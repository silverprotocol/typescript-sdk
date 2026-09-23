/**
 * Standalone OpenAI Agents SDK capture agent for the E2E conformance harness
 * (Task 6 / audit M60 — the design's own promised Slice A capture agent).
 *
 * Mirrors `../claude-agent-sdk/run.ts`'s contract EXACTLY: runs a real
 * `@openai/agents` agent and yields its RAW native `RunStreamEvent` stream as
 * `JsonValue` items — unnormalized. The harness (capture.ts) captures this
 * stream directly and pipes it through `createOpenaiNormalizer` under test in
 * a separate step.
 *
 * MCP wiring: `@openai/agents` ships `MCPServerStreamableHttp`, a REAL client
 * for the exact Streamable-HTTP transport `mcp-mocks/serve.ts` implements
 * (POST /mcp, stateless `sessionIdGenerator: undefined`) — the SAME transport
 * the claude-agent-sdk agent uses. Per the SDK's own `MCPServer` contract
 * (agents-core/dist/mcp.d.ts), the CALLER owns the connect()/close()
 * lifecycle — `Agent`/`run()` do not auto-connect.
 *
 * OPERATOR-GATED: requires `OPENAI_API_KEY` (or `CaptureRunInput.apiKey`) at
 * ITERATION time (the function is an async generator — no work happens, and
 * no key check fires, until the caller starts iterating). Live capture is
 * operator-run; this module + its smoke test only confirm: (a) module loads
 * without throwing, (b) the function is callable and returns an
 * AsyncIterable without starting the SDK, (c) the key-absent error fires on
 * first iteration with a clear message.
 */

import { Agent, getAllMcpTools, MCPServerStreamableHttp, type ModelSettings, run, RunState, type Tool } from "@openai/agents";
import type { JsonValue } from "@silverprotocol/core";
import { toJsonValue } from "@silverprotocol/core";
import type { CaptureRunInput } from "../types.js";

/**
 * The Agent's `modelSettings` for this capture, or `undefined` when no knob asks
 * for any (then NO `modelSettings` key is passed — byte-identical to the
 * pre-knob agent). Today one knob: `reasoningSummary` → `reasoning.summary`
 * (agents-core 0.18.0 `dist/model.d.ts`:37, `ModelSettingsReasoning.summary:
 * 'auto' | 'concise' | 'detailed' | null`), so a capture can request the
 * reasoning-summary text the commentary scenario needs (sp-probe ad6f19f,
 * rnd 13+17 stage 2 evidence). Effort is left at the API default. Exported
 * so the keyless smoke test can pin it.
 */
export function openaiModelSettings(input: CaptureRunInput): ModelSettings | undefined {
  if (input.reasoningSummary === undefined) return undefined;
  return { reasoning: { summary: input.reasoningSummary } };
}

/**
 * The openai capture agent's approval / resume knobs (sp-main work order,
 * 2026-09-24: the OpenAI approval-resume capture — evidence for the fold/flush
 * package's Q2). They mirror sp-claude's deferred-tool pattern (a22d669 +
 * 35ab1eb): leg 1 stops on the interruption and hands its RunState out; each
 * resume leg forks from THAT serialized state with its own decision.
 *
 * - `toolApproval: "interrupt"` (leg 1): every MCP tool needs approval, so the
 *   run stops on the first tool call's interruption. The serialized RunState
 *   (`result.state.toString()`) goes to `onRunState`; probe's harness persists
 *   it beside the seed. It is not in the native stream, unlike claude's
 *   session_id.
 * - `toolApproval: "approve" | "reject"` (a resume leg): `resumeRunState` is
 *   leg 1's serialized state. `RunState.fromString` builds a FRESH state from
 *   it every time, so the approve and reject legs fork from the same
 *   interruption and never mutate each other. Every pending interruption gets
 *   the decision, and `run(agent, state, {stream: true})` resumes. The
 *   resumed stream is yielded in real order.
 *
 * Absent ⇒ none of this: the agent is built exactly as before (byte-identical).
 * These live on an openai-local extension of CaptureRunInput. probe's
 * harness (types.ts / scenario.ts / capture.ts / KNOB_SUPPORT) wires the
 * scenario knobs to them.
 */
export interface OpenaiCaptureRunInput extends CaptureRunInput {
  toolApproval?: "interrupt" | "approve" | "reject";
  /** A resume leg's input: the RunState string leg 1 handed to `onRunState`. */
  resumeRunState?: string;
  /** Leg 1's output: receives the serialized RunState when the run stops on an interruption. */
  onRunState?: (serializedRunState: string) => void;
}

export type OpenaiApprovalPlan =
  | { mode: "interrupt"; onRunState: (serializedRunState: string) => void }
  | { mode: "resume"; decision: "approve" | "reject"; runState: string };

