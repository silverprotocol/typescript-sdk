import { describe, it, expect } from "vitest";
import { reduce, Reducer } from "./reduce.js";
import { AgEvent } from "./agjson.js";
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
    const out = reduce([]);
    expect(out.result).toEqual({ messages: [], artifacts: [], memory: [], turns: [] });
    expect(out.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(out.result)).not.toThrow();
  });
  it("Reducer fed nothing matches reduce([]) and needsResync is false", () => {
    const acc = new Reducer();
    expect(acc.result()).toEqual(reduce([]).result);
    expect(acc.needsResync).toBe(false);
  });
  it("batch reduce() surfaces the park signal instead of a silently truncated result (audit M50)", () => {
    const out = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "text.start", seq: 5, id: "x1", turnId: "t1" }, // forward gap ⇒ park
    ]);
    expect(out.needsResync).toBe(true);
    expect(out.result.turns).toHaveLength(1); // the pre-park fold is still returned
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
    ]).result;
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
    ]).result;
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
    ]).result;
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
    ]).result;
    expect(r.turns).toHaveLength(2);
    const nested = r.turns.find((t) => t.turnId === "t2");
    expect(nested).toBeDefined();
    expect(nested?.parentTurnId).toBe("t1");
    expect(nested?.threadId).toBe("th1"); // inherited from parent
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d2) subagent.start falls back to a real turn's root threadId when the
  // parent lookup misses (Task 8c leg 2 — guuey capstone finding A: claude's
  // synthetic `turn_${toolCallId}` parentTurnId label was never opened as a
  // real turn, so a naive fallback corrupted the subagent's own threadId).
  it("(d2) subagent.start falls back to any real turn's threadId when the parent was never opened", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      {
        type: "subagent.start",
        seq: 1,
        turnId: "t2",
        parentTurnId: "never-opened-label",
      },
    ]).result;
    const nested = r.turns.find((t) => t.turnId === "t2");
    expect(nested).toBeDefined();
    expect(nested?.parentTurnId).toBe("never-opened-label"); // wire value unchanged
    expect(nested?.threadId).toBe("th1"); // NOT "never-opened-label"
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (e) duplicate turn.start → ONE turn (idempotent merge)
  it("(e) duplicate turn.start is idempotent — exactly one turn record", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1", trigger: { kind: "user" } },
      { type: "turn.start", seq: 5, threadId: "th1", turnId: "t1" },
    ]).result;
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
    ]).result;

    const withSteps = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "step.start", seq: 1, id: "s1", turnId: "t1" },
      { type: "step.done", seq: 2, id: "s1", usage: { outputTokens: 99 } },
    ]).result;

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
    ]).result;
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
    ]).result;
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

  // (e) STREAMED-text citations carrier: text.end.citations attaches to the
  // sealed block — no duplicate supplement fold (audit M22).
  it("a cited streamed text block folds ONCE, with citations attached at text.end (audit M22)", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({
      type: "message.start",
      seq: 1,
      id: "m1",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({ type: "text.start", seq: 2, id: "x1", turnId: "t1" });
    r.push({ type: "text.delta", seq: 3, id: "x1", delta: "cited claim" });
    r.push({
      type: "text.end",
      seq: 4,
      id: "x1",
      citations: [{ kind: "url", url: "https://x.test", citedText: "cited claim" }],
    });
    const blocks = r.result().messages[0]?.content ?? [];
    expect(blocks.filter((b) => b.type === "text")).toHaveLength(1);
    const t = blocks[0];
    expect(t?.type === "text" && t.citations?.[0]).toMatchObject({ url: "https://x.test" });
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3 — tool-call + tool-result blocks
// ─────────────────────────────────────────────────────────────────────────────

describe("reduce — R3 tool-call + tool-result blocks", () => {
  // (a) tool.start + tool.args.delta + tool.args.assembled → the tool-call block's
  //     final input reflects the assembled value (this fixture's delta-concatenation
  //     and assembled input agree byte-for-byte, so — unlike its name previously
  //     implied — it does NOT independently prove assembled-over-delta precedence
  //     on a conflict; see (a2) below for the seeded-placeholder-before-assembled case)
  it("(a) tool.start + args.delta + args.assembled → tool-call block reflects the assembled input (audit M20 mislabel fix)", () => {
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
    ]).result;
    expect(r.messages[0]?.content).toHaveLength(1);
    const block = r.messages[0]?.content[0];
    expect(block?.type).toBe("tool-call");
    if (block?.type === "tool-call") {
      expect(block.toolCallId).toBe("tc1");
      expect(block.name).toBe("search");
      // final input is the assembled value (delta scratch is discarded, not authoritative)
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
    ]).result;
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
    ]).result;
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
    ]).result;
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
    ]).result;
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
    ]).result;
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
    ]).result;
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
    ]).result;
    const turn = r.turns[0];
    expect(turn?.finishReason).toBe("pause_turn");
    // No asks synthesized for pause_turn
    expect(turn?.asks).toBeUndefined();
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (a3) draft.4: turn.done.finishReasonRaw folds verbatim beside finishReason
  it("(a3) turn.done.finishReasonRaw folds verbatim onto AgTurnRecord; absent ⇒ no key", () => {
    const withRaw = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "turn.done", seq: 1, turnId: "t1", finishReason: "other", finishReasonRaw: "zz_future", outcome: { type: "success" } },
    ]).result;
    expect(withRaw.turns[0]?.finishReason).toBe("other");
    expect(withRaw.turns[0]?.finishReasonRaw).toBe("zz_future");
    expect(() => AgReduceResult.parse(withRaw)).not.toThrow();
    const without = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "turn.done", seq: 1, turnId: "t1", finishReason: "stop", outcome: { type: "success" } },
    ]).result;
    expect("finishReasonRaw" in without.turns[0]!).toBe(false);
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
    ]).result;
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

  // (b2) D9 (draft.4 §5.0 INV-OWNER): a terminal for a turn the fold never saw
  // opened folds onto NO turn record and does not park. Through draft.3 the
  // reducer minted a defensive stub record for it.
  it("(b2) turn.error before turn.start → no turn record, no resync (D9)", () => {
    const out = reduce([
      {
        type: "turn.error",
        seq: 0,
        turnId: "t-orphan",
        message: "Pre-start error",
      },
    ]);
    expect(out.result.turns).toEqual([]);
    expect(out.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(out.result)).not.toThrow();
  });

  // (c) turn.abort → AgTurnRecord.outcome = {type:"aborted"} (taskState is verbatim-A2A
  // only and is NEVER reducer-invented — audit M29; was taskState="aborted" pre-fix).
  it("(c) turn.abort folds outcome={type:'aborted'}, leaves taskState untouched (audit M29)", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "turn.abort", seq: 1, turnId: "t1" },
    ]).result;
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.outcome).toEqual({ type: "aborted" });
    expect(turn?.taskState).toBeUndefined();
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (c2) turn.abort with reason → outcome carries it; taskState stays verbatim-A2A-only
  // (audit M29 — dedicated marker, symmetric with turn.error).
  it("turn.abort folds a dedicated aborted outcome and leaves taskState verbatim-A2A (audit M29)", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({ type: "turn.abort", seq: 1, turnId: "t1", reason: "stream-truncated" });
    const turn = r.result().turns[0];
    expect(turn?.outcome).toEqual({ type: "aborted", reason: "stream-truncated" });
    expect(turn?.taskState).toBeUndefined();
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
    ]).result;
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.sourceIds).toEqual(["src-A", "src-B"]);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d2) source → the FULL record lands on sources[] (payload/chunkIndex/providerMetadata
  // survive the fold, not just the bare sourceId) so citations can resolve post-fold
  // (audit M23). sourceIds[] stays as the derived binding index.
  it("source events land full records; citations can resolve post-fold (audit M23)", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({
      type: "source",
      seq: 1,
      sourceId: "s1",
      source: { url: "https://x.test", title: "X" },
      chunkIndex: 0,
      turnId: "t1",
    });
    const turn = r.result().turns[0];
    expect(turn?.sources?.[0]).toMatchObject({
      sourceId: "s1",
      source: { url: "https://x.test" },
      chunkIndex: 0,
    });
    expect(turn?.sourceIds).toEqual(["s1"]); // derived, kept
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
    ]).result;
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
    ]).result;
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

  // (f2) prompt.blocked → the dedicated promptBlocked record lands the REQUIRED reason
  // (and blockedness itself), even with no safety[] at all — a bare-reason block used
  // to fold to ZERO trace (audit M28).
  it("prompt.blocked folds its reason and blockedness even with empty safety (audit M28)", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({ type: "prompt.blocked", seq: 1, turnId: "t1", reason: "safety" });
    expect(r.result().turns[0]?.promptBlocked).toMatchObject({ reason: "safety" });
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
    ]).result;
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
    ]).result;
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
    ]).result;
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.capabilities).toBeDefined();
    expect(turn?.capabilities?.profile).toBe("ADVANCED");
    expect(turn?.capabilities?.streaming?.partialMessages).toBe(true);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R7 — artifact + memory side-channels
// ─────────────────────────────────────────────────────────────────────────────

