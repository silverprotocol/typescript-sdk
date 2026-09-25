/**
 * Fixture suite for `@silverprotocol/vercel-ai`.
 *
 * Every native sequence below was CAPTURED from real ai@7.0.26 fullStream
 * output (keyless MockLanguageModelV3 runs, 2026-07-20 — generator preserved
 * in the private workspace validation kit). They are pasted verbatim except
 * that the bulky derived `performance` bag on finish-step is trimmed
 * everywhere but F1 (kept there to prove extra-field tolerance).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgEvent, Reducer, StreamAssembler, reduce as foldBatch } from "@silverprotocol/core";
import { VERCEL_HOST_ERROR, createVercelNormalizer } from "./index.js";

function run(parts: unknown[]): AgEvent[] {
  const n = createVercelNormalizer({ invokeId: "vercel" });
  const out: AgEvent[] = [];
  for (const p of parts) out.push(...n.push(p));
  out.push(...n.flush());
  return out;
}

function types(evs: AgEvent[]): string[] {
  return evs.map((e) => (e as { type: string }).type);
}

function expectAllParse(evs: AgEvent[]): void {
  for (const ev of evs) expect(() => AgEvent.parse(ev)).not.toThrow();
}

function reduce(evs: AgEvent[]) {
  const r = new Reducer();
  for (const ev of evs) r.push(ev);
  return r.result();
}

const USAGE = {
  inputTokens: 5,
  inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 },
  outputTokens: 7,
  outputTokenDetails: { textTokens: 4, reasoningTokens: 3 },
  totalTokens: 12,
};
const RESPONSE_S1 = { id: "resp-s1", timestamp: "1970-01-01T00:00:00.000Z", modelId: "mock-model" };

describe("F1 — single-step text turn (captured text-single-step)", () => {
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "Hello " },
    { type: "text-delta", id: "t1", text: "world" },
    { type: "text-end", id: "t1" },
    {
      type: "finish-step",
      finishReason: "stop",
      rawFinishReason: "stop",
      usage: USAGE,
      // real capture carries a large derived `performance` bag — kept here to
      // prove tolerance of unmapped extra fields on a known arm.
      performance: { stepTimeMs: 9.7, toolExecutionMs: {}, responseTimeMs: 7.1 },
      response: RESPONSE_S1,
    },
    { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: USAGE },
  ];

  it("emits the full lifecycle in order and closes turn.done{stop}", () => {
    const out = run(parts);
    expect(types(out)).toEqual([
      "turn.start",
      "step.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.delta",
      "text.end",
      "message.metadata",
      "message.end",
      "step.done",
      "turn.done",
    ]);
    expectAllParse(out);
  });

  it("message.metadata carries the step's response identity (only available at finish-step)", () => {
    const out = run(parts);
    const meta = out.find((e) => e.type === "message.metadata") as {
      metadata: Record<string, unknown>;
    };
    expect(meta.metadata["responseId"]).toBe("resp-s1");
    expect(meta.metadata["model"]).toBe("mock-model");
  });

  it("per-step usage rides message.end; turn.done carries totalUsage verbatim-mapped, no cumulative flag", () => {
    const out = run(parts);
    const msgEnd = out.find((e) => e.type === "message.end") as { usage?: Record<string, unknown> };
    expect(msgEnd.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      reasoningTokens: 3,
    });
    const done = out.find((e) => e.type === "turn.done") as {
      finishReason: string;
      usage?: Record<string, unknown>;
    };
    expect(done.finishReason).toBe("stop");
    expect(done.usage?.["totalTokens"]).toBe(12);
    expect(done.usage?.["cumulative"]).toBeUndefined();
  });

  it("reduces to one turn with one assistant message reading 'Hello world'", () => {
    const { messages, turns } = reduce(run(parts));
    expect(turns).toHaveLength(1);
    expect(messages).toHaveLength(1);
    const text = messages[0]!.content.find((b) => b.type === "text") as { text: string };
    expect(text.text).toBe("Hello world");
  });
});

describe("F2 — two-step tool run (captured tool-two-step)", () => {
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "tool-input-start", id: "call_1", toolName: "echo", dynamic: false },
    { type: "tool-input-delta", id: "call_1", delta: '{"text":' },
    { type: "tool-input-delta", id: "call_1", delta: '"hi"}' },
    { type: "tool-input-end", id: "call_1" },
    { type: "tool-call", toolCallId: "call_1", toolName: "echo", input: { text: "hi" } },
    {
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "echo",
      input: { text: "hi" },
      output: { result: "echo: hi" },
      dynamic: false,
    },
    {
      type: "finish-step",
      finishReason: "tool-calls",
      rawFinishReason: "tool-calls",
      usage: USAGE,
      response: RESPONSE_S1,
    },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "echo: hi" },
    { type: "text-end", id: "t1" },
    {
      type: "finish-step",
      finishReason: "stop",
      rawFinishReason: "stop",
      usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13, inputTokenDetails: {}, outputTokenDetails: {} },
      response: { id: "resp-s2", timestamp: "1970-01-01T00:00:00.000Z", modelId: "mock-model" },
    },
    { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: USAGE },
  ];

  it("normalizes the full tool lifecycle and two step-messages under ONE turn", () => {
    const out = run(parts);
    expect(types(out)).toEqual([
      "turn.start",
      "step.start",
      "message.start",
      "tool.start",
      "tool.args.delta",
      "tool.args.delta",
      "tool.args.assembled",
      "tool.done",
      "message.metadata",
      "message.end",
      "step.done",
      "step.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.metadata",
      "message.end",
      "step.done",
      "turn.done",
    ]);
    expectAllParse(out);
  });

  it("tool-input-end is a no-op; assembled input is the parsed object; tool.done carries structuredContent", () => {
    const out = run(parts);
    const assembled = out.find((e) => e.type === "tool.args.assembled") as { input: unknown };
    expect(assembled.input).toEqual({ text: "hi" });
    const done = out.find((e) => e.type === "tool.done") as {
      outcome: string;
      structuredContent?: unknown;
    };
    expect(done.outcome).toBe("ok");
    expect(done.structuredContent).toEqual({ result: "echo: hi" });
  });

  it("the two messages carry DISTINCT synthetic ids and distinct responseIds in metadata", () => {
    const out = run(parts);
    const starts = out.filter((e) => e.type === "message.start") as { id: string }[];
    expect(starts).toHaveLength(2);
    expect(starts[0]!.id).not.toBe(starts[1]!.id);
    const metas = out.filter((e) => e.type === "message.metadata") as {
      metadata: Record<string, unknown>;
    }[];
    expect(metas.map((m) => m.metadata["responseId"])).toEqual(["resp-s1", "resp-s2"]);
  });

  it("reduces to one turn, two messages, with tool-call + tool-result blocks", () => {
    const { messages, turns } = reduce(run(parts));
    expect(turns).toHaveLength(1);
    expect(messages).toHaveLength(2);
    const blocks = messages.flatMap((m) => m.content);
    expect(blocks.some((b) => b.type === "tool-call")).toBe(true);
    expect(blocks.some((b) => b.type === "tool-result")).toBe(true);
  });
});

describe("reasoning lifecycle (captured reasoning-then-text)", () => {
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "reasoning-start", id: "r1" },
    { type: "reasoning-delta", id: "r1", text: "thinking..." },
    { type: "reasoning-end", id: "r1" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "answer" },
    { type: "text-end", id: "t1" },
    { type: "finish-step", finishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
    { type: "finish", finishReason: "stop", totalUsage: USAGE },
  ];

  it("maps reasoning-* (which carry `text`, not `delta`) to reasoning.start/delta/end", () => {
    const out = run(parts);
    expect(types(out)).toContain("reasoning.start");
    expect(types(out)).toContain("reasoning.delta");
    expect(types(out)).toContain("reasoning.end");
    expectAllParse(out);
  });

  it("does NOT emit reasoning.opaque when reasoning-end carries no providerMetadata", () => {
    const out = run(parts);
    expect(types(out)).not.toContain("reasoning.opaque");
  });
});

describe("encrypted-reasoning carry (captured echo-gpt56 @ai 7.0.34 reasoning-end shape — first vercel census triage, 2026-07-25)", () => {
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    {
      type: "reasoning-start",
      id: "rs_abc:0",
      providerMetadata: {
        openai: { itemId: "rs_abc", reasoningEncryptedContent: "gAAAA-early-snapshot" },
      },
    },
    { type: "reasoning-delta", id: "rs_abc:0", text: "thinking..." },
    {
      type: "reasoning-end",
      id: "rs_abc:0",
      providerMetadata: {
        openai: { itemId: "rs_abc", reasoningEncryptedContent: "gAAAA-final-blob" },
      },
    },
    { type: "finish-step", finishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
    { type: "finish", finishReason: "stop", totalUsage: USAGE },
  ];

  it("carries reasoning-end's providerMetadata.<provider>.reasoningEncryptedContent as reasoning.opaque {kind:'encrypted'} (the claude signature / adk thoughtSignature analog)", () => {
    const out = run(parts);
    const opaque = out.find((e) => e.type === "reasoning.opaque") as
      | { id: string; kind: string; value: string; provider?: string }
      | undefined;
    expect(opaque).toBeDefined();
    expect(opaque).toMatchObject({
      id: "rs_abc:0",
      kind: "encrypted",
      value: "gAAAA-final-blob", // the END blob (final/authoritative), not the start snapshot
      provider: "openai",
    });
    // exactly one carry — the reasoning-start snapshot is not separately emitted
    expect(out.filter((e) => e.type === "reasoning.opaque")).toHaveLength(1);
    // ordering: opaque follows reasoning.end, like the claude facet's sequence
    const typesArr = types(out);
    expect(typesArr.indexOf("reasoning.opaque")).toBeGreaterThan(typesArr.indexOf("reasoning.end"));
    expectAllParse(out);
  });
});

describe("empty text-delta metadata carry (synthetic ai>=7.0.42 wire — changeset 6de2ec1: the empty-text guard now passes chunks whose providerMetadata is their whole payload)", () => {
  const META = { openai: { itemId: "msg_001", annotationBoundary: true } };

  // 7.0.42+-shaped: the empty delta exists ONLY to convey its metadata bag.
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "Hello " },
    { type: "text-delta", id: "t1", text: "", providerMetadata: META },
    { type: "text-delta", id: "t1", text: "world" },
    { type: "text-end", id: "t1" },
    { type: "finish-step", finishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
    { type: "finish", finishReason: "stop", totalUsage: USAGE },
  ];

  it("emits exactly one text.delta per wire chunk (no spurious events) and carries the bag on the empty one", () => {
    const out = run(parts);
    expect(types(out)).toEqual([
      "turn.start",
      "step.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.delta",
      "text.delta",
      "text.end",
      "message.metadata",
      "message.end",
      "step.done",
      "turn.done",
    ]);
    const deltas = out.filter((e) => e.type === "text.delta") as {
      delta: string;
      providerMetadata?: unknown;
    }[];
    expect(deltas.map((d) => d.delta)).toEqual(["Hello ", "", "world"]);
    expect(deltas[1]!.providerMetadata).toEqual(META);
    // the carry is scoped to the empty chunk — its neighbors stay bare
    expect("providerMetadata" in deltas[0]!).toBe(false);
    expect("providerMetadata" in deltas[2]!).toBe(false);
    expectAllParse(out);
  });

  it("folds clean through the Reducer: text uncorrupted, bag merged onto the sealed block, no park", () => {
    const out = run(parts);
    const r = new Reducer();
    for (const e of out) r.push(e);
    expect(r.needsResync).toBe(false);
    const { messages, turns } = r.result();
    expect(turns).toHaveLength(1);
    expect(messages).toHaveLength(1);
    const text = messages[0]!.content.find((b) => b.type === "text") as {
      text: string;
      providerMetadata?: unknown;
    };
    expect(text.text).toBe("Hello world");
    expect(text.providerMetadata).toEqual(META);
  });

  it("a plain empty delta WITHOUT metadata keeps the pre-7.0.42 mapping (bare text.delta, fold clean)", () => {
    const out = run([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "" },
      { type: "text-delta", id: "t1", text: "ok" },
      { type: "text-end", id: "t1" },
      { type: "finish-step", finishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
      { type: "finish", finishReason: "stop", totalUsage: USAGE },
    ]);
    const deltas = out.filter((e) => e.type === "text.delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toEqual({
      type: "text.delta",
      seq: 4,
      id: "t1",
      messageId: "msg_turn_vercel_1_s1",
      delta: "",
      turnId: "turn_vercel_1",
    });
    const { messages } = reduce(out);
    const text = messages[0]!.content.find((b) => b.type === "text") as { text: string };
    expect(text.text).toBe("ok");
    expectAllParse(out);
  });

  it("negative control: a 7.0.41-shaped stream (non-empty deltas only, bag on a NON-empty delta) normalizes byte-identically — no providerMetadata key anywhere", () => {
    // Non-empty deltas passed the old guard too, so a bag on one is a
    // pre-7.0.42-possible wire — its disposition (disclosed drop) must not move.
    const out = run([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "Hello ", providerMetadata: META },
      { type: "text-delta", id: "t1", text: "world" },
      { type: "text-end", id: "t1" },
      { type: "finish-step", finishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
      { type: "finish", finishReason: "stop", totalUsage: USAGE },
    ]);
    const deltas = out.filter((e) => e.type === "text.delta");
    expect(deltas).toEqual([
      {
        type: "text.delta",
        seq: 4,
        id: "t1",
        messageId: "msg_turn_vercel_1_s1",
        delta: "Hello ",
        turnId: "turn_vercel_1",
      },
      {
        type: "text.delta",
        seq: 5,
        id: "t1",
        messageId: "msg_turn_vercel_1_s1",
        delta: "world",
        turnId: "turn_vercel_1",
      },
    ]);
    expectAllParse(out);
  });

  it("a hostile non-object bag on an empty delta degrades to the bare pre-7.0.42 mapping, never throws", () => {
    const n = createVercelNormalizer();
    const out = [
      ...n.push({ type: "start" }),
      ...n.push({ type: "start-step", request: {}, warnings: [] }),
      ...n.push({ type: "text-start", id: "t1" }),
      ...n.push({ type: "text-delta", id: "t1", text: "", providerMetadata: "not-a-bag" }),
      ...n.flush(),
    ];
    const delta = out.find((e) => e.type === "text.delta");
    expect(delta).toBeDefined();
    expect("providerMetadata" in delta!).toBe(false);
    expectAllParse(out);
  });
});

describe("text-start/text-end providerMetadata carry (captured echo-gpt56/gpt6astra/gpt6luna/gpt6sol shape: OpenAI `phase` on both parts)", () => {
  // Verbatim shape of corpus/echo-gpt6sol/vercel.native.json's text parts.
  const FINAL = { openai: { itemId: "msg_final", phase: "final_answer" } };
  const COMMENTARY = { openai: { itemId: "msg_comm", phase: "commentary" } };

  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1", providerMetadata: COMMENTARY },
    { type: "text-delta", id: "t1", text: "Checking the tool." },
    { type: "text-end", id: "t1", providerMetadata: COMMENTARY },
    { type: "text-start", id: "t2", providerMetadata: FINAL },
    { type: "text-delta", id: "t2", text: "Done." },
    { type: "text-end", id: "t2", providerMetadata: FINAL },
    { type: "finish-step", finishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
    { type: "finish", finishReason: "stop", totalUsage: USAGE },
  ];

  it("carries each part's bag verbatim on text.start AND text.end (phase known before the first delta)", () => {
    const out = run(parts);
    const starts = out.filter((e) => e.type === "text.start") as { id: string; providerMetadata?: unknown }[];
    const ends = out.filter((e) => e.type === "text.end") as { id: string; providerMetadata?: unknown }[];
    expect(starts.map((e) => [e.id, e.providerMetadata])).toEqual([
      ["t1", COMMENTARY],
      ["t2", FINAL],
    ]);
    expect(ends.map((e) => [e.id, e.providerMetadata])).toEqual([
      ["t1", COMMENTARY],
      ["t2", FINAL],
    ]);
    // the deltas stay bare — the carry is on the block boundaries only
    for (const d of out.filter((e) => e.type === "text.delta")) expect("providerMetadata" in d).toBe(false);
    expectAllParse(out);
  });

  it("folds clean: commentary and final answer stay SEPARATE text blocks, each with its own phase", () => {
    const r = new Reducer();
    for (const e of run(parts)) r.push(e);
    expect(r.needsResync).toBe(false);
    const { messages } = r.result();
    expect(messages).toHaveLength(1);
    const blocks = messages[0]!.content.filter((b) => b.type === "text") as {
      text: string;
      providerMetadata?: unknown;
    }[];
    expect(blocks.map((b) => [b.text, b.providerMetadata])).toEqual([
      ["Checking the tool.", COMMENTARY],
      ["Done.", FINAL],
    ]);
  });

  it("negative control: bag-less text parts normalize byte-identically — no providerMetadata key on text.start/text.end", () => {
    const out = run([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "ok" },
      { type: "text-end", id: "t1" },
      { type: "finish-step", finishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
      { type: "finish", finishReason: "stop", totalUsage: USAGE },
    ]);
    expect(out.filter((e) => e.type === "text.start" || e.type === "text.end")).toEqual([
      { type: "text.start", seq: 3, id: "t1", messageId: "msg_turn_vercel_1_s1", turnId: "turn_vercel_1" },
      { type: "text.end", seq: 5, id: "t1", messageId: "msg_turn_vercel_1_s1", turnId: "turn_vercel_1" },
    ]);
    expectAllParse(out);
  });

  it("a hostile bag on text-start/text-end never throws: a non-object is skipped, a circular bag keeps everything but its repeated node", () => {
    const circular: { [k: string]: unknown } = { openai: {} };
    (circular["openai"] as { [k: string]: unknown })["self"] = circular;
    const n = createVercelNormalizer();
    const out = [
      ...n.push({ type: "start" }),
      ...n.push({ type: "start-step", request: {}, warnings: [] }),
      ...n.push({ type: "text-start", id: "t1", providerMetadata: "not-a-bag" }),
      ...n.push({ type: "text-delta", id: "t1", text: "ok" }),
      ...n.push({ type: "text-end", id: "t1", providerMetadata: circular }),
      ...n.flush(),
    ];
    // A non-object bag has nothing to carry.
    expect("providerMetadata" in (out.find((x) => x.type === "text.start") ?? {})).toBe(false);
    // A circular bag degrades per node (core toJsonValueSafe): the cycle becomes
    // "[Circular]" at the repeated node and the rest of the bag rides. Before the json-safe switch it collapsed to
    // "[object Object]" and was dropped whole.
    expect((out.find((x) => x.type === "text.end") as { providerMetadata?: unknown }).providerMetadata).toEqual({
      openai: { self: "[Circular]" },
    });
    expectAllParse(out);
  });
});

describe("error arm A — in-band error, provider still finishes (captured error-midstream-finish)", () => {
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "partial" },
    { type: "error", error: "provider hiccup" },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", totalUsage: USAGE },
  ];

  it("emits a non-terminal error advisory and still closes turn.done", () => {
    const out = run(parts);
    const err = out.find((e) => e.type === "error") as { message: string };
    expect(err.message).toBe("provider hiccup");
    expect(types(out)).toContain("turn.done");
    expect(types(out)).not.toContain("turn.error");
    expectAllParse(out);
  });
});

describe("error arm A2 — SDK-synthesized finish{error} (captured error-then-eof)", () => {
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "partial" },
    { type: "error", error: "mid-flight failure" },
    { type: "finish-step", finishReason: "error", usage: {}, response: RESPONSE_S1 },
    { type: "finish", finishReason: "error", totalUsage: {} },
  ];

  it("routes finishReason 'error' to turn.error carrying the stashed message", () => {
    const out = run(parts);
    const terminal = out.find((e) => e.type === "turn.error") as { message: string };
    expect(terminal.message).toBe("mid-flight failure");
    expect(types(out)).not.toContain("turn.done");
    // the open text stream + message are sealed BEFORE the terminal
    expect(types(out).indexOf("message.end")).toBeLessThan(types(out).indexOf("turn.error"));
    expectAllParse(out);
  });
});

describe("error arm B — error then EOF, no finish at all (captured dostream-reject)", () => {
  const parts = [{ type: "start" }, { type: "error", error: "connect ECONNREFUSED" }];

  it("flush() self-seals the turn as turn.error with the stashed message", () => {
    const out = run(parts);
    expect(types(out)).toEqual(["turn.start", "error", "turn.error"]);
    const terminal = out.find((e) => e.type === "turn.error") as { message: string };
    expect(terminal.message).toBe("connect ECONNREFUSED");
    expectAllParse(out);
  });
});

describe("error arm C — transport throw, host sentinel (captured transport-throw)", () => {
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "par" },
    { type: VERCEL_HOST_ERROR, message: "Error: socket reset" },
  ];

  it("closes open text + message, then turn.error — no dangling state for flush", () => {
    const out = run(parts);
    const t = types(out);
    expect(t).toContain("text.end");
    expect(t.indexOf("message.end")).toBeLessThan(t.indexOf("turn.error"));
    expect(t.filter((x) => x === "turn.error")).toHaveLength(1);
    expect(t).not.toContain("turn.abort"); // flush must not double-close
    expectAllParse(out);
  });
});

// ─── StreamProviderError carry (ai>=7.0.80 wraps provider error frames) ──────

/**
 * Shape-faithful stand-in for ai>=7.0.80's `StreamProviderError` — `ai` is an
 * optional peer this package never imports (not even as a devDependency), so
 * the fixture mirrors the real class's constructor field-for-field: `name`
 * `AI_StreamProviderError` (AISDKError sets it as an OWN prop), `cause`, and
 * own enumerable `type` / `code` / `statusCode` / `isRetryable` / `data` (the
 * raw provider frame). The real class's symbol-keyed marker is JSON-invisible
 * and irrelevant to the facet's structural read, so it is omitted.
 */
