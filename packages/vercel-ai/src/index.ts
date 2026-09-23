/**
 * `@silverprotocol/vercel-ai` — AgJSON normalizer for the Vercel AI SDK.
 *
 * Normalizes the `streamText` result's `fullStream` (v7: also `result.stream`)
 * — the `TextStreamPart` union — into AgJSON events. fullStream is the
 * in-process analog of the other three facets' inputs and the only Vercel
 * surface carrying typed usage (`finish-step.usage` / `finish.totalUsage`).
 *
 * DESIGN: docs/plans/2026-07-14-vercel-ai-facet-brief.md (private workspace)
 * — event mapping table + D1 decision sheet. Every wire shape below was
 * captured from REAL ai@7.0.26 fullStream output (keyless MockLanguageModelV3
 * runs, 2026-07-20), which corrected the survey in three places:
 *  - `text-delta`/`reasoning-delta` carry `text`; `tool-input-delta` carries
 *    `delta` (asymmetric on the real wire);
 *  - `start-step` carries NO response id — `{request, warnings}` only. The
 *    step's response identity (`id`, `modelId`) surfaces at
 *    `finish-step.response`, so message ids are minted synthetically at open
 *    (`msg_<turnId>_s<k>`) and the response identity lands as a
 *    `message.metadata` event at close;
 *  - fullStream `finishReason` is a flat string with a sibling
 *    `rawFinishReason` (the `{unified, raw}` object form exists only on the
 *    model-spec chunk grammar).
 *
 * Anchoring (D1-final): one `streamText` invocation = ONE turn (threadId fixed
 * `"vercel"`; no wire thread id — openai-facet precedent). One message PER
 * STEP: opened at `start-step`, sealed at `finish-step` with that step's
 * `usage`; `turn.done.usage` = `finish.totalUsage` VERBATIM (never summed,
 * `cumulative` absent). `step.start`/`step.done` ride as fold-neutral live
 * markers.
 *
 * Errors have three arms (all empirically captured):
 *  A. in-band `error` part with a later `finish` — non-terminal advisory
 *     `error` event, then the turn closes via `turn.error` (finishReason
 *     `"error"`) or `turn.done` (provider recovered and finished normally);
 *  B. in-band `error` part and the stream just ENDS (doStream rejection:
 *     `[start, error]`, no finish) — `flush()` self-seals the turn as
 *     `turn.error` with the stashed message;
 *  C. a raw throw out of `for await (fullStream)` (transport failure) — the
 *     HOST wraps iteration and pushes a `{type: VERCEL_HOST_ERROR, message}`
 *     sentinel (OpenAIHostError pattern), which closes message + turn.
 * Since ai@7.0.80 every provider mid-stream `error` payload reaches fullStream
 * wrapped in a `StreamProviderError` (own enumerable `type`/`code`/
 * `statusCode`/`isRetryable`/`data`; `data` = the raw provider frame). Arms A/B
 * project its `code`/`type` and `isRetryable` onto the AgJSON `code` /
 * `retriable` fields (see `errFields`); pre-7.0.80 string/plain-Error payloads
 * normalize byte-identically. Two more 7.0.66→7.0.90 runtime changes are
 * facet-NEUTRAL, recorded here only: 7.0.70 stops automatic tool execution
 * after finishReason length/content-filter/error/other (the step still closes
 * via finish-step/finish, so message + turn seal normally; a resultless tool
 * call rides as tool.start/args with no tool.done — carried as-is), and 7.0.76
 * remaps duplicate text/reasoning part ids across steps (open streams are
 * keyed per message, so a remapped id is just a new stream).
 * ai@7.0.94 (changeset 36b3364) added streamText-side enforcement of
 * `toolChoice` `required`/`tool`: when a step does not satisfy it, the SDK
 * enqueues an IN-BAND `error` part carrying a `ToolChoiceViolationError` right
 * after the model's terminal chunk. No new part type — the enforcement is only
 * a new PRODUCER of the existing `error` part. Both shapes are FIXTURE-ONLY:
 * the e2e capture agent never sets `toolChoice`, so neither can fire live.
 *  - shape A, zero qualifying tool calls ⇒ `error`,
 *    `finish-step{finishReason:'error'}`, `finish{finishReason:'error',
 *    totalUsage}`: the arm-A2 close, which forwards `totalUsage` onto
 *    `turn.error.usage` (the step really did burn tokens before violating).
 *    Unchanged on fullStream by ai@7.0.108;
 *  - shape B, a call to a DIFFERENT tool ⇒ since ai@7.0.108 (changeset
 *    ccf98e7) the violating step's internal `model-call-end` carries
 *    finishReason `'error'`, which the tool executor treats as
 *    execution-not-allowed: the wrong tool is NOT executed, the loop does not
 *    continue, and the run converges on the shape-A close — `tool-call`,
 *    `error`, `finish-step{error}`, `finish{error, totalUsage}` ⇒
 *    tool.start/args/assembled with NO tool.done (the 7.0.70 resultless-call
 *    shape above), the advisory `error`, then `turn.error` with usage. The
 *    existing arms already produce that; no facet code is specific to it.
 *    HISTORICAL (ai 7.0.94–7.0.107 only): the wrong tool still executed and a
 *    second step ran, so the run closed `turn.done{stop}`; `stashedError` is
 *    cleared at every `finish`, so the advisory did not leak into that close.
 *
 * Tool approval (ai>=7.0.102, changeset 8b92ba9): an automatically DENIED call
 * (`toolApproval` resolving `'denied'`) now also enqueues `tool-output-denied`
 * inside the step, after the `tool-approval-request{isAutomatic}` /
 * `tool-approval-response{approved:false, reason}` pair. That part HAS an
 * AgJSON home (SPEC §8 item 22 routes such frames to it): `tool.done
 * {outcome:"denied"}` (ToolOutcome; SPEC Pattern 4), content = the denial
 * `reason` the model receives, when the preceding approval response carried
 * one. streamText's initial pass also emits `tool-output-denied` for approvals
 * denied in a PREVIOUS call; that id has no tool.start in this turn, and it
 * settles as a bare tool.done exactly like the initial pass's prior-call
 * `tool-result` / `tool-error`. KNOWN GAP shared by all three: that bare
 * tool.done arrives before the first start-step, with no open message, so the
 * Reducer parks it (needsResync). Any fix belongs on all three arms together.
 * Fixture-only: the capture agent sets no `toolApproval`.
 *
 * Lossless posture (Tenet 6): `push()` never throws. Unknown part types ride
 * `ext.vercel.frame{kind, frame}` (v7 adds `custom`, `reasoning-file`,
 * `tool-approval-request` / `tool-approval-response` — the paused-turn HITL
 * mapping to `hitl.ask` is still deferred; a denying response's `reason` is
 * only READ, for the `tool-output-denied` close above, and the part itself
 * still rides the frame carry; also v0-DEFERRED: `source`, `file`, `raw` —
 * carried, not yet mapped to first-class blocks). Guard failures ride
 * `ext.vercel.unparsed{native}`. `ai` is an OPTIONAL peer, never imported.
 */

