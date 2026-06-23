/**
 * `@silverprotocol/claude-agent-sdk` — the LIVE-path normalizer.
 *
 * Translates the public Claude Agent SDK `SDKMessage` union (the run-seam yields
 * these; see guuey `backend/services/nocode-runtime/src/code-worker.ts`) into
 * AgJSON events (`AgEvent[]`, spec §4). Claude's assistant turn is a
 * COMPLETE-message structure — `message.content[]` is the whole turn's content,
 * not a stream of deltas — so the per-block fan-out is a TS function (clearer
 * than pure JSONata). The portable pure-structural subset (assistant text →
 * `text.*`, result-success → `turn.done`) also ships as `rule.jsonata`,
 * re-exported here for cross-runtime reuse.
 *
 * One `SDKMessage` → one self-contained `AgEvent[]`. `seq` is allocated
 * monotonically from 0 WITHIN each call; the Router rebases to a global ordinal
 * downstream (out of scope here). Stable ids derive from the SDK ids
 * (`message.id`, block `id`, `tool_use_id`).
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgEvent,
  type AgBlock,
  type AgCitation,
  type AgFinishReason,
  type AgSafety,
  type AgSource,
  type AgUsage,
  JsonValue,
  type Normalizer,
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

import { ruleJsonata } from "./rule.js";

/** The portable pure-structural JSONata subset (assistant text → `text.*`,
 *  result-success → `turn.done`). Re-exported for cross-runtime reuse; the full
 *  per-block branching lives in {@link claudeNormalizer}. The canonical source of
 *  this string is the sibling `rule.jsonata` artifact. */
export { ruleJsonata };

// ─── seq allocator ────────────────────────────────────────────────────────────
// Monotonic per call, from 0. A tiny closure keeps the emit sites declarative.
function makeEmitter() {
  let seq = 0;
  const events: AgEvent[] = [];
  return {
    push(ev: AgEvent): void {
      events.push(ev);
    },
    next(): number {
      return seq++;
    },
    events,
  };
}

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

