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
  AgHandoffRecord,
  AgDisplayRequired,
  JsonValue,
} from "./agjson.js";
import { REMOVE_ALL } from "./agjson.js";
import { applyPatch } from "./json-patch.js";

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
// R4: content.block (APPEND/REPLACE-in-place by id; transient SKIP) +
//     message.metadata (REPLACE-by-key shallow merge).
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
 * Merge `incoming` into a block's providerMetadata, assigning only a defined
 * result. A bare `block.providerMetadata = mergeProviderMeta(...)` left an
 * explicit `providerMetadata: undefined` key on blocks that never had any:
 * invisible in JSON, but visible to `in` / `toHaveProperty` / Object.keys
 * consumers (sp-openai's PH-2 finding, 2026-09-23).
 */
function setProviderMeta(block: { providerMetadata?: AgProviderMeta }, incoming: AgProviderMeta | undefined): void {
  const merged = mergeProviderMeta(block.providerMetadata, incoming);
  if (merged !== undefined) block.providerMetadata = merged;
}


/**
 * Snapshot-fold one optional result field (draft.4 §5 tool.done): the later
 * event's value, or no key at all when the later event omits it.
 */
function replaceOrClear<B extends object, K extends keyof B>(block: B, key: K, value: B[K] | undefined): void {
  if (value === undefined) delete block[key];
  else block[key] = value;
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
  // turnIds legitimately opened via turn.start / subagent.start (or restored
  // by a messages.snapshot's turns?) — Task 8c leg 3 (guuey capstone finding
  // B). Distinguishes "a real turn genuinely exists" from "ensureTurn() would
  // happily fabricate a stub for this key" so the tool.done adoption CREATE
  // path can degrade loudly (resync) instead of silently minting a phantom
  // turn for a key that was never actually opened.
  #openedTurns: Set<string> = new Set();
  // D9 (draft.4 §5.0 INV-OWNER; bar wf_08cf78ac-c30, A tightened): every
  // turnId the fold has seen opened — by turn.start, by subagent.start, or by a
  // folded messages.snapshot (its `turns`, or a message's turnId) — mapped to
  // the threadId it was opened on (undefined when the opener named none). A
  // snapshot that carries `turns` resets it (see the messages.snapshot arm).
  // Only a terminal for one of these folds onto a turn record, and a record it
  // has to create takes that thread, never the turnId. Kept apart from
  // #openedTurns (tool.done adoption) and never rebuilt from #turns, whose
  // records non-terminal arms may have minted as stubs.
  #seenOpened: Map<string, string | undefined> = new Map();
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

  // ── rd-14 INV-BLOCK (invoke-scoped) ─────────────────────────────────────────
  // Block ids created in the current invoke, and toolCallIds whose FINAL
  // (more-less) tool.done already landed. Both reset at the seq-0 restart, so a
  // new invoke may reuse per-invoke ids.
  #invokeBlockIds: Set<string> = new Set();
  #finalToolDone: Set<string> = new Set();

  /**
   * Feed a single normalized AgEvent into the fold.
   * R1: lifecycle handlers (turn/message/subagent/step).
   * R2: text + reasoning blocks (APPEND deltas, REPLACE opaque).
   * R3–R10 fill remaining content types.
   */
  push(ev: AgEvent): void {
    // ── Seq-gap detection (R9) ────────────────────────────────────────────────
    // Seq accounting is UNIVERSAL (INV-SEQ: "gap-free ordinal" over the whole
    // per-invoke stream) — EVERY well-formed event with a numeric seq advances
    // the gap check, INCLUDING events the reducer does not fold (ext.* and
    // other live-only events). This must run BEFORE the isClosedEvent skip
    // below: an ext/live-only event between two closed events still occupies a
    // seq slot, so skipping it here would let the NEXT closed event look like
    // a forward gap that never happened (found by M46 review — the false-park
    // this fixes voided every fold with an ext emission between closed events).
    // After the first event (#lastSeq >= 0), a forward gap sets #resync (park)
    // — including when an ext/live-only event is the one revealing the gap.
    if (this.#lastSeq >= 0 && ev.seq > this.#lastSeq + 1) {
      this.#resync = true;
    }
    // rd-14 (founder: "Stall it, like a gap"): a repeated or backward seq ABOVE 0
    // parks exactly like a forward gap. Only seq 0 (a new invoke's restart) may go
    // backward (SPEC INV-SEQ), so a re-delivery can never fold twice.
    if (this.#lastSeq >= 0 && ev.seq > 0 && ev.seq <= this.#lastSeq) {
      this.#resync = true;
    }

    // ── Park-gate (R9) ───────────────────────────────────────────────────────
    // While parked, process ONLY the two snapshot kinds; all else is ignored.
    // Both snapshots REPLACE + clear #resync inside their handlers.
    if (this.#resync) {
      if (ev.type === "messages.snapshot" || ev.type === "state.snapshot") {
        // Fall through to the switch — these handlers clear #resync.
      } else {
        // Parked: ignore. Do NOT update #lastSeq for ignored events.
        return;
      }
    }

    // Update #lastSeq for every processed event (including snapshots and
    // non-folding ext/live-only events — seq accounting is universal, see above).
    this.#lastSeq = ev.seq;
    // A seq-0 restart opens a new invoke: the invoke-scoped INV-BLOCK sets reset.
    if (ev.seq === 0) {
      this.#invokeBlockIds.clear();
      this.#finalToolDone.clear();
    }

    // Store-time isolation: the handlers below keep references into the event
    // (a block, a providerMetadata or _meta bag, a tool result, an outcome, a
    // state snapshot, a patch value, a memory value), so the fold works on its
    // own copy. A host that reuses or mutates its event object after push() can
    // never move the fold; result() clones on the way out, this on the way in.
    // It runs before the ext guard below, which then narrows the copy. An event
    // structuredClone cannot copy (a function-valued field) folds as pushed, as
    // it always did, rather than throwing out of push().
    try {
      ev = structuredClone(ev);
    } catch {
      // not cloneable: fold the event as pushed
    }

    // Ext events (`ext.<vendor>.<key>`) are live-only / non-folding (§4/§12).
    // Rule them out HERE — after seq accounting above, so an ext event still
    // advances the gap check/#lastSeq — so the switch below sees the narrowed
    // AgClosedEventType and avoids the AgExtEvent.catchall(JsonValue)
    // index-signature field widening.
    if (!isClosedEvent(ev)) return;

    switch (ev.type) {
      // ── TURN lifecycle ─────────────────────────────────────────────────────
      case "turn.start": {
        // Task 8c leg 3: a turn.start always counts as a legitimately opened turn.
        this.#openedTurns.add(ev.turnId);
        this.#seenOpened.set(ev.turnId, ev.threadId);
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
        // rd-14 INV-MSG: a message.start for a turn that already closed parks.
        if (this.#isClosedTurn(this.#resolveTurnId(ev.turnId) ?? ev.turnId)) { this.#resync = true; break; }
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
          ...(ev.noticeSource !== undefined ? { noticeSource: ev.noticeSource } : {}),
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
        // INV-MSG: sealing removes the open-message pointer so a post-seal
        // block-creating event degrades loudly (resync), never a silent attach.
        for (const [pk, msgId] of this.#openMsg) {
          if (msgId === ev.id) this.#openMsg.delete(pk);
        }
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
        // Task 8c leg 3: a subagent.start always counts as a legitimately
        // opened turn, even on the idempotent-duplicate early return below.
        this.#openedTurns.add(ev.turnId);
        // Idempotent: if the nested turn already exists, skip (never duplicate).
        const existingNested = this.#turns.get(ev.turnId);
        if (existingNested !== undefined) {
          this.#seenOpened.set(ev.turnId, existingNested.threadId);
          break;
        }
        // threadId is required on AgTurnRecord; inherit from the parent turn.
        // subagent.start does not carry threadId on the wire, so we look it up.
        const parentTurn = this.#turns.get(ev.parentTurnId);
        let threadId: string;
        if (parentTurn !== undefined) {
          threadId = parentTurn.threadId;
        } else {
          // Task 8c leg 2 (SPEC §1.2 + guuey capstone finding A): a parent
          // lookup miss means ev.parentTurnId is a wire label that was never
          // opened as a real turn (e.g. claude's synthetic `turn_${toolCallId}`
          // Task-tool cross-ref) — NOT a legitimate cross-thread reference.
          // Every entity in a fold shares one root threadId (SPEC §1.2), so
          // fall back to any ALREADY-OPENED real turn's threadId instead of
          // adopting the unresolvable label as this subagent's own threadId.
          // A "real" turn is identified by threadId !== turnId — a defensive
          // ensureTurn() stub uses its own turnId as a threadId placeholder
          // and must never be picked here. `ev.parentTurnId` remains the last
          // resort when no real turn exists yet.
          const realTurn = [...this.#turns.values()].find((t) => t.threadId !== t.turnId);
          threadId = realTurn?.threadId ?? ev.parentTurnId;
        }
        this.#turns.set(ev.turnId, {
          turnId: ev.turnId,
          parentTurnId: ev.parentTurnId,
          threadId,
        });
        this.#seenOpened.set(ev.turnId, threadId);
        break;
      }

      case "subagent.done": {
        // No AgReduceResult landing for subagent.done beyond what's already recorded.
        break;
      }

      // ── STEP lifecycle — structural scratch only, NO AgReduceResult landing ──
      case "step.start": {
        // Live-only structural marker (spec §5 step rows): steps have no
        // AgReduceResult container — no-op on the output tree.
        break;
      }

      case "step.done": {
        // Live-only structural marker (spec §5 step rows): step.done.usage has
        // no fold target; turn.done.usage is the authoritative turn accounting.
        break;
      }

      // ── TEXT blocks ───────────────────────────────────────────────────────────
      case "text.start": {
        if (this.#dupBlock(ev.id)) break; // rd-14 INV-BLOCK
        const msg = this.openMessage(ev.turnId, ev.candidateIndex ?? 0);
        if (msg === undefined) { this.#resync = true; break; }
        const block: AgBlock = {
          type: "text",
          text: "", // REQUIRED field — mid-stream result() before any delta must parse
          ...(ev.phase !== undefined ? { phase: ev.phase } : {}), // draft.4 open-string label
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
        // INV-MSG (SPEC.md:745): a straggler delta into a sealed message, or into
        // any message of a closed turn (rd-14), parks.
        if (this.#isClosedTarget(msg.id)) { this.#resync = true; break; } // INV-MSG delta guard
        const block = msg.content[pos.index];
        if (block === undefined || block.type !== "text") break;
        block.text += ev.delta;
        setProviderMeta(block, ev.providerMetadata);
        break;
      }

      case "text.end": {
        const pos = this.#blockPos.get(ev.id);
        if (pos === undefined) break;
        const msg = this.#messages.get(pos.messageId);
        if (msg === undefined) break;
        // INV-MSG (SPEC.md:745, draft.4 E5): a block-finalizing event into a sealed
        // message, or into any message of a closed turn, parks like a delta.
        if (this.#isClosedTarget(msg.id)) { this.#resync = true; break; } // INV-MSG finalizer guard (E5)
        const block = msg.content[pos.index];
        if (block === undefined || block.type !== "text") break;
        // draft.4 phase: a value on the end REPLACES the start one; absent keeps
        // it; never filled once the owning message is sealed.
        if (ev.phase !== undefined && !this.#sealed.has(msg.id)) block.phase = ev.phase;
        setProviderMeta(block, ev.providerMetadata);
        // STREAMED-text citations carrier (audit M22): attach citations to the
        // sealed block named by `ev.id` — never re-emitted as a duplicate
        // supplement block.
        if (ev.citations !== undefined) block.citations = ev.citations;
        break;
      }

      // ── REASONING blocks ──────────────────────────────────────────────────────
      case "reasoning.start": {
        if (this.#dupBlock(ev.id)) break; // rd-14 INV-BLOCK
        const msg = this.openMessage(ev.turnId, ev.candidateIndex ?? 0);
        if (msg === undefined) { this.#resync = true; break; }
        const block: AgBlock = {
          type: "reasoning",
          text: "", // seeded — mid-stream result() before any delta must parse
          ...(ev.phase !== undefined ? { phase: ev.phase } : {}), // draft.4 open-string label
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
        // INV-MSG (SPEC.md:745): a straggler delta into a sealed message, or into
        // any message of a closed turn (rd-14), parks.
        if (this.#isClosedTarget(msg.id)) { this.#resync = true; break; } // INV-MSG delta guard
        const block = msg.content[pos.index];
        if (block === undefined || block.type !== "reasoning") break;
        // APPEND delta to text (in-order concat of parts)
        block.text = (block.text ?? "") + ev.delta;
        setProviderMeta(block, ev.providerMetadata);
        break;
      }

      case "reasoning.end": {
        const pos = this.#blockPos.get(ev.id);
        if (pos === undefined) break;
        const msg = this.#messages.get(pos.messageId);
        if (msg === undefined) break;
        // INV-MSG (SPEC.md:745, draft.4 E5): a block-finalizing event into a sealed
        // message, or into any message of a closed turn, parks like a delta.
        if (this.#isClosedTarget(msg.id)) { this.#resync = true; break; } // INV-MSG finalizer guard (E5)
        const block = msg.content[pos.index];
        if (block === undefined || block.type !== "reasoning") break;
        // draft.4 phase: same rule as text.end (end REPLACES, absent keeps, no post-seal fill).
        if (ev.phase !== undefined && !this.#sealed.has(msg.id)) block.phase = ev.phase;
        setProviderMeta(block, ev.providerMetadata);
        if (ev.provider !== undefined) {
          block.provider = ev.provider;
        }
        break;
      }

      case "reasoning.opaque.delta": {
        // APPEND to per-id opaque scratch buffer (sealed by the following reasoning.opaque).
        // INV-MSG (SPEC.md:745): a straggler into a block of a sealed message
        // parks. The block is resolved by id; with no known block the delta
        // stays scratch-only, as before.
        const opaquePos = this.#blockPos.get(ev.id);
        if (opaquePos !== undefined && this.#isClosedTarget(opaquePos.messageId)) { this.#resync = true; break; } // INV-MSG delta guard
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
        // INV-MSG (SPEC.md:745, draft.4 E5): a block-finalizing event into a sealed
        // message, or into any message of a closed turn, parks like a delta.
        if (this.#isClosedTarget(msg.id)) { this.#resync = true; break; } // INV-MSG finalizer guard (E5)
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
        if (this.#dupBlock(ev.toolCallId)) break; // rd-14 INV-BLOCK
        const msg = this.openMessage(ev.turnId, ev.candidateIndex ?? 0);
        if (msg === undefined) { this.#resync = true; break; }
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
        // INV-MSG (SPEC.md:745): a straggler into a sealed message's tool call parks.
        const argsPos = this.#blockPos.get(ev.toolCallId);
        if (argsPos !== undefined && this.#isClosedTarget(argsPos.messageId)) { this.#resync = true; break; } // INV-MSG delta guard
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
        // INV-MSG (SPEC.md:745, draft.4 E5): a block-finalizing event into a sealed
        // message, or into any message of a closed turn, parks like a delta.
        if (this.#isClosedTarget(msg.id)) { this.#resync = true; break; } // INV-MSG finalizer guard (E5)
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
        setProviderMeta(block, ev.providerMetadata);
        // Clear scratch now that it's been superseded by the authoritative input.
        this.#toolArgs.delete(ev.toolCallId);
        break;
      }

      // ── TOOL-RESULT blocks ────────────────────────────────────────────────────
      case "tool.done": {
        // rd-14 INV-BLOCK: a second FINAL (more-less) tool.done for one call parks.
        if (ev.more !== true) {
          if (this.#finalToolDone.has(ev.toolCallId)) { this.#resync = true; break; }
          this.#finalToolDone.add(ev.toolCallId);
        }
        const resultKey = `result:${ev.toolCallId}`;
        const existingPos = this.#blockPos.get(resultKey);

        if (existingPos !== undefined) {
          // MERGE path: a kept-open (more:true) tool-result block exists for this
          // toolCallId; the incoming tool.done (final or next kept-open) folds onto it
          // as a snapshot (draft.4 §5, below).
          const msg = this.#messages.get(existingPos.messageId);
          if (msg === undefined) break;
          const block = msg.content[existingPos.index];
          if (block === undefined || block.type !== "tool-result") break;
          // INV-MSG enforcement: a post-terminal straggler tool.done for a still-open
          // more:true preliminary must never silently mutate a closed turn's already-
          // published content. Resolve the block's owning turn via the
          // #blockPos → messageId → message.turnId chain and park instead of mutating
          // (mirrors the adoption path's closed-turn/sealed guard above).
          const ownerTurnKey = msg.turnId ?? "unknown-turn";
          if (this.#sealed.has(msg.id) || this.#isClosedTurn(ownerTurnKey)) {
            this.#resync = true;
            break;
          }
          // Snapshot fold (draft.4 §5; fold/flush P1, bar wf_2231e194-e31): while a
          // result is kept open, every tool.done carries the FULL current result, so
          // a later one REPLACES the payload as a unit. content, outcome, isError,
          // structuredContent, uiData, sideData, errorText, errorCode and
          // pendingInput take the later event's values, and a field it omits is
          // CLEARED: an ok final no longer keeps a kept-open error's
          // isError/errorText, and an error final no longer keeps a kept-open
          // structuredContent. uiData is payload (founder ruling, bar
          // wf_93a30c7b-cd0): a carried `uiData: null` is STORED as a value ("no
          // view data"), never a retraction; a view's identity that must outlive a
          // snapshot lives on `_meta.ui.resourceUri`, a descriptor below.
          block.content = ev.content;
          replaceOrClear(block, "outcome", ev.outcome);
          replaceOrClear(block, "isError", ev.isError);
          replaceOrClear(block, "structuredContent", ev.structuredContent);
          replaceOrClear(block, "uiData", ev.uiData);
          replaceOrClear(block, "sideData", ev.sideData);
          replaceOrClear(block, "errorText", ev.errorText);
          replaceOrClear(block, "errorCode", ev.errorCode);
          replaceOrClear(block, "pendingInput", ev.pendingInput);
          // Descriptors are replaced only when the later event carries them:
          // toolMetadata and dynamic (SPEC.md:799; as tool.args.assembled treats
          // toolMetadata), and `_meta`, the §0.4 host side-channel, so a kept-open
          // result's MCP-Apps/A2UI card bootstrap survives a final that omits its
          // own (workspace#9). providerMetadata merges by key.
          if (ev.toolMetadata !== undefined) block.toolMetadata = ev.toolMetadata;
          if (ev.dynamic !== undefined) block.dynamic = ev.dynamic;
          if (ev._meta !== undefined) block._meta = ev._meta;
          setProviderMeta(block, ev.providerMetadata);
          // Typed preliminary flag mirrors the block's `more` state (audit M20):
          // more:true keeps it set (kept open); the final more-less tool.done
          // clears it and closes the result (removed from open tracking).
          if (ev.more) {
            block.preliminary = true;
          } else {
            delete block.preliminary;
            this.#blockPos.delete(resultKey);
          }
        } else {
          // CREATE path: first tool.done for this toolCallId.
          let msg: AgMessage | undefined;
          if (ev.messageId !== undefined) {
            // SPEC §5 tool.done row: the landed tool-result message ADOPTS
            // ev.messageId as its own id (stable ToolMessage identity; audit B10).
            const existing = this.#messages.get(ev.messageId);
            // INV-MSG enforcement: a sealed message, or ANY message of a closed
            // turn — including one that would need to be freshly created — is
            // never a valid adoption target. Resolve the turn this adoption
            // would land in (the existing message's own turnId, or the turnId
            // ensureTurn() would assign a new message) BEFORE either sub-path
            // runs, and park instead of silently attaching/creating past the
            // seal or the turn's binding window.
            const targetTurnKey =
              existing !== undefined
                ? (existing.turnId ?? "unknown-turn")
                : (this.#resolveTurnId(ev.turnId) ?? ev.turnId ?? "unknown-turn");
            // Task 8c leg 3 (guuey capstone finding B): a turn that was never
            // legitimately opened (turn.start / subagent.start / a snapshot's
            // turns?) is just as invalid an adoption target as a sealed
            // message or a closed turn — without this, ensureTurn() below
            // would happily fabricate a phantom turn stub instead of parking.
            if (
              this.#sealed.has(ev.messageId) ||
              this.#isClosedTurn(targetTurnKey) ||
              !this.#openedTurns.has(targetTurnKey)
            ) {
              this.#resync = true;
              break;
            }
            if (existing !== undefined) {
              msg = existing;
            } else {
              const turn = this.ensureTurn(ev.turnId);
              // Create new tool-result message with the adopted messageId.
              msg = {
                id: ev.messageId,
                role: "tool",
                content: [],
                turnId: turn.turnId,
                threadId: turn.threadId,
              };
              this.#messages.set(ev.messageId, msg);
            }
          } else {
            msg = this.openMessage(ev.turnId, ev.candidateIndex ?? 0);
          }
          if (msg === undefined) { this.#resync = true; break; }
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
            // workspace#9: the §0.4 host side-channel (MCP-Apps `_meta.ui` /
            // A2UI bootstraps) — mirrors the text.start/reasoning.start carriage.
            ...(ev._meta !== undefined ? { _meta: ev._meta } : {}),
            ...(ev.more === true ? { preliminary: true } : {}),
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

      // ── CONTENT.BLOCK ────────────────────────────────────────────────────────
      case "content.block": {
        // Transient at event level: skip (live-only, never folded).
        if (ev.transient === true) break;
        // Transient at block level (data block): skip.
        if (ev.block.type === "data" && ev.block.transient === true) break;

        const msg = this.openMessage(ev.turnId, ev.candidateIndex ?? 0);
        if (msg === undefined) { this.#resync = true; break; }

        // Same-id REPLACE-in-place: only data blocks carry id?.
        if (ev.block.type === "data" && ev.block.id !== undefined) {
          const existingPos = this.#blockPos.get(ev.block.id);
          if (existingPos !== undefined && existingPos.messageId === msg.id) {
            // REPLACE in place — same position, preserve byte-order.
            msg.content[existingPos.index] = ev.block;
            break;
          }
        }

        // APPEND: push the block and (for blocks with an id) register the position.
        const index = msg.content.length;
        msg.content.push(ev.block);
        if (ev.block.type === "data" && ev.block.id !== undefined) {
          this.#blockPos.set(ev.block.id, { messageId: msg.id, index });
        }
        break;
      }

      // ── MESSAGE.METADATA ─────────────────────────────────────────────────────
      case "message.metadata": {
        // Resolve the target message: by explicit messageId or the open assistant message.
        let msg: AgMessage | undefined;
        if (ev.messageId !== undefined) {
          msg = this.#messages.get(ev.messageId);
        } else {
          // Fall back to the open message for the event's turnId (base carries turnId?).
          msg = this.openMessage(ev.turnId, 0);
        }
        if (msg === undefined) break;
        // Shallow merge REPLACE-by-key into msg.metadata (create if absent).
        msg.metadata = { ...(msg.metadata ?? {}), ...ev.metadata } as typeof msg.metadata;
        break;
      }

      // ── TURN-RECORD events (R5) ───────────────────────────────────────────────

      case "turn.done": {
        // D9 (draft.4 §5.0 INV-OWNER): a terminal for a turn this fold never saw
        // opened is not an unresolvable owner: it folds onto no turn record and
        // does not park. A CORE client that ignores subagent.*, or a fold whose
        // opener was dropped, sees exactly this; a producer's lone terminal fails
        // the §10 producer turn-open leg instead of minting a stub record here.
        if (!this.#seenOpened.has(ev.turnId)) break;
        const turn = this.#seenTurnRecord(ev.turnId);
        if (turn === undefined) break;
        turn.finishReason = ev.finishReason;
        // draft.4: the native finish value, verbatim, beside its mapped reason.
        if (ev.finishReasonRaw !== undefined) turn.finishReasonRaw = ev.finishReasonRaw;
        // Usage is recorded VERBATIM — NO de-cumulation (spec §8.4; normalizer duty).
        if (ev.usage !== undefined) turn.usage = ev.usage;
        if (ev.safety !== undefined) turn.safety = ev.safety;
        if (ev.taskState !== undefined) turn.taskState = ev.taskState;
        turn.outcome = ev.outcome;
        // If outcome is paused, record the asks at the top-level asks[] too.
        if (ev.outcome.type === "paused") {
          turn.asks = ev.outcome.asks;
        }
        // messageMetadata: REPLACE-merge onto the message named by turn.done.messageId
        // when present, else the open message of this turn (audit M20).
        // (Read happens BEFORE the binding window closes below.)
        if (ev.messageMetadata !== undefined) {
          const msg = ev.messageId !== undefined ? this.#messages.get(ev.messageId) : this.openMessage(ev.turnId, 0);
          if (msg !== undefined) {
            msg.messageMetadata = ev.messageMetadata;
          }
        }
        // INV-MSG binding window: no blocks attach to a closed turn's messages.
        this.#closeTurnWindow(ev.turnId);
        this.#evictTurnScratch(ev.turnId);
        break;
      }

      case "turn.error": {
        // Non-folding into content; sets outcome={type:"error",...} on the turn record.
        // D9, as turn.done; only for a NAMED turnId (a turnId-less terminal keeps
        // the INV-OWNER backfill below).
        if (ev.turnId !== undefined && !this.#seenOpened.has(ev.turnId)) break;
        const turn = ev.turnId !== undefined ? this.#seenTurnRecord(ev.turnId) : this.ensureTurn(ev.turnId);
        if (turn === undefined) break;
        turn.outcome = {
          type: "error",
          message: ev.message,
          ...(ev.code !== undefined ? { code: ev.code } : {}),
        };
        // Usage is recorded VERBATIM — NO de-cumulation (mirrors turn.done; normalizer duty).
        if (ev.usage !== undefined) turn.usage = ev.usage;
        // INV-MSG binding window: no blocks attach to a closed turn's messages.
        this.#closeTurnWindow(ev.turnId);
        this.#evictTurnScratch(ev.turnId);
        break;
      }

      case "turn.abort": {
        // Non-folding into content; sets a dedicated aborted outcome on the turn record
        // (symmetric with turn.error). taskState is verbatim-A2A only and is NEVER
        // reducer-invented (audit M29) — it stays whatever a prior turn.done left it as.
        // D9, as turn.done; only for a NAMED turnId (a turnId-less terminal keeps
        // the INV-OWNER backfill below).
        if (ev.turnId !== undefined && !this.#seenOpened.has(ev.turnId)) break;
        const turn = ev.turnId !== undefined ? this.#seenTurnRecord(ev.turnId) : this.ensureTurn(ev.turnId);
        if (turn === undefined) break;
        turn.outcome = { type: "aborted", ...(ev.reason !== undefined ? { reason: ev.reason } : {}) };
        // INV-MSG binding window: no blocks attach to a closed turn's messages.
        this.#closeTurnWindow(ev.turnId);
        this.#evictTurnScratch(ev.turnId);
        break;
      }

      case "source": {
        // Append sourceId to the turn's sourceIds[] in order (preserve groundingChunks order),
        // AND land the FULL record (payload/chunkIndex/providerMetadata) on sources[] so
        // citations can resolve post-fold (audit M23) — sourceIds[] stays as the derived index.
        const turn = this.ensureTurn(ev.turnId);
        if (turn.sourceIds === undefined) {
          turn.sourceIds = [];
        }
        turn.sourceIds.push(ev.sourceId);
        if (turn.sources === undefined) {
          turn.sources = [];
        }
        turn.sources.push({
          sourceId: ev.sourceId,
          source: ev.source,
          ...(ev.chunkIndex !== undefined ? { chunkIndex: ev.chunkIndex } : {}),
          ...(ev.providerMetadata !== undefined ? { providerMetadata: ev.providerMetadata } : {}),
        });
        break;
      }

      case "handoff": {
        // Push an AgHandoffRecord onto the turn's handoffs[].
        const turn = this.ensureTurn(ev.turnId);
        if (turn.handoffs === undefined) {
          turn.handoffs = [];
        }
        const record: AgHandoffRecord = {
          ...(ev.kind !== undefined ? { kind: ev.kind } : {}),
          ...(ev.fromAgentId !== undefined ? { fromAgentId: ev.fromAgentId } : {}),
          ...(ev.toAgentId !== undefined ? { toAgentId: ev.toAgentId } : {}),
          ...(ev.toAgentName !== undefined ? { toAgentName: ev.toAgentName } : {}),
        };
        turn.handoffs.push(record);
        break;
      }

      case "prompt.blocked": {
        // Record safety[] on the turn (merge — append to existing safety, or create) AND
        // land the dedicated promptBlocked record {reason, safety?} so the REQUIRED reason
        // and the blockedness itself survive the fold — a bare-reason block used to fold to
        // ZERO trace (audit M28).
        const turn = this.ensureTurn(ev.turnId);
        if (ev.safety !== undefined) {
          if (turn.safety === undefined) {
            turn.safety = [...ev.safety];
          } else {
            turn.safety = [...turn.safety, ...ev.safety];
          }
        }
        turn.promptBlocked = {
          reason: ev.reason,
          ...(ev.safety !== undefined ? { safety: ev.safety } : {}),
        };
        break;
      }

      case "guardrail.result": {
        // Push a guardrail evaluation record onto the turn's guardrails[].
        const turn = this.ensureTurn(ev.turnId);
        if (turn.guardrails === undefined) {
          turn.guardrails = [];
        }
        turn.guardrails.push({
          target: ev.target,
          passed: ev.passed,
          ...(ev.action !== undefined ? { action: ev.action } : {}),
          ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
          ...(ev.guardrailName !== undefined ? { guardrailName: ev.guardrailName } : {}),
          ...(ev.safety !== undefined ? { safety: ev.safety } : {}),
        });
        break;
      }

      case "display.required": {
        // MUST NOT drop (ToS). Push {provider, html} onto turn's displayRequired[].
        const turn = this.ensureTurn(ev.turnId);
        if (turn.displayRequired === undefined) {
          turn.displayRequired = [];
        }
        const entry: AgDisplayRequired = { provider: ev.provider, html: ev.html };
        turn.displayRequired.push(entry);
        break;
      }

      case "agent.capabilities": {
        // SPEC §5: "Record the agent's AgCapabilities on the turn (first-turn negotiation)."
        // Fold ev.capabilities onto the AgTurnRecord for the owning turn.
        const turn = this.ensureTurn(ev.turnId);
        turn.capabilities = ev.capabilities;
        break;
      }

      // ── ARTIFACT side-channel (R7) ─────────────────────────────────────────────
      case "artifact.start": {
        // Create a new AgArtifact entry in #artifacts.
        const artifact: AgArtifact = {
          artifactId: ev.artifactId,
          turnId: ev.turnId,
          threadId: ev.threadId,
          parts: [],
          ...(ev.name !== undefined ? { name: ev.name } : {}),
          ...(ev.description !== undefined ? { description: ev.description } : {}),
          ...(ev.extensions !== undefined ? { extensions: ev.extensions } : {}),
        };
        this.#artifacts.set(ev.artifactId, artifact);
        break;
      }

      case "artifact.delta": {
        // Append or concatenate onto the artifact's parts[].
        const artifact = this.#artifacts.get(ev.artifactId);
        if (artifact === undefined) break;
        if (ev.append === false) {
          // START a new part: push a shallow copy of the incoming part so that
          // subsequent in-place text concatenation (append:true) does NOT mutate
          // the original event object.  The caller may be replaying the same
          // event array twice (batch vs. incremental), so aliasing must be broken here.
          artifact.parts.push({ ...ev.part });
        } else {
          // CONCATENATE onto the last part.
          const last = artifact.parts[artifact.parts.length - 1];
          if (last !== undefined && last.type === "text" && ev.part.type === "text") {
            // Both are text blocks: append the text in-place.
            last.text += ev.part.text;
          } else {
            // Incompatible types or empty parts array: push a SHALLOW COPY (same
            // aliasing discipline as the append:false path above) so a following
            // append:true in-place concat can't mutate the original event object.
            artifact.parts.push({ ...ev.part });
          }
        }
        break;
      }

      case "artifact.end": {
        // Finalize the artifact. No further parts; nothing to do beyond leaving it
        // in #artifacts. The lastChunk:true flag is informational only.
        break;
      }

      // ── SHARED STATE side-channel (R8) ───────────────────────────────────────

      case "state.snapshot": {
        // REPLACE #state wholesale with the incoming snapshot value.
        // Also clears #resync if set — state.snapshot is one of the two valid
        // resync-recovery paths (the R9 park-gate will route it here while parked).
        this.#state = ev.snapshot;
        this.#resync = false;
        break;
      }

      case "state.delta": {
        // Apply patch to #state using a tightened discriminator:
        //
        //   Array.isArray(patch)                 → RFC-6902 via applyPatch (R6)
        //   typeof patch === "object" && != null  → key-replace: each top-level key set whole (draft.4, pkg-21)
        //   else (scalar / null)                  → explicit no-op
        //     (documented: a future third source may extend this discriminator;
        //      scalars are NOT an error and must NOT set #resync)
        const patch = ev.patch;
        if (Array.isArray(patch)) {
          // RFC-6902 path: requires an existing document to patch against.
          if (this.#state === undefined) {
            // No document to apply the patch to — signal resync (same semantics
            // as memory.write patch against a never-seeded record).
            this.#resync = true;
            break;
          }
          const result = applyPatch(this.#state, patch);
          if (!result.ok) {
            // applyPatch failed — signal resync; leave #state unchanged.
            this.#resync = true;
            break;
          }
          this.#state = result.value;
        } else if (typeof patch === "object" && patch !== null) {
          // Key-replace (draft.4 §5, pkg-21, founder-ruled): each top-level key
          // of the patch REPLACES #state[key] whole, which is how ADK applies
          // a stateDelta (sessions/state.js State.set). draft.3 merged one
          // level deep: a write that rewrote part of an object-valued key kept
          // the stale members (state-fold-gemini38: {cfg:{a:1,b:2}} then
          // {cfg:{a:5}} folded to {cfg:{a:5,b:2}} where ADK holds {cfg:{a:5}}),
          // and two partial writes to one key could assemble an object neither
          // write held (DC-6). null is stored as a value. #state starts as {}
          // when it is absent or not an object.
          // Keys are DEFINED, never assigned, so an own `__proto__` key of a
          // hand-built patch never selects the state's prototype.
          const base: { [k: string]: JsonValue } =
            this.#state !== undefined && typeof this.#state === "object" && !Array.isArray(this.#state)
              ? { ...this.#state }
              : {};
          for (const key of Object.keys(patch)) {
            const value = patch[key];
            if (value !== undefined) {
              // Copy-isolated from the event, as the capstone C1/C2 fixes require.
              Object.defineProperty(base, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
            }
          }
          this.#state = base;
        }
        // else: scalar or null patch — explicit no-op. A future third source may
        // extend this discriminator deliberately; do NOT crash or set #resync.
        break;
      }

      // ── MEMORY side-channel (R7) ──────────────────────────────────────────────
      case "memory.write": {
        // Memory records are keyed by `${scope}${key ?? ""}`.
        const memKey = `${ev.scope}${ev.key ?? ""}`;

        if (ev.value !== undefined) {
          // SET path: create or replace the record.
          const record: AgMemoryRecord = {
            scope: ev.scope,
            ...(ev.key !== undefined ? { key: ev.key } : {}),
            value: ev.value,
            ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
            ...(ev.durable !== undefined ? { durable: ev.durable } : {}),
            ...(ev.turnId !== undefined ? { turnId: ev.turnId } : {}),
          };
          this.#memory.set(memKey, record);
        } else if (ev.patch !== undefined) {
          // PATCH path: mutate an existing record via R6 applyPatch.
          const existing = this.#memory.get(memKey);
          if (existing === undefined) {
            // NEVER seed from {} — set resync flag and bail.
            this.#resync = true;
            break;
          }
          const result = applyPatch(existing.value, ev.patch);
          if (!result.ok) {
            // applyPatch failed — set resync flag and leave record unchanged.
            this.#resync = true;
            break;
          }
          // Update value in-place; also update optional metadata from the event.
          existing.value = result.value;
          if (ev.reason !== undefined) existing.reason = ev.reason;
          if (ev.durable !== undefined) existing.durable = ev.durable;
        }
        break;
      }

      // ── MESSAGE.REMOVE (R9) ──────────────────────────────────────────────────
      case "message.remove": {
        if (ev.id === REMOVE_ALL) {
          // REMOVE_ALL: remove every message of exactly the given turnId.
          // Parse-enforced: id===REMOVE_ALL without turnId is already rejected.
          const targetTurnId = ev.turnId;
          if (targetTurnId === undefined) break; // parse-rejected; should not reach
          const toRemove: string[] = [];
          for (const [msgId, msg] of this.#messages) {
            if (msg.turnId === targetTurnId) {
              toRemove.push(msgId);
            }
          }
          // Zero matches = deterministic no-op (not an error).
          for (const msgId of toRemove) {
            this.#removeMessage(msgId);
          }
        } else {
          this.#removeMessage(ev.id);
        }
        break;
      }

      // ── MESSAGES.SNAPSHOT (R9) ───────────────────────────────────────────────
      case "messages.snapshot": {
        // structuredClone each incoming array at store time so a later in-place
        // mutation (turn.done/source/text.delta/memory.write patch onto a
        // snapshot-seeded record) can NOT write through into the original event
        // object — otherwise a re-fold (batch vs incremental) of the same array
        // diverges (same aliasing discipline as result()/applyPatch).
        // ALWAYS replace #messages.
        this.#messages = new Map(structuredClone(ev.messages).map((m) => [m.id, m]));

        // CONDITIONALLY replace #turns (only if turns? present in event).
        if (ev.turns !== undefined) {
          this.#turns = new Map(structuredClone(ev.turns).map((t) => [t.turnId, t]));
        }

        // CONDITIONALLY replace #artifacts (only if artifacts? present in event).
        if (ev.artifacts !== undefined) {
          this.#artifacts = new Map(structuredClone(ev.artifacts).map((a) => [a.artifactId, a]));
        }

        // CONDITIONALLY replace ONLY scope==="thread" memory records.
        // Rebuild: [surviving non-thread records in insertion order, then snapshot's thread records].
        if (ev.memory !== undefined) {
          const nonThread: [string, AgMemoryRecord][] = [];
          for (const [k, rec] of this.#memory) {
            if (rec.scope !== "thread") {
              nonThread.push([k, rec]);
            }
          }
          const snapshotThread: [string, AgMemoryRecord][] = structuredClone(ev.memory)
            .filter((rec) => rec.scope === "thread")
            .map((rec) => [`${rec.scope}${rec.key ?? ""}`, rec]);
          this.#memory = new Map([...nonThread, ...snapshotThread]);
        }

        // Clear the transient scratch (draft.5 §5 messages.snapshot row): per-
        // toolCallId arg scratch, reasoning signature scratch, open-message
        // pointers, message seals and block positions; open/un-sealed blocks go
        // with the #messages REPLACE above. INV-BLOCK's invoke-scoped id sets are
        // NOT cleared (only a 0-restart resets them). Turn closure is not
        // scratch: it follows the turn records this arm leaves in the fold
        // (INV-MSG, #isClosedTurn), so carried turns bring their outcomes and a
        // turns-omitting snapshot keeps every record, and with it every closure.
        this.#toolArgs = new Map();
        this.#opaque = new Map();
        this.#openMsg = new Map();
        this.#sealed = new Set();
        this.#blockPos = new Map();
        // Task 8c leg 3: a snapshot-restored turn counts as opened (guuey
        // capstone finding B) — reseed #openedTurns from the replaced turns in
        // lockstep with #turns above; a turns-omitting snapshot re-seeds it from
        // the records it keeps.
        this.#openedTurns = ev.turns !== undefined
          ? new Set(ev.turns.map((t) => t.turnId))
          : new Set(this.#turns.keys());
        // D9 (bar wf_08cf78ac-c30): a snapshot that carries `turns` is
        // authoritative, so seen becomes exactly its turns plus its messages'
        // turns (a turn seen before it and absent from it is no longer seen);
        // one that omits `turns` keeps what was seen and adds its messages'
        // turns. Never rebuilt from #turns (a source/handoff/guardrail event
        // can have minted a stub record for a turn nobody opened). A
        // message-carried turn takes the thread of this snapshot's first
        // message with that turnId and a threadId, else none.
        if (ev.turns !== undefined) this.#seenOpened = new Map(ev.turns.map((t) => [t.turnId, t.threadId]));
        const snapshotTurnIds = new Set((ev.turns ?? []).map((t) => t.turnId));
        const messageThread = new Map<string, string | undefined>();
        for (const m of ev.messages) {
          if (m.turnId === undefined || snapshotTurnIds.has(m.turnId)) continue;
          if (messageThread.get(m.turnId) === undefined) messageThread.set(m.turnId, m.threadId);
        }
        for (const [turnId, threadId] of messageThread) this.#seenOpened.set(turnId, threadId);

        // Un-park.
        this.#resync = false;
        break;
      }

      // ── LIVE-ONLY / NON-FOLDING (R9) ─────────────────────────────────────────
      // These events produce NO change to the fold result.
      // `error` (bare advisory), `host.context`, `hitl.ask`, and ALL `ui.*` events.
      // (Note: `turn.error` and `turn.abort` are NOT here — they fold in R5.)
      case "error":
      case "host.context":
      case "hitl.ask":
      case "ui.call":
      case "ui.result":
      case "ui.action-result":
      case "ui.widget.result":
      case "ui.display-mode":
      case "ui.surface.start":
      case "ui.surface.update":
      case "ui.surface.end":
      case "ui.data-model":
        // Live-only: deliberate no-op. No accumulator mutation.
        break;

      // All other event types are handled by later tasks (R6–R10).
      default:
        break;
    }
  }

  /**
   * Remove a single message by id from #messages, its content blocks' #blockPos
   * entries (guarded by messageId match), and revert the #openMsg pointer for
   * its partition to the last still-present, not-#sealed message in insertion order.
   *
   * The block-creating handlers that call openMessage() already set #resync when
   * the pointer is missing (none), so we only need to update the pointer here.
   */
  #removeMessage(msgId: string): void {
    const msg = this.#messages.get(msgId);
    if (msg === undefined) return; // no-op if not found

    // Remove #blockPos entries ONLY when their stored messageId matches.
    // This guards against corrupting blocks in other partitions that share a block id.
    for (const [blockId, pos] of this.#blockPos) {
      if (pos.messageId === msgId) {
        this.#blockPos.delete(blockId);
        // Clear the per-block scratch buffers too (same block-id / toolCallId key),
        // else a stale opaque-signature / arg buffer leaks into a LATER message that
        // reuses the same id (cross-task scratch leak — byte-identity can't catch it
        // because it corrupts batch AND incremental identically). (final-review M1)
        this.#toolArgs.delete(blockId);
        this.#opaque.delete(blockId);
        // INV-BLOCK is about ids PRESENT in the fold (SPEC INV-BLOCK): a removed
        // block's id is no longer present, so a later *.start may reuse it.
        this.#invokeBlockIds.delete(blockId);
      }
    }

    // Remove from #messages.
    this.#messages.delete(msgId);
    // Remove from #sealed if sealed.
    this.#sealed.delete(msgId);

    // ── Pointer-revert ────────────────────────────────────────────────────────
    // Determine the partition key for this message.
    const turnId = msg.turnId;
    if (turnId === undefined) return; // no partition to revert
    const candIdx = msg.candidateIndex ?? 0;
    const pk = partKey(turnId, candIdx);

    // Check if the removed message was the current open pointer.
    const currentOpen = this.#openMsg.get(pk);
    if (currentOpen !== msgId) return; // pointer was not pointing to this message; done.

    // Revert: find the LAST still-present, not-#sealed message of this partition
    // in #messages insertion order.
    let revertTo: string | undefined = undefined;
    for (const [id, m] of this.#messages) {
      if (m.turnId === turnId && (m.candidateIndex ?? 0) === candIdx && !this.#sealed.has(id)) {
        revertTo = id; // keep scanning — we want the LAST one
      }
    }

    if (revertTo !== undefined) {
      this.#openMsg.set(pk, revertTo);
    } else {
      // No valid prior message: delete the pointer (none).
      this.#openMsg.delete(pk);
      // A subsequent block-creating event with no pointer will set #resync
      // via the openMessage() stub → #resync path in the block handlers.
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
    // INV-MSG: a sealed message is never an attach target (belt-and-braces —
    // message.end already clears the pointer; this covers any path that
    // doesn't go through that clear, e.g. a future direct pointer mutation).
    if (this.#sealed.has(msgId)) return undefined;
    return this.#messages.get(msgId);
  }

  /**
   * Delete every open-message pointer belonging to a closed turn (INV-MSG).
   * Closure itself is the record's `outcome`, set by the terminal arm before
   * this runs (#isClosedTurn); this only evicts the turn's open-message pointers.
   */
  #closeTurnWindow(turnId: string | undefined): void {
    const resolved = this.#resolveTurnId(turnId);
    if (resolved === undefined) return;
    for (const [pk] of this.#openMsg) {
      if (pk.startsWith(`${resolved} `)) this.#openMsg.delete(pk);
    }
  }

  /**
   * Evict dangling per-block streaming scratch owned by a closed turn
   * (audit M51): #toolArgs/#opaque entries are otherwise reclaimed only on
   * assembled/seal/snapshot — an errored/aborted turn leaks them and a reused
   * per-invoke block id in a LATER turn would concatenate stale scratch.
   */
  #evictTurnScratch(turnId: string | undefined): void {
    const resolved = this.#resolveTurnId(turnId);
    if (resolved === undefined) return;
    for (const [blockId, pos] of this.#blockPos) {
      const msg = this.#messages.get(pos.messageId);
      if (msg?.turnId === resolved) {
        this.#toolArgs.delete(blockId);
        this.#opaque.delete(blockId);
      }
    }
  }

  /**
   * Resolve a possibly-omitted turnId.
   *
   * If `turnId` is provided, return it verbatim.
   * If omitted and exactly one turn is open, return that turn's id.
   * Otherwise return `undefined` (ambiguous / no turns open).
   */
  /** INV-MSG: true when the message is sealed or its turn has closed (rd-14 closed-turn half). */
  #isClosedTarget(messageId: string): boolean {
    if (this.#sealed.has(messageId)) return true;
    return this.#isClosedTurn(this.#messages.get(messageId)?.turnId);
  }

  /**
   * INV-MSG (draft.5, CB-8 A′: closure follows the records): a turn is closed
   * while the fold holds a turn record for it that carries an `outcome`. Only a
   * folded turn.done / turn.error / turn.abort sets one, so a terminal that
   * folds onto no record closes nothing; a messages.snapshot changes closure
   * only through the records its §5 per-container rule leaves in the fold. No
   * message of a closed turn (sealed or not, existing or not yet created) is a
   * valid attach or adoption target. `key` is a resolved turnId or the
   * "unknown-turn" stub key.
   */
  #isClosedTurn(key: string | undefined): boolean {
    return key !== undefined && this.#turns.get(key)?.outcome !== undefined;
  }

  /** rd-14 INV-BLOCK: a block-creating id seen twice in one invoke parks; else records it. */
  #dupBlock(id: string): boolean {
    if (this.#invokeBlockIds.has(id)) {
      this.#resync = true;
      return true;
    }
    this.#invokeBlockIds.add(id);
    return false;
  }

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
   * Defensive turn lookup: get an existing `AgTurnRecord` by turnId, or create a
   * minimal stub if the record-on-turn event arrives before its `turn.start`.
   *
   * Record-on-turn events (turn.done, turn.error, turn.abort, source, handoff,
   * prompt.blocked, guardrail.result, display.required) all carry `turnId` (optional
   * in the base schema). When turnId is undefined, fall back to the sole open turn
   * (single-turn-stream default). If still ambiguous, create a fallback record keyed
   * on "unknown-turn" — the stub will be visible in turns[] but can be reconciled on
   * a subsequent messages.snapshot resync.
   *
   * AgTurnRecord requires `threadId`; when creating a defensive stub we use the
   * turnId itself as a placeholder (no threadId is available without turn.start).
   */
  /**
   * D9: the record a terminal for a SEEN turn folds onto — the existing one,
   * else one created on the thread the fold saw the turn opened on. With no
   * thread known it returns undefined and the terminal folds onto no record.
   * No other turn's thread is borrowed (that could adopt a subagent's parent
   * label as a threadId), and a D9 path never writes a threadId equal to its
   * turnId.
   */
  #seenTurnRecord(turnId: string): AgTurnRecord | undefined {
    const existing = this.#turns.get(turnId);
    if (existing !== undefined) return existing;
    const threadId = this.#seenOpened.get(turnId);
    if (threadId === undefined) return undefined;
    const record: AgTurnRecord = { turnId, threadId };
    this.#turns.set(turnId, record);
    return record;
  }

  ensureTurn(turnId: string | undefined): AgTurnRecord {
    const resolved = this.#resolveTurnId(turnId) ?? turnId;
    const key = resolved ?? "unknown-turn";
    const existing = this.#turns.get(key);
    if (existing !== undefined) return existing;
    // Defensive stub: threadId is required on AgTurnRecord; use key as placeholder.
    const stub: AgTurnRecord = { turnId: key, threadId: key };
    this.#turns.set(key, stub);
    return stub;
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
 * Batch fold. Returns the folded result AND the resync signal — a parked fold
 * is never a silent truncation (audit M50; INV-SEQ: "a conformant reducer MUST
 * expose its resync condition to the caller").
 */
export function reduce(events: AgEvent[]): { result: AgReduceResult; needsResync: boolean } {
  const r = new Reducer();
  for (const ev of events) {
    r.push(ev);
  }
  return { result: r.result(), needsResync: r.needsResync };
}
