// Fixtures captured live from OpenRouter /v1/responses (beta), non-OpenAI model
// meta-llama/llama-3.3-70b-instruct, #128 spike 2026-06-30. Locks in: OpenRouter
// rides the EXISTING OpenAI Responses normalizer with ZERO code change.
//
// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter exposes an OpenAI **Responses-API beta** surface at /v1/responses.
// The @openai/agents SDK, in its DEFAULT Responses mode, therefore produces the
// SAME `RunStreamEvent` stream against OpenRouter as it does against OpenAI — so
// `createOpenaiNormalizer` (the existing OpenAI-Responses facet) normalizes it
// verbatim. This regression PINS that fact against two drifts:
//   1. OpenRouter's beta surface drifting away from OpenAI Responses shape, and
//   2. anyone re-introducing a `chat_completions`-flavoured normalizer branch
//      under the (false) belief OpenRouter needs special handling.
//
// The two streams below are a faithful TRIM of the real capture
// (`/tmp/or-spike-events.json`, since deleted) down to the subset the normalizer
// reads: the authoritative `model`-carrier Responses events + the tool run-items.
// Provider noise the normalizer never consults (`sequence_number`, `logprobs`,
// `created_at`, `object`, the echoed `response.output[]` arrays, the flattened
// `output_text_delta`/`response_started`/`response_done` literals, the duplicate
// `response.completed`, `response.in_progress`/`content_part.*`/`output_item.done`)
// is dropped; the trimmed streams drive the engine to the SAME AgJSON (verified by
// running, not assumed). ONE fixture — the tool turn's TERMINAL `response.completed`
// — deliberately keeps OpenRouter's FULL `response.usage` SUPERSET (`cost`,
// `cost_details`, `is_byok`) so the test also pins that `mapUsage` tolerates the
// superset and never leaks those money fields into `AgUsage` (cost is the broker
// meter's job, not the normalizer's).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from "vitest";
import { AgReduceResult, JsonValue, Reducer } from "@silverprotocol/core";
import { createOpenaiNormalizer } from "./index.js";

// The Agents SDK `model` carrier: the verbatim openai-node Responses event rides
// in `event` (snake_case). Same envelope OpenRouter's beta surface emits.
function rawModel(event: JsonValue): JsonValue {
  return { type: "raw_model_stream_event", data: { type: "model", event } };
}

// ── TEXT TURN — a plain text turn (real capture, "Hello.") ────────────────────
const TEXT_TURN: JsonValue[] = [
  // Authoritative turn open — real response.id present at start.
  rawModel({ type: "response.created", response: { id: "gen-1782801068-BgE9uEvKkzui3mQStFPx" } }),
  // Streamed assistant text (OpenRouter delivered the whole turn in one chunk).
  rawModel({ type: "response.output_text.delta", item_id: "msg_tmp_30akrkn4xj9", delta: "Hello." }),
  rawModel({ type: "response.output_text.done", item_id: "msg_tmp_30akrkn4xj9", text: "Hello." }),
  // Authoritative close + final usage.
  rawModel({
    type: "response.completed",
    response: {
      id: "gen-1782801068-BgE9uEvKkzui3mQStFPx",
      status: "completed",
      usage: {
        input_tokens: 27,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 30,
      },
    },
  }),
];

// The real per-chunk text fragments from the capture's second round-trip.
const TOOL_TEXT_DELTAS = [
  "The",
  " weather",
  " in",
  " Paris",
  " is",
  " ",
  "21",
  "°C",
  " and",
  " sunny",
  ".",
];

