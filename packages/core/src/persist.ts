/**
 * persist.ts — the persistable projection of a fold.
 *
 * A turn record's `displayRequired[]` holds grounding UI a provider requires a
 * display to render (e.g. Google Search Suggestions), and the provider's terms
 * may forbid storing it (SPEC §13.3, "Grounding records and the host").
 * `toPersistable` is what a host stores by default: the same fold with every
 * turn record's `displayRequired` omitted (§10 item 51). The same terms may
 * limit `sources[]` and the grounded content, which it leaves in place.
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
