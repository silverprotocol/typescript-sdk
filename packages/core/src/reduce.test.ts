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

// ─────────────────────────────────────────────────────────────────────────────
// R3 — tool-call + tool-result blocks
// ─────────────────────────────────────────────────────────────────────────────

describe("reduce — R3 tool-call + tool-result blocks", () => {
  // (a) tool.start + tool.args.delta + tool.args.assembled → tool-call block
  //     with assembled input (assembled wins over delta scratch)
  it("(a) tool.start + args.delta + args.assembled → tool-call block with assembled input", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      {
        type: "tool.start",
        seq: 2,
        toolCallId: "tc1",
        name: "search",
        turnId: "t1",
        threadId: "th1",
      },
      {
        type: "tool.args.delta",
        seq: 3,
        toolCallId: "tc1",
        delta: '{"q":',
        turnId: "t1",
        threadId: "th1",
      },
      {
        type: "tool.args.delta",
        seq: 4,
        toolCallId: "tc1",
        delta: '"x"}',
        turnId: "t1",
        threadId: "th1",
      },
      {
        type: "tool.args.assembled",
        seq: 5,
        toolCallId: "tc1",
        input: { q: "x" },
        turnId: "t1",
        threadId: "th1",
      },
    ]);
    expect(r.messages[0]?.content).toHaveLength(1);
    const block = r.messages[0]?.content[0];
    expect(block?.type).toBe("tool-call");
    if (block?.type === "tool-call") {
      expect(block.toolCallId).toBe("tc1");
      expect(block.name).toBe("search");
      // assembled input wins over delta scratch
      expect(block.input).toEqual({ q: "x" });
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (a2) result() AFTER tool.start BEFORE args.assembled parses (seeded input:{})
  it("(a2) result() after tool.start before assembled → seeded input:{} parses", () => {
    const acc = new Reducer();
    acc.push(TURN_START);
    acc.push(MSG_START);
    acc.push({
      type: "tool.start",
      seq: 2,
      toolCallId: "tc1",
      name: "search",
      turnId: "t1",
      threadId: "th1",
    });
    // Take snapshot BEFORE assembled arrives
    const snap = acc.result();
    const block = snap.messages[0]?.content[0];
    expect(block?.type).toBe("tool-call");
    if (block?.type === "tool-call") {
      // seeded with empty object — must be valid
      expect(block.input).toEqual({});
    }
    expect(() => AgReduceResult.parse(snap)).not.toThrow();
  });

  // (b) tool.done → tool-result block with outcome and content
  it("(b) tool.done → tool-result block with outcome and content", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      {
        type: "tool.start",
        seq: 2,
        toolCallId: "tc1",
        name: "calc",
        turnId: "t1",
        threadId: "th1",
      },
      {
        type: "tool.done",
        seq: 3,
        toolCallId: "tc1",
        content: [{ type: "text", text: "42" }],
        outcome: "ok",
        turnId: "t1",
        threadId: "th1",
      },
    ]);
    // Both tool-call and tool-result land in the message
    expect(r.messages[0]?.content).toHaveLength(2);
    const toolResult = r.messages[0]?.content[1];
    expect(toolResult?.type).toBe("tool-result");
    if (toolResult?.type === "tool-result") {
      expect(toolResult.toolCallId).toBe("tc1");
      expect(toolResult.outcome).toBe("ok");
      expect(toolResult.content).toHaveLength(1);
      expect(toolResult.content[0]).toMatchObject({ type: "text", text: "42" });
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (c) tool.done with ADVANCED channels (structuredContent, errorCode) round-trips
  it("(c) tool.done structuredContent + errorCode round-trip", () => {
    const structured = { rows: [1, 2, 3] };
    const r = reduce([
      TURN_START,
      MSG_START,
      {
        type: "tool.start",
        seq: 2,
        toolCallId: "tc2",
        name: "query",
        turnId: "t1",
        threadId: "th1",
      },
      {
        type: "tool.done",
        seq: 3,
        toolCallId: "tc2",
        content: [],
        outcome: "ok",
        structuredContent: structured,
        errorCode: "NONE",
        turnId: "t1",
        threadId: "th1",
      },
    ]);
    const toolResult = r.messages[0]?.content[1];
    expect(toolResult?.type).toBe("tool-result");
    if (toolResult?.type === "tool-result") {
      expect(toolResult.structuredContent).toEqual(structured);
      expect(toolResult.errorCode).toBe("NONE");
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d) two tool.done for one toolCallId: first more:true → preliminary;
  //     second (no more) → final content replaces preliminary content;
  //     result is ONE tool-result block with final content
  it("(d) two tool.done (more:true then final) → one merged tool-result with final content", () => {
    const acc = new Reducer();
    acc.push(TURN_START);
    acc.push(MSG_START);
    acc.push({
      type: "tool.start",
      seq: 2,
      toolCallId: "tc3",
      name: "longop",
      turnId: "t1",
      threadId: "th1",
    });
    // First tool.done: more:true — preliminary result
    acc.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "tc3",
      content: [{ type: "text", text: "working..." }],
      outcome: "ok",
      more: true,
      turnId: "t1",
      threadId: "th1",
    });
    // Intermediate check: one tool-call + one tool-result
    const interim = acc.result();
    expect(interim.messages[0]?.content).toHaveLength(2);
    expect(() => AgReduceResult.parse(interim)).not.toThrow();

    // Second tool.done: final (no more) — replaces preliminary content
    acc.push({
      type: "tool.done",
      seq: 4,
      toolCallId: "tc3",
      content: [{ type: "text", text: "done!" }],
      outcome: "ok",
      turnId: "t1",
      threadId: "th1",
    });

    const r = acc.result();
    // Still exactly one tool-call + one tool-result (no duplicate block)
    expect(r.messages[0]?.content).toHaveLength(2);
    const toolResult = r.messages[0]?.content[1];
    expect(toolResult?.type).toBe("tool-result");
    if (toolResult?.type === "tool-result") {
      expect(toolResult.toolCallId).toBe("tc3");
      // Final content replaces preliminary
      expect(toolResult.content).toHaveLength(1);
      expect(toolResult.content[0]).toMatchObject({ type: "text", text: "done!" });
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 — content.block / data / message.metadata + providerMetadata merge +
//      annotations unchanged
// ─────────────────────────────────────────────────────────────────────────────

describe("reduce — R4 content.block + message.metadata", () => {
  // (a) content.block appends; second content.block with SAME id REPLACEs in place
  it("(a) content.block appends; same-id second content.block REPLACEs in place", () => {
    const acc = new Reducer();
    acc.push(TURN_START);
    acc.push(MSG_START);

    // First content.block: data block with id "d1"
    acc.push({
      type: "content.block",
      seq: 2,
      turnId: "t1",
      block: { type: "data", name: "chart", id: "d1", data: { v: 1 } },
    });
    // Second content.block: another block (no id), appended after
    acc.push({
      type: "content.block",
      seq: 3,
      turnId: "t1",
      block: { type: "data", name: "other", id: "d2", data: { v: 99 } },
    });

    const snap1 = acc.result();
    expect(snap1.messages[0]?.content).toHaveLength(2);
    // d1 is at index 0
    expect(snap1.messages[0]?.content[0]).toMatchObject({ type: "data", name: "chart", data: { v: 1 } });

    // REPLACE: same id "d1" with updated data
    acc.push({
      type: "content.block",
      seq: 4,
      turnId: "t1",
      block: { type: "data", name: "chart", id: "d1", data: { v: 42 } },
    });

    const r = acc.result();
    // Still 2 blocks: the REPLACE was in-place (not appended)
    expect(r.messages[0]?.content).toHaveLength(2);
    // Index 0 now has the updated data; index 1 is unchanged
    expect(r.messages[0]?.content[0]).toMatchObject({ type: "data", name: "chart", id: "d1", data: { v: 42 } });
    expect(r.messages[0]?.content[1]).toMatchObject({ type: "data", name: "other", id: "d2" });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (b) content.block with transient:true on the block (data) is SKIPPED
  it("(b) content.block{block:{type:'data',...,transient:true}} is SKIPPED", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      {
        type: "content.block",
        seq: 2,
        turnId: "t1",
        block: { type: "data", name: "live-only", id: "d-t", data: { x: 1 }, transient: true },
      },
    ]);
    // Transient block must NOT appear in content
    expect(r.messages[0]?.content).toHaveLength(0);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (b2) content.block with event-level transient:true is also SKIPPED
  it("(b2) content.block event with transient:true is SKIPPED", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      {
        type: "content.block",
        seq: 2,
        turnId: "t1",
        transient: true,
        block: { type: "data", name: "live-only", id: "d-t2", data: { x: 2 } },
      },
    ]);
    expect(r.messages[0]?.content).toHaveLength(0);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (c) message.metadata merges into the open message's metadata
  it("(c) message.metadata merges into the open message metadata", () => {
    const acc = new Reducer();
    acc.push(TURN_START);
    acc.push(MSG_START);

    // First metadata event: sets two keys
    acc.push({
      type: "message.metadata",
      seq: 2,
      metadata: { source: "test", score: 0.9 },
    });

    const snap1 = acc.result();
    expect(snap1.messages[0]?.metadata).toMatchObject({ source: "test", score: 0.9 });

    // Second metadata event: adds a key, REPLACEs score
    acc.push({
      type: "message.metadata",
      seq: 3,
      metadata: { score: 1.0, extra: "yes" },
    });

    const r = acc.result();
    expect(r.messages[0]?.metadata).toMatchObject({ source: "test", score: 1.0, extra: "yes" });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (c2) message.metadata with explicit messageId targets that specific message
  it("(c2) message.metadata with messageId targets the named message", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      { type: "message.metadata", seq: 2, messageId: "m1", metadata: { tagged: true } },
    ]);
    expect(r.messages[0]?.metadata).toMatchObject({ tagged: true });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d) providerMetadata REPLACE-by-key merge across two content.block events on same block;
  //     annotations carried verbatim and never mutated
  it("(d) providerMetadata REPLACE-by-key; annotations unchanged after REPLACE", () => {
    const annotations = { audience: ["user" as const], priority: 1 };
    const acc = new Reducer();
    acc.push(TURN_START);
    acc.push(MSG_START);

    // First: data block with id, providerMetadata key-A, and annotations
    acc.push({
      type: "content.block",
      seq: 2,
      turnId: "t1",
      block: {
        type: "data",
        name: "chart",
        id: "d5",
        data: { v: 1 },
        annotations,
      },
    });

    const snap1 = acc.result();
    const b1 = snap1.messages[0]?.content[0];
    expect(b1?.type).toBe("data");
    if (b1?.type === "data") {
      // annotations round-trip
      expect(b1.annotations).toEqual(annotations);
    }

    // REPLACE with updated data and different annotations (should use the new block as-is)
    const annotations2 = { audience: ["user" as const, "assistant" as const], priority: 2 };
    acc.push({
      type: "content.block",
      seq: 3,
      turnId: "t1",
      block: {
        type: "data",
        name: "chart",
        id: "d5",
        data: { v: 2 },
        annotations: annotations2,
      },
    });

    const r = acc.result();
    expect(r.messages[0]?.content).toHaveLength(1);
    const b2 = r.messages[0]?.content[0];
    expect(b2?.type).toBe("data");
    if (b2?.type === "data") {
      expect(b2.data).toEqual({ v: 2 });
      // annotations from the REPLACED block, verbatim
      expect(b2.annotations).toEqual(annotations2);
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 — turn-records: turn.done / turn.error / turn.abort / source / handoff /
//      prompt.blocked / guardrail.result / display.required / agent.capabilities
// ─────────────────────────────────────────────────────────────────────────────

describe("reduce — R5 turn-records", () => {
  // (a) turn.done: finishReason + usage (VERBATIM, cumulative flag preserved) +
  //     safety + outcome:paused → asks recorded
  it("(a) turn.done sets finishReason/usage(verbatim)/safety/outcome; paused → asks[]", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "turn.done",
        seq: 1,
        turnId: "t1",
        finishReason: "paused",
        usage: { inputTokens: 100, outputTokens: 50, cumulative: true },
        safety: [{ category: "harm", score: 0.1 }],
        outcome: {
          type: "paused",
          asks: [
            { askId: "ask1", kind: "approval", message: "Approve?" },
          ],
        },
      },
    ]);
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.finishReason).toBe("paused");
    // usage must be VERBATIM — cumulative flag preserved, NOT de-cumulated
    expect(turn?.usage).toEqual({ inputTokens: 100, outputTokens: 50, cumulative: true });
    expect(turn?.safety).toHaveLength(1);
    expect(turn?.safety?.[0]?.category).toBe("harm");
    expect(turn?.outcome?.type).toBe("paused");
    if (turn?.outcome?.type === "paused") {
      expect(turn.outcome.asks).toHaveLength(1);
      expect(turn.outcome.asks[0]?.askId).toBe("ask1");
    }
    // asks[] also recorded at top level for paused
    expect(turn?.asks).toHaveLength(1);
    expect(turn?.asks?.[0]?.askId).toBe("ask1");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (a2) turn.done with finishReason:"pause_turn" (checkpoint) — NO asks synthesized
  it("(a2) turn.done finishReason:pause_turn = checkpoint — asks[] NOT synthesized", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "turn.done",
        seq: 1,
        turnId: "t1",
        finishReason: "pause_turn",
        outcome: { type: "success" },
      },
    ]);
    const turn = r.turns[0];
    expect(turn?.finishReason).toBe("pause_turn");
    // No asks synthesized for pause_turn
    expect(turn?.asks).toBeUndefined();
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (b) turn.error → AgTurnRecord.outcome = {type:"error", message, code?}
  it("(b) turn.error folds outcome={type:'error',...} onto AgTurnRecord", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "turn.error",
        seq: 1,
        turnId: "t1",
        message: "Something went wrong",
        code: "ERR_UPSTREAM",
      },
    ]);
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.outcome).toBeDefined();
    expect(turn?.outcome?.type).toBe("error");
    if (turn?.outcome?.type === "error") {
      expect(turn.outcome.message).toBe("Something went wrong");
      expect(turn.outcome.code).toBe("ERR_UPSTREAM");
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (b2) turn.error before turn.start → defensive ensureTurn creates the turn
  it("(b2) turn.error before turn.start → defensive turn created with error outcome", () => {
    const r = reduce([
      {
        type: "turn.error",
        seq: 0,
        turnId: "t-orphan",
        message: "Pre-start error",
      },
    ]);
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.turnId).toBe("t-orphan");
    expect(turn?.outcome?.type).toBe("error");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (c) turn.abort → AgTurnRecord.taskState = "aborted"
  it("(c) turn.abort sets AgTurnRecord.taskState = 'aborted'", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "turn.abort", seq: 1, turnId: "t1" },
    ]);
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.taskState).toBe("aborted");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d) source×2 → sourceIds[] in order (groundingChunks order preserved)
  it("(d) two source events → sourceIds[] in arrival order", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "source",
        seq: 1,
        turnId: "t1",
        sourceId: "src-A",
        source: { url: "https://example.com/a", title: "A" },
      },
      {
        type: "source",
        seq: 2,
        turnId: "t1",
        sourceId: "src-B",
        source: { url: "https://example.com/b", title: "B" },
      },
    ]);
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.sourceIds).toEqual(["src-A", "src-B"]);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (e) handoff → handoffs[] with kind/fromAgentId/toAgentId/toAgentName
  it("(e) handoff event pushed onto turn handoffs[]", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "handoff",
        seq: 1,
        turnId: "t1",
        kind: "transfer",
        fromAgentId: "agentA",
        toAgentId: "agentB",
        toAgentName: "Agent B",
      },
    ]);
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.handoffs).toHaveLength(1);
    expect(turn?.handoffs?.[0]).toMatchObject({
      kind: "transfer",
      fromAgentId: "agentA",
      toAgentId: "agentB",
      toAgentName: "Agent B",
    });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (f) prompt.blocked → turn safety[] recorded
  it("(f) prompt.blocked records safety[] on the turn", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "prompt.blocked",
        seq: 1,
        turnId: "t1",
        reason: "safety",
        safety: [{ category: "violence", score: 0.95, blocked: true }],
      },
    ]);
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.safety).toHaveLength(1);
    expect(turn?.safety?.[0]).toMatchObject({
      category: "violence",
      score: 0.95,
      blocked: true,
    });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (g) guardrail.result → guardrails[] entry appended
  it("(g) guardrail.result appends to AgTurnRecord.guardrails[]", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "guardrail.result",
        seq: 1,
        turnId: "t1",
        target: "output",
        passed: false,
        action: "block",
        reason: "hate speech detected",
        guardrailName: "content-policy",
        safety: [{ category: "hate", score: 0.99, blocked: true }],
      },
    ]);
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.guardrails).toHaveLength(1);
    expect(turn?.guardrails?.[0]).toMatchObject({
      target: "output",
      passed: false,
      action: "block",
      reason: "hate speech detected",
      guardrailName: "content-policy",
    });
    expect(turn?.guardrails?.[0]?.safety).toHaveLength(1);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (h) display.required → displayRequired[] entry (MUST NOT drop — ToS)
  it("(h) display.required appends to AgTurnRecord.displayRequired[]", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "display.required",
        seq: 1,
        turnId: "t1",
        provider: "google",
        html: "<p>Grounded by Google</p>",
      },
    ]);
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.displayRequired).toHaveLength(1);
    expect(turn?.displayRequired?.[0]).toMatchObject({
      provider: "google",
      html: "<p>Grounded by Google</p>",
    });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (i) agent.capabilities → folded onto AgTurnRecord.capabilities (spec §5 first-turn negotiation)
  it("(i) agent.capabilities folds onto AgTurnRecord.capabilities (no longer a no-op)", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "agent.capabilities",
        seq: 1,
        turnId: "t1",
        capabilities: {
          streaming: { partialMessages: true },
          profile: "ADVANCED",
        },
      },
    ]);
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.capabilities).toBeDefined();
    expect(turn?.capabilities?.profile).toBe("ADVANCED");
    expect(turn?.capabilities?.streaming?.partialMessages).toBe(true);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});
