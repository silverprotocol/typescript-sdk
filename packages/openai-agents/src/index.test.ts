import { describe, it, expect, vi } from "vitest";
import { AgEvent, AgProviderMeta, AgReduceResult, JsonValue, Reducer, StreamAssembler } from "@silverprotocol/core";
import { createOpenaiNormalizer, mapFinishReason } from "./index.js";

describe("mapFinishReason", () => {
  it("maps the OpenAI finish/incomplete reasons to the AgFinishReason superset", () => {
    expect(mapFinishReason(undefined)).toBe("stop");
    expect(mapFinishReason("max_output_tokens")).toBe("token_limit");
    expect(mapFinishReason("content_filter")).toBe("safety_blocked");
    expect(mapFinishReason("max_tokens")).toBe("token_limit");
    expect(mapFinishReason("something_else")).toBe("unknown");
  });
});

// OA-15 — `turn.done.finishReasonRaw` (draft.4: SPEC.md §8.0 graceful
// degradation + §10 item 23, sp-protocol 89c57db). Set ONLY when the mapped
// finishReason is a fallback ("other"/"unknown"), carrying the native value byte
// for byte; a real mapping (max_output_tokens → token_limit, …) sets nothing.
describe("createOpenaiNormalizer — OA-15 turn.done.finishReasonRaw", () => {
  function closeWith(response: { [k: string]: JsonValue }): AgEvent[] {
    const n = createOpenaiNormalizer();
    return [
      rawModel({ type: "response.created", response: { id: "resp_oa15" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_oa15", delta: "hi" }),
      rawModel({ type: "response.completed", response: { id: "resp_oa15", status: "completed", ...response } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
  }
  function turnDone(evs: AgEvent[]): AgEvent | undefined {
    return evs.find((e) => e.type === "turn.done");
  }

  it("§10 item 23: an unmapped native reason ⇒ finishReason fallback + finishReasonRaw verbatim; every event passes AgEvent.parse", () => {
    const evs = closeWith({ incomplete_details: { reason: "zz" } });
    expect(turnDone(evs)).toMatchObject({ finishReason: "unknown", finishReasonRaw: "zz" });
    for (const e of evs) expect(() => AgEvent.parse(e)).not.toThrow();
  });

  it("byte for byte: the native value is carried untouched (case, punctuation, unicode)", () => {
    expect(turnDone(closeWith({ incomplete_details: { reason: "Max_Messages—v2 ✓" } }))).toMatchObject({
      finishReason: "unknown",
      finishReasonRaw: "Max_Messages—v2 ✓",
    });
  });

  it.each([
    ["no reason (plain completed)", {}, "stop"],
    ["max_output_tokens", { incomplete_details: { reason: "max_output_tokens" } }, "token_limit"],
    ["max_tokens", { incomplete_details: { reason: "max_tokens" } }, "token_limit"],
    ["stop", { incomplete_details: { reason: "stop" } }, "stop"],
  ])("a MAPPED reason sets no finishReasonRaw — %s", (_label, response, mapped) => {
    const done = turnDone(closeWith(response));
    expect(done).toMatchObject({ finishReason: mapped });
    expect(done).not.toHaveProperty("finishReasonRaw");
  });

  it("content_filter (mapped safety path) sets no finishReasonRaw", () => {
    const done = turnDone(closeWith({ incomplete_details: { reason: "content_filter" } }));
    expect(done).toMatchObject({ finishReason: "safety_blocked" });
    expect(done).not.toHaveProperty("finishReasonRaw");
  });

  it("fold: the turn record carries finishReasonRaw", () => {
    const r = new Reducer();
    for (const e of closeWith({ incomplete_details: { reason: "zz" } })) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns[0]).toMatchObject({ finishReason: "unknown", finishReasonRaw: "zz" });
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stateful createOpenaiNormalizer — A1 §5-6 (turn anchoring + text path).
//
// The corpus below is a faithful TRIM of the real `@openai/agents` capture
// (`/tmp/openai-spike-toolturn.json`, second response) down to a single text
// turn. It deliberately INCLUDES the SDK's redundant representations — the
// `response_started` literal, the duplicated flattened `output_text_delta`
// literal alongside each real `response.output_text.delta`, the `response_done`
// literal, and the DUPLICATE 2nd `response.completed` — so the test pins that
// the stateful normalizer drives the engine from the single authoritative
// source per concern and ignores the rest (no triple-counted text, exactly one
// turn close). Native inputs are plain `JsonValue` object literals (no cast):
// `push` takes `JsonValue`.
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_TURN: JsonValue[] = [
  // SDK turn-start literal (IGNORE — duplicate of response.created).
  { type: "raw_model_stream_event", data: { type: "response_started" } },
  // Authoritative turn open: real response.id present at start.
  {
    type: "raw_model_stream_event",
    data: { type: "model", event: { type: "response.created", response: { id: "resp_text_1" } } },
  },
  // In-progress duplicate (IGNORE).
  {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: { type: "response.in_progress", response: { id: "resp_text_1" } },
    },
  },
  // First real text delta (item_id-keyed) + its flattened duplicate (IGNORE).
  { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "Hel" } },
  {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: { type: "response.output_text.delta", item_id: "msg_text_1", delta: "Hel" },
    },
  },
  // Second real text delta + its flattened duplicate (IGNORE).
  { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "lo" } },
  {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: { type: "response.output_text.delta", item_id: "msg_text_1", delta: "lo" },
    },
  },
  // Text end.
  {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: { type: "response.output_text.done", item_id: "msg_text_1", text: "Hello" },
    },
  },
  // SDK turn terminator literal (IGNORE — duplicate of response.completed).
  { type: "raw_model_stream_event", data: { type: "response_done" } },
  // Authoritative close (#1).
  {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: {
        type: "response.completed",
        response: {
          id: "resp_text_1",
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      },
    },
  },
  // DUPLICATE 2nd response.completed (IGNORE — close-once guard).
  {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: {
        type: "response.completed",
        response: {
          id: "resp_text_1",
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      },
    },
  },
];

describe("createOpenaiNormalizer — text turn", () => {
  it("opens a turn at response start and emits assembled text under it (I1)", () => {
    const n = createOpenaiNormalizer();
    const evs = TEXT_TURN.flatMap((e) => n.push(e)).concat(n.flush());

    // (1) turn anchored to the real response.id.
    const start = evs.find((e) => e.type === "turn.start");
    expect(start).toMatchObject({ turnId: "turn_resp_text_1" });

    // (2) every text.delta resolves to that turn (I1).
    const text = evs.filter((e) => e.type === "text.delta");
    expect(text.length).toBeGreaterThan(0);
    expect(text.every((e) => "turnId" in e && e.turnId === "turn_resp_text_1")).toBe(true);

    // (3) turn.start precedes the first text.delta in emitted order (I1 ordering).
    const startIdx = evs.findIndex((e) => e.type === "turn.start");
    const firstTextIdx = evs.findIndex((e) => e.type === "text.delta");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(firstTextIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeLessThan(firstTextIdx);
  });

  it("ignores the flattened output_text_delta duplicate (no double-counted text)", () => {
    const n = createOpenaiNormalizer();
    const evs = TEXT_TURN.flatMap((e) => n.push(e)).concat(n.flush());
    // The corpus carries TWO flattened `output_text_delta` literals alongside the
    // two real `response.output_text.delta` events. Only the real (item_id-keyed)
    // ones drive the engine → exactly two text.delta events, not four.
    const deltas = evs.filter((e) => e.type === "text.delta");
    expect(deltas).toHaveLength(2);
    const reassembled = deltas
      .map((e) => ("delta" in e && typeof e.delta === "string" ? e.delta : ""))
      .join("");
    expect(reassembled).toBe("Hello");
  });

  it("closes the turn exactly once despite the duplicate response.completed", () => {
    const n = createOpenaiNormalizer();
    const evs = TEXT_TURN.flatMap((e) => n.push(e)).concat(n.flush());
    const closes = evs.filter((e) => e.type === "turn.done" || e.type === "turn.error");
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ type: "turn.done", turnId: "turn_resp_text_1" });
  });

  it("fold-identity: reducing the AgEvent stream yields exactly one successful assistant turn", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of TEXT_TURN) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    const res = r.result();
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0]).toMatchObject({ outcome: { type: "success" } });
    expect(r.needsResync).toBe(false);
  });
});

describe("createOpenaiNormalizer — cache_write_tokens usage detail (openai ≥6.46 / GPT-5.6-era wire)", () => {
  it("maps usage.input_tokens_details.cache_write_tokens → turn.done usage.cacheWriteTokens", () => {
    // openai 6.46 adds `cache_write_tokens` as a REQUIRED member of
    // `ResponseUsage.InputTokensDetails` (responses.d.ts:5894; absent ≤6.44) —
    // shipped to this normalizer's seam by @openai/agents 0.13.2's ^6.46 pin.
    // AgUsage.cacheWriteTokens existed all along (core agjson.ts:176); this
    // pins that the wire detail lands there instead of being dropped.
    const WRITE_USAGE_TURN: JsonValue[] = [
      ...TEXT_TURN.slice(0, 8), // through response.output_text.done
      {
        type: "raw_model_stream_event",
        data: {
          type: "model",
          event: {
            type: "response.completed",
            response: {
              id: "resp_text_1",
              status: "completed",
              usage: {
                input_tokens: 5,
                input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
                output_tokens: 2,
                total_tokens: 7,
              },
            },
          },
        },
      },
    ];
    const n = createOpenaiNormalizer();
    const evs = WRITE_USAGE_TURN.flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({
      type: "turn.done",
      turnId: "turn_resp_text_1",
      usage: { cumulative: false, inputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
    });
  });
});

describe("createOpenaiNormalizer — INV-FLUSH truncation (audit M21)", () => {
  it("flush() aborts a dangling turn as stream-truncated when response.completed never arrives (no stashed close)", () => {
    // Truncate BEFORE any native close signal (`response.completed` /
    // `.incomplete` / `.failed`) ever arrives — the NO-stash case (contrast
    // with Task 4b's deferred-close stash, which replays a REAL turn.done at
    // flush() when a tool result never lands for an already-completed round).
    // Here the round itself never completed on the wire, so `flush()` must
    // truthfully abort the still-open turn, never fabricate success.
    const n = createOpenaiNormalizer();
    const TRUNCATED = TEXT_TURN.slice(0, 8); // through response.output_text.done; no response.completed
    const pushed = TRUNCATED.flatMap((e) => n.push(e));
    const flushed = n.flush();
    const out = [...pushed, ...flushed];
    const msgEnd = out.findIndex((e) => e.type === "message.end");
    const abort = out.findIndex((e) => e.type === "turn.abort");
    expect(msgEnd).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(msgEnd);
    expect(out[abort]).toMatchObject({
      type: "turn.abort",
      turnId: "turn_resp_text_1",
      reason: "stream-truncated",
    });
    expect(out.some((e) => e.type === "turn.done")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stateful createOpenaiNormalizer — T5b: tools path over engine
//
// Uses REAL shapes from /tmp/openai-spike-toolturn.json:
//   - response.output_item.added (function_call) with snake_case call_id
//   - response.function_call_arguments.delta/.done (fc_-keyed)
//   - tool_output run-item with item.output carrying structuredContent
//
// BINDING canonical model (plan §"Spike Findings"):
//   - toolStart ← model:response.output_item.added (item.type==="function_call")
//   - toolArgsDelta/toolArgsAssembled ← function_call_arguments.delta/.done
//   - toolDone ← tool_output run-item (structuredContent from item.output)
//   - IGNORE tool_called run-item (superseded by output_item.added)
// ─────────────────────────────────────────────────────────────────────────────

// Minimal tool turn trimmed from the real spike capture.
// Uses output_item.added (snake_case call_id) as authoritative toolStart source.
const TOOL_TURN: JsonValue[] = [
  // Authoritative turn open.
  {
    type: "raw_model_stream_event",
    data: { type: "model", event: { type: "response.created", response: { id: "resp_tool_1" } } },
  },
  // Authoritative tool start: response.output_item.added with function_call item.
  // Real shape from /tmp/openai-spike-toolturn.json: call_id is snake_case.
  {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: {
        type: "response.output_item.added",
        item: {
          id: "fc_spike_1",
          type: "function_call",
          status: "in_progress",
          arguments: "",
          call_id: "call_spike_1",
          name: "render_card",
        },
      },
    },
  },
  // Args delta fragments (fc_-keyed).
  {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: { type: "response.function_call_arguments.delta", item_id: "fc_spike_1", delta: '{"q"' },
    },
  },
  {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: {
        type: "response.function_call_arguments.delta",
        item_id: "fc_spike_1",
        delta: ':"x"}',
      },
    },
  },
  // Args done — full assembled JSON string.
  {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: {
        type: "response.function_call_arguments.done",
        item_id: "fc_spike_1",
        arguments: '{"q":"x"}',
      },
    },
  },
  // tool_called run-item — MUST be IGNORED (superseded by output_item.added).
  {
    type: "run_item_stream_event",
    name: "tool_called",
    item: {
      type: "tool_call_item",
      rawItem: {
        type: "function_call",
        callId: "call_spike_1",
        name: "render_card",
        arguments: '{"q":"x"}',
        status: "completed",
        id: "fc_spike_1",
      },
    },
  },
  // tool_output run-item — authoritative toolDone source.
  // item.output carries structuredContent (ggui cache marker).
  {
    type: "run_item_stream_event",
    name: "tool_output",
    item: {
      type: "tool_call_output_item",
      rawItem: {
        type: "function_call_result",
        name: "render_card",
        callId: "call_spike_1",
        status: "completed",
        output: "rendered",
      },
      output: { structuredContent: { cache: { hit: true } } },
    },
  },
  // Authoritative turn close.
  {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: {
        type: "response.completed",
        response: {
          id: "resp_tool_1",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    },
  },
];

describe("createOpenaiNormalizer — tools path (T5b)", () => {
  it("emits tool.start with call_id as toolCallId (NOT fc_ id) from output_item.added", () => {
    const n = createOpenaiNormalizer();
    const evs = TOOL_TURN.flatMap((e) => n.push(e)).concat(n.flush());
    const start = evs.find((e) => e.type === "tool.start");
    expect(start).toBeDefined();
    expect(start).toMatchObject({ name: "render_card", toolCallId: "call_spike_1" });
    // toolCallId must be the call_id (call_spike_1), NOT the fc_ id (fc_spike_1).
    expect((start as { toolCallId?: string }).toolCallId).not.toBe("fc_spike_1");
  });

  it("does NOT emit a duplicate tool.start from the tool_called run-item (IGNORED)", () => {
    const n = createOpenaiNormalizer();
    const evs = TOOL_TURN.flatMap((e) => n.push(e)).concat(n.flush());
    const starts = evs.filter((e) => e.type === "tool.start");
    // Exactly ONE tool.start — from output_item.added only.
    expect(starts).toHaveLength(1);
  });

  it("emits tool.args.assembled with parsed input from function_call_arguments.done", () => {
    const n = createOpenaiNormalizer();
    const evs = TOOL_TURN.flatMap((e) => n.push(e)).concat(n.flush());
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toBeDefined();
    expect(assembled).toMatchObject({ toolCallId: "call_spike_1", input: { q: "x" } });
  });

  it("emits tool.done with structuredContent from item.output (cache marker)", () => {
    const n = createOpenaiNormalizer();
    const evs = TOOL_TURN.flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as {
      toolCallId?: string;
      outcome?: string;
      structuredContent?: { cache?: { hit?: boolean } };
    };
    expect(done).toBeDefined();
    expect(done?.toolCallId).toBe("call_spike_1");
    expect(done?.outcome).toBe("ok");
    expect(done?.structuredContent?.cache?.hit).toBe(true);
  });

  it("fold-identity: reducing the tool turn yields tool-call + tool-result blocks", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of TOOL_TURN) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    expect(res.turns).toHaveLength(1);
    // Tool-call block (input).
    const allBlocks = res.messages.flatMap((m) => m.content);
    const toolCallBlock = allBlocks.find((b) => b.type === "tool-call");
    expect(toolCallBlock).toMatchObject({ type: "tool-call", name: "render_card", input: { q: "x" } });
    // Tool-result block with structuredContent.
    const toolResultBlock = allBlocks.find((b) => b.type === "tool-result");
    expect(toolResultBlock).toMatchObject({ type: "tool-result" });
    expect(
      (toolResultBlock as { structuredContent?: { cache?: { hit?: boolean } } }).structuredContent
        ?.cache?.hit,
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M46 — function_call_arguments.done never crashes out of push() (audit
// M46 / §2.B). Three reproduced crash paths on the raw `.done.arguments`
// field: empty string and truncated JSON both threw `SyntaxError` out of
// `JSON.parse`; an ABSENT `arguments` field (typed required, but this is the
// deserialization boundary — a nonconforming provider such as OpenRouter can
// omit it) threw `TypeError` at `.length`. All three now degrade per Tenet 6:
// `push()` never throws, a best-effort `tool.args.assembled` with `input:{}`
// keeps the tool-call block fold-coherent, and the untouched raw signal (or
// an explicit `null` absent-marker, distinguishing "field omitted" from
// "field arrived empty") rides losslessly on `ext.openai.unparsed`. A fourth
// control pins that valid arguments still behave exactly as today (parsed
// input, no unparsed emission).
//
// `driveRawResponsesEvent`'s `function_call_arguments.done` arm is reached
// ONLY via `raw_model_stream_event` → `data.type === "model"` (the `drive()`
// switch's default arm silently ignores the SDK's flattened-duplicate
// literals — `response_started` / `output_text_delta` / `response_done` —
// and there is no flattened-duplicate literal for tool-call-argument events),
// so this IS the single-sourced path `push()` actually drives; there is no
// bypass route for a malformed `.done` event to reach the engine unguarded.
// ─────────────────────────────────────────────────────────────────────────────

// A minimal realistic tool turn: open → tool start → the (possibly
// malformed) `.done` event under test → native close. No delta events
// precede it, so the instance argument buffer is empty and the fallback
// path (buffered content) never masks the failure under test.
function argsDoneTurn(itemId: string, callId: string, doneEvent: JsonValue): JsonValue[] {
  const respId = `resp_${callId}`;
  return [
    rawModel({ type: "response.created", response: { id: respId } }),
    rawModel({
      type: "response.output_item.added",
      item: {
        id: itemId,
        type: "function_call",
        status: "in_progress",
        arguments: "",
        call_id: callId,
        name: "render_card",
      },
    }),
    rawModel(doneEvent),
    rawModel({ type: "response.completed", response: { id: respId, status: "completed" } }),
  ];
}

describe("createOpenaiNormalizer — function_call_arguments.done never crashes out of push() (audit M46)", () => {
  it("(a) empty-string arguments: push() does not throw; degrades to input:{} + ext.openai.unparsed carrying the empty string", () => {
    const n = createOpenaiNormalizer();
    const turn = argsDoneTurn("fc_empty_1", "call_empty_1", {
      type: "response.function_call_arguments.done",
      item_id: "fc_empty_1",
      arguments: "",
    });
    let evs: AgEvent[] = [];
    expect(() => {
      evs = turn.flatMap((e) => n.push(e)).concat(n.flush());
    }).not.toThrow();

    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "call_empty_1", input: {} });

    const unparsed = evs.find((e) => e.type === "ext.openai.unparsed") as
      | { itemId?: unknown; arguments?: unknown }
      | undefined;
    expect(unparsed).toBeDefined();
    expect(unparsed?.itemId).toBe("fc_empty_1");
    expect(unparsed?.arguments).toBe("");
  });

  it("(b) truncated JSON arguments: push() does not throw; degrades to input:{} + ext.openai.unparsed carrying the truncated string verbatim", () => {
    const n = createOpenaiNormalizer();
    const truncated = '{"a": tru';
    const turn = argsDoneTurn("fc_trunc_1", "call_trunc_1", {
      type: "response.function_call_arguments.done",
      item_id: "fc_trunc_1",
      arguments: truncated,
    });
    let evs: AgEvent[] = [];
    expect(() => {
      evs = turn.flatMap((e) => n.push(e)).concat(n.flush());
    }).not.toThrow();

    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "call_trunc_1", input: {} });

    const unparsed = evs.find((e) => e.type === "ext.openai.unparsed") as
      | { itemId?: unknown; arguments?: unknown }
      | undefined;
    expect(unparsed).toBeDefined();
    expect(unparsed?.itemId).toBe("fc_trunc_1");
    expect(unparsed?.arguments).toBe(truncated);
  });

  it("(c) ABSENT arguments field: push() does not throw; degrades to input:{} + ext.openai.unparsed carrying a null absent-marker", () => {
    const n = createOpenaiNormalizer();
    // No `arguments` key at all — a nonconforming provider's payload. `push`
    // takes `JsonValue`, so this is a genuine (not cast-forced) boundary input.
    const turn = argsDoneTurn("fc_absent_1", "call_absent_1", {
      type: "response.function_call_arguments.done",
      item_id: "fc_absent_1",
    });
    let evs: AgEvent[] = [];
    expect(() => {
      evs = turn.flatMap((e) => n.push(e)).concat(n.flush());
    }).not.toThrow();

    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "call_absent_1", input: {} });

    const unparsed = evs.find((e) => e.type === "ext.openai.unparsed") as
      | { itemId?: unknown; arguments?: unknown }
      | undefined;
    expect(unparsed).toBeDefined();
    expect(unparsed?.itemId).toBe("fc_absent_1");
    // Distinct from case (a)'s `""` — the field never arrived at all.
    expect(unparsed?.arguments).toBeNull();
  });

  it("(control) valid arguments: behaves exactly as today — parsed input, no unparsed emission", () => {
    const n = createOpenaiNormalizer();
    const turn = argsDoneTurn("fc_valid_1", "call_valid_1", {
      type: "response.function_call_arguments.done",
      item_id: "fc_valid_1",
      arguments: '{"q":"x"}',
    });
    const evs = turn.flatMap((e) => n.push(e)).concat(n.flush());

    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "call_valid_1", input: { q: "x" } });
    expect(evs.find((e) => e.type === "ext.openai.unparsed")).toBeUndefined();
  });

  // Reducer-level fold-identity assertion (Task 2b, core-wide fix): a
  // Reducer-level assertion here was previously tried and DROPPED because
  // `reduce()`'s `isClosedEvent` guard returned before updating `#lastSeq`
  // for ext events, so the `ext.openai.unparsed` emission mid-degrade made
  // the following closed event (`tool.args.assembled`) look like a forward
  // seq gap and false-parked the whole fold (reduce.ts push()). That reducer
  // defect is now fixed at its root (seq accounting is universal — every
  // event, folded or not, advances #lastSeq) — this test proves the shipped
  // M46 degrade path (`tool.start, ext.openai.unparsed, tool.args.assembled,
  // …, turn.done`) folds clean end to end.
  it("(reducer fold) the full M46 degrade path (tool.start, ext.openai.unparsed, tool.args.assembled, …, turn.done) folds clean through Reducer — needsResync===false (Task 2b core fix)", () => {
    const n = createOpenaiNormalizer();
    const turn = argsDoneTurn("fc_empty_2", "call_empty_2", {
      type: "response.function_call_arguments.done",
      item_id: "fc_empty_2",
      arguments: "",
    });
    const evs = turn.flatMap((e) => n.push(e)).concat(n.flush());

    // Sanity: the degrade path actually includes a live-only ext emission
    // sandwiched between closed events — otherwise this test wouldn't be
    // exercising the false-park bug at all.
    expect(evs.some((e) => e.type === "ext.openai.unparsed")).toBe(true);

    const r = new Reducer();
    for (const ev of evs) r.push(ev);

    expect(r.needsResync).toBe(false);

    const result = r.result();
    expect(() => AgReduceResult.parse(result)).not.toThrow();

    const turnRecord = result.turns[0];
    expect(turnRecord).toBeDefined();
    // O1 (the honest flush): this round's tool result never arrives, so its
    // deferred success close is released at flush as turn.abort (its usage
    // moves to message.end) — an aborted outcome, and no finishReason.
    expect(turnRecord?.outcome).toMatchObject({ type: "aborted" });
    expect(turnRecord?.finishReason).toBeUndefined();

    const toolCallBlock = result.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool-call" && b.toolCallId === "call_empty_2");
    expect(toolCallBlock).toMatchObject({ input: {} });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 4b — defer a round's close past its pending tool results (INV-MSG).
//
// On the real OpenAI/OpenRouter wire, the `tool_output` run-item arrives AFTER
// `response.completed` (verified by the #128 spike capture — see
// or-responses-regression.test.ts). Forwarding native order verbatim emits
// `tool.done` on an already-closed turn, which `reduce()` correctly parks
// (SPEC §5.0 INV-MSG). Deferring `turn.done` ALONE is not sufficient: reduce()'s
// `message.end` handler also clears the message's open-pointer unconditionally
// (independent of turn state), so a `tool.done` landing after `message.end`
// resync-parks just the same. The facet must stash the round's ENTIRE close —
// message.end AND turn.done — until its pending tool results have landed, then
// replay both immediately after the draining `tool.done` (same push() batch;
// message.end first, so the reducer's INV-MSG binding window never sees a
// block-creating event target a sealed message OR a closed turn) — or, if the
// result never arrives, at `flush()` (the round genuinely completed on the wire).
// ─────────────────────────────────────────────────────────────────────────────

// A tool round trimmed to the REAL late-arrival order: response.completed
// fires BEFORE the tool_output run-item (unlike the T5b `TOOL_TURN` fixture
// above, which — like the real SDK's run-item dispatch in most captures —
// happens to enqueue tool_output first; this fixture pins the problematic
// order explicitly).
const TOOL_TURN_LATE_RESULT: JsonValue[] = [
  rawModel({ type: "response.created", response: { id: "resp_late_1" } }),
  rawModel({
    type: "response.output_item.added",
    item: {
      id: "fc_late_1",
      type: "function_call",
      status: "in_progress",
      arguments: "",
      call_id: "call_late_1",
      name: "get_weather",
    },
  }),
  rawModel({
    type: "response.function_call_arguments.delta",
    item_id: "fc_late_1",
    delta: '{"city":',
  }),
  rawModel({
    type: "response.function_call_arguments.delta",
    item_id: "fc_late_1",
    delta: '"Paris"}',
  }),
  rawModel({
    type: "response.function_call_arguments.done",
    item_id: "fc_late_1",
    arguments: '{"city":"Paris"}',
  }),
  // Native round-close arrives BEFORE the tool_output run-item — the real-wire
  // bug order this task fixes.
  rawModel({
    type: "response.completed",
    response: {
      id: "resp_late_1",
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }),
  // tool_output arrives LATE (after response.completed).
  runItem("tool_output", {
    type: "tool_call_output_item",
    rawItem: {
      type: "function_call_result",
      name: "get_weather",
      callId: "call_late_1",
      status: "completed",
      output: "21C and sunny",
    },
    output: "21C and sunny",
  }),
];

describe("createOpenaiNormalizer — defer turn.done past pending tool results (Task 4b, INV-MSG)", () => {
  it("late tool_output (after response.completed) ⇒ drained order ends …, tool.done, message.end, turn.done", () => {
    const n = createOpenaiNormalizer();
    const evs = TOOL_TURN_LATE_RESULT.flatMap((e) => n.push(e)).concat(n.flush());
    const types = evs.map((e) => e.type);

    // The ENTIRE close (message.end + turn.done) is deferred past the late
    // tool.done — NOT emitted at response.completed time (which is where
    // native order would place it).
    expect(types).toEqual([
      "turn.start",
      "message.start",
      "tool.start",
      "tool.args.delta",
      "tool.args.delta",
      "tool.args.assembled",
      "tool.done",
      "message.end",
      "turn.done",
    ]);

    // Full fold: no resync-park, tool-result attached inside the (one) turn.
    const r = new Reducer();
    const fn = createOpenaiNormalizer();
    for (const e of TOOL_TURN_LATE_RESULT) for (const ev of fn.push(e)) r.push(ev);
    for (const ev of fn.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0]).toMatchObject({ finishReason: "stop", outcome: { type: "success" } });
    const toolResult = res.messages.flatMap((m) => m.content).find((b) => b.type === "tool-result") as {
      content?: Array<{ type?: string; text?: string }>;
      outcome?: string;
    };
    expect(toolResult).toBeDefined();
    expect(toolResult?.outcome).toBe("ok");
    expect(toolResult?.content?.[0]).toMatchObject({ type: "text", text: "21C and sunny" });
    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });

  // O1 (sp-protocol's fold/flush package, A.5 INV-TURN/INV-FLUSH + A.6 openai;
  // founder: Q1 option 1, "honest flush"): a flush NEVER emits a success
  // turn.done. A close deferred under §8.0 item 14 is released as `paused` (an
  // approval ask outstanding), verbatim (a non-success outcome), or else as
  // message.end carrying the round's usage, then turn.abort{stream-truncated}.
  it("O1 — tool_output never arrives, no approval ask ⇒ flush releases message.end carrying the round's usage, then turn.abort{stream-truncated} — never a success turn.done", () => {
    const n = createOpenaiNormalizer();
    const withoutToolOutput = TOOL_TURN_LATE_RESULT.slice(0, -1);
    const evs = withoutToolOutput.flatMap((e) => n.push(e)).concat(n.flush());
    const types = evs.map((e) => e.type);
    expect(types).not.toContain("tool.done");
    expect(types).not.toContain("turn.done");
    const end = evs.find((e) => e.type === "message.end");
    expect(end).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } });
    const abort = evs.find((e) => e.type === "turn.abort");
    expect(abort).toMatchObject({ turnId: "turn_resp_late_1", reason: "stream-truncated" });
    expect(types.indexOf("message.end")).toBeLessThan(types.indexOf("turn.abort"));
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns[0]).toMatchObject({ outcome: { type: "aborted" } });
  });

  it("a no-tools round closes turn.done immediately — deferral never engages", () => {
    const n = createOpenaiNormalizer();
    const evs = TEXT_TURN.flatMap((e) => n.push(e)).concat(n.flush());
    // Identical to the pre-Task-4b order (TEXT_TURN has no tool calls, so the
    // pending set is always empty — closeTurnDone is never deferred).
    expect(evs.map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.delta",
      "text.end",
      "message.end",
      "turn.done",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stateful createOpenaiNormalizer — T5c: errors / incomplete / refusal /
// __host_error__ sentinel + citations supplement.
//
// Canonical model (plan §"Spike Findings"):
//   - response.incomplete (non-refusal)  → turn.error{code:reason, usage}
//   - response.incomplete (content_filter) → turn.done error-outcome + safety
//   - response.failed                    → turn.error{code, message, usage}
//   - response.completed + pending refusal → turn.done finishReason:"refusal"
//   - __host_error__ sentinel (host feeds on MaxTurnsExceededError) →
//       turn.error{code:"max_turns", usage}; turn open → close it,
//       no turn open → open+close a fresh terminal turn.
//   - message_output_created → citations supplement ONLY (no text re-emit).
// ─────────────────────────────────────────────────────────────────────────────

function rawModel(event: JsonValue): JsonValue {
  return { type: "raw_model_stream_event", data: { type: "model", event } };
}

// A `run_item_stream_event` envelope (the SDK's semantic run-item wrapper). Typed
// `JsonValue` so the literals stay cast-free at the `push(native: JsonValue)` seam.
function runItem(name: string, item: JsonValue): JsonValue {
  return { type: "run_item_stream_event", name, item };
}

// The synthetic `__host_error__` terminal sentinel the host feeds on
// `MaxTurnsExceededError`. Returns `JsonValue` — cast-free native input.
function hostError(code: string, message: string, usage?: JsonValue): JsonValue {
  return usage !== undefined
    ? { type: "__host_error__", code, message, usage }
    : { type: "__host_error__", code, message };
}

describe("createOpenaiNormalizer — response.incomplete error arm (T5c)", () => {
  it("response.incomplete(max_turns-style) → turn.error with code + usage", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_inc_1" } }),
      rawModel({
        type: "response.incomplete",
        response: {
          id: "resp_inc_1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 8, output_tokens: 1 },
        },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const err = evs.find((e) => e.type === "turn.error") as {
      turnId?: string;
      code?: string;
      message?: string;
      usage?: { inputTokens?: number };
    };
    expect(err).toBeDefined();
    expect(err?.turnId).toBe("turn_resp_inc_1");
    expect(err?.code).toBe("max_output_tokens");
    expect(err?.message).toBe("max_output_tokens");
    expect(err?.usage?.inputTokens).toBe(8);
    // No turn.done was emitted for an errored (incomplete) turn.
    expect(evs.find((e) => e.type === "turn.done")).toBeUndefined();
  });

  it("content_filter incomplete → turn.done error outcome + safety (NOT turn.error)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_cf_2" } }),
      rawModel({
        type: "response.incomplete",
        response: {
          id: "resp_cf_2",
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const done = evs.find((e) => e.type === "turn.done") as {
      finishReason?: string;
      outcome?: { type?: string };
      safety?: Array<{ category?: string; blocked?: boolean }>;
    };
    expect(done).toBeDefined();
    expect(done?.finishReason).toBe("safety_blocked");
    expect(done?.outcome?.type).toBe("error");
    expect(done?.safety?.[0]).toMatchObject({ category: "content_filter", blocked: true });
    expect(evs.find((e) => e.type === "turn.error")).toBeUndefined();
  });
});

describe("createOpenaiNormalizer — response.completed carrying a NON-completed status (openai 7.15.0 ResponseStatus)", () => {
  // Wire truth (openai 7.15.0 `resources/responses/responses.d.ts`): a
  // `response.completed` event carries a FULL `Response` (:1652-1656), whose
  // OPTIONAL `status` (:997) ranges over the whole `ResponseStatus` union
  // (:6186) — `failed`/`cancelled`/`incomplete` included. Closing such a round
  // as a SUCCESS is a wrong MAPPING (not a drop). @openai/agents-openai 0.17.1+
  // rejects these terminal states upstream, but yields the raw `model` carrier
  // this facet closes on BEFORE throwing, so the correct decision has to be made
  // here.
  function completedRound(response: JsonValue): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: "resp_status_1" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_status_1", delta: "partial" }),
      rawModel({ type: "response.completed", response }),
    ];
  }
  function runRound(response: JsonValue): AgEvent[] {
    const n = createOpenaiNormalizer();
    return completedRound(response)
      .flatMap((e) => n.push(e))
      .concat(n.flush());
  }
  const USAGE: JsonValue = { input_tokens: 9, output_tokens: 3, total_tokens: 12 };

  it('MIRROR: status "failed" → turn.error carrying the status as code (never a successful close)', () => {
    const evs = runRound({ id: "resp_status_1", status: "failed", usage: USAGE });
    const err = evs.find((e) => e.type === "turn.error") as {
      turnId?: string;
      code?: string;
      message?: string;
      usage?: { inputTokens?: number };
    };
    expect(err).toBeDefined();
    expect(err?.turnId).toBe("turn_resp_status_1");
    expect(err?.code).toBe("failed");
    expect(err?.message).toBe("failed");
    expect(err?.usage?.inputTokens).toBe(9);
    // The wrong mapping this fixes: no turn.done is emitted for this round.
    expect(evs.find((e) => e.type === "turn.done")).toBeUndefined();
    // The open text stream and the message still close (same shape as the
    // `response.incomplete` branch) — no dangling stream, no INV-FLUSH abort.
    expect(evs.filter((e) => e.type === "text.end")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "message.end")).toHaveLength(1);
    expect(evs.find((e) => e.type === "turn.abort")).toBeUndefined();
  });

  it('MIRROR: status "cancelled" → turn.error{code:"cancelled"}, and the fold records an error outcome', () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    const round = completedRound({ id: "resp_status_1", status: "cancelled" });
    for (const e of round) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    const res: AgReduceResult = r.result();
    expect(r.needsResync).toBe(false);
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0]).toMatchObject({ outcome: { type: "error", code: "cancelled", message: "cancelled" } });
  });

  it(`MIRROR: status "incomplete" on a response.completed event also errors (upstream's own unsuccessful set)`, () => {
    const evs = runRound({ id: "resp_status_1", status: "incomplete" });
    expect(evs.find((e) => e.type === "turn.error")).toMatchObject({ code: "incomplete" });
    expect(evs.find((e) => e.type === "turn.done")).toBeUndefined();
  });

  it('MIRROR: a self-contradictory response.completed{status:"incomplete"} that ALSO carries incomplete_details.reason prefers the sharper reason as the code', () => {
    // Code fidelity: the `response.incomplete` branch emits `code: reason`. A
    // producer that mislabels the same payload as `response.completed` must not
    // cost the consumer that specificity, so this branch reaches for the reason
    // first and falls back to the bare status only when there is none.
    const evs = runRound({
      id: "resp_status_1",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(evs.find((e) => e.type === "turn.error")).toMatchObject({
      code: "max_output_tokens",
      message: "max_output_tokens",
    });
    expect(evs.find((e) => e.type === "turn.done")).toBeUndefined();
  });

  it('a "failed" status carrying an incomplete_details.reason still reports "failed" — the reason preference is scoped to the incomplete status alone', () => {
    const evs = runRound({
      id: "resp_status_1",
      status: "failed",
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(evs.find((e) => e.type === "turn.error")).toMatchObject({ code: "failed" });
  });

  it('NEGATIVE CONTROL: status "completed" closes the turn as a success, exactly as before', () => {
    const evs = runRound({ id: "resp_status_1", status: "completed", usage: USAGE });
    expect(evs.find((e) => e.type === "turn.error")).toBeUndefined();
    expect(evs.find((e) => e.type === "turn.done")).toMatchObject({
      turnId: "turn_resp_status_1",
      outcome: { type: "success" },
      finishReason: "stop",
    });
  });

  it('NEGATIVE CONTROL: an ABSENT status emits a byte-identical stream to status:"completed" (nothing new is carried)', () => {
    const withStatus = runRound({ id: "resp_status_1", status: "completed", usage: USAGE });
    const withoutStatus = runRound({ id: "resp_status_1", usage: USAGE });
    expect(JSON.stringify(withoutStatus)).toBe(JSON.stringify(withStatus));
    expect(withoutStatus.find((e) => e.type === "turn.done")).toMatchObject({ outcome: { type: "success" } });
    expect(withoutStatus.find((e) => e.type === "turn.error")).toBeUndefined();
  });

  it("NEGATIVE CONTROL: a NON-terminal (`in_progress`) or unrecognized server-added status stays on the success path — the facet never invents an outcome from an open enum", () => {
    const baseline = runRound({ id: "resp_status_1", usage: USAGE });
    for (const status of ["in_progress", "queued", "some_future_status"]) {
      const evs = runRound({ id: "resp_status_1", status, usage: USAGE });
      expect(JSON.stringify(evs)).toBe(JSON.stringify(baseline));
    }
  });

  it("the close-once guard still suppresses the DUPLICATE response.completed (exactly one close, still the error one)", () => {
    const n = createOpenaiNormalizer();
    const terminal = rawModel({
      type: "response.completed",
      response: { id: "resp_status_dup", status: "failed", usage: USAGE },
    });
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_status_dup" } }),
      terminal,
      terminal, // the SDK emits response.completed TWICE
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const closes = evs.filter((e) => e.type === "turn.done" || e.type === "turn.error" || e.type === "turn.abort");
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ type: "turn.error", turnId: "turn_resp_status_dup", code: "failed" });
  });
});

