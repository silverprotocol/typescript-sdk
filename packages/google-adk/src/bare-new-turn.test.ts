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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("an event that only repeats the closed turn's streamed text (ADK's aggregate after a message-less block chunk closed it) stays on that turn and emits nothing, and a state-only event after it opens the next turn", () => {
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
      expect(out.filter((e) => e.type === "turn.start").map((e) => Reflect.get(e, "turnId")), `#${i}`).toEqual([`turn_adk_${inv}`, `turn_adk_${inv}_g1`]);
      expect(out.flatMap((e) => (e.type === "text.delta" ? [e.delta] : [])).join(""), `#${i}`).toBe(text);
      expect(out.filter((e) => e.type === "state.delta").map((e) => Reflect.get(e, "turnId")), `#${i}`).toEqual([`turn_adk_${inv}_g1`]);
      expect(fold(out).needsResync, `#${i}`).toBe(false);
    }
  });

  it("a repeat of the closed turn's text that carries ADK's empty stateDelta emits that one state.delta on the closed turn, and nothing else of it", () => {
    for (const i of [0, 1]) {
      const inv = `inv-repeat-state-${i}`;
      const text = `Hello ${i}`;
      const out = run(
        [
          { invocationId: inv, author: "agent", content: { role: "model", parts: [{ text: text.slice(0, 3) }] }, partial: true },
          { invocationId: inv, author: "agent", content: { role: "model", parts: [{ text: text.slice(3) }] }, partial: true },
          { invocationId: inv, author: "agent", finishReason: "STOP" },
          { invocationId: inv, author: "agent", content: { role: "model", parts: [{ text }] }, partial: false, actions: { stateDelta: {} } },
        ],
        false,
      );
      const end = out.findIndex((e) => TERMINAL.test(e.type));
      expect(out.slice(end + 1).map((e) => [e.type, Reflect.get(e, "turnId")]), `#${i}`).toEqual([["state.delta", `turn_adk_${inv}`]]);
      expect(out.filter((e) => e.type === "turn.start"), `#${i}`).toHaveLength(1);
      expect(fold(out).needsResync, `#${i}`).toBe(false);
    }
  });
});

/** Events that name a turn, by turnId or through a message of that turn, after the turn's terminal. */
function afterTerminal(out: AgEvent[]): string[] {
  const closed = new Set<string>();
  const turnOf = new Map<string, string>();
  const found: string[] = [];
  for (const e of out) {
    const id: unknown = Reflect.get(e, "id");
    const ownTurn: unknown = Reflect.get(e, "turnId");
    const messageId: unknown = Reflect.get(e, "messageId");
    if (e.type === "message.start" && typeof id === "string" && typeof ownTurn === "string") turnOf.set(id, ownTurn);
    const turn =
      typeof ownTurn === "string" ? ownTurn : typeof messageId === "string" ? turnOf.get(messageId) : e.type === "message.end" && typeof id === "string" ? turnOf.get(id) : undefined;
    if (turn !== undefined && closed.has(turn)) found.push(`${e.type} @${turn}`);
    if (TERMINAL.test(e.type) && typeof ownTurn === "string") closed.add(ownTurn);
  }
  return found;
}

