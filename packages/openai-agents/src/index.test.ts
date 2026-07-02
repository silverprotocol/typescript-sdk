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
// Task 3 (audit M48) — port the three typed-but-no-op'd known run-item
// families: reasoning_item_created (incl. rs_/encrypted_content ZDR replay),
// handoff_requested, tool_approval_requested. Plus: the default arm now
// routes genuinely-unknown run-item names to `ext.openai.unparsed` (the file's
// stated convention, previously untrue — M48).
//
// Single-sourcing note: none of these three typed run-item interfaces has a
// counterpart arm in `response.output_item.added` (that raw event only special-
// cases `item.type === "function_call"`, and none of the three declares a
// richer item shape there — reasoning's content/encrypted_content and
// handoff's targetAgent exist ONLY on the run-item's `rawItem`). So the
// run-item arm is the sole source for all three; `output_item.added` is left
// untouched.
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
});

describe("createOpenaiNormalizer — handoff_requested (Task 3, audit M48)", () => {
  it("⇒ a `handoff` event (NOT subagent.start) — the wire carries no completion signal, so opening a nested turn would get INV-FLUSH-aborted on a genuinely-completed handoff", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_handoff_1" } }),
      runItem("handoff_requested", {
        type: "handoff_call_item",
        rawItem: {
          type: "function_call",
          name: "transfer_to_billing_agent",
          callId: "call_handoff_1",
          arguments: "{}",
          targetAgent: "billing_agent",
          id: "fc_handoff_1",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_handoff_1", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());

    const handoff = evs.find((e) => e.type === "handoff") as {
      kind?: string;
      toAgentName?: string;
      fromAgentId?: string;
      toAgentId?: string;
    };
    expect(handoff).toBeDefined();
    expect(handoff?.kind).toBe("transfer");
    expect(handoff?.toAgentName).toBe("billing_agent");
    // No agent-identity concept exists anywhere in this facet (single fixed
    // threadId) — fromAgentId/toAgentId are never fabricated.
    expect(handoff?.fromAgentId).toBeUndefined();
    expect(handoff?.toAgentId).toBeUndefined();

    // Never a subagent lifecycle for this facet's handoff mapping.
    expect(evs.find((e) => e.type === "subagent.start")).toBeUndefined();
    expect(evs.find((e) => e.type === "subagent.done")).toBeUndefined();
  });

  it("no targetAgent on the typed input ⇒ handoff event still fires, without a fabricated toAgentName", () => {
    const n = createOpenaiNormalizer();
    const evs = [
      rawModel({ type: "response.created", response: { id: "resp_handoff_2" } }),
      runItem("handoff_requested", {
        type: "handoff_call_item",
        rawItem: {
          type: "function_call",
          name: "transfer_to_agent",
          callId: "call_handoff_2",
          arguments: "{}",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_handoff_2", status: "completed" } }),
    ]
      .flatMap((e) => n.push(e))
      .concat(n.flush());
    const handoff = evs.find((e) => e.type === "handoff") as { toAgentName?: string };
    expect(handoff).toBeDefined();
    expect(handoff?.toAgentName).toBeUndefined();
  });

  it("fold-identity: the handoff record lands on the turn's handoffs[], needsResync=false", () => {
    const n = createOpenaiNormalizer();
    const r = new Reducer();
    const stream = [
      rawModel({ type: "response.created", response: { id: "resp_handoff_3" } }),
      runItem("handoff_requested", {
        type: "handoff_call_item",
        rawItem: {
          type: "function_call",
          name: "transfer_to_billing_agent",
          callId: "call_handoff_3",
          arguments: "{}",
          targetAgent: "billing_agent",
        },
      }),
      rawModel({ type: "response.completed", response: { id: "resp_handoff_3", status: "completed" } }),
    ];
    for (const e of stream) for (const ev of n.push(e)) r.push(ev);
    for (const ev of n.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    const turn = res.turns.find((t) => t.turnId === "turn_resp_handoff_3");
    expect(turn?.handoffs).toMatchObject([{ kind: "transfer", toAgentName: "billing_agent" }]);
    expect(() => AgReduceResult.parse(res)).not.toThrow();
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