/**
 * Validates the approval knobs before any network call and returns the plan,
 * or `undefined` when no knob is set. A mis-set knob FAILS LOUD rather than
 * recording a plain run under an approval-leg name (the KNOB_SUPPORT lesson,
 * capture-cli.ts). It is also this agent's KNOB_SUPPORT proof export.
 */
export function openaiApprovalPlan(
  input: Pick<OpenaiCaptureRunInput, "toolApproval" | "resumeRunState" | "onRunState">,
): OpenaiApprovalPlan | undefined {
  const { toolApproval, resumeRunState, onRunState } = input;
  if (toolApproval === undefined) {
    if (resumeRunState !== undefined) {
      throw new Error("openai capture: resumeRunState is set but toolApproval is not; a resume leg must say approve or reject");
    }
    return undefined;
  }
  if (toolApproval === "interrupt") {
    if (resumeRunState !== undefined) {
      throw new Error('openai capture: toolApproval "interrupt" is leg 1 and must not resume a RunState');
    }
    if (onRunState === undefined) {
      throw new Error('openai capture: toolApproval "interrupt" needs onRunState, or the leg-1 RunState would be lost');
    }
    return { mode: "interrupt", onRunState };
  }
  if (resumeRunState === undefined) {
    throw new Error(`openai capture: toolApproval "${toolApproval}" is a resume leg and needs resumeRunState (leg 1's RunState)`);
  }
  return { mode: "resume", decision: toolApproval, runState: resumeRunState };
}

/** Every FUNCTION tool (the MCP tools, as `getAllMcpTools` lists them) gets a
 *  `needsApproval` that always says yes. Other tools pass through untouched,
 *  and the inputs are never mutated (a spread copy keeps `invoke`, so a
 *  tool still executes against the real MCP mock once approved). */
export function withRequiredApproval(tools: readonly Tool[]): Tool[] {
  return tools.map((t) => (t.type === "function" ? { ...t, needsApproval: async () => true } : t));
}

/** The approval surface of a RunState that a resume leg needs (structural, so
 *  the unit test can use a fake). */
export interface ApprovalState<Item> {
  getInterruptions(): Item[];
  approve(item: Item): void;
  reject(item: Item): void;
}

/** Applies the resume leg's decision to EVERY pending interruption and returns
 *  the count. Zero pending FAILS LOUD: the resume would re-run nothing. */
export function applyApprovalDecision<Item>(state: ApprovalState<Item>, decision: "approve" | "reject"): number {
  const pending = state.getInterruptions();
  if (pending.length === 0) {
    throw new Error("openai capture: the resumed RunState has no pending approval interruption; nothing to approve or reject");
  }
  for (const item of pending) {
    if (decision === "approve") state.approve(item);
    else state.reject(item);
  }
  return pending.length;
}

/** Leg 1's serialized RunState. A run that ended WITHOUT an interruption
 *  (no approval-gated tool was called) FAILS LOUD, so an interrupt-leg name
 *  never holds a plain run. */
export function serializeInterruptedRun(result: {
  readonly interruptions: readonly unknown[];
  readonly state: { toString(): string };
}): string {
  if (result.interruptions.length === 0) {
    throw new Error('openai capture: toolApproval "interrupt" but the run ended with NO approval interruption (no approval-gated tool was called)');
  }
  return result.state.toString();
}

/**
 * Yields the RAW native `@openai/agents` `RunStreamEvent` stream, unnormalized,
 * each item materialized as a plain `JsonValue` via `toJsonValue` (audit
 * D5-a's native-ingestion boundary — the whole event, no per-field cast).
 */
