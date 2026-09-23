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
   * Claude follow-up prompts (claude-agent-sdk only): streamed into the SAME
   * query() after each previous `result`, so one invoke yields one result per
   * prompt. Agents without the concept ignore it. See scenario.ts `followUps`.
   */
  followUpPrompts?: string[];
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
  /**
   * workspace#7: enable token-granular partial frames in the native stream.
   * Claude-only today (`includePartialMessages: true` on the Agent SDK query);
   * agents without a partials concept ignore it.
   */
  includePartialMessages?: boolean;
  /**
   * Gemini thinking knob (google-adk only today): maps to
   * `generateContentConfig.thinkingConfig { includeThoughts: true,
   * thinkingLevel }` on the LlmAgent; agents without a thinking-level concept
   * ignore it. Thought summaries are OFF by default on gemini-3.7-flash, so a
   * capture without this can never produce `thought: true` parts.
   */
  thinkingLevel?: "low" | "medium" | "high";
  /**
   * Claude thinking display (claude-agent-sdk only): sets the Agent SDK's
   * `thinking: { type: "adaptive", display }`. Agents without the concept ignore
   * it. See scenario.ts for why "summarized" is required for streamed thinking.
   */
  thinkingDisplay?: "summarized" | "omitted";
  /**
   * OpenAI reasoning summaries (openai-agents only): maps to the Agent's
   * `modelSettings.reasoning.summary`. Agents without the concept ignore it.
   * See scenario.ts for why the commentary capture needs it.
   */
  reasoningSummary?: "auto" | "concise" | "detailed";
  /** claude-agent-sdk only: a PreToolUse hook returns this permissionDecision
   *  for every tool call ("defer" parks it as the result's deferred_tool_use). */
  preToolUseDecision?: "defer" | "allow" | "deny";
  /** claude-agent-sdk only: resume this earlier session (the SDK's `resume`). */
  resumeSessionId?: string;
  /** google-adk only: a scripted state-writing tool (apply_state_step) writes
   *  entry `step - 1` through toolContext.state (sp-google 5bc5351). */
  adkStateScript?: ReadonlyArray<Readonly<Record<string, JsonValue>>>;
  /** google-adk only: called once after a normal run with ADK's own
   *  session.state read back (never yielded as a native event). */
  onSessionState?: (state: JsonValue) => void;
}

/** The LLM/process boundary contract every capture agent implements. */
export type CaptureRunFn = (input: CaptureRunInput) => AsyncIterable<JsonValue>;