class FakeStreamProviderError extends Error {
  readonly type?: string;
  readonly code?: string | number;
  readonly statusCode?: number;
  readonly isRetryable: boolean;
  readonly data?: unknown;
  constructor(fields: {
    message: string;
    type?: string;
    code?: string | number;
    statusCode?: number;
    isRetryable: boolean;
    data?: unknown;
    cause?: unknown;
  }) {
    super(fields.message);
    this.name = "AI_StreamProviderError";
    this.cause = fields.cause;
    this.type = fields.type;
    this.code = fields.code;
    this.statusCode = fields.statusCode;
    this.isRetryable = fields.isRetryable;
    this.data = fields.data;
  }
}

/** Raw OpenAI Responses `error` SSE frame as @ai-sdk/openai 4.0.56 hands it to
 *  the SDK (rides `StreamProviderError.data` verbatim). */
const OPENAI_ERROR_FRAME = {
  type: "error",
  code: "rate_limit_exceeded",
  message: "Rate limit reached for gpt-4o-mini",
  param: null,
  sequence_number: 3,
};

const RATE_LIMIT = () =>
  new FakeStreamProviderError({
    message: "Rate limit reached for gpt-4o-mini",
    type: "error", // the SSE envelope name is what @ai-sdk/openai puts here on the real wire
    code: "rate_limit_exceeded",
    statusCode: 429,
    isRetryable: true, // SDK-inferred from 429 when the frame omits it
    data: OPENAI_ERROR_FRAME,
  });

const STEP = [{ type: "start" }, { type: "start-step", request: {}, warnings: [] }];

describe("StreamProviderError carry — arm A: error part, provider still finishes", () => {
  it("error event carries code (provider code) + retriable; message = Error.message; turn.done unchanged", () => {
    const out = run([
      ...STEP,
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "partial" },
      { type: "error", error: RATE_LIMIT() },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop", totalUsage: USAGE },
    ]);
    const err = out.find((e) => e.type === "error");
    expect(err).toStrictEqual({
      type: "error",
      seq: 5,
      message: "Rate limit reached for gpt-4o-mini",
      code: "rate_limit_exceeded",
      retriable: true,
      turnId: "turn_vercel_1",
    });
    const done = out.find((e) => e.type === "turn.done");
    expect(done).toBeDefined();
    expect("code" in done!).toBe(false);
    expect("retriable" in done!).toBe(false);
    expect(types(out)).not.toContain("turn.error");
    expectAllParse(out);
  });

  it("does NOT fall back to `type` when `code` is absent (the wire's `type` is the SSE envelope name); numeric codes stringify", () => {
    const typeOnly = run([
      ...STEP,
      {
        type: "error",
        error: new FakeStreamProviderError({
          message: "overloaded",
          type: "error", // what @ai-sdk/openai stamps: the SSE event name, not a classification
          statusCode: 503,
          isRetryable: true,
        }),
      },
      { type: "finish", finishReason: "stop", totalUsage: USAGE },
    ]);
    const a = typeOnly.find((e) => e.type === "error") as { code?: string; retriable?: boolean };
    expect("code" in a).toBe(false);
    expect(a.retriable).toBe(true);

    const numeric = run([
      ...STEP,
      {
        type: "error",
        error: new FakeStreamProviderError({ message: "bad request", code: 400, isRetryable: false }),
      },
      { type: "finish", finishReason: "stop", totalUsage: USAGE },
    ]);
    const b = numeric.find((e) => e.type === "error") as { code?: string; retriable?: boolean };
    expect(b.code).toBe("400");
    expect(b.retriable).toBe(false); // an asserted `false` is carried, not dropped
    expectAllParse([...typeOnly, ...numeric]);
  });
});

