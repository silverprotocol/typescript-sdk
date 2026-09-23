/**
 * Consumer-ingestion posture (SPEC §0.2 / §12; audit B5).
 *
 * A consumer validating incoming events MUST parse-known-else-skip and pass
 * unknown fields through, so additive-minor spec revisions survive. This is
 * DISTINCT from producer conformance (`AgEvent.parse`), which rejects anything
 * outside the schema.
 *
 * Field-passthrough scope: unknown TOP-LEVEL fields are preserved verbatim.
 * Nested structured sub-objects are returned in validated form; the opaque
 * channels (`_meta`, `providerMetadata`, provider payload fields) are typed as
 * opaque bags and therefore pass through in full by construction.
 */
import { AgEvent, type JsonValue } from "./agjson.js";

export function ingestAgEvent(v: JsonValue): AgEvent | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = AgEvent.safeParse(v);
  if (!r.success) return undefined;
  // Preserve unknown top-level fields: validated keys win, unknown keys ride
  // along, in the same key order a plain merge would give. Keys are DEFINED,
  // never assigned: assigning a wire key named `__proto__` runs
  // Object.prototype's setter, which would let wire data choose the returned
  // event's prototype, and then fields it never carried (and the schema never
  // validated) would be inherited (SPEC.md:759, :27). That one key is skipped
  // outright, matching zod, which keeps it at no nested depth either.
  const out: { [k: string]: unknown } = {};
  for (const src of [v, r.data] as ReadonlyArray<{ [k: string]: unknown }>) {
    for (const k of Object.keys(src)) {
      if (k === "__proto__") continue;
      Object.defineProperty(out, k, { value: src[k], enumerable: true, writable: true, configurable: true });
    }
  }
  return out as AgEvent;
}

export function ingestAgEvents(vs: JsonValue[]): AgEvent[] {
  const out: AgEvent[] = [];
  for (const v of vs) {
    const e = ingestAgEvent(v);
    if (e !== undefined) out.push(e);
  }
  return out;
}
