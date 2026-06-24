/**
 * StreamAssembler — the shared engine that turns per-framework event bursts into a
 * coherent turn stream: synthesizes `turn.start` for the first message in an unseen
 * turn, emits subagent lifecycle, and enforces turn-scoped monotonic seq. Used by
 * the stateful `Normalizer` implementations in `@silverprotocol/<framework>` packages.
 *
 * Generalised from the guuey-side `backend/services/nocode-runtime/src/stream-assembler.ts`
 * (spec §8.2 / §16). The guuey-side version will be deleted in T5.
 *
 * Invariants enforced:
 *  I1  – `turn.start` synthesized when `openMessage` is called for an unseen turnId
 *  I5  – seq is a turn-scoped monotonic counter (never calls Date.now/Math.random)
 *  I7  – `flush()` emits `message.end` for each dangling open message in insertion order
 *
 * Fix: subagent-turn-double-open / subagent-turnstart-ordering
 *  `subagentStart` and `openTurn` both call `#seenTurns.add(turnId)` so a subsequent
 *  `openMessage` does NOT synthesize a spurious `turn.start` for an already-opened nested turn.
 */

import type { AgEvent, AgClosedEventType, AgTrigger, AgUsage, AgRole } from "./agjson.js";

// Extracted closed-event arm types (no `as` casts — Extract keeps types typed at source).
type TurnStartEvent    = Extract<AgClosedEventType, { type: "turn.start" }>;
type TurnDoneEvent     = Extract<AgClosedEventType, { type: "turn.done" }>;
type TurnErrorEvent    = Extract<AgClosedEventType, { type: "turn.error" }>;
type MessageStartEvent = Extract<AgClosedEventType, { type: "message.start" }>;
type MessageEndEvent   = Extract<AgClosedEventType, { type: "message.end" }>;
type SubagentStartEvent = Extract<AgClosedEventType, { type: "subagent.start" }>;
type SubagentDoneEvent  = Extract<AgClosedEventType, { type: "subagent.done" }>;

/** Fields required by `openMessage`. Mirrors the load-bearing fields on `message.start`. */
export interface OpenMessageFields {
  id: string;
  role: AgRole;
  turnId: string;
  threadId: string;
  stepId?: string;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  model?: string;
}

/** Fields required by `closeTurnDone`. */
export type TurnDoneFields = Omit<TurnDoneEvent, "type" | "seq" | "turnId">;

/** Reserved context for future stateful seeding (e.g. lastSeq for reconnect). */
export interface NormalizerContext {
  seed?: { lastSeq: number };
}

/** Stateful push/flush interface implemented by concrete Normalizer facets. */
export interface Normalizer {
  push(native: import("./agjson.js").JsonValue): AgEvent[];
  flush(): AgEvent[];
}

// ─────────────────────────────────────────────────────────────────────────────

export class StreamAssembler {
  // Turn-scoped monotonic sequence counter (never calls Date.now/Math.random).
  #seq = 0;

  // turnIds already introduced (via openTurn, subagentStart, or synthesized by openMessage).
  // Once a turn is seen, openMessage will NOT synthesize a duplicate turn.start.
  #seenTurns = new Set<string>();

  // Insertion-ordered map of open messageId → its owning turnId.
  // Used by flush() to close dangling messages in the order they were opened.
  #openMessages = new Map<string, { turnId: string }>();

  // Internal buffer that collects emitted events until drain() is called.
  #buffer: AgEvent[] = [];

  constructor(_ctx?: NormalizerContext) {
    // ctx is reserved for Slice 0+ seeding; unused here.
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /** Allocate the next monotonic seq counter value. */
  #nextSeq(): number {
    return this.#seq++;
  }

