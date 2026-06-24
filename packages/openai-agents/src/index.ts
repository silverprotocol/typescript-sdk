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
 * The sole entry point is the STATEFUL {@link createOpenaiNormalizer} factory:
 * one fresh `StreamAssembler` per factory call holds the per-invoke closure state
 * (turn anchoring, fc_→call_id correlation, arg buffers, refusal flag) and drives
 * the engine from the SINGLE authoritative source per concern (BINDING canonical
 * model, plan §"Spike Findings"). `seq` is allocated monotonically from 0 by the
 * engine; the Router rebases to a global ordinal downstream (out of scope here).
 * (The earlier per-call stateless `RuleNormalizer`/JSONata path was deleted in
 * A1 T5c — pre-launch no-backcompat.)
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
  type AgUsage,
  type AgSafety,
  type AgCitation,
  JsonValue,
  type Normalizer,
  type NormalizerContext,
  StreamAssembler,
  type ToolOutcome,
} from "@silverprotocol/core";

// ─────────────────────────────────────────────────────────────────────────────
// OpenAIStreamEvent — the HAND-DEFINED fixture contract (verified shapes above).
// A minimal faithful projection of the @openai/agents `RunStreamEvent` union +
// the underlying OpenAI Responses streaming events the runtime would emit.
// ─────────────────────────────────────────────────────────────────────────────

/** Assistant message content part (protocol `OutputText`). */
export interface OpenAIOutputText {
  type: "output_text";
  text: string;
  /** url_citation and file_citation annotations on the text part. */
  annotations?: OpenAIAnnotation[];
}

