/**
 * capture.ts — runCapture: boots scenario mocks, runs the LLM, verifies tool
 * calls, normalizes, and computes coverage. Produces a Cassette.
 *
 * Dependency-injected for keyless testing (CaptureDeps). The CLI entry wires
 * real deps + writes the cassette to disk.
 *
 * runCapture steps:
 *   1. Boot each mcpServer mock via serveMock(kind, port) and assemble the
 *      { key: { url, bearer } } map the SDK expects.
 *   2. Run the agent via runClaudeCapture with derivedTools(s).allowedTools,
 *      collecting raw native events into the `native` array.
 *   3. ★ Verify extractToolCalls(native) ⊇ derivedTools(s).expectTools —
 *      if not, THROW (no half-cassette written).
 *   4. Produce { native, agjson, coverage } where agjson = normalize all
 *      native events via createClaudeNormalizer, coverage = census(...).
 */
import type { JsonValue, Normalizer } from "@silverprotocol/core";
import { toWire } from "@silverprotocol/core";
import type { CensusInput, CensusReport, AllowlistReview } from "./census.js";
import type { MockKind } from "./mcp-mocks/tools.js";
import type { MockHandle } from "./mcp-mocks/serve.js";
import type { CaptureRunInput } from "./agents/claude-agent-sdk/run.js";
import { Scenario, derivedTools } from "./scenario.js";
import { extractToolCalls } from "./extract-tools.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/** The output of a successful capture run. */
export interface Cassette {
  /** Raw native Claude SDK event stream (JsonValue[]) */
  native: JsonValue[];
  /** Normalized AgJSON events (AgEvent[], via toWire() for transport) */
  agjson: JsonValue[];
  /** Census lossiness report */
  coverage: CensusReport;
}

/**
 * Injected collaborators for runCapture.
 *
 * Fake ONLY runClaudeCapture in tests; the rest are REAL.
 */
export interface CaptureDeps {
  /** The LLM/process boundary — yields raw native events. FAKED in tests. */
  runClaudeCapture(input: CaptureRunInput): AsyncIterable<JsonValue>;
  /** Boots a mock MCP server on a given port. REAL in tests. */
  serveMock(kind: MockKind, port: number): MockHandle;
  /** Creates a fresh stateful Claude normalizer. REAL in tests. */
  createClaudeNormalizer(): Normalizer;
  /** Runs the census lossiness analysis. REAL in tests. */
  census(input: CensusInput): CensusReport;
}

/**
 * Runtime options for runCapture.
 *
 * ports: one port per scenario.mcpServers entry, in the same order.
 *        Caller is responsible for providing free ports (no Math.random here).
 */
export interface CaptureRunOptions {
  ports: number[];
  /** Anthropic API key (live captures only). */
  apiKey?: string;
  /** System prompt override. Defaults to scenario.steer if present. */
  systemPrompt?: string;
}

// ─── runCapture ────────────────────────────────────────────────────────────────

/**
 * Boots the scenario's mocks, runs the agent, verifies tool calls, normalizes,
 * and computes coverage. Returns a Cassette.
 *
 * Throws if extractToolCalls(native) does not contain every name in
 * derivedTools(scenario).expectTools (no half-cassette is produced).
 */
