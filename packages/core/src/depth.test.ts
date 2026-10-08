import { describe, it, expect } from "vitest";
import { Reducer } from "./reduce.js";
import { ingestAgEvent, type AgIngestReject } from "./ingest.js";
import { AG_EVENT_DEPTH_ALLOWANCE, AG_EVENT_MAX_DEPTH, JSON_SAFE_MAX_DEPTH, toJsonValueSafe } from "./wire.js";
import type { AgEvent, JsonValue } from "./agjson.js";
import { copyJson } from "./copy-json.js";

/** A value whose deepest node sits `n` levels below its own root (n = 0: a primitive). */
const nest = (n: number): JsonValue => {
  let v: JsonValue = 1;
  for (let i = 0; i < n; i++) v = { k: v };
  return v;
};
/** The depth of an event's deepest node, the root at 0, by an iterative walk. */
const depthOf = (v: unknown): number => {
  let max = 0;
  const stack: Array<[unknown, number]> = [[v, 0]];
  while (stack.length > 0) {
    const [x, d] = stack.pop()!;
    if (d > max) max = d;
    if (x !== null && typeof x === "object") for (const y of Object.values(x)) stack.push([y, d + 1]);
  }
  return max;
};

/**
 * Each JSON-valued member, as the stream that carries it with its deepest node
 * at event depth `d`: the events before it (so a fold has somewhere to put it)
 * and the event itself.
 */
const MEMBERS: Array<[string, (d: number) => { pre: unknown[]; ev: Record<string, unknown> }]> = [
  ["an ext event's payload member", (d) => ({ pre: [], ev: { type: "ext.acme.note", seq: 0, payload: nest(d - 1) } })],
  [
    "a tool.done data block's data",
    (d) => ({
      pre: [
        { type: "turn.start", seq: 0, turnId: "T", threadId: "R" },
        { type: "message.start", seq: 1, id: "M", turnId: "T", threadId: "R", role: "assistant" },
      ],
      ev: { type: "tool.done", seq: 2, turnId: "T", toolCallId: "c1", outcome: "ok", content: [{ type: "data", name: "d", data: nest(d - 3) }] },
    }),
  ],
  [
    "a state.delta operation's value",
    (d) => ({ pre: [{ type: "state.snapshot", seq: 0, snapshot: {} }], ev: { type: "state.delta", seq: 1, patch: [{ op: "add", path: "/x", value: nest(d - 3) }] } }),
  ],
  ["a memory.write value", (d) => ({ pre: [], ev: { type: "memory.write", seq: 0, scope: "user", key: "k", value: nest(d - 1) } })],
  [
    "a turn.done's messageMetadata",
    (d) => ({
      pre: [{ type: "turn.start", seq: 0, turnId: "T", threadId: "R" }],
      ev: { type: "turn.done", seq: 1, turnId: "T", outcome: { type: "success" }, finishReason: "stop", messageMetadata: nest(d - 1) },
    }),
  ],
];

const foldOf = (evs: unknown[]): Reducer => {
  const r = new Reducer();
  for (const e of evs) r.push(e as AgEvent);
  return r;
};

