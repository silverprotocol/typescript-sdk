/**
 * `@silverprotocol/google-adk` — the Google Agent Development Kit normalizer
 * (FIXTURE-TESTED ONLY; no guuey runtime emits this native input yet).
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
  type AgSafety,
  type AgUsage,
  AgProviderMeta,
  JsonValue,
  type Normalizer,
  type NormalizerContext,
  type RuleNormalizer,
  StreamAssembler,
  type ToolOutcome,
} from "@silverprotocol/core";

import { ruleJsonata } from "./rule.js";

/** The portable pure-structural JSONata subset (non-thought text lifecycle +
 *  functionCall tool.start/args.delta with dict args). Re-exported for
 *  cross-runtime reuse; the parsed `tool.args.assembled`, the reasoning
 *  (thought) parts, the functionResponse → tool.done, the inlineData /
 *  executableCode / codeExecutionResult → content.block, the turn synthesis, and
 *  ALL THREE stateful hazards (aggregate-suppression / thoughtSignature /
 *  providerCallIndex) live in {@link adkNormalizer}, authoritative for the live
 *  path. The canonical source of this string is the sibling `rule.jsonata`. */
export { ruleJsonata };

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
    /** Request OAuth/auth configs from the caller (one per tool). */
    requestedAuthConfigs?: Array<{
      toolName?: string;
      authConfig?: {
        scheme?: string;
        scopes?: string[];
        authorizationUrl?: string;
        tokenUrl?: string;
        clientId?: string;
        audience?: string;
      };
    }>;
    /** Request user confirmation before executing a tool. */
    requestedToolConfirmations?: Array<{
      toolName?: string;
      toolCallId?: string;
      message?: string;
    }>;
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

// ─── stateful aggregate-suppression (spec §8.3) ───────────────────────────────
// ADK streams partial:true events (incremental) then a FINAL partial:false (or
// partial-absent) AGGREGATE that RE-SENDS the full accumulated content. Replaying
// the aggregate's already-streamed text/reasoning is the #1 ADK double-render.
//
// FAITHFUL §8.3 dedup: we accumulate the visible streamed text per turn
// (keyed by invocationId, the run/turn key) across the partial:true events. When
// the partial:false aggregate arrives, its text/reasoning parts are a PREFIX-
// superset of what already streamed; we emit ONLY the residual (the tail not yet
// streamed) — in practice the aggregate equals the accumulation, so nothing is
// re-emitted. The function_calls and the turn-completion that ride ONLY the final
// event are KEPT (they never streamed). After consuming the aggregate the per-turn
// accumulation is cleared.
const streamedText = new Map<string, string>();

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