describe("reduce — R7 artifact + memory side-channels", () => {
  // (a) artifact.start + delta(append:false) + delta(append:true) + artifact.end
  //     → one artifact with assembled parts
  it("(a) artifact.start + delta(false) + delta(true) + end → one artifact, assembled parts", () => {
    const r = reduce([
      {
        type: "artifact.start",
        seq: 0,
        artifactId: "art1",
        turnId: "t1",
        threadId: "th1",
        name: "report",
      },
      {
        type: "artifact.delta",
        seq: 1,
        artifactId: "art1",
        part: { type: "text", text: "Hello" },
        append: false,
      },
      {
        type: "artifact.delta",
        seq: 2,
        artifactId: "art1",
        part: { type: "text", text: ", world" },
        append: true,
      },
      {
        type: "artifact.end",
        seq: 3,
        artifactId: "art1",
        lastChunk: true,
      },
    ]).result;
    expect(r.artifacts).toHaveLength(1);
    const art = r.artifacts[0];
    expect(art?.artifactId).toBe("art1");
    expect(art?.name).toBe("report");
    expect(art?.turnId).toBe("t1");
    expect(art?.threadId).toBe("th1");
    // append:false starts a new part; append:true on matching text type concatenates
    expect(art?.parts).toHaveLength(1);
    const part = art?.parts[0];
    expect(part?.type).toBe("text");
    if (part?.type === "text") {
      expect(part.text).toBe("Hello, world");
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (a2) artifact.delta append:false with non-text part type starts a new part each time
  it("(a2) two artifact.delta append:false → two separate parts", () => {
    const r = reduce([
      {
        type: "artifact.start",
        seq: 0,
        artifactId: "art2",
        turnId: "t1",
        threadId: "th1",
      },
      {
        type: "artifact.delta",
        seq: 1,
        artifactId: "art2",
        part: { type: "text", text: "part A" },
        append: false,
      },
      {
        type: "artifact.delta",
        seq: 2,
        artifactId: "art2",
        part: { type: "text", text: "part B" },
        append: false,
      },
      {
        type: "artifact.end",
        seq: 3,
        artifactId: "art2",
        lastChunk: true,
      },
    ]).result;
    expect(r.artifacts).toHaveLength(1);
    const art = r.artifacts[0];
    expect(art?.parts).toHaveLength(2);
    const p0 = art?.parts[0];
    const p1 = art?.parts[1];
    if (p0?.type === "text") expect(p0.text).toBe("part A");
    if (p1?.type === "text") expect(p1.text).toBe("part B");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (b) memory.write value SET: scope+key and absent-key cases
  it("(b) memory.write{scope:user,key:name,value:'Ada'} → one record in memory[]", () => {
    const r = reduce([
      {
        type: "memory.write",
        seq: 0,
        scope: "user",
        key: "name",
        value: "Ada",
      },
    ]).result;
    expect(r.memory).toHaveLength(1);
    const rec = r.memory[0];
    expect(rec?.scope).toBe("user");
    expect(rec?.key).toBe("name");
    expect(rec?.value).toBe("Ada");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  it("(b2) absent-key memory.write{scope:agent,value:{}} → (agent,'') record", () => {
    const r = reduce([
      {
        type: "memory.write",
        seq: 0,
        scope: "agent",
        value: {},
      },
    ]).result;
    expect(r.memory).toHaveLength(1);
    const rec = r.memory[0];
    expect(rec?.scope).toBe("agent");
    // absent key maps to key=undefined in the record (or omitted)
    expect(rec?.value).toEqual({});
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (c) memory.write patch after a value-set → mutates via R6 applyPatch
  it("(c) memory.write patch after value-set {x:0} mutates to {x:1} via R6", () => {
    const acc = new Reducer();
    // First: SET {x: 0}
    acc.push({
      type: "memory.write",
      seq: 0,
      scope: "user",
      key: "name",
      value: { x: 0 },
    });
    // Second: PATCH replace /x → 1
    acc.push({
      type: "memory.write",
      seq: 1,
      scope: "user",
      key: "name",
      patch: [{ op: "replace", path: "/x", value: 1 }],
    });
    const r = acc.result();
    expect(r.memory).toHaveLength(1);
    const rec = r.memory[0];
    expect(rec?.value).toEqual({ x: 1 });
    expect(acc.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d) memory.write patch against a NEVER-seeded (scope,key) → needsResync === true (NOT a {}-seed)
  it("(d) memory.write patch against never-seeded (scope,key) sets needsResync, does NOT seed from {}", () => {
    const acc = new Reducer();
    acc.push({
      type: "memory.write",
      seq: 0,
      scope: "user",
      key: "missing",
      patch: [{ op: "replace", path: "/x", value: 1 }],
    });
    // needsResync must be set
    expect(acc.needsResync).toBe(true);
    // The record must NOT have been seeded with {} — memory[] should be empty
    const r = acc.result();
    expect(r.memory).toHaveLength(0);
  });

  // (e) memory.write patch where applyPatch returns ok:false → needsResync set
  it("(e) memory.write patch that fails applyPatch → needsResync set, record unchanged", () => {
    const acc = new Reducer();
    // Seed a record with a string value
    acc.push({
      type: "memory.write",
      seq: 0,
      scope: "agent",
      key: "cfg",
      value: "not-an-object",
    });
    // Try to patch a path that doesn't exist on a string
    acc.push({
      type: "memory.write",
      seq: 1,
      scope: "agent",
      key: "cfg",
      patch: [{ op: "replace", path: "/missing", value: 99 }],
    });
    expect(acc.needsResync).toBe(true);
    // Original value preserved
    const r = acc.result();
    const rec = r.memory[0];
    expect(rec?.value).toBe("not-an-object");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R8 — shared-state: state.snapshot REPLACE + state.delta (RFC-6902 / key-replace object, draft.4)
// ─────────────────────────────────────────────────────────────────────────────

describe("reduce — R8 shared-state snapshot + delta", () => {
  // (a) state.snapshot → #state is REPLACED wholesale
  it("(a) state.snapshot{snapshot:{a:1}} → result.state is {a:1}", () => {
    const r = reduce([
      { type: "state.snapshot", seq: 0, snapshot: { a: 1 } },
    ]).result;
    expect(r.state).toEqual({ a: 1 });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (a2) state.snapshot clears #resync when it was set
  it("(a2) state.snapshot clears needsResync", () => {
    const acc = new Reducer();
    // Trigger resync via a patch against a never-seeded state
    acc.push({
      type: "state.delta",
      seq: 0,
      patch: [{ op: "add", path: "/x", value: 1 }],
    });
    expect(acc.needsResync).toBe(true);
    // Now deliver a snapshot — should clear resync
    acc.push({ type: "state.snapshot", seq: 1, snapshot: { recovered: true } });
    expect(acc.needsResync).toBe(false);
    const r = acc.result();
    expect(r.state).toEqual({ recovered: true });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (b) state.delta RFC-6902 (array patch) after a snapshot → mutates via applyPatch
  it("(b) state.delta RFC-6902 [{op:'add',path:'/b',value:2}] after snapshot {a:1} → state {a:1,b:2}", () => {
    const acc = new Reducer();
    acc.push({ type: "state.snapshot", seq: 0, snapshot: { a: 1 } });
    acc.push({
      type: "state.delta",
      seq: 1,
      patch: [{ op: "add", path: "/b", value: 2 }],
    });
    const r = acc.result();
    expect(r.state).toEqual({ a: 1, b: 2 });
    expect(acc.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (b2) state.delta RFC-6902 against undefined #state → needsResync set
  it("(b2) state.delta RFC-6902 with no prior snapshot → needsResync set, state absent", () => {
    const acc = new Reducer();
    acc.push({
      type: "state.delta",
      seq: 0,
      patch: [{ op: "add", path: "/x", value: 1 }],
    });
    expect(acc.needsResync).toBe(true);
    const r = acc.result();
    // #state was never set, so state key must be absent
    expect("state" in r).toBe(false);
  });

  // (b3) state.delta RFC-6902 where applyPatch returns ok:false → needsResync set, state unchanged
  it("(b3) state.delta RFC-6902 that fails applyPatch → needsResync set, state unchanged", () => {
    const acc = new Reducer();
    acc.push({ type: "state.snapshot", seq: 0, snapshot: { x: 0 } });
    // replace /nonexistent fails on a non-existent path
    acc.push({
      type: "state.delta",
      seq: 1,
      patch: [{ op: "replace", path: "/nonexistent", value: 99 }],
    });
    expect(acc.needsResync).toBe(true);
    const r = acc.result();
    // State must be the last-known-good value
    expect(r.state).toEqual({ x: 0 });
  });

  // (c) state.delta {nodeX:{k:"v"}} → key-replace (draft.4 §5, pkg-21): the key is set WHOLE
  it("(c) state.delta {nodeX:{k:'v'}} replaces state.nodeX whole (draft.4 key-replace; draft.3 merged one level)", () => {
    const acc = new Reducer();
    // Seed initial state
    acc.push({ type: "state.snapshot", seq: 0, snapshot: { nodeX: { existing: "yes" } } });
    // Rewrite nodeX: the stale member does NOT survive
    acc.push({
      type: "state.delta",
      seq: 1,
      patch: { nodeX: { k: "v" } },
    });
    const r = acc.result();
    expect(r.state).toEqual({ nodeX: { k: "v" } });
    expect(acc.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  describe("draft.4 key-replace object fold (pkg-21; §10.29 vectors)", () => {
    const fold = (evs: AgEvent[]) => reduce(evs);
    it("D1: {cfg:{a:1,b:2}} then {cfg:{a:5}} folds to {cfg:{a:5}} (state-fold-gemini38; ADK holds the same)", () => {
      const out = fold([
        { type: "state.delta", seq: 0, patch: { cfg: { a: 1, b: 2 } } },
        { type: "state.delta", seq: 1, patch: { cfg: { a: 5 } } },
      ]);
      expect(out.result.state).toEqual({ cfg: { a: 5 } });
      expect(out.needsResync).toBe(false);
    });
    it("keys the patch does not name are untouched", () => {
      const out = fold([
        { type: "state.delta", seq: 0, patch: { a: 1, b: { x: 1 } } },
        { type: "state.delta", seq: 1, patch: { a: 9 } },
      ]);
      expect(out.result.state).toEqual({ a: 9, b: { x: 1 } });
    });
    it("null is stored as a value (the key is present)", () => {
      const out = fold([{ type: "state.delta", seq: 0, patch: { k: null } }]);
      const state = out.result.state as Record<string, unknown>;
      expect(Object.hasOwn(state, "k")).toBe(true);
      expect(state["k"]).toBeNull();
      expect(out.needsResync).toBe(false);
    });
    it("a scalar patch is a no-op, never a resync", () => {
      const out = fold([
        { type: "state.snapshot", seq: 0, snapshot: { x: 1 } },
        { type: "state.delta", seq: 1, patch: 7 },
      ]);
      expect(out.result.state).toEqual({ x: 1 });
      expect(out.needsResync).toBe(false);
    });
    it("a JSON Patch against an absent working copy still resyncs, and state stays absent (unchanged)", () => {
      const out = fold([{ type: "state.delta", seq: 0, patch: [{ op: "add", path: "/k", value: 1 }] }]);
      expect(out.needsResync).toBe(true);
      expect("state" in out.result).toBe(false);
    });
    it("DC-6: two writes to one key keep only the second, never an object assembled from both", () => {
      const out = fold([
        { type: "state.delta", seq: 0, patch: { obj: { kind: "a" } } },
        { type: "state.delta", seq: 1, patch: { obj: { value: "v" } } },
      ]);
      expect(out.result.state).toEqual({ obj: { value: "v" } });
      expect(Object.hasOwn((out.result.state as { obj: object }).obj, "kind")).toBe(false);
    });
    it("copy-isolated and batch == incremental; an own __proto__ key stays data, never a prototype", () => {
      const evs: AgEvent[] = [
        { type: "state.delta", seq: 0, patch: JSON.parse('{"k":{"a":1},"__proto__":{"polluted":true}}') },
        { type: "state.delta", seq: 1, patch: [{ op: "replace", path: "/k/a", value: 2 }] },
      ];
      const before = JSON.stringify(evs);
      const out = fold(evs);
      const acc = new Reducer();
      for (const e of evs) acc.push(e);
      expect(acc.result()).toEqual(out.result);
      expect(JSON.stringify(evs)).toBe(before); // the fold mutated no event
      const state = out.result.state as Record<string, unknown>;
      expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
      expect((state as { k: unknown }).k).toEqual({ a: 2 });
      (state as { k: { a: number } }).k.a = 99; // a consumer mutating the result
      expect((evs[0] as unknown as { patch: { k: { a: number } } }).patch.k.a).toBe(1);
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    });
    it("an own __proto__ key of a patch is stored as data under that key, never as the state's prototype", () => {
      const out = fold([{ type: "state.delta", seq: 0, patch: JSON.parse('{"__proto__":{"polluted":true},"k":1}') }]);
      const state = out.result.state as Record<string, unknown>;
      expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(state, "__proto__")?.value).toEqual({ polluted: true });
      expect(state["k"]).toBe(1);
      expect(out.needsResync).toBe(false);
    });
    it("the fold holds a copy: mutating a pushed patch afterwards changes no state", () => {
      const ev = { type: "state.delta", seq: 0, patch: { cfg: { a: 1, list: [1] } } } as AgEvent;
      const acc = new Reducer();
      acc.push(ev);
      const patch = (ev as unknown as { patch: { cfg: { a: number; list: number[] } } }).patch;
      patch.cfg.a = 99; // a host reusing its event object
      patch.cfg.list.push(2);
      expect(acc.result().state).toEqual({ cfg: { a: 1, list: [1] } });
    });
  });

  // (c2) state.delta key-replace object with no prior state → creates state from scratch
  it("(c2) state.delta key-replace object with no prior state → creates {nodeX:{k:'v'}}", () => {
    const r = reduce([
      { type: "state.delta", seq: 0, patch: { nodeX: { k: "v" } } },
    ]).result;
    expect(r.state).toEqual({ nodeX: { k: "v" } });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d) scalar state.delta.patch (e.g. patch: 5) → no-op (state unchanged, no resync)
  it("(d) scalar state.delta.patch (patch: 5) → no-op, state unchanged, needsResync false", () => {
    const acc = new Reducer();
    acc.push({ type: "state.snapshot", seq: 0, snapshot: { keep: true } });
    acc.push({ type: "state.delta", seq: 1, patch: 5 });
    expect(acc.needsResync).toBe(false);
    const r = acc.result();
    expect(r.state).toEqual({ keep: true });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d2) null state.delta.patch → also a no-op (documented; null falls into scalar branch)
  it("(d2) null state.delta.patch → no-op, state unchanged, needsResync false", () => {
    const acc = new Reducer();
    acc.push({ type: "state.snapshot", seq: 0, snapshot: { keep: true } });
    acc.push({ type: "state.delta", seq: 1, patch: null });
    expect(acc.needsResync).toBe(false);
    const r = acc.result();
    expect(r.state).toEqual({ keep: true });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (e) state OMITTED from result when no state event seen (R0 exact-equality contract)
  it("(e) state key OMITTED from result when no state event was pushed", () => {
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
    ]).result;
    // R0 contract: state key must be absent (not undefined, not null — absent)
    expect("state" in r).toBe(false);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D9 — a terminal folds only onto a turn the fold saw opened (draft.4 INV-OWNER)
// ─────────────────────────────────────────────────────────────────────────────

describe("reduce — D9: a terminal for a never-opened turn folds onto no record", () => {
  const fold = (evs: AgEvent[]) => {
    const acc = new Reducer();
    for (const ev of evs) acc.push(ev);
    return acc;
  };
  const turnIds = (acc: Reducer) => acc.result().turns.map((t) => t.turnId);

  it("a lone turn.done, turn.error or turn.abort mints no record and does not park", () => {
    const lone: AgEvent[] = [
      { type: "turn.done", seq: 0, turnId: "tX", outcome: { type: "success" } },
      { type: "turn.error", seq: 0, turnId: "tX", message: "boom" },
      { type: "turn.abort", seq: 0, turnId: "tX", reason: "stream-truncated" },
    ];
    for (const ev of lone) {
      const acc = fold([ev]);
      expect(turnIds(acc), ev.type).toEqual([]);
      expect(acc.needsResync, ev.type).toBe(false);
    }
  });

  it("the ignored terminal closes nothing: the same turnId, opened later, streams and closes normally", () => {
    const acc = fold([
      { type: "turn.done", seq: 0, turnId: "tX", outcome: { type: "success" } },
      { type: "turn.start", seq: 1, turnId: "tX", threadId: "th1" },
      { type: "message.start", seq: 2, id: "m1", role: "assistant", turnId: "tX", threadId: "th1" },
      { type: "text.start", seq: 3, id: "x1", turnId: "tX" },
      { type: "text.delta", seq: 4, id: "x1", delta: "hi", turnId: "tX" },
      { type: "turn.done", seq: 5, turnId: "tX", outcome: { type: "success" } },
    ]);
    expect(acc.needsResync).toBe(false);
    expect(acc.result().turns).toMatchObject([{ turnId: "tX", threadId: "th1", outcome: { type: "success" } }]);
    expect(acc.result().messages[0]?.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("opened by turn.start or by subagent.start: the terminal folds onto its record", () => {
    const acc = fold([
      { type: "turn.start", seq: 0, turnId: "t1", threadId: "th1" },
      { type: "subagent.start", seq: 1, turnId: "t2", parentTurnId: "t1" },
      { type: "turn.error", seq: 2, turnId: "t2", message: "nested failed" },
      { type: "subagent.done", seq: 3, turnId: "t2" },
      { type: "turn.done", seq: 4, turnId: "t1", outcome: { type: "success" } },
    ] as AgEvent[]);
    expect(acc.needsResync).toBe(false);
    const byId = new Map(acc.result().turns.map((t) => [t.turnId, t]));
    expect(byId.get("t2")?.outcome).toMatchObject({ type: "error", message: "nested failed" });
    expect(byId.get("t1")?.outcome).toEqual({ type: "success" });
  });

  it("seen by a messages.snapshot, in turns[] or only as a message's turnId: the terminal folds", () => {
    const viaTurns = fold([
      { type: "messages.snapshot", seq: 0, messages: [], turns: [{ turnId: "tS", threadId: "th1" }] },
      { type: "turn.done", seq: 1, turnId: "tS", outcome: { type: "success" } },
    ]);
    expect(viaTurns.result().turns).toMatchObject([{ turnId: "tS", outcome: { type: "success" } }]);
    const viaMessage = fold([
      { type: "messages.snapshot", seq: 0, messages: [{ id: "m1", role: "assistant", content: [], turnId: "tM", threadId: "th1" }] },
      { type: "turn.abort", seq: 1, turnId: "tM", reason: "stream-truncated" },
    ]);
    expect(turnIds(viaMessage)).toEqual(["tM"]);
    expect(viaMessage.needsResync).toBe(false);
  });

  it("a turn seen opened stays seen after a snapshot that replaces the turns without it", () => {
    const acc = fold([
      { type: "turn.start", seq: 0, turnId: "t1", threadId: "th1" },
      { type: "messages.snapshot", seq: 1, messages: [], turns: [] },
      { type: "turn.done", seq: 2, turnId: "t1", outcome: { type: "success" } },
    ]);
    expect(turnIds(acc)).toEqual(["t1"]);
  });

  it("a terminal with no turnId keeps the INV-OWNER backfill: it folds onto the only turn", () => {
    const acc = fold([
      { type: "turn.start", seq: 0, turnId: "t1", threadId: "th1" },
      { type: "turn.error", seq: 1, message: "boom" },
    ]);
    expect(acc.result().turns).toMatchObject([{ turnId: "t1", outcome: { type: "error", message: "boom" } }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Store-time isolation — push() folds its own copy of the event
// ─────────────────────────────────────────────────────────────────────────────

describe("reduce — store-time isolation (a host mutating a pushed event never moves the fold)", () => {
  /** Push each event, mutate it in place right after, and return the result. */
  const foldThenMutate = (evs: AgEvent[], mutate: (ev: AgEvent) => void) => {
    const acc = new Reducer();
    for (const ev of evs) {
      acc.push(ev);
      mutate(ev);
    }
    return acc;
  };
  const obj = (ev: AgEvent) => ev as unknown as Record<string, any>;

  it("state.snapshot: the snapshot value", () => {
    const acc = foldThenMutate([{ type: "state.snapshot", seq: 0, snapshot: { cfg: { a: 1 } } }], (ev) => {
      obj(ev).snapshot.cfg.a = 99;
    });
    expect(acc.result().state).toEqual({ cfg: { a: 1 } });
  });

  it("state.delta JSON Patch add: the op's value", () => {
    const acc = foldThenMutate(
      [
        { type: "state.snapshot", seq: 0, snapshot: {} },
        { type: "state.delta", seq: 1, patch: [{ op: "add", path: "/cfg", value: { a: 1 } }] },
      ],
      (ev) => {
        if (ev.type === "state.delta") obj(ev).patch[0].value.a = 99;
      },
    );
    expect(acc.result().state).toEqual({ cfg: { a: 1 } });
    expect(acc.needsResync).toBe(false);
  });

  it("state.delta JSON Patch replace: the op's value", () => {
    const acc = foldThenMutate(
      [
        { type: "state.snapshot", seq: 0, snapshot: { cfg: { a: 0 } } },
        { type: "state.delta", seq: 1, patch: [{ op: "replace", path: "/cfg", value: { a: 1, list: [1] } }] },
      ],
      (ev) => {
        if (ev.type !== "state.delta") return;
        obj(ev).patch[0].value.a = 99;
        obj(ev).patch[0].value.list.push(2);
      },
    );
    expect(acc.result().state).toEqual({ cfg: { a: 1, list: [1] } });
    expect(acc.needsResync).toBe(false);
  });

  it("memory.write: a set value and a patch value", () => {
    const acc = foldThenMutate(
      [
        { type: "memory.write", seq: 0, scope: "user", key: "p", value: { v: { w: 1 } } },
        { type: "memory.write", seq: 1, scope: "user", key: "p", patch: [{ op: "add", path: "/n", value: { q: 1 } }] },
      ],
      (ev) => {
        if (obj(ev).value !== undefined) obj(ev).value.v.w = 99;
        if (obj(ev).patch !== undefined) obj(ev).patch[0].value.q = 99;
      },
    );
    expect(acc.result().memory).toEqual([{ scope: "user", key: "p", value: { v: { w: 1 }, n: { q: 1 } } }]);
  });

  it("a block and its providerMetadata (content.block into an open message)", () => {
    const acc = foldThenMutate(
      [
        { type: "turn.start", seq: 0, turnId: "t1", threadId: "th1" },
        { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
        AgEvent.parse({
          type: "content.block",
          seq: 2,
          id: "b1",
          turnId: "t1",
          block: { type: "text", text: "hi", providerMetadata: { vendor: { k: 1 } } },
        }),
      ],
      (ev) => {
        if (ev.type !== "content.block") return;
        obj(ev).block.text = "moved";
        obj(ev).block.providerMetadata.vendor.k = 99;
      },
    );
    expect(acc.result().messages[0]?.content).toEqual([{ type: "text", text: "hi", providerMetadata: { vendor: { k: 1 } } }]);
  });

  it("an event structuredClone cannot copy still folds as pushed, and push() does not throw", () => {
    const withFn = { type: "state.snapshot", seq: 0, snapshot: { a: 1 }, hook: () => 1 } as unknown as AgEvent;
    const acc = new Reducer();
    expect(() => acc.push(withFn)).not.toThrow();
    expect(acc.result().state).toEqual({ a: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R9 — message.remove + messages.snapshot + seq-gap resync + live-only sweep
// ─────────────────────────────────────────────────────────────────────────────

describe("reduce — R9 new-ops + resync + snapshot + live-only", () => {
  // ── (a) message.remove ──────────────────────────────────────────────────────

  // (a1) message.remove{id} removes the message and its content blocks
  it("(a1) message.remove{id} removes the message + its #blockPos entries", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    acc.push({ type: "text.start", seq: 2, id: "b1", turnId: "t1" });
    acc.push({ type: "text.delta", seq: 3, id: "b1", delta: "hello" });
    acc.push({ type: "message.remove", seq: 4, id: "m1", turnId: "t1" });

    const r = acc.result();
    // Message removed
    expect(r.messages).toHaveLength(0);
    // Block is gone (no messages left)
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (a2) message.remove has NO CASCADE to tool-result messages that adopted their own id
  it("(a2) message.remove does NOT cascade to tool-result messages with their own id", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    // Message m1: contains a tool-call
    acc.push({ type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    acc.push({ type: "tool.start", seq: 2, toolCallId: "tc1", name: "search", turnId: "t1", threadId: "th1" });
    // Message m2: tool-result (adopted id via tool.done.messageId)
    acc.push({ type: "message.start", seq: 3, id: "m2", role: "tool", turnId: "t1", threadId: "th1" });
    acc.push({
      type: "tool.done",
      seq: 4,
      toolCallId: "tc1",
      content: [{ type: "text", text: "result" }],
      outcome: "ok",
      turnId: "t1",
      threadId: "th1",
    });

    // Remove only m1 (the assistant message)
    acc.push({ type: "message.remove", seq: 5, id: "m1", turnId: "t1" });

    const r = acc.result();
    // m2 (tool-result message) must still be present
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.id).toBe("m2");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (a3) #blockPos guard: a same block-id in another partition survives message.remove
  it("(a3) #blockPos guard — block in another partition survives remove of the first message", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    // Partition 0: message mA with text block b1
    acc.push({ type: "message.start", seq: 1, id: "mA", role: "assistant", turnId: "t1", threadId: "th1", candidateIndex: 0 });
    acc.push({ type: "text.start", seq: 2, id: "b1", turnId: "t1", candidateIndex: 0 });
    acc.push({ type: "text.delta", seq: 3, id: "b1", delta: "candidate A" });
    // Partition 1: message mB with a block registered under the same key "b2"
    acc.push({ type: "message.start", seq: 4, id: "mB", role: "assistant", turnId: "t1", threadId: "th1", candidateIndex: 1 });
    acc.push({ type: "text.start", seq: 5, id: "b2", turnId: "t1", candidateIndex: 1 });
    acc.push({ type: "text.delta", seq: 6, id: "b2", delta: "candidate B" });

    // Remove mA: b1's #blockPos entry must be deleted (messageId=mA matches)
    // b2's #blockPos entry must NOT be deleted (messageId=mB != mA)
    acc.push({ type: "message.remove", seq: 7, id: "mA", turnId: "t1" });

    const r = acc.result();
    // mA is removed; mB survives
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.id).toBe("mB");
    // mB still has its b2 block
    const block = r.messages[0]?.content[0];
    expect(block?.type).toBe("text");
    if (block?.type === "text") {
      expect(block.text).toBe("candidate B");
    }
    // A text.delta for b2 still routes correctly (b2's blockPos intact)
    acc.push({ type: "text.delta", seq: 8, id: "b2", delta: " extra" });
    const r2 = acc.result();
    const block2 = r2.messages[0]?.content[0];
    if (block2?.type === "text") {
      expect(block2.text).toBe("candidate B extra");
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // ── (b) pointer-revert after message.remove ─────────────────────────────────

  // (b1) after removing the open message, a bare block-creating event sets #resync
  it("(b1) removing the open message + block-creating event (no message.start) → needsResync", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    // Remove the open message
    acc.push({ type: "message.remove", seq: 2, id: "m1", turnId: "t1" });
    // Now push a block-creating event with NO intervening message.start
    acc.push({ type: "text.start", seq: 3, id: "b-orphan", turnId: "t1" });
    // This must have set #resync
    expect(acc.needsResync).toBe(true);
    expect(() => AgReduceResult.parse(acc.result())).not.toThrow();
  });

  // (b2) pointer-revert: with multiple messages, removing the last reverts to the previous one
  it("(b2) pointer-revert to last still-present unsealed message in partition", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    acc.push({ type: "message.start", seq: 2, id: "m2", role: "assistant", turnId: "t1", threadId: "th1" });
    // Remove m2 (the current open message for partition (t1, 0))
    acc.push({ type: "message.remove", seq: 3, id: "m2", turnId: "t1" });

    // Pointer should now revert to m1 (last present, unsealed)
    const openAfterRemove = acc.openMessage("t1", 0);
    expect(openAfterRemove?.id).toBe("m1");

    // A text.start should now attach to m1
    acc.push({ type: "text.start", seq: 4, id: "b1", turnId: "t1" });
    acc.push({ type: "text.delta", seq: 5, id: "b1", delta: "reverted" });

    const r = acc.result();
    // Only m1 remains
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.id).toBe("m1");
    // Block landed on m1
    const block = r.messages[0]?.content[0];
    expect(block?.type).toBe("text");
    if (block?.type === "text") {
      expect(block.text).toBe("reverted");
    }
    // needsResync must NOT be set (we found a valid prior message)
    expect(acc.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (b3) pointer-revert skips sealed messages (message.end seals a message)
  it("(b3) pointer-revert skips #sealed messages — falls back to none if all are sealed → needsResync on next block event", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    // Seal m1
    acc.push({ type: "message.end", seq: 2, id: "m1" });
    acc.push({ type: "message.start", seq: 3, id: "m2", role: "assistant", turnId: "t1", threadId: "th1" });
    // Remove m2 (the open one), only m1 is left but it's sealed
    acc.push({ type: "message.remove", seq: 4, id: "m2", turnId: "t1" });

    // No valid unsealed prior message → pointer is none
    const openAfterRemove = acc.openMessage("t1", 0);
    expect(openAfterRemove).toBeUndefined();

    // Block-creating event → needsResync
    acc.push({ type: "text.start", seq: 5, id: "b-orphan", turnId: "t1" });
    expect(acc.needsResync).toBe(true);
    expect(() => AgReduceResult.parse(acc.result())).not.toThrow();
  });

  // ── (c) message.remove{id:"*", turnId} (REMOVE_ALL) ────────────────────────

  // (c1) REMOVE_ALL removes all messages for the given turn
  it("(c1) message.remove{id:'*',turnId} removes all messages of that turn", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "message.start", seq: 1, id: "mA", role: "assistant", turnId: "t1", threadId: "th1" });
    acc.push({ type: "message.start", seq: 2, id: "mB", role: "assistant", turnId: "t1", threadId: "th1" });
    // Turn t2 with its own message (should NOT be removed)
    acc.push({ type: "turn.start", seq: 3, threadId: "th1", turnId: "t2" });
    acc.push({ type: "message.start", seq: 4, id: "mC", role: "assistant", turnId: "t2", threadId: "th1" });

    acc.push({ type: "message.remove", seq: 5, id: "*", turnId: "t1" });

    const r = acc.result();
    // t1's messages removed; t2's message survives
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.id).toBe("mC");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (c2) REMOVE_ALL with zero-matching turn → no-op (deterministic)
  it("(c2) message.remove{id:'*',turnId:nonexistent} = zero-match no-op", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    acc.push({ type: "message.remove", seq: 2, id: "*", turnId: "t-nonexistent" });

    const r = acc.result();
    // All messages intact
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.id).toBe("m1");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // ── (d) messages.snapshot ───────────────────────────────────────────────────

  // (d1) messages-only snapshot PRESERVES prior artifacts + turns
  it("(d1) messages.snapshot without turns/artifacts PRESERVES prior artifacts + turns", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({
      type: "artifact.start", seq: 1, artifactId: "art1", turnId: "t1", threadId: "th1", name: "report",
    });
    acc.push({ type: "artifact.end", seq: 2, artifactId: "art1", lastChunk: true });

    // Push a messages.snapshot with ONLY messages (no turns, no artifacts)
    acc.push({
      type: "messages.snapshot",
      seq: 3,
      messages: [
        { id: "snap-m1", role: "assistant", content: [], turnId: "t1", threadId: "th1" },
      ],
    });

    const r = acc.result();
    // Messages are replaced
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.id).toBe("snap-m1");
    // Turns are PRESERVED (not replaced)
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.turnId).toBe("t1");
    // Artifacts are PRESERVED (not replaced)
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0]?.artifactId).toBe("art1");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d2) full snapshot REPLACEs messages + turns + artifacts; clears transient scratch
  it("(d2) full messages.snapshot REPLACEs all three containers + clears transient", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "message.start", seq: 1, id: "old-m", role: "assistant", turnId: "t1", threadId: "th1" });
    acc.push({
      type: "tool.start", seq: 2, toolCallId: "tc-pre", name: "calc", turnId: "t1", threadId: "th1",
    });
    // pre-snapshot tool.args.delta (must NOT bleed through after snapshot)
    acc.push({ type: "tool.args.delta", seq: 3, toolCallId: "tc-pre", delta: '{"bleed', turnId: "t1", threadId: "th1" });

    acc.push({
      type: "messages.snapshot",
      seq: 4,
      messages: [
        { id: "snap-m", role: "assistant", content: [], turnId: "snap-t", threadId: "th1" },
      ],
      turns: [
        { turnId: "snap-t", threadId: "th1" },
      ],
      artifacts: [],
    });

    const r = acc.result();
    // Messages replaced
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.id).toBe("snap-m");
    // Turns replaced
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.turnId).toBe("snap-t");
    // Artifacts replaced (empty)
    expect(r.artifacts).toHaveLength(0);
    // No pre-snapshot tool-call scratch should bleed (old-m + tc-pre are gone)
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d3) messages.snapshot with memory REPLACES only scope:thread records (deterministic order)
  it("(d3) messages.snapshot memory replaces only scope:thread records; non-thread survives", () => {
    const acc = new Reducer();
    // Seed a user-scope and agent-scope memory record (non-thread)
    acc.push({ type: "memory.write", seq: 0, scope: "user", key: "name", value: "Ada" });
    acc.push({ type: "memory.write", seq: 1, scope: "agent", key: "cfg", value: { mode: "fast" } });
    // Seed a thread-scope record that should be REPLACED
    acc.push({ type: "memory.write", seq: 2, scope: "thread", key: "ctx", value: "old-ctx" });

    acc.push({
      type: "messages.snapshot",
      seq: 3,
      messages: [],
      memory: [
        { scope: "thread", key: "ctx", value: "new-ctx" },
        { scope: "thread", key: "extra", value: "extra-thread" },
      ],
    });

    const r = acc.result();
    // Non-thread records survive (user + agent)
    const userRec = r.memory.find((m) => m.scope === "user" && m.key === "name");
    const agentRec = r.memory.find((m) => m.scope === "agent" && m.key === "cfg");
    expect(userRec?.value).toBe("Ada");
    expect(agentRec?.value).toEqual({ mode: "fast" });
    // Thread records are replaced by snapshot's thread records
    const threadCtx = r.memory.find((m) => m.scope === "thread" && m.key === "ctx");
    const threadExtra = r.memory.find((m) => m.scope === "thread" && m.key === "extra");
    expect(threadCtx?.value).toBe("new-ctx");
    expect(threadExtra?.value).toBe("extra-thread");
    // Old thread record is gone (replaced)
    expect(r.memory.filter((m) => m.scope === "thread")).toHaveLength(2);
    // Deterministic order: non-thread first, then thread records
    const nonThreadCount = r.memory.filter((m) => m.scope !== "thread").length;
    const threadCount = r.memory.filter((m) => m.scope === "thread").length;
    expect(nonThreadCount).toBe(2);
    expect(threadCount).toBe(2);
    // Non-thread appear before thread in result
    const firstThreadIndex = r.memory.findIndex((m) => m.scope === "thread");
    const lastNonThreadIndex = r.memory.reduce((idx, m, i) => (m.scope !== "thread" ? i : idx), -1);
    expect(lastNonThreadIndex).toBeLessThan(firstThreadIndex);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d3b) snapshot memory[] that includes a non-thread record must NOT clobber a surviving durable record
  it("(d3b) snapshot with mixed-scope memory[] does not clobber surviving user-scope durable record", () => {
    const acc = new Reducer();
    // Seed a durable user-scope record that must survive.
    acc.push({ type: "memory.write", seq: 0, scope: "user", key: "name", value: "Ada" });
    // Deliver a messages.snapshot whose memory[] includes BOTH a thread record AND a user record.
    // The snapshot's user record must NOT clobber the surviving "Ada" value.
    acc.push({
      type: "messages.snapshot",
      seq: 1,
      messages: [],
      memory: [
        { scope: "user", key: "name", value: "Snapshot-Intruder" },
        { scope: "thread", key: "ctx", value: "thread-value" },
      ],
    });
    const r = acc.result();
    // The durable user/name record must still hold "Ada" (snapshot did NOT clobber it).
    const userRec = r.memory.find((m) => m.scope === "user" && m.key === "name");
    expect(userRec?.value).toBe("Ada");
    // The snapshot's thread record IS present.
    const threadRec = r.memory.find((m) => m.scope === "thread" && m.key === "ctx");
    expect(threadRec?.value).toBe("thread-value");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (d4) messages.snapshot clears #resync (un-parks the reducer)
  it("(d4) messages.snapshot clears needsResync (un-parks)", () => {
    const acc = new Reducer();
    // Trigger resync via memory.write patch against never-seeded key
    acc.push({ type: "memory.write", seq: 0, scope: "user", key: "missing", patch: [{ op: "add", path: "/x", value: 1 }] });
    expect(acc.needsResync).toBe(true);

    // Deliver a messages.snapshot — should clear resync
    acc.push({ type: "messages.snapshot", seq: 1, messages: [] });
    expect(acc.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(acc.result())).not.toThrow();
  });

  // (d5) turns-omitting messages.snapshot preserves adoption eligibility for preserved turns (M27 conditional replace)
  it("a turns-omitting messages.snapshot preserves adoption eligibility for preserved turns (M27 conditional replace)", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({
      type: "message.start",
      seq: 1,
      id: "m1",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({
      type: "tool.start",
      seq: 2,
      toolCallId: "c1",
      name: "calc",
      turnId: "t1",
      threadId: "th1",
    });
    // Push a messages.snapshot that OMITS turns (preserves the turn)
    r.push({
      type: "messages.snapshot",
      seq: 3,
      messages: [],
    });
    // After snapshot: turn t1 should still be eligible for tool.done adoption
    r.push({
      type: "tool.done",
      seq: 4,
      toolCallId: "c1",
      content: [],
      outcome: "ok",
      turnId: "t1",
      messageId: "tm1",
      threadId: "th1",
    });
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.find((m) => m.id === "tm1")).toBeDefined();
  });

  // ── (e) seq-gap → resync; BOTH snapshot kinds clear it ─────────────────────

  // (e1) seq-gap (ev.seq > #lastSeq+1) → needsResync set; subsequent events ignored
  it("(e1) seq-gap sets needsResync; events after gap are ignored until snapshot", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    // Gap: seq 3 (skipped seq 2)
    acc.push({ type: "text.start", seq: 3, id: "b1", turnId: "t1" });
    expect(acc.needsResync).toBe(true);

    // text.delta should be IGNORED (reducer is parked)
    acc.push({ type: "text.delta", seq: 4, id: "b1", delta: "ignored delta" });

    const r = acc.result();
    // m1 exists (created before the gap), but b1 was ignored (created after gap detection)
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.content).toHaveLength(0); // text.start was ignored or not applied
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (e2) seq-gap; messages.snapshot recovery clears #resync
  it("(e2) seq-gap → messages.snapshot recovery clears needsResync", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    // Gap: seq 2 (skipped seq 1)
    acc.push({ type: "message.start", seq: 2, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    expect(acc.needsResync).toBe(true);

    // messages.snapshot recovery
    acc.push({
      type: "messages.snapshot",
      seq: 5,
      messages: [{ id: "recovered-m", role: "assistant", content: [], turnId: "t1", threadId: "th1" }],
    });
    expect(acc.needsResync).toBe(false);

    const r = acc.result();
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.id).toBe("recovered-m");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (e3) seq-gap; state.snapshot recovery ALSO clears #resync
  it("(e3) seq-gap → state.snapshot recovery ALSO clears needsResync (both recovery paths)", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    // Gap: seq 2 (skipped seq 1)
    acc.push({ type: "turn.error", seq: 2, turnId: "t1", message: "gap-induced" });
    expect(acc.needsResync).toBe(true);

    // state.snapshot recovery
    acc.push({ type: "state.snapshot", seq: 5, snapshot: { recovered: true } });
    expect(acc.needsResync).toBe(false);
    const r = acc.result();
    expect(r.state).toEqual({ recovered: true });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (e4) while parked, non-snapshot events are ignored; state.snapshot resumes normal processing
  it("(e4) parked reducer ignores non-snapshot events; resumes after state.snapshot", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    // Gap triggers park
    acc.push({ type: "message.start", seq: 2, id: "m-ignored", role: "assistant", turnId: "t1", threadId: "th1" });
    expect(acc.needsResync).toBe(true);

    // These should be ignored while parked
    acc.push({ type: "turn.start", seq: 3, threadId: "th1", turnId: "t2" });
    acc.push({ type: "message.start", seq: 4, id: "m-also-ignored", role: "assistant", turnId: "t2", threadId: "th1" });

    // Recovery via state.snapshot
    acc.push({ type: "state.snapshot", seq: 5, snapshot: { ok: true } });
    expect(acc.needsResync).toBe(false);

    // After recovery, normal events resume
    acc.push({ type: "turn.start", seq: 6, threadId: "th1", turnId: "t3" });
    const r = acc.result();
    // Only t1 and t3 — t2 was ignored while parked
    const turnIds = r.turns.map((t) => t.turnId);
    expect(turnIds).toContain("t1");
    expect(turnIds).toContain("t3");
    expect(turnIds).not.toContain("t2");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // ── (e5)/(e6) seq accounting is universal — ext/live-only events advance
  // #lastSeq too, so they neither mask a genuine forward gap (e6) nor
  // false-park the fold when they sit between two closed events that ARE
  // seq-adjacent-through-the-ext-slot (e5). Task 2b (core-wide fix): the
  // engine's emitExt consumes a seq slot from the SAME monotonic counter as
  // every other event, but push() used to early-return on isClosedEvent(ev)
  // BEFORE the #lastSeq update — an ext.* event between two closed events made
  // the next closed event look like a forward gap → false park → the rest of
  // the fold silently voided (found by M46 review; fixed at reduce.ts push()).

  // (e5) raw-events repro: closed(seq0) → ext.acme.x(seq1) → closed(seq2) —
  // the ext event legitimately occupies seq1, so seq2 is NOT a gap. Both
  // closed events must fold; needsResync must stay false.
  it("(e5) an ext event occupying a seq slot between two closed events does NOT false-park (Task 2b)", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "ext.acme.x", seq: 1, value: "live-only" });
    acc.push({ type: "message.start", seq: 2, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });

    expect(acc.needsResync).toBe(false);

    const r = acc.result();
    // Both closed events folded: the turn AND the message exist.
    expect(r.turns.map((t) => t.turnId)).toContain("t1");
    expect(r.messages.map((m) => m.id)).toContain("m1");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  // (e6) genuine-forward-gap control: closed(seq0) → ext(seq5) — the ext
  // event's OWN seq reveals a real gap (seq 1-4 never arrived), so gap
  // detection must still work THROUGH ext events: this MUST park.
  it("(e6) a genuine forward gap revealed BY an ext event still parks (gap detection works through ext events)", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "ext.acme.y", seq: 5, value: "reveals-the-gap" });

    expect(acc.needsResync).toBe(true);
  });

  // ── (f) live-only sweep ─────────────────────────────────────────────────────

  // (f) live-only events produce NO change to the fold result
  it("(f) live-only events (error/host.context/hitl.ask/ui.surface.start/ext.x.y) produce NO change", () => {
    const baseEvents = [
      { type: "turn.start" as const, seq: 0, threadId: "th1", turnId: "t1" },
      { type: "message.start" as const, seq: 1, id: "m1", role: "assistant" as const, turnId: "t1", threadId: "th1" },
    ];

    const baseline = reduce(baseEvents).result;

    // Each live-only event must produce an identical result
    const withError = reduce([
      ...baseEvents,
      { type: "error" as const, seq: 2, message: "something failed", code: "ERR_FAIL" },
    ]).result;
    expect(withError).toEqual(baseline);

    const withHostContext = reduce([
      ...baseEvents,
      { type: "host.context" as const, seq: 2, theme: { dark: true } },
    ]).result;
    expect(withHostContext).toEqual(baseline);

    const withHitlAsk = reduce([
      ...baseEvents,
      {
        type: "hitl.ask" as const,
        seq: 2,
        askId: "ask1",
        kind: "approval" as const,
        message: "Approve?",
        turnId: "t1",
        threadId: "th1",
      },
    ]).result;
    expect(withHitlAsk).toEqual(baseline);

    const withUiSurface = reduce([
      ...baseEvents,
      {
        type: "ui.surface.start" as const,
        seq: 2,
        surfaceId: "s1",
        kind: "panel",
        turnId: "t1",
        threadId: "th1",
      },
    ]).result;
    expect(withUiSurface).toEqual(baseline);

    // ext.<vendor>.<key> — live-only via isClosedEvent guard (already exits early)
    // Verify the ext path also produces no change via the AgEvent union
    expect(baseline).toEqual(reduce(baseEvents).result);

    expect(() => AgReduceResult.parse(baseline)).not.toThrow();
    expect(() => AgReduceResult.parse(withError)).not.toThrow();
    expect(() => AgReduceResult.parse(withHostContext)).not.toThrow();
    expect(() => AgReduceResult.parse(withHitlAsk)).not.toThrow();
    expect(() => AgReduceResult.parse(withUiSurface)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R10 — CAPSTONE: byte-identity + live-SSE↔history invariant
//
// A RICH event stream that exercises MANY rule-groups in a single interleaved
// stream:
//   • top-level turn (turn.start / message.start / text / reasoning(+opaque) /
//     tool-call+result / message.end / turn.done)
//   • INTERLEAVED subagent nested turn (subagent.start…subagent.done,
//     interleaved by seq with the parent)
//   • MULTI-CANDIDATE message (candidateIndex 0 vs 1)
//   • artifact side-channel (start / delta×2 / end)
//   • memory.write
//   • state.delta (LangGraph node-merge)
//   • source
// ─────────────────────────────────────────────────────────────────────────────

// ── CAPSTONE EVENT FIXTURE ──────────────────────────────────────────────────
// All seqs are ascending with no gaps (gap would trigger resync).
// Typed as AgEvent[] so the array (and its elements) are mutable — required by
// reduce() / Reducer.push().  Individual `as const` suffixes narrow the literal
// discriminant fields so TypeScript can pick the right union arm.
const CAPSTONE_EVENTS: AgEvent[] = [
  // seq 0: top-level turn opens
  { type: "turn.start" as const, seq: 0, threadId: "th1", turnId: "t1", trigger: { kind: "user" as const } },

  // seq 1: message for candidate 0
  {
    type: "message.start" as const,
    seq: 1,
    id: "m1",
    role: "assistant" as const,
    turnId: "t1",
    threadId: "th1",
    candidateIndex: 0,
  },

  // seq 2: text block opens in m1 → content[0]
  { type: "text.start" as const, seq: 2, id: "bt1", turnId: "t1", candidateIndex: 0 },

  // seq 3: subagent INTERLEAVED with parent turn
  { type: "subagent.start" as const, seq: 3, turnId: "t2", parentTurnId: "t1" },

  // seq 4: text delta → text block text = "Hello"
  { type: "text.delta" as const, seq: 4, id: "bt1", delta: "Hello" },

  // seq 5: reasoning block opens in m1 → content[1]
  { type: "reasoning.start" as const, seq: 5, id: "br1", turnId: "t1", candidateIndex: 0 },

  // seq 6: reasoning delta → text = "I think"
  { type: "reasoning.delta" as const, seq: 6, id: "br1", delta: "I think" },

  // seq 7: opaque delta → scratch accumulates "SIG"
  { type: "reasoning.opaque.delta" as const, seq: 7, id: "br1", delta: "SIG" },

  // seq 8: reasoning.opaque → seals opaque from scratch buffer
  { type: "reasoning.opaque" as const, seq: 8, id: "br1", kind: "signature" as const, value: "SIG" },

  // seq 9: reasoning end
  { type: "reasoning.end" as const, seq: 9, id: "br1" },

  // seq 10: text block end
  { type: "text.end" as const, seq: 10, id: "bt1" },

  // seq 11: tool-call block opens in m1 → content[2]
  {
    type: "tool.start" as const,
    seq: 11,
    toolCallId: "tc1",
    name: "search",
    turnId: "t1",
    threadId: "th1",
    candidateIndex: 0,
  },

  // seq 12: partial args
  { type: "tool.args.delta" as const, seq: 12, toolCallId: "tc1", delta: '{"q":' },

  // seq 13: more partial args
  { type: "tool.args.delta" as const, seq: 13, toolCallId: "tc1", delta: '"hello"}' },

  // seq 14: assembled args → authoritative input
  {
    type: "tool.args.assembled" as const,
    seq: 14,
    toolCallId: "tc1",
    input: { q: "hello" },
    turnId: "t1",
    threadId: "th1",
  },

  // seq 15: tool result → tool-result block in m1 → content[3]
  {
    type: "tool.done" as const,
    seq: 15,
    toolCallId: "tc1",
    content: [{ type: "text" as const, text: "results" }],
    outcome: "ok" as const,
    turnId: "t1",
    threadId: "th1",
    candidateIndex: 0,
  },

  // seq 16: seal m1
  { type: "message.end" as const, seq: 16, id: "m1" },

  // seq 17: message for candidate 1 (multi-candidate)
  {
    type: "message.start" as const,
    seq: 17,
    id: "m2",
    role: "assistant" as const,
    turnId: "t1",
    threadId: "th1",
    candidateIndex: 1,
  },

  // seq 18: text block in m2 → content[0]
  { type: "text.start" as const, seq: 18, id: "bt2", turnId: "t1", candidateIndex: 1 },

  // seq 19: text delta → text = "Candidate 1"
  { type: "text.delta" as const, seq: 19, id: "bt2", delta: "Candidate 1" },

  // seq 20: text block end
  { type: "text.end" as const, seq: 20, id: "bt2" },

  // seq 21: subagent done (closes the interleaved nested turn)
  { type: "subagent.done" as const, seq: 21, turnId: "t2", parentTurnId: "t1" },

  // seq 22: artifact side-channel
  {
    type: "artifact.start" as const,
    seq: 22,
    artifactId: "art1",
    turnId: "t1",
    threadId: "th1",
    name: "report",
  },

  // seq 23: artifact part (new part, append:false)
  {
    type: "artifact.delta" as const,
    seq: 23,
    artifactId: "art1",
    part: { type: "text" as const, text: "Report: " },
    append: false,
  },

  // seq 24: artifact text continuation (append:true → concatenate onto last text part)
  {
    type: "artifact.delta" as const,
    seq: 24,
    artifactId: "art1",
    part: { type: "text" as const, text: "done" },
    append: true,
  },

  // seq 25: artifact end
  { type: "artifact.end" as const, seq: 25, artifactId: "art1", lastChunk: true as const },

  // seq 26: memory write
  { type: "memory.write" as const, seq: 26, scope: "user" as const, key: "pref", value: "dark" },

  // seq 27: state.delta LangGraph node-keyed merge
  { type: "state.delta" as const, seq: 27, patch: { agent: { status: "running" } } },

  // seq 28: source citation
  {
    type: "source" as const,
    seq: 28,
    turnId: "t1",
    sourceId: "src1",
    source: { url: "https://example.com", title: "Example" },
  },

  // seq 29: turn done
  {
    type: "turn.done" as const,
    seq: 29,
    turnId: "t1",
    finishReason: "stop" as const,
    outcome: { type: "success" as const },
  },
] as const;

// ── HAND-SPELLED EXPECTED RESULT ─────────────────────────────────────────────
// Reasoned through each fold rule — this IS the spec proof.
//
// messages[] (insertion order of message.start):
//   [0] m1 (candidateIndex:0) — sealed, 4-block content
//   [1] m2 (candidateIndex:1) — 1-block content
//
// m1.content[] (ascending seq of creating event):
//   [0] text block (seq 2)    → text="Hello"
//   [1] reasoning block (seq 5) → text="I think", opaque={kind:"signature",value:"SIG"}
//   [2] tool-call block (seq 11) → toolCallId="tc1", input={q:"hello"}
//   [3] tool-result block (seq 15) → toolCallId="tc1", content=[{type:"text",text:"results"}], outcome="ok"
//
// turns[] (insertion order of turn.start / subagent.start):
//   [0] t1 — parent turn
//   [1] t2 — nested turn (threadId inherited from t1 = "th1")
//
// artifacts[] → [art1]
// memory[]    → [{scope:"user",key:"pref",value:"dark"}]
// state       → {agent:{status:"running"}}

const EXPECTED_RESULT = {
  messages: [
    {
      id: "m1",
      role: "assistant" as const,
      turnId: "t1",
      threadId: "th1",
      candidateIndex: 0,
      content: [
        // [0] text block — text appended across deltas (seq 2/4/10)
        { type: "text" as const, text: "Hello" },
        // [1] reasoning block — delta text + opaque sealed from scratch (seq 5/6/7/8/9)
        {
          type: "reasoning" as const,
          text: "I think",
          opaque: { kind: "signature" as const, value: "SIG" },
        },
        // [2] tool-call block — input assembled (seq 11/12/13/14)
        {
          type: "tool-call" as const,
          toolCallId: "tc1",
          name: "search",
          input: { q: "hello" },
        },
        // [3] tool-result block — landed by tool.done (seq 15)
        {
          type: "tool-result" as const,
          toolCallId: "tc1",
          content: [{ type: "text" as const, text: "results" }],
          outcome: "ok" as const,
        },
      ],
    },
    {
      id: "m2",
      role: "assistant" as const,
      turnId: "t1",
      threadId: "th1",
      candidateIndex: 1,
      content: [
        // [0] text block (seq 18/19/20)
        { type: "text" as const, text: "Candidate 1" },
      ],
    },
  ],
  turns: [
    // t1 — parent turn (turn.start at seq 0, turn.done at seq 29)
    {
      turnId: "t1",
      threadId: "th1",
      trigger: { kind: "user" as const },
      finishReason: "stop" as const,
      outcome: { type: "success" as const },
      sourceIds: ["src1"],
      // audit M23: the full record lands on sources[], not just the bare sourceId.
      sources: [{ sourceId: "src1", source: { url: "https://example.com", title: "Example" } }],
    },
    // t2 — nested turn (subagent.start at seq 3; threadId inherited from t1)
    {
      turnId: "t2",
      parentTurnId: "t1",
      threadId: "th1",
    },
  ],
  artifacts: [
    {
      artifactId: "art1",
      turnId: "t1",
      threadId: "th1",
      name: "report",
      // delta(append:false) starts a new text part; delta(append:true) concatenates onto it
      parts: [{ type: "text" as const, text: "Report: done" }],
    },
  ],
  memory: [
    { scope: "user" as const, key: "pref", value: "dark" },
  ],
  // state.delta key-replace sets {agent:{status:"running"}} from no prior state (draft.4 §5)
  state: { agent: { status: "running" } },
} satisfies import("./agjson.js").AgReduceResult;

// ── CAPSTONE TESTS ────────────────────────────────────────────────────────────

describe("reduce — R10 capstone: byte-identity + live-SSE↔history invariant", () => {
  it("byte-identity: reduce(CAPSTONE_EVENTS) deep-equals the hand-spelled EXPECTED_RESULT (toEqual, order-sensitive)", () => {
    const out = reduce(CAPSTONE_EVENTS);
    expect(out.result).toEqual(EXPECTED_RESULT);
    expect(out.needsResync).toBe(false);
    // Also validate EXPECTED is a valid AgReduceResult (catches mis-spelled types)
    expect(() => AgReduceResult.parse(EXPECTED_RESULT)).not.toThrow();
  });

  it("live-SSE ↔ history: incremental Reducer.push() equals batch reduce()", () => {
    const out = reduce(CAPSTONE_EVENTS);
    const batch = out.result;
    expect(out.needsResync).toBe(false);
    const acc = new Reducer();
    for (const e of CAPSTONE_EVENTS) {
      acc.push(e);
    }
    expect(acc.result()).toEqual(batch);
    expect(acc.needsResync).toBe(false);
  });

  it("interleaved-block-kind order: content[] is in ascending-seq-of-creating-event order (text < reasoning < tool-call)", () => {
    const r = reduce(CAPSTONE_EVENTS).result;
    const m1 = r.messages.find((m) => m.id === "m1");
    expect(m1).toBeDefined();
    const content = m1?.content ?? [];
    // Must have 4 blocks: text(seq2), reasoning(seq5), tool-call(seq11), tool-result(seq15)
    expect(content).toHaveLength(4);
    expect(content[0]?.type).toBe("text");      // seq 2 < seq 5 < seq 11 < seq 15
    expect(content[1]?.type).toBe("reasoning");
    expect(content[2]?.type).toBe("tool-call");
    expect(content[3]?.type).toBe("tool-result");
  });

  // ── alias-in regression tests (capstone review C1/C2) — store-by-ref bugs that
  //    break batch==incremental when an aliased object is later mutated in place ──
  it("alias-in C1: artifact.delta append:true into empty parts is copy-isolated (batch == incremental)", () => {
    const events: AgEvent[] = [
      { type: "turn.start", seq: 0, threadId: "th", turnId: "t" },
      { type: "artifact.start", seq: 1, artifactId: "a1", turnId: "t", threadId: "th" },
      { type: "artifact.delta", seq: 2, artifactId: "a1", part: { type: "text", text: "A" }, append: true },
      { type: "artifact.delta", seq: 3, artifactId: "a1", part: { type: "text", text: "B" }, append: true },
    ];
    const out = reduce(events);
    const batch = out.result;
    expect(out.needsResync).toBe(false);
    const acc = new Reducer();
    for (const e of events) acc.push(e);
    expect(acc.result()).toEqual(batch);
    expect(acc.needsResync).toBe(false);
    expect(batch.artifacts[0]?.parts[0]).toMatchObject({ type: "text", text: "AB" });
    // the original event array must NOT have been mutated by the fold
    const ev2 = events[2];
    expect(ev2?.type).toBe("artifact.delta");
    if (ev2?.type === "artifact.delta") expect(ev2.part).toMatchObject({ text: "A" });
  });

  it("alias-in C2: messages.snapshot record is copy-isolated from a later mutation (batch == incremental)", () => {
    const events: AgEvent[] = [
      {
        type: "messages.snapshot",
        seq: 0,
        messages: [{ id: "m1", role: "assistant", content: [], turnId: "t1", threadId: "th" }],
        turns: [{ turnId: "t1", threadId: "th" }],
      },
      { type: "source", seq: 1, turnId: "t1", sourceId: "s1", source: { url: "https://e.com" } },
    ];
    const out = reduce(events);
    const batch = out.result;
    expect(out.needsResync).toBe(false);
    const acc = new Reducer();
    for (const e of events) acc.push(e);
    expect(acc.result()).toEqual(batch);
    expect(acc.needsResync).toBe(false);
    expect(batch.turns[0]?.sourceIds).toEqual(["s1"]); // not ["s1","s1"]
    // the snapshot event's turn object must NOT have been mutated (no sourceIds leaked in)
    expect(JSON.stringify(events[0])).not.toContain("sourceIds");
  });

  // final-review M1: message.remove must clear the per-block #opaque/#toolArgs scratch,
  // else a stale reasoning signature leaks into a LATER message that reuses the id.
  // (byte-identity can't catch this — it corrupts batch AND incremental identically.)
  it("scratch-leak M1: message.remove clears #opaque so a reused reasoning id is not contaminated", () => {
    const events: AgEvent[] = [
      { type: "turn.start", seq: 0, threadId: "th", turnId: "t" },
      { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t", threadId: "th" },
      { type: "reasoning.start", seq: 2, id: "r1" },
      { type: "reasoning.opaque.delta", seq: 3, id: "r1", delta: "STALESIG" },
      { type: "message.remove", seq: 4, id: "m1" },
      { type: "message.start", seq: 5, id: "m2", role: "assistant", turnId: "t", threadId: "th" },
      { type: "reasoning.start", seq: 6, id: "r1" }, // reuse id r1 in the new message
      { type: "reasoning.opaque.delta", seq: 7, id: "r1", delta: "FRESHSIG" },
      { type: "reasoning.opaque", seq: 8, id: "r1", kind: "signature", value: "" },
    ];
    const r = reduce(events).result;
    const m2 = r.messages[0];
    expect(m2?.id).toBe("m2");
    const rblock = m2?.content[0];
    expect(rblock?.type).toBe("reasoning");
    // must be the fresh signature only — NOT "STALESIGFRESHSIG"
    if (rblock?.type === "reasoning") expect(rblock.opaque?.value).toBe("FRESHSIG");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ── turn.error.usage fold (A1) ────────────────────────────────────────────────
describe("turn.error.usage fold", () => {
  it("records usage on the turn record for an errored turn", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "t1", turnId: "turn_1" });
    r.push({
      type: "turn.error",
      seq: 1,
      turnId: "turn_1",
      message: "max turns",
      code: "max_turns",
      usage: { inputTokens: 10, outputTokens: 2, cumulative: false },
    });
    const turn = r.result().turns.find((t) => t.turnId === "turn_1");
    expect(turn?.outcome).toEqual({ type: "error", message: "max turns", code: "max_turns" });
    expect(turn?.usage).toEqual({ inputTokens: 10, outputTokens: 2, cumulative: false });
  });
});

// ── tool.done.structuredContent fold onto tool-result block (A1 §9) ──────────
// Characterization test: structuredContent on tool.done survives the fold and
// appears on the reduced tool-result block (reduce.ts lines 411+432 already
// handle this; test pins the behaviour so a future refactor can't silently drop it).

describe("tool.done.structuredContent fold", () => {
  it("folds tool.done.structuredContent onto the tool-result block", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "t1", turnId: "turn_1" });
    r.push({
      type: "message.start",
      seq: 1,
      id: "m1",
      role: "assistant",
      turnId: "turn_1",
      threadId: "t1",
    });
    r.push({
      type: "tool.start",
      seq: 2,
      toolCallId: "toolu_1",
      name: "render",
      turnId: "turn_1",
      threadId: "t1",
    });
    r.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "toolu_1",
      outcome: "ok",
      content: [{ type: "text", text: "rendered" }],
      structuredContent: { cache: { hit: true } },
      turnId: "turn_1",
      threadId: "t1",
    });
    const block = r
      .result()
      .messages.flatMap((m) => m.content)
      .find((b) => b.type === "tool-result" && b.toolCallId === "toolu_1");
    expect(block).toMatchObject({
      type: "tool-result",
      toolCallId: "toolu_1",
      structuredContent: { cache: { hit: true } },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-MSG seal + binding-window enforcement (audit M19)
//
// A sealed message (message.end) or a closed turn (turn.done/error/abort) is
// NEVER a valid attach target — a block-creating event that targets one must
// degrade loudly (needsResync) instead of silently attaching past the seal.
// ─────────────────────────────────────────────────────────────────────────────

describe("INV-MSG seal + binding window enforcement (audit M19)", () => {
  const open: AgEvent[] = [
    { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
    { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
  ];

  it("a block-creating event after message.end parks (resync), never a silent attach", () => {
    const r = new Reducer();
    for (const e of open) r.push(e);
    r.push({ type: "message.end", seq: 2, id: "m1" });
    r.push({ type: "text.start", seq: 3, id: "x1", turnId: "t1" });
    expect(r.needsResync).toBe(true);
    const m1 = r.result().messages.find((m) => m.id === "m1");
    expect(m1?.content).toHaveLength(0); // nothing attached to the sealed message
  });

  it("a block-creating event after turn.done parks (binding window closed)", () => {
    const r = new Reducer();
    for (const e of open) r.push(e);
    r.push({
      type: "turn.done",
      seq: 2,
      turnId: "t1",
      outcome: { type: "success" },
      finishReason: "stop",
    });
    r.push({ type: "text.start", seq: 3, id: "x1", turnId: "t1" });
    expect(r.needsResync).toBe(true);
  });

  it("turn.done.messageMetadata still lands (read happens before the window closes)", () => {
    const r = new Reducer();
    for (const e of open) r.push(e);
    r.push({
      type: "turn.done",
      seq: 2,
      turnId: "t1",
      outcome: { type: "success" },
      finishReason: "stop",
      messageMetadata: { k: 1 },
    });
    expect(r.result().messages[0]?.messageMetadata).toEqual({ k: 1 });
  });

  // Controller-added leg on Task 6 (review finding on Task 4's #closedTurns work,
  // same INV-MSG class as the two tests above): the tool.done MERGE branch had NO
  // closed-turn/sealed guard — a post-terminal straggler tool.done for a still-open
  // more:true preliminary silently mutated a closed turn's published content.
  it("a straggler tool.done for a still-open more:true preliminary parks after turn.error — never mutates the closed turn's published content (audit M20 controller leg)", () => {
    const r = new Reducer();
    for (const e of open) r.push(e);
    r.push({
      type: "tool.start",
      seq: 2,
      toolCallId: "c1",
      name: "poll",
      turnId: "t1",
    });
    r.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "c1",
      content: [{ type: "text", text: "working..." }],
      outcome: "ok",
      more: true,
      turnId: "t1",
    });
    r.push({
      type: "turn.error",
      seq: 4,
      turnId: "t1",
      message: "boom",
    });
    // Straggler final tool.done arrives AFTER the turn already closed.
    r.push({
      type: "tool.done",
      seq: 5,
      toolCallId: "c1",
      content: [{ type: "text", text: "final (must never land)" }],
      outcome: "ok",
      turnId: "t1",
    });
    expect(r.needsResync).toBe(true);
    const tr = r.result().messages[0]?.content.find((b) => b.type === "tool-result");
    expect(tr?.type === "tool-result" && tr.content).toEqual([{ type: "text", text: "working..." }]);
    expect(tr?.type === "tool-result" && tr.preliminary).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-MSG for DELTA events targeting a SEALED message (SPEC.md:745)
//
// "A block-creating or delta event targeting a sealed message ... is a
// reduce()-error → snapshot-resync, never a silent attach." The delta events
// resolve their block by id (#blockPos), so the openMessage() pointer clear
// never saw them. This is the SEALED half only (sp-protocol ruling A,
// 2026-09-23); the closed-turn half waits for per-turn turnIds in the claude
// facet (ruling B). text.end / reasoning.end / reasoning.opaque /
// tool.args.assembled are not named by :745 and are untouched.
// ─────────────────────────────────────────────────────────────────────────────

describe("INV-MSG: a straggler delta into a sealed message parks (SPEC.md:745)", () => {
  // One open message m1 holding a text, a reasoning and a tool-call block.
  const withBlocks = (): Reducer => {
    const r = new Reducer();
    const evs: AgEvent[] = [
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
      { type: "text.start", seq: 2, id: "x1", turnId: "t1" },
      { type: "text.delta", seq: 3, id: "x1", delta: "on time" },
      { type: "reasoning.start", seq: 4, id: "r1", turnId: "t1" },
      { type: "reasoning.delta", seq: 5, id: "r1", delta: "thought" },
      { type: "tool.start", seq: 6, toolCallId: "c1", name: "echo", turnId: "t1" },
      { type: "tool.args.delta", seq: 7, toolCallId: "c1", delta: "{" },
    ];
    for (const e of evs) r.push(e);
    return r;
  };
  const seal: AgEvent = { type: "message.end", seq: 8, id: "m1" };

  const stragglers: Array<[string, AgEvent]> = [
    ["text.delta", { type: "text.delta", seq: 9, id: "x1", delta: " LATE" }],
    ["reasoning.delta", { type: "reasoning.delta", seq: 9, id: "r1", delta: " LATE" }],
    ["reasoning.opaque.delta", { type: "reasoning.opaque.delta", seq: 9, id: "r1", delta: "LATE" }],
    ["tool.args.delta", { type: "tool.args.delta", seq: 9, toolCallId: "c1", delta: "LATE" }],
  ];

  for (const [name, straggler] of stragglers) {
    it(`a straggler ${name} after message.end parks and mutates nothing`, () => {
      const r = withBlocks();
      r.push(seal);
      expect(r.needsResync).toBe(false);
      r.push(straggler);
      expect(r.needsResync).toBe(true);
      const content = r.result().messages.find((m) => m.id === "m1")!.content;
      expect(content.find((b) => b.type === "text")).toMatchObject({ text: "on time" });
      expect(content.find((b) => b.type === "reasoning")).toMatchObject({ text: "thought" });
    });
  }

  it("control: the same deltas BEFORE the seal fold clean", () => {
    const r = withBlocks();
    // same four events, re-sequenced contiguously (seq 8-11) ahead of the seal
    stragglers.forEach(([, e], i) => r.push({ ...e, seq: 8 + i } as AgEvent));
    r.push({ ...seal, seq: 12 } as AgEvent);
    expect(r.needsResync).toBe(false);
    const m1 = r.result().messages.find((m) => m.id === "m1")!;
    expect(m1.content.find((b) => b.type === "text")).toMatchObject({ text: "on time LATE" });
    expect(m1.content.find((b) => b.type === "reasoning")).toMatchObject({ text: "thought LATE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-MSG for BLOCK-FINALIZING events (draft.4 E5, founder-ruled editorial
// batch 1): exactly text.end, reasoning.end, reasoning.opaque and
// tool.args.assembled, targeting a sealed message or any message of a closed
// turn, park like a delta, never a silent merge. The message-level merges
// (message.metadata, turn.done.messageMetadata) stay outside the rule.
// ─────────────────────────────────────────────────────────────────────────────

describe("INV-MSG E5: a block-finalizing event into a sealed message or a closed turn parks", () => {
  // One open message m1 holding a text, a reasoning and a tool-call block, all unfinalized.
  const HEAD: AgEvent[] = [
    { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
    { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
    { type: "text.start", seq: 2, id: "x1", turnId: "t1" },
    { type: "text.delta", seq: 3, id: "x1", delta: "on time" },
    { type: "reasoning.start", seq: 4, id: "r1", turnId: "t1" },
    { type: "reasoning.delta", seq: 5, id: "r1", delta: "thought" },
    { type: "tool.start", seq: 6, toolCallId: "c1", name: "echo", turnId: "t1" },
  ];
  const meta = { openai: { late: true } };
  const finalizers: Array<[string, AgEvent]> = [
    ["text.end", { type: "text.end", seq: 0, id: "x1", providerMetadata: meta }],
    ["reasoning.end", { type: "reasoning.end", seq: 0, id: "r1", providerMetadata: meta }],
    ["reasoning.opaque", { type: "reasoning.opaque", seq: 0, id: "r1", kind: "signature", value: "SIG" }],
    ["tool.args.assembled", { type: "tool.args.assembled", seq: 0, toolCallId: "c1", input: { message: "LATE" } }],
  ];
  const at = (e: AgEvent, seq: number) => ({ ...e, seq }) as AgEvent;
  const fold = (evs: AgEvent[]) => {
    const r = new Reducer();
    for (const e of evs) r.push(e);
    return r;
  };
  /** The three blocks as they were before any finalizer. */
  const expectUnfinalized = (r: Reducer) => {
    const content = r.result().messages.find((m) => m.id === "m1")!.content;
    const text = content.find((b) => b.type === "text") as { text: string; providerMetadata?: unknown };
    const reasoning = content.find((b) => b.type === "reasoning") as { providerMetadata?: unknown; opaque?: unknown };
    const call = content.find((b) => b.type === "tool-call") as { input: unknown };
    expect(text).toMatchObject({ text: "on time" });
    expect(text.providerMetadata).toBeUndefined();
    expect(reasoning.providerMetadata).toBeUndefined();
    expect(reasoning.opaque).toBeUndefined();
    expect(call.input).toEqual({});
  };

  for (const [name, finalizer] of finalizers) {
    it(`${name} after message.end (sealed) parks and mutates nothing`, () => {
      const r = fold([...HEAD, { type: "message.end", seq: 7, id: "m1" }]);
      expect(r.needsResync).toBe(false);
      r.push(at(finalizer, 8));
      expect(r.needsResync).toBe(true);
      expectUnfinalized(r);
    });

    it(`${name} into an UNSEALED message of a closed turn parks and mutates nothing`, () => {
      const r = fold([...HEAD, { type: "turn.done", seq: 7, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" }]);
      expect(r.needsResync).toBe(false);
      r.push(at(finalizer, 8));
      expect(r.needsResync).toBe(true);
      expectUnfinalized(r);
    });
  }

  it("control: the same four finalizers BEFORE the seal fold clean and land", () => {
    const r = fold([...HEAD, ...finalizers.map(([, e], i) => at(e, 7 + i)), { type: "message.end", seq: 11, id: "m1" }]);
    expect(r.needsResync).toBe(false);
    const content = r.result().messages.find((m) => m.id === "m1")!.content;
    expect(content.find((b) => b.type === "text")).toMatchObject({ providerMetadata: meta });
    expect(content.find((b) => b.type === "reasoning")).toMatchObject({ providerMetadata: meta, opaque: { kind: "signature", value: "SIG" } });
    expect(content.find((b) => b.type === "tool-call")).toMatchObject({ input: { message: "LATE" } });
  });

  it("outside the rule: message.metadata and turn.done.messageMetadata still merge onto a sealed message, no park", () => {
    const r = fold([
      ...HEAD,
      { type: "message.end", seq: 7, id: "m1" },
      { type: "message.metadata", seq: 8, messageId: "m1", metadata: { app: { note: "after seal" } } },
      { type: "turn.done", seq: 9, turnId: "t1", outcome: { type: "success" }, finishReason: "stop", messageId: "m1", messageMetadata: { usage: 1 } },
    ]);
    expect(r.needsResync).toBe(false);
    const m1 = r.result().messages.find((m) => m.id === "m1")!;
    expect(m1.metadata).toMatchObject({ app: { note: "after seal" } });
    expect(m1.messageMetadata).toEqual({ usage: 1 });
  });

  it("a finalizer for a block the reducer never saw stays a no-op (no park), as before", () => {
    const r = fold([...HEAD, { type: "message.end", seq: 7, id: "m1" }, { type: "text.end", seq: 8, id: "unknown" }]);
    expect(r.needsResync).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tool-result typed `preliminary` + turn.done.messageId targeting (audit M20)
// ─────────────────────────────────────────────────────────────────────────────

describe("tool.done snapshot fold over a kept-open result (draft.4 §5; fold/flush P1)", () => {
  const S = { cache: { hit: true } };
  const U = { card: "weather" };
  const M = { ui: { resourceUri: "ui://cards/weather" } };
  const T = { "host/k": "v" };
  const open = (): Reducer => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({ type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    r.push({ type: "tool.start", seq: 2, toolCallId: "c1", name: "poll", turnId: "t1" });
    return r;
  };
  const results = (r: Reducer) => r.result().messages.flatMap((m) => m.content).filter((b) => b.type === "tool-result");

  const LEG1: AgEvent[] = [
    { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
    { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
    { type: "tool.start", seq: 2, toolCallId: "c1", name: "poll", turnId: "t1" },
    {
      type: "tool.done",
      seq: 3,
      toolCallId: "c1",
      more: true,
      content: [{ type: "text", text: "A" }],
      outcome: "error",
      isError: true,
      errorText: "e",
      structuredContent: S,
      uiData: U,
      _meta: M,
      toolMetadata: T,
      providerMetadata: { p: 1 },
      turnId: "t1",
    },
    {
      type: "tool.done",
      seq: 4,
      toolCallId: "c1",
      content: [{ type: "text", text: "B" }],
      outcome: "ok",
      providerMetadata: { q: 2 },
      turnId: "t1",
    },
  ];

  it("§10 item 25 leg: an ok final over a kept-open error folds to exactly the ok snapshot", () => {
    const r = open();
    r.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "c1",
      more: true,
      content: [{ type: "text", text: "A" }],
      outcome: "error",
      isError: true,
      errorText: "e",
      structuredContent: S,
      uiData: U,
      _meta: M,
      toolMetadata: T,
      providerMetadata: { p: 1 },
      turnId: "t1",
    });
    r.push({
      type: "tool.done",
      seq: 4,
      toolCallId: "c1",
      content: [{ type: "text", text: "B" }],
      outcome: "ok",
      providerMetadata: { q: 2 },
      turnId: "t1",
    });
    expect(r.needsResync).toBe(false);
    const blocks = results(r);
    expect(blocks).toHaveLength(1);
    const rest = blocks[0] as Record<string, unknown>;
    expect(rest).toEqual({
      type: "tool-result",
      toolCallId: "c1",
      content: [{ type: "text", text: "B" }],
      outcome: "ok",
      _meta: M,
      toolMetadata: T,
      providerMetadata: { p: 1, q: 2 },
    });
    // uiData is payload (founder ruling, bar wf_93a30c7b-cd0): the final omits it, so it clears.
    for (const k of ["isError", "errorText", "structuredContent", "uiData", "preliminary"]) expect(k in rest, k).toBe(false);
  });

  it("§10 item 25 leg: the incremental fold deep-equals the batch fold", () => {
    const acc = new Reducer();
    for (const ev of LEG1) acc.push(ev);
    expect(acc.result()).toEqual(reduce(LEG1).result);
    expect(reduce(LEG1).needsResync).toBe(false);
  });

  it("§10 item 25 null leg: a final carrying uiData: null stores null, a value, never a retraction", () => {
    const r = open();
    r.push({ type: "tool.done", seq: 3, toolCallId: "c1", more: true, content: [], outcome: "ok", uiData: U, turnId: "t1" });
    r.push({ type: "tool.done", seq: 4, toolCallId: "c1", content: [], outcome: "ok", uiData: null, turnId: "t1" });
    const block = results(r)[0] as Record<string, unknown>;
    expect("uiData" in block).toBe(true);
    expect(block["uiData"]).toBeNull();
    expect(r.needsResync).toBe(false);
  });

  it("omitted uiData and structuredContent clear, while _meta.ui.resourceUri (a descriptor) survives", () => {
    const r = open();
    r.push({ type: "tool.done", seq: 3, toolCallId: "c1", more: true, content: [], outcome: "ok", uiData: U, structuredContent: S, _meta: M, turnId: "t1" });
    r.push({ type: "tool.done", seq: 4, toolCallId: "c1", content: [{ type: "text", text: "done" }], outcome: "ok", turnId: "t1" });
    const block = results(r)[0] as Record<string, unknown>;
    for (const k of ["uiData", "structuredContent"]) expect(k in block, k).toBe(false);
    expect(block["_meta"]).toEqual({ ui: { resourceUri: "ui://cards/weather" } });
  });

  it("an error final over a kept-open structuredContent folds with no structuredContent", () => {
    const r = open();
    r.push({ type: "tool.done", seq: 3, toolCallId: "c1", more: true, content: [], outcome: "ok", structuredContent: S, turnId: "t1" });
    r.push({
      type: "tool.done",
      seq: 4,
      toolCallId: "c1",
      content: [{ type: "text", text: "E" }],
      outcome: "error",
      isError: true,
      errorText: "boom",
      turnId: "t1",
    });
    const block = results(r)[0] as Record<string, unknown>;
    expect(block).toMatchObject({ outcome: "error", isError: true, errorText: "boom", content: [{ type: "text", text: "E" }] });
    expect("structuredContent" in block).toBe(false);
    expect(r.needsResync).toBe(false);
  });

  it("a kept-open snapshot over a kept-open snapshot replaces the payload too (sideData, errorCode, pendingInput cleared)", () => {
    const r = open();
    r.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "c1",
      more: true,
      content: [{ type: "text", text: "1" }],
      outcome: "input_required",
      sideData: { log: 1 },
      errorCode: "E1",
      pendingInput: { requestState: "rs", inputKeys: ["k"] },
      turnId: "t1",
    });
    r.push({ type: "tool.done", seq: 4, toolCallId: "c1", more: true, content: [{ type: "text", text: "2" }], outcome: "ok", turnId: "t1" });
    const block = results(r)[0] as Record<string, unknown>;
    expect(block).toMatchObject({ content: [{ type: "text", text: "2" }], outcome: "ok", preliminary: true });
    for (const k of ["sideData", "errorCode", "pendingInput"]) expect(k in block, k).toBe(false);
  });

  it("a final that omits outcome clears the kept-open outcome (payload, not descriptor)", () => {
    const r = open();
    r.push({ type: "tool.done", seq: 3, toolCallId: "c1", more: true, content: [], outcome: "error", turnId: "t1" });
    r.push({ type: "tool.done", seq: 4, toolCallId: "c1", content: [{ type: "text", text: "done" }], turnId: "t1" });
    const block = results(r)[0] as Record<string, unknown>;
    expect("outcome" in block).toBe(false);
    expect(block["content"]).toEqual([{ type: "text", text: "done" }]);
  });
});

describe("tool-result typed preliminary + turn.done.messageId targeting (audit M20)", () => {
  // SPEC.md:799: tool.done lands toolMetadata and dynamic. The CREATE path
  // always did; the MERGE path (a final tool.done over a more:true
  // preliminary) dropped both. They are descriptors: replaced only when the
  // later event carries them (draft.4 §5 snapshot fold).
  it("a final tool.done over a preliminary lands toolMetadata + dynamic; a final that omits them keeps the preliminary's", () => {
    const open = (): Reducer => {
      const r = new Reducer();
      r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
      r.push({ type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
      r.push({ type: "tool.start", seq: 2, toolCallId: "c1", name: "poll", turnId: "t1" });
      return r;
    };
    const result = (r: Reducer) => r.result().messages[0]!.content.find((b) => b.type === "tool-result") as {
      toolMetadata?: unknown;
      dynamic?: boolean;
    };

    const landed = open();
    landed.push({ type: "tool.done", seq: 3, toolCallId: "c1", content: [], outcome: "ok", more: true, turnId: "t1" });
    landed.push({
      type: "tool.done",
      seq: 4,
      toolCallId: "c1",
      content: [{ type: "text", text: "done" }],
      outcome: "ok",
      toolMetadata: { "host/k": "final" },
      dynamic: true,
      turnId: "t1",
    });
    expect(landed.needsResync).toBe(false);
    expect(result(landed).toolMetadata).toEqual({ "host/k": "final" });
    expect(result(landed).dynamic).toBe(true);

    const kept = open();
    kept.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "c1",
      content: [],
      outcome: "ok",
      more: true,
      toolMetadata: { "host/k": "prelim" },
      dynamic: false,
      turnId: "t1",
    });
    kept.push({ type: "tool.done", seq: 4, toolCallId: "c1", content: [], outcome: "ok", turnId: "t1" });
    expect(result(kept).toolMetadata).toEqual({ "host/k": "prelim" });
    expect(result(kept).dynamic).toBe(false);
  });

  it("more:true lands a typed preliminary flag on the tool-result block (audit M20)", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({
      type: "message.start",
      seq: 1,
      id: "m1",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({ type: "tool.start", seq: 2, toolCallId: "c1", name: "poll", turnId: "t1" });
    r.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "c1",
      content: [],
      outcome: "ok",
      more: true,
      turnId: "t1",
    });
    const blocks = r.result().messages[0]?.content ?? [];
    const tr = blocks.find((b) => b.type === "tool-result");
    expect(tr?.type === "tool-result" && tr.preliminary).toBe(true);
    // the final result clears it (draft.4 §5 snapshot fold)
    r.push({
      type: "tool.done",
      seq: 4,
      toolCallId: "c1",
      content: [{ type: "text", text: "done" }],
      outcome: "ok",
      turnId: "t1",
    });
    const tr2 = r.result().messages[0]?.content.find((b) => b.type === "tool-result");
    expect(tr2?.type === "tool-result" && tr2.preliminary).toBeUndefined();
  });

  it("turn.done.messageId targets the messageMetadata REPLACE-merge (audit M20)", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({
      type: "message.start",
      seq: 1,
      id: "m1",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({
      type: "message.start",
      seq: 2,
      id: "m2",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({
      type: "turn.done",
      seq: 3,
      turnId: "t1",
      outcome: { type: "success" },
      finishReason: "stop",
      messageId: "m1",
      messageMetadata: { k: 1 },
    });
    expect(r.result().messages.find((m) => m.id === "m1")?.messageMetadata).toEqual({ k: 1 });
    expect(r.result().messages.find((m) => m.id === "m2")?.messageMetadata).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tool.done.messageId adoption (SPEC §5 fold row; audit B10)
// ─────────────────────────────────────────────────────────────────────────────

describe("tool.done.messageId adoption (SPEC §5 fold row; audit B10)", () => {
  it("lands the tool-result in a message that adopts messageId as its own id", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({
      type: "message.start",
      seq: 1,
      id: "m1",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({
      type: "tool.start",
      seq: 2,
      toolCallId: "c1",
      name: "search",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "c1",
      content: [],
      outcome: "ok",
      turnId: "t1",
      threadId: "th1",
      messageId: "tm1",
    });
    const tm = r.result().messages.find((m) => m.id === "tm1");
    expect(tm?.role).toBe("tool");
    expect(tm?.content.some((b) => b.type === "tool-result" && b.toolCallId === "c1")).toBe(true);
    expect(r.needsResync).toBe(false);
  });

  it("without messageId, the open-message attach behavior is unchanged", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({
      type: "message.start",
      seq: 1,
      id: "m1",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({
      type: "tool.done",
      seq: 2,
      toolCallId: "c1",
      content: [],
      outcome: "ok",
      turnId: "t1",
      threadId: "th1",
    });
    expect(
      r
        .result()
        .messages.find((m) => m.id === "m1")
        ?.content.some((b) => b.type === "tool-result")
    ).toBe(true);
  });

  it("messageId adoption to an existing unsealed message succeeds", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    // Pre-create message tm1 with role tool
    r.push({
      type: "message.start",
      seq: 1,
      id: "tm1",
      role: "tool",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({
      type: "tool.start",
      seq: 2,
      toolCallId: "c1",
      name: "search",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "c1",
      content: [{ type: "text", text: "result" }],
      outcome: "ok",
      turnId: "t1",
      threadId: "th1",
      messageId: "tm1",
    });
    const tm = r.result().messages.find((m) => m.id === "tm1");
    expect(tm?.role).toBe("tool");
    expect(tm?.content.some((b) => b.type === "tool-result" && b.toolCallId === "c1")).toBe(true);
    expect(r.needsResync).toBe(false);
  });

  it("messageId adoption to a sealed message parks (resync), does not attach", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    // Create an assistant message to hold the tool-call
    r.push({
      type: "message.start",
      seq: 1,
      id: "m1",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({
      type: "tool.start",
      seq: 2,
      toolCallId: "c1",
      name: "search",
      turnId: "t1",
      threadId: "th1",
    });
    // Create and seal the tool-result message
    r.push({
      type: "message.start",
      seq: 3,
      id: "tm1",
      role: "tool",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({ type: "message.end", seq: 4, id: "tm1" });
    // Try to adopt the sealed message
    r.push({
      type: "tool.done",
      seq: 5,
      toolCallId: "c1",
      content: [{ type: "text", text: "result" }],
      outcome: "ok",
      turnId: "t1",
      threadId: "th1",
      messageId: "tm1",
    });
    // Should set needsResync and NOT attach
    expect(r.needsResync).toBe(true);
    const tm = r.result().messages.find((m) => m.id === "tm1");
    expect(tm?.content).toHaveLength(0); // No tool-result attached
  });

  it("messageId adoption into a never-existing message of a closed turn parks — no phantom message", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({
      type: "turn.done",
      seq: 1,
      turnId: "t1",
      outcome: { type: "success" },
      finishReason: "stop",
    });
    // tm1 never existed — the CREATE sub-path would otherwise happily fabricate
    // it into the now-closed turn t1.
    r.push({
      type: "tool.done",
      seq: 2,
      toolCallId: "c1",
      content: [{ type: "text", text: "result" }],
      outcome: "ok",
      turnId: "t1",
      threadId: "th1",
      messageId: "tm1",
    });
    expect(r.needsResync).toBe(true);
    const tm = r.result().messages.find((m) => m.id === "tm1");
    expect(tm).toBeUndefined(); // no phantom message created
  });

  it("a lone orphan tool.done with NO turns at all parks — no phantom turn fabricated (Task 8c leg 3)", () => {
    // Mirrors the guuey capstone repro 2 shape: a tool_result the assembler
    // truly cannot place anywhere (no turn.start, no subagent.start — nothing
    // was ever legitimately opened). Before leg 3, the CREATE path's
    // ensureTurn() would happily fabricate an "unknown-turn" stub here instead
    // of parking — defeating guuey's skipSnapshot degrade-loudly path.
    const r = new Reducer();
    r.push({
      type: "tool.done",
      seq: 0,
      toolCallId: "orphan_1",
      content: [{ type: "text", text: "result" }],
      outcome: "ok",
      messageId: "orphan:result",
    });
    expect(r.needsResync).toBe(true);
    expect(r.result().turns).toHaveLength(0);
    expect(r.result().messages).toHaveLength(0);
  });

  it("messageId adoption to an existing message of a closed turn (never sealed) parks — no silent attach", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    // tm1 is created but never sealed with message.end.
    r.push({
      type: "message.start",
      seq: 1,
      id: "tm1",
      role: "tool",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({
      type: "turn.done",
      seq: 2,
      turnId: "t1",
      outcome: { type: "success" },
      finishReason: "stop",
    });
    // tm1 is still unsealed, but its turn is closed — adoption must still park.
    r.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "c1",
      content: [{ type: "text", text: "result" }],
      outcome: "ok",
      turnId: "t1",
      threadId: "th1",
      messageId: "tm1",
    });
    expect(r.needsResync).toBe(true);
    const tm = r.result().messages.find((m) => m.id === "tm1");
    expect(tm?.content).toHaveLength(0); // No tool-result silently attached
  });
});

describe("reducer scratch eviction at turn terminals (audit M51)", () => {
  it("an errored turn's dangling opaque scratch cannot corrupt a later turn's same-id block (audit M51)", () => {
    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({
      type: "message.start",
      seq: 1,
      id: "m1",
      role: "assistant",
      turnId: "t1",
      threadId: "th1",
    });
    r.push({ type: "reasoning.start", seq: 2, id: "r0", turnId: "t1" });
    r.push({ type: "reasoning.opaque.delta", seq: 3, id: "r0", delta: "STALE" });
    r.push({ type: "turn.error", seq: 4, turnId: "t1", message: "boom" }); // dangling scratch
    // next invoke reuses the per-invoke id r0 (backward seq jump tolerated)
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t2" });
    r.push({
      type: "message.start",
      seq: 1,
      id: "m2",
      role: "assistant",
      turnId: "t2",
      threadId: "th1",
    });
    r.push({ type: "reasoning.start", seq: 2, id: "r0", turnId: "t2" });
    r.push({
      type: "reasoning.opaque",
      seq: 3,
      id: "r0",
      kind: "signature",
      value: "FRESH",
      turnId: "t2",
    });
    const m2 = r.result().messages.find((m) => m.id === "m2");
    const block = m2?.content.find((b) => b.type === "reasoning");
    expect(block?.type === "reasoning" && block.opaque?.value).toBe("FRESH"); // not "STALE"+…
    expect(r.needsResync).toBe(false);
  });
});

// ─── workspace#9 — `_meta` carriage on tool-result blocks ─────────────────────
// The §0.4 host side-channel (`_meta`) is exactly the generative-UI bootstrap
// (MCP-Apps `_meta.ui`, A2UI render descriptors); text.start/reasoning.start
// carried theirs from the start, and the tool.done arms silently dropped it —
// every folded consumer lost card-capable results. Both arms now mirror the
// text/reasoning precedent.
describe("tool.done _meta carriage (workspace#9)", () => {
  const META = { ui: { resourceUri: "ui://cards/1" } };

  it("CREATE: a tool.done with _meta lands it on the tool-result block", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      { type: "tool.start", seq: 2, toolCallId: "tm1", name: "render", turnId: "t1", threadId: "th1" },
      {
        type: "tool.done",
        seq: 3,
        toolCallId: "tm1",
        content: [],
        outcome: "ok",
        _meta: META,
        turnId: "t1",
        threadId: "th1",
      },
    ]).result;
    const block = r.messages[0]?.content[1];
    expect(block?.type).toBe("tool-result");
    if (block?.type === "tool-result") expect(block._meta).toEqual(META);
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  it("MERGE: a preliminary's _meta SURVIVES a final REPLACE that omits its own", () => {
    const acc = new Reducer();
    acc.push(TURN_START);
    acc.push(MSG_START);
    acc.push({ type: "tool.start", seq: 2, toolCallId: "tm2", name: "render", turnId: "t1", threadId: "th1" });
    acc.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "tm2",
      content: [{ type: "text", text: "rendering..." }],
      outcome: "ok",
      more: true,
      _meta: META,
      turnId: "t1",
      threadId: "th1",
    });
    acc.push({
      type: "tool.done",
      seq: 4,
      toolCallId: "tm2",
      content: [{ type: "text", text: "rendered" }],
      outcome: "ok",
      turnId: "t1",
      threadId: "th1",
    });
    const r = acc.result();
    const block = r.messages[0]?.content[1];
    expect(block?.type).toBe("tool-result");
    if (block?.type === "tool-result") {
      expect(block._meta).toEqual(META);
      expect(block.preliminary).toBeUndefined();
      expect(block.content[0]).toMatchObject({ text: "rendered" });
    }
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  it("MERGE: a final tool.done carrying its OWN _meta overwrites the preliminary's", () => {
    const acc = new Reducer();
    acc.push(TURN_START);
    acc.push(MSG_START);
    acc.push({ type: "tool.start", seq: 2, toolCallId: "tm3", name: "render", turnId: "t1", threadId: "th1" });
    acc.push({
      type: "tool.done",
      seq: 3,
      toolCallId: "tm3",
      content: [],
      outcome: "ok",
      more: true,
      _meta: { ui: { resourceUri: "ui://cards/preliminary" } },
      turnId: "t1",
      threadId: "th1",
    });
    acc.push({
      type: "tool.done",
      seq: 4,
      toolCallId: "tm3",
      content: [],
      outcome: "ok",
      _meta: META,
      turnId: "t1",
      threadId: "th1",
    });
    const block = acc.result().messages[0]?.content[1];
    if (block?.type === "tool-result") expect(block._meta).toEqual(META);
  });

  it("a _meta-less tool.done still produces a _meta-less block (no empty bag fabricated)", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      { type: "tool.start", seq: 2, toolCallId: "tm4", name: "calc", turnId: "t1", threadId: "th1" },
      { type: "tool.done", seq: 3, toolCallId: "tm4", content: [], outcome: "ok", turnId: "t1", threadId: "th1" },
    ]).result;
    const block = r.messages[0]?.content[1];
    if (block?.type === "tool-result") expect("_meta" in block).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// draft.4 `phase` (rnd 13+17 stage 2, P-phase): an open-string label on
// text.start/text.end/reasoning.start/reasoning.end that folds onto the block.
// Set-if-present; a value on *.end REPLACES the prior one, an absent one keeps
// it; no fill once the owning message is sealed.
// ─────────────────────────────────────────────────────────────────────────────

describe("draft.4 phase on text and reasoning blocks (rnd 13+17 stage 2)", () => {
  const head: AgEvent[] = [
    { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
    { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
  ];
  const textStream = (start: object, end: object): AgEvent[] =>
    [
      ...head,
      { type: "text.start", seq: 2, id: "x1", turnId: "t1", ...start },
      { type: "text.delta", seq: 3, id: "x1", delta: "hi" },
      { type: "text.end", seq: 4, id: "x1", ...end },
      { type: "message.end", seq: 5, id: "m1" },
    ] as AgEvent[];
  const reasoningStream = (start: object, end: object): AgEvent[] =>
    [
      ...head,
      { type: "reasoning.start", seq: 2, id: "r1", turnId: "t1", ...start },
      { type: "reasoning.delta", seq: 3, id: "r1", delta: "think" },
      { type: "reasoning.end", seq: 4, id: "r1", ...end },
      { type: "message.end", seq: 5, id: "m1" },
    ] as AgEvent[];
  const block = (evs: AgEvent[]) => reduce(evs).result.messages[0]!.content[0] as { phase?: string };

  it("the schema accepts phase on the four events and on text/reasoning blocks, as an OPEN string", () => {
    for (const ev of [...textStream({ phase: "interim" }, { phase: "x-future" }), ...reasoningStream({ phase: "interim" }, { phase: "x-future" })]) {
      expect(() => AgEvent.parse(ev)).not.toThrow();
    }
    expect(() => AgReduceResult.parse(reduce(textStream({ phase: "x-future" }, {})).result)).not.toThrow();
  });

  it("(a) text.start{phase:'interim'} → delta → text.end{} folds to 'interim'", () => {
    expect(block(textStream({ phase: "interim" }, {})).phase).toBe("interim");
  });

  it("(b) reasoning.end{phase:'interim'} sets it", () => {
    expect(block(reasoningStream({}, { phase: "interim" })).phase).toBe("interim");
  });

  it("(c) a start value survives a phase-less end (text and reasoning)", () => {
    expect(block(textStream({ phase: "interim" }, {})).phase).toBe("interim");
    expect(block(reasoningStream({ phase: "interim" }, {})).phase).toBe("interim");
  });

  it("a value on *.end REPLACES the start's", () => {
    expect(block(textStream({ phase: "interim" }, { phase: "x-other" })).phase).toBe("x-other");
    expect(block(reasoningStream({ phase: "interim" }, { phase: "x-other" })).phase).toBe("x-other");
  });

  it("(d) an unknown value ('x-future') folds verbatim", () => {
    expect(block(textStream({ phase: "x-future" }, {})).phase).toBe("x-future");
  });

  it("(e) the same streams with every phase removed fold exactly as draft.3 did: no phase key", () => {
    for (const evs of [textStream({}, {}), reasoningStream({}, {})]) {
      const b = block(evs);
      expect("phase" in b).toBe(false);
    }
  });

  it("(f) INV-FOLD: an incremental fold equals the batch fold", () => {
    const evs = [...textStream({ phase: "interim" }, { phase: "x-other" })];
    const r = new Reducer();
    const snapshots = evs.map((e) => {
      r.push(e);
      return r.result();
    });
    expect(snapshots[snapshots.length - 1]).toEqual(reduce(evs).result);
  });

  it("no post-seal fill: a phase on a text.end after message.end is not applied, and the fold parks (draft.4 E5)", () => {
    const evs = [
      ...head,
      { type: "text.start", seq: 2, id: "x1", turnId: "t1", phase: "interim" },
      { type: "text.delta", seq: 3, id: "x1", delta: "hi" },
      { type: "message.end", seq: 4, id: "m1" },
      { type: "text.end", seq: 5, id: "x1", phase: "x-late" },
    ] as AgEvent[];
    expect(block(evs).phase).toBe("interim");
    expect(reduce(evs).needsResync).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rd-14 P14 (founder: "1 + 1a: Stall it, like a gap"): INV-SEQ narrows backward
// tolerance to the 0-restart; INV-BLOCK is enforced per invoke; INV-MSG's
// closed-turn half joins the sealed half (31f7bab).
// ─────────────────────────────────────────────────────────────────────────────

describe("rd-14 P14: delivery integrity in the reference reducer", () => {
  const fold = (evs: AgEvent[]): Reducer => {
    const r = new Reducer();
    for (const e of evs) r.push(e);
    return r;
  };
  const head = (turnId = "t1", msg = "m1", from = 0): AgEvent[] => [
    { type: "turn.start", seq: from, threadId: "th1", turnId },
    { type: "message.start", seq: from + 1, id: msg, role: "assistant", turnId, threadId: "th1" },
  ];
  const done = (turnId: string, seq: number): AgEvent =>
    ({ type: "turn.done", seq, turnId, outcome: { type: "success" }, finishReason: "stop" }) as AgEvent;

  describe("INV-SEQ: a repeated or backward seq above 0 parks like a forward gap; only seq 0 restarts", () => {
    it("a repeated seq above 0 parks", () => {
      const r = fold([...head(), { type: "text.start", seq: 2, id: "x1", turnId: "t1" }, { type: "text.delta", seq: 2, id: "x1", delta: "dup" }]);
      expect(r.needsResync).toBe(true);
    });
    it("a backward seq above 0 parks", () => {
      const r = fold([
        ...head(),
        { type: "text.start", seq: 2, id: "x1", turnId: "t1" },
        { type: "text.delta", seq: 3, id: "x1", delta: "a" },
        { type: "text.delta", seq: 2, id: "x1", delta: "b" },
      ]);
      expect(r.needsResync).toBe(true);
    });
    it("control: a seq-0 restart (a new invoke) folds normally", () => {
      const r = fold([...head(), { type: "message.end", seq: 2, id: "m1" }, done("t1", 3), ...head("t2", "m2")]);
      expect(r.needsResync).toBe(false);
      expect(r.result().turns.map((t) => t.turnId)).toEqual(["t1", "t2"]);
    });
    it("snapshot-seq-ahead: a parked fold recovers on a snapshot whose seq is ahead, and continues from it", () => {
      const r = fold([...head(), { type: "text.start", seq: 5, id: "x1", turnId: "t1" }]); // forward gap → park
      expect(r.needsResync).toBe(true);
      r.push({ type: "messages.snapshot", seq: 9, messages: [] } as unknown as AgEvent);
      expect(r.needsResync).toBe(false);
      r.push({ type: "turn.start", seq: 10, threadId: "th1", turnId: "t9" });
      expect(r.needsResync).toBe(false);
    });
    it("replay-from-0: a whole completed invoke replayed from seq 0 parks (never folds twice)", () => {
      const invoke: AgEvent[] = [
        ...head(),
        { type: "text.start", seq: 2, id: "x1", turnId: "t1" },
        { type: "text.delta", seq: 3, id: "x1", delta: "once" },
        { type: "message.end", seq: 4, id: "m1" },
        done("t1", 5),
      ];
      const r = fold([...invoke, ...invoke]);
      expect(r.needsResync).toBe(true);
      const texts = r.result().messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text));
      expect(texts).toEqual(["once"]);
    });
  });

  describe("INV-BLOCK (invoke-scoped): a block id is created once per invoke", () => {
    it("a duplicate text.start id parks", () => {
      const r = fold([...head(), { type: "text.start", seq: 2, id: "x1", turnId: "t1" }, { type: "text.start", seq: 3, id: "x1", turnId: "t1" }]);
      expect(r.needsResync).toBe(true);
    });
    it("a duplicate reasoning.start id parks", () => {
      const r = fold([...head(), { type: "reasoning.start", seq: 2, id: "r1", turnId: "t1" }, { type: "reasoning.start", seq: 3, id: "r1", turnId: "t1" }]);
      expect(r.needsResync).toBe(true);
    });
    it("a duplicate tool.start toolCallId parks", () => {
      const r = fold([
        ...head(),
        { type: "tool.start", seq: 2, toolCallId: "c1", name: "echo", turnId: "t1" },
        { type: "tool.start", seq: 3, toolCallId: "c1", name: "echo", turnId: "t1" },
      ]);
      expect(r.needsResync).toBe(true);
    });
    it("a second final (more-less) tool.done for the same toolCallId parks; a preliminary then a final does not", () => {
      const base: AgEvent[] = [...head(), { type: "tool.start", seq: 2, toolCallId: "c1", name: "echo", turnId: "t1" }];
      const ok = fold([
        ...base,
        { type: "tool.done", seq: 3, toolCallId: "c1", content: [], outcome: "ok", more: true, turnId: "t1" },
        { type: "tool.done", seq: 4, toolCallId: "c1", content: [{ type: "text", text: "final" }], outcome: "ok", turnId: "t1" },
      ]);
      expect(ok.needsResync).toBe(false);
      const twice = fold([
        ...base,
        { type: "tool.done", seq: 3, toolCallId: "c1", content: [{ type: "text", text: "final" }], outcome: "ok", turnId: "t1" },
        { type: "tool.done", seq: 4, toolCallId: "c1", content: [{ type: "text", text: "again" }], outcome: "ok", turnId: "t1" },
      ]);
      expect(twice.needsResync).toBe(true);
    });
    it("control: the scope resets at the 0-restart, so a new invoke may reuse block ids", () => {
      const r = fold([
        ...head(),
        { type: "text.start", seq: 2, id: "x1", turnId: "t1" },
        { type: "message.end", seq: 3, id: "m1" },
        done("t1", 4),
        ...head("t2", "m2"),
        { type: "text.start", seq: 2, id: "x1", turnId: "t2" },
      ]);
      expect(r.needsResync).toBe(false);
    });
  });

  describe("INV-MSG closed turn: nothing attaches to a message of a closed turn", () => {
    it("a message.start after its turn's terminal parks", () => {
      const r = fold([...head(), { type: "message.end", seq: 2, id: "m1" }, done("t1", 3), { type: "message.start", seq: 4, id: "m2", role: "assistant", turnId: "t1", threadId: "th1" }]);
      expect(r.needsResync).toBe(true);
    });
    it("a delta into an UNSEALED message of a closed turn parks", () => {
      const r = fold([...head(), { type: "text.start", seq: 2, id: "x1", turnId: "t1" }, done("t1", 3), { type: "text.delta", seq: 4, id: "x1", delta: "late" }]);
      expect(r.needsResync).toBe(true);
    });
    it("control: a block-create after the turn closes already parks (the pointer is gone)", () => {
      const r = fold([...head(), done("t1", 2), { type: "text.start", seq: 3, id: "x2", turnId: "t1" }]);
      expect(r.needsResync).toBe(true);
    });
  });
});

describe("providerMetadata: no explicit undefined key on blocks without metadata (sp-openai PH-2 finding)", () => {
  const base = { turnId: "t1", threadId: "th1" };
  const fold = (withMeta: boolean) =>
    reduce([
      { type: "turn.start", seq: 0, ...base },
      { type: "message.start", seq: 1, id: "m1", role: "assistant", ...base },
      { type: "text.start", seq: 2, id: "x1", ...base },
      { type: "text.delta", seq: 3, id: "x1", delta: "hi", ...base, ...(withMeta ? { providerMetadata: { openai: { a: 1 } } } : {}) },
      { type: "text.end", seq: 4, id: "x1", ...base },
      { type: "reasoning.start", seq: 5, id: "r1", ...base },
      { type: "reasoning.delta", seq: 6, id: "r1", delta: "think", ...base },
      { type: "reasoning.end", seq: 7, id: "r1", ...base },
      { type: "tool.start", seq: 8, toolCallId: "tc1", name: "search", ...base },
      { type: "tool.args.assembled", seq: 9, toolCallId: "tc1", input: { q: "x" }, ...base },
      { type: "tool.done", seq: 10, toolCallId: "tc1", outcome: "ok", content: [], ...base },
      { type: "message.end", seq: 11, id: "m1" },
      { type: "turn.done", seq: 12, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
    ] as AgEvent[]).result;

  it("text, reasoning and tool blocks folded with no metadata carry no own providerMetadata key", () => {
    const blocks = fold(false).messages[0]?.content ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const b of blocks) expect(Object.prototype.hasOwnProperty.call(b, "providerMetadata"), JSON.stringify(b)).toBe(false);
  });

  it("a delta that carries metadata still merges it onto the block (control)", () => {
    const text = (fold(true).messages[0]?.content ?? []).find((b) => (b as { type: string }).type === "text");
    expect((text as { providerMetadata?: unknown }).providerMetadata).toEqual({ openai: { a: 1 } });
  });
});
