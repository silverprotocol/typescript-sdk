/**
 * Without the host-completion event, a final response that carries no branch
 * closes its turn as success on arrival, but ADK keeps running after it: a
 * SequentialAgent's next sub-agent, or a LoopAgent's next iteration. Content
 * that follows such a close opens the next generation of the turn,
 * `<turn>_g<n>`, rather than landing after its terminal. With the
 * host-completion event the close waits, and the run stays one turn.
 *
 * The replier-first shape: an agent that replies, then an agent relaying a
 * remote agent (RemoteA2AAgent) whose remote run ends on an in-band error. Bare,
 * the reply closes the first turn as success, and the error, everything after
 * it and the invocation's one turn.error belong to the second turn.
 */
import { describe, expect, it } from "vitest";
import { AgEvent, JsonValue, Reducer, toJsonValue } from "@silverprotocol/core";
import { ADK_HOST_COMPLETE_TYPE, createAdkNormalizer } from "./index.js";

type Obj = { [k: string]: JsonValue };
const TERMINAL = /^turn\.(done|error|abort)$/;

function run(natives: Obj[], host: boolean, invokeId = "adk"): AgEvent[] {
  const n = createAdkNormalizer({ invokeId, ...(host ? { hostCompletion: true } : {}) });
  return [...natives.flatMap((e) => n.push(toJsonValue(e))), ...(host ? n.push({ type: ADK_HOST_COMPLETE_TYPE }) : []), ...n.flush()];
}
function fold(out: AgEvent[]): Reducer {
  const r = new Reducer();
  for (const e of out) r.push(e);
  return r;
}
const terminals = (out: AgEvent[]): Array<[string, unknown, unknown]> =>
  out.flatMap((e): Array<[string, unknown, unknown]> =>
    TERMINAL.test(e.type) ? [[e.type, Reflect.get(e, "turnId"), Reflect.get(Reflect.get(e, "outcome") ?? {}, "type") ?? Reflect.get(e, "code") ?? null]] : [],
  );
const reply = (inv: string, author: string, text: string): Obj => ({
  invocationId: inv,
  author,
  content: { role: "model", parts: [{ text }] },
  finishReason: "STOP",
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24 },
});
const relayedBlock = (inv: string, task: string): Obj => ({
  invocationId: inv,
  author: "helper",
  turnComplete: true,
  errorCode: "SAFETY",
  errorMessage: "The response was blocked for safety.",
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  customMetadata: { "a2a:request": {}, "a2a:response": { kind: "status-update" }, "a2a:task_id": task, "a2a:context_id": `ctx-${task}` },
});

describe("createAdkNormalizer — content after a bare success close opens the next generation of the turn", () => {
  it("a replier-first run (a LoopAgent of two iterations over an agent that replies and an agent relaying a remote agent whose run ends on a block): bare, the first reply closes turn 1 as success, and the errors, the second reply and the one turn.error belong to turn 2; with host completion it is one turn closing turn.error; every fold is clean", () => {
    for (const i of [0, 1]) {
      const inv = `inv-replier-${i}`;
      const natives = [reply(inv, "planner", `Next ${i}.`), relayedBlock(inv, `task-a-${i}`), reply(inv, "planner", `Next ${i}.`), relayedBlock(inv, `task-b-${i}`)];
      const bare = run(natives, false);
      expect(terminals(bare), `bare #${i}`).toEqual([
        ["turn.done", `turn_adk_${inv}`, "success"],
        ["turn.error", `turn_adk_${inv}_g1`, "SAFETY"],
      ]);
      expect(bare.filter((e) => e.type === "error").map((e) => Reflect.get(e, "turnId")), `bare #${i}`).toEqual([`turn_adk_${inv}_g1`, `turn_adk_${inv}_g1`]);
      expect(fold(bare).needsResync, `bare #${i}`).toBe(false);
      const hc = run(natives, true);
      expect(terminals(hc), `hc #${i}`).toEqual([["turn.error", `turn_adk_${inv}`, "SAFETY"]]);
      expect(fold(hc).needsResync, `hc #${i}`).toBe(false);
    }
  });

  it("an error-free run of two agents that each answer (a SequentialAgent): bare, each final closes its own turn as success, the second in the next generation; with host completion it is one turn closing success; every fold is clean", () => {
    for (const i of [0, 1]) {
      const inv = `inv-two-finals-${i}`;
      const natives = [reply(inv, "first", `First ${i}.`), reply(inv, "second", `Second ${i}.`)];
      const bare = run(natives, false);
      expect(terminals(bare), `bare #${i}`).toEqual([
        ["turn.done", `turn_adk_${inv}`, "success"],
        ["turn.done", `turn_adk_${inv}_g1`, "success"],
      ]);
      expect(fold(bare).needsResync, `bare #${i}`).toBe(false);
      const hc = run(natives, true);
      expect(terminals(hc), `hc #${i}`).toEqual([["turn.done", `turn_adk_${inv}`, "success"]]);
      expect(fold(hc).needsResync, `hc #${i}`).toBe(false);
    }
  });

  it("the next generation's turn id derives from the invoke and the invocation, so two invokes of the same invocation folded through one reducer never share one", () => {
    const natives = [reply("inv-same", "first", "First."), reply("inv-same", "second", "Second.")];
    const both = [...run(natives, false, "run-1"), ...run(natives, false, "run-2")];
    const turnIds = both.filter((e) => e.type === "turn.start").map((e) => Reflect.get(e, "turnId"));
    expect(turnIds).toHaveLength(4);
    expect(new Set(turnIds).size).toBe(4);
    expect(fold(both).needsResync).toBe(false);
  });

  it("an event that only repeats the closed turn's streamed text (ADK's aggregate after a message-less block chunk closed it) stays on that turn and emits nothing, and a text-less event after the close opens no turn", () => {
    for (const i of [0, 1]) {
      const inv = `inv-repeat-${i}`;
      const text = `Hello ${i}`;
      const out = run(
        [
          { invocationId: inv, author: "agent", content: { role: "model", parts: [{ text: text.slice(0, 3) }] }, partial: true },
          { invocationId: inv, author: "agent", content: { role: "model", parts: [{ text: text.slice(3) }] }, partial: true },
          { invocationId: inv, author: "agent", finishReason: "STOP" },
          { invocationId: inv, author: "agent", content: { role: "model", parts: [{ text }] }, partial: false },
          { invocationId: inv, author: "agent", actions: { stateDelta: { step: i } } },
        ],
        false,
      );
      expect(out.filter((e) => e.type === "turn.start"), `#${i}`).toHaveLength(1);
      expect(out.flatMap((e) => (e.type === "text.delta" ? [e.delta] : [])).join(""), `#${i}`).toBe(text);
      expect(fold(out).needsResync, `#${i}`).toBe(false);
    }
  });
});
