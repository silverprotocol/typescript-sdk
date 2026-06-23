import { describe, it, expect } from "vitest";
import { fromJsonata, NormalizerError } from "./normalizer.js";
import { AgEvent } from "./agjson.js";

describe("fromJsonata", () => {
  it("maps an input through a jsonata rule to AgEvent[]", async () => {
    const n = fromJsonata(`[{ "type": "text.delta", "seq": seq, "id": id, "delta": text }]`);
    const out = await n({ id: "m1", text: "hello", seq: 0 });
    expect(out).toEqual([{ type: "text.delta", seq: 0, id: "m1", delta: "hello" }]);
  });

  it("validates output against AgEvent (rejects invalid AgJSON)", async () => {
    const n = fromJsonata(`[{ "type": "bogus", "seq": 0 }]`);
    await expect(n({})).rejects.toThrow();
  });

  it("normalizes a single-object result to a one-element array", async () => {
    const n = fromJsonata(`{ "type": "text.delta", "seq": seq, "id": id, "delta": text }`);
    const out = await n({ id: "m1", text: "hi", seq: 1 });
    expect(out).toEqual([{ type: "text.delta", seq: 1, id: "m1", delta: "hi" }]);
  });

  it("maps an undefined result to []", async () => {
    const n = fromJsonata(`input.missing`); // jsonata resolves to undefined
    const out = await n({ input: {} });
    expect(out).toEqual([]);
  });

  it("each mapped event round-trips through AgEvent.parse", async () => {
    const n = fromJsonata(`[{ "type": "turn.start", "seq": 0, "threadId": tid, "turnId": tu }]`);
    const out = await n({ tid: "th1", tu: "t1" });
    expect(() => out.map((e) => AgEvent.parse(e))).not.toThrow();
    expect(out[0]?.type).toBe("turn.start");
  });

  it("exposes NormalizerError as an Error subclass (the timeout/over-budget guard type)", () => {
    const e = new NormalizerError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("NormalizerError");
  });
});
