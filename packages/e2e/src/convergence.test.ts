/**
 * convergence.test.ts — unit tests for canonicalizeAgjson + assertConvergent.
 *
 * Mandatory coverage:
 *   POSITIVE: two structurally-equal schemas with different ids/seq/usage CONVERGE
 *             (proves the must-ignore set works and the test is not vacuous).
 *   NEGATIVE: two structurally-DIFFERENT schemas THROW with a diff naming the mismatch
 *             (proves the assertion is not a rubber-stamp).
 */
import { describe, it, expect } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { canonicalizeAgjson, assertConvergent, sortKeys } from "./convergence.js";
import type { CanonicalSchema } from "./convergence.js";

// ─── Helpers: minimal AgJSON event builders ───────────────────────────────────

function turnStart(turnId: string, threadId = "thread1"): JsonValue {
  return { type: "turn.start", seq: 0, turnId, threadId };
}

function messageStart(id: string, turnId: string): JsonValue {
  return { type: "message.start", seq: 1, id, turnId, threadId: "thread1", role: "assistant" };
}

function textStart(id: string, messageId: string, turnId: string): JsonValue {
  return { type: "text.start", seq: 2, id, messageId, turnId };
}

function textDelta(id: string, messageId: string, delta: string, turnId: string): JsonValue {
  return { type: "text.delta", seq: 3, id, messageId, delta, turnId };
}

function textEnd(id: string, messageId: string, turnId: string): JsonValue {
  return { type: "text.end", seq: 4, id, messageId, turnId };
}

function toolStart(toolCallId: string, name: string, turnId: string, messageId: string, itemId?: string): JsonValue {
  const ev: { [k: string]: JsonValue } = { type: "tool.start", seq: 5, toolCallId, name, turnId, messageId };
  if (itemId !== undefined) ev.itemId = itemId;
  return ev;
}

function toolArgsDelta(toolCallId: string, delta: string): JsonValue {
  return { type: "tool.args.delta", seq: 6, toolCallId, delta };
}

function toolArgsAssembled(toolCallId: string, input: JsonValue): JsonValue {
  return { type: "tool.args.assembled", seq: 7, toolCallId, input };
}

function messageEnd(id: string, usage?: JsonValue): JsonValue {
  const ev: { [k: string]: JsonValue } = { type: "message.end", seq: 8, id };
  if (usage !== undefined) ev.usage = usage;
  return ev;
}

function toolDone(toolCallId: string, outcome: string, content: JsonValue, turnId: string): JsonValue {
  return { type: "tool.done", seq: 9, turnId, toolCallId, content, outcome, isError: false };
}

function turnDone(
  turnId: string,
  finishReason: string,
  usage?: JsonValue,
  outcomeType = "success",
): JsonValue {
  const ev: { [k: string]: JsonValue } = {
    type: "turn.done",
    seq: 10,
    turnId,
    outcome: { type: outcomeType },
    finishReason,
  };
  if (usage !== undefined) ev.usage = usage;
  return ev;
}

// ─── Minimal "echo hi → Done." AgJSON stream (provider-neutral structure) ──────

/**
 * Build a minimal AgJSON stream for: echo({text:"hi"}) → result "echo: hi" → text "Done."
 * The ids and seq values are parameterized so we can test must-ignore stripping.
 */
function buildEchoStream(ids: {
  turnId1: string;
  msg1Id: string;
  toolCallId: string;
  itemId: string;
  turnId2: string;
  msg2Id: string;
  textBlockId: string;
  seq?: number;
}): JsonValue[] {
  return [
    turnStart(ids.turnId1),
    messageStart(ids.msg1Id, ids.turnId1),
    toolStart(ids.toolCallId, "echo", ids.turnId1, ids.msg1Id, ids.itemId),
    toolArgsDelta(ids.toolCallId, '{"text":"hi"}'),
    toolArgsAssembled(ids.toolCallId, { text: "hi" }),
    messageEnd(ids.msg1Id, { inputTokens: 10, outputTokens: 5 }),
    turnDone(ids.turnId1, "stop", { inputTokens: 10, outputTokens: 5 }),
    toolDone(ids.toolCallId, "ok", [{ type: "text", text: "echo: hi" }], ids.turnId1),
    turnStart(ids.turnId2),
    messageStart(ids.msg2Id, ids.turnId2),
    textStart(ids.textBlockId, ids.msg2Id, ids.turnId2),
    textDelta(ids.textBlockId, ids.msg2Id, "Done.", ids.turnId2),
    textEnd(ids.textBlockId, ids.msg2Id, ids.turnId2),
    messageEnd(ids.msg2Id),
    turnDone(ids.turnId2, "stop"),
  ];
}

