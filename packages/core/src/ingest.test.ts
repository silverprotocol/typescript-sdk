import { describe, expect, it } from "vitest";
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