describe("StreamProviderError carry — arm A2: SDK-synthesized finish{error}", () => {
  it("turn.error carries the stashed message + code + retriable", () => {
    const out = run([
      ...STEP,
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "partial" },
      { type: "error", error: RATE_LIMIT() },
      { type: "finish-step", finishReason: "error", usage: {}, response: RESPONSE_S1 },
      { type: "finish", finishReason: "error", totalUsage: {} },
    ]);
    const terminal = out.find((e) => e.type === "turn.error");
    expect(terminal).toStrictEqual({
      type: "turn.error",
      seq: 10,
      turnId: "turn_vercel_1",
      message: "Rate limit reached for gpt-4o-mini",
      code: "rate_limit_exceeded",
      retriable: true,
    });
    expect(types(out)).not.toContain("turn.done");
    expectAllParse(out);
  });
});

// ─── toolChoice enforcement (ai>=7.0.94, changeset 36b3364) ──────────────────

/**
 * Shape-faithful stand-in for ai>=7.0.94's `ToolChoiceViolationError` — `ai` is
 * an optional peer this package never imports (not even as a devDependency), so
 * the fixture mirrors the real class field-for-field: it extends `AISDKError`,
 * which sets ONLY `name` (`AI_ToolChoiceViolationError`) and `cause` as own
 * props, plus the subclass's own `toolChoice` / `finishReason` / `provider` /
 * `modelId` / `content`. Note what is NOT there: no `code`, no `isRetryable` —
 * this is an SDK-side enforcement error, not a wrapped provider frame — so
 * `errFields` projects it to `{message}` alone (asserted below). The real
 * class's symbol-keyed marker is JSON-invisible and irrelevant to the facet's
 * structural read, so it is omitted. Default messages are copied verbatim from
 * the ai@7.0.100 constructor (unchanged at ai@7.0.111).
 */
class FakeToolChoiceViolationError extends Error {
  readonly toolChoice: { type: "required" } | { type: "tool"; toolName: string };
  readonly finishReason: string;
  readonly provider: string;
  readonly modelId: string;
  readonly content: unknown[];
  constructor(fields: {
    toolChoice: { type: "required" } | { type: "tool"; toolName: string };
    finishReason: string;
    provider: string;
    modelId: string;
    content: unknown[];
  }) {
    super(
      fields.toolChoice.type === "required"
        ? "Model response did not contain a tool call even though tool choice was required."
        : `Model response did not contain a call to the required tool '${fields.toolChoice.toolName}'.`,
    );
    this.name = "AI_ToolChoiceViolationError";
    this.toolChoice = fields.toolChoice;
    this.finishReason = fields.finishReason;
    this.provider = fields.provider;
    this.modelId = fields.modelId;
    this.content = fields.content;
  }
}

const VIOLATION_REQUIRED_MESSAGE =
  "Model response did not contain a tool call even though tool choice was required.";
const VIOLATION_TOOL_MESSAGE =
  "Model response did not contain a call to the required tool 'lookup'.";

/**
 * FIXTURE-ONLY, BY CONSTRUCTION — do not hunt for a live cassette. Our e2e
 * capture config never sets `toolChoice`: the agent leaves `prepareToolChoice`
 * at its `'auto'` default, and ai only enforces `required` / `{type:'tool'}`,
 * so this producer of the `error` part cannot fire on any captured run. That
 * holds for BOTH shapes below (A, and B in its historical and current forms).
 * The wire below is transcribed from the ai@7.0.100 runtime rather than a
 * capture, and re-read against ai@7.0.111:
 *  - the violation check runs immediately after the model's terminal chunk
 *    (`model-call-end`) and enqueues `{type:'error', error: ToolChoiceViolationError}`;
 *  - the step transform turns that `error` into `stepFinishReason = 'error'`
 *    while KEEPING the model's own `rawFinishReason` — hence the
 *    `finishReason:'error'` + `rawFinishReason:'stop'|'tool-calls'` pairing;
 *  - `finish` is built as `{finishReason: stepFinishReason, rawFinishReason,
 *    totalUsage: combinedUsage}`, and `combinedUsage` accrues the step's real
 *    usage regardless of the violation — the tokens were burned.
 * ai@7.0.108 (ccf98e7) now runs the violation check BEFORE it enqueues the
 * internal `model-call-end`, and stamps that chunk's finishReason `'error'`.
 * The `error` part still follows it. Shape A's fullStream bytes do not move:
 * the step transform already ended on `'error'`, and there is no tool to hold
 * back. Shape B's bytes do: see the two shape-B blocks.
 */
describe("toolChoice enforcement shape A — required/tool with NO qualifying tool call (ai>=7.0.94; fullStream unchanged by ai@7.0.108)", () => {
  const VIOLATION = () =>
    new FakeToolChoiceViolationError({
      toolChoice: { type: "required" },
      finishReason: "stop",
      provider: "openai.responses",
      modelId: "gpt-5-mini",
      content: [{ type: "text", text: "I'll just answer directly." }],
    });

  // Everything up to (but excluding) the terminal `finish` part.
  const HEAD = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "I'll just answer directly." },
    { type: "text-end", id: "t1" },
    { type: "error", error: VIOLATION() },
    {
      type: "finish-step",
      finishReason: "error", // overwritten by the error chunk…
      rawFinishReason: "stop", // …while the model's own raw reason survives
      usage: USAGE,
      response: RESPONSE_S1,
    },
  ];
  const parts = [
    ...HEAD,
    { type: "finish", finishReason: "error", rawFinishReason: "stop", totalUsage: USAGE },
  ];

  it("routes to the finish{error} branch: full ordered event list, advisory error before message.end", () => {
    const out = run(parts);
    expect(types(out)).toEqual([
      "turn.start",
      "step.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "error",
      "message.metadata",
      "message.end",
      "step.done",
      "turn.error",
    ]);
    expectAllParse(out);
  });

  it("the advisory is message-ONLY — ToolChoiceViolationError exposes no code/isRetryable", () => {
    const out = run(parts);
    expect(out.find((e) => e.type === "error")).toStrictEqual({
      type: "error",
      seq: 6,
      message: VIOLATION_REQUIRED_MESSAGE,
      turnId: "turn_vercel_1",
    });
  });

  it("MIRROR — turn.error forwards finish.totalUsage, mapped exactly as turn.done maps it", () => {
    const out = run(parts);
    expect(out.find((e) => e.type === "turn.error")).toStrictEqual({
      type: "turn.error",
      seq: 10,
      turnId: "turn_vercel_1",
      message: VIOLATION_REQUIRED_MESSAGE,
      usage: {
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        reasoningTokens: 3,
      },
    });
    // same mapper as the success close — identical bag off the identical bag
    const done = run([
      ...HEAD.slice(0, -1),
      { type: "finish-step", finishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
      { type: "finish", finishReason: "stop", totalUsage: USAGE },
    ]).find((e) => e.type === "turn.done") as { usage?: unknown };
    expect(done.usage).toStrictEqual(
      (out.find((e) => e.type === "turn.error") as { usage?: unknown }).usage,
    );
    // the per-step message.end bag is untouched by the carry
    const msgEnd = out.find((e) => e.type === "message.end") as { usage?: unknown };
    expect(msgEnd.usage).toStrictEqual(done.usage);
  });

  it("NEGATIVE CONTROL — totalUsage absent ⇒ NO usage key; output byte-identical to the pre-carry shape", () => {
    const bare = run([...HEAD, { type: "finish", finishReason: "error", rawFinishReason: "stop" }]);
    // every event before the terminal is untouched by the carry
    expect(bare.slice(0, -1)).toStrictEqual(run(parts).slice(0, -1));
    const terminal = bare.at(-1)!;
    expect(terminal).toStrictEqual({
      type: "turn.error",
      seq: 10,
      turnId: "turn_vercel_1",
      message: VIOLATION_REQUIRED_MESSAGE,
    });
    expect("usage" in terminal).toBe(false);
    expectAllParse(bare);
  });

  it("NEGATIVE CONTROL — an all-null totalUsage bag stays absent, never an empty object", () => {
    const nulled = run([
      ...HEAD,
      {
        type: "finish",
        finishReason: "error",
        rawFinishReason: "stop",
        // ai's createNullLanguageModelUsage(): every slot present-but-undefined
        totalUsage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          inputTokenDetails: {},
          outputTokenDetails: {},
        },
      },
    ]);
    const terminal = nulled.at(-1)!;
    expect("usage" in terminal).toBe(false);
    expect(terminal).toStrictEqual({
      type: "turn.error",
      seq: 10,
      turnId: "turn_vercel_1",
      message: VIOLATION_REQUIRED_MESSAGE,
    });
  });
});

describe("toolChoice enforcement shape B, HISTORICAL — {type:'tool'} satisfied by the WRONG tool (ai 7.0.94–7.0.107 only)", () => {
  const VIOLATION = () =>
    new FakeToolChoiceViolationError({
      toolChoice: { type: "tool", toolName: "lookup" },
      finishReason: "tool-calls",
      provider: "openai.responses",
      modelId: "gpt-5-mini",
      content: [{ type: "tool-call", toolCallId: "call_1", toolName: "echo" }],
    });

  /**
   * FIXTURE-ONLY (same reason as shape A — capture config never sets
   * toolChoice). HISTORICAL: this wire exists only on ai 7.0.94–7.0.107.
   * ai@7.0.108 (ccf98e7) stopped executing a violating tool call, so the
   * current runtime yields shape B' below instead. It is kept as a
   * regression fixture: a synthetic wire that still pins how the facet
   * handles a standalone advisory `error` on a turn that then succeeds.
   * Ordering transcribed from the ai@7.0.100 runtime:
   * `executeToolsFromStream` runs the step's tools inside its own
   * `model-call-end` transform and AWAITS them, so `tool-result` is enqueued
   * BEFORE the violation `error` reaches the step transform; `finish-step` is
   * only produced in that transform's flush, so it always trails both. The
   * wrong-tool call still executes and still counts as a client tool output, so
   * the loop is not finished and a SECOND step runs — here with `prepareStep`
   * having relaxed toolChoice back to `'auto'` (toolChoice is re-read per step),
   * which is why the run ends `finish{finishReason:'stop'}` and the facet takes
   * the finish arm's SUCCESS branch.
   */
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "tool-input-start", id: "call_1", toolName: "echo", dynamic: true },
    { type: "tool-input-delta", id: "call_1", delta: '{"text":"hi"}' },
    { type: "tool-input-end", id: "call_1" },
    { type: "tool-call", toolCallId: "call_1", toolName: "echo", input: { text: "hi" }, dynamic: true },
    {
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "echo",
      input: { text: "hi" },
      output: { result: "echo: hi" },
      dynamic: true,
    },
    { type: "error", error: VIOLATION() },
    {
      type: "finish-step",
      finishReason: "error",
      rawFinishReason: "tool_calls",
      usage: USAGE,
      response: RESPONSE_S1,
    },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "echo: hi" },
    { type: "text-end", id: "t1" },
    {
      type: "finish-step",
      finishReason: "stop",
      rawFinishReason: "stop",
      usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
      response: { id: "resp-s2", timestamp: "1970-01-01T00:00:00.000Z", modelId: "mock-model" },
    },
    {
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "stop",
      totalUsage: { inputTokens: 14, outputTokens: 11, totalTokens: 25 },
    },
  ];

  it("FULL ORDERED event list — a standalone `error` precedes message.end on a turn that then closes turn.done", () => {
    const out = run(parts);
    // The ordering IS the claim: on the 7.0.94–7.0.107 runtime this was the
    // first shape on this facet where an advisory `error` rides inside a step
    // that is followed by another step and a SUCCESSFUL turn close.
    expect(types(out)).toEqual([
      "turn.start",
      "step.start",
      "message.start",
      "tool.start",
      "tool.args.delta",
      "tool.args.assembled",
      "tool.done",
      "error",
      "message.metadata",
      "message.end",
      "step.done",
      "step.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.metadata",
      "message.end",
      "step.done",
      "turn.done",
    ]);
    expectAllParse(out);
  });

  it("the stashed error does NOT leak into the successful close (finish clears it)", () => {
    const out = run(parts);
    expect(types(out)).not.toContain("turn.error");
    const done = out.find((e) => e.type === "turn.done")!;
    expect(done).toStrictEqual({
      type: "turn.done",
      seq: 19,
      turnId: "turn_vercel_1",
      outcome: { type: "success" },
      finishReason: "stop",
      usage: { inputTokens: 14, outputTokens: 11, totalTokens: 25 },
    });
    expect("message" in done).toBe(false);
    expect("code" in done).toBe(false);
    expect("retriable" in done).toBe(false);
  });

  it("the violating step still seals normally: the wrong tool's result rides, step 1 keeps its own usage + raw reason", () => {
    const out = run(parts);
    const err = out.find((e) => e.type === "error") as { message: string };
    expect(err.message).toBe(VIOLATION_TOOL_MESSAGE);
    const toolDone = out.find((e) => e.type === "tool.done") as {
      outcome: string;
      structuredContent?: unknown;
    };
    expect(toolDone.outcome).toBe("ok");
    expect(toolDone.structuredContent).toStrictEqual({ result: "echo: hi" });
    const meta = out.find((e) => e.type === "message.metadata") as {
      metadata: Record<string, unknown>;
    };
    expect(meta.metadata["rawFinishReason"]).toBe("tool_calls"); // model's own reason survives
    const msgEnds = out.filter((e) => e.type === "message.end") as { usage?: unknown }[];
    expect(msgEnds[0]!.usage).toStrictEqual({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      reasoningTokens: 3,
    });
  });

  it("reduces to ONE successful turn with two messages (tool-call + tool-result blocks intact)", () => {
    const { messages, turns } = reduce(run(parts));
    expect(turns).toHaveLength(1);
    expect(messages).toHaveLength(2);
    const blocks = messages.flatMap((m) => m.content);
    expect(blocks.some((b) => b.type === "tool-call")).toBe(true);
    expect(blocks.some((b) => b.type === "tool-result")).toBe(true);
  });
});

