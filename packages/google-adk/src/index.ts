/**
 * `@silverprotocol/google-adk` — the Google Agent Development Kit normalizer.
 *
 * Translates a Google ADK `Event` (a Gemini `Content` — role + `parts[]` — plus
 * the event metadata `partial` / `turnComplete` / `errorCode` / `finishReason` /
 * `actions`, inherited from `LlmResponse`) into AgJSON events (`AgEvent[]`,
 * spec §4). The `content.parts[]` fan-out is the HIGHEST structural fan-out in
 * the family: one event maps to a BURST of lifecycle events (`seq` monotonic
 * from 0 within the call; the Router rebases to a global ordinal downstream, out
 * of scope here).
 *
 * The normalizer is STATEFUL across calls (spec §8): it tracks the per-thread
 * already-streamed parts so the ADK `partial:false` AGGREGATE event (which
 * re-sends the full accumulated content) is SUPPRESSED — the #1 ADK
 * double-render quirk (§8.3). It also synthesizes a stable `toolCallId` +
 * records the positional `providerCallIndex` when a Gemini `functionCall.id` is
 * null on the Developer API (§8.2), and preserves the Gemini `thoughtSignature`
 * on EVERY signed part (§8.8) — on the reasoning block's `opaque` for a thought
 * part, on the text event's `providerMetadata.google` for a signed NON-thought
 * (Google-Search-grounded) text part, and on `tool.args.assembled.signature` for
 * a functionCall part. Echo-or-400: a dropped signature breaks turn N+1.
 *
 * ── PRIMARY-SOURCE VERIFICATION (June 2026; the ADK SDK is NOT installed —
 * `@google/adk` is an OPTIONAL peerDependency, NOT imported). The `AdkEvent` type
 * below is a faithful PROJECTION of the verified shapes, hand-defined as the
 * fixture contract until the ADK runtime is wired:
 *   - google/adk-python src/google/adk/events/event.py — the `Event` class
 *     (`author`, `invocationId`, `id`, `actions`, `branch`) extends `LlmResponse`
 *     (`content`, `partial`, `turnComplete`, `errorCode`, `finishReason`).
 *     `is_final_response()` = no functionCalls AND no functionResponses AND not
 *     `partial` AND no trailing codeExecutionResult (or skipSummarization /
 *     longRunningToolIds short-circuit) — the aggregate/final disposition (§8.3).
 *   - Gemini API `Content` (role + parts[]) and the `Part` union
 *     (`Content` REST reference + the Thought-Signatures / Function-Calling /
 *     Code-Execution docs): `{ text, thought?: boolean, thoughtSignature?: base64
 *     string }`, `{ functionCall: { name, args: OBJECT/dict, id? } }`,
 *     `{ functionResponse: { name, response: OBJECT, id? } }`,
 *     `{ inlineData: { mimeType, data: base64 } }`,
 *     `{ executableCode: { language: enum, code } }`,
 *     `{ codeExecutionResult: { outcome: "OUTCOME_OK"|"OUTCOME_FAILED"|
 *       "OUTCOME_DEADLINE_EXCEEDED", output } }`, `{ fileData }`.
 *   - `thoughtSignature` is a PER-PART base64 field; `functionCall.id` is OFTEN
 *     null on the Developer API (echoed parts must restore name+position).
 *
 * NOTE on field casing: the verified Gemini wire shape uses camelCase
 * (`functionCall`, `thoughtSignature`, `inlineData`, `mimeType`, `executableCode`,
 * `codeExecutionResult`, `turnComplete`, `finishReason`) — the genai REST/JS
 * surface. The Python ADK uses the snake_case aliases (`turn_complete`,
 * `function_call`); a runtime adapter would map those before this seam. This
 * fixture contract is the camelCase wire projection.
 */
import {
  type AgEvent,
  type AgBlock,
  type AgAuthConfig,
  type AgCitation,
  type AgFinishReason,
  type AgMeta,
  type AgPausedAsk,
  type AgSafety,
  type AgUsage,
  AgProviderMeta,
  JsonValue,
  type Normalizer,
  StreamAssembler,
  type ToolOutcome,
} from "@silverprotocol/core";

// ─────────────────────────────────────────────────────────────────────────────
// AdkEvent — the HAND-DEFINED fixture contract (a faithful PROJECTION of the
// verified ADK Event + Gemini Content/Part shapes; see file header for the
// primary sources). Until the ADK runtime is wired, this is the input contract.
// ─────────────────────────────────────────────────────────────────────────────

/** A Gemini `Part` — the discriminated-by-presence union (one of the arms
 *  carries content; `thought` / `thoughtSignature` ride alongside). Fields are
 *  optional so a fixture sets exactly the arm it exercises. `args` / `response`
 *  are JSON OBJECTS/dicts (NOT JSON strings — do NOT JSON.parse). */
export interface AdkPart {
  /** Visible text (or, with `thought:true`, the visible reasoning text). */
  text?: string;
  /** Marks a reasoning part (the model's thought) — routes to `reasoning.*`. */
  thought?: boolean;
  /** Per-part base64 thought signature — replay-load-bearing (§8.8). */
  thoughtSignature?: string;
  /** A tool call. `args` is an OBJECT/dict; `id` is OFTEN null on the Dev API. */
  functionCall?: { name: string; args?: { [k: string]: JsonValue }; id?: string | null };
  /** A tool result. `response` is an OBJECT (the function result, JSON object).
   *  `thoughtSignature` carries the per-response replay signature (§8.8). */
  functionResponse?: {
    name: string;
    response?: { [k: string]: JsonValue };
    id?: string | null;
    thoughtSignature?: string;
  };
  /** Embedded media bytes (base64). Both members are OPTIONAL on the genai
   *  `Blob` type (`data?`/`mimeType?`, doc-"Required" only) — `driveAdkPart`
   *  typeof-guards them and carries a Blob missing either via provider-raw
   *  rather than crash on `mimeType.startsWith` or emit a `data`-less source.
   *  `displayName?` (genai 2.24.0 drops "not supported in Gemini API" from its
   *  doc): → `file.filename`, or `providerMetadata.google.displayName` on an
   *  image/audio block, which has no name slot. */
  inlineData?: { mimeType?: string; data?: string; displayName?: string };
  /** Model-generated code (the Code Execution tool). `code` is OPTIONAL on
   *  the genai `ExecutableCode` type (upstream adk #868 fixed the same
   *  assumption) — a code-less part rides provider-raw, never a `code` block
   *  with a fabricated value. */
  executableCode?: { language?: string; code?: string };
  /** Code-execution result (the Code Execution tool). */
  codeExecutionResult?: { outcome?: string; output?: string };
  /** A reference to an uploaded file (passed through opaquely). `fileUri` is
   *  OPTIONAL on the genai `FileData` type — a uri-less part rides
   *  provider-raw, never a schema-invalid `resource-link`. `displayName?`
   *  (genai 2.24.0): `resource-link` has no name slot (SPEC §2), so it rides a
   *  sibling provider-raw `{ fileData: { displayName } }`. */
  fileData?: { mimeType?: string; fileUri?: string; displayName?: string };
  /** Media resolution hint for the input media (fixture-drift ratchet finding,
   *  google-adk-ratchet task) — carried opaquely via `driveAdkPart`'s
   *  unmapped-part-fields provider-raw block; never interpreted. */
  mediaResolution?: JsonValue;
  /** Video metadata accompanying `inlineData`/`fileData` (fixture-drift
   *  ratchet finding): the genai `Part` doc states it "should only be
   *  specified while the video data is presented in inline_data or
   *  file_data" — i.e. it normally rides ALONGSIDE an already-handled kind,
   *  not standalone. Carried opaquely via the same unmapped-part-fields
   *  provider-raw block (checked unconditionally, before the primary
   *  if-chain's early return — see `driveAdkPart`). */
  videoMetadata?: JsonValue;
  /** A server-side tool call the model predicts, which the client is
   *  expected to echo back (fixture-drift ratchet finding) — distinct from
   *  the client-executed `functionCall`. Carried opaquely via provider-raw. */
  toolCall?: JsonValue;
  /** The client-supplied result of a server-side `toolCall` (fixture-drift
   *  ratchet finding). Carried opaquely via provider-raw. */
  toolResponse?: JsonValue;
  /** Free-form per-part custom metadata, e.g. a source-file name or a
   *  multiplex hint for multiple Part streams (fixture-drift ratchet
   *  finding). Carried opaquely via provider-raw. */
  partMetadata?: JsonValue;
  /** "Output only. The transcription of the audio part." (genai 2.15.0 — the
   *  first NEW `Part` field since the 14-member partKind ratchet). The
   *  `Transcription` shape is {text?, finished?, languageCode?, speakerLabel?,
   *  words?: WordInfo[]} with WordInfo {word?, startOffset?, endOffset?}
   *  (offsets are duration strings). Rides ALONGSIDE the audio `inlineData`
   *  part it transcribes (same sibling situation as `videoMetadata`) —
   *  carried opaquely via the same unconditional unmapped-part-fields
   *  provider-raw block. First-class text treatment (the event-level
   *  `outputTranscription` `_meta['agjson/transcription']` stamp precedent)
   *  would orphan `speakerLabel`/`words` — a spec-process decision, not a
   *  mechanical carry. */
  audioTranscription?: JsonValue;
  /** "How the model processes this part's media for understanding." (genai
   *  2.20.0 — the ONE new `Part` field 2.17.1 -> 2.20.0.) The `MediaProcessing`
   *  enum: MEDIA_PROCESSING_UNSPECIFIED (model-specific default) | STATIC
   *  (fixed-rate frame extraction, all frames in context) | AGENTIC
   *  (model-driven dynamic navigation). A REQUEST-side media-understanding
   *  hint that rides ALONGSIDE the `inlineData`/`fileData` part it qualifies —
   *  the identical sibling situation as `mediaResolution`/`videoMetadata`, so
   *  it joins the SAME unconditional unmapped-part-fields provider-raw carry
   *  at the top of `driveAdkPart` (never an else-fallback, which would miss it
   *  on a part whose primary kind already matched and returned). Typed
   *  JsonValue (opaque carry, never interpreted) per the sibling precedents. */
  mediaProcessing?: JsonValue;
  /** "Extra metadata associated with the part for speech synthesis, such as
   *  speaker and style. Only valid when `Part.data` is set to `text`." (genai
   *  2.24.0 — the ONE new `Part` field 2.22.0 -> 2.24.0.) The `SpeechMetadata`
   *  shape is {speaker?, style?}: `speaker` must match a `speaker` name in
   *  `MultiSpeakerVoiceConfig.speaker_voice_configs`; `style` is a free-form
   *  voice-style instruction (e.g. "excited, fast-paced"). A REQUEST-side TTS
   *  hint that rides ALONGSIDE a `text` part — and the text arm returns early,
   *  so it joins the SAME unconditional unmapped-part-fields provider-raw
   *  carry at the top of `driveAdkPart` (never an else-fallback). Typed
   *  JsonValue (opaque carry, never interpreted) per the sibling precedents. */
  speechMetadata?: JsonValue;
}

/** A Gemini `Content` — the role + the part list. ADK normalizes Gemini's
 *  "model" role; we map "model" → "assistant" downstream where needed. */
export interface AdkContent {
  role?: string;
  parts?: AdkPart[];
}

/** A Google ADK `Event` — a Gemini `Content` plus the `LlmResponse` /
 *  `Event` metadata (verified shapes; see file header). */