// ── TOOL TURN — a get_weather tool round-trip + a final text round-trip ────────
// TWO LLM round-trips (two `response.created`…`response.completed` cycles) → TWO
// normalized turns. Note the tool's `call_id` is OpenRouter's `chatcmpl-tool-…`
// flavour (snake_case `call_id` on `output_item.added`, DISTINCT from the `fc_…`
// item id) — the existing normalizer keys on it unchanged.
const TOOL_TURN: JsonValue[] = [
  // ─ round 1: the tool call ─
  rawModel({ type: "response.created", response: { id: "gen-1782801069-teHVpsyBYzPK9OilFHhl" } }),
  // Authoritative tool-start: function_call output_item.added (snake_case call_id).
  rawModel({
    type: "response.output_item.added",
    item: {
      id: "fc_tmp_qwefa3kqzt",
      type: "function_call",
      status: "in_progress",
      call_id: "chatcmpl-tool-9176ba2d93a505c4",
      name: "get_weather",
      arguments: "",
    },
  }),
  // Streamed argument fragments (fc_-keyed).
  rawModel({
    type: "response.function_call_arguments.delta",
    item_id: "fc_tmp_qwefa3kqzt",
    delta: '{"city": "',
  }),
  rawModel({
    type: "response.function_call_arguments.delta",
    item_id: "fc_tmp_qwefa3kqzt",
    delta: 'Paris"}',
  }),
  // Sealed arguments JSON string.
  rawModel({
    type: "response.function_call_arguments.done",
    item_id: "fc_tmp_qwefa3kqzt",
    arguments: '{"city": "Paris"}',
  }),
  // Round-1 close (the tool-call round-trip).
  rawModel({
    type: "response.completed",
    response: {
      id: "gen-1782801069-teHVpsyBYzPK9OilFHhl",
      status: "completed",
      usage: { input_tokens: 225, output_tokens: 17, total_tokens: 242 },
    },
  }),
  // tool_called run-item — IGNORED (superseded by output_item.added).
  {
    type: "run_item_stream_event",
    name: "tool_called",
    item: {
      type: "tool_call_item",
      rawItem: {
        type: "function_call",
        id: "fc_tmp_qwefa3kqzt",
        callId: "chatcmpl-tool-9176ba2d93a505c4",
        name: "get_weather",
        status: "completed",
        arguments: '{"city": "Paris"}',
      },
    },
  },
  // tool_output run-item — authoritative tool-result source.
  {
    type: "run_item_stream_event",
    name: "tool_output",
    item: {
      type: "tool_call_output_item",
      rawItem: {
        type: "function_call_result",
        name: "get_weather",
        callId: "chatcmpl-tool-9176ba2d93a505c4",
        status: "completed",
        output: { type: "text", text: "It is 21°C and sunny in Paris." },
      },
      output: "It is 21°C and sunny in Paris.",
    },
  },
  // ─ round 2: the final text answer ─
  rawModel({ type: "response.created", response: { id: "gen-1782801070-T4gq9Oz4Bv5AoSog1Cxd" } }),
  ...TOOL_TEXT_DELTAS.map((delta) =>
    rawModel({ type: "response.output_text.delta", item_id: "msg_tmp_eh8trgeytn5", delta }),
  ),
  rawModel({
    type: "response.output_text.done",
    item_id: "msg_tmp_eh8trgeytn5",
    text: "The weather in Paris is 21°C and sunny.",
  }),
  // Round-2 (TERMINAL) close — keeps OpenRouter's FULL usage SUPERSET on purpose:
  // `cost`, `cost_details`, `is_byok` MUST NOT leak into AgUsage (broker's job).
  rawModel({
    type: "response.completed",
    response: {
      id: "gen-1782801070-T4gq9Oz4Bv5AoSog1Cxd",
      status: "completed",
      usage: {
        input_tokens: 267,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 12,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 279,
        cost: 3.951e-5,
        is_byok: false,
        cost_details: {
          upstream_inference_cost: 3.951e-5,
          upstream_inference_input_cost: 3.471e-5,
          upstream_inference_output_cost: 4.8e-6,
        },
      },
    },
  }),
  // message_output_created with no annotations — citations supplement no-op.
  {
    type: "run_item_stream_event",
    name: "message_output_created",
    item: {
      type: "message_output_item",
      rawItem: {
        id: "msg_tmp_eh8trgeytn5",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "The weather in Paris is 21°C and sunny." }],
      },
    },
  },
];

