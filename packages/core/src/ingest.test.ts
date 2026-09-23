import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgEvent, type JsonValue } from "./agjson.js";
import { ingestAgEvent, ingestAgEvents, type AgIngestReject } from "./ingest.js";
import { Reducer } from "./reduce.js";

describe("ingestAgEvent — consumer-lenient posture (SPEC §0.2; audit B5)", () => {
  it("parses a known event", () => {
    const e = ingestAgEvent({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    expect(e?.type).toBe("turn.start");
  });

  it("an unknown event type becomes the in-place ext.agjson.ignored stub, never a throw (additive-minor survival)", () => {
    expect(ingestAgEvent({ type: "poll.start", seq: 0 })).toEqual({
      type: "ext.agjson.ignored",
      seq: 0,
      ignoredType: "poll.start",
      raw: { type: "poll.start", seq: 0 },
    });
  });

  it("passes unknown TOP-LEVEL fields through untouched", () => {
    const e = ingestAgEvent({
      type: "turn.start",
      seq: 0,
      threadId: "th1",
      turnId: "t1",
      futureField: "kept",
    });
    expect(e).toMatchObject({ type: "turn.start", futureField: "kept" });
  });

  it("a malformed known-type event becomes the stub too (ignored, not skipped: it keeps its seq slot)", () => {
    // missing threadId/turnId
    expect(ingestAgEvent({ type: "turn.start", seq: 0 })).toEqual({
      type: "ext.agjson.ignored",
      seq: 0,
      ignoredType: "turn.start",
      raw: { type: "turn.start", seq: 0 },
    });
  });

  it("a non-envelope returns undefined and is reported through onReject, with its reason", () => {
    const rejects: AgIngestReject[] = [];
    const onReject = (r: AgIngestReject): void => void rejects.push(r);
    expect(ingestAgEvent("nope", { onReject })).toBeUndefined();
    expect(ingestAgEvent(null, { onReject })).toBeUndefined();
    expect(ingestAgEvent([{ type: "turn.start", seq: 0 }], { onReject })).toBeUndefined();
    expect(ingestAgEvent({ type: 7, seq: 0 }, { onReject })).toBeUndefined();
    expect(ingestAgEvent({ type: "turn.start" }, { onReject })).toBeUndefined();
    expect(ingestAgEvent({ type: "turn.start", seq: "0" }, { onReject })).toBeUndefined();
    expect(rejects.map((r) => r.reason)).toEqual([
      "not-object",
      "not-object",
      "not-object",
      "type-not-string",
      "seq-not-number",
      "seq-not-number",
    ]);
    expect(rejects[0]!.input).toBe("nope");
    // without a callback a non-envelope is still just undefined
    expect(ingestAgEvent("nope")).toBeUndefined();
  });

  it("ingestAgEvents keeps a mixed stream's slots: the unknown event rides as the stub, in place", () => {
    const out = ingestAgEvents([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "future.thing", seq: 1 },
      {
        type: "turn.done",
        seq: 2,
        turnId: "t1",
        outcome: { type: "success" },
        finishReason: "stop",
      },
    ]);
    expect(out.map((e) => e.type)).toEqual(["turn.start", "ext.agjson.ignored", "turn.done"]);
    expect(out.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe("ingestAgEvent — wire data never sets the returned event's prototype (SPEC.md:759, :27)", () => {
  // JSON.parse keeps a `__proto__` key as an OWN data property, exactly as a
  // wire decoder hands it to a consumer.
  const wire = (): JsonValue[] =>
    JSON.parse(
      JSON.stringify([
        { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
        { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
        { type: "content.block", seq: 2, turnId: "t1", block: { type: "text", text: "kept" }, futureField: "rides" },
        { type: "message.end", seq: 3, id: "m1" },
        { type: "turn.done", seq: 4, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
      ]).replace('"futureField"', '"__proto__":{"transient":true},"futureField"'),
    ) as JsonValue[];

  it("the fixture really carries an own __proto__ key (non-vacuity)", () => {
    const cb = wire()[2] as { [k: string]: unknown };
    expect(Object.prototype.hasOwnProperty.call(cb, "__proto__")).toBe(true);
  });

  it("returns a plain object: Object.prototype, no own __proto__, nothing inherited", () => {
    const e = ingestAgEvent(wire()[2]!) as unknown as { [k: string]: unknown };
    expect(e).toBeDefined();
    expect(Object.getPrototypeOf(e)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(e, "__proto__")).toBe(false);
    expect(e["transient"]).toBeUndefined();
    expect("transient" in e).toBe(false);
  });

  it("the Reducer folds the validated block (no silent skip, no park)", () => {
    const r = new Reducer();
    for (const ev of ingestAgEvents(wire())) r.push(ev);
    expect(r.needsResync).toBe(false);
    const { messages } = r.result();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toEqual([{ type: "text", text: "kept" }]);
  });

  it("other unknown top-level fields still pass through, in the key order a plain merge gives", () => {
    const e = ingestAgEvent(wire()[2]!) as unknown as { [k: string]: unknown };
    expect(e["futureField"]).toBe("rides");
    expect(Object.keys(e)).toEqual(["type", "seq", "turnId", "block", "futureField"]);
  });

  it("an event whose nested keys already follow the schema's order serializes like the old validated merge", () => {
    // Only true because this fixture's nested block is in schema order; see the
    // next test for the general case.
    const v = { type: "content.block", seq: 2, block: { type: "text", text: "x" }, futureField: 1 } as JsonValue;
    const expected = Object.assign({}, v, AgEvent.parse(v));
    expect(JSON.stringify(ingestAgEvent(v))).toBe(JSON.stringify(expected));
  });

  it("nested objects keep the PRODUCER's key order (not byte-identical to the old validated merge); keys and values are unchanged", () => {
    // The shape that reordered 64 corpus events in 0.6.5: usage with totalTokens
    // before reasoningTokens, where the schema declares reasoningTokens first.
    const v = {
      type: "turn.done",
      seq: 0,
      turnId: "t1",
      outcome: { type: "success" },
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 1 },
    } as JsonValue;
    const got = ingestAgEvent(v) as unknown as { usage: { [k: string]: number } };
    expect(Object.keys(got.usage)).toEqual(["inputTokens", "outputTokens", "totalTokens", "reasoningTokens"]);
    const old = Object.assign({}, v, AgEvent.parse(v)) as unknown as { usage: { [k: string]: number } };
    expect(Object.keys(old.usage)).not.toEqual(Object.keys(got.usage)); // the disclosed reorder
    expect(got.usage).toEqual(old.usage); // same keys, same values
  });
});

describe("ingestAgEvent — unknown fields pass through at EVERY depth (SPEC.md:27; workspace#20 stage 1)", () => {
  type Rec = { [k: string]: unknown };
  const own = (o: unknown, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

  it("keeps a nested unknown key in turn.done.usage (depth 2) and inside usage.byModel (depth 4)", () => {
    const e = ingestAgEvent({
      type: "turn.done",
      seq: 0,
      turnId: "t1",
      outcome: { type: "success" },
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, zzCounter: 7, byModel: { m: { inputTokens: 1, zzPerModel: "x" } } },
    }) as unknown as Rec;
    const usage = e["usage"] as Rec;
    expect(usage["zzCounter"]).toBe(7);
    expect(((usage["byModel"] as Rec)["m"] as Rec)["zzPerModel"]).toBe("x");
  });

  it("keeps a nested unknown key in content.block.block (depth 2) and in a tool.done content element (depth 3)", () => {
    const cb = ingestAgEvent({ type: "content.block", seq: 0, block: { type: "text", text: "x", zzKey: "kept" } }) as unknown as Rec;
    expect((cb["block"] as Rec)["zzKey"]).toBe("kept");
    const td = ingestAgEvent({
      type: "tool.done",
      seq: 0,
      toolCallId: "c1",
      content: [{ type: "text", text: "ok", zzDeep: 1 }],
    }) as unknown as Rec;
    expect(((td["content"] as Rec[])[0] as Rec)["zzDeep"]).toBe(1);
  });

  it("drops `__proto__` at depth 2 and 3: plain prototypes, nothing inherited, the data block still folds", () => {
    // JSON.parse keeps `__proto__` as an OWN key at every depth, as a wire decoder would.
    const wire = JSON.parse(
      '[{"type":"turn.start","seq":0,"threadId":"th1","turnId":"t1"},' +
        '{"type":"message.start","seq":1,"id":"m1","role":"assistant","turnId":"t1","threadId":"th1"},' +
        '{"type":"content.block","seq":2,"turnId":"t1","block":{"type":"data","name":"d","__proto__":{"transient":true},' +
        '"data":{"k":1,"__proto__":{"polluted":true}}}},' +
        '{"type":"message.end","seq":3,"id":"m1"}]',
    ) as JsonValue[];
    const rawBlock = (wire[2] as Rec)["block"] as Rec;
    expect(own(rawBlock, "__proto__")).toBe(true); // non-vacuity: depth 2
    expect(own(rawBlock["data"], "__proto__")).toBe(true); // non-vacuity: depth 3
    const evs = ingestAgEvents(wire);
    const block = (evs[2] as unknown as Rec)["block"] as Rec;
    const data = block["data"] as Rec;
    for (const o of [block, data]) {
      expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
      expect(own(o, "__proto__")).toBe(false);
    }
    expect("transient" in block).toBe(false);
    expect("polluted" in data).toBe(false);
    const r = new Reducer();
    for (const ev of evs) r.push(ev);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages[0]!.content).toEqual([{ type: "data", name: "d", data: { k: 1 } }]);
  });

  it("guard: agjson.ts has no value-changing zod combinator, so the raw copy IS the validated value", () => {
    // ingest returns a copy of the RAW input after validation (workspace#20 A.6).
    // That is only equal to the validated value while no schema rewrites values.
    const src = readFileSync(fileURLToPath(new URL("./agjson.ts", import.meta.url)), "utf8");
    const hits = src.match(/\.(transform|default|catch|pipe|overwrite|prefault)\(|z\.coerce|\.coerce\.|preprocess\(/g) ?? [];
    expect(hits).toEqual([]);
  });
});

describe("ingestAgEvents — ignored envelopes keep their seq slot; non-envelopes occupy none (draft.4 §0.2, workspace#20 stage 2)", () => {
  type Rec = { [k: string]: unknown };
  // The spec's own malformed example (§10.20): message.remove id "*" without turnId, at seq 2.
  const stream = (mid: JsonValue): JsonValue[] => [
    { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
    { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
    mid,
    { type: "text.start", seq: 3, id: "x1", turnId: "t1" },
    { type: "text.delta", seq: 4, id: "x1", delta: "kept" },
    { type: "message.end", seq: 5, id: "m1" },
  ];
  const fold = (evs: AgEvent[]): Reducer => {
    const r = new Reducer();
    for (const e of evs) r.push(e);
    return r;
  };

  for (const [name, bad] of [
    ["a malformed known type", { type: "message.remove", seq: 2, id: "*" }],
    ["an undefined type", { type: "zz.start", seq: 2, zz: 1 }],
    ["an unknown enum value", { type: "turn.abort", seq: 2, turnId: "t9", reason: 7 }],
  ] as const) {
    it(`${name} mid-stream rides as ONE stub in its own slot, and the stream folds without parking`, () => {
      const evs = ingestAgEvents(stream(bad as unknown as JsonValue));
      const stubs = evs.filter((e) => e.type === "ext.agjson.ignored") as unknown as Rec[];
      expect(stubs).toHaveLength(1);
      expect(stubs[0]).toMatchObject({ seq: 2, ignoredType: (bad as Rec)["type"] });
      expect(stubs[0]!["raw"]).toEqual(bad);
      expect(() => AgEvent.parse(stubs[0])).not.toThrow(); // a valid typed ext event
      const r = fold(evs);
      expect(r.needsResync).toBe(false);
      expect(r.result().messages[0]!.content).toEqual([{ type: "text", text: "kept" }]);
    });
  }

  it("the stub's raw drops `__proto__` at every depth", () => {
    const bad = JSON.parse('{"type":"zz.start","seq":2,"__proto__":{"a":1},"n":{"__proto__":{"b":2},"k":1}}') as JsonValue;
    const stub = ingestAgEvent(bad) as unknown as Rec;
    const raw = stub["raw"] as Rec;
    const n = raw["n"] as Rec;
    for (const o of [stub, raw, n]) {
      expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(o, "__proto__")).toBe(false);
    }
    expect(raw).toEqual({ type: "zz.start", seq: 2, n: { k: 1 } });
  });

  it("control: a real seq gap still parks (the stub keeps slots, it does not invent them)", () => {
    const evs = ingestAgEvents(stream({ type: "message.remove", seq: 7, id: "*" }));
    expect(fold(evs).needsResync).toBe(true);
  });

  it("control: a non-envelope mid-stream advances nothing and is reported once", () => {
    const rejects: AgIngestReject[] = [];
    const s = stream({ type: "message.metadata", seq: 2, metadata: {} });
    const evs = ingestAgEvents([...s.slice(0, 2), "junk", ...s.slice(2)], { onReject: (r) => void rejects.push(r) });
    expect(rejects).toEqual([{ input: "junk", reason: "not-object" }]);
    expect(evs.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fold(evs).needsResync).toBe(false);
  });

  it("never throws, even when onReject throws", () => {
    const onReject = (): void => {
      throw new Error("host bug");
    };
    expect(() => ingestAgEvents(["junk", { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" }], { onReject })).not.toThrow();
    expect(ingestAgEvents(["junk", { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" }], { onReject })).toHaveLength(1);
  });
});