describe("createOpenaiNormalizer — response.failed error arm (T5c)", () => {
  it("response.failed → turn.error with message + code", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_fail_2" } }),
      rawModel({
        type: "response.failed",
        response: {
          id: "resp_fail_2",
          error: { message: "Rate limit exceeded", code: "rate_limit_exceeded" },
        },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const err = evs.find((e) => e.type === "turn.error") as {
      turnId?: string;
      message?: string;
      code?: string;
    };
    expect(err).toBeDefined();
    expect(err?.turnId).toBe("turn_resp_fail_2");
    expect(err?.message).toBe("Rate limit exceeded");
    expect(err?.code).toBe("rate_limit_exceeded");
    // Negative control for the 0.6.1 misalignment carry: a plain failure
    // (no `error.misalignment`) emits NO ext.openai.misalignment event —
    // the pre-7.10.0 output is byte-identical.
    expect(evs.some((e) => e.type === "ext.openai.misalignment")).toBe(false);
    expect(evs.some((e) => e.type === "message.start" && Reflect.get(e, "role") === "notice")).toBe(false);
  });

  // openai-node >=7.10.0 (GPT-6 Astra misalignment monitoring): response.failed
  // may carry `error.misalignment {detailed_explanation, error_type, steer{message}}`
  // beside code `misalignment_policy_violation` (synthetic-tested only: the
  // documented auto-stop applies to persisted-reasoning / WebSocket / compaction
  // requests the e2e HTTP path never uses). rd-15 (sp-protocol's package A.6,
  // founder: rides 0.7.0; sp-cto: the carry must sit in a home that FOLDS):
  // before turn.error the facet emits an adapter NOTICE message — one text block
  // whose text is `detailed_explanation` verbatim (error.message when absent) and
  // whose text.start `_meta["openai/misalignment"]` holds the WHOLE object
  // (incl. steer and unknown keys). The live-only ext.openai.misalignment carry
  // is RETIRED (the item-21 one-carrier precedent).
  const MISALIGNMENT = {
    error_type: "potentially_unintended_destructive_activity",
    detailed_explanation: "The model attempted to delete files outside the workspace.",
    steer: { message: "Confirm the deletion scope with the user before continuing." },
    future_key: { nested: true },
  };
  function failedWith(respId: string, misalignment: JsonValue | undefined): JsonValue[] {
    const error: { [k: string]: JsonValue } = { message: "Misalignment policy violation", code: "misalignment_policy_violation" };
    if (misalignment !== undefined) error.misalignment = misalignment;
    return [
      rawModel({ type: "response.created", response: { id: respId } }),
      rawModel({ type: "response.output_text.delta", item_id: `msg_${respId}`, delta: "Deleting…" }),
      rawModel({ type: "response.failed", response: { id: respId, error } }),
    ];
  }

  it("rd-15: response.failed with error.misalignment → an adapter NOTICE message (text = detailed_explanation, text.start _meta carries the whole object) right before turn.error; no ext.openai.misalignment", () => {
    const n = createOpenaiNormalizer();
    const evs = failedWith("resp_mis_1", MISALIGNMENT)
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const types = evs.map((e) => e.type);
    expect(types).not.toContain("ext.openai.misalignment");
    const errIdx = types.indexOf("turn.error");
    expect(types.slice(errIdx - 5, errIdx + 1)).toEqual(["message.start", "text.start", "text.delta", "text.end", "message.end", "turn.error"]);
    const notice = evs[errIdx - 5];
    expect(notice).toMatchObject({ type: "message.start", role: "notice", noticeSource: "adapter", turnId: "turn_resp_mis_1" });
    const noticeId = Reflect.get(notice ?? {}, "id");
    expect(evs[errIdx - 4]).toMatchObject({ type: "text.start", messageId: noticeId, _meta: { "openai/misalignment": MISALIGNMENT } });
    expect(evs[errIdx - 3]).toMatchObject({ type: "text.delta", delta: MISALIGNMENT.detailed_explanation });
    expect(evs[errIdx - 1]).toMatchObject({ type: "message.end", id: noticeId });
    // The assistant's own message closed BEFORE the notice opened.
    const assistantEnd = types.indexOf("message.end");
    expect(assistantEnd).toBeLessThan(errIdx - 5);
    expect(evs[errIdx]).toMatchObject({ message: "Misalignment policy violation", code: "misalignment_policy_violation" });
    for (const e of evs) expect(() => AgEvent.parse(e)).not.toThrow();
  });

  it("rd-15 (readable + durable): the fold keeps the notice message — its text is the explanation and its block `_meta` holds the whole misalignment object; no park", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of failedWith("resp_mis_fold", MISALIGNMENT)) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const notice = res.messages.find((m) => m.role === "notice");
    expect(notice).toMatchObject({ role: "notice", noticeSource: "adapter" });
    expect(notice?.content).toEqual([
      expect.objectContaining({ type: "text", text: MISALIGNMENT.detailed_explanation, _meta: { "openai/misalignment": MISALIGNMENT } }),
    ]);
    expect(res.turns[0]).toMatchObject({ outcome: { type: "error", code: "misalignment_policy_violation" } });
    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });

  it("rd-15: with no detailed_explanation, the notice text falls back to error.message", () => {
    const n = createOpenaiNormalizer();
    const { detailed_explanation: _drop, ...noExplanation } = MISALIGNMENT;
    const evs = failedWith("resp_mis_3", noExplanation)
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const noticeText = evs.find((e) => e.type === "text.delta" && Reflect.get(e, "delta") === "Misalignment policy violation");
    expect(noticeText).toBeDefined();
    expect(evs.find((e) => e.type === "text.start" && Reflect.get(e, "_meta") !== undefined)).toMatchObject({
      _meta: { "openai/misalignment": noExplanation },
    });
  });

  it("a malformed (non-object) error.misalignment is ignored, never thrown (Tenet 6)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_mis_2" } }),
      rawModel({
        type: "response.failed",
        response: { id: "resp_mis_2", error: { message: "boom", code: "server_error", misalignment: "nope" } },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    expect(evs.some((e) => e.type === "ext.openai.misalignment")).toBe(false);
    expect(evs.some((e) => e.type === "message.start" && Reflect.get(e, "role") === "notice")).toBe(false);
    expect(evs.some((e) => e.type === "turn.error")).toBe(true);
  });

  // openai-node 7.9.0/7.10.0 widened `incomplete_details.reason` with
  // 'max_messages' and 'steered'. The response.incomplete arm never computes a
  // finishReason — it closes with turn.error{code: reason, message: reason} —
  // so a new reason survives verbatim with zero facet change. Regression pin.
  it("response.incomplete with a new reason ('steered') keeps the raw reason as turn.error code", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_steer_1" } }),
      rawModel({
        type: "response.incomplete",
        response: { id: "resp_steer_1", status: "incomplete", incomplete_details: { reason: "steered" } },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const err = evs.find((e) => e.type === "turn.error") as { code?: string } | undefined;
    expect(err?.code).toBe("steered");
  });
});

describe("createOpenaiNormalizer — refusal arm (T5c)", () => {
  it("message_output_created refusal part → response.completed closes with finishReason:refusal", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_ref_1" } }),
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "I cannot help with that." }],
          id: "msg_ref_1",
        },
      }),
      rawModel({
        type: "response.completed",
        response: { id: "resp_ref_1", status: "completed" },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const done = evs.find((e) => e.type === "turn.done") as { finishReason?: string };
    expect(done).toBeDefined();
    expect(done?.finishReason).toBe("refusal");
  });
});

describe("createOpenaiNormalizer — __host_error__ sentinel (T5c)", () => {
  it("with an OPEN turn → closes that turn with turn.error{code:max_turns, usage}", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_mt_1" } }),
      rawModel({ type: "response.output_text.delta", item_id: "it1", delta: "thinking" }),
      // Host catches MaxTurnsExceededError and feeds the synthetic sentinel.
      hostError("max_turns", "Max turns (1) exceeded", {
        inputTokens: 12,
        outputTokens: 3,
        cumulative: false,
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const err = evs.find((e) => e.type === "turn.error") as {
      turnId?: string;
      code?: string;
      message?: string;
      usage?: { inputTokens?: number };
    };
    expect(err).toBeDefined();
    expect(err?.turnId).toBe("turn_resp_mt_1");
    expect(err?.code).toBe("max_turns");
    expect(err?.message).toBe("Max turns (1) exceeded");
    expect(err?.usage?.inputTokens).toBe(12);
    // The turn.error closes the already-open turn → no separate turn.done.
    expect(evs.find((e) => e.type === "turn.done")).toBeUndefined();
    // A well-formed turn: exactly one turn.start precedes the turn.error.
    const starts = evs.filter((e) => e.type === "turn.start");
    expect(starts).toHaveLength(1);
    const startIdx = evs.findIndex((e) => e.type === "turn.start");
    const errIdx = evs.findIndex((e) => e.type === "turn.error");
    expect(startIdx).toBeLessThan(errIdx);
  });

  it("with NO turn open (max_turns after last response completed) → opens+closes a fresh terminal turn", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      // A response completed first; the turn is closed before max_turns fires.
      rawModel({ type: "response.created", response: { id: "resp_mt_2" } }),
      rawModel({
        type: "response.completed",
        response: {
          id: "resp_mt_2",
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      }),
      // Now the host feeds the sentinel with NO turn open.
      hostError("max_turns", "Max turns (2) exceeded", {
        inputTokens: 20,
        outputTokens: 4,
        cumulative: false,
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    // The first response closed cleanly with turn.done.
    expect(evs.find((e) => e.type === "turn.done")).toBeDefined();
    // The sentinel opened+closed a fresh terminal turn carrying turn.error.
    const err = evs.find((e) => e.type === "turn.error") as {
      turnId?: string;
      code?: string;
      usage?: { inputTokens?: number };
    };
    expect(err).toBeDefined();
    expect(err?.code).toBe("max_turns");
    expect(err?.usage?.inputTokens).toBe(20);
    // The fresh terminal turn is a DISTINCT turn from the completed one.
    expect(err?.turnId).not.toBe("turn_resp_mt_2");
    // It is well-formed: a turn.start exists for that fresh turn id.
    const freshStart = evs.find(
      (e) => e.type === "turn.start" && "turnId" in e && e.turnId === err?.turnId,
    );
    expect(freshStart).toBeDefined();
  });

  it("reduces cleanly to an errored turn (fold-identity, no needsResync)", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    const corpus: JsonValue[] = [
      rawModel({ type: "response.created", response: { id: "resp_mt_3" } }),
      rawModel({ type: "response.output_text.delta", item_id: "it1", delta: "partial" }),
      hostError("max_turns", "Max turns exceeded", {
        inputTokens: 9,
        outputTokens: 1,
        cumulative: false,
      }),
    ];
    for (const e of corpus) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0]?.outcome).toMatchObject({ type: "error", code: "max_turns" });
    expect(res.turns[0]?.usage).toMatchObject({ inputTokens: 9 });
    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });
});

describe("createOpenaiNormalizer — message_output_created citations carrier (audit M22)", () => {
  it("attaches citations to text.end and does NOT re-emit text as a supplement", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_cit_1" } }),
      // Text streamed from the raw delta (the authoritative text source).
      rawModel({
        type: "response.output_text.delta",
        item_id: "it_cit",
        delta: "Paris is the capital of France.",
      }),
      rawModel({
        type: "response.output_text.done",
        item_id: "it_cit",
        text: "Paris is the capital of France.",
      }),
      // The run-item arrives at the end carrying the annotated part (citations).
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Paris is the capital of France.",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.com/france",
                  title: "France",
                  start_index: 0,
                  end_index: 5,
                },
              ],
            },
          ],
          id: "msg_cit_1",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_cit_1", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    // No id-less duplicate supplement block — citations ride text.end.
    expect(evs.find((e) => e.type === "content.block")).toBeUndefined();
    const textEnd = evs.find((e) => e.type === "text.end") as {
      id?: string;
      citations?: Array<{ url?: string }>;
    };
    expect(textEnd).toBeDefined();
    expect(textEnd?.id).toBe("it_cit");
    expect(textEnd?.citations?.[0]?.url).toBe("https://example.com/france");
    // Text was NOT re-emitted: exactly ONE text.delta (from the raw delta path),
    // not a second one from the run-item.
    const deltas = evs.filter((e) => e.type === "text.delta");
    expect(deltas).toHaveLength(1);
  });

  it("folds to exactly ONE text block, with citations attached (no duplicate-fold)", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    const stream = [
      rawModel({ type: "response.created", response: { id: "resp_cit_2" } }),
      rawModel({
        type: "response.output_text.delta",
        item_id: "it_cit2",
        delta: "Paris is the capital of France.",
      }),
      rawModel({
        type: "response.output_text.done",
        item_id: "it_cit2",
        text: "Paris is the capital of France.",
      }),
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Paris is the capital of France.",
              annotations: [{ type: "url_citation", url: "https://example.com/france", start_index: 0, end_index: 5 }],
            },
          ],
          id: "msg_cit_2",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_cit_2", status: "completed" } }),
    ];
    for (const e of stream) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    const blocks = r.result().messages[0]?.content ?? [];
    const textBlocks = blocks.filter((b) => b.type === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toMatchObject({
      type: "text",
      text: "Paris is the capital of France.",
      citations: [{ kind: "url", url: "https://example.com/france" }],
    });
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });

  it("does NOT emit a content.block when the message has no annotations", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_noann_1" } }),
      rawModel({ type: "response.output_text.delta", item_id: "it_na", delta: "Done." }),
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done." }],
          id: "msg_noann_1",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_noann_1", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    expect(evs.find((e) => e.type === "content.block")).toBeUndefined();
    const textEnd = evs.find((e) => e.type === "text.end") as { citations?: unknown };
    expect(textEnd).toBeDefined();
    expect(textEnd?.citations).toBeUndefined();
  });

  it("late arrival (response.completed lands FIRST, #128 live-proven ordering): annotations carry losslessly via ext.openai.late-citations, no phantom turn/message events", () => {
    const n = createOpenaiNormalizer();
    const rawAnnotations = [
      {
        type: "url_citation",
        url: "https://example.com/france",
        title: "France",
        start_index: 0,
        end_index: 5,
      },
    ];
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_late_cit" } }),
      rawModel({
        type: "response.output_text.delta",
        item_id: "it_late",
        delta: "Paris is the capital of France.",
      }),
      rawModel({
        type: "response.output_text.done",
        item_id: "it_late",
        text: "Paris is the capital of France.",
      }),
      // Terminal close arrives FIRST — the live-proven #128 ordering.
      rawModel({ type: "response.completed", response: { id: "resp_late_cit", status: "completed" } }),
      // The run-item lands AFTER the round already closed, carrying the annotated part.
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Paris is the capital of France.",
              annotations: rawAnnotations,
            },
          ],
          id: "msg_late_cit_1",
        },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    // No phantom turn/message events synthesized for the late run-item — exactly
    // one of each from the ORIGINAL round (never re-open via ensureResponseOpen).
    const types = evs.map((e) => e.type);
    expect(types.filter((t) => t === "turn.start")).toHaveLength(1);
    expect(types.filter((t) => t === "message.start")).toHaveLength(1);
    expect(types.filter((t) => t === "turn.done")).toHaveLength(1);
    expect(types.filter((t) => t === "message.end")).toHaveLength(1);

    // The annotations survive losslessly on the ext channel instead of being
    // silently dropped by the late-arrival guard.
    const lateCitations = evs.find((e) => e.type === "ext.openai.late-citations") as {
      itemId?: string;
      annotations?: unknown;
    };
    expect(lateCitations).toBeDefined();
    expect(lateCitations?.itemId).toBe("msg_late_cit_1");
    expect(lateCitations?.annotations).toEqual(rawAnnotations);
  });
});

