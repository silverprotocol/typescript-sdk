/**
 * convergence.ts — I4 cross-framework convergence assertion for the AgJSON
 * E2E conformance harness.
 *
 * Canonicalizes an AgJSON event stream into a framework-neutral CanonicalSchema
 * that can be compared across normalizer implementations (e.g. Claude vs OpenAI).
 *
 * ## Must-IGNORE (stripped during canonicalization)
 *   - `seq` — per-event sequence counter (layout artifact)
 *   - all identity fields: `turnId`, `threadId`, `toolCallId`, `messageId`, `id`, `itemId`
 *   - `usage` — token counts differ per provider
 *   - `providerMetadata` — provider-specific opaque bag
 *   - `ts` — wall-clock timestamp
 *   - `model` — model identifier (provider-specific)
 *   - `_meta` — host-only metadata bag
 *   - any key matching `*_ms` (timing)
 *
 * ## Must-MATCH (load-bearing)
 *   - event-type sequence (with `.delta` streaming noise dropped)
 *   - tool-call name + canonicalized input (object keys sorted recursively)
 *   - assistant text content (concatenated across all text.delta events, per block)
 *   - tool-result outcome
 *   - finishReason (both normalizers emit the neutral AgFinishReason; no remap)
 */

import type { JsonValue } from "@silverprotocol/core";

// ─── Public interface ─────────────────────────────────────────────────────────

export interface CanonicalSchema {
  /** Load-bearing event types in order, with `.delta` streaming noise dropped. */
  eventSequence: string[];
  /** Tool calls: name + recursively key-sorted input. */
  toolCalls: Array<{ name: string; input: JsonValue }>;
  /** Assistant text blocks, each concatenated from their text.delta fragments. */
  textContent: string[];
  /** Tool results: outcome only (content is provider-shaped). */
  toolResults: Array<{ outcome: string }>;
  /** Finish reason from the last turn.done that carries one, or undefined. */
  finishReason: string | undefined;
}

// ─── Type guards ──────────────────────────────────────────────────────────────

/**
 * True when `v` is a non-null, non-array plain object.
 * Reuses the same guard pattern as census.ts.
 */
function isObject(v: JsonValue): v is { [k: string]: JsonValue } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Extract a string field from an event object, or undefined if absent/non-string. */
function strField(ev: { [k: string]: JsonValue }, key: string): string | undefined {
  const v = ev[key];
  return typeof v === "string" ? v : undefined;
}

// ─── MUST-IGNORE set ──────────────────────────────────────────────────────────

/** Keys that are always stripped during canonicalization. */
const MUST_IGNORE_KEYS = new Set([
  "seq",
  "turnId",
  "threadId",
  "toolCallId",
  "messageId",
  "id",
  "itemId",
  "usage",
  "providerMetadata",
  "ts",
  "model",
  "_meta",
]);

/** True for any key matching `*_ms` (timing field pattern). */
function isTimingKey(key: string): boolean {
  return key.endsWith("_ms");
}

// ─── NOISE event types (dropped from the event sequence) ─────────────────────

/**
 * Event types that are streaming noise or provider-specific intermediate steps.
 * These are stripped from the canonical event sequence.
 *
 * Drop rules:
 *   - All `.delta` variants (streaming fragments — content is captured separately)
 *   - `reasoning.*` — provider-specific thinking; not part of the load-bearing task
 *   - `subagent.start` / `subagent.done` — subagent lifecycle (Claude-specific)
 *   - `message.start` / `message.end` — envelope-only, no semantic content
 *   - `turn.start` / `turn.done` — turn-lifecycle events: providers differ in how many
 *     turns they use for a single tool-call+response cycle (OpenAI = 2 turns, Claude = 1).
 *     finishReason and outcome are captured from turn.done SEPARATELY — they are not lost.
 *   - `text.start` / `text.end` — text-block boundaries; content is captured separately
 */
const NOISE_EVENT_TYPES = new Set([
  "text.delta",
  "tool.args.delta",
  "reasoning.delta",
  "reasoning.start",
  "reasoning.end",
  "reasoning.opaque",
  "subagent.start",
  "subagent.done",
  "message.start",
  "message.end",
  "turn.start",
  "turn.done",
  "text.start",
  "text.end",
]);

// ─── sortKeys — recursive key-sort for canonical input comparison ─────────────

/**
 * Recursively sorts all object keys alphabetically so that `{b:1,a:2}` and
 * `{a:2,b:1}` produce the same canonical form.
 * Reuses the same recursive walk pattern used in census.ts rather than
 * reimplementing a separate key-sort utility.
 */
