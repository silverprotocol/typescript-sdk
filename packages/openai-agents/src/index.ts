/**
 * `@silverprotocol/openai-agents` — the OpenAI Agents SDK normalizer
 * (FIXTURE-TESTED ONLY; no guuey runtime emits this native input yet).
 *
 * Translates the OpenAI Agents JS SDK stream-event union into AgJSON events
 * (`AgEvent[]`, spec §4). The Agents SDK surfaces TWO event families on its
 * `RunStreamEvent` stream:
 *   1. `RunItemStreamEvent` (type:"run_item_stream_event") — a SEMANTIC wrapper
 *      around a completed `RunItem` (message / tool-call / tool-output /
 *      reasoning). Its `item.rawItem` is the protocol item.
 *   2. `RunRawModelStreamEvent` (type:"raw_model_stream_event") — its `data` is the
 *      Agents SDK's own `ResponseStreamEvent` union (`@openai/agents` protocol
 *      `StreamEvent`): the literals `output_text_delta`, `response_started`,
 *      `response_done`, and a generic `model` carrier (`{ type:"model"; event }`).
 *      The verbatim openai-node Responses events (`response.output_text.delta`,
 *      `response.function_call_arguments.delta`/`.done`, `response.completed`) ride
 *      INSIDE the `model` carrier's `event` field and use snake_case fields
 *      (`item_id`, `arguments`, `delta`, `output_index`, `sequence_number`,
 *      `incomplete_details`) — NOT camelCase.
 *
 * Both families are needed: the run-item wrapper gives the assembled tool-call /
 * reasoning items (with the `fc_`/`rs_` ids that are replay-load-bearing), while
 * the raw Responses deltas (in the `model` carrier) carry the streamed text + the
 * per-fragment tool-call argument accumulation the spec mandates (§8.1).
 *
 * The normalizer is STATEFUL across calls (spec §8): it buffers
 * `function_call_arguments.delta` fragments per Responses item id and assembles
 * the mandatory `tool.args.assembled` on `.done`. `seq` is allocated
 * monotonically from 0 WITHIN each call; the Router rebases to a global ordinal
 * downstream (out of scope here).
 *
 * The `OpenAIStreamEvent` discriminated union below is a faithful PROJECTION of
 * the verified `@openai/agents` `RunStreamEvent` union + the openai-node
 * `ResponseStreamEvent` shapes — hand-defined as the fixture contract (the
 * subset the normalizer consumes) until the OpenAI runtime is wired. It is NOT a
 * raw-provider-event redefinition with an invented shape; field names match the
 * primary sources (snake_case for the openai-node Responses events). Verified
 * against the primary sources (June 2026):
 *   - openai/openai-agents-js packages/agents-core/src/events.ts
 *     (`RunItemStreamEvent` + `RunItemStreamEventName`;
 *      `RunRawModelStreamEvent.data: ResponseStreamEvent`)
 *   - openai/openai-agents-js packages/agents-core/src/items.ts
 *     (`RunMessageOutputItem`/`RunToolCallItem`/`RunToolCallOutputItem`/`RunReasoningItem`)
 *   - openai/openai-agents-js packages/agents-core/src/types/protocol.ts
 *     (`AssistantMessageItem` / `FunctionCallItem.{callId,name,arguments,id}` /
 *      `FunctionCallResultItem.{callId,output}` / `ReasoningItem.{id,content,providerData}`;
 *      the `StreamEvent` union: `output_text_delta` {delta}, `response_started`,
 *      `response_done` {response}, and the generic `model` carrier {type:"model", event})
 *   - openai/openai-node responses event types (the `model` carrier's `event`):
 *     `response.output_text.delta` (`item_id`/`delta`/`output_index`/`content_index`/`sequence_number`),
 *     `response.function_call_arguments.delta` (`item_id`/`delta`),
 *     `response.function_call_arguments.done` (`arguments`/`item_id`),
 *     `response.completed`/`response.incomplete` (`response.incomplete_details.reason`),
 *     and the reasoning item `rs_…` + `encrypted_content` stateless-replay payload
 *     (the `reasoning.encrypted_content` include; rides `ReasoningItem.providerData`).
 *
 * `@openai/agents` is declared an OPTIONAL peerDependency (for when its native
 * types are wanted) but is NOT imported — this package is fixture-only and the
 * SDK is not installed.
 */
