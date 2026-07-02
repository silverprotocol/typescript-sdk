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

import type { AgEvent, AgClosedEventType, AgTrigger, AgUsage, AgRole, AgBlock, AgOpaqueKind, JsonValue } from "./agjson.js";

// Extracted closed-event arm types (no `as` casts — Extract keeps types typed at source).
type TurnStartEvent    = Extract<AgClosedEventType, { type: "turn.start" }>;
type TurnDoneEvent     = Extract<AgClosedEventType, { type: "turn.done" }>;
type TurnErrorEvent    = Extract<AgClosedEventType, { type: "turn.error" }>;
type MessageStartEvent = Extract<AgClosedEventType, { type: "message.start" }>;
type MessageEndEvent   = Extract<AgClosedEventType, { type: "message.end" }>;
type SubagentStartEvent = Extract<AgClosedEventType, { type: "subagent.start" }>;
type SubagentDoneEvent  = Extract<AgClosedEventType, { type: "subagent.done" }>;

// T2 content/tool/reasoning event arm types.
type TextStartEvent          = Extract<AgClosedEventType, { type: "text.start" }>;
type TextDeltaEvent          = Extract<AgClosedEventType, { type: "text.delta" }>;
type TextEndEvent            = Extract<AgClosedEventType, { type: "text.end" }>;
type ReasoningStartEvent     = Extract<AgClosedEventType, { type: "reasoning.start" }>;
type ReasoningDeltaEvent     = Extract<AgClosedEventType, { type: "reasoning.delta" }>;
type ReasoningEndEvent       = Extract<AgClosedEventType, { type: "reasoning.end" }>;
type ReasoningOpaqueEvent    = Extract<AgClosedEventType, { type: "reasoning.opaque" }>;
type ToolStartEvent          = Extract<AgClosedEventType, { type: "tool.start" }>;
type ToolArgsDeltaEvent      = Extract<AgClosedEventType, { type: "tool.args.delta" }>;
type ToolArgsAssembledEvent  = Extract<AgClosedEventType, { type: "tool.args.assembled" }>;
type ToolDoneEvent           = Extract<AgClosedEventType, { type: "tool.done" }>;
type ContentBlockEvent       = Extract<AgClosedEventType, { type: "content.block" }>;

/** Distributes `Omit` over a union so each arm keeps its exact shape. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** A complete closed event awaiting only the engine-owned `seq`. */
export type SeqlessEvent = DistributiveOmit<AgClosedEventType, "seq">;

/** Fields for `toolStart`: the tool.start arm minus base envelope fields. */
export type ToolStartFields = Omit<ToolStartEvent, "type" | "seq" | "turnId">;

/** Fields for `toolDone`: the tool.done arm minus base envelope fields + optional turnId for backfill. */
export type ToolDoneFields = Omit<ToolDoneEvent, "type" | "seq"> & { turnId?: string };

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

/** Stateful push/flush interface implemented by concrete Normalizer facets. */
export interface Normalizer {
  push(native: import("./agjson.js").JsonValue): AgEvent[];
  flush(): AgEvent[];
}

// ─────────────────────────────────────────────────────────────────────────────

// Reserved AgEvent envelope keys — a vendor ext payload must not clobber these.
const RESERVED_EXT_KEYS = new Set<string>([
  "seq",
  "type",
  "ts",
  "id",
  "turnId",
  "messageId",
  "parentId",
  "_meta",
]);

export class StreamAssembler {
  // Turn-scoped monotonic sequence counter (never calls Date.now/Math.random).
  #seq = 0;

  // turnIds already introduced (via openTurn, subagentStart, or synthesized by openMessage).
  // Once a turn is seen, openMessage will NOT synthesize a duplicate turn.start.
  #seenTurns = new Set<string>();

  // Insertion-ordered map of open messageId → its owning turnId.
  // Used by flush() to close dangling messages in the order they were opened.
  #openMessages = new Map<string, { turnId: string }>();

  // messageId → turnId map (populated in openMessage): used by content/tool events
  // to backfill turnId from the owning message when the event carries no turnId.
  // Mirrors the guuey-side StreamAssembler #msgTurn.
  #msgTurn = new Map<string, string>();