// ─── sortKeys tests ───────────────────────────────────────────────────────────

describe("sortKeys", () => {
  it("sorts object keys alphabetically", () => {
    expect(sortKeys({ b: 2, a: 1 })).toEqual({ a: 1, b: 2 });
  });

  it("recurses into nested objects", () => {
    expect(sortKeys({ z: { y: 3, x: 2 }, a: 1 })).toEqual({ a: 1, z: { x: 2, y: 3 } });
  });

  it("recurses into arrays", () => {
    expect(sortKeys([{ b: 2, a: 1 }])).toEqual([{ a: 1, b: 2 }]);
  });

  it("passes scalars through unchanged", () => {
    expect(sortKeys("hello")).toBe("hello");
    expect(sortKeys(42)).toBe(42);
    expect(sortKeys(null)).toBe(null);
    expect(sortKeys(true)).toBe(true);
  });
});

// ─── canonicalizeAgjson — must-ignore set ────────────────────────────────────

describe("canonicalizeAgjson — must-ignore set", () => {
  it("strips seq, turnId, threadId, toolCallId, messageId, id, itemId, usage, model from output", () => {
    const stream = buildEchoStream({
      turnId1: "turn_abc",
      msg1Id: "msg_001",
      toolCallId: "call_xyz",
      itemId: "fc_item_1",
      turnId2: "turn_def",
      msg2Id: "msg_002",
      textBlockId: "block_1",
    });
    const schema = canonicalizeAgjson(stream);
    // The schema fields must NOT contain any ids
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain("turn_abc");
    expect(serialized).not.toContain("turn_def");
    expect(serialized).not.toContain("msg_001");
    expect(serialized).not.toContain("msg_002");
    expect(serialized).not.toContain("call_xyz");
    expect(serialized).not.toContain("fc_item_1");
    expect(serialized).not.toContain("block_1");
  });

  it("strips usage from the schema output", () => {
    const stream = buildEchoStream({
      turnId1: "t1",
      msg1Id: "m1",
      toolCallId: "c1",
      itemId: "i1",
      turnId2: "t2",
      msg2Id: "m2",
      textBlockId: "b1",
    });
    const schema = canonicalizeAgjson(stream);
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain("inputTokens");
    expect(serialized).not.toContain("outputTokens");
  });

  it("excludes delta events, message/turn lifecycle, and text block boundaries from eventSequence", () => {
    const stream = buildEchoStream({
      turnId1: "t1",
      msg1Id: "m1",
      toolCallId: "c1",
      itemId: "i1",
      turnId2: "t2",
      msg2Id: "m2",
      textBlockId: "b1",
    });
    const { eventSequence } = canonicalizeAgjson(stream);
    expect(eventSequence).not.toContain("text.delta");
    expect(eventSequence).not.toContain("tool.args.delta");
    expect(eventSequence).not.toContain("message.start");
    expect(eventSequence).not.toContain("message.end");
    expect(eventSequence).not.toContain("text.start");
    expect(eventSequence).not.toContain("text.end");
    // turn lifecycle is also excluded (provider-specific multiplicity)
    expect(eventSequence).not.toContain("turn.start");
    expect(eventSequence).not.toContain("turn.done");
    // load-bearing events ARE present
    expect(eventSequence).toContain("tool.start");
    expect(eventSequence).toContain("tool.args.assembled");
    expect(eventSequence).toContain("tool.done");
  });
});

// ─── canonicalizeAgjson — must-match set ─────────────────────────────────────

