import { describe, it, expect } from "vitest";
import { Reducer } from "./reduce.js";
import { ingestAgEvent, type AgIngestReject } from "./ingest.js";
import { AG_EVENT_DEPTH_ALLOWANCE, AG_EVENT_MAX_DEPTH, JSON_SAFE_MAX_DEPTH, JSON_SAFE_MAX_DEPTH_MARK, toJsonValueSafe } from "./wire.js";
import { JsonValue as JsonValueSchema, type AgEvent, type JsonValue } from "./agjson.js";
import { copyJson } from "./copy-json.js";
import { readStoredAgMemoryRecords, readStoredAgMessage, readStoredAgMessages } from "./record.js";
import { toPersistable } from "./persist.js";

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
      it(`${member} at depth ${d}: ingest stubs it in its slot without throwing, and a fold counts the slot, folds nothing and still returns a result`, () => {
        const { pre, ev } = build(d);
        expect(depthOf(ev)).toBe(d);
        const rejects: AgIngestReject[] = [];
        let got: AgEvent | undefined;
        expect(() => {
          got = ingestAgEvent(ev as JsonValue, { onReject: (x) => rejects.push(x) });
        }).not.toThrow();
        expect(rejects).toEqual([]);
        const stub = got as unknown as { type: string; seq: number; ignoredType: string; raw: JsonValue };
        expect([stub.type, stub.seq, stub.ignoredType]).toEqual(["ext.agjson.ignored", ev["seq"], ev["type"]]);
        expect(depthOf(stub)).toBeLessThanOrEqual(AG_EVENT_MAX_DEPTH);
        expect(JSON.stringify(stub.raw)).toContain(JSON_SAFE_MAX_DEPTH_MARK);
        const before = JSON.stringify(foldOf(pre).result());
        let r: Reducer | undefined;
        expect(() => {
          r = foldOf([...pre, ev]);
        }).not.toThrow();
        expect(r!.needsResync).toBe(false);
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

  it("the own-property copy every reader runs reaches any depth: a value 100000 deep copies without throwing, equal and less the member", () => {
    const deep = JSON.parse('{"k":'.repeat(99999) + '{"__proto__":{"x":1},"s":1}' + "}".repeat(99999)) as JsonValue;
    let copy: JsonValue = null;
    expect(() => {
      copy = copyJson(deep);
    }).not.toThrow();
    expect(depthOf(copy)).toBe(100000);
    let x: unknown = copy;
    while (x !== null && typeof x === "object" && Object.hasOwn(x, "k")) x = (x as Record<string, unknown>)["k"];
    expect(Object.hasOwn(x as object, "__proto__")).toBe(false);
    expect(x).toEqual({ s: 1 });
  });

  it("an event pushed directly with a cycle counts its slot and folds nothing, rather than overflowing", () => {
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    const r = foldOf([{ type: "memory.write", seq: 0, scope: "user", key: "k", value: loop }]);
    expect(r.needsResync).toBe(false);
    expect(r.result().memory ?? []).toEqual([]);
  });

  for (const [member, build] of MEMBERS) {
    it(`${member} too deep at seq n: the event at n+1 folds with no gap, pushed directly and through ingest`, () => {
      const built = build(5000);
      // The deep event sits at seq >= 1, where the fold's gap check runs: a member
      // whose stream has no lead event gets one at seq 0.
      const lead = built.pre.length === 0 ? [{ type: "state.snapshot", seq: 0, snapshot: {} }] : [];
      const pre = [...lead, ...built.pre];
      const ev = { ...built.ev, seq: (built.ev["seq"] as number) + lead.length };
      expect(ev["seq"]).toBeGreaterThanOrEqual(1);
      const next = { type: "memory.write", seq: (ev["seq"] as number) + 1, scope: "user", key: "next", value: 1 };
      for (const evs of [
        [...pre, ev, next],
        [...pre, ev, next].map((e) => ingestAgEvent(e as JsonValue)).filter((e) => e !== undefined),
      ]) {
        expect(evs).toHaveLength(pre.length + 2);
        const r = foldOf(evs);
        expect(r.needsResync).toBe(false);
        expect(r.result().memory?.map((m) => m.key)).toEqual(["next"]);
      }
    });
  }
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

  it("a memory.write patch that leaves the value at the stored bound applies; one level more parks", () => {
    const pre = [{ type: "memory.write", seq: 0, scope: "user", key: "k", value: nest(900) }];
    const add = (n: number) => ({ type: "memory.write", seq: 1, scope: "user", key: "k", patch: [{ op: "add", path: "/k".repeat(200) + "/y", value: nest(n) }] });
    const at = foldOf([...pre, add(AG_EVENT_MAX_DEPTH - 1 - 201)]);
    expect(at.needsResync).toBe(false);
    expect(depthOf(at.result().memory?.[0]?.value)).toBe(AG_EVENT_MAX_DEPTH - 1);
    const before = JSON.stringify(foldOf(pre).result());
    const over = foldOf([...pre, add(AG_EVENT_MAX_DEPTH - 201)]);
    expect(over.needsResync).toBe(true);
    expect(JSON.stringify(over.result())).toBe(before);
  });

  it("a memory.write patch that would nest the record's value past the bound parks and keeps the record", () => {
    const pre = [{ type: "memory.write", seq: 0, scope: "user", key: "k", value: nest(900) }];
    const before = JSON.stringify(foldOf(pre).result());
    const r = foldOf([...pre, { type: "memory.write", seq: 1, scope: "user", key: "k", patch: [{ op: "add", path: "/k".repeat(200) + "/y", value: nest(900) }] }]);
    expect(r.needsResync).toBe(true);
    expect(JSON.stringify(r.result())).toBe(before);
  });
});

