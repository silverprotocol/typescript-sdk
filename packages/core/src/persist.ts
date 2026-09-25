/**
 * persist.ts — the persistable projection of a fold.
 *
 * A turn record's `displayRequired[]` holds grounding UI a provider requires a
 * display to render (e.g. Google Search Suggestions; the render duty is SPEC
 * §13.3), and the provider's terms may forbid storing it. `toPersistable` is
 * what a host stores by default: the same fold with every turn record's
 * `displayRequired` omitted.
 */
import type { AgReduceResult } from "./agjson.js";

/**
 * A deep copy of `result` with `displayRequired` deleted from every turn
 * record; nothing else changes, and `result` itself is not mutated. Persist
 * this unless the grounding provider's terms permit storing `displayRequired`.
 */
export function toPersistable(result: AgReduceResult): AgReduceResult {
  const copy = structuredClone(result);
  for (const turn of copy.turns) delete (turn as { displayRequired?: unknown }).displayRequired;
  return copy;
}