describe("an event nested past the event bound", () => {
  it("the bound is the emit side's cap plus the envelope allowance", () => {
    expect(AG_EVENT_MAX_DEPTH).toBe(JSON_SAFE_MAX_DEPTH + AG_EVENT_DEPTH_ALLOWANCE);
    expect(AG_EVENT_MAX_DEPTH).toBe(1016);
  });

  for (const [member, build] of MEMBERS) {
    for (const d of [AG_EVENT_MAX_DEPTH - 1, AG_EVENT_MAX_DEPTH]) {
      it(`${member} at depth ${d}: ingest returns the event, and a fold takes it without parking`, () => {
        const { pre, ev } = build(d);
        expect(depthOf(ev)).toBe(d);
        const rejects: AgIngestReject[] = [];
        const got = ingestAgEvent(ev as JsonValue, { onReject: (x) => rejects.push(x) });
        expect(rejects).toEqual([]);
        expect(got?.type).toBe(ev["type"]);
        const r = foldOf([...pre, ev]);
        expect(r.needsResync).toBe(false);
        expect(() => r.result()).not.toThrow();
      });
    }
    for (const d of [AG_EVENT_MAX_DEPTH + 1, 2000, 5000, 12000]) {
      it(`${member} at depth ${d}: ingest rejects it as depth-exceeded without throwing, and a fold parks on it, folds nothing and still returns a result`, () => {
        const { pre, ev } = build(d);
        expect(depthOf(ev)).toBe(d);
        const rejects: AgIngestReject[] = [];
        let got: AgEvent | undefined;
        expect(() => {
          got = ingestAgEvent(ev as JsonValue, { onReject: (x) => rejects.push(x) });
        }).not.toThrow();
        expect(got).toBeUndefined();
        expect(rejects.map((x) => x.reason)).toEqual(["depth-exceeded"]);
        const before = JSON.stringify(foldOf(pre).result());
        let r: Reducer | undefined;
        expect(() => {
          r = foldOf([...pre, ev]);
        }).not.toThrow();
        expect(r!.needsResync).toBe(true);
        expect(JSON.stringify(r!.result())).toBe(before);
      });
    }
  }

  it("a carry the emit side capped stays readable: a value capped by toJsonValueSafe, carried three levels down, is ingested and folded", () => {
    const capped = toJsonValueSafe(nest(5000));
    const ev = { type: "content.block", seq: 1, turnId: "T", messageId: "M", block: { type: "data", name: "d", data: { entry: capped } } };
    expect(depthOf(ev)).toBe(JSON_SAFE_MAX_DEPTH + 3);
    const rejects: AgIngestReject[] = [];
    expect(ingestAgEvent(ev as JsonValue, { onReject: (x) => rejects.push(x) })?.type).toBe("content.block");
    expect(rejects).toEqual([]);
  });

  it("the own-property copy every reader runs reaches any depth: a value 5000 deep copies without throwing, equal and less the member", () => {
    const deep = JSON.parse('{"k":'.repeat(4999) + '{"__proto__":{"x":1},"s":1}' + "}".repeat(4999)) as JsonValue;
    let copy: JsonValue = null;
    expect(() => {
      copy = copyJson(deep);
    }).not.toThrow();
    expect(depthOf(copy)).toBe(5000);
    let x: unknown = copy;
    while (x !== null && typeof x === "object" && Object.hasOwn(x, "k")) x = (x as Record<string, unknown>)["k"];
    expect(Object.hasOwn(x as object, "__proto__")).toBe(false);
    expect(x).toEqual({ s: 1 });
  });

  it("an event pushed directly with a cycle parks rather than overflowing", () => {
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    const r = foldOf([{ type: "memory.write", seq: 0, scope: "user", key: "k", value: loop }]);
    expect(r.needsResync).toBe(true);
    expect(() => r.result()).not.toThrow();
  });
});

describe("a state or memory value composed past the bound by successive patches", () => {
  // Each add nests a value 900 deep under the deepest point the last one left,
  // through a path string: every event stays shallow, the value it builds does not.
  const step = (seq: number, path: string) => ({ type: "state.delta", seq, patch: [{ op: "add", path, value: nest(900) }] });

  it("the patch that would leave state deeper than a state.snapshot could carry parks, and the state keeps the last value", () => {
    const evs: unknown[] = [{ type: "state.snapshot", seq: 0, snapshot: {} }, step(1, "/x")];
    const ok = foldOf(evs);
    expect(ok.needsResync).toBe(false);
    expect(depthOf(ok.result().state)).toBe(901);
    const before = JSON.stringify(ok.result());
    const deeper = "/x" + "/k".repeat(200) + "/y";
    const r = foldOf([...evs, step(2, deeper)]);
    expect(r.needsResync).toBe(true);
    expect(JSON.stringify(r.result())).toBe(before);
  });

  it("the same add short of the bound applies (the state reaches the bound exactly)", () => {
    const at = "/x" + "/k".repeat(AG_EVENT_MAX_DEPTH - 1 - 902) + "/y";
    const r = foldOf([{ type: "state.snapshot", seq: 0, snapshot: {} }, step(1, "/x"), step(2, at)]);
    expect(r.needsResync).toBe(false);
    expect(depthOf(r.result().state)).toBe(AG_EVENT_MAX_DEPTH - 1);
  });

  it("one level more parks: a state.snapshot carrying that state would exceed the event bound", () => {
    const at = "/x" + "/k".repeat(AG_EVENT_MAX_DEPTH - 902) + "/y";
    const r = foldOf([{ type: "state.snapshot", seq: 0, snapshot: {} }, step(1, "/x"), step(2, at)]);
    expect(r.needsResync).toBe(true);
    expect(depthOf(r.result().state)).toBe(901);
  });

  it("a memory.write patch that would nest the record's value past the bound parks and keeps the record", () => {
    const pre = [{ type: "memory.write", seq: 0, scope: "user", key: "k", value: nest(900) }];
    const before = JSON.stringify(foldOf(pre).result());
    const r = foldOf([...pre, { type: "memory.write", seq: 1, scope: "user", key: "k", patch: [{ op: "add", path: "/k".repeat(200) + "/y", value: nest(900) }] }]);
    expect(r.needsResync).toBe(true);
    expect(JSON.stringify(r.result())).toBe(before);
  });
});
