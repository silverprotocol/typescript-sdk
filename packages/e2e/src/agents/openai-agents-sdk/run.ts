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

import { Agent, MCPServerStreamableHttp, run } from "@openai/agents";
import type { JsonValue } from "@silverprotocol/core";
import { toJsonValue } from "@silverprotocol/core";
import type { CaptureRunInput } from "../types.js";

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

    const agent = new Agent({
      name: "spike",
      instructions: input.systemPrompt ?? "You are a helpful assistant.",
      model: input.model ?? "gpt-4o-mini",
      mcpServers,
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
