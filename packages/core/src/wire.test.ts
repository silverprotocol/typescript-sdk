import { describe, expect, it } from "vitest";
import { toWire, toJsonValue } from "./wire.js";
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
