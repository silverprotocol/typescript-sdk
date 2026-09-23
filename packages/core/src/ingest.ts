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
 * nested keys. The copy equals the validated value only because no schema in
 * agjson.ts rewrites values (no transform/default/coerce/catch/pipe/
 * preprocess); ingest.test.ts guards that.
 *
 * One exception, at every depth: a key named `__proto__` is dropped, never
 * copied. A consumer must not let wire data select the prototype of any object
 * it materialises (JSON.parse keeps such a key as an own property, and
 * assigning it would run Object.prototype's setter).
 */
import { AgEvent, type JsonValue } from "./agjson.js";

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

export function ingestAgEvent(v: JsonValue): AgEvent | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = AgEvent.safeParse(v);
  if (!r.success) return undefined;
  return copyJson(v) as unknown as AgEvent;
}

export function ingestAgEvents(vs: JsonValue[]): AgEvent[] {
  const out: AgEvent[] = [];
  for (const v of vs) {
    const e = ingestAgEvent(v);
    if (e !== undefined) out.push(e);
  }
  return out;
}
