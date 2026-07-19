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
 *
 * Lossless posture (Tenet 6): `push()` never throws. Unknown part types ride
 * `ext.vercel.frame{kind, frame}` (v7 adds `custom`, `reasoning-file`,
 * `tool-approval-*`; also v0-DEFERRED: `source`, `file`, `raw` — carried, not
 * yet mapped to first-class blocks). Guard failures ride
 * `ext.vercel.unparsed{native}`. `ai` is an OPTIONAL peer, never imported.
 */

import type { AgEvent, AgFinishReason, AgUsage, JsonValue, Normalizer } from "@silverprotocol/core";
import { StreamAssembler, toJsonValue } from "@silverprotocol/core";

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

// ─── wire → AgJSON value mapping ─────────────────────────────────────────────

/** fullStream `LanguageModelUsage` (flat tokens + detail bags — verified
 *  ai@7.0.26) → AgUsage. `cumulative` deliberately ABSENT (D1: totalUsage is
 *  carried verbatim on turn.done; per-step usage rides message.end). */
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
 * Stateful-per-invoke normalizer for one `streamText` run's fullStream.
 * `push(part)` → 0+ AgEvents; `flush()` seals anything still open.
 */
export function createVercelNormalizer(): Normalizer {
  const a = new StreamAssembler();

  let turnCounter = 0;
  let turnId: string | undefined; // current open turn
  let turnClosed = false;
  let stepIndex = 0;
  let stepId: string | undefined; // current open step marker id
  let msgId: string | undefined; // current open message id
  const openTextIds = new Set<string>();
  const openReasoningIds = new Set<string>();
  const pendingToolIds = new Set<string>(); // tool-input-start seen, tool-call not yet
  let stashedError: string | undefined; // last in-band error message (arms A/B)

  /** Mint + open the run's turn if not already open (defensive: arms other
   *  than `start` can arrive first on a hostile/truncated wire). */
  function ensureTurn(): string {
    if (turnId === undefined || turnClosed) {
      turnId = `turn_vercel_${++turnCounter}`;
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
          a.emitExt(THREAD_ID, "warnings", { stepId, warnings: safeJson(warnings) });
        }
        return;
      }

      case "text-start": {
        const id = str(part["id"]);
        if (id === undefined) break;
        openTextIds.add(id);
        a.textStart(id, ensureMessage());
        return;
      }
      case "text-delta": {
        const id = str(part["id"]);
        const text = str(part["text"]); // fullStream field is `text` (verified)
        if (id === undefined || text === undefined) break;
        a.textDelta(id, ensureMessage(), text, { cumulative: false });
        return;
      }
      case "text-end": {
        const id = str(part["id"]);
        if (id === undefined) break;
        openTextIds.delete(id);
        a.textEnd(id, ensureMessage());
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
        a.reasoningEnd(id, ensureMessage());
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
          a.emitExt(THREAD_ID, "invalid-tool-call", {
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
        if (str(part["finishReason"]) === "error") {
          a.closeTurnError(t, { message: stashedError ?? "provider error" });
        } else {
          const usage = mapUsage(part["totalUsage"]);
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
        // Non-terminal advisory (arm A); stashed for arm B's flush self-seal.
        stashedError = errText(part["error"]);
        a.emit({ type: "error", message: stashedError });
        return;
      }

      case VERCEL_HOST_ERROR: {
        // Arm C: transport failure thrown out of the iterator; host sentinel.
        const t = ensureTurn();
        stashedError = str(part["message"]) ?? "host iteration error";
        a.emit({ type: "error", message: stashedError });
        closeOpenMessage();
        a.closeTurnError(t, { message: stashedError });
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
    a.emitExt(THREAD_ID, "frame", { kind: part.type, frame: safeJson(part) });
  }

  return {
    push(native: unknown): AgEvent[] {
      if (!isVercelStreamPart(native)) {
        a.emitExt(THREAD_ID, "unparsed", { native: safeJson(native) });
        return a.drain();
      }
      drive(native);
      return a.drain();
    },
    flush(): AgEvent[] {
      if (turnId !== undefined && !turnClosed) {
        if (stashedError !== undefined) {
          // Arm B: in-band error and the stream just ended (doStream
          // rejection — verified: [start, error] then EOF). Self-seal.
          closeOpenMessage();
          a.closeTurnError(turnId, { message: stashedError });
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
