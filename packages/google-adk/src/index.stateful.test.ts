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

describe("createAdkNormalizer — reasoning + content blocks", () => {
  it("maps a thought part to reasoning.start/delta/end + reasoning.opaque signature", () => {
    const out = run([
      event([{ text: "thinking…", thought: true, thoughtSignature: "SIG" }], { partial: true }),
    ]);
    const types = out.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "reasoning.start",
        "reasoning.delta",
        "reasoning.end",
        "reasoning.opaque",
      ])
    );
    expect(out.find((e) => e.type === "reasoning.opaque")).toMatchObject({
      kind: "signature",
      value: "SIG",
      provider: "google",
    });
  });

  it("maps executableCode to a content.block code block", () => {
    const out = run([
      event([{ executableCode: { language: "PYTHON", code: "print(1)" } }], { partial: true }),
    ]);
    const block = out.find((e) => e.type === "content.block");
    expect(block).toMatchObject({ block: { type: "code", code: "print(1)" } });
  });
});

describe("createAdkNormalizer — standalone arms via emit()", () => {
  it("maps interrupted to turn.abort", () => {
    const out = run([event([], { interrupted: true })]);
    expect(out.find((e) => e.type === "turn.abort")).toMatchObject({ reason: "interrupted" });
  });

  it("maps actions.transferToAgent to a handoff event", () => {
    const out = run([event([], { actions: { transferToAgent: "billing" } })]);
    expect(out.find((e) => e.type === "handoff")).toMatchObject({
      kind: "transfer",
      toAgentName: "billing",
    });
  });

  it("maps actions.stateDelta to a state.delta event", () => {
    const out = run([event([], { actions: { stateDelta: { cart: 3 } } })]);
    expect(out.find((e) => e.type === "state.delta")).toMatchObject({ patch: { cart: 3 } });
  });

  it("maps a grounding chunk to a source event", () => {
    const out = run([
      event([], {
        groundingMetadata: { groundingChunks: [{ web: { uri: "https://x", title: "X" } }] },
      }),
    ]);
    expect(out.find((e) => e.type === "source")).toMatchObject({
      source: { url: "https://x", title: "X" },
    });
  });
});

describe("createAdkNormalizer — tool arms", () => {
  it("emits one tool.start+args.assembled and dedupes the partial:false aggregate", () => {
    const fc = { functionCall: { name: "echo", args: { text: "hi" }, id: "adk-1" } };
    const out = run([
      event([fc], { partial: true, finishReason: "STOP" }),
      event([fc], { partial: false, finishReason: "STOP" }), // aggregate re-send
    ]);
    expect(out.filter((e) => e.type === "tool.start")).toHaveLength(1);
    const start = out.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ type: "tool.start", toolCallId: "adk-1", name: "echo" });
    const assembled = out.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "adk-1", input: { text: "hi" } });
  });

  it("correlates a functionResponse to its call by the shared adk-<uuid> id", () => {
    const out = run([
      event(
        [
          {
            functionResponse: {
              name: "echo",
              id: "adk-1",
              response: { content: [{ type: "text", text: "echo: hi" }] },
            },
          },
        ],
        {}
      ),
    ]);
    const done = out.find((e) => e.type === "tool.done");
    expect(done).toMatchObject({
      toolCallId: "adk-1",
      outcome: "ok",
      content: [{ type: "text", text: "echo: hi" }],
    });
  });
});
