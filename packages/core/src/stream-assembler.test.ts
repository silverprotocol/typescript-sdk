import { describe, it, expect } from "vitest";
import { StreamAssembler } from "./stream-assembler.js";
import { AgProviderMeta } from "./agjson.js";

// ── Existing T1 tests ──────────────────────────────────────────────────────────

it("synthesizes turn.start when a message opens before any turn (I1)", () => {
  const a = new StreamAssembler();
  a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
  expect(a.drain().map((e) => e.type)).toEqual(["turn.start", "message.start"]);
});
it("subagentStart seeds the turn so openMessage does NOT add a turn.start", () => {
  const a = new StreamAssembler();
  a.subagentStart("t2", "t1");
  a.openMessage({ id: "m1", role: "assistant", turnId: "t2", threadId: "th1" });
  expect(a.drain().map((e) => e.type)).toEqual(["subagent.start", "message.start"]); // NO turn.start
});
it("subagentDone restores the parent turn as the owner fallback (audit B10)", () => {
  const a = new StreamAssembler();
  a.openTurn("t1", "th1");
  a.subagentStart("t2", "t1");
  a.subagentDone("t2", "t1");
  a.emit({ type: "text.start", id: "x1" }); // after subagent close, owner = parent
  const textStart = a.drain().find((e) => e.type === "text.start");
  expect(textStart?.turnId).toBe("t1");
});
it("assigns turn-scoped monotonic seq across primitive calls (I5)", () => {
  const a = new StreamAssembler();
  a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
  a.closeMessage("m1");
  expect(a.drain().map((e) => e.seq)).toEqual([0, 1, 2]);
});
it("flush() emits message.end for a dangling open message (INV-FLUSH)", () => {
  const a = new StreamAssembler();
  a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
  a.drain();
  expect(a.flush().some((e) => e.type === "message.end")).toBe(true);
});

describe("INV-FLUSH turn closure (audit M21)", () => {
  it("flush() closes a dangling turn with turn.abort(stream-truncated), never success", () => {
    const a = new StreamAssembler();
    a.openTurn("t1", "th1");
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    const evs = a.flush();
    const msgEnd = evs.findIndex((e) => e.type === "message.end");
    const abort = evs.findIndex((e) => e.type === "turn.abort");
    expect(msgEnd).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(msgEnd); // message closes first
    const abortEv = evs[abort];
    expect(abortEv?.type === "turn.abort" && abortEv.reason).toBe("stream-truncated");
    expect(evs.some((e) => e.type === "turn.done")).toBe(false);
  });

  it("flush() after a closed turn emits no turn events", () => {
    const a = new StreamAssembler();
    a.openTurn("t1", "th1");
    a.closeTurnDone("t1", { outcome: { type: "success" }, finishReason: "stop" });
    expect(a.drain().length).toBeGreaterThan(0);
    expect(a.flush().filter((e) => e.type.startsWith("turn."))).toHaveLength(0);
  });

  it("a turn closed via raw emit(turn.abort) is not double-closed at flush", () => {
    const a = new StreamAssembler();
    a.openTurn("t1", "th1");
    a.emit({ type: "turn.abort", reason: "interrupted" }); // turnId backfilled (Task 3)
    a.drain();
    expect(a.flush().filter((e) => e.type === "turn.abort")).toHaveLength(0);
  });

  it("nested dangling turns close innermost-first", () => {
    const a = new StreamAssembler();
    a.openTurn("t1", "th1");
    a.subagentStart("t2", "t1");
    a.drain();
    const aborts = a.flush().filter((e) => e.type === "turn.abort");
    expect(aborts.map((e) => (e.type === "turn.abort" ? e.turnId : undefined))).toEqual([
      "t2",
      "t1",
    ]);
  });
});

// ── T2 tests: content/tool/reasoning primitives ───────────────────────────────