describe("createOpenaiNormalizer — id-less synthesized final message (agents-core ≥0.13.2 errorHandlers.invalidFinalOutput)", () => {
  // agents-core 0.13.2's invalidFinalOutput recovery pushes a final assistant
  // message via createRunErrorFinalOutputItem (errorHandlers.mjs:23 →
  // helpers/message.mjs:45-59): NO id, NO annotations, NO preceding
  // response.output_text.delta events, arriving past the terminal close. Its
  // text is the SDK-reported final output — it must carry losslessly via
  // ext.openai.late-message, never vanish and never graft onto the closed turn.
  const SYNTHESIZED_TEXT = "I could not produce the requested structured output.";
  const CORPUS: JsonValue[] = [
    rawModel({ type: "response.created", response: { id: "resp_inv_final" } }),
    // The model's own (schema-invalid) output streamed normally…
    rawModel({ type: "response.output_text.delta", item_id: "it_inv", delta: '{"oops": tru' }),
    rawModel({ type: "response.output_text.done", item_id: "it_inv", text: '{"oops": tru' }),
    // …the round closed…
    rawModel({ type: "response.completed", response: { id: "resp_inv_final", status: "completed" } }),
    // …then the handler-synthesized id-less message lands (exact rawItem shape
    // from helpers/message.mjs:45-59 — no id, no annotations).
    runItem("message_output_created", {
      type: "message_output_item",
      rawItem: {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: SYNTHESIZED_TEXT }],
      },
    }),
  ];

  it("routes the never-streamed text losslessly via ext.openai.late-message (anchored to the closed turn); no phantom turn/text events", () => {
    const n = createOpenaiNormalizer();
    const evs = CORPUS.flatMap((e) => n.push(e)).concat(n.flush());

    const late = evs.find((e) => e.type === "ext.openai.late-message") as {
      text?: unknown;
      forTurnId?: unknown;
    };
    expect(late).toBeDefined();
    expect(late?.text).toBe(SYNTHESIZED_TEXT);
    // Fold anchor: the retained top-level turnId of the turn it belongs to
    // (`forTurnId` — the envelope's `turnId` is a reserved ext key).
    expect(late?.forTurnId).toBe("turn_resp_inv_final");

    // Never re-open the turn or emit streamed-text events for it (INV-MSG).
    const types = evs.map((e) => e.type);
    expect(types.filter((t) => t === "turn.start")).toHaveLength(1);
    expect(types.filter((t) => t === "turn.done")).toHaveLength(1);
    const doneIdx = types.indexOf("turn.done");
    expect(types.slice(doneIdx + 1)).not.toContain("text.start");
    expect(types.slice(doneIdx + 1)).not.toContain("text.delta");
    expect(types.slice(doneIdx + 1)).not.toContain("text.end");
  });

  it("fold-identity: the corpus reduces cleanly (needsResync=false)", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of CORPUS) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.result().turns).toHaveLength(1);
    expect(r.needsResync).toBe(false);
  });

  it("id-less synthesized message arriving while a text stream is STILL OPEN never consumes the FIFO stream (review finding: mis-correlation interleaving)", () => {
    const n = createOpenaiNormalizer();
    const pushed = [
      rawModel({ type: "response.created", response: { id: "resp_open_synth" } }),
      rawModel({ type: "response.output_text.delta", item_id: "it_open", delta: "streaming…" }),
      // Synthesized id-less item lands BEFORE the terminal close, stream open.
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: SYNTHESIZED_TEXT }],
        },
      }),
      // The model's own id'd message closes its genuine stream afterwards.
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "streaming…" }],
          id: "msg_open_1",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_open_synth", status: "completed" } }),
    ].flatMap((e) => n.push(e));
    const evs = pushed.concat(n.flush());

    // The synthesized text rides ext; the genuine stream still gets its own
    // text.end (the id'd run-item found it un-consumed).
    const late = evs.find((e) => e.type === "ext.openai.late-message") as { text?: unknown };
    expect(late?.text).toBe(SYNTHESIZED_TEXT);
    expect(evs.filter((e) => e.type === "text.end")).toHaveLength(1);
  });

  it("never throws on an envelope-only-validated output_text part MISSING `text` (push() never-throw contract)", () => {
    const n = createOpenaiNormalizer();
    const push = (): unknown[] => [
      rawModel({ type: "response.created", response: { id: "resp_malformed" } }),
      rawModel({ type: "response.completed", response: { id: "resp_malformed", status: "completed" } }),
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text" }], // no `text` — malformed/partial wire
        },
      }),
    ].flatMap((e) => n.push(e));
    expect(push).not.toThrow();
    expect(push().find((e: unknown) => (e as { type?: string }).type === "ext.openai.late-message")).toBeUndefined();
  });

  it("id-less post-close part WITH annotations keeps the documented late-citations channel (late-message never absorbs it)", () => {
    const n = createOpenaiNormalizer();
    const rawAnnotations = [
      { type: "url_citation", url: "https://example.com", start_index: 0, end_index: 4 },
    ];
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_idless_ann" } }),
      rawModel({ type: "response.completed", response: { id: "resp_idless_ann", status: "completed" } }),
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "cited", annotations: rawAnnotations }],
        },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const late = evs.find((e) => e.type === "ext.openai.late-message") as { annotations?: unknown };
    expect(late).toBeDefined();
    expect(late?.annotations).toBeUndefined();
    const citations = evs.find((e) => e.type === "ext.openai.late-citations") as {
      annotations?: unknown;
    };
    expect(citations?.annotations).toEqual(rawAnnotations);
  });

  it("an id'd late run-item (#128 ordering) still takes the late-citations path — no late-message", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_idd_late" } }),
      rawModel({ type: "response.output_text.delta", item_id: "it_idd", delta: "Hi" }),
      rawModel({ type: "response.output_text.done", item_id: "it_idd", text: "Hi" }),
      rawModel({ type: "response.completed", response: { id: "resp_idd_late", status: "completed" } }),
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hi" }],
          id: "msg_idd_late_1",
        },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    expect(evs.find((e) => e.type === "ext.openai.late-message")).toBeUndefined();
  });

  it("an id'd post-close part carries phase via ext.openai.late-phase (live 0.14.0 wire ordering — census-caught)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_late_phase" } }),
      rawModel({ type: "response.output_text.delta", item_id: "it_lp", delta: "Done" }),
      rawModel({ type: "response.output_text.done", item_id: "it_lp", text: "Done" }),
      rawModel({ type: "response.completed", response: { id: "resp_late_phase", status: "completed" } }),
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done" }],
          id: "msg_lp_1",
          phase: "final_answer",
        },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const late = evs.find((e) => e.type === "ext.openai.late-phase") as {
      itemId?: unknown;
      phase?: unknown;
    };
    expect(late).toBeDefined();
    expect(late.itemId).toBe("msg_lp_1");
    expect(late.phase).toBe("final_answer");
    // The closed message gained nothing: no text.end after the close, no late-message.
    expect(evs.find((e) => e.type === "ext.openai.late-message")).toBeUndefined();
  });

  it("an id'd post-close part WITHOUT phase emits no late-phase (0.13.5-shaped negative control)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_lp_neg" } }),
      rawModel({ type: "response.output_text.delta", item_id: "it_lpn", delta: "Hi" }),
      rawModel({ type: "response.output_text.done", item_id: "it_lpn", text: "Hi" }),
      rawModel({ type: "response.completed", response: { id: "resp_lp_neg", status: "completed" } }),
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hi" }],
          id: "msg_lpn_1",
        },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    expect(evs.find((e) => e.type === "ext.openai.late-phase")).toBeUndefined();
  });
});

describe("createOpenaiNormalizer — capstone fold-identity over a combined corpus (T5c)", () => {
  it("text + tool + a terminal error reduce cleanly (needsResync=false) and round-trip", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    // A terminal-error turn appended to the text + tool corpora.
    const ERROR_TURN: JsonValue[] = [
      rawModel({ type: "response.created", response: { id: "resp_err_cap" } }),
      rawModel({ type: "response.output_text.delta", item_id: "it_err", delta: "Working" }),
      rawModel({
        type: "response.failed",
        response: {
          id: "resp_err_cap",
          error: { message: "boom", code: "server_error" },
        },
      }),
    ];
    const combined: JsonValue[] = [...TEXT_TURN, ...TOOL_TURN, ...ERROR_TURN];
    for (const e of combined) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    // Three turns: text (success), tool (success), error.
    expect(res.turns).toHaveLength(3);
    const errorTurn = res.turns.find((t) => t.turnId === "turn_resp_err_cap");
    expect(errorTurn?.outcome).toMatchObject({ type: "error", code: "server_error" });
    // Full AgReduceResult round-trips through the schema (T3 reviewer deferred-Minor).
    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 3 (audit M48) — port the typed-but-no-op'd known run-item families:
// reasoning_item_created (incl. rs_/encrypted_content ZDR replay),
// handoff_requested + handoff_occurred, tool_approval_requested. Plus: the
// default arm now routes genuinely-unknown run-item names to
// `ext.openai.unparsed` (the file's stated convention, previously untrue — M48).
//
// M48 REVIEW (Finding 1) corrected the handoff mapping's false premise: the
// original port assumed `handoff_requested` had no completion signal on this
// seam and mapped it to a standalone `handoff` event. The REAL installed SDK
// (`@openai/agents` 0.2.1, this package's own peer dep) carries
// `handoff_occurred` too (`RunHandoffOutputItem{sourceAgent,targetAgent}`) —
// the mapping now brackets the transfer with `subagentStart`/`subagentDone`,
// with the identity-carrying `handoff` event firing once both agent names are
// actually known (at `handoff_occurred`, not `handoff_requested` — the target
// is not resolvable at request time on the real wire; see index.ts).
//
// Single-sourcing note: none of these typed run-item interfaces has a
// counterpart arm in `response.output_item.added` (that raw event only special-
// cases `item.type === "function_call"`, and none of these declares a richer
// item shape there — reasoning's content/encrypted_content and the handoff
// agents exist ONLY on the run-item wrappers). So the run-item arm is the sole
// source for all of them; `output_item.added` is left untouched. SUPERSEDED for
// reasoning by OA-11 (see the OA-11 describe below): the raw `output_item.added`
// opens the block and the terminal `response.output` fills it; the tests in THIS
// describe feed no raw reasoning events, so they pin the run-item FALLBACK path.
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — reasoning_item_created (Task 3, audit M48)", () => {
  it("rs_ id + summary text + encrypted_content ⇒ reasoning.start/delta/end + reasoning.opaque carrying the ZDR replay blob", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_reason_1" } }),
      runItem("reasoning_item_created", {
        type: "reasoning_item",
        rawItem: {
          type: "reasoning",
          id: "rs_abc123",
          content: [{ type: "input_text", text: "Thinking about the answer..." }],
          providerData: { encrypted_content: "ENC_BLOB_XYZ" },
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_reason_1", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    const start = evs.find((e) => e.type === "reasoning.start") as {
      itemId?: string;
      id?: string;
    };
    expect(start).toBeDefined();
    expect(start?.itemId).toBe("rs_abc123");

    const delta = evs.find((e) => e.type === "reasoning.delta") as { delta?: string };
    expect(delta?.delta).toBe("Thinking about the answer...");

    const end = evs.find((e) => e.type === "reasoning.end");
    expect(end).toBeDefined();

    const opaque = evs.find((e) => e.type === "reasoning.opaque") as {
      kind?: string;
      value?: string;
      itemId?: string;
      provider?: string;
    };
    expect(opaque).toBeDefined();
    expect(opaque?.kind).toBe("ciphertext");
    expect(opaque?.value).toBe("ENC_BLOB_XYZ");
    expect(opaque?.itemId).toBe("rs_abc123");
    expect(opaque?.provider).toBe("openai");

    // reasoning.start / reasoning.opaque share the same block `id`.
    expect(opaque && start && (opaque as { id?: string }).id).toBe((start as { id?: string }).id);
  });

  it("no summary text ⇒ no reasoning.delta (start/end/opaque still fire)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_reason_2" } }),
      runItem("reasoning_item_created", {
        type: "reasoning_item",
        rawItem: {
          type: "reasoning",
          id: "rs_notext",
          content: [],
          providerData: { encrypted_content: "ENC_2" },
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_reason_2", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    expect(evs.find((e) => e.type === "reasoning.delta")).toBeUndefined();
    expect(evs.find((e) => e.type === "reasoning.start")).toBeDefined();
    expect(evs.find((e) => e.type === "reasoning.end")).toBeDefined();
    expect(evs.find((e) => e.type === "reasoning.opaque")).toBeDefined();
  });

  it("no encrypted_content ⇒ no reasoning.opaque emitted", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_reason_3" } }),
      runItem("reasoning_item_created", {
        type: "reasoning_item",
        rawItem: {
          type: "reasoning",
          id: "rs_noenc",
          content: [{ type: "input_text", text: "hmm" }],
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_reason_3", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    expect(evs.find((e) => e.type === "reasoning.opaque")).toBeUndefined();
    expect(evs.find((e) => e.type === "reasoning.start")).toBeDefined();
  });

  it("fold-identity: the reasoning block round-trips with opaque.value + itemId, needsResync=false", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    const stream = [
      rawModel({ type: "response.created", response: { id: "resp_reason_4" } }),
      runItem("reasoning_item_created", {
        type: "reasoning_item",
        rawItem: {
          type: "reasoning",
          id: "rs_fold1",
          content: [{ type: "input_text", text: "step by step" }],
          providerData: { encrypted_content: "ENC_FOLD" },
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_reason_4", status: "completed" } }),
    ];
    for (const e of stream) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const reasoningBlock = res.messages.flatMap((m) => m.content).find((b) => b.type === "reasoning") as {
      opaque?: { kind?: string; value?: string };
      itemId?: string;
      text?: string;
    };
    expect(reasoningBlock).toBeDefined();
    expect(reasoningBlock?.text).toBe("step by step");
    expect(reasoningBlock?.opaque).toMatchObject({ kind: "ciphertext", value: "ENC_FOLD" });
    expect(reasoningBlock?.itemId).toBe("rs_fold1");
    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });

  it("late arrival (response.completed lands FIRST): rs_/encrypted_content carries losslessly via ext.openai.late-reasoning instead of the bare-return guard silently dropping it (review finding on M48)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_late_reason" } }),
      // Terminal close arrives FIRST — mirrors the #128 live-proven ordering
      // (message_output_created / M22) that applies to every run-item on this seam.
      rawModel({ type: "response.completed", response: { id: "resp_late_reason", status: "completed" } }),
      // The reasoning run-item lands AFTER the round already closed.
      runItem("reasoning_item_created", {
        type: "reasoning_item",
        rawItem: {
          type: "reasoning",
          id: "rs_late1",
          content: [{ type: "input_text", text: "late thinking" }],
          providerData: { encrypted_content: "ENC_LATE_BLOB" },
        },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    // No phantom reasoning block opened for the late run-item.
    expect(evs.find((e) => e.type === "reasoning.start")).toBeUndefined();
    expect(evs.find((e) => e.type === "reasoning.opaque")).toBeUndefined();

    // The REPLAY-LOAD-BEARING encrypted_content blob survives losslessly on the
    // ext channel instead of being silently dropped by the late-arrival guard.
    const lateReasoning = evs.find((e) => e.type === "ext.openai.late-reasoning") as {
      itemId?: string;
      encryptedContent?: string;
    };
    expect(lateReasoning).toBeDefined();
    expect(lateReasoning?.itemId).toBe("rs_late1");
    expect(lateReasoning?.encryptedContent).toBe("ENC_LATE_BLOB");
  });

  it("late arrival with NO encrypted_content ⇒ no ext.openai.late-reasoning (nothing irrecoverable to lose, bare return still holds)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_late_reason2" } }),
      rawModel({ type: "response.completed", response: { id: "resp_late_reason2", status: "completed" } }),
      runItem("reasoning_item_created", {
        type: "reasoning_item",
        rawItem: {
          type: "reasoning",
          id: "rs_late2",
          content: [{ type: "input_text", text: "no zdr blob here" }],
        },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    expect(evs.find((e) => e.type === "ext.openai.late-reasoning")).toBeUndefined();
    expect(evs.find((e) => e.type === "reasoning.start")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OA-11 — reasoning as a first-class block on the LIVE wire order.
//
// Live evidence (corpus/echo-gpt6sol/openai.native.json, gpt-6-sol, @openai/
// agents 0.18.0): `output_item.added{reasoning rs_}` [3] → `output_item.done
// {reasoning}` [4] → `output_item.added{function_call fc_}` [5] … →
// `response.completed` [21] → run-item `reasoning_item_created` [22]. The run-
// item lands AFTER the close, so before OA-11 only `ext.openai.late-reasoning`
// fired and no reasoning block folded. And the `encrypted_content` at [4] is a
// DIFFERENT blob from [21]/[22] — OpenAI re-encrypts per stage; only the final
// one (the `response.completed` output's) is what stateless replay sends back.
//
// Mapping: the block OPENS at `output_item.added{reasoning}` (id only — keeps
// wire order: `rs_` before `fc_`, §5 block insertion order, SPEC:763; §10 item
// 4's stateless loop needs `rs_` ahead of its `fc_` on replay) and is FILLED
// (summary delta, end, opaque) from the `response.completed`/`.incomplete`
// output, never from `output_item.done`. The run-item then dedupes by id.
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — OA-11 reasoning sourced from the response.completed output", () => {
  const RESP = "resp_oa11";
  const RS = "rs_oa11";
  const FC = "fc_oa11";
  const CALL = "call_oa11";

  /** The live gpt-6-sol tool round (echo-gpt6sol natives [1]..[24]), minimised. */
  function liveToolRound(opts: {
    finalBlob?: string;
    summary?: JsonValue;
    terminal?: "response.completed" | "response.incomplete";
  }): JsonValue[] {
    const reasoningOut: { [k: string]: JsonValue } = { id: RS, type: "reasoning", content: [] };
    reasoningOut.summary = opts.summary ?? [];
    if (opts.finalBlob !== undefined) reasoningOut.encrypted_content = opts.finalBlob;
    const runItemProviderData: { [k: string]: JsonValue } = { id: RS, type: "reasoning", content: [] };
    if (opts.finalBlob !== undefined) runItemProviderData.encrypted_content = opts.finalBlob;
    return [
      rawModel({ type: "response.created", response: { id: RESP } }),
      rawModel({ type: "response.output_item.added", item: { id: RS, type: "reasoning", summary: [] } }),
      // The STAGE blob: re-encrypted before the terminal event — never replayable.
      rawModel({
        type: "response.output_item.done",
        item: { id: RS, type: "reasoning", content: [], encrypted_content: "ENC_STAGE_NOT_REPLAYABLE", summary: [] },
      }),
      rawModel({
        type: "response.output_item.added",
        item: { id: FC, type: "function_call", call_id: CALL, name: "echo", arguments: "" },
      }),
      rawModel({ type: "response.function_call_arguments.delta", item_id: FC, delta: '{"message":"hi"}' }),
      rawModel({ type: "response.function_call_arguments.done", item_id: FC, arguments: '{"message":"hi"}' }),
      rawModel({
        type: opts.terminal ?? "response.completed",
        response: {
          id: RESP,
          status: opts.terminal === "response.incomplete" ? "incomplete" : "completed",
          ...(opts.terminal === "response.incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
          output: [
            reasoningOut,
            { id: FC, type: "function_call", status: "completed", arguments: '{"message":"hi"}', call_id: CALL, name: "echo" },
          ],
        },
      }),
      runItem("reasoning_item_created", {
        type: "reasoning_item",
        rawItem: { providerData: runItemProviderData, id: RS, type: "reasoning", content: [] },
      }),
    ];
  }

  function drive(stream: JsonValue[]): AgEvent[] {
    const n = createOpenaiNormalizer();
    return stream.flatMap((e) => n.push(e)).concat(n.flush());
  }

  it("live order: one reasoning block, opened BEFORE the fc_ tool.start, sealed with the FINAL blob + rs_ itemId; no late-reasoning ext", () => {
    const evs = drive(liveToolRound({ finalBlob: "ENC_FINAL" }));
    const types = evs.map((e) => e.type);

    expect(types.filter((t) => t === "reasoning.start")).toHaveLength(1);
    expect(types.indexOf("reasoning.start")).toBeGreaterThan(-1);
    expect(types.indexOf("reasoning.start")).toBeLessThan(types.indexOf("tool.start"));

    const start = evs.find((e) => e.type === "reasoning.start");
    expect(start).toMatchObject({ id: RS, itemId: RS });

    const opaques = evs.filter((e) => e.type === "reasoning.opaque");
    expect(opaques).toHaveLength(1);
    expect(opaques[0]).toMatchObject({ id: RS, kind: "ciphertext", value: "ENC_FINAL", provider: "openai", itemId: RS });
    expect(types.filter((t) => t === "reasoning.end")).toHaveLength(1);
    // Opaque BEFORE end: "sealed" means complete (sp-protocol's recommendation —
    // mirrors Claude's signature landing before content_block_stop).
    expect(types.indexOf("reasoning.opaque")).toBeLessThan(types.indexOf("reasoning.end"));

    // The per-stage blob from output_item.done is never emitted, anywhere.
    expect(JSON.stringify(evs)).not.toContain("ENC_STAGE_NOT_REPLAYABLE");
    // The late run-item dedupes — the block already carries the blob.
    expect(types).not.toContain("ext.openai.late-reasoning");
  });

  // A reasoning + text round with NO tool call: the close is NOT deferred, so
  // message.end + turn.done fire inside the very `response.completed` arm that
  // fills the block — the path where a mis-ordered fill would land post-seal.
  function liveTextRound(): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: "resp_txt" } }),
      rawModel({ type: "response.output_item.added", item: { id: "rs_txt", type: "reasoning", summary: [] } }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_txt", type: "message" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_txt", delta: "hello" }),
      rawModel({ type: "response.output_text.done", item_id: "msg_txt", text: "hello" }),
      rawModel({
        type: "response.completed",
        response: {
          id: "resp_txt",
          status: "completed",
          output: [
            { id: "rs_txt", type: "reasoning", content: [], summary: [{ type: "summary_text", text: "think" }], encrypted_content: "ENC_TXT" },
            { id: "msg_txt", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello", annotations: [] }] },
          ],
        },
      }),
    ];
  }

  it.each([
    ["text round (close inside the completed arm)", "rs_txt", liveTextRound()],
    ["tool round (close deferred to flush)", RS, liveToolRound({ finalBlob: "ENC_FINAL", summary: [{ type: "summary_text", text: "think" }] })],
  ])(
    "INV-MSG (SPEC:745), %s: every rs_ fill event (delta/opaque/end) has a LOWER seq than the holding message's message.end and than the turn terminal — core's reduce() has no sealed-message check on reasoning.*, so the order is asserted here",
    (_label, rsId, stream) => {
      const evs = drive(stream);
      const start = evs.find((e) => e.type === "reasoning.start");
      if (start === undefined || start.type !== "reasoning.start") throw new Error("no reasoning.start");
      const fills = evs.filter(
        (e) => (e.type === "reasoning.delta" || e.type === "reasoning.opaque" || e.type === "reasoning.end") && e.id === rsId,
      );
      expect(fills.map((e) => e.type)).toEqual(["reasoning.delta", "reasoning.opaque", "reasoning.end"]);
      const msgEnd = evs.find((e) => e.type === "message.end" && e.id === start.messageId);
      const terminal = evs.find((e) => e.type === "turn.done" || e.type === "turn.error" || e.type === "turn.abort");
      expect(msgEnd).toBeDefined();
      expect(terminal).toBeDefined();
      const maxFillSeq = Math.max(...fills.map((e) => e.seq));
      expect(maxFillSeq).toBeLessThan(msgEnd?.seq ?? -1);
      expect(maxFillSeq).toBeLessThan(terminal?.seq ?? -1);
    },
  );

  it("INV-DELTA (SPEC:749): a raw stream that ALSO carried response.reasoning_summary_text.delta folds the summary exactly once", () => {
    const stream = liveToolRound({ finalBlob: "ENC_FINAL", summary: [{ type: "summary_text", text: "only once" }] });
    // Splice the live summary-streaming events in after output_item.added{reasoning}.
    stream.splice(
      2,
      0,
      rawModel({ type: "response.reasoning_summary_part.added", item_id: RS, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
      rawModel({ type: "response.reasoning_summary_text.delta", item_id: RS, output_index: 0, summary_index: 0, delta: "only " }),
      rawModel({ type: "response.reasoning_summary_text.delta", item_id: RS, output_index: 0, summary_index: 0, delta: "once" }),
      rawModel({ type: "response.reasoning_summary_text.done", item_id: RS, output_index: 0, summary_index: 0, text: "only once" }),
    );
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of stream) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    const block = r
      .result()
      .messages.flatMap((m) => m.content)
      .find((b) => b.type === "reasoning");
    expect(block).toMatchObject({ type: "reasoning", text: "only once", itemId: RS });
  });

  it("fold: content[0] is the reasoning block (rs_ itemId + final opaque), content[1] the fc_ tool-call — the §10.4 stateless-replay order", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of liveToolRound({ finalBlob: "ENC_FINAL" })) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const assistant = res.messages.find((m) => m.content.some((b) => b.type === "reasoning"));
    expect(assistant).toBeDefined();
    expect(assistant?.content[0]).toMatchObject({
      type: "reasoning",
      itemId: RS,
      opaque: { kind: "ciphertext", value: "ENC_FINAL", provider: "openai" },
    });
    expect(assistant?.content[1]).toMatchObject({ type: "tool-call", itemId: FC });
    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });

  it("summary text rides one reasoning.delta PER summary part with partIndex = summary_index, sourced from the completed output's summary[] (the text the run-item's content[] is built from — agents-openai 0.18.0 openaiResponsesConverter.mjs:1481-1497); empty parts emit nothing", () => {
    const summary: JsonValue = [
      { type: "summary_text", text: "Plan: call echo. " },
      { type: "summary_text", text: "" },
      { type: "summary_text", text: "Then answer." },
    ];
    const evs = drive(liveToolRound({ finalBlob: "ENC_FINAL", summary }));
    const deltas = evs.filter((e) => e.type === "reasoning.delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ id: RS, delta: "Plan: call echo. ", partIndex: 0 });
    expect(deltas[1]).toMatchObject({ id: RS, delta: "Then answer.", partIndex: 2 });

    // The fold's `text` is the in-order concatenation of parts (SPEC reasoning.delta row).
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of liveToolRound({ finalBlob: "ENC_FINAL", summary })) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    const block = r
      .result()
      .messages.flatMap((m) => m.content)
      .find((b) => b.type === "reasoning");
    expect(block).toMatchObject({ text: "Plan: call echo. Then answer." });
  });

  it("mirror: no encrypted_content in the completed output ⇒ block still folds, but no reasoning.opaque and no late-reasoning ext", () => {
    const evs = drive(liveToolRound({}));
    const types = evs.map((e) => e.type);
    expect(types).toContain("reasoning.start");
    expect(types).toContain("reasoning.end");
    expect(types).not.toContain("reasoning.opaque");
    expect(types).not.toContain("ext.openai.late-reasoning");
  });

  it("response.incomplete carries the same output ⇒ the block is filled there too (the turn still closes as an error)", () => {
    const evs = drive(liveToolRound({ finalBlob: "ENC_FINAL", terminal: "response.incomplete" }));
    expect(evs.find((e) => e.type === "reasoning.opaque")).toMatchObject({ value: "ENC_FINAL", itemId: RS });
    expect(evs.find((e) => e.type === "turn.error")).toMatchObject({ code: "max_output_tokens" });
  });

  it("defensive: a reasoning item in the completed output with NO output_item.added still folds (opened at the terminal event)", () => {
    const evs = drive([
      rawModel({ type: "response.created", response: { id: "resp_noadd" } }),
      rawModel({
        type: "response.completed",
        response: {
          id: "resp_noadd",
          status: "completed",
          output: [{ id: "rs_noadd", type: "reasoning", content: [], summary: [], encrypted_content: "ENC_NOADD" }],
        },
      }),
    ]);
    expect(evs.find((e) => e.type === "reasoning.start")).toMatchObject({ id: "rs_noadd", itemId: "rs_noadd" });
    expect(evs.find((e) => e.type === "reasoning.opaque")).toMatchObject({ value: "ENC_NOADD", itemId: "rs_noadd" });
  });

  it("negative control: absent / empty / reasoning-free output ⇒ byte-identical to a completed event with no output field", () => {
    const base = (extra: { [k: string]: JsonValue }): AgEvent[] =>
      drive([
        rawModel({ type: "response.created", response: { id: "resp_neg" } }),
        rawModel({ type: "response.completed", response: { id: "resp_neg", status: "completed", ...extra } }),
      ]);
    const bare = base({});
    expect(base({ output: [] })).toEqual(bare);
    expect(base({ output: [{ id: "msg_1", type: "message", role: "assistant", content: [] }] })).toEqual(bare);
    // A malformed output (not an array) is ignored at the deserialization boundary.
    expect(base({ output: "not-an-array" })).toEqual(bare);
    expect(bare.map((e) => e.type)).not.toContain("reasoning.start");
  });

  it("run-item arriving while the message is still open after the raw fill ⇒ no duplicate block (single-source by rs_ id)", () => {
    const stream = liveToolRound({ finalBlob: "ENC_FINAL" });
    // Move the run-item BEFORE the terminal event (synthetic ordering).
    const runItemEv = stream.pop();
    const terminal = stream.pop();
    if (runItemEv === undefined || terminal === undefined) throw new Error("fixture shape");
    const reordered = [...stream, runItemEv, terminal];
    const evs = drive(reordered);
    expect(evs.filter((e) => e.type === "reasoning.start")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "reasoning.opaque")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "reasoning.end")).toHaveLength(1);
  });

  it("response.failed after the reasoning item opened ⇒ the open block folds empty (no opaque), the turn errors, no resync", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    const stream = [
      rawModel({ type: "response.created", response: { id: "resp_fail" } }),
      rawModel({ type: "response.output_item.added", item: { id: "rs_fail", type: "reasoning", summary: [] } }),
      rawModel({ type: "response.failed", response: { id: "resp_fail", error: { code: "server_error", message: "boom" } } }),
    ];
    for (const e of stream) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const block = res.messages.flatMap((m) => m.content).find((b) => b.type === "reasoning");
    expect(block).toMatchObject({ type: "reasoning", text: "", itemId: "rs_fail" });
    expect(block).not.toHaveProperty("opaque");
    expect(res.turns.some((t) => t.outcome?.type === "error")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OA-12 — `message.start.model?` (SPEC:610) filled from `response.created`'s
// `response.model` (live: echo-gpt6sol natives [1] `"model": "gpt-6-sol"`,
// which arrives BEFORE the message opens). An existing optional slot, folded to
// `AgMessage.model` (SPEC:585, reduce.ts); absent/non-string/empty ⇒ no key
// (byte-identical to pre-OA-12). sp-rnd finding #1 (2026-09-23).
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — OA-12 message.start.model from response.created", () => {
  function run(stream: JsonValue[]): AgEvent[] {
    const n = createOpenaiNormalizer();
    return stream.flatMap((e) => n.push(e)).concat(n.flush());
  }
  const textRound = (id: string, created: { [k: string]: JsonValue }): JsonValue[] => [
    rawModel({ type: "response.created", response: { id, ...created } }),
    rawModel({ type: "response.output_text.delta", item_id: `msg_${id}`, delta: "hi" }),
    rawModel({ type: "response.completed", response: { id, status: "completed" } }),
  ];

  it("response.created's model rides message.start.model and folds to AgMessage.model", () => {
    const stream = textRound("resp_m1", { model: "gpt-6-sol" });
    const evs = run(stream);
    expect(evs.find((e) => e.type === "message.start")).toMatchObject({ model: "gpt-6-sol" });

    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of stream) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages[0]).toMatchObject({ model: "gpt-6-sol" });
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });

  it("each response's message carries ITS OWN model (e.g. a handoff to an agent on another model)", () => {
    const evs = run([
      ...textRound("resp_a", { model: "gpt-6-sol" }),
      ...textRound("resp_b", { model: "gpt-6-luna" }),
    ]);
    const starts = evs.filter((e) => e.type === "message.start");
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ model: "gpt-6-sol" });
    expect(starts[1]).toMatchObject({ model: "gpt-6-luna" });
  });

  it("negative control: absent / non-string / empty model ⇒ no model key, byte-identical to a created event without it", () => {
    const bare = run(textRound("resp_neg", {}));
    expect(bare.find((e) => e.type === "message.start")).not.toHaveProperty("model");
    expect(run(textRound("resp_neg", { model: null }))).toEqual(bare);
    expect(run(textRound("resp_neg", { model: 42 }))).toEqual(bare);
    expect(run(textRound("resp_neg", { model: "" }))).toEqual(bare);
  });

  it("a message opened defensively BEFORE any response.created carries no model (nothing invented)", () => {
    const evs = run([
      rawModel({ type: "response.output_text.delta", item_id: "msg_x", delta: "hi" }),
      rawModel({ type: "response.created", response: { id: "resp_late_created", model: "gpt-6-sol" } }),
      rawModel({ type: "response.completed", response: { id: "resp_late_created", status: "completed" } }),
    ]);
    const starts = evs.filter((e) => e.type === "message.start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).not.toHaveProperty("model");
  });
});

