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
import { isJsonValue, toJsonValue, toJsonValueSafe } from "./wire.js";

/**
 * The constant `message` of the guard's core `error` event.
 *
 * @beta
 */
export const NORMALIZER_ERROR_MESSAGE = "normalizer error";

/** The guard's `code`: the thrown value's constructor NAME only, never its
 *  message (a SyntaxError quotes its input) and never the native.
 *
 * @beta
 */
export function normalizerErrorCode(err: unknown): string {
  try {
    if (err instanceof Error) return err.constructor.name || "Error";
  } catch {
    return "Error";
  }
  return "NonError";
}

/**
 * Options for {@link withAtomicPush}.
 *
 * @beta
 */
export interface AtomicPushOptions {
  /** Run {@link toJsonValueSafe} on each native before the inner push (default
   *  true). With it the journal holds a JSON deep copy of what the inner saw,
   *  so a host mutating a pushed native later cannot skew a rebuild. With
   *  `false` a native that is already plain JSON is still journaled as a deep
   *  copy; any other native (a class instance, a Date, a cycle) is journaled
   *  BY REFERENCE, so the caller must pass values it owns and never mutate one
   *  after pushing it. */
  normalize?: boolean;
}

/**
 * Wrap a Normalizer factory so each push() (and flush()) is atomic:
 * - Success: the inner's events are returned (by reference; unchanged until a
 *   throw has happened), and the native joins the journal.
 * - Throw: the partial batch is discarded, the inner is rebuilt and re-driven
 *   from the journal with its output dropped (a throw during that re-drive is
 *   caught too), and ONE core `error {message: "normalizer error", code}`
 *   takes the next seq. Its `turnId` is the owner INV-OWNER backfills
 *   (SPEC.md:766), resolved exactly as StreamAssembler.emit() resolves it:
 *   the last-opened turn, restored to the parent when a subagent turn
 *   closes, so after the last turn closed it is still that turn, and before
 *   any turn there is none. It is replayed from the delivered events, which
 *   show every move of the assembler's last turn except one: a facet
 *   re-calling openTurn() on an already-seen turn, which emits nothing. The
 *   e2e corpus leg asserts no committed native reaches that move
 *   (atomic-guard.corpus.test.ts).
 *   From then on every inner event is
 *   renumbered by +1 per error emitted, so seq stays ascending and gap-free
 *   and no seq repeats.
 * - flush() throwing: inner.flush() is NOT retried (so it cannot throw a
 *   second time). The wrapper rebuilds, emits the same `error`, then
 *   synthesizes the INV-FLUSH closes from its own tracker of what the
 *   consumer has seen open: a message.end for each open message, then
 *   turn.abort{stream-truncated} for each open turn, innermost first.
 *
 * Costs, by design (caps deferred):
 * - Memory: O(invoke). The journal keeps a COPY of every accepted native (a
 *   JSON deep copy when normalizing, never the host's reference) for the life
 *   of the instance, i.e. one invoke, since hosts build a fresh Normalizer per
 *   invoke (§8.0 obligation 3).
 * - Time: O(bad × prefix). Each throw re-drives the invoke so far, output
 *   dropped. Nothing is paid when nothing throws, beyond the copy.
 *
 * @beta
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

  // The guard error's owner, per INV-OWNER (SPEC.md:766: every emit path,
  // the generic emit() included, applies the same owner backfill): the
  // StreamAssembler's last-turn rule (#resolveTurnId, stream-assembler.ts),
  // replayed from the events the consumer has seen. turn.start and
  // message.start set it, subagent.start saves it and moves in,
  // subagent.done restores the saved one (the parent), and no close clears it.
  let ownerTurn: string | undefined;
  const ownerStack: (string | undefined)[] = [];
  const trackOwner = (ev: AgEvent): void => {
    const turnId = (ev as { turnId?: string }).turnId;
    switch (ev.type) {
      case "turn.start":
      case "message.start":
        if (turnId !== undefined) ownerTurn = turnId;
        break;
      case "subagent.start":
        ownerStack.push(ownerTurn);
        ownerTurn = turnId;
        break;
      case "subagent.done":
        ownerTurn = ownerStack.length > 0 ? ownerStack.pop() : (ev as { parentTurnId?: string }).parentTurnId;
        break;
      default:
        break;
    }
  };

  const track = (ev: AgEvent): void => {
    trackOwner(ev);
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
    const turnId = ownerTurn;
    // Key order as StreamAssembler.emit() builds it ({...ev, turnId, seq}), so
    // this error serializes byte-for-byte like an assembler-emitted guard
    // error (vercel-ai's, and google-adk's in 0.6.x).
    const ev: AgEvent = {
      type: "error",
      message: NORMALIZER_ERROR_MESSAGE,
      code: normalizerErrorCode(err),
      ...(turnId !== undefined ? { turnId } : {}),
      seq: lastSeq + 1,
    };
    lastSeq = ev.seq;
    offset += 1;
    return ev;
  };

  return {
    push(native: unknown): AgEvent[] {
      try {
        const n: unknown = normalize ? toJsonValueSafe(native) : native;
        const evs = inner.push(n);
        journal.push(normalize || isJsonValue(n) ? toJsonValue(n as JsonValue) : n);
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