describe("de-cumulation", () => {
  it("de-cumulates textDelta: [Hel, Hello] cumulative → emits [Hel, lo]", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.textStart("s1", "m1");
    a.textDelta("s1", "m1", "Hel", { cumulative: true });
    a.textDelta("s1", "m1", "Hello", { cumulative: true });
    const evs = a.drain();
    const deltas = evs.filter((e) => e.type === "text.delta") as Array<{ delta: string }>;
    expect(deltas.map((e) => e.delta)).toEqual(["Hel", "lo"]);
  });

  it("non-cumulative textDelta: passes through verbatim", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.textStart("s2", "m1");
    a.textDelta("s2", "m1", "Hello world");
    const evs = a.drain();
    const deltas = evs.filter((e) => e.type === "text.delta") as Array<{ delta: string }>;
    expect(deltas.map((e) => e.delta)).toEqual(["Hello world"]);
  });

  it("de-cumulates reasoningDelta: cumulative slice", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.reasoningStart("r1", "m1");
    a.reasoningDelta("r1", "m1", "Think", { cumulative: true });
    a.reasoningDelta("r1", "m1", "Thinking", { cumulative: true });
    const evs = a.drain();
    const deltas = evs.filter((e) => e.type === "reasoning.delta") as Array<{ delta: string }>;
    expect(deltas.map((e) => e.delta)).toEqual(["Think", "ing"]);
  });

  it("de-cumulates toolArgsDelta: cumulative slice", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.toolStart({ toolCallId: "tc1", name: "my_tool", messageId: "m1" });
    a.toolArgsDelta("tc1", '{"a":', { cumulative: true });
    a.toolArgsDelta("tc1", '{"a":1}', { cumulative: true });
    const evs = a.drain();
    const deltas = evs.filter((e) => e.type === "tool.args.delta") as Array<{ delta: string }>;
    expect(deltas.map((e) => e.delta)).toEqual(['{"a":', "1}"]); // sliced from prior
  });

  it("de-cumulation buffers are per-id: two streams don't interfere", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.textStart("sA", "m1");
    a.textStart("sB", "m1");
    a.textDelta("sA", "m1", "AB", { cumulative: true });
    a.textDelta("sB", "m1", "XY", { cumulative: true });
    a.textDelta("sA", "m1", "ABCD", { cumulative: true });
    a.textDelta("sB", "m1", "XYZW", { cumulative: true });
    const evs = a.drain();
    const aDeltas = evs.filter((e) => e.type === "text.delta" && (e as { id: string }).id === "sA") as Array<{ delta: string }>;
    const bDeltas = evs.filter((e) => e.type === "text.delta" && (e as { id: string }).id === "sB") as Array<{ delta: string }>;
    expect(aDeltas.map((e) => e.delta)).toEqual(["AB", "CD"]);
    expect(bDeltas.map((e) => e.delta)).toEqual(["XY", "ZW"]);
  });
});

describe("turnId backfill", () => {
  it("content events backfill turnId from owning message (#msgTurn)", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.textStart("s1", "m1");
    const evs = a.drain();
    const textStart = evs.find((e) => e.type === "text.start");
    expect((textStart as { turnId?: string })?.turnId).toBe("t1");
  });

  it("orphan toolDone (no turnId, no messageId) backfills from #lastTurn", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    // toolDone with neither turnId (via fields) nor messageId
    a.toolDone({ toolCallId: "tc1", content: [] });
    const evs = a.drain();
    const done = evs.find((e) => e.type === "tool.done");
    expect((done as { turnId?: string })?.turnId).toBe("t1");
  });

  it("toolDone with explicit messageId backfills turnId via #msgTurn", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t42", threadId: "th1" });
    a.drain();
    a.toolDone({ toolCallId: "tc1", content: [], messageId: "m1" });
    const evs = a.drain();
    const done = evs.find((e) => e.type === "tool.done");
    expect((done as { turnId?: string })?.turnId).toBe("t42");
  });

  it("toolDone explicit turnId field wins over message turnId and #lastTurn", () => {
    // #resolveTurnId tier-1: explicit field → message's turnId → #lastTurn.
    // After openMessage sets #lastTurn="t1" and #msgTurn["m1"]="t1",
    // passing turnId:"override-t" in the fields must take priority over both.
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.toolDone({ toolCallId: "tc1", content: [], messageId: "m1", turnId: "override-t" });
    const evs = a.drain();
    const done = evs.find((e) => e.type === "tool.done");
    expect((done as { turnId?: string })?.turnId).toBe("override-t");
  });

  it("textDelta backfills turnId from messageId chain", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t99", threadId: "th1" });
    a.drain();
    a.textStart("s1", "m1");
    a.textDelta("s1", "m1", "hi");
    const evs = a.drain();
    for (const ev of evs) {
      if (ev.type === "text.start" || ev.type === "text.delta") {
        expect((ev as { turnId?: string }).turnId).toBe("t99");
      }
    }
  });
});