// handoff_requested / handoff_occurred (Task 3, audit M48; corrected by the M48
// REVIEW, Finding 1). Every run-item on this seam — these two included — arrives
// AFTER its owning round's `response.completed` on the real wire (mirrors the
// #128 live-proven message_output_created ordering, M22 / Task 4b), so the
// fixtures below put `response.completed` BEFORE the handoff run-items.
describe("createOpenaiNormalizer — handoff_requested / handoff_occurred (Task 3, audit M48 review Finding 1)", () => {
  it("handoff_requested ⇒ subagent.start; handoff_occurred ⇒ subagent.done (agent identity rides via the paired handoff event, not subagentStart)", () => {
    const n = createOpenaiNormalizer({ invokeId: "inv1" });
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_handoff_1" } }),
      rawModel({ type: "response.completed", response: { id: "resp_handoff_1", status: "completed" } }),
      runItem("handoff_requested", {
        type: "handoff_call_item",
        rawItem: {
          type: "function_call",
          name: "transfer_to_billing_agent",
          callId: "call_handoff_1",
          arguments: "{}",
          id: "fc_handoff_1",
        },
        agent: { name: "triage_agent" },
      }),
      runItem("handoff_occurred", {
        type: "handoff_output_item",
        rawItem: {
          type: "function_call_result",
          name: "transfer_to_billing_agent",
          callId: "call_handoff_1",
          status: "completed",
          output: "Transferring to billing_agent",
        },
        sourceAgent: { name: "triage_agent" },
        targetAgent: { name: "billing_agent" },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    const start = evs.find((e) => e.type === "subagent.start") as {
      turnId?: string;
      parentTurnId?: string;
    };
    expect(start).toBeDefined();
    expect(start?.turnId).toBe("turn_inv1_handoff_1");
    expect(start?.parentTurnId).toBe("turn_resp_handoff_1");

    const done = evs.find((e) => e.type === "subagent.done") as {
      turnId?: string;
      parentTurnId?: string;
    };
    expect(done).toBeDefined();
    expect(done?.turnId).toBe("turn_inv1_handoff_1");
    expect(done?.parentTurnId).toBe("turn_resp_handoff_1");

    // Ordering: start precedes done, which precedes (or is same-batch-adjacent
    // to) the identity-carrying handoff event.
    const startIndex = evs.findIndex((e) => e.type === "subagent.start");
    const doneIndex = evs.findIndex((e) => e.type === "subagent.done");
    expect(startIndex).toBeLessThan(doneIndex);

    // Agent identity rides the follow-up `handoff` event — fired once BOTH
    // names are actually known (handoff_occurred time), not fabricated at
    // handoff_requested time.
    const handoff = evs.find((e) => e.type === "handoff") as {
      kind?: string;
      toAgentName?: string;
      fromAgentId?: string;
      toAgentId?: string;
    };
    expect(handoff).toBeDefined();
    expect(handoff?.kind).toBe("transfer");
    expect(handoff?.toAgentName).toBe("billing_agent");
    // No agent-ID concept exists anywhere on this seam (only names) —
    // fromAgentId/toAgentId are never fabricated from a name.
    expect(handoff?.fromAgentId).toBeUndefined();
    expect(handoff?.toAgentId).toBeUndefined();
  });

  it("fold-identity: the subagent turn record carries parentTurnId and the handoff lands on the parent round's handoffs[], needsResync=false (no park)", () => {
    const n = createOpenaiNormalizer({ invokeId: "inv1" });
    const r = new Reducer();
    const stream = [
      rawModel({ type: "response.created", response: { id: "resp_handoff_2" } }),
      // The transfer function_call the model emitted (live wire, handoff-gpt6sol):
      // its result rides handoff_occurred (HO), so this round stays open for it.
      rawModel({ type: "response.output_item.added", item: { id: "fc_handoff_2", type: "function_call", call_id: "call_handoff_2", name: "transfer_to_billing_agent" } }),
      rawModel({ type: "response.completed", response: { id: "resp_handoff_2", status: "completed" } }),
      runItem("handoff_requested", {
        type: "handoff_call_item",
        rawItem: {
          type: "function_call",
          name: "transfer_to_billing_agent",
          callId: "call_handoff_2",
          arguments: "{}",
        },
        agent: { name: "triage_agent" },
      }),
      runItem("handoff_occurred", {
        type: "handoff_output_item",
        rawItem: {
          type: "function_call_result",
          name: "transfer_to_billing_agent",
          callId: "call_handoff_2",
          status: "completed",
          output: "Transferring to billing_agent",
        },
        sourceAgent: { name: "triage_agent" },
        targetAgent: { name: "billing_agent" },
      }),
    ];
    for (const e of stream) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);

    const res = r.result();
    const subTurn = res.turns.find((t) => t.turnId === "turn_inv1_handoff_1");
    expect(subTurn).toBeDefined();
    expect(subTurn?.parentTurnId).toBe("turn_resp_handoff_2");
    expect(subTurn?.threadId).toBe("openai");

    const parentTurn = res.turns.find((t) => t.turnId === "turn_resp_handoff_2");
    expect(parentTurn?.handoffs).toMatchObject([{ kind: "transfer", toAgentName: "billing_agent" }]);

    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });

  it("defensive orphan: handoff_occurred with NO open handoff ⇒ standalone handoff event, lossless, no subagent.done", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_handoff_3" } }),
      rawModel({ type: "response.completed", response: { id: "resp_handoff_3", status: "completed" } }),
      // handoff_occurred arrives with no matching handoff_requested ever seen
      // (e.g. a resumed/truncated stream).
      runItem("handoff_occurred", {
        type: "handoff_output_item",
        rawItem: {
          type: "function_call_result",
          name: "transfer_to_billing_agent",
          callId: "call_handoff_orphan",
          status: "completed",
          output: "Transferring to billing_agent",
        },
        sourceAgent: { name: "triage_agent" },
        targetAgent: { name: "billing_agent" },
      }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    expect(evs.find((e) => e.type === "subagent.start")).toBeUndefined();
    expect(evs.find((e) => e.type === "subagent.done")).toBeUndefined();

    const handoff = evs.find((e) => e.type === "handoff") as { kind?: string; toAgentName?: string };
    expect(handoff).toBeDefined();
    expect(handoff?.kind).toBe("transfer");
    expect(handoff?.toAgentName).toBe("billing_agent");
  });
});

// HO — the handoff close (0.7.0 regression, sp-probe's live handoff-gpt6sol at
// c08a2a2). On the real wire the transfer is an ordinary function_call the
// model emits (`response.output_item.added` → tool.start, pending), and its
// result arrives ONLY as `handoff_occurred`'s `handoff_output_item` rawItem (a
// function_call_result for that callId), never as a `tool_output`. Without a
// tool.done there, the main round's deferred close never drained and O1's
// honest flush released it as turn.abort{stream-truncated}. The nested bracket
// closes with its draft.4 terminal (§8.0 item 29, §10 item 36): the SDK reports
// the transfer done, so success with finishReason "unknown", no usage.
describe("createOpenaiNormalizer — HO handoff close (the transfer result + the nested terminal)", () => {
  const U = { input_tokens: 90, output_tokens: 12, total_tokens: 102 };
  const TRANSFER_OUT = '{"assistant":"Echoer"}';
  function mainRound(respId: string, callId: string): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: respId, model: "gpt-6-sol" } }),
      rawModel({
        type: "response.output_item.added",
        item: { id: `fc_${callId}`, type: "function_call", status: "in_progress", arguments: "", call_id: callId, name: "transfer_to_Echoer" },
      }),
      rawModel({ type: "response.function_call_arguments.done", item_id: `fc_${callId}`, arguments: "{}" }),
      rawModel({ type: "response.completed", response: { id: respId, status: "completed", usage: U } }),
    ];
  }
  function requested(callId: string): JsonValue {
    return runItem("handoff_requested", {
      type: "handoff_call_item",
      rawItem: { type: "function_call", name: "transfer_to_Echoer", callId, status: "completed", arguments: "{}", id: `fc_${callId}` },
      agent: { name: "spike" },
    });
  }
  function occurred(callId: string): JsonValue {
    return runItem("handoff_occurred", {
      type: "handoff_output_item",
      rawItem: { type: "function_call_result", name: "transfer_to_Echoer", callId, status: "completed", output: { type: "text", text: TRANSFER_OUT } },
      sourceAgent: { name: "spike" },
      targetAgent: { name: "Echoer" },
    });
  }
  function echoerRound(respId: string): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: respId, model: "gpt-6-sol" } }),
      rawModel({ type: "response.output_item.added", item: { id: `msg_${respId}`, type: "message", status: "in_progress", content: [], role: "assistant" } }),
      rawModel({ type: "response.output_text.delta", item_id: `msg_${respId}`, delta: "handoff-probe" }),
      rawModel({ type: "response.completed", response: { id: respId, status: "completed", usage: U } }),
    ];
  }
  const LIVE_SHAPED: JsonValue[] = [
    ...mainRound("resp_ho_main", "call_ho"),
    requested("call_ho"),
    occurred("call_ho"),
    { type: "agent_updated_stream_event", agent: { name: "Echoer" } },
    ...echoerRound("resp_ho_echo"),
  ];
  function run(s: JsonValue[]): AgEvent[] {
    const n = createOpenaiNormalizer({ invokeId: "inv1" });
    return s.flatMap((e) => n.push(e)).concat(n.flush());
  }
  function fold(evs: AgEvent[]): Reducer {
    const r = new Reducer();
    for (const e of evs) r.push(e);
    return r;
  }

  it("the main round folds SUCCESS: the transfer call gets its tool.done (content = the transfer output), which drains the deferred close; no turn.abort anywhere", () => {
    const evs = run(LIVE_SHAPED);
    expect(evs.some((e) => e.type === "turn.abort")).toBe(false);
    const toolDone = evs.find((e) => e.type === "tool.done" && e.toolCallId === "call_ho");
    expect(toolDone).toMatchObject({
      turnId: "turn_resp_ho_main",
      content: [{ type: "text", text: TRANSFER_OUT }],
      outcome: "ok",
      isError: false,
    });
    const mainDone = evs.find((e) => e.type === "turn.done" && e.turnId === "turn_resp_ho_main");
    expect(mainDone).toMatchObject({ outcome: { type: "success" }, usage: { inputTokens: 90, outputTokens: 12 } });
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    expect(res.turns.find((t) => t.turnId === "turn_resp_ho_main")?.outcome).toMatchObject({ type: "success" });
    expect(res.turns.find((t) => t.turnId === "turn_resp_ho_echo")?.outcome).toMatchObject({ type: "success" });
    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });

  it("the main round closes AT handoff_occurred, not at flush: that one push() batch is the whole close", () => {
    const n = createOpenaiNormalizer({ invokeId: "inv1" });
    for (const e of mainRound("resp_ho_main", "call_ho")) n.push(e);
    n.push(requested("call_ho"));
    const batch = n.push(occurred("call_ho"));
    // message.end names its message by `id` (the owner resolves through it, INV-OWNER).
    const owner = (e: AgEvent): string | undefined =>
      e.type === "message.end" ? e.id : "turnId" in e ? e.turnId : undefined;
    expect(batch.map((e) => [e.type, owner(e)])).toEqual([
      ["turn.done", "turn_inv1_handoff_1"],
      ["subagent.done", "turn_inv1_handoff_1"],
      ["handoff", "turn_resp_ho_main"],
      ["tool.done", "turn_resp_ho_main"],
      ["message.end", "msg_turn_resp_ho_main"],
      ["turn.done", "turn_resp_ho_main"],
    ]);
  });

  it("wire order at handoff_occurred: nested turn.done{success, unknown, no usage} → subagent.done (adjacent) → handoff → tool.done → main message.end → main turn.done", () => {
    const evs = run(LIVE_SHAPED);
    const nestedTerminals = evs.filter(
      (e) => (e.type === "turn.done" || e.type === "turn.abort" || e.type === "turn.error") && e.turnId === "turn_inv1_handoff_1",
    );
    expect(nestedTerminals).toHaveLength(1);
    const nested = nestedTerminals[0];
    expect(nested).toMatchObject({ type: "turn.done", outcome: { type: "success" }, finishReason: "unknown" });
    expect(nested).not.toHaveProperty("usage");
    const at = (pred: (e: AgEvent) => boolean): number => evs.findIndex(pred);
    const iNested = at((e) => e.type === "turn.done" && e.turnId === "turn_inv1_handoff_1");
    const iSubDone = at((e) => e.type === "subagent.done");
    const iHandoff = at((e) => e.type === "handoff");
    const iToolDone = at((e) => e.type === "tool.done" && e.toolCallId === "call_ho");
    const iMainEnd = at((e) => e.type === "message.end" && e.id === "msg_turn_resp_ho_main");
    const iMainDone = at((e) => e.type === "turn.done" && e.turnId === "turn_resp_ho_main");
    expect(iSubDone).toBe(iNested + 1);
    expect(iHandoff).toBeGreaterThan(iSubDone);
    expect(iToolDone).toBeGreaterThan(iHandoff);
    expect(iMainEnd).toBeGreaterThan(iToolDone);
    expect(iMainDone).toBeGreaterThan(iMainEnd);
    // The target agent's round opens only after the source round closed.
    expect(at((e) => e.type === "turn.start" && e.turnId === "turn_resp_ho_echo")).toBeGreaterThan(iMainDone);
    // The nested record carries the outcome; the handoff still lands on the parent.
    const res = fold(evs).result();
    expect(res.turns.find((t) => t.turnId === "turn_inv1_handoff_1")).toMatchObject({
      parentTurnId: "turn_resp_ho_main",
      outcome: { type: "success" },
    });
    expect(res.turns.find((t) => t.turnId === "turn_resp_ho_main")?.handoffs).toMatchObject([{ kind: "transfer", toAgentName: "Echoer" }]);
  });

  it("§10 item 36: folding with the subagent.done events removed (seq renumbered, INV-SEQ) is structurally identical", () => {
    const evs = run(LIVE_SHAPED);
    expect(evs.some((e) => e.type === "subagent.done")).toBe(true);
    const without = evs.filter((e) => e.type !== "subagent.done").map((e, seq) => ({ ...e, seq }));
    const withDone = fold(evs);
    const withoutDone = fold(without);
    expect(withDone.needsResync).toBe(false);
    expect(withoutDone.needsResync).toBe(false);
    expect(withoutDone.result()).toEqual(withDone.result());
  });

  it("a bracket still open at flush (handoff_requested, no handoff_occurred) is never closed success: the nested turn aborts, and so does the round whose transfer never resolved", () => {
    const evs = run([...mainRound("resp_ho_cut", "call_cut"), requested("call_cut")]);
    // No turn.done at all: both closes are flush-time, and a flush never emits success.
    expect(evs.some((e) => e.type === "turn.done")).toBe(false);
    expect(evs.find((e) => e.type === "turn.abort" && e.turnId === "turn_inv1_handoff_1")).toMatchObject({ reason: "stream-truncated" });
    expect(evs.find((e) => e.type === "turn.abort" && e.turnId === "turn_resp_ho_cut")).toMatchObject({ reason: "stream-truncated" });
    expect(evs.some((e) => e.type === "tool.done")).toBe(false);
    expect(fold(evs).needsResync).toBe(false);
  });

  it("a RESUMED invoke whose leading item is handoff_occurred (agents-core resolveInterruptedTurn runs the interrupted response's handoff): the result opens turn_resume_<callId>, the handoff lands there too, the target's response adopts that turn; no park", () => {
    const evs = run([occurred("call_ho_resumed"), ...echoerRound("resp_ho_after")]);
    const start = evs.find((e) => e.type === "turn.start");
    expect(start).toMatchObject({ turnId: "turn_resume_call_ho_resumed" });
    expect(evs.find((e) => e.type === "handoff")).toMatchObject({ turnId: "turn_resume_call_ho_resumed", toAgentName: "Echoer" });
    expect(evs.find((e) => e.type === "tool.done")).toMatchObject({
      turnId: "turn_resume_call_ho_resumed",
      messageId: "call_ho_resumed:result",
      content: [{ type: "text", text: TRANSFER_OUT }],
    });
    // No bracket was opened in this invoke, so none is closed.
    expect(evs.some((e) => e.type === "subagent.done" || e.type === "subagent.start")).toBe(false);
    expect(evs.filter((e) => e.type === "turn.start")).toHaveLength(1);
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns).toMatchObject([{ turnId: "turn_resume_call_ho_resumed", outcome: { type: "success" }, handoffs: [{ toAgentName: "Echoer" }] }]);
  });

  it("negative control: a transfer_to_* function_call whose result rides a plain tool_output still drains through the tool_output arm, exactly once", () => {
    const evs = run([
      ...mainRound("resp_ho_plain", "call_plain"),
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: { type: "function_call_result", name: "transfer_to_Echoer", callId: "call_plain", status: "completed", output: "Multiple handoffs detected, ignoring this one." },
        output: "Multiple handoffs detected, ignoring this one.",
      }),
    ]);
    expect(evs.filter((e) => e.type === "tool.done")).toHaveLength(1);
    expect(evs.find((e) => e.type === "turn.done" && e.turnId === "turn_resp_ho_plain")).toMatchObject({ outcome: { type: "success" } });
    expect(evs.some((e) => e.type === "subagent.start" || e.type === "handoff")).toBe(false);
  });
});

