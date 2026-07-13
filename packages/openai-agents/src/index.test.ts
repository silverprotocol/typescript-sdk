import { describe, it, expect } from "vitest";
import { AgEvent, AgReduceResult, JsonValue, Reducer } from "@silverprotocol/core";
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
    expect(turnRecord?.outcome).toBeDefined();
    expect(turnRecord?.finishReason).toBeDefined();

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

  it("tool_output never arrives ⇒ flush() emits the stashed turn.done (not turn.abort)", () => {
    const n = createOpenaiNormalizer();
    // Drop the trailing tool_output run-item — the result never lands.
    const withoutToolOutput = TOOL_TURN_LATE_RESULT.slice(0, -1);
    const evs = withoutToolOutput.flatMap((e) => n.push(e)).concat(n.flush());
    const types = evs.map((e) => e.type);

    // No tool.done was ever emitted, but the round's genuine completion still
    // surfaces via flush() as turn.done — never turn.abort.
    expect(types).not.toContain("tool.done");
    expect(types).not.toContain("turn.abort");
    expect(types.filter((t) => t === "turn.done")).toHaveLength(1);

    const done = evs.find((e) => e.type === "turn.done") as {
      turnId?: string;
      finishReason?: string;
      outcome?: { type?: string };
    };
    expect(done).toBeDefined();
    expect(done?.turnId).toBe("turn_resp_late_1");
    // finishReason/outcome come from the STASHED payload (the original close),
    // not a synthesized abort.
    expect(done?.finishReason).toBe("stop");
    expect(done?.outcome).toMatchObject({ type: "success" });
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
// source for all of them; `output_item.added` is left untouched.
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

// handoff_requested / handoff_occurred (Task 3, audit M48; corrected by the M48
// REVIEW, Finding 1). Every run-item on this seam — these two included — arrives
// AFTER its owning round's `response.completed` on the real wire (mirrors the
// #128 live-proven message_output_created ordering, M22 / Task 4b), so the
// fixtures below put `response.completed` BEFORE the handoff run-items.
describe("createOpenaiNormalizer — handoff_requested / handoff_occurred (Task 3, audit M48 review Finding 1)", () => {
  it("handoff_requested ⇒ subagent.start; handoff_occurred ⇒ subagent.done (agent identity rides via the paired handoff event, not subagentStart)", () => {
    const n = createOpenaiNormalizer();
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
    expect(start?.turnId).toBe("turn_handoff_1");
    expect(start?.parentTurnId).toBe("turn_resp_handoff_1");

    const done = evs.find((e) => e.type === "subagent.done") as {
      turnId?: string;
      parentTurnId?: string;
    };
    expect(done).toBeDefined();
    expect(done?.turnId).toBe("turn_handoff_1");
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
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    const stream = [
      rawModel({ type: "response.created", response: { id: "resp_handoff_2" } }),
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
    const subTurn = res.turns.find((t) => t.turnId === "turn_handoff_1");
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
