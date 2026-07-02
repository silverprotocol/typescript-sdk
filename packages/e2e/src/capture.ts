/**
 * capture.ts — runCapture: boots scenario mocks, runs the framework's capture
 * agent, verifies tool calls, normalizes, and computes coverage. Produces a
 * Cassette. Framework-parametric (Task 6) — see capture-cli.ts for the CLI
 * entry that dispatches to a concrete agent per `pnpm e2e:capture <scenario>
 * <framework>`.
 *
 * Dependency-injected for keyless testing (CaptureDeps). capture-cli.ts wires
 * real deps + writes the corpus triple + provenance sidecar to disk.
 *
 * runCapture steps:
 *   1. Boot each mcpServer mock via serveMock(kind, port) and assemble the
 *      { key: { url, bearer } } map the agent expects.
 *   2. Run the agent via deps.runAgentCapture with derivedTools(s,
 *      opts.framework).allowedTools, collecting raw native events into the
 *      `native` array.
 *   3. ★ Verify extractToolCalls(native, opts.framework) ⊇
 *      derivedTools(s, opts.framework).expectTools — if not, THROW (no
 *      half-cassette written).
 *   4. Produce { native, agjson, coverage } where agjson = normalize all
 *      native events via deps.createNormalizer(), coverage = census(...).
 */
import type { JsonValue, Normalizer } from "@silverprotocol/core";
import { toWire } from "@silverprotocol/core";
import type { CensusInput, CensusReport, AllowlistReview, Framework } from "./census.js";
import type { MockKind } from "./mcp-mocks/tools.js";
import type { MockHandle } from "./mcp-mocks/serve.js";
import type { CaptureRunInput, CaptureRunFn } from "./agents/types.js";
import { Scenario, derivedTools } from "./scenario.js";
import { extractToolCalls } from "./extract-tools.js";

export type { CaptureRunInput };

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
 * Fake ONLY runAgentCapture in tests; the rest are REAL.
 */
export interface CaptureDeps {
  /** The LLM/process boundary — yields raw native events. FAKED in tests. */
  runAgentCapture: CaptureRunFn;
  /** Boots a mock MCP server on a given port. REAL in tests. */
  serveMock(kind: MockKind, port: number): MockHandle;
  /** Creates a fresh stateful normalizer for opts.framework. REAL in tests. */
  createNormalizer(): Normalizer;
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
  /** The framework whose capture agent + normalizer + tool-call reader to use. */
  framework: Framework;
  /** Provider API key (live captures only). */
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
  const { allowedTools, expectTools } = derivedTools(scenario, opts.framework);

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

    for await (const event of deps.runAgentCapture(agentInput)) {
      native.push(event);
    }

    // ── Step 3: Verify expectTools ⊇ extractToolCalls(native) ────────────────
    const calledTools = extractToolCalls(native, opts.framework);
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
    const normalizer = deps.createNormalizer();
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
      framework: opts.framework,
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
