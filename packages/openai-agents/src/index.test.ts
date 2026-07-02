import { describe, it, expect } from "vitest";
import { AgReduceResult, JsonValue, Reducer } from "@silverprotocol/core";
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

describe("createOpenaiNormalizer — message_output_created citations supplement (T5c)", () => {
  it("emits a content.block with citations and does NOT re-emit text", () => {
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
    // The supplement emits a content.block carrying citations.
    const block = evs.find((e) => e.type === "content.block") as {
      block?: { type?: string; text?: string; citations?: Array<{ url?: string }> };
    };
    expect(block).toBeDefined();
    expect(block?.block?.type).toBe("text");
    expect(block?.block?.citations?.[0]?.url).toBe("https://example.com/france");
    // Text was NOT re-emitted: exactly ONE text.delta (from the raw delta path),
    // not a second one from the run-item.
    const deltas = evs.filter((e) => e.type === "text.delta");
    expect(deltas).toHaveLength(1);
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
