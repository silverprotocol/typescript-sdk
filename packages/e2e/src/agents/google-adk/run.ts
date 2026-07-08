/**
 * Standalone Google ADK capture agent for the E2E conformance harness
 * (Task 6 / audit M60 — the design's own promised Slice B capture agent).
 *
 * ★ RETARGETED to the OFFICIAL `@google/adk` (google/adk-js 1.3.0) ★
 *
 * HISTORY: at first-capture time this agent was wired to the COMMUNITY
 * `@iqai/adk` TS port because the OFFICIAL SDK's TS release lagged. It is now
 * on the OFFICIAL `@google/adk` — the exact SDK `@silverprotocol/google-adk`'s
 * normalizer targets. The fixture-drift ratchet's `sdk-surface.json` ALSO
 * migrated its Event/LlmResponse ground truth to `@google/adk` (2026-07-08 —
 * see the manifest's own `$comment`), so `@iqai/adk` has been REMOVED from the
 * e2e devDependencies entirely; it is no longer imported OR resolved anywhere.
 * The native `Event` stream
 * this agent yields is a Gemini `Content` (role + `parts[]`) plus the
 * `LlmResponse` metadata (`partial` / `turnComplete` / `errorCode` /
 * `finishReason` / `actions`) — the SAME wire shape the normalizer + the
 * `extractAdkToolCalls` reader (`content.parts[].functionCall`) consume, so the
 * corpus stays comparable across the community→official swap.
 *
 * ★ MCP transport: NATIVE, no bridge ★
 *
 * The official `MCPToolset` speaks Streamable HTTP directly
 * (`type: "StreamableHTTPConnectionParams"`, `POST /mcp`) — the exact transport
 * `mcp-mocks/serve.ts` (and the claude + openai capture agents) implement. So
 * the `@iqai`-era `tools/list` + `BaseTool`-proxy bridge (which existed ONLY
 * because that port's `McpToolset` spoke stdio/SSE, never Streamable HTTP) is
 * DELETED: each configured mock server becomes one native `MCPToolset` handed
 * straight to the agent's `tools[]` (a `MCPToolset` is a `BaseToolset`, i.e. a
 * valid `ToolUnion` — the runner expands it via `getTools()` during the flow).
 * The whole agent engine — LLM loop, turn/event stream, tool-call decisioning
 * — is 100% real `@google/adk`.
 *
 * OPERATOR-GATED: requires a Gemini API key (`CaptureRunInput.apiKey` or the
 * `GEMINI_API_KEY` / `GOOGLE_GENAI_API_KEY` environment variable) at ITERATION
 * time (the function is an async generator — no work happens, and no key check
 * fires, until the caller starts iterating). `@google/adk`'s `GoogleLlm`
 * resolves its key from `GOOGLE_GENAI_API_KEY || GEMINI_API_KEY` at
 * model-construction time (no per-call apiKey param is plumbed through the
 * string-model path), so this module seeds that var from the resolved key
 * before building the agent. Live capture is operator-run; this module + its
 * smoke test only confirm module load, callable shape, and the key-absent
 * failure — no live SDK run, no mock server booted.
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
  const apiKey = input.apiKey ?? process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_GENAI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is required: set it via CaptureRunInput.apiKey or the GEMINI_API_KEY environment variable",
    );
  }
  // `GoogleLlm` reads `GOOGLE_GENAI_API_KEY || GEMINI_API_KEY` — seed the
  // higher-priority var from the resolved key so an explicit
  // `CaptureRunInput.apiKey` always wins over any stale ambient value.
  process.env["GOOGLE_GENAI_API_KEY"] = apiKey;

  // One native MCPToolset per configured mock server, over Streamable HTTP.
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
      userId: "spike-user",
    });

    const stream = runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      // `role: "user"` is MANDATORY — omitting it 400s on tool follow-ups
      // (upstream google/adk-js#475). See launch/validation/e2e-adk-*.mjs.
      newMessage: { role: "user", parts: [{ text: input.prompt }] },
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });

    for await (const event of stream) {
      // Wire projection (audit D5-a) — toJsonValue materializes the WHOLE raw
      // ADK Event into plain JsonValue with no per-field cast.
      yield toJsonValue(event);
    }
  } finally {
    // Release the MCP client sessions each toolset opened during the flow.
    await Promise.all(toolsets.map((toolset) => toolset.close()));
  }
}