describe("toolChoice enforcement shape B' — {type:'tool'} answered with the WRONG tool (ai>=7.0.108, changeset ccf98e7)", () => {
  const VIOLATION = () =>
    new FakeToolChoiceViolationError({
      toolChoice: { type: "tool", toolName: "lookup" },
      // the constructor still receives the model's UNIFIED reason; only the
      // internal model-call-end chunk is stamped 'error'
      finishReason: "tool-calls",
      provider: "openai.responses",
      modelId: "gpt-5-mini",
      content: [{ type: "tool-call", toolCallId: "call_1", toolName: "echo" }],
    });

  /**
   * FIXTURE-ONLY (same reason as shape A — capture config never sets
   * toolChoice). This is the CURRENT runtime for shape B. Transcribed from
   * ai@7.0.111:
   *  - stream-language-model-call.ts computes the violation BEFORE enqueuing
   *    the internal `model-call-end`, stamps that chunk finishReason 'error',
   *    then enqueues the `error` part;
   *  - execute-tools-from-stream.ts returns early on a `model-call-end` whose
   *    finishReason fails isToolExecutionAllowedFinishReason (only 'stop' and
   *    'tool-calls' pass), so the `echo` call is NEVER executed: no
   *    tool-result, no tool-error;
   *  - stream-text.ts sees 1 client tool call against 0 outputs + 0 denials,
   *    so the loop does not continue and it enqueues `finish{finishReason:
   *    'error', rawFinishReason, totalUsage: combinedUsage}`.
   * The streamed tool-input parts and the `tool-call` are forwarded as they
   * arrive, before the model's terminal chunk, so they precede the `error`.
   */
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "tool-input-start", id: "call_1", toolName: "echo", dynamic: true },
    { type: "tool-input-delta", id: "call_1", delta: '{"text":"hi"}' },
    { type: "tool-input-end", id: "call_1" },
    { type: "tool-call", toolCallId: "call_1", toolName: "echo", input: { text: "hi" }, dynamic: true },
    { type: "error", error: VIOLATION() },
    {
      type: "finish-step",
      finishReason: "error",
      rawFinishReason: "tool_calls",
      usage: USAGE,
      response: RESPONSE_S1,
    },
    { type: "finish", finishReason: "error", rawFinishReason: "tool_calls", totalUsage: USAGE },
  ];

  it("FULL ORDERED event list — the wrong tool is never settled and the run closes turn.error", () => {
    const out = run(parts);
    expect(types(out)).toEqual([
      "turn.start",
      "step.start",
      "message.start",
      "tool.start",
      "tool.args.delta",
      "tool.args.assembled",
      "error",
      "message.metadata",
      "message.end",
      "step.done",
      "turn.error",
    ]);
    expect(types(out)).not.toContain("tool.done");
    expect(types(out)).not.toContain("turn.done");
    expectAllParse(out);
  });

  it("turn.error carries the violation message and usage == the mapped finish.totalUsage; the advisory is message-only", () => {
    const out = run(parts);
    expect(out.find((e) => e.type === "error")).toStrictEqual({
      type: "error",
      seq: 6,
      message: VIOLATION_TOOL_MESSAGE,
      turnId: "turn_vercel_1",
    });
    expect(out.at(-1)).toStrictEqual({
      type: "turn.error",
      seq: 10,
      turnId: "turn_vercel_1",
      message: VIOLATION_TOOL_MESSAGE,
      usage: {
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        reasoningTokens: 3,
      },
    });
  });

  it("the violating step seals normally: the model's raw reason survives in metadata, message.end keeps the step usage", () => {
    const out = run(parts);
    const meta = out.find((e) => e.type === "message.metadata") as {
      metadata: Record<string, unknown>;
    };
    expect(meta.metadata).toStrictEqual({
      responseId: "resp-s1",
      model: "mock-model",
      rawFinishReason: "tool_calls",
    });
    const msgEnd = out.find((e) => e.type === "message.end") as { usage?: unknown };
    expect(msgEnd.usage).toStrictEqual(
      (out.find((e) => e.type === "turn.error") as { usage?: unknown }).usage,
    );
  });

  it("folds as the 7.0.70 resultless-call shape: one errored turn, a tool-call block with NO tool-result, no resync", () => {
    const r = new Reducer();
    for (const e of run(parts)) r.push(e);
    expect(r.needsResync).toBe(false);
    const { messages, turns } = r.result();
    expect(turns).toHaveLength(1);
    expect(messages).toHaveLength(1);
    const blocks = messages[0]!.content;
    const call = blocks.find((b) => b.type === "tool-call") as
      | { toolCallId: string; name: string }
      | undefined;
    expect(call).toMatchObject({ toolCallId: "call_1", name: "echo" });
    expect(blocks.some((b) => b.type === "tool-result")).toBe(false);
  });
});

// ─── tool approval auto-denial (ai>=7.0.102, changeset 8b92ba9) ──────────────

/**
 * FIXTURE-ONLY, BY CONSTRUCTION — the e2e capture agent passes no
 * `toolApproval`, and a tool's own `needsApproval` can only resolve to
 * 'user-approval', never 'denied', so no captured run reaches the auto-denial.
 * Wire transcribed from the ai@7.0.111 runtime:
 *  - execute-tools-from-stream.ts `case 'denied'`: the `tool-call` is
 *    forwarded first, then tool-approval-request{isAutomatic:true},
 *    tool-approval-response{approved:false, reason} and — NEW in 7.0.102 —
 *    tool-output-denied{toolCallId, toolName}; the tool is not executed;
 *  - stream-text.ts forwards tool-output-denied as a step part. 1 client call
 *    settled by 1 denial lets the loop continue, so a second step has the
 *    model answer with the denial in its prompt;
 *  - streamText's INITIAL pass (stream-text.ts, before the first start-step)
 *    also enqueues a bare tool-output-denied{toolCallId, toolName} for every
 *    approval denied in a PREVIOUS call, next to tool-result / tool-error for
 *    prior-call approvals it executes or rejects — ids with no tool.start in
 *    this turn.
 */
const DENY_CALL = { type: "tool-call", toolCallId: "call_1", toolName: "echo", input: { text: "hi" } };
const DENY_REQUEST = {
  type: "tool-approval-request",
  approvalId: "approval-1",
  toolCall: DENY_CALL,
  isAutomatic: true,
};
const DENY_RESPONSE = {
  type: "tool-approval-response",
  approvalId: "approval-1",
  approved: false,
  toolCall: DENY_CALL,
  reason: "echo is disabled by policy",
};
const DENIED = { type: "tool-output-denied", toolCallId: "call_1", toolName: "echo" };

