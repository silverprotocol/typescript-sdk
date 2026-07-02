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
 * `@iqai/adk` is an OPTIONAL peerDependency, NOT imported). The `AdkEvent` type
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
  type AgCitation,
  type AgFinishReason,
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
  /** Embedded media bytes (base64). */
  inlineData?: { mimeType: string; data: string };
  /** Model-generated code (the Code Execution tool). */
  executableCode?: { language?: string; code: string };
  /** Code-execution result (the Code Execution tool). */
  codeExecutionResult?: { outcome?: string; output?: string };
  /** A reference to an uploaded file (passed through opaquely). */
  fileData?: { mimeType?: string; fileUri: string };
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
    /** Opaque agent state string (runtime passthrough). */
    agentState?: string;
    /** Signals the end of the agent processing pipeline for this turn. */
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
}

// ─── finishReason → AgFinishReason (spec §4) ──────────────────────────────────
// Maps any Gemini/ADK Candidate.finishReason to the neutral AgFinishReason
// superset. A bare turnComplete with no reason ⇒ stop.
export function mapFinishReason(reason: string | undefined | null): AgFinishReason {
  switch (reason) {
    case undefined:
    case null:
    case "":
    case "STOP":
    case "FINISH_REASON_STOP":
      return "stop";
    case "MAX_TOKENS":
      return "token_limit";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "safety_blocked";
    case "MALFORMED_FUNCTION_CALL":
      return "malformed_tool_call";
    case "OTHER":
      return "other";
    default:
      return "unknown";
  }
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

/** ADK usageMetadata → neutral AgUsage (cumulative:false). Extracted from the legacy turn.done arm. */
function mapUsage(um: AdkEvent["usageMetadata"]): AgUsage | undefined {
  if (um === undefined) return undefined;
  return {
    ...(um.promptTokenCount !== undefined ? { inputTokens: um.promptTokenCount } : {}),
    ...(um.candidatesTokenCount !== undefined ? { outputTokens: um.candidatesTokenCount } : {}),
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
function inlineDataBlock(d: { mimeType: string; data: string }): AgBlock {
  const source = { type: "base64", mediaType: d.mimeType, data: d.data } as const;
  if (d.mimeType.startsWith("image/")) return { type: "image", source };
  if (d.mimeType.startsWith("audio/")) return { type: "audio", source };
  // Everything else (video/*, application/*, text/*, …) rides the file arm
  // (spec §2: video = mediaType video/*). It is still a typed media block.
  return { type: "file", source };
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

function turnKey(ev: AdkEvent): string {
  return ev.invocationId && ev.invocationId.length > 0 ? ev.invocationId : ev.id ?? "adk";
}

// ─── tool-call positional index (spec §8.2) ───────────────────────────────────
// Gemini parallel functionCall parts arrive in positional order; when a part's
// `functionCall.id` is null/absent we synthesize a stable toolCallId AND record
// the positional index on tool.start/tool-call `providerCallIndex` so re-input can
// restore name+position correlation when echoing functionResponse parts.

// ─── functionResponse.response → AgBlock[] (spec §2, MCP resource shape) ──────
// The Gemini functionResponse.response is a JSON OBJECT (the function result).
// Preserve its shape: an MCP-style { content: AgBlock[] } passes through as the
// model-facing content blocks; otherwise the whole object rides a single `data`
// block (typed, addressable by the function name) so nothing is dropped.
function functionResponseToAgBlocks(name: string, response: { [k: string]: JsonValue } | undefined): AgBlock[] {
  if (response === undefined) return [];
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
    return out;
  }
  // Non-MCP plain object result → a typed `data` block keyed by the tool name.
  return [{ type: "data", name, data: response }];
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
  citations?: AgCitation[]
): string {
  // ── REASONING (thought:true) → reasoning.start/delta/end + opaque signature ──
  if (part.thought === true) {
    const id = `reasoning:${index}`;
    a.reasoningStart(id, messageId);
    if (part.text !== undefined && part.text.length > 0) a.reasoningDelta(id, messageId, part.text);
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
  if (part.text !== undefined) {
    const id = `text:${index}`;
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
    const input: JsonValue = JsonValue.parse(fc.args ?? {});
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
      a.emitExt("google", "unparsed", { functionResponse: JsonValue.parse(fr), turnId });
      return "";
    }
    const outcome: ToolOutcome = fr.response?.["isError"] === true ? "error" : "ok";
    a.toolDone({
      toolCallId,
      content: functionResponseToAgBlocks(fr.name, fr.response),
      outcome,
      turnId,
      providerMetadata:
        fr.thoughtSignature !== undefined && fr.thoughtSignature.length > 0
          ? AgProviderMeta.parse({ google: { thoughtSignature: fr.thoughtSignature } })
          : undefined,
    });
    return "";
  }

  // ── inlineData / executableCode / codeExecutionResult / fileData → content.block ──
  if (part.inlineData !== undefined) {
    a.contentBlock(messageId, inlineDataBlock(part.inlineData));
    return "";
  }
  if (part.executableCode !== undefined) {
    a.contentBlock(messageId, {
      type: "code",
      language: codeLanguage(part.executableCode.language),
      code: part.executableCode.code,
    });
    return "";
  }
  if (part.codeExecutionResult !== undefined) {
    a.contentBlock(messageId, {
      type: "code-result",
      outcome: codeOutcome(part.codeExecutionResult.outcome),
      output: part.codeExecutionResult.output ?? "",
    });
    return "";
  }
  if (part.fileData !== undefined) {
    a.contentBlock(messageId, {
      type: "resource-link",
      uri: part.fileData.fileUri,
      mimeType: part.fileData.mimeType,
    });
    return "";
  }

  return "";
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
  pendingAsks: Map<string, AgPausedAsk[]>
): void {
  if (event.inputTranscription?.text !== undefined) {
    a.contentBlock(messageId, {
      type: "text",
      text: event.inputTranscription.text,
      _meta: { "agjson/transcription": { role: "input", kind: "transcription" } },
    });
  }
  if (event.outputTranscription?.text !== undefined) {
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

  // ── actions → handoff / hitl.ask / state.delta / provider-raw bag ──
  const actions = event.actions;
  if (actions !== undefined) {
    if (actions.transferToAgent !== undefined) {
      a.emit({ type: "handoff", kind: "transfer", toAgentName: actions.transferToAgent });
    }
    if (actions.escalate === true) a.emit({ type: "handoff", kind: "escalate" });
    if (actions.requestedAuthConfigs !== undefined) {
      // ADK dict[str, AuthConfig] keyed by function-call-id. The AuthConfig is a
      // complex framework-specific object (auth-scheme union + credentials) that
      // does not fit the flat AgAuthConfig OAuth projection, so it rides opaque
      // in `metadata` (AgJSON: framework-specifics lossless via metadata; SPEC §8
      // item 12's sanctioned carrier). The SAME ask fields are tracked in
      // `pendingAsks` — if this turn's close-path event turns out to be THIS
      // event (or a later one for the same turnId), `maybeCloseTurn` folds them
      // into `turn.done.outcome.paused.asks[]` instead of fabricating success
      // (audit M26).
      for (const [callId, authConfig] of Object.entries(actions.requestedAuthConfigs)) {
        const ask: AgPausedAsk = {
          askId: `auth_${callId}`,
          kind: "auth",
          toolCallId: callId,
          metadata: { authConfig: JsonValue.parse(authConfig) },
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
    if (actions.stateDelta !== undefined)
      a.emit({ type: "state.delta", patch: JsonValue.parse(actions.stateDelta) });

    const unmappedActions: { [k: string]: JsonValue } = {};
    if (actions.artifactDelta !== undefined)
      unmappedActions["artifactDelta"] = JsonValue.parse(actions.artifactDelta);
    if (actions.renderUiWidgets !== undefined)
      unmappedActions["renderUiWidgets"] = JsonValue.parse(actions.renderUiWidgets);
    if (actions.agentState !== undefined) unmappedActions["agentState"] = actions.agentState;
    if (actions.endOfAgent !== undefined) unmappedActions["endOfAgent"] = actions.endOfAgent;
    if (Object.keys(unmappedActions).length > 0) {
      a.contentBlock(messageId, {
        type: "provider-raw",
        vendor: "google",
        raw: JsonValue.parse(unmappedActions),
      });
    }
  }

  // ── event-level unmapped (citationMetadata / customMetadata) → provider-raw ──
  const unmappedEvent: { [k: string]: JsonValue } = {};
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
export function createAdkNormalizer(): Normalizer {
  const a = new StreamAssembler();
  const threadId = "google";
  // §8.3 per-instance accumulator (replaces the module-level streamedText Map):
  const streamedText = new Map<string, string>();
  const openTurns = new Set<string>();
  const closedTurns = new Set<string>();
  // Per-turn HITL asks emitted by the two `actions.requested*` arms (audit
  // M26) — populated in emission order by `trackPendingAsk` inside
  // `driveAdkTopLevel`. Consulted ONLY by `maybeCloseTurn`'s REAL close path
  // (the is_final_response aggregate); the `flush()` truncation path never
  // reads it — see the comment there.
  const pendingAsks = new Map<string, AgPausedAsk[]>();
  const assembledToolCalls = new Set<string>(); // FC dedup across partial/aggregate (Task 3)
  // Null-id call mint state (audit M47) — per-invoke ordinal counter + the
  // content/name correlation maps; lives exactly as long as this Normalizer
  // instance (one invoke, per §8.0's lifetime rule).
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
    const parts = event.content?.parts ?? [];
    const hasFunctionCall = parts.some((p) => p.functionCall !== undefined);
    const interrupted = event.interrupted === true;
    const hasCompletion =
      event.turnComplete === true ||
      event.finishReason !== undefined ||
      event.errorCode !== undefined;
    // is_final_response: a non-partial event with no pending function call and not interrupted.
    if (hasFunctionCall || interrupted || !hasCompletion) return;
    closedTurns.add(turnId);
    a.closeMessage(messageId);
    if (event.errorCode !== undefined && event.errorMessage !== undefined) {
      a.closeTurnError(turnId, { message: event.errorMessage, code: event.errorCode });
    } else {
      const usage = mapUsage(event.usageMetadata);
      const safety = mapBlockedSafety(event.safetyRatings);
      // A turn with pending HITL asks (requestedAuthConfigs /
      // requestedToolConfirmations, tracked by `trackPendingAsk` above) closes
      // PAUSED, not success — the asks are real, unresolved requests the
      // turn is parked on, never a fabricated success (audit M26 / SPEC §8
      // items 12 + 18). `finishReason` stays the same mapping either way.
      const asks = pendingAsks.get(turnId);
      a.closeTurnDone(turnId, {
        outcome: asks !== undefined && asks.length > 0 ? { type: "paused", asks } : { type: "success" },
        finishReason: mapFinishReason(event.finishReason ?? event.errorCode),
        ...(usage !== undefined ? { usage } : {}),
        ...(safety !== undefined ? { safety } : {}),
      });
    }
  }

  function drive(event: AdkEvent): void {
    const key = turnKey(event);
    const turnId = `turn_${key}`;
    const messageId = ensureOpen(turnId);
    const parts = event.content?.parts ?? [];
    const isPartial = event.partial === true;

    // STREAMED-text citations carrier (audit M22): groundingMetadata is
    // EVENT-level, not per-part. A Gemini grounding response carries the full
    // grounded answer in a single (non-thought, non-function-call) text part, so
    // the FIRST such part in this event's `parts[]` is the citation carrier for
    // ALL of this event's groundingSupports segments — attached at that one
    // part's text.end below (never a per-segment supplement block).
    const citations = mapGroundingCitations(event.groundingMetadata);
    const citedPartIndex =
      citations !== undefined
        ? parts.findIndex((p) => p.thought !== true && p.functionCall === undefined && p.text !== undefined)
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
      if (fr === undefined) return;
      if (fr.id != null && fr.id.length > 0) return; // real id — resolved directly, not via this map
      nullIdResponseIds.set(idx, consumeMintedCallId(toolCallMint, turnId, fr.name));
    });

    // §8.3 — verbatim port of the legacy suppression, with e.push(...) → a.<primitive>.
    const alreadyStreamed = streamedText.get(key) ?? "";
    const isAggregate = !isPartial && alreadyStreamed.length > 0;
    const aggregateText = isAggregate
      ? parts
          .filter((p) => p.thought !== true && p.functionCall === undefined && p.text !== undefined)
          .map((p) => p.text ?? "")
          .join("")
      : "";
    const suppressAggregateText =
      isAggregate && aggregateText.length > 0 && alreadyStreamed.startsWith(aggregateText);
    let residualTail =
      isAggregate && !suppressAggregateText ? aggregateText.slice(alreadyStreamed.length) : "";
    let accumulated = alreadyStreamed;

    parts.forEach((part, index) => {
      const isAggregateText =
        isAggregate &&
        part.thought !== true &&
        part.functionCall === undefined &&
        part.text !== undefined;
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
          const id = `text:${index}`;
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

    driveAdkTopLevel(a, event, messageId, turnId, closedTurns, pendingAsks); // standalone/content arms (Tasks 4–5)
    maybeCloseTurn(event, turnId, messageId, isPartial);
  }

  return {
    push(native: JsonValue): AgEvent[] {
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
      for (const turnId of openTurns) {
        if (!closedTurns.has(turnId)) {
          closedTurns.add(turnId);
          a.closeMessage(`msg_${turnId}`);
        }
      }
      return a.flush();
    },
  };
}