describe("createOpenaiNormalizer — compaction_item_created (0.14.3)", () => {
  it("⇒ content.block{type:'compaction'} with the ciphertext opaque — converging with the claude facet's compaction vocabulary", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_compaction_1" } }),
      runItem("compaction_item_created", {
        type: "compaction_item",
        rawItem: {
          type: "compaction",
          encrypted_content: "enc_openai_blob_1",
          id: "cmp_1",
          created_by: "context_manager",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_compaction_1", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    const block = evs.find((e) => e.type === "content.block") as {
      block?: { type?: string; opaque?: { kind?: string; value?: string; provider?: string }; provider?: string };
      turnId?: string;
    };
    expect(block).toBeDefined();
    expect(block?.block).toMatchObject({
      type: "compaction",
      provider: "openai",
      opaque: { kind: "ciphertext", value: "enc_openai_blob_1", provider: "openai" },
    });
    // turn-scoped: the engine backfills the turnId; the marker attaches to no message.
    expect(block?.turnId).toBeDefined();
    // …and it is NOT double-carried through the unknown-name ext channel.
    expect(evs.some((e) => e.type === "ext.openai.unparsed")).toBe(false);
    // The reducer folds the stream without parking.
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
  });
});

describe("createOpenaiNormalizer — tool_approval_requested (Task 3, audit M48)", () => {
  it("⇒ hitl.ask{kind:'approval', toolCallId, askId} — the M26 paused-fold discipline is ADK-scoped this batch; openai just emits the ask", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_approval_1" } }),
      runItem("tool_approval_requested", {
        type: "tool_approval_item",
        rawItem: {
          type: "function_call",
          name: "send_email",
          callId: "call_approval_1",
          arguments: '{"to":"x@example.com"}',
          id: "fc_approval_1",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_approval_1", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    const ask = evs.find((e) => e.type === "hitl.ask") as {
      kind?: string;
      toolCallId?: string;
      askId?: string;
    };
    expect(ask).toBeDefined();
    expect(ask?.kind).toBe("approval");
    expect(ask?.toolCallId).toBe("call_approval_1");
    expect(ask?.askId).toBeDefined();
    expect(typeof ask?.askId).toBe("string");
  });

  it("fold-identity: hitl.ask is live-only (no accumulator mutation) — needsResync stays false", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    const stream = [
      rawModel({ type: "response.created", response: { id: "resp_approval_2" } }),
      runItem("tool_approval_requested", {
        type: "tool_approval_item",
        rawItem: {
          type: "function_call",
          name: "send_email",
          callId: "call_approval_2",
          arguments: "{}",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_approval_2", status: "completed" } }),
    ];
    for (const e of stream) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });
});

describe("createOpenaiNormalizer — default run-item arm (Task 3, audit M48)", () => {
  it("a genuinely-unknown run-item name routes to ext.openai.unparsed (the file's stated convention, now true)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_unk_1" } }),
      runItem("mcp_list_tools", { type: "mcp_list_tools_item", rawItem: { foo: "bar" } }),
      rawModel({ type: "response.completed", response: { id: "resp_unk_1", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const unparsed = evs.find((e) => e.type === "ext.openai.unparsed") as {
      name?: string;
      item?: unknown;
    };
    expect(unparsed).toBeDefined();
    expect(unparsed?.name).toBe("mcp_list_tools");
    expect(unparsed?.item).toEqual({ type: "mcp_list_tools_item", rawItem: { foo: "bar" } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding #1 (critical, playbook 2026-07-03 SDK-bump adaptation, @openai/agents
// 0.2.1 → 0.12.0): Shell / Apply-Patch / Hosted-tool built-in calls reuse the
// EXISTING `tool_called`/`tool_output` run-item names with NEW `rawItem`
// shapes the facet's authoritative `response.output_item.added`-only tool-start
// path never recognized — before this fix, `tool_output` WOULD still fire a
// generic `tool.done` (shape-compatible field names) with NO matching
// `tool.start` ever emitted: an orphaned done. Fixed by making the `tool_called`/
// `tool_output` run-item WRAPPER (not the raw stream) the sole tool-start/done
// source for these three discriminants — full start/args/done lifecycle, one
// test per discriminant + a combined fold test.
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — built-in tool lifecycle: shell_call (playbook 2026-07-03)", () => {
  const SHELL_ROUND: JsonValue[] = [
    rawModel({ type: "response.created", response: { id: "resp_shell_1" } }),
    runItem("tool_called", {
      type: "tool_call_item",
      rawItem: {
        type: "shell_call",
        callId: "call_shell_1",
        status: "in_progress",
        action: { commands: ["ls", "-la"], timeoutMs: 5000 },
        id: "item_shell_1",
      },
    }),
    // Defensive: a real capture may ALSO fire the raw output_item.added for
    // this item — the (unchanged, function_call-only) raw path must no-op it,
    // not double-start.
    rawModel({
      type: "response.output_item.added",
      item: { id: "item_shell_1", type: "shell_call", call_id: "call_shell_1" },
    }),
    runItem("tool_output", {
      type: "tool_call_output_item",
      rawItem: {
        type: "shell_call_output",
        callId: "call_shell_1",
        output: [{ stdout: "file1\nfile2\n", stderr: "", outcome: { type: "exit", exitCode: 0 } }],
      },
    }),
    rawModel({ type: "response.completed", response: { id: "resp_shell_1", status: "completed" } }),
  ];

  it("synthesizes tool.start with name builtin:shell from the tool_called wrapper", () => {
    const n = createOpenaiNormalizer();
    const evs = SHELL_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const starts = evs.filter((e) => e.type === "tool.start");
    expect(starts).toHaveLength(1); // exactly one — the raw output_item.added no-ops
    expect(starts[0]).toMatchObject({ toolCallId: "call_shell_1", name: "builtin:shell" });
  });

  it("emits tool.args.assembled with the shell action object", () => {
    const n = createOpenaiNormalizer();
    const evs = SHELL_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({
      toolCallId: "call_shell_1",
      input: { commands: ["ls", "-la"], timeoutMs: 5000 },
    });
  });

  it("emits tool.done with the joined stdout/stderr as content and outcome:ok for a clean exit", () => {
    const n = createOpenaiNormalizer();
    const evs = SHELL_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as {
      toolCallId?: string;
      outcome?: string;
      content?: { type: string; text?: string }[];
    };
    expect(done?.toolCallId).toBe("call_shell_1");
    expect(done?.outcome).toBe("ok");
    expect(done?.content?.[0]).toMatchObject({ type: "text", text: "file1\nfile2\n" });
  });

  it("maps a non-zero exit code to outcome:error", () => {
    const n = createOpenaiNormalizer();
    const errorRound = SHELL_ROUND.map((e) =>
      e === SHELL_ROUND[3]
        ? runItem("tool_output", {
            type: "tool_call_output_item",
            rawItem: {
              type: "shell_call_output",
              callId: "call_shell_1",
              output: [{ stdout: "", stderr: "not found", outcome: { type: "exit", exitCode: 1 } }],
            },
          })
        : e,
    );
    const evs = errorRound.flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as { outcome?: string; isError?: boolean };
    expect(done?.outcome).toBe("error");
    expect(done?.isError).toBe(true);
  });

  it("no orphaned tool.done — tool.start always precedes tool.done for the same toolCallId", () => {
    const n = createOpenaiNormalizer();
    const evs = SHELL_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const startIdx = evs.findIndex((e) => e.type === "tool.start");
    const doneIdx = evs.findIndex((e) => e.type === "tool.done");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(startIdx);
  });

  it("fold: no resync, exactly one tool-call + tool-result block pair, no park", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of SHELL_ROUND) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const allBlocks = res.messages.flatMap((m) => m.content);
    expect(allBlocks.filter((b) => b.type === "tool-call")).toHaveLength(1);
    expect(allBlocks.filter((b) => b.type === "tool-result")).toHaveLength(1);
  });
});

describe("createOpenaiNormalizer — built-in tool lifecycle: apply_patch_call (playbook 2026-07-03)", () => {
  const APPLY_PATCH_ROUND: JsonValue[] = [
    rawModel({ type: "response.created", response: { id: "resp_patch_1" } }),
    runItem("tool_called", {
      type: "tool_call_item",
      rawItem: {
        type: "apply_patch_call",
        callId: "call_patch_1",
        status: "in_progress",
        operation: { type: "create_file", path: "hello.txt", diff: "+hello" },
        id: "item_patch_1",
      },
    }),
    runItem("tool_output", {
      type: "tool_call_output_item",
      rawItem: {
        type: "apply_patch_call_output",
        callId: "call_patch_1",
        status: "completed",
        output: "applied",
      },
    }),
    rawModel({ type: "response.completed", response: { id: "resp_patch_1", status: "completed" } }),
  ];

  it("synthesizes tool.start with name builtin:apply_patch and the operation as args", () => {
    const n = createOpenaiNormalizer();
    const evs = APPLY_PATCH_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const start = evs.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ toolCallId: "call_patch_1", name: "builtin:apply_patch" });
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({
      toolCallId: "call_patch_1",
      input: { type: "create_file", path: "hello.txt", diff: "+hello" },
    });
  });

  it("emits tool.done with outcome:ok for status:completed", () => {
    const n = createOpenaiNormalizer();
    const evs = APPLY_PATCH_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as {
      outcome?: string;
      content?: { type: string; text?: string }[];
    };
    expect(done?.outcome).toBe("ok");
    expect(done?.content?.[0]).toMatchObject({ type: "text", text: "applied" });
  });

  it("maps status:failed to outcome:error", () => {
    const n = createOpenaiNormalizer();
    const failedRound = APPLY_PATCH_ROUND.map((e) =>
      e === APPLY_PATCH_ROUND[2]
        ? runItem("tool_output", {
            type: "tool_call_output_item",
            rawItem: {
              type: "apply_patch_call_output",
              callId: "call_patch_1",
              status: "failed",
              output: "permission denied",
            },
          })
        : e,
    );
    const evs = failedRound.flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as { outcome?: string; isError?: boolean };
    expect(done?.outcome).toBe("error");
    expect(done?.isError).toBe(true);
  });

  it("fold: no resync, no orphan tool.done", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of APPLY_PATCH_ROUND) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const allBlocks = res.messages.flatMap((m) => m.content);
    expect(allBlocks.filter((b) => b.type === "tool-call")).toHaveLength(1);
    expect(allBlocks.filter((b) => b.type === "tool-result")).toHaveLength(1);
  });
});

describe("createOpenaiNormalizer — built-in tool lifecycle: hosted_tool_call (playbook 2026-07-03)", () => {
  // Unlike shell_call/apply_patch_call, a hosted tool call is ALREADY RESOLVED
  // (output present) by the time the ONE tool_called wrapper streams — there is
  // no separate tool_output for it (verified against @openai/agents-core
  // 0.12.0's runner/modelOutputs.mjs).
  const HOSTED_ROUND: JsonValue[] = [
    rawModel({ type: "response.created", response: { id: "resp_hosted_1" } }),
    runItem("tool_called", {
      type: "tool_call_item",
      rawItem: {
        type: "hosted_tool_call",
        id: "item_hosted_1",
        name: "web_search_call",
        arguments: '{"query":"weather today"}',
        status: "completed",
        output: "It is sunny.",
      },
    }),
    rawModel({ type: "response.completed", response: { id: "resp_hosted_1", status: "completed" } }),
  ];

  it("emits tool.start with the item's own real name (no builtin: synthesis)", () => {
    const n = createOpenaiNormalizer();
    const evs = HOSTED_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const start = evs.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ toolCallId: "item_hosted_1", name: "web_search_call" });
  });

  it("emits tool.args.assembled by parsing the arguments JSON string", () => {
    const n = createOpenaiNormalizer();
    const evs = HOSTED_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ input: { query: "weather today" } });
  });

  it("emits tool.start THEN tool.done TOGETHER from the single tool_called event (no separate tool_output)", () => {
    const n = createOpenaiNormalizer();
    const evs = HOSTED_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const startIdx = evs.findIndex((e) => e.type === "tool.start");
    const doneIdx = evs.findIndex((e) => e.type === "tool.done");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(startIdx);
    const done = evs.find((e) => e.type === "tool.done") as {
      outcome?: string;
      content?: { type: string; text?: string }[];
    };
    expect(done?.outcome).toBe("ok");
    expect(done?.content?.[0]).toMatchObject({ type: "text", text: "It is sunny." });
  });

  it("malformed arguments JSON degrades gracefully — ext.openai.unparsed, not a crash", () => {
    const n = createOpenaiNormalizer();
    const malformedRound = HOSTED_ROUND.map((e) =>
      e === HOSTED_ROUND[1]
        ? runItem("tool_called", {
            type: "tool_call_item",
            rawItem: {
              type: "hosted_tool_call",
              id: "item_hosted_2",
              name: "web_search_call",
              arguments: "{not-json",
              status: "completed",
              output: "It is sunny.",
            },
          })
        : e,
    );
    expect(() => malformedRound.flatMap((e) => n.push(e))).not.toThrow();
    const evs = malformedRound.flatMap((e) => n.push(e)).concat(n.flush());
    expect(evs.some((e) => e.type === "ext.openai.unparsed")).toBe(true);
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ input: {} });
  });

  it("fold: no resync, one tool-call + tool-result block pair", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of HOSTED_ROUND) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const allBlocks = res.messages.flatMap((m) => m.content);
    expect(allBlocks.filter((b) => b.type === "tool-call")).toHaveLength(1);
    expect(allBlocks.filter((b) => b.type === "tool-result")).toHaveLength(1);
  });
});

// ─── computer_call / computer_call_result (fixture-drift ratchet finding, ────
// 2026-07-03) — the SAME orphan-tool.done bug class Finding #1 fixed for
// shell_call/apply_patch_call, confirmed still present for OpenAI's
// Computer-Use built-in tool (which rides the exact SAME `tool_called`/
// `tool_output` event names). `ComputerUseCallItem` carries NO `name` field
// (unlike hosted_tool_call, which has one) — pre-fix, `builtinToolName()`'s
// fallback (`rawItem.name`) would have synthesized `name: undefined` on
// `a.toolStart()`. `ComputerCallResultItem.output` is `{type:"computer_
// screenshot", data}` (a base64 PNG) — pre-fix, the generic
// `toolOutputToAgBlocks` path's `.type === "text"` check never matched it,
// producing an orphaned tool.done with silently-EMPTY content.
describe("createOpenaiNormalizer — built-in tool lifecycle: computer_call (fixture-drift ratchet, 2026-07-03)", () => {
  const COMPUTER_ROUND: JsonValue[] = [
    rawModel({ type: "response.created", response: { id: "resp_computer_1" } }),
    runItem("tool_called", {
      type: "tool_call_item",
      rawItem: {
        type: "computer_call",
        callId: "call_computer_1",
        status: "in_progress",
        action: { type: "screenshot" },
        id: "item_computer_1",
      },
    }),
    runItem("tool_output", {
      type: "tool_call_output_item",
      rawItem: {
        type: "computer_call_result",
        callId: "call_computer_1",
        output: { type: "computer_screenshot", data: "aGVsbG8=" },
      },
    }),
    rawModel({ type: "response.completed", response: { id: "resp_computer_1", status: "completed" } }),
  ];

  it("synthesizes tool.start with name builtin:computer (regression: NOT name:undefined)", () => {
    const n = createOpenaiNormalizer();
    const evs = COMPUTER_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const starts = evs.filter((e) => e.type === "tool.start");
    expect(starts).toHaveLength(1); // exactly one — no double-start
    expect(starts[0]).toMatchObject({ toolCallId: "call_computer_1", name: "builtin:computer" });
    expect((starts[0] as { name?: unknown }).name).not.toBeUndefined();
  });

  it("emits tool.args.assembled with the computer action object carried through verbatim", () => {
    const n = createOpenaiNormalizer();
    const evs = COMPUTER_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "call_computer_1", input: { type: "screenshot" } });
  });

  it("emits tool.done with the screenshot landed as a file block (base64 PNG) — regression: NOT orphaned-empty content", () => {
    const n = createOpenaiNormalizer();
    const evs = COMPUTER_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as {
      toolCallId?: string;
      outcome?: string;
      content?: { type: string; source?: { type: string; mediaType?: string; data?: string } }[];
    };
    expect(done?.toolCallId).toBe("call_computer_1");
    expect(done?.outcome).toBe("ok");
    expect(done?.content).toHaveLength(1);
    expect(done?.content?.[0]).toMatchObject({
      type: "file",
      source: { type: "base64", mediaType: "image/png", data: "aGVsbG8=" },
    });
  });

  it("no orphaned tool.done — tool.start always precedes tool.done for the same toolCallId", () => {
    const n = createOpenaiNormalizer();
    const evs = COMPUTER_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const startIdx = evs.findIndex((e) => e.type === "tool.start");
    const doneIdx = evs.findIndex((e) => e.type === "tool.done");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(startIdx);
  });

  it("fold: no resync, exactly one tool-call + tool-result block pair, no park", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of COMPUTER_ROUND) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const allBlocks = res.messages.flatMap((m) => m.content);
    expect(allBlocks.filter((b) => b.type === "tool-call")).toHaveLength(1);
    expect(allBlocks.filter((b) => b.type === "tool-result")).toHaveLength(1);
  });

  it("(ratchet finding) computer_call with actions[] batch (no action field) — the batch carries through to tool.args.assembled input (SDK precedence: actions ?? action)", () => {
    const n = createOpenaiNormalizer();
    // A computer_call with actions batch but NO action field — SDK reads actions first.
    // The fixture uses a plausible two-action batch (click + type).
    const batchRound: JsonValue[] = [
      rawModel({ type: "response.created", response: { id: "resp_computer_batch_1" } }),
      runItem("tool_called", {
        type: "tool_call_item",
        rawItem: {
          type: "computer_call",
          callId: "call_computer_batch_1",
          status: "in_progress",
          // actions populated, action absent — SDK reads actions FIRST
          actions: [
            { type: "click", coordinate: [100, 200] },
            { type: "type", text: "hello" },
          ],
          id: "item_computer_batch_1",
        },
      }),
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: {
          type: "computer_call_result",
          callId: "call_computer_batch_1",
          output: { type: "computer_screenshot", data: "aGVsbG8=" },
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_computer_batch_1", status: "completed" } }),
    ];
    const evs = batchRound.flatMap((e) => n.push(e)).concat(n.flush());

    // Regression: the batch MUST be carried through to the input, not silently lost
    // to {}. Byte-preserves whatever went into actions.
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toBeDefined();
    expect((assembled as { input?: unknown }).input).toEqual([
      { type: "click", coordinate: [100, 200] },
      { type: "type", text: "hello" },
    ]);
  });
});

