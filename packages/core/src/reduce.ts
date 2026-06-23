import type {
  AgEvent,
  AgClosedEventType,
  AgReduceResult,
  AgMessage,
  AgBlock,
  AgArtifact,
  AgMemoryRecord,
  AgTurnRecord,
  AgProviderMeta,
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
//
// R2: text + reasoning blocks (APPEND deltas, REPLACE opaque, seeded required
//     fields, byte-order via #blockPos).
// ─────────────────────────────────────────────────────────────────────────────

// ── providerMetadata merge helpers ────────────────────────────────────────────

/**
 * Merge `incoming` providerMetadata into `existing` (REPLACE-by-key).
 * Returns the merged record, or `incoming` if `existing` is undefined.
 * Returns `undefined` if both are undefined.
 */
function mergeProviderMeta(
  existing: AgProviderMeta | undefined,
  incoming: AgProviderMeta | undefined,
): AgProviderMeta | undefined {
  if (incoming === undefined) return existing;
  if (existing === undefined) return incoming;
  return { ...existing, ...incoming } as AgProviderMeta;
}


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
   * R1: lifecycle handlers (turn/message/subagent/step).
   * R2: text + reasoning blocks (APPEND deltas, REPLACE opaque).
   * R3–R10 fill remaining content types.
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

      // ── TEXT blocks ───────────────────────────────────────────────────────────
      case "text.start": {
        const msg = this.openMessage(ev.turnId, ev.candidateIndex ?? 0);
        if (msg === undefined) break;
        const block: AgBlock = {
          type: "text",
          text: "", // REQUIRED field — mid-stream result() before any delta must parse
          ...(ev.providerMetadata !== undefined ? { providerMetadata: ev.providerMetadata } : {}),
          ...(ev._meta !== undefined ? { _meta: ev._meta } : {}),
        };
        const index = msg.content.length;
        msg.content.push(block);
        this.#blockPos.set(ev.id, { messageId: msg.id, index });
        break;
      }

      case "text.delta": {
        const pos = this.#blockPos.get(ev.id);
        if (pos === undefined) break;
        const msg = this.#messages.get(pos.messageId);
        if (msg === undefined) break;
        const block = msg.content[pos.index];
        if (block === undefined || block.type !== "text") break;
        block.text += ev.delta;
        block.providerMetadata = mergeProviderMeta(block.providerMetadata, ev.providerMetadata);
        break;
      }

      case "text.end": {
        const pos = this.#blockPos.get(ev.id);
        if (pos === undefined) break;
        const msg = this.#messages.get(pos.messageId);
        if (msg === undefined) break;
        const block = msg.content[pos.index];
        if (block === undefined || block.type !== "text") break;
        block.providerMetadata = mergeProviderMeta(block.providerMetadata, ev.providerMetadata);
        break;
      }

      // ── REASONING blocks ──────────────────────────────────────────────────────
      case "reasoning.start": {
        const msg = this.openMessage(ev.turnId, ev.candidateIndex ?? 0);
        if (msg === undefined) break;
        const block: AgBlock = {
          type: "reasoning",
          text: "", // seeded — mid-stream result() before any delta must parse
          ...(ev.providerMetadata !== undefined ? { providerMetadata: ev.providerMetadata } : {}),
          ...(ev._meta !== undefined ? { _meta: ev._meta } : {}),
          ...(ev.itemId !== undefined ? { itemId: ev.itemId } : {}),
        };
        const index = msg.content.length;
        msg.content.push(block);
        this.#blockPos.set(ev.id, { messageId: msg.id, index });
        break;
      }

      case "reasoning.delta": {
        const pos = this.#blockPos.get(ev.id);
        if (pos === undefined) break;
        const msg = this.#messages.get(pos.messageId);
        if (msg === undefined) break;
        const block = msg.content[pos.index];
        if (block === undefined || block.type !== "reasoning") break;
        // APPEND delta to text (in-order concat of parts)
        block.text = (block.text ?? "") + ev.delta;
        block.providerMetadata = mergeProviderMeta(block.providerMetadata, ev.providerMetadata);
        break;
      }

      case "reasoning.end": {
        const pos = this.#blockPos.get(ev.id);
        if (pos === undefined) break;
        const msg = this.#messages.get(pos.messageId);
        if (msg === undefined) break;
        const block = msg.content[pos.index];
        if (block === undefined || block.type !== "reasoning") break;
        block.providerMetadata = mergeProviderMeta(block.providerMetadata, ev.providerMetadata);
        if (ev.provider !== undefined) {
          block.provider = ev.provider;
        }
        break;
      }

      case "reasoning.opaque.delta": {
        // APPEND to per-id opaque scratch buffer (sealed by the following reasoning.opaque).
        const existing = this.#opaque.get(ev.id) ?? "";
        this.#opaque.set(ev.id, existing + ev.delta);
        break;
      }

      case "reasoning.opaque": {
        // REPLACE: set opaque on the reasoning block named by id (replay-load-bearing).
        const pos = this.#blockPos.get(ev.id);
        if (pos === undefined) break;
        const msg = this.#messages.get(pos.messageId);
        if (msg === undefined) break;
        const block = msg.content[pos.index];
        if (block === undefined || block.type !== "reasoning") break;
        // Use accumulated opaque scratch if present; otherwise use ev.value directly.
        const value = this.#opaque.has(ev.id) ? (this.#opaque.get(ev.id) ?? ev.value) : ev.value;
        block.opaque = {
          kind: ev.kind,
          value,
          ...(ev.provider !== undefined ? { provider: ev.provider } : {}),
        };
        // Clear the scratch buffer now that it's been sealed.
        this.#opaque.delete(ev.id);
        if (ev.itemId !== undefined) {
          block.itemId = ev.itemId;
        }
        break;
      }

      // ── TOOL-CALL blocks ──────────────────────────────────────────────────────
      case "tool.start": {
        const msg = this.openMessage(ev.turnId, ev.candidateIndex ?? 0);
        if (msg === undefined) break;
        const block: AgBlock = {
          type: "tool-call",
          toolCallId: ev.toolCallId,
          name: ev.name,
          // Seed with empty object so a mid-stream result() still parses (must-fix #8).
          input: {},
          ...(ev.serverName !== undefined ? { serverName: ev.serverName } : {}),
          ...(ev.providerExecuted !== undefined ? { providerExecuted: ev.providerExecuted } : {}),
          ...(ev.title !== undefined ? { title: ev.title } : {}),
          ...(ev.toolMetadata !== undefined ? { toolMetadata: ev.toolMetadata } : {}),
          ...(ev.itemId !== undefined ? { itemId: ev.itemId } : {}),
          ...(ev.uiVisibility !== undefined ? { uiVisibility: ev.uiVisibility } : {}),
          ...(ev.providerMetadata !== undefined ? { providerMetadata: ev.providerMetadata } : {}),
        };
        const index = msg.content.length;
        msg.content.push(block);
        this.#blockPos.set(ev.toolCallId, { messageId: msg.id, index });
        break;
      }

      case "tool.args.delta": {
        // APPEND raw partial-JSON delta to scratch (NEVER authoritative input).
        const existing = this.#toolArgs.get(ev.toolCallId) ?? "";
        this.#toolArgs.set(ev.toolCallId, existing + ev.delta);
        break;
      }

      case "tool.args.assembled": {
        // AUTHORITATIVE: replace seeded input:{} with the assembled value.
        const pos = this.#blockPos.get(ev.toolCallId);
        if (pos === undefined) break;
        const msg = this.#messages.get(pos.messageId);
        if (msg === undefined) break;
        const block = msg.content[pos.index];
        if (block === undefined || block.type !== "tool-call") break;
        block.input = ev.input;
        if (ev.signature !== undefined) {
          block.signature = ev.signature;
        }
        if (ev.title !== undefined) {
          block.title = ev.title;
        }
        if (ev.toolMetadata !== undefined) {
          block.toolMetadata = ev.toolMetadata;
        }
        block.providerMetadata = mergeProviderMeta(block.providerMetadata, ev.providerMetadata);
        // Clear scratch now that it's been superseded by the authoritative input.
        this.#toolArgs.delete(ev.toolCallId);
        break;
      }

      // ── TOOL-RESULT blocks ────────────────────────────────────────────────────
      case "tool.done": {
        const resultKey = `result:${ev.toolCallId}`;
        const existingPos = this.#blockPos.get(resultKey);

        if (existingPos !== undefined) {
          // MERGE path: a preliminary tool-result block is already open for this
          // toolCallId. Replace its content with the incoming (final or next-preliminary)
          // content.
          const msg = this.#messages.get(existingPos.messageId);
          if (msg === undefined) break;
          const block = msg.content[existingPos.index];
          if (block === undefined || block.type !== "tool-result") break;
          block.content = ev.content;
          if (ev.outcome !== undefined) block.outcome = ev.outcome;
          if (ev.isError !== undefined) block.isError = ev.isError;
          if (ev.structuredContent !== undefined) block.structuredContent = ev.structuredContent;
          if (ev.uiData !== undefined) block.uiData = ev.uiData;
          if (ev.sideData !== undefined) block.sideData = ev.sideData;
          if (ev.errorText !== undefined) block.errorText = ev.errorText;
          if (ev.errorCode !== undefined) block.errorCode = ev.errorCode;
          if (ev.pendingInput !== undefined) block.pendingInput = ev.pendingInput;
          block.providerMetadata = mergeProviderMeta(block.providerMetadata, ev.providerMetadata);
          // If this final tool.done has no more:true, close (remove from open tracking).
          if (!ev.more) {
            this.#blockPos.delete(resultKey);
          }
        } else {
          // CREATE path: first tool.done for this toolCallId.
          const msg = this.openMessage(ev.turnId, ev.candidateIndex ?? 0);
          if (msg === undefined) break;
          const block: AgBlock = {
            type: "tool-result",
            toolCallId: ev.toolCallId,
            content: ev.content,
            ...(ev.outcome !== undefined ? { outcome: ev.outcome } : {}),
            ...(ev.isError !== undefined ? { isError: ev.isError } : {}),
            ...(ev.structuredContent !== undefined ? { structuredContent: ev.structuredContent } : {}),
            ...(ev.uiData !== undefined ? { uiData: ev.uiData } : {}),
            ...(ev.sideData !== undefined ? { sideData: ev.sideData } : {}),
            ...(ev.errorText !== undefined ? { errorText: ev.errorText } : {}),
            ...(ev.errorCode !== undefined ? { errorCode: ev.errorCode } : {}),
            ...(ev.toolMetadata !== undefined ? { toolMetadata: ev.toolMetadata } : {}),
            ...(ev.dynamic !== undefined ? { dynamic: ev.dynamic } : {}),
            ...(ev.pendingInput !== undefined ? { pendingInput: ev.pendingInput } : {}),
            ...(ev.providerMetadata !== undefined ? { providerMetadata: ev.providerMetadata } : {}),
          };
          const index = msg.content.length;
          msg.content.push(block);
          // If more:true, keep the block open for subsequent merge.
          if (ev.more) {
            this.#blockPos.set(resultKey, { messageId: msg.id, index });
          }
        }
        break;
      }

      // All other event types are handled by later tasks (R4–R10).
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