import type { AgEvent, AgFinishReason, AgUsage, JsonValue, Normalizer } from "@silverprotocol/core";
import { AgProviderMeta, StreamAssembler, toJsonValue } from "@silverprotocol/core";

// ─── host-boundary sentinel (error arm C) ────────────────────────────────────

/** Sentinel `type` the HOST pushes when `for await (fullStream)` itself throws
 *  (transport failure — bypasses even streamText's `onError`). Wrap iteration:
 *  `try { for await (const p of stream) out.push(...n.push(p)) } catch (e) {
 *     out.push(...n.push({ type: VERCEL_HOST_ERROR, message: String(e) })) }` */
export const VERCEL_HOST_ERROR = "__host_error__";

// ─── input contract — structural projection of the fullStream envelope ───────

/** The one invariant every `TextStreamPart` shares: a string `type` discriminant. */
export interface VercelStreamPart {
  type: string;
  [k: string]: unknown;
}

/** JSON-materialize ANY input without ever throwing (Tenet 6). */
function safeJson(v: unknown): JsonValue {
  if (v === undefined) return null;
  try {
    return toJsonValue(v);
  } catch {
    return String(v);
  }
}

/** True for a non-null, non-array object carrying a string `type` (guard idiom
 *  shared with the OpenAI facet — envelope-only; arm payloads are validated by
 *  the drive switch per-arm, widen-don't-cast). */
