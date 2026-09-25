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

import { randomUUID, type UUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition, HookCallbackMatcher, HookEvent, SDKUserMessage, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { JsonValue } from "@silverprotocol/core";
import { toJsonValue } from "@silverprotocol/core";

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
  /**
   * workspace#7: when true the SDK interleaves `stream_event` partial frames
   * (raw Anthropic streaming events) before each complete assistant message —
   * the token-delta wire surface the claude facet normalizes.
   */
  includePartialMessages?: boolean;
  /**
   * Sets `thinking: { type: "adaptive", display }` on the query. Unset keeps the
   * CLI's own selector (connector_text: narration only, no thinking summaries).
   */
  thinkingDisplay?: "summarized" | "omitted";
  /**
   * Multi-result capture (one invoke, several results): when set and
   * non-empty, `query()` runs in STREAMING-INPUT mode. `prompt` is sent first,
   * then each follow-up only after the previous turn's `result` frame has been
   * yielded, and the input ends after the last one. Every streamed prompt
   * carries a caller-minted `uuid`, so the SDK stamps `user_message_uuid(s)` on
   * its reply frames. Absent or empty ⇒ the plain string prompt, byte-identical
   * to before (the live receipt for the facet's one-turnId-per-turn fix).
   */
  followUpPrompts?: string[];
  /**
   * Installs a PreToolUse hook that returns this `permissionDecision` for every
   * tool call. "defer" parks the call: the CLI ends the turn and reports it as
   * the result's `deferred_tool_use` (the claude facet carries it on
   * `ext.anthropic.result-meta.deferredToolUse`; R&D candidate 20's live
   * receipt). "allow" and "deny" are the two resume legs' decisions ("deny"
   * exercises the decline path: permission_denials → tool.done{outcome:"denied"}).
   * Absent ⇒ no hooks option, byte-identical to before.
   */
  preToolUseDecision?: "defer" | "allow" | "deny";
  /**
   * Resume an earlier session (the SDK's `resume`), always FORKED
   * (`forkSession: true`): each resume branches from the saved session under a
   * new session id and leaves the original untouched, so two resume legs from
   * one session (allow, deny) each start from exactly that session's state,
   * never from each other's (sdk.d.ts `forkSession`). Absent ⇒ a new session.
   */
  resumeSessionId?: string;
  /**
   * Programmatic subagents (the SDK's `options.agents`), for the nested-turn
   * captures (the `claudeSubagents` scenario knob). Set ⇒ the built-in
   * Agent tool is enabled and auto-allowed (see `claudeSubagentOptions`), and a
   * `background: true` subagent runs the query in streaming-input mode that
   * stays open until every background launch has reported (see
   * `createBackgroundTracker`). Absent ⇒ no agents and `tools: []`,
   * byte-identical to before.
   */
  subagents?: Readonly<
    Record<
      string,
      {
        description: string;
        prompt: string;
        tools?: readonly string[];
        model?: string;
        maxTurns?: number;
        background?: boolean;
      }
    >
  >;
}

/** The built-in tool that spawns a subagent (SDK 0.3.x names it "Agent"). */
export const AGENT_TOOL = "Agent";

/**
 * The query() options behind `subagents`: the SDK `agents` record, the built-in
 * Agent tool enabled (in place of `tools: []`), and Agent added to the
 * auto-allowed tools. No `subagents` ⇒ `{}` (byte-identical query). Pure, so the
 * unit test and the harness's KNOB_SUPPORT proof need no SDK.
 */
export function claudeSubagentOptions(input: Pick<CaptureRunInput, "subagents" | "allowedTools">): {
  agents?: Record<string, AgentDefinition>;
  tools?: string[];
  allowedTools?: string[];
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
} {
  const subagents = input.subagents;
  if (subagents === undefined) return {};
  const agents: Record<string, AgentDefinition> = {};
  for (const [name, def] of Object.entries(subagents)) {
    agents[name] = {
      description: def.description,
      prompt: def.prompt,
      ...(def.tools !== undefined ? { tools: [...def.tools] } : {}),
      ...(def.model !== undefined ? { model: def.model } : {}),
      ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
      ...(def.background !== undefined ? { background: def.background } : {}),
    };
  }
  const allowed = input.allowedTools ?? [];
  return {
    agents,
    tools: [AGENT_TOOL],
    allowedTools: allowed.includes(AGENT_TOOL) ? [...allowed] : [...allowed, AGENT_TOOL],
    hooks: { PreToolUse: [{ matcher: AGENT_TOOL, hooks: [stripAgentIsolation] }] },
  };
}

