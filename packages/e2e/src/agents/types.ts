/**
 * types.ts — the shared CaptureRunInput contract every capture agent
 * implements (claude-agent-sdk, openai-agents-sdk, google-adk).
 *
 * Each agent's `run.ts` defines its own `runXCapture(input: CaptureRunInput):
 * AsyncIterable<JsonValue>` — the LLM/process boundary that yields the RAW
 * native event stream, unnormalized. capture.ts (the harness) is written
 * against THIS shared shape so it can dispatch to any of the three agents
 * without importing framework-specific types.
 *
 * The claude-agent-sdk agent (Task 5 / pre-existing) declares its own
 * structurally-identical `CaptureRunInput` in `claude-agent-sdk/run.ts` — left
 * untouched (frozen, smoke-tested) rather than migrated to import this file,
 * since TypeScript's structural typing makes the two interchangeable at every
 * call site that types against this shared shape.
 */
import type { JsonValue } from "@silverprotocol/core";

export interface CaptureRunInput {
  /** The user prompt to run. */
  prompt: string;
  /**
   * MCP servers to attach. Keys are server names; values carry the HTTP URL
   * and a bearer token used for the Authorization header.
   */
  mcpServers: Record<string, { url: string; bearer: string }>;
  /** Tool names that are auto-allowed without a permission prompt. */
  allowedTools: string[];
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Model ID. Each agent picks its own framework-appropriate default. */
  model?: string;
  /** Maximum number of agent turns. Each agent picks its own default. */
  maxTurns?: number;
  /**
   * The provider API key. Falls back to the framework's own env var. Throws a
   * clear error at ITERATION time (not at import/call time — the boundary is
   * an async generator) when absent.
   */
  apiKey?: string;
  /** Optional abort signal — bridged into whatever cancellation primitive the
   *  underlying SDK requires. */
  abortSignal?: AbortSignal;
}

/** The LLM/process boundary contract every capture agent implements. */
export type CaptureRunFn = (input: CaptureRunInput) => AsyncIterable<JsonValue>;