import {
  type AgEvent,
  type AgBlock,
  type AgFinishReason,
  JsonValue,
  type Normalizer,
  type ToolOutcome,
} from "@silverprotocol/core";

import { ruleJsonata } from "./rule.js";

/** The portable pure-structural JSONata subset (message text + tool.start/args.delta).
 *  Re-exported for cross-runtime reuse; the parsed `tool.args.assembled`, the
 *  arg-accumulation, the `rs_` reasoning replay, `tool_output`, and `turn.done`
 *  live in {@link openaiNormalizer}, authoritative for the live path. The canonical
 *  source of this string is the sibling `rule.jsonata` artifact. */
export { ruleJsonata };

// ─────────────────────────────────────────────────────────────────────────────
// OpenAIStreamEvent — the HAND-DEFINED fixture contract (verified shapes above).
// A minimal faithful projection of the @openai/agents `RunStreamEvent` union +
// the underlying OpenAI Responses streaming events the runtime would emit.
// ─────────────────────────────────────────────────────────────────────────────

/** Assistant message content part (protocol `OutputText`). */
export interface OpenAIOutputText {
  type: "output_text";
  text: string;
}

/** protocol `AssistantMessageItem` (the `rawItem` of a message_output_item). */
export interface OpenAIAssistantMessageItem {
  type?: "message";
  role: "assistant";
  status: "in_progress" | "completed" | "incomplete";
  content: OpenAIOutputText[];
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

/** protocol `FunctionCallItem` (the `rawItem` of a tool_call_item). `callId` is
 *  the model's call_id; `id` is the Responses `fc_…` item id (DISTINCT). */
export interface OpenAIFunctionCallItem {
  type: "function_call";
  callId: string;
  name: string;
  arguments: string; // a JSON STRING — MUST be JSON.parse'd for tool.args.assembled
  status?: "in_progress" | "completed" | "incomplete";
  id?: string; // fc_… Responses item id
  providerData?: { [k: string]: JsonValue };
}

/** protocol `ToolOutputText` arm of `FunctionCallResultItem.output`. */
export interface OpenAIToolOutputText {
  type: "text";
  text: string;
}

/** protocol `FunctionCallResultItem` (the `rawItem` of a tool_call_output_item).
 *  `output` is a string OR a content object/array; the wrapper's own `output`
 *  field carries the stringified primary output. */
export interface OpenAIFunctionCallResultItem {
  type: "function_call_result";
  name: string;
  callId: string;
  status: "in_progress" | "completed" | "incomplete";
  output: string | OpenAIToolOutputText | OpenAIToolOutputText[];
  providerData?: { [k: string]: JsonValue };
}

/** protocol `InputText` (the visible reasoning content part). */
export interface OpenAIReasoningTextPart {
  type: "input_text";
  text: string;
}

/** protocol `ReasoningItem` (the `rawItem` of a reasoning_item). The `rs_…` id +
 *  the `encrypted_content` (under `providerData`, the Responses stateless-replay
 *  payload) are replay-load-bearing (spec §8.2/§10.4). */
export interface OpenAIReasoningItem {
  type: "reasoning";
  id?: string; // rs_… Responses reasoning item id
  content: OpenAIReasoningTextPart[];
  providerData?: { encrypted_content?: string; [k: string]: JsonValue | undefined };
}

// ── run_item_stream_event arms (one per consumed RunItemStreamEventName) ──────
interface OpenAIMessageOutputEvent {
  type: "run_item_stream_event";
  name: "message_output_created";
  item: { type: "message_output_item"; rawItem: OpenAIAssistantMessageItem };
}
interface OpenAIToolCalledEvent {
  type: "run_item_stream_event";
  name: "tool_called";
  item: { type: "tool_call_item"; rawItem: OpenAIFunctionCallItem };
}
interface OpenAIToolOutputEvent {
  type: "run_item_stream_event";
  name: "tool_output";
  // The normalizer reads `item.rawItem.output` (the protocol FunctionCallResultItem);
  // the wrapper's own `output` field is unused and intentionally not modelled.
  item: { type: "tool_call_output_item"; rawItem: OpenAIFunctionCallResultItem };
}
interface OpenAIReasoningEvent {
  type: "run_item_stream_event";
  name: "reasoning_item_created";
  item: { type: "reasoning_item"; rawItem: OpenAIReasoningItem };
}

// ── raw_model_stream_event arm ───────────────────────────────────────────────
// `RunRawModelStreamEvent.data` is the Agents SDK's own `ResponseStreamEvent`
// union (`@openai/agents` protocol `StreamEvent`): the literals below + the
// generic `model` carrier. The verbatim openai-node Responses events ride INSIDE
// the carrier's `event` field, using snake_case.

/** openai-node `ResponseFunctionCallArgumentsDeltaEvent` — the per-fragment
 *  argument delta (snake_case `item_id`/`delta`). */
interface OpenAIResponsesFnArgsDelta {
  type: "response.function_call_arguments.delta";
  item_id: string; // the fc_… Responses item id (buffer key + tool-call itemId)
  delta: string;
}
/** openai-node `ResponseFunctionCallArgumentsDoneEvent` — the sealed full
 *  arguments JSON string (snake_case `arguments`/`item_id`). */
interface OpenAIResponsesFnArgsDone {
  type: "response.function_call_arguments.done";
  item_id: string; // the fc_… Responses item id
  arguments: string;
}
/** openai-node `ResponseTextDeltaEvent` — a streamed assistant-text fragment
 *  (snake_case `item_id`/`delta`). Carried via the `model` carrier. */
interface OpenAIResponsesTextDelta {
  type: "response.output_text.delta";
  item_id: string;
  delta: string;
}
/** openai-node `ResponseCompletedEvent`/incomplete — `response.incomplete_details`
 *  is snake_case. Carried via the `model` carrier. */
interface OpenAIResponsesCompleted {
  type: "response.completed" | "response.incomplete";
  response: {
    id: string;
    status: "completed" | "incomplete";
    incomplete_details?: { reason?: string };
  };
}

/** The faithful projection of the openai-node `ResponseStreamEvent` events the
 *  normalizer consumes (the carrier `event` payload). */
type OpenAIRawResponsesEvent =
  | OpenAIResponsesFnArgsDelta
  | OpenAIResponsesFnArgsDone
  | OpenAIResponsesTextDelta
  | OpenAIResponsesCompleted;

// ── the Agents SDK `StreamEvent` union (RunRawModelStreamEvent.data) ──────────
/** `StreamEventTextStream` — `{ type:"output_text_delta"; delta }`. */
interface OpenAIStreamEventTextDelta {
  type: "output_text_delta";
  delta: string;
}
/** `StreamEventResponseStarted` — `{ type:"response_started" }`. */
interface OpenAIStreamEventResponseStarted {
  type: "response_started";
}
/** `StreamEventResponseCompleted` — `{ type:"response_done"; response? }`. */
interface OpenAIStreamEventResponseDone {
  type: "response_done";
  response?: { id: string };
}
/** `StreamEventGenericItem` — the generic `model` carrier. The verbatim
 *  openai-node Responses event rides in `event`. */
interface OpenAIStreamEventModel {
  type: "model";
  event: OpenAIRawResponsesEvent;
}
/** The SDK `ResponseStreamEvent`/`StreamEvent` union (`RunRawModelStreamEvent.data`). */
type OpenAIResponseStreamEvent =
  | OpenAIStreamEventTextDelta
  | OpenAIStreamEventResponseStarted
  | OpenAIStreamEventResponseDone
  | OpenAIStreamEventModel;

interface OpenAIRawModelStreamEvent {
  type: "raw_model_stream_event";
  data: OpenAIResponseStreamEvent;
}

/** The fixture-contract input union (verified shapes; see file header). */
export type OpenAIStreamEvent =
  | OpenAIMessageOutputEvent
  | OpenAIToolCalledEvent
  | OpenAIToolOutputEvent
  | OpenAIReasoningEvent
  | OpenAIRawModelStreamEvent;

// ─── seq allocator ────────────────────────────────────────────────────────────
// Monotonic per call, from 0. A tiny closure keeps the emit sites declarative.
function makeEmitter() {
  let seq = 0;
  const events: AgEvent[] = [];
  return {
    push(ev: AgEvent): void {
      events.push(ev);
    },
    next(): number {
      return seq++;
    },
    events,
  };
}

// ─── finish-reason → AgFinishReason (spec §4) ─────────────────────────────────
// Maps any OpenAI completion / `response.incomplete_details.reason` to the
// neutral AgFinishReason superset. A bare `response.completed` (no reason) = stop.
export function mapFinishReason(reason: string | undefined | null): AgFinishReason {
  switch (reason) {
    case undefined:
    case null:
    case "stop":
    case "completed":
      return "stop";
    case "max_output_tokens":
    case "max_tokens":
      return "token_limit";
    case "content_filter":
      return "safety_blocked";
    default:
      return "unknown";
  }
}

// ─── stateful arg buffer (spec §8.1) ──────────────────────────────────────────
// `response.function_call_arguments.delta` fragments accumulate per Responses
// item id; `.done` (or a wrapped `tool_called`) seals them into the mandatory
// `tool.args.assembled`. The buffer survives ACROSS normalizer calls — the SDK
// emits each fragment as its own stream event.
const argBuffers = new Map<string, string>();

// ─── fc_ → call_id correlation (spec §2) ──────────────────────────────────────
// AgJSON `toolCallId` = the model `call_id`; the raw Responses events carry only
// the `fc_…` item id, NOT the `call_id`. The `tool_called` run-item carries BOTH
// (`callId` + `id`=`fc_…`), so we buffer the mapping there and look it up on the
// raw `.done` path. Survives ACROSS normalizer calls (separate stream events).
const callIdByItemId = new Map<string, string>();

// ─── tool-output content → AgBlock[] (spec §2) ────────────────────────────────
function toolOutputToAgBlocks(
  output: OpenAIFunctionCallResultItem["output"],
): AgBlock[] {
  if (typeof output === "string") {
    return output.length > 0 ? [{ type: "text", text: output }] : [];
  }
  const parts = Array.isArray(output) ? output : [output];
  const out: AgBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") out.push({ type: "text", text: part.text });
  }
  return out;
}