describe("canonicalizeAgjson — must-match set", () => {
  it("captures tool name and sorted input", () => {
    const stream: JsonValue[] = [
      turnStart("t1"),
      messageStart("m1", "t1"),
      toolStart("c1", "myTool", "t1", "m1"),
      toolArgsAssembled("c1", { z: 3, a: 1 }),
      turnDone("t1", "stop"),
    ];
    const { toolCalls } = canonicalizeAgjson(stream);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe("myTool");
    // Keys should be sorted: a before z
    expect(toolCalls[0]?.input).toEqual({ a: 1, z: 3 });
  });

  it("concatenates text.delta fragments into a single textContent block", () => {
    const stream: JsonValue[] = [
      turnStart("t1"),
      textStart("blk1", "m1", "t1"),
      textDelta("blk1", "m1", "Hello, ", "t1"),
      textDelta("blk1", "m1", "world!", "t1"),
      textEnd("blk1", "m1", "t1"),
      turnDone("t1", "stop"),
    ];
    const { textContent } = canonicalizeAgjson(stream);
    expect(textContent).toEqual(["Hello, world!"]);
  });

  it("captures multiple text blocks in order", () => {
    const stream: JsonValue[] = [
      turnStart("t1"),
      textStart("blk1", "m1", "t1"),
      textDelta("blk1", "m1", "First.", "t1"),
      textEnd("blk1", "m1", "t1"),
      textStart("blk2", "m1", "t1"),
      textDelta("blk2", "m1", "Second.", "t1"),
      textEnd("blk2", "m1", "t1"),
      turnDone("t1", "stop"),
    ];
    const { textContent } = canonicalizeAgjson(stream);
    expect(textContent).toEqual(["First.", "Second."]);
  });

  it("captures tool-result outcome", () => {
    const stream: JsonValue[] = [
      turnStart("t1"),
      toolDone("c1", "ok", [{ type: "text", text: "result" }], "t1"),
      turnDone("t1", "stop"),
    ];
    const { toolResults } = canonicalizeAgjson(stream);
    expect(toolResults).toEqual([{ outcome: "ok" }]);
  });

  it("captures finishReason from turn.done", () => {
    const stream: JsonValue[] = [turnStart("t1"), turnDone("t1", "tool_call")];
    const { finishReason } = canonicalizeAgjson(stream);
    expect(finishReason).toBe("tool_call");
  });

  it("uses the last turn.done finishReason when multiple turns exist", () => {
    const stream: JsonValue[] = [
      turnStart("t1"),
      turnDone("t1", "tool_call"),
      turnStart("t2"),
      turnDone("t2", "stop"),
    ];
    const { finishReason } = canonicalizeAgjson(stream);
    expect(finishReason).toBe("stop");
  });
});

// ─── POSITIVE convergence test ────────────────────────────────────────────────

describe("assertConvergent — POSITIVE: different ids/seq/usage but same structure converge", () => {
  it("asserts convergence when two streams have identical task but different identity fields", () => {
    // Claude-style stream: different ids and usage from OpenAI-style
    const claudeStream = buildEchoStream({
      turnId1: "turn_claude_abc123",
      msg1Id: "msg_claude_001",
      toolCallId: "call_claude_xyz",
      itemId: "fc_claude_item",
      turnId2: "turn_claude_def456",
      msg2Id: "msg_claude_002",
      textBlockId: "claude_text_block",
    });
    // OpenAI-style stream: completely different ids
    const openaiStream = buildEchoStream({
      turnId1: "turn_resp_openai_aaa",
      msg1Id: "msg_openai_001",
      toolCallId: "call_EwiJuADOeCUSNTVk5",
      itemId: "fc_0e10e9968fce76e400",
      turnId2: "turn_resp_openai_bbb",
      msg2Id: "msg_openai_002",
      textBlockId: "msg_0e10e996",
    });

    const a = canonicalizeAgjson(claudeStream);
    const b = canonicalizeAgjson(openaiStream);

    // Must NOT throw
    expect(() =>
      assertConvergent(a, b, { scenario: "echo", fw1: "claude", fw2: "openai" }),
    ).not.toThrow();
  });

  it("two identical canonical schemas converge", () => {
    const schema: CanonicalSchema = {
      eventSequence: ["tool.start", "tool.args.assembled", "tool.done"],
      toolCalls: [{ name: "echo", input: { text: "hi" } }],
      textContent: ["Done."],
      toolResults: [{ outcome: "ok" }],
      finishReason: "stop",
    };
    expect(() =>
      assertConvergent(schema, schema, { scenario: "echo", fw1: "fw-a", fw2: "fw-b" }),
    ).not.toThrow();
  });
});

// ─── NEGATIVE convergence tests ──────────────────────────────────────────────

