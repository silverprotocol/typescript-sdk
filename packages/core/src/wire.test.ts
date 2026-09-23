import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  toWire,
  toJsonValue,
  toJsonValueSafe,
  toJsonValueSafeWithIssues,
  isJsonValue,
  JSON_SAFE_CIRCULAR,
  JSON_SAFE_MAX_DEPTH,
  JSON_SAFE_MAX_DEPTH_MARK,
} from "./wire.js";
import { JsonValue } from "./agjson.js";
import { AgEvent } from "./agjson.js";

describe("toWire/toJsonValue (audit D5-a)", () => {
  it("round-trips a representative event byte-identically and parses back", () => {
    const ev = AgEvent.parse({
      type: "turn.done",
      seq: 9,
      turnId: "t1",
      outcome: { type: "success" },
      finishReason: "stop",
      usage: { inputTokens: 1 },
    });
    const w = toWire(ev);
    expect(JSON.stringify(w)).toBe(JSON.stringify(ev));
    expect(AgEvent.parse(w).type).toBe("turn.done");
  });
  it("toJsonValue accepts arbitrary serializable natives", () => {
    expect(toJsonValue({ a: [1, "x", null] })).toEqual({ a: [1, "x", null] });
  });
});

describe("isJsonValue / toJsonValueSafe / toJsonValueSafeWithIssues (live-boundary JSON)", () => {
  // (An object LITERAL "__proto__" key would set the prototype; the own-key case is plainParsed.)
  const plain = { a: 1, b: "x", c: [true, null, { d: 2.5 }], e: {}, f: [], h: -1 };
  const plainParsed = JSON.parse('{"a":1,"__proto__":{"x":1},"n":[1,{"m":"z"}]}');

  it("plain JSON is recognized and returned UNCHANGED, by identity (no copy)", () => {
    for (const v of [plain, plainParsed, [1, 2, 3], "s", 0, true, null, { nested: { deeper: [{ x: 1 }] } }]) {
      expect(isJsonValue(v)).toBe(true);
      expect(toJsonValueSafe(v)).toBe(v);
      expect(toJsonValueSafeWithIssues(v).issues).toEqual([]);
    }
  });

  it("is not plain: undefined, -0, NaN/Infinity, BigInt, function, symbol, Date, class instance, holes, cycles", () => {
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    class K {
      x = 1;
    }
    for (const v of [undefined, -0, Number.NaN, Number.POSITIVE_INFINITY, 1n, () => 1, Symbol("s"), new Date(0), new K(), [1, , 3], cyc, { a: undefined }, { toJSON: () => 1 }]) {
      expect(isJsonValue(v)).toBe(false);
    }
  });

  // The value-class matrix × nested positions: every JSON-defined form must
  // serialize exactly as JSON.stringify's round trip (toJsonValue) does.
  const classes: Record<string, unknown> = {
    undefined: undefined,
    date: new Date("2026-09-24T01:02:03.004Z"),
    nan: Number.NaN,
    infinity: Number.NEGATIVE_INFINITY,
    negzero: -0,
    fn: () => 1,
    symbol: Symbol("s"),
    boxedNumber: Object(3),
    boxedString: Object("s"),
    boxedBoolean: Object(false),
    map: new Map([["k", 1]]),
    set: new Set([1]),
    classWithToJSON: new (class {
      secretish = "raw";
      toJSON() {
        return { projected: true, when: new Date(0) };
      }
    })(),
  };
  const positions: Record<string, (v: unknown) => unknown> = {
    top: (v) => v,
    member: (v) => ({ keep: "sibling", v }),
    element: (v) => ["sibling", v, 2],
    deep: (v) => ({ a: [{ b: { v, keep: 1 } }] }),
  };
  for (const [cls, value] of Object.entries(classes)) {
    for (const [pos, place] of Object.entries(positions)) {
      it(`matches JSON.stringify's round trip: ${cls} @ ${pos}`, () => {
        const input = place(value);
        const expected = JSON.stringify(input) === undefined ? "null" : JSON.stringify(toJsonValue(input));
        const got = toJsonValueSafe(input);
        expect(JSON.stringify(got)).toBe(expected);
        expect(() => JsonValue.parse(got)).not.toThrow();
        expect(toJsonValueSafeWithIssues(input).issues).toEqual([]);
      });
    }
  }

  // Where JSON.stringify throws, it degrades PER NODE and keeps JSON-able siblings.
  it("BigInt becomes its decimal string (bare, nested, boxed), reported as an issue", () => {
    const input = { keep: "k", n: 12345678901234567890n, arr: [1n], boxed: Object(7n) };
    const r = toJsonValueSafeWithIssues(input);
    expect(r.value).toEqual({ keep: "k", n: "12345678901234567890", arr: ["1"], boxed: "7" });
    expect(r.issues.map((i) => `${i.path}:${i.kind}`)).toEqual(["$.n:bigint", "$.arr[0]:bigint", "$.boxed:bigint"]);
  });

  it("a cycle becomes [Circular] at the repeated node only; siblings are kept", () => {
    const node: Record<string, unknown> = { name: "n", data: { x: 1 } };
    node["parent"] = { child: node, label: "p" };
    const r = toJsonValueSafeWithIssues({ keep: true, node });
    expect(r.value).toEqual({ keep: true, node: { name: "n", data: { x: 1 }, parent: { child: JSON_SAFE_CIRCULAR, label: "p" } } });
    expect(r.issues).toEqual([{ path: "$.node.parent.child", kind: "circular" }]);
  });

  it("a shared but acyclic reference (a DAG) is serialized in full at each use, as JSON does", () => {
    const shared = { big: [1, 2, 3] };
    const input = { a: shared, b: [shared], date: new Date(0) };
    const r = toJsonValueSafeWithIssues(input);
    expect(JSON.stringify(r.value)).toBe(JSON.stringify(toJsonValue(input)));
    expect(r.issues).toEqual([]);
  });

  it("a throwing getter / toJSON / key enumeration omits that node, never throws", () => {
    const getter = Object.defineProperty({ keep: 1 }, "boom", { enumerable: true, get: () => { throw new Error("getter"); } });
    const toj = { keep: 2, bad: { toJSON: () => { throw new Error("toJSON"); } } };
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("ownKeys"); } });
    const r = toJsonValueSafeWithIssues({ getter, toj, proxy, arr: [toj.bad] });
    expect(r.value).toEqual({ getter: { keep: 1 }, toj: { keep: 2 }, arr: [null] });
    expect(r.issues.map((i) => `${i.path}:${i.kind}`)).toEqual([
      "$.getter.boom:throwing-getter",
      "$.toj.bad:throwing-toJSON",
      "$.proxy:throwing-keys",
      "$.arr[0]:throwing-toJSON",
    ]);
    expect(toJsonValueSafe(proxy)).toBeNull();
  });

  it("a __proto__ key stays a data member and never touches a prototype", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"d":1}');
    input.when = new Date(0); // force the copying path
    const out = toJsonValueSafe(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect((({}) as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(JSON.stringify(out)).toBe(JSON.stringify(toJsonValue(input)));
  });

  it("nesting past the depth cap becomes the max-depth mark instead of overflowing", () => {
    let deep: unknown = { leaf: new Date(0) };
    for (let i = 0; i < JSON_SAFE_MAX_DEPTH + 5; i++) deep = { d: deep };
    const r = toJsonValueSafeWithIssues(deep);
    expect(JSON.stringify(r.value)).toContain(JSON_SAFE_MAX_DEPTH_MARK);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.kind).toBe("max-depth");
  });

  it("a top-level value JSON would drop returns null", () => {
    for (const v of [undefined, () => 1, Symbol("s")]) expect(toJsonValueSafe(v)).toBeNull();
  });
});