// ─── the normalizer ───────────────────────────────────────────────────────────
const openaiNormalizer: Normalizer<OpenAIStreamEvent> = (event) => {
  const e = makeEmitter();

  if (event.type === "run_item_stream_event") {
    switch (event.name) {
      case "message_output_created": {
        const item = event.item.rawItem;
        const id = item.id ?? "msg";
        // Concatenate all output_text parts into the visible text (the run-item
        // wrapper is the COMPLETE message; deltas ride the raw Responses stream).
        const text = item.content
          .filter((p) => p.type === "output_text")
          .map((p) => p.text)
          .join("");
        e.push({ type: "text.start", seq: e.next(), id });
        e.push({ type: "text.delta", seq: e.next(), id, delta: text });
        e.push({ type: "text.end", seq: e.next(), id });
        return e.events;
      }
      case "tool_called": {
        const item = event.item.rawItem;
        // `arguments` is a JSON STRING (spec §4) — parse at this genuine
        // deserialization boundary into JsonValue (no cast). call_id → toolCallId;
        // the fc_ item id → itemId (DISTINCT, replay-load-bearing, spec §8).
        const input: JsonValue = JsonValue.parse(JSON.parse(item.arguments));
        e.push({
          type: "tool.start",
          seq: e.next(),
          toolCallId: item.callId,
          name: item.name,
          itemId: item.id,
        });
        e.push({
          type: "tool.args.delta",
          seq: e.next(),
          toolCallId: item.callId,
          delta: item.arguments,
        });
        e.push({
          type: "tool.args.assembled",
          seq: e.next(),
          toolCallId: item.callId,
          input,
        });
        // The run-item path is AUTHORITATIVE for the call_id↔fc_ correlation: the
        // fc_ itemId is already carried on `tool.start.itemId` above (its spec home;
        // `tool.args.assembled` has no itemId slot). Record call_id keyed by fc_ id
        // so the raw `.done` path (which lacks call_id) can recover the real
        // toolCallId. The assembled wrapper also supersedes any scratch buffer.
        if (item.id !== undefined) {
          callIdByItemId.set(item.id, item.callId);
          argBuffers.delete(item.id);
        }
        return e.events;
      }
      case "tool_output": {
        const item = event.item.rawItem;
        const outcome: ToolOutcome = "ok";
        e.push({
          type: "tool.done",
          seq: e.next(),
          toolCallId: item.callId,
          content: toolOutputToAgBlocks(item.output),
          outcome,
        });
        return e.events;
      }
      case "reasoning_item_created": {
        const item = event.item.rawItem;
        const id = item.id ?? "reasoning";
        const itemId = item.id;
        // Visible reasoning text (the input_text parts).
        const text = item.content.map((p) => p.text).join("");
        e.push({ type: "reasoning.start", seq: e.next(), id, itemId });
        if (text.length > 0) {
          e.push({ type: "reasoning.delta", seq: e.next(), id, delta: text });
        }
        e.push({ type: "reasoning.end", seq: e.next(), id });
        // The rs_ id + encrypted_content are the stateless-replay payload
        // (spec §8.2/§10.4): reasoning.opaque kind:"ciphertext", echoed verbatim
        // or multi-turn reasoning 400s.
        const encrypted = item.providerData?.encrypted_content;
        if (typeof encrypted === "string" && encrypted.length > 0) {
          e.push({
            type: "reasoning.opaque",
            seq: e.next(),
            id,
            kind: "ciphertext",
            value: encrypted,
            itemId,
            provider: "openai",
          });
        }
        return e.events;
      }
      default: {
        // Other RunItemStreamEventName values (handoff_*, tool_search_*,
        // tool_approval_requested) carry no events on this fixture seam.
        return e.events;
      }
    }
  }

  // raw_model_stream_event — `data` is the Agents SDK `ResponseStreamEvent`
  // (`StreamEvent`) union: the SDK literals + the generic `model` carrier whose
  // `event` is the verbatim openai-node Responses event (snake_case fields).
  const data = event.data;
  switch (data.type) {
    case "output_text_delta": {
      // SDK-flattened streamed assistant text. No item id on the carrier literal,
      // so attach to the open message generically (spec §4 binds to last message).
      e.push({ type: "text.delta", seq: e.next(), id: "msg", delta: data.delta });
      return e.events;
    }
    case "response_started": {
      // Turn opener — no AgJSON event on this fixture seam (the run-item /
      // response_done legs carry the load-bearing lifecycle).
      return e.events;
    }
    case "response_done": {
      // SDK turn terminator. Mirror response.completed → turn.done (stop).
      e.push({
        type: "turn.done",
        seq: e.next(),
        turnId: `turn_${data.response?.id ?? "openai"}`,
        outcome: { type: "success" },
        finishReason: mapFinishReason(undefined),
      });
      return e.events;
    }
    case "model": {
      // The verbatim openai-node Responses event rides in `event` (snake_case).
      return handleRawResponsesEvent(data.event, e);
    }
    default:
      return e.events;
  }
};