export function sortKeys(value: JsonValue): JsonValue {
  if (!isObject(value)) {
    if (Array.isArray(value)) {
      return (value as JsonValue[]).map(sortKeys);
    }
    return value;
  }
  const sorted: { [k: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) {
      sorted[key] = sortKeys(child);
    }
  }
  return sorted;
}

// ─── canonicalizeAgjson ───────────────────────────────────────────────────────

/**
 * Converts an AgJSON event array into a provider-neutral CanonicalSchema.
 *
 * Walk strategy:
 *   - For each event, extract its `type` field (must be a string).
 *   - Skip NOISE_EVENT_TYPES from the event sequence.
 *   - Accumulate per-tool-call text (text.delta → textContent block).
 *   - Extract tool-call name+input from tool.args.assembled.
 *   - Extract tool-result outcome from tool.done.
 *   - Extract finishReason from turn.done (last one wins).
 */
export function canonicalizeAgjson(agjson: JsonValue[]): CanonicalSchema {
  const eventSequence: string[] = [];
  const toolCalls: Array<{ name: string; input: JsonValue }> = [];
  const textContent: string[] = [];
  const toolResults: Array<{ outcome: string }> = [];
  let finishReason: string | undefined;

  // Per-text-block accumulator: itemId (or id) → accumulated text.
  // Since we strip ids in the canonical schema, we only need the ordering.
  // We use an insertion-order Map keyed by the raw id from the stream.
  const textBlocks = new Map<string, string>();

  // Per-tool accumulator: toolCallId → tool name (from tool.start).
  const toolNames = new Map<string, string>();

  for (const raw of agjson) {
    if (!isObject(raw)) continue;
    const type = strField(raw, "type");
    if (type === undefined) continue;

    // ── Capture text.start (open a new text block) ──────────────────────────
    if (type === "text.start") {
      const blockId = strField(raw, "id");
      if (blockId !== undefined && !textBlocks.has(blockId)) {
        textBlocks.set(blockId, "");
      }
      // text.start IS a noise event — skip from eventSequence
      continue;
    }

    // ── Capture text.delta (accumulate into the current block) ─────────────
    if (type === "text.delta") {
      const blockId = strField(raw, "id");
      const delta = strField(raw, "delta");
      if (blockId !== undefined && delta !== undefined) {
        textBlocks.set(blockId, (textBlocks.get(blockId) ?? "") + delta);
      }
      // text.delta is noise — skip from eventSequence
      continue;
    }

    // ── Capture text.end (finalize the text block) ──────────────────────────
    if (type === "text.end") {
      const blockId = strField(raw, "id");
      if (blockId !== undefined) {
        const accumulated = textBlocks.get(blockId);
        if (accumulated !== undefined && accumulated.length > 0) {
          textContent.push(accumulated);
        }
        textBlocks.delete(blockId);
      }
      // text.end IS a noise event — skip from eventSequence
      continue;
    }

    // ── Capture tool.start (record tool name keyed by toolCallId) ───────────
    if (type === "tool.start") {
      const callId = strField(raw, "toolCallId");
      const name = strField(raw, "name");
      if (callId !== undefined && name !== undefined) {
        toolNames.set(callId, name);
      }
      // tool.start IS load-bearing — add to sequence
      if (!NOISE_EVENT_TYPES.has(type)) {
        eventSequence.push(type);
      }
      continue;
    }

    // ── Capture tool.args.assembled (record name + canonical input) ──────────
    if (type === "tool.args.assembled") {
      const callId = strField(raw, "toolCallId");
      const inputRaw = raw["input"];
      const name = callId !== undefined ? (toolNames.get(callId) ?? callId) : "unknown";
      const input = inputRaw !== undefined ? sortKeys(inputRaw) : null;
      toolCalls.push({ name, input });
      // tool.args.assembled IS load-bearing — add to sequence
      if (!NOISE_EVENT_TYPES.has(type)) {
        eventSequence.push(type);
      }
      continue;
    }

    // ── Capture tool.done (record outcome) ──────────────────────────────────
    if (type === "tool.done") {
      const outcomeRaw = raw["outcome"];
      const outcome = typeof outcomeRaw === "string" ? outcomeRaw : "unknown";
      toolResults.push({ outcome });
      if (!NOISE_EVENT_TYPES.has(type)) {
        eventSequence.push(type);
      }
      continue;
    }

    // ── Capture turn.done (record finishReason — last wins) ─────────────────
    if (type === "turn.done") {
      const reason = strField(raw, "finishReason");
      if (reason !== undefined) {
        finishReason = reason;
      }
      if (!NOISE_EVENT_TYPES.has(type)) {
        eventSequence.push(type);
      }
      continue;
    }

    // ── All other event types: add to sequence if not noise ──────────────────
    if (!NOISE_EVENT_TYPES.has(type)) {
      eventSequence.push(type);
    }
  }

  // Flush any unclosed text blocks (shouldn't happen in well-formed streams,
  // but be defensive: include non-empty accumulated text).
  for (const [, accumulated] of textBlocks) {
    if (accumulated.length > 0) {
      textContent.push(accumulated);
    }
  }

  return { eventSequence, toolCalls, textContent, toolResults, finishReason };
}

