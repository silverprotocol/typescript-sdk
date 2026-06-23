import { describe, it, expect } from "vitest";
import { reduce, Reducer } from "./reduce.js";
import { AgReduceResult } from "./agjson.js";

// Shared event helpers for R2 tests
const TURN_START = { type: "turn.start" as const, seq: 0, threadId: "th1", turnId: "t1" };
const MSG_START = {
  type: "message.start" as const,
  seq: 1,
  id: "m1",
  role: "assistant" as const,
  turnId: "t1",
  threadId: "th1",
};

describe("reduce — scaffold", () => {
  it("reduce([]) returns the empty container (4 arrays, no state key)", () => {
    const r = reduce([]);
    expect(r).toEqual({ messages: [], artifacts: [], memory: [], turns: [] });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
  it("Reducer fed nothing matches reduce([]) and needsResync is false", () => {
    const acc = new Reducer();
    expect(acc.result()).toEqual(reduce([]));
    expect(acc.needsResync).toBe(false);
  });
  // ALIASING REGRESSION (must-fix #7): a held snapshot must not see later pushes.
  // (full assertion lands once R2 implements text; here, assert result() arrays are
  //  fresh objects — result() twice yields deep-equal-but-not-identical arrays.)
  it("result() returns fresh (non-aliased) arrays each call", () => {
    const acc = new Reducer();
    expect(acc.result().messages).not.toBe(acc.result().messages);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1 — lifecycle + (turnId, candidateIndex) partitioning
// ─────────────────────────────────────────────────────────────────────────────

describe("reduce — R1 lifecycle", () => {
  // (a) turn.start → turns[0] with trigger
  it("(a) turn.start creates a turn record with trigger", () => {
    const r = reduce([
      {
        type: "turn.start",
        seq: 0,
        threadId: "th1",
        turnId: "t1",
        trigger: { kind: "user" },
      },
    ]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({
      turnId: "t1",
      threadId: "th1",
      trigger: { kind: "user" },
    });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (b) message.start + message.end → one sealed AgMessage
  it("(b) message.start + message.end → one AgMessage in result", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "message.start",
        seq: 1,
        id: "m1",
        role: "assistant",
        turnId: "t1",
        threadId: "th1",
      },
      { type: "message.end", seq: 2, id: "m1" },
    ]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ id: "m1", role: "assistant", content: [] });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (b2) message.end.usage lands on AgMessage.usage verbatim (no de-cumulation)
  it("(b2) message.end.usage lands verbatim on AgMessage.usage", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "message.start",
        seq: 1,
        id: "m1",
        role: "assistant",
        turnId: "t1",
        threadId: "th1",
      },
      {
        type: "message.end",
        seq: 2,
        id: "m1",
        usage: { inputTokens: 10, outputTokens: 42 },
      },
    ]);
    expect(r.messages[0]?.usage).toMatchObject({ inputTokens: 10, outputTokens: 42 });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (c) two message.start same turnId, candidateIndex 0 vs 1 → two messages
  //     with distinct partition pointers; openMessage routes each correctly.
  // block-creating-event routing via openMessage() is fully exercised in R2
  it("(c) two candidateIndex → two messages, each pointer is distinct", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({
      type: "message.start",
      seq: 1,
      id: "mA",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
      candidateIndex: 0,
    });
    acc.push({
      type: "message.start",
      seq: 2,
      id: "mB",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
      candidateIndex: 1,
    });

    const r = acc.result();
    expect(r.messages).toHaveLength(2);

    // Partition helper routes by candidateIndex.
    const openA = acc.openMessage("t1", 0);
    const openB = acc.openMessage("t1", 1);
    expect(openA?.id).toBe("mA");
    expect(openB?.id).toBe("mB");
    expect(openA?.id).not.toBe(openB?.id);

    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d) subagent.start → second turn with parentTurnId
  it("(d) subagent.start creates a nested turn with parentTurnId", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "subagent.start",
        seq: 1,
        turnId: "t2",
        parentTurnId: "t1",
        agentName: "helper",
      },
    ]);
    expect(r.turns).toHaveLength(2);
    const nested = r.turns.find((t) => t.turnId === "t2");
    expect(nested).toBeDefined();
    expect(nested?.parentTurnId).toBe("t1");
    expect(nested?.threadId).toBe("th1"); // inherited from parent
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (e) duplicate turn.start → ONE turn (idempotent merge)
  it("(e) duplicate turn.start is idempotent — exactly one turn record", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1", trigger: { kind: "user" } },
      { type: "turn.start", seq: 5, threadId: "th1", turnId: "t1" },
    ]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.turnId).toBe("t1");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (f) openMessage(undefined) in a single-turn stream resolves to the sole open turn
  it("(f) openMessage(undefined) resolves to the sole open turn in a single-turn stream", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({
      type: "message.start",
      seq: 1,
      id: "m1",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
    });

    // A block-creating event with no explicit turnId would call openMessage(undefined).
    const resolved = acc.openMessage(undefined, 0);
    expect(resolved?.id).toBe("m1");

    expect(() => AgReduceResult.parse(acc.result())).not.toThrow();
  });

  // (g) step.start / step.done produce NO output-tree change
  it("(g) step.start + step.done produce no AgReduceResult change", () => {
    const baseline = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
    ]);

    const withSteps = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "step.start", seq: 1, id: "s1", turnId: "t1" },
      { type: "step.done", seq: 2, id: "s1", usage: { outputTokens: 99 } },
    ]);

    expect(withSteps).toEqual(baseline);
    expect(() => AgReduceResult.parse(withSteps)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 — text + reasoning blocks (APPEND deltas, REPLACE opaque, seeded required
//      fields, byte-order)
// ─────────────────────────────────────────────────────────────────────────────

describe("reduce — R2 text + reasoning blocks", () => {
  // (a) text.start + 2×text.delta + text.end → one text block with concatenated text
  it("(a) text.start + deltas + text.end → content[0] is a text block with full text", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      { type: "text.start", seq: 2, id: "b1", turnId: "t1" },
      { type: "text.delta", seq: 3, id: "b1", delta: "Hello" },
      { type: "text.delta", seq: 4, id: "b1", delta: ", world" },
      { type: "text.end", seq: 5, id: "b1" },
    ]);
    expect(r.messages).toHaveLength(1);
    const msg = r.messages[0];
    expect(msg?.content).toHaveLength(1);
    const block = msg?.content[0];
    expect(block?.type).toBe("text");
    if (block?.type === "text") {
      expect(block.text).toBe("Hello, world");
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (a2) result() AFTER text.start BEFORE any delta → seeded text:"" must parse
  it("(a2) result() after text.start before any delta parses (seeded text: \"\")", () => {
    const acc = new Reducer();
    acc.push(TURN_START);
    acc.push(MSG_START);
    acc.push({ type: "text.start", seq: 2, id: "b1", turnId: "t1" });
    // Take a snapshot BEFORE any delta arrives
    const snap = acc.result();
    expect(snap.messages[0]?.content[0]).toMatchObject({ type: "text", text: "" });
    expect(() => AgReduceResult.parse(snap)).not.toThrow();
  });

  // (b) reasoning.start + delta + opaque + end → reasoning block with text + opaque round-trip
  it("(b) reasoning.start + delta + opaque + end → reasoning block; opaque.value round-trips", () => {
    const opaqueValue = "SIGNATURE_BYTE_IDENTICAL_ROUND_TRIP_abc123";
    const r = reduce([
      TURN_START,
      MSG_START,
      { type: "reasoning.start", seq: 2, id: "r1", turnId: "t1" },
      { type: "reasoning.delta", seq: 3, id: "r1", delta: "I think " },
      { type: "reasoning.delta", seq: 4, id: "r1", delta: "therefore I am" },
      {
        type: "reasoning.opaque",
        seq: 5,
        id: "r1",
        kind: "signature",
        value: opaqueValue,
      },
      { type: "reasoning.end", seq: 6, id: "r1" },
    ]);
    expect(r.messages[0]?.content).toHaveLength(1);
    const block = r.messages[0]?.content[0];
    expect(block?.type).toBe("reasoning");
    if (block?.type === "reasoning") {
      expect(block.text).toBe("I think therefore I am");
      expect(block.opaque).toBeDefined();
      expect(block.opaque?.kind).toBe("signature");
      // byte-identical round-trip
      expect(block.opaque?.value).toBe(opaqueValue);
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (c) byte-order: text.start(seq2) then reasoning.start(seq3) then text.delta(seq4)
  //     → content[0]=text, content[1]=reasoning; delta mutates content[0] in place
  it("(c) byte-order: text at seq2, reasoning at seq3, delta at seq4 → content[0]=text, content[1]=reasoning, delta mutates content[0]", () => {
    const acc = new Reducer();
    acc.push(TURN_START);
    acc.push(MSG_START);
    // seq2: text block opens → appended at index 0
    acc.push({ type: "text.start", seq: 2, id: "bt", turnId: "t1" });
    // seq3: reasoning block opens → appended at index 1
    acc.push({ type: "reasoning.start", seq: 3, id: "br", turnId: "t1" });
    // seq4: text delta → mutates content[0] (bt) IN PLACE, not changing index
    acc.push({ type: "text.delta", seq: 4, id: "bt", delta: "text content" });

    const r = acc.result();
    const content = r.messages[0]?.content;
    expect(content).toHaveLength(2);
    expect(content?.[0]?.type).toBe("text");
    expect(content?.[1]?.type).toBe("reasoning");
    // The delta applied to content[0] in-place
    const textBlock = content?.[0];
    if (textBlock?.type === "text") {
      expect(textBlock.text).toBe("text content");
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d) ALIASING: held snapshot must NOT see a later delta push
  it("(d) aliasing: held snapshot does not see delta pushed after result()", () => {
    const acc = new Reducer();
    acc.push(TURN_START);
    acc.push(MSG_START);
    acc.push({ type: "text.start", seq: 2, id: "b1", turnId: "t1" });
    acc.push({ type: "text.delta", seq: 3, id: "b1", delta: "first" });
    // Take snapshot after first delta
    const snap = acc.result();
    // Push second delta AFTER snapshot
    acc.push({ type: "text.delta", seq: 4, id: "b1", delta: " second" });

    // The snapshot must show ONLY "first" — not see " second"
    const snapBlock = snap.messages[0]?.content[0];
    expect(snapBlock?.type).toBe("text");
    if (snapBlock?.type === "text") {
      expect(snapBlock.text).toBe("first");
    }
    // The live result sees both
    const liveBlock = acc.result().messages[0]?.content[0];
    if (liveBlock?.type === "text") {
      expect(liveBlock.text).toBe("first second");
    }
    expect(() => AgReduceResult.parse(snap)).not.toThrow();
    expect(() => AgReduceResult.parse(acc.result())).not.toThrow();
  });
});
