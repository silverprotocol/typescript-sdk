import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgEvent, type JsonValue } from "./agjson.js";
import { ingestAgEvent, ingestAgEvents } from "./ingest.js";
import { Reducer } from "./reduce.js";

describe("ingestAgEvent — consumer-lenient posture (SPEC §0.2; audit B5)", () => {
  it("parses a known event", () => {
    const e = ingestAgEvent({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    expect(e?.type).toBe("turn.start");
  });

  it("SKIPS an unknown event type instead of throwing (additive-minor survival)", () => {
    expect(ingestAgEvent({ type: "poll.start", seq: 0 })).toBeUndefined();
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

  it("skips a malformed known-type event (parse-known-else-skip)", () => {
    expect(ingestAgEvent({ type: "turn.start", seq: 0 })).toBeUndefined(); // missing threadId/turnId
  });

  it("skips non-object values", () => {
    expect(ingestAgEvent("nope")).toBeUndefined();
    expect(ingestAgEvent(null)).toBeUndefined();
  });

  it("ingestAgEvents filters a mixed stream", () => {
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
    expect(out.map((e) => e.type)).toEqual(["turn.start", "turn.done"]);
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

  it("an event without the key is byte-identical to the pre-fix merge", () => {
    const v = { type: "content.block", seq: 2, block: { type: "text", text: "x" }, futureField: 1 } as JsonValue;
    const expected = Object.assign({}, v, AgEvent.parse(v));
    expect(JSON.stringify(ingestAgEvent(v))).toBe(JSON.stringify(expected));
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
