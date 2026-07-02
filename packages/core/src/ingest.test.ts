import { describe, expect, it } from "vitest";
import { ingestAgEvent, ingestAgEvents } from "./ingest.js";

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
