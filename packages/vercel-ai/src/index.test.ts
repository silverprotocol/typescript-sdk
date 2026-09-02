/**
 * Fixture suite for `@silverprotocol/vercel-ai`.
 *
 * Every native sequence below was CAPTURED from real ai@7.0.26 fullStream
 * output (keyless MockLanguageModelV3 runs, 2026-07-20 — generator preserved
 * in the private workspace validation kit). They are pasted verbatim except
 * that the bulky derived `performance` bag on finish-step is trimmed
 * everywhere but F1 (kept there to prove extra-field tolerance).
 */
import { describe, expect, it } from "vitest";
import { AgEvent, Reducer } from "@silverprotocol/core";
import { VERCEL_HOST_ERROR, createVercelNormalizer } from "./index.js";

function run(parts: unknown[]): AgEvent[] {
  const n = createVercelNormalizer();
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
