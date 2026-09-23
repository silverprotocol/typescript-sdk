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

import { Agent, MCPServerStreamableHttp, type ModelSettings, run } from "@openai/agents";
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
 * Yields the RAW native `@openai/agents` `RunStreamEvent` stream, unnormalized,
 * each item materialized as a plain `JsonValue` via `toJsonValue` (audit
 * D5-a's native-ingestion boundary — the whole event, no per-field cast).
 */
export async function* runOpenaiCapture(input: CaptureRunInput): AsyncIterable<JsonValue> {
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
    const agent = new Agent({
      name: "spike",
      instructions: input.systemPrompt ?? "You are a helpful assistant.",
      model: input.model ?? "gpt-4o-mini",
      mcpServers,
      ...(modelSettings !== undefined ? { modelSettings } : {}),
    });

    const stream = await run(agent, input.prompt, {
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
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await Promise.all(mcpServers.map((server) => server.close()));
  }
}
