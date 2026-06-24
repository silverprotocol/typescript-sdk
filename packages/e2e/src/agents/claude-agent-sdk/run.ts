/**
 * Standalone Claude capture agent for the E2E conformance harness.
 *
 * Runs a real Claude Agent SDK `query()` and yields its RAW native `SDKMessage`
 * stream as `JsonValue` items — unnormalized. The harness captures this stream
 * directly and pipes it through the normalizer under test in a separate step.
 *
 * This module is ALSO the de-ggui'd replacement for the silverprotocol example
 * agent (two birds, one stone):
 *   - ZERO `@ggui-ai/*` imports
 *   - NO module-load CLI resolution (`resolveClaudeCliPath` / `spawnClaudeCli` /
 *     `pathToClaudeCodeExecutable` are deliberately absent — SDK 0.2.141 ships a
 *     native binary and self-resolves it at run time, not at import time)
 *   - The `query()` call omits `pathToClaudeCodeExecutable` and
 *     `spawnClaudeCodeProcess`; the SDK manages its own executable lifecycle
 *
 * Live run is exercised by the OPERATOR in Task 7. This module + its smoke test
 * only confirm: (a) module loads without throwing, (b) the function is callable
 * and returns an AsyncIterable without starting the SDK.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { JsonValue } from "@silverprotocol/core";

// ─── Public interface ─────────────────────────────────────────────────────────

export interface CaptureRunInput {
  /** The user prompt to run. */
  prompt: string;
  /**
   * MCP servers to attach. Keys are server names; values carry the HTTP URL and
   * a bearer token used for the Authorization header.
   */
  mcpServers: Record<string, { url: string; bearer: string }>;
  /** Tool names that are auto-allowed without a permission prompt. */
  allowedTools: string[];
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Model ID, e.g. "claude-sonnet-4-6". Defaults to "claude-sonnet-4-6". */
  model?: string;
  /** Maximum number of agent turns. Defaults to 8. */
  maxTurns?: number;
  /**
   * Anthropic API key. Falls back to `process.env.ANTHROPIC_API_KEY`.
   * Throws a clear error at iteration time (not at import time) when absent.
   */
  apiKey?: string;
  /** Optional abort signal — bridged to the AbortController the SDK requires. */
  abortSignal?: AbortSignal;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Yields the RAW native `SDKMessage` stream from the Claude Agent SDK,
 * unnormalized, each item materialized as a plain `JsonValue` via a JSON
 * round-trip. The round-trip is intentional: it materializes the WHOLE
 * message (including the `tool_use_result` sibling that 0.2.141 declares
 * as `unknown` on `SDKUserMessage`) into plain `JsonValue` with no per-field
 * cast.
 *
 * Deliberately omitted from the `query()` call:
 *   - `pathToClaudeCodeExecutable` — the SDK self-resolves its native binary
 *   - `spawnClaudeCodeProcess` — same reason; we never need to override spawning
 */
export async function* runClaudeCapture(input: CaptureRunInput): AsyncIterable<JsonValue> {
  const apiKey = input.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required: set it via CaptureRunInput.apiKey or the ANTHROPIC_API_KEY environment variable",
    );
  }

  // Bridge the optional AbortSignal into an AbortController (the SDK takes a
  // controller, not a signal).  If the caller doesn't provide a signal we
  // create a standalone controller so the query can still be cleaned up.
  const abortController = new AbortController();
  const signal = input.abortSignal;
  // Named listener so the `finally` below can remove it — avoids leaking a
  // listener on a caller-owned long-lived signal (T4 review).
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

  // Translate the harness-friendly mcpServers map into the SDK's McpHttpServerConfig
  // shape (lifted from the ggui sample agent.ts L226-236, minus the @ggui-ai/* deps).
  const sdkMcpServers: Record<
    string,
    { type: "http"; url: string; headers: { Authorization: string } }
  > = {};
  for (const [name, cfg] of Object.entries(input.mcpServers)) {
    sdkMcpServers[name] = {
      type: "http",
      url: cfg.url,
      headers: { Authorization: `Bearer ${cfg.bearer}` },
    };
  }

  const response = query({
    prompt: input.prompt,
    options: {
      model: input.model ?? "claude-sonnet-4-6",
      mcpServers: sdkMcpServers,
      allowedTools: input.allowedTools,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: input.maxTurns ?? 8,
      env: { ANTHROPIC_API_KEY: apiKey },
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      abortController,
    },
  });

  try {
    for await (const msg of response) {
      // JSON round-trip materializes the WHOLE raw message (including fields typed
      // as `unknown` by the SDK, e.g. SDKUserMessage's tool_use_result sibling)
      // into plain JsonValue. No per-field cast needed.
      yield JSON.parse(JSON.stringify(msg)) as JsonValue;
    }
  } finally {
    // Remove the abort listener (no-op if it was never added) so a long-lived
    // caller signal doesn't accumulate listeners across captures.
    signal?.removeEventListener("abort", onAbort);
  }
}