/** Step 2 + close: the model answers after seeing the denial. */
const DENY_TAIL = [
  {
    type: "finish-step",
    finishReason: "tool-calls",
    rawFinishReason: "tool_calls",
    usage: USAGE,
    response: RESPONSE_S1,
  },
  { type: "start-step", request: {}, warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", text: "I could not run echo." },
  { type: "text-end", id: "t1" },
  {
    type: "finish-step",
    finishReason: "stop",
    rawFinishReason: "stop",
    usage: USAGE,
    response: { id: "resp-s2", timestamp: "1970-01-01T00:00:00.000Z", modelId: "mock-model" },
  },
  { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: USAGE },
];

/** 7.0.102+ in-step auto-denial on a STREAMED tool call. */
const DENY_PARTS = [
  { type: "start" },
  { type: "start-step", request: {}, warnings: [] },
  { type: "tool-input-start", id: "call_1", toolName: "echo" },
  { type: "tool-input-delta", id: "call_1", delta: '{"text":"hi"}' },
  { type: "tool-input-end", id: "call_1" },
  DENY_CALL,
  DENY_REQUEST,
  DENY_RESPONSE,
  DENIED,
  ...DENY_TAIL,
];

describe("tool-output-denied — in-step auto-denial (ai>=7.0.102, changeset 8b92ba9)", () => {
  it("MIRROR — FULL ORDERED event list: tool-output-denied settles the call as tool.done; request/response still ride the frame carry", () => {
    const out = run(DENY_PARTS);
    expect(types(out)).toEqual([
      "turn.start",
      "step.start",
      "message.start",
      "tool.start",
      "tool.args.delta",
      "tool.args.assembled",
      "ext.vercel.frame", // tool-approval-request (HITL mapping still deferred)
      "ext.vercel.frame", // tool-approval-response
      "tool.done", // tool-output-denied — formerly a third ext.vercel.frame
      "message.metadata",
      "message.end",
      "step.done",
      "step.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.metadata",
      "message.end",
      "step.done",
      "turn.done",
    ]);
    const frames = out.filter((e) => e.type === "ext.vercel.frame");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ kind: "tool-approval-request", frame: DENY_REQUEST });
    expect(frames[1]).toMatchObject({ kind: "tool-approval-response", frame: DENY_RESPONSE });
    expectAllParse(out);
  });

  it("MIRROR — tool.done{outcome:'denied'} carries the approval response's reason as its text; NOT an isError alias", () => {
    const out = run(DENY_PARTS);
    const done = out.find((e) => e.type === "tool.done")!;
    expect(done).toStrictEqual({
      type: "tool.done",
      seq: 8,
      turnId: "turn_vercel_1",
      toolCallId: "call_1",
      outcome: "denied",
      content: [{ type: "text", text: "echo is disabled by policy" }],
    });
    expect("isError" in done).toBe(false);
    expect("errorText" in done).toBe(false);
  });

  it("folds clean: one turn, the tool-call block and a tool-result{outcome:'denied'} block, no resync", () => {
    const r = new Reducer();
    for (const e of run(DENY_PARTS)) r.push(e);
    expect(r.needsResync).toBe(false);
    const { messages, turns } = r.result();
    expect(turns).toHaveLength(1);
    const blocks = messages.flatMap((m) => m.content);
    expect(blocks.find((b) => b.type === "tool-call")).toMatchObject({ toolCallId: "call_1", name: "echo" });
    expect(blocks.find((b) => b.type === "tool-result")).toMatchObject({
      toolCallId: "call_1",
      outcome: "denied",
      content: [{ type: "text", text: "echo is disabled by policy" }],
    });
  });

  it("a NON-streamed denied call (synthesized tool.start path) closes the same way", () => {
    const out = run([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      DENY_CALL,
      DENY_REQUEST,
      DENY_RESPONSE,
      DENIED,
      ...DENY_TAIL,
    ]);
    expect(types(out).slice(0, 9)).toEqual([
      "turn.start",
      "step.start",
      "message.start",
      "tool.start",
      "tool.args.delta",
      "tool.args.assembled",
      "ext.vercel.frame",
      "ext.vercel.frame",
      "tool.done",
    ]);
    expect(out[8]).toStrictEqual({
      type: "tool.done",
      seq: 8,
      turnId: "turn_vercel_1",
      toolCallId: "call_1",
      outcome: "denied",
      content: [{ type: "text", text: "echo is disabled by policy" }],
    });
    expectAllParse(out);
  });

  it("reason handling: absent ⇒ content [] (no text block); empty string kept (typeof guard); keyed by toolCallId (approving-response strictness pinned separately below)", () => {
    const call2 = { type: "tool-call", toolCallId: "call_2", toolName: "echo", input: { text: "b" } };
    const out = run([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      DENY_CALL,
      // call_1: denied with NO reason (ToolApprovalStatus 'denied' as a bare string)
      { type: "tool-approval-request", approvalId: "a1", toolCall: DENY_CALL, isAutomatic: true },
      { type: "tool-approval-response", approvalId: "a1", approved: false, toolCall: DENY_CALL },
      { type: "tool-output-denied", toolCallId: "call_1", toolName: "echo" },
      call2,
      // call_2: approved WITH a reason, then denied on a later response with ""
      { type: "tool-approval-response", approvalId: "a2", approved: true, toolCall: call2, reason: "ok" },
      { type: "tool-approval-response", approvalId: "a3", approved: false, toolCall: call2, reason: "" },
      { type: "tool-output-denied", toolCallId: "call_2", toolName: "echo" },
      // call_3: denied with no approval response at all ⇒ nothing stashed
      { type: "tool-output-denied", toolCallId: "call_3", toolName: "echo" },
      ...DENY_TAIL,
    ]);
    const dones = out.filter((e) => e.type === "tool.done") as {
      toolCallId: string;
      outcome: string;
      content: unknown[];
    }[];
    expect(dones.map((d) => [d.toolCallId, d.outcome, d.content])).toStrictEqual([
      ["call_1", "denied", []],
      ["call_2", "denied", [{ type: "text", text: "" }]],
      ["call_3", "denied", []],
    ]);
    expectAllParse(out);
  });

  it("a malformed tool-output-denied (no string toolCallId) degrades to the frame carry", () => {
    const n = createVercelNormalizer();
    n.push({ type: "start" });
    const out = n.push({ type: "tool-output-denied", toolCallId: 7, toolName: "echo" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "ext.vercel.frame",
      kind: "tool-output-denied",
      frame: { type: "tool-output-denied", toolCallId: 7, toolName: "echo" },
    });
  });

  it("only a STRICT approved:false stashes a reason: an approving (or non-boolean) response's reason never reaches a tool.done", () => {
    const call2 = { type: "tool-call", toolCallId: "call_2", toolName: "echo", input: { text: "b" } };
    const call3 = { type: "tool-call", toolCallId: "call_3", toolName: "echo", input: { text: "c" } };
    const out = run([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      DENY_CALL,
      call2,
      call3,
      { type: "tool-approval-response", approvalId: "a1", approved: true, toolCall: DENY_CALL, reason: "ok" },
      { type: "tool-approval-response", approvalId: "a2", approved: "false", toolCall: call2, reason: "str" },
      // `approved` absent — falsy but not `false`
      { type: "tool-approval-response", approvalId: "a3", toolCall: call3, reason: "absent" },
      { type: "tool-output-denied", toolCallId: "call_1", toolName: "echo" },
      { type: "tool-output-denied", toolCallId: "call_2", toolName: "echo" },
      { type: "tool-output-denied", toolCallId: "call_3", toolName: "echo" },
      ...DENY_TAIL,
    ]);
    const dones = out.filter((e) => e.type === "tool.done") as { toolCallId: string; content: unknown[] }[];
    expect(dones.map((d) => [d.toolCallId, d.content])).toStrictEqual([
      ["call_1", []],
      ["call_2", []],
      ["call_3", []],
    ]);
  });

  it("a later reasonless denial for the same id clears an earlier stashed reason (no stale text)", () => {
    const out = run([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      DENY_CALL,
      { type: "tool-approval-response", approvalId: "a1", approved: false, toolCall: DENY_CALL, reason: "stale" },
      { type: "tool-approval-response", approvalId: "a2", approved: false, toolCall: DENY_CALL },
      DENIED,
      ...DENY_TAIL,
    ]);
    const done = out.find((e) => e.type === "tool.done") as { content: unknown[] };
    expect(done.content).toStrictEqual([]);
  });

  it("NEGATIVE CONTROL — a 7.0.101-shaped auto-denial (no tool-output-denied) is byte-identical to before: frames only, no tool.done", () => {
    const before = run(DENY_PARTS.filter((p) => p !== DENIED));
    expect(types(before)).toEqual([
      "turn.start",
      "step.start",
      "message.start",
      "tool.start",
      "tool.args.delta",
      "tool.args.assembled",
      "ext.vercel.frame", // tool-approval-request
      "ext.vercel.frame", // tool-approval-response
      "message.metadata",
      "message.end",
      "step.done",
      "step.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.metadata",
      "message.end",
      "step.done",
      "turn.done",
    ]);
    const frames = before.filter((e) => e.type === "ext.vercel.frame");
    expect(frames).toStrictEqual([
      {
        type: "ext.vercel.frame",
        seq: 6,
        kind: "tool-approval-request",
        frame: DENY_REQUEST,
      },
      {
        type: "ext.vercel.frame",
        seq: 7,
        kind: "tool-approval-response",
        frame: DENY_RESPONSE,
      },
    ]);
    expectAllParse(before);
  });

  it("MIRROR — the lone delta between the 7.0.101 and 7.0.102 wires is the tool.done (a third frame on the pre-arm facet)", () => {
    const before = run(DENY_PARTS.filter((p) => p !== DENIED));
    // strip the new tool.done and every seq: the 7.0.102 run equals the
    // 7.0.101 run event for event.
    const strip = (evs: AgEvent[]) =>
      evs
        .filter((e) => e.type !== "tool.done")
        .map((e) => {
          const { seq: _seq, ...rest } = e as { seq: number };
          return rest;
        });
    expect(strip(run(DENY_PARTS))).toStrictEqual(strip(before));
  });
});

describe("tool-output-denied — PRIOR-CALL id from streamText's initial pass (no tool.start this turn)", () => {
  // Initial-pass order (stream-text.ts): denials first, then the prior-call
  // approvals it executed (tool-result) — all before the first start-step.
  const parts = [
    { type: "start" },
    { type: "tool-output-denied", toolCallId: "old1", toolName: "echo" },
    {
      type: "tool-result",
      toolCallId: "old2",
      toolName: "lookup",
      input: { q: "x" },
      output: { ok: true },
    },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "done" },
    { type: "text-end", id: "t1" },
    {
      type: "finish-step",
      finishReason: "stop",
      rawFinishReason: "stop",
      usage: USAGE,
      response: RESPONSE_S1,
    },
    { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: USAGE },
  ];

  it("emits a prior-call tool.done right after turn.start, naming its own <id>:result message — settled one way with the initial pass's prior-call tool-result", () => {
    const out = run(parts);
    expect(types(out)).toEqual([
      "turn.start",
      "tool.done", // old1 — denied
      "tool.done", // old2 — ok (the pre-existing initial-pass handling)
      "step.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.metadata",
      "message.end",
      "step.done",
      "turn.done",
    ]);
    expect(types(out)).not.toContain("tool.start"); // no synthesized start for a prior-call id
    expect(out[1]).toStrictEqual({
      type: "tool.done",
      seq: 1,
      turnId: "turn_vercel_1",
      toolCallId: "old1",
      messageId: "old1:result",
      outcome: "denied",
      content: [], // the initial pass's denial carries no reason on the wire
    });
    // same envelope as the prior-call tool-result: its own <id>:result message, turnId from the invoke's turn
    expect(out[2]).toMatchObject({ seq: 2, turnId: "turn_vercel_1", toolCallId: "old2", messageId: "old2:result", outcome: "ok" });
    expectAllParse(out);
  });

  it("§10 item 47 leg pair-vercel (c20; flipped from the 0.7.x KNOWN GAP): after a prior invoke that opened the calls, both prior-call results fold into role:'tool' messages of this invoke's turn, through one Reducer, without parking", () => {
    // The prior invoke: the model called old1 and old2 and the run paused on their approvals.
    const prior = createVercelNormalizer({ invokeId: "vercel_prior" });
    const priorParts = [
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "tool-call", toolCallId: "old1", toolName: "echo", input: {} },
      { type: "tool-call", toolCallId: "old2", toolName: "lookup", input: { q: "x" } },
      { type: "finish-step", finishReason: "tool-calls", rawFinishReason: "tool-calls", usage: USAGE, response: RESPONSE_S1 },
      { type: "finish", finishReason: "tool-calls", rawFinishReason: "tool-calls", totalUsage: USAGE },
    ];
    const first: AgEvent[] = [];
    for (const p of priorParts) first.push(...prior.push(p));
    first.push(...prior.flush());
    const second = run(parts); // this invoke: seq restarts at 0
    const r = new Reducer();
    for (const e of [...first, ...second]) r.push(e);
    expect(r.needsResync).toBe(false);
    const thisTurn = (second.find((e) => e.type === "turn.start") as { turnId: string }).turnId;
    for (const id of ["old1", "old2"]) {
      const dones = second.filter((e) => e.type === "tool.done" && (e as { toolCallId?: string }).toolCallId === id) as Array<Record<string, unknown>>;
      expect(dones).toHaveLength(1);
      expect(dones[0]).toMatchObject({ messageId: `${id}:result`, turnId: thisTurn });
      expect("more" in dones[0]!).toBe(false);
      expect(second.some((e) => e.type === "tool.start" && (e as { toolCallId?: string }).toolCallId === id)).toBe(false);
      const msg = r.result().messages.find((m) => m.id === `${id}:result`);
      expect(msg).toMatchObject({ role: "tool", turnId: thisTurn });
      expect(msg!.content.filter((b) => b.type === "tool-result")).toHaveLength(1);
      // exactly one tool-call and one tool-result for the id across the fold, in different turns
      const all = r.result().messages.flatMap((m) => m.content.map((b) => ({ m, b })));
      expect(all.filter(({ b }) => b.type === "tool-call" && (b as { toolCallId?: string }).toolCallId === id)).toHaveLength(1);
      expect(all.filter(({ b }) => b.type === "tool-result" && (b as { toolCallId?: string }).toolCallId === id)).toHaveLength(1);
    }
    const denied = r.result().messages.find((m) => m.id === "old1:result")!.content[0] as { outcome?: string };
    expect(denied.outcome).toBe("denied");
  });

  it("a prior-call tool-error names its own <id>:result message too; a call opened in this invoke gets no messageId", () => {
    const out = run([
      { type: "start" },
      { type: "tool-error", toolCallId: "old3", toolName: "echo", input: {}, error: "boom" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "tool-call", toolCallId: "new1", toolName: "echo", input: {} },
      { type: "tool-result", toolCallId: "new1", toolName: "echo", input: {}, output: { ok: 1 } },
      { type: "finish-step", finishReason: "tool-calls", rawFinishReason: "tool-calls", usage: USAGE, response: RESPONSE_S1 },
      { type: "finish", finishReason: "tool-calls", rawFinishReason: "tool-calls", totalUsage: USAGE },
    ]);
    expectAllParse(out);
    const done = (id: string) => out.find((e) => e.type === "tool.done" && (e as { toolCallId?: string }).toolCallId === id) as Record<string, unknown>;
    expect(done("old3")).toMatchObject({ messageId: "old3:result", outcome: "error", isError: true });
    expect("messageId" in done("new1")).toBe(false);
    const r = new Reducer();
    for (const e of out) r.push(e);
    expect(r.needsResync).toBe(false);
  });
});

describe("StreamProviderError carry — arm B: error then EOF (flush self-seal)", () => {
  it("both the advisory and the self-sealed turn.error carry code + retriable", () => {
    const out = run([{ type: "start" }, { type: "error", error: RATE_LIMIT() }]);
    expect(out.slice(1)).toStrictEqual([
      {
        type: "error",
        seq: 1,
        message: "Rate limit reached for gpt-4o-mini",
        code: "rate_limit_exceeded",
        retriable: true,
        turnId: "turn_vercel_1",
      },
      {
        type: "turn.error",
        seq: 2,
        turnId: "turn_vercel_1",
        message: "Rate limit reached for gpt-4o-mini",
        code: "rate_limit_exceeded",
        retriable: true,
      },
    ]);
    expectAllParse(out);
  });

  it("a plain object exposing code/type (pre-7.0.80 raw frame, unwrapped) carries code; message text unchanged", () => {
    const out = run([{ type: "start" }, { type: "error", error: OPENAI_ERROR_FRAME }]);
    const terminal = out.find((e) => e.type === "turn.error");
    expect(terminal).toStrictEqual({
      type: "turn.error",
      seq: 2,
      turnId: "turn_vercel_1",
      message: JSON.stringify(OPENAI_ERROR_FRAME), // errText for plain objects — unchanged
      code: "rate_limit_exceeded",
    });
    expectAllParse(out);
  });
});

