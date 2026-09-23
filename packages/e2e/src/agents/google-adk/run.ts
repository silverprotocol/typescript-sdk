/**
 * Standalone Google ADK capture agent for the E2E conformance harness
 * (Task 6 / audit M60 — the design's own promised Slice B capture agent),
 * retargeted 2026-07-13 to the OFFICIAL `@google/adk` (google/adk-js).
 *
 * HISTORY: originally wired to `@iqai/adk` (the independently-maintained TS
 * port that predated a stable official SDK) with a hand-rolled
 * `McpBridgeTool` transport bridge, because `@iqai/adk`'s `McpToolset` spoke
 * only stdio/SSE while `mcp-mocks/serve.ts` speaks Streamable HTTP. That was
 * the ONE genuine gap the old header documented. The official `@google/adk`
 * closes it: its `MCPToolset` accepts `StreamableHTTPConnectionParams`
 * (tools/mcp/mcp_session_manager.d.ts — a real
 * `@modelcontextprotocol/sdk` StreamableHTTP client under the hood, the
 * EXACT transport `serve.ts` implements), so the entire bridge is deleted
 * and every concern — tool discovery, transport, the LLM loop, the
 * turn/event stream — is 100% official SDK. NOTE (2.0.0 bump, 2026-09-02):
 * `@google/adk` 2.0.0 makes `@modelcontextprotocol/sdk` an OPTIONAL
 * peerDependency (`^1.26.0`, peerDependenciesMeta optional:true) where 1.x
 * declared it as a regular dependency (npm-registry-verified) — satisfied
 * here by packages/e2e's OWN `@modelcontextprotocol/sdk` devDependency, so
 * `MCPToolset` keeps resolving a real client. The
 * root `@google/adk` import below is deliberately kept (no subpath entry)
 * so this file works unchanged across the facet's 1.x/2.x peer range.
 * The wire this yields is the
 * official `Event extends LlmResponse` interface
 * (events/event.d.ts; `content.parts[]` uses the real `@google/genai`
 * `Content`/`Part` types — the SAME Gemini wire shape
 * `google-adk/src/index.ts`'s header cites as its primary source, so the
 * normalizer under test needed no change: it was retargeted to the official
 * peer in v0.3.0 and live-validated by launch/validation/e2e-adk-google*.mjs).
 *
 * `newMessage.role: "user"` was LOAD-BEARING on ≤1.3.0: a role-less Content
 * triggered an upstream 400 (google/adk-js#475, filed by @wanseob; diagnosed
 * to root cause in the v0.3.1 fix). Upstream fixed it in google/adk-js#478
 * (defaults role to 'user' when omitted), SHIPPED in 1.4.0 and live-confirmed
 * 2026-07-22 (role-less newMessage survived a full gemini-3.6-flash tool-loop
 * replay on this harness's pin). Keep setting it explicitly regardless:
 * correct on every version, and explicit beats defaulted for a conformance
 * capture.
 *
 * OPERATOR-GATED: requires `GOOGLE_API_KEY` (or `CaptureRunInput.apiKey`) at
 * ITERATION time (the function is an async generator — no work happens, and
 * no key check fires, until the caller starts iterating; `@google/adk`'s
 * Gemini model class reads `process.env.GOOGLE_API_KEY` internally, so this
 * module seeds that var from the resolved key before building the agent).
 * Live capture is operator-run; this module + its smoke test only confirm
 * module load, callable shape, and the key-absent failure — no live SDK run,
 * no mock server booted.
 */

import { FunctionTool, InMemoryRunner, LlmAgent, MCPToolset } from "@google/adk";
import { ThinkingLevel } from "@google/genai";
import { z } from "zod";
import type { JsonValue } from "@silverprotocol/core";
import { toJsonValue } from "@silverprotocol/core";
import type { CaptureRunInput } from "../types.js";

/** The scripted-state tool's name, and the harness's proof that this agent
 *  supports `adkStateScript` (its knob guard, KNOB_SUPPORT). */
export const ADK_STATE_TOOL = "apply_state_step";

/**
 * The inputs only this agent reads, on top of the shared contract. Both
 * optional; with both absent a capture is byte-identical to one without them.
 */
export interface AdkCaptureInput extends CaptureRunInput {
  /**
   * Scripted session-state writes. When set, the agent gets one extra
   * FunctionTool, `apply_state_step({ step })`, which writes
   * `adkStateScript[step - 1]`'s entries through ADK's own
   * `toolContext.state.set(key, value)`, one call per entry. The values are
   * fixed by the script, so the model only chooses which step to call.
   */
  adkStateScript?: ReadonlyArray<Readonly<Record<string, JsonValue>>>;
  /**
   * Called once, after the run completes normally, with the session's state as
   * ADK's own session service holds it (`getSession(...).state`), as plain JSON.
   * It is kept OUT of the native stream, so replay and the census never see
   * harness data. `null` when the session is gone.
   */
  onSessionState?: (state: JsonValue) => void;
}

/** Applies one scripted step to a state writer. Returns what the tool answers:
 *  the step and the keys it wrote, or `applied: false` for a step the script
 *  does not have. */
export function applyAdkStateStep(
  script: ReadonlyArray<Readonly<Record<string, JsonValue>>>,
  step: number,
  state: { set(key: string, value: unknown): void },
): { applied: boolean; step: number; keys: string[] } {
  const entries = Number.isInteger(step) && step >= 1 ? script[step - 1] : undefined;
  if (entries === undefined) return { applied: false, step, keys: [] };
  const keys = Object.keys(entries);
  // structuredClone: each write stores its own copy, so no two steps (and no
  // step and the script) share an object.
  for (const key of keys) state.set(key, structuredClone(entries[key]));
  return { applied: true, step, keys };
}