describe("textStart / textDelta / textEnd shape", () => {
  it("textStart emits text.start with correct fields", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.textStart("s1", "m1", { role: "assistant" });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "text.start");
    expect(ev).toMatchObject({ type: "text.start", id: "s1", messageId: "m1", role: "assistant" });
  });

  it("textEnd emits text.end with correct fields", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.textEnd("s1", "m1");
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "text.end");
    expect(ev).toMatchObject({ type: "text.end", id: "s1", messageId: "m1" });
  });

  it("seq increments monotonically for textStart/textDelta/textEnd", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    const seq0 = a.drain().length; // seq drained but we reset — open fresh
    const a2 = new StreamAssembler();
    a2.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a2.textStart("s1", "m1");
    a2.textDelta("s1", "m1", "hi");
    a2.textEnd("s1", "m1");
    const evs = a2.drain();
    const seqs = evs.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // strictly increasing
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
  });

  it("textStart/textEnd carry providerMetadata when supplied (#118)", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    const pm = AgProviderMeta.parse({ google: { thoughtSignature: "sig" } });
    a.textStart("x1", "m1", { providerMetadata: pm });
    a.textEnd("x1", "m1", { providerMetadata: pm });
    const evs = a.drain();
    // Cast: `providerMetadata` is not a base-envelope field carried by every AgEvent
    // arm (unlike turnId/messageId), so it needs narrowing for property access —
    // same established pattern as the other cross-arm assertions in this file.
    expect((evs.find((e) => e.type === "text.start") as { providerMetadata?: AgProviderMeta } | undefined)?.providerMetadata).toEqual(pm);
    expect((evs.find((e) => e.type === "text.end") as { providerMetadata?: AgProviderMeta } | undefined)?.providerMetadata).toEqual(pm);
  });
});

describe("reasoningStart / reasoningDelta / reasoningEnd / reasoningOpaque shape", () => {
  it("reasoningStart emits reasoning.start with id + messageId + optional mode", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.reasoningStart("r1", "m1", { mode: "summarized" });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "reasoning.start");
    expect(ev).toMatchObject({ type: "reasoning.start", id: "r1", messageId: "m1", mode: "summarized" });
  });

  it("reasoningEnd emits reasoning.end with optional provider", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.reasoningEnd("r1", "m1", { provider: "anthropic" });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "reasoning.end");
    expect(ev).toMatchObject({ type: "reasoning.end", id: "r1", messageId: "m1", provider: "anthropic" });
  });

  it("reasoningOpaque emits reasoning.opaque with kind + value", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.reasoningOpaque("r1", "m1", { kind: "signature", value: "abc123" });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "reasoning.opaque");
    expect(ev).toMatchObject({ type: "reasoning.opaque", id: "r1", messageId: "m1", kind: "signature", value: "abc123" });
  });
});

describe("toolStart / toolArgsDelta / toolArgsAssembled / toolDone shape", () => {
  it("toolStart emits tool.start with required fields", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.toolStart({ toolCallId: "tc1", name: "search", messageId: "m1" });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "tool.start");
    expect(ev).toMatchObject({ type: "tool.start", toolCallId: "tc1", name: "search", messageId: "m1" });
  });

  it("toolStart backfills turnId from messageId", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t77", threadId: "th1" });
    a.drain();
    a.toolStart({ toolCallId: "tc1", name: "search", messageId: "m1" });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "tool.start");
    expect((ev as { turnId?: string })?.turnId).toBe("t77");
  });

  it("toolArgsDelta emits tool.args.delta with correct delta", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.toolArgsDelta("tc1", '{"q":');
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "tool.args.delta");
    expect(ev).toMatchObject({ type: "tool.args.delta", toolCallId: "tc1", delta: '{"q":' });
  });

  it("toolArgsAssembled emits tool.args.assembled with input", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.toolArgsAssembled("tc1", { q: "hello" });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "tool.args.assembled");
    expect(ev).toMatchObject({ type: "tool.args.assembled", toolCallId: "tc1", input: { q: "hello" } });
  });

  it("toolArgsAssembled accepts optional signature", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.toolArgsAssembled("tc1", { q: 1 }, { signature: "sig123" });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "tool.args.assembled");
    expect(ev).toMatchObject({ signature: "sig123" });
  });

  it("toolDone emits tool.done with content array", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.toolDone({
      toolCallId: "tc1",
      content: [{ type: "text", text: "result" }],
      messageId: "m1",
    });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "tool.done");
    expect(ev).toMatchObject({ type: "tool.done", toolCallId: "tc1", content: [{ type: "text", text: "result" }] });
  });

  it("toolDone with structuredContent includes it", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.toolDone({ toolCallId: "tc1", content: [], messageId: "m1", structuredContent: { answer: 42 } });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "tool.done");
    expect(ev).toMatchObject({ structuredContent: { answer: 42 } });
  });
});