describe("StreamProviderError carry — negative controls (absent fields ⇒ byte-identical output)", () => {
  const ARM_B_STRING = [{ type: "start" }, { type: "error", error: "connect ECONNREFUSED" }];

  it("plain string payload (arm B): error + turn.error carry message ONLY — no code/retriable keys", () => {
    const out = run(ARM_B_STRING);
    expect(out.slice(1)).toStrictEqual([
      { type: "error", seq: 1, message: "connect ECONNREFUSED", turnId: "turn_vercel_1" },
      { type: "turn.error", seq: 2, turnId: "turn_vercel_1", message: "connect ECONNREFUSED" },
    ]);
    expectAllParse(out);
  });

  it("plain Error payload (arm A + A2): message = .message, no code/retriable keys", () => {
    const out = run([
      ...STEP,
      { type: "error", error: new Error("boom") },
      { type: "finish-step", finishReason: "error", usage: {}, response: RESPONSE_S1 },
      { type: "finish", finishReason: "error", totalUsage: {} },
    ]);
    const err = out.find((e) => e.type === "error");
    expect(err).toStrictEqual({ type: "error", seq: 3, message: "boom", turnId: "turn_vercel_1" });
    const terminal = out.find((e) => e.type === "turn.error");
    expect(terminal).toStrictEqual({
      type: "turn.error",
      seq: 7,
      turnId: "turn_vercel_1",
      message: "boom",
    });
    expectAllParse(out);
  });

  it("plain object WITHOUT code/type/isRetryable: JSON message, no code/retriable keys", () => {
    const out = run([{ type: "start" }, { type: "error", error: { foo: "bar" } }]);
    expect(out.slice(1)).toStrictEqual([
      { type: "error", seq: 1, message: '{"foo":"bar"}', turnId: "turn_vercel_1" },
      { type: "turn.error", seq: 2, turnId: "turn_vercel_1", message: '{"foo":"bar"}' },
    ]);
    expectAllParse(out);
  });

  it("non-string/number code and non-boolean isRetryable are ignored (guarded, never coerced)", () => {
    const out = run([
      { type: "start" },
      { type: "error", error: { code: { nested: true }, type: 7, isRetryable: "yes" } },
    ]);
    const err = out.find((e) => e.type === "error")!;
    expect("code" in err).toBe(false);
    expect("retriable" in err).toBe(false);
    expectAllParse(out);
  });

  it("arm C host sentinel is message-only and unchanged", () => {
    const out = run([{ type: "start" }, { type: VERCEL_HOST_ERROR, message: "Error: socket reset" }]);
    expect(out.slice(1)).toStrictEqual([
      { type: "error", seq: 1, message: "Error: socket reset", turnId: "turn_vercel_1" },
      { type: "turn.error", seq: 2, turnId: "turn_vercel_1", message: "Error: socket reset" },
    ]);
    expectAllParse(out);
  });

  it("finish{error} with no prior error part keeps the 'provider error' fallback, message-only", () => {
    const out = run([...STEP, { type: "finish", finishReason: "error", totalUsage: {} }]);
    const terminal = out.find((e) => e.type === "turn.error");
    expect(terminal).toStrictEqual({
      type: "turn.error",
      seq: 5,
      turnId: "turn_vercel_1",
      message: "provider error",
    });
    expectAllParse(out);
  });
});

describe("abort (captured abort-midstream — text stream left open by the wire)", () => {
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "abort", reason: "AbortError: This operation was aborted" },
  ];

  it("seals the open text stream and message BEFORE turn.abort (R5 ordering)", () => {
    const out = run(parts);
    const t = types(out);
    expect(t).toEqual([
      "turn.start",
      "step.start",
      "message.start",
      "text.start",
      "text.end",
      "message.end",
      "step.done",
      "turn.abort",
    ]);
    const abort = out.find((e) => e.type === "turn.abort") as { reason?: string };
    expect(abort.reason).toContain("AbortError");
    expectAllParse(out);
  });
});

describe("finish mapping (captured finish-content-filter)", () => {
  it("content-filter → turn.done{safety_blocked}", () => {
    const out = run([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "redac" },
      { type: "text-end", id: "t1" },
      { type: "finish-step", finishReason: "content-filter", usage: USAGE, response: RESPONSE_S1 },
      { type: "finish", finishReason: "content-filter", totalUsage: USAGE },
    ]);
    const done = out.find((e) => e.type === "turn.done") as { finishReason: string };
    expect(done.finishReason).toBe("safety_blocked");
    expectAllParse(out);
  });
});

describe("forward-compat + Tenet 6 (scaffold contract, kept)", () => {
  it("unknown part types ride ext.vercel.frame{kind,frame} losslessly (R2 tolerant arm)", () => {
    const out = run([
      { type: "start" },
      { type: "custom", data: { x: 1 } },
      { type: "reasoning-file", file: "blob" },
      { type: "tool-approval-response", id: "a1" },
      { type: "finish", finishReason: "stop", totalUsage: USAGE },
    ]);
    const frames = out.filter((e) => e.type === "ext.vercel.frame");
    expect(frames).toHaveLength(3);
    expect(JSON.stringify(frames[0])).toContain('"kind":"custom"');
    expectAllParse(out);
  });

  it("guard failures ride ext.vercel.unparsed nested under `native`", () => {
    const n = createVercelNormalizer();
    const out = n.push(42);
    expect(out).toHaveLength(1);
    expect((out[0] as { type: string }).type).toBe("ext.vercel.unparsed");
    expect(JSON.stringify(out[0])).toContain('"native":42');
  });

  it("push() never throws on hostile inputs; malformed known arms degrade to frame carry", () => {
    const n = createVercelNormalizer();
    for (const hostile of [null, undefined, [], "text", { noType: true }, { type: 7 }]) {
      expect(() => n.push(hostile)).not.toThrow();
    }
    const out = n.push({ type: "text-delta", id: 7, text: null }); // malformed payload
    expect((out[0] as { type: string }).type).toBe("ext.vercel.frame");
  });

  it("flush() with zero pushes emits nothing", () => {
    expect(createVercelNormalizer().flush()).toHaveLength(0);
  });

  it("a truncated healthy stream (no error, no finish) closes message and lets the engine abort the turn", () => {
    const out = run([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "cut of" },
    ]);
    const t = types(out);
    expect(t).toContain("message.end");
    expect(t).toContain("turn.abort");
    expect(t.indexOf("message.end")).toBeLessThan(t.indexOf("turn.abort"));
    expectAllParse(out);
  });
});

describe("draft.4 phase: an OpenAI commentary text part opens as phase 'interim' (rnd 13+17 stage 2)", () => {
  const COMMENTARY = { openai: { itemId: "msg_c", phase: "commentary" } };
  const FINAL = { openai: { itemId: "msg_f", phase: "final_answer" } };
  const stream = (bag?: object) => [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1", ...(bag ? { providerMetadata: bag } : {}) },
    { type: "text-delta", id: "t1", text: "Checking." },
    { type: "text-end", id: "t1", ...(bag ? { providerMetadata: bag } : {}) },
    { type: "finish-step", finishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
    { type: "finish", finishReason: "stop", totalUsage: USAGE },
  ];

  it("commentary → text.start{phase:'interim'}, providerMetadata kept verbatim; the block folds 'interim'", () => {
    const out = run(stream(COMMENTARY));
    const start = out.find((e) => e.type === "text.start") as { phase?: string; providerMetadata?: unknown };
    expect(start.phase).toBe("interim");
    expect(start.providerMetadata).toEqual(COMMENTARY);
    const end = out.find((e) => e.type === "text.end") as object;
    expect("phase" in end).toBe(false); // the start value stands
    expectAllParse(out);
    const text = reduce(out).messages[0]!.content.find((b) => b.type === "text") as { phase?: string };
    expect(text.phase).toBe("interim");
  });

  it("final_answer, an unknown phase, or no bag → no phase key at all", () => {
    for (const bag of [FINAL, { openai: { phase: "x-future" } }, undefined]) {
      const out = run(stream(bag));
      for (const e of out.filter((x) => x.type === "text.start" || x.type === "text.end")) expect("phase" in e).toBe(false);
    }
  });
});

describe("invoke-scoped ids: turn and message ids unique across the invokes of one fold", () => {
  // The fullStream has no id before finish-step, so each normalizer draws a
  // random id stem unless the host passes `invokeId` (sp-protocol's ruling on
  // rd-14 P14: a per-normalizer counter restarting at 1 collided across invokes).
  const PARTS = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "hi" },
    { type: "text-end", id: "t1" },
    { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
    { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: USAGE },
  ];
  function drive(options?: { invokeId?: string }): AgEvent[] {
    const n = createVercelNormalizer(options);
    const out: AgEvent[] = [];
    for (const p of PARTS) out.push(...n.push(p));
    out.push(...n.flush());
    return out;
  }
  const turnIds = (evs: AgEvent[]) =>
    evs.filter((e) => e.type === "turn.start").map((e) => (e as { turnId: string }).turnId);
  const messageIds = (evs: AgEvent[]) =>
    evs.filter((e) => e.type === "message.start").map((e) => (e as { id: string }).id);

  it("two default normalizers mint disjoint turn and message ids from a fresh random stem", () => {
    const a = drive();
    const b = drive();
    expect(turnIds(a)).toHaveLength(1);
    expect(turnIds(a)[0]).toMatch(/^turn_vercel_[0-9a-f]{16}_1$/);
    expect(messageIds(a)).toEqual([`msg_${turnIds(a)[0]}_s1`]);
    expect(turnIds(b)).not.toEqual(turnIds(a));
    expect(messageIds(b)).not.toEqual(messageIds(a));
    expectAllParse([...a, ...b]);
  });

  it("the same native with the same invokeId produces identical output", () => {
    expect(drive({ invokeId: "inv-7" })).toEqual(drive({ invokeId: "inv-7" }));
    expect(turnIds(drive({ invokeId: "inv-7" }))).toEqual(["turn_inv-7_1"]);
    // replay.ts pins "vercel", which reproduces the committed goldens' ids.
    expect(turnIds(drive({ invokeId: "vercel" }))).toEqual(["turn_vercel_1"]);
  });

  it("two default invokes fold into one Reducer as two turns and two messages, no park", () => {
    const a = drive();
    const b = drive();
    const r = new Reducer();
    for (const ev of [...a, ...b]) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    expect(res.turns.map((t) => t.turnId)).toEqual([...turnIds(a), ...turnIds(b)]);
    expect(res.messages.map((m) => m.id)).toEqual([...messageIds(a), ...messageIds(b)]);
  });
});

describe("turn.done.finishReasonRaw for an unmapped native finish reason (draft.4, SPEC §8.0, §10 item 23)", () => {
  const stream = (finish: Record<string, unknown>) => [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "hi" },
    { type: "text-end", id: "t1" },
    { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
    { type: "finish", totalUsage: USAGE, ...finish },
  ];
  const done = (evs: AgEvent[]) =>
    evs.find((e) => e.type === "turn.done") as { finishReason: string; finishReasonRaw?: string } | undefined;

  it("item 23: rawFinishReason 'zz' behind a unified 'other' → finishReason other + finishReasonRaw 'zz'; every event parses", () => {
    const out = run(stream({ finishReason: "other", rawFinishReason: "zz" }));
    expect(done(out)).toMatchObject({ finishReason: "other", finishReasonRaw: "zz" });
    expectAllParse(out);
  });

  it("carries the native value byte for byte (unicode, punctuation, quotes)", () => {
    const raw = 'ZZ-未来.☃ "q" \\ end';
    const out = run(stream({ finishReason: "other", rawFinishReason: raw }));
    expect(done(out)?.finishReasonRaw).toBe(raw);
    expectAllParse(out);
  });

  it("an unrecognized unified finishReason (a future ai value) maps to unknown and carries rawFinishReason, else the unified value", () => {
    const withRaw = run(stream({ finishReason: "zz-future", rawFinishReason: "provider_zz" }));
    expect(done(withRaw)).toMatchObject({ finishReason: "unknown", finishReasonRaw: "provider_zz" });
    const bare = run(stream({ finishReason: "zz-future" }));
    expect(done(bare)).toMatchObject({ finishReason: "unknown", finishReasonRaw: "zz-future" });
    expectAllParse([...withRaw, ...bare]);
  });

  it("a mapped reason sets no finishReasonRaw, whatever the provider's raw value", () => {
    for (const [unified, raw, mapped] of [
      ["stop", "end_turn", "stop"],
      ["length", "max_tokens", "token_limit"],
      ["content-filter", "SAFETY", "safety_blocked"],
      ["tool-calls", "tool_use", "tool_call"],
    ] as const) {
      const d = done(run(stream({ finishReason: unified, rawFinishReason: raw })));
      expect(d?.finishReason).toBe(mapped);
      expect(d !== undefined && "finishReasonRaw" in d).toBe(false);
    }
  });

  it("a bare unified 'other' with no rawFinishReason carries nothing (it would only repeat the fallback)", () => {
    const d = done(run(stream({ finishReason: "other" })));
    expect(d?.finishReason).toBe("other");
    expect(d !== undefined && "finishReasonRaw" in d).toBe(false);
  });

  it("the turn record folds finishReasonRaw", () => {
    const res = reduce(run(stream({ finishReason: "other", rawFinishReason: "zz" })));
    expect(res.turns[0]).toMatchObject({ finishReason: "other", finishReasonRaw: "zz" });
  });
});

