/**
 * Keyless unit tests for the openai capture agent's approval / resume path
 * (sp-main work order, 2026-09-24: the OpenAI approval-resume capture,
 * evidence for the fold/flush package's Q2). No API key, no network, no MCP
 * server: every helper is pure. The one SDK round-trip, a real RunState through
 * toString / fromString, needs no model call.
 */
import { describe, expect, it } from "vitest";
// Static on purpose (see run.smoke.test.ts): the vendor SDK's cold load runs at
// collection, which vitest does not time.
import { Agent, RunContext, RunState, tool, webSearchTool, type Tool } from "@openai/agents";
import {
  applyApprovalDecision,
  openaiApprovalPlan,
  serializeInterruptedRun,
  withRequiredApproval,
  type ApprovalState,
} from "./run.js";

const noop = (): void => {};

describe("openaiApprovalPlan — the knobs validate before any network call", () => {
  it("absent ⇒ undefined (the agent is built exactly as before)", () => {
    expect(openaiApprovalPlan({})).toBeUndefined();
  });

  it('"interrupt" (leg 1) with onRunState ⇒ the interrupt plan', () => {
    expect(openaiApprovalPlan({ toolApproval: "interrupt", onRunState: noop })).toMatchObject({ mode: "interrupt" });
  });

  it.each(["approve", "reject"] as const)('"%s" (a resume leg) with resumeRunState ⇒ the resume plan carrying the decision', (decision) => {
    expect(openaiApprovalPlan({ toolApproval: decision, resumeRunState: "STATE" })).toEqual({
      mode: "resume",
      decision,
      runState: "STATE",
    });
  });

  it.each([
    ["interrupt without onRunState (the leg-1 RunState would be lost)", { toolApproval: "interrupt" as const }, /needs onRunState/],
    ["interrupt that also resumes", { toolApproval: "interrupt" as const, onRunState: noop, resumeRunState: "S" }, /must not resume/],
    ["approve without resumeRunState", { toolApproval: "approve" as const }, /needs resumeRunState/],
    ["reject without resumeRunState", { toolApproval: "reject" as const }, /needs resumeRunState/],
    ["resumeRunState without toolApproval", { resumeRunState: "S" }, /toolApproval is not/],
  ])("FAILS LOUD: %s", (_label, input, message) => {
    expect(() => openaiApprovalPlan(input)).toThrow(message);
  });
});

describe("withRequiredApproval — every function tool needs approval; nothing is mutated", () => {
  const echo = tool({
    name: "echo",
    description: "Echoes the input.",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
    strict: true,
    execute: async (args: unknown) => JSON.stringify(args),
  });

  it("a function tool's copy needs approval, keeps its name and invoke, and the original stays unapproved", async () => {
    const [wrapped] = withRequiredApproval([echo]);
    if (wrapped === undefined || wrapped.type !== "function") throw new Error("expected a function tool");
    const ctx = new RunContext();
    expect(await wrapped.needsApproval(ctx, { message: "hi" }, "call_1")).toBe(true);
    expect(await echo.needsApproval(ctx, { message: "hi" }, "call_1")).toBe(false);
    expect(wrapped.name).toBe("echo");
    expect(wrapped.invoke).toBe(echo.invoke);
    expect(wrapped).not.toBe(echo);
  });

  it("a non-function (hosted) tool passes through by reference", () => {
    const hosted: Tool = webSearchTool();
    const [same] = withRequiredApproval([hosted]);
    expect(same).toBe(hosted);
  });
});

describe("applyApprovalDecision — the resume leg's decision reaches every pending interruption", () => {
  function fakeState(pending: string[]): ApprovalState<string> & { approved: string[]; rejected: string[] } {
    const approved: string[] = [];
    const rejected: string[] = [];
    return {
      approved,
      rejected,
      getInterruptions: () => pending,
      approve: (item) => void approved.push(item),
      reject: (item) => void rejected.push(item),
    };
  }

  it("approve ⇒ approve() for each, reject() for none", () => {
    const s = fakeState(["a", "b"]);
    expect(applyApprovalDecision(s, "approve")).toBe(2);
    expect(s.approved).toEqual(["a", "b"]);
    expect(s.rejected).toEqual([]);
  });

  it("reject ⇒ reject() for each, approve() for none", () => {
    const s = fakeState(["a"]);
    expect(applyApprovalDecision(s, "reject")).toBe(1);
    expect(s.rejected).toEqual(["a"]);
    expect(s.approved).toEqual([]);
  });

  it("FAILS LOUD with zero pending interruptions (the resume would re-run nothing)", () => {
    expect(() => applyApprovalDecision(fakeState([]), "approve")).toThrow(/no pending approval/);
  });

  it("a REAL SDK RunState round-trips through toString / fromString, and one with no interruption fails loud", async () => {
    const agent = new Agent({ name: "spike", instructions: "x" });
    const state = new RunState(new RunContext(), "prompt", agent, 8);
    const restored = await RunState.fromString(agent, state.toString());
    expect(restored.getInterruptions()).toEqual([]);
    expect(() => applyApprovalDecision(restored, "approve")).toThrow(/no pending approval/);
  });
});

describe("serializeInterruptedRun — leg 1's RunState, only for a run that really stopped", () => {
  it("interruptions present ⇒ the state's serialization", () => {
    expect(serializeInterruptedRun({ interruptions: [{}], state: { toString: () => "SERIALIZED" } })).toBe("SERIALIZED");
  });

  it("FAILS LOUD when the run ended with NO interruption (no approval-gated tool was called)", () => {
    expect(() => serializeInterruptedRun({ interruptions: [], state: { toString: () => "S" } })).toThrow(/NO approval interruption/);
  });
});