describe("OpenRouter /v1/responses (beta) rides the existing OpenAI normalizer (#128)", () => {
  it("text turn → identical AgEvent shape + reduced result (zero code change)", () => {
    const n = createOpenaiNormalizer();
    const evs = TEXT_TURN.flatMap((e) => n.push(e)).concat(n.flush());

    // (1) Exact normalized AgEvent type sequence.
    expect(evs.map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.end",
      "turn.done",
    ]);

    // (2) Fold the AgEvent[] through the Reducer and pin the result snapshot
    // (a fresh normalizer so push/flush ordering into the Reducer is clean).
    const r = new Reducer();
    const fn = createOpenaiNormalizer();
    for (const e of TEXT_TURN) for (const ev of fn.push(e)) r.push(ev);
    for (const ev of fn.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();

    // assistant text content.
    const text = res.messages.flatMap((m) => m.content).find((b) => b.type === "text");
    expect(text).toMatchObject({ type: "text", text: "Hello." });

    // exactly one turn, finishReason stop, usage 27/3/30.
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0]).toMatchObject({
      finishReason: "stop",
      outcome: { type: "success" },
    });
    expect(res.turns[0]?.usage).toMatchObject({ inputTokens: 27, outputTokens: 3, totalTokens: 30 });

    // (3) Schema validity.
    expect(() => AgReduceResult.parse(res)).not.toThrow();
  });

  it("tool turn → tool.start/args.assembled/done + two turn.done, no cost leak (deferred-close order)", () => {
    const n = createOpenaiNormalizer();
    const evs = TOOL_TURN.flatMap((e) => n.push(e)).concat(n.flush());
    const types = evs.map((e) => e.type);

    // (1) Exact normalized AgEvent type sequence across BOTH round-trips. The 11
    // real text deltas of round 2 yield 11 text.delta events under one text.start.
    // Round 1's close (message.end + turn.done) is DEFERRED past its late
    // tool.done (SPEC §5.0 INV-MSG; Task 4b — the real wire delivers
    // tool_output AFTER response.completed, so closing early would target an
    // already-sealed message/closed turn and resync-park).
    expect(types).toEqual([
      // round 1: tool call
      "turn.start",
      "message.start",
      "tool.start",
      "tool.args.delta",
      "tool.args.delta",
      "tool.args.assembled",
      "tool.done",
      "message.end",
      "turn.done",
      // round 2: final text
      "turn.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.delta",
      "text.delta",
      "text.delta",
      "text.delta",
      "text.delta",
      "text.delta",
      "text.delta",
      "text.delta",
      "text.delta",
      "text.delta",
      "text.end",
      "message.end",
      "turn.done",
    ]);
    // The load-bearing markers (explicit, so a sequence refactor can't silently drop them).
    expect(types).toContain("tool.start");
    expect(types).toContain("tool.args.assembled");
    expect(types).toContain("tool.done");
    expect(types.filter((t) => t === "turn.done")).toHaveLength(2);

    // (2) Fold and pin the reduced snapshot.
    const r = new Reducer();
    const fn = createOpenaiNormalizer();
    for (const e of TOOL_TURN) for (const ev of fn.push(e)) r.push(ev);
    for (const ev of fn.flush()) r.push(ev);
    expect(r.needsResync).toBe(false);
    const res = r.result();

    const allBlocks = res.messages.flatMap((m) => m.content);

    // tool-call block: input {city:'Paris'}.
    const toolCall = allBlocks.find((b) => b.type === "tool-call");
    expect(toolCall).toMatchObject({
      type: "tool-call",
      name: "get_weather",
      input: { city: "Paris" },
    });

    // tool-result block: text + ok outcome.
    const toolResult = allBlocks.find((b) => b.type === "tool-result") as {
      content?: Array<{ type?: string; text?: string }>;
      outcome?: string;
    };
    expect(toolResult).toBeDefined();
    expect(toolResult?.outcome).toBe("ok");
    expect(toolResult?.content?.[0]).toMatchObject({
      type: "text",
      text: "It is 21°C and sunny in Paris.",
    });

    // final assistant text.
    const finalText = allBlocks.find((b) => b.type === "text" && "text" in b && b.text.startsWith("The weather"));
    expect(finalText).toMatchObject({ type: "text", text: "The weather in Paris is 21°C and sunny." });

    // TWO turns, both finishReason stop.
    expect(res.turns).toHaveLength(2);
    expect(res.turns.every((t) => t.finishReason === "stop")).toBe(true);

    // (3) Schema validity.
    expect(() => AgReduceResult.parse(res)).not.toThrow();

    // (4) Cost mapping: the TERMINAL turn's usage carried OpenRouter's full
    // superset (`cost`/`cost_details`/`is_byok`). AgUsage maps the provider-REPORTED
    // cost figure verbatim to costUsd (cost is provider-reported wire data with
    // a first-class AgUsage home; guuey's broker meters off the teed wire and
    // reads no normalizer costUsd — audit M42 canonical).
    const terminalTurn = res.turns.find((t) => t.turnId === "turn_gen-1782801070-T4gq9Oz4Bv5AoSog1Cxd");
    expect(terminalTurn?.usage).toMatchObject({
      inputTokens: 267,
      outputTokens: 12,
      totalTokens: 279,
      costUsd: 3.951e-5,
    });
    const usageKeys = Object.keys(terminalTurn?.usage ?? {});
    expect(usageKeys).not.toContain("cost");
    expect(usageKeys).not.toContain("cost_details");
    expect(usageKeys).not.toContain("is_byok");
  });
});
