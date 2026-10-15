import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloneError, cloneValue } from "./clone.js";
import { Reducer } from "./reduce.js";
import { applyPatch } from "./json-patch.js";
import { toPersistable } from "./persist.js";
import type { AgEvent, JsonValue } from "./agjson.js";

/** Descriptor-level shape of a value: own keys in order, holes, prototypes, sharing. */
function shape(v: unknown, seen = new Map<object, number>()): unknown {
  if (v === null || typeof v !== "object") return typeof v === "number" && Object.is(v, -0) ? "-0" : v;
  if (seen.has(v)) return { ref: seen.get(v) };
  seen.set(v, seen.size);
  const proto = Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype);
  const own = Reflect.ownKeys(v).filter((k) => !(Array.isArray(v) && k === "length"));
  return {
    array: Array.isArray(v),
    length: Array.isArray(v) ? v.length : undefined,
    proto,
    members: own.map((k) => {
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      return [String(k), d.enumerable, d.writable, d.configurable, shape(d.value, seen)];
    }),
  };
}

describe("cloneValue — the structuredClone result on every value the fold holds", () => {
  const cyc: Record<string, unknown> = { n: 1 };
  cyc.self = cyc;
  const shared = { s: [1] };
  const withProto = JSON.parse('{"__proto__":{"x":1},"a":1}') as JsonValue;
  const nullProto = Object.assign(Object.create(null) as object, { z: 1 });
  const arrExtra = Object.assign([1, 2], { extra: "e" });
  class K {
    k = 1;
  }
  const cases: [string, unknown][] = [
    ["primitives", [null, true, 0, -0, Number.NaN, "s", undefined, 1n]],
    ["undefined in arrays and as a value", { a: [1, undefined, 3], u: undefined }],
    // eslint-disable-next-line no-sparse-arrays
    ["holes", [1, , 3]],
    ["key order (integer keys first)", { b: 1, 2: 1, a: 1, 1: 1 }],
    ["an own __proto__ member", withProto],
    ["a null-prototype object", nullProto],
    ["array extras", arrExtra],
    ["a class instance", new K()],
    ["a cycle", cyc],
    ["a shared node", { a: shared, b: [shared] }],
    ["a deep JSON tree", JSON.parse("[".repeat(500) + "]".repeat(500))],
  ];
  for (const [name, v] of cases) {
    it(name, () => {
      expect(shape(cloneValue(v))).toEqual(shape(structuredClone(v)));
      if (v !== null && typeof v === "object") expect(cloneValue(v)).not.toBe(v);
    });
  }

  it("never overflows the stack (iterative): 100 000 levels", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    let c = cloneValue(deep);
    let n = 0;
    while (Array.isArray(c)) {
      c = c[0];
      n++;
    }
    expect(n).toBe(100_000);
  });

  it("reads each member once (a getter runs once), and drops non-enumerable and symbol keys", () => {
    let calls = 0;
    const o = {
      get v() {
        calls++;
        return 1;
      },
    };
    Object.defineProperty(o, "hidden", { value: 1, enumerable: false });
    (o as Record<symbol, number>)[Symbol("s")] = 1;
    const c = cloneValue(o);
    expect(calls).toBe(1);
    expect(Reflect.ownKeys(c)).toEqual(["v"]);
  });

  it("throws on a function or a symbol, as structuredClone does", () => {
    for (const bad of [{ f: () => 1 }, [Symbol("s")], () => 1]) {
      expect(() => structuredClone(bad)).toThrow();
      expect(() => cloneValue(bad)).toThrow(CloneError);
    }
  });

  it("throws on a typed built-in, which structuredClone copies by type and no AgJSON value holds", () => {
    for (const bad of [new Date(0), /x/, new Map(), new Set(), new Error("e"), new Uint8Array(1), new ArrayBuffer(1), Object(1)]) {
      expect(() => cloneValue({ v: bad })).toThrow(CloneError);
    }
  });
});