function isVercelStreamPart(v: unknown): v is VercelStreamPart {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { type?: unknown }).type === "string"
  );
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const rec = (v: unknown): { [k: string]: unknown } | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as { [k: string]: unknown }) : undefined;

/**
 * The part's AI SDK `providerMetadata` bag, verbatim, as AgProviderMeta — or
 * undefined when the part has none. Never throws (Tenet 6): a circular or
 * unserializable bag degrades to a string in safeJson, and only a
 * materialized object is carried.
 */
function partProviderMeta(part: VercelStreamPart): AgProviderMeta | undefined {
  if (part["providerMetadata"] === undefined) return undefined;
  const meta = rec(safeJson(part["providerMetadata"]));
  if (meta === undefined) return undefined;
  const parsed = AgProviderMeta.safeParse(meta);
  return parsed.success ? parsed.data : undefined;
}

/** Render any error-ish value to a message string, never throwing. */
function errText(v: unknown): string {
  if (v instanceof Error) return v.message;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** The AgJSON `error` / `turn.error` payload fields this facet populates. */
interface ErrorFields {
  message: string;
  code?: string;
  retriable?: boolean;
}

/**
 * Project an error-ish value to `ErrorFields`, never throwing. `message` is
 * `errText(v)` — UNCHANGED for strings, Error instances and plain objects.
 *
 * `code` / `retriable` are populated only when `v` is an Error or plain object
 * exposing the `StreamProviderError` fields ai>=7.0.80 wraps every provider
 * mid-stream `error` payload in (own enumerable `type`, `code`, `statusCode`,
 * `isRetryable`, `data`; @ai-sdk/openai emits them for Responses `error` SSE
 * events and `response.failed`):
 *  - `code` = `String(code)` — the provider-defined code (string or number,
 *    stringified). `type` is deliberately NOT a fallback: on the real wire it
 *    is the SSE envelope name (`'error'` for an OpenAI Responses error frame),
 *    not an error classification, and would masquerade as a code;
 *  - `retriable` = `isRetryable`. NOTE: the AI SDK INFERS `isRetryable` from
 *    `statusCode` (408/409/429/>=500) — or from well-known message text — when
 *    the provider frame omits it, so `retriable` is an SDK judgement, not
 *    necessarily a provider assertion. Carried verbatim; consumers wanting the
 *    provider's own word must read the raw frame.
 * A value without those fields projects to `{message}` alone, so pre-7.0.80
 * payloads (and plain Errors / strings) normalize byte-identically.
 */
function errFields(v: unknown): ErrorFields {
  const out: ErrorFields = { message: errText(v) };
  const bag = rec(v); // an Error instance is an object too — own props read as-is
  if (bag === undefined) return out;
  const code = bag["code"];
  if (typeof code === "string" || typeof code === "number") out.code = String(code);
  if (typeof bag["isRetryable"] === "boolean") out.retriable = bag["isRetryable"];
  return out;
}

// ─── wire → AgJSON value mapping ─────────────────────────────────────────────

/** fullStream `LanguageModelUsage` (flat tokens + detail bags — verified
 *  ai@7.0.26) → AgUsage. `cumulative` deliberately ABSENT (D1: totalUsage is
 *  carried verbatim on the turn-terminal — `turn.done` or `turn.error`; per-step
 *  usage rides message.end). Spec §4
 *  (draft.3): `outputTokens` is reasoning-INCLUSIVE upstream (ai normalizes
 *  every provider — Google included since v6 — to total + {text, reasoning}
 *  details), so it is copied verbatim and `outputTokenDetails.reasoningTokens`
 *  lands on `reasoningTokens` as the breakdown; `totalTokens` is copied from
 *  the framework wire (ai synthesizes it), never computed here. */
function mapUsage(v: unknown): AgUsage | undefined {
  const u = rec(v);
  if (u === undefined) return undefined;
  const inDet = rec(u["inputTokenDetails"]);
  const outDet = rec(u["outputTokenDetails"]);
  const out: AgUsage = {
    ...(num(u["inputTokens"]) !== undefined ? { inputTokens: num(u["inputTokens"]) } : {}),
    ...(num(u["outputTokens"]) !== undefined ? { outputTokens: num(u["outputTokens"]) } : {}),
    ...(num(u["totalTokens"]) !== undefined ? { totalTokens: num(u["totalTokens"]) } : {}),
    ...(num(inDet?.["cacheReadTokens"]) !== undefined
      ? { cacheReadTokens: num(inDet?.["cacheReadTokens"]) }
      : {}),
    ...(num(inDet?.["cacheWriteTokens"]) !== undefined
      ? { cacheWriteTokens: num(inDet?.["cacheWriteTokens"]) }
      : {}),
    ...(num(outDet?.["reasoningTokens"]) !== undefined
      ? { reasoningTokens: num(outDet?.["reasoningTokens"]) }
      : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** fullStream finishReason strings → AgFinishReason. `"error"` never reaches
 *  this map — it routes to `turn.error` in the `finish` arm. */
function mapFinishReason(v: unknown): AgFinishReason {
  switch (str(v)) {
    case "stop":
      return "stop";
    case "tool-calls":
      return "tool_call";
    case "length":
      return "token_limit";
    case "content-filter":
      return "safety_blocked";
    case "other":
      return "other";
    default:
      return "unknown";
  }
}

// ─── factory ──────────────────────────────────────────────────────────────────

const THREAD_ID = "vercel";

/**
 * The `ext.<vendor>.*` segment this facet emits under. Deliberately NOT
 * THREAD_ID: the other facets pass a vendor literal, and a thread id may one
 * day be host-supplied, which must never re-key the ext namespace. Same value
 * today, so the wire is unchanged. Whether SPEC reserves `vercel` alongside
 * anthropic/google/openai/langgraph is sp-protocol's call.
 */
const EXT_VENDOR = "vercel";

/** Options for {@link createVercelNormalizer}. */
export interface VercelNormalizerOptions {
  /**
   * The stem this invoke's ids are minted from: turn ids are
   * `turn_<invokeId>_<n>` and message ids `msg_turn_<invokeId>_<n>_s<step>`.
   *
   * Turn and message ids must be unique across every invoke folded into one
   * reducer (SPEC INV-BLOCK "collision-free derived ids"; a repeated turn id
   * re-opens a closed turn, which INV-MSG parks). The fullStream carries no
   * id before `finish-step`, so by default each normalizer draws a fresh
   * `vercel_<16 hex>` stem from `crypto.getRandomValues`.
   *
   * Pass one to make the output deterministic (replay, tests). A host that
   * passes it MUST keep it unique per invoke within a fold.
   */
  invokeId?: string;
}

/** 64 random bits as 16 hex chars: the default per-invoke id stem. */
function mintInvokeNonce(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stateful-per-invoke normalizer for one `streamText` run's fullStream.
 * `push(part)` → 0+ AgEvents; `flush()` seals anything still open. One
 * normalizer per invoke; see {@link VercelNormalizerOptions.invokeId} for
 * how its ids stay unique across invokes.
 */
export function createVercelNormalizer(options: VercelNormalizerOptions = {}): Normalizer {
  const a = new StreamAssembler();

  const turnStem = `turn_${options.invokeId ?? `vercel_${mintInvokeNonce()}`}`;
  let turnCounter = 0;
  let turnId: string | undefined; // current open turn
  let turnClosed = false;
  let stepIndex = 0;
  let stepId: string | undefined; // current open step marker id
  let msgId: string | undefined; // current open message id
  const openTextIds = new Set<string>();
  const openReasoningIds = new Set<string>();
  const pendingToolIds = new Set<string>(); // tool-input-start seen, tool-call not yet
  // toolCallId → `reason` of a DENYING tool-approval-response, read by the
  // following tool-output-denied (ai>=7.0.102). Empty unless approvals run.
  const deniedReasons = new Map<string, string>();
  let stashedError: ErrorFields | undefined; // last in-band error fields (arms A/B)

  /** Mint + open the run's turn if not already open (defensive: arms other
   *  than `start` can arrive first on a hostile/truncated wire). */
  function ensureTurn(): string {
    if (turnId === undefined || turnClosed) {
      turnId = `${turnStem}_${++turnCounter}`;
      turnClosed = false;
      a.openTurn(turnId, THREAD_ID);
    }
    return turnId;
  }

  /** Ensure an open message (defensive for content arriving before start-step). */
  function ensureMessage(): string {
    if (msgId === undefined) {
      const t = ensureTurn();
      stepIndex += 1;
      stepId = `step_${stepIndex}`;
      a.emit({ type: "step.start", id: stepId, turnId: t });
      msgId = `msg_${t}_s${stepIndex}`;
      a.openMessage({ id: msgId, role: "assistant", turnId: t, threadId: THREAD_ID, stepId });
    }
    return msgId;
  }

  /** Close any open text/reasoning streams (abort/host-error paths). */
  function endOpenStreams(): void {
    if (msgId === undefined) return;
    for (const id of openTextIds) a.textEnd(id, msgId);
    openTextIds.clear();
    for (const id of openReasoningIds) a.reasoningEnd(id, msgId);
    openReasoningIds.clear();
  }

  /** messageEnd BEFORE any turn-terminal event (D1/R5 ordering rule). */
  function closeOpenMessage(usage?: AgUsage): void {
    if (msgId === undefined) return;
    endOpenStreams();
    a.closeMessage(msgId, usage);
    if (stepId !== undefined) a.emit({ type: "step.done", id: stepId });
    msgId = undefined;
    stepId = undefined;
  }

  function drive(part: VercelStreamPart): void {
    switch (part.type) {
      case "start": {
        ensureTurn();
        return;
      }

      case "start-step": {
        const t = ensureTurn();
        // Seal a dangling previous step defensively (the real wire always
        // closes via finish-step first — verified tool-two-step capture).
        if (msgId !== undefined) closeOpenMessage();
        stepIndex += 1;
        stepId = `step_${stepIndex}`;
        a.emit({ type: "step.start", id: stepId, turnId: t });
        msgId = `msg_${t}_s${stepIndex}`;
        a.openMessage({ id: msgId, role: "assistant", turnId: t, threadId: THREAD_ID, stepId });
        const warnings = part["warnings"];
        if (Array.isArray(warnings) && warnings.length > 0) {
          a.emitExt(EXT_VENDOR, "warnings", { stepId, warnings: safeJson(warnings) });
        }
        return;
      }

      case "text-start": {
        const id = str(part["id"]);
        if (id === undefined) break;
        openTextIds.add(id);
        // The part's providerMetadata bag rides text.start/text.end verbatim.
        // Load-bearing case: OpenAI's gpt-5.5+ `phase` ("commentary" |
        // "final_answer") surfaces as providerMetadata.openai.phase on both
        // parts. OpenAI requires it resent on follow-up requests, and a
        // consumer that cannot see it merges commentary into the answer. The
        // openai facet carries the same field on text.end (openai-agents
        // index.ts `phaseMeta`); on text.start it is known before any delta.
        const meta = partProviderMeta(part);
        // draft.4 phase (rnd 13+17 stage 2): OpenAI's "commentary" (text a model
        // writes between tool calls) opens as phase "interim". The provider bag
        // still rides verbatim; "final_answer", unknown values or no bag → no key.
        const interim =
          meta !== undefined && Object.values(meta).some((v) => rec(v)?.["phase"] === "commentary");
        a.textStart(
          id,
          ensureMessage(),
          meta !== undefined || interim
            ? { ...(meta !== undefined ? { providerMetadata: meta } : {}), ...(interim ? { phase: "interim" } : {}) }
            : undefined,
        );
        return;
      }
      case "text-delta": {
        const id = str(part["id"]);
        const text = str(part["text"]); // fullStream field is `text` (verified)
        if (id === undefined || text === undefined) break;
        const msg = ensureMessage();
        // ai>=7.0.42 (changeset 6de2ec1): the upstream empty-text guard became
        // `text.length > 0 || providerMetadata != null`, so an empty delta now
        // reaches consumers when a chunk-level providerMetadata bag is its
        // WHOLE payload — dropping the bag would lose the entire chunk
        // (Tenet 6). Carried on text.delta's first-class providerMetadata slot
        // (the Reducer merges it onto the sealed block); the sugar has no
        // metadata parameter, so raw-emit (claude reasoning.start precedent).
        // Scoped to EMPTY deltas: non-empty deltas passed the old guard too,
        // so pre-7.0.42-shaped streams must normalize byte-identically — their
        // bag keeps the census's standing disclosed-drop disposition.
        if (text.length === 0 && part["providerMetadata"] !== undefined) {
          const meta = rec(safeJson(part["providerMetadata"]));
          // a circular/unserializable bag degrades to a string in safeJson —
          // only a materialized object parses as AgProviderMeta (never throw).
          if (meta !== undefined) {
            a.emit({
              type: "text.delta",
              id,
              messageId: msg,
              delta: text,
              providerMetadata: AgProviderMeta.parse(meta),
            });
            return;
          }
        }
        a.textDelta(id, msg, text, { cumulative: false });
        return;
      }
      case "text-end": {
        const id = str(part["id"]);
        if (id === undefined) break;
        openTextIds.delete(id);
        const meta = partProviderMeta(part); // see text-start
        a.textEnd(id, ensureMessage(), meta !== undefined ? { providerMetadata: meta } : undefined);
        return;
      }

      case "reasoning-start": {
        const id = str(part["id"]);
        if (id === undefined) break;
        openReasoningIds.add(id);
        a.reasoningStart(id, ensureMessage());
        return;
      }
      case "reasoning-delta": {
        const id = str(part["id"]);
        const text = str(part["text"]); // `text` here too (verified)
        if (id === undefined || text === undefined) break;
        a.reasoningDelta(id, ensureMessage(), text, { cumulative: false });
        return;
      }
      case "reasoning-end": {
        const id = str(part["id"]);
        if (id === undefined) break;
        openReasoningIds.delete(id);
        const msg = ensureMessage();
        a.reasoningEnd(id, msg);
        // Encrypted-reasoning carry (first vercel census triage, 2026-07-25,
        // corpus/echo-gpt56): providerMetadata.<provider>.reasoningEncryptedContent
        // is the replay-load-bearing signature analog of claude's `signature` /
        // adk's `thoughtSignature` — both sibling facets carry theirs via
        // reasoning.opaque, so this facet must too (Tenet: lossless on
        // replay-load-bearing payload). The end-of-block blob is the final,
        // authoritative one (the reasoning-start occurrence is an earlier
        // snapshot of the same channel). Provider-agnostic: the AI SDK nests
        // the field under whichever provider produced the part.
        const pm = rec(part["providerMetadata"]);
        if (pm !== undefined) {
          for (const [provider, entry] of Object.entries(pm)) {
            const bag = rec(entry);
            const encrypted = bag === undefined ? undefined : str(bag["reasoningEncryptedContent"]);
            if (encrypted !== undefined) {
              a.reasoningOpaque(id, msg, { kind: "encrypted", value: encrypted, provider });
            }
          }
        }
        return;
      }

      case "tool-input-start": {
        // fullStream keys the streamed-input lifecycle by `id` ≡ the eventual
        // `tool-call.toolCallId` (R1, verified live).
        const id = str(part["id"]);
        const name = str(part["toolName"]);
        if (id === undefined || name === undefined) break;
        pendingToolIds.add(id);
        a.toolStart({
          toolCallId: id,
          name,
          messageId: ensureMessage(),
          ...(typeof part["dynamic"] === "boolean" ? { dynamic: part["dynamic"] } : {}),
          ...(str(part["title"]) !== undefined ? { title: str(part["title"]) } : {}),
          ...(typeof part["providerExecuted"] === "boolean"
            ? { providerExecuted: part["providerExecuted"] }
            : {}),
        });
        return;
      }
      case "tool-input-delta": {
        const id = str(part["id"]);
        const delta = str(part["delta"]); // `delta` for tool input (verified)
        if (id === undefined || delta === undefined) break;
        a.toolArgsDelta(id, delta, { cumulative: false });
        return;
      }
      case "tool-input-end": {
        // Redundant on this seam — `tool-call` is the single authoritative
        // assembled-input source (mapping table §1).
        return;
      }
      case "tool-call": {
        const toolCallId = str(part["toolCallId"]);
        const name = str(part["toolName"]);
        if (toolCallId === undefined || name === undefined) break;
        const input = safeJson(part["input"] ?? {}); // parsed OBJECT on this wire (verified)
        if (!pendingToolIds.has(toolCallId)) {
          // Non-streamed call: synthesize the start+delta pair so the tool
          // lifecycle stays well-formed (openai-facet built-in-tool precedent).
          a.toolStart({
            toolCallId,
            name,
            messageId: ensureMessage(),
            ...(typeof part["dynamic"] === "boolean" ? { dynamic: part["dynamic"] } : {}),
          });
          a.toolArgsDelta(toolCallId, JSON.stringify(input), { cumulative: false });
        }
        pendingToolIds.delete(toolCallId);
        a.toolArgsAssembled(toolCallId, input);
        if (part["invalid"] === true) {
          a.emitExt(EXT_VENDOR, "invalid-tool-call", {
            toolCallId,
            error: errText(part["error"]),
          });
        }
        return;
      }
      case "tool-result": {
        const toolCallId = str(part["toolCallId"]);
        if (toolCallId === undefined) break;
        const output = safeJson(part["output"]);
        const preliminary = part["preliminary"] === true;
        a.toolDone({
          toolCallId,
          outcome: "ok",
          structuredContent: output,
          content: [
            { type: "text", text: typeof output === "string" ? output : JSON.stringify(output) },
          ],
          ...(preliminary ? { more: true, preliminary: true } : {}),
          ...(typeof part["dynamic"] === "boolean" ? { dynamic: part["dynamic"] } : {}),
        });
        return;
      }
      case "tool-error": {
        const toolCallId = str(part["toolCallId"]);
        if (toolCallId === undefined) break;
        const message = errText(part["error"]);
        a.toolDone({
          toolCallId,
          outcome: "error",
          isError: true,
          errorText: message,
          content: [{ type: "text", text: message }],
        });
        return;
      }
      case "tool-approval-response": {
        // NOT mapped (the paused-turn HITL design is still deferred), and the
        // part still rides the frame carry below byte-identically. A DENYING
        // response's `reason` is only read here so the tool-output-denied that
        // follows it can carry the text the model receives. `approved` is
        // compared strictly (`false`, not falsy); `reason` is typeof-guarded,
        // so an empty string is kept.
        if (part["approved"] === false) {
          const toolCallId = str(rec(part["toolCall"])?.["toolCallId"]);
          const reason = str(part["reason"]);
          if (toolCallId !== undefined) {
            if (reason !== undefined) deniedReasons.set(toolCallId, reason);
            else deniedReasons.delete(toolCallId);
          }
        }
        break; // → frame carry
      }
      case "tool-output-denied": {
        // ai>=7.0.102 (8b92ba9) in-step auto-denial, plus the initial-pass
        // producer for approvals denied in a PREVIOUS call. The home is
        // tool.done{outcome:"denied"}: a recorded outcome of its own, NOT an
        // isError alias (SPEC Pattern 4, claude permission_denials
        // precedent). One arm serves both producers. The in-step id already
        // has its tool.start (tool-input-start or the synthesized tool-call
        // path). The prior-call id gets a bare tool.done, the same as the
        // initial pass's `tool-result` / `tool-error` for prior-call ids, so
        // every prior-call id is handled one way.
        const toolCallId = str(part["toolCallId"]);
        if (toolCallId === undefined) break;
        const reason = deniedReasons.get(toolCallId);
        deniedReasons.delete(toolCallId);
        a.toolDone({
          toolCallId,
          outcome: "denied",
          content: reason !== undefined ? [{ type: "text", text: reason }] : [],
        });
        return;
      }

      case "finish-step": {
        const response = rec(part["response"]);
        if (msgId !== undefined && response !== undefined) {
          // The step's response identity only surfaces HERE (verified) —
          // land it as message metadata before sealing.
          const metadata: { [k: string]: JsonValue } = {};
          const responseId = str(response["id"]);
          const modelId = str(response["modelId"]);
          const rawFinish = str(part["rawFinishReason"]);
          if (responseId !== undefined) metadata["responseId"] = responseId;
          if (modelId !== undefined) metadata["model"] = modelId;
          if (rawFinish !== undefined) metadata["rawFinishReason"] = rawFinish;
          if (Object.keys(metadata).length > 0) {
            a.emit({ type: "message.metadata", messageId: msgId, metadata });
          }
        }
        closeOpenMessage(mapUsage(part["usage"]));
        return;
      }

      case "finish": {
        const t = ensureTurn();
        closeOpenMessage(); // defensive; the real wire closes via finish-step first
        // `finish.totalUsage` is populated on BOTH branches — ai builds the part
        // as `{finishReason: stepFinishReason, totalUsage: combinedUsage}`, and
        // `combinedUsage` accrues every step's usage regardless of how the run
        // ended. An errored turn therefore still reports the tokens it burned
        // (the ai>=7.0.94 toolChoice-enforcement close is exactly this shape:
        // finish{finishReason:'error'} with a full totalUsage — shape A always,
        // and shape B too from ai@7.0.108). Mapped ONCE and
        // forwarded to whichever close runs — `turn.error` carries usage on the
        // same optional slot `turn.done` does (spec §4; openai-agents facet
        // precedent, which fills it on its own error closes). Absent/empty
        // totalUsage ⇒ `mapUsage` returns undefined ⇒ no `usage` key at all.
        const usage = mapUsage(part["totalUsage"]);
        if (str(part["finishReason"]) === "error") {
          // The stashed arm-A fields (message + optional code/retriable) close
          // the turn; a bare finish{error} with no prior error part falls back.
          a.closeTurnError(t, {
            ...(stashedError ?? { message: "provider error" }),
            ...(usage !== undefined ? { usage } : {}),
          });
        } else {
          a.closeTurnDone(t, {
            outcome: { type: "success" },
            finishReason: mapFinishReason(part["finishReason"]),
            ...(usage !== undefined ? { usage } : {}),
          });
        }
        turnClosed = true;
        stashedError = undefined;
        return;
      }

      case "error": {
        // Non-terminal advisory (arm A); stashed for arm B's flush self-seal
        // and the finish{error} close. `code`/`retriable` present only when
        // the payload exposes StreamProviderError fields (see errFields).
        stashedError = errFields(part["error"]);
        a.emit({ type: "error", ...stashedError });
        return;
      }

      case VERCEL_HOST_ERROR: {
        // Arm C: transport failure thrown out of the iterator; host sentinel
        // (message-only — the host renders the throw to a string).
        const t = ensureTurn();
        stashedError = { message: str(part["message"]) ?? "host iteration error" };
        a.emit({ type: "error", ...stashedError });
        closeOpenMessage();
        a.closeTurnError(t, stashedError);
        turnClosed = true;
        stashedError = undefined;
        return;
      }

      case "abort": {
        const t = ensureTurn();
        closeOpenMessage(); // messageEnd BEFORE turn.abort (R5 ordering rule)
        const reason = str(part["reason"]);
        a.emit({ type: "turn.abort", turnId: t, ...(reason !== undefined ? { reason } : {}) });
        turnClosed = true;
        return;
      }

      default:
        break; // → tolerant frame carry below
    }
    // Tolerant default arm (R2): unknown part types AND known types with
    // malformed payloads ride the lossless vendor channel.
    a.emitExt(EXT_VENDOR, "frame", { kind: part.type, frame: safeJson(part) });
  }

  return {
    push(native: unknown): AgEvent[] {
      if (!isVercelStreamPart(native)) {
        a.emitExt(EXT_VENDOR, "unparsed", { native: safeJson(native) });
        return a.drain();
      }
      drive(native);
      return a.drain();
    },
    flush(): AgEvent[] {
      if (turnId !== undefined && !turnClosed) {
        if (stashedError !== undefined) {
          // Arm B: in-band error and the stream just ended (doStream
          // rejection — verified: [start, error] then EOF). Self-seal with the
          // stashed fields (message + optional code/retriable).
          closeOpenMessage();
          a.closeTurnError(turnId, stashedError);
          turnClosed = true;
          stashedError = undefined;
        } else {
          // Truncated stream with no error signal: seal the message; the
          // engine's flush (INV-FLUSH) aborts the still-open turn.
          closeOpenMessage();
        }
      }
      return a.flush();
    },
  };
}

export default createVercelNormalizer;
export type { AgEvent, JsonValue };