describe("a stored record reads back whatever the fold took", () => {
  /** A stored message whose one data block's `data` puts its deepest node at record depth `d`. */
  const message = (d: number) => ({ id: "M", role: "assistant", turnId: "T", threadId: "R", content: [{ type: "data", name: "d", data: nest(d - 3) }] });
  const memory = (d: number) => ({ scope: "user", key: "k", value: nest(d - 1) });

  for (const d of [990, AG_EVENT_MAX_DEPTH - 1, AG_EVENT_MAX_DEPTH, AG_EVENT_MAX_DEPTH + AG_EVENT_DEPTH_ALLOWANCE]) {
    it(`a message and a memory record ${d} deep read back whole, with no report`, () => {
      const m = message(d);
      expect(depthOf(m)).toBe(d);
      const read = readStoredAgMessage(m);
      expect(read.reports).toEqual([]);
      expect(read.value).toEqual(m);
      const mem = memory(d);
      expect(depthOf(mem)).toBe(d);
      const memRead = readStoredAgMemoryRecords([mem]);
      expect(memRead.reports).toEqual([]);
      expect(memRead.value).toEqual([mem]);
    });
  }

  for (const d of [AG_EVENT_MAX_DEPTH + AG_EVENT_DEPTH_ALLOWANCE + 1, 5000]) {
    it(`a message and a memory record ${d} deep are reported, without throwing`, () => {
      let read: ReturnType<typeof readStoredAgMessage> | undefined;
      expect(() => {
        read = readStoredAgMessage(message(d));
      }).not.toThrow();
      expect(read!.value).toBeUndefined();
      expect(read!.reports.map((r) => r.path)).toEqual([[]]);
      let memRead: ReturnType<typeof readStoredAgMemoryRecords> | undefined;
      expect(() => {
        memRead = readStoredAgMemoryRecords([memory(d)]);
      }).not.toThrow();
      expect(memRead!.value).toEqual([]);
      expect(memRead!.reports).toHaveLength(1);
    });
  }

  it("a record holding a value that is not plain JSON is still reported, as before (a Date, an object with toJSON, a class instance)", () => {
    class Box {
      v = 1;
    }
    for (const odd of [new Date(0), { toJSON: () => 1 }, new Box()]) {
      const read = readStoredAgMessage({ id: "M", role: "assistant", turnId: "T", threadId: "R", content: [{ type: "data", name: "d", data: { odd } }] });
      expect(read.value).toBeUndefined();
      expect(read.reports.map((r) => r.path)).toEqual([[]]);
      expect(readStoredAgMemoryRecords([{ scope: "user", key: "k", value: { odd } }]).value).toEqual([]);
    }
  });

  const open = [
    { type: "turn.start", seq: 0, turnId: "T", threadId: "R" },
    { type: "message.start", seq: 1, id: "M", turnId: "T", threadId: "R", role: "assistant" },
  ];
  const FOLDS: Array<[string, unknown[]]> = [
    ["a content.block's data", [{ type: "content.block", seq: 2, turnId: "T", messageId: "M", block: { type: "data", name: "d", data: nest(AG_EVENT_MAX_DEPTH - 2) } }]],
    ["a tool.done data block's data", [{ type: "tool.done", seq: 2, turnId: "T", toolCallId: "c1", outcome: "ok", content: [{ type: "data", name: "d", data: nest(AG_EVENT_MAX_DEPTH - 3) }] }]],
    ["a tool.done's structuredContent", [{ type: "tool.done", seq: 2, turnId: "T", toolCallId: "c1", outcome: "ok", content: [], structuredContent: nest(AG_EVENT_MAX_DEPTH - 1) }]],
    [
      "a tool call's assembled input",
      [
        { type: "tool.start", seq: 2, turnId: "T", toolCallId: "c1", name: "f", messageId: "M", index: 0 },
        { type: "tool.args.assembled", seq: 3, toolCallId: "c1", input: nest(AG_EVENT_MAX_DEPTH - 1) },
      ],
    ],
    ["a text block's providerMetadata", [{ type: "text.start", seq: 2, id: "b", messageId: "M", turnId: "T", providerMetadata: { v: nest(AG_EVENT_MAX_DEPTH - 2) } }]],
  ];
  for (const [what, tail] of FOLDS) {
    it(`${what} at the event bound: the folded messages persist and read back with no report`, () => {
      const evs = [...open, ...tail];
      expect(Math.max(...evs.map(depthOf))).toBeLessThanOrEqual(AG_EVENT_MAX_DEPTH);
      const r = foldOf(evs);
      expect(r.needsResync).toBe(false);
      const stored = JSON.parse(JSON.stringify(toPersistable(r.result()).messages)) as unknown[];
      expect(Math.max(...stored.map(depthOf))).toBeGreaterThan(AG_EVENT_MAX_DEPTH);
      const read = readStoredAgMessages(stored);
      expect(read.reports).toEqual([]);
      expect(read.value).toEqual(stored);
    });
  }
});