describe("without a global structuredClone (React Native / Hermes)", () => {
  const g = globalThis as { structuredClone?: unknown };
  const saved = g.structuredClone;
  beforeAll(() => {
    delete g.structuredClone;
  });
  afterAll(() => {
    g.structuredClone = saved;
  });

  it("the global is gone for these tests", () => {
    expect(typeof g.structuredClone).toBe("undefined");
  });

  const startEvents = (): AgEvent[] => [
    { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
    { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
    { type: "text.start", seq: 2, id: "b1", turnId: "t1", providerMetadata: { vendor: { k: 1 } } } as AgEvent,
    { type: "text.delta", seq: 3, id: "b1", delta: "hi" },
  ];

  it("push() isolates the fold from the host's event (mutate after push)", () => {
    const acc = new Reducer();
    const evs = startEvents();
    for (const e of evs) acc.push(e);
    (evs[2] as unknown as { providerMetadata: { vendor: { k: number } } }).providerMetadata.vendor.k = 99;
    expect(JSON.stringify(acc.result().messages)).not.toContain("99");
  });

  it("state.snapshot then an object state.delta: each value is the fold's own copy", () => {
    const acc = new Reducer();
    const snap = { type: "state.snapshot", seq: 0, snapshot: { a: [1, undefined, 3] } } as unknown as AgEvent;
    const value = { deep: [1] };
    const delta = { type: "state.delta", seq: 1, patch: { b: value } } as unknown as AgEvent;
    acc.push(snap);
    acc.push(delta);
    value.deep.push(2);
    const state = acc.result().state as { a: unknown[]; b: { deep: number[] } };
    expect(state.b.deep).toEqual([1]);
    expect(state.a).toHaveLength(3);
    expect(1 in state.a && state.a[1] === undefined).toBe(true); // undefined kept, never null
  });

  it("an RFC 6902 state.delta applies on a copy", () => {
    const acc = new Reducer();
    acc.push({ type: "state.snapshot", seq: 0, snapshot: { list: [1] } });
    const op = { op: "add", path: "/obj", value: { v: 1 } };
    acc.push({ type: "state.delta", seq: 1, patch: [op] } as unknown as AgEvent);
    op.value.v = 2;
    expect(acc.result().state).toEqual({ list: [1], obj: { v: 1 } });
  });

  it("messages.snapshot stores its own copy of messages, turns, artifacts and memory", () => {
    const acc = new Reducer();
    const ev = {
      type: "messages.snapshot",
      seq: 0,
      messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "a" }], turnId: "t1", threadId: "th1" }],
      turns: [{ turnId: "t1", threadId: "th1" }],
      artifacts: [{ artifactId: "a1", name: "r", parts: [{ type: "text", text: "p" }], turnId: "t1", threadId: "th1" }],
      memory: [{ scope: "thread", key: "k", value: { v: 1 } }],
    };
    acc.push(ev as unknown as AgEvent);
    ev.messages[0]!.content[0]!.text = "MOVED";
    ev.turns[0]!.threadId = "MOVED";
    ev.artifacts[0]!.parts[0]!.text = "MOVED";
    ev.memory[0]!.value.v = 2;
    expect(JSON.stringify(acc.result())).not.toContain("MOVED");
    expect(acc.result().memory[0]?.value).toEqual({ v: 1 });
  });

  it("result() returns a fresh copy each call; toPersistable does not mutate its input", () => {
    const acc = new Reducer();
    for (const e of startEvents()) acc.push(e);
    acc.push({ type: "memory.write", seq: 4, scope: "user", key: "n", value: { v: 1 } });
    const r1 = acc.result();
    (r1.memory[0]!.value as { v: number }).v = 9;
    expect(acc.result().memory[0]?.value).toEqual({ v: 1 });
    const before = JSON.stringify(r1);
    const p = toPersistable(r1);
    expect(JSON.stringify(r1)).toBe(before);
    expect(p.memory).toEqual([]); // a user-scope record is omitted by default
  });

  it("applyPatch never mutates its document, and a copy op copies", () => {
    const doc = { a: { x: [1] } } as JsonValue;
    const r = applyPatch(doc, [{ op: "copy", from: "/a", path: "/b" }]);
    expect(r.ok).toBe(true);
    const v = (r as unknown as { value: { a: { x: number[] }; b: { x: number[] } } }).value;
    v.b.x.push(2);
    expect(v.a.x).toEqual([1]);
    v.a.x.push(3); // an untouched subtree of the result is not the document's
    expect(doc).toEqual({ a: { x: [1] } });
  });

  // An event push() cannot copy (a function-valued field) folds as pushed, so
  // the store-time copies below are its only isolation: each is tested alone.
  const hook = () => 1;

  it("as pushed: an object state.delta value is copied at store time", () => {
    const acc = new Reducer();
    const value = { deep: [1] };
    acc.push({ type: "state.delta", seq: 0, patch: { b: value }, hook } as unknown as AgEvent);
    value.deep.push(2);
    expect(acc.result().state).toEqual({ b: { deep: [1] } });
  });

  it("as pushed: messages.snapshot copies messages, turns, artifacts and memory at store time", () => {
    const mk = () => ({
      type: "messages.snapshot",
      seq: 0,
      hook,
      messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "a" }], turnId: "t1", threadId: "th1" }],
      turns: [{ turnId: "t1", threadId: "th1" }],
      artifacts: [{ artifactId: "a1", name: "r", parts: [{ type: "text", text: "p" }], turnId: "t1", threadId: "th1" }],
      memory: [{ scope: "thread", key: "k", value: { v: 1 } }],
    });
    type Ev = ReturnType<typeof mk>;
    for (const mutate of [
      (ev: Ev) => (ev.messages[0]!.content[0]!.text = "MOVED"),
      (ev: Ev) => (ev.turns[0]!.threadId = "MOVED"),
      (ev: Ev) => (ev.artifacts[0]!.parts[0]!.text = "MOVED"),
      (ev: Ev) => (ev.memory[0]!.value.v = 2),
    ]) {
      const ev = mk();
      const acc = new Reducer();
      acc.push(ev as unknown as AgEvent);
      mutate(ev);
      const r = acc.result();
      expect(JSON.stringify(r)).not.toContain("MOVED");
      expect(r.memory[0]?.value).toEqual({ v: 1 });
    }
  });

  it("result() copies messages, artifacts, memory, turns and state on every read", () => {
    const acc = new Reducer();
    for (const e of startEvents()) acc.push(e);
    acc.push({ type: "artifact.start", seq: 4, artifactId: "a1", turnId: "t1", threadId: "th1", name: "r" });
    acc.push({ type: "memory.write", seq: 5, scope: "thread", key: "k", value: { v: 1 } });
    acc.push({ type: "state.snapshot", seq: 6, snapshot: { s: { v: 1 } } });
    const before = JSON.stringify(acc.result());
    const r = acc.result() as unknown as {
      messages: { content: { text: string }[] }[];
      artifacts: { name: string }[];
      memory: { value: { v: number } }[];
      turns: { threadId: string }[];
      state: { s: { v: number } };
    };
    r.messages[0]!.content[0]!.text = "MOVED";
    r.artifacts[0]!.name = "MOVED";
    r.memory[0]!.value.v = 9;
    r.turns[0]!.threadId = "MOVED";
    r.state.s.v = 9;
    expect(JSON.stringify(acc.result())).toBe(before);
  });

  it("§13.7: an own __proto__ member is omitted from the fold, cloneable or as pushed, and the host's event is unchanged", () => {
    for (const withHook of [false, true]) {
      const ev = JSON.parse('{"type":"state.snapshot","seq":0,"snapshot":{"a":{"__proto__":{"polluted":1},"k":1}}}') as Record<string, unknown>;
      if (withHook) ev.hook = () => 1;
      const before = JSON.stringify(ev);
      const acc = new Reducer();
      acc.push(ev as unknown as AgEvent);
      const a = (acc.result().state as { a: object }).a;
      expect(Object.hasOwn(a, "__proto__")).toBe(false);
      expect(a).toEqual({ k: 1 });
      expect(Object.hasOwn((ev.snapshot as { a: object }).a, "__proto__")).toBe(true);
      expect(JSON.stringify(ev)).toBe(before);
    }
  });

  it("an event with a function-valued field still folds as pushed, and push() does not throw", () => {
    const withFn = { type: "state.snapshot", seq: 0, snapshot: { a: 1 }, hook: () => 1 } as unknown as AgEvent;
    const acc = new Reducer();
    expect(() => acc.push(withFn)).not.toThrow();
    expect(acc.result().state).toEqual({ a: 1 });
  });
});
