/**
 * `@silverprotocol/claude-agent-sdk` — the LIVE-path normalizer (stateful facet).
 *
 * Translates the public Claude Agent SDK `SDKMessage` union (the run-seam yields
 * these; see guuey `backend/services/nocode-runtime/src/code-worker.ts`) into
 * AgJSON events (`AgEvent[]`, spec §4) by driving a shared {@link StreamAssembler}
 * via primitive calls. Claude's assistant turn is a COMPLETE-message structure —
 * `message.content[]` is the whole turn's content, not a stream of deltas — so the
 * per-block fan-out is a TS function (clearer than pure JSONata).
 *
 * The engine owns sequencing and turn assembly: it synthesizes a `turn.start` at
 * the head of each unseen TOP-LEVEL turn (`openMessage` → `#ensureTurn`), backfills
 * `turnId` onto content/tool events from the owning message, and allocates a
 * turn-scoped monotonic `seq`. A NESTED (`parent_tool_use_id`) assistant message is
 * seeded by `subagentStart`, so the engine does NOT synthesize a `turn.start` for it.
 *
 * `push(native)` structurally guards `native` → `SDKMessage`; on a guard failure it
 * routes the raw payload through the lossless `ext.anthropic.unparsed` channel and
 * returns — graceful, never throws (Tenet 6). Stable ids derive from the SDK ids
 * (`message.id`, block `id`, `tool_use_id`).
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgBlock,
  type AgCitation,
  type AgFinishReason,
  AgMeta,
  AgProviderMeta,
  type AgSafety,
  type AgSource,
  type AgUsage,
  type AgEvent,
  JsonValue,
  type Normalizer,
  StreamAssembler,
  type ToolOutcome,
} from "@silverprotocol/core";

// ─── types DERIVED from SDKMessage (version-correct) ──────────────────────────
// The platform's `@anthropic-ai/sdk` (the bundled copy the Claude Agent SDK pins)
// differs from any root-level copy, so we never import its subpaths directly —
// every shape is projected out of the `SDKMessage` union so it always tracks the
// SDK the run-seam actually yields.
type SDKAssistant = Extract<SDKMessage, { type: "assistant" }>;
type SDKUser = Extract<SDKMessage, { type: "user" }>;
type BetaMessageT = SDKAssistant["message"];
type BetaContentBlock = BetaMessageT["content"][number];
type BetaStopReason = NonNullable<BetaMessageT["stop_reason"]>;
type UserContent = SDKUser["message"]["content"];
type ContentBlockParam = Extract<UserContent, readonly unknown[]>[number];
type ToolResultBlock = Extract<ContentBlockParam, { type: "tool_result" }>;
type ToolResultContent = ToolResultBlock["content"];
type ImageBlockSource = Extract<ContentBlockParam, { type: "image" }>["source"];
// Assistant-side mcp_tool_result content (distinct shape from the user-side
// tool_result content mapped by `toolResultContentToAgBlocks`).
type McpToolResultBlock = Extract<BetaContentBlock, { type: "mcp_tool_result" }>;
type McpToolResultContent = McpToolResultBlock["content"];

// ─── Additional types derived from SDKMessage (version-correct) ──────────────
type SDKResultMsg = Extract<SDKMessage, { type: "result" }>;
type SDKResultSuccessMsg = Extract<SDKResultMsg, { subtype: "success" }>;
// For modelUsage per-model breakdown
type SDKModelUsage = SDKResultSuccessMsg["modelUsage"][string];
// For assistant error signal (rate_limit, billing_error, etc.)
type SDKAssistantError = SDKAssistant["error"];
// For text block citations
type BetaTextBlockT = Extract<BetaContentBlock, { type: "text" }>;
type BetaTextCitationT = NonNullable<BetaTextBlockT["citations"]>[number];

// ─── stop_reason → AgFinishReason (spec §4) ───────────────────────────────────
// Anthropic BetaStopReason superset → the neutral finish-reason superset.
function mapStopReason(stop: BetaStopReason | string | null): AgFinishReason {
  switch (stop) {
    case "end_turn":
      return "stop";
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "token_limit";
    case "model_context_window_exceeded":
      return "context_window_exceeded";
    case "tool_use":
      return "tool_call";
    case "pause_turn":
      return "pause_turn";
    case "refusal":
      return "refusal";
    case "compaction":
      // Anthropic server-loop compaction checkpoint — a resumable pause, no asks.
      return "pause_turn";
    case null:
      return "stop";
    default:
      return "unknown";
  }
}

// ─── derive stable ids ────────────────────────────────────────────────────────
// A stable per-message turn id: the assistant message is the model's turn, so
// the SDK session id names the turn (a top-level turn shares the session). When
// absent, fall back to the message id.
function turnIdFor(sessionId: string | undefined, messageId: string): string {
  return sessionId && sessionId.length > 0 ? `turn_${sessionId}` : `turn_${messageId}`;
}

// ─── image source mapping (Anthropic → AgSource, spec §2) ─────────────────────
function imageSource(source: ImageBlockSource): AgSource {
  if (source.type === "base64") {
    return { type: "base64", mediaType: source.media_type, data: source.data };
  }
  // url
  return { type: "url", url: source.url };
}

// ─── usage mapping helpers ────────────────────────────────────────────────────
function mapModelUsage(mu: SDKModelUsage): AgUsage {
  return {
    inputTokens: mu.inputTokens,
    outputTokens: mu.outputTokens,
    cacheReadTokens: mu.cacheReadInputTokens,
    cacheWriteTokens: mu.cacheCreationInputTokens,
    costUsd: mu.costUSD,
    serverToolRequests: mu.webSearchRequests,
    cumulative: true,
  };
}

function mapTurnUsage(
  usage: SDKResultSuccessMsg["usage"],
  totalCostUsd: number,
  modelUsage: SDKResultSuccessMsg["modelUsage"],
): AgUsage {
  const byModel: Record<string, AgUsage> = {};
  for (const [model, mu] of Object.entries(modelUsage)) {
    byModel[model] = mapModelUsage(mu);
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    serverToolRequests:
      usage.server_tool_use !== null
        ? usage.server_tool_use.web_search_requests + usage.server_tool_use.web_fetch_requests
        : undefined,
    costUsd: totalCostUsd,
    cumulative: true,
    ...(Object.keys(byModel).length > 0 ? { byModel } : {}),
  };
}

function mapMessageUsage(usage: BetaMessageT["usage"]): AgUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
    cumulative: true,
  };
}

// ─── citation mapping helpers ─────────────────────────────────────────────────
function mapCitations(citations: BetaTextCitationT[]): AgCitation[] {
  const result: AgCitation[] = [];
  for (const c of citations) {
    if (c.type === "char_location") {
      result.push({
        kind: "char",
        citedText: c.cited_text,
        title: c.document_title ?? undefined,
        documentIndex: c.document_index,
        startCharIndex: c.start_char_index,
        endCharIndex: c.end_char_index,
        indexFrame: "source",
      });
    } else if (c.type === "page_location") {
      result.push({
        kind: "page",
        citedText: c.cited_text,
        title: c.document_title ?? undefined,
        documentIndex: c.document_index,
        startPage: c.start_page_number,
        endPage: c.end_page_number,
      });
    } else if (c.type === "content_block_location") {
      result.push({
        kind: "block",
        citedText: c.cited_text,
        title: c.document_title ?? undefined,
        documentIndex: c.document_index,
        startBlockIndex: c.start_block_index,
        endBlockIndex: c.end_block_index,
      });
    } else if (c.type === "web_search_result_location") {
      result.push({
        kind: "url",
        citedText: c.cited_text,
        url: c.url,
        title: c.title ?? undefined,
        encryptedIndex: c.encrypted_index,
        indexFrame: "response",
      });
    } else if (c.type === "search_result_location") {
      result.push({
        kind: "block",
        citedText: c.cited_text,
        title: c.title ?? undefined,
        source: c.source ?? undefined,
        documentIndex: c.search_result_index,
        startBlockIndex: c.start_block_index,
        endBlockIndex: c.end_block_index,
      });
    }
  }
  return result;
}

// Map a non-lifecycle assistant content block (rich blocks with no dedicated
// lifecycle: container uploads, server-tool-result blocks, …) onto an AgBlock for
// content.block. BetaContentBlock has no `image` arm on the ASSISTANT side, so
// these pass through as provider-raw (spec §2 provider-raw), preserving the
// vendor shape losslessly — nothing is silently dropped. The block is plain JSON;
// JsonValue.parse validates it at the opaque pass-through boundary (no cast).
function assistantContentBlockToAgBlock(block: BetaContentBlock): AgBlock {
  return {
    type: "provider-raw",
    vendor: "anthropic",
    raw: JsonValue.parse(block),
  };
}

// ─── user/tool_result content fan-out (spec §2 — tool.done content blocks) ────
// The tool_result block's `content` is a string OR an array of param blocks; map
// to AgBlock[] (text / image), preserving the MCP content shape. The remaining
// rich param blocks pass through as provider-raw (spec §2; plain JSON validated
// at the opaque boundary by JsonValue.parse — no cast).
function toolResultContentToAgBlocks(content: NonNullable<ToolResultContent>): AgBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  const out: AgBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      out.push({ type: "image", source: imageSource(part.source) });
    } else {
      out.push({ type: "provider-raw", vendor: "anthropic", raw: JsonValue.parse(part) });
    }
  }
  return out;
}

// Assistant-side mcp_tool_result content → AgBlock[] (distinct shape from the
// user-side tool_result content mapped by `toolResultContentToAgBlocks` above).
// A `for...of` loop, not `.map` — playbook 2026-07-03 SDK-bump adaptation: the
// 0.3.199 `SDKMessage` union widened enough that `.map`/`.forEach`/`.filter`
// callback PARAMETER inference silently degrades to implicit `any` on this
// content shape (a known TS limitation calling an array method on a value typed
// as a union of structurally-different array types); a plain loop sidesteps it
// without an explicit-but-redundant parameter annotation, matching this file's
// established iteration style everywhere else.
function mcpToolResultContentToAgBlocks(content: McpToolResultContent): AgBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  const out: AgBlock[] = [];
  for (const tb of content) out.push({ type: "text", text: tb.text });
  return out;
}

// ─── assistant content block fan-out (spec §4 mapping table) ──────────────────
// Per content[] block, drive the engine to emit its lifecycle events under the
// open message named by `messageId`. `blockProviderMetadata` is the refusal-
// fallback `supersedes` carrier (playbook 2026-07-03 SDK-bump adaptation,
// Finding #1 / §8 item 19): the caller passes it ONLY for blockIndex 0 of a
// superseding message, mirroring the established "signature on first block"
// precedent (§8 item 8, Gemini thoughtSignature). `text`/`thinking`/
// `redacted_thinking`/`tool_use` family all have a providerMetadata slot on
// their *.start event and land it there; the remaining rarer block-0 shapes
// (image/resource/mcp_tool_result/compaction) have no providerMetadata slot on
// `content.block` and drop the annotation (NOT the retraction itself, which
// already executed via `message.remove` regardless — see `drive()`).
function emitAssistantBlock(
  a: StreamAssembler,
  block: BetaContentBlock,
  messageId: string,
  blockIndex: number,
  blockProviderMetadata?: AgProviderMeta,
): void {
  switch (block.type) {
    case "text": {
      // Claude's assistant message is a COMPLETE structure (not a live stream), so
      // citations are already known at the point text.end fires — they ride the
      // STREAMED-text citations carrier (audit M22: text.end.citations), never as
      // a duplicate id-less supplement block.
      const id = `${messageId}:text:${blockIndex}`;
      const citations =
        block.citations != null && block.citations.length > 0 ? mapCitations(block.citations) : undefined;
      a.textStart(id, messageId, blockProviderMetadata !== undefined ? { providerMetadata: blockProviderMetadata } : undefined);
      a.textDelta(id, messageId, block.text);
      a.textEnd(id, messageId, citations !== undefined ? { citations } : undefined);
      return;
    }
    case "thinking": {
      const id = `${messageId}:reasoning:${blockIndex}`;
      if (blockProviderMetadata !== undefined) {
        // reasoningStart's sugar signature has no providerMetadata parameter
        // (only textStart's does) — `a.emit()` is the documented base
        // primitive for exactly this case (schema DOES support it on
        // reasoning.start; StreamAssembler docstring: "guarantees no
        // AgClosedEventType is ever unreachable").
        a.emit({ type: "reasoning.start", id, messageId, providerMetadata: blockProviderMetadata });
      } else {
        a.reasoningStart(id, messageId);
      }
      a.reasoningDelta(id, messageId, block.thinking);
      a.reasoningEnd(id, messageId);
      // The Anthropic thinking signature is replay-load-bearing (spec §8/§10):
      // sets `opaque` on the reasoning block named by `id`. Echo or multi-turn
      // reasoning breaks.
      if (block.signature && block.signature.length > 0) {
        a.reasoningOpaque(id, messageId, {
          kind: "signature",
          value: block.signature,
          provider: "anthropic",
        });
      }
      return;
    }
    case "redacted_thinking": {
      // No visible text; the redacted blob is the replay-load-bearing opaque part.
      const id = `${messageId}:reasoning:${blockIndex}`;
      if (blockProviderMetadata !== undefined) {
        a.emit({ type: "reasoning.start", id, messageId, providerMetadata: blockProviderMetadata });
      } else {
        a.reasoningStart(id, messageId);
      }
      a.reasoningEnd(id, messageId);
      a.reasoningOpaque(id, messageId, {
        kind: "redacted",
        value: block.data,
        provider: "anthropic",
      });
      return;
    }
    case "tool_use":
    case "server_tool_use":
    case "mcp_tool_use": {
      // `input` is opaque JSON (spec §0.1) typed `unknown` by the SDK — validate
      // it at this genuine deserialization boundary into JsonValue (no cast).
      // Emit the buffered-args lifecycle: start → one args.delta (the whole JSON,
      // since Claude gives the assembled object up front) → the MANDATORY
      // args.assembled (spec §4/§8.1).
      const toolCallId = block.id;
      const input: JsonValue = JsonValue.parse(block.input);
      // server_tool_use blocks are always provider-executed; regular tool_use blocks
      // with a non-direct caller (e.g. code_execution_20250825) are also
      // provider-executed. A direct caller or absent caller ⇒ not provider-executed.
      const providerExecuted: boolean | undefined =
        block.type === "server_tool_use"
          ? true
          : "caller" in block && block.caller !== undefined
            ? block.caller.type !== "direct"
            : undefined;
      a.toolStart({
        toolCallId,
        name: block.name,
        // MCP tool calls carry the originating server (spec §4 tool.start.serverName).
        serverName: block.type === "mcp_tool_use" ? block.server_name : undefined,
        index: blockIndex,
        messageId,
        providerExecuted,
        ...(blockProviderMetadata !== undefined ? { providerMetadata: blockProviderMetadata } : {}),
      });
      a.toolArgsDelta(toolCallId, JSON.stringify(input));
      a.toolArgsAssembled(toolCallId, input);
      return;
    }
    case "mcp_tool_result": {
      // MCP tool results from the assistant side: map to tool.done with content + outcome.
      const outcome: ToolOutcome = block.is_error ? "error" : "ok";
      const content: AgBlock[] = mcpToolResultContentToAgBlocks(block.content);
      a.toolDone({
        toolCallId: block.tool_use_id,
        content,
        outcome,
        isError: block.is_error,
        messageId,
      });
      return;
    }
    case "compaction": {
      // Compaction blocks carry a provider-produced context summary (spec §4).
      // The encrypted_content is replay-load-bearing opaque data (spec §2/§8).
      a.contentBlock(messageId, {
        type: "compaction",
        text: block.content ?? undefined,
        opaque:
          block.encrypted_content !== null
            ? { kind: "ciphertext", value: block.encrypted_content, provider: "anthropic" }
            : undefined,
        provider: "anthropic",
      });
      return;
    }
    default: {
      // image / resource / other rich content blocks ride content.block (spec §4).
      a.contentBlock(messageId, assistantContentBlockToAgBlock(block));
      return;
    }
  }
}

// ─── structural guard: JsonValue → SDKMessage ─────────────────────────────────
// `push` receives the genuine JSON boundary (`JsonValue`, spec §0.1). The run-seam
// yields well-formed `SDKMessage`s, but this is the deserialization boundary so we
// confirm the discriminant + the per-arm load-bearing nested shape before driving
// the engine. A user-defined type guard (not a cast) narrows on success; a failure
// routes the raw payload to `ext.anthropic.unparsed` and returns (graceful, Tenet 6).
function isJsonObject(v: unknown): v is { readonly [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Input is `unknown` (not `JsonValue`): `SDKMessage` is NOT assignable to
// `JsonValue` (its nested BetaMessage has no index signature), so a `v is SDKMessage`
// predicate over a `JsonValue` param is rejected by TS (TS2677). `unknown` is the
// genuine deserialization-boundary input type and is predicate-compatible. The
// caller passes a `JsonValue`, which widens to `unknown` losslessly.
function isSDKMessage(v: unknown): v is SDKMessage {
  if (!isJsonObject(v)) return false;
  const t = v.type;
  if (t === "assistant") {
    const message = v.message;
    if (!isJsonObject(message)) return false;
    return typeof message.id === "string" && Array.isArray(message.content);
  }
  if (t === "user") {
    return isJsonObject(v.message) && "content" in v.message;
  }
  if (t === "result") {
    return typeof v.subtype === "string";
  }
  // system / partial-assistant / status / … — structurally valid SDKMessage arms
  // that carry no AgJSON-relevant content. Accept (the normalizer no-ops on them).
  return typeof t === "string";
}

// ─── the stateful normalizer ──────────────────────────────────────────────────
/**
 * Build a stateful Claude-facet normalizer over a fresh {@link StreamAssembler}.
 * Each `push(native)` validates `native` → `SDKMessage`, drives the engine via
 * primitive calls, and drains the buffered `AgEvent[]`. `flush()` closes any
 * dangling open message (none, in Claude's complete-message model) and drains.
 */