describe("createOpenaiNormalizer — built-in tool lifecycle: tool_search (fixture-drift ratchet disposition, 2026-07-03)", () => {
  // tool_search_called/tool_search_output_created were the last weak
  // `carried` entries in the fixture-drift ratchet manifest. Wire-truth
  // re-investigation against the installed @openai/agents-core 0.12.0
  // (dist/types/protocol.d.ts, dist/events.d.ts, dist/runner/modelOutputs.mjs
  // + streaming.mjs + tooling.mjs) found: (1) these are DEDICATED
  // RunItemStreamEventName literals (not a tool_called/tool_output reuse —
  // §8 item 20's family), (2) they stream as a PAIRED call+output (mirrors
  // shell_call/apply_patch_call/computer_call, not hosted_tool_call's
  // single-shot collapse), (3) the output's `tools` array is a genuine
  // structured retrieval listing (never opaque), so an honest first-class
  // tool.start/tool.done lifecycle IS supportable — see
  // `driveToolSearchCalled`/`driveToolSearchOutput`'s docs in index.ts.
  const TOOL_SEARCH_ROUND: JsonValue[] = [
    rawModel({ type: "response.created", response: { id: "resp_search_1" } }),
    runItem("tool_search_called", {
      type: "tool_search_call_item",
      rawItem: {
        type: "tool_search_call",
        callId: "call_search_1",
        execution: "server",
        arguments: { query: "weather tools" },
        id: "item_search_1",
      },
    }),
    runItem("tool_search_output_created", {
      type: "tool_search_output_item",
      rawItem: {
        type: "tool_search_output",
        callId: "call_search_1",
        tools: [{ type: "tool_reference", functionName: "get_weather" }],
      },
    }),
    rawModel({ type: "response.completed", response: { id: "resp_search_1", status: "completed" } }),
  ];

  it("synthesizes tool.start with name builtin:tool_search from the tool_search_called wrapper", () => {
    const n = createOpenaiNormalizer();
    const evs = TOOL_SEARCH_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const starts = evs.filter((e) => e.type === "tool.start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ toolCallId: "call_search_1", name: "builtin:tool_search" });
  });

  it("emits tool.args.assembled with the call's arguments object, carried verbatim (not JSON-string-parsed)", () => {
    const n = createOpenaiNormalizer();
    const evs = TOOL_SEARCH_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "call_search_1", input: { query: "weather tools" } });
  });

  it("emits tool.done with the tools listing as a `data` block and outcome:ok", () => {
    const n = createOpenaiNormalizer();
    const evs = TOOL_SEARCH_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as {
      toolCallId?: string;
      outcome?: string;
      content?: { type: string; name?: string; data?: unknown }[];
    };
    expect(done?.toolCallId).toBe("call_search_1");
    expect(done?.outcome).toBe("ok");
    expect(done?.content).toEqual([
      { type: "data", name: "tool_search_results", data: [{ type: "tool_reference", functionName: "get_weather" }] },
    ]);
  });

  it("no orphaned tool.done — tool.start always precedes tool.done for the same toolCallId", () => {
    const n = createOpenaiNormalizer();
    const evs = TOOL_SEARCH_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const startIdx = evs.findIndex((e) => e.type === "tool.start");
    const doneIdx = evs.findIndex((e) => e.type === "tool.done");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(startIdx);
  });

  it("correlates via providerData.call_id — the SDK's own client-executed built-in-loader output shape (createClientToolSearchOutputFromTools)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_search_2" } }),
      runItem("tool_search_called", {
        type: "tool_search_call_item",
        rawItem: {
          type: "tool_search_call",
          id: "item_search_2",
          execution: "client",
          arguments: { paths: ["weather"] },
        },
      }),
      // No top-level call_id/callId/id — only providerData.call_id, exactly
      // agents-core 0.12.0's toolSearch.mjs createClientToolSearchOutputFromTools shape.
      runItem("tool_search_output_created", {
        type: "tool_search_output_item",
        rawItem: {
          type: "tool_search_output",
          tools: [{ type: "function", name: "get_weather" }],
          providerData: { call_id: "item_search_2", execution: "client" },
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_search_2", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const start = evs.find((e) => e.type === "tool.start") as { toolCallId?: string };
    const done = evs.find((e) => e.type === "tool.done") as { toolCallId?: string };
    expect(start?.toolCallId).toBe("item_search_2");
    expect(done?.toolCallId).toBe("item_search_2");
  });

  it("degrades to ext.openai.unparsed (no fabricated tool.start) when a call carries no identifiable id at all", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_search_3" } }),
      runItem("tool_search_called", {
        type: "tool_search_call_item",
        rawItem: { type: "tool_search_call", arguments: { query: "x" } }, // no id, callId, or call_id
      }),
      rawModel({ type: "response.completed", response: { id: "resp_search_3", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    expect(evs.some((e) => e.type === "tool.start")).toBe(false);
    const unparsed = evs.find((e) => e.type === "ext.openai.unparsed") as { name?: string };
    expect(unparsed?.name).toBe("tool_search_called");
  });

  it("degrades to ext.openai.unparsed (no fabricated tool.done) when an output carries no identifiable id at all", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_search_4" } }),
      runItem("tool_search_output_created", {
        type: "tool_search_output_item",
        rawItem: { type: "tool_search_output", tools: [] },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_search_4", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    expect(evs.some((e) => e.type === "tool.done")).toBe(false);
    const unparsed = evs.find((e) => e.type === "ext.openai.unparsed") as { name?: string };
    expect(unparsed?.name).toBe("tool_search_output_created");
  });

  it("carries a zero-match search (empty tools[]) as an empty-array data block, not dropped", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_search_5" } }),
      runItem("tool_search_called", {
        type: "tool_search_call_item",
        rawItem: { type: "tool_search_call", callId: "call_search_5", arguments: { query: "nonexistent" } },
      }),
      runItem("tool_search_output_created", {
        type: "tool_search_output_item",
        rawItem: { type: "tool_search_output", callId: "call_search_5", tools: [] },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_search_5", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as { content?: { type: string; data?: unknown }[] };
    expect(done?.content).toEqual([{ type: "data", name: "tool_search_results", data: [] }]);
  });

  it("fold: no resync, exactly one tool-call + tool-result block pair, no park", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of TOOL_SEARCH_ROUND) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const allBlocks = res.messages.flatMap((m) => m.content);
    expect(allBlocks.filter((b) => b.type === "tool-call")).toHaveLength(1);
    expect(allBlocks.filter((b) => b.type === "tool-result")).toHaveLength(1);
  });

  it("divergent-channel regression (review finding): call and output carry different ids on different channels, resolveToolSearchCallId precedence (providerData first) ensures pairing on the authoritative providerData.call_id", () => {
    // The call item carries top-level callId "A", but the output carries ONLY
    // providerData.call_id "B". If the resolver checks top-level callId FIRST
    // (the old wrong order), tool.start resolves to "A" and tool.done resolves
    // to "B" → silent mis-pair (unlinked tool-call/tool-result blocks, no
    // resync). The correct precedence (providerData FIRST) resolves both to "B"
    // and they link correctly.
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_div_1" } }),
      runItem("tool_search_called", {
        type: "tool_search_call_item",
        rawItem: {
          type: "tool_search_call",
          callId: "call_divergent_A", // top-level callId is "A"
          execution: "client",
          arguments: { query: "test" },
          providerData: { call_id: "call_divergent_B" }, // but providerData.call_id is "B"
        },
      }),
      runItem("tool_search_output_created", {
        type: "tool_search_output_item",
        rawItem: {
          type: "tool_search_output",
          tools: [{ type: "tool_reference", functionName: "test_tool" }],
          providerData: { call_id: "call_divergent_B" }, // output carries ONLY providerData.call_id "B"
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_div_1", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    // Both tool.start and tool.done resolve to "B" (the authoritative providerData.call_id).
    const start = evs.find((e) => e.type === "tool.start") as { toolCallId?: string };
    const done = evs.find((e) => e.type === "tool.done") as { toolCallId?: string };
    expect(start?.toolCallId).toBe("call_divergent_B");
    expect(done?.toolCallId).toBe("call_divergent_B");

    // Full fold: they pair correctly (one tool-call + one tool-result, same id), no resync-park.
    const n2 = createOpenaiNormalizer();
    const r = new Reducer();
    const corpus = [
      rawModel({ type: "response.created", response: { id: "resp_div_2" } }),
      runItem("tool_search_called", {
        type: "tool_search_call_item",
        rawItem: {
          type: "tool_search_call",
          callId: "call_divergent_A",
          execution: "client",
          arguments: { query: "test" },
          providerData: { call_id: "call_divergent_B" },
        },
      }),
      runItem("tool_search_output_created", {
        type: "tool_search_output_item",
        rawItem: {
          type: "tool_search_output",
          tools: [{ type: "tool_reference", functionName: "test_tool" }],
          providerData: { call_id: "call_divergent_B" },
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_div_2", status: "completed" } }),
    ];
    for (const e of corpus) for (const ev of n2.push(e)) r.push(ev);
    for (const ev of n2.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const allBlocks = res.messages.flatMap((m) => m.content);
    const toolCall = allBlocks.find((b) => b.type === "tool-call") as { toolCallId?: string };
    const toolResult = allBlocks.find((b) => b.type === "tool-result") as { toolCallId?: string };
    expect(toolCall?.toolCallId).toBe("call_divergent_B");
    expect(toolResult?.toolCallId).toBe("call_divergent_B");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding #2 (CRITICAL, live-proven playbook 2026-07-03 gap): the array-form
// arm of `FunctionCallResultItem.output` uses an `input_text` discriminant —
// DIFFERENT from the bare-object arm's `text` discriminant
// ({@link OpenAIToolOutputText} vs the array's `input_text` elements,
// verified against @openai/agents-core 0.12.0's own zod schema,
// `protocol.d.ts`). The PRIOR 0.12.0 adaptation typed (and matched) the array
// arm as if it also used `type:"text"`, so `toolOutputToAgBlocks` silently
// produced `[]` for every array-shaped tool result — this is 0.12.0's actual
// wire shape for MCP-routed tool calls (VERIFIED LIVE against the real
// `echo-gpt55` capture: `tool.done.content` was `[]` before this fix, with
// the tool's entire result text ("conformance-probe-gpt55") discarded).
// This gap was never caught by any prior unit test — every existing
// `function_call_result` fixture used either a bare string or the bare-object
// `{type:"text"}` form, never the array form.
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — function_call_result array-form output (Finding #2, playbook 2026-07-03)", () => {
  it("tool.done.content carries the text from an array-shaped output ([{type:'input_text', text}])", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_arrout_1" } }),
      rawModel({
        type: "response.output_item.added",
        item: { id: "fc_arrout_1", type: "function_call", call_id: "call_arrout_1", name: "echo" },
      }),
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: {
          type: "function_call_result",
          name: "echo",
          callId: "call_arrout_1",
          status: "completed",
          // The REAL 0.12.0 MCP tool-result wire shape (array + input_text) —
          // NOT the bare-object {type:"text"} shape.
          output: [{ type: "input_text", text: "conformance-probe" }],
        },
        output: '{"type":"text","text":"conformance-probe"}',
      }),
      rawModel({ type: "response.completed", response: { id: "resp_arrout_1", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    const done = evs.find((e) => e.type === "tool.done") as {
      toolCallId?: string;
      outcome?: string;
      content?: { type: string; text?: string }[];
    };
    expect(done?.toolCallId).toBe("call_arrout_1");
    expect(done?.outcome).toBe("ok");
    // Before the fix: content was [] (the text was silently dropped).
    expect(done?.content).toEqual([{ type: "text", text: "conformance-probe" }]);
  });

  it("multiple input_text array elements are all carried, in order", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_arrout_2" } }),
      rawModel({
        type: "response.output_item.added",
        item: { id: "fc_arrout_2", type: "function_call", call_id: "call_arrout_2", name: "echo" },
      }),
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: {
          type: "function_call_result",
          name: "echo",
          callId: "call_arrout_2",
          status: "completed",
          output: [
            { type: "input_text", text: "first" },
            { type: "input_text", text: "second" },
          ],
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_arrout_2", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    const done = evs.find((e) => e.type === "tool.done") as {
      content?: { type: string; text?: string }[];
    };
    expect(done?.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// structuredContent under 0.12.0's native MCP client (playbook 2026-07-03
// follow-up, tracked follow-up from the 2026-07-03 playbook's exploratory
// finding). Wire-truth investigation (see `extractStructuredContent`'s doc):
//
//  - `@openai/agents-core` 0.12.0's own `mcpToFunctionTool` unconditionally
//    drops `CallToolResult.structuredContent` at the MCP-call boundary
//    UNLESS the caller's `MCPServer` config sets `customDataExtractor`
//    (0.12+ only) — in which case the extractor's return value lands
//    verbatim on the wrapper's NEW sibling field, `item.customData`
//    (`RunToolCallOutputItem.customData`, `dist/items.mjs`).
//  - Without that opt-in, the wrapper's `item.output` field is a
//    JSON-stringified STRING of the bare content item (VERIFIED against the
//    real committed `echo-gpt55` capture,
//    `packages/e2e/corpus/echo-gpt55/openai.native.json`:
//    `item.output === '{"type":"text","text":"conformance-probe-gpt55"}'`)
//    — never an object with a `.structuredContent` key, and never contains
//    structuredContent at all (there is nothing to extract from it).
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — tool_output structuredContent under 0.12.0 (playbook 2026-07-03 follow-up)", () => {
  it("extracts structuredContent from item.customData (the customDataExtractor channel)", () => {
    const n = createOpenaiNormalizer();
    const payload = { title: "Hello", body: "World" };
    const cacheMarker = { hit: false, llmCallsAvoided: 0, kind: "cold" };
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_customdata_1" } }),
      rawModel({
        type: "response.output_item.added",
        item: { id: "fc_customdata_1", type: "function_call", call_id: "call_customdata_1", name: "render_card" },
      }),
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: {
          type: "function_call_result",
          name: "render_card",
          callId: "call_customdata_1",
          status: "completed",
          // Real 0.12.0 MCP tool-result wire shape (array + input_text, Finding #2).
          output: [{ type: "input_text", text: JSON.stringify(payload) }],
        },
        // Real 0.12.0 wrapper shape: item.output is a JSON-stringified STRING
        // of the bare content item — NEVER an object with .structuredContent
        // (verified against the echo-gpt55 capture).
        output: JSON.stringify({ type: "text", text: JSON.stringify(payload) }),
        // The NEW 0.12.0 channel: populated only when the caller's MCPServer
        // config sets customDataExtractor (see run.ts). This is where the
        // ggui cache marker actually rides on real 0.12.0 wire.
        customData: { structuredContent: { ...payload, cache: cacheMarker } },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_customdata_1", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    const done = evs.find((e) => e.type === "tool.done") as {
      toolCallId?: string;
      content?: { type: string; text?: string }[];
      structuredContent?: { title?: string; body?: string; cache?: { hit?: boolean } };
    };
    expect(done?.toolCallId).toBe("call_customdata_1");
    // content still carries the plain-text form (Finding #2 regression guard).
    expect(done?.content).toEqual([{ type: "text", text: JSON.stringify(payload) }]);
    // structuredContent recovered from the customData channel.
    expect(done?.structuredContent).toEqual({ ...payload, cache: cacheMarker });
  });

  it("yields NO structuredContent when neither home is populated (the ordinary plain-text case — echo-gpt55 shape)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_nostruct_1" } }),
      rawModel({
        type: "response.output_item.added",
        item: { id: "fc_nostruct_1", type: "function_call", call_id: "call_nostruct_1", name: "echo" },
      }),
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: {
          type: "function_call_result",
          name: "echo",
          callId: "call_nostruct_1",
          status: "completed",
          output: [{ type: "input_text", text: "conformance-probe-gpt55" }],
        },
        // Real echo-gpt55 wire byte-for-byte: a JSON string, no structuredContent key.
        output: '{"type":"text","text":"conformance-probe-gpt55"}',
      }),
      rawModel({ type: "response.completed", response: { id: "resp_nostruct_1", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    const done = evs.find((e) => e.type === "tool.done") as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
    };
    expect(done?.content).toEqual([{ type: "text", text: "conformance-probe-gpt55" }]);
    expect(done?.structuredContent).toBeUndefined();
  });

  it("never throws push() on a malformed (non-JSON) item.output string — degrades to no structuredContent", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_malformed_1" } }),
      rawModel({
        type: "response.output_item.added",
        item: { id: "fc_malformed_1", type: "function_call", call_id: "call_malformed_1", name: "echo" },
      }),
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: {
          type: "function_call_result",
          name: "echo",
          callId: "call_malformed_1",
          status: "completed",
          output: "plain unstructured tool text, not JSON at all",
        },
        // A plain (non-MCP) local tool can legitimately return a bare string
        // that is NOT JSON — toSmartString passes strings through unchanged.
        output: "plain unstructured tool text, not JSON at all",
      }),
      rawModel({ type: "response.completed", response: { id: "resp_malformed_1", status: "completed" } }),
    ];

    let out: AgEvent[] = [];
    expect(() => {
      out = evs.flatMap((e) => n.push(e)).concat(n.flush());
    }).not.toThrow();

    const toolDone = out.find((e) => e.type === "tool.done") as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
    };
    expect(toolDone?.content).toEqual([{ type: "text", text: "plain unstructured tool text, not JSON at all" }]);
    expect(toolDone?.structuredContent).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// workspace#21 (guuey#981's ask) — `customData._meta` → tool-result `_meta`, and
// the §2.1 MCP-Apps routing: `_meta.ui` present ⇒ ADD `uiData` = the
// structuredContent (SPEC.md:332), `structuredContent` itself unchanged (the
// :340 host-convention mapping; ggui's cache marker keeps riding it).
// sp-protocol ruled option A 2026-09-23: facet mapping under SPEC.md:332/:338/
// :340 — `customData._meta` is the host's MCP result `_meta` (agents-core 0.18.0
// `MCPToolCustomDataContext.resultMeta`), a protocol annotation → carried
// VERBATIM (§8.0 no-drop); §2.1's "exactly one consumer" is per channel.
// Mirrors claude-agent-sdk/src/index.ts:1926-1946. Absent `_meta` ⇒ byte-identical.
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — tool_output customData._meta + §2.1 MCP-Apps uiData routing (workspace#21)", () => {
  const PAYLOAD = { title: "Hello", body: "World", cache: { hit: false, llmCallsAvoided: 0, kind: "cold" } };
  // The live mock's `_meta` (e2e/src/mcp-mocks/app-spec.ts) + a non-ui key.
  const META_UI = { ui: { resourceUri: "ui://mock/card", visibility: ["model"] }, "trace/id": "t-1" };

  function stream(customData: JsonValue | undefined): JsonValue[] {
    const item: { [k: string]: JsonValue } = {
      type: "tool_call_output_item",
      rawItem: {
        type: "function_call_result",
        name: "render_card",
        callId: "call_ws21",
        status: "completed",
        output: [{ type: "input_text", text: '{"title":"Hello","body":"World"}' }],
      },
      output: JSON.stringify({ type: "text", text: '{"title":"Hello","body":"World"}' }),
    };
    if (customData !== undefined) item.customData = customData;
    return [
      rawModel({ type: "response.created", response: { id: "resp_ws21" } }),
      rawModel({
        type: "response.output_item.added",
        item: { id: "fc_ws21", type: "function_call", call_id: "call_ws21", name: "render_card" },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_ws21", status: "completed" } }),
      runItem("tool_output", item),
    ];
  }
  function run(s: JsonValue[]): AgEvent[] {
    const n = createOpenaiNormalizer();
    return s.flatMap((e) => n.push(e)).concat(n.flush());
  }
  function toolDone(evs: AgEvent[]): AgEvent | undefined {
    return evs.find((e) => e.type === "tool.done");
  }

  it("_meta.ui present ⇒ tool.done carries structuredContent (unchanged) + uiData (= structuredContent) + _meta (verbatim)", () => {
    const done = toolDone(run(stream({ structuredContent: PAYLOAD, _meta: META_UI })));
    expect(done).toMatchObject({ type: "tool.done", toolCallId: "call_ws21" });
    if (done === undefined || done.type !== "tool.done") throw new Error("no tool.done");
    expect(done.structuredContent).toEqual(PAYLOAD);
    expect(done.uiData).toEqual(PAYLOAD);
    // Equal, but a clone — the surface channel never aliases the model channel.
    expect(done.uiData).not.toBe(done.structuredContent);
    expect(done._meta).toEqual(META_UI);
  });

  it("fold: the tool-result block carries all three channels and the result parses", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of stream({ structuredContent: PAYLOAD, _meta: META_UI })) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const block = res.messages.flatMap((m) => m.content).find((b) => b.type === "tool-result");
    expect(block).toMatchObject({ structuredContent: PAYLOAD, uiData: PAYLOAD, _meta: META_UI });
    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });

  it("_meta WITHOUT .ui ⇒ _meta only — no uiData; structuredContent unchanged", () => {
    const meta = { "trace/id": "t-2", timestamp: "2026-09-23T00:00:00Z" };
    const done = toolDone(run(stream({ structuredContent: PAYLOAD, _meta: meta })));
    if (done === undefined || done.type !== "tool.done") throw new Error("no tool.done");
    expect(done._meta).toEqual(meta);
    expect(done).not.toHaveProperty("uiData");
    expect(done.structuredContent).toEqual(PAYLOAD);
  });

  it("_meta.ui with NO structuredContent anywhere ⇒ _meta only — no uiData invented", () => {
    const done = toolDone(run(stream({ _meta: META_UI })));
    if (done === undefined || done.type !== "tool.done") throw new Error("no tool.done");
    expect(done._meta).toEqual(META_UI);
    expect(done).not.toHaveProperty("uiData");
    expect(done).not.toHaveProperty("structuredContent");
  });

  it("negative control: absent / non-object _meta ⇒ byte-identical to customData with no _meta key", () => {
    const bare = run(stream({ structuredContent: PAYLOAD }));
    const bareDone = toolDone(bare);
    expect(bareDone).not.toHaveProperty("_meta");
    expect(bareDone).not.toHaveProperty("uiData");
    expect(run(stream({ structuredContent: PAYLOAD, _meta: null }))).toEqual(bare);
    expect(run(stream({ structuredContent: PAYLOAD, _meta: "ui" }))).toEqual(bare);
    expect(run(stream({ structuredContent: PAYLOAD, _meta: [{ ui: {} }] }))).toEqual(bare);
    // No customData at all is likewise untouched by the new arm.
    expect(toolDone(run(stream(undefined)))).not.toHaveProperty("_meta");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// agents-core 0.13.5 → 0.14.0 carry (2026-07-29): programmatic tool calling
// (`program`/`program_output` protocol items + `caller` provenance),
// AssistantMessageItem.phase, ShellCallResultItem.status. Synthetic frames
// mirror the verified 0.14.0 `dist/types/protocol.d.ts` shapes; every block
// includes a 0.13.5-shaped negative control (output unchanged).
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — programmatic tool calling: program/program_output (agents-core 0.14.0)", () => {
  const PROGRAM_ROUND: JsonValue[] = [
    rawModel({ type: "response.created", response: { id: "resp_prog_1" } }),
    runItem("tool_called", {
      type: "tool_call_item",
      rawItem: {
        type: "program",
        callId: "call_prog_1",
        code: "results = [search(q) for q in queries]",
        fingerprint: "fp_abc123",
        id: "item_prog_1",
      },
    }),
    // Defensive: a real capture may ALSO fire the raw output_item.added carrier
    // for the program item — the (function_call-only) raw path must no-op it,
    // not double-start.
    rawModel({
      type: "response.output_item.added",
      item: { id: "item_prog_1", type: "program" },
    }),
    runItem("tool_output", {
      type: "tool_call_output_item",
      rawItem: {
        type: "program_output",
        callId: "call_prog_1",
        output: '["r1","r2"]',
        status: "completed",
      },
    }),
    rawModel({ type: "response.completed", response: { id: "resp_prog_1", status: "completed" } }),
  ];

  it("synthesizes tool.start with name builtin:program (rawItem-derived, NOT the wrapper's 'programmatic_tool_calling')", () => {
    const n = createOpenaiNormalizer();
    const evs = PROGRAM_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const starts = evs.filter((e) => e.type === "tool.start");
    expect(starts).toHaveLength(1); // exactly one — the raw output_item.added no-ops
    expect(starts[0]).toMatchObject({
      toolCallId: "call_prog_1",
      name: "builtin:program",
      itemId: "item_prog_1",
    });
  });

  it("carries {code, fingerprint} verbatim as tool.args.assembled input (the shell/apply-patch whole-payload precedent)", () => {
    const n = createOpenaiNormalizer();
    const evs = PROGRAM_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({
      toolCallId: "call_prog_1",
      input: { code: "results = [search(q) for q in queries]", fingerprint: "fp_abc123" },
    });
  });

  it("emits tool.done correlated by callId with the output string as text content and outcome:ok for status:completed", () => {
    const n = createOpenaiNormalizer();
    const evs = PROGRAM_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as {
      toolCallId?: string;
      outcome?: string;
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    expect(done?.toolCallId).toBe("call_prog_1");
    expect(done?.outcome).toBe("ok");
    expect(done?.isError).toBe(false);
    expect(done?.content).toEqual([{ type: "text", text: '["r1","r2"]' }]);
  });

  it("maps status:incomplete to outcome:error (a truncated program run never folds as success)", () => {
    const n = createOpenaiNormalizer();
    const incompleteRound = PROGRAM_ROUND.map((e) =>
      e === PROGRAM_ROUND[3]
        ? runItem("tool_output", {
            type: "tool_call_output_item",
            rawItem: {
              type: "program_output",
              callId: "call_prog_1",
              output: "partial",
              status: "incomplete",
            },
          })
        : e,
    );
    const evs = incompleteRound.flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as { outcome?: string; isError?: boolean };
    expect(done?.outcome).toBe("error");
    expect(done?.isError).toBe(true);
  });

  it("no orphaned tool.done — tool.start always precedes tool.done for the same toolCallId", () => {
    const n = createOpenaiNormalizer();
    const evs = PROGRAM_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const startIdx = evs.findIndex((e) => e.type === "tool.start");
    const doneIdx = evs.findIndex((e) => e.type === "tool.done");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(startIdx);
  });

  it("fold: no resync, exactly one tool-call + tool-result block pair, no park", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of PROGRAM_ROUND) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const allBlocks = res.messages.flatMap((m) => m.content);
    expect(allBlocks.filter((b) => b.type === "tool-call")).toHaveLength(1);
    expect(allBlocks.filter((b) => b.type === "tool-result")).toHaveLength(1);
  });
});

describe("createOpenaiNormalizer — ToolSearchOutputItem.toolSearchAgentName (agents-core 0.18.0)", () => {
  // The ONLY protocol-schema delta across the whole 0.17.0→0.18.0 span
  // (`dist/types/protocol.mjs`:426-432 — on the OUTPUT item only, never on
  // `ToolSearchCallItem`): "SDK-only discovery attribution" naming the logical
  // Agent that owns this search's results. An SDK-side field, so the name is
  // already camelCase on the wire we consume and is carried VERBATIM on the
  // tool.done providerMetadata (the `executionStatus` precedent). No corpus
  // scenario configures tool_search, so this carry is fixture-testable only.
  function searchRound(outputExtra: { [k: string]: JsonValue }): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: "resp_tsan_1" } }),
      runItem("tool_search_called", {
        type: "tool_search_call_item",
        rawItem: {
          type: "tool_search_call",
          callId: "call_tsan_1",
          execution: "server",
          arguments: { query: "weather tools" },
        },
      }),
      runItem("tool_search_output_created", {
        type: "tool_search_output_item",
        rawItem: {
          type: "tool_search_output",
          callId: "call_tsan_1",
          tools: [{ type: "tool_reference", functionName: "get_weather" }],
          ...outputExtra,
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_tsan_1", status: "completed" } }),
    ];
  }
  function runRound(outputExtra: { [k: string]: JsonValue }): AgEvent[] {
    const n = createOpenaiNormalizer();
    return searchRound(outputExtra)
      .flatMap((e) => n.push(e))
      .concat(n.flush());
  }
  function doneOf(evs: readonly AgEvent[]): { [k: string]: unknown } | undefined {
    return evs.find((e) => e.type === "tool.done") as { [k: string]: unknown } | undefined;
  }

  it("MIRROR: tool.done carries providerMetadata.toolSearchAgentName verbatim", () => {
    const evs = runRound({ toolSearchAgentName: "WeatherAgent" });
    expect(doneOf(evs)?.providerMetadata).toEqual({ toolSearchAgentName: "WeatherAgent" });
    // The results block is untouched by the carry.
    expect(doneOf(evs)?.content).toEqual([
      { type: "data", name: "tool_search_results", data: [{ type: "tool_reference", functionName: "get_weather" }] },
    ]);
  });

  it("NEGATIVE CONTROL: a 0.17.x-shaped output (no toolSearchAgentName) emits NO providerMetadata — byte-identical to the pre-0.18.0 stream", () => {
    const withField = runRound({ toolSearchAgentName: "WeatherAgent" });
    const without = runRound({});
    const doneWithout = doneOf(without);
    expect(doneWithout?.providerMetadata).toBeUndefined();
    // The absent case differs from the present case ONLY by that one key: the
    // rest of tool.done, and every other event in the stream, is unchanged.
    const { providerMetadata: _pm, ...restWith } = doneOf(withField) as { [k: string]: unknown };
    expect(doneWithout).toEqual(restWith);
    expect(JSON.stringify(without.filter((e) => e.type !== "tool.done"))).toBe(
      JSON.stringify(withField.filter((e) => e.type !== "tool.done")),
    );
  });

  it("a non-string toolSearchAgentName (deserialization boundary) degrades to no carry instead of reaching AgProviderMeta.parse", () => {
    const evs = runRound({ toolSearchAgentName: 42 });
    expect(doneOf(evs)?.providerMetadata).toBeUndefined();
    expect(evs.find((e) => e.type === "tool.done")).toBeDefined();
  });

  it("fold: the carry rides a well-formed tool-result pair (no resync)", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of searchRound({ toolSearchAgentName: "WeatherAgent" })) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const allBlocks = r.result().messages.flatMap((m) => m.content);
    expect(allBlocks.filter((b) => b.type === "tool-result")).toHaveLength(1);
  });
});

describe("createOpenaiNormalizer — RunToolCallOutputItem.executionStatus (agents-core 0.15.0)", () => {
  // Wrapper-level marker, live-observed on echo-gpt56 @ agents-core 0.17.0:
  // `executionStatus: "executed"` means the runner really invoked the tool;
  // a synthesized result (guardrail rejection, cancellation, refused
  // approval) carries nothing. Not a protocol-item field, so the fixture-
  // drift inventory cannot catch it — the census did.
  function outputRound(item: { [k: string]: JsonValue }): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: "resp_exec_1" } }),
      rawModel({
        type: "response.output_item.added",
        item: { id: "fc_exec_1", type: "function_call", call_id: "call_exec_1", name: "echo" },
      }),
      rawModel({ type: "response.function_call_arguments.done", item_id: "fc_exec_1", arguments: "{}" }),
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: { type: "function_call_result", name: "echo", callId: "call_exec_1", status: "completed", output: "ok" },
        ...item,
      }),
      rawModel({ type: "response.completed", response: { id: "resp_exec_1", status: "completed" } }),
    ];
  }
  function doneOf(evs: readonly { type: string }[]): { providerMetadata?: { [k: string]: unknown } } | undefined {
    return evs.find((e) => e.type === "tool.done") as { providerMetadata?: { [k: string]: unknown } } | undefined;
  }

  it("tool.done carries providerMetadata.executionStatus verbatim when the SDK marks the result executed", () => {
    const n = createOpenaiNormalizer();
    const evs = outputRound({ executionStatus: "executed" }).flatMap((e) => n.push(e)).concat(n.flush());
    expect(doneOf(evs)?.providerMetadata).toEqual({ executionStatus: "executed" });
  });

  it("an unmarked result (0.14.x-shaped wire, or a runner-synthesized output) carries no providerMetadata at all", () => {
    const n = createOpenaiNormalizer();
    const evs = outputRound({}).flatMap((e) => n.push(e)).concat(n.flush());
    expect(doneOf(evs)?.providerMetadata).toBeUndefined();
  });

  it("executionStatus and caller ride the same providerMetadata object (neither carry clobbers the other)", () => {
    const n = createOpenaiNormalizer();
    const evs = outputRound({
      executionStatus: "executed",
      rawItem: {
        type: "function_call_result",
        name: "echo",
        callId: "call_exec_1",
        status: "completed",
        output: "ok",
        caller: { type: "program", callerId: "call_prog_9" },
      },
    })
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    expect(doneOf(evs)?.providerMetadata).toEqual({
      caller: { type: "program", callerId: "call_prog_9" },
      executionStatus: "executed",
    });
  });
});

describe("createOpenaiNormalizer — ToolCaller provenance (agents-core 0.14.0)", () => {
  // A program-issued function call + its result: the caller rides the
  // AUTHORITATIVE raw output_item.added (verbatim openai-node snake_case
  // caller_id) on the start side, and the run-item result's own camelCase
  // field on the done side.
  const CALLER_ROUND: JsonValue[] = [
    rawModel({ type: "response.created", response: { id: "resp_caller_1" } }),
    rawModel({
      type: "response.output_item.added",
      item: {
        id: "fc_caller_1",
        type: "function_call",
        call_id: "call_fn_1",
        name: "get_weather",
        caller: { type: "program", caller_id: "call_prog_1" },
      },
    }),
    rawModel({
      type: "response.function_call_arguments.done",
      item_id: "fc_caller_1",
      arguments: '{"city":"Paris"}',
    }),
    runItem("tool_output", {
      type: "tool_call_output_item",
      rawItem: {
        type: "function_call_result",
        name: "get_weather",
        callId: "call_fn_1",
        status: "completed",
        output: "sunny",
        caller: { type: "program", callerId: "call_prog_1" },
      },
    }),
    rawModel({ type: "response.completed", response: { id: "resp_caller_1", status: "completed" } }),
  ];

  it("tool.start carries providerMetadata.caller normalized to camelCase ({type:'program', callerId}) from the raw snake_case caller_id", () => {
    const n = createOpenaiNormalizer();
    const evs = CALLER_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const start = evs.find((e) => e.type === "tool.start") as {
      providerMetadata?: { caller?: { type?: string; callerId?: string } };
    };
    expect(start?.providerMetadata).toEqual({
      caller: { type: "program", callerId: "call_prog_1" },
    });
  });

  it("tool.done carries the result item's own providerMetadata.caller (both fields preserved)", () => {
    const n = createOpenaiNormalizer();
    const evs = CALLER_ROUND.flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as {
      providerMetadata?: { caller?: { type?: string; callerId?: string } };
      content?: { type: string; text?: string }[];
    };
    expect(done?.providerMetadata).toEqual({
      caller: { type: "program", callerId: "call_prog_1" },
    });
    expect(done?.content).toEqual([{ type: "text", text: "sunny" }]);
  });

  it("caller {type:'direct'} carries verbatim (no fabricated callerId)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_caller_2" } }),
      rawModel({
        type: "response.output_item.added",
        item: {
          id: "fc_caller_2",
          type: "function_call",
          call_id: "call_fn_2",
          name: "echo",
          caller: { type: "direct" },
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_caller_2", status: "completed" } }),
    ].flatMap((e) => n.push(e)).concat(n.flush());
    const start = evs.find((e) => e.type === "tool.start") as {
      providerMetadata?: { caller?: { type?: string; callerId?: string } };
    };
    expect(start?.providerMetadata).toEqual({ caller: { type: "direct" } });
  });

  it("shell_call caller rides tool.start providerMetadata (call-side carry on a built-in)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_caller_3" } }),
      runItem("tool_called", {
        type: "tool_call_item",
        rawItem: {
          type: "shell_call",
          callId: "call_shell_c1",
          status: "in_progress",
          action: { commands: ["ls"] },
          id: "item_shell_c1",
          caller: { type: "program", callerId: "call_prog_9" },
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_caller_3", status: "completed" } }),
    ].flatMap((e) => n.push(e)).concat(n.flush());
    const start = evs.find((e) => e.type === "tool.start") as {
      name?: string;
      providerMetadata?: { caller?: { type?: string; callerId?: string } };
    };
    expect(start?.name).toBe("builtin:shell");
    expect(start?.providerMetadata).toEqual({
      caller: { type: "program", callerId: "call_prog_9" },
    });
  });

  it("negative control (0.13.5-shaped frames, no caller anywhere) ⇒ NO providerMetadata key on tool.start or tool.done", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_caller_4" } }),
      rawModel({
        type: "response.output_item.added",
        item: { id: "fc_caller_4", type: "function_call", call_id: "call_fn_4", name: "echo" },
      }),
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: {
          type: "function_call_result",
          name: "echo",
          callId: "call_fn_4",
          status: "completed",
          output: "ok",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_caller_4", status: "completed" } }),
    ].flatMap((e) => n.push(e)).concat(n.flush());
    const start = evs.find((e) => e.type === "tool.start") as { providerMetadata?: unknown };
    const done = evs.find((e) => e.type === "tool.done") as { providerMetadata?: unknown };
    expect(start).toBeDefined();
    expect(done).toBeDefined();
    expect("providerMetadata" in (start as object)).toBe(false);
    expect("providerMetadata" in (done as object)).toBe(false);
  });
});

describe("createOpenaiNormalizer — ShellCallResultItem.status (agents-core 0.14.0)", () => {
  function shellRound(resultRawItem: JsonValue): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: "resp_shst_1" } }),
      runItem("tool_called", {
        type: "tool_call_item",
        rawItem: {
          type: "shell_call",
          callId: "call_shst_1",
          status: "in_progress",
          action: { commands: ["ls"] },
          id: "item_shst_1",
        },
      }),
      runItem("tool_output", { type: "tool_call_output_item", rawItem: resultRawItem }),
      rawModel({ type: "response.completed", response: { id: "resp_shst_1", status: "completed" } }),
    ];
  }

  it("status:incomplete forces outcome:error even when every command exited 0 (never success)", () => {
    const n = createOpenaiNormalizer();
    const evs = shellRound({
      type: "shell_call_output",
      callId: "call_shst_1",
      status: "incomplete",
      output: [{ stdout: "partial listing", stderr: "", outcome: { type: "exit", exitCode: 0 } }],
    }).flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as {
      outcome?: string;
      isError?: boolean;
      providerMetadata?: { status?: string };
    };
    expect(done?.outcome).toBe("error");
    expect(done?.isError).toBe(true);
    // The raw status is carried verbatim — the outcome mapping alone cannot recover it.
    expect(done?.providerMetadata).toEqual({ status: "incomplete" });
  });

  it("status:completed keeps the per-command outcome mapping (ok on clean exits) + verbatim status carry", () => {
    const n = createOpenaiNormalizer();
    const evs = shellRound({
      type: "shell_call_output",
      callId: "call_shst_1",
      status: "completed",
      output: [{ stdout: "file1", stderr: "", outcome: { type: "exit", exitCode: 0 } }],
    }).flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as {
      outcome?: string;
      providerMetadata?: { status?: string };
    };
    expect(done?.outcome).toBe("ok");
    expect(done?.providerMetadata).toEqual({ status: "completed" });
  });

  it("negative control (0.13.5-shaped result, no status field) ⇒ exit-code-only mapping, NO providerMetadata key", () => {
    const n = createOpenaiNormalizer();
    const evs = shellRound({
      type: "shell_call_output",
      callId: "call_shst_1",
      output: [{ stdout: "file1", stderr: "", outcome: { type: "exit", exitCode: 0 } }],
    }).flatMap((e) => n.push(e)).concat(n.flush());
    const done = evs.find((e) => e.type === "tool.done") as { outcome?: string };
    expect(done?.outcome).toBe("ok");
    expect("providerMetadata" in (done as object)).toBe(false);
  });
});