/** The `apply_state_step` FunctionTool over a script. */
export function adkStateTool(script: ReadonlyArray<Readonly<Record<string, JsonValue>>>): FunctionTool {
  return new FunctionTool({
    name: ADK_STATE_TOOL,
    description:
      "Apply one scripted session-state step. Call it with step 1, then with step 2, and so on, one call at a time.",
    parameters: z.object({ step: z.number().int().describe("The 1-based step number to apply.") }),
    execute: ({ step }, toolContext) =>
      toolContext === undefined ? { applied: false, step, keys: [] } : applyAdkStateStep(script, step, toolContext.state),
  });
}

/** The session's state as ADK's session service holds it, as plain JSON
 *  (`null` when the session is gone). */
export async function adkSessionState(
  runner: InMemoryRunner,
  key: { userId: string; sessionId: string },
): Promise<JsonValue> {
  const session = await runner.sessionService.getSession({ appName: runner.appName, ...key });
  return session === undefined ? null : toJsonValue(session.state);
}

/** CaptureRunInput's lowercase levels → genai's enum. The 3.7-flash set only
 *  (low/medium/high) — MINIMAL exists in the enum but is rejected server-side
 *  by gemini-3.7-flash, so the scenario schema never offers it. */
const THINKING_LEVELS: Record<NonNullable<CaptureRunInput["thinkingLevel"]>, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * The LlmAgent `generateContentConfig` for the scenario's thinking knob, or
 * `undefined` when the scenario sets none. Shared with `workflow.ts` so both
 * capture agents build the same model request. Thought summaries are OFF by
 * default on gemini-3.7-flash, so `includeThoughts` must ride alongside the
 * level for `thought: true` parts to appear on the wire at all.
 */
export function adkGenerateContentConfig(
  input: Pick<CaptureRunInput, "thinkingLevel">,
): { thinkingConfig: { includeThoughts: true; thinkingLevel: ThinkingLevel } } | undefined {
  return input.thinkingLevel !== undefined
    ? {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: THINKING_LEVELS[input.thinkingLevel],
        },
      }
    : undefined;
}

/**
 * Yields the RAW native `@google/adk` `Event` stream, unnormalized, each item
 * materialized as a plain `JsonValue` via `toJsonValue` (audit D5-a's
 * native-ingestion boundary — the whole event, no per-field cast).
 */
export async function* runAdkCapture(input: AdkCaptureInput): AsyncIterable<JsonValue> {
  const apiKey = input.apiKey ?? process.env["GOOGLE_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "GOOGLE_API_KEY is required: set it via CaptureRunInput.apiKey or the GOOGLE_API_KEY environment variable",
    );
  }
  // `@google/adk`'s Gemini model reads this env var directly (no per-run
  // apiKey param is plumbed through LlmAgent/Runner) — seed it from the
  // resolved key, mirroring the other capture agents' per-call scoping as
  // closely as the SDK allows.
  process.env["GOOGLE_API_KEY"] = apiKey;

  // One MCPToolset per configured mock server — the official Streamable-HTTP
  // client. The bearer rides `transportOptions.requestInit.headers` (the
  // non-deprecated channel; the legacy `header` field is ignored whenever
  // transportOptions is present, per mcp_session_manager.d.ts).
  const toolsets = Object.values(input.mcpServers).map(
    (cfg) =>
      new MCPToolset({
        type: "StreamableHTTPConnectionParams",
        url: cfg.url,
        transportOptions: {
          requestInit: { headers: { Authorization: `Bearer ${cfg.bearer}` } },
        },
      }),
  );

  try {
    // Thinking knob (scenario.thinkingLevel → CaptureRunInput); see
    // adkGenerateContentConfig.
    const generateContentConfig = adkGenerateContentConfig(input);
    const agent = new LlmAgent({
      name: "spike",
      model: input.model ?? "gemini-2.5-flash",
      instruction: input.systemPrompt ?? "You are a helpful assistant.",
      tools: input.adkStateScript !== undefined ? [...toolsets, adkStateTool(input.adkStateScript)] : toolsets,
      ...(generateContentConfig !== undefined ? { generateContentConfig } : {}),
    });
    const runner = new InMemoryRunner({ agent });
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: "user-1",
    });

    const stream = runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      // role:"user" was load-bearing on ≤1.3.0 — see header (google/adk-js#475,
      // fixed by #478 in 1.4.0); kept explicit deliberately.
      newMessage: { role: "user", parts: [{ text: input.prompt }] },
      // maxTurns → maxLlmCalls: ADK has no per-turn cap; one capture "turn" is
      // one LLM call round, and the SDK's own default (500, createRunConfig)
      // is unbounded for this harness's purposes — mirror the claude/openai
      // agents' `maxTurns ?? 8` so same-corpus captures stay comparable.
      runConfig: { maxLlmCalls: input.maxTurns ?? 8 },
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });

    for await (const event of stream) {
      // Wire projection (audit D5-a) — toJsonValue materializes the WHOLE raw
      // event into plain JsonValue with no per-field cast.
      yield toJsonValue(event);
    }
    // Ground truth for the state seed: ADK's own session state, after the run
    // returned normally. Reported through the callback, never yielded.
    if (input.onSessionState !== undefined) {
      input.onSessionState(await adkSessionState(runner, { userId: session.userId, sessionId: session.id }));
    }
  } finally {
    await Promise.all(toolsets.map((toolset) => toolset.close()));
  }
}