export async function runCapture(
  scenario: Scenario,
  deps: CaptureDeps,
  opts: CaptureRunOptions,
): Promise<Cassette> {
  const { allowedTools, expectTools } = derivedTools(scenario);

  // ── Step 1: Boot mocks ────────────────────────────────────────────────────
  const handles: MockHandle[] = [];
  const mcpServers: Record<string, { url: string; bearer: string }> = {};

  for (let i = 0; i < scenario.mcpServers.length; i++) {
    const server = scenario.mcpServers[i];
    if (server === undefined) continue;
    const port = opts.ports[i];
    if (port === undefined) {
      throw new Error(
        `runCapture: no port provided for mcpServers[${i}] (key="${server.key}"). ` +
          `Pass one port per mcpServers entry in opts.ports.`,
      );
    }

    const handle = deps.serveMock(server.kind, port);
    handles.push(handle);
    mcpServers[server.key] = {
      url: handle.url,
      // A static bearer token for the mock — no real secret needed.
      bearer: "mock-bearer-token",
    };
  }

  try {
    // ── Step 2: Run the agent ───────────────────────────────────────────────
    const native: JsonValue[] = [];
    const systemPrompt = opts.systemPrompt ?? scenario.steer;

    const agentInput: CaptureRunInput = {
      prompt: scenario.prompt,
      mcpServers,
      allowedTools,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    };

    for await (const event of deps.runClaudeCapture(agentInput)) {
      native.push(event);
    }

    // ── Step 3: Verify expectTools ⊇ extractToolCalls(native) ────────────────
    const calledTools = extractToolCalls(native);
    const missingTools = expectTools.filter((t) => !calledTools.includes(t));
    if (missingTools.length > 0) {
      throw new Error(
        `runCapture: agent did not call expected tools: ${missingTools.join(", ")}. ` +
          `Called: [${calledTools.join(", ")}]. ` +
          `Expected (from scenario): [${expectTools.join(", ")}]. ` +
          `No cassette written.`,
      );
    }

    // ── Step 4: Normalize + census ─────────────────────────────────────────
    const normalizer = deps.createClaudeNormalizer();
    const agEvents: JsonValue[] = [];

    for (const event of native) {
      const produced = normalizer.push(event);
      for (const e of produced) {
        // Wire projection (audit D5-a) — toWire materializes the AgEvent as
        // plain JsonValue for the cassette.
        agEvents.push(toWire(e));
      }
    }
    // Flush any dangling open messages
    const flushed = normalizer.flush();
    for (const e of flushed) {
      agEvents.push(toWire(e));
    }

    const agjsonValue: JsonValue = agEvents;
    const nativeValue: JsonValue = native;

    const coverage = deps.census({
      native: nativeValue,
      agjson: agjsonValue,
      transforms: new Map<string, string>(),
      allowlist: new Map<string, AllowlistReview>(),
      registry: new Set<string>(),
      framework: "claude",
    });

    return {
      native,
      agjson: agEvents,
      coverage,
    };
  } finally {
    // ── Cleanup: close all mock servers ────────────────────────────────────
    await Promise.all(handles.map((h) => h.close()));
  }
}

// ─── CLI entry ────────────────────────────────────────────────────────────────
// `pnpm e2e:capture <scenario-name>` — wires real deps + writes cassette.

async function main(): Promise<void> {
  const scenarioName = process.argv[2];
  if (!scenarioName) {
    process.stderr.write("Usage: pnpm e2e:capture <scenario-name>\n");
    process.exit(1);
  }

  // Lazy imports so the module is still importable without them in test context.
  const { createClaudeNormalizer } = await import("@silverprotocol/claude-agent-sdk");
  const { census } = await import("./census.js");
  const { serveMock } = await import("./mcp-mocks/serve.js");
  const { runClaudeCapture } = await import("./agents/claude-agent-sdk/run.js");
  const { createServer } = await import("node:net");
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const scenarioDir = join(__dirname, "..", "scenarios", scenarioName);
  const scenarioFile = join(scenarioDir, "scenario.json");

  let raw: string;
  try {
    raw = await readFile(scenarioFile, "utf8");
  } catch {
    process.stderr.write(`Scenario not found: ${scenarioFile}\n`);
    process.exit(1);
  }

  const scenario = Scenario.parse(JSON.parse(raw));

  // Allocate free ephemeral ports (one per mcpServer).
  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (addr === null || typeof addr === "string") {
          srv.close();
          reject(new Error("Could not get ephemeral port"));
          return;
        }
        const port = addr.port;
        srv.close(() => resolve(port));
      });
      srv.on("error", reject);
    });
  }

  const ports: number[] = await Promise.all(
    scenario.mcpServers.map(() => freePort()),
  );

  const cassette = await runCapture(
    scenario,
    { runClaudeCapture, serveMock, createClaudeNormalizer, census },
    { ports, apiKey: process.env["ANTHROPIC_API_KEY"] },
  );

  const outFile = join(scenarioDir, "cassette.json");
  await mkdir(scenarioDir, { recursive: true });
  await writeFile(outFile, JSON.stringify(cassette, null, 2), "utf8");
  process.stdout.write(`Cassette written: ${outFile}\n`);
}

// Run main() only when invoked as a script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(String(err) + "\n");
    process.exit(1);
  });
}