describe("createOpenaiNormalizer — AssistantMessageItem.phase (agents-core 0.14.0)", () => {
  function phaseRound(messageRawItem: JsonValue): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: "resp_phase_1" } }),
      rawModel({
        type: "response.output_text.delta",
        item_id: "msg_phase_1",
        delta: "The answer is 42.",
      }),
      runItem("message_output_created", { type: "message_output_item", rawItem: messageRawItem }),
      rawModel({ type: "response.completed", response: { id: "resp_phase_1", status: "completed" } }),
    ];
  }

  it("carries phase on the matching text.end's providerMetadata (per-part, not message-level)", () => {
    const n = createOpenaiNormalizer();
    const evs = phaseRound({
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      id: "msg_phase_1",
      content: [{ type: "output_text", text: "The answer is 42." }],
    }).flatMap((e) => n.push(e)).concat(n.flush());
    const end = evs.find((e) => e.type === "text.end") as {
      providerMetadata?: { phase?: string };
    };
    expect(end?.providerMetadata).toEqual({ phase: "final_answer" });
  });

  it("phase coexists with citations on the same text.end (both carriers intact)", () => {
    const n = createOpenaiNormalizer();
    const evs = phaseRound({
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "commentary",
      id: "msg_phase_1",
      content: [
        {
          type: "output_text",
          text: "The answer is 42.",
          annotations: [
            { type: "url_citation", url: "https://example.com", title: "t", start_index: 0, end_index: 3 },
          ],
        },
      ],
    }).flatMap((e) => n.push(e)).concat(n.flush());
    const end = evs.find((e) => e.type === "text.end") as {
      providerMetadata?: { phase?: string };
      citations?: { kind?: string; url?: string }[];
    };
    expect(end?.providerMetadata).toEqual({ phase: "commentary" });
    expect(end?.citations?.[0]).toMatchObject({ kind: "url", url: "https://example.com" });
  });

  it("id-less late-message ext payload carries phase (no streamed text.end exists on that path)", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_phase_2" } }),
      rawModel({ type: "response.completed", response: { id: "resp_phase_2", status: "completed" } }),
      // Id-less synthesized final message arriving PAST the terminal close,
      // now phase-tagged (0.14.0) — joins the documented late-message carry.
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "synthesized final answer" }],
        },
      }),
    ].flatMap((e) => n.push(e)).concat(n.flush());
    const late = evs.find((e) => e.type === "ext.openai.late-message") as {
      text?: unknown;
      phase?: unknown;
    };
    expect(late).toBeDefined();
    expect(late?.text).toBe("synthesized final answer");
    expect(late?.phase).toBe("final_answer");
  });

  it("negative control (0.13.5-shaped message, no phase) ⇒ NO providerMetadata on text.end", () => {
    const n = createOpenaiNormalizer();
    const evs = phaseRound({
      type: "message",
      role: "assistant",
      status: "completed",
      id: "msg_phase_1",
      content: [{ type: "output_text", text: "The answer is 42." }],
    }).flatMap((e) => n.push(e)).concat(n.flush());
    const end = evs.find((e) => e.type === "text.end") as { providerMetadata?: unknown };
    expect(end).toBeDefined();
    expect("providerMetadata" in (end as object)).toBe(false);
  });

  it("fold-identity: a phase-tagged text turn reduces cleanly (needsResync=false) with the metadata on the text block", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    const frames = phaseRound({
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      id: "msg_phase_1",
      content: [{ type: "output_text", text: "The answer is 42." }],
    });
    for (const e of frames) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res: AgReduceResult = r.result();
    const textBlock = res.messages.flatMap((m) => m.content).find((b) => b.type === "text") as {
      providerMetadata?: { phase?: string };
      text?: string;
    };
    expect(textBlock?.text).toBe("The answer is 42.");
    expect(textBlock?.providerMetadata).toEqual({ phase: "final_answer" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OA-14 — rnd 13+17 Stage 1 (founder ruling 2026-09-23, relayed by sp-main):
// `phase` is read at raw `response.output_item.added{type:"message"}` and carried
// on the matching `text.start.providerMetadata` (the vercel half: c4f5981). Live
// evidence: 6/8 openai seeds carry `phase` on that added event — incl. echo-gpt55,
// whose 0.12.0 run-item never did. `ext.openai.late-phase` is RETIRED for an id
// whose phase already rode text.start; it stays (lossless) when only the run-item
// knows the phase. text.end's existing carry is untouched (start + end, the
// vercel parity). A providerMetadata carry — no new wire literal.
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — OA-14 phase on text.start from output_item.added", () => {
  function run(s: JsonValue[]): AgEvent[] {
    const n = createOpenaiNormalizer();
    return s.flatMap((e) => n.push(e)).concat(n.flush());
  }
  /** The live final round (echo-gpt6sol natives [26]..[51]), minimised. */
  function finalRound(added: { [k: string]: JsonValue } | undefined, runItemPhase?: string): JsonValue[] {
    const rawItem: { [k: string]: JsonValue } = {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done" }],
      id: "msg_oa14",
    };
    if (runItemPhase !== undefined) rawItem.phase = runItemPhase;
    return [
      rawModel({ type: "response.created", response: { id: "resp_oa14" } }),
      ...(added !== undefined
        ? [rawModel({ type: "response.output_item.added", item: { id: "msg_oa14", type: "message", ...added } })]
        : []),
      rawModel({ type: "response.output_text.delta", item_id: "msg_oa14", delta: "Done" }),
      rawModel({ type: "response.output_text.done", item_id: "msg_oa14", text: "Done" }),
      rawModel({ type: "response.completed", response: { id: "resp_oa14", status: "completed" } }),
      runItem("message_output_created", { type: "message_output_item", rawItem }),
    ];
  }

  it("live order: phase from output_item.added rides text.start.providerMetadata; the late-phase ext is retired for that id", () => {
    const evs = run(finalRound({ phase: "final_answer" }, "final_answer"));
    expect(evs.find((e) => e.type === "text.start")).toMatchObject({
      id: "msg_oa14",
      providerMetadata: { phase: "final_answer" },
    });
    expect(evs.map((e) => e.type)).not.toContain("ext.openai.late-phase");
  });

  it("fold: the text block carries providerMetadata.phase", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of finalRound({ phase: "final_answer" }, "final_answer")) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const block = r
      .result()
      .messages.flatMap((m) => m.content)
      .find((b) => b.type === "text");
    expect(block).toMatchObject({ text: "Done", providerMetadata: { phase: "final_answer" } });
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });

  it("a 0.12.0-era run-item WITHOUT phase (echo-gpt55 shape) still gets it from the raw added event", () => {
    const evs = run(finalRound({ phase: "final_answer" }));
    expect(evs.find((e) => e.type === "text.start")).toMatchObject({ providerMetadata: { phase: "final_answer" } });
    expect(evs.map((e) => e.type)).not.toContain("ext.openai.late-phase");
  });

  it("per part: commentary and final_answer message items in ONE response each carry their own phase on text.start", () => {
    const evs = run([
      rawModel({ type: "response.created", response: { id: "resp_oa14_two" } }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_c", type: "message", phase: "commentary" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_c", delta: "Checking the tool first." }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_f", type: "message", phase: "final_answer" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_f", delta: "Done." }),
      rawModel({ type: "response.completed", response: { id: "resp_oa14_two", status: "completed" } }),
    ]);
    const starts = evs.filter((e) => e.type === "text.start");
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ id: "msg_c", providerMetadata: { phase: "commentary" } });
    expect(starts[1]).toMatchObject({ id: "msg_f", providerMetadata: { phase: "final_answer" } });
  });

  it("lossless: raw added WITHOUT phase but the late run-item has it ⇒ late-phase ext still fires, text.start carries none", () => {
    const evs = run(finalRound({}, "final_answer"));
    expect(evs.find((e) => e.type === "text.start")).not.toHaveProperty("providerMetadata");
    expect(evs.find((e) => e.type === "ext.openai.late-phase")).toMatchObject({ itemId: "msg_oa14", phase: "final_answer" });
  });

  it("lossless: a run-item phase that DIFFERS from the one carried on text.start still rides late-phase", () => {
    const evs = run(finalRound({ phase: "commentary" }, "final_answer"));
    expect(evs.find((e) => e.type === "text.start")).toMatchObject({ providerMetadata: { phase: "commentary" } });
    expect(evs.find((e) => e.type === "ext.openai.late-phase")).toMatchObject({ phase: "final_answer" });
  });

  it("tool round (message still open when the run-item lands): phase rides BOTH text.start and text.end (vercel parity)", () => {
    const evs = run([
      rawModel({ type: "response.created", response: { id: "resp_oa14_open" } }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_open", type: "message", phase: "commentary" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_open", delta: "Let me check." }),
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Let me check." }],
          id: "msg_open",
          phase: "commentary",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_oa14_open", status: "completed" } }),
    ]);
    expect(evs.find((e) => e.type === "text.start")).toMatchObject({ providerMetadata: { phase: "commentary" } });
    expect(evs.find((e) => e.type === "text.end")).toMatchObject({ providerMetadata: { phase: "commentary" } });
  });

  // Completion correlation (protocol package rd-13-17 §2 stage 1): match
  // message_output_created to its open text stream by id FIRST — on the direct
  // OpenAI wire the raw `item_id` and the run-item `rawItem.id` are the SAME
  // (all 8 openai seeds) — and fall back to FIFO only when the id is unknown
  // (the OpenRouter `msg_tmp_` surface, index.ts's correlation doc).
  function twoOpenStreams(completedId: string): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: "resp_oa14_corr" } }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_A", type: "message", phase: "commentary" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_A", delta: "Checking." }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_B", type: "message", phase: "final_answer" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_B", delta: "See [1]." }),
      // msg_B's completion arrives FIRST, while both streams are still open.
      runItem("message_output_created", {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "See [1].",
              annotations: [{ type: "url_citation", url: "https://example.com", title: "Ex", start_index: 4, end_index: 7 }],
            },
          ],
          id: completedId,
          phase: "final_answer",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_oa14_corr", status: "completed" } }),
    ];
  }

  it("correlation id-first: a completion for msg_B closes msg_B's stream (citations + phase), even with msg_A opened earlier", () => {
    const evs = run(twoOpenStreams("msg_B"));
    const endB = evs.find((e) => e.type === "text.end" && e.id === "msg_B");
    expect(endB).toMatchObject({ providerMetadata: { phase: "final_answer" } });
    expect(endB).toHaveProperty("citations");
    // msg_A is closed later by the native-close fallback, with neither.
    const endA = evs.find((e) => e.type === "text.end" && e.id === "msg_A");
    expect(endA).toBeDefined();
    expect(endA).not.toHaveProperty("citations");
    expect(endA).not.toHaveProperty("providerMetadata");
  });

  it("correlation FIFO fallback: an unknown run-item id (OpenRouter msg_tmp_ shape) still closes the FIRST open stream", () => {
    const evs = run(twoOpenStreams("msg_tmp_unknown"));
    const endA = evs.find((e) => e.type === "text.end" && e.id === "msg_A");
    expect(endA).toHaveProperty("citations");
    expect(endA).toMatchObject({ providerMetadata: { phase: "final_answer" } });
  });

  it("negative control: added{message} with absent / null / non-string / empty phase ⇒ byte-identical to a stream with no added event", () => {
    const bare = run(finalRound(undefined));
    expect(bare.find((e) => e.type === "text.start")).not.toHaveProperty("providerMetadata");
    expect(run(finalRound({}))).toEqual(bare);
    expect(run(finalRound({ phase: null }))).toEqual(bare);
    expect(run(finalRound({ phase: 7 }))).toEqual(bare);
    expect(run(finalRound({ phase: "" }))).toEqual(bare);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PH-2 — rnd 13+17 STAGE 2 (draft.4, sp-protocol fb2126a on sp-probe P-phase):
// the first-class optional `phase` on text.start/text.end. SPEC §8.0 item 27:
// OpenAI `phase:"commentary"` → `phase:"interim"` on that message's text block;
// "final_answer", null, "", absent and any other value → `phase` absent; the
// vendor marker stays VERBATIM in providerMetadata (the stage-1 carry). §5
// "`phase` timing": on the `*.start` when known before the first delta, else on
// the block's `*.end` — never after an emitted `*.end` (then first-class phase
// stays absent and the lossless ext.openai.late-phase carry stays). sp-protocol
// ruled a STASHED (deferred tool-round) text.end "not yet emitted" (2026-09-23).
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — PH-2 first-class phase:\"interim\" (draft.4, §8.0 item 27, §10 item 26)", () => {
  function run(s: JsonValue[]): AgEvent[] {
    const n = createOpenaiNormalizer();
    return s.flatMap((e) => n.push(e)).concat(n.flush());
  }
  function fold(s: JsonValue[]): ReturnType<Reducer["result"]> {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    for (const e of s) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    return r.result();
  }
  function msgItem(id: string, phase?: JsonValue): JsonValue {
    const rawItem: { [k: string]: JsonValue } = {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: `text of ${id}` }],
      id,
    };
    if (phase !== undefined) rawItem.phase = phase;
    return runItem("message_output_created", { type: "message_output_item", rawItem });
  }
  function textEvent(evs: AgEvent[], type: "text.start" | "text.end", id: string): AgEvent | undefined {
    return evs.find((e) => e.type === type && e.id === id);
  }

  // §10 item 26's OpenAI vector: two message items, commentary then
  // final_answer (each on output_item.added), completions after the close.
  function twoItemVector(phaseA: JsonValue, phaseB: JsonValue): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: "resp_ph2" } }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_A", type: "message", phase: phaseA } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_A", delta: "text of msg_A" }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_B", type: "message", phase: phaseB } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_B", delta: "text of msg_B" }),
      rawModel({ type: "response.completed", response: { id: "resp_ph2", status: "completed" } }),
      msgItem("msg_A", phaseA),
      msgItem("msg_B", phaseB),
    ];
  }

  it("§10 item 26 vector: commentary → phase:\"interim\" on msg_A's text.start ONLY; msg_B (final_answer) carries no phase; both keep providerMetadata.phase verbatim; no late-phase; every event passes AgEvent.safeParse", () => {
    const evs = run(twoItemVector("commentary", "final_answer"));
    expect(textEvent(evs, "text.start", "msg_A")).toMatchObject({ phase: "interim", providerMetadata: { phase: "commentary" } });
    expect(textEvent(evs, "text.start", "msg_B")).not.toHaveProperty("phase");
    expect(textEvent(evs, "text.end", "msg_B")).not.toHaveProperty("phase");
    expect(textEvent(evs, "text.start", "msg_B")).toMatchObject({ providerMetadata: { phase: "final_answer" } });
    expect(evs.map((e) => e.type)).not.toContain("ext.openai.late-phase");
    for (const e of evs) expect(AgEvent.safeParse(e).success).toBe(true);

    const blocks = fold(twoItemVector("commentary", "final_answer"))
      .messages.flatMap((m) => m.content)
      .filter((b) => b.type === "text");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ text: "text of msg_A", phase: "interim", providerMetadata: { phase: "commentary" } });
    expect(blocks[1]).toMatchObject({ text: "text of msg_B", providerMetadata: { phase: "final_answer" } });
    expect(blocks[1]).not.toHaveProperty("phase");
  });

  it.each([
    ["null", null],
    ["empty string", ""],
  ])("negative control: phase %s ⇒ neither `phase` nor `providerMetadata.phase` (sp-protocol ruling (a))", (_label, bad) => {
    const evs = run(twoItemVector(bad, "final_answer"));
    const startA = textEvent(evs, "text.start", "msg_A");
    expect(startA).not.toHaveProperty("phase");
    expect(startA).not.toHaveProperty("providerMetadata");
    // No marker ⇒ no lossless ext either (pre-PH-2 the post-close run-item
    // emitted ext.openai.late-phase {phase: null} for a null phase).
    expect(evs.map((e) => e.type)).not.toContain("ext.openai.late-phase");
    const block = fold(twoItemVector(bad, "final_answer"))
      .messages.flatMap((m) => m.content)
      .find((b) => b.type === "text");
    // Value checks, not key checks: core's text fold assigns
    // `providerMetadata = mergeProviderMeta(...)`, which leaves an explicit
    // `undefined` key on the block (pre-existing, JSON-invisible).
    expect(block?.type === "text" ? block.phase : "not-a-text-block").toBeUndefined();
    expect(block?.type === "text" ? block.providerMetadata : "not-a-text-block").toBeUndefined();
  });

  it("negative control: an unknown vendor value (\"foo\") ⇒ `phase` absent, providerMetadata.phase \"foo\" verbatim (never copied into `phase`)", () => {
    const evs = run(twoItemVector("foo", "final_answer"));
    const startA = textEvent(evs, "text.start", "msg_A");
    expect(startA).not.toHaveProperty("phase");
    expect(startA).toMatchObject({ providerMetadata: { phase: "foo" } });
  });

  // ── §5 timing boundary: known only at the run-item (raw added lacks phase) ──
  it("(i) message OPEN, stream still open when the commentary completion lands ⇒ phase:\"interim\" on that text.end", () => {
    const evs = run([
      rawModel({ type: "response.created", response: { id: "resp_ph2_i" } }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_i", type: "message" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_i", delta: "Let me check." }),
      msgItem("msg_i", "commentary"),
      rawModel({ type: "response.completed", response: { id: "resp_ph2_i", status: "completed" } }),
    ]);
    expect(textEvent(evs, "text.start", "msg_i")).not.toHaveProperty("phase");
    expect(textEvent(evs, "text.end", "msg_i")).toMatchObject({ phase: "interim", providerMetadata: { phase: "commentary" } });
  });

  it("(ii) DEFERRED tool-round close: the text.end is still stashed when the post-close commentary completion lands ⇒ phase:\"interim\" rides the stashed text.end; late-phase retired", () => {
    const evs = run([
      rawModel({ type: "response.created", response: { id: "resp_ph2_ii" } }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_ii", type: "message" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_ii", delta: "Calling echo." }),
      rawModel({
        type: "response.output_item.added",
        item: { id: "fc_ii", type: "function_call", call_id: "call_ii", name: "echo" },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_ph2_ii", status: "completed" } }),
      msgItem("msg_ii", "commentary"),
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: { type: "function_call_result", name: "echo", callId: "call_ii", status: "completed", output: "ok" },
        output: "ok",
      }),
    ]);
    const types = evs.map((e) => e.type);
    const end = textEvent(evs, "text.end", "msg_ii");
    expect(end).toMatchObject({ phase: "interim", providerMetadata: { phase: "commentary" } });
    // It really was the deferred close: text.end lands AFTER the tool.done.
    expect(types.indexOf("tool.done")).toBeLessThan(evs.findIndex((e) => e.type === "text.end" && e.id === "msg_ii"));
    expect(types).not.toContain("ext.openai.late-phase");
  });

  it("(iii) text.end ALREADY emitted (non-deferred close) before the commentary completion lands ⇒ first-class phase absent; ext.openai.late-phase carries it", () => {
    const evs = run([
      rawModel({ type: "response.created", response: { id: "resp_ph2_iii" } }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_iii", type: "message" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_iii", delta: "Done." }),
      rawModel({ type: "response.completed", response: { id: "resp_ph2_iii", status: "completed" } }),
      msgItem("msg_iii", "commentary"),
    ]);
    const end = textEvent(evs, "text.end", "msg_iii");
    expect(end).not.toHaveProperty("phase");
    expect(evs.findIndex((e) => e.type === "text.end" && e.id === "msg_iii")).toBeLessThan(
      evs.findIndex((e) => e.type === "ext.openai.late-phase"),
    );
    expect(evs.find((e) => e.type === "ext.openai.late-phase")).toMatchObject({ itemId: "msg_iii", phase: "commentary" });
    expect(evs.filter((e) => e.type === "text.end" && e.id === "msg_iii")).toHaveLength(1); // never a second end
  });

  it("a late final_answer (open message) sets NO first-class phase on text.end — only providerMetadata.phase", () => {
    const evs = run([
      rawModel({ type: "response.created", response: { id: "resp_ph2_fa" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_fa", delta: "Answer." }),
      msgItem("msg_fa", "final_answer"),
      rawModel({ type: "response.completed", response: { id: "resp_ph2_fa", status: "completed" } }),
    ]);
    const end = textEvent(evs, "text.end", "msg_fa");
    expect(end).not.toHaveProperty("phase");
    expect(end).toMatchObject({ providerMetadata: { phase: "final_answer" } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LV — LIVE natives never throw out of push() (SPEC.md:933, §8.0 graceful
// degradation). The corpus is `toJsonValue(event)` — JSON round-tripped — so it
// never showed that a host pushing the SDK's LIVE stream objects (class
// instances with toJSON, `undefined` members, Dates, cycles) hit
// `JsonValue.parse` at carried-member sites and THREW a ZodError (sp-main's
// no-throw check, 2026-09-24: 6 of 9 live shapes threw at d8d04ca). Fix:
// normalize ONCE at push() entry with core `toJsonValueSafe` (total, JSON
// semantics per node), so live input is exactly the corpus shape.
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — LV live (non-JSON-round-tripped) natives never throw", () => {
  // The cast IS the scenario: a host pushes a live SDK object through
  // `push(native: JsonValue)`. Test-only; the facet itself stays cast-free.
  function liveNative(v: unknown): JsonValue {
    return v as JsonValue;
  }
  const rm = (event: unknown): JsonValue => liveNative({ type: "raw_model_stream_event", data: { type: "model", event } });
  const ri = (name: string, item: unknown): JsonValue => liveNative({ type: "run_item_stream_event", name, item });
  const created = rm({ type: "response.created", response: { id: "resp_lv" } });
  const WHEN = new Date("2026-09-24T01:02:03.000Z");
  function cyclicAgent(): unknown {
    const a: { name: string; self?: unknown } = { name: "spike" };
    a.self = a;
    return a;
  }
  function run(stream: JsonValue[]): AgEvent[] {
    const n = createOpenaiNormalizer();
    let evs: AgEvent[] = [];
    expect(() => {
      evs = stream.flatMap((e) => n.push(e)).concat(n.flush());
    }).not.toThrow();
    for (const e of evs) expect(AgEvent.safeParse(e).success).toBe(true);
    return evs;
  }

  it("A: an unknown future run-item name with a live item (undefined member + cyclic agent) ⇒ ext.openai.unparsed, no throw", () => {
    const evs = run([created, ri("future_item_created", { type: "future_item", rawItem: { id: undefined, x: 1 }, agent: cyclicAgent() })]);
    const unparsed = evs.find((e) => e.type === "ext.openai.unparsed");
    expect(unparsed).toBeDefined();
    // JSON semantics: the undefined member is dropped, the value kept.
    expect(JSON.stringify(unparsed)).toContain('"x":1');
    expect(JSON.stringify(unparsed)).not.toContain('"id":');
  });

  it("B: tool_search_called with no resolvable id and a live Date ⇒ ext.openai.unparsed carrying the ISO string, no throw", () => {
    const evs = run([
      created,
      ri("tool_search_called", {
        type: "tool_search_call_item",
        rawItem: { type: "tool_search_call", id: undefined, callId: undefined, when: WHEN, arguments: {} },
      }),
    ]);
    expect(JSON.stringify(evs.find((e) => e.type === "ext.openai.unparsed"))).toContain("2026-09-24T01:02:03.000Z");
  });

  it("D: a local tool's live wrapper output {structuredContent:{a:undefined, d:Date}} ⇒ tool.done.structuredContent {d: ISO}, no throw", () => {
    const evs = run([
      created,
      rm({ type: "response.output_item.added", item: { id: "fc_lv", type: "function_call", call_id: "call_lv", name: "t" } }),
      ri("tool_output", {
        type: "tool_call_output_item",
        rawItem: { type: "function_call_result", name: "t", callId: "call_lv", status: "completed", output: "x" },
        output: { structuredContent: { a: undefined, d: WHEN } },
      }),
    ]);
    expect(evs.find((e) => e.type === "tool.done")).toMatchObject({ structuredContent: { d: "2026-09-24T01:02:03.000Z" } });
  });

  it("I: tool_search arguments with an undefined member and a Date ⇒ assembled input {at: ISO}, no throw", () => {
    const evs = run([
      created,
      ri("tool_search_called", {
        type: "tool_search_call_item",
        rawItem: { type: "tool_search_call", callId: "call_ts_lv", arguments: { q: undefined, at: WHEN }, id: "ts_lv" },
      }),
    ]);
    expect(evs.find((e) => e.type === "tool.args.assembled")).toMatchObject({ input: { at: "2026-09-24T01:02:03.000Z" } });
  });

  it("J: a computer_call live action with an undefined member ⇒ assembled input without it, no throw", () => {
    const evs = run([
      created,
      ri("tool_called", {
        type: "tool_call_item",
        rawItem: { type: "computer_call", callId: "call_cu_lv", status: "completed", action: { type: "click", x: 1, y: undefined }, id: "cu_lv" },
      }),
    ]);
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ input: { type: "click", x: 1 } });
    expect(JSON.stringify(assembled)).not.toContain('"y"');
  });

  it("a live SDK object with toJSON (agents-core RunItem/Agent shape) is read through its toJSON, as the capture agent's toJsonValue does", () => {
    // The name is reachable ONLY through toJSON (no plain `name` member), so a
    // correct toAgentName proves the entry normalization honoured toJSON.
    class LiveAgent {
      readonly #label: string;
      constructor(label: string) {
        this.#label = label;
      }
      toJSON(): { name: string } {
        return { name: this.#label };
      }
    }
    const evs = run([
      created,
      rm({ type: "response.output_text.delta", item_id: "msg_lv", delta: "hi" }),
      rm({ type: "response.completed", response: { id: "resp_lv", status: "completed" } }),
      ri("handoff_occurred", {
        type: "handoff_output_item",
        rawItem: { type: "function_call_result", name: "transfer", callId: "call_h", status: "completed", output: "{}" },
        sourceAgent: new LiveAgent("spike"),
        targetAgent: new LiveAgent("helper"),
      }),
    ]);
    expect(evs.find((e) => e.type === "handoff")).toMatchObject({ kind: "transfer", toAgentName: "helper" });
  });

  // The last-resort guard: an envelope-VALID but malformed event used to throw
  // a TypeError out of push() from an unguarded read deep in drive() (each of
  // these threw before the guard; 2026-09-24 probe). Now: no throw, and the
  // degradation is visible as ext.openai.unparsed{reason:"normalizer-error"}
  // (no payload), never silent.
  it.each([
    ["tool_called with item {}", { type: "run_item_stream_event", name: "tool_called", item: {} }],
    ["tool_output with rawItem {}", { type: "run_item_stream_event", name: "tool_output", item: { rawItem: {} } }],
    ["message_output_created with no content", { type: "run_item_stream_event", name: "message_output_created", item: { rawItem: { type: "message" } } }],
    ["response.completed with no response", { type: "raw_model_stream_event", data: { type: "model", event: { type: "response.completed" } } }],
    ["output_item.added with no item", { type: "raw_model_stream_event", data: { type: "model", event: { type: "response.output_item.added" } } }],
  ])("last-resort guard: %s ⇒ no throw, the core non-terminal `error` event {message:\"normalizer error\", code:<error name>}", (_label, malformed) => {
    const evs = run([liveNative(malformed)]);
    const guard = evs.find((e) => e.type === "error");
    expect(guard).toMatchObject({ type: "error", message: "normalizer error", code: "TypeError" });
    expect(guard).not.toHaveProperty("native");
    expect(evs.some((e) => e.type === "ext.openai.unparsed")).toBe(false);
  });

  // sp-cto's aliasing / `__proto__` checks on the toJsonValueSafe swap
  // (2026-09-24): the helper returns plain input BY REFERENCE and keeps an own
  // `__proto__` as data. The unrecognised-envelope branch was the one emit path
  // with no copying parse, so its `ext.openai.unparsed.native` WAS the host's
  // object (aliased; a later host mutation would rewrite an emitted event) and
  // carried an own `__proto__` key to consumers. It now copies through
  // JsonValue.parse like every other carry path (which drops an own
  // `__proto__`, never pollutes).
  it("unrecognised envelope: ext.openai.unparsed.native is a COPY (never the host's object) with no own __proto__", () => {
    const hostObject: JsonValue = JSON.parse('{"weird":true,"nested":{"k":1},"__proto__":{"p":1}}');
    const n = createOpenaiNormalizer();
    const unparsed = n.push(hostObject).find((e) => e.type === "ext.openai.unparsed");
    if (unparsed === undefined || unparsed.type !== "ext.openai.unparsed") throw new Error("no ext.openai.unparsed");
    const carried: unknown = Reflect.get(unparsed, "native");
    expect(carried).not.toBe(hostObject);
    expect(carried).toEqual({ weird: true, nested: { k: 1 } });
    expect(Object.keys(carried ?? {})).toEqual(["weird", "nested"]);
    // A later host mutation must not reach the emitted event.
    if (typeof hostObject === "object" && hostObject !== null && !Array.isArray(hostObject)) {
      Reflect.set(hostObject, "weird", "mutated");
    }
    expect(carried).toEqual({ weird: true, nested: { k: 1 } });
  });

  // sp-cto nit (2026-09-24): the guard's payload must be content-free BY
  // CONSTRUCTION, not because today's throws happen to be TypeErrors. A V8
  // SyntaxError quotes its input (`Unexpected token 'o', "{"secret":"…" is not
  // valid JSON`), so an error MESSAGE can carry a slice of tool arguments or a
  // wrapper output. Force one out of drive(): the OA-14 phase carry reaches
  // AgProviderMeta.parse unguarded, so a spy that throws there reaches the guard.
  it("last-resort guard carries the error NAME only: a SyntaxError quoting SECRET_ content never reaches the wire", () => {
    const spy = vi.spyOn(AgProviderMeta, "parse").mockImplementation(() => {
      throw new SyntaxError('Unexpected token \'o\', "{"secret":"SECRET_TOOL_ARGS_42"}" is not valid JSON');
    });
    try {
      const evs = run([
        created,
        rm({ type: "response.output_item.added", item: { id: "msg_sec", type: "message", phase: "commentary" } }),
        rm({ type: "response.output_text.delta", item_id: "msg_sec", delta: "hi" }),
      ]);
      const guard = evs.find((e) => e.type === "error");
      expect(guard).toMatchObject({ message: "normalizer error", code: "SyntaxError" });
      expect(JSON.stringify(evs)).not.toContain("SECRET_");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // sp-cto (2026-09-24): the guard catches a throw DEEP in drive(), possibly
  // AFTER this same native already opened a turn, a message and a block. Those
  // events stay on the wire (the assembler's seq/open-state advanced past them);
  // what must hold is: reduce() never parks, INV-MSG (every message.start gets
  // exactly one message.end), INV-BLOCK (no block id is created twice) and
  // INV-TURN at flush, and the stream keeps working after the guard.
  function assertInvariantsHold(evs: AgEvent[]): void {
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const starts = evs.filter((e) => e.type === "message.start").map((e) => (e.type === "message.start" ? e.id : ""));
    for (const id of starts) {
      expect(evs.filter((e) => e.type === "message.end" && e.id === id)).toHaveLength(1);
    }
    const blockIds = evs
      .filter((e) => e.type === "text.start" || e.type === "reasoning.start")
      .map((e) => (e.type === "text.start" || e.type === "reasoning.start" ? e.id : ""));
    expect(new Set(blockIds).size).toBe(blockIds.length);
    const opened = evs.filter((e) => e.type === "turn.start").length;
    const closed = evs.filter((e) => e.type === "turn.done" || e.type === "turn.error" || e.type === "turn.abort").length;
    expect(closed).toBe(opened);
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  }

  const stripSeq = (evs: AgEvent[]): unknown[] => evs.map((e) => ({ ...e, seq: 0 }));
  function assertSeqGapFree(evs: AgEvent[]): void {
    evs.forEach((e, i) => expect(e.seq).toBe(i));
  }

  it("ATOMIC: a throw AFTER open (turn + message + text block opened by the SAME native) discards that whole batch — the wire gets ONLY the error event, and flush closes nothing that never went out", () => {
    const spy = vi.spyOn(StreamAssembler.prototype, "textDelta").mockImplementationOnce(() => {
      throw new RangeError("boom after open");
    });
    try {
      // No response.created: this delta alone would open the turn, the message
      // and the text block before textDelta throws.
      const evs = run([rm({ type: "response.output_text.delta", item_id: "msg_open", delta: "lost" })]);
      expect(evs.map((e) => e.type)).toEqual(["error"]);
      expect(evs[0]).toMatchObject({ message: "normalizer error", code: "RangeError" });
      assertInvariantsHold(evs);
      assertSeqGapFree(evs);
    } finally {
      spy.mockRestore();
    }
  });

  it("ATOMIC + no state divergence: a throw after open, then NORMAL natives ⇒ exactly the stream WITHOUT that native plus one error event (seq gap-free); reduce() never parks", () => {
    const spy = vi.spyOn(StreamAssembler.prototype, "textDelta").mockImplementationOnce(() => {
      throw new RangeError("boom after open");
    });
    const created = rm({ type: "response.created", response: { id: "resp_cont" } });
    const bad = rm({ type: "response.output_text.delta", item_id: "msg_cont", delta: "lost " });
    const rest = [
      rm({ type: "response.output_text.delta", item_id: "msg_cont", delta: "kept" }),
      rm({ type: "response.completed", response: { id: "resp_cont", status: "completed" } }),
    ];
    let evs: AgEvent[] = [];
    try {
      evs = run([created, bad, ...rest]);
    } finally {
      spy.mockRestore();
    }
    const baseline = run([created, ...rest]);
    const errors = evs.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(stripSeq(evs.filter((e) => e.type !== "error"))).toEqual(stripSeq(baseline));
    assertSeqGapFree(evs);
    assertInvariantsHold(evs);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.result().messages.flatMap((m) => m.content).find((b) => b.type === "text")).toMatchObject({ text: "kept" });
  });

  it("a SECRET_ marker in the THROWING NATIVE never reaches the wire (its batch is discarded)", () => {
    const spy = vi.spyOn(StreamAssembler.prototype, "textDelta").mockImplementationOnce(() => {
      throw new RangeError("boom");
    });
    try {
      const evs = run([
        rm({ type: "response.created", response: { id: "resp_secret_native" } }),
        rm({ type: "response.output_text.delta", item_id: "msg_sn", delta: "SECRET_NATIVE_7" }),
      ]);
      expect(JSON.stringify(evs)).not.toContain("SECRET_");
      expect(evs.some((e) => e.type === "error")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("an Error-based __host_error__ sentinel (Object.assign(new Error(msg), {type, code})) keeps its message through the entry conversion ⇒ turn.error", () => {
    const sentinel = Object.assign(new Error("Max turns (8) exceeded"), { type: "__host_error__", code: "max_turns" });
    const evs = run([created, liveNative(sentinel)]);
    expect(evs.find((e) => e.type === "turn.error")).toMatchObject({ code: "max_turns", message: "Max turns (8) exceeded" });
    expect(evs.some((e) => e.type === "ext.openai.unparsed")).toBe(false);
  });

  it("identity: an already-JSON native produces byte-identical output to before (the corpus shape)", () => {
    const plain: JsonValue[] = [
      rawModel({ type: "response.created", response: { id: "resp_id" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_id", delta: "hello" }),
      rawModel({ type: "response.completed", response: { id: "resp_id", status: "completed" } }),
    ];
    const cloned: JsonValue[] = JSON.parse(JSON.stringify(plain));
    const n1 = createOpenaiNormalizer();
    const n2 = createOpenaiNormalizer();
    expect(plain.flatMap((e) => n1.push(e)).concat(n1.flush())).toEqual(cloned.flatMap((e) => n2.push(e)).concat(n2.flush()));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RS — a RESUMED invoke opens its own turn (INV-TURN, SPEC:743). sp-probe's live
// approval-resume capture (gpt-6-sol, @openai/agents 0.18.0, 2026-09-24): after
// `RunState.fromString` + approve/reject, the resumed stream's FIRST event is the
// approved (or rejected) call's `tool_output`, before any `response.created`. The
// facet emitted tool.done with no turn open, so reduce() parked on the stream
// alone. Per sp-protocol's c20 package (A.6, openai): when the call's round is
// unknown, the leading result opens `turn_resume_<callId>` (deterministic, never
// a leg-1 `turn_resp_*` id: INV-XINV) and lands as its OWN role:"tool" message
// (`messageId: "<callId>:result"`); the resumed model response then opens its
// assistant message in that turn and its response.completed closes it (the
// sp-claude 37185be shape). Outcome stays ok/error from rawItem.status — never
// "denied" (PS-13).
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — RS a resumed invoke's leading tool_output opens its own turn", () => {
  const CALL = "call_xqZZcXHOAmS73QrOGrXeJfON"; // the captured call id
  function resumedStream(output: JsonValue, executionStatus: string | undefined): JsonValue[] {
    const item: { [k: string]: JsonValue } = {
      type: "tool_call_output_item",
      rawItem: { type: "function_call_result", name: "echo", callId: CALL, status: "completed", output },
      agent: { name: "spike" },
      output: typeof output === "string" ? output : JSON.stringify(output),
    };
    if (executionStatus !== undefined) item.executionStatus = executionStatus;
    return [
      runItem("tool_output", item),
      rawModel({ type: "response.created", response: { id: "resp_resumed", model: "gpt-6-sol" } }),
      rawModel({ type: "response.output_item.added", item: { id: "msg_resumed", type: "message", phase: "final_answer" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_resumed", delta: "Echoed." }),
      rawModel({ type: "response.completed", response: { id: "resp_resumed", status: "completed" } }),
    ];
  }
  function run(s: JsonValue[]): AgEvent[] {
    const n = createOpenaiNormalizer();
    return s.flatMap((e) => n.push(e)).concat(n.flush());
  }

  const legs: Array<[string, JsonValue, string | undefined]> = [
    ["approve", [{ type: "input_text", text: "conformance-probe-approval" }], "executed"],
    ["reject", { type: "text", text: "Tool execution was not approved." }, undefined],
  ];
  it.each(legs)("%s leg: turn.start → tool.done{messageId:<callId>:result} → the resumed response's message.start in the SAME turn; reduce() never parks", (_leg, output, status) => {
    const evs = run(resumedStream(output, status));
    const types = evs.map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["turn.start", "tool.done", "message.start"]);
    expect(evs[0]).toMatchObject({ type: "turn.start", turnId: `turn_resume_${CALL}` });
    expect(evs[1]).toMatchObject({ type: "tool.done", toolCallId: CALL, messageId: `${CALL}:result`, outcome: "ok" });
    expect(evs[2]).toMatchObject({ type: "message.start", turnId: `turn_resume_${CALL}`, model: "gpt-6-sol" });
    expect(evs.filter((e) => e.type === "turn.start")).toHaveLength(1);
    expect(evs.find((e) => e.type === "turn.done")).toMatchObject({ turnId: `turn_resume_${CALL}`, outcome: { type: "success" } });
    for (const e of evs) expect(AgEvent.safeParse(e).success).toBe(true);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    expect(res.turns).toHaveLength(1);
    // Chronological: the tool-result message, then the assistant's reply.
    expect(res.messages.map((m) => m.id)).toEqual([`${CALL}:result`, `msg_turn_resume_${CALL}`]);
    const blocks = res.messages.flatMap((m) => m.content);
    expect(blocks.find((b) => b.type === "tool-result")).toMatchObject({ toolCallId: CALL });
    expect(blocks.find((b) => b.type === "text")).toMatchObject({ text: "Echoed." });
    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });

  it("deterministic and never a leg-1 id: the same input yields the same turn id, and it is not a turn_resp_* id", () => {
    const a = run(resumedStream("ok", "executed")).find((e) => e.type === "turn.start");
    const b = run(resumedStream("ok", "executed")).find((e) => e.type === "turn.start");
    expect(a).toEqual(b);
    expect(a).toMatchObject({ turnId: `turn_resume_${CALL}` });
  });

  it("a leading result with NOTHING after it (stream ends) ⇒ flush aborts the turn (INV-FLUSH); no park", () => {
    const evs = run(resumedStream("ok", "executed").slice(0, 1));
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "tool.done", "turn.abort"]);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
  });

  // sp-protocol's pin for the pending D3 wording (c20, bar wf_9722b7bc-ba9):
  // ONE resuming invoke that carries TWO approved results (approve-all), in the
  // order the SDK replays them from RunState. One resume turn, named for the
  // FIRST call; both results are their own role:"tool" messages in it; no
  // second turn; no park. And replaying the same RunState twice (two
  // normalizers, two folds) mints the same turn id.
  function twoResultResume(): JsonValue[] {
    const result = (callId: string, text: string): JsonValue =>
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: { type: "function_call_result", name: "echo", callId, status: "completed", output: [{ type: "input_text", text }] },
        agent: { name: "spike" },
        output: JSON.stringify({ type: "text", text }),
        executionStatus: "executed",
      });
    return [
      result("call_first", "one"),
      result("call_second", "two"),
      rawModel({ type: "response.created", response: { id: "resp_two", model: "gpt-6-sol" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_two", delta: "Both echoed." }),
      rawModel({ type: "response.completed", response: { id: "resp_two", status: "completed" } }),
    ];
  }

  it("approve-all: TWO leading results ⇒ ONE resume turn (turn_resume_<firstCallId>), both results own messages <callId>:result in it, no second turn, no park", () => {
    const evs = run(twoResultResume());
    const starts = evs.filter((e) => e.type === "turn.start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ turnId: "turn_resume_call_first" });
    const dones = evs.filter((e) => e.type === "tool.done");
    expect(dones).toHaveLength(2);
    expect(dones[0]).toMatchObject({ toolCallId: "call_first", messageId: "call_first:result", turnId: "turn_resume_call_first" });
    expect(dones[1]).toMatchObject({ toolCallId: "call_second", messageId: "call_second:result", turnId: "turn_resume_call_first" });
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    expect(res.turns).toHaveLength(1);
    expect(res.messages.map((m) => m.id)).toEqual(["call_first:result", "call_second:result", "msg_turn_resume_call_first"]);
    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });

  it("approve-all determinism: the same RunState replayed through two normalizers and two folds mints the same turn id and the same fold", () => {
    const fold = (): { turnIds: unknown[]; result: unknown } => {
      const evs = run(twoResultResume());
      const r = new Reducer();
      for (const e of evs) r.push(e);
      return { turnIds: evs.filter((e) => e.type === "turn.start").map((e) => Reflect.get(e, "turnId")), result: r.result() };
    };
    const first = fold();
    const second = fold();
    expect(first.turnIds).toEqual(["turn_resume_call_first"]);
    expect(second).toEqual(first);
  });

  it("negative control: a NORMAL deferred tool result (its round is known) opens no resume turn", () => {
    const evs = run([
      rawModel({ type: "response.created", response: { id: "resp_norm" } }),
      rawModel({ type: "response.output_item.added", item: { id: "fc_norm", type: "function_call", call_id: "call_norm", name: "echo" } }),
      rawModel({ type: "response.completed", response: { id: "resp_norm", status: "completed" } }),
      runItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: { type: "function_call_result", name: "echo", callId: "call_norm", status: "completed", output: "ok" },
        output: "ok",
      }),
    ]);
    expect(evs.filter((e) => e.type === "turn.start")).toHaveLength(1);
    expect(evs.find((e) => e.type === "turn.start")).toMatchObject({ turnId: "turn_resp_norm" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OA-13 — `tool.start.providerExecuted` (SPEC:632; tool-call block
// `providerExecuted`, SPEC:210; SPEC:496 "server already ran it; client MUST
// NOT execute"). An existing optional slot (sp-rnd item 10 re-verify,
// 2026-09-23); claude and vercel already set it. Which item kinds OpenAI
// executes, per the installed runtime (agents-core 0.18.0
// dist/runner/modelOutputs.mjs):
//  - hosted_tool_call — always (:443-: resolved server-side, its own output).
//  - program — always: programmatic tool calling is a hosted tool
//    (`providerData.type:"programmatic_tool_calling"`, :23-28) and its
//    program_output arrives in the MODEL output (:435-441), never run locally.
//  - shell_call — only a hosted-container shell: "Hosted container shell is
//    executed by the API provider" (:511-517, keyed on the tool's environment
//    type); on the item that is `providerData.environment.type` (openai-node
//    7.22.0 `environment: ResponseLocalEnvironment | ResponseContainerReference
//    | null`, carried into providerData by agents-openai's converter :1318).
//  - tool_search_call — only `execution:"server"` (the item's own field).
//  - computer_call / apply_patch_call / function_call — client-executed: unset.
// Absent ⇒ key omitted (SPEC treats absent as not provider-executed).
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — OA-13 tool.start.providerExecuted", () => {
  function called(rawItem: JsonValue): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: "resp_oa13" } }),
      runItem("tool_called", { type: "tool_call_item", rawItem }),
    ];
  }
  function startOf(stream: JsonValue[]): AgEvent | undefined {
    const n = createOpenaiNormalizer();
    return stream
      .flatMap((e) => n.push(e))
      .concat(n.flush())
      .find((e) => e.type === "tool.start");
  }
  const SHELL = {
    type: "shell_call",
    callId: "call_sh",
    status: "completed",
    action: { commands: ["ls"] },
    id: "sh_1",
  };

  it("hosted_tool_call ⇒ providerExecuted:true", () => {
    const start = startOf(
      called({ type: "hosted_tool_call", id: "ws_1", name: "web_search_call", arguments: "{}", status: "completed", output: "ok" }),
    );
    expect(start).toMatchObject({ type: "tool.start", providerExecuted: true });
  });

  it("program (hosted programmatic tool calling) ⇒ providerExecuted:true", () => {
    const start = startOf(called({ type: "program", callId: "call_prog", code: "print(1)", fingerprint: "fp", id: "prog_1" }));
    expect(start).toMatchObject({ type: "tool.start", providerExecuted: true });
  });

  it("shell_call in a hosted container (environment.type container_reference) ⇒ providerExecuted:true", () => {
    const start = startOf(
      called({ ...SHELL, providerData: { environment: { type: "container_reference", container_id: "cntr_1" } } }),
    );
    expect(start).toMatchObject({ type: "tool.start", providerExecuted: true });
  });

  it("shell_call local / environment null / no providerData ⇒ no providerExecuted key (byte-identical)", () => {
    const bare = startOf(called(SHELL));
    expect(bare).not.toHaveProperty("providerExecuted");
    expect(startOf(called({ ...SHELL, providerData: { environment: { type: "local" } } }))).toEqual(bare);
    expect(startOf(called({ ...SHELL, providerData: { environment: null } }))).toEqual(bare);
    expect(startOf(called({ ...SHELL, providerData: { environment: "container" } }))).toEqual(bare);
  });

  it("tool_search execution:server ⇒ true; execution:client / absent ⇒ no key", () => {
    const search = (execution: string | undefined): JsonValue[] => [
      rawModel({ type: "response.created", response: { id: "resp_oa13_ts" } }),
      runItem("tool_search_called", {
        type: "tool_search_call_item",
        rawItem: {
          type: "tool_search_call",
          callId: "call_ts",
          ...(execution !== undefined ? { execution } : {}),
          arguments: { query: "q" },
          id: "ts_1",
        },
      }),
    ];
    expect(startOf(search("server"))).toMatchObject({ providerExecuted: true });
    expect(startOf(search("client"))).not.toHaveProperty("providerExecuted");
    expect(startOf(search(undefined))).not.toHaveProperty("providerExecuted");
  });

  it("client-executed kinds (computer_call, apply_patch_call, raw function_call) ⇒ no providerExecuted key", () => {
    expect(
      startOf(called({ type: "computer_call", callId: "call_cu", status: "completed", action: { type: "screenshot" }, id: "cu_1" })),
    ).not.toHaveProperty("providerExecuted");
    expect(
      startOf(
        called({
          type: "apply_patch_call",
          callId: "call_ap",
          status: "completed",
          operation: { type: "update_file", path: "a.txt", diff: "-a\n+b" },
          id: "ap_1",
        }),
      ),
    ).not.toHaveProperty("providerExecuted");
    expect(
      startOf([
        rawModel({ type: "response.created", response: { id: "resp_oa13_fc" } }),
        rawModel({ type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_fc", name: "echo" } }),
      ]),
    ).not.toHaveProperty("providerExecuted");
  });

  it("fold: the tool-call block carries providerExecuted:true for a hosted call", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    const stream = [
      ...called({ type: "hosted_tool_call", id: "ws_2", name: "web_search_call", arguments: "{}", status: "completed", output: "ok" }),
      rawModel({ type: "response.completed", response: { id: "resp_oa13", status: "completed" } }),
    ];
    for (const e of stream) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const block = r
      .result()
      .messages.flatMap((m) => m.content)
      .find((b) => b.type === "tool-call");
    expect(block).toMatchObject({ providerExecuted: true });
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IS — ids the facet MINTS are unique across invokes (sp-protocol's D3 bar,
// wf_9722b7bc-ba9, finding DC-10; the rnd-14 ruling; INV-BLOCK collision-free
// derived ids). guuey folds every invoke of a conversation into ONE Reducer; the
// old per-normalizer counters (`turn_openai_<n>`, `turn_handoff_<n>`) repeated
// across invokes. Now each normalizer draws a random `openai_<16 hex>` stem once
// (outside withAtomicPush's inner factory), or takes the host's `invokeId`.
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — IS minted ids are unique across invokes folded into one Reducer", () => {
  // No response.created: the facet mints the fallback turn id.
  const FALLBACK_INVOKE: JsonValue[] = [rawModel({ type: "response.output_text.delta", item_id: "msg_fb", delta: "hi" })];
  // Each invoke has its own (wire-unique) response id; only the MINTED
  // subagent turn id is under test. The transfer is the function_call the
  // model emitted (as on the live wire, handoff-gpt6sol): its result rides
  // handoff_occurred (HO), so the round's close waits for it.
  const handoffInvoke = (respId: string): JsonValue[] => [
    rawModel({ type: "response.created", response: { id: respId } }),
    rawModel({ type: "response.output_item.added", item: { id: "fc_h", type: "function_call", call_id: "call_h", name: "transfer_to_helper" } }),
    rawModel({ type: "response.completed", response: { id: respId, status: "completed" } }),
    runItem("handoff_requested", {
      type: "handoff_call_item",
      rawItem: { type: "function_call", name: "transfer_to_helper", callId: "call_h", status: "completed", arguments: "{}" },
      agent: { name: "spike" },
    }),
    runItem("handoff_occurred", {
      type: "handoff_output_item",
      rawItem: { type: "function_call_result", name: "transfer_to_helper", callId: "call_h", status: "completed", output: "{}" },
      sourceAgent: { name: "spike" },
      targetAgent: { name: "helper" },
    }),
  ];
  function invoke(stream: JsonValue[], options?: { invokeId?: string }): AgEvent[] {
    const n = createOpenaiNormalizer(options);
    return stream.flatMap((e) => n.push(e)).concat(n.flush());
  }
  function turnIds(evs: AgEvent[]): unknown[] {
    return evs.filter((e) => e.type === "turn.start" || e.type === "subagent.start").map((e) => Reflect.get(e, "turnId"));
  }
  function foldTogether(...invokes: AgEvent[][]): Reducer {
    const r = new Reducer();
    // Each invoke restarts seq at 0 (a backward jump folds normally, INV-SEQ).
    for (const evs of invokes) for (const e of evs) r.push(e);
    return r;
  }

  it("two FALLBACK-path invokes (no response.created) ⇒ distinct turn ids; one Reducer folds both without parking", () => {
    const a = invoke(FALLBACK_INVOKE);
    const b = invoke(FALLBACK_INVOKE);
    const [ta] = turnIds(a);
    const [tb] = turnIds(b);
    expect(typeof ta).toBe("string");
    expect(ta).not.toBe(tb);
    expect(String(ta)).toMatch(/^turn_openai_[0-9a-f]{16}_1$/);
    const r = foldTogether(a, b);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.map((t) => t.turnId)).toEqual([ta, tb]);
  });

  it("two HANDOFF invokes ⇒ distinct subagent turn ids; one Reducer folds both without parking", () => {
    const a = invoke(handoffInvoke("resp_h1"));
    const b = invoke(handoffInvoke("resp_h2"));
    const subA = a.find((e) => e.type === "subagent.start");
    const subB = b.find((e) => e.type === "subagent.start");
    expect(Reflect.get(subA ?? {}, "turnId")).not.toBe(Reflect.get(subB ?? {}, "turnId"));
    expect(String(Reflect.get(subA ?? {}, "turnId"))).toMatch(/^turn_openai_[0-9a-f]{16}_handoff_1$/);
    expect(foldTogether(a, b).needsResync).toBe(false);
  });

  it("two host-error sentinels with no turn open ⇒ distinct terminal turns", () => {
    const sentinel = [
      { type: "__host_error__", code: "max_turns", message: "Max turns (8) exceeded" } satisfies JsonValue,
    ];
    const a = invoke(sentinel);
    const b = invoke(sentinel);
    expect(turnIds(a)[0]).not.toBe(turnIds(b)[0]);
    expect(foldTogether(a, b).needsResync).toBe(false);
  });

  it("a host-supplied invokeId makes the minted ids deterministic (replay, tests)", () => {
    expect(turnIds(invoke(FALLBACK_INVOKE, { invokeId: "inv_A" }))).toEqual(["turn_inv_A_1"]);
    expect(turnIds(invoke(handoffInvoke("resp_h"), { invokeId: "inv_A" }))).toEqual(["turn_resp_h", "turn_inv_A_handoff_1"]);
  });

  it("withAtomicPush rebuild keeps the SAME random stem: a throw after a fallback open ⇒ one turn, its id unchanged through the rebuild", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      ...FALLBACK_INVOKE,
      runItem("tool_called", { type: "tool_call_item" }), // malformed: drive() throws → rebuild
      rawModel({ type: "response.output_text.delta", item_id: "msg_fb", delta: " there" }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const starts = evs.filter((e) => e.type === "turn.start");
    expect(starts).toHaveLength(1);
    expect(evs.filter((e) => e.type === "error")).toHaveLength(1);
    const tid = Reflect.get(starts[0] ?? {}, "turnId");
    expect(evs.find((e) => e.type === "turn.abort")).toMatchObject({ turnId: tid });
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.flatMap((m) => m.content).find((b) => b.type === "text")).toMatchObject({ text: "hi there" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O1 — the honest flush (sp-protocol's fold/flush package, A.5 + A.6 openai;
// §10 item 26's OpenAI leg). The real-order approval interruption is
// function_call → response.completed (usage U) → tool_called →
// tool_approval_requested → end of stream (sp-probe's live leg-1 capture). It
// used to flush as turn.done{success} (CB-14 / PS-2): now `paused`, asks naming
// approval_<callId>, the stashed finishReason and usage U.
// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenaiNormalizer — O1 honest flush (fold/flush option 1)", () => {
  const U = { input_tokens: 110, output_tokens: 56, total_tokens: 166 };
  function approvalRound(respId: string, callId: string, opts: { ask: boolean; completed?: { [k: string]: JsonValue } }): JsonValue[] {
    return [
      rawModel({ type: "response.created", response: { id: respId } }),
      rawModel({ type: "response.output_item.added", item: { id: `fc_${callId}`, type: "function_call", call_id: callId, name: "echo" } }),
      rawModel({ type: "response.function_call_arguments.done", item_id: `fc_${callId}`, arguments: '{"message":"x"}' }),
      rawModel({ type: "response.completed", response: { id: respId, status: "completed", usage: U, ...(opts.completed ?? {}) } }),
      runItem("tool_called", {
        type: "tool_call_item",
        rawItem: { type: "function_call", name: "echo", callId, status: "completed", arguments: '{"message":"x"}' },
      }),
      ...(opts.ask
        ? [
            runItem("tool_approval_requested", {
              type: "tool_approval_item",
              rawItem: { type: "function_call", name: "echo", callId, status: "completed", arguments: '{"message":"x"}' },
            }),
          ]
        : []),
    ];
  }
  function run(s: JsonValue[]): AgEvent[] {
    const n = createOpenaiNormalizer();
    return s.flatMap((e) => n.push(e)).concat(n.flush());
  }
  function fold(evs: AgEvent[]): Reducer {
    const r = new Reducer();
    for (const e of evs) r.push(e);
    return r;
  }

  it("§10.26 leg: the approval interruption flushes EXACTLY one terminal — turn.done{paused, asks:[approval_<callId>]}, the stashed finishReason and usage U; never success, never abort", () => {
    const evs = run(approvalRound("resp_ap", "call_ap", { ask: true }));
    const terminals = evs.filter((e) => e.type === "turn.done" || e.type === "turn.abort" || e.type === "turn.error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      type: "turn.done",
      turnId: "turn_resp_ap",
      outcome: { type: "paused", asks: [{ askId: "approval_call_ap", kind: "approval", toolCallId: "call_ap" }] },
      finishReason: "stop",
      usage: { inputTokens: 110, outputTokens: 56 },
    });
    // The hitl.ask the pause names was emitted before it.
    const types = evs.map((e) => e.type);
    expect(types.indexOf("hitl.ask")).toBeLessThan(types.indexOf("turn.done"));
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns[0]).toMatchObject({ outcome: { type: "paused" } });
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });

  it("§10.26 leg: the same stream WITHOUT tool_approval_requested ⇒ turn.abort{stream-truncated} and a message.end carrying usage U", () => {
    const evs = run(approvalRound("resp_na", "call_na", { ask: false }));
    expect(evs.filter((e) => e.type === "turn.done")).toHaveLength(0);
    expect(evs.find((e) => e.type === "turn.abort")).toMatchObject({ turnId: "turn_resp_na", reason: "stream-truncated" });
    expect(evs.find((e) => e.type === "message.end")).toMatchObject({ usage: { inputTokens: 110, outputTokens: 56 } });
    expect(fold(evs).needsResync).toBe(false);
  });

  it("a NON-success deferred close (content_filter, tool still pending) is released VERBATIM at flush", () => {
    const evs = run(approvalRound("resp_cf", "call_cf", { ask: false, completed: { incomplete_details: { reason: "content_filter" } } }));
    const done = evs.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({ turnId: "turn_resp_cf", outcome: { type: "error" }, finishReason: "safety_blocked" });
    expect(evs.some((e) => e.type === "turn.abort")).toBe(false);
  });

  it("message.end in insertion order: an OLDER stashed round's message ends before the live response's", () => {
    const evs = run([
      ...approvalRound("resp_old", "call_old", { ask: false }),
      rawModel({ type: "response.created", response: { id: "resp_live" } }),
      rawModel({ type: "response.output_text.delta", item_id: "msg_live", delta: "partial" }),
    ]);
    const ends = evs.filter((e) => e.type === "message.end").map((e) => Reflect.get(e, "id"));
    expect(ends).toEqual(["msg_turn_resp_old", "msg_turn_resp_live"]);
    expect(evs.some((e) => e.type === "turn.done")).toBe(false);
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.every((t) => t.outcome?.type === "aborted")).toBe(true);
  });

  it.each([
    ["no approval ask", false, "turn.abort"],
    ["an approval ask outstanding", true, "turn.done"],
  ] as const)("host error with a DEFERRED round (%s) ⇒ the stash is released per INV-FLUSH (2) BEFORE the error closes", (_label, ask, releasedAs) => {
    const evs = run([
      ...approvalRound("resp_he", "call_he", { ask }),
      { type: "__host_error__", code: "max_turns", message: "Max turns (8) exceeded" } satisfies JsonValue,
    ]);
    const types = evs.map((e) => e.type);
    const release = types.indexOf(releasedAs);
    const error = types.indexOf("turn.error");
    expect(release).toBeGreaterThanOrEqual(0);
    expect(error).toBeGreaterThan(release);
    expect(evs[release]).toMatchObject({ turnId: "turn_resp_he" });
    if (ask) expect(evs[release]).toMatchObject({ outcome: { type: "paused" } });
    const outcomes = evs.filter((e) => e.type === "turn.done").map((e) => Reflect.get(e, "outcome"));
    expect(outcomes.some((o) => typeof o === "object" && o !== null && Reflect.get(o, "type") === "success")).toBe(false);
    expect(fold(evs).needsResync).toBe(false);
  });
});