/** url_citation annotation on an output_text part (openai-node `ResponseCitationAnnotation`). */
export interface OpenAIUrlCitationAnnotation {
  type: "url_citation";
  url: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

/** file_citation annotation on an output_text part. */
export interface OpenAIFileCitationAnnotation {
  type: "file_citation";
  file_id?: string;
  filename?: string;
  index?: number;
}

/** The subset of annotations that the normalizer handles. */
export type OpenAIAnnotation = OpenAIUrlCitationAnnotation | OpenAIFileCitationAnnotation;

/** `Refusal` content part — the model refused to answer (openai-node `ResponseOutputRefusal`). */
export interface OpenAIRefusal {
  type: "refusal";
  refusal: string;
}

/** Union of assistant message content parts the normalizer handles. */
export type OpenAIContentPart = OpenAIOutputText | OpenAIRefusal;

/** protocol `AssistantMessageItem` (the `rawItem` of a message_output_item). */
export interface OpenAIAssistantMessageItem {
  type?: "message";
  role: "assistant";
  status: "in_progress" | "completed" | "incomplete";
  content: OpenAIContentPart[];
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
  // `item.rawItem` carries the protocol FunctionCallResultItem (callId, output, status).
  // `item.output` (the wrapper-level field) may carry a structured object with a
  // `structuredContent` key — the ggui cache marker (e.g. `{ cache: { hit: true } }`)
  // rides here. Cast-free extraction uses `isJsonObject` + `JsonValue.parse`.
  item: {
    type: "tool_call_output_item";
    rawItem: OpenAIFunctionCallResultItem;
    output?: JsonValue;
  };
}
interface OpenAIReasoningEvent {
  type: "run_item_stream_event";
  name: "reasoning_item_created";
  item: { type: "reasoning_item"; rawItem: OpenAIReasoningItem };
}

/** A handoff call item (RunHandoffCallItem) — the target agent name rides in
 *  the rawItem (FunctionCallItem-shaped) as `targetAgent` or can be inferred
 *  from the function name by convention. */
interface OpenAIHandoffCallItem {
  type: "function_call";
  name: string;
  callId: string;
  arguments: string;
  /** The target agent name, when the SDK surfaces it explicitly. */
  targetAgent?: string;
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

interface OpenAIHandoffRequestedEvent {
  type: "run_item_stream_event";
  name: "handoff_requested";
  item: { type: "handoff_call_item"; rawItem: OpenAIHandoffCallItem };
}

/** A tool approval request item (RunToolApprovalItem) — the function call that
 *  needs human approval rides in rawItem. */
interface OpenAIToolApprovalItem {
  type: "function_call";
  name: string;
  callId: string;
  arguments: string;
  id?: string;
}

interface OpenAIToolApprovalRequestedEvent {
  type: "run_item_stream_event";
  name: "tool_approval_requested";
  item: { type: "tool_approval_item"; rawItem: OpenAIToolApprovalItem };
}

// ── raw_model_stream_event arm ───────────────────────────────────────────────
// `RunRawModelStreamEvent.data` is the Agents SDK's own `ResponseStreamEvent`
// union (`@openai/agents` protocol `StreamEvent`): the literals below + the
// generic `model` carrier. The verbatim openai-node Responses events ride INSIDE
// the carrier's `event` field, using snake_case.

/** openai-node `ResponseCreatedEvent` — the turn-open boundary. The real
 *  `response.id` is present here at the START of the stream (spike-confirmed),
 *  so it is the authoritative turn-anchor source (A1 canonical model). Carried via
 *  the `model` carrier. */
interface OpenAIResponsesCreated {
  type: "response.created";
  response: { id: string };
}
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
/** openai-node `ResponseTextDoneEvent` — the assistant-text stream for `item_id`
 *  is complete (`text` carries the full assembled string). Carried via the `model`
 *  carrier. Authoritative `text.end` source per the canonical event model (A1). */
interface OpenAIResponsesTextDone {
  type: "response.output_text.done";
  item_id: string;
  text?: string;
}
/** openai-node `ResponseUsage` — per-response token counts (snake_case). */
interface OpenAIResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

/** openai-node `ResponseCompletedEvent`/incomplete — `response.incomplete_details`
 *  is snake_case. Carried via the `model` carrier. */
interface OpenAIResponsesCompleted {
  type: "response.completed" | "response.incomplete";
  response: {
    id: string;
    status: "completed" | "incomplete";
    incomplete_details?: { reason?: string };
    usage?: OpenAIResponseUsage;
  };
}

/** openai-node `ResponseOutputItemAddedEvent` — fired when a new output item starts.
 *  When `item.type === "function_call"`, this is the AUTHORITATIVE tool-start source
 *  (canonical model, A1). Note: the raw Responses event uses snake_case `call_id`
 *  (DISTINCT from the run-item's camelCase `callId`). Carried via the `model` carrier. */
interface OpenAIResponsesOutputItemAdded {
  type: "response.output_item.added";
  item: {
    id: string; // the fc_… Responses item id
    type: string; // "function_call" | "message" | "reasoning" | …
    call_id?: string; // snake_case — only present when type==="function_call"
    name?: string; // tool name — only present when type==="function_call"
    status?: string;
    arguments?: string;
  };
}

/** openai-node `ResponseFailedEvent` — the response itself failed (e.g. rate limit).
 *  Carried via the `model` carrier. */
interface OpenAIResponsesFailed {
  type: "response.failed";
  response: {
    id: string;
    error?: { message?: string; code?: string };
  };
}

/** A top-level streaming error event (non-terminal advisory, spec §4). */
interface OpenAIResponsesError {
  type: "error";
  message: string;
  code?: string;
}

/** The faithful projection of the openai-node `ResponseStreamEvent` events the
 *  normalizer consumes (the carrier `event` payload). */
type OpenAIRawResponsesEvent =
  | OpenAIResponsesCreated
  | OpenAIResponsesOutputItemAdded
  | OpenAIResponsesFnArgsDelta
  | OpenAIResponsesFnArgsDone
  | OpenAIResponsesTextDelta
  | OpenAIResponsesTextDone
  | OpenAIResponsesCompleted
  | OpenAIResponsesFailed
  | OpenAIResponsesError;

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
  response?: { id: string; usage?: OpenAIResponseUsage };
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

/** A SYNTHETIC terminal sentinel the host feeds the normalizer when the
 *  `@openai/agents` runtime THROWS `MaxTurnsExceededError` from
 *  `await stream.completed` after the stream ends (the spike confirmed
 *  `max_turns` is NOT a native stream event). The host (T6) catches the throw
 *  and injects this; the normalizer maps it to `turn.error{code:"max_turns",…}`.
 *  Modeled as a real arm of the native union (NOT cast) so the guard + drive
 *  switch handle it type-safely. `usage` mirrors the neutral `AgUsage` shape. */
export interface OpenAIHostError {
  type: "__host_error__";
  code: string;
  message: string;
  usage?: AgUsage;
}

/** The fixture-contract input union (verified shapes; see file header). */
export type OpenAIStreamEvent =
  | OpenAIMessageOutputEvent
  | OpenAIToolCalledEvent
  | OpenAIToolOutputEvent
  | OpenAIReasoningEvent
  | OpenAIHandoffRequestedEvent
  | OpenAIToolApprovalRequestedEvent
  | OpenAIRawModelStreamEvent
  | OpenAIHostError;

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

// ─── usage mapping: OpenAI response usage → AgUsage ──────────────────────────
// cumulative:false — OpenAI usage is FINAL (not cumulative like Anthropic).
function mapUsage(usage: OpenAIResponseUsage | undefined): AgUsage | undefined {
  if (usage === undefined) return undefined;
  const u: AgUsage = { cumulative: false };
  if (usage.input_tokens !== undefined) u.inputTokens = usage.input_tokens;
  if (usage.output_tokens !== undefined) u.outputTokens = usage.output_tokens;
  if (usage.total_tokens !== undefined) u.totalTokens = usage.total_tokens;
  if (usage.input_tokens_details?.cached_tokens !== undefined)
    u.cacheReadTokens = usage.input_tokens_details.cached_tokens;
  if (usage.output_tokens_details?.reasoning_tokens !== undefined)
    u.reasoningTokens = usage.output_tokens_details.reasoning_tokens;
  return u;
}

// ─── url_citation annotation → AgCitation ──────────────────────────────────
// `partText` is the source output_text part's text string; used to extract the
// cited substring from the char-offset indices carried by the annotation (Fix 3).
function mapAnnotationsToCitations(
  annotations: OpenAIAnnotation[] | undefined,
  partText: string,
): AgCitation[] | undefined {
  if (annotations === undefined || annotations.length === 0) return undefined;
  const out: AgCitation[] = [];
  for (const ann of annotations) {
    if (ann.type === "url_citation") {
      // Extract the cited substring from the part text when both offsets are present
      // and valid (Fix 3). Fall back to "" when any guard condition fails.
      const startIdx = ann.start_index;
      const endIdx = ann.end_index;
      const citedText =
        startIdx !== undefined && endIdx !== undefined && startIdx >= 0 && endIdx <= partText.length
          ? partText.slice(startIdx, endIdx)
          : "";
      const cit: AgCitation = {
        kind: "url",
        url: ann.url,
        citedText,
        indexFrame: "response",
      };
      if (ann.title !== undefined) cit.title = ann.title;
      if (startIdx !== undefined) cit.startIndex = startIdx;
      if (endIdx !== undefined) cit.endIndex = endIdx;
      out.push(cit);
    }
    // file_citation: no url-kind match; skip (deferred to a later slice — only remaining silent annotation drop)
  }
  return out.length > 0 ? out : undefined;
}

// ─── structural guard: unknown → OpenAIStreamEvent ────────────────────────────
// `createOpenaiNormalizer().push` receives the genuine JSON boundary (`JsonValue`,
// spec §0.1). The run-seam yields well-formed `OpenAIStreamEvent`s, but this is the
// deserialization boundary, so we confirm the OUTER discriminant before driving the
// engine. A user-defined type guard (not a cast) narrows on success; a failure routes
// the raw payload to `ext.openai.unparsed` and returns (graceful, Tenet 6).
//
// The guard takes `unknown` (not `JsonValue`): `OpenAIStreamEvent`'s nested
// interfaces have no index signature, so a `v is OpenAIStreamEvent` predicate over a
// `JsonValue` param is rejected by TS (TS2677). `unknown` is the genuine boundary
// input type and is predicate-compatible; the caller passes a `JsonValue`, which
// widens to `unknown` losslessly (mirrors the Claude facet's `isSDKMessage`).
function isJsonObject(v: unknown): v is { readonly [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Only the OUTER envelope is validated here (the RunStreamEvent families: a
// `run_item_stream_event` with a string `name`, a `raw_model_stream_event` with a
// `data` object, or the synthetic `__host_error__` terminal sentinel the host feeds
// on `MaxTurnsExceededError`). The inner `drive` switch handles every nested arm
// structurally and no-ops anything it does not recognise — so a partially-shaped-but-
// well-typed event is never lost, and only a genuinely non-OpenAI-shaped payload
// falls to `unparsed`.
function isOpenAIStreamEvent(v: unknown): v is OpenAIStreamEvent {
  if (!isJsonObject(v)) return false;
  if (v.type === "run_item_stream_event") return typeof v.name === "string";
  if (v.type === "raw_model_stream_event") return isJsonObject(v.data);
  if (v.type === "__host_error__")
    return typeof v.code === "string" && typeof v.message === "string";
  return false;
}

// ─── the stateful normalizer (A1 §5-6) ────────────────────────────────────────
/**
 * Build a stateful OpenAI-facet normalizer over a fresh {@link StreamAssembler}.
 *
 * OpenAI has no native `turn.start` and the assistant turn is delivered as a
 * stream of redundant representations (the SDK emits `response_started`, a
 * `model:response.created`, an in-progress duplicate, BOTH a flattened
 * `output_text_delta` literal and the real item-id-keyed
 * `model:response.output_text.delta`, a `response_done` literal, and TWO
 * `model:response.completed` events per response). The normalizer drives the
 * engine from the SINGLE authoritative source per concern (BINDING canonical
 * model, plan §"Spike Findings") and ignores the rest:
 *
 *  - turn open  ← `model:response.created` (real `response.id` present at start)
 *  - text       ← `model:response.output_text.delta` (carries `item_id`)
 *  - text end   ← `model:response.output_text.done`
 *  - turn close ← `model:response.completed` (guard close-once)
 *
 * `ensureResponseOpen()` opens turn + message exactly once per response;
 * `closeResponse()` resets per-response state so the duplicate `response.completed`
 * is a no-op.
 *
 * NOTE (T5a scope): tools, refusal, incomplete/failed error arms, citations,
 * reasoning, handoff and HITL are NOT yet ported — they are KNOWN families and are
 * no-op'd here (NOT routed to `unparsed`). T5b/T5c port them. `emitExt` is reserved
 * for a genuinely unrecognisable OUTER envelope only (mirrors the Claude facet).
 */
export function createOpenaiNormalizer(ctx?: NormalizerContext): Normalizer {
  const a = new StreamAssembler(ctx);
  // OpenAI's native stream carries no thread/session id (unlike Claude's
  // `session_id`), and `NormalizerContext` exposes only reconnect `seed` — so the
  // threadId is the fixed facet label. The Router rebases ids downstream.
  const threadId = "openai";

  // Per-response anchoring state (one open response at a time on this seam).
  let turnCounter = 0;
  let turnId: string | undefined; // current open response's turn id
  let msgId: string | undefined; // current open message id
  let responseId: string | undefined; // real response.id once known
  // Open text streams keyed by Responses item_id (textStart once per id).
  const openTextStreams = new Set<string>();
  // Close-once guard: the SDK emits `response.completed` TWICE per response. Once a
  // response.id (or a synthesized turnId) has been closed, any further terminal event
  // for it is a no-op — it must NOT reopen a fresh message/turn.
  const closedResponses = new Set<string>();

  // Per-instance tool state (T5b — replaces the module-level statics for the factory path).
  // fc_… item id → model call_id correlation, populated by response.output_item.added
  // (the AUTHORITATIVE tool-start source per the canonical model, A1).
  const instanceCallIdByItemId = new Map<string, string>();
  // Accumulated function_call_arguments.delta fragments, keyed by fc_ item id.
  // The engine accumulates for downstream use; `.done.arguments` carries the full
  // string so argBuffers is primarily for the fallback path.
  const instanceArgBuffers = new Map<string, string>();

  // Refusal tracking (T5c — instance state mirroring the old module-level
  // `pendingRefusal`). Set when a `message_output_created` run-item carries a
  // `refusal` content part; the downstream `response.completed` arm then closes
  // the turn with `finishReason:"refusal"`. Cleared on every response close so it
  // never leaks across turns.
  let pendingRefusal = false;

  /**
   * Open the turn + message exactly once per response. Uses the real `response.id`
   * (`turn_<id>`) when known; synthesizes a stable id only if `response.created` was
   * somehow absent (defensive — the spike confirms the id is always present at start).
   * Returns the close-once key (the real response.id, else the synthesized turnId),
   * or `undefined` when the response has already been closed (caller must no-op).
   */
  function ensureResponseOpen(respId?: string): string | undefined {
    // Already closed → never reopen (the duplicate `response.completed` lands here).
    if (respId !== undefined && closedResponses.has(respId)) return undefined;
    if (turnId !== undefined) {
      // Backfill the real id if it arrives after a defensive synthesized open.
      if (respId !== undefined && responseId === undefined) responseId = respId;
      return responseId ?? turnId;
    }
    responseId = respId;
    turnId = respId !== undefined ? `turn_${respId}` : `turn_${threadId}_${++turnCounter}`;
    msgId = `msg_${turnId}`;
    a.openTurn(turnId, threadId);
    a.openMessage({ id: msgId, role: "assistant", turnId, threadId });
    return responseId ?? turnId;
  }

  /** Reset per-response state after a close. Marks the response closed (close-once). */
  function resetResponseState(): void {
    const key = responseId ?? turnId;
    if (key !== undefined) closedResponses.add(key);
    openTextStreams.clear();
    turnId = undefined;
    msgId = undefined;
    responseId = undefined;
    pendingRefusal = false;
  }

  /**
   * Close any dangling open message/turn (flush path: a stream ended before
   * `response.completed`). Ends open text streams, closes the message, and reuses
   * `resetResponseState` so the response is marked closed.
   */
  function closeResponse(): void {
    if (msgId !== undefined) {
      for (const streamId of openTextStreams) a.textEnd(streamId, msgId);
      a.closeMessage(msgId);
    }
    resetResponseState();
  }

  /** Drive the engine from one verbatim openai-node Responses event (snake_case). */
  function driveRawResponsesEvent(ev: OpenAIRawResponsesEvent): void {
    switch (ev.type) {
      case "response.created": {
        // Authoritative turn open — the real response.id is present at start.
        ensureResponseOpen(ev.response.id);
        return;
      }
      case "response.output_text.delta": {
        ensureResponseOpen();
        if (msgId === undefined) return; // unreachable post-ensure; satisfies the narrowing
        if (!openTextStreams.has(ev.item_id)) {
          openTextStreams.add(ev.item_id);
          a.textStart(ev.item_id, msgId, { role: "assistant" });
        }
        // OpenAI text deltas are suffix-only fragments (cumulative:false, the default).
        a.textDelta(ev.item_id, msgId, ev.delta, { cumulative: false });
        return;
      }
      case "response.output_text.done": {
        // Authoritative text-end for this item_id (canonical model).
        if (msgId !== undefined && openTextStreams.has(ev.item_id)) {
          openTextStreams.delete(ev.item_id);
          a.textEnd(ev.item_id, msgId);
        }
        return;
      }
      case "response.output_item.added": {
        // Authoritative tool-start source (canonical model, A1 §"Spike Findings").
        // Only function_call items carry a tool name + call_id; other item types
        // (message, reasoning) are no-op'd here — their lifecycle is handled elsewhere.
        if (ev.item.type === "function_call" && ev.item.call_id !== undefined && ev.item.name !== undefined) {
          const fcId = ev.item.id;
          const callId = ev.item.call_id;
          ensureResponseOpen();
          // Record the fc_→call_id correlation (the raw argument events carry only
          // the fc_ item id, not the call_id; this mapping allows recovery).
          instanceCallIdByItemId.set(fcId, callId);
          a.toolStart({
            toolCallId: callId,
            name: ev.item.name,
            itemId: fcId,
            messageId: msgId,
          });
        }
        return;
      }
      case "response.function_call_arguments.delta": {
        // Accumulate the fragment per fc_ item id (spec §8.1).
        const prevDelta = instanceArgBuffers.get(ev.item_id) ?? "";
        instanceArgBuffers.set(ev.item_id, prevDelta + ev.delta);
        // Resolve to call_id for the engine (fall back to fc_ id defensively).
        const callIdDelta = instanceCallIdByItemId.get(ev.item_id) ?? ev.item_id;
        a.toolArgsDelta(callIdDelta, ev.delta, { cumulative: false });
        return;
      }
      case "response.function_call_arguments.done": {
        // Seal accumulated buffer → toolArgsAssembled. Prefer the event's full
        // `arguments` string (the engine accumulates the delta path); fall back to
        // the instance buffer when the done event omits it (defensive).
        const buffered = instanceArgBuffers.get(ev.item_id) ?? "";
        const raw = ev.arguments.length > 0 ? ev.arguments : buffered;
        const input: JsonValue = JsonValue.parse(JSON.parse(raw));
        const callIdDone = instanceCallIdByItemId.get(ev.item_id) ?? ev.item_id;
        a.toolArgsAssembled(callIdDone, input);
        instanceArgBuffers.delete(ev.item_id);
        return;
      }
      case "response.completed":
      case "response.incomplete": {
        // Terminal close — guard close-once (the SDK emits completed TWICE). A
        // `undefined` return means this response is already closed → no-op the dupe.
        if (ensureResponseOpen(ev.response.id) === undefined) return;
        if (turnId === undefined) return; // unreachable post-ensure; satisfies narrowing
        endOpenStreamsAndCloseMessage();
        const reason = ev.response.incomplete_details?.reason;
        const usage = mapUsage(ev.response.usage);
        // Decision tree (mirrors the canonical model, A1):
        //   refusal recorded         → closeTurnDone success, finishReason:"refusal"
        //   content_filter           → closeTurnDone error-outcome + safety signal
        //   any other incomplete     → closeTurnError{code:reason, usage}
        //   plain completed          → closeTurnDone success
        if (pendingRefusal) {
          a.closeTurnDone(turnId, {
            outcome: { type: "success" },
            finishReason: "refusal",
            ...(usage !== undefined ? { usage } : {}),
          });
        } else if (reason === "content_filter") {
          const safety: AgSafety[] = [{ category: "content_filter", blocked: true }];
          a.closeTurnDone(turnId, {
            outcome: { type: "error", message: "content_filter" },
            finishReason: mapFinishReason(reason),
            safety,
            ...(usage !== undefined ? { usage } : {}),
          });
        } else if (ev.type === "response.incomplete") {
          a.closeTurnError(turnId, {
            message: reason ?? "incomplete",
            ...(reason !== undefined ? { code: reason } : {}),
            ...(usage !== undefined ? { usage } : {}),
          });
        } else {
          a.closeTurnDone(turnId, {
            outcome: { type: "success" },
            finishReason: mapFinishReason(reason),
            ...(usage !== undefined ? { usage } : {}),
          });
        }
        resetResponseState();
        return;
      }
      case "response.failed": {
        // The response itself failed (rate limit, server error, …). Close-once guard.
        if (ensureResponseOpen(ev.response.id) === undefined) return;
        if (turnId === undefined) return; // unreachable post-ensure; satisfies narrowing
        endOpenStreamsAndCloseMessage();
        const err = ev.response.error;
        a.closeTurnError(turnId, {
          message: err?.message ?? "response.failed",
          ...(err?.code !== undefined ? { code: err.code } : {}),
        });
        resetResponseState();
        return;
      }
      case "error": {
        // Top-level NON-terminal advisory (spec §4 bare `error`). It does NOT close
        // the turn — surface it on the lossless vendor channel without disturbing the
        // open response lifecycle.
        a.emitExt("openai", "error", {
          message: ev.message,
          ...(ev.code !== undefined ? { code: ev.code } : {}),
        });
        return;
      }
      // Duplicate raw families IGNORED per the canonical model:
      //   response.output_text.done is handled above; response.output_item.done,
      //   response.in_progress, content_part.* are not authoritative sources.
      default:
        return;
    }
  }

  /** End any still-open text streams (defensive), then close the open message. */
  function endOpenStreamsAndCloseMessage(): void {
    if (msgId !== undefined) {
      for (const streamId of openTextStreams) a.textEnd(streamId, msgId);
      a.closeMessage(msgId);
    }
  }

  /**
   * Map a `message_output_created` run-item to a CITATIONS SUPPLEMENT only —
   * the text already streamed from the raw `response.output_text.delta` path, so
   * this MUST NOT re-emit text. For each `output_text` part that carries
   * url_citation annotations, emit a `content.block` (text + citations[]) so the
   * citations survive the reduce fold. A `refusal` part sets `pendingRefusal` so
   * the downstream `response.completed` arm closes with `finishReason:"refusal"`.
   */
  function driveMessageOutputCreated(item: OpenAIAssistantMessageItem): void {
    for (const part of item.content) {
      if (part.type === "refusal") {
        pendingRefusal = true;
        continue;
      }
      if (part.type === "output_text") {
        const citations = mapAnnotationsToCitations(part.annotations, part.text);
        if (citations !== undefined) {
          ensureResponseOpen();
          const block: AgBlock = { type: "text", text: part.text, citations };
          a.contentBlock(msgId, block);
        }
      }
    }
  }

  /**
   * Map the synthetic `__host_error__` sentinel (host feeds it on
   * `MaxTurnsExceededError`) to a terminal `turn.error{code, message, usage}`.
   *  - A response turn is OPEN → close THAT turn (end streams, close message,
   *    closeTurnError) so the error lands on the well-formed open turn.
   *  - NO turn open (max_turns fired after the last response already completed) →
   *    open a FRESH terminal turn via `ensureResponseOpen()` (which emits a
   *    `turn.start` + `message.start` — `closeTurnError` alone does NOT synthesize
   *    `turn.start`, so a bare close would leave a malformed start-less turn),
   *    close its message, then closeTurnError. Either way the error is emitted on
   *    a turn that has a `turn.start`.
   */
  function driveHostError(event: OpenAIHostError): void {
    ensureResponseOpen();
    if (turnId === undefined) return; // unreachable post-ensure; satisfies narrowing
    endOpenStreamsAndCloseMessage();
    a.closeTurnError(turnId, {
      message: event.message,
      code: event.code,
      ...(event.usage !== undefined ? { usage: event.usage } : {}),
    });
    resetResponseState();
  }

  /** Drive the engine from one (already-narrowed) OpenAIStreamEvent. */
  function drive(event: OpenAIStreamEvent): void {
    if (event.type === "__host_error__") {
      driveHostError(event);
      return;
    }
    if (event.type === "run_item_stream_event") {
      switch (event.name) {
        case "tool_output": {
          // Authoritative tool-result source (canonical model, A1). Drives toolDone
          // with content + structuredContent (the ggui cache marker rides on item.output).
          const rawItem = event.item.rawItem;
          const outcome: ToolOutcome = rawItem.status === "incomplete" ? "error" : "ok";
          const content = toolOutputToAgBlocks(rawItem.output);
          // Extract structuredContent cast-free: item.output may be an object carrying
          // { structuredContent: … }. Use isJsonObject + JsonValue.parse (not a cast).
          const wrapperOutput = event.item.output;
          const structuredContent: JsonValue | undefined =
            isJsonObject(wrapperOutput) && isJsonObject(wrapperOutput.structuredContent)
              ? JsonValue.parse(wrapperOutput.structuredContent)
              : undefined;
          a.toolDone({
            toolCallId: rawItem.callId,
            content,
            outcome,
            isError: rawItem.status === "incomplete",
            ...(structuredContent !== undefined ? { structuredContent } : {}),
          });
          return;
        }
        case "message_output_created":
          // CITATIONS SUPPLEMENT only — the text already streamed from the raw delta
          // (canonical model, A1). Records refusal + emits citation blocks; no text.
          driveMessageOutputCreated(event.item.rawItem);
          return;
        case "tool_called":
          // IGNORED — superseded by model:response.output_item.added, which is the
          // authoritative tool-start source (canonical model, A1 §"Spike Findings").
          return;
        default:
          // Other run-item families (reasoning/handoff/HITL) are not yet ported.
          // No-op here (NOT routed to `unparsed` — they are known families).
          return;
      }
    }

    // raw_model_stream_event — `data` is the Agents SDK ResponseStreamEvent union.
    const data = event.data;
    switch (data.type) {
      case "model": {
        // The verbatim openai-node Responses event rides in `event` (snake_case).
        driveRawResponsesEvent(data.event);
        return;
      }
      // IGNORE the SDK-flattened duplicates (canonical model):
      //   response_started   — duplicate of model:response.created
      //   output_text_delta  — flattened duplicate of model:response.output_text.delta
      //   response_done      — duplicate of model:response.completed
      case "response_started":
      case "output_text_delta":
      case "response_done":
      default:
        return;
    }
  }

  return {
    push(native: JsonValue): AgEvent[] {
      if (!isOpenAIStreamEvent(native)) {
        // Graceful guard (Tenet 6): route a genuinely unrecognisable payload through
        // the lossless vendor channel rather than throwing. Nest under `native` so a
        // payload carrying its own `type` key does NOT clobber the event type.
        a.emitExt("openai", "unparsed", { native });
        return a.drain();
      }
      drive(native);
      return a.drain();
    },
    flush(): AgEvent[] {
      // Close any dangling open response (e.g. a stream that ended before
      // response.completed), then flush the engine's dangling open messages (I7).
      if (turnId !== undefined) closeResponse();
      return a.flush();
    },
  };
}
