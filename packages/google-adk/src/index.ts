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
  type AgFinishReason,
  AgProviderMeta,
  JsonValue,
  type Normalizer,
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
  /** A tool result. `response` is an OBJECT (the function result, JSON object). */
  functionResponse?: { name: string; response?: { [k: string]: JsonValue }; id?: string | null };
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
  /** Event id (stable per ADK event). */
  id?: string;
  /** The whole-interaction run id (the turn key). */
  invocationId?: string;
  /** 'user' or the agent name. */
  author?: string;
  /** Side-effect / control signals (skipSummarization short-circuits final). */
  actions?: { skipSummarization?: boolean };
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
function emitPart(e: ReturnType<typeof makeEmitter>, part: AdkPart, index: number): string {
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
    e.push({
      type: "tool.start",
      seq: e.next(),
      toolCallId,
      name: fc.name,
      index,
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
    const outcome: ToolOutcome = "ok";
    e.push({
      type: "tool.done",
      seq: e.next(),
      toolCallId,
      content: functionResponseToAgBlocks(fr.name, fr.response),
      outcome,
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
const adkNormalizer: Normalizer<AdkEvent> = (event) => {
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

    const contributed = emitPart(e, part, index);
    if (isPartial) accumulated += contributed;
  });

  // §8.3 state: a partial event GROWS the per-turn accumulation; the final
  // aggregate CLEARS it (the turn's streamed text is fully consumed).
  if (isPartial) {
    streamedText.set(key, accumulated);
  } else if (isAggregate) {
    streamedText.delete(key);
  }

  // ── TURN COMPLETION → turn.done (spec §4) ──
  // turnComplete (or a finishReason, or a bare errorCode) on the final event seals
  // the turn. An errorCode-only event (a non-STOP finish with no finishReason and
  // no turnComplete — e.g. a block reason) MUST still seal; mapFinishReason already
  // folds `finishReason ?? errorCode`. A turn does not complete on a partial:true
  // incremental event.
  if (
    !isPartial &&
    (event.turnComplete === true || event.finishReason !== undefined || event.errorCode !== undefined)
  ) {
    const finishReason = mapFinishReason(event.finishReason ?? event.errorCode);
    e.push({
      type: "turn.done",
      seq: e.next(),
      turnId: `turn_${key}`,
      outcome: { type: "success" },
      finishReason,
    });
  }

  return e.events;
};

export default adkNormalizer;
export { adkNormalizer };
