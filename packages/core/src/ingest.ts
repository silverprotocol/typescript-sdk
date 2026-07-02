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
  // Preserve unknown top-level fields: validated keys win, unknown keys ride along.
  return Object.assign({}, v, r.data);
}

export function ingestAgEvents(vs: JsonValue[]): AgEvent[] {
  const out: AgEvent[] = [];
  for (const v of vs) {
    const e = ingestAgEvent(v);
    if (e !== undefined) out.push(e);
  }
  return out;
}
