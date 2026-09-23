/**
 * The nested-turn capture knobs (sp-probe's `claudeSubagents`): the query
 * options behind `subagents`, the background-launch tracker, and the
 * end-of-input gate that holds a streaming-input capture open until every
 * background sub-run has reported. All pure: no SDK, no network.
 */
import { describe, expect, it, vi } from "vitest";
import type { UUID } from "node:crypto";
import {
  AGENT_TOOL,
  captureIsolationOptions,
  captureQueryExtras,
  claudeSubagentOptions,
  mergeHooks,
  stripAgentIsolation,
  createBackgroundTracker,
  createEndGate,
  gatedPromptStream,
} from "./run.js";

describe("claudeSubagentOptions", () => {
  it("no subagents ⇒ {} (the query stays byte-identical: tools [] and no agents)", () => {
    expect(claudeSubagentOptions({ allowedTools: ["mcp__t__echo"] })).toEqual({});
  });

  it("maps each subagent to an SDK AgentDefinition, enables the Agent tool and auto-allows it once", () => {
    const tools = ["mcp__t__echo"] as const;
    const out = claudeSubagentOptions({
      allowedTools: ["mcp__t__echo"],
      subagents: {
        fg: { description: "d", prompt: "p", tools, model: "claude-sonnet-5", maxTurns: 3 },
        bg: { description: "d2", prompt: "p2", background: true },
      },
    });
    expect(out).toEqual({
      agents: {
        fg: { description: "d", prompt: "p", tools: ["mcp__t__echo"], model: "claude-sonnet-5", maxTurns: 3 },
        bg: { description: "d2", prompt: "p2", background: true },
      },
      tools: [AGENT_TOOL],
      allowedTools: ["mcp__t__echo", AGENT_TOOL],
      hooks: { PreToolUse: [{ matcher: AGENT_TOOL, hooks: [stripAgentIsolation] }] },
    });
    expect(out.agents?.["fg"]?.tools).not.toBe(tools);
    expect(claudeSubagentOptions({ allowedTools: [AGENT_TOOL], subagents: { a: { description: "d", prompt: "p" } } }).allowedTools).toEqual([AGENT_TOOL]);
  });
});

describe("createBackgroundTracker", () => {
  const launch = (id: string, status = "async_launched", agentId = "agent_1"): unknown => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "launched" }] },
    tool_use_result: { status, agentId },
  });
  const note = (fields: Record<string, unknown>): unknown => ({ type: "system", subtype: "task_notification", task_id: "task_1", status: "completed", ...fields });
  const result = { type: "result", subtype: "success" };

  it("a background launch holds the end until its notification arrives AND the turn it wakes closes", () => {
    const t = createBackgroundTracker();
    t.observe(launch("toolu_bg"));
    t.observe(result);
    expect(t.canEnd()).toBe(false);
    t.observe(note({ tool_use_id: "toolu_bg" }));
    expect(t.canEnd()).toBe(false);
    t.observe(result);
    expect(t.canEnd()).toBe(true);
  });

  it("correlates a notification by task_id through task_started, or by task_id = the launch's agentId", () => {
    const viaStarted = createBackgroundTracker();
    viaStarted.observe({ type: "system", subtype: "task_started", task_id: "task_9", tool_use_id: "toolu_a" });
    viaStarted.observe(launch("toolu_a", "async_launched", "other"));
    viaStarted.observe(note({ task_id: "task_9" }));
    viaStarted.observe(result);
    expect(viaStarted.canEnd()).toBe(true);
    const viaAgent = createBackgroundTracker();
    viaAgent.observe(launch("toolu_b", "remote_launched", "agent_7"));
    viaAgent.observe(note({ task_id: "agent_7" }));
    viaAgent.observe(result);
    expect(viaAgent.canEnd()).toBe(true);
  });

  it("no launch (foreground, completed, or an unattributable multi-result frame) and an uncorrelated notification hold nothing", () => {
    const t = createBackgroundTracker();
    t.observe(launch("toolu_fg", "completed"));
    t.observe({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x" }, { type: "tool_result", tool_use_id: "y" }] }, tool_use_result: { status: "async_launched" } });
    t.observe(note({ task_id: "unknown" }));
    t.observe(result);
    expect(t.canEnd()).toBe(true);
    expect(t.pending()).toEqual([]);
  });
});

describe("createEndGate", () => {
  it("resolves at the first onResult(true) after wait(), never on onResult(false)", async () => {
    const g = createEndGate(60_000);
    let done = false;
    const w = g.wait().then(() => { done = true; });
    g.onResult(false);
    await Promise.resolve();
    expect(done).toBe(false);
    g.onResult(true);
    await w;
    expect(done).toBe(true);
  });

  it("resolves at the cap, and release() (the run's finally) resolves it and every later wait()", async () => {
    vi.useFakeTimers();
    try {
      const g = createEndGate(1_000);
      let done = false;
      void g.wait().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    const r = createEndGate(60_000);
    const pending = r.wait();
    r.release();
    await pending;
    await r.wait();
  });
});

describe("gatedPromptStream with an end gate", () => {
  it("the input stays open after the last prompt until the gate opens", async () => {
    let n = 0;
    const mint = (): UUID => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` as const;
    const gate = createEndGate(60_000);
    const { stream } = gatedPromptStream(["only prompt"], mint, gate);
    const it = stream[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ message: { content: "only prompt" } });
    let ended = false;
    const next = it.next().then((r) => { ended = r.done === true; });
    await Promise.resolve();
    expect(ended).toBe(false);
    gate.onResult(true);
    await next;
    expect(ended).toBe(true);
  });
});

describe("capture isolation: never write outside the capture's tree, never load the fleet's memory", () => {
  it("every capture turns Claude's auto-memory OFF by both documented switches (env var and flag setting)", () => {
    expect(captureIsolationOptions()).toEqual({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, settings: { autoMemoryEnabled: false } });
  });

  it("an Agent call that sets isolation is rewritten without it (worktree or remote); every other key is kept", async () => {
    for (const isolation of ["worktree", "remote"]) {
      const out = await stripAgentIsolation({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "d", prompt: "p", subagent_type: "bg", run_in_background: true, isolation } });
      expect(out).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { description: "d", prompt: "p", subagent_type: "bg", run_in_background: true } },
      });
    }
  });

  it("an Agent call without isolation gets no hook output (the call is untouched)", async () => {
    expect(await stripAgentIsolation({ tool_name: "Agent", tool_input: { description: "d", prompt: "p" } })).toEqual({});
    expect(await stripAgentIsolation(null)).toEqual({});
  });

  it("claudeSubagentOptions installs the strip on the Agent tool only, and mergeHooks keeps a scenario's own PreToolUse hook beside it", () => {
    const sub = claudeSubagentOptions({ allowedTools: [], subagents: { a: { description: "d", prompt: "p" } } });
    expect(sub.hooks?.PreToolUse).toEqual([{ matcher: AGENT_TOOL, hooks: [stripAgentIsolation] }]);
    const decision = captureQueryExtras({ preToolUseDecision: "deny" }).hooks;
    const merged = mergeHooks(decision, sub.hooks);
    expect(merged?.PreToolUse).toHaveLength(2);
    expect(merged?.PreToolUse?.[1]).toEqual({ matcher: AGENT_TOOL, hooks: [stripAgentIsolation] });
    expect(mergeHooks(undefined, sub.hooks)).toBe(sub.hooks);
    expect(mergeHooks(undefined, undefined)).toBeUndefined();
    expect(claudeSubagentOptions({ allowedTools: [] })).toEqual({});
  });
});
