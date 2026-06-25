import { describe, it, expect } from "vitest";
import { AgEvent, JsonValue } from "@silverprotocol/core";
import { createAdkNormalizer, mapFinishReason, type AdkEvent, type AdkPart } from "./index.js";

/** Build one ADK Event (a Gemini Content + event metadata). */
function event(parts: AdkPart[], extra: Partial<AdkEvent> = {}): AdkEvent {
  return { content: { role: "model", parts }, invocationId: "inv_fixture_1", ...extra };
}

/** Serialize an AdkEvent to JsonValue — the cassette/wire boundary the normalizer
 *  consumes. `JSON.parse(...) as JsonValue` is the established round-trip idiom
 *  (replay.ts:153), NOT a workaround (no `as unknown as`). */
function toJson(e: AdkEvent): JsonValue {
  return JSON.parse(JSON.stringify(e)) as JsonValue;
}

/** Drive a list of events through one normalizer instance, then flush. */
function run(events: AdkEvent[]): AgEvent[] {
  const n = createAdkNormalizer();
  const out: AgEvent[] = [];
  for (const e of events) out.push(...n.push(toJson(e)));
  out.push(...n.flush());
  return out;
}

describe("createAdkNormalizer — text turn lifecycle", () => {
  it("opens a turn, streams an incremental delta, and closes on the final aggregate", () => {
    const out = run([
      event([{ text: "Hello " }], { partial: true, finishReason: "STOP" }),
      event([{ text: "Hello world" }], { partial: false, finishReason: "STOP" }),
    ]);
    const types = out.map((e) => e.type);
    // turn.start + message.start (synthesized), the streamed delta block, then close.
    expect(types).toContain("turn.start");
    // The partial streams "Hello " (1 delta); the aggregate grows past the stream so
    // the residual tail "world" is emitted as a second delta — 2 text.delta total.
    expect(types.filter((t) => t === "text.delta")).toHaveLength(2);
    expect(types).toContain("turn.done");
    const delta = out.find((e) => e.type === "text.delta");
    expect(delta).toMatchObject({ delta: "Hello " });
    const residual = out
      .filter((e) => e.type === "text.delta")
      .map((e) => (e as { delta: string }).delta);
    // The aggregate's residual tail "world" is streamed if not a prefix; here "Hello world"
    // is NOT a prefix of "Hello " so the residual "world" rides as a second delta block.
    expect(residual).toEqual(["Hello ", "world"]);
  });

  it("does NOT close the turn on a function-call aggregate (not is_final_response)", () => {
    const out = run([
      event([{ functionCall: { name: "echo", args: { text: "hi" }, id: "adk-1" } }], {
        partial: false,
        finishReason: "STOP",
      }),
    ]);
    // A partial:false event carrying a functionCall is NOT final → turn stays open until flush.
    const beforeFlush = out.filter((e) => e.type === "turn.done");
    // flush() closes it, so exactly one turn.done exists overall, emitted by flush — but
    // assert it is NOT emitted by the function-call event itself: drive it without flush.
    const n = createAdkNormalizer();
    const driven = n.push(
      JSON.parse(
        JSON.stringify(
          event([{ functionCall: { name: "echo", args: { text: "hi" }, id: "adk-1" } }], {
            partial: false,
            finishReason: "STOP",
          })
        )
      )
    );
    expect(driven.map((e) => e.type)).not.toContain("turn.done");
    expect(beforeFlush).toHaveLength(1); // flush closed it
  });

  it("maps STOP to the neutral 'stop' finishReason", () => {
    expect(mapFinishReason("STOP")).toBe("stop");
  });
});