// ─── per-part fan-out (spec §4 mapping table) ─────────────────────────────────
// Emit one part's lifecycle burst. Returns the visible text contributed (for the
// aggregate-suppression accumulation). `index` is the positional part index
// (the providerCallIndex source for null-id functionCalls, §8.2).
function emitPart(e: ReturnType<typeof makeEmitter>, part: AdkPart, index: number, event: AdkEvent): string {
  // ── REASONING (thought:true) — text part that is the model's thought ──
  if (part.thought === true) {
    const id = `reasoning:${index}`;
    e.push({ type: "reasoning.start", seq: e.next(), id });
    if (part.text !== undefined && part.text.length > 0) {
      e.push({ type: "reasoning.delta", seq: e.next(), id, delta: part.text });
    }
    e.push({ type: "reasoning.end", seq: e.next(), id });
    // §8.8: the per-part thoughtSignature rides the reasoning block's opaque —
    // replay-load-bearing (echo or 400 on turn N+1 for a thinking-only turn).
    if (part.thoughtSignature !== undefined && part.thoughtSignature.length > 0) {
      e.push({
        type: "reasoning.opaque",
        seq: e.next(),
        id,
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
    // §8.8: a NON-thought text part can ALSO carry a thoughtSignature (the
    // Google-Search-grounded turn). The spec preserves the signature on EVERY
    // signed part, not just thought + functionCall — drop it and Gemini 400s on
    // turn N+1. The text event's providerMetadata replay channel (text.start /
    // text.end carry providerMetadata?: AgProviderMeta) is its home: reduce()
    // merges it onto the text block's providerMetadata under `google`.
    const signed = part.thoughtSignature !== undefined && part.thoughtSignature.length > 0;
    const providerMetadata = signed
      ? AgProviderMeta.parse({ google: { thoughtSignature: part.thoughtSignature } })
      : undefined;
    e.push({ type: "text.start", seq: e.next(), id, providerMetadata });
    e.push({ type: "text.delta", seq: e.next(), id, delta: part.text });
    e.push({ type: "text.end", seq: e.next(), id, providerMetadata });
    return part.text;
  }

  // ── FUNCTION CALL ──
  if (part.functionCall !== undefined) {
    const fc = part.functionCall;
    // §8.2: null/absent id → synthesize a stable toolCallId AND record the
    // positional index on providerCallIndex (restores name+position on re-input).
    // `id` is OFTEN null on the Dev API; narrow inline so no non-null `!` is needed.
    const realId = fc.id != null && fc.id.length > 0 ? fc.id : null;
    const toolCallId = realId !== null ? realId : `adk_call_${index}`;
    const providerCallIndex = realId !== null ? undefined : index;
    // args is ALREADY a dict — validate via JsonValue.parse (NO JSON.parse, NO cast).
    const argsObj: { [k: string]: JsonValue } = fc.args ?? {};
    const input: JsonValue = JsonValue.parse(argsObj);
    // §8.2: record the synthesized null-id positional index on the
    // replay-load-bearing providerMetadata (branded AgProviderMeta) under
    // `google.providerCallIndex` (the spec home is the tool-call block's
    // `providerCallIndex` / `_meta`; the streaming tool.start event carries it on
    // providerMetadata, its replay channel) so re-input restores name+position.
    // §longRunning: if the call id is in event.longRunningToolIds, set longRunning:true.
    const longRunning =
      event.longRunningToolIds !== undefined && event.longRunningToolIds.includes(toolCallId)
        ? true
        : undefined;
    e.push({
      type: "tool.start",
      seq: e.next(),
      toolCallId,
      name: fc.name,
      index,
      longRunning,
      providerMetadata:
        providerCallIndex !== undefined
          ? AgProviderMeta.parse({ google: { providerCallIndex } })
          : undefined,
    });
    e.push({
      type: "tool.args.delta",
      seq: e.next(),
      toolCallId,
      delta: JSON.stringify(input),
    });
    // §8.8: the Gemini tool-call thoughtSignature rides tool.args.assembled.signature
    // (the tool-call signature) — replay-load-bearing. The MANDATORY assembled.
    e.push({
      type: "tool.args.assembled",
      seq: e.next(),
      toolCallId,
      input,
      signature:
        part.thoughtSignature !== undefined && part.thoughtSignature.length > 0
          ? part.thoughtSignature
          : undefined,
    });
    return "";
  }

  // ── FUNCTION RESPONSE → tool.done (preserve the MCP resource shape) ──
  if (part.functionResponse !== undefined) {
    const fr = part.functionResponse;
    // `id` is OFTEN null on the Dev API; narrow inline so no non-null `!` is needed.
    const realId = fr.id != null && fr.id.length > 0 ? fr.id : null;
    const toolCallId = realId !== null ? realId : `adk_call_${index}`;
    // (e) response.isError=true → outcome="error"; otherwise "ok".
    const outcome: ToolOutcome = fr.response?.["isError"] === true ? "error" : "ok";
    // (f) thoughtSignature on functionResponse → tool.done providerMetadata.google.
    const providerMetadata =
      fr.thoughtSignature !== undefined && fr.thoughtSignature.length > 0
        ? AgProviderMeta.parse({ google: { thoughtSignature: fr.thoughtSignature } })
        : undefined;
    e.push({
      type: "tool.done",
      seq: e.next(),
      toolCallId,
      content: functionResponseToAgBlocks(fr.name, fr.response),
      outcome,
      providerMetadata,
    });
    return "";
  }

  // ── INLINE DATA → content.block (image/audio/file by mimeType) ──
  if (part.inlineData !== undefined) {
    e.push({ type: "content.block", seq: e.next(), block: inlineDataBlock(part.inlineData) });
    return "";
  }

  // ── EXECUTABLE CODE → content.block (code) ──
  if (part.executableCode !== undefined) {
    e.push({
      type: "content.block",
      seq: e.next(),
      block: { type: "code", language: codeLanguage(part.executableCode.language), code: part.executableCode.code },
    });
    return "";
  }

  // ── CODE EXECUTION RESULT → content.block (code-result) ──
  if (part.codeExecutionResult !== undefined) {
    e.push({
      type: "content.block",
      seq: e.next(),
      block: {
        type: "code-result",
        outcome: codeOutcome(part.codeExecutionResult.outcome),
        output: part.codeExecutionResult.output ?? "",
      },
    });
    return "";
  }

  // ── FILE DATA → content.block (resource-link, by reference) ──
  if (part.fileData !== undefined) {
    e.push({
      type: "content.block",
      seq: e.next(),
      block: { type: "resource-link", uri: part.fileData.fileUri, mimeType: part.fileData.mimeType },
    });
    return "";
  }

  // An empty/unknown part contributes nothing (clients ignore unknown shapes, §0.2).
  return "";
}

// ─── the normalizer ───────────────────────────────────────────────────────────
const adkNormalizer: RuleNormalizer<AdkEvent> = (event) => {
  const e = makeEmitter();
  const key = turnKey(event);
  const parts = event.content?.parts ?? [];

  // §8.3 — partial:true is an INCREMENTAL streamed event: emit its parts and
  // ACCUMULATE the visible text so the later partial:false aggregate can be deduped.
  const isPartial = event.partial === true;

  // The partial:false (or partial-absent) AGGREGATE re-sends the full content.
  // Compute the already-streamed text for this turn; emit only the RESIDUAL
  // visible text (the tail not yet streamed). function_calls / tool results that
  // ride ONLY the final event never streamed → they are always emitted.
  const alreadyStreamed = streamedText.get(key) ?? "";

  // Aggregate suppression is engaged when this is the FINAL event AND prior
  // partial text streamed for this turn (an aggregate restating the stream).
  const isAggregate = !isPartial && alreadyStreamed.length > 0;

  // Build the aggregate's full visible text to detect the prefix overlap.
  const aggregateText = isAggregate
    ? parts
        .filter((p) => p.thought !== true && p.functionCall === undefined && p.text !== undefined)
        .map((p) => p.text ?? "")
        .join("")
    : "";

  // §8.3: the aggregate's visible text is FULLY suppressible when it equals (is a
  // prefix of) what already streamed — the common ADK case (the aggregate restates
  // the stream verbatim). When it does NOT (the aggregate carries strictly MORE
  // text than streamed), we emit the residual tail instead of double-rendering the
  // streamed prefix. `suppressAggregateText` engages the prefix-equality drop.
  const suppressAggregateText =
    isAggregate && aggregateText.length > 0 && alreadyStreamed.startsWith(aggregateText);
  // The residual tail (aggregate text beyond the streamed prefix), emitted once
  // when the aggregate grew past the stream. Tracked across the part loop.
  let residualTail = isAggregate && !suppressAggregateText ? aggregateText.slice(alreadyStreamed.length) : "";

  let accumulated = alreadyStreamed;

  parts.forEach((part, index) => {
    // §8.3: on the aggregate, a visible text part is the streamed-prefix restatement.
    // Non-text parts (function calls, tool results, reasoning, media) ride the final
    // event and NEVER streamed → never suppressed.
    const isAggregateText =
      isAggregate && part.thought !== true && part.functionCall === undefined && part.text !== undefined;
    if (isAggregateText) {
      if (suppressAggregateText) {
        // The whole aggregate text already streamed: drop this restatement.
        accumulated += part.text ?? "";
        return;
      }
      // The aggregate grew past the stream: emit ONLY the residual tail, once,
      // as a single text burst (still no double-render of the streamed prefix).
      if (residualTail.length > 0) {
        const id = `text:${index}`;
        e.push({ type: "text.start", seq: e.next(), id });
        e.push({ type: "text.delta", seq: e.next(), id, delta: residualTail });
        e.push({ type: "text.end", seq: e.next(), id });
        residualTail = "";
      }
      accumulated += part.text ?? "";
      return;
    }

    const contributed = emitPart(e, part, index, event);
    if (isPartial) accumulated += contributed;
  });

  // §8.3 state: a partial event GROWS the per-turn accumulation; the final
  // aggregate CLEARS it (the turn's streamed text is fully consumed).
  if (isPartial) {
    streamedText.set(key, accumulated);
  } else if (isAggregate) {
    streamedText.delete(key);
  }

  // ── (h) interrupted → turn.abort ──
  if (event.interrupted === true) {
    e.push({ type: "turn.abort", seq: e.next(), reason: "interrupted" });
  }

  // ── (c) promptFeedback → prompt.blocked ──
  if (event.promptFeedback?.blockReason !== undefined) {
    const blockReason = event.promptFeedback.blockReason;
    const reason = mapBlockReason(blockReason);
    const safety: AgSafety[] | undefined =
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
    e.push({ type: "prompt.blocked", seq: e.next(), reason, ...(safety !== undefined ? { safety } : {}) });
  }

  // ── (j) inputTranscription / outputTranscription → content.block ──
  if (event.inputTranscription?.text !== undefined) {
    e.push({
      type: "content.block",
      seq: e.next(),
      block: {
        type: "text",
        text: event.inputTranscription.text,
        _meta: { "agjson/transcription": { role: "input", kind: "transcription" } },
      },
    });
  }
  if (event.outputTranscription?.text !== undefined) {
    e.push({
      type: "content.block",
      seq: e.next(),
      block: {
        type: "text",
        text: event.outputTranscription.text,
        _meta: { "agjson/transcription": { role: "output", kind: "transcription" } },
      },
    });
  }

  // ── (d) groundingMetadata → source events + citations + display.required ──
  if (event.groundingMetadata !== undefined) {
    const gm = event.groundingMetadata;
    // Emit a source event for each grounding chunk with a web URI.
    if (gm.groundingChunks !== undefined) {
      gm.groundingChunks.forEach((chunk, chunkIndex) => {
        if (chunk.web?.uri !== undefined) {
          e.push({
            type: "source",
            seq: e.next(),
            sourceId: `grounding_${chunkIndex}`,
            source: { url: chunk.web.uri, title: chunk.web.title },
          });
        }
      });
    }
    // Emit content.block with citations for each grounding support.
    if (gm.groundingSupports !== undefined) {
      gm.groundingSupports.forEach((support) => {
        const segText = support.segment?.text ?? "";
        const citation: AgCitation = {
          kind: "offset",
          unit: "byte",
          startIndex: support.segment?.startIndex ?? 0,
          endIndex: support.segment?.endIndex ?? 0,
          bounds: "[start,end)",
          sourceIds: support.groundingChunkIndices?.map((i) => `grounding_${i}`) ?? [],
          confidenceScores: support.confidenceScores ?? [],
          citedText: segText,
          indexFrame: "response",
        };
        e.push({
          type: "content.block",
          seq: e.next(),
          block: { type: "text", text: segText, citations: [citation] },
        });
      });
    }
    // Emit display.required for the Google Search Entry Point (ToS-must-render).
    if (gm.searchEntryPoint?.renderedContent !== undefined) {
      e.push({
        type: "display.required",
        seq: e.next(),
        provider: "google",
        html: gm.searchEntryPoint.renderedContent,
      });
    }
  }

  // ── (g) actions mappings ──
  const actions = event.actions;
  if (actions !== undefined) {
    // transferToAgent → handoff transfer
    if (actions.transferToAgent !== undefined) {
      e.push({
        type: "handoff",
        seq: e.next(),
        kind: "transfer",
        toAgentName: actions.transferToAgent,
      });
    }
    // escalate → handoff escalate
    if (actions.escalate === true) {
      e.push({ type: "handoff", seq: e.next(), kind: "escalate" });
    }
    // requestedAuthConfigs → hitl.ask (auth)
    if (actions.requestedAuthConfigs !== undefined) {
      for (const config of actions.requestedAuthConfigs) {
        const toolName = config.toolName ?? "unknown";
        const authConfig =
          config.authConfig !== undefined
            ? {
                scheme: config.authConfig.scheme ?? "unknown",
                ...(config.authConfig.scopes !== undefined ? { scopes: config.authConfig.scopes } : {}),
                ...(config.authConfig.authorizationUrl !== undefined
                  ? { authorizationUrl: config.authConfig.authorizationUrl }
                  : {}),
                ...(config.authConfig.tokenUrl !== undefined ? { tokenUrl: config.authConfig.tokenUrl } : {}),
                ...(config.authConfig.clientId !== undefined ? { clientId: config.authConfig.clientId } : {}),
                ...(config.authConfig.audience !== undefined ? { audience: config.authConfig.audience } : {}),
              }
            : undefined;
        e.push({
          type: "hitl.ask",
          seq: e.next(),
          askId: `auth_${toolName}`,
          kind: "auth",
          toolCallId: toolName,
          ...(authConfig !== undefined ? { authConfig } : {}),
        });
      }
    }
    // requestedToolConfirmations → hitl.ask (approval)
    if (actions.requestedToolConfirmations !== undefined) {
      actions.requestedToolConfirmations.forEach((conf, confIndex) => {
        const toolName = conf.toolName ?? "unknown";
        e.push({
          type: "hitl.ask",
          seq: e.next(),
          askId: `approval_${toolName}_${confIndex}`,
          kind: "approval",
          toolCallId: conf.toolCallId ?? toolName,
          ...(conf.message !== undefined ? { message: conf.message } : {}),
        });
      });
    }
    // stateDelta → state.delta (spec §4 state.delta, patch = the delta dict).
    if (actions.stateDelta !== undefined) {
      e.push({
        type: "state.delta",
        seq: e.next(),
        patch: JsonValue.parse(actions.stateDelta),
      });
    }
    // Collect unmapped action-level fields that are present and carry them
    // opaquely as a provider-raw content.block (lossless carry, spec §2).
    // stateDelta is now mapped above and excluded from the opaque bag.
    const unmappedActions: { [k: string]: JsonValue } = {};
    if (actions.artifactDelta !== undefined) unmappedActions["artifactDelta"] = JsonValue.parse(actions.artifactDelta);
    if (actions.renderUiWidgets !== undefined) unmappedActions["renderUiWidgets"] = JsonValue.parse(actions.renderUiWidgets);
    if (actions.agentState !== undefined) unmappedActions["agentState"] = actions.agentState;
    if (actions.endOfAgent !== undefined) unmappedActions["endOfAgent"] = actions.endOfAgent;
    if (Object.keys(unmappedActions).length > 0) {
      e.push({
        type: "content.block",
        seq: e.next(),
        block: { type: "provider-raw", vendor: "google", raw: JsonValue.parse(unmappedActions) },
      });
    }
  }

  // Collect unmapped event-level fields that are present and carry them
  // opaquely as a provider-raw content.block (lossless carry, spec §2).
  const unmappedEvent: { [k: string]: JsonValue } = {};
  if (event.citationMetadata !== undefined) unmappedEvent["citationMetadata"] = JsonValue.parse(event.citationMetadata);
  if (event.customMetadata !== undefined) unmappedEvent["customMetadata"] = JsonValue.parse(event.customMetadata);
  if (Object.keys(unmappedEvent).length > 0) {
    e.push({
      type: "content.block",
      seq: e.next(),
      block: { type: "provider-raw", vendor: "google", raw: JsonValue.parse(unmappedEvent) },
    });
  }

  // ── TURN COMPLETION → turn.done / turn.error (spec §4) ──
  // (b) When BOTH errorCode AND errorMessage are present, it's a hard error → turn.error.
  // Otherwise: turnComplete (or finishReason, or bare errorCode) seals with turn.done.
  // A turn does not complete on a partial:true incremental event.
  if (
    !isPartial &&
    (event.turnComplete === true || event.finishReason !== undefined || event.errorCode !== undefined)
  ) {
    if (event.errorCode !== undefined && event.errorMessage !== undefined) {
      // Hard error: emit turn.error instead of turn.done.
      e.push({
        type: "turn.error",
        seq: e.next(),
        message: event.errorMessage,
        code: event.errorCode,
      });
    } else {
      const finishReason = mapFinishReason(event.finishReason ?? event.errorCode);
      // (a) usageMetadata → usage on turn.done.
      const um = event.usageMetadata;
      const usage =
        um !== undefined
          ? {
              ...(um.promptTokenCount !== undefined ? { inputTokens: um.promptTokenCount } : {}),
              ...(um.candidatesTokenCount !== undefined ? { outputTokens: um.candidatesTokenCount } : {}),
              ...(um.totalTokenCount !== undefined ? { totalTokens: um.totalTokenCount } : {}),
              ...(um.cachedContentTokenCount !== undefined ? { cacheReadTokens: um.cachedContentTokenCount } : {}),
              ...(um.thoughtsTokenCount !== undefined ? { reasoningTokens: um.thoughtsTokenCount } : {}),
              ...(um.toolUsePromptTokenCount !== undefined
                ? { toolUseInputTokens: um.toolUsePromptTokenCount }
                : {}),
              cumulative: false as const,
            }
          : undefined;
      // (c) safetyRatings → safety on turn.done (only blocked ratings).
      const safety =
        event.safetyRatings !== undefined
          ? event.safetyRatings
              .filter((r): r is typeof r & { category: string } => r.blocked === true && r.category !== undefined)
              .map((r) => ({
                category: r.category,
                probability: r.probability,
                score: r.score,
                blocked: r.blocked,
              }))
          : undefined;
      e.push({
        type: "turn.done",
        seq: e.next(),
        turnId: `turn_${key}`,
        outcome: { type: "success" },
        finishReason,
        ...(usage !== undefined ? { usage } : {}),
        ...(safety !== undefined && safety.length > 0 ? { safety } : {}),
      });
    }
  }

  return e.events;
};

export default adkNormalizer;
export { adkNormalizer };

// ─── stateful factory: driveAdkPart (TEXT arm; Tasks 3–5 fill the rest) ──────
function driveAdkPart(
  a: StreamAssembler,
  part: AdkPart,
  index: number,
  event: AdkEvent,
  messageId: string,
  _turnId: string,
  _assembledToolCalls: Set<string>
): string {
  // ── REASONING (thought:true) — Task 4 ──
  // (no-op placeholder; Task 4 fills)
  if (part.thought === true) {
    return "";
  }

  // ── TEXT ──
  if (part.text !== undefined) {
    const id = `text:${index}`;
    const signed = part.thoughtSignature !== undefined && part.thoughtSignature.length > 0;
    if (signed) {
      // §8.8 — carry the signature on text.start/end providerMetadata via the emit primitive
      // (textStart/textEnd sugar has no providerMetadata param).
      const providerMetadata = AgProviderMeta.parse({
        google: { thoughtSignature: part.thoughtSignature },
      });
      a.emit({ type: "text.start", id, providerMetadata });
      a.textDelta(id, messageId, part.text);
      a.emit({ type: "text.end", id, providerMetadata });
    } else {
      a.textStart(id, messageId);
      a.textDelta(id, messageId, part.text);
      a.textEnd(id, messageId);
    }
    return part.text;
  }

  // ── FUNCTION CALL — Task 3 ──
  if (part.functionCall !== undefined) {
    // no-op placeholder; Task 3 fills
    void event;
    return "";
  }

  // ── FUNCTION RESPONSE — Task 3 ──
  if (part.functionResponse !== undefined) {
    // no-op placeholder; Task 3 fills
    return "";
  }

  // ── INLINE DATA / CODE / FILE — Task 5 ──
  // no-op placeholder; Task 5 fills

  return "";
}

function driveAdkTopLevel(
  a: StreamAssembler,
  event: AdkEvent,
  messageId: string,
  turnId: string
): void {
  // Tasks 4–5 fill grounding / actions / promptFeedback / interrupted / transcription.
  void a;
  void event;
  void messageId;
  void turnId;
}

// ─── stateful factory: createAdkNormalizer ────────────────────────────────────
export function createAdkNormalizer(ctx?: NormalizerContext): Normalizer {
  const a = new StreamAssembler(ctx);
  const threadId = "google";
  // §8.3 per-instance accumulator (replaces the module-level streamedText Map):
  const streamedText = new Map<string, string>();
  const openTurns = new Set<string>();
  const closedTurns = new Set<string>();
  const assembledToolCalls = new Set<string>(); // FC dedup across partial/aggregate (Task 3)

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
      a.closeTurnDone(turnId, {
        outcome: { type: "success" },
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
          accumulated += part.text ?? "";
          return;
        }
        if (residualTail.length > 0) {
          const id = `text:${index}`;
          a.textStart(id, messageId);
          a.textDelta(id, messageId, residualTail);
          a.textEnd(id, messageId);
          residualTail = "";
        }
        accumulated += part.text ?? "";
        return;
      }
      const contributed = driveAdkPart(a, part, index, event, messageId, turnId, assembledToolCalls);
      if (isPartial) accumulated += contributed;
    });

    if (isPartial) streamedText.set(key, accumulated);
    else if (isAggregate) streamedText.delete(key);

    driveAdkTopLevel(a, event, messageId, turnId); // standalone/content arms (Tasks 4–5)
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
      // Close any dangling open turn (interrupted stream before a final aggregate).
      for (const turnId of openTurns) {
        if (!closedTurns.has(turnId)) {
          closedTurns.add(turnId);
          a.closeMessage(`msg_${turnId}`);
          a.closeTurnDone(turnId, { outcome: { type: "success" }, finishReason: "stop" });
        }
      }
      return a.flush();
    },
  };
}