export function createClaudeNormalizer(): Normalizer {
  const a = new StreamAssembler();

  // Task 8c leg 4 (guuey capstone finding A): the wire-visible `parentTurnId`
  // label passed to subagent.start/.done (`turn_${parent_tool_use_id}`) is a
  // synthetic cross-ref that was never opened as a real turn — it must stay on
  // the wire (the guuey capstone asserts `parentTurnId === 'turn_<toolCallId>'`)
  // but must NOT be reused to route an INNER tool_result's turnId. Track the
  // REAL subagent turnId per spawning parent_tool_use_id, derived from the
  // sub-session's own assistant arm at subagent.start time, so a later inner
  // tool_result (same non-null parent_tool_use_id) can route to it instead.
  const subagentTurnByParentToolUseId = new Map<string, string>();

  // Playbook 2026-07-03 SDK-bump adaptation, Finding #1 (critical) — refusal-
  // fallback retraction (§8 item 19). `supersedes` / `retracted_message_uuids`
  // name PRIOR DELIVERED MESSAGES by their wire-frame `uuid` (`msg.uuid`) — a
  // DIFFERENT id space from the messageIds this facet actually emits (`m.id`
  // for an assistant frame's `message.start`, `${tool_use_id}:result` for an
  // ADOPTED tool-result frame, §8 item 15). Track uuid → the messageId(s) it
  // produced so a later retraction can translate before emitting
  // `message.remove` — "translated through the facet's uuid→messageId
  // convention" per the adaptation brief.
  const messageIdsByUuid = new Map<string, string[]>();

  function registerUuid(uuid: string | undefined, ids: readonly string[]): void {
    if (uuid === undefined || ids.length === 0) return;
    const existing = messageIdsByUuid.get(uuid);
    if (existing !== undefined) existing.push(...ids);
    else messageIdsByUuid.set(uuid, [...ids]);
  }

  // Evict every messageId ever produced for each uuid in `uuids`. An uuid this
  // facet never observed is skipped (Tenet 6: nothing is fabricated — the fold
  // has nothing live under an unknown id anyway; `reduce()`'s `#removeMessage`
  // is a documented no-op on an unknown id regardless). Safe to call from BOTH
  // retraction sources without double-effect: `supersedes` fires "on arrival"
  // (the field's own doc: evict immediately, treat this frame as canonical)
  // and the end-of-turn `model_refusal_fallback` notice re-asserts the same
  // uuids as "the complete audit record for the turn" — `#removeMessage`
  // no-ops a repeat remove, so processing both sources is idempotent.
  function retractUuids(uuids: readonly string[]): void {
    for (const uuid of uuids) {
      const ids = messageIdsByUuid.get(uuid);
      if (ids === undefined) continue;
      for (const id of ids) {
        a.emit({ type: "message.remove", id });
      }
    }
  }

  function drive(msg: SDKMessage): void {
    if (msg.type === "assistant") {
      const m = msg.message;
      const turnId = turnIdFor(msg.session_id, m.id);
      const parentTurnId =
        msg.parent_tool_use_id !== null ? `turn_${msg.parent_tool_use_id}` : undefined;

      // Finding #1 (critical): this frame supersedes prior delivered messages
      // (refusal-fallback retry) — evict them "on arrival", per the field's own
      // doc, before opening the canonical replacement below. Idempotent with
      // the end-of-turn `model_refusal_fallback` notice (see the `system`
      // branch further down) — see `retractUuids`'s doc.
      if (msg.supersedes !== undefined && msg.supersedes.length > 0) {
        retractUuids(msg.supersedes);
      }
      // The raw uuid list is ALSO carried losslessly as `providerMetadata` on
      // this message's first content block (mirrors the "signature on first
      // block" precedent, §8 item 8) — an audit trail independent of whether
      // every targeted uuid was resolvable above.
      const supersedesMeta: AgProviderMeta | undefined =
        msg.supersedes !== undefined && msg.supersedes.length > 0
          ? AgProviderMeta.parse({ supersedes: msg.supersedes })
          : undefined;

      // A non-null parent_tool_use_id ⇒ this assistant message is a NESTED turn
      // (subagent). subagent.start is the SOLE nested-turn opener (spec §4/§5) and
      // seeds the turn so openMessage does NOT synthesize a duplicate turn.start.
      if (parentTurnId !== undefined) {
        if (msg.parent_tool_use_id !== null) {
          subagentTurnByParentToolUseId.set(msg.parent_tool_use_id, turnId);
        }
        a.subagentStart(turnId, parentTurnId);
      }

      a.openMessage({
        id: m.id,
        role: "assistant",
        turnId,
        threadId: msg.session_id,
        model: m.model,
      });
      // A plain indexed loop, not `.forEach` — see `mcpToolResultContentToAgBlocks`'s
      // doc: `.forEach`'s callback parameter inference degrades to implicit `any`
      // on this content shape post-0.3.199.
      for (let i = 0; i < m.content.length; i++) {
        emitAssistantBlock(a, m.content[i], m.id, i, i === 0 ? supersedesMeta : undefined);
      }
      a.closeMessage(m.id, mapMessageUsage(m.usage));

      // If the assistant turn carries an error signal (rate_limit, billing_error, etc.),
      // emit a turn.error so consumers see the error rather than a silent empty turn.
      if (msg.error !== undefined) {
        const errCode: NonNullable<SDKAssistantError> = msg.error;
        a.closeTurnError(turnId, {
          message: errCode,
          code: errCode,
          // Finding #2 (minor): `overloaded` (transient capacity error, a first
          // cousin of rate_limit/server_error) joins the retriable set.
          // `model_not_found` (a permanent misconfiguration — e.g. a stale/
          // decommissioned model id) is deliberately EXCLUDED: explicit
          // false-by-omission, not an oversight (playbook 2026-07-03 SDK-bump
          // adaptation, Finding #2).
          retriable: errCode === "rate_limit" || errCode === "server_error" || errCode === "overloaded",
        });
      }

      if (parentTurnId !== undefined) {
        a.subagentDone(turnId, parentTurnId);
      }

      // Record this frame's own uuid → the messageId it produced, so a LATER
      // retraction naming this uuid can translate it (Finding #1).
      registerUuid(msg.uuid, [m.id]);
      return;
    }

    if (msg.type === "user") {
      // A user message carrying tool_result blocks → tool.done per result.
      // parent_tool_use_id (when set) identifies a subagent tool call — the
      // tool.done's turnId should point at that parent call's turn so the
      // subagent reduce() correctly routes the result.
      const content = msg.message.content;
      if (typeof content !== "string") {
        // Task 8c leg 4: prefer the REAL subagent turnId recorded at
        // subagent.start time. Fall back to the old synthetic label only when
        // it is unknown (e.g. a result delivered before its subagent.start
        // was ever observed) — defensive; leg 3's never-opened-turn guard now
        // parks loudly on that label instead of fabricating a phantom turn.
        const toolTurnId =
          msg.parent_tool_use_id !== null
            ? (subagentTurnByParentToolUseId.get(msg.parent_tool_use_id) ??
              `turn_${msg.parent_tool_use_id}`)
            : undefined;
        // tool_use_result sibling (SDK-injected rich MCP result; audit B7): carries
        // structuredContent (incl. render-cache markers) + _meta.ui the block-level
        // arm never sees. Applies only when the message has exactly ONE tool_result
        // block (the sibling is message-level; multi-result attribution is ambiguous —
        // skipped, and the census will surface it if a multi-result sibling ever occurs).
        const rawMsg = isJsonObject(msg) ? msg : undefined;
        const sibling =
          rawMsg !== undefined && isJsonObject(rawMsg["tool_use_result"])
            ? rawMsg["tool_use_result"]
            : undefined;
        const siblingSc =
          sibling?.["structuredContent"] !== undefined
            ? JsonValue.parse(sibling["structuredContent"])
            : undefined;
        const siblingMeta =
          sibling !== undefined && isJsonObject(sibling["_meta"])
            ? AgMeta.parse(sibling["_meta"])
            : undefined;
        const siblingHasUi = siblingMeta !== undefined && siblingMeta["ui"] !== undefined;
        // A `for...of` count, not `.filter(...).length` — see
        // `mcpToolResultContentToAgBlocks`'s doc: array-method callback
        // parameter inference degrades to implicit `any` on this content shape
        // post-0.3.199.
        let toolResultCount = 0;
        for (const b of content) if (b.type === "tool_result") toolResultCount++;
        const applySibling = sibling !== undefined && toolResultCount === 1;
        // Finding #1: this frame's own uuid may later be named by a retraction
        // (a refused leg's tombstoned tool_results, per the field's own doc) —
        // collect every adopted messageId this frame produces below.
        const resultMessageIds: string[] = [];
        for (const block of content) {
          if (block.type === "tool_result") {
            const outcome: ToolOutcome = block.is_error === true ? "error" : "ok";
            const toolContent =
              block.content === undefined ? [] : toolResultContentToAgBlocks(block.content);
            // `structuredContent` is not declared on `ToolResultBlockParam` in the
            // static SDK type, but the Claude Agent SDK injects it at runtime (spec §9
            // / MCP outputSchema). Use isJsonObject to widen `block` to the opaque
            // JSON-object boundary and extract the field via JsonValue.parse — no cast.
            const blockAsObj = isJsonObject(block) ? block : undefined;
            const sc =
              blockAsObj?.["structuredContent"] !== undefined
                ? JsonValue.parse(blockAsObj["structuredContent"])
                : undefined;
            const resultMessageId = `${block.tool_use_id}:result`;
            resultMessageIds.push(resultMessageId);
            a.toolDone({
              toolCallId: block.tool_use_id,
              content: toolContent,
              outcome,
              isError: block.is_error === true,
              turnId: toolTurnId,
              // SPEC §5 tool.done adoption (audit B10; Task 8b): the Claude SDK
              // closes the assistant message (message.end) BEFORE this tool_result
              // arrives, so a messageId-less toolDone here has no open message to
              // attach to and parks the fold (guuey fold-identity capstone caught
              // this on a real claude tool conversation). A stable derived
              // messageId engages the reducer's adoption path instead: the result
              // lands in its OWN dedicated role:"tool" message.
              messageId: resultMessageId,
              // §2.1 routing: MCP-Apps structuredContent (sibling with _meta.ui)
              // is surface data → uiData; base-MCP structuredContent → the model
              // channel. The sibling's copy is authoritative over the block-level
              // one (it carries the full payload incl. cache markers).
              ...(applySibling && siblingHasUi && siblingSc !== undefined
                ? { uiData: siblingSc }
                : {}),
              ...(applySibling && !siblingHasUi && siblingSc !== undefined
                ? { structuredContent: siblingSc }
                : sc !== undefined
                  ? { structuredContent: sc }
                  : {}),
              ...(applySibling && siblingHasUi && sc !== undefined ? { structuredContent: sc } : {}),
              ...(applySibling && siblingMeta !== undefined ? { _meta: siblingMeta } : {}),
            });
          }
        }
        // Finding #1: record this frame's uuid → the adopted messageId(s) it
        // produced, so a later retraction naming this uuid can translate it.
        registerUuid(msg.uuid, resultMessageIds);
      }
      return;
    }

    if (msg.type === "result" && msg.subtype === "success") {
      const turnId = turnIdFor(msg.session_id, msg.uuid);
      const safety: AgSafety[] | undefined =
        msg.stop_reason === "refusal" ? [{ category: "refusal", blocked: true }] : undefined;
      // structured_output (when a response schema is in effect) overrides the plain
      // string result — it is the authoritative typed outcome payload (spec §4).
      const structuredOutput =
        msg.structured_output !== undefined ? JsonValue.parse(msg.structured_output) : undefined;
      // Emit permission_denials as tool.start + tool.done denied pairs, inside a
      // dedicated carrier message: the assistant message is already sealed, and
      // INV-MSG (audit M19) forbids attaching to sealed messages / closed turns.
      if (msg.permission_denials.length > 0) {
        const denialMsgId = `${turnId}:denials`;
        a.openMessage({ id: denialMsgId, role: "assistant", turnId, threadId: msg.session_id });
        for (const denial of msg.permission_denials) {
          a.toolStart({ toolCallId: denial.tool_use_id, name: denial.tool_name });
          a.toolDone({ toolCallId: denial.tool_use_id, content: [], outcome: "denied" });
        }
        a.closeMessage(denialMsgId);
      }
      a.closeTurnDone(turnId, {
        outcome: { type: "success", result: structuredOutput ?? msg.result },
        finishReason: mapStopReason(msg.stop_reason),
        usage: mapTurnUsage(msg.usage, msg.total_cost_usd, msg.modelUsage),
        safety,
      });
      return;
    }

    if (msg.type === "result") {
      // At this point msg.subtype can only be an error variant (success handled above).
      const turnId = turnIdFor(msg.session_id, msg.uuid);
      // Guard `errors` and `subtype` defensively: `isSDKMessage` only checks
      // `typeof v.subtype === "string"` for the result arm — it does NOT validate
      // the `errors` array. A malformed message (missing errors, wrong subtype) must
      // not throw (Tenet 6: graceful, never throws).
      const errors = Array.isArray(msg.errors) ? msg.errors : [];
      const subtype = typeof msg.subtype === "string" ? msg.subtype : "error_unknown";
      const retriable = subtype !== "error_max_turns";
      a.closeTurnError(turnId, {
        message: errors.length > 0 ? errors.join("; ") : subtype,
        code: subtype,
        retriable,
      });
      return;
    }

    if (msg.type === "system" && msg.subtype === "informational") {
      // Fixture-drift ratchet FLAGSHIP finding (2026-07-03): CONTRADICTS
      // playbook-sdk-bumps-report.md's prior classification of this arm as a
      // "control-plane/CLI-UX signal, no model output". Direct field
      // inspection (sdk.d.ts) shows `content`/`level`/`prevent_continuation?`
      // are genuinely conversation/UX-relevant (transcript notices, an
      // explanation for why a turn halted, e.g. a Stop hook denial) — not
      // telemetry. LOCKED DISPOSITION: no first-class AgJSON event exists for
      // this today (a `notice` core event is a future spec-process decision,
      // §8 item 21) — carry it losslessly via the facet's established
      // `ext.anthropic.*` convention rather than drop it.
      a.emitExt("anthropic", "informational", {
        content: msg.content,
        level: msg.level,
        ...(msg.prevent_continuation !== undefined ? { preventContinuation: msg.prevent_continuation } : {}),
      });
      return;
    }

    if (msg.type === "system" && msg.subtype === "model_refusal_fallback") {
      // Finding #1 (critical): the end-of-turn authoritative eviction record —
      // "the complete audit record for the turn" per the field's own doc.
      // Idempotent with the earlier `supersedes`-triggered eviction above (see
      // `retractUuids`'s doc); also the ONLY retraction path when a consumer
      // never observed (or a normalizer instance never processed) the
      // superseding assistant frame's own `supersedes` field directly.
      const uuids = Array.isArray(msg.retracted_message_uuids) ? msg.retracted_message_uuids : [];
      retractUuids(uuids);
      return;
    }

    // Other SDKMessage variants (system, partial-assistant, status, …) carry no
    // AgJSON-relevant content on this seam → no events.
  }

  return {
    push(native: JsonValue): AgEvent[] {
      if (!isSDKMessage(native)) {
        // Graceful guard (Tenet 6): route the raw payload through the lossless
        // vendor channel rather than throwing. Nest under `native` so a payload
        // that carries its own `type` key (the common malformed-SDKMessage shape
        // that lands here) does NOT clobber the `ext.anthropic.unparsed` event type
        // (emitExt spreads object payloads at the top level).
        a.emitExt("anthropic", "unparsed", { native });
        return a.drain();
      }
      drive(native);
      return a.drain();
    },
    flush(): AgEvent[] {
      return a.flush();
    },
  };
}

export default createClaudeNormalizer;
export { mapStopReason };