export interface AdkEvent {
  content?: AdkContent;
  /** true on an incremental/streamed event; false (or absent) on the FINAL
   *  aggregate that re-sends the full content (§8.3). */
  partial?: boolean;
  /** Signals the user-input gate may re-open — the turn boundary (§4 turn.done). */
  turnComplete?: boolean;
  /** Provider finish reason (Gemini `Candidate.finishReason`): STOP / MAX_TOKENS
   *  / SAFETY / RECITATION / … — mapped to the AgFinishReason superset. */
  finishReason?: string;
  /** Provider error code (Gemini block reason) — surfaces a non-STOP finish. */
  errorCode?: string;
  /** Free-text error message accompanying errorCode for hard errors. When BOTH
   *  errorCode AND errorMessage are set, a turn.error is emitted instead of turn.done. */
  errorMessage?: string;
  /** Event id (stable per ADK event). */
  id?: string;
  /** The whole-interaction run id (the turn key). */
  invocationId?: string;
  /** 'user' or the agent name. */
  author?: string;
  /** Side-effect / control signals. */
  actions?: {
    skipSummarization?: boolean;
    /** Transfer control to another named agent. */
    transferToAgent?: string;
    /** Escalate to a human or supervisor. */
    escalate?: boolean;
    /** Request OAuth/auth configs from the caller. ADK serializes this as a
     * dict keyed by the function-call-id (`dict[str, AuthConfig]`); the value
     * is a complex, framework-specific AuthConfig (auth-scheme union +
     * credentials) we carry opaquely. Empty -> `{}` (NOT an array, NOT
     * omitted) — iterating it as an array throws "not iterable". */
    requestedAuthConfigs?: { [callId: string]: JsonValue };
    /** Request user confirmation before executing a tool. ADK serializes this
     * as a dict keyed by the function-call-id (`dict[str, ToolConfirmation]`).
     * Empty -> `{}`. */
    requestedToolConfirmations?: {
      [callId: string]: { hint?: string; confirmed?: boolean; payload?: JsonValue };
    };
    /** State deltas to merge into the shared working copy. */
    stateDelta?: { [k: string]: JsonValue };
    /** Artifact deltas (keyed artifact patches). */
    artifactDelta?: { [k: string]: JsonValue };
    /** UI widgets to render inline. */
    renderUiWidgets?: Array<{ name?: string; code?: string }>;
    /** Workflow: "a serialized node/agent state snapshot used for resumable
     *  checkpointing" — FIRST-CLASS on the official `EventActions` since
     *  `@google/adk` 2.0.0 (event_actions.d.ts, `agentState?: Record<string,
     *  unknown>`; the workflow plane writes an OBJECT, e.g. `{ input }` from
     *  dist/esm/workflow/node_runner.js). Was hand-typed `string` here before
     *  the 2.0.0 bump — WRONG for the official shape; widened to JsonValue so
     *  the object rides losslessly through the `unmappedActions` ledger (via
     *  JsonValue.parse at the boundary) while a legacy string still passes. */
    agentState?: JsonValue;
    /** Workflow: "marks that the emitting agent/workflow has reached the end
     *  of its execution for this invocation" — FIRST-CLASS on the official
     *  `EventActions` since 2.0.0 (was already on this contract + ledger). */
    endOfAgent?: boolean;
  };
  /** Gemini token usage metadata (maps to AgUsage on turn.done). */
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  /** Per-part safety ratings from the Gemini Candidate. */
  safetyRatings?: Array<{
    category?: string;
    probability?: string;
    score?: number;
    blocked?: boolean;
  }>;
  /** Prompt-level safety feedback (block reason + ratings). */
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<{
      category?: string;
      probability?: string;
      score?: number;
      blocked?: boolean;
    }>;
  };
  /** Gemini grounding metadata (search result chunks, citations, search widget). */
  groundingMetadata?: {
    groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    groundingSupports?: Array<{
      groundingChunkIndices?: number[];
      confidenceScores?: number[];
      segment?: { startIndex?: number; endIndex?: number; text?: string };
    }>;
    searchEntryPoint?: { renderedContent?: string };
  };
  /** Citation metadata (Gemini Candidate.citationMetadata). */
  citationMetadata?: {
    citations?: Array<{
      uri?: string;
      title?: string;
      startIndex?: number;
      endIndex?: number;
    }>;
  };
  /** When true, the turn was interrupted mid-stream — emit turn.abort. */
  interrupted?: boolean;
  /** Tool call ids that are long-running (hint: set longRunning:true on tool.start). */
  longRunningToolIds?: string[];
  /** ADK event branch (multi-agent routing). */
  branch?: string;
  /** ISO timestamp of the event. */
  timestamp?: string;
  /** Speech-to-text transcription of the user's audio input. */
  inputTranscription?: { text?: string };
  /** Text-to-speech transcription of the model's audio output. */
  outputTranscription?: { text?: string };
  /** Opaque per-event custom metadata bag. */
  customMetadata?: { [k: string]: JsonValue };
  /** Index of the candidate response (meaningful when the request's
   *  candidateCount > 1) — fixture-drift ratchet finding (google-adk-ratchet
   *  task): absent from this contract entirely until now. Carried via the
   *  event-level unmapped-fields provider-raw block (`driveAdkTopLevel`,
   *  alongside `citationMetadata`/`customMetadata`; SPEC §8 item 23).
   *  NOTE (official-SDK retarget, 2026-07-13): `@google/adk` 1.3.0's
   *  `LlmResponse` does NOT declare this field (it was `@iqai/adk` surface) —
   *  the carry stays as a harmless structural tolerance for older wire. */
  candidateIndex?: number;
  /** The model version that produced this response (official `@google/adk`
   *  `LlmResponse.modelVersion`, new on the 1.3.0 retarget) — carried via the
   *  event-level unmapped-fields provider-raw block, same ratchet precedent
   *  as `candidateIndex`/`branch`. */
  modelVersion?: string;
  /** The interaction ID returned by the model, if any (official `@google/adk`
   *  `LlmResponse.interactionId`, new in 1.4.0) — model-response identity,
   *  carried via the event-level unmapped-fields provider-raw block, same
   *  ratchet precedent as `modelVersion`. */
  interactionId?: string;
  /** CompactedEvent subtype projection (`@google/adk`
   *  dist/types/events/compacted_event.d.ts, `CompactedEvent extends Event` —
   *  OUTSIDE the drift gate's flattened Event/LlmResponse eventField
   *  inventory, which covers only the two base interfaces' own files): a
   *  synthesized summary of past session events. The compactors run inside
   *  `ContextCompactorRequestProcessor` and rewrite `session.events` IN PLACE
   *  before the LLM request — a CompactedEvent is never yielded on the
   *  `runner.runAsync` stream this facet's ingestion boundary normalizes, so
   *  these fields are session-REPLAY ingestion tolerance, carried via the
   *  event-level unmapped-fields provider-raw block per the `candidateIndex`
   *  off-inventory-tolerance precedent (absent from all recorded fixtures —
   *  no golden-snapshot impact). `isScratchpad` is NEW in 1.5.0 (the anchored
   *  compactor's persistent context scratchpad, adk-js PR #470, with the new
   *  `isScratchpadEvent` guard). */
  isCompacted?: boolean;
  /** Start of the compacted context range (epoch seconds — wire payload of
   *  the compaction record, not a per-event envelope stamp). */
  startTime?: number;
  /** End of the compacted context range (epoch seconds). */
  endTime?: number;
  /** The summarized content of the compacted events. */
  compactedContent?: string;
  /** Marks the compacted event as the persistent context scratchpad (1.5.0). */
  isScratchpad?: boolean;
  /** WORKFLOW-PLANE Event fields (`@google/adk` 2.0.0,
   *  dist/types/events/event.d.ts — the four new optional `Event` own-fields;
   *  the fifth addition, a non-serializable unique-symbol brand set by
   *  `createEvent`/checked by `isEvent`, is invisible to JSON and needs no
   *  projection). All four are stamped ONLY by the new workflow plane
   *  (dist/esm/workflow/node_runner.js sets `output`/`route` on node results;
   *  run_llm_agent_as_node.js stamps `nodeInfo.messageAsOutput` +
   *  `isolationScope`) and round-tripped by
   *  sessions/vertex_ai_session_service.js's event metadata — a plain
   *  `LlmAgent` `runner.runAsync` stream (this facet's ingestion boundary)
   *  never carries them, so they are workflow-plane / session-replay ingestion
   *  tolerance carried via the event-level unmapped-fields provider-raw ledger
   *  per the CompactedEvent/`isScratchpad` + `interactionId` precedents
   *  (absent from all recorded fixtures — no golden-snapshot impact).
   *
   *  "Workflow: the structured output produced by the emitting node, if any"
   *  (`output?: unknown` upstream — JsonValue at this JSON boundary). */
  output?: JsonValue;
  /** "Workflow: the route key(s) emitted by a routing node, used by the graph
   *  to select the matching outgoing edge(s)" — upstream `Route = RouteKey |
   *  RouteKey[]`, `RouteKey = string | number | boolean` (a single key fires
   *  one branch; an array fires every branch whose route matches). Carried
   *  opaquely (present-check, never truthiness — `false`/`0` are valid keys). */
  route?: JsonValue;
  /** "Workflow: provenance of the emitting node" (`NodeInfo`): `path` = the
   *  node path that produced the event (e.g. `wf.child.0`); `outputFor` = the
   *  node paths this event's output serves as the output for (emitting node
   *  first, then any ancestor that delegated via `useAsOutput`);
   *  `messageAsOutput` = whether the textual content is promoted to the node's
   *  structured output. Carried as a WHOLE object. */
  nodeInfo?: { path?: string; outputFor?: string[]; messageAsOutput?: boolean };
  /** "Workflow: scope tag used to isolate multi-agent conversations so peer
   *  scopes don't see each other's events" (e.g. `<nodePath>@<runId>`). */
  isolationScope?: string;
}

// ─── finishReason → AgFinishReason (spec §4) ──────────────────────────────────
// Maps any Gemini/ADK Candidate.finishReason to the neutral AgFinishReason
// superset. A bare turnComplete with no reason ⇒ stop.
//
// The single mapping table both exported views read. `lossy` marks the arms
// where the neutral value cannot round-trip back to the wire string — the
// default→"unknown" arm (unrecognized value) plus recognized-but-inexact
// mappings (TOO_MANY_TOOL_CALLS→"other") — so adding a new inexact case here
// is FORCED to declare its lossiness in the same literal (nothing to drift).
// `maybeCloseTurn` lands lossy wire strings as `message.metadata` before the
// close; without that carry the raw value is unrecoverable downstream
// (turn.done has no provider slot).
function resolveFinishReason(reason: string | undefined | null): {
  value: AgFinishReason;
  lossy: boolean;
} {
  switch (reason) {
    case undefined:
    case null:
    case "":
    case "STOP":
    case "FINISH_REASON_STOP":
      return { value: "stop", lossy: false };
    case "MAX_TOKENS":
      return { value: "token_limit", lossy: false };
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return { value: "safety_blocked", lossy: false };
    case "MALFORMED_FUNCTION_CALL":
      return { value: "malformed_tool_call", lossy: false };
    // genai ≥2.16.0 (2026-08-06, the gemini-3.7-flash SDK generation) tool-call
    // reasons. CAVEAT (unproven wire shape, check at the first 3.7 capture):
    // if the final event carries the offending functionCall part alongside the
    // finishReason, maybeCloseTurn's hasFunctionCall gate defers the close and
    // neither mapping nor carry ever fires for it.
    case "UNEXPECTED_TOOL_CALL":
      return { value: "unexpected_tool_call", lossy: false };
    // No first-class AgFinishReason home yet — "other" is the interim mapping
    // and the wire string rides the lossy carry, pending a spec-process
    // decision on first-class standing.
    case "TOO_MANY_TOOL_CALLS":
      return { value: "other", lossy: true };
    case "OTHER":
      return { value: "other", lossy: false };
    default:
      return { value: "unknown", lossy: true };
  }
}

export function mapFinishReason(reason: string | undefined | null): AgFinishReason {
  return resolveFinishReason(reason).value;
}

/** True when mapFinishReason loses the wire string (see resolveFinishReason's
 *  table — the lossy arms). Exported for the same testability reason as
 *  mapFinishReason. */
export function isLossyFinishReason(reason: string): boolean {
  return resolveFinishReason(reason).lossy;
}

// ─── stateful factory helpers ─────────────────────────────────────────────────