describe("one scan per pushed event finds the depth and an own __proto__ member", () => {
  /** A DAG `levels` deep whose every level holds the next twice: 2^levels paths, levels+1 objects. */
  const fan = (levels: number): JsonValue => {
    let v: JsonValue = { leaf: 1 };
    for (let i = 0; i < levels; i++) v = { a: v, b: v };
    return v;
  };
  const ownProtoAnywhere = (v: unknown): boolean => {
    const seen = new Set<object>();
    const stack: unknown[] = [v];
    while (stack.length > 0) {
      const x = stack.pop();
      if (x === null || typeof x !== "object" || seen.has(x)) continue;
      seen.add(x);
      if (!Array.isArray(x) && Object.hasOwn(x, "__proto__")) return true;
      for (const y of Object.values(x)) stack.push(y);
    }
    return false;
  };

  it("a class instance holding an own __proto__ data member is folded less the member", () => {
    class Box {
      v = 1;
    }
    const box = new Box();
    Object.defineProperty(box, "__proto__", { value: { polluted: true }, enumerable: true, writable: true, configurable: true });
    expect(Object.hasOwn(structuredClone(box), "__proto__")).toBe(true); // the member survives the clone
    const r = foldOf([{ type: "memory.write", seq: 0, scope: "user", key: "k", value: { inst: box, s: 1 } }]);
    expect(r.needsResync).toBe(false);
    const value = r.result().memory?.[0]?.value;
    expect(ownProtoAnywhere(value)).toBe(false);
    expect(value).toEqual({ inst: { v: 1 }, s: 1 });
  });

  it("an event that shares nodes past the scan's node budget, inside the bound, folds", () => {
    const value = fan(20);
    const r = foldOf([{ type: "memory.write", seq: 0, scope: "user", key: "k", value }]);
    expect(r.needsResync).toBe(false);
    expect(depthOf(r.result().memory?.[0]?.value)).toBe(21);
  });

  it("a large event that shares no node folds: size alone never parks", () => {
    const value = Array.from({ length: 60_000 }, (_, i) => ({ i }));
    const r = foldOf([{ type: "memory.write", seq: 0, scope: "user", key: "k", value }]);
    expect(r.needsResync).toBe(false);
    expect((r.result().memory?.[0]?.value as unknown[]).length).toBe(60_000);
  });

  it("a cycle that fans out counts its slot and folds nothing, without hanging or overflowing", () => {
    const loop: Record<string, unknown> = {};
    loop["a"] = loop;
    loop["b"] = loop;
    const r = foldOf([{ type: "memory.write", seq: 0, scope: "user", key: "k", value: loop }]);
    expect(r.needsResync).toBe(false);
    expect(r.result().memory ?? []).toEqual([]);
  });

  for (const order of ["a before b", "b before a"] as const) {
    it(`a node shared at a shallow and a deep place, past the node budget, is too deep when the deep place puts it past the bound (keys ${order})`, () => {
      const shared = nest(900);
      let deep: JsonValue = { s: shared };
      for (let i = 0; i < 200; i++) deep = { k: deep };
      const value = order === "a before b" ? { a: shared, b: deep, c: fan(20) } : { b: deep, a: shared, c: fan(20) };
      const ev = { type: "memory.write", seq: 0, scope: "user", key: "k", value };
      const rejects: AgIngestReject[] = [];
      expect(ingestAgEvent(ev as unknown as JsonValue, { onReject: (x) => rejects.push(x) })?.type).toBe("ext.agjson.ignored");
      expect(rejects).toEqual([]);
      const r = foldOf([ev]);
      expect(r.needsResync).toBe(false);
      expect(r.result().memory ?? []).toEqual([]);
    });
  }
});