/**
 * A capture must never write outside its own tree. The Agent tool's
 * `isolation: "worktree"` makes the CLI create a git worktree under
 * `.claude/worktrees` at the repository root, which for a git worktree is the
 * main checkout (a background capture was seen setting it unprompted, and the
 * CLI created that directory there). `"remote"` launches a
 * cloud run. So this PreToolUse hook (matched to Agent) rewrites any Agent call
 * that sets `isolation` to the same call without it (`updatedInput`; the CLI
 * validates it against the tool's schema). A call without it gets no output.
 */
export async function stripAgentIsolation(hookInput: unknown): Promise<
  { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "allow"; updatedInput: Record<string, unknown> } } | Record<string, never>
> {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const toolInput = isObj(hookInput) ? hookInput["tool_input"] : undefined;
  if (!isObj(toolInput) || !("isolation" in toolInput)) return {};
  const updatedInput: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(toolInput)) if (k !== "isolation") updatedInput[k] = v;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } };
}

/**
 * Every capture runs with Claude's AUTO-MEMORY OFF. CLI 2.1.280 enables it by
 * default regardless of `settingSources: []` (its gate reads only the
 * CLAUDE_CODE_DISABLE_AUTO_MEMORY env var, CLAUDE_CODE_SIMPLE, and the
 * `autoMemoryEnabled` setting), and resolves the directory from the repository
 * root, so a capture session loaded the local project's memory index into its
 * prompt, with write access to that directory (init advertised
 * `memory_paths.auto`). The corpus is public, so captures run with auto-memory
 * off and no local state reaches it.
 * Both documented switches are set: the env var, and the flag-settings layer's
 * `autoMemoryEnabled: false` ("Claude will not read from or write to the
 * auto-memory directory").
 */
export function captureIsolationOptions(): { env: Record<string, string>; settings: Settings } {
  return { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, settings: { autoMemoryEnabled: false } };
}

/** Merge two hook maps: the PreToolUse matcher lists are CONCATENATED (a
 *  scenario's decision hook and the Agent isolation strip both run); any other
 *  event key is kept as-is (neither source sets one today). */
export function mergeHooks(
  a: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
  b: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const pre = [...(a.PreToolUse ?? []), ...(b.PreToolUse ?? [])];
  return { ...a, ...b, ...(pre.length > 0 ? { PreToolUse: pre } : {}) };
}

/** How long a capture holds its input open for background sub-runs to report. */
export const BACKGROUND_HOLD_CAP_MS = 180_000;

/**
 * Tracks background subagent launches across the native stream, so the capture
 * ends its input only once every launch has reported and the turn it woke has
 * closed. A launch is the Agent tool_result whose `tool_use_result.status` is
 * "async_launched" / "remote_launched" (keyed by its tool_use_id; its `agentId`
 * is recorded too). A report is the `system/task_notification` correlated by
 * its `tool_use_id`, else by its `task_id` through the `task_started` frame
 * that named it, else by `task_id` = the launch's `agentId`. The report wakes a
 * turn, so the input may end at the NEXT result with nothing still pending.
 * Nothing is filtered: this only reads the frames the capture yields anyway.
 */
