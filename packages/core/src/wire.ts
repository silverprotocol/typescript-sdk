/**
 * Wire projection (audit D5-a). SPEC §0.1 asserts every AgEvent is a plain
 * JSON value, but TypeScript cannot PROVE `AgEvent extends JsonValue`
 * (structural interfaces like AgUsage lack index signatures). These helpers
 * are the single sanctioned crossing: a JSON round-trip typed at the
 * boundary — never a cast. The wire.test round-trip suite is the executable
 * proof that the projection is byte-faithful.
 */
import type { AgEvent, JsonValue } from "./agjson.js";

export function toWire(e: AgEvent): JsonValue {
  const w: JsonValue = JSON.parse(JSON.stringify(e));
  return w;
}

export function toJsonValue(v: unknown): JsonValue {
  const w: JsonValue = JSON.parse(JSON.stringify(v));
  return w;
}
