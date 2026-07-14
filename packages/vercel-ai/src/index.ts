/**
 * `@silverprotocol/vercel-ai` — AgJSON normalizer for the Vercel AI SDK.
 *
 * Normalizes the `streamText` result's `fullStream` (v7: `result.stream`) —
 * the `TextStreamPart` union — into AgJSON events. The fullStream surface is
 * the in-process analog of the other three facets' inputs and the only Vercel
 * surface carrying typed usage (`finish-step.usage` / `finish.totalUsage`).
 *
 * DESIGN: docs/plans/2026-07-14-vercel-ai-facet-brief.md in the private
 * workspace (event mapping table + D1 decision sheet). Contract finals from
 * the D1 risk burn-down (all empirically verified on ai@7.0.26):
 *  - one `streamText` invocation = ONE turn (threadId fixed "vercel" — no wire
 *    thread id; openai-facet precedent);
 *  - one message PER STEP: opened at `start-step`, id minted from the step's
 *    `response-metadata.id`, sealed at `finish-step` with that step's usage;
 *    `turn.done.usage` = `finish.totalUsage` VERBATIM (never summed);
 *  - tool correlation: `tool-input-start.id` === `tool-call.toolCallId`
 *    (verified live, R1);
 *  - errors have THREE arms (R4): in-band `error` + later `finish` → error
 *    event then normal close; in-band `error` then EOF → self-seal;
 *    raw iterator throw → host wraps and injects a `__host_error__` sentinel;
 *  - unknown part types ride `ext.vercel.frame{kind,frame}` (tolerant default
 *    arm — v7 adds `custom`/`reasoning-file`/`tool-approval-response`);
 *    guard failures ride `ext.vercel.unparsed{native}` (Tenet 6: push() never
 *    throws, nothing is ever dropped).
 *
 * STATUS: v0 scaffold — the envelope guard and the lossless carry channels are
 * live (every input is preserved, byte-faithfully, today); the lifecycle drive
 * switch (text/reasoning/tool/step/finish arms per the mapping table) lands
 * next, replacing the frame-carry fallthrough case by case. `ai` is an
 * OPTIONAL peer, never imported: the input contract is a hand-defined
 * structural projection of `TextStreamPart`, guarded at runtime.
 */

import type { AgEvent, JsonValue, Normalizer } from "@silverprotocol/core";
import { StreamAssembler, toJsonValue } from "@silverprotocol/core";

// ─── input contract — structural projection of the fullStream envelope ───────

/** The one invariant every `TextStreamPart` shares: a string `type` discriminant. */
export interface VercelStreamPart {
  type: string;
  [k: string]: unknown;
}

/** JSON-materialize ANY input without ever throwing (Tenet 6): `undefined`,
 *  functions, symbols, and circular structures all coerce to a lossless-enough
 *  representation instead of crashing `push()`. */
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

// ─── factory ──────────────────────────────────────────────────────────────────

/**
 * Stateful-per-invoke normalizer for one `streamText` run's fullStream.
 * `push(part)` → 0+ AgEvents; `flush()` seals anything still open.
 */
export function createVercelNormalizer(): Normalizer {
  const a = new StreamAssembler();

  return {
    push(native: unknown): AgEvent[] {
      if (!isVercelStreamPart(native)) {
        // Graceful guard (Tenet 6): route a genuinely unrecognisable payload
        // through the lossless vendor channel rather than throwing. Nested
        // under `native` so a payload carrying its own keys cannot clobber
        // the ext envelope (anti-clobber, openai-facet precedent).
        a.emitExt("vercel", "unparsed", { native: safeJson(native) });
        return a.drain();
      }
      // v0 scaffold: every recognized part rides the RECOMMENDED tolerant
      // carry (SPEC §ext — `ext.vercel.frame{kind,frame}`) until its lifecycle
      // arm lands in the drive switch. Lossless by construction.
      a.emitExt("vercel", "frame", {
        kind: native.type,
        frame: safeJson(native),
      });
      return a.drain();
    },
    flush(): AgEvent[] {
      // No lifecycle state yet — the engine's flush closes nothing because
      // nothing is opened. The drive switch will hand real open turns/messages
      // to this same call (I7 / INV-FLUSH).
      return a.flush();
    },
  };
}

export default createVercelNormalizer;
export type { AgEvent, JsonValue };
