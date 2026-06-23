import type {
  AgEvent,
  AgClosedEventType,
  AgReduceResult,
  AgMessage,
  AgArtifact,
  AgMemoryRecord,
  AgTurnRecord,
  JsonValue,
} from "./agjson.js";

// ─────────────────────────────────────────────────────────────────────────────
// Reducer — the normative event→state fold (spec §5).
//
// R0 scaffold: all scratch initialized; push() = switch with default no-op;
// result() materializes via structuredClone (aliasing-safe).
//
// R1: lifecycle handlers (turn.start / message.start / message.end /
//     subagent.start / subagent.done / step.start / step.done) +
//     (turnId, candidateIndex) partition helper.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the partition key for the open-message map.
 *
 * Spec §5: the partition key is `(turnId, candidateIndex)` — absent
 * `candidateIndex` defaults to 0 (back-compat anchor).
 *
 * R2/R3/R4 reuse this helper via `openMessage()`.
 *
 * @param turnId        The owning turn's id.
 * @param candidateIndex The candidate index (absent → 0).
 */
function partKey(turnId: string, candidateIndex: number): string {
  return `${turnId} ${candidateIndex}`;
}

/**
 * Narrow `AgEvent` to `AgClosedEventType` by ruling out the open `AgExtEvent`
 * arm (whose `type` always matches `/^ext\.[^.]+\..+$/`).
 *
 * `AgExtEvent` uses `.catchall(JsonValue)`, which adds an index signature that
 * widens every field access on the `AgEvent` union. This type guard excludes the
 * ext arm so the switch inside `push()` sees the properly-narrowed closed-event
 * type and avoids spurious `string | JsonValue` field types.
 */
function isClosedEvent(ev: AgEvent): ev is AgClosedEventType {
  return !ev.type.startsWith("ext.");
}

export class Reducer {
  // ── keyed accumulators ──────────────────────────────────────────────────────
  // Messages, keyed by message id (insertion-ordered).
  #messages: Map<string, AgMessage> = new Map();
  // Turn records, keyed by turnId.
  #turns: Map<string, AgTurnRecord> = new Map();
  // Artifacts, keyed by artifactId.
  #artifacts: Map<string, AgArtifact> = new Map();
  // Memory records, keyed by `${scope}${key ?? ""}`.
  #memory: Map<string, AgMemoryRecord> = new Map();
  // Shared-state working copy (opaque; §11.1).
  #state: JsonValue | undefined = undefined;

  // ── open-message tracking ──────────────────────────────────────────────────
  // Partition key `${turnId} ${candidateIndex}` → open message id.
  #openMsg: Map<string, string> = new Map();
  // Message ids sealed by message.end.
  #sealed: Set<string> = new Set();
  // block/tool-call id → position in its owning message's content[], for REPLACE.
  #blockPos: Map<string, { messageId: string; index: number }> = new Map();

  // ── streaming scratch ──────────────────────────────────────────────────────
  // toolCallId → raw partial-JSON scratch.
  #toolArgs: Map<string, string> = new Map();
  // reasoning id → signature scratch.
  #opaque: Map<string, string> = new Map();

  // ── gap detection ──────────────────────────────────────────────────────────
  #lastSeq: number = -1;
  #resync: boolean = false;

  /**
   * Feed a single normalized AgEvent into the fold.
   * R1: lifecycle handlers (turn/message/subagent/step); R2–R10 fill content.
   */
  push(ev: AgEvent): void {
    // Ext events (`ext.<vendor>.<key>`) are live-only / non-folding (§4/§12).
    // Rule them out so the switch below sees the narrowed AgClosedEventType and
    // avoids the AgExtEvent.catchall(JsonValue) index-signature field widening.
    if (!isClosedEvent(ev)) return;
    switch (ev.type) {
      // ── TURN lifecycle ─────────────────────────────────────────────────────
      case "turn.start": {
        // Idempotent: if the turn already exists, merge defined fields only.
        const existing = this.#turns.get(ev.turnId);
        if (existing === undefined) {
          this.#turns.set(ev.turnId, {
            turnId: ev.turnId,
            threadId: ev.threadId,
            ...(ev.trigger !== undefined ? { trigger: ev.trigger } : {}),
          });
        } else {
          // Merge — only overwrite with defined values (idempotent re-delivery).
          if (ev.trigger !== undefined) {
            existing.trigger = ev.trigger;
          }
        }
        break;
      }

      // ── MESSAGE lifecycle ──────────────────────────────────────────────────
      case "message.start": {
        const msg: AgMessage = {
          id: ev.id,
          role: ev.role,
          content: [],
          turnId: ev.turnId,
          threadId: ev.threadId,
          ...(ev.candidateIndex !== undefined ? { candidateIndex: ev.candidateIndex } : {}),
          ...(ev.agentId !== undefined ? { agentId: ev.agentId } : {}),
          ...(ev.agentName !== undefined ? { agentName: ev.agentName } : {}),
          ...(ev.agentRole !== undefined ? { agentRole: ev.agentRole } : {}),
          ...(ev.model !== undefined ? { model: ev.model } : {}),
          ...(ev.extensions !== undefined ? { extensions: ev.extensions } : {}),
        };
        this.#messages.set(ev.id, msg);
        // Register partition pointer: (turnId, candidateIndex ?? 0) → message id.
        this.#openMsg.set(partKey(ev.turnId, ev.candidateIndex ?? 0), ev.id);
        break;
      }