export function createBackgroundTracker(): {
  observe(msg: unknown): void;
  canEnd(): boolean;
  pending(): readonly string[];
} {
  const pending = new Set<string>();
  const toolUseByTask = new Map<string, string>();
  let awaitingWokenResult = false;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  return {
    observe(msg: unknown): void {
      if (!isObj(msg)) return;
      if (msg["type"] === "user") {
        const message = msg["message"];
        const content = isObj(message) ? message["content"] : undefined;
        const results = Array.isArray(content) ? content.filter((b) => isObj(b) && b["type"] === "tool_result") : [];
        const sibling = msg["tool_use_result"];
        const status = isObj(sibling) ? sibling["status"] : undefined;
        if (results.length === 1 && (status === "async_launched" || status === "remote_launched")) {
          const block = results[0];
          const id = isObj(block) && typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : undefined;
          if (id !== undefined) {
            pending.add(id);
            if (isObj(sibling) && typeof sibling["agentId"] === "string") toolUseByTask.set(sibling["agentId"], id);
          }
        }
        return;
      }
      if (msg["type"] === "system" && typeof msg["task_id"] === "string") {
        const named = typeof msg["tool_use_id"] === "string" ? msg["tool_use_id"] : undefined;
        if (msg["subtype"] === "task_started" && named !== undefined) toolUseByTask.set(msg["task_id"], named);
        if (msg["subtype"] === "task_notification") {
          const key = named ?? toolUseByTask.get(msg["task_id"]);
          if (key !== undefined && pending.delete(key)) awaitingWokenResult = true;
        }
        return;
      }
      if (msg["type"] === "result") awaitingWokenResult = false;
    },
    canEnd(): boolean {
      return pending.size === 0 && !awaitingWokenResult;
    },
    pending(): readonly string[] {
      return [...pending];
    },
  };
}

/**
 * The end-of-input gate for streaming-input mode: after the last prompt, the
 * prompt stream awaits `wait()`, which resolves at the first `onResult(true)`
 * after it was called, at `capMs` after it was called, or on `release()`
 * (always called when the run ends, so the stream can never hang).
 */
export function createEndGate(capMs: number): {
  wait(): Promise<void>;
  onResult(canEnd: boolean): void;
  release(): void;
} {
  let resolveWait: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let released = false;
  const finish = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const r = resolveWait;
    resolveWait = undefined;
    r?.();
  };
  return {
    wait(): Promise<void> {
      if (released) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveWait = resolve;
        timer = setTimeout(finish, capMs);
      });
    },
    onResult(canEnd: boolean): void {
      if (canEnd && resolveWait !== undefined) finish();
    },
    release(): void {
      released = true;
      finish();
    },
  };
}

/**
 * The query() options behind `preToolUseDecision` and `resumeSessionId`, as a
 * pure builder so the unit test can exercise the installed hook without the
 * SDK. Returns only the keys that were asked for.
 */
export function captureQueryExtras(input: Pick<CaptureRunInput, "preToolUseDecision" | "resumeSessionId">): {
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  resume?: string;
  forkSession?: boolean;
} {
  const decision = input.preToolUseDecision;
  return {
    ...(decision !== undefined
      ? {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async () => ({
                    hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: decision },
                  }),
                ],
              },
            ],
          },
        }
      : {}),
    ...(input.resumeSessionId !== undefined ? { resume: input.resumeSessionId, forkSession: true } : {}),
  };
}

/**
 * The streaming-input prompt source behind `followUpPrompts`: yields the first
 * prompt at once and each later one only after `resultSeen()` is called (the
 * run loop calls it on every `result` frame), then ends. Exported for its unit
 * test, which exercises the gate without the SDK.
 */