// ─── embedded openai-node Responses events (the `model` carrier payload) ──────
// Real snake_case fields (`item_id`, `arguments`, `delta`, `incomplete_details`).
function handleRawResponsesEvent(
  ev: OpenAIRawResponsesEvent,
  e: ReturnType<typeof makeEmitter>,
): AgEvent[] {
  switch (ev.type) {
    case "response.output_text.delta": {
      e.push({ type: "text.delta", seq: e.next(), id: ev.item_id, delta: ev.delta });
      return e.events;
    }
    case "response.function_call_arguments.delta": {
      // Accumulate the fragment per Responses fc_ item id (spec §8.1); no emit yet.
      const prev = argBuffers.get(ev.item_id) ?? "";
      argBuffers.set(ev.item_id, prev + ev.delta);
      return e.events;
    }
    case "response.function_call_arguments.done": {
      // Seal the accumulated buffer into the mandatory tool.args.assembled. Prefer
      // the event's full `arguments`; fall back to the accumulated buffer.
      const buffered = argBuffers.get(ev.item_id) ?? "";
      const raw = ev.arguments.length > 0 ? ev.arguments : buffered;
      const input: JsonValue = JsonValue.parse(JSON.parse(raw));
      // toolCallId = the model call_id (spec §2), recovered via the fc_-keyed map
      // populated by the run-item `tool_called` leg (the AUTHORITATIVE call_id↔fc_
      // correlation). If no run-item correlated this fc_ id yet, fall back to the
      // fc_ id as toolCallId — the run-item path remains authoritative and will
      // carry the real call_id (and the fc_ itemId on tool.start) when it fires.
      const toolCallId = callIdByItemId.get(ev.item_id) ?? ev.item_id;
      e.push({
        type: "tool.args.assembled",
        seq: e.next(),
        toolCallId,
        input,
      });
      argBuffers.delete(ev.item_id);
      return e.events;
    }
    case "response.completed":
    case "response.incomplete": {
      e.push({
        type: "turn.done",
        seq: e.next(),
        turnId: `turn_${ev.response.id}`,
        outcome: { type: "success" },
        finishReason: mapFinishReason(ev.response.incomplete_details?.reason),
      });
      return e.events;
    }
    default:
      return e.events;
  }
}

export default openaiNormalizer;
export { openaiNormalizer };