describe("contentBlock / providerRaw / emitExt shape", () => {
  it("contentBlock emits content.block with block and optional transient", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.contentBlock("m1", { type: "text", text: "hello" });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "content.block");
    expect(ev).toMatchObject({ type: "content.block", block: { type: "text", text: "hello" }, messageId: "m1" });
  });

  it("contentBlock with transient:true passes through", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.contentBlock("m1", { type: "text", text: "temp" }, { transient: true });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "content.block");
    expect(ev).toMatchObject({ transient: true });
  });

  it("contentBlock with messageId=undefined still emits turnId from #lastTurn", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.contentBlock(undefined, { type: "text", text: "hi" });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "content.block");
    expect((ev as { turnId?: string })?.turnId).toBe("t1");
  });

  it("providerRaw emits content.block with provider-raw block", () => {
    const a = new StreamAssembler();
    a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    a.drain();
    a.providerRaw("m1", "anthropic", { raw_key: "val" });
    const evs = a.drain();
    const ev = evs.find((e) => e.type === "content.block");
    expect(ev).toMatchObject({ type: "content.block", block: { type: "provider-raw", vendor: "anthropic", raw: { raw_key: "val" } } });
  });

  it("emitExt emits an ext.<vendor>.<key> event", () => {
    const a = new StreamAssembler();
    a.emitExt("myvendor", "my_event", { foo: "bar" });
    const evs = a.drain();
    expect(evs).toHaveLength(1);
    expect(evs[0]?.type).toBe("ext.myvendor.my_event");
    expect((evs[0] as { foo?: string })?.foo).toBe("bar");
  });
});

describe("emitExt reserved-key guard", () => {
  it("drops reserved envelope keys from an object payload, keeps vendor keys", () => {
    const a = new StreamAssembler();
    a.emitExt("openai", "unparsed", {
      seq: 999,
      type: "spoofed",
      turnId: "evil",
      responseId: "resp_1",
      payload: { ok: true },
    });
    const evs = a.drain();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "ext.openai.unparsed", responseId: "resp_1" }); // type engine-owned (not "spoofed"); vendor key kept
    expect(evs[0]?.seq).not.toBe(999); // engine-assigned
    expect(evs[0]).not.toHaveProperty("turnId"); // reserved, dropped
  });
});

describe("StreamAssembler.emit — base primitive for standalone events", () => {
  it("stamps a monotonic seq on a seqless standalone event", () => {
    const a = new StreamAssembler();
    a.emit({ type: "state.delta", patch: { foo: 1 } });
    const evs = a.drain();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "state.delta", seq: 0, patch: { foo: 1 } });
  });

  it("keeps seq monotonic across emit() and lifecycle methods interleaved", () => {
    const a = new StreamAssembler();
    a.openTurn("turn_1", "thread_1"); // turn.start — seq 0
    a.emit({ type: "turn.abort", reason: "interrupted" }); // seq 1
    a.emit({ type: "handoff", kind: "transfer", toAgentName: "other" }); // seq 2
    const evs = a.drain();
    expect(evs.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "turn.abort", "handoff"]);
  });

  it("accepts every standalone ADK event type (compile + runtime)", () => {
    const a = new StreamAssembler();
    a.emit({ type: "source", sourceId: "s0", source: { url: "https://x" } });
    a.emit({ type: "display.required", provider: "google", html: "<x/>" });
    a.emit({ type: "handoff", kind: "escalate" });
    a.emit({ type: "hitl.ask", askId: "a0", kind: "approval", toolCallId: "t0" });
    a.emit({ type: "state.delta", patch: {} });
    a.emit({ type: "prompt.blocked", reason: "safety" });
    a.emit({ type: "turn.abort", reason: "interrupted" });
    expect(a.drain()).toHaveLength(7);
  });

  it("emit() backfills turnId from the owner chain (INV-OWNER; audit B10)", () => {
    const a = new StreamAssembler();
    a.openTurn("t1", "th1");
    a.emit({ type: "text.start", id: "x1" }); // raw emit, no owner ids
    const evs = a.drain();
    const textStart = evs.find((e) => e.type === "text.start");
    expect(textStart?.turnId).toBe("t1");
  });
});