describe("createAdkNormalizer — after a bare success close, no later event of the invocation names the closed turn", () => {
  const live = (inv: string, i: number): Obj[] => [
    { invocationId: inv, author: "voice", content: { role: "model", parts: [{ text: `Hi ${i}.` }] }, modelVersion: "gemini-live-x" },
    { invocationId: inv, author: "voice", turnComplete: true, modelVersion: "gemini-live-x" },
    { invocationId: inv, author: "voice", usageMetadata: { promptTokenCount: 7 + i, candidatesTokenCount: 2, totalTokenCount: 9 + i }, modelVersion: "gemini-live-x" },
    { invocationId: inv, author: "voice", content: { role: "model", parts: [{ functionCall: { name: "lookup", id: `c-${i}`, args: {} } }] }, modelVersion: "gemini-live-x" },
    { invocationId: inv, author: "voice", content: { role: "user", parts: [{ functionResponse: { name: "lookup", id: `c-${i}`, response: { ok: true } } }] } },
    { invocationId: inv, author: "voice", content: { role: "model", parts: [{ text: `Found ${i}.` }] }, modelVersion: "gemini-live-x" },
    { invocationId: inv, author: "voice", turnComplete: true, modelVersion: "gemini-live-x" },
  ];
  /** Each shape as [label, the natives after the reply that closes the first turn]. */
  const shapes = (inv: string, i: number): Array<[string, Obj[]]> => [
    ["the relay's own failure (an error message and turnComplete, no error code)", [{ invocationId: inv, author: "helper", errorMessage: `Remote agent request failed ${i}`, turnComplete: true }]],
    ["a usage report carrying modelVersion", [{ invocationId: inv, author: "planner", modelVersion: "gemini-x", usageMetadata: { promptTokenCount: 3 + i, candidatesTokenCount: 1, totalTokenCount: 4 + i } }]],
    ["a state-only callback event", [{ invocationId: inv, author: "planner", actions: { stateDelta: { step: i } } }]],
    ["an event carrying only branch and nodeInfo", [{ invocationId: inv, author: "planner", branch: `root.b${i}`, nodeInfo: { path: `wf/n${i}` } }]],
    ["a prompt block", [{ invocationId: inv, author: "planner", errorCode: "SAFETY" }]],
  ];

  it("a Live text generation, then a tool-call generation that opens on a usage report carrying modelVersion: the report opens the second generation and its usage counts there, and the fold is clean", () => {
    for (const i of [0, 1]) {
      const inv = `inv-live-${i}`;
      const out = run(live(inv, i), false);
      expect(afterTerminal(out), `#${i}`).toEqual([]);
      expect(fold(out).needsResync, `#${i}`).toBe(false);
      const ends = out.filter((e) => TERMINAL.test(e.type));
      expect(ends.map((e) => e.type), `#${i}`).toEqual(["turn.done", "turn.done"]);
      expect(Reflect.get(ends[1] ?? {}, "usage"), `#${i}`).toMatchObject({ inputTokens: 7 + i });
    }
  });

  it("after a reply closes the first turn, each content-less shape (the relay's code-less failure, a usage report with modelVersion, a state-only callback, a branch and nodeInfo carry, a prompt block) opens a second turn, nothing names the first after its terminal, and the fold is clean", () => {
    for (const i of [0, 1]) {
      const inv = `inv-shape-${i}`;
      for (const [label, later] of shapes(inv, i)) {
        const out = run([reply(inv, "planner", `Hello ${i}.`), ...later], false);
        const tag = `${label} #${i}`;
        expect(afterTerminal(out), tag).toEqual([]);
        expect(fold(out).needsResync, tag).toBe(false);
        expect(new Set(out.filter((e) => e.type === "turn.start").map((e) => Reflect.get(e, "turnId"))), tag).toEqual(new Set([`turn_adk_${inv}`, `turn_adk_${inv}_g1`]));
        expect(terminals(out)[0], tag).toEqual(["turn.done", `turn_adk_${inv}`, "success"]);
      }
    }
  });

  it("with the host-completion event each of those runs stays one turn closing once", () => {
    for (const i of [0, 1]) {
      const inv = `inv-shape-hc-${i}`;
      for (const [label, later] of [...shapes(inv, i), ["a Live tool-call generation", live(inv, i)] as [string, Obj[]]]) {
        const natives = label === "a Live tool-call generation" ? later : [reply(inv, "planner", `Hello ${i}.`), ...later];
        const out = run(natives, true);
        expect(terminals(out).length, `${label} #${i}`).toBeGreaterThan(0);
        expect(afterTerminal(out), `${label} #${i}`).toEqual([]);
        expect(fold(out).needsResync, `${label} #${i}`).toBe(false);
      }
    }
  });
});

describe("createAdkNormalizer — the two events that stay on a turn after its bare success close", () => {
  it("ADK's bare {interrupted} re-yield after a generation that closed as success emits nothing: no second turn, nothing after the terminal", () => {
    for (const i of [0, 1]) {
      const inv = `inv-reyield-${i}`;
      const out = run(
        [
          { invocationId: inv, author: "voice", content: { role: "model", parts: [{ text: `Hi ${i}.` }] } },
          { invocationId: inv, author: "voice", turnComplete: true },
          { invocationId: inv, author: "voice", interrupted: true },
        ],
        false,
      );
      expect(out.filter((e) => e.type === "turn.start"), `#${i}`).toHaveLength(1);
      expect(terminals(out), `#${i}`).toEqual([["turn.done", `turn_adk_${inv}`, "success"]]);
      expect(out.at(-1)?.type, `#${i}`).toBe("turn.done");
      expect(fold(out).needsResync, `#${i}`).toBe(false);
    }
  });

  it("on the two engine-built oracle runs whose aggregate repeats the closed turn's text, bare, the one event after the terminal is that aggregate's state.delta {} on the closed turn, and it leaves the fold's state and turns as they were, with no resync", () => {
    const dir = join(import.meta.dirname, "..", "..", "e2e", "fixtures", "adk-oracle");
    for (const f of ["block-after-text-bare.np.native.json", "block-after-text-usage.np.native.json"]) {
      const raw: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const natives: Obj[] = Array.isArray(raw) ? raw.filter((e): e is Obj => typeof e === "object" && e !== null && !Array.isArray(e)) : [];
      const out = run(natives, false);
      const end = out.findIndex((e) => TERMINAL.test(e.type));
      const closed = Reflect.get(out[end] ?? {}, "turnId");
      expect(out.slice(end + 1).map((e) => [e.type, Reflect.get(e, "turnId"), Reflect.get(e, "patch")]), f).toEqual([["state.delta", closed, {}]]);
      const before = fold(out.slice(0, end + 1));
      const after = fold(out);
      expect(after.needsResync, f).toBe(false);
      expect(JSON.stringify(after.result()), f).toBe(JSON.stringify(before.result()));
    }
  });
});