// ─── assistant content block fan-out (spec §4 mapping table) ──────────────────
// Per content[] block, emit its lifecycle events under the open message.
function emitAssistantBlock(
  e: ReturnType<typeof makeEmitter>,
  block: BetaContentBlock,
  messageId: string,
  blockIndex: number,
): void {
  switch (block.type) {
    case "text": {
      const id = `${messageId}:text:${blockIndex}`;
      e.push({ type: "text.start", seq: e.next(), id, messageId, turnId: undefined });
      e.push({ type: "text.delta", seq: e.next(), id, messageId, delta: block.text });
      e.push({ type: "text.end", seq: e.next(), id, messageId });
      if (block.citations !== null && block.citations.length > 0) {
        const mappedCitations = mapCitations(block.citations);
        e.push({
          type: "content.block",
          seq: e.next(),
          block: { type: "text", text: block.text, citations: mappedCitations },
          messageId,
        });
      }
      return;
    }
    case "thinking": {
      const id = `${messageId}:reasoning:${blockIndex}`;
      e.push({ type: "reasoning.start", seq: e.next(), id, messageId });
      e.push({ type: "reasoning.delta", seq: e.next(), id, messageId, delta: block.thinking });
      e.push({ type: "reasoning.end", seq: e.next(), id, messageId });
      // The Anthropic thinking signature is replay-load-bearing (spec §8/§10):
      // sets `opaque` on the reasoning block named by `id`. Echo or multi-turn
      // reasoning breaks.
      if (block.signature && block.signature.length > 0) {
        e.push({
          type: "reasoning.opaque",
          seq: e.next(),
          id,
          messageId,
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
      e.push({ type: "reasoning.start", seq: e.next(), id, messageId });
      e.push({ type: "reasoning.end", seq: e.next(), id, messageId });
      e.push({
        type: "reasoning.opaque",
        seq: e.next(),
        id,
        messageId,
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
      e.push({
        type: "tool.start",
        seq: e.next(),
        toolCallId,
        name: block.name,
        // MCP tool calls carry the originating server (spec §4 tool.start.serverName).
        serverName: block.type === "mcp_tool_use" ? block.server_name : undefined,
        index: blockIndex,
        messageId,
        providerExecuted,
      });
      e.push({
        type: "tool.args.delta",
        seq: e.next(),
        toolCallId,
        messageId,
        delta: JSON.stringify(input),
      });
      e.push({
        type: "tool.args.assembled",
        seq: e.next(),
        toolCallId,
        messageId,
        input,
      });
      return;
    }
    case "mcp_tool_result": {
      // MCP tool results from the assistant side: map to tool.done with content + outcome.
      const outcome: ToolOutcome = block.is_error ? "error" : "ok";
      const content: AgBlock[] =
        typeof block.content === "string"
          ? block.content.length > 0
            ? [{ type: "text", text: block.content }]
            : []
          : block.content.map((tb): AgBlock => ({ type: "text", text: tb.text }));
      e.push({
        type: "tool.done",
        seq: e.next(),
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
      e.push({
        type: "content.block",
        seq: e.next(),
        messageId,
        block: {
          type: "compaction",
          text: block.content ?? undefined,
          opaque:
            block.encrypted_content !== null
              ? { kind: "ciphertext", value: block.encrypted_content, provider: "anthropic" }
              : undefined,
          provider: "anthropic",
        },
      });
      return;
    }
    default: {
      // image / resource / other rich content blocks ride content.block (spec §4).
      e.push({
        type: "content.block",
        seq: e.next(),
        block: assistantContentBlockToAgBlock(block),
        messageId,
      });
      return;
    }
  }
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

// ─── the normalizer ───────────────────────────────────────────────────────────
const claudeNormalizer: Normalizer<SDKMessage> = (msg) => {
  const e = makeEmitter();

  if (msg.type === "assistant") {
    const m = msg.message;
    const turnId = turnIdFor(msg.session_id, m.id);
    const parentTurnId =
      msg.parent_tool_use_id !== null ? `turn_${msg.parent_tool_use_id}` : undefined;

    // A non-null parent_tool_use_id ⇒ this assistant message is a NESTED turn
    // (subagent). subagent.start is the SOLE nested-turn opener (spec §4/§5);
    // its events route by turnId.
    if (parentTurnId !== undefined) {
      e.push({ type: "subagent.start", seq: e.next(), turnId, parentTurnId });
    }

    e.push({
      type: "message.start",
      seq: e.next(),
      id: m.id,
      role: "assistant",
      turnId,
      threadId: msg.session_id,
    });
    m.content.forEach((block, i) => emitAssistantBlock(e, block, m.id, i));
    e.push({ type: "message.end", seq: e.next(), id: m.id, turnId, usage: mapMessageUsage(m.usage) });

    // If the assistant turn carries an error signal (rate_limit, billing_error, etc.),
    // emit a turn.error so consumers see the error rather than a silent empty turn.
    if (msg.error !== undefined) {
      const errCode: NonNullable<SDKAssistantError> = msg.error;
      e.push({
        type: "turn.error",
        seq: e.next(),
        turnId,
        message: errCode,
        code: errCode,
        retriable: errCode === "rate_limit" || errCode === "server_error",
      });
    }

    if (parentTurnId !== undefined) {
      e.push({ type: "subagent.done", seq: e.next(), turnId, parentTurnId });
    }
    return e.events;
  }

  if (msg.type === "user") {
    // A user message carrying tool_result blocks → tool.done per result.
    // parent_tool_use_id (when set) identifies a subagent tool call — the
    // tool.done's turnId should point at that parent call's turn so the
    // subagent reduce() correctly routes the result.
    const content = msg.message.content;
    if (typeof content !== "string") {
      const toolTurnId =
        msg.parent_tool_use_id !== null ? `turn_${msg.parent_tool_use_id}` : undefined;
      for (const block of content) {
        if (block.type === "tool_result") {
          const outcome: ToolOutcome = block.is_error === true ? "error" : "ok";
          const toolContent =
            block.content === undefined ? [] : toolResultContentToAgBlocks(block.content);
          e.push({
            type: "tool.done",
            seq: e.next(),
            toolCallId: block.tool_use_id,
            content: toolContent,
            outcome,
            isError: block.is_error === true,
            turnId: toolTurnId,
          });
        }
      }
    }
    return e.events;
  }

  if (msg.type === "result" && msg.subtype === "success") {
    const turnId = turnIdFor(msg.session_id, msg.uuid);
    const safety: AgSafety[] | undefined =
      msg.stop_reason === "refusal"
        ? [{ category: "refusal", blocked: true }]
        : undefined;
    // structured_output (when a response schema is in effect) overrides the plain
    // string result — it is the authoritative typed outcome payload (spec §4).
    const structuredOutput =
      msg.structured_output !== undefined ? JsonValue.parse(msg.structured_output) : undefined;
    e.push({
      type: "turn.done",
      seq: e.next(),
      turnId,
      outcome: { type: "success", result: structuredOutput ?? msg.result },
      finishReason: mapStopReason(msg.stop_reason),
      usage: mapTurnUsage(msg.usage, msg.total_cost_usd, msg.modelUsage),
      safety,
    });
    // Emit permission_denials as tool.start + tool.done denied pairs.
    for (const denial of msg.permission_denials) {
      e.push({
        type: "tool.start",
        seq: e.next(),
        toolCallId: denial.tool_use_id,
        name: denial.tool_name,
      });
      e.push({
        type: "tool.done",
        seq: e.next(),
        toolCallId: denial.tool_use_id,
        content: [],
        outcome: "denied",
      });
    }
    return e.events;
  }

  if (msg.type === "result") {
    // At this point msg.subtype can only be an error variant (success was handled and returned above).
    const turnId = turnIdFor(msg.session_id, msg.uuid);
    const retriable = msg.subtype !== "error_max_turns";
    e.push({
      type: "turn.error",
      seq: e.next(),
      turnId,
      message: msg.errors.length > 0 ? msg.errors.join("; ") : msg.subtype,
      code: msg.subtype,
      retriable,
    });
    return e.events;
  }

  // Other SDKMessage variants (system, partial-assistant, status, …) carry no
  // AgJSON-relevant content on this seam → no events.
  return e.events;
};

export default claudeNormalizer;
export { claudeNormalizer, mapStopReason };
