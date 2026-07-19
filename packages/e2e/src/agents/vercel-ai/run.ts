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

import { stepCountIs, streamText, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { JsonValue } from "@silverprotocol/core";
import { toJsonValue } from "@silverprotocol/core";
import type { CaptureRunInput } from "../types.js";

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
      // part into plain JsonValue with no per-field cast.
      yield toJsonValue(part);
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
}
