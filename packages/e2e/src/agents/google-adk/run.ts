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
 * turn/event stream — is 100% official SDK. The wire this yields is the
 * official `Event extends LlmResponse` interface
 * (events/event.d.ts; `content.parts[]` uses the real `@google/genai`
 * `Content`/`Part` types — the SAME Gemini wire shape
 * `google-adk/src/index.ts`'s header cites as its primary source, so the
 * normalizer under test needed no change: it was retargeted to the official
 * peer in v0.3.0 and live-validated by launch/validation/e2e-adk-google*.mjs).
 *
 * `newMessage.role: "user"` is LOAD-BEARING on ≤1.3.0: a role-less Content
 * triggered an upstream 400 (google/adk-js#475, filed by @wanseob; diagnosed
 * to root cause in the v0.3.1 fix). Upstream merged the fix 2026-07-13
 * (google/adk-js#478 — defaults role to 'user' when omitted; unreleased as of
 * 1.3.0). Keep setting it explicitly regardless: correct on every version,
 * and explicit beats defaulted for a conformance capture.
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

import { InMemoryRunner, LlmAgent, MCPToolset } from "@google/adk";
import type { JsonValue } from "@silverprotocol/core";
import { toJsonValue } from "@silverprotocol/core";
import type { CaptureRunInput } from "../types.js";

/**
 * Yields the RAW native `@google/adk` `Event` stream, unnormalized, each item
 * materialized as a plain `JsonValue` via `toJsonValue` (audit D5-a's
 * native-ingestion boundary — the whole event, no per-field cast).
 */
export async function* runAdkCapture(input: CaptureRunInput): AsyncIterable<JsonValue> {
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
    const agent = new LlmAgent({
      name: "spike",
      model: input.model ?? "gemini-2.5-flash",
      instruction: input.systemPrompt ?? "You are a helpful assistant.",
      tools: toolsets,
    });
    const runner = new InMemoryRunner({ agent });
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: "user-1",
    });

    const stream = runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      // role:"user" is load-bearing — see header (google/adk-js#475).
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
  } finally {
    await Promise.all(toolsets.map((toolset) => toolset.close()));
  }
}