  /** Emit one closed event into the buffer. */
  #emit(ev: AgClosedEventType): void {
    this.#buffer.push(ev);
  }

  /** Ensure a turn.start has been emitted for `turnId`. If not seen, synthesize one. */
  #ensureTurn(turnId: string, threadId: string, opts?: { trigger?: AgTrigger }): void {
    if (this.#seenTurns.has(turnId)) return;
    this.#seenTurns.add(turnId);
    const ev: TurnStartEvent = {
      type: "turn.start",
      seq: this.#nextSeq(),
      turnId,
      threadId,
      ...(opts?.trigger !== undefined ? { trigger: opts.trigger } : {}),
    };
    this.#emit(ev);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Explicitly open a turn. Emits `turn.start` and seeds `#seenTurns` so a
   * following `openMessage` does NOT synthesize a duplicate.
   * Delegates to `#ensureTurn` so the synthesis path lives in one place.
   */
  openTurn(turnId: string, threadId: string, opts?: { trigger?: AgTrigger }): void {
    this.#ensureTurn(turnId, threadId, opts);
  }

  /** Close a turn successfully. */
  closeTurnDone(turnId: string, fields: TurnDoneFields): void {
    const ev: TurnDoneEvent = { type: "turn.done", seq: this.#nextSeq(), turnId, ...fields };
    this.#emit(ev);
  }

  /** Close a turn with an error. */
  closeTurnError(
    turnId: string,
    fields: { message: string; code?: string; retriable?: boolean },
  ): void {
    const ev: TurnErrorEvent = {
      type: "turn.error",
      seq: this.#nextSeq(),
      turnId,
      ...fields,
    };
    this.#emit(ev);
  }

  /**
   * Open a message stream. Auto-synthesizes `turn.start` iff `turnId` is unseen (I1).
   */
  openMessage(fields: OpenMessageFields): void {
    const { id, turnId, threadId, ...rest } = fields;
    // I1: synthesize turn.start if this turn hasn't been opened yet.
    this.#ensureTurn(turnId, threadId);
    // Emit message.start.
    const ev: MessageStartEvent = {
      type: "message.start",
      seq: this.#nextSeq(),
      id,
      turnId,
      threadId,
      ...rest,
    };
    this.#emit(ev);
    // Track as an open message.
    this.#openMessages.set(id, { turnId });
  }

  /** Close a message stream. */
  closeMessage(id: string, usage?: AgUsage): void {
    this.#openMessages.delete(id);
    const ev: MessageEndEvent = {
      type: "message.end",
      seq: this.#nextSeq(),
      id,
      ...(usage !== undefined ? { usage } : {}),
    };
    this.#emit(ev);
  }

  /**
   * Record a subagent turn start. Emits `subagent.start` AND seeds `#seenTurns`
   * so a following `openMessage` for the same turnId does NOT produce a spurious
   * `turn.start` (fix: subagent-turn-double-open / subagent-turnstart-ordering).
   */
  subagentStart(turnId: string, parentTurnId: string): void {
    this.#seenTurns.add(turnId);
    const ev: SubagentStartEvent = {
      type: "subagent.start",
      seq: this.#nextSeq(),
      turnId,
      parentTurnId,
    };
    this.#emit(ev);
  }

  /** Record a subagent turn done. */
  subagentDone(turnId: string, parentTurnId: string): void {
    const ev: SubagentDoneEvent = {
      type: "subagent.done",
      seq: this.#nextSeq(),
      turnId,
      parentTurnId,
    };
    this.#emit(ev);
  }

  /**
   * Drain the buffer and return all buffered events. Clears the buffer.
   */
  drain(): AgEvent[] {
    const out = this.#buffer;
    this.#buffer = [];
    return out;
  }

  /**
   * Flush dangling open messages: emit `message.end` for each open message
   * in insertion order (I7), then drain.
   */
  flush(): AgEvent[] {
    for (const [id] of this.#openMessages) {
      const ev: MessageEndEvent = { type: "message.end", seq: this.#nextSeq(), id };
      this.#emit(ev);
    }
    this.#openMessages.clear();
    return this.drain();
  }
}