/** True for a non-null, non-array plain JSON object (guard idiom from the OpenAI facet). */
function isJsonObject(v: unknown): v is { readonly [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Outer-discriminant guard. ADK events carry an object `content` and/or an `invocationId`. */
function isAdkEvent(v: unknown): v is AdkEvent {
  if (!isJsonObject(v)) return false;
  return isJsonObject(v["content"]) || typeof v["invocationId"] === "string";
}

/**
 * ADK usageMetadata → neutral AgUsage (cumulative:false). Extracted from the
 * legacy turn.done arm.
 *
 * Spec §4 `outputTokens` inclusion (draft.3; §8.0 item 24): `outputTokens`
 * counts every generated token INCLUDING reasoning. Gemini reports thoughts as a
 * SIBLING of `candidatesTokenCount` (exclusive — `totalTokenCount = prompt +
 * candidates + toolUsePrompt + thoughts`, verified on every live cassette), so
 * the fold `candidates + thoughts` is the one sanctioned arithmetic on usage.
 * GUARD (LiteLLM precedent): if the provider's own total already balances on
 * candidates alone while thoughts are present, `candidatesTokenCount` is
 * inclusive on that endpoint — carry it as-is, never add twice. A thoughts-free
 * usageMetadata normalizes byte-identically to draft.2. `reasoningTokens` stays
 * the breakdown (`thoughtsTokenCount` verbatim); `totalTokens` is copied, never
 * computed. Known upstream gap: @google/adk's Interactions-API route synthesizes
 * usageMetadata WITHOUT thoughts (candidates = total_output_tokens, total =
 * in + out), so on that route outputTokens is exclusive and reasoningTokens
 * absent — nothing the facet can recover (see README).
 * The guard is applied to the per-turn SUM (accumulateUsage): sound as long as
 * every summed event carried `totalTokenCount` (Gemini always does); a turn
 * mixing total-bearing and total-less events could balance by accident.
 */
function mapUsage(um: AdkEvent["usageMetadata"]): AgUsage | undefined {
  if (um === undefined) return undefined;
  const candidates = um.candidatesTokenCount;
  const thoughts = um.thoughtsTokenCount;
  const alreadyInclusive =
    candidates !== undefined &&
    thoughts !== undefined &&
    thoughts > 0 &&
    um.totalTokenCount !== undefined &&
    um.promptTokenCount !== undefined &&
    um.promptTokenCount + (candidates ?? 0) + (um.toolUsePromptTokenCount ?? 0) === um.totalTokenCount;
  const outputTokens =
    candidates === undefined && thoughts === undefined
      ? undefined
      : alreadyInclusive
        ? candidates
        : (candidates ?? 0) + (thoughts ?? 0);
  return {
    ...(um.promptTokenCount !== undefined ? { inputTokens: um.promptTokenCount } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(um.totalTokenCount !== undefined ? { totalTokens: um.totalTokenCount } : {}),
    ...(um.cachedContentTokenCount !== undefined
      ? { cacheReadTokens: um.cachedContentTokenCount }
      : {}),
    ...(um.thoughtsTokenCount !== undefined ? { reasoningTokens: um.thoughtsTokenCount } : {}),
    ...(um.toolUsePromptTokenCount !== undefined
      ? { toolUseInputTokens: um.toolUsePromptTokenCount }
      : {}),
    cumulative: false as const,
  };
}

/** The usageMetadata fields mapUsage consumes — the summable per-LLM-call
 *  token counters a turn's accumulator adds up (see maybeCloseTurn). */
const USAGE_SUM_FIELDS = [
  "promptTokenCount",
  "candidatesTokenCount",
  "totalTokenCount",
  "cachedContentTokenCount",
  "thoughtsTokenCount",
  "toolUsePromptTokenCount",
] as const;

/** Fold one event's usageMetadata into a turn's running accumulator
 *  (field-wise sum; absent fields stay absent so mapUsage's presence checks
 *  keep working). Returns the accumulator (creating it on first use). */
function accumulateUsage(
  acc: NonNullable<AdkEvent["usageMetadata"]> | undefined,
  um: AdkEvent["usageMetadata"],
): NonNullable<AdkEvent["usageMetadata"]> | undefined {
  if (um === undefined) return acc;
  const next = acc ?? {};
  for (const field of USAGE_SUM_FIELDS) {
    const v = um[field];
    if (v !== undefined) next[field] = (next[field] ?? 0) + v;
  }
  return next;
}

/** ADK blocked safetyRatings → neutral AgSafety[]. Extracted from the legacy turn.done arm. */
function mapBlockedSafety(ratings: AdkEvent["safetyRatings"]): AgSafety[] | undefined {
  if (ratings === undefined) return undefined;
  const out = ratings
    .filter(
      (r): r is typeof r & { category: string } => r.blocked === true && r.category !== undefined
    )
    .map((r) => ({
      category: r.category,
      probability: r.probability,
      score: r.score,
      blocked: r.blocked,
    }));
  return out.length > 0 ? out : undefined;
}

// ─── promptFeedback.blockReason → prompt.blocked reason (spec §4) ────────────
// Maps Gemini blockReason to the AgJSON prompt.blocked reason enum.
function mapBlockReason(reason: string): "safety" | "blocklist" | "prohibited" | "other" {
  switch (reason) {
    case "SAFETY":
      return "safety";
    case "BLOCKLIST":
      return "blocklist";
    case "PROHIBITED_CONTENT":
      return "prohibited";
    default:
      return "other";
  }
}

// ─── inlineData.mimeType → AgBlock type (spec §2) ─────────────────────────────
// Route a Gemini Blob by its MIME type to the matching AgBlock media arm. base64
// is the only source kind Gemini inlineData carries (Blob = {mimeType, data}).
function inlineDataBlock(d: { mimeType: string; data: string; displayName?: string }): AgBlock {
  const source = { type: "base64", mediaType: d.mimeType, data: d.data } as const;
  // genai 2.24.0 Blob.displayName: the file arm's own `filename` (SPEC §2) is
  // its home; image/audio have no name slot, so it rides providerMetadata.
  // Absent ⇒ byte-identical.
  const named =
    d.displayName !== undefined
      ? { providerMetadata: AgProviderMeta.parse({ google: { displayName: d.displayName } }) }
      : {};
  if (d.mimeType.startsWith("image/")) return { type: "image", source, ...named };
  if (d.mimeType.startsWith("audio/")) return { type: "audio", source, ...named };
  // Everything else (video/*, application/*, text/*, …) rides the file arm
  // (spec §2: video = mediaType video/*). It is still a typed media block.
  return { type: "file", source, ...(d.displayName !== undefined ? { filename: d.displayName } : {}) };
}

// ─── genai-optional arm members (adk-13 hardening) ───────────────────────────
// A Part arm's member when it is a string, else undefined. Read through
// `unknown` + `isJsonObject` so a JSON-null arm (a snake_case serializer that
// keeps None) is guarded too, never dereferenced.
function stringMember(arm: unknown, key: string): string | undefined {
  if (!isJsonObject(arm)) return undefined;
  const v = arm[key];
  return typeof v === "string" ? v : undefined;
}

// A media/code arm missing a member its AgBlock arm REQUIRES rides verbatim in
// one provider-raw block keyed by its wire Part field name — the same
// `{ <field>: <value> }` shape as `driveAdkPart`'s unmapped-part-fields ledger.
// A JSON-null arm (a snake_case serializer that keeps None) rides the same way
// for every object arm, the tool arms included (null guard): it is carried,
// never dereferenced.
function carryUnmappableArm(
  a: StreamAssembler,
  messageId: string,
  field:
    | "inlineData"
    | "executableCode"
    | "codeExecutionResult"
    | "fileData"
    | "functionCall"
    | "functionResponse",
  arm: unknown,
): void {
  a.contentBlock(messageId, {
    type: "provider-raw",
    vendor: "google",
    raw: JsonValue.parse({ [field]: arm }),
  });
}

// ─── executableCode.language → AgBlock.code.language (spec §2) ────────────────
// Gemini ExecutableCode.language is a closed enum (LANGUAGE_UNSPECIFIED|PYTHON);
// AgJSON code.language is a free string. Map defensively (spec §2 round-trip note).
function codeLanguage(lang: string | undefined): string {
  if (lang === undefined || lang === "LANGUAGE_UNSPECIFIED" || lang === "") return "python";
  return lang.toLowerCase();
}

// ─── codeExecutionResult.outcome → code-result.outcome (spec §2) ──────────────
function codeOutcome(outcome: string | undefined): "ok" | "failed" | "deadline_exceeded" {
  switch (outcome) {
    case "OUTCOME_OK":
      return "ok";
    case "OUTCOME_DEADLINE_EXCEEDED":
      return "deadline_exceeded";
    default:
      // OUTCOME_FAILED / OUTCOME_UNSPECIFIED / unknown → failed.
      return "failed";
  }
}

// ─── ADK pause family: the event with which ADK ENDS a pause (R&D item 6) ────
// Package rd-06 (sp-protocol bar wf_6973f170-9d0), step 1. Observed on the
// real @google/adk 2.1.0 engine (offline, stub model), each pause's LAST event:
//   - requireConfirmation: the confirmation-request event, which carries
//     actions.requestedToolConfirmations (plus a user-role adk_request_confirmation
//     call);
//   - credential: the tool's functionResponse carrying actions.requestedAuthConfigs,
//     AFTER the adk_request_credential call (closing on that call would put the
//     response after the terminal and park);
//   - requestInputTool: the content-less skipSummarization event after the call;
//   - a Workflow root pause: the root's own content-less input record, which
//     carries longRunningToolIds. The root is identified by adk-js path grammar
//     (a dotless nodeInfo.path); that detail is facet-local, not spec.
// The caller closes `paused` on one of these only while an ask is pending.
const ADK_REQUEST_INPUT = "adk_request_input";
const ADK_REQUEST_CONFIRMATION = "adk_request_confirmation";

/** Per-normalizer pause-family bookkeeping (item 26): reserved-call ids already
 *  asked, and per turn the ORIGINAL tool-call ids those asks cover (so items
 *  12/18 yield no second ask for them). */
type ReservedAskState = { asked: Set<string>; originalsByTurn: Map<string, Set<string>> };

/** A member of `v` by camelCase or snake_case name. */
function memberOf(v: JsonValue | undefined, name: string): JsonValue | undefined {
  if (!isJsonObject(v)) return undefined;
  if (Object.hasOwn(v, name)) return v[name];
  const snake = snakeKey(name);
  return Object.hasOwn(v, snake) ? v[snake] : undefined;
}

/** The ask a reserved adk_request_* call yields (SPEC §8.0 item 26). */
function reservedCallAsk(
  name: string,
  callId: string,
  args: { readonly [k: string]: JsonValue },
): { ask: AgPausedAsk; originalId?: string } {
  if (name === ADK_REQUEST_INPUT) {
    const schema = args["response_schema"];
    const message = stringMember(args, "message");
    const payload = args["payload"];
    return {
      ask: {
        askId: callId,
        kind: isJsonObject(schema) ? "form" : "text",
        toolCallId: callId,
        resumeBinding: "id",
        ...(message !== undefined ? { message } : {}),
        ...(isJsonObject(schema) ? { schema } : {}),
        ...(payload !== undefined ? { metadata: { payload } } : {}),
      },
    };
  }
  if (name === ADK_REQUEST_CREDENTIAL) {
    const originalId =
      stringMember(args, "functionCallId") ?? stringMember(args, "function_call_id");
    const authConfig = memberOf(args, "authConfig") ?? null;
    const message = stringMember(args, "message");
    const view = adkAuthConfigView(authConfig);
    return {
      ask: {
        askId: `auth_${callId}`,
        kind: "auth",
        toolCallId: callId,
        resumeBinding: "id",
        ...(message !== undefined ? { message } : {}),
        ...(view !== undefined ? { authConfig: view } : {}),
        metadata: {
          authConfig: scrubAdkAuthConfig(authConfig),
          ...(originalId !== undefined ? { originalFunctionCallId: originalId } : {}),
        },
      },
      ...(originalId !== undefined ? { originalId } : {}),
    };
  }
  // adk_request_confirmation: args {originalFunctionCall {id, name, args}, toolConfirmation {hint, confirmed, payload}}.
  const originalId = stringMember(memberOf(args, "originalFunctionCall"), "id");
  const confirmation = memberOf(args, "toolConfirmation");
  const hint = stringMember(confirmation, "hint");
  const confirmed = memberOf(confirmation, "confirmed");
  const payload = memberOf(confirmation, "payload");
  const metadata: { [k: string]: JsonValue } = {};
  if (typeof confirmed === "boolean") metadata["confirmed"] = confirmed;
  if (payload !== undefined) metadata["payload"] = payload;
  if (originalId !== undefined) metadata["originalFunctionCallId"] = originalId;
  return {
    ask: {
      askId: `approval_${callId}`,
      kind: "approval",
      toolCallId: callId,
      resumeBinding: "id",
      ...(hint !== undefined ? { message: hint } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
    ...(originalId !== undefined ? { originalId } : {}),
  };
}

function isNonEmptyRecord(v: unknown): boolean {
  return isJsonObject(v) && Object.keys(v).length > 0;
}

function isAdkPauseEnd(event: AdkEvent): boolean {
  const actions = event.actions;
  if (isNonEmptyRecord(actions?.requestedToolConfirmations)) return true;
  if (isNonEmptyRecord(actions?.requestedAuthConfigs)) return true;
  const contentless = (event.content?.parts ?? []).length === 0;
  if (contentless && actions?.skipSummarization === true) return true;
  const path = event.nodeInfo?.path;
  return (
    contentless &&
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes(".") &&
    (event.longRunningToolIds?.length ?? 0) > 0
  );
}

function turnKey(ev: AdkEvent): string {
  return ev.invocationId && ev.invocationId.length > 0 ? ev.invocationId : ev.id ?? "adk";
}

// ─── tool-call positional index (spec §8.2) ───────────────────────────────────
// Gemini parallel functionCall parts arrive in positional order; when a part's
// `functionCall.id` is null/absent we synthesize a stable toolCallId AND record
// the positional index on tool.start/tool-call `providerCallIndex` so re-input can
// restore name+position correlation when echoing functionResponse parts.

// ─── functionResponse.response → tool.done outcome (SPEC §8.0 item 25, draft.4) ─
// adk-10, founder-ruled 2026-09-23 ("Flip on error, approvals kept"). ADK
// answers a failed tool call with a response carrying Gemini's documented
// `error` key: an unresolvable tool name (functions.js:264), a thrown tool
// including a thrown MCP call (functions.js:282), several built-in tools.
// Rules, in order:
//   1. MCP CallToolResult `isError: true` → "error" + isError.
//   2. The call id is named in the SAME event's actions.requestedToolConfirmations
//      or actions.requestedAuthConfigs → "ok": ADK's pause placeholder
//      (function_tool.js:139-141, same event per functions.js:422-431); the
//      pause rides hitl.ask (§8.0 items 12 and 18).
//   3. A declined approval → "denied", no errorText, no isError: an `error`
//      equal to a rejection literal or starting with the policy-engine prefix,
//      or an error_code/errorCode of CONFIRMATION_REJECTED.
//   4. An `error` present and not null/false/0/"" → "error" + isError, with
//      errorText when it is a string and errorCode from a string
//      error_code/errorCode.
//   5. Otherwise "ok" (incl. `{status:"error", …}`, out of scope per item 25).
// `content` always carries the response verbatim (functionResponseToToolDoneFields).
// Literals pinned at @google/adk 2.1.0: function_tool.js:144,
// security_plugin.js:75 and :113, run_skill_inline_script_tool.js:160-163.
const ADK_REJECTION_ERRORS: ReadonlySet<string> = new Set([
  "This tool call is rejected.",
  "Tool call rejected from confirmation flow.",
]);
const ADK_POLICY_REJECTION_PREFIX = "This tool call is rejected by policy engine.";
const ADK_REJECTION_ERROR_CODE = "CONFIRMATION_REJECTED";

type ToolResultClassification = {
  outcome: ToolOutcome;
  isError?: true;
  errorText?: string;
  errorCode?: string;
};

function isAdkPausePlaceholder(toolCallId: string, actions: AdkEvent["actions"]): boolean {
  const confirmations = actions?.requestedToolConfirmations;
  const auths = actions?.requestedAuthConfigs;
  return (
    (isJsonObject(confirmations) && Object.hasOwn(confirmations, toolCallId)) ||
    (isJsonObject(auths) && Object.hasOwn(auths, toolCallId))
  );
}

function classifyFunctionResponse(
  response: { readonly [k: string]: JsonValue } | undefined,
  toolCallId: string,
  actions: AdkEvent["actions"],
): ToolResultClassification {
  if (response === undefined) return { outcome: "ok" };
  if (response["isError"] === true) return { outcome: "error", isError: true };
  if (isAdkPausePlaceholder(toolCallId, actions)) return { outcome: "ok" };
  const error = response["error"];
  const code = stringMember(response, "error_code") ?? stringMember(response, "errorCode");
  if (
    code === ADK_REJECTION_ERROR_CODE ||
    (typeof error === "string" &&
      (ADK_REJECTION_ERRORS.has(error) || error.startsWith(ADK_POLICY_REJECTION_PREFIX)))
  ) {
    return { outcome: "denied" };
  }
  if (error !== undefined && error !== null && error !== false && error !== 0 && error !== "") {
    return {
      outcome: "error",
      isError: true,
      ...(typeof error === "string" ? { errorText: error } : {}),
      ...(code !== undefined ? { errorCode: code } : {}),
    };
  }
  return { outcome: "ok" };
}

// ─── functionResponse.response → tool.done channels (spec §2/§2.1, MCP shape) ──
// The Gemini functionResponse.response is a JSON OBJECT (the function result).
// Preserve its shape: an MCP-style { content: AgBlock[] } passes through as the
// model-facing content blocks; otherwise the whole object rides a single `data`
// block (typed, addressable by the function name) so nothing is dropped.
//
// MCP-Apps siblings (workspace#2, first adk MCP-Apps capture 2026-07-25):
// on the MCP-shape branch, `structuredContent` and `_meta` ride ALONGSIDE the
// content array (the app-spec shape — `_meta.ui.resourceUri` is the MCP-Apps
// surface anchor). Reading only `content` silently dropped both — caught by
// the census on corpus/app-spec-gemini36. They now land on the tool.done's
// first-class §2.1 channels, converging with the openai facet's
// extractStructuredContent precedent (corpus/app-spec-structured-result). The
// non-MCP branch never had this gap: the whole object (siblings included)
// already rides the data block.
interface FunctionResponseToolDoneFields {
  content: AgBlock[];
  structuredContent?: JsonValue;
  _meta?: AgMeta;
}
function functionResponseToToolDoneFields(
  name: string,
  response: { [k: string]: JsonValue } | undefined,
): FunctionResponseToolDoneFields {
  if (response === undefined) return { content: [] };
  // MCP resource shape: a `content` array of MCP content blocks (text/image/…).
  const content = response["content"];
  if (Array.isArray(content)) {
    const out: AgBlock[] = [];
    for (const part of content) {
      if (part !== null && typeof part === "object" && !Array.isArray(part)) {
        const t = part["type"];
        if (t === "text" && typeof part["text"] === "string") {
          out.push({ type: "text", text: part["text"] });
          continue;
        }
      }
      // Preserve any non-text MCP content part losslessly as a provider-raw block.
      out.push({ type: "provider-raw", vendor: "google", raw: part });
    }
    const meta = response["_meta"];
    return {
      content: out,
      ...(response["structuredContent"] !== undefined
        ? { structuredContent: response["structuredContent"] }
        : {}),
      ...(meta !== null && typeof meta === "object" && !Array.isArray(meta)
        ? { _meta: meta as AgMeta }
        : {}),
    };
  }
  // Non-MCP plain object result → a typed `data` block keyed by the tool name.
  return { content: [{ type: "data", name, data: response }] };
}

// ─── groundingMetadata.groundingSupports → ONE citations[] (audit M22) ────────
// Each `groundingSupports` entry is a distinct SEGMENT of the SAME grounded text
// output (its own offsets + sourceIds, self-contained), so collecting them into
// one array — attached to the ONE streamed text block's `text.end` — is correct:
// no per-segment supplement block, no duplicate-fold.
function mapGroundingCitations(
  gm: AdkEvent["groundingMetadata"]
): AgCitation[] | undefined {
  if (gm?.groundingSupports === undefined || gm.groundingSupports.length === 0) return undefined;
  return gm.groundingSupports.map((support): AgCitation => ({
    kind: "offset",
    unit: "byte",
    startIndex: support.segment?.startIndex ?? 0,
    endIndex: support.segment?.endIndex ?? 0,
    bounds: "[start,end)",
    sourceIds: support.groundingChunkIndices?.map((i) => `grounding_${i}`) ?? [],
    confidenceScores: support.confidenceScores ?? [],
    citedText: support.segment?.text ?? "",
    indexFrame: "response",
  }));
}

// ─── null-id call mint state (audit M47; window/correlation redesign — review
// findings b/c on M47) ──────────────────────────────────────────────────────
// Gemini `functionCall.id` is often null on the Developer API (§8.2). Identity
// MUST NOT derive from a per-event positional index (INV-BLOCK): two DIFFERENT
// null-id calls that each land at parts[0] of DIFFERENT events would otherwise
// collide on the same synthesized id — the M47 repro (sequential toolA/toolB,
// both at parts[0]; toolB silently dropped, both results mis-keyed to toolA).
//
// Fix: mint a per-INVOKE ordinal id (`${turnId}:call:${ordinal}` — the ordinal
// counter lives in this closure, once per Normalizer instance/invoke).
//
// ── review finding (b): window-scoped multiset dedup, not "unresolved" ─────
// The ADK `partial:false` AGGREGATE re-send (§8 item 3) repeats the exact same
// functionCall content (name+args) the partial event(s) already streamed —
// that repeat must dedup to the SAME minted id, not mint a fresh one. The
// PRIOR fix keyed this dedup on "still unresolved" (a call stayed collapsible
// until its functionResponse landed) — but that collapses a GENUINELY
// REPEATED invocation (the same name+args called a SECOND time before the
// first resolves): the second call's tool.start silently vanished, and its
// later functionResponse then had no pending id left to consume, so it minted
// a FRESH one — a dangling tool.done with no matching tool.start.
//
// The correct dedup scope is the WINDOW, not "resolved-ness": the
// aggregate-resend window spans this turn's first `partial:true` event to its
// NEXT `partial:false` event that carries that SAME content, which CLOSES it
// — the facet's existing partial/aggregate boundary (§8 item 3; see
// `isAggregate`/`streamedText` in `drive()`). `openWindowCounts` is a per-turn
// MULTISET of (name,argsJson) -> how many times that content was emitted so
// far in the CURRENTLY open window. Every `partial:true` occurrence
// mints+emits and increments the count. The closing `partial:false` event
// SUPPRESSES up to that many occurrences of the same content (the resend) and
// mints+emits any EXCESS occurrences fresh — the aggregate is authoritative
// for the window's full call list, so two truly-parallel identical calls emit
// twice.
//
// Round-3 review finding (regression on this same finding b): the window's
// lifecycle is scoped PER CONTENT KEY, not per turn. `mintNullIdCallId`
// clears ONLY the contentKey entry it just fully consumed — it never touches
// other content keys' entries, and nothing clears the whole turn's map on an
// unrelated non-partial event (a different tool's call, a text aggregate).
// The prior "clear the whole per-turn map after any non-partial event"
// approach wiped a still-in-flight window whenever an unrelated non-partial
// event landed first, causing that window's TRUE aggregate resend to see no
// suppress-budget and re-mint+re-emit a duplicate tool.start. Per-contentKey
// clearing means a repeat invocation with identical content in a LATER window
// is still never collapsed — once ITS contentKey entry is cleared (by ITS OWN
// closing event), a further occurrence mints+emits exactly like a first
// occurrence. A call outside any window (no `partial:true` precursor at all)
// is never counted either way, so flat standalone repeats always emit too.
//
// ── review finding (c): functionResponse correlation ───────────────────────
// A functionResponse carries the tool NAME, never a position that reliably
// maps back to its call (SPEC.md:914's `providerCallIndex` is a *re-input*
// echo concern, not a receive-side correlator). Three cases, by shape:
//  (i) ONE event with MULTIPLE functionResponses: Gemini's parallel-call
//      convention is that a batch of results mirrors its calls' array
//      position — the same rationale `providerCallIndex` records at mint
//      time (§8 item 2). Resolved by a dedicated event-scoped pre-pass in
//      `drive()` that calls `consumeMintedCallId` once per response, IN
//      EVENT ORDER — exactly the positional pairing that convention implies.
//  (ii) a single, standalone functionResponse in its own event: still FIFO
//      per (turnId,name) via `consumeMintedCallId`. Two same-name calls whose
//      responses resolve OUT OF ORDER across separate events are genuinely
//      INDISTINGUISHABLE on this wire — no field ties a response to a
//      specific call beyond the name — so FIFO-by-mint-order is the
//      documented best-available approximation, not a claimed fix.
//  (iii) an ORPHAN response (no pending mint under that name at all) must NOT
//      fabricate a dangling tool.done — the whole functionResponse rides
//      losslessly via `ext.google.unparsed` instead (mirrors the openai
//      `late-*` ext precedents), handled at the `driveAdkPart` call site.
interface ToolCallMintState {
  nextOrdinal: number;
  /** turnId -> (contentKey -> emitted-count) for the CURRENTLY open resend
   *  window. No entry (or an empty map) for a turnId means no window is open
   *  for it right now. */
  openWindowCounts: Map<string, Map<string, number>>;
  /** (turnId,name) -> FIFO queue of minted ids awaiting their functionResponse. */
  pendingIdsByName: Map<string, string[]>;
}

function toolCallContentKey(
  turnId: string,
  name: string,
  args: { [k: string]: JsonValue } | undefined
): string {
  return `${turnId} ${name} ${JSON.stringify(args ?? {})}`;
}

/** Mint the next per-invoke-ordinal call id — never derived from event position. */
function mintFreshCallId(mint: ToolCallMintState, turnId: string): string {
  const toolCallId = `${turnId}:call:${mint.nextOrdinal}`;
  mint.nextOrdinal += 1;
  return toolCallId;
}

/** Mint (or, within the still-open resend window's already-emitted budget for
 *  this exact content, SUPPRESS) the toolCallId for a null-id functionCall
 *  part. `resend:true` means the caller MUST NOT re-emit tool.start/args for
 *  this occurrence (§8 item 3 suppression; review finding-b window-scoped
 *  multiset dedup — see the file-header doc above for the full rationale). */
function mintNullIdCallId(
  mint: ToolCallMintState,
  turnId: string,
  name: string,
  args: { [k: string]: JsonValue } | undefined,
  isPartial: boolean
): { toolCallId: string; resend: boolean } {
  const contentKey = toolCallContentKey(turnId, name, args);
  if (!isPartial) {
    const windowCounts = mint.openWindowCounts.get(turnId);
    const emitted = windowCounts?.get(contentKey) ?? 0;
    if (emitted > 0) {
      // Round-3 review finding: the window's lifecycle is scoped to THIS
      // content key alone, never the whole turn. Once this occurrence's
      // suppress-budget is fully consumed, delete just this contentKey's
      // entry — an unrelated non-partial event for a DIFFERENT content key
      // (or no null-id calls at all) must never touch it. `drive()` no
      // longer blanket-clears `openWindowCounts` on turn-scope; entries for
      // windows whose aggregate never arrives simply die with the invoke's
      // closure (bounded, per-invoke).
      if (emitted === 1) windowCounts?.delete(contentKey);
      else windowCounts?.set(contentKey, emitted - 1);
      return { toolCallId: "", resend: true };
    }
    // No open window entry for this content, or this content's window budget
    // is already exhausted: either a standalone call (no partial precursor)
    // or an EXCESS occurrence in the aggregate (a genuinely-parallel
    // identical call) — mint+emit fresh.
  }
  const toolCallId = mintFreshCallId(mint, turnId);
  if (isPartial) {
    const windowCounts = mint.openWindowCounts.get(turnId) ?? new Map<string, number>();
    windowCounts.set(contentKey, (windowCounts.get(contentKey) ?? 0) + 1);
    mint.openWindowCounts.set(turnId, windowCounts);
  }
  const nameKey = `${turnId} ${name}`;
  const queue = mint.pendingIdsByName.get(nameKey) ?? [];
  queue.push(toolCallId);
  mint.pendingIdsByName.set(nameKey, queue);
  return { toolCallId, resend: false };
}

/** Correlate a null-id functionResponse to its call: pop the FIFO-oldest
 *  unconsumed minted id for this (turnId,name). Called once per response, IN
 *  EVENT ORDER, by `drive()`'s pre-pass — for a multi-response event this IS
 *  the positional pairing Gemini's parallel-call convention describes
 *  (finding c-i); for a lone cross-event response it's the best-available
 *  FIFO approximation, since out-of-order same-name responses carry no field
 *  that disambiguates them further (finding c-ii). `undefined` means no call
 *  is pending under that name — an ORPHAN response (finding c-iii); the
 *  caller must NOT mint a fresh id for it. */
function consumeMintedCallId(
  mint: ToolCallMintState,
  turnId: string,
  name: string
): string | undefined {
  const nameKey = `${turnId} ${name}`;
  const queue = mint.pendingIdsByName.get(nameKey);
  if (queue === undefined || queue.length === 0) return undefined;
  return queue.shift();
}

// ─── stateful factory: driveAdkPart ──────────────────────────────────────────
// ─── block ids: a per-INVOKE ordinal per kind (SPEC.md INV-BLOCK) ────────────
// Streaming block ids MUST be unique within a fold, and identity MUST never
// derive solely from a per-event positional index. ADK/Gemini parts carry no
// block id, so the facet mints `${kind}:${n}`, where n counts that kind's
// blocks across the WHOLE normalizer (one invoke, §8.0 obligation 3). The id
// carries no turnId, so the counter must not reset per turn. A per-turn count
// re-opened text:0 in a second turn of the same invoke (a workflow-node turn
// then a plain turn), and the draft.4 reducer parks on that (rd-14 P14:
// invoke-scoped INV-BLOCK, reset at the seq-0 restart). The old
// `${kind}:${partIndex}` repeated across events: two thought events in one
// invoke both opened reasoning:0 (thinking-gemini37/38, R&D item 14
// prerequisite). A one-turn invoke's ids are unchanged, and every committed
// adk golden is a one-turn invoke.
type BlockIdMint = Map<"text" | "reasoning", number>;

function mintBlockId(m: BlockIdMint, kind: "text" | "reasoning"): string {
  const n = m.get(kind) ?? 0;
  m.set(kind, n + 1);
  return `${kind}:${n}`;
}

function driveAdkPart(
  a: StreamAssembler,
  part: AdkPart,
  index: number,
  event: AdkEvent,
  messageId: string,
  turnId: string,
  isPartial: boolean,
  _assembledToolCalls: Set<string>,
  mint: ToolCallMintState,
  nullIdResponseIds: Map<number, string | undefined>,
  blockIds: BlockIdMint,
  citations?: AgCitation[]
): string {
  // ── UNMAPPED PART FIELDS (mediaResolution/videoMetadata/toolCall/toolResponse/
  // partMetadata/audioTranscription/mediaProcessing/speechMetadata) → provider-raw content.block
  // (fixture-drift ratchet finding, google-adk-ratchet task; Tenet-6; SPEC §8 item 23). These
  // genai `Part` fields have NO route in the kind-specific if-chain below.
  // Checked UNCONDITIONALLY, before that if-chain's early returns, because
  // `videoMetadata` normally rides ALONGSIDE an already-handled `inlineData`/
  // `fileData` part (genai's own doc: "should only be specified while the
  // video data is presented in inline_data or file_data") — a check placed
  // AFTER the if-chain would never see a sibling field on a part that already
  // matched a primary kind and returned. `audioTranscription` (genai 2.15.0)
  // is the same sibling situation: "Output only. The transcription of the
  // audio part" rides alongside the audio `inlineData` it transcribes. So is
  // `mediaProcessing` (genai 2.20.0): a request-side media-understanding hint
  // qualifying the `inlineData`/`fileData` part it rides beside. And
  // `speechMetadata` (genai 2.24.0): a request-side TTS {speaker?, style?}
  // hint that is "only valid when `Part.data` is set to `text`" — it rides
  // beside a text part, and the TEXT arm below returns early.
  // Mirrors `driveAdkTopLevel`'s `unmappedActions`/`unmappedEvent` carry
  // pattern (named-field ledger, not a generic reflection-over-keys
  // catch-all — fixture discipline: type/carry only what is verified on the
  // wire).
  const unmappedPartFields: { [k: string]: JsonValue } = {};
  if (part.mediaResolution !== undefined)
    unmappedPartFields["mediaResolution"] = JsonValue.parse(part.mediaResolution);
  if (part.videoMetadata !== undefined)
    unmappedPartFields["videoMetadata"] = JsonValue.parse(part.videoMetadata);
  if (part.toolCall !== undefined) unmappedPartFields["toolCall"] = JsonValue.parse(part.toolCall);
  if (part.toolResponse !== undefined)
    unmappedPartFields["toolResponse"] = JsonValue.parse(part.toolResponse);
  if (part.partMetadata !== undefined)
    unmappedPartFields["partMetadata"] = JsonValue.parse(part.partMetadata);
  if (part.audioTranscription !== undefined)
    unmappedPartFields["audioTranscription"] = JsonValue.parse(part.audioTranscription);
  if (part.mediaProcessing !== undefined)
    unmappedPartFields["mediaProcessing"] = JsonValue.parse(part.mediaProcessing);
  if (part.speechMetadata !== undefined)
    unmappedPartFields["speechMetadata"] = JsonValue.parse(part.speechMetadata);
  if (Object.keys(unmappedPartFields).length > 0) {
    a.contentBlock(messageId, {
      type: "provider-raw",
      vendor: "google",
      raw: JsonValue.parse(unmappedPartFields),
    });
  }

  // ── REASONING (thought:true) → reasoning.start/delta/end + opaque signature ──
  if (part.thought === true) {
    const id = mintBlockId(blockIds, "reasoning");
    a.reasoningStart(id, messageId);
    // typeof, not `!== undefined`: a JSON-null text is absent (null guard).
    if (typeof part.text === "string" && part.text.length > 0) a.reasoningDelta(id, messageId, part.text);
    a.reasoningEnd(id, messageId, { provider: "google" });
    if (part.thoughtSignature !== undefined && part.thoughtSignature.length > 0) {
      a.reasoningOpaque(id, messageId, {
        kind: "signature",
        value: part.thoughtSignature,
        provider: "google",
      });
    }
    return "";
  }

  // ── TEXT ──
  // A JSON-null text is ABSENT (null guard): it is not a text arm, so the part
  // falls through to the arms below (a functionCall beside it still maps), and
  // `null` never reaches textDelta or the streamed-text accumulator.
  if (typeof part.text === "string") {
    const id = mintBlockId(blockIds, "text");
    const signed = part.thoughtSignature !== undefined && part.thoughtSignature.length > 0;
    // STREAMED-text citations carrier (audit M22): `citations` collects ALL of this
    // event's groundingSupports segments (each already carries its own offsets +
    // sourceIds — see `mapGroundingCitations`) into ONE array attached at
    // text.end — never as per-segment id-less supplement blocks.
    if (signed) {
      // §8.8 — signature rides text.start/end providerMetadata via the sugar path
      // (audit B10/#118).
      const providerMetadata = AgProviderMeta.parse({
        google: { thoughtSignature: part.thoughtSignature },
      });
      a.textStart(id, messageId, { providerMetadata });
      a.textDelta(id, messageId, part.text);
      a.textEnd(id, messageId, { providerMetadata, ...(citations !== undefined ? { citations } : {}) });
    } else {
      a.textStart(id, messageId);
      a.textDelta(id, messageId, part.text);
      a.textEnd(id, messageId, citations !== undefined ? { citations } : undefined);
    }
    return part.text;
  }

  // ── FUNCTION CALL → tool.start + tool.args.delta + tool.args.assembled ──
  if (part.functionCall !== undefined) {
    if (!isJsonObject(part.functionCall)) {
      carryUnmappableArm(a, messageId, "functionCall", part.functionCall);
      return "";
    }
    const fc = part.functionCall;
    const realId = fc.id != null && fc.id.length > 0 ? fc.id : null;
    let toolCallId: string;
    if (realId !== null) {
      toolCallId = realId;
      if (_assembledToolCalls.has(toolCallId)) return ""; // dedup the partial:false aggregate re-send
      _assembledToolCalls.add(toolCallId);
    } else {
      // Null id (audit M47): mint a per-invoke-ordinal id, never a per-event
      // positional one. A content-identical occurrence still within the open
      // resend window's emitted budget (the aggregate re-send) is SUPPRESSED
      // — window-scoped multiset dedup, review finding-b (see the
      // `ToolCallMintState` doc above).
      const minted = mintNullIdCallId(mint, turnId, fc.name, fc.args, isPartial);
      if (minted.resend) return ""; // dedup the partial:false aggregate re-send (window-scoped content identity)
      toolCallId = minted.toolCallId;
    }
    const providerCallIndex = realId !== null ? undefined : index;
    // The reserved credential call's args carry the whole ADK AuthConfig: scrub
    // them to the allowlist (see scrubAdkAuthConfig) before they reach
    // tool.args.* and the folded tool-call block.
    const rawInput: JsonValue = JsonValue.parse(fc.args ?? {});
    const input: JsonValue = fc.name === ADK_REQUEST_CREDENTIAL ? scrubCredentialCallArgs(rawInput) : rawInput;
    const longRunning =
      event.longRunningToolIds !== undefined && event.longRunningToolIds.includes(toolCallId)
        ? true
        : undefined;
    a.toolStart({
      toolCallId,
      name: fc.name,
      index,
      longRunning,
      providerMetadata:
        providerCallIndex !== undefined
          ? AgProviderMeta.parse({ google: { providerCallIndex } })
          : undefined,
    });
    a.toolArgsDelta(toolCallId, JSON.stringify(input));
    a.toolArgsAssembled(toolCallId, input, {
      signature:
        part.thoughtSignature !== undefined && part.thoughtSignature.length > 0
          ? part.thoughtSignature
          : undefined,
    });
    return "";
  }

  // ── FUNCTION RESPONSE → tool.done ──
  if (part.functionResponse !== undefined) {
    if (!isJsonObject(part.functionResponse)) {
      carryUnmappableArm(a, messageId, "functionResponse", part.functionResponse);
      return "";
    }
    const fr = part.functionResponse;
    const realId = fr.id != null && fr.id.length > 0 ? fr.id : null;
    // Null id (audit M47): correlation was already resolved by `drive()`'s
    // event-scoped pre-pass (positional for a multi-response event, FIFO for
    // a lone one — review finding c-i/c-ii; see `consumeMintedCallId` doc).
    const toolCallId = realId ?? nullIdResponseIds.get(index);
    if (toolCallId === undefined) {
      // Orphan response (review finding c-iii): no pending mint exists under
      // this name. Minting a fresh id here would fabricate a dangling
      // tool.done with no matching tool.start — exactly the M47-review bug.
      // Carry the whole functionResponse losslessly instead (mirrors the
      // openai `late-*` ext precedents).
      // A reserved-credential answer takes the same allowlist here as on the
      // resolved arm below (see scrubAdkAuthConfig): the carry must not
      // bypass it. Only the id, the name and the scrubbed response ride.
      const carriedResponse: JsonValue =
        fr.name === ADK_REQUEST_CREDENTIAL
          ? (pickAllowed(JsonValue.parse(fr), { id: true, name: true, response: (v) => scrubbedResponse(v) }) ?? {})
          : JsonValue.parse(fr);
      a.emitExt("google", "unparsed", { functionResponse: carriedResponse, turnId });
      return "";
    }
    // A JSON-null response is absent (null guard): it was dereferenced below.
    const response = isJsonObject(fr.response) ? fr.response : undefined;
    // A reserved-credential answer carries the client's credential: its content
    // AND its classification use the allowlisted form (see scrubAdkAuthConfig),
    // so nothing omitted can resurface through errorText.
    const carried = fr.name === ADK_REQUEST_CREDENTIAL ? scrubbedResponse(fr.response) : response;
    a.toolDone({
      toolCallId,
      ...functionResponseToToolDoneFields(fr.name, carried),
      // adk-10 / SPEC §8.0 item 25: see classifyFunctionResponse.
      ...classifyFunctionResponse(carried, toolCallId, event.actions),
      turnId,
      providerMetadata:
        fr.thoughtSignature !== undefined && fr.thoughtSignature.length > 0
          ? AgProviderMeta.parse({ google: { thoughtSignature: fr.thoughtSignature } })
          : undefined,
    });
    return "";
  }

  // ── inlineData / executableCode / codeExecutionResult / fileData → content.block ──
  // The members these arms map to REQUIRED block fields are all OPTIONAL on
  // the genai types (Blob `mimeType?`/`data?`, ExecutableCode `code?`,
  // FileData `fileUri?` — doc-"Required" only; upstream adk #868 fixed the
  // same assumption for `code`). Each is typeof-guarded (never truthiness —
  // "" is a real value and maps exactly as before). When one is missing the
  // arm cannot become a schema-valid block (and inlineData used to THROW on
  // `mimeType.startsWith`), so the arm rides VERBATIM via
  // `carryUnmappableArm`'s provider-raw block instead — lossless, never a
  // fabricated value. Branch order is unchanged: the carry fires exactly
  // where the arm would otherwise have mapped. codeExecutionResult defaults
  // both of its optional members, so only a JSON-null arm needs the carry.
  if (part.inlineData !== undefined) {
    const mimeType = stringMember(part.inlineData, "mimeType");
    const data = stringMember(part.inlineData, "data");
    if (mimeType !== undefined && data !== undefined) {
      const displayName = stringMember(part.inlineData, "displayName");
      a.contentBlock(
        messageId,
        inlineDataBlock({ mimeType, data, ...(displayName !== undefined ? { displayName } : {}) }),
      );
    } else {
      carryUnmappableArm(a, messageId, "inlineData", part.inlineData);
    }
    return "";
  }
  if (part.executableCode !== undefined) {
    const code = stringMember(part.executableCode, "code");
    if (code !== undefined) {
      a.contentBlock(messageId, {
        type: "code",
        // stringMember: a JSON-null language is absent → "python" (null guard;
        // it was `null.toLowerCase()`).
        language: codeLanguage(stringMember(part.executableCode, "language")),
        code,
      });
    } else {
      carryUnmappableArm(a, messageId, "executableCode", part.executableCode);
    }
    return "";
  }
  if (part.codeExecutionResult !== undefined) {
    // Null guard: a JSON-null arm rides provider-raw (it was dereferenced);
    // a null or non-string member is absent and takes its existing default.
    if (isJsonObject(part.codeExecutionResult)) {
      a.contentBlock(messageId, {
        type: "code-result",
        outcome: codeOutcome(stringMember(part.codeExecutionResult, "outcome")),
        output: stringMember(part.codeExecutionResult, "output") ?? "",
      });
    } else {
      carryUnmappableArm(a, messageId, "codeExecutionResult", part.codeExecutionResult);
    }
    return "";
  }
  if (part.fileData !== undefined) {
    const fileUri = stringMember(part.fileData, "fileUri");
    if (fileUri !== undefined) {
      a.contentBlock(messageId, {
        type: "resource-link",
        uri: fileUri,
        // stringMember: a JSON-null mimeType is absent (null guard; it rode
        // the block as `null`, which the schema rejects).
        mimeType: stringMember(part.fileData, "mimeType"),
      });
      // genai 2.24.0 FileData.displayName: resource-link has no name slot
      // (SPEC §2), so it rides a sibling provider-raw keyed by the wire path.
      // Absent ⇒ byte-identical. (Spec R&D item 5 would map it to an MCP
      // `name` if protocol adds one.)
      const displayName = stringMember(part.fileData, "displayName");
      if (displayName !== undefined) {
        a.contentBlock(messageId, {
          type: "provider-raw",
          vendor: "google",
          raw: { fileData: { displayName } },
        });
      }
    } else {
      carryUnmappableArm(a, messageId, "fileData", part.fileData);
    }
    return "";
  }

  return "";
}

// ─── ADK AuthConfig → flat AgAuthConfig view (SPEC §8.0 item 12) ─────────────
// ADK's AuthConfig (@google/adk 2.1.0 dist/types/auth/auth_tool.d.ts:12-42) is
// `{ authScheme, rawAuthCredential?, exchangedAuthCredential?, credentialKey }`,
// with authScheme an OpenAPI v3 SecuritySchemeObject or OIDC-with-config
// (auth_schemes.d.ts:12, :25). The view maps ONLY what has a native value:
// - scheme ← authScheme.type, verbatim; no string type → no view at all (the
//   field is required and never invented);
// - authorizationUrl / tokenUrl / scopes follow ADK's own derivation
//   (dist/esm/auth/auth_handler.js:112-128): OIDC-with-config's
//   authorizationEndpoint / tokenEndpoint / scopes; for oauth2, the first
//   present flow of implicit > authorizationCode > clientCredentials >
//   password, with scopes = the keys of its OpenAPI scopes map;
// - clientId / audience ← rawAuthCredential.oauth2 (auth_credential.d.ts:35-62).
// credentialKey, secrets and exchange state never enter the view.
// ─── ADK auth objects: carry only members known to be non-secret ─────────────
// An ADK AuthConfig, and the credential objects inside it, can hold credential
// material. Anything the facet forwards is persisted by hosts (hitl.ask →
// turn.done paused asks[]; tool-call blocks). So every carrier of an ADK auth
// object is an ALLOWLIST: a member is forwarded only when it is known to be
// non-secret, and every other member, at any depth, is omitted. The list is
// checked against @google/adk 2.1.0 dist/types/auth/auth_tool.d.ts and
// auth_credential.d.ts. Keys match in camelCase or snake_case (the reserved
// call's args arrive snake_case at the top level); a kept key keeps its wire
// spelling.
//
// Resume safety (ADK 2.1.0, a tool's credential request inside an LlmAgent):
// the credential resume rebuilds the request
// server-side from the session's own reserved call (auth_preprocessor.js
// requestedAuthConfigs) and takes only the auth code / response URI from the
// client's answer (credential_response_binding.js bindCredential; the raw
// credential is restored from the request). An oauth2/OIDC request always
// carries a generated authUri (auth_handler.js generateAuthRequest). So what
// the allowlist omits is never needed to answer the ask.
const ADK_REQUEST_CREDENTIAL = "adk_request_credential";

type AllowSpec = { [key: string]: true | ((v: JsonValue) => JsonValue | undefined) };

function snakeKey(k: string): string {
  return k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Copy only the allowlisted members of `v` (camel or snake spelling), each
 *  either verbatim (`true`) or through its nested allowlist. */
function pickAllowed(v: JsonValue | undefined, spec: AllowSpec): JsonValue | undefined {
  if (!isJsonObject(v)) return undefined;
  const out: { [k: string]: JsonValue } = {};
  for (const [name, rule] of Object.entries(spec)) {
    for (const key of name === snakeKey(name) ? [name] : [name, snakeKey(name)]) {
      if (!Object.hasOwn(v, key)) continue;
      const member = v[key];
      if (member === undefined) continue;
      const kept = rule === true ? member : rule(member);
      if (kept !== undefined) out[key] = kept;
    }
  }
  return out;
}

const OAUTH2_ALLOW: AllowSpec = {
  clientId: true,
  authUri: true,
  redirectUri: true,
  scopes: true,
  codeChallengeMethod: true,
  tokenEndpointAuthMethod: true,
  expiresAt: true,
  expiresIn: true,
  audience: true,
};
const SERVICE_ACCOUNT_ALLOW: AllowSpec = {
  scopes: true,
  useDefaultCredential: true,
  useIdToken: true,
  audience: true,
  serviceAccountCredential: (v) =>
    pickAllowed(v, { projectId: true, clientEmail: true, tokenUri: true, universeDomain: true }),
};
const AUTH_CREDENTIAL_ALLOW: AllowSpec = {
  authType: true,
  resourceRef: true,
  oauth2: (v) => pickAllowed(v, OAUTH2_ALLOW),
  serviceAccount: (v) => pickAllowed(v, SERVICE_ACCOUNT_ALLOW),
};
// The security scheme, member by member: an OpenAPI 3.0 SecuritySchemeObject
// (openapi-types 12.1.3 OpenAPIV3: http, apiKey, oauth2 and openIdConnect,
// the type @google/adk 2.1.0's auth_schemes.d.ts names) or ADK's
// OpenIdConnectWithConfig. Every leaf is a string, a string list or a map of
// strings, and only those survive. A scheme member no type declares (a vendor
// extension, a stray field) never rides.
const schemeString = (v: JsonValue): JsonValue | undefined => (typeof v === "string" ? v : undefined);
const schemeStringList = (v: JsonValue): JsonValue | undefined =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined;
/** A map this facet rebuilds from native entries never carries an own
 *  `__proto__` key (SPEC §13.7): JsonValue.parse drops one, and
 *  Object.fromEntries would re-create it as an own property. */
function isReservedMapKey(k: string): boolean {
  return k === "__proto__";
}
/** OAuth2 flow scopes are a map of scope name -> description; OIDC config
 *  scopes are a list. Either keeps only its string entries. */
const schemeScopes = (v: JsonValue): JsonValue | undefined =>
  Array.isArray(v)
    ? schemeStringList(v)
    : isJsonObject(v)
      ? Object.fromEntries(
          Object.entries(v).filter((e): e is [string, string] => !isReservedMapKey(e[0]) && typeof e[1] === "string"),
        )
      : undefined;
const OAUTH2_FLOW_ALLOW: AllowSpec = {
  authorizationUrl: schemeString,
  tokenUrl: schemeString,
  refreshUrl: schemeString,
  scopes: schemeScopes,
};
const AUTH_SCHEME_ALLOW: AllowSpec = {
  type: schemeString,
  description: schemeString,
  // http
  scheme: schemeString,
  bearerFormat: schemeString,
  // apiKey (the header/query parameter's name and location, never its value)
  name: schemeString,
  in: schemeString,
  // oauth2 (flows.password is the password-GRANT flow: a tokenUrl and scopes)
  flows: (v) =>
    pickAllowed(v, {
      implicit: (f) => pickAllowed(f, OAUTH2_FLOW_ALLOW),
      password: (f) => pickAllowed(f, OAUTH2_FLOW_ALLOW),
      clientCredentials: (f) => pickAllowed(f, OAUTH2_FLOW_ALLOW),
      authorizationCode: (f) => pickAllowed(f, OAUTH2_FLOW_ALLOW),
    }),
  // openIdConnect
  openIdConnectUrl: schemeString,
  // OpenIdConnectWithConfig
  authorizationEndpoint: schemeString,
  tokenEndpoint: schemeString,
  userinfoEndpoint: schemeString,
  revocationEndpoint: schemeString,
  tokenEndpointAuthMethodsSupported: schemeStringList,
  grantTypesSupported: schemeStringList,
  scopes: schemeScopes,
};
const AUTH_CONFIG_ALLOW: AllowSpec = {
  authScheme: (v) => pickAllowed(v, AUTH_SCHEME_ALLOW),
  credentialKey: true,
  rawAuthCredential: (v) => pickAllowed(v, AUTH_CREDENTIAL_ALLOW),
  exchangedAuthCredential: (v) => pickAllowed(v, AUTH_CREDENTIAL_ALLOW),
};

// ─── shared state (state.delta) ──────────────────────────────────────────────
// ADK itself writes an exchanged AuthCredential into the event's
// actions.stateDelta on two paths (@google/adk 2.1.0):
// - a Runner configured with SessionStateCredentialService saves it under the
//   bare credentialKey (session_state_credential_service.js; ToolContext's
//   State writes value AND delta, agents/context.js:37-39, sessions/state.js:97-102);
// - a Workflow FunctionNode whose auth step runs again on resume stores it
//   under "temp:" + credentialKey (auth_handler.js:35-38, :47), and function_node.js
//   copies every new delta entry into the event it yields (:93-127). A Runner
//   removes "temp:" entries from a non-partial event as it appends it to the
//   session, before yielding it; a partial event, or an event read before
//   that append, still carries them.
// ADK treats any value under the key as a stored credential
// (hitl_utils.js:131-133), so the entry is omitted whole: a redacted value left
// behind would read as a credential. Every "temp:" entry is omitted too
// (invocation-scoped by ADK's contract). Every other entry rides unchanged.
const ADK_TEMP_STATE_PREFIX = "temp:";
const AUTH_CREDENTIAL_TYPES: ReadonlySet<string> = new Set(["apiKey", "http", "oauth2", "openIdConnect", "serviceAccount"]);
// resourceRef (auth_credential.d.ts:244) names a stored credential: ADK's
// presence readers treat an object holding it as a held credential.
const AUTH_CREDENTIAL_MEMBERS = [
  "apiKey",
  "api_key",
  "http",
  "oauth2",
  "serviceAccount",
  "service_account",
  "resourceRef",
  "resource_ref",
] as const;

function isObjectRecord(v: unknown): v is { readonly [k: string]: unknown } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** An ADK AuthCredential: `authType` (either spelling) is one of ADK's
 *  credential types (auth_credential.d.ts) and a credential member is present
 *  and non-null. */
function isAuthCredentialObject(v: { readonly [k: string]: unknown }): boolean {
  const typed = ["authType", "auth_type"].some((k) => {
    const t = Object.hasOwn(v, k) ? v[k] : undefined;
    return typeof t === "string" && AUTH_CREDENTIAL_TYPES.has(t);
  });
  return typed && AUTH_CREDENTIAL_MEMBERS.some((m) => Object.hasOwn(v, m) && v[m] !== null && v[m] !== undefined);
}

/** Whether `v` is, or holds at any depth (arrays included), an ADK
 *  AuthCredential. Iterative and cycle-safe over the raw native value; a value
 *  that cannot be walked counts as holding one, so this never throws. */
function holdsAuthCredential(v: unknown): boolean {
  return holdsObject(v, isAuthCredentialObject);
}

/** Whether `v` is, or holds at any depth (arrays included), an object `match`
 *  accepts. Iterative and cycle-safe over the raw native value; a value that
 *  cannot be walked counts as holding one, so this never throws. */
function holdsObject(v: unknown, match: (o: { readonly [k: string]: unknown }) => boolean): boolean {
  try {
    const seen = new Set<object>();
    const stack: unknown[] = [v];
    while (stack.length > 0) {
      const x = stack.pop();
      if (x === null || typeof x !== "object" || seen.has(x)) continue;
      seen.add(x);
      if (Array.isArray(x)) {
        for (const y of x) stack.push(y);
      } else if (isObjectRecord(x)) {
        if (match(x)) return true;
        for (const k of Object.keys(x)) stack.push(x[k]);
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** The state map ADK yields, minus its "temp:" entries and every entry that
 *  holds an ADK AuthCredential, in the original key order. A map with none of
 *  those is carried exactly as before. When entries were omitted, a remaining
 *  entry that is not JSON is dropped rather than thrown on, since a throw would
 *  hand the raw native event to the host's error path. A value that is not a
 *  map is carried as before, or as {} if it holds a credential. */
function scrubStateMap(raw: unknown): JsonValue {
  if (!isObjectRecord(raw)) return holdsAuthCredential(raw) ? {} : JsonValue.parse(raw);
  const keys = Object.keys(raw);
  const omitted = keys.map((k) => k.startsWith(ADK_TEMP_STATE_PREFIX) || holdsAuthCredential(raw[k]));
  if (!omitted.includes(true)) return JsonValue.parse(raw);
  const kept: [string, JsonValue][] = [];
  keys.forEach((k, i) => {
    if (omitted[i] === true || isReservedMapKey(k)) return;
    const parsed = JsonValue.safeParse(raw[k]);
    if (parsed.success) kept.push([k, parsed.data]);
  });
  return Object.fromEntries(kept);
}

/** The ADK AuthConfig reduced to its non-secret members ({} for a non-object). */
function scrubAdkAuthConfig(native: JsonValue): JsonValue {
  return pickAllowed(native, AUTH_CONFIG_ALLOW) ?? {};
}

/** A reserved-credential functionResponse (the client's answer) scrubbed the
 *  same way; undefined when the response is not an object. */
function scrubbedResponse(response: unknown): { readonly [k: string]: JsonValue } | undefined {
  if (!isJsonObject(response)) return undefined;
  const scrubbed = scrubAdkAuthConfig(response);
  return isJsonObject(scrubbed) ? scrubbed : undefined;
}

// ─── provider-raw carries of node data ───────────────────────────────────────
// A Workflow event's `output` and `actions.agentState` ride verbatim in
// provider-raw. Inside them, each ADK AuthCredential (detected as for shared
// state) is reduced to its allowlisted members, and each response named
// adk_request_credential (matched by that name at any depth, never by id)
// keeps only its id, its name and the reserved-credential answer's
// allowlisted response, so an untyped reply becomes {}. Every other member
// rides unchanged. A value with neither is parsed exactly as before; a value
// that cannot be walked or reduced is omitted, never thrown on.

/** A response named adk_request_credential (a functionResponse object). */
function isCredentialRequestResponse(v: { readonly [k: string]: unknown }): boolean {
  return v["name"] === ADK_REQUEST_CREDENTIAL && Object.hasOwn(v, "name") && Object.hasOwn(v, "response");
}

/** One JSON value with every credential object and credential-request
 *  response reduced (see above); recursion stops at a reduced unit. */
function reduceCredentialCarry(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(reduceCredentialCarry);
  if (!isJsonObject(v)) return v;
  if (isAuthCredentialObject(v)) return pickAllowed(v, AUTH_CREDENTIAL_ALLOW) ?? {};
  if (isCredentialRequestResponse(v))
    return pickAllowed(v, { id: true, name: true, response: (r) => scrubbedResponse(r) }) ?? {};
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => !isReservedMapKey(k))
      .map(([k, x]): [string, JsonValue] => [k, reduceCredentialCarry(x)]),
  );
}

/** JSON with object keys in sorted order: "did the reduction change it"
 *  compares members, not the order an allowlist writes them in. */
function canonicalJson(v: JsonValue): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (!isJsonObject(v)) return JSON.stringify(v);
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k] ?? null)}`)
    .join(",")}}`;
}

/** A node-data value for a provider-raw carry. `changed` says whether the
 *  reduction altered it; `undefined` omits the unit. */
function carryNodeValue(raw: unknown): { value: JsonValue; changed: boolean } | undefined {
  if (!holdsAuthCredential(raw) && !holdsObject(raw, isCredentialRequestResponse))
    return { value: JsonValue.parse(raw), changed: false };
  try {
    const before = JsonValue.parse(JSON.parse(JSON.stringify(raw)));
    const value = reduceCredentialCarry(before);
    return { value, changed: canonicalJson(value) !== canonicalJson(before) };
  } catch {
    return undefined;
  }
}

/** JSON.stringify of a raw `output` whose node-data reduction changed or
 *  omitted it: the text ADK renders from that output. `undefined` otherwise
 *  (including a string output, which ADK renders as itself). */
function changedOutputRendering(output: unknown): string | undefined {
  if (output === undefined || output === null || typeof output !== "object") return undefined;
  // Detection first, so an output holding neither is never parsed here.
  if (!holdsAuthCredential(output) && !holdsObject(output, isCredentialRequestResponse)) return undefined;
  const carried = carryNodeValue(output);
  if (carried !== undefined && !carried.changed) return undefined;
  try {
    const rendered: unknown = JSON.stringify(output);
    return typeof rendered === "string" ? rendered : undefined;
  } catch {
    return undefined;
  }
}

/** The reserved credential call's args: its id, its message and the scrubbed
 *  AuthConfig. Nothing else is forwarded. */
function scrubCredentialCallArgs(args: JsonValue): JsonValue {
  return (
    pickAllowed(args, {
      functionCallId: true,
      message: true,
      authConfig: (v) => scrubAdkAuthConfig(v),
    }) ?? {}
  );
}

function adkAuthConfigView(native: JsonValue): AgAuthConfig | undefined {
  if (!isJsonObject(native)) return undefined;
  const authScheme = native["authScheme"];
  const scheme = stringMember(authScheme, "type");
  if (scheme === undefined || !isJsonObject(authScheme)) return undefined;
  let authorizationUrl: string | undefined;
  let tokenUrl: string | undefined;
  let scopes: string[] | undefined;
  if ("authorizationEndpoint" in authScheme) {
    authorizationUrl = stringMember(authScheme, "authorizationEndpoint");
    tokenUrl = stringMember(authScheme, "tokenEndpoint");
    const s = authScheme["scopes"];
    if (Array.isArray(s)) scopes = s.filter((x): x is string => typeof x === "string");
  } else if (scheme === "oauth2") {
    const flows = authScheme["flows"];
    const flow = isJsonObject(flows)
      ? [flows["implicit"], flows["authorizationCode"], flows["clientCredentials"], flows["password"]].find(
          isJsonObject,
        )
      : undefined;
    if (flow !== undefined) {
      authorizationUrl = stringMember(flow, "authorizationUrl");
      tokenUrl = stringMember(flow, "tokenUrl");
      const s = flow["scopes"];
      if (isJsonObject(s)) scopes = Object.keys(s);
    }
  }
  const raw = native["rawAuthCredential"];
  const oauth2 = isJsonObject(raw) ? raw["oauth2"] : undefined;
  const clientId = stringMember(oauth2, "clientId");
  const audience = stringMember(oauth2, "audience");
  return {
    scheme,
    ...(scopes !== undefined ? { scopes } : {}),
    ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
    ...(tokenUrl !== undefined ? { tokenUrl } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(audience !== undefined ? { audience } : {}),
  };
}

/** Append `ask` to the turn's pending-asks list (creating it on first use).
 *  Preserves emission order — asks accumulate in the order their originating
 *  hitl.ask events were emitted, which `maybeCloseTurn` folds verbatim into
 *  `turn.done.outcome.paused.asks[]` (audit M26). */
function trackPendingAsk(
  pendingAsks: Map<string, AgPausedAsk[]>,
  turnId: string,
  ask: AgPausedAsk
): void {
  const existing = pendingAsks.get(turnId);
  if (existing !== undefined) existing.push(ask);
  else pendingAsks.set(turnId, [ask]);
}

function driveAdkTopLevel(
  a: StreamAssembler,
  event: AdkEvent,
  messageId: string,
  turnId: string,
  closedTurns: Set<string>,
  pendingAsks: Map<string, AgPausedAsk[]>,
  reserved: ReservedAskState
): void {
  // typeof: a JSON-null transcription text is absent (null guard; it rode the
  // text block as `null`, which the schema rejects).
  if (typeof event.inputTranscription?.text === "string") {
    a.contentBlock(messageId, {
      type: "text",
      text: event.inputTranscription.text,
      _meta: { "agjson/transcription": { role: "input", kind: "transcription" } },
    });
  }
  if (typeof event.outputTranscription?.text === "string") {
    a.contentBlock(messageId, {
      type: "text",
      text: event.outputTranscription.text,
      _meta: { "agjson/transcription": { role: "output", kind: "transcription" } },
    });
  }

  // ── interrupted → turn.abort ──
  // Mark the turn closed in the FACET's own bookkeeping too (audit M21): without
  // this, `maybeCloseTurn`'s is_final_response path or `flush()` would later
  // fabricate a success `turn.done` for a turn that already aborted — the
  // self-contradiction the audit found.
  if (event.interrupted === true) {
    a.emit({ type: "turn.abort", reason: "interrupted" });
    closedTurns.add(turnId);
  }

  // ── promptFeedback → prompt.blocked ──
  if (event.promptFeedback?.blockReason !== undefined) {
    const reason = mapBlockReason(event.promptFeedback.blockReason);
    const safety =
      event.promptFeedback.safetyRatings !== undefined
        ? event.promptFeedback.safetyRatings
            .filter((r): r is typeof r & { category: string } => r.category !== undefined)
            .map((r) => ({
              category: r.category,
              probability: r.probability,
              score: r.score,
              blocked: r.blocked,
            }))
        : undefined;
    a.emit({ type: "prompt.blocked", reason, ...(safety !== undefined ? { safety } : {}) });
  }

  // ── groundingMetadata → source + display.required ──────────────────────────
  // groundingSupports (per-segment citations) are handled BEFORE this function
  // runs — collected by `mapGroundingCitations` and attached to the streamed text
  // block's `text.end.citations` in `drive()`/`driveAdkPart` (audit M22: was N
  // id-less per-segment supplement blocks, one per grounding segment).
  if (event.groundingMetadata !== undefined) {
    const gm = event.groundingMetadata;
    if (gm.groundingChunks !== undefined) {
      gm.groundingChunks.forEach((chunk, chunkIndex) => {
        if (chunk.web?.uri !== undefined) {
          a.emit({
            type: "source",
            sourceId: `grounding_${chunkIndex}`,
            source: { url: chunk.web.uri, title: chunk.web.title },
          });
        }
      });
    }
    if (gm.searchEntryPoint?.renderedContent !== undefined) {
      a.emit({
        type: "display.required",
        provider: "google",
        html: gm.searchEntryPoint.renderedContent,
      });
    }
  }

  // ── ADK pause family → hitl.ask (SPEC §8.0 item 26, draft.4; R&D item 6) ──
  // An ADK pause is a functionCall named adk_request_input,
  // adk_request_credential or adk_request_confirmation. Each yields ONE ask:
  // toolCallId = the reserved call's id (the id ADK accepts as the answer),
  // resumeBinding "id", and the ORIGINAL tool-call id (when the call names
  // one) in metadata.originalFunctionCallId. When items 12/18 surface the
  // same request (actions keyed by the original id), the reserved call's ask is
  // the one: the original id is recorded, and those loops skip it. On the real
  // engine the reserved call arrives before, or on the same event as, those
  // actions. Deduped by id across the partial/aggregate re-send. The reserved
  // call's own tool.start still opens (suppressing it is an unwalked decision).
  if (event.partial !== true) {
    for (const part of event.content?.parts ?? []) {
      const fc = part.functionCall;
      if (!isJsonObject(fc)) continue;
      const name = fc["name"];
      if (name !== ADK_REQUEST_INPUT && name !== ADK_REQUEST_CREDENTIAL && name !== ADK_REQUEST_CONFIRMATION)
        continue;
      const callId = stringMember(fc, "id");
      if (callId === undefined || callId.length === 0 || reserved.asked.has(callId)) continue;
      reserved.asked.add(callId);
      const args = isJsonObject(fc["args"]) ? fc["args"] : {};
      const { ask, originalId } = reservedCallAsk(name, callId, args);
      if (originalId !== undefined) {
        const originals = reserved.originalsByTurn.get(turnId) ?? new Set<string>();
        originals.add(originalId);
        reserved.originalsByTurn.set(turnId, originals);
      }
      a.emit({ type: "hitl.ask", ...ask });
      trackPendingAsk(pendingAsks, turnId, ask);
    }
  }
  const askedOriginals = reserved.originalsByTurn.get(turnId);

  // ── actions → handoff / hitl.ask / state.delta / provider-raw bag ──
  const actions = event.actions;
  if (actions !== undefined) {
    if (actions.transferToAgent !== undefined) {
      a.emit({ type: "handoff", kind: "transfer", toAgentName: actions.transferToAgent });
    }
    if (actions.escalate === true) a.emit({ type: "handoff", kind: "escalate" });
    if (actions.requestedAuthConfigs !== undefined) {
      // ADK dict[str, AuthConfig] keyed by function-call-id (SPEC §8.0 item 12).
      // `authConfig` is the flat AgAuthConfig VIEW derived by
      // `adkAuthConfigView` (absent when no string scheme exists), and
      // `metadata.authConfig` carries the native AuthConfig through the
      // allowlist (scrubAdkAuthConfig). A request the reserved
      // adk_request_credential call already asked for (item 26) yields no
      // second ask. The SAME ask fields are tracked in `pendingAsks`: if this
      // turn's close-path event turns out to be THIS event (or a later one for
      // the same turnId), `maybeCloseTurn` folds them into
      // `turn.done.outcome.paused.asks[]` instead of fabricating success
      // (audit M26).
      for (const [callId, authConfig] of Object.entries(actions.requestedAuthConfigs)) {
        if (askedOriginals?.has(callId) === true) continue;
        const view = adkAuthConfigView(authConfig);
        const ask: AgPausedAsk = {
          askId: `auth_${callId}`,
          kind: "auth",
          toolCallId: callId,
          ...(view !== undefined ? { authConfig: view } : {}),
          metadata: { authConfig: scrubAdkAuthConfig(JsonValue.parse(authConfig)) },
        };
        a.emit({ type: "hitl.ask", ...ask });
        trackPendingAsk(pendingAsks, turnId, ask);
      }
    }
    if (actions.requestedToolConfirmations !== undefined) {
      // ADK dict[str, ToolConfirmation] keyed by function-call-id. `hint` maps to
      // `message`; `confirmed`/`payload` ride opaque in `metadata` (SPEC §8 item
      // 18). Tracked in `pendingAsks` for the same paused-close fold as above.
      for (const [callId, conf] of Object.entries(actions.requestedToolConfirmations)) {
        // Asked already by the reserved adk_request_confirmation call (item 26).
        if (askedOriginals?.has(callId) === true) continue;
        const metadata: { [k: string]: JsonValue } = {};
        if (conf.confirmed !== undefined) metadata["confirmed"] = conf.confirmed;
        if (conf.payload !== undefined) metadata["payload"] = JsonValue.parse(conf.payload);
        const ask: AgPausedAsk = {
          askId: `approval_${callId}`,
          kind: "approval",
          toolCallId: callId,
          ...(conf.hint !== undefined ? { message: conf.hint } : {}),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        };
        a.emit({ type: "hitl.ask", ...ask });
        trackPendingAsk(pendingAsks, turnId, ask);
      }
    }
    // One state.delta per native state change, partial events included; see
    // scrubStateMap for the entries it omits ({} when none remain).
    if (actions.stateDelta !== undefined)
      a.emit({ type: "state.delta", patch: scrubStateMap(actions.stateDelta) });

    const unmappedActions: { [k: string]: JsonValue } = {};
    if (actions.artifactDelta !== undefined)
      unmappedActions["artifactDelta"] = JsonValue.parse(actions.artifactDelta);
    if (actions.renderUiWidgets !== undefined)
      unmappedActions["renderUiWidgets"] = JsonValue.parse(actions.renderUiWidgets);
    // agentState is an OBJECT on the official 2.0.0 EventActions (a
    // resumable-checkpoint snapshot, e.g. `{ input }`), a string on the older
    // hand-typed contract — JsonValue.parse at the boundary carries either.
    if (actions.agentState !== undefined) {
      const carried = carryNodeValue(actions.agentState);
      if (carried !== undefined) unmappedActions["agentState"] = carried.value;
    }
    if (actions.endOfAgent !== undefined) unmappedActions["endOfAgent"] = actions.endOfAgent;
    if (Object.keys(unmappedActions).length > 0) {
      a.contentBlock(messageId, {
        type: "provider-raw",
        vendor: "google",
        raw: JsonValue.parse(unmappedActions),
      });
    }
  }

  // ── event-level unmapped (citationMetadata / customMetadata / candidateIndex /
  // branch / modelVersion / interactionId / the CompactedEvent subtype
  // projection isCompacted+startTime+endTime+compactedContent+isScratchpad /
  // the 2.0.0 workflow-plane quartet output+route+nodeInfo+isolationScope) →
  // provider-raw ──
  // candidateIndex/branch are fixture-drift ratchet findings (google-adk-ratchet
  // task; SPEC §8 item 23): candidateIndex was entirely absent from the
  // AdkEvent contract; branch was ALREADY typed but never read anywhere in
  // drive()/driveAdkTopLevel. modelVersion joined on the official-SDK retarget
  // (2026-07-13): a genuinely-optional `@google/adk` 1.3.0 `LlmResponse` field
  // absent from `@iqai/adk`'s surface, closed by the same opportunistic-carry
  // precedent (absent from all recorded fixtures — no golden-snapshot impact).
  //
  // `author`/`timestamp` are ALSO real, currently-unread AdkEvent fields
  // (same manifest inventory) but are DELIBERATELY NOT folded into this bag.
  // On the official `@google/adk` 1.3.0 `Event` interface `timestamp: number`
  // is REQUIRED and `author?: string` is optional in the TYPE — but the
  // runner sets author on every event it appends in practice, so the
  // original empirical point stands unchanged: folding either into this
  // carry fired a provider-raw content.block on every single native event in
  // packages/e2e's captured adk fixtures (author:"spike" is set on all 5
  // events of both corpus scenarios), breaking the recorded golden
  // `*.agjson.json` snapshots AND the cross-framework convergence assertions
  // (adk's sequence gained content.block noise claude/openai's equivalent
  // streams don't have) — regenerating those cassette fixtures is outside
  // this ratchet's boundary (facet + manifests + script + SPEC §8 only).
  // Disposed honestly as `silently-dropped` in sdk-surface.json rather than
  // landed here; a more precise, non-noisy home (e.g. an agent-identity
  // field on message.start for `author`, or the SPEC.md-sanctioned
  // `_meta.timestamp` bare-key for `timestamp`) is a future spec-process
  // decision, not a mechanical carry.
  const unmappedEvent: { [k: string]: JsonValue } = {};
  if (event.candidateIndex !== undefined) unmappedEvent["candidateIndex"] = event.candidateIndex;
  if (event.branch !== undefined) unmappedEvent["branch"] = event.branch;
  if (event.modelVersion !== undefined) unmappedEvent["modelVersion"] = event.modelVersion;
  if (event.interactionId !== undefined) unmappedEvent["interactionId"] = event.interactionId;
  // CompactedEvent subtype projection (1.5.0 peer bump; see the AdkEvent
  // field docs): never on the runAsync boundary — session-replay tolerance
  // only, so it can never fire on live-captured wire. `isScratchpad`
  // present-checks (never truthiness) so an explicit `false` still rides.
  if (event.isCompacted !== undefined) unmappedEvent["isCompacted"] = event.isCompacted;
  if (event.startTime !== undefined) unmappedEvent["startTime"] = event.startTime;
  if (event.endTime !== undefined) unmappedEvent["endTime"] = event.endTime;
  if (event.compactedContent !== undefined)
    unmappedEvent["compactedContent"] = event.compactedContent;
  if (event.isScratchpad !== undefined) unmappedEvent["isScratchpad"] = event.isScratchpad;
  // Workflow-plane quartet (2.0.0 peer bump; see the AdkEvent field docs):
  // stamped only by dist/esm/workflow/* (and round-tripped by the Vertex
  // session service); a plain LlmAgent runAsync stream carries it only via a
  // NodeTool. It fires on every Workflow invoke (the e2e workflow capture
  // agent, observed offline on the real 2.1.0 engine). Present-checks
  // throughout (`route` may legitimately be `false`/`0`; `output` may be any
  // JSON value incl. null); `nodeInfo` rides as a WHOLE object. `nodeInfo` is
  // also READ by maybeCloseTurn's per-event gate and by isAdkPauseEnd.
  if (event.output !== undefined) {
    const carried = carryNodeValue(event.output);
    if (carried !== undefined) unmappedEvent["output"] = carried.value;
  }
  if (event.route !== undefined) unmappedEvent["route"] = JsonValue.parse(event.route);
  if (event.nodeInfo !== undefined) unmappedEvent["nodeInfo"] = JsonValue.parse(event.nodeInfo);
  if (event.isolationScope !== undefined)
    unmappedEvent["isolationScope"] = JsonValue.parse(event.isolationScope);
  if (event.citationMetadata !== undefined)
    unmappedEvent["citationMetadata"] = JsonValue.parse(event.citationMetadata);
  if (event.customMetadata !== undefined)
    unmappedEvent["customMetadata"] = JsonValue.parse(event.customMetadata);
  if (Object.keys(unmappedEvent).length > 0) {
    a.contentBlock(messageId, {
      type: "provider-raw",
      vendor: "google",
      raw: JsonValue.parse(unmappedEvent),
    });
  }
}

// ─── stateful factory: createAdkNormalizer ────────────────────────────────────
/** Options for {@link createAdkNormalizer}. */
export interface AdkNormalizerOptions {
  /**
   * Opt in to SPEC §8.0 host obligation 4 (draft.4): the host feeds
   * `{ type: "__host_complete__" }` after the ADK run returned NORMALLY (never
   * after a cancel, an abort signal or a thrown error), before `flush()`.
   * Then a success close waits for that event (so a Workflow, a
   * SequentialAgent or after-agent callback content can follow a node's final
   * text), and on it each still-open turn closes: `paused` if an ask is
   * pending, left to `flush()` if a non-HITL long-running call is unanswered,
   * else `success`. Default off: the step-1 behaviour.
   */
  hostCompletion?: boolean;
}

/** The facet-local host-completion native (§8.0 host obligation 4). */
export const ADK_HOST_COMPLETE_TYPE = "__host_complete__";

/** Exactly `{ type: "__host_complete__" }` (one key), as recorded by a capture harness. */
function isHostCompleteNative(v: JsonValue): boolean {
  return isJsonObject(v) && v["type"] === ADK_HOST_COMPLETE_TYPE && Object.keys(v).length === 1;
}

export function createAdkNormalizer(options: AdkNormalizerOptions = {}): Normalizer {
  const hostCompletion = options.hostCompletion === true;
  const a = new StreamAssembler();
  const threadId = "google";
  // §8.3 per-instance accumulator (replaces the module-level streamedText Map):
  const streamedText = new Map<string, string>();
  const openTurns = new Set<string>();
  const closedTurns = new Set<string>();
  // Per-turn usageMetadata accumulator (2026-07-13, echo-gemini35 live-capture
  // finding): ADK usageMetadata is PER-LLM-CALL and one ADK turn spans EVERY
  // round of the invocation (turnKey = invocationId) — reading only the
  // closing event's usageMetadata dropped every intermediate round's tokens
  // (the live tool round's promptTokenCount/candidatesTokenCount AND its
  // thoughtsTokenCount vanished from turn.done; census Rule 1 caught the
  // transforms-registered thoughtsTokenCount target never landing). Summed
  // over the turn's NON-PARTIAL events only: the partial:true stream and its
  // partial:false aggregate re-send carry the SAME per-round usage (§8.3's
  // double-render quirk applies to usage too), so counting non-partial
  // events counts each round exactly once.
  const usageByTurn = new Map<string, NonNullable<AdkEvent["usageMetadata"]>>();
  // Per-turn HITL asks emitted by the two `actions.requested*` arms (audit
  // M26) — populated in emission order by `trackPendingAsk` inside
  // `driveAdkTopLevel`. Consulted ONLY by `maybeCloseTurn`'s REAL close path
  // (the is_final_response aggregate); the `flush()` truncation path never
  // reads it — see the comment there.
  const pendingAsks = new Map<string, AgPausedAsk[]>();
  // Pause-family bookkeeping (item 26): reserved-call ids already asked, and the
  // original tool-call ids their asks cover, per turn.
  const reserved: ReservedAskState = { asked: new Set(), originalsByTurn: new Map() };
  // Host obligation 4 (opt-in): a success close stashed until the sentinel, and
  // the non-HITL long-running calls still unanswered, per turn.
  const deferredClose = new Map<string, AdkEvent>();
  const pendingLongRunning = new Map<string, Set<string>>();
  const assembledToolCalls = new Set<string>(); // FC dedup across partial/aggregate (Task 3)
  // Null-id call mint state (audit M47) — per-invoke ordinal counter + the
  // content/name correlation maps; lives exactly as long as this Normalizer
  // instance (one invoke, per §8.0's lifetime rule).
  // Per-turn, per-kind block ordinals (INV-BLOCK); lives as long as the invoke.
  const blockIds: BlockIdMint = new Map();
  const toolCallMint: ToolCallMintState = {
    nextOrdinal: 0,
    openWindowCounts: new Map<string, Map<string, number>>(),
    pendingIdsByName: new Map<string, string[]>(),
  };

  function ensureOpen(turnId: string): string {
    const messageId = `msg_${turnId}`;
    if (!openTurns.has(turnId)) {
      openTurns.add(turnId);
      a.openTurn(turnId, threadId);
      a.openMessage({ id: messageId, role: "assistant", turnId, threadId });
    }
    return messageId;
  }

  function maybeCloseTurn(
    event: AdkEvent,
    turnId: string,
    messageId: string,
    isPartial: boolean
  ): void {
    if (isPartial || closedTurns.has(turnId)) return;
    // Every non-partial event contributes its per-round usage to the turn's
    // accumulator — including functionCall rounds, which never close the
    // turn themselves (see the usageByTurn doc above).
    const accumulated = accumulateUsage(usageByTurn.get(turnId), event.usageMetadata);
    if (accumulated !== undefined) usageByTurn.set(turnId, accumulated);
    const parts = event.content?.parts ?? [];
    const hasFunctionCall = parts.some((p) => p.functionCall !== undefined);
    const interrupted = event.interrupted === true;
    // ── The pause close (R&D item 6, step 1) ──
    // SPEC §7 "the pause is the turn outcome" (SPEC.md:896): while an ask is
    // pending, the event with which ADK ENDS the pause (isAdkPauseEnd) closes
    // the turn `paused` from push(), with finishReason "paused". This runs
    // before the functionCall early-return, because the confirmation-request
    // event carries a (reserved) call. Items 12/18 now close on the real wire;
    // before, their close never fired and the turn flushed as an abort.
    const pending = pendingAsks.get(turnId);
    if (!interrupted && pending !== undefined && pending.length > 0 && isAdkPauseEnd(event)) {
      closedTurns.add(turnId);
      const usage = mapUsage(usageByTurn.get(turnId) ?? event.usageMetadata);
      a.closeMessage(messageId);
      a.closeTurnDone(turnId, {
        outcome: { type: "paused", asks: pending },
        finishReason: "paused",
        ...(usage !== undefined ? { usage } : {}),
      });
      return;
    }
    const hasCompletion =
      event.turnComplete === true ||
      event.finishReason !== undefined ||
      event.errorCode !== undefined;
    // is_final_response: a non-partial event with no pending function call and not interrupted.
    if (hasFunctionCall || interrupted || !hasCompletion) return;
    // The error-close predicate, spelled ONCE: both errorCode AND errorMessage
    // present ⇒ turn.error (values captured here so the close below needs no
    // re-narrowing).
    const errorClose =
      event.errorCode !== undefined && event.errorMessage !== undefined
        ? { code: event.errorCode, message: event.errorMessage }
        : undefined;
    // ── The nodeInfo gate (R&D item 6, step 1) ──
    // ADK's final-response rule is PER AGENT. On a Workflow invoke a node's
    // final text (nodeInfo present) is mid-invocation: closing the invocation
    // turn on it put the workflow's later events after the terminal and parked
    // reduce() (INV-MSG, SPEC.md:745/:757). So an event carrying nodeInfo never
    // closes the turn as success. It is a per-EVENT test, never a latch
    // (NodeTool puts nodeInfo into plain runs too). Error closes stay
    // immediate. A completed workflow closes success only on the host-completion
    // event (the `hostCompletion` opt-in, §8.0 host obligation 4); without it,
    // it flushes turn.abort.
    if (errorClose === undefined && event.nodeInfo !== undefined) return;
    // Host obligation 4 (opt-in): a SUCCESS close waits for the host-completion
    // event, because the run may not be over (a SequentialAgent's next agent,
    // after-agent callback content). The final response is stashed and closed
    // unchanged on the sentinel, so a stream ending here is byte-identical.
    // Error and paused closes stay immediate.
    if (hostCompletion && errorClose === undefined && !((pendingAsks.get(turnId)?.length ?? 0) > 0)) {
      deferredClose.set(turnId, event);
      return;
    }
    closeOnFinalResponse(event, turnId, messageId, errorClose);
  }

  /** The close on a final response: lossy-finish metadata, message.end, then
   *  turn.error or turn.done (paused when asks are pending, else success). */
  function closeOnFinalResponse(
    event: AdkEvent,
    turnId: string,
    messageId: string,
    errorClose: { code: string; message: string } | undefined,
  ): void {
    closedTurns.add(turnId);
    const rawFinish = event.finishReason ?? event.errorCode;
    const finish = resolveFinishReason(rawFinish);
    // Lossy finish mappings (resolveFinishReason's lossy arms) land the wire
    // string as `message.metadata` before the message seals — the SAME
    // channel + key the vercel-ai facet uses for this datum
    // (`rawFinishReason`, finish-step metadata), so consumers probe one
    // channel across facets. Keyed by the TRUE wire field: an errorCode-only
    // soft close (Gemini block reason, no errorMessage) rides
    // `rawErrorCode`, never fabricated as a finishReason. Lossy-only (unlike
    // vercel-ai's unconditional carry) so no recorded cassette — all STOP
    // closes — gains noise. Runs exactly once per turn (real-close path,
    // closedTurns-guarded), never on partials; the error-close path skips it
    // (closeTurnError carries the wire errorCode verbatim in `code`).
    if (errorClose === undefined && rawFinish !== undefined && finish.lossy) {
      a.emit({
        type: "message.metadata",
        messageId,
        metadata: {
          [event.finishReason !== undefined ? "rawFinishReason" : "rawErrorCode"]: rawFinish,
        },
      });
    }
    a.closeMessage(messageId);
    if (errorClose !== undefined) {
      a.closeTurnError(turnId, { message: errorClose.message, code: errorClose.code });
    } else {
      const usage = mapUsage(usageByTurn.get(turnId) ?? event.usageMetadata);
      const safety = mapBlockedSafety(event.safetyRatings);
      // A turn with pending HITL asks (requestedAuthConfigs /
      // requestedToolConfirmations / adk_request_input, tracked by
      // `trackPendingAsk` above) closes PAUSED, not success: the asks are real,
      // unresolved requests the turn is parked on, never a fabricated success
      // (audit M26 / SPEC §8 items 12 + 18). A paused close carries
      // finishReason "paused" (the HITL value, R&D item 6 step 1), the same as
      // the pause-end close above.
      const asks = pendingAsks.get(turnId);
      const paused = asks !== undefined && asks.length > 0;
      a.closeTurnDone(turnId, {
        outcome: paused ? { type: "paused", asks } : { type: "success" },
        finishReason: paused ? "paused" : finish.value,
        // draft.4 (SPEC.md:941, §10 item 23): a lossy mapping carries the
        // native value verbatim in turn.done.finishReasonRaw. That is the value
        // finishReason was mapped from: the wire finishReason, or for an
        // errorCode-only soft close the errorCode. A paused close's "paused" is
        // not a fallback, so it takes no companion. message.metadata's
        // rawFinishReason/rawErrorCode carry stays for one cohort.
        ...(!paused && rawFinish !== undefined && finish.lossy ? { finishReasonRaw: rawFinish } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(safety !== undefined ? { safety } : {}),
      });
    }
  }

  /** Host obligation 4 bookkeeping: a call named in longRunningToolIds is
   *  pending until its functionResponse arrives. */
  function trackLongRunning(event: AdkEvent, turnId: string): void {
    const longRunningIds = event.longRunningToolIds ?? [];
    const pending = pendingLongRunning.get(turnId) ?? new Set<string>();
    for (const part of event.content?.parts ?? []) {
      const callId = stringMember(part.functionCall, "id");
      if (callId !== undefined && longRunningIds.includes(callId)) pending.add(callId);
      const responseId = stringMember(part.functionResponse, "id");
      if (responseId !== undefined) pending.delete(responseId);
    }
    pendingLongRunning.set(turnId, pending);
  }

  /** The host-completion event (SPEC §8.0 host obligation 4): the run returned
   *  normally. Each still-open turn closes from push(): paused when an ask is
   *  pending; left to flush() when a non-HITL long-running call is unanswered;
   *  otherwise success (the stashed final response's close, or a plain success
   *  close with the accumulated usage when the run ended on a non-final event,
   *  e.g. a completed Workflow). */
  function hostComplete(): void {
    for (const turnId of openTurns) {
      if (closedTurns.has(turnId)) continue;
      const messageId = `msg_${turnId}`;
      const asks = pendingAsks.get(turnId);
      if (asks !== undefined && asks.length > 0) {
        closedTurns.add(turnId);
        const usage = mapUsage(usageByTurn.get(turnId));
        a.closeMessage(messageId);
        a.closeTurnDone(turnId, {
          outcome: { type: "paused", asks },
          finishReason: "paused",
          ...(usage !== undefined ? { usage } : {}),
        });
        continue;
      }
      if ((pendingLongRunning.get(turnId)?.size ?? 0) > 0) continue;
      const stashed = deferredClose.get(turnId);
      if (stashed !== undefined) {
        closeOnFinalResponse(stashed, turnId, messageId, undefined);
        continue;
      }
      closedTurns.add(turnId);
      const usage = mapUsage(usageByTurn.get(turnId));
      a.closeMessage(messageId);
      a.closeTurnDone(turnId, {
        outcome: { type: "success" },
        finishReason: "stop",
        ...(usage !== undefined ? { usage } : {}),
      });
    }
  }

  function drive(event: AdkEvent): void {
    const key = turnKey(event);
    const turnId = `turn_${key}`;
    const messageId = ensureOpen(turnId);
    const parts = event.content?.parts ?? [];
    const isPartial = event.partial === true;
    // ADK renders an object `output` as the same event's text part, byte-equal
    // to JSON.stringify(output) (workflow/base_node.js toContent → valueToText).
    // When the node-data reduction changed that output, the rendering would
    // repeat what the reduction removed, so that one part is skipped here and
    // in the aggregate below. Nothing else matches: not a string output, not
    // a substring, not model text.
    const renderedOutput = changedOutputRendering(event.output);
    const skipped = new Set<number>();
    if (renderedOutput !== undefined)
      parts.forEach((p, idx) => {
        if (p.thought !== true && typeof p.text === "string" && p.text === renderedOutput) skipped.add(idx);
      });

    // STREAMED-text citations carrier (audit M22): groundingMetadata is
    // EVENT-level, not per-part. A Gemini grounding response carries the full
    // grounded answer in a single (non-thought, non-function-call) text part, so
    // the FIRST such part in this event's `parts[]` is the citation carrier for
    // ALL of this event's groundingSupports segments — attached at that one
    // part's text.end below (never a per-segment supplement block).
    const citations = mapGroundingCitations(event.groundingMetadata);
    const citedPartIndex =
      citations !== undefined
        ? parts.findIndex(
            (p, idx) => !skipped.has(idx) && p.thought !== true && p.functionCall === undefined && typeof p.text === "string",
          )
        : -1;

    // Review finding c-i/c-ii: resolve null-id functionResponse correlation
    // for the WHOLE event up front, in array order, BEFORE any tool.done is
    // emitted — Gemini's parallel-call convention is that a batch of results
    // mirrors its calls' array position (the same rationale `providerCallIndex`
    // records at mint time, §8 item 2). Doing this as one event-scoped pass
    // (rather than resolving inline as each part streams past) is what makes a
    // multi-response event's positional pairing an explicit, testable
    // guarantee instead of an accident of loop order. A lone response in its
    // own event is the degenerate one-element case of the same pass.
    const nullIdResponseIds = new Map<number, string | undefined>();
    parts.forEach((part, idx) => {
      const fr = part.functionResponse;
      // A JSON-null arm is carried by driveAdkPart; never dereference it here.
      if (fr === undefined || !isJsonObject(fr)) return;
      if (fr.id != null && fr.id.length > 0) return; // real id — resolved directly, not via this map
      nullIdResponseIds.set(idx, consumeMintedCallId(toolCallMint, turnId, fr.name));
    });

    // §8.3 — verbatim port of the legacy suppression, with e.push(...) → a.<primitive>.
    const alreadyStreamed = streamedText.get(key) ?? "";
    const isAggregate = !isPartial && alreadyStreamed.length > 0;
    const aggregateText = isAggregate
      ? parts
          .filter(
            (p, idx) => !skipped.has(idx) && p.thought !== true && p.functionCall === undefined && typeof p.text === "string",
          )
          .map((p) => p.text ?? "")
          .join("")
      : "";
    const suppressAggregateText =
      isAggregate && aggregateText.length > 0 && alreadyStreamed.startsWith(aggregateText);
    let residualTail =
      isAggregate && !suppressAggregateText ? aggregateText.slice(alreadyStreamed.length) : "";
    let accumulated = alreadyStreamed;

    parts.forEach((part, index) => {
      if (skipped.has(index)) return;
      const isAggregateText =
        isAggregate &&
        part.thought !== true &&
        part.functionCall === undefined &&
        typeof part.text === "string";
      if (isAggregateText) {
        if (suppressAggregateText) {
          // NOTE: fully-suppressed aggregate — this event emits NO text.end at all
          // for this part; its text.end already fired on an earlier PARTIAL event.
          // Gemini grounding metadata is not documented to land on an intermediate
          // partial, so this combination is believed unreachable; if it occurs,
          // citations are dropped rather than force-attached to the wrong
          // (already-sealed) block.
          accumulated += part.text ?? "";
          return;
        }
        if (residualTail.length > 0) {
          const id = mintBlockId(blockIds, "text");
          a.textStart(id, messageId);
          a.textDelta(id, messageId, residualTail);
          a.textEnd(id, messageId, index === citedPartIndex && citations !== undefined ? { citations } : undefined);
          residualTail = "";
        }
        accumulated += part.text ?? "";
        return;
      }
      const contributed = driveAdkPart(
        a,
        part,
        index,
        event,
        messageId,
        turnId,
        isPartial,
        assembledToolCalls,
        toolCallMint,
        nullIdResponseIds,
        blockIds,
        index === citedPartIndex ? citations : undefined
      );
      if (isPartial) accumulated += contributed;
    });

    if (isPartial) streamedText.set(key, accumulated);
    else if (isAggregate) streamedText.delete(key);

    // Round-3 review finding (regression on finding b): the resend window's
    // lifecycle is scoped PER CONTENT KEY, never per turn. `mintNullIdCallId`
    // (see the `ToolCallMintState` doc above) already clears each null-id
    // call's own contentKey entry as it's consumed while processing this
    // event's parts, above. There is deliberately NO blanket
    // `openWindowCounts.delete(turnId)` here anymore: that used to wipe the
    // WHOLE turn's window map on ANY non-partial event, including one that
    // carries no null-id calls for the still-open content key at all (a
    // different tool's real-id call, a text aggregate) — which silently
    // dropped a still-in-flight window and made its true aggregate resend
    // re-mint+re-emit a duplicate tool.start. Entries for windows whose
    // aggregate never arrives simply die with the invoke's closure — bounded,
    // per-invoke.

    if (!isPartial) trackLongRunning(event, turnId);
    driveAdkTopLevel(a, event, messageId, turnId, closedTurns, pendingAsks, reserved); // standalone/content arms (Tasks 4–5)
    maybeCloseTurn(event, turnId, messageId, isPartial);
  }

  return {
    push(native: JsonValue): AgEvent[] {
      if (isHostCompleteNative(native)) {
        // The host-completion sentinel is a host<->facet contract input (SPEC
        // §8.0 host obligation 4), like obligation 1's `__host_error__`: NOT a
        // framework native. So §8.0's graceful-degradation rule ("MUST NOT
        // silently drop a native event") does not bind it. With the option OFF
        // it is ignored by design and never reaches the wire as
        // ext.google.unparsed.
        if (hostCompletion) hostComplete();
        return a.drain();
      }
      if (!isAdkEvent(native)) {
        a.emitExt("google", "unparsed", { native });
        return a.drain();
      }
      drive(native);
      return a.drain();
    },
    flush(): AgEvent[] {
      // Dangling open turns (interrupted stream before a final aggregate):
      // close their message; the ENGINE flush closes the turn itself with
      // turn.abort{stream-truncated} per INV-FLUSH — never success (audit M21).
      // This is deliberately true even when `pendingAsks` holds asks for one
      // of these turns: a HITL pause that never reached the REAL close path
      // (the is_final_response aggregate — see `maybeCloseTurn`) is an
      // INTERRUPTED stream, not a resolved pause. A truncated pause is a
      // truncation — `pendingAsks` is never consulted here (audit M26).
      // The synthetic message.end carries the turn's accumulated usage
      // (SPEC.md:779; R&D item 6 step 1), so a flushed turn, e.g. a completed
      // Workflow invoke until the host completion signal exists, still reports
      // the tokens it spent. There is never a turn.done here, so the usage
      // appears only once.
      for (const turnId of openTurns) {
        if (!closedTurns.has(turnId)) {
          closedTurns.add(turnId);
          a.closeMessage(`msg_${turnId}`, mapUsage(usageByTurn.get(turnId)));
        }
      }
      return a.flush();
    },
  };
}
