/**
 * persist.ts — the persistable projection of a fold.
 *
 * A turn record's `displayRequired[]` holds grounding UI a provider requires a
 * display to render (e.g. Google Search Suggestions), and the provider's terms
 * may forbid storing it (SPEC §13.3, "Grounding records and the host").
 * `toPersistable` is what a host stores by default: the same fold with every
 * turn record's `displayRequired` omitted (§10 item 51). The same terms may
 * limit `sources[]` and the grounded content, which it leaves in place.
 *
 * Memory (draft.6): a `memory.write` of scope `agent`, `user` or `skill`
 * records a write to the producer's own cross-thread store, not a claim about
 * the host. A host persists scope `thread` and the non-thread scopes it
 * declares; the projection omits the rest and reports each omission.
 */
import type { AgCapabilities, AgReduceResult } from "./agjson.js";

/** A non-thread memory scope a host can declare it persists. */
export type AgPersistedMemoryScope = NonNullable<AgCapabilities["memoryScopes"]>[number];

/** Options for {@link toPersistable} and {@link toPersistableWithReport}. */
export interface PersistOptions {
  /**
   * The non-thread memory scopes the host persists (SPEC §8.0 host obligation
   * 7). Scope `thread` is always kept. Absent declares none, so every `agent`,
   * `user` and `skill` record is omitted: the same set a host that declares
   * nothing in `AgCapabilities.memoryScopes` persists.
   */
  memoryScopes?: readonly AgPersistedMemoryScope[];
}

/** One memory record a projection omitted, by `(scope, key)`. */
export interface AgOmittedMemoryRecord {
  scope: AgPersistedMemoryScope;
  key?: string;
}

/** A persistable projection together with the records it omitted. */
export interface AgPersistableWithReport {
  result: AgReduceResult;
  /** Every omitted memory record, in the fold's order. */
  omitted: AgOmittedMemoryRecord[];
}

/**
 * The persistable projection of `result` with its omission report: a deep copy
 * with `displayRequired` deleted from every turn record and every memory record
 * whose scope is neither `thread` nor listed in `opts.memoryScopes` removed;
 * nothing else changes, and `result` itself is not mutated. `omitted` names each
 * removed memory record by `(scope, key)` in the fold's order, the typed report
 * a persisting host gives its caller (SPEC §8.0 host obligation 7).
 */
export function toPersistableWithReport(result: AgReduceResult, opts: PersistOptions = {}): AgPersistableWithReport {
  const copy = structuredClone(result);
  for (const turn of copy.turns) delete (turn as { displayRequired?: unknown }).displayRequired;
  const kept = new Set<string>(opts.memoryScopes ?? []);
  const omitted: AgOmittedMemoryRecord[] = [];
  copy.memory = copy.memory.filter((rec) => {
    if (rec.scope === "thread" || kept.has(rec.scope)) return true;
    omitted.push({ scope: rec.scope, ...(rec.key !== undefined ? { key: rec.key } : {}) });
    return false;
  });
  return { result: copy, omitted };
}

/**
 * The persistable projection of `result`, the same as
 * `toPersistableWithReport(result, opts).result`: every turn record's
 * `displayRequired` and every memory record of an undeclared non-thread scope
 * omitted. A host that owes its caller the omission report (SPEC §8.0 host
 * obligation 7) calls {@link toPersistableWithReport} instead.
 */
export function toPersistable(result: AgReduceResult, opts: PersistOptions = {}): AgReduceResult {
  return toPersistableWithReport(result, opts).result;
}