      case "message.end": {
        this.#sealed.add(ev.id);
        if (ev.usage !== undefined) {
          const msg = this.#messages.get(ev.id);
          if (msg !== undefined) {
            msg.usage = ev.usage;
          }
        }
        break;
      }

      // ── SUBAGENT lifecycle ─────────────────────────────────────────────────
      case "subagent.start": {
        // Idempotent: if the nested turn already exists, skip (never duplicate).
        if (this.#turns.has(ev.turnId)) break;
        // threadId is required on AgTurnRecord; inherit from the parent turn.
        // subagent.start does not carry threadId on the wire, so we look it up.
        const parentTurn = this.#turns.get(ev.parentTurnId);
        const threadId = parentTurn?.threadId ?? ev.parentTurnId;
        this.#turns.set(ev.turnId, {
          turnId: ev.turnId,
          parentTurnId: ev.parentTurnId,
          threadId,
        });
        break;
      }

      case "subagent.done": {
        // No AgReduceResult landing for subagent.done beyond what's already recorded.
        break;
      }

      // ── STEP lifecycle — structural scratch only, NO AgReduceResult landing ──
      case "step.start": {
        // No AgReduceResult landing (spec §5 / brief §R1). No-op on output tree.
        break;
      }

      case "step.done": {
        // No AgReduceResult landing (step.done.usage has no target; turn.done.usage
        // is authoritative per spec §8.4 / brief §R1). No-op on output tree.
        break;
      }

      // All other event types are handled by later tasks (R2–R10).
      default:
        break;
    }
  }

  /**
   * Return the open `AgMessage` for a given `(turnId, candidateIndex)` partition.
   *
   * Routing rule (spec §5): ALWAYS by the event's own `turnId`. When a single
   * turn is open and the event omits `turnId`, defaults to that sole open turn.
   * A missing pointer is a no-op stub here (resync-on-missing-pointer is R9).
   *
   * R2/R3/R4 reuse this method to attach blocks to the correct message.
   *
   * @param turnId         The event's `turnId`, or `undefined` for omitted single-turn.
   * @param candidateIndex The event's `candidateIndex` (absent → 0).
   */
  openMessage(turnId: string | undefined, candidateIndex: number = 0): AgMessage | undefined {
    const resolvedTurnId = this.#resolveTurnId(turnId);
    if (resolvedTurnId === undefined) return undefined;
    const msgId = this.#openMsg.get(partKey(resolvedTurnId, candidateIndex));
    if (msgId === undefined) return undefined;
    return this.#messages.get(msgId);
  }

  /**
   * Resolve a possibly-omitted turnId.
   *
   * If `turnId` is provided, return it verbatim.
   * If omitted and exactly one turn is open, return that turn's id.
   * Otherwise return `undefined` (ambiguous / no turns open).
   */
  #resolveTurnId(turnId: string | undefined): string | undefined {
    if (turnId !== undefined) return turnId;
    // Single-turn default: if exactly one turn exists, use it.
    if (this.#turns.size === 1) {
      // Map.keys() iterator — noUncheckedIndexedAccess-safe via for..of.
      for (const key of this.#turns.keys()) {
        return key;
      }
    }
    return undefined;
  }

  /**
   * Materialize the current fold state as a DEFENSIVE DEEP COPY.
   * Each call returns fresh arrays and objects — holding a snapshot
   * is safe across subsequent push() calls.
   */
  result(): AgReduceResult {
    return {
      messages: this.#messages.size
        ? structuredClone([...this.#messages.values()])
        : [],
      artifacts: this.#artifacts.size
        ? structuredClone([...this.#artifacts.values()])
        : [],
      memory: this.#memory.size
        ? structuredClone([...this.#memory.values()])
        : [],
      turns: this.#turns.size
        ? structuredClone([...this.#turns.values()])
        : [],
      ...(this.#state !== undefined
        ? { state: structuredClone(this.#state) }
        : {}),
    };
  }

  /**
   * True when a sequence gap was detected and the consumer should
   * resync from a snapshot before pushing further events.
   */
  get needsResync(): boolean {
    return this.#resync;
  }
}

/**
 * Convenience fold: reduce an ordered array of AgEvents into an AgReduceResult.
 * Equivalent to `new Reducer(); events.forEach(r.push); r.result()`.
 */
export function reduce(events: AgEvent[]): AgReduceResult {
  const r = new Reducer();
  for (const ev of events) {
    r.push(ev);
  }
  return r.result();
}
