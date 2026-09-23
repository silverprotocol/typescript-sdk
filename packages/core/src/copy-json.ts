/**
 * copy-json.ts — INTERNAL (not re-exported from index.ts).
 *
 * The one own-property deep copy every consumer-side reader in core uses, so
 * the §13 rule on `__proto__` has a single code path: stage-1 ingest
 * (ingest.ts), the stored-record readers (record.ts) and the input check
 * (input-check.ts).
 */
import type { JsonValue } from "./agjson.js";

/** Own-property deep copy of a JSON value, dropping `__proto__` at every depth. */
export function copyJson(v: JsonValue): JsonValue {
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