export async function* runOpenaiCapture(input: OpenaiCaptureRunInput): AsyncIterable<JsonValue> {
  const apiKey = input.apiKey ?? process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required: set it via CaptureRunInput.apiKey or the OPENAI_API_KEY environment variable",
    );
  }
  // The Agents SDK reads the key from this env var; there is no per-run
  // override plumbed through Agent/run(), so we set it for the process
  // (mirrors the claude agent's `env: { ANTHROPIC_API_KEY }` per-call scoping
  // as closely as the SDK allows).
  process.env["OPENAI_API_KEY"] = apiKey;
  // Validate the approval knobs BEFORE any MCP connect or API call.
  const approval = openaiApprovalPlan(input);

  const mcpServers = Object.entries(input.mcpServers).map(
    ([name, cfg]) =>
      new MCPServerStreamableHttp({
        name,
        url: cfg.url,
        requestInit: { headers: { Authorization: `Bearer ${cfg.bearer}` } },
        // Playbook 2026-07-03 follow-up (structuredContent-under-0.12.0 fix):
        // `@openai/agents-core` 0.12.0's `MCPServer.useStructuredContent`
        // (default `false`) was considered and REJECTED — flipping it merges
        // MCP `structuredContent` into the MODEL-VISIBLE tool-result text
        // instead of restoring a separate channel, which would leak the ggui
        // cache-marker payload into what the model sees (a behavior change,
        // not a fix). Left unset (SDK default).
        //
        // `customDataExtractor` is the real, additive channel: it does NOT
        // touch model-visible content — its return value lands verbatim on
        // the wrapper's `item.customData` field (`RunToolCallOutputItem.
        // customData`, agents-core 0.12.0's `dist/items.mjs`), which
        // `../../../openai-agents/src/index.ts`'s `extractStructuredContent`
        // now reads. This is what actually carries the ggui cache marker
        // through on real 0.12.0 wire — verified against agents-core
        // 0.12.0's `mcpToFunctionTool` (`dist/mcp.mjs:672-738`) and
        // `normalizeToolOutputCustomData` (`dist/utils/customData.mjs`, which
        // JSON-round-trips and validates the return value itself). A no-op
        // for tools that return no structuredContent (returns `undefined`,
        // which the SDK drops — no new field appears on the wire for them).
        //
        // workspace#21 (2026-09-23): the MCP result `_meta` rides along as
        // `_meta` — agents-core 0.18.0 `MCPToolCustomDataContext.resultMeta`
        // (`dist/mcpUtil.d.ts`:41, sourced `result._meta ?? content._meta` at
        // `dist/mcp.mjs`:700) — the same `{ structuredContent, _meta }` shape
        // guuey's worker ships (guuey#981), so a re-capture of
        // `app-spec-structured-result` (its mock emits `_meta.ui`,
        // `mcp-mocks/app-spec.ts`) proves the facet's `_meta` / `uiData`
        // routing live. Still `undefined` when the tool returned neither.
        customDataExtractor: (context) =>
          context.structuredContent !== undefined || context.resultMeta !== undefined
            ? {
                ...(context.structuredContent !== undefined ? { structuredContent: context.structuredContent } : {}),
                ...(context.resultMeta !== undefined ? { _meta: context.resultMeta } : {}),
              }
            : undefined,
      }),
  );

  const abortController = new AbortController();
  const signal = input.abortSignal;
  const onAbort = (): void => {
    abortController.abort(signal?.reason);
  };
  if (signal) {
    if (signal.aborted) {
      abortController.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onAbort);
    }
  }

  try {
    for (const server of mcpServers) {
      await server.connect();
    }

    const modelSettings = openaiModelSettings(input);
    // With an approval knob, the MCP tools are listed once and passed as
    // approval-gated `tools`; otherwise the agent is built exactly as before.
    const agent =
      approval === undefined
        ? new Agent({
            name: "spike",
            instructions: input.systemPrompt ?? "You are a helpful assistant.",
            model: input.model ?? "gpt-4o-mini",
            mcpServers,
            ...(modelSettings !== undefined ? { modelSettings } : {}),
          })
        : new Agent({
            name: "spike",
            instructions: input.systemPrompt ?? "You are a helpful assistant.",
            model: input.model ?? "gpt-4o-mini",
            tools: withRequiredApproval(await getAllMcpTools(mcpServers)),
            ...(modelSettings !== undefined ? { modelSettings } : {}),
          });

    let runInput: string | RunState<unknown, typeof agent> = input.prompt;
    if (approval?.mode === "resume") {
      // A FRESH state from leg 1's string every time: the approve and reject
      // legs fork from the same interruption.
      const state = await RunState.fromString(agent, approval.runState);
      applyApprovalDecision(state, approval.decision);
      runInput = state;
    }

    // NO `context` is passed, deliberately (sp-cto, 2026-09-24): the run
    // `context` rides into the serialized RunState (agents-core 0.18.0
    // RunState: context, originalInput, modelResponses, currentStep, spans),
    // which leg 1 hands out via `onRunState`. It is kept in a gitignored
    // capture-time location, never the corpus, but anything the corpus would
    // redact must still never be put in `context`.
    const stream = await run(agent, runInput, {
      stream: true,
      maxTurns: input.maxTurns ?? 8,
      signal: abortController.signal,
    });

    for await (const event of stream) {
      // Wire projection (audit D5-a) — toJsonValue materializes the WHOLE raw
      // event into plain JsonValue with no per-field cast.
      yield toJsonValue(event);
    }
    // Ensure the stream is fully drained (guardrails / final-output resolution)
    // before cleanup — mirrors the SDK's own documented usage pattern.
    await stream.completed;
    // Leg 1: the run stopped on the interruption; hand its RunState out.
    if (approval?.mode === "interrupt") approval.onRunState(serializeInterruptedRun(stream));
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await Promise.all(mcpServers.map((server) => server.close()));
  }
}