describe("assertConvergent — NEGATIVE: structurally different schemas throw with a named diff", () => {
  const base: CanonicalSchema = {
    // turn.start/turn.done are NOISE (provider turn multiplicity differs);
    // only the task-level events are load-bearing.
    eventSequence: ["tool.start", "tool.args.assembled", "tool.done"],
    toolCalls: [{ name: "echo", input: { text: "hi" } }],
    textContent: ["Done."],
    toolResults: [{ outcome: "ok" }],
    finishReason: "stop",
  };

  it("throws when tool names differ", () => {
    const different: CanonicalSchema = {
      ...base,
      toolCalls: [{ name: "other_tool", input: { text: "hi" } }],
    };
    expect(() =>
      assertConvergent(base, different, { scenario: "echo", fw1: "claude", fw2: "openai" }),
    ).toThrow(/toolCalls\[0\]\.name mismatch/);
  });

  it("throws when tool input differs", () => {
    const different: CanonicalSchema = {
      ...base,
      toolCalls: [{ name: "echo", input: { text: "different text" } }],
    };
    expect(() =>
      assertConvergent(base, different, { scenario: "echo", fw1: "claude", fw2: "openai" }),
    ).toThrow(/toolCalls\[0\]\.input mismatch/);
  });

  it("throws when textContent differs", () => {
    const different: CanonicalSchema = {
      ...base,
      textContent: ["Different response."],
    };
    expect(() =>
      assertConvergent(base, different, { scenario: "echo", fw1: "claude", fw2: "openai" }),
    ).toThrow(/textContent mismatch/);
  });

  it("throws when toolResults outcome differs", () => {
    const different: CanonicalSchema = {
      ...base,
      toolResults: [{ outcome: "error" }],
    };
    expect(() =>
      assertConvergent(base, different, { scenario: "echo", fw1: "claude", fw2: "openai" }),
    ).toThrow(/toolResults\[0\]\.outcome mismatch/);
  });

  it("throws when finishReason differs", () => {
    const different: CanonicalSchema = {
      ...base,
      finishReason: "token_limit",
    };
    expect(() =>
      assertConvergent(base, different, { scenario: "echo", fw1: "claude", fw2: "openai" }),
    ).toThrow(/finishReason mismatch/);
  });

  it("throws when eventSequence differs", () => {
    const different: CanonicalSchema = {
      ...base,
      eventSequence: ["tool.start"],
    };
    expect(() =>
      assertConvergent(base, different, { scenario: "echo", fw1: "claude", fw2: "openai" }),
    ).toThrow(/eventSequence mismatch/);
  });

  it("throws when tool count differs (extra tool call in one)", () => {
    const different: CanonicalSchema = {
      ...base,
      toolCalls: [
        { name: "echo", input: { text: "hi" } },
        { name: "extra", input: {} },
      ],
    };
    expect(() =>
      assertConvergent(base, different, { scenario: "echo", fw1: "claude", fw2: "openai" }),
    ).toThrow(/toolCalls\.length mismatch/);
  });

  it("error message names the specific mismatch fields", () => {
    const different: CanonicalSchema = {
      ...base,
      toolCalls: [{ name: "wrong_tool", input: { text: "hi" } }],
      finishReason: "token_limit",
    };
    let errorMessage = "";
    try {
      assertConvergent(base, different, { scenario: "echo", fw1: "claude", fw2: "openai" });
    } catch (e) {
      if (e instanceof Error) errorMessage = e.message;
    }
    // Both mismatches should be in the single aggregated error
    expect(errorMessage).toContain("toolCalls[0].name mismatch");
    expect(errorMessage).toContain("finishReason mismatch");
    expect(errorMessage).toContain("[echo]");
    expect(errorMessage).toContain("claude");
    expect(errorMessage).toContain("openai");
  });
});

// ─── canonicalizeAgjson — smoke test on an empty stream ─────────────────────

describe("canonicalizeAgjson — edge cases", () => {
  it("returns empty schema for empty stream", () => {
    const schema = canonicalizeAgjson([]);
    expect(schema.eventSequence).toEqual([]);
    expect(schema.toolCalls).toEqual([]);
    expect(schema.textContent).toEqual([]);
    expect(schema.toolResults).toEqual([]);
    expect(schema.finishReason).toBeUndefined();
  });

  it("ignores non-object events gracefully", () => {
    const stream: JsonValue[] = [
      "not-an-object",
      42,
      null,
      // turn.start is NOISE (excluded from sequence), but tool.start is load-bearing
      { type: "turn.start", seq: 0, turnId: "t1", threadId: "th1" },
      { type: "tool.start", seq: 1, toolCallId: "c1", name: "myTool", turnId: "t1", messageId: "m1" },
    ];
    const schema = canonicalizeAgjson(stream);
    // turn.start is noise; only tool.start should be in sequence
    expect(schema.eventSequence).toEqual(["tool.start"]);
  });
});