export function gatedPromptStream(
  prompts: readonly string[],
  mintUuid: () => UUID = randomUUID,
  endGate?: { wait(): Promise<void> },
): { stream: AsyncIterable<SDKUserMessage>; resultSeen: () => void } {
  let release: (() => void) | undefined;
  let pendingReleases = 0;
  const resultSeen = (): void => {
    if (release !== undefined) {
      const r = release;
      release = undefined;
      r();
    } else {
      pendingReleases++;
    }
  };
  async function* stream(): AsyncIterable<SDKUserMessage> {
    for (let i = 0; i < prompts.length; i++) {
      if (i > 0) {
        if (pendingReleases > 0) pendingReleases--;
        else await new Promise<void>((resolve) => { release = resolve; });
      }
      const text = prompts[i];
      if (text === undefined) continue;
      yield {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        uuid: mintUuid(),
      };
    }
    // Background subagents: hold the input open until every launch reported
    // (or the cap), so the CLI can deliver the task_notification and wake a turn.
    if (endGate !== undefined) await endGate.wait();
  }
  return { stream: stream(), resultSeen };
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
    { type: "http"; url: string; headers: { Authorization: string }; alwaysLoad: true }
  > = {};
  for (const [name, cfg] of Object.entries(input.mcpServers)) {
    sdkMcpServers[name] = {
      type: "http",
      url: cfg.url,
      headers: { Authorization: `Bearer ${cfg.bearer}` },
      // SDK 0.3.199 introduced tool-search deferred loading: by default an
      // HTTP MCP server's tools are NOT included in the turn-1 prompt — the
      // model must invoke a built-in tool-search capability to discover them
      // first. This harness disables ALL built-in tools (`tools: []` below,
      // by design — captures must exercise ONLY the scenario's declared MCP
      // tools), which also removes that tool-search capability, so a
      // deferred MCP tool schema is NEVER loaded into context. Verified
      // empirically live (playbook 2026-07-03): without `alwaysLoad`, the
      // model narrates a fabricated `<tool_call>...</tool_call>` in PLAIN
      // TEXT instead of emitting a real `tool_use` content block (the SDK
      // never sees the tool exists) — silently producing a hallucinated
      // "capture" with zero real tool calls in the native stream. Setting
      // `alwaysLoad: true` forces the server's tools to be eagerly included
      // in the prompt every time (bypassing tool-search entirely), matching
      // this harness's synchronous single-mock-server startup, at the cost
      // of blocking `query()` startup on the mock server's connect (capped
      // at the SDK's standard 5s timeout — negligible for a local mock).
      alwaysLoad: true,
    };
  }

  const followUps = input.followUpPrompts ?? [];
  // A background subagent needs streaming-input mode: a plain string prompt ends
  // the input at the first result, before its task_notification can arrive.
  const background =
    input.subagents !== undefined && Object.values(input.subagents).some((d) => d.background === true)
      ? { tracker: createBackgroundTracker(), gate: createEndGate(BACKGROUND_HOLD_CAP_MS) }
      : undefined;
  const gated =
    followUps.length > 0 || background !== undefined
      ? gatedPromptStream([input.prompt, ...followUps], randomUUID, background?.gate)
      : undefined;
  const extras = captureQueryExtras(input);
  const subagentExtras = claudeSubagentOptions(input);
  const hooks = mergeHooks(extras.hooks, subagentExtras.hooks);
  const isolation = captureIsolationOptions();
  const response = query({
    prompt: gated !== undefined ? gated.stream : input.prompt,
    options: {
      model: input.model ?? "claude-sonnet-4-6",
      mcpServers: sdkMcpServers,
      allowedTools: input.allowedTools,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: input.maxTurns ?? 8,
      env: { ANTHROPIC_API_KEY: apiKey, ...isolation.env },
      settings: isolation.settings,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.includePartialMessages === true ? { includePartialMessages: true } : {}),
      ...(input.thinkingDisplay !== undefined
        ? { thinking: { type: "adaptive" as const, display: input.thinkingDisplay } }
        : {}),
      ...extras,
      ...subagentExtras,
      ...(hooks !== undefined ? { hooks } : {}),
      abortController,
    },
  });

  try {
    for await (const msg of response) {
      // Wire projection (audit D5-a) — toJsonValue materializes the WHOLE raw
      // message (including fields typed as `unknown` by the SDK) into plain JsonValue.
      yield toJsonValue(msg);
      if (background !== undefined) {
        background.tracker.observe(msg);
        if (msg.type === "result") background.gate.onResult(background.tracker.canEnd());
      }
      // Multi-result capture: a turn ended, so release the next prompt (after
      // the result frame itself was yielded).
      if (gated !== undefined && msg.type === "result") gated.resultSeen();
    }
  } finally {
    background?.gate.release();
    // Remove the abort listener (no-op if it was never added) so a long-lived
    // caller signal doesn't accumulate listeners across captures.
    signal?.removeEventListener("abort", onAbort);
  }
}