describe("live (not JSON round-tripped) parts: no throw, and no whole-value collapse (core toJsonValueSafe)", () => {
  it("a tool output holding a cycle and a BigInt keeps every JSON-able sibling; only those nodes degrade", () => {
    const output: Record<string, unknown> = { keep: "sibling", n: 10n, when: new Date(0), gone: undefined };
    output["self"] = output;
    const out = run([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "echo", input: { msg: "hi", big: 2n } },
      { type: "tool-result", toolCallId: "c1", toolName: "echo", input: { msg: "hi" }, output },
      { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage: USAGE, response: RESPONSE_S1 },
      { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: USAGE },
    ]);
    const done = out.find((e) => e.type === "tool.done");
    const serialized = JSON.stringify(done);
    // Before: safeJson's String(v) fallback made the whole output "[object Object]".
    expect(serialized).not.toContain("[object Object]");
    expect(serialized).toContain('"keep":"sibling"');
    expect(serialized).toContain('"n":"10"');
    expect(serialized).toContain('"when":"1970-01-01T00:00:00.000Z"');
    expect(serialized).toContain('"self":"[Circular]"');
    expect(serialized).not.toContain('"gone"');
    expect(JSON.stringify(out.find((e) => e.type === "tool.args.assembled"))).toContain('"big":"2"');
    expectAllParse(out);
  });
});