// ─── assertConvergent ─────────────────────────────────────────────────────────

/**
 * Asserts that two canonical schemas are structurally equivalent.
 * Throws an aggregated, human-readable diff on any mismatch — listing EVERY
 * failing check so the caller can fix all problems in one pass.
 *
 * Checks (in order):
 *   1. eventSequence deep-equal
 *   2. toolCalls length equal
 *   3. each toolCall name + input deep-equal (by position)
 *   4. textContent deep-equal (order + content)
 *   5. toolResults length equal + each outcome equal
 *   6. finishReason equal
 */
export function assertConvergent(
  a: CanonicalSchema,
  b: CanonicalSchema,
  ctx: { scenario: string; fw1: string; fw2: string },
): void {
  const diffs: string[] = [];
  const label = `[${ctx.scenario}] ${ctx.fw1} vs ${ctx.fw2}`;

  // ── 1. eventSequence ──────────────────────────────────────────────────────
  if (JSON.stringify(a.eventSequence) !== JSON.stringify(b.eventSequence)) {
    diffs.push(
      `eventSequence mismatch:\n` +
        `  ${ctx.fw1}: ${JSON.stringify(a.eventSequence)}\n` +
        `  ${ctx.fw2}: ${JSON.stringify(b.eventSequence)}`,
    );
  }

  // ── 2+3. toolCalls ────────────────────────────────────────────────────────
  if (a.toolCalls.length !== b.toolCalls.length) {
    diffs.push(
      `toolCalls.length mismatch: ${ctx.fw1}=${a.toolCalls.length} ${ctx.fw2}=${b.toolCalls.length}`,
    );
  } else {
    for (let i = 0; i < a.toolCalls.length; i++) {
      const ta = a.toolCalls[i];
      const tb = b.toolCalls[i];
      if (ta === undefined || tb === undefined) continue;
      if (ta.name !== tb.name) {
        diffs.push(
          `toolCalls[${i}].name mismatch: ${ctx.fw1}="${ta.name}" ${ctx.fw2}="${tb.name}"`,
        );
      }
      if (JSON.stringify(ta.input) !== JSON.stringify(tb.input)) {
        diffs.push(
          `toolCalls[${i}].input mismatch:\n` +
            `  ${ctx.fw1}: ${JSON.stringify(ta.input)}\n` +
            `  ${ctx.fw2}: ${JSON.stringify(tb.input)}`,
        );
      }
    }
  }

  // ── 4. textContent ────────────────────────────────────────────────────────
  if (JSON.stringify(a.textContent) !== JSON.stringify(b.textContent)) {
    diffs.push(
      `textContent mismatch:\n` +
        `  ${ctx.fw1}: ${JSON.stringify(a.textContent)}\n` +
        `  ${ctx.fw2}: ${JSON.stringify(b.textContent)}`,
    );
  }

  // ── 5. toolResults ────────────────────────────────────────────────────────
  if (a.toolResults.length !== b.toolResults.length) {
    diffs.push(
      `toolResults.length mismatch: ${ctx.fw1}=${a.toolResults.length} ${ctx.fw2}=${b.toolResults.length}`,
    );
  } else {
    for (let i = 0; i < a.toolResults.length; i++) {
      const ra = a.toolResults[i];
      const rb = b.toolResults[i];
      if (ra === undefined || rb === undefined) continue;
      if (ra.outcome !== rb.outcome) {
        diffs.push(
          `toolResults[${i}].outcome mismatch: ${ctx.fw1}="${ra.outcome}" ${ctx.fw2}="${rb.outcome}"`,
        );
      }
    }
  }

  // ── 6. finishReason ───────────────────────────────────────────────────────
  if (a.finishReason !== b.finishReason) {
    diffs.push(
      `finishReason mismatch: ${ctx.fw1}=${JSON.stringify(a.finishReason)} ${ctx.fw2}=${JSON.stringify(b.finishReason)}`,
    );
  }

  if (diffs.length > 0) {
    throw new Error(
      `Convergence assertion failed ${label}:\n` + diffs.map((d) => `  • ${d}`).join("\n"),
    );
  }
}