  // The most recent turnId introduced by any turn-opening event (openTurn,
  // openMessage, subagentStart). Fallback for content events that carry neither
  // turnId nor messageId (e.g. an orphan tool.done). Mirrors guuey #lastTurn.
  #lastTurn: string | undefined = undefined;

  // Per-id cumulative delta buffer: tracks the last full incoming string per
  // content stream id. `textDelta`/`reasoningDelta`/`toolArgsDelta` with
  // `{cumulative:true}` slice off the prior to emit only the new suffix.
  // Claude never sends cumulative on Slice 0 — exercised by unit tests only.
  #cumulative = new Map<string, string>();

  // Internal buffer that collects emitted events until drain() is called.
  #buffer: AgEvent[] = [];

  // ── Internal helpers ────────────────────────────────────────────────────────

  /** Allocate the next monotonic seq counter value. */
  #nextSeq(): number {
    return this.#seq++;
  }

  /** Emit one closed event into the buffer. */
  #emit(ev: AgClosedEventType): void {
    this.#buffer.push(ev);
  }

  /** Emit one AgExtEvent into the buffer (open template-literal type). */
  #emitExt(ev: AgEvent): void {
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

  /**
   * Resolve a turnId for a content/tool event: explicit field → owning message's
   * turnId (#msgTurn) → current open turn (#lastTurn).
   * Mirrors the guuey-side `withTurnId` + `#msgTurn`/`#lastTurn` resolution order.
   */
  #resolveTurnId(explicitTurnId: string | undefined, messageId: string | undefined): string | undefined {
    if (explicitTurnId !== undefined) return explicitTurnId;
    if (messageId !== undefined) {
      const fromMsg = this.#msgTurn.get(messageId);
      if (fromMsg !== undefined) return fromMsg;
    }
    return this.#lastTurn;
  }

  /**
   * Apply de-cumulation for a content delta with `cumulative:true`.
   * Slices off `prior.length` from the incoming string and updates the buffer.
   * When cumulative is absent/false, returns the delta verbatim.
   */
  #deCumulate(id: string, incoming: string, cumulative: boolean | undefined): string {
    if (!cumulative) return incoming;
    const prior = this.#cumulative.get(id) ?? "";
    const delta = incoming.slice(prior.length);
    this.#cumulative.set(id, incoming);
    return delta;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Explicitly open a turn. Emits `turn.start` and seeds `#seenTurns` so a
   * following `openMessage` does NOT synthesize a duplicate.
   * Delegates to `#ensureTurn` so the synthesis path lives in one place.
   */
  openTurn(turnId: string, threadId: string, opts?: { trigger?: AgTrigger }): void {
    this.#ensureTurn(turnId, threadId, opts);
    this.#lastTurn = turnId;
  }

  /** Close a turn successfully. */
  closeTurnDone(turnId: string, fields: TurnDoneFields): void {
    const ev: TurnDoneEvent = { type: "turn.done", seq: this.#nextSeq(), turnId, ...fields };
    this.#emit(ev);
  }

  /** Close a turn with an error. `usage` carries accrued usage on the interrupted turn (A1). */
  closeTurnError(
    turnId: string,
    fields: { message: string; code?: string; retriable?: boolean; usage?: AgUsage },
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
   * Records turnId in #msgTurn and updates #lastTurn for downstream backfill.
   */
  openMessage(fields: OpenMessageFields): void {
    const { id, turnId, threadId, ...rest } = fields;
    // I1: synthesize turn.start if this turn hasn't been opened yet.
    this.#ensureTurn(turnId, threadId);
    // Update #lastTurn and #msgTurn for content/tool backfill.
    this.#lastTurn = turnId;
    this.#msgTurn.set(id, turnId);
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
    this.#lastTurn = turnId;
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

  // ── TEXT primitives ─────────────────────────────────────────────────────────

  /** Emit `text.start` for a new text content stream. */
  textStart(id: string, messageId: string, fields?: { role?: "assistant" }): void {
    const turnId = this.#resolveTurnId(undefined, messageId);
    const ev: TextStartEvent = {
      type: "text.start",
      seq: this.#nextSeq(),
      id,
      messageId,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(fields?.role !== undefined ? { role: fields.role } : {}),
    };
    this.#emit(ev);
  }

  /** Emit `text.delta`. With `{cumulative:true}` de-cumulates against the prior buffer. */
  textDelta(id: string, messageId: string, delta: string, opts?: { cumulative?: boolean }): void {
    const turnId = this.#resolveTurnId(undefined, messageId);
    const emitDelta = this.#deCumulate(id, delta, opts?.cumulative);
    const ev: TextDeltaEvent = {
      type: "text.delta",
      seq: this.#nextSeq(),
      id,
      messageId,
      delta: emitDelta,
      ...(turnId !== undefined ? { turnId } : {}),
    };
    this.#emit(ev);
  }

  /** Emit `text.end` for a finished text content stream. */
  textEnd(id: string, messageId: string): void {
    const turnId = this.#resolveTurnId(undefined, messageId);
    const ev: TextEndEvent = {
      type: "text.end",
      seq: this.#nextSeq(),
      id,
      messageId,
      ...(turnId !== undefined ? { turnId } : {}),
    };
    this.#emit(ev);
  }

  // ── REASONING primitives ────────────────────────────────────────────────────

  /** Emit `reasoning.start` for a new reasoning stream. */
  reasoningStart(id: string, messageId: string, opts?: { mode?: "summarized" | "full" }): void {
    const turnId = this.#resolveTurnId(undefined, messageId);
    const ev: ReasoningStartEvent = {
      type: "reasoning.start",
      seq: this.#nextSeq(),
      id,
      messageId,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
    };
    this.#emit(ev);
  }

  /** Emit `reasoning.delta`. With `{cumulative:true}` de-cumulates against the prior buffer. */
  reasoningDelta(id: string, messageId: string, delta: string, opts?: { cumulative?: boolean }): void {
    const turnId = this.#resolveTurnId(undefined, messageId);
    const emitDelta = this.#deCumulate(id, delta, opts?.cumulative);
    const ev: ReasoningDeltaEvent = {
      type: "reasoning.delta",
      seq: this.#nextSeq(),
      id,
      messageId,
      delta: emitDelta,
      ...(turnId !== undefined ? { turnId } : {}),
    };
    this.#emit(ev);
  }

  /** Emit `reasoning.end` for a finished reasoning stream. */
  reasoningEnd(id: string, messageId: string, opts?: { provider?: string }): void {
    const turnId = this.#resolveTurnId(undefined, messageId);
    const ev: ReasoningEndEvent = {
      type: "reasoning.end",
      seq: this.#nextSeq(),
      id,
      messageId,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(opts?.provider !== undefined ? { provider: opts.provider } : {}),
    };
    this.#emit(ev);
  }

  /** Emit `reasoning.opaque` to set the opaque blob on a reasoning block. */
  reasoningOpaque(
    id: string,
    messageId: string,
    fields: { kind: AgOpaqueKind; value: string; provider?: string },
  ): void {
    const turnId = this.#resolveTurnId(undefined, messageId);
    const ev: ReasoningOpaqueEvent = {
      type: "reasoning.opaque",
      seq: this.#nextSeq(),
      id,
      messageId,
      kind: fields.kind,
      value: fields.value,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
    };
    this.#emit(ev);
  }

  // ── TOOL primitives ─────────────────────────────────────────────────────────

  /**
   * Emit `tool.start`. `fields` is `Omit<ToolStartEvent, "type"|"seq"|"turnId">`;
   * turnId is backfilled from the owning message (via fields.messageId) or #lastTurn.
   */
  toolStart(fields: ToolStartFields): void {
    const turnId = this.#resolveTurnId(undefined, fields.messageId);
    const ev: ToolStartEvent = {
      type: "tool.start",
      seq: this.#nextSeq(),
      ...(turnId !== undefined ? { turnId } : {}),
      ...fields,
    };
    this.#emit(ev);
  }

  /** Emit `tool.args.delta`. With `{cumulative:true}` de-cumulates against the prior buffer. */
  toolArgsDelta(toolCallId: string, delta: string, opts?: { cumulative?: boolean }): void {
    const emitDelta = this.#deCumulate(toolCallId, delta, opts?.cumulative);
    const ev: ToolArgsDeltaEvent = {
      type: "tool.args.delta",
      seq: this.#nextSeq(),
      toolCallId,
      delta: emitDelta,
    };
    this.#emit(ev);
  }

  /** Emit `tool.args.assembled` with the fully assembled input object. */
  toolArgsAssembled(
    toolCallId: string,
    input: JsonValue,
    fields?: { signature?: string },
  ): void {
    const ev: ToolArgsAssembledEvent = {
      type: "tool.args.assembled",
      seq: this.#nextSeq(),
      toolCallId,
      input,
      ...(fields?.signature !== undefined ? { signature: fields.signature } : {}),
    };
    this.#emit(ev);
  }

  /**
   * Emit `tool.done`. `fields` may include an optional `turnId` (for the orphan
   * case where no owning message is known). When absent, backfills from
   * fields.messageId → #msgTurn → #lastTurn.
   */
  toolDone(fields: ToolDoneFields): void {
    const { turnId: explicitTurnId, ...rest } = fields;
    const turnId = this.#resolveTurnId(explicitTurnId, fields.messageId);
    const ev: ToolDoneEvent = {
      type: "tool.done",
      seq: this.#nextSeq(),
      ...(turnId !== undefined ? { turnId } : {}),
      ...rest,
    };
    this.#emit(ev);
  }

  // ── CONTENT BLOCK / PROVIDER-RAW / EXT primitives ──────────────────────────

  /**
   * Emit `content.block`. `messageId` may be undefined; turnId is backfilled
   * from #msgTurn or #lastTurn. `opts.transient` passes through to the event.
   */
  contentBlock(
    messageId: string | undefined,
    block: AgBlock,
    opts?: { transient?: boolean },
  ): void {
    const turnId = this.#resolveTurnId(undefined, messageId);
    const ev: ContentBlockEvent = {
      type: "content.block",
      seq: this.#nextSeq(),
      block,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(opts?.transient !== undefined ? { transient: opts.transient } : {}),
    };
    this.#emit(ev);
  }

  /**
   * Convenience: emit a `content.block` wrapping a `provider-raw` block.
   * Used to pass opaque vendor payloads through without losing the lossless channel.
   */
  providerRaw(messageId: string | undefined, vendor: string, raw: JsonValue): void {
    this.contentBlock(messageId, { type: "provider-raw", vendor, raw });
  }

  /**
   * Emit an open `ext.<vendor>.<key>` event (lossless vendor extension channel).
   * The type field is the only constraint: `ext.` + vendor + `.` + key.
   * Reserved envelope keys (seq, type, ts, id, turnId, messageId, parentId, _meta)
   * are filtered from the payload to prevent clobbering the engine-assigned envelope.
   */
  emitExt(vendor: string, key: string, payload: JsonValue): void {
    // AgExtEvent: an object validated on the `type` regex `^ext\.[^.]+\..+$`
    // with .catchall(JsonValue). Build it as a plain object matching that shape.
    // Guard + assign to a typed local so TS narrows without a cast.
    const objectPayload: Record<string, JsonValue> | undefined =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : undefined;
    const ev: AgEvent = {
      seq: this.#nextSeq(),
      type: `ext.${vendor}.${key}`,
      ...Object.fromEntries(
        Object.entries(objectPayload ?? {}).filter(([k]) => !RESERVED_EXT_KEYS.has(k))
      ),
    };
    this.#emitExt(ev);
  }

  /**
   * Emit a complete standalone event the engine has no dedicated lifecycle for
   * (e.g. handoff, state.delta, turn.abort, source, hitl.ask, prompt.blocked,
   * display.required — all members of AgClosedEventType). The engine stamps the
   * monotonic seq; the facet supplies every other field. This is the base
   * primitive the 23 lifecycle methods are sugar over — it guarantees no
   * AgClosedEventType is ever unreachable.
   */
  emit(ev: SeqlessEvent): void {
    // seq-reconstruction: TS cannot prove `{...Omit<T,"seq">, seq}` is `T` across
    // a distributed union (spread-over-union limitation). The single assertion
    // below re-attaches the engine-owned field; it is NOT type erasure.
    this.#emit({ ...ev, seq: this.#nextSeq() } as AgClosedEventType);
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
