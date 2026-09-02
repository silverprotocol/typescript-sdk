/**
 * Standalone Vercel AI SDK capture agent for the E2E conformance harness
 * (4th facet — mirrors ../google-adk/run.ts's contract exactly).
 *
 * Runs a real `streamText` tool loop (`ai` + `@ai-sdk/openai` — the capture
 * exercises the OpenAI provider, so the operator gate is OPENAI_API_KEY, the
 * SAME key as framework "openai") and yields the RAW native `TextStreamPart`
 * union from `result.fullStream` as `JsonValue` items — unnormalized. This is
 * the exact surface `@silverprotocol/vercel-ai`'s normalizer reads (on v7
 * `fullStream` is aliased to `result.stream`; we iterate the name that exists
 * across the whole supported peer range).
 *
 * MCP wiring: `experimental_createMCPClient` no longer ships in `ai` core v7 —
 * the client graduated to `@ai-sdk/mcp` (stable `createMCPClient`). Its
 * `transport: { type: "http", url, headers }` IS the Streamable HTTP transport
 * `mcp-mocks/serve.ts` implements. The bearer rides `transport.headers` (a
 * first-class field). `client.tools()` returns an AI-SDK `ToolSet` keyed by
 * BARE MCP tool names (matches scenario.ts derivedTools' non-claude arm).
 *
 * maxTurns → `stopWhen: stepCountIs(n)`: one AI-SDK step is one LLM call
 * round — mirror the other agents' `maxTurns ?? 8` so same-corpus captures
 * stay comparable. abortSignal passes straight through (streamText takes an
 * AbortSignal natively).
 *
 * OPERATOR-GATED: requires `OPENAI_API_KEY` (or `CaptureRunInput.apiKey`) at
 * ITERATION time (async generator — no work, and no key check, until the
 * caller starts iterating). Unlike the openai-agents agent there is NO
 * process.env mutation: `createOpenAI({ apiKey })` scopes the key per-call.
 * Live capture is operator-run; this module + its smoke test only confirm
 * module load, callable shape, and the key-absent failure — no live SDK run,
 * no mock server booted.
 */

import { stepCountIs, streamText, type TextStreamPart, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { JsonValue } from "@silverprotocol/core";
import { toJsonValue } from "@silverprotocol/core";
import type { CaptureRunInput } from "../types.js";

/**
 * Project the Error instances a fullStream part can carry at its top level
 * (`error.error` — since ai@7.0.80 ALWAYS a `StreamProviderError` instance
 * wrapping the provider frame; `tool-error.error`; `tool-call{invalid}.error`)
 * to `{ name, message, ...ownEnumerableProps }` BEFORE the JsonValue
 * round-trip. `JSON.stringify` emits only own ENUMERABLE string keys, and an
 * Error's `message` is own but non-enumerable (`name` lives on the prototype
 * for plain Errors), so the bare round-trip yields `{}` for a plain Error and
 * `{name, cause, type, code, statusCode, isRetryable, data}` — no `message` —
 * for a StreamProviderError: a live capture's error arm would then diverge
 * from its replay (the normalizer's `errText` reads `.message`). A nested
 * Error `cause` projects recursively. A part carrying no Error instance is
 * returned BY REFERENCE, so every other part's serialization is byte-identical
 * to the unprojected round-trip.
 *
 * LOCAL to this capture agent by design: core's `toJsonValue` is the shared
 * wire projection and the same Error→`{}` gap latently exists for any facet
 * whose native frames can carry Error instances — noted for the cohort,
 * not fixed here.
 */
export function projectStreamPartErrors(part: TextStreamPart<ToolSet>): unknown {
  let projected: { [k: string]: unknown } | undefined;
  for (const [key, value] of Object.entries(part)) {
    if (value instanceof Error) {
      // fromEntries preserves the part's own-key insertion order exactly.
      projected ??= Object.fromEntries(Object.entries(part));
      projected[key] = projectError(value);
    }
  }
  return projected ?? part;
}

/** `{ name, message }` first, then every own enumerable prop verbatim (an
 *  AISDKError's own `name` re-lands on the same key; `cause` recurses). */
function projectError(e: Error): { [k: string]: unknown } {
  const out: { [k: string]: unknown } = { name: e.name, message: e.message };
  for (const [key, value] of Object.entries(e)) {
    out[key] = value instanceof Error ? projectError(value) : value;
  }
  return out;
}

/**
 * Yields the RAW native `TextStreamPart` stream from `streamText().fullStream`,
 * unnormalized, each item materialized as a plain `JsonValue` via `toJsonValue`
 * (audit D5-a's native-ingestion boundary — the whole part, no per-field cast).
 */
export async function* runVercelCapture(input: CaptureRunInput): AsyncIterable<JsonValue> {
  const apiKey = input.apiKey ?? process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required: set it via CaptureRunInput.apiKey or the OPENAI_API_KEY environment variable",
    );
  }
  // Per-call key scoping — the AI SDK provider factory takes the key
  // directly, so no process.env write is needed (unlike @openai/agents).
  const openai = createOpenAI({ apiKey });

  // One MCP client per configured mock server; merge each server's ToolSet.
  // Keys are BARE tool names (scenario mocks use distinct names per server).
  const clients: MCPClient[] = [];
  try {
    let tools: ToolSet = {};
    for (const cfg of Object.values(input.mcpServers)) {
      const client = await createMCPClient({
        transport: {
          type: "http", // Streamable HTTP — the exact transport serve.ts speaks
          url: cfg.url,
          headers: { Authorization: `Bearer ${cfg.bearer}` },
        },
      });
      clients.push(client);
      tools = { ...tools, ...(await client.tools()) };
    }

    const result = streamText({
      model: openai(input.model ?? "gpt-4o-mini"),
      system: input.systemPrompt ?? "You are a helpful assistant.",
      prompt: input.prompt,
      tools,
      // One step = one LLM call round — mirrors the other agents' maxTurns ?? 8.
      stopWhen: stepCountIs(input.maxTurns ?? 8),
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });

    for await (const part of result.fullStream) {
      // Wire projection (audit D5-a) — toJsonValue materializes the WHOLE raw
      // part into plain JsonValue with no per-field cast. Error instances are
      // projected first so their `message` survives the round-trip (see
      // projectStreamPartErrors); Error-free parts pass through by reference.
      yield toJsonValue(projectStreamPartErrors(part));
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
}
