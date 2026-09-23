/**
 * Consumer-ingestion posture (SPEC §0.2 / §12; audit B5).
 *
 * A consumer validating incoming events MUST parse-known-else-skip and pass
 * unknown fields through, so additive-minor spec revisions survive. This is
 * DISTINCT from producer conformance (`AgEvent.parse`), which rejects anything
 * outside the schema.
 *
 * Field-passthrough scope: unknown fields are preserved verbatim at EVERY
 * depth (SPEC.md:27 does not limit "untouched" to the top level). After a
 * successful `AgEvent.safeParse`, the returned event is an own-property deep
 * copy of the RAW input, not zod's validated output, which strips unknown
 * nested keys. The copy carries the same keys and values as the validated
 * value only because no schema in agjson.ts rewrites values (no transform/
 * default/coerce/catch/pipe/preprocess); ingest.test.ts guards that. It is
 * NOT byte-identical to it: nested objects keep the PRODUCER's key order,
 * where zod's output (and so 0.6.4's ingest) used the schema's. Over the
 * 0.6.5 corpus that reordered 64 of 1,103 events, all inside `usage`.
 *
 * One exception, at every depth: a key named `__proto__` is dropped, never
 * copied. A consumer must not let wire data select the prototype of any object
 * it materialises (JSON.parse keeps such a key as an own property, and
 * assigning it would run Object.prototype's setter).
 *
 * Forward-compatible ingest (draft.4 §0.2, workspace#20 stage 2). Every input
 * lands in exactly one of three places:
 *  - a WELL-FORMED ENVELOPE (a JSON object whose `type` is a string and whose
 *    `seq` is a finite number) that validates → the event, as above;
 *  - a well-formed envelope that does NOT validate (an undefined type, an
 *    unknown enum value or block, a malformed known type) → IN PLACE, the
 *    stub `{type: "ext.agjson.ignored", seq, ignoredType, raw}`. It is a
 *    typed ext event: it never folds, but a Reducer counts its `seq` slot,
 *    so an ignored event can no longer open a false gap. `raw` is the
 *    original frame (same copy rules) and is LIVE-ONLY: never persist it;
 *  - anything else (not an object, a non-string `type`, a missing or
 *    non-number `seq`) → not an event and occupies no slot: returns
 *    undefined and is reported through the optional `onReject` callback.
 * ingestAgEvent/ingestAgEvents never throw, even if `onReject` does.
 */
import { AgEvent, type JsonValue } from "./agjson.js";

/** Why an input is not a well-formed envelope (draft.4 §0.2). */
export type AgIngestRejectReason = "not-object" | "type-not-string" | "seq-not-number";

/** A non-envelope input, reported through `IngestOptions.onReject`. */
export interface AgIngestReject {
  input: JsonValue;
  reason: AgIngestRejectReason;
}

export interface IngestOptions {
  /** Called once per non-envelope input. It occupies no seq slot. A throw is swallowed. */
  onReject?: (reject: AgIngestReject) => void;
}

/** The in-place report for an ignored well-formed envelope. `raw` is live-only. */
export interface AgIgnoredEvent {
  type: "ext.agjson.ignored";
  seq: number;
  ignoredType: string;
  raw: JsonValue;
}

function envelopeProblem(v: JsonValue): AgIngestRejectReason | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "not-object";
  if (typeof v["type"] !== "string") return "type-not-string";
  const seq = v["seq"];
  if (typeof seq !== "number" || !Number.isFinite(seq)) return "seq-not-number";
  return undefined;
}

/** Own-property deep copy of a JSON value, dropping `__proto__` at every depth. */
function copyJson(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(copyJson);
  if (v === null || typeof v !== "object") return v;
  const out: { [k: string]: JsonValue } = {};
  for (const k of Object.keys(v)) {
    if (k === "__proto__") continue;
    // DEFINED, never assigned (belt and braces with the skip above).
    Object.defineProperty(out, k, {
      value: copyJson((v as { [k: string]: JsonValue })[k]!),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function ingestAgEvent(v: JsonValue, opts?: IngestOptions): AgEvent | undefined {
  const problem = envelopeProblem(v);
  if (problem !== undefined) {
    try {
      opts?.onReject?.({ input: v, reason: problem });
    } catch {
      // never-throw contract: a host callback bug must not break ingest
    }
    return undefined;
  }
  const env = v as { [k: string]: JsonValue };
  if (AgEvent.safeParse(v).success) return copyJson(v) as unknown as AgEvent;
  const stub: AgIgnoredEvent = {
    type: "ext.agjson.ignored",
    seq: env["seq"] as number,
    ignoredType: env["type"] as string,
    raw: copyJson(v),
  };
  return stub as unknown as AgEvent;
}

export function ingestAgEvents(vs: JsonValue[], opts?: IngestOptions): AgEvent[] {
  const out: AgEvent[] = [];
  for (const v of vs) {
    const e = ingestAgEvent(v, opts);
    if (e !== undefined) out.push(e);
  }
  return out;
}
