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
import { HOST_COMPLETE_MARKER, splitHostCompleteMarker } from "./replay.js";
import { redactNative } from "./redact.js";

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
  /** The message the run threw, kept only for an `expectError` scenario. */
  runError?: string;
  /** The framework's own session state read back after the run (adkStateScript). */
  sessionState?: JsonValue;
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
  /**
   * SPEC §8.0 host obligation 4 (draft.4): the framework's stream carries no
   * in-band run terminal (adk-js), so the capture, acting as the host, records
   * the host-completion marker `{type: HOST_COMPLETE_MARKER}` as the LAST
   * native line after the run returned normally, never after a throw. It
   * reaches the normalizer in native order, just as replay.ts feeds a
   * recorded marker, so `createNormalizer` must return a facet opted into it
   * (google-adk `{ hostCompletion: true }`). The census reads the natives
   * without it, as replay's does.
   */
  hostCompletion?: boolean;
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
  /** Resume this session (resolved by capture-cli from scenario.resumeFrom). */
  resumeSessionId?: string;
  /** Resume this RunState (openai; resolved by capture-cli from scenario.resumeFrom). */
  resumeRunState?: string;
  /** Leg 1 (toolApproval "interrupt"): receives the interrupted run's RunState. */
  onRunState?: (serializedRunState: string) => void;
  /** System prompt override. Defaults to scenario.steer if present. */
  systemPrompt?: string;
  /**
   * Model ID override, forwarded verbatim to the capture agent's
   * `CaptureRunInput.model`. Omitted → each agent's own hardcoded default
   * literal applies (see agents/claude-agent-sdk/run.ts,
   * agents/openai-agents-sdk/run.ts, agents/google-adk/run.ts).
   */
  model?: string;
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
    // ADK's session.state read back after the run (adkStateScript scenarios).
    let sessionState: JsonValue | undefined;
    const systemPrompt = opts.systemPrompt ?? scenario.steer;

    const agentInput: CaptureRunInput = {
      prompt: scenario.prompt,
      ...(scenario.followUps !== undefined ? { followUpPrompts: scenario.followUps } : {}),
      mcpServers,
      allowedTools,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(scenario.includePartialMessages === true ? { includePartialMessages: true } : {}),
      ...(scenario.thinkingLevel !== undefined ? { thinkingLevel: scenario.thinkingLevel } : {}),
      ...(scenario.thinkingDisplay !== undefined ? { thinkingDisplay: scenario.thinkingDisplay } : {}),
      ...(scenario.reasoningSummary !== undefined ? { reasoningSummary: scenario.reasoningSummary } : {}),
      ...(scenario.preToolUseDecision !== undefined ? { preToolUseDecision: scenario.preToolUseDecision } : {}),
      ...(opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
      ...(scenario.toolApproval !== undefined ? { toolApproval: scenario.toolApproval } : {}),
      ...(opts.resumeRunState !== undefined ? { resumeRunState: opts.resumeRunState } : {}),
      ...(opts.onRunState !== undefined ? { onRunState: opts.onRunState } : {}),
      ...(scenario.adkStateScript !== undefined
        ? { adkStateScript: scenario.adkStateScript, onSessionState: (state: JsonValue) => { sessionState = state; } }
        : {}),
      ...(scenario.claudeSubagents !== undefined ? { subagents: scenario.claudeSubagents } : {}),
      ...(scenario.openaiHandoff !== undefined ? { handoff: scenario.openaiHandoff } : {}),
    };

    let runError: string | undefined;
    try {
      for await (const event of deps.runAgentCapture(agentInput)) {
        // Scrub account-identifying values before anything reads the event (redact.ts).
        native.push(redactNative(event));
      }
    } catch (err) {
      // An error seed expects the throw and keeps what arrived before it.
      if (scenario.expectError !== true) throw err;
      runError = err instanceof Error ? err.message : String(err);
    }
    if (scenario.expectError === true && runError === undefined) {
      throw new Error(
        "runCapture: the scenario expects the run to fail (expectError) but it returned normally. " +
          "No cassette written.",
      );
    }
    // Only a run that returned normally gets the marker (never after a throw).
    if (runError === undefined && deps.hostCompletion === true) native.push({ type: HOST_COMPLETE_MARKER });

    // ── Step 3: Verify expectTools ⊇ extractToolCalls(native) ────────────────
    // Skipped for an error seed (a failed run calls no tools) and for a resume
    // leg (its tool call was made in the leg it resumes; the resumed stream
    // carries only what happens next, e.g. the deferred call's execution).
    const skipToolCheck = runError !== undefined || opts.resumeSessionId !== undefined || opts.resumeRunState !== undefined;
    const calledTools = extractToolCalls(native, opts.framework);
    const missingTools = skipToolCheck ? [] : expectTools.filter((t) => !calledTools.includes(t));
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
    // The marker is harness data, not framework wire: census the natives without it.
    const nativeValue: JsonValue = splitHostCompleteMarker(native).native;

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
      ...(runError !== undefined ? { runError } : {}),
      ...(sessionState !== undefined ? { sessionState } : {}),
    };
  } finally {
    // ── Cleanup: close all mock servers ────────────────────────────────────
    await Promise.all(handles.map((h) => h.close()));
  }
}