describe("per-native guard: a throw mid-part discards that part's batch, emits one error, parks nothing (core checkpoint/rollback)", () => {
  afterEach(() => vi.restoreAllMocks());
  const U = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const R = { id: "r", timestamp: "1970-01-01T00:00:00.000Z", modelId: "m" };
  const BAD = 8; // the second start-step: emits step.start, then openMessage (the throw lands between them)
  const PARTS = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "hello" },
    { type: "text-end", id: "t1" },
    { type: "tool-call", toolCallId: "c1", toolName: "echo", input: { msg: "hi" } },
    { type: "tool-result", toolCallId: "c1", toolName: "echo", input: { msg: "hi" }, output: "hi" },
    { type: "finish-step", finishReason: "tool-calls", rawFinishReason: "tool_calls", usage: U, response: R },
    { type: "start-step", request: {}, warnings: [], secret: "SECRET_native" },
    { type: "text-start", id: "t2" },
    { type: "text-delta", id: "t2", text: "world" },
    { type: "text-end", id: "t2" },
    { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage: U, response: R },
    { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: U },
  ];
  /** Every StreamAssembler method throws on the `nth` call made after arming. */
  function armThrowOnCall(nth: number): { calls: () => number; disarm: () => void } {
    let calls = 0;
    const methods = Object.getOwnPropertyNames(StreamAssembler.prototype).filter(
      (m) => !["constructor", "drain", "flush", "checkpoint", "rollback"].includes(m),
    );
    const spies = methods.map((m) => {
      const proto = StreamAssembler.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
      const original = proto[m]!;
      return vi.spyOn(proto, m).mockImplementation(function (this: StreamAssembler, ...a: unknown[]) {
        if (++calls === nth) throw new TypeError("SECRET_in_message: normalizer bug");
        return original.apply(this, a);
      });
    });
    return { calls: () => calls, disarm: () => spies.forEach((s) => s.mockRestore()) };
  }
  function expectFoldsClean(out: AgEvent[]): void {
    expectAllParse(out);
    expect(out.map((e) => e.seq), "seq contiguous").toEqual(out.map((_, i) => i));
    const { result, needsResync } = foldBatch(out);
    expect(needsResync, "reduce() parked").toBe(false);
    const starts = out.filter((e) => e.type === "message.start").map((e) => (e as { id: string }).id);
    const ends = out.filter((e) => e.type === "message.end").map((e) => (e as { id: string }).id);
    expect(ends.sort(), "INV-MSG: every opened message closes once").toEqual(starts.sort());
    return void result;
  }

  it("(a) a throw after step.start is emitted: ≡ the stream without that part + one error, +1 renumbered; no park; INV-MSG/INV-BLOCK hold", () => {
    const reference = run(PARTS.filter((_, i) => i !== BAD));
    const at = (() => {
      const n = createVercelNormalizer({ invokeId: "vercel" });
      return PARTS.slice(0, BAD).flatMap((p) => n.push(p)).length;
    })();
    const n = createVercelNormalizer({ invokeId: "vercel" });
    const out: AgEvent[] = [];
    for (const [i, p] of PARTS.entries()) {
      if (i !== BAD) {
        out.push(...n.push(p));
        continue;
      }
      const arm = armThrowOnCall(2);
      expect(() => out.push(...n.push(p))).not.toThrow();
      arm.disarm();
      // Call 1 emitted step.start, call 2 (openMessage) threw, call 3 is the guard's own error emit.
      expect(arm.calls(), "the throw landed after an open").toBe(3);
    }
    out.push(...n.flush());
    expect(out).toEqual([
      ...reference.slice(0, at),
      { type: "error", seq: at, turnId: "turn_vercel_1", message: "normalizer error", code: "TypeError" },
      ...reference.slice(at).map((e) => ({ ...e, seq: e.seq + 1 })),
    ]);
    expect(out.filter((e) => e.type === "step.start")).toHaveLength(reference.filter((e) => e.type === "step.start").length);
    expectFoldsClean(out);
    const texts = reduce(out).messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text));
    expect(texts, "INV-BLOCK: each text block once, in order").toEqual(["hello", "world"]);
  });

  it("(b) neither the thrown message nor the native reaches the wire", () => {
    const n = createVercelNormalizer({ invokeId: "vercel" });
    const out: AgEvent[] = [];
    for (const [i, p] of PARTS.entries()) {
      const arm = i === BAD ? armThrowOnCall(2) : undefined;
      out.push(...n.push(p));
      arm?.disarm();
    }
    out.push(...n.flush());
    const wire = JSON.stringify(out);
    expect(wire).toContain('"message":"normalizer error"');
    expect(wire).not.toContain("SECRET_");
    expect(wire).not.toContain("normalizer bug");
  });

  it("(c) a throw while flush() seals a truncated turn: one error, then the assembler's INV-FLUSH closes; no park", () => {
    const n = createVercelNormalizer({ invokeId: "vercel" });
    const out: AgEvent[] = [];
    for (const p of PARTS.slice(0, 4)) out.push(...n.push(p)); // text block t1 left open, no finish
    const arm = armThrowOnCall(1);
    let flushed: AgEvent[] = [];
    expect(() => (flushed = n.flush())).not.toThrow();
    arm.disarm();
    out.push(...flushed);
    expect(flushed[0]).toMatchObject({ type: "error", message: "normalizer error", code: "TypeError" });
    expect(types(flushed).slice(1)).toContain("message.end");
    expect(JSON.stringify(out)).not.toContain("SECRET_");
    expectFoldsClean(out);
  });

  it("(d) a throw after the last turn closed: the error names the closed turn (INV-OWNER's backfill), byte-equal to core withAtomicPush's", () => {
    const n = createVercelNormalizer({ invokeId: "vercel" });
    const out: AgEvent[] = [];
    for (const p of PARTS) out.push(...n.push(p)); // ends with finish → turn.done
    expect(out[out.length - 1]).toMatchObject({ type: "turn.done", turnId: "turn_vercel_1" });
    const arm = armThrowOnCall(1); // the next part's first assembler call throws
    const after = n.push({ type: "start" });
    arm.disarm();
    expect(JSON.stringify(after)).toBe(
      JSON.stringify([{ type: "error", message: "normalizer error", code: "TypeError", turnId: "turn_vercel_1", seq: out.length }]),
    );
    out.push(...after, ...n.flush());
    expectFoldsClean(out);
  });

  it("saveLocal()/restoreLocal() cover every mutable per-invoke local of the factory (a new one cannot silently escape a rollback)", () => {
    // Source reflection (sp-cto's nit 3): the factory's top-level `let`s and
    // Set/Map locals are the facet's per-invoke state; each must be saved and
    // restored, or a rolled-back part leaves it advanced.
    const src = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    const start = src.indexOf("export function createVercelNormalizer(");
    const factory = src.slice(start, src.indexOf("\n}\n", start));
    const lets = [...factory.matchAll(/^  let (\w+)/gm)].map((m) => m[1]!);
    const containers = [...factory.matchAll(/^  const (\w+)(?::[^=]+)? = new (?:Set|Map)\b/gm)].map((m) => m[1]!);
    const locals = [...lets, ...containers];
    expect(locals.sort()).toEqual(
      ["deniedReasons", "msgId", "openReasoningIds", "openTextIds", "pendingToolIds", "startedToolIds", "stashedError", "stepId", "stepIndex", "turnClosed", "turnCounter", "turnId"],
    );
    const body = (signature: string): string => {
      const i = factory.indexOf(signature);
      expect(i, signature).toBeGreaterThan(0);
      return factory.slice(i, factory.indexOf("\n  }\n", i));
    };
    const save = body("  function saveLocal() {");
    const restore = body("  function restoreLocal(");
    for (const name of lets) {
      expect(save, `saveLocal() keeps ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
      expect(restore, `restoreLocal() sets ${name}`).toMatch(new RegExp(`\\b${name} = s\\.${name};`));
    }
    for (const name of containers) {
      expect(save, `saveLocal() copies ${name}`).toContain(`[...${name}]`);
      expect(restore, `restoreLocal() refills ${name}`).toContain(`${name}.clear();`);
    }
  });

  it("no throw: the guard is invisible (identical output with and without the spies armed at an unreachable call)", () => {
    const plain = run(PARTS);
    const arm = armThrowOnCall(Number.MAX_SAFE_INTEGER);
    const guarded = run(PARTS);
    arm.disarm();
    expect(guarded).toEqual(plain);
  });
});

describe("preliminary tool-result, then tool-error (CB-7; draft.4 §5 snapshot fold)", () => {
  const parts = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "tool-call", toolCallId: "call_1", toolName: "fetch", input: { url: "u" } },
    {
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "fetch",
      input: { url: "u" },
      output: { progress: 0.5 },
      preliminary: true,
      dynamic: false,
    },
    { type: "tool-error", toolCallId: "call_1", toolName: "fetch", input: { url: "u" }, error: "boom" },
    {
      type: "finish-step",
      finishReason: "tool-calls",
      rawFinishReason: "tool-calls",
      usage: USAGE,
      response: RESPONSE_S1,
    },
    { type: "finish", finishReason: "tool-calls", rawFinishReason: "tool-calls", totalUsage: USAGE },
  ];

  it("the facet sends a kept-open ok snapshot with structuredContent, then an error final without it", () => {
    const done = run(parts).filter((e) => (e as { type: string }).type === "tool.done") as Record<string, unknown>[];
    expect(done).toHaveLength(2);
    expect(done[0]).toMatchObject({ more: true, outcome: "ok", structuredContent: { progress: 0.5 } });
    expect(done[1]).toMatchObject({ outcome: "error", isError: true, errorText: "boom" });
    expect("structuredContent" in done[1]!).toBe(false);
  });

  it("the fold holds exactly the error result: no stale structuredContent, no preliminary", () => {
    const out = run(parts);
    expectAllParse(out);
    const r = new Reducer();
    for (const ev of out) r.push(ev);
    expect(r.needsResync).toBe(false);
    const results = r.result().messages.flatMap((m) => m.content).filter((b) => b.type === "tool-result");
    expect(results).toHaveLength(1);
    const block = results[0] as Record<string, unknown>;
    expect(block).toMatchObject({
      toolCallId: "call_1",
      outcome: "error",
      isError: true,
      errorText: "boom",
      content: [{ type: "text", text: "boom" }],
    });
    for (const k of ["structuredContent", "preliminary"]) expect(k in block, k).toBe(false);
  });
});

describe("§10 item 42 — kept-open results are snapshots (yield/yield/return, yield/throw)", () => {
  const head = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "tool-call", toolCallId: "call_1", toolName: "gen", input: {} },
  ];
  const yielded = (v: number) => ({ type: "tool-result", toolCallId: "call_1", toolName: "gen", input: {}, output: { v }, preliminary: true });
  const toolDones = (parts: unknown[]) =>
    run(parts).filter((e) => (e as { type: string }).type === "tool.done").map((e) => {
      const { seq: _seq, ...rest } = e as Record<string, unknown>;
      return rest;
    });
  const snapshot = (v: number) => ({
    type: "tool.done",
    turnId: "turn_vercel_1",
    toolCallId: "call_1",
    outcome: "ok",
    structuredContent: { v },
    content: [{ type: "text", text: JSON.stringify({ v }) }],
  });

  it("yields V1, yields V2, returns V2: two kept-open snapshots and a final snapshot with no more", () => {
    const parts = [...head, yielded(1), yielded(2), { type: "tool-result", toolCallId: "call_1", toolName: "gen", input: {}, output: { v: 2 } }];
    expect(toolDones(parts)).toEqual([
      { ...snapshot(1), more: true, preliminary: true },
      { ...snapshot(2), more: true, preliminary: true },
      snapshot(2),
    ]);
  });

  it("yields V1, then throws E: a final error with E's message and no more, no structuredContent", () => {
    const parts = [...head, yielded(1), { type: "tool-error", toolCallId: "call_1", toolName: "gen", input: {}, error: new Error("E") }];
    expect(toolDones(parts)).toEqual([
      { ...snapshot(1), more: true, preliminary: true },
      { type: "tool.done", turnId: "turn_vercel_1", toolCallId: "call_1", outcome: "error", isError: true, errorText: "E", content: [{ type: "text", text: "E" }] },
    ]);
  });

  it("both sequences fold to exactly their final result (the snapshot fold drops V1 on the throw)", () => {
    const fold = (parts: unknown[]) => {
      const r = new Reducer();
      for (const ev of run(parts)) r.push(ev);
      expect(r.needsResync).toBe(false);
      return r.result().messages.flatMap((m) => m.content).filter((b) => b.type === "tool-result");
    };
    expect(fold([...head, yielded(1), yielded(2), { type: "tool-result", toolCallId: "call_1", toolName: "gen", input: {}, output: { v: 2 } }])).toEqual([
      { type: "tool-result", toolCallId: "call_1", outcome: "ok", structuredContent: { v: 2 }, content: [{ type: "text", text: '{"v":2}' }] },
    ]);
    expect(fold([...head, yielded(1), { type: "tool-error", toolCallId: "call_1", toolName: "gen", input: {}, error: new Error("E") }])).toEqual([
      { type: "tool-result", toolCallId: "call_1", outcome: "error", isError: true, errorText: "E", content: [{ type: "text", text: "E" }] },
    ]);
  });
});

describe("emitted values are copies: a host mutating its part after push() changes no emitted event", () => {
  it("tool input and output, a carried frame, warnings and an unparsed native", () => {
    const n = createVercelNormalizer({ invokeId: "vercel" });
    const input = { q: { a: 1 } };
    const output = { r: { b: [1] } };
    const warnings = [{ type: "other", message: { m: "w" } }];
    const unknownPart = { type: "zz-future", payload: { k: { v: 1 } } };
    const notAPart = { payload: { k: { v: 1 } } };
    const out: AgEvent[] = [];
    for (const p of [
      { type: "start" },
      { type: "start-step", request: {}, warnings },
      { type: "tool-call", toolCallId: "c1", toolName: "t", input },
      { type: "tool-result", toolCallId: "c1", toolName: "t", input, output },
      unknownPart,
      notAPart,
    ]) out.push(...n.push(p));
    const before = JSON.stringify(out);
    input.q.a = 99;
    output.r.b.push(2);
    warnings[0]!.message.m = "changed";
    unknownPart.payload.k.v = 99;
    notAPart.payload.k.v = 99;
    expect(JSON.stringify(out)).toBe(before);
    // the sites the test covers really carry those values
    expect(before).toContain('"q":{"a":1}');
    expect(before).toContain('"r":{"b":[1]}');
  });
});

describe("MCP tool results (@ai-sdk/mcp): isError sets outcome error (V1); _meta.ui rides tool.done._meta (V4)", () => {
  const MCP = { clientName: "ai-sdk-mcp-client", toolName: "t" };
  const step = (calls: Array<{ id: string; output: unknown; toolMetadata?: unknown }>) => [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    ...calls.flatMap((c) => {
      const tm = c.toolMetadata !== undefined ? { toolMetadata: c.toolMetadata } : {};
      return [
        { type: "tool-call", toolCallId: c.id, toolName: "t", input: {}, dynamic: true, ...tm },
        { type: "tool-result", toolCallId: c.id, toolName: "t", input: {}, output: c.output, dynamic: true, ...tm },
      ];
    }),
    { type: "finish-step", finishReason: "tool-calls", rawFinishReason: "tool-calls", usage: USAGE, response: RESPONSE_S1 },
    { type: "finish", finishReason: "tool-calls", rawFinishReason: "tool-calls", totalUsage: USAGE },
  ];
  const done = (evs: AgEvent[], id: string) =>
    evs.find((e) => e.type === "tool.done" && (e as { toolCallId?: string }).toolCallId === id) as Record<string, unknown>;
  // The live shapes (tool-error-gpt6sol / app-spec-gpt6sol, ai 7.0.111 + @ai-sdk/mcp).
  const ERR = { content: [{ type: "text", text: '{"error":{"code":"E_MOCK","message":"boom"}}' }], isError: true };
  const UI = { resourceUri: "ui://mock/card", visibility: ["model"] };
  const APP = { _meta: { ui: UI }, content: [{ type: "text", text: "{}" }], structuredContent: { title: "Hello" }, isError: false };

  it("V1: each MCP isError result maps to outcome error + isError (two in one step), and an MCP ok result stays ok", () => {
    const evs = run(step([{ id: "c1", output: ERR, toolMetadata: MCP }, { id: "c2", output: ERR, toolMetadata: MCP }, { id: "c3", output: { content: [], isError: false }, toolMetadata: MCP }]));
    expectAllParse(evs);
    for (const id of ["c1", "c2"]) expect(done(evs, id)).toMatchObject({ outcome: "error", isError: true });
    expect(done(evs, "c3")["outcome"]).toBe("ok");
    expect("isError" in done(evs, "c3")).toBe(false);
    const results = reduce(evs).messages.flatMap((m) => m.content).filter((b) => b.type === "tool-result") as Array<{ toolCallId: string; isError?: boolean }>;
    expect(results.filter((b) => b.isError === true).map((b) => b.toolCallId)).toEqual(["c1", "c2"]);
  });

  it("V1: without the @ai-sdk/mcp stamp an MCP-shaped isError output stays ok (the shape alone is never the key)", () => {
    const d = done(run(step([{ id: "c1", output: ERR }])), "c1");
    expect(d["outcome"]).toBe("ok");
    expect("isError" in d).toBe(false);
  });

  it("V1: with the stamp but no CallToolResult shape (no content array) the result stays ok", () => {
    const d = done(run(step([{ id: "c1", output: { isError: true }, toolMetadata: MCP }])), "c1");
    expect(d["outcome"]).toBe("ok");
  });

  it("V4: MCP Apps _meta.ui rides tool.done._meta unchanged; structuredContent and content keep their shape", () => {
    const evs = run(step([{ id: "c1", output: APP, toolMetadata: MCP }]));
    expectAllParse(evs);
    const d = done(evs, "c1");
    expect(d["_meta"]).toEqual({ ui: UI });
    expect(d["outcome"]).toBe("ok");
    expect(d["structuredContent"]).toEqual(APP);
    expect(d["content"]).toEqual([{ type: "text", text: JSON.stringify(APP) }]);
  });

  it("V4: no _meta without the stamp, and none for an MCP result that carries no _meta.ui", () => {
    expect("_meta" in done(run(step([{ id: "c1", output: APP }])), "c1")).toBe(false);
    expect("_meta" in done(run(step([{ id: "c1", output: { content: [], _meta: { other: 1 } }, toolMetadata: MCP }])), "c1")).toBe(false);
  });
});

describe("Anthropic stop details (@ai-sdk/anthropic finish-step providerMetadata.anthropic.stopDetails): carried beside rawFinishReason, never a credit token", () => {
  const SENTINEL = "TOKEN-SENTINEL";
  const refusal = (stopDetails: unknown, withText = false) => [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    ...(withText ? [{ type: "text-start", id: "t0" }, { type: "text-delta", id: "t0", text: "I can't" }, { type: "text-end", id: "t0" }] : []),
    {
      type: "finish-step",
      response: { id: "msg_r1", modelId: "claude-sonnet-5", timestamp: new Date(0) },
      usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 },
      finishReason: "content-filter",
      rawFinishReason: "refusal",
      providerMetadata: { anthropic: { usage: {}, stopDetails } },
    },
    { type: "finish", finishReason: "content-filter", rawFinishReason: "refusal", totalUsage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 } },
  ];
  const metadataOf = (evs: AgEvent[]) => (evs.find((e) => e.type === "message.metadata") as { metadata: Record<string, unknown> } | undefined)?.metadata;

  it("carries the provider's stopDetails verbatim onto the step's message metadata, beside rawFinishReason, and it folds onto that message", () => {
    const sd = { type: "refusal", category: "bio", explanation: "p", recommendedModel: "m" };
    for (const withText of [false, true]) {
      const evs = run(refusal(sd, withText));
      expect(metadataOf(evs)).toEqual({ responseId: "msg_r1", model: "claude-sonnet-5", rawFinishReason: "refusal", stopDetails: sd });
      const folded = foldBatch(evs);
      expect(folded.needsResync).toBe(false);
      expect(folded.result.messages[0]!.metadata).toEqual({ responseId: "msg_r1", model: "claude-sonnet-5", rawFinishReason: "refusal", stopDetails: sd });
    }
  });

  it("never emits a provider credit token, in either spelling, at any depth, while keeping everything else verbatim", () => {
    const sd = {
      type: "refusal",
      recommendedModel: "m",
      fallback_credit_token: SENTINEL,
      fallbackCreditToken: SENTINEL,
      deep: { fallback_credit_token: SENTINEL, list: [{ fallbackCreditToken: SENTINEL, keep: 1 }] },
    };
    const evs = run(refusal(sd));
    expect(JSON.stringify(evs)).not.toContain(SENTINEL);
    expect(JSON.stringify(foldBatch(evs).result)).not.toContain(SENTINEL);
    expect(metadataOf(evs)!["stopDetails"]).toEqual({ type: "refusal", recommendedModel: "m", deep: { list: [{ keep: 1 }] } });
  });

  it("emits no stopDetails key when the provider reports none (every other finish-step is unchanged)", () => {
    for (const pm of [undefined, { anthropic: { usage: {} } }, { anthropic: { stopDetails: null } }, { openai: { responseId: "x" } }]) {
      const parts = refusal(undefined).map((p) => (p.type === "finish-step" ? { ...p, providerMetadata: pm } : p));
      const meta = metadataOf(run(parts))!;
      expect("stopDetails" in meta).toBe(false);
      expect(meta["rawFinishReason"]).toBe("refusal");
    }
  });
});

describe("threadId option (partition root): the host's id everywhere, else the placeholder \"vercel\"", () => {
  const toolRun = [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [{ type: "other", message: "w" }] },
    { type: "tool-input-start", id: "call_1", toolName: "echo", dynamic: false },
    { type: "tool-input-end", id: "call_1" },
    { type: "tool-call", toolCallId: "call_1", toolName: "echo", input: { text: "hi" } },
    { type: "tool-result", toolCallId: "call_1", toolName: "echo", input: { text: "hi" }, output: { result: "echo: hi" }, dynamic: false },
    { type: "finish-step", finishReason: "tool-calls", rawFinishReason: "tool-calls", usage: USAGE, response: { id: "r1", timestamp: "1970-01-01T00:00:00.000Z", modelId: "m" } },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "echo: hi" },
    { type: "text-end", id: "t1" },
    { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage: USAGE, response: { id: "r2", timestamp: "1970-01-01T00:00:00.000Z", modelId: "m" } },
    { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: USAGE },
  ];
  const runWith = (opts: { threadId?: string }) => {
    const n = createVercelNormalizer({ invokeId: "vercel", ...opts });
    const out: AgEvent[] = [];
    for (const p of toolRun) out.push(...n.push(p));
    out.push(...n.flush());
    return out;
  };
  const threadIds = (v: unknown, acc: string[] = []): string[] => {
    if (Array.isArray(v)) for (const x of v) threadIds(x, acc);
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) (k === "threadId" && typeof x === "string" ? acc.push(x) : threadIds(x, acc));
    return acc;
  };

  it("with threadId, every threadId on the wire and in the fold is the host's, and the ext namespace stays ext.vercel", () => {
    const evs = runWith({ threadId: "conv-42" });
    expectAllParse(evs);
    const wire = threadIds(evs);
    expect(wire.length).toBeGreaterThan(0);
    expect(new Set(wire)).toEqual(new Set(["conv-42"]));
    const folded = reduce(evs);
    expect(new Set(threadIds(folded))).toEqual(new Set(["conv-42"]));
    expect(folded.messages.length).toBeGreaterThanOrEqual(2);
    expect(evs.some((e) => e.type === "ext.vercel.warnings")).toBe(true);
    expect(evs.filter((e) => e.type.startsWith("ext.")).every((e) => e.type.startsWith("ext.vercel."))).toBe(true);
  });

  it("without threadId, every threadId is the placeholder \"vercel\" and the output is byte-identical to before the option existed", () => {
    const evs = runWith({});
    expect(new Set(threadIds(evs))).toEqual(new Set(["vercel"]));
    expect(JSON.stringify(runWith({ threadId: undefined }))).toBe(JSON.stringify(evs));
  });
});