describe("a parse at the bound never throws, however deep the caller's stack", () => {
  /** Runs `f` under `frames` extra stack frames, as a host calling deep inside its own stack does. */
  const under = <T>(frames: number, f: () => T): T => (frames === 0 ? f() : under(frames - 1, f));
  const payload = (d: number) => ({ type: "ext.acme.note", seq: 0, payload: nest(d - 1) });

  for (const frames of [2000, 4000, 6000, 8000]) {
    it(`under ${frames} host frames: an event at the bound is ingested as itself, and one past it as the stub in its slot`, () => {
      const at = payload(AG_EVENT_MAX_DEPTH), past = payload(AG_EVENT_MAX_DEPTH + 1);
      expect(depthOf(at)).toBe(AG_EVENT_MAX_DEPTH);
      let a: AgEvent | undefined, b: AgEvent | undefined;
      expect(() => {
        a = under(frames, () => ingestAgEvent(at as JsonValue));
        b = under(frames, () => ingestAgEvent(past as JsonValue));
      }).not.toThrow();
      expect(a?.type).toBe("ext.acme.note");
      expect(b?.type).toBe("ext.agjson.ignored");
    });
  }

  it("the JsonValue schema parses a value far past any stack depth, with the union's output", () => {
    const v = nest(100_000);
    let out: JsonValue | undefined;
    let threw = false;
    try {
      out = JsonValueSchema.parse(v);
    } catch {
      threw = true;
    }
    // plain values only: a matcher handed the 100,000-deep value would overflow formatting it
    expect(threw).toBe(false);
    expect(depthOf(out)).toBe(100_000);
    expect(out === v).toBe(false);
  });
});