describe("toJsonValueSafe: Error instances (a deliberate extension beyond JSON)", () => {
  class ProviderError extends Error {
    code = "rate_limit_exceeded";
    isRetryable = true;
    data = { status: 429, when: new Date(0) };
    constructor(message: string) {
      super(message);
      this.name = "AI_StreamProviderError";
    }
  }

  it("an Error becomes {name, message}: JSON alone would give {}", () => {
    expect(JSON.stringify(new Error("boom"))).toBe("{}");
    expect(toJsonValueSafe(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
    expect(toJsonValueSafe(new TypeError("t"))).toEqual({ name: "TypeError", message: "t" });
  });

  it("a provider error keeps name, message and its own enumerable fields (converted), and never stack", () => {
    const out = toJsonValueSafe(new ProviderError("Rate limit reached")) as Record<string, unknown>;
    expect(out).toEqual({
      name: "AI_StreamProviderError",
      message: "Rate limit reached",
      code: "rate_limit_exceeded",
      isRetryable: true,
      data: { status: 429, when: "1970-01-01T00:00:00.000Z" },
    });
    expect("stack" in out).toBe(false);
  });

  it("stack is dropped even when a host made it enumerable", () => {
    const e = new Error("x");
    Object.defineProperty(e, "stack", { value: "at /Users/someone/secret/path.ts:1:1", enumerable: true });
    const out = toJsonValueSafe(e);
    expect(JSON.stringify(out)).not.toContain("/Users/");
    expect(out).toEqual({ name: "Error", message: "x" });
  });

  it("a nested Error (e.g. an error part's payload) keeps its text; siblings kept", () => {
    expect(toJsonValueSafe({ type: "error", error: new Error("upstream failed"), keep: 1 })).toEqual({
      type: "error",
      error: { name: "Error", message: "upstream failed" },
      keep: 1,
    });
  });

  it("a throwing message getter omits just that member, reported as an issue", () => {
    const e = new Error("x");
    Object.defineProperty(e, "message", { get: () => { throw new Error("no"); } });
    const r = toJsonValueSafeWithIssues(e);
    expect(r.value).toEqual({ name: "Error" });
    expect(r.issues).toEqual([{ path: "$.message", kind: "throwing-getter" }]);
  });

  it("key order: name, message, then own enumerable keys; an own name/message keeps its first position", () => {
    const e = Object.assign(new TypeError("bad"), { code: "E1" });
    expect(Object.keys(toJsonValueSafe(e) as object)).toEqual(["name", "message", "code"]);
    const q = new Error("m") as Error & { extra?: number };
    q.extra = 1;
    q.name = "QuotaError"; // own, enumerable, assigned AFTER extra
    expect(Object.keys(q)).toEqual(["extra", "name"]);
    expect(toJsonValueSafe(q)).toEqual({ name: "QuotaError", message: "m", extra: 1 });
    expect(Object.keys(toJsonValueSafe(q) as object)).toEqual(["name", "message", "extra"]);
  });

  it("as c6ecc1c: an own enumerable name/message is read again by the own-keys pass; that read wins, first position kept", () => {
    let reads = 0;
    const e = new Error("x");
    Object.defineProperty(e, "message", { get: () => `read ${++reads}`, enumerable: true });
    const out = toJsonValueSafe(e);
    expect(out).toEqual({ name: "Error", message: "read 2" });
    expect(Object.keys(out as object)).toEqual(["name", "message"]);
    expect(reads).toBe(2);
  });

  it("parity with sp-google's c6ecc1c facet vectors (0.6.7 and 0.7.0 map the same values)", () => {
    class QuotaError extends Error {
      override name = "QuotaError";
    }
    const withFields = Object.assign(new TypeError("bad input"), { code: "E1", detail: { retry: false } });
    const enumerableStack = new Error("s");
    Object.defineProperty(enumerableStack, "stack", { value: "at /Users/someone/app.ts:1:1", enumerable: true });
    const out = toJsonValueSafe({ plain: new Error("returned as a value"), withFields, custom: new QuotaError("over"), enumerableStack });
    expect(out).toEqual({
      plain: { name: "Error", message: "returned as a value" },
      withFields: { name: "TypeError", message: "bad input", code: "E1", detail: { retry: false } },
      custom: { name: "QuotaError", message: "over" },
      enumerableStack: { name: "Error", message: "s" },
    });
    expect(JSON.stringify(out)).not.toContain("stack");
    expect(JSON.stringify(out)).not.toContain("/Users/");
  });

  it("cause and AggregateError.errors are non-enumerable own data: not carried unless a host made them enumerable", () => {
    expect(toJsonValueSafe(new Error("outer", { cause: new Error("inner") }))).toEqual({ name: "Error", message: "outer" });
    expect(toJsonValueSafe(new AggregateError([new Error("a")], "agg"))).toEqual({ name: "AggregateError", message: "agg" });
    const withCause = Object.assign(new Error("outer"), { cause: new RangeError("inner") });
    expect(toJsonValueSafe(withCause)).toEqual({ name: "Error", message: "outer", cause: { name: "RangeError", message: "inner" } });
  });

  it("an Error's own toJSON wins (the JSON rule runs first); a cycle through an Error is [Circular]", () => {
    const j = Object.assign(new Error("x"), { toJSON: () => ({ custom: true }) });
    expect(toJsonValueSafe(j)).toEqual({ custom: true });
    const c = new Error("loop") as Error & { self?: unknown };
    c.self = c;
    expect(toJsonValueSafe(c)).toEqual({ name: "Error", message: "loop", self: JSON_SAFE_CIRCULAR });
  });

  it("detection is instanceof Error (as c6ecc1c): an Error from another realm converts as a plain object", () => {
    const foreign = runInNewContext("Object.assign(new RangeError('r'), { code: 7 })") as unknown;
    expect(foreign instanceof Error).toBe(false);
    expect(toJsonValueSafe(foreign)).toEqual({ code: 7 });
  });

  it("a chain of Errors deeper than the depth cap stays total: [MaxDepth], never a stack overflow", () => {
    let e: Error & { inner?: unknown } = new Error("leaf");
    for (let i = 0; i < 5000; i++) e = Object.assign(new Error(`e${i}`), { inner: e });
    let r: ReturnType<typeof toJsonValueSafeWithIssues> | undefined;
    expect(() => (r = toJsonValueSafeWithIssues(e))).not.toThrow();
    expect(JSON.stringify(r!.value)).toContain(JSON_SAFE_MAX_DEPTH_MARK);
    expect(r!.issues.some((i) => i.kind === "max-depth")).toBe(true);
  });

  it("an Error is never plain JSON, so corpus identity is unaffected", () => {
    expect(isJsonValue(new Error("x"))).toBe(false);
    const plainErrorShape = { name: "Error", message: "x" };
    expect(toJsonValueSafe(plainErrorShape)).toBe(plainErrorShape);
  });
});

