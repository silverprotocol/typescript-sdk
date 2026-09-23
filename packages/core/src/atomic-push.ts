/**
 * atomic-push.ts — per-native atomicity for a Normalizer (the fleet guard
 * ruling, 2026-09-24, binding; sp-main approved sp-openai's option B).
 *
 * A Normalizer MUST NOT throw out of push() (SPEC.md §8.0). When handling
 * one native throws anyway, the events it had already produced must be
 * discarded WITHOUT consuming seq (INV-SEQ), and no turn, message or block it
 * half-opened may survive. The assembler stamps seq at emit and the facet
 * holds its own state, so the wrapper restores both by construction: it
 * rebuilds the inner Normalizer from its factory and re-drives every native it
 * accepted so far, output dropped. That relies on facets being deterministic
 * (no clock, no randomness inside the factory; capture a random id stem OUTSIDE
 * `createInner`).
 *
 * A facet whose live natives are class instances it recognizes by class
 * (e.g. an Error it tests with `instanceof`, which any JSON-shaped copy
 * loses) should not normalize at entry, and cannot journal a faithful copy.
 * It can use StreamAssembler.checkpoint()/rollback() plus its own state
 * snapshot instead (the vercel-ai facet does).
 */
import type { AgEvent, JsonValue } from "./agjson.js";
import type { Normalizer } from "./stream-assembler.js";
import { toJsonValue, toJsonValueSafe } from "./wire.js";

/** The constant `message` of the guard's core `error` event. */
export const NORMALIZER_ERROR_MESSAGE = "normalizer error";

/** The guard's `code`: the thrown value's constructor NAME only, never its
 *  message (a SyntaxError quotes its input) and never the native. */
export function normalizerErrorCode(err: unknown): string {
  try {
    if (err instanceof Error) return err.constructor.name || "Error";
  } catch {
    return "Error";
  }
  return "NonError";
}

export interface AtomicPushOptions {
  /** Run {@link toJsonValueSafe} on each native before the inner push (default
   *  true). With it the journal holds a JSON deep copy of what the inner saw,
   *  so a host mutating a pushed native later cannot skew a rebuild. With
   *  `false` the journal holds the natives themselves, and the host MUST NOT
   *  mutate a native after pushing it. */
  normalize?: boolean;
}

/**
 * Wrap a Normalizer factory so each push() (and flush()) is atomic:
 * - Success: the inner's events are returned (by reference; unchanged until a
 *   throw has happened), and the native joins the journal.
 * - Throw: the partial batch is discarded, the inner is rebuilt and re-driven
 *   from the journal with its output dropped (a throw during that re-drive is
 *   caught too), and ONE core `error {message: "normalizer error", code}`
 *   takes the next seq. From then on every inner event is renumbered by +1 per
 *   error emitted, so seq stays ascending and gap-free and no seq repeats.
 * - flush() throwing: the same rebuild and `error`, then the wrapper closes
 *   what the consumer has seen open, per INV-FLUSH: a message.end for each
 *   open message, then turn.abort{stream-truncated} for each open turn,
 *   innermost first.
 *
 * Costs, by design (caps deferred):
 * - Memory: O(invoke). The journal keeps a COPY of every accepted native (a
 *   JSON deep copy when normalizing, never the host's reference) for the life
 *   of the instance, i.e. one invoke, since hosts build a fresh Normalizer per
 *   invoke (§8.0 obligation 3).
 * - Time: O(bad × prefix). Each throw re-drives the invoke so far, output
 *   dropped. Nothing is paid when nothing throws, beyond the copy.
 */
export function withAtomicPush(createInner: () => Normalizer, opts: AtomicPushOptions = {}): Normalizer {
  const normalize = opts.normalize ?? true;
  let inner = createInner();
  const journal: unknown[] = [];
  let offset = 0; // errors emitted so far = the seq shift applied to inner output
  let lastSeq = -1; // the last seq returned to the caller
  // What the consumer has seen open, for flush()'s fallback INV-FLUSH close.
  const openMessages = new Map<string, true>();
  const openTurns = new Set<string>();
  let lastTurn: string | undefined;

  const track = (ev: AgEvent): void => {
    const turnId = (ev as { turnId?: string }).turnId;
    const id = (ev as { id?: string }).id;
    switch (ev.type) {
      case "message.start":
        if (id !== undefined) openMessages.set(id, true);
        break;
      case "message.end":
        if (id !== undefined) openMessages.delete(id);
        break;
      case "turn.start":
      case "subagent.start":
        if (turnId !== undefined) {
          openTurns.add(turnId);
          lastTurn = turnId;
        }
        break;
      case "turn.done":
      case "turn.error":
      case "turn.abort": {
        const closed = turnId ?? lastTurn;
        if (closed !== undefined) openTurns.delete(closed);
        break;
      }
      case "subagent.done":
        if (turnId !== undefined) openTurns.delete(turnId);
        break;
      default:
        break;
    }
  };

  const deliver = (evs: AgEvent[]): AgEvent[] => {
    const out = offset === 0 ? evs : evs.map((ev): AgEvent => ({ ...ev, seq: ev.seq + offset }));
    for (const ev of out) {
      lastSeq = ev.seq;
      track(ev);
    }
    return out;
  };

  const rebuild = (): void => {
    try {
      inner = createInner();
      for (const n of journal) inner.push(n);
    } catch {
      // Double fault: keep the partly rebuilt inner; the error is still emitted.
    }
  };

  const guardError = (err: unknown): AgEvent => {
    const ev: AgEvent = { type: "error", seq: lastSeq + 1, message: NORMALIZER_ERROR_MESSAGE, code: normalizerErrorCode(err) };
    lastSeq = ev.seq;
    offset += 1;
    return ev;
  };

  return {
    push(native: unknown): AgEvent[] {
      try {
        const n: unknown = normalize ? toJsonValueSafe(native) : native;
        const evs = inner.push(n);
        journal.push(normalize ? toJsonValue(n as JsonValue) : n);
        return deliver(evs);
      } catch (err) {
        rebuild();
        return [guardError(err)];
      }
    },
    flush(): AgEvent[] {
      try {
        return deliver(inner.flush());
      } catch (err) {
        rebuild();
        const out: AgEvent[] = [guardError(err)];
        for (const id of openMessages.keys()) out.push({ type: "message.end", seq: ++lastSeq, id });
        for (const turnId of [...openTurns].reverse()) {
          out.push({ type: "turn.abort", seq: ++lastSeq, turnId, reason: "stream-truncated" });
        }
        openMessages.clear();
        openTurns.clear();
        return out;
      }
    },
  };
}
