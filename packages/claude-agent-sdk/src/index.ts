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
 * One API message id can nevertheless span SEVERAL `assistant` frames (thinking
 * block, then tool_use block), so the message lifecycle is keyed on `message.id`
 * and its seal is deferred across contiguous same-id frames: one
 * `message.start`/`message.end` pair per id, never a re-open of a sealed id
 * (INV-MSG — see `PendingMessage` in `createClaudeNormalizer`, guuey#26).
 *
 * With `includePartialMessages: true` (workspace#7) the seam ALSO interleaves
 * `stream_event` frames — the raw Anthropic streaming vocabulary — before each
 * complete assistant frame. Partials map to the SAME lifecycles under the SAME
 * ids (token-granular `text.delta`/`reasoning.delta`/`tool.args.delta`), and
 * the complete frame that follows joins the streamed lifecycle content-
 * suppressed, so nothing is emitted twice; a consumer without partials sees
 * byte-identical output to before (see `driveStreamEvent`).
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
  withAtomicPush,
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

// ─── stream_event (partial-assistant) arm — workspace#7 ──────────────────────
// With `includePartialMessages: true` the run-seam interleaves
// `{type:"stream_event", event: BetaRawMessageStreamEvent}` frames (the raw
// Anthropic streaming vocabulary) before each complete assistant frame. Same
// no-subpath-import rule as above: every shape is projected out of the union.
type SDKPartial = Extract<SDKMessage, { type: "stream_event" }>;
type StreamEvent = SDKPartial["event"];
type StreamContentBlock = Extract<StreamEvent, { type: "content_block_start" }>["content_block"];

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

// draft.4 (§8.0 graceful degradation / §10 item 23): when `mapStopReason` had to
// FALL BACK (a stop_reason this facet has no mapping for, e.g. one a newer
// Messages API ships), `turn.done.finishReasonRaw` carries the native value
// verbatim beside finishReason "unknown", so nothing about why the turn ended
// is lost. Set ONLY on the fallback: a mapped reason, and `null` (a real
// "stop"), carry no raw companion, so ordinary turns stay byte-identical.
function stopReasonRaw(stop: BetaStopReason | string | null): string | undefined {
  return typeof stop === "string" && mapStopReason(stop) === "unknown" ? stop : undefined;
}

// ─── derive stable ids ────────────────────────────────────────────────────────
// Turn ids are minted per TURN inside `createClaudeNormalizer()` (see
// `topTurnId` / `nestedTurnId`), never per session: through 0.6.4 the facet
// keyed every top-level turn on `turn_${session_id}`, so in a multi-turn
// invoke the second turn's message.start and content landed on T AFTER
// turn.done(T) (the assembler's seen-turn set suppressed a second
// turn.start), breaking INV-TURN (SPEC:743), and reduce() merged every turn
// of a session into one AgTurnRecord (sp-protocol, 2026-09-23).

// ─── image source mapping (Anthropic → AgSource, spec §2) ─────────────────────
function imageSource(source: ImageBlockSource): AgSource {
  if (source.type === "base64") {
    return { type: "base64", mediaType: source.media_type, data: source.data };
  }
  // url
  return { type: "url", url: source.url };
}

// ─── usage mapping helpers ────────────────────────────────────────────────────

/**
 * Reads `usage.output_tokens_details.thinking_tokens` off an Anthropic usage
 * object — the thinking-token telemetry that has ridden `message_delta` and
 * result usage on the wire for a while (a constant 0 until the 0.3.257 fix made
 * it real; corpus/partials-sonnet5 carries the 0). The bundled
 * `@anthropic-ai/sdk` `BetaUsage` / `BetaMessageDeltaUsage` types (0.93.0) still
 * do NOT declare `output_tokens_details`, so it is read through a runtime guard
 * at the JsonValue boundary — the user branch's `structuredContent` precedent —
 * never a cast that widens the peer type.
 *
 * SUBSET semantics — the SDK's own doc for the per-model twin
 * (`ModelUsage.thinkingTokens`: "Thinking tokens, already counted inside
 * outputTokens"): the value lands on `AgUsage.reasoningTokens` as a BREAKDOWN
 * of `outputTokens`, not an additional bucket. Consumers must never sum
 * `reasoningTokens + outputTokens`. Spec §4 (draft.3) makes this the rule for
 * every facet: the openai facet copies `output_tokens_details.reasoning_tokens`
 * (already inclusive upstream), and the adk facet FOLDS Gemini's sibling
 * `thoughtsTokenCount` into `outputTokens` (0.6.0; through 0.5.4 it carried
 * Gemini's exclusive `candidatesTokenCount` verbatim — this JSDoc's own 0.5.4
 * claim that adk already followed the subset convention was wrong).
 *
 * Absent ⇒ `undefined`, and every caller spreads the field conditionally, so a
 * frame without `output_tokens_details` normalizes byte-identically to before.
 */
function readThinkingTokens(usage: unknown): number | undefined {
  if (!isJsonObject(usage)) return undefined;
  const details = usage["output_tokens_details"];
  if (!isJsonObject(details)) return undefined;
  const thinking = details["thinking_tokens"];
  return typeof thinking === "number" ? thinking : undefined;
}

// `thinkingTokens` (0.3.257) → `reasoningTokens`: the per-model twin of
// `readThinkingTokens` above — same subset-of-outputTokens semantics (the SDK's
// own doc: "already counted inside outputTokens"), same absent ⇒ no key rule.
function mapModelUsage(mu: SDKModelUsage): AgUsage {
  return {
    inputTokens: mu.inputTokens,
    outputTokens: mu.outputTokens,
    cacheReadTokens: mu.cacheReadInputTokens,
    cacheWriteTokens: mu.cacheCreationInputTokens,
    ...(mu.thinkingTokens !== undefined ? { reasoningTokens: mu.thinkingTokens } : {}),
    costUsd: mu.costUSD,
    serverToolRequests: mu.webSearchRequests,
    cumulative: true,
  };
}

// `server_tool_use` is typed `{web_search_requests, web_fetch_requests} | null`,
// but a result frame is discriminant-validated only, so a leaner producer (a
// proxy, an older CLI) can omit it or a member. Through 0.7.0's stack an ABSENT
// member passed the `!== null` check and threw a TypeError out of push()
// (Tenet 6 / SPEC §8.0 "MUST NOT throw"; found by sp-protocol writing §10.23),
// and a missing counter summed to NaN. Both counters numbers ⇒ their sum;
// anything else ⇒ absent.
function serverToolRequestCount(usage: unknown): number | undefined {
  if (!isJsonObject(usage)) return undefined;
  const stu = usage["server_tool_use"];
  if (!isJsonObject(stu)) return undefined;
  const search = stu["web_search_requests"];
  const fetch = stu["web_fetch_requests"];
  return typeof search === "number" && typeof fetch === "number" ? search + fetch : undefined;
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
  const reasoningTokens = readThinkingTokens(usage);
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    serverToolRequests: serverToolRequestCount(usage),
    costUsd: totalCostUsd,
    cumulative: true,
    ...(Object.keys(byModel).length > 0 ? { byModel } : {}),
  };
}

function mapMessageUsage(usage: BetaMessageT["usage"]): AgUsage {
  const reasoningTokens = readThinkingTokens(usage);
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
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

// `tool_result_meta` (CLI 2.1.280, @internal, runtime-only; live on sp-probe's
// defer resume-deny capture): per tool_result, keyed by tool_use_id. Its
// `non_execution_kind` is "the harness-stamped reason an is_error:true result did
// not carry the tool's own execution output (user-rejected / permission-rule /
// automode-* / interrupted / cancelled); absent means the tool ran to
// completion" (the CLI's own schema doc). Read through the JSON boundary; a
// malformed entry is skipped. The entry itself is NOT carried here (that carry
// is package 15's); only the kind decides the outcome below.
function readNonExecutionKinds(frame: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isJsonObject(frame)) return out;
  const list = frame["tool_result_meta"];
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (isJsonObject(entry) && typeof entry["id"] === "string" && typeof entry["non_execution_kind"] === "string") {
      out.set(entry["id"], entry["non_execution_kind"]);
    }
  }
  return out;
}

// The non_execution_kinds that mean the call was NOT PERMITTED to run →
// `outcome:"denied"` (SPEC :850: "denied is a distinct recorded outcome"; §8.0
// item 15 routes Claude's permission denials to it; sp-protocol, 2026-09-23).
// `interrupted`, `cancelled`, absent and any unknown value are not denials and
// keep "error" (no guessing).
function isDenialKind(kind: string | undefined): boolean {
  return kind === "user-rejected" || kind === "permission-rule" || (kind !== undefined && kind.startsWith("automode-"));
}

// Which assistant `error` codes are transient (retriable). CL-09's stashed
// top-level close and a nested frame's non-terminal `error` share it.
// Finding #2 (minor): `overloaded` (transient capacity error, a first
// cousin of rate_limit/server_error) joins the retriable set.
// `model_not_found` (a permanent misconfiguration — e.g. a stale/
// decommissioned model id) is deliberately EXCLUDED: explicit
// false-by-omission, not an oversight (playbook 2026-07-03 SDK-bump
// adaptation, Finding #2). `account_on_hold` (0.3.258) is likewise a
// deliberate non-retriable: a billing-class code (the account is on
// hold — a first cousin of `billing_error`, cleared by the account
// holder, never by re-sending the turn).
//
// 0.3.272 widened `SDKAssistantMessageError` by two more values, both
// deliberate non-retriables recorded here for the same reason — an
// omission must never read as an oversight:
//  - `verification_required`: the request is gated on an out-of-band
//    human step (identity/org verification). Nothing about the turn
//    changes by re-sending it; the block clears only when a person
//    completes the verification.
//  - `cloud_credential_error`: a credential/billing-class failure on
//    the cloud-provider leg (a first cousin of `billing_error` and
//    `account_on_hold`, not of `overloaded`) — a bad, expired or
//    unauthorized credential is exactly as bad on the next attempt.
function assistantErrorRetriable(errCode: NonNullable<SDKAssistantError>): boolean {
  return errCode === "rate_limit" || errCode === "server_error" || errCode === "overloaded";
}

// ─── assistant content block fan-out (spec §4 mapping table) ──────────────────
// Per content[] block, drive the engine to emit its lifecycle events under the
// open message named by `messageId`. The caller passes the frame's wrapper
// carry ONLY for blockIndex 0, mirroring the "signature on first block"
// precedent (§8 item 8, Gemini thoughtSignature), in two bags:
//  - `blockProviderMetadata`: the REPLAY-side wrapper facts (`supersedes`,
//    `resumed_from_incomplete_thinking`, `aborted`, `context_usage`,
//    `usage_report`, the turn-binding family). `text` / `thinking` /
//    `redacted_thinking` and the `tool_use` family land it on their *.start
//    event. The rarer block-0 shapes (mcp_tool_result / compaction / the
//    default content.block) never apply it, so those facts drop there (a
//    disclosed, pre-existing gap; a retraction itself still executes via
//    `message.remove` regardless, see `drive()`).
//  - `blockMeta` (X5): the HOST-only wrapper facts (HOST_ONLY_WRAPPER_KEYS).
//    Only text.start / reasoning.start get it, because `reduce()` folds their
//    `_meta` onto the block.
// Returns which halves ANCHORED on a folded start event: `replay` when the
// block type has a providerMetadata slot the caller's bag landed on (text,
// thinking, redacted_thinking, the tool_use family), `host` when `blockMeta`
// landed (text / thinking / redacted_thinking only; tool.start folds no
// `_meta`). The caller routes every UNANCHORED half through the assistant
// message's `message.metadata`, so no wrapper fact is dropped. (Before this,
// a frame whose first block was a compaction, an mcp_tool_result or a
// content.block lost its replay half silently: those have no providerMetadata
// slot, and an mcp_tool_result's tool.done belongs to another message.) That fallback is message-level and
// merges REPLACE-by-key, so it does not say which frame the frame-relative
// `narration_block_indexes` belong to. In practice it is not reached: the CLI
// sends one content block per frame, narration marks thinking/text blocks, and
// an API-error frame starts with text.
type BlockAnchor = { readonly replay: boolean; readonly host: boolean };
const NOTHING_ANCHORED: BlockAnchor = { replay: false, host: false };

function emitAssistantBlock(
  a: StreamAssembler,
  block: BetaContentBlock,
  messageId: string,
  blockIndex: number,
  blockProviderMetadata?: AgProviderMeta,
  blockMeta?: AgMeta,
  phase?: string,
): BlockAnchor {
  switch (block.type) {
    case "text": {
      // Claude's assistant message is a COMPLETE structure (not a live stream), so
      // citations are already known at the point text.end fires — they ride the
      // STREAMED-text citations carrier (audit M22: text.end.citations), never as
      // a duplicate id-less supplement block.
      const id = `${messageId}:text:${blockIndex}`;
      const citations =
        block.citations != null && block.citations.length > 0 ? mapCitations(block.citations) : undefined;
      if (blockMeta !== undefined) {
        // textStart's sugar has no `_meta` field; `a.emit()` is the base primitive.
        a.emit({
          type: "text.start",
          id,
          messageId,
          ...(blockProviderMetadata !== undefined ? { providerMetadata: blockProviderMetadata } : {}),
          _meta: blockMeta,
        });
      } else {
        a.textStart(id, messageId, blockProviderMetadata !== undefined ? { providerMetadata: blockProviderMetadata } : undefined);
      }
      a.textDelta(id, messageId, block.text);
      a.textEnd(id, messageId, citations !== undefined ? { citations } : undefined);
      return { replay: true, host: blockMeta !== undefined };
    }
    case "thinking": {
      const id = `${messageId}:reasoning:${blockIndex}`;
      if (blockProviderMetadata !== undefined || blockMeta !== undefined) {
        // reasoningStart's sugar signature has no providerMetadata or `_meta`
        // parameter — `a.emit()` is the documented base primitive for exactly
        // this case (schema DOES support both on reasoning.start;
        // StreamAssembler docstring: "guarantees no AgClosedEventType is ever
        // unreachable").
        a.emit({
          type: "reasoning.start",
          id,
          messageId,
          ...(blockProviderMetadata !== undefined ? { providerMetadata: blockProviderMetadata } : {}),
          ...(blockMeta !== undefined ? { _meta: blockMeta } : {}),
          ...(phase !== undefined ? { phase } : {}),
        });
      } else {
        a.reasoningStart(id, messageId, phase !== undefined ? { phase } : undefined);
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
      return { replay: true, host: blockMeta !== undefined };
    }
    case "redacted_thinking": {
      // No visible text; the redacted blob is the replay-load-bearing opaque part.
      const id = `${messageId}:reasoning:${blockIndex}`;
      if (blockProviderMetadata !== undefined || blockMeta !== undefined) {
        a.emit({
          type: "reasoning.start",
          id,
          messageId,
          ...(blockProviderMetadata !== undefined ? { providerMetadata: blockProviderMetadata } : {}),
          ...(blockMeta !== undefined ? { _meta: blockMeta } : {}),
        });
      } else {
        a.reasoningStart(id, messageId);
      }
      a.reasoningEnd(id, messageId);
      a.reasoningOpaque(id, messageId, {
        kind: "redacted",
        value: block.data,
        provider: "anthropic",
      });
      return { replay: true, host: blockMeta !== undefined };
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
      return { replay: true, host: false };
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
      return NOTHING_ANCHORED;
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
      return NOTHING_ANCHORED;
    }
    default: {
      // image / resource / other rich content blocks ride content.block (spec §4).
      a.contentBlock(messageId, assistantContentBlockToAgBlock(block));
      return NOTHING_ANCHORED;
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
  if (t === "stream_event") {
    // workspace#7: the partial-assistant arm is now driven — the load-bearing
    // nested shape is the event object with its own discriminant.
    const ev = v.event;
    return isJsonObject(ev) && typeof ev.type === "string";
  }
  // system / status / … — structurally valid SDKMessage arms that carry no
  // AgJSON-relevant content. Accept (the normalizer no-ops on them).
  return typeof t === "string";
}

// ─── uniform lossless carry: 17 claude arms — the fixture-drift ratchet's
// original 15 `silently-dropped` arms (2026-07-03 follow-up to the
// SDKInformationalMessage flagship fix) + 2 added on the 0.3.207 bump
// (2026-07-13: background_tasks_changed, conversation_reset) ────────────────
// Per-arm field inspection (sdk.d.ts) confirmed each carries genuine
// consumer-facing content (hook stdout/stderr, slash-command output,
// OAuth-flow instructions, toast notifications, file-persistence receipts,
// tool-use-summary prose, recalled-memory body text, a no-fallback refusal's
// own diagnostic fields, suggested-prompt text, mirror-sync errors, and the
// Task* subagent-progress family) with NO existing AgJSON vocabulary home.
//
// The Task* family (task_started/task_progress/task_updated/task_notification)
// was STUDIED against the facet's ALREADY-derived subagent lifecycle
// (parent_tool_use_id -> subagentStart/Done in `drive()` below) and
// deliberately NOT folded into it: `tool_use_id` is OPTIONAL on every Task*
// arm (a `task_type:"local_workflow"` background task carries NONE at all —
// this family is a broader "tasks panel" superset, not 1:1 with Task-tool
// subagent adoption), and task_progress/task_notification's own
// `summary`/`last_tool_name` would DUPLICATE content the nested subagent's
// own tool_use/tool_result stream already conveys once correlation resolves
// — the M22 double-fold hazard. `description` enrichment onto
// subagent.start was also considered and rejected: `subagent.start`'s
// schema carries no providerMetadata slot (only agentId/agentName), and
// reaching it would require bypassing the `subagentStart()` sugar
// primitive's turn-stack bookkeeping via the raw `emit()` base primitive —
// a core/src change, outside this task's facet+manifest+SPEC-§8/§12
// boundary invariant.
//
// SDKModelRefusalNoFallbackMessage was STUDIED against the existing
// `stop_reason:"refusal"` terminal handling (mapStopReason + the
// closeTurnDone safety flag in `drive()`'s result-success branch): that
// path ALREADY produces the terminal "a refusal happened" signal, so this
// frame's OWN diagnostic fields (api_refusal_category/explanation/
// original_model/content) are enrichment with no precise existing home —
// carried, not forced onto an unrelated event.
//
// SDKPermissionDeniedMessage is the ONE arm that DOES map onto an existing
// home (the W1 `<turnId>:denials` carrier, audit M19) — see the dedicated
// branch + `deniedLiveByToolUseId` in `createClaudeNormalizer()` below; it
// is deliberately EXCLUDED from the carried sets here.
//
// SDKModelRefusalFallbackMessage is HALF-mapped: its retraction goes to
// `message.remove` (§8 item 19) and the rest of the frame has no home. It is
// NOT in the sets below either. Its dedicated branch does the retraction and
// then emits the same `ext.anthropic.frame` carry itself (X4, 2026-09-23, on
// sp-protocol's item-22 reading for half-mapped frames — see that branch).
//
// ONE uniform key — `ext.anthropic.frame{kind, frame}` (SPEC §8 item 22 /
// §12) — not 15 distinct ext keys (ext-vocabulary sprawl, the standing
// review Minor this closes). `kind` is the frame's own discriminating
// subtype/type string; `frame` is the VERBATIM native message
// (JsonValue.parse at the opaque pass-through boundary, no cast, no
// field-by-field reinterpretation — the whole frame rides losslessly).
const CARRIED_SYSTEM_SUBTYPES = new Set<string>([
  "model_refusal_no_fallback",
  "local_command_output",
  "hook_progress",
  "hook_response",
  "task_notification",
  "task_started",
  "task_updated",
  "task_progress",
  // Task* family, 5 of 5 (0.3.207 bump, 2026-07-13): the LEVEL signal to the
  // four edge bookends above — full live-background-task set, REPLACE
  // semantics, per-task free-text `description`. Same carry, same rationale.
  "background_tasks_changed",
  "notification",
  "files_persisted",
  "memory_recall",
  "mirror_error",
  // workspace#7 census-caught (2026-08-07, corpus/partials-sonnet5): the
  // system/status ping — status:'compacting'|'requesting'|null (+ optional
  // compact_result/compact_error). GENUINE consumer-facing agent-state signal
  // (exactly the ready/thinking/responding vocabulary chat surfaces render —
  // loqu-co/guuey#91's status-states half) with no AgJSON home; previously
  // router-plane'd. Carried whole-frame, which also closes the manifest's
  // disclosed `compact_error` residual gap.
  "status",
  // cohort 0.5.4 census-caught (2026-09-02, corpus/partials-fable51 — the
  // FIRST live thinking turn in the corpus): system/thinking_tokens
  // {estimated_tokens, estimated_tokens_delta} arrives once per thinking burst.
  // Under Claude Fable 5.1's default `thinking.display: omitted` the model's
  // thinking_delta text is '' — these frames are the ONLY live progress signal
  // a host gets while the model thinks (what Claude Code's own UI renders as
  // "thinking… N tokens"). Same status-ping reasoning as `status` above:
  // consumer-facing agent-state, no AgJSON home yet (a first-class
  // reasoning-progress event is a draft.3 spec candidate) → whole-frame carry.
  "thinking_tokens",
]);
const CARRIED_STANDALONE_TYPES = new Set<string>([
  "auth_status",
  "tool_use_summary",
  "prompt_suggestion",
  // 0.3.207 bump (2026-07-13): the previously-UNVERIFIABLE arm's shape is now
  // declared — {type:'conversation_reset', new_conversation_id: UUID}. A
  // session-identity ROTATION signal: no free text, but dropping it silently
  // breaks any consumer correlating by conversation id (the old router-plane
  // no-op made the rotation invisible). Carried whole-frame; a first-class
  // thread-rotation mapping is a future spec decision, not a mechanical carry.
  "conversation_reset",
]);

// The top-level `type` literals the SDKMessage union declares (0.3.280: 39
// members over these 11 types). A frame whose `type` is NOT among them is
// RUNTIME-ONLY: no d.ts diff shows it (the 0.3.272 lesson, now for a whole
// frame type). The first one observed: `command_lifecycle`
// ({command_uuid, state: "queued"|"started"|"completed"}, three per prompt,
// streaming-input mode; live on corpus/multi-result-sonnet5), the host
// prompt's queue lifecycle keyed by the caller's message uuid. Through the
// 0.7.0 stack it fell through `drive()` to the no-op, a silent drop against
// SPEC §8.0 graceful degradation. An unknown top-level type now rides the
// uniform carry, `ext.anthropic.frame{kind: <type>, frame}`, verbatim (§8 item
// 22), so the next runtime-only frame type is carried the day it ships.
const KNOWN_TOP_LEVEL_TYPES: ReadonlySet<string> = new Set([
  "assistant",
  "user",
  "result",
  "system",
  "stream_event",
  "tool_progress",
  "auth_status",
  "tool_use_summary",
  "rate_limit_event",
  "prompt_suggestion",
  "conversation_reset",
]);

// Returns the uniform-carry `kind` string for `msg` if it is one of the arms
// disposed `carried` in sdk-surface.json, else undefined (leaves router-plane
// / dedicated-branch arms — including SDKPermissionDeniedMessage — untouched).
function anthropicFrameKind(msg: SDKMessage): string | undefined {
  if (msg.type === "system") {
    return CARRIED_SYSTEM_SUBTYPES.has(msg.subtype) ? msg.subtype : undefined;
  }
  return CARRIED_STANDALONE_TYPES.has(msg.type) ? msg.type : undefined;
}

// `user_message_uuids` (0.3.259) is a string list on the wire; the frame
// arrived through `JsonValue.parse` and `isSDKMessage` validates only the
// discriminants, so the typed `string[]` is nominal — guard the shape at
// runtime (Array.isArray + every-string, the `resourceLinks` precedent) and
// carry it verbatim. A malformed list is ignored, never thrown on (Tenet 6);
// `string[]` is itself a JsonValue, so no cast is needed downstream.
// A COPY, never the frame's own array: the value is emitted unparsed
// (result-meta, message.metadata), core's StreamAssembler does not copy, and
// push() hands a JSON frame through by reference, so returning `v` would let an
// emitted event share the host's live array (cto's aliasing audit).
function readUserMessageUuids(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((s): s is string => typeof s === "string") ? [...v] : undefined;
}

// X5 (2026-09-23): the assistant-wrapper keys that ride a block's HOST-ONLY
// `_meta` rather than replay-load-bearing `providerMetadata` (SPEC §12). They
// are CLI-wrapper facts the Messages API never consumes. See the split in
// drive()'s assistant branch.
const HOST_ONLY_WRAPPER_KEYS: ReadonlySet<string> = new Set([
  "narration_block_indexes",
  "diagnostics",
  "api_error",
  "api_error_params",
  "api_error_code",
]);

// `narration_block_indexes` (0.3.272) — which of THIS frame's content blocks are
// user-facing NARRATION rather than private reasoning. Undeclared in sdk.d.ts at
// 0.3.272 (a pass-through of the Messages API field that rides the assistant
// wrapper), so it is read through the JSON boundary and shape-guarded here, never
// cast. Integer indexes into `message.content`; a non-integer or negative member
// means the producer changed shape, so the whole array is refused rather than
// half-carried. The upper bound is not checked here: an out-of-range index
// simply names no block where it is used (the draft.4 `phase` mapping).
// A copy for the same reason as readUserMessageUuids: the block-less wrapper
// path emits it in message.metadata unparsed.
function readNarrationBlockIndexes(v: unknown): number[] | undefined {
  return Array.isArray(v) &&
    v.length > 0 &&
    v.every((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0)
    ? [...v]
    : undefined;
}

// A result's `terminal_reason` when it names why the turn ended other than a
// normal completion (e.g. "tool_deferred_unavailable"); undefined otherwise. A
// live API error's own value is "api_error", which is also the generic code, so
// that close is unchanged. Typed as the SDK's TerminalReason union, but a newer
// CLI may send an undeclared value, so only a non-empty string is taken.
function closeCauseTerminalReason(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" && v !== "completed" ? v : undefined;
}

// `api_error_code` (CLI 2.1.280, @internal) — UNDECLARED in sdk.d.ts at 0.3.280
// on both frames that carry it (the API-error assistant frame and the
// `is_error: true` success result), so it is read through the JSON boundary.
// The CLI copies the server's error.details.error_code through only when it is
// an identifier (^[a-z][a-z0-9_]{0,63}$); the facet does not re-validate the
// producer's invariant, it only refuses a non-string.
function readApiErrorCode(v: unknown): string | undefined {
  return isJsonObject(v) && typeof v["api_error_code"] === "string" ? v["api_error_code"] : undefined;
}

// `startup_failure_reason` (0.3.274) — declared on SDKResultError ONLY, so on
// the result union it is reachable only through the JSON boundary.
function readStartupFailureReason(v: unknown): string | undefined {
  return isJsonObject(v) && typeof v["startup_failure_reason"] === "string"
    ? v["startup_failure_reason"]
    : undefined;
}

// `turn.error.retriable` for a result that carries `startup_failure_reason`.
// The type's own lead sentence frames the whole enum as a refusal to start:
// "Why Claude Code refused to start, so a host can offer the fix instead of a
// retry." So a PRESENT reason means NOT retriable, except for the values
// upstream itself EXPLICITLY describes as retriable. At 0.3.280 that set is
// exactly one value:
//  - `worktree_unverified`: "the session's worktree could not be verified
//    right now; retrying may succeed."
// Three more values read as if they might clear on their own, but upstream
// never says a retry helps, so each is a deliberate non-retriable — explicit
// false-by-omission (the model_not_found / account_on_hold voice in the
// assistant-error branch), never an oversight:
//  - `org_verify_failed`: "the sign-in's organization could not be verified
//    against the pin (network, or a revoked token)." A revoked token is not
//    transient, and the doc does not tell the two causes apart.
//  - `remote_settings_required_unavailable`: "managed settings the
//    organization requires could not be loaded." No retry guidance; whether
//    the load failure is transient is not stated.
//  - `session_held_by_background`: "the conversation to resume or continue is
//    running as a background session." Nothing says the hold clears, or when.
// Every other documented value (org_pin_api_key_conflict, org_pin_mismatch,
// managed_settings_invalid, gateway_signin_required, gateway_access_denied,
// proxy_invalid, temp_dir_unusable, cwd_unavailable, shell_tool_missing,
// worktree_resume_refused, cli_version_too_old, bypass_root) names a
// configuration, policy or environment fix, and an unknown future value
// inherits the enum's "offer the fix instead of a retry" framing. An ABSENT
// reason never reaches this function: the error arm keeps its old rule, so
// older producers are byte-identical.
const RETRIABLE_STARTUP_FAILURE_REASONS = new Set<string>(["worktree_unverified"]);
function startupFailureRetriable(reason: string): boolean {
  return RETRIABLE_STARTUP_FAILURE_REASONS.has(reason);
}

// `turn.error.retriable` for an API-error turn closed by its result frame:
// retriable exactly when the HTTP status is a rate limit (429) or a server-
// side failure (>= 500, which includes 529 overloaded) — the result-frame
// twin of the assistant-error branch's rate_limit / server_error / overloaded
// set. A null or absent status is not retriable: it carries no evidence that a
// re-send would behave differently. Typed `number | null` on the
// success arm, but the frame is only discriminant-validated, so it is guarded
// with typeof.
function apiErrorStatusRetriable(status: unknown): boolean {
  return typeof status === "number" && (status === 429 || status >= 500);
}

// ─── 0.3.220 result-frame enrichment: fast mode + per-model serving identity ──
// `fast_mode_disabled_reason` (on BOTH result arms — why fast mode was blocked)
// and `ModelUsage.canonicalModel`/`provider` (the pricing-lookup identity behind
// each modelUsage key — added for billing rate-table selection) have NO core
// home: turn.done/turn.error carry no providerMetadata slot, and AgUsage is a
// closed schema (a byModel entry cannot carry identity fields). Carried
// losslessly via ONE structured ext event — `ext.anthropic.result-meta` —
// emitted immediately BEFORE the turn close so the carry lands inside the turn
// it describes (the `ext.anthropic.informational` structured-carry precedent;
// carried fields camelCased like the facet's other structured carries). A
// first-class turn-close providerMetadata slot / AgUsage identity slot is a
// spec-process decision, recorded in sdk-surface.json, not forced here.
// Absent fields ⇒ undefined (never an empty bag; pre-0.3.220 wire is
// byte-identical). Nested access is runtime-guarded like the error arm's
// `errors` guard: `isSDKMessage` validates only `subtype` on a result frame,
// and a malformed frame must not throw (Tenet 6).
//
// 0.3.258 bump — three more result-frame siblings join the SAME carry (one
// carrier per concept, §0.6; nothing new on the ext vocabulary):
//  - `ModelUsage.costBasis` ('list'|'managed'|'unknown', 0.3.246): which price
//    table the most recent request for this model was priced at — the third
//    leg of the per-model pricing identity beside canonicalModel/provider,
//    same overwritten-per-request lifecycle; lands inside the same identity
//    object.
//  - `user_message_uuid` (SDKResultError gained it in 0.3.258; success had it
//    since 0.3.217): the client uuid of the user message this turn answers —
//    the join key back to the send, carried top-level as `userMessageUuid`.
//  - `queued_turn_count` (both arms, 0.3.258): user-initiated sends still
//    waiting in the command queue when this result was produced — >0 means
//    another turn follows without further input. 0 is a REAL value ("none
//    pending"), so the guard is `typeof === "number"`, not truthiness.
//  - `subagent_stats` (RUNTIME-ONLY — undeclared in sdk.d.ts through 0.3.258,
//    census-caught on every 0.3.258 capture, 2026-09-02): the CLI's per-turn
//    subagent lifecycle tally {spawned, requested{background,foreground,
//    unset}, started_in_background, max_depth, spawned_by_subagents,
//    completed, failed, killed{parent,user,system}, refused{depth_limit,
//    concurrency_limit,budget}, by_type{…}}. Read through the JsonValue
//    boundary (no typed access exists) and carried WHOLE as `subagentStats`
//    — a lineage summary consumers correlating Task* frames can reconcile
//    against; a first-class subagent summary is a spec-process question.
//
// 0.3.261 bump — one more sibling on the SAME carry:
//  - `user_message_uuids` (both arms, 0.3.259): every client uuid whose prompt
//    this turn consumed, in consumption order — the members of a prompt batch
//    the host merged into one turn PLUS any queued user message folded into
//    the running turn between tool rounds, so the result copy can be LONGER
//    than the first reply frame's copy (carry both; neither is redundant).
//    Present exactly when the singular is (older producers: fall back to
//    `userMessageUuid`). Carried verbatim as `userMessageUuids` — the doc
//    invariants ("always contains user_message_uuid", "at most 64") are the
//    producer's to keep, not the facet's to validate. CONSISTENCY carry: the
//    string-prompt capture path supplies no client uuid, so no cassette has
//    ever exercised either the singular or the plural.
//
// 0.3.272 bump — three more result-frame siblings on the SAME carry:
//  - `resume_reason` (BOTH arms, 0.3.268): the result-frame leg of the
//    turn-binding family the assistant/stream arms now carry (see
//    `carryTurnBinding`) — why this turn was the AUTOMATIC re-run of a turn a
//    worker restart interrupted (the host's CLAUDE_CODE_RESUME_REASON:
//    host_draining, checkpoint_restore, container_recreated, …; else
//    'interrupted_turn'). Its sibling `user_message_uuid` names the INTERRUPTED
//    turn's own last prompt on such a re-run, so a consumer reconciling results
//    by uuid sees the SAME uuid twice; this is the field that says the second
//    one is a re-run and not a duplicate. Normalized `resumeReason`.
//  - `result_index` (BOTH arms, 0.3.268): delivery sequence of this result
//    within the run, from 0, in the order the process writes them. A
//    DELIVERY-INTEGRITY signal, not a counter: "a result whose write fails
//    still consumes its number, so a gap in a stream-json sequence means a
//    result was LOST" — a consumer can detect a dropped result it would
//    otherwise never know about. Direct sibling of `queued_turn_count` (the
//    same "what else is coming" axis), so it lands in the same carrier as
//    `resultIndex`. 0 is a REAL value (every run's first result), so the guard
//    is `typeof === "number"`, never truthiness.
//  - `local_command` (SUCCESS arm only, 0.3.268 — NO upstream doc comment;
//    disposition from a 0.3.272 CLI-bundle read, 2026-09-15): present exactly
//    on the result of a turn that ran a slash command and NEVER entered the
//    model loop. In the bundle it is written only on the `shouldQuery === false`
//    early-return branch of the result builder, from the input processor's
//    `localCommand`, and not at all when the slash command was deferred to the
//    engine (`engineDeferredSlash`). CARRIED, because its PRESENCE is the
//    consumer signal: it is what distinguishes "this turn was a local command,
//    zero model round-trips" from "this turn produced nothing" — a
//    success result with `num_turns: 0` and no assistant frames is otherwise
//    indistinguishable from an empty turn. Its VALUE, however, is deliberately
//    coarse: the CLI passes the command name through the same sanitizer its
//    analytics use (`isMcp ? "mcp" : (isBuiltIn || isBundled || isOfficial ?
//    rawName : "custom")`) and then slugifies it (lowercase, `[^a-z]+`→`_`,
//    trimmed, ≤64 chars, empty ⇒ "custom"), so a user/project/third-party
//    command reports "custom" and any MCP command reports "mcp". Carried
//    verbatim as the producer emits it — the facet never re-derives a name it
//    was not given — under the normalized name `localCommand`. Read through the
//    `unknown` boundary because it is declared on the SUCCESS arm ONLY, so the
//    union has no such property to access.
//
// 0.3.280 bump — two more result-frame siblings on the SAME carry:
//  - `api_error_code` (SUCCESS arm, CLI 2.1.280, @internal — UNDECLARED in
//    sdk.d.ts, so no typed access exists): "the api_error_code of the API error
//    that ended the turn (see SDKAssistantMessage.api_error_code): the server's
//    error.details.error_code when it is an identifier". It rides the
//    `is_error: true` success result an API-error turn ends with, and it names
//    server gate codes `SDKAssistantMessageError` flattens to 'unknown', so a
//    host can key on a new gate without a Claude Code release. Normalized
//    `apiErrorCode`; the same value is `turn.error.code` when no assistant
//    error frame preceded this result, so the result alone builds the close
//    (see the success branch in `drive()`).
//  - `startup_failure_reason` (ERROR arm only, 0.3.274): set on the zeroed
//    error_during_execution result a stream-json run writes before exiting on
//    a known startup failure — "Why Claude Code refused to start, so a host
//    can offer the fix instead of a retry". Normalized `startupFailureReason`,
//    value verbatim; it also drives `turn.error.retriable` (see
//    `startupFailureRetriable`). Read through the JSON boundary because it is
//    declared on that one arm only.
function resultMetaPayload(msg: SDKResultMsg, closesAsError: boolean): { [k: string]: JsonValue } | undefined {
  const byModel: { [k: string]: JsonValue } = {};
  const modelUsage = isJsonObject(msg.modelUsage) ? msg.modelUsage : {};
  for (const [model, mu] of Object.entries(modelUsage)) {
    if (!isJsonObject(mu)) continue;
    const identity: { [k: string]: JsonValue } = {
      ...(typeof mu["canonicalModel"] === "string" ? { canonicalModel: mu["canonicalModel"] } : {}),
      ...(typeof mu["provider"] === "string" ? { provider: mu["provider"] } : {}),
      ...(typeof mu["costBasis"] === "string" ? { costBasis: mu["costBasis"] } : {}),
    };
    if (Object.keys(identity).length > 0) byModel[model] = identity;
  }
  // Undeclared siblings are only reachable through the JSON boundary: widen to
  // `unknown` (no cast) and let the isJsonObject guard narrow.
  const raw: unknown = msg;
  const subagentStats =
    isJsonObject(raw) && isJsonObject(raw["subagent_stats"]) ? JsonValue.parse(raw["subagent_stats"]) : undefined;
  const userMessageUuids = readUserMessageUuids(msg.user_message_uuids);
  // SUCCESS-arm-only field (0.3.268) — the union carries no such property, so
  // it is read through the same JSON boundary as `subagent_stats`, never cast.
  const localCommand =
    isJsonObject(raw) && typeof raw["local_command"] === "string" ? raw["local_command"] : undefined;
  // 0.3.280 — undeclared on both arms (`api_error_code`) / declared on the
  // ERROR arm only (`startup_failure_reason`): same JSON boundary, never cast.
  const apiErrorCode = readApiErrorCode(msg);
  const startupFailureReason = readStartupFailureReason(msg);
  // `deferred_tool_use` (SUCCESS arm, declared `SDKDeferredToolUse {id, name,
  // input}`): the tool call a host's PreToolUse `defer` decision parked, which
  // the CLI resumes later ("Deferred tool resume"). CONTENT, not telemetry:
  // the host needs it to act on the parked call. Through 0.6.4 the facet never
  // read it (a silent drop). Carried WHOLE and verbatim (the `subagent_stats`
  // precedent); whether it should instead map onto `turn.done.outcome.paused`
  // (asks) is a question routed to sp-protocol / sp-rnd. Fixture-only: no
  // capture sets a defer hook.
  const deferredToolUse =
    isJsonObject(raw) && isJsonObject(raw["deferred_tool_use"]) ? JsonValue.parse(raw["deferred_tool_use"]) : undefined;
  // `api_error_status` (SUCCESS arm, `number | null`): the HTTP status of the
  // API error that ended the turn. It already decides `retriable` on an
  // is_error close; it is now also CARRIED verbatim, beside `apiErrorCode`, as
  // the census allowlist's "carry candidate the first time an error seed
  // surfaces it" (sp-probe's api-error-auth seed: 401). Absent or null ⇒ no key.
  const apiErrorStatus =
    isJsonObject(raw) && typeof raw["api_error_status"] === "number" ? raw["api_error_status"] : undefined;
  // `stop_reason` on a result that closes as turn.error: turn.error has no
  // finishReason slot (and finishReasonRaw is turn.done-only), so the native
  // value would otherwise be dropped. Carried verbatim ONLY on an error close;
  // a success close keeps it on finishReason / finishReasonRaw (no duplicate).
  const stopReason =
    closesAsError && isJsonObject(raw) && typeof raw["stop_reason"] === "string" ? raw["stop_reason"] : undefined;
  const payload: { [k: string]: JsonValue } = {
    ...(typeof msg.fast_mode_disabled_reason === "string"
      ? { fastModeDisabledReason: msg.fast_mode_disabled_reason }
      : {}),
    ...(typeof msg.user_message_uuid === "string" ? { userMessageUuid: msg.user_message_uuid } : {}),
    ...(userMessageUuids !== undefined ? { userMessageUuids } : {}),
    ...(typeof msg.resume_reason === "string" ? { resumeReason: msg.resume_reason } : {}),
    ...(typeof msg.queued_turn_count === "number" ? { queuedTurnCount: msg.queued_turn_count } : {}),
    // 0 is the first result of EVERY run — `typeof === "number"`, not truthiness.
    ...(typeof msg.result_index === "number" ? { resultIndex: msg.result_index } : {}),
    ...(localCommand !== undefined ? { localCommand } : {}),
    ...(apiErrorCode !== undefined ? { apiErrorCode } : {}),
    ...(startupFailureReason !== undefined ? { startupFailureReason } : {}),
    ...(subagentStats !== undefined ? { subagentStats } : {}),
    ...(deferredToolUse !== undefined ? { deferredToolUse } : {}),
    ...(apiErrorStatus !== undefined ? { apiErrorStatus } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(Object.keys(byModel).length > 0 ? { modelUsage: byModel } : {}),
  };
  return Object.keys(payload).length > 0 ? payload : undefined;
}

// A result frame's turn usage, or undefined when the frame's usage trio is not
// the shape `mapTurnUsage` dereferences. Both result arms are
// discriminant-validated only, so every call goes through this guard (Tenet 6:
// a malformed frame must not throw out of push()); absent ⇒ no usage key.
// The guard covers each property `mapTurnUsage` reads unguarded: the `usage`
// object and its minimal real shape (numeric input/output token counts, so an
// empty `usage: {}` stays "no usage" as before), the `modelUsage` object and
// each of its entries (`mapModelUsage`), and `total_cost_usd`.
// `server_tool_use` is NOT required: `serverToolRequestCount` reads it totally,
// so a leaner producer that omits it keeps the rest of its usage.
function guardedTurnUsage(msg: SDKResultMsg): AgUsage | undefined {
  const raw: unknown = msg;
  if (!isJsonObject(raw)) return undefined;
  const rawUsage = raw["usage"];
  const rawModelUsage = raw["modelUsage"];
  return isJsonObject(rawUsage) &&
    typeof rawUsage["input_tokens"] === "number" &&
    typeof rawUsage["output_tokens"] === "number" &&
    isJsonObject(rawModelUsage) &&
    Object.values(rawModelUsage).every(isJsonObject) &&
    typeof raw["total_cost_usd"] === "number"
    ? mapTurnUsage(msg.usage, msg.total_cost_usd, msg.modelUsage)
    : undefined;
}

// ─── the stateful normalizer ──────────────────────────────────────────────────

/** Options for {@link createClaudeNormalizer}. */
export interface ClaudeNormalizerOptions {
  /**
   * The partition-root `threadId` stamped on every entity this normalizer
   * emits (SPEC §3: the root each unit carries so a key-value persistence
   * layer can write it knowing only its own id, its parent, and the
   * partition root). The Claude Agent SDK wire has no thread concept — only
   * `session_id` — so with this option ABSENT the adapter relabels
   * `session_id` as the threadId, a placeholder in the same spirit as the
   * openai/vercel facets' fixed labels. That placeholder is fine for
   * self-contained streams but LEAKS into any consumer that persists
   * events verbatim under its own thread identity (guuey#415: mid-stream
   * events carried the session id while the runtime's session records
   * carried the real thread id). A runtime that owns the real thread
   * identity should always pass it here — one id everywhere, stamped at
   * construction.
   */
  threadId?: string;
  /**
   * The stem of this invoke's POSITIONAL fallback turn ids,
   * `turn_<invokeId>_frame_<n>`, minted only for a top-level or nested turn
   * whose frame carries no usable message id or uuid (the normal path names a
   * turn by its SDK message id or frame uuid, unique by construction). A host
   * folds every invoke of a conversation into ONE Reducer, so a stem that
   * restarted with each invoke repeated those ids across invokes (DC-10, from
   * sp-protocol's D3 bar). Absent, each normalizer draws a random
   * `claude_<16 hex>` stem at most once, lazily (only when a fallback id is
   * first needed, so the common path draws no randomness), and holds it
   * OUTSIDE the atomic-push rebuild, so a rebuild reproduces it. Pass a fixed
   * value only where one invoke's output must be byte-reproducible (capture,
   * replay, tests), as vercel-ai's `invokeId`.
   */
  invokeId?: string;
}

/** 64 random bits as 16 hex chars: the default per-invoke fallback id stem
 *  (vercel-ai's mintInvokeNonce). */
function mintInvokeNonce(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The inner Claude-facet normalizer over a fresh {@link StreamAssembler}: each
 * `push(native)` validates `native` → `SDKMessage`, drives the engine via
 * primitive calls, and drains the buffered `AgEvent[]`; `flush()` closes any
 * dangling open message and drains. `createClaudeNormalizer` wraps it in core's
 * withAtomicPush. It must stay deterministic (no clock, no randomness): a
 * rebuild re-drives it from the journal. Its one invoke-unique input, the
 * fallback id stem, comes from the caller, which mints and holds it.
 */
function createInnerClaudeNormalizer(options: ClaudeNormalizerOptions, invokeStem: () => string): Normalizer {
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

  // INV-TURN (SPEC:743; sp-protocol ruling B, 2026-09-23): ONE turnId names
  // exactly ONE turn. A top-level turn is `turn_` + the id of the frame that
  // OPENS it: the first assistant message's id (`m.id`, from a complete frame
  // or a stream `message_start`) in the ordinary case, or the frame's own
  // `uuid` when a notice or a result opens it (a result-only turn). The id is
  //  - unique per turn, across the invokes of a resumed session too (a resume
  //    keeps `session_id` unless `forkSession` is set, so the old
  //    `turn_${session_id}` collided across invokes; message ids never repeat);
  //  - deterministic from the wire, so the same native replays to the same ids;
  //  - known at turn.start, since the opening frame carries it;
  //  - `turn_`-prefixed.
  // Open from the first frame that needs a turn; the turn's result frame
  // (either arm) closes it and clears it, so the next frame opens a new one.
  //
  // Two guards keep an id naming ONE turn even on odd wire:
  //  - a CLOSED id is never reopened: a late frame reusing a closed turn's
  //    message id opens its turn under its own frame uuid instead;
  //  - `isSDKMessage` validates only discriminants, so a missing or non-string
  //    id/uuid falls back to a positional `turn_<stem>_frame_<n>` rather than a
  //    shared `turn_undefined`. The stem is per invoke (DC-10: a bare
  //    `turn_frame_<n>` repeated across the invokes one Reducer folds), and the
  //    counter is deterministic from the wire, so an atomic-push rebuild
  //    reproduces every delivered id.
  // Nested (subagent) frames never open or name a top-level turn.
  let openTopTurnId: string | undefined;
  const closedTopTurnIds = new Set<string>();
  let framesSeen = 0;
  function mintId(candidate: unknown): string | undefined {
    return typeof candidate === "string" && candidate.length > 0 ? `turn_${candidate}` : undefined;
  }
  function topTurnId(openingId: unknown, frameUuid: unknown): string {
    if (openTopTurnId === undefined) {
      const byId = mintId(openingId);
      const byUuid = mintId(frameUuid);
      openTopTurnId =
        byId !== undefined && !closedTopTurnIds.has(byId)
          ? byId
          : byUuid !== undefined && !closedTopTurnIds.has(byUuid)
            ? byUuid
            : `turn_${invokeStem()}_frame_${framesSeen}`;
    }
    return openTopTurnId;
  }
  // The result frame closes the open turn (or, for a result-only turn, the one
  // it opens itself) and clears it. A RESULT-ONLY turn (no assistant frame,
  // notice or stream opened it: the CL-09 result-only API-error path, a
  // startup-failure result, a local-command result) is OPENED here with an
  // explicit turn.start before anything else the result emits (INV-TURN,
  // SPEC:743: every turn is opened by exactly one turn.start and closed by
  // exactly one terminal; sp-protocol, 2026-09-23). Through the B commit such a
  // turn was only closed, and reduce() minted a stub record whose threadId was
  // the turnId. An open turn already has its turn.start (openMessage).
  function closingTopTurnId(resultUuid: unknown, sessionId: string): string {
    let turnId = openTopTurnId;
    if (turnId === undefined) {
      turnId = topTurnId(resultUuid, undefined);
      a.openTurn(turnId, options.threadId ?? sessionId);
    }
    openTopTurnId = undefined;
    closedTopTurnIds.add(turnId);
    return turnId;
  }
  // A NESTED (subagent) turn is one per subagent run, keyed by the spawning
  // `parent_tool_use_id`: `turn_` + that run's first nested message id. Through
  // 0.6.4 it was `turn_${session_id}` too, which merged every subagent run of a
  // session into one nested turn (and, if a subagent's frames carry the
  // parent's session_id, collided with the top-level turn itself). It must
  // never equal the synthetic `parentTurnId` label `turn_${parent_tool_use_id}`
  // (guuey capstone finding A), and a message id never does.
  function nestedTurnId(parentToolUseId: string, firstMessageId: unknown, frameUuid: unknown): string {
    const known = subagentTurnByParentToolUseId.get(parentToolUseId);
    if (known !== undefined && !closedRuns.has(parentToolUseId)) return known;
    // A new run, or a frame arriving for a run that already CLOSED: mint a fresh
    // id (a closed nested id is never reopened, as for top-level turns).
    const byId = mintId(firstMessageId);
    const byUuid = mintId(frameUuid);
    const minted =
      byId !== undefined && !closedNestedTurnIds.has(byId)
        ? byId
        : byUuid !== undefined && !closedNestedTurnIds.has(byUuid)
          ? byUuid
          : `turn_${invokeStem()}_frame_${framesSeen}`;
    closedRuns.delete(parentToolUseId);
    subagentTurnByParentToolUseId.set(parentToolUseId, minted);
    return minted;
  }

  // ONE subagent bracket per RUN (sp-protocol ruling, 2026-09-23; INV-TURN,
  // SPEC:743; SPEC:807 "subagent.done: Close the nested turn"). Through 0.7.0's
  // B commit the bracket was per MESSAGE: a run of N nested messages emitted N
  // subagent.start/subagent.done pairs on its one id, closing it N times with
  // content after the first close. The run now opens once, at its first nested
  // frame, and closes exactly once, at whichever comes first: the spawning
  // Task's tool_result (any user frame, so a subagent's own sub-run closes
  // too), the turn's result frame, or flush. Parallel Task calls give
  // OVERLAPPING runs, and the assembler's last-turn backfill is a LIFO stack
  // that out-of-order closes skew. So the facet's turn-scoped events name their
  // owner: messages and their blocks by turnId / messageId, top-level tool.done
  // by the open turn, a retraction's message.remove by the removed message's
  // own turn. What still backfills: tool.args.* and ext.* (no turnId at all),
  // and a top-level tool.done with NO turn open (pre-existing: it lands on the
  // closed turn, as before B).
  type OpenRun = { readonly turnId: string; readonly parentTurnId: string };
  const openRuns = new Map<string, OpenRun>();
  const closedRuns = new Set<string>();
  const closedNestedTurnIds = new Set<string>();
  function openRun(parentToolUseId: string, turnId: string, parentTurnId: string): void {
    if (openRuns.has(parentToolUseId)) return;
    openRuns.set(parentToolUseId, { turnId, parentTurnId });
    a.subagentStart(turnId, parentTurnId);
  }
  function closeRun(parentToolUseId: string): void {
    const run = openRuns.get(parentToolUseId);
    if (run === undefined) return;
    openRuns.delete(parentToolUseId);
    closedRuns.add(parentToolUseId);
    closedNestedTurnIds.add(run.turnId);
    a.subagentDone(run.turnId, run.parentTurnId);
  }
  // Innermost (latest-opened) first, as INV-FLUSH orders its own closes.
  function closeAllRuns(): void {
    for (const parentToolUseId of [...openRuns.keys()].reverse()) closeRun(parentToolUseId);
  }

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

  // Fixture-drift ratchet (SDKPermissionDeniedMessage, "handled" via existing-
  // home mapping): live per-denial diagnostic recorded by the standalone
  // `permission_denied` frame (fires DURING the turn, before the terminal
  // result) — keyed by tool_use_id so the terminal `permission_denials[]`
  // aggregate (the ALREADY-handled W1 `<turnId>:denials` carrier, audit M19)
  // can enrich its tool.done with the actual rejection text + decision-reason
  // context, instead of emitting a SECOND tool.start/tool.done pair for the
  // same denial (the M22 double-fold hazard).
  type LiveDenial = {
    message: string;
    decisionReasonType?: string;
    decisionReasonCode?: string;
    decisionReason?: string;
    agentId?: string;
  };
  const deniedLiveByToolUseId = new Map<string, LiveDenial>();
  // Every toolCallId that already got its FINAL tool.done in this invoke. The
  // result's permission_denials aggregate skips these: re-emitting tool.start +
  // tool.done{denied} for a call already closed is a duplicate start and a second
  // final tool.done (INV-BLOCK; rd-14 P14 parks it; the M22 double-fold hazard).
  const closedToolCallIds = new Set<string>();
  // SDK message id → the `diagnostics` value already carried for it (see the
  // assistant branch): one carry per response, not one per frame.
  const diagnosticsCarried = new Map<string, string>();

  // The live denial's diagnostic fields, camelCased — the providerMetadata bag
  // on the enriched `<turnId>:denials` tool.done. undefined when the live
  // frame carried none of them (no empty bag).
  function liveDenialMeta(live: LiveDenial | undefined): { [k: string]: JsonValue } | undefined {
    if (
      live === undefined ||
      (live.decisionReasonType === undefined &&
        live.decisionReasonCode === undefined &&
        live.decisionReason === undefined &&
        live.agentId === undefined)
    ) {
      return undefined;
    }
    return {
      ...(live.decisionReasonType !== undefined ? { decisionReasonType: live.decisionReasonType } : {}),
      ...(live.decisionReasonCode !== undefined ? { decisionReasonCode: live.decisionReasonCode } : {}),
      ...(live.decisionReason !== undefined ? { decisionReason: live.decisionReason } : {}),
      ...(live.agentId !== undefined ? { agentId: live.agentId } : {}),
    };
  }

  // CL-09 (0.3.280 sweep): the turn.error close an API-error assistant frame
  // (`error` set) decided for its turn, STASHED until the turn's result frame
  // (the vercel facet's `stashedError` pattern). An API-error turn reaches this
  // facet as TWO frames: the synthetic assistant message carrying `error`, and
  // then the turn's result, `subtype: "success"` with `is_error: true` ("with
  // is_error true, the error text when the turn ended on an API error").
  // Closing at the assistant frame lost the turn's usage: only the result
  // carries `usage` / `total_cost_usd` / `modelUsage`, so a long agentic turn
  // failing on its Nth round dropped the cost of every earlier round from the
  // fold. So the assistant branch stashes {message, code, retriable} here, and
  // the turn is closed exactly ONCE (INV-TURN):
  //  - by its result frame, EITHER arm, as turn.error with the stashed fields
  //    plus the usage mapped from that result (`mapTurnUsage`, the success
  //    close's mapping) — never as a turn.done (reduce() keeps the LAST
  //    outcome, so the old turn.error → turn.done pair folded an API-error turn
  //    as a success), never as a second turn.error;
  //  - or, if the stream ends before any result frame, by `flush()`, with the
  //    stashed fields and no usage — never degraded to INV-FLUSH's
  //    engine-synthesized turn.abort.
  // The FIRST error frame's fields win: a later error frame on the same turn
  // leaves the stash alone. EVERY result frame consumes the entry, whichever
  // arm it is. Since the per-turn ids (INV-TURN, 2026-09-23) an entry can only
  // be its own turn's, so a stale one can no longer leak into the next turn.
  type StashedTurnError = { readonly message: string; readonly code: string; readonly retriable: boolean };
  const stashedTurnErrors = new Map<string, StashedTurnError>();

  /** Remove and return the stashed error close for `turnId`, if any (CL-09). */
  function takeStashedTurnError(turnId: string): StashedTurnError | undefined {
    const stashed = stashedTurnErrors.get(turnId);
    stashedTurnErrors.delete(turnId);
    return stashed;
  }

  // guuey#26 — ONE message id ⇒ ONE message lifecycle.
  //
  // The Claude Agent SDK splits ONE API assistant message across MULTIPLE
  // `assistant` frames whenever it has several content blocks: the thinking
  // block arrives as its own complete frame, the tool_use block as a SECOND
  // complete frame carrying the SAME `message.id`. Opening and sealing per
  // FRAME therefore re-opened an id the consumer had already sealed — and
  // INV-MSG forbids exactly that: `reduce()` refuses a sealed message as an
  // attach target, sets `needsResync`, and DISCARDS the rest of the turn (a
  // production capture parked at the turn's first tool.start, seq 8 of 65;
  // this repo's own `corpus/app-update-sonnet5` cassette parks the same way).
  //
  // So the close is DEFERRED: the frame's blocks are emitted, and the message
  // stays open until something that actually binds to the fold arrives — the
  // next message, a tool_result, a turn close, or `flush()`. A following frame
  // with the same id then simply continues the open message. Pure `ext.*`
  // carries deliberately do NOT close it: a hook/task/telemetry frame can land
  // between two frames of one message and must never split it.
  //
  // Emission order is otherwise unchanged from the per-frame shape: for every
  // stream that was already correct (one frame per id), the events and their
  // order are byte-identical.
  type PendingMessage = {
    /** The SDK's own `message.id` — the continuation key. */
    readonly sdkId: string;
    /** The id actually emitted (`sdkId`, or a derived carrier — see below). */
    readonly emittedId: string;
    readonly turnId: string;
    /** Set iff this is a NESTED (subagent) message: the run's synthetic parent label (continuation test). */
    readonly parentTurnId: string | undefined;
    /** Content-block index to resume at, so a second frame's block never collides with the first's. */
    blockIndex: number;
    /** Last frame's usage — the SDK repeats message-level usage per frame, so latest wins. */
    usage: AgUsage | undefined;
    /**
     * workspace#7 — true iff this lifecycle was opened by `stream_event`
     * partials. With partials on, the SDK emits BOTH the stream_events AND the
     * complete assistant frame(s); a streamed lifecycle already emitted every
     * block incrementally, so each complete same-id frame that joins it is
     * content-SUPPRESSED while still driving usage / uuid / error / retraction
     * bookkeeping (the reducer state after partials + suppressed-complete
     * equals the complete-only state).
     */
    streamed: boolean;
    /** workspace#7 — open streaming block state by content `index` (streamed lifecycles only). */
    readonly streamBlocks: Map<number, StreamBlockState>;
    /** workspace#7 — `ttft_ms` carried at most once per message (message.metadata). */
    ttftCarried: boolean;
    /**
     * draft.4 `phase`: how many of this lifecycle's blocks earlier COMPLETE
     * frames already covered. A frame's blocks are the next ones after these,
     * so its frame-local index `i` names stream block `framedThrough + i`.
     */
    framedThrough: number;
    /**
     * The TURN-BINDING FAMILY, carried at most once per message, whichever
     * channel delivers it first: the stream arm's message.metadata carry
     * (`carryTurnBinding`, the first non-ping stream event) or the complete
     * arm's first-block wrapper carry (the SDK stamps the turn's FIRST reply
     * frame only; with partials the stamp normally rides the stream instead).
     *
     * 0.3.258 — `user_message_uuid` opened the family.
     * 0.3.261 — the plural `user_message_uuids` (0.3.259) joined the SAME single
     * emission under the SAME flag.
     * 0.3.272 — `resume_reason` (0.3.268) joins it too. The upstream 0.3.269
     * entry changes all THREE under ONE rule ("stamped on a turn's first
     * complete assistant message as well as its first stream event when partial
     * messages are on"), so they are one family with one flag — a field written
     * outside this guard would double-emit `message.metadata` on a streamed
     * lifecycle (the stream arm carries, then the content-suppressed complete
     * frame carries again).
     */
    turnBindingCarried: boolean;
  };
  // workspace#7 — per-block accumulation between content_block_start and its
  // content_block_stop. `emitted` marks blocks that arrive complete inside the
  // start frame (server-tool results etc.) and were mapped there, so the stop
  // is clean punctuation.
  type StreamBlockState =
    | { kind: "text"; id: string; citations: AgCitation[] }
    | {
        kind: "reasoning";
        id: string;
        signature: string;
        redacted: string | undefined;
        // draft.4 `phase` (§8.0 item 27): whether any non-empty thinking text
        // streamed, and whether the complete frame listed this block in
        // `narration_block_indexes` while it was still open (CB-13).
        hasText: boolean;
        narration: boolean;
      }
    | { kind: "tool"; toolCallId: string; json: string; startInput: JsonValue }
    | { kind: "compaction"; content: string | null; encrypted: string | null }
    | { kind: "emitted" };
  let pending: PendingMessage | undefined;
  // How many lifecycles each SDK message id has already opened. A same-id frame
  // arriving after its lifecycle closed (a fold-binding frame landed between two
  // frames of one message) can NEVER re-open the sealed id, so its blocks ride a
  // derived carrier id instead — the facet's established derived-id convention
  // (cf. `<turnId>:denials`, `<toolCallId>:result`). Nothing is fabricated: the
  // blocks, their order and their content are the SDK's own.
  const lifecyclesBySdkId = new Map<string, number>();

  /** Seal the deferred message, if one is open (a run's bracket closes separately; see `openRun`). */
  function closePendingMessage(): void {
    if (pending === undefined) return;
    const p = pending;
    pending = undefined;
    // workspace#7: a stream interrupted mid-block (abort / flush / a binding
    // frame racing the stop) leaves open stream blocks — finalize each in
    // index order (the same emission its content_block_stop would have
    // produced) so no lifecycle dangles under the seal.
    if (p.streamBlocks.size > 0) {
      for (const idx of [...p.streamBlocks.keys()].sort((x, y) => x - y)) {
        finalizeStreamBlock(p, idx);
      }
    }
    a.closeMessage(p.emittedId, p.usage);
    // The subagent bracket is per RUN now (see `openRun`), so sealing a nested
    // message no longer closes its nested turn.
  }

  // ─── workspace#7: stream_event mapping helpers ──────────────────────────────

  // Unmappable stream frames — an orphan delta after a fold-binding frame
  // sealed its message, a future event/delta type, a kind-mismatched delta —
  // ride the uniform lossless carry (`kind` is the frame's own discriminant,
  // per the ext.anthropic.frame convention). Nothing is silently dropped.
  function carryStreamFrame(msg: SDKPartial): void {
    a.emitExt("anthropic", "frame", { kind: "stream_event", frame: JsonValue.parse(msg) });
  }

  // `ttft_ms` (time to first token, on the partial envelope) has no core home —
  // it rides the message.metadata merge channel, wire name verbatim (the
  // wrapper-carry precedent above), at most once per message.
  function carryTtft(msg: SDKPartial, p: PendingMessage): void {
    if (msg.ttft_ms === undefined || p.ttftCarried) return;
    p.ttftCarried = true;
    a.emit({ type: "message.metadata", messageId: p.emittedId, metadata: { ttft_ms: msg.ttft_ms } });
  }

  // The TURN-BINDING FAMILY on the partial envelope — what binds this reply
  // stream to the send it answers, before the result arrives. Same channel and
  // same once-per-message rule as `ttft_ms` above (message.metadata, wire names
  // verbatim); the flag is shared with the complete arm's wrapper carry so the
  // two channels never double-carry one message.
  //  - `user_message_uuid` (0.3.258): the client uuid of the user message this
  //    turn answers, stamped on the turn's FIRST non-ping stream event.
  //  - `user_message_uuids` (0.3.259): every client uuid of the prompt batch
  //    this turn answers, "present exactly when the singular is" — shape-guarded
  //    (`readUserMessageUuids`).
  //  - `resume_reason` (0.3.268): why this frame's turn is the AUTOMATIC re-run
  //    of a turn a worker restart interrupted — the host's
  //    CLAUDE_CODE_RESUME_REASON (host_draining, checkpoint_restore,
  //    container_recreated, …) or else 'interrupted_turn'. Not a separate
  //    concept from the uuids but the third leg of the same binding: on such a
  //    re-run `user_message_uuid` names the INTERRUPTED turn's own last prompt,
  //    and `resume_reason` is what tells the re-run's first reply apart from the
  //    interrupted attempt's. 0.3.269 stamps all three on the SAME frames under
  //    ONE rule, so they share ONE guard and ONE emission.
  // Either member alone still triggers the carry — the "exactly when" /
  // "same frames as" invariants are the producer's, not preconditions here.
  function carryTurnBinding(msg: SDKPartial, p: PendingMessage): void {
    if (p.turnBindingCarried) return;
    const uuid = typeof msg.user_message_uuid === "string" ? msg.user_message_uuid : undefined;
    const uuids = readUserMessageUuids(msg.user_message_uuids);
    const resumeReason = typeof msg.resume_reason === "string" ? msg.resume_reason : undefined;
    if (uuid === undefined && uuids === undefined && resumeReason === undefined) return;
    p.turnBindingCarried = true;
    a.emit({
      type: "message.metadata",
      messageId: p.emittedId,
      metadata: {
        ...(uuid !== undefined ? { user_message_uuid: uuid } : {}),
        ...(uuids !== undefined ? { user_message_uuids: uuids } : {}),
        ...(resumeReason !== undefined ? { resume_reason: resumeReason } : {}),
      },
    });
  }

  // Emit what the block's content_block_stop produces — text.end (with the M22
  // streamed-citations carrier), reasoning.end + the replay-load-bearing opaque
  // (same end-then-opaque order as the complete arm), the MANDATORY
  // tool.args.assembled (spec §4/§8.1), or the buffered compaction block.
  function finalizeStreamBlock(p: PendingMessage, index: number): void {
    const b = p.streamBlocks.get(index);
    if (b === undefined) return;
    p.streamBlocks.delete(index);
    const messageId = p.emittedId;
    switch (b.kind) {
      case "text":
        a.textEnd(b.id, messageId, b.citations.length > 0 ? { citations: b.citations } : undefined);
        return;
      case "reasoning":
        // draft.4 `phase` for a STREAMED narration block: known only once the
        // complete frame arrived (after the start), so it rides reasoning.end
        // (§5 phase timing), and only if the block's text is non-empty
        // (§8.0 item 27). Never a post-seal event.
        a.reasoningEnd(b.id, messageId, b.narration && b.hasText ? { phase: "interim" } : undefined);
        if (b.redacted !== undefined) {
          a.reasoningOpaque(b.id, messageId, { kind: "redacted", value: b.redacted, provider: "anthropic" });
        } else if (b.signature.length > 0) {
          a.reasoningOpaque(b.id, messageId, { kind: "signature", value: b.signature, provider: "anthropic" });
        }
        return;
      case "tool": {
        // The accumulated partial_json is authoritative; a truncated
        // (unparseable) accumulation falls back to the start block's own input —
        // the partial string itself already rode the args deltas losslessly.
        let input: JsonValue = b.startInput;
        if (b.json.length > 0) {
          try {
            input = JsonValue.parse(JSON.parse(b.json));
          } catch {
            input = b.startInput;
          }
        }
        a.toolArgsAssembled(b.toolCallId, input);
        return;
      }
      case "compaction":
        // Same shape the complete arm's compaction case produces.
        a.contentBlock(messageId, {
          type: "compaction",
          text: b.content ?? undefined,
          opaque:
            b.encrypted !== null
              ? { kind: "ciphertext", value: b.encrypted, provider: "anthropic" }
              : undefined,
          provider: "anthropic",
        });
        return;
      case "emitted":
        return;
    }
  }

  // The stream arm proper. Partials map onto the SAME lifecycles the complete
  // arm produces: message_start opens the SAME PendingMessage the complete
  // frame later joins (guuey#26 continuation test), and block ids reuse the
  // stream's own content `index` — which equals the complete arm's cross-frame
  // `blockIndex` arithmetic, so ids are identical either way.
  function driveStreamEvent(msg: SDKPartial): void {
    const ev = msg.event;

    if (ev.type === "message_start") {
      const m = ev.message;
      const turnId =
        msg.parent_tool_use_id !== null
          ? nestedTurnId(msg.parent_tool_use_id, m.id, msg.uuid)
          : topTurnId(m.id, msg.uuid);
      const parentTurnId =
        msg.parent_tool_use_id !== null ? `turn_${msg.parent_tool_use_id}` : undefined;
      // Same continuation test as the complete arm: a message_start naming the
      // message already open just joins it (and marks it streamed).
      const continued: PendingMessage | undefined =
        pending !== undefined &&
        pending.sdkId === m.id &&
        pending.turnId === turnId &&
        pending.parentTurnId === parentTurnId
          ? pending
          : undefined;
      if (continued !== undefined) {
        continued.streamed = true;
        carryTtft(msg, continued);
        carryTurnBinding(msg, continued);
        return;
      }
      closePendingMessage();
      // Open exactly as the complete arm would — same subagent seeding, same
      // lifecycle counter, same emittedId derivation — so the complete frame
      // that follows JOINS this lifecycle and is content-suppressed.
      if (parentTurnId !== undefined && msg.parent_tool_use_id !== null) {
        openRun(msg.parent_tool_use_id, turnId, parentTurnId);
      }
      const lifecycle = lifecyclesBySdkId.get(m.id) ?? 0;
      lifecyclesBySdkId.set(m.id, lifecycle + 1);
      const open: PendingMessage = {
        sdkId: m.id,
        emittedId: lifecycle === 0 ? m.id : `${m.id}:cont:${lifecycle}`,
        turnId,
        parentTurnId,
        blockIndex: 0,
        usage: mapMessageUsage(m.usage),
        streamed: true,
        streamBlocks: new Map(),
        ttftCarried: false,
        framedThrough: 0,
        turnBindingCarried: false,
      };
      pending = open;
      a.openMessage({
        id: open.emittedId,
        role: "assistant",
        turnId,
        threadId: options.threadId ?? msg.session_id,
        model: m.model,
      });
      // NOT registered in messageIdsByUuid: retractions name DELIVERED messages
      // (assistant / adopted tool-result frames) — the complete frame that joins
      // this lifecycle registers its own uuid as before.
      carryTtft(msg, open);
      carryTurnBinding(msg, open);
      return;
    }

    if (ev.type === "message_stop") {
      // The seal stays DEFERRED (guuey#26 / INV-MSG) while the lifecycle is
      // open: the complete assistant frame for this id follows and joins it,
      // and tool_results may still bind. And when the lifecycle is ALREADY
      // sealed — the live wire delivers the tool_result BEFORE the tool-round
      // message's own message_stop (observed in corpus/partials-sonnet5), so
      // the binding frame seals first on EVERY tool round — the frame is still
      // pure punctuation ({type:"message_stop"} carries no content): a no-op
      // either way, never an ext carry.
      if (pending !== undefined && pending.streamed) {
        carryTtft(msg, pending);
        carryTurnBinding(msg, pending);
      }
      return;
    }

    // Every other stream event belongs to the open STREAMED lifecycle — stream
    // frames carry no message id of their own. Without one (its message_start
    // was never observed, or a binding frame already sealed it), the frame is
    // unmappable → lossless carry.
    const p = pending;
    if (p === undefined || !p.streamed) {
      carryStreamFrame(msg);
      return;
    }
    carryTtft(msg, p);
    carryTurnBinding(msg, p);

    if (ev.type === "content_block_start") {
      const index = ev.index;
      const block: StreamContentBlock = ev.content_block;
      const messageId = p.emittedId;
      // A start re-using an open index: finalize the stale block first (graceful).
      if (p.streamBlocks.has(index)) finalizeStreamBlock(p, index);
      p.blockIndex = Math.max(p.blockIndex, index + 1);
      switch (block.type) {
        case "text": {
          const id = `${messageId}:text:${index}`;
          a.textStart(id, messageId);
          p.streamBlocks.set(index, { kind: "text", id, citations: [] });
          return;
        }
        case "thinking": {
          const id = `${messageId}:reasoning:${index}`;
          a.reasoningStart(id, messageId);
          p.streamBlocks.set(index, {
            kind: "reasoning",
            id,
            signature: block.signature,
            redacted: undefined,
            hasText: false,
            narration: false,
          });
          return;
        }
        case "redacted_thinking": {
          // Arrives complete (never delta'd); end + the redacted opaque land at stop.
          const id = `${messageId}:reasoning:${index}`;
          a.reasoningStart(id, messageId);
          p.streamBlocks.set(index, { kind: "reasoning", id, signature: "", redacted: block.data, hasText: false, narration: false });
          return;
        }
        case "tool_use":
        case "server_tool_use":
        case "mcp_tool_use": {
          // Same providerExecuted derivation as the complete arm. Args stream
          // via input_json_delta; the start's own `input` (normally `{}`) is
          // the assembled fallback for a delta-less stream.
          const providerExecuted: boolean | undefined =
            block.type === "server_tool_use"
              ? true
              : "caller" in block && block.caller !== undefined
                ? block.caller.type !== "direct"
                : undefined;
          a.toolStart({
            toolCallId: block.id,
            name: block.name,
            serverName: block.type === "mcp_tool_use" ? block.server_name : undefined,
            index,
            messageId,
            providerExecuted,
          });
          p.streamBlocks.set(index, {
            kind: "tool",
            toolCallId: block.id,
            json: "",
            startInput: JsonValue.parse(block.input),
          });
          return;
        }
        case "compaction": {
          // Buffered — content/encrypted_content accumulate via compaction_delta;
          // ONE content.block at stop, matching the complete arm's shape.
          p.streamBlocks.set(index, {
            kind: "compaction",
            content: block.content,
            encrypted: block.encrypted_content,
          });
          return;
        }
        case "mcp_tool_result": {
          // Arrives complete inside the start frame — same tool.done mapping as
          // the complete arm's mcp_tool_result case.
          const outcome: ToolOutcome = block.is_error ? "error" : "ok";
          closedToolCallIds.add(block.tool_use_id);
          a.toolDone({
            toolCallId: block.tool_use_id,
            content: mcpToolResultContentToAgBlocks(block.content),
            outcome,
            isError: block.is_error,
            messageId,
          });
          p.streamBlocks.set(index, { kind: "emitted" });
          return;
        }
        default: {
          // Rich server-tool-result / container blocks arrive complete — same
          // provider-raw pass-through as the complete arm's default case.
          a.contentBlock(messageId, {
            type: "provider-raw",
            vendor: "anthropic",
            raw: JsonValue.parse(block),
          });
          p.streamBlocks.set(index, { kind: "emitted" });
          return;
        }
      }
    }

    if (ev.type === "content_block_delta") {
      const b = p.streamBlocks.get(ev.index);
      if (b === undefined) {
        carryStreamFrame(msg);
        return;
      }
      const d = ev.delta;
      const messageId = p.emittedId;
      if (d.type === "text_delta" && b.kind === "text") {
        a.textDelta(b.id, messageId, d.text);
        return;
      }
      if (d.type === "thinking_delta" && b.kind === "reasoning") {
        if (typeof d.thinking === "string" && d.thinking.length > 0) b.hasText = true;
        // Claude Code stamps a RUNTIME-ONLY `estimated_tokens` (number | null;
        // undeclared on BetaThinkingDelta) on each thinking_delta. Under
        // Fable 5.1's default `display: omitted` the `thinking` text is '' and
        // that estimate is the delta's entire payload — carried verbatim (wire
        // name kept; null kept: "no estimate yet" is a real value). Absent key ⇒
        // no bag, byte-identical.
        //
        // X5 (sp-rnd, 2026-09-23): it rides the delta's host-only `_meta`, not
        // `providerMetadata`. The latter is REPLAY-LOAD-BEARING (SPEC §12: values
        // that must round-trip to the provider), and the Messages API never
        // consumes this CLI estimate. Consequence: `reduce()` folds `_meta` only
        // on start events, so the estimate is now LIVE-ONLY (it used to fold
        // last-value-wins onto the reasoning block) — the same standing as its
        // `system/thinking_tokens` twin, which rides `ext.anthropic.frame`. No
        // consumer read the folded value (guuey/ggui checked via sp-team-main).
        // `reasoningDelta`'s sugar has no `_meta` option; `a.emit()` is the base
        // primitive (the reasoning.start precedent in `emitAssistantBlock`), and
        // the sugar's only extra step, de-cumulation, is a pass-through for a
        // non-cumulative delta like this one.
        const rawDelta: unknown = d;
        if (isJsonObject(rawDelta) && "estimated_tokens" in rawDelta) {
          const estimate = AgMeta.parse({ estimated_tokens: rawDelta["estimated_tokens"] });
          a.emit({ type: "reasoning.delta", id: b.id, messageId, delta: d.thinking, _meta: estimate });
        } else {
          a.reasoningDelta(b.id, messageId, d.thinking);
        }
        return;
      }
      if (d.type === "input_json_delta" && b.kind === "tool") {
        a.toolArgsDelta(b.toolCallId, d.partial_json);
        b.json += d.partial_json;
        return;
      }
      if (d.type === "signature_delta" && b.kind === "reasoning") {
        // Buffered — the replay-load-bearing opaque rides reasoning.opaque at stop.
        b.signature += d.signature;
        return;
      }
      if (d.type === "citations_delta" && b.kind === "text") {
        // Buffered — the M22 streamed-citations carrier is text.end, at stop.
        b.citations.push(...mapCitations([d.citation]));
        return;
      }
      if (d.type === "compaction_delta" && b.kind === "compaction") {
        if (d.content !== null) b.content = (b.content ?? "") + d.content;
        if (d.encrypted_content !== null) b.encrypted = (b.encrypted ?? "") + d.encrypted_content;
        return;
      }
      // Unknown delta type / kind-mismatched delta — lossless carry.
      carryStreamFrame(msg);
      return;
    }

    if (ev.type === "content_block_stop") {
      if (!p.streamBlocks.has(ev.index)) {
        carryStreamFrame(msg);
        return;
      }
      finalizeStreamBlock(p, ev.index);
      return;
    }

    if (ev.type === "message_delta") {
      // Cumulative usage refresh — kept live so an aborted stream still seals
      // with real usage; the complete frame's copy overwrites every field it
      // carries on join (see the assistant branch — fields ONLY the stream
      // delivers, `thinking_tokens` in the observed wire, survive the join).
      // stop_reason/stop_details fold nowhere here: the turn close comes from
      // the result frame, exactly as in complete-only mode.
      const u = ev.usage;
      // 0.3.257 thinking-token telemetry — runtime-guarded (`BetaMessageDeltaUsage`
      // does not declare `output_tokens_details`), subset of outputTokens; see
      // `readThinkingTokens`'s doc.
      const reasoningTokens = readThinkingTokens(u);
      p.usage = {
        ...(p.usage ?? {}),
        ...(typeof u.input_tokens === "number" ? { inputTokens: u.input_tokens } : {}),
        ...(typeof u.output_tokens === "number" ? { outputTokens: u.output_tokens } : {}),
        ...(typeof u.cache_read_input_tokens === "number"
          ? { cacheReadTokens: u.cache_read_input_tokens }
          : {}),
        ...(typeof u.cache_creation_input_tokens === "number"
          ? { cacheWriteTokens: u.cache_creation_input_tokens }
          : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        cumulative: true,
      };
      return;
    }

    // A future stream event type — lossless carry.
    carryStreamFrame(msg);
  }

  // The turn each retractable message was emitted under, so a retraction's
  // `message.remove` names its OWNER explicitly (INV-OWNER) instead of taking
  // the assembler's last-turn backfill, which overlapping subagent runs can skew.
  const turnByMessageId = new Map<string, string>();
  function registerUuid(uuid: string | undefined, ids: readonly string[], turnId?: string): void {
    if (turnId !== undefined) for (const id of ids) turnByMessageId.set(id, turnId);
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
        const owner = turnByMessageId.get(id);
        a.emit({ type: "message.remove", id, ...(owner !== undefined ? { turnId: owner } : {}) });
      }
    }
  }

  // Emit a result's permission_denials as tool.start + tool.done denied pairs,
  // inside a dedicated carrier message: the assistant message is already
  // sealed, and INV-MSG (audit M19) forbids attaching to sealed messages or
  // closed turns. BOTH result arms call it, at the same point (after the seal
  // and the run closes, before result-meta and the close). Through 0.6.4 only
  // the success arm did, so an error-subtype result (SDKResultError declares
  // permission_denials too, e.g. error_max_turns after a denied tool) dropped
  // its denials.
  function emitDenialsCarrier(
    turnId: string,
    denials: ReadonlyArray<{ readonly tool_name: string; readonly tool_use_id: string }>,
    sessionId: string,
  ): void {
    // Skip every denial whose call already has its final tool.done in this
    // invoke: a harness-stamped denied tool_result (the user branch), an
    // mcp_tool_result, or an earlier carrier (a repeated id, in this list or a
    // later result's). A denial for an id not yet closed still gets its pair.
    const fresh: Array<{ readonly tool_name: string; readonly tool_use_id: string }> = [];
    for (const d of denials) {
      if (closedToolCallIds.has(d.tool_use_id)) continue;
      closedToolCallIds.add(d.tool_use_id);
      fresh.push(d);
    }
    if (fresh.length > 0) {
      const denialMsgId = `${turnId}:denials`;
      a.openMessage({ id: denialMsgId, role: "assistant", turnId, threadId: options.threadId ?? sessionId });
      for (const denial of fresh) {
        // Fixture-drift ratchet finding (SDKPermissionDeniedMessage,
        // "handled" via existing-home mapping): enrich with the live
        // standalone denial notice recorded above (keyed by tool_use_id),
        // when one preceded this aggregate — the actual rejection text
        // returned to the model, plus decision-reason/agent-id context —
        // rather than leaving a bare empty-content stub. No second
        // tool.start/tool.done pair is ever emitted for the live frame
        // itself (see the dedicated `permission_denied` branch below).
        const live = deniedLiveByToolUseId.get(denial.tool_use_id);
        const liveFields = liveDenialMeta(live);
        const liveMeta: AgProviderMeta | undefined =
          liveFields !== undefined ? AgProviderMeta.parse(liveFields) : undefined;
        a.toolStart({ toolCallId: denial.tool_use_id, name: denial.tool_name });
        a.toolDone({
          toolCallId: denial.tool_use_id,
          content: live !== undefined ? [{ type: "text", text: live.message }] : [],
          outcome: "denied",
          ...(liveMeta !== undefined ? { providerMetadata: liveMeta } : {}),
        });
      }
      a.closeMessage(denialMsgId);
    }
  }

  function drive(msg: SDKMessage): void {
    if (msg.type === "assistant") {
      const m = msg.message;
      const turnId =
        msg.parent_tool_use_id !== null
          ? nestedTurnId(msg.parent_tool_use_id, m.id, msg.uuid)
          : topTurnId(m.id, msg.uuid);
      const parentTurnId =
        msg.parent_tool_use_id !== null ? `turn_${msg.parent_tool_use_id}` : undefined;

      // guuey#26: does this frame CONTINUE the message left open by the previous
      // frame? Same SDK message id, same turn, same nesting — anything else is a
      // new message and seals the open one first (unchanged emission order).
      const continued: PendingMessage | undefined =
        pending !== undefined &&
        pending.sdkId === m.id &&
        pending.turnId === turnId &&
        pending.parentTurnId === parentTurnId
          ? pending
          : undefined;
      if (continued === undefined) closePendingMessage();

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
      //
      // 0.3.217 wrapper-level siblings join the SAME first-block carrier
      // (closing the two disclosed gaps from the 0.3.217 bump audit), wire
      // names kept verbatim:
      //  - `resumed_from_incomplete_thinking`: REPLAY-LOAD-BEARING per its own
      //    doc — this turn continued the preceding truncated assistant turn
      //    inside its trailing signed thinking block, and a history replayed
      //    through the bridge must carry the flag back; without this carry the
      //    reasoningOpaque signature alone cannot reconstruct the run's prefix.
      //  - `aborted`: the interrupt-truncation signal (stop_reason never
      //    received; content may end mid-word) — without it a truncated frame
      //    folds indistinguishably from a complete one.
      //  - `context_usage` (0.3.230): the structured twin of the /context
      //    report, riding the synthetic assistant message that delivers the
      //    markdown table. Wrapper-level sibling per its own doc (never inside
      //    `message.content`, not replayed to the model) — carried verbatim so
      //    clients can render the context-usage card without parsing markdown.
      // An aborted frame can be truncated before ANY content block existed —
      // with no block to anchor, the carry rides a `message.metadata` event
      // (the merge-into-message channel) instead; see below the block loop.
      const wrapperMetaRaw: { [k: string]: JsonValue } = {};
      if (msg.supersedes !== undefined && msg.supersedes.length > 0) {
        wrapperMetaRaw["supersedes"] = msg.supersedes;
      }
      if (msg.resumed_from_incomplete_thinking === true) {
        wrapperMetaRaw["resumed_from_incomplete_thinking"] = true;
      }
      if (msg.aborted === true) {
        wrapperMetaRaw["aborted"] = true;
      }
      if (msg.context_usage !== undefined) {
        // Structured plain-JSON shape per its own doc (evolves additively);
        // JsonValue.parse both validates that invariant and satisfies the
        // wrapper-meta channel's type without an unchecked cast.
        wrapperMetaRaw["context_usage"] = JsonValue.parse(msg.context_usage);
      }
      // `usage_report` (0.3.273): the structured twin of the /usage report,
      // riding the synthetic assistant message that delivers its text (session
      // totals, the plan's usage rows, extra-usage spend) — context_usage's
      // sibling, same wrapper-level placement per its own doc (never inside
      // `message.content`, not replayed to the model), so it gets the same carry:
      // whole and verbatim, wire name kept. Carried whole rather than field by
      // field because upstream marks SDKUsageReport "Experimental — the shape may
      // change". A per-frame fact like context_usage, so it sits OUTSIDE the
      // turn-binding guard. FIXTURE-ONLY: upstream attaches it only "from
      // claude.ai-subscriber sessions", and the capture harness authenticates
      // with ANTHROPIC_API_KEY, so no live cassette can carry it.
      if (msg.usage_report !== undefined) {
        wrapperMetaRaw["usage_report"] = JsonValue.parse(msg.usage_report);
      }
      // `narration_block_indexes` (0.3.272, first seen live on app-update-fable51):
      // the indexes of THIS frame's content blocks that are user-facing narration
      // — Anthropic's `thinking.display: "updates"` mode returns progress updates
      // between tool calls as thinking blocks, and without this list a consumer
      // cannot tell a narration block (meant to be shown) from private reasoning
      // (usually hidden). A rendering decision, so it is carried losslessly rather
      // than allowlisted. Deliberately OUTSIDE the turn-binding guard: this is a
      // per-frame content fact like `aborted`, not a member of the
      // user_message_uuid family, and it appears on the complete assistant frame
      // only (no stream-event twin), so it cannot double-carry. Wire name verbatim.
      // Undeclared at 0.3.272 — same JSON boundary as `local_command`, never a cast.
      const rawAssistant: unknown = msg;
      const narrationBlockIndexes = readNarrationBlockIndexes(
        isJsonObject(rawAssistant) ? rawAssistant["narration_block_indexes"] : undefined,
      );
      if (narrationBlockIndexes !== undefined) {
        wrapperMetaRaw["narration_block_indexes"] = narrationBlockIndexes;
      }
      // `message.diagnostics` (a Messages API response field, first seen live on
      // sp-probe's defer-tool-sonnet5-resume-unavailable, 7c6880f): per-response
      // diagnostics, there `{cache_miss_reason: {type: "tools_changed",
      // cache_missed_input_tokens: 3258}}`, i.e. why the prompt cache missed.
      // Response-only (never sent back on replay), so it rides host-only `_meta`
      // (SPEC §12, the X5 split), verbatim with its wire name. Undeclared on
      // @anthropic-ai/sdk 0.93.0's BetaMessage, so read through the JSON
      // boundary; null (its usual value) carries nothing. It is per RESPONSE,
      // and the CLI repeats the same message object on every frame of a
      // multi-frame message, so it is carried once per SDK message id (again
      // only if the value changes).
      const rawMessage: unknown = m;
      const diagnostics =
        isJsonObject(rawMessage) && isJsonObject(rawMessage["diagnostics"])
          ? JsonValue.parse(rawMessage["diagnostics"])
          : undefined;
      if (diagnostics !== undefined) {
        const diagnosticsKey = JSON.stringify(diagnostics);
        if (diagnosticsCarried.get(m.id) !== diagnosticsKey) {
          wrapperMetaRaw["diagnostics"] = diagnostics;
          diagnosticsCarried.set(m.id, diagnosticsKey);
        }
      }
      // The API-error TRIAD (CLI 2.1.280, all @internal and UNDECLARED in
      // sdk.d.ts at 0.3.280 — read through the same JSON boundary, never cast).
      // The CLI stamps them on the synthetic API-error assistant frame, the one
      // that also carries `error`, which SDKAssistantMessageError flattens to a
      // 13-value set (a new server gate reads as 'unknown'):
      //  - `api_error`: the typed kind of the error ("for consumers that key on
      //    the cause instead of the message text"), a closed CLI enum of 25
      //    values at CLI 2.1.280 (dlp_request_denied, claude_code_version_too_old,
      //    effort_requires_thinking, provider_credentials, …; "new values are
      //    added over time"). Carried as a string, not enum-gated.
      //  - `api_error_params`: `{effort?, provider?, remedy?}`, "present only
      //    for the kinds that have any" — `remedy` is the fix a host should
      //    offer (refresh_command, refresh_credentials, adc, …). Carried whole.
      //  - `api_error_code`: the server's error.details.error_code, so "a host
      //    can key on a new gate without a Claude Code release".
      // Per-frame facts of the error frame, like `aborted` / `context_usage`, so
      // they sit OUTSIDE the turn-binding guard. Wire names verbatim. The frame's
      // `is_api_error_message: true` flag is deliberately NOT carried: it
      // restates `error` being set, which already decides the turn's turn.error
      // close (stashed until the result frame — see `stashedTurnErrors`).
      if (isJsonObject(rawAssistant)) {
        const apiError = rawAssistant["api_error"];
        if (typeof apiError === "string") wrapperMetaRaw["api_error"] = apiError;
        const apiErrorParams = rawAssistant["api_error_params"];
        if (isJsonObject(apiErrorParams)) wrapperMetaRaw["api_error_params"] = JsonValue.parse(apiErrorParams);
      }
      const assistantApiErrorCode = readApiErrorCode(rawAssistant);
      if (assistantApiErrorCode !== undefined) {
        wrapperMetaRaw["api_error_code"] = assistantApiErrorCode;
      }
      // `user_message_uuid` (0.3.258) and `user_message_uuids` (0.3.259) join
      // the bag below, once `open` is known — their once-per-message flag is
      // shared with the stream arm's carry.

      // A non-null parent_tool_use_id ⇒ this assistant message belongs to a
      // NESTED turn (subagent run). subagent.start is the SOLE nested-turn opener
      // (spec §4/§5), emitted once per run by `openRun`, and seeds the turn so
      // openMessage does NOT synthesize a duplicate turn.start. guuey#26: a
      // CONTINUATION frame joins the message the previous frame opened — no
      // second message.start.
      let open: PendingMessage;
      if (continued !== undefined) {
        open = continued;
      } else {
        if (parentTurnId !== undefined && msg.parent_tool_use_id !== null) {
          openRun(msg.parent_tool_use_id, turnId, parentTurnId);
        }

        const lifecycle = lifecyclesBySdkId.get(m.id) ?? 0;
        lifecyclesBySdkId.set(m.id, lifecycle + 1);
        open = {
          sdkId: m.id,
          // Lifecycle 0 is the SDK id itself. A later lifecycle for the same id
          // means that id is already sealed downstream — this frame's blocks
          // ride a derived carrier rather than re-opening it (see
          // `lifecyclesBySdkId`).
          emittedId: lifecycle === 0 ? m.id : `${m.id}:cont:${lifecycle}`,
          turnId,
          parentTurnId,
          blockIndex: 0,
          usage: undefined,
          streamed: false,
          streamBlocks: new Map(),
          ttftCarried: false,
          framedThrough: 0,
          turnBindingCarried: false,
        };
        pending = open;
        a.openMessage({
          id: open.emittedId,
          role: "assistant",
          turnId,
          threadId: options.threadId ?? msg.session_id,
          model: m.model,
        });
      }
      const messageId = open.emittedId;
      //  - `user_message_uuid` (0.3.258): the client uuid of the user message
      //    this turn answers, stamped on the turn's FIRST reply frame only
      //    (wrapper-level sibling per its own doc — never inside
      //    `message.content`, not replayed to the model). The join key that
      //    binds a reply to its send without waiting for the result frame;
      //    carried verbatim. With partials on, the stamp normally rode the first
      //    non-ping stream event instead (`carryTurnBinding`) — the shared
      //    once-per-message flag keeps the two channels from double-carrying.
      //  - `user_message_uuids` (0.3.259): the plural companion — every client
      //    uuid whose prompt this turn consumed so far, in consumption order
      //    (a prompt batch the host merged into one turn; the singular is the
      //    LAST member). Same frame, same bag, same flag, wire name verbatim;
      //    shape-guarded through `readUserMessageUuids`, invariants not
      //    validated. Either member alone still triggers the (single) carry.
      //  - `resume_reason` (0.3.268): the third leg of the SAME turn-binding
      //    family — why this frame's turn is the AUTOMATIC re-run of a turn a
      //    worker restart interrupted (the host's CLAUDE_CODE_RESUME_REASON:
      //    host_draining, checkpoint_restore, container_recreated, …; else
      //    'interrupted_turn'). On such a re-run `user_message_uuid` names the
      //    INTERRUPTED turn's last prompt, so without this field a consumer
      //    cannot tell the re-run's first reply from the interrupted attempt's.
      //    0.3.269 stamps all THREE under ONE rule ("first complete assistant
      //    message as well as first stream event when partial messages are
      //    on"), so it MUST ride the same flag: written outside this guard it
      //    would double-emit message.metadata on every streamed lifecycle (the
      //    stream arm carries, then this suppressed complete frame carries
      //    again). Wire name verbatim.
      if (!open.turnBindingCarried) {
        const uuid = typeof msg.user_message_uuid === "string" ? msg.user_message_uuid : undefined;
        const uuids = readUserMessageUuids(msg.user_message_uuids);
        const resumeReason = typeof msg.resume_reason === "string" ? msg.resume_reason : undefined;
        if (uuid !== undefined || uuids !== undefined || resumeReason !== undefined) {
          open.turnBindingCarried = true;
          if (uuid !== undefined) wrapperMetaRaw["user_message_uuid"] = uuid;
          if (uuids !== undefined) wrapperMetaRaw["user_message_uuids"] = uuids;
          if (resumeReason !== undefined) wrapperMetaRaw["resume_reason"] = resumeReason;
        }
      }
      // X5 (sp-rnd re-cut, 2026-09-23): the bag mixes two kinds of fact. SPEC
      // §12 makes `providerMetadata` REPLAY-LOAD-BEARING (values that must
      // round-trip to the provider) and `_meta` host-only side metadata.
      // `narration_block_indexes` and the API-error triad are CLI-wrapper facts
      // the Messages API never consumes, so where the bag anchors on a BLOCK they
      // ride that block's start event `_meta` (`reduce()` folds it onto
      // `block._meta`, keeping the per-frame anchoring). The rest keeps
      // `providerMetadata`. The split is by key, so the combined bag, and the
      // `message.metadata` path below that uses it, stay byte-identical
      // (message.metadata is already `AgMeta`).
      //
      // Consumer check (sp-team-main, 2026-09-23): ggui has none of these names.
      // No guuey code reads `providerMetadata`, and its #367/#1652 scrub keys on
      // the native frame. guuey asked that the triad move as ONE unit; the
      // result frame's `apiErrorCode` stays on `ext.anthropic.result-meta`.
      const replayRaw: { [k: string]: JsonValue } = {};
      const hostRaw: { [k: string]: JsonValue } = {};
      for (const [k, v] of Object.entries(wrapperMetaRaw)) {
        if (HOST_ONLY_WRAPPER_KEYS.has(k)) hostRaw[k] = v;
        else replayRaw[k] = v;
      }
      const wrapperMeta: AgProviderMeta | undefined =
        Object.keys(replayRaw).length > 0 ? AgProviderMeta.parse(replayRaw) : undefined;
      const hostMeta: AgMeta | undefined = Object.keys(hostRaw).length > 0 ? AgMeta.parse(hostRaw) : undefined;
      let anchored: BlockAnchor = NOTHING_ANCHORED;
      // workspace#7 dedupe: a STREAMED lifecycle already emitted every block
      // incrementally (stream ids reuse the content `index`, identical to the
      // arithmetic below) — this complete frame must not re-synthesize them.
      // Everything below the block loop (wrapper carry via message.metadata,
      // usage, error close, uuid registration) still runs.
      const suppressed = open.streamed;
      // draft.4 `phase` (§8.0 item 27, a SHOULD per the founder's A.10.5
      // ruling): a `thinking` block listed in `narration_block_indexes` whose
      // text is NON-EMPTY is interim narration → `phase:"interim"` on that
      // reasoning block. A listed empty block (display "omitted") gets none.
      // The index is FRAME-local. Never inferred from position, text or turn
      // end; never decoded from the signature; the vendor list itself still
      // rides host-only `_meta` verbatim (X5).
      const narrationIndexes = new Set(narrationBlockIndexes ?? []);
      if (suppressed && narrationIndexes.size > 0) {
        // STREAMED: the complete frame precedes its blocks' content_block_stop
        // (CB-13; thinking-fable51 frames [62] signature → [63] frame → [64]
        // stop), so each listed frame-local index names stream block
        // `framedThrough + idx` (the frame covers the next blocks after those
        // earlier frames covered). It is marked only while it is still OPEN;
        // the phase then rides its reasoning.end, if its streamed text was
        // non-empty. A block that already sealed stays unmarked, never a
        // post-seal event and never a neighbouring block.
        for (const idx of narrationIndexes) {
          const frameBlock = m.content[idx];
          const streamBlock = open.streamBlocks.get(open.framedThrough + idx);
          if (frameBlock?.type === "thinking" && streamBlock?.kind === "reasoning") streamBlock.narration = true;
        }
      }
      if (!suppressed) {
        // A plain indexed loop, not `.forEach` — see `mcpToolResultContentToAgBlocks`'s
        // doc: `.forEach`'s callback parameter inference degrades to implicit `any`
        // on this content shape post-0.3.199.
        for (let i = 0; i < m.content.length; i++) {
          const block = m.content[i];
          // noUncheckedIndexedAccess: structurally unreachable for i < length,
          // but the real 0.3.207 union (unlike 0.3.199's any-collapse) makes
          // the indexed access `| undefined` — guard, never assert.
          if (block === undefined) continue;
          // The block index CONTINUES across frames of one message id, so a
          // second frame's block can never collide with a first frame's
          // (`<id>:text:0` twice would clobber in the fold). The wrapper carry
          // stays anchored to this FRAME's first block: `aborted` /
          // `resumed_from_incomplete_thinking` are per-frame facts.
          // NON-STREAMED: the marker is known before the first delta, so it
          // rides reasoning.start (§5 phase timing).
          const interim =
            narrationIndexes.has(i) && block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0
              ? "interim"
              : undefined;
          const landed = emitAssistantBlock(
            a,
            block,
            messageId,
            open.blockIndex + i,
            i === 0 ? wrapperMeta : undefined,
            i === 0 ? hostMeta : undefined,
            interim,
          );
          if (block.type === "mcp_tool_result") closedToolCallIds.add(block.tool_use_id);
          if (i === 0) anchored = landed;
        }
        open.blockIndex += m.content.length;
      }
      open.framedThrough += m.content.length;
      // Block-less frame (e.g. aborted before any content streamed) — or a
      // suppressed one, whose blocks were already sealed by the stream: no
      // first block exists to anchor the wrapper carry — ride message.metadata
      // (the whole combined bag, unchanged).
      if ((suppressed || m.content.length === 0) && (wrapperMeta !== undefined || hostMeta !== undefined)) {
        a.emit({ type: "message.metadata", messageId, metadata: wrapperMetaRaw });
      } else {
        // Whatever the first block could not anchor rides the message instead,
        // in wire order, so it still folds: the host half after a tool call (no
        // `_meta` on tool.start), and BOTH halves after a compaction, an
        // mcp_tool_result or a content.block (no providerMetadata slot).
        const unanchored: { [k: string]: JsonValue } = {};
        for (const [k, v] of Object.entries(wrapperMetaRaw)) {
          const isHost = HOST_ONLY_WRAPPER_KEYS.has(k);
          if ((isHost && !anchored.host) || (!isHost && !anchored.replay)) unanchored[k] = v;
        }
        if (Object.keys(unanchored).length > 0) {
          a.emit({ type: "message.metadata", messageId, metadata: unanchored });
        }
      }
      // The seal is DEFERRED (guuey#26) — the next frame may continue this same
      // message id. Usage is message-level and repeated per frame, so the newest
      // frame's copy is the one that rides the eventual `message.end` — field by
      // field: `mapMessageUsage` names every field it maps explicitly (absent ⇒
      // an explicit `undefined`), so each overwrites the earlier value exactly
      // as before, while a field ONLY an earlier frame delivered survives. That
      // is the 0.3.257 `thinking_tokens` case in the observed wire
      // (corpus/partials-sonnet5): the streamed `message_delta` usage carries
      // `output_tokens_details`, the CLI-assembled complete frame's usage does
      // not — without this merge the join would erase the streamed count.
      open.usage = { ...(open.usage ?? {}), ...mapMessageUsage(m.usage) };

      // If the assistant turn carries an error signal (rate_limit, billing_error, etc.),
      // the turn ends as a turn.error so consumers see the error rather than a
      // silent empty turn. CL-09: the close is STASHED, not emitted here — the
      // turn's result frame (which carries the turn's usage) emits it, or
      // `flush()` does if no result ever arrives (see `stashedTurnErrors`).
      if (msg.error !== undefined) {
        // The API error ended the model's output — nothing can continue this
        // message. Seal it now, so `message.end` still precedes the (deferred)
        // close.
        closePendingMessage();
        const errCode: NonNullable<SDKAssistantError> = msg.error;
        const retriable = assistantErrorRetriable(errCode);
        if (msg.parent_tool_use_id !== null) {
          // A NESTED error frame (sp-protocol ruling 1, 2026-09-23): the error is
          // owned by the NESTED turn (SPEC:97 a subagent is a full turn with its
          // own turnId; INV-OWNER, SPEC:753), so it never closes the parent. The
          // parent closes as an error only when its OWN result frame says so.
          // Through 0.6.4 (whenever subagent frames carried the parent's
          // session_id) a nested rate_limit closed a recovered parent as a
          // retriable error and, first-error-wins, masked a later top-level
          // billing_error. `subagent.done` carries no outcome (SPEC:648), so the
          // failure rides the NON-terminal `error` event (SPEC:609) on the nested
          // turn: live-only but truthful and correctly owned, and inside the
          // run's still-open bracket, so before its subagent.done. The folded gap
          // ("a nested turn has no failure outcome") is sp-protocol's to bar.
          a.emit({ type: "error", turnId, message: errCode, code: errCode, retriable });
        } else if (!stashedTurnErrors.has(turnId)) {
          // First error frame wins: a turn already carrying a stashed close keeps
          // it (before CL-09's stash, the first error frame closed the turn).
          stashedTurnErrors.set(turnId, { message: errCode, code: errCode, retriable });
        }
      }

      // `subagent.done` is NOT emitted here: it brackets the RUN (see `openRun`),
      // and this message's seal is deferred (guuey#26) until nothing can continue it.

      // Record this frame's own uuid → the messageId it produced, so a LATER
      // retraction naming this uuid can translate it (Finding #1). The EMITTED
      // id, so a retraction still names the message that actually exists on the
      // wire when this frame rode a derived carrier.
      registerUuid(msg.uuid, [messageId], turnId);
      return;
    }

    if (msg.type === "user") {
      // SDKUserMessageReplay (`isReplay: true`, typed only on that arm; a
      // runtime `isReplay: false` also exists, so only `=== true` counts) emits
      // NO core event and does NOT seal the open message (sp-rnd lead,
      // 2026-09-23). The CLI 2.1.280 replay builders are the host's own-prompt
      // acks (sent on stdin accept, never held), queued-prompt merges, history
      // re-sends (filtered to `!toolUseResult`, so no tool_results), and
      // local-command/bash echo+output. All of them are string or prompt content,
      // which this branch never mapped (it maps only tool_result blocks), so
      // skipping loses nothing it used to emit. What the skip fixes:
      //  - REALISTIC: an ack landing mid-stream used to run closePendingMessage()
      //    and split the streaming message (the complete frame then re-opened a
      //    `:cont:` copy). Returning first keeps it a byte-identical no-op.
      //  - DEFENSIVE (fixture-only; no 0.3.280 builder produces it): a replayed
      //    tool_result re-emitted `tool.done`. After its turn's `turn.done` that
      //    parked `reduce()` for the rest of the stream (INV-MSG, SPEC:745); in a
      //    fresh normalizer it carried no turnId and parked from event 0.
      // DISCLOSED GAP, unchanged by this fix: replayed string content that is the
      // FIRST delivery (bash `<bash-input>` echo and output, local-command
      // output) has no AgJSON event. It is a candidate for the item-22 carry
      // `ext.anthropic.frame{kind:"user"}`. The replay's `tool_use_result`
      // sibling, read here for live frames, is no longer read on replays.
      if ("isReplay" in msg && msg.isReplay === true) return;
      // guuey#26: a tool_result binds to the fold — seal the open assistant
      // message first, exactly as the per-frame close used to (spec §5 tool.done
      // adoption below depends on this ordering).
      closePendingMessage();
      // A tool_result answering a Task call ENDS that subagent run: close its
      // bracket before the result's own tool.done (per-run bracket, see
      // `openRun`). A result for any other tool closes nothing.
      if (typeof msg.message.content !== "string") {
        for (const b of msg.message.content) if (b.type === "tool_result") closeRun(b.tool_use_id);
      }
      // A LIVE user frame with no tool_result block is content the CLI added to
      // the conversation itself (the SDKUserMessage doc; the host's own prompts
      // come back only as isReplay acks, returned above). The live case: the
      // CLI's `isSynthetic: true` nudge "[Your previous response had no visible
      // output. …]" after an empty reply (sp-probe's
      // defer-tool-sonnet5-resume-unavailable, 7c6880f, the corpus's only such
      // frame). This branch maps only tool_result blocks, so it had no event at
      // all, and the census could not see the text go (its path normalizes to
      // the assistant's). It rides the item-22 bulk carry verbatim, kind "user",
      // the carry the replay gap above names. DISCLOSED: a frame MIXING
      // tool_results with other blocks still maps only its tool_results (none
      // in the corpus).
      let carriesToolResult = false;
      if (typeof msg.message.content !== "string") {
        for (const b of msg.message.content) if (b.type === "tool_result") carriesToolResult = true;
      }
      if (!carriesToolResult) {
        a.emitExt("anthropic", "frame", { kind: "user", frame: JsonValue.parse(msg) });
      }
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
        // Top-level: the OPEN top-level turn, explicitly (overlapping subagent
        // runs make the assembler's last-turn backfill unreliable); undefined
        // only with no turn open, which backfills as before.
        // Nested: the run's OPEN nested turn. A nested frame for a run that has
        // CLOSED (e.g. a background agent's tool_result after the parent's
        // result) gets a fresh run, as nested assistant frames do, so nothing
        // lands on a nested turn after its subagent.done. A run that NEVER
        // opened (the stream started mid-run) keeps Task 8c leg 3's synthetic
        // label, which parks loudly rather than fabricating a nested turn.
        // INV-TURN (SPEC:743: a normalizer MUST synthesize turn.start before any
        // content event for a turn the stream has not opened; sp-protocol,
        // 2026-09-23): a TOP-LEVEL tool_result with NO turn open (a resumed
        // invoke's first frame is the deferred call's tool_result, before
        // system/init; sp-probe's defer-resume capture) opens the turn it lands
        // in, named by this frame's uuid. The resumed invoke's assistant frames
        // then join it and its result closes it. Through c54eb7f its tool.done
        // had no turn and reduce() parked from the first event. Where that result
        // folds relative to the PREVIOUS invoke's open tool block is candidate
        // 20's bar question, not decided here.
        let opensWithToolResult = false;
        for (const b of content) if (b.type === "tool_result") opensWithToolResult = true;
        if (msg.parent_tool_use_id === null && openTopTurnId === undefined && opensWithToolResult) {
          const opened = topTurnId(msg.uuid, undefined);
          a.openTurn(opened, options.threadId ?? msg.session_id ?? opened);
        }
        let toolTurnId: string | undefined;
        if (msg.parent_tool_use_id !== null) {
          const parentToolUseId = msg.parent_tool_use_id;
          const run = openRuns.get(parentToolUseId);
          if (run !== undefined) {
            toolTurnId = run.turnId;
          } else if (closedRuns.has(parentToolUseId)) {
            toolTurnId = nestedTurnId(parentToolUseId, undefined, msg.uuid);
            openRun(parentToolUseId, toolTurnId, `turn_${parentToolUseId}`);
          } else {
            toolTurnId = subagentTurnByParentToolUseId.get(parentToolUseId) ?? `turn_${parentToolUseId}`;
          }
        } else {
          toolTurnId = openTopTurnId;
        }
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
        // 0.3.257 sibling: `resourceLinks` — the MCP result's `resource_link`
        // content blocks (files returned by reference: {uri, name, title?,
        // description?, mimeType?, size?, annotations?}; at most 50 links /
        // 64 KiB serialized), collected by the CLI from the raw result BEFORE it
        // renders the text the model reads. `tool_use_result` is typed `unknown`
        // (runtime-only shape, like structuredContent above), so the array is
        // validated at the opaque boundary by JsonValue.parse — no cast. The
        // tool.done `content` stays model-faithful (the rendered text); the links
        // ride the adopted tool.done's providerMetadata, key verbatim, under the
        // same single-result attribution rule as the sibling's other fields.
        const siblingResourceLinks =
          sibling !== undefined && Array.isArray(sibling["resourceLinks"])
            ? JsonValue.parse(sibling["resourceLinks"])
            : undefined;
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
        const nonExecutionById = readNonExecutionKinds(msg);
        for (const block of content) {
          if (block.type === "tool_result") {
            // A harness-stamped denial (see isDenialKind) records as "denied"
            // with no isError, and the native block message stays in `content`,
            // so the model-facing reason survives (§2.2 draft.4: isError and
            // errorText belong to outcome "error"). Before this, the same call
            // folded "error" here and then "denied" again from the result's
            // permission_denials (sp-probe's resume-deny leg).
            // Second key (sp-protocol, same basis): when no kind is stamped, a
            // live `permission_denied` notice already seen for this id is the
            // harness's own denial record (the CLI emits it at decision time,
            // always before this result). No kind is stamped on a frame holding
            // more than one tool_result (2.1.280's stamper returns [] unless
            // exactly one), nor by a CLI that predates the stamp. A stamped kind
            // stays the primary key, so "interrupted" with a notice is still an
            // error.
            const kind = nonExecutionById.get(block.tool_use_id);
            const denied =
              block.is_error === true &&
              (kind !== undefined ? isDenialKind(kind) : deniedLiveByToolUseId.has(block.tool_use_id));
            const outcome: ToolOutcome = denied ? "denied" : block.is_error === true ? "error" : "ok";
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
            closedToolCallIds.add(block.tool_use_id);
            // This tool.done closes the call, so the result's permission_denials
            // carrier skips it. The live `permission_denied` notice for the id
            // (the CLI emits it from its canUseTool wrapper at decision time,
            // always before this tool_result) rides here instead, the same
            // providerMetadata the carrier gave it, so D drops nothing.
            const liveFields = liveDenialMeta(deniedLiveByToolUseId.get(block.tool_use_id));
            const resultProviderFields: { [k: string]: JsonValue } = {
              ...(applySibling && siblingResourceLinks !== undefined ? { resourceLinks: siblingResourceLinks } : {}),
              ...(liveFields ?? {}),
            };
            a.toolDone({
              toolCallId: block.tool_use_id,
              content: toolContent,
              outcome,
              ...(denied ? {} : { isError: block.is_error === true }),
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
              ...(Object.keys(resultProviderFields).length > 0
                ? { providerMetadata: AgProviderMeta.parse(resultProviderFields) }
                : {}),
            });
          }
        }
        // Finding #1: record this frame's uuid → the adopted messageId(s) it
        // produced, so a later retraction naming this uuid can translate it.
        registerUuid(msg.uuid, resultMessageIds, toolTurnId);
      }
      return;
    }

    if (msg.type === "result" && msg.subtype === "success") {
      // guuey#26: the turn is closing — seal the open assistant message first
      // (message.end has always preceded the turn close).
      closePendingMessage();
      // Every subagent run still open ends with the turn (per-run bracket).
      closeAllRuns();
      const turnId = closingTopTurnId(msg.uuid, msg.session_id);
      // CL-09 (0.3.280 sweep): `subtype: "success"` does NOT mean the turn
      // succeeded. Upstream's SDKResultMessage doc: "subtype "success" carries
      // the final assistant text in result — or, with is_error true, the error
      // text when the turn ended on an API error". The CLI sets is_error from
      // the turn's last assistant frame being its synthetic API-error message
      // (rate_limit / overloaded after retries ran out, billing_error,
      // authentication_failed, …). Such a turn closes as an ERROR, never as a
      // success, and exactly once:
      //  - if that assistant frame reached this facet, it stashed the turn's
      //    error close (`stashedTurnErrors`); this frame emits it, with this
      //    frame's usage — whatever is_error says, since that frame already
      //    decided the turn's outcome;
      //  - otherwise, with is_error true, this frame is the only evidence of
      //    the error, and the close is a turn.error built from the result
      //    itself (see below).
      // Strict `=== true`: is_error is typed boolean, but the frame is only
      // discriminant-validated, and false/absent must stay on the success path
      // byte-for-byte. The stash entry is consumed either way.
      const stashedError = takeStashedTurnError(turnId);
      // Shape-guarded once for every close below (Tenet 6; see guardedTurnUsage).
      const turnUsage = guardedTurnUsage(msg);
      const apiErrorTurn = msg.is_error === true;
      const safety: AgSafety[] | undefined =
        msg.stop_reason === "refusal" ? [{ category: "refusal", blocked: true }] : undefined;
      // structured_output (when a response schema is in effect) overrides the plain
      // string result — it is the authoritative typed outcome payload (spec §4).
      const structuredOutput =
        msg.structured_output !== undefined ? JsonValue.parse(msg.structured_output) : undefined;
      // Emit permission_denials as tool.start + tool.done denied pairs, inside a
      // dedicated carrier message: the assistant message is already sealed, and
      // INV-MSG (audit M19) forbids attaching to sealed messages / closed turns.
      // CL-09: an API-error turn's denials take this same carrier, at the same
      // point — its close is deferred to this frame (below), so the turn is
      // still open here, like every other turn.
      emitDenialsCarrier(turnId, msg.permission_denials, msg.session_id);
      // 0.3.220: fast_mode_disabled_reason + per-model canonicalModel/provider
      // ride `ext.anthropic.result-meta` before the close (no core home on
      // turn.done — see resultMetaPayload's doc). CL-09: it is emitted on an
      // API-error turn too, before its close like on every other turn.
      const resultMeta = resultMetaPayload(msg, stashedError !== undefined || apiErrorTurn);
      if (resultMeta !== undefined) {
        a.emitExt("anthropic", "result-meta", resultMeta);
      }
      if (stashedError !== undefined) {
        // The assistant error frame decided this close; this frame adds the
        // turn's usage, the same mapping turn.done would have carried (SPEC §4:
        // turn.error `usage` is "accrued billing on the interrupted turn"), so
        // the fold keeps the cost of every round the turn ran before failing.
        a.closeTurnError(turnId, {
          ...stashedError,
          ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
        });
        return;
      }
      if (apiErrorTurn) {
        // No assistant error frame preceded this result (a producer that did
        // not yield it, or a normalizer that never saw it), so this result is
        // the turn's only close. code = the server's api_error_code when the
        // CLI copied one through; else the CLI's own terminal_reason when it
        // names a cause other than a normal completion; else the generic
        // "api_error".
        // message = the result text (on an API error, its text), or the code
        // when that text is empty. retriable = the HTTP status says rate limit
        // or server failure (see `apiErrorStatusRetriable`); usage = the turn's
        // accrued usage, as above.
        // The terminal_reason step (sp-protocol, facet-local, 2026-09-23): the
        // CLI also sets is_error on a result that is NOT an API error. sp-probe's
        // resume-unavailable leg (7c6880f) is a resumed invoke whose deferred
        // tool's MCP server is gone: terminal_reason "tool_deferred_unavailable",
        // result "", no status, no api_error_code. Through b7dd7ff it closed
        // turn.error{message: "", code: "api_error"}, claiming an API failure
        // that never happened. `code` is free-form (SPEC :618), so this fills
        // existing fields from the frame's own value; a live API error
        // (terminal_reason "api_error", api-error-auth) is unchanged.
        const code = readApiErrorCode(msg) ?? closeCauseTerminalReason(msg.terminal_reason) ?? "api_error";
        a.closeTurnError(turnId, {
          message: typeof msg.result === "string" && msg.result !== "" ? msg.result : code,
          code,
          retriable: apiErrorStatusRetriable(msg.api_error_status),
          ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
        });
        return;
      }
      const finishReasonRaw = stopReasonRaw(msg.stop_reason);
      a.closeTurnDone(turnId, {
        outcome: { type: "success", result: structuredOutput ?? msg.result },
        finishReason: mapStopReason(msg.stop_reason),
        ...(finishReasonRaw !== undefined ? { finishReasonRaw } : {}),
        ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
        safety,
      });
      return;
    }

    if (msg.type === "result") {
      // At this point msg.subtype can only be an error variant (success handled above).
      // guuey#26: seal the open assistant message before the turn close.
      closePendingMessage();
      closeAllRuns();
      const turnId = closingTopTurnId(msg.uuid, msg.session_id);
      // CL-09: consume any stashed assistant-error close for this turnId — this
      // frame emits it (below). Each turn has its own id now, so an entry can
      // only ever be this turn's.
      const stashedError = takeStashedTurnError(turnId);
      // Guard `errors` and `subtype` defensively: `isSDKMessage` only checks
      // `typeof v.subtype === "string"` for the result arm — it does NOT validate
      // the `errors` array. A malformed message (missing errors, wrong subtype) must
      // not throw (Tenet 6: graceful, never throws).
      const errors = Array.isArray(msg.errors) ? msg.errors : [];
      const subtype = typeof msg.subtype === "string" ? msg.subtype : "error_unknown";
      // CL-04 (0.3.274): a known startup failure says why the CLI refused to
      // start, and upstream frames it as "offer the fix instead of a retry" —
      // so a PRESENT reason decides retriable (false, except the values upstream
      // itself calls retriable; see `startupFailureRetriable`). An ABSENT reason
      // keeps the old rule, byte-identical for every older producer.
      const startupFailureReason = readStartupFailureReason(msg);
      const retriable =
        startupFailureReason !== undefined
          ? startupFailureRetriable(startupFailureReason)
          : subtype !== "error_max_turns";
      // Denials ride the SAME carrier as on the success arm, at the same point.
      // This arm is discriminant-validated only, so the array is shape-guarded
      // (a malformed entry is skipped; Tenet 6: never throw).
      const rawDenials: unknown = isJsonObject(msg) ? msg["permission_denials"] : undefined;
      const denials = Array.isArray(rawDenials)
        ? rawDenials.flatMap((d: unknown) =>
            isJsonObject(d) && typeof d["tool_name"] === "string" && typeof d["tool_use_id"] === "string"
              ? [{ tool_name: d["tool_name"], tool_use_id: d["tool_use_id"] }]
              : [],
          )
        : [];
      emitDenialsCarrier(turnId, denials, msg.session_id);
      // 0.3.220: fast_mode_disabled_reason exists on BOTH result arms — the
      // error variant gets the SAME `ext.anthropic.result-meta` carry as the
      // success arm above (turn.error carries no metadata slot at all).
      const resultMeta = resultMetaPayload(msg, true);
      if (resultMeta !== undefined) {
        a.emitExt("anthropic", "result-meta", resultMeta);
      }
      if (stashedError !== undefined) {
        // CL-09: an assistant error frame already decided this turn's close —
        // emit THAT one (the first error that ended the turn), once, never a
        // second turn.error for the same turnId (INV-TURN), with this frame's
        // usage (the success arm's mapping). This arm is only
        // discriminant-validated, so the usage trio is shape-guarded first
        // (Tenet 6: a malformed frame must not throw); absent ⇒ no usage key.
        // The guard (`guardedTurnUsage`) covers every property `mapTurnUsage`
        // dereferences — `usage: {}` or a null modelUsage entry would otherwise
        // throw here, after the stash was already consumed.
        const usage = guardedTurnUsage(msg);
        a.closeTurnError(turnId, { ...stashedError, ...(usage !== undefined ? { usage } : {}) });
        return;
      }
      a.closeTurnError(turnId, {
        message: errors.length > 0 ? errors.join("; ") : subtype,
        code: subtype,
        retriable,
      });
      return;
    }

    if (msg.type === "system" && msg.subtype === "informational") {
      // spec draft.2 (§8.0 item 21, resolving the fixture-drift ratchet's
      // FLAGSHIP finding): the first-class `notice` home this frame waited
      // for since 2026-07-03. `content`/`level`/`prevent_continuation?` are
      // genuinely conversation/UX-relevant (transcript notices, an
      // explanation for why a turn halted, e.g. a Stop hook denial) — a
      // persisted, user-facing, non-conversational row (the §3 admission
      // test), never model input. The draft.1 `ext.anthropic.informational`
      // carry is RETIRED (superseded, not layered — one carrier per concept,
      // §0.6); note `tool_use_id` was NOT carried by that route, so this
      // promotion is strictly more lossless. Wrapper siblings ride the text
      // block's providerMetadata (camelCased per the facet's carry
      // convention, mirroring the 0.3.217 first-block precedent).
      // The open turn, or (between turns) the one this notice opens; the next
      // assistant frame then joins it and its result closes it.
      const turnId = topTurnId(msg.uuid, undefined);
      const noticeMeta = AgProviderMeta.parse({
        level: msg.level,
        ...(msg.prevent_continuation !== undefined ? { preventContinuation: msg.prevent_continuation } : {}),
        ...(msg.tool_use_id !== undefined ? { toolUseId: msg.tool_use_id } : {}),
      });
      a.openMessage({ id: msg.uuid, role: "notice", turnId, threadId: options.threadId ?? msg.session_id, noticeSource: "framework" });
      a.contentBlock(msg.uuid, { type: "text", text: msg.content, providerMetadata: noticeMeta });
      a.closeMessage(msg.uuid);
      return;
    }

    if (msg.type === "system" && msg.subtype === "model_refusal_fallback") {
      // Finding #1 (critical): the end-of-turn authoritative eviction record —
      // "the complete audit record for the turn" per the field's own doc.
      // Idempotent with the earlier `supersedes`-triggered eviction above (see
      // `retractUuids`'s doc); also the ONLY retraction path when a consumer
      // never observed (or a normalizer instance never processed) the
      // superseding assistant frame's own `supersedes` field directly.
      // guuey#26: a retraction can name the still-open message — seal it first so
      // `message.end` never trails its own `message.remove`.
      closePendingMessage();
      const uuids = Array.isArray(msg.retracted_message_uuids) ? msg.retracted_message_uuids : [];
      retractUuids(uuids);
      // X4 (sp-rnd re-cut, 2026-09-23): only the retraction has a core home.
      // A notice yields 0..N `message.remove`s, so there is no single event to
      // hang the rest on. The rest of the frame is the switch itself: `trigger`, `direction`
      // ('retry'; 'revert'/'sticky' are "no longer emitted" per 0.3.280),
      // `scope` ('session'|'local', absent ⇒ 'session' on older CLIs),
      // `original_model`/`fallback_model`, `request_id`, `api_refusal_category`
      // /`_explanation`, `refused_user_message_uuid` (the edit-and-retry target)
      // and the human-readable `content`. Through 0.6.3 it was dropped. It now
      // rides the uniform carry beside its `model_refusal_no_fallback` sibling
      // (SPEC §8 item 22 / §12), the WHOLE frame verbatim, AFTER the removes
      // (the frame is itself "emitted AFTER the retraction"). Item 22 says a
      // mapped frame goes to its home "instead" of the bulk carry. sp-protocol
      // ruled on 2026-09-23 (SPEC blob bef014c) that the clause covers frames
      // whose content that home already conveys, and `message.remove` conveys
      // only the retraction. So the residual fields fall under item 22's
      // no-drop MUST, and the whole frame rides. (sp-protocol's clarifying
      // line for item 22 is queued for the review bar.) `ext.*` is live-only
      // and non-folding, so the second copy of `retracted_message_uuids`
      // cannot double-fold (the M22 hazard). This is the only producer for R&D
      // item 3's `turn.model-switch`. Synthetic-only (needs a classifier refusal).
      a.emitExt("anthropic", "frame", { kind: msg.subtype, frame: JsonValue.parse(msg) });
      return;
    }

    if (msg.type === "system" && msg.subtype === "permission_denied") {
      // Fixture-drift ratchet finding: this standalone LIVE denial notice is
      // the SAME fact the already-handled `SDKResultMessage.permission_denials[]`
      // aggregate turns into a tool.start+tool.done{denied} pair inside the
      // W1 `<turnId>:denials` carrier (audit M19, above) — do NOT emit a
      // second pair here (the M22 double-fold hazard). Record this frame's
      // richer diagnostic fields only; the aggregate handler consumes them.
      //
      // `decision_reason_code` (CLI 2.1.280, @internal — UNDECLARED in sdk.d.ts
      // at 0.3.280, so read through the JSON boundary, never cast): "A
      // closed-set code for a reason a host can act on, beside
      // decision_reason_type (whose values are unchanged)":
      // 'outside_reads_blocked' (permissions.blockReadsOutsideWorkingDirectories
      // refused the path), 'memory_paused' (/pause-memory has memory paused),
      // 'classifier_transcript_too_long' (the auto-mode classifier's transcript
      // exceeded its context window). "Absent for every other reason; new values
      // are additive" — carried as a string, not enum-gated, camelCased beside
      // its `decisionReasonType` sibling. Fixture-only: the capture harness
      // produces no denials.
      const rawDenied: unknown = msg;
      const decisionReasonCode =
        isJsonObject(rawDenied) && typeof rawDenied["decision_reason_code"] === "string"
          ? rawDenied["decision_reason_code"]
          : undefined;
      deniedLiveByToolUseId.set(msg.tool_use_id, {
        message: msg.message,
        ...(msg.decision_reason_type !== undefined ? { decisionReasonType: msg.decision_reason_type } : {}),
        ...(decisionReasonCode !== undefined ? { decisionReasonCode } : {}),
        ...(msg.decision_reason !== undefined ? { decisionReason: msg.decision_reason } : {}),
        ...(msg.agent_id !== undefined ? { agentId: msg.agent_id } : {}),
      });
      return;
    }

    if (msg.type === "stream_event") {
      // workspace#7: partial-assistant frames (includePartialMessages: true) —
      // token-granular deltas mapped onto the same lifecycles the complete arm
      // produces; see `driveStreamEvent`.
      driveStreamEvent(msg);
      return;
    }

    // Fixture-drift ratchet (2026-07-03 follow-up; +2 on the 0.3.207 bump):
    // 17 carried arms with genuine consumer-facing content and no existing
    // AgJSON home — uniform lossless carry (see `anthropicFrameKind` doc
    // comment above for the full per-arm reasoning, SPEC §8 item 22).
    const carriedKind = anthropicFrameKind(msg);
    if (carriedKind !== undefined) {
      a.emitExt("anthropic", "frame", { kind: carriedKind, frame: JsonValue.parse(msg) });
      return;
    }

    // A top-level type the union does not declare (see KNOWN_TOP_LEVEL_TYPES):
    // carried whole, never silently dropped. `msg.type` is typed as the union's
    // literals, but the frame is only discriminant-validated at runtime.
    const topLevelType: string = msg.type;
    if (!KNOWN_TOP_LEVEL_TYPES.has(topLevelType)) {
      a.emitExt("anthropic", "frame", { kind: topLevelType, frame: JsonValue.parse(msg) });
      return;
    }

    // Other SDKMessage variants (system, status, …) carry no AgJSON-relevant
    // content on this seam → no events.
  }

  return {
    push(native: JsonValue): AgEvent[] {
      framesSeen++;
      // `native` is already plain JSON: withAtomicPush (createClaudeNormalizer)
      // ran core's toJsonValueSafe on it before this push (SPEC:933; a JSON
      // frame is the same reference, anything else its JSON form).
      const frame = native;
      if (!isSDKMessage(frame)) {
        // Graceful guard (Tenet 6): route the raw payload through the lossless
        // vendor channel rather than throwing. Nest under `native` so a payload
        // that carries its own `type` key (the common malformed-SDKMessage shape
        // that lands here) does NOT clobber the `ext.anthropic.unparsed` event type
        // (emitExt spreads object payloads at the top level).
        // A copy: `frame` IS the host's object when it was already JSON, and
        // this raw channel would otherwise emit it by reference. JsonValue.parse
        // copies and, like every other carry here, drops an own "__proto__"
        // (sp-main 2026-09-24, matching sp-openai cf55e08 and the 0.6.6
        // reserved-key rule 314a183: an emitted map carries no own __proto__).
        a.emitExt("anthropic", "unparsed", { native: JsonValue.parse(frame) });
        return a.drain();
      }
      drive(frame);
      return a.drain();
    },
    flush(): AgEvent[] {
      // guuey#26: nothing can continue the deferred message now — seal it with
      // its real usage rather than leaving INV-FLUSH to synthesize a bare
      // `message.end`.
      closePendingMessage();
      // Close any subagent run still open, so INV-FLUSH never aborts a nested
      // turn the stream simply ended inside (per-run bracket).
      closeAllRuns();
      // CL-09: a turn whose assistant error frame stashed its close but whose
      // result frame never arrived still closes as that turn.error (no usage:
      // only a result carries the turn's), never as INV-FLUSH's synthesized
      // turn.abort — the outcome the frame's own close used to produce.
      for (const [turnId, stashed] of stashedTurnErrors) {
        a.closeTurnError(turnId, { ...stashed });
      }
      stashedTurnErrors.clear();
      return a.flush();
    },
  };
}

/**
 * Build the Claude-facet normalizer: the inner normalizer wrapped in core's
 * withAtomicPush (the fleet guard ruling, 2026-09-24, binding). push() never
 * throws (SPEC:933):
 *  - each native is first read as plain JSON (core toJsonValueSafe): a host
 *    may hand in the in-process object, whose members need not be JSON (an
 *    undefined member, a Date, NaN, a BigInt, a function, a cycle); a JSON
 *    frame passes by reference, anything else folds exactly as its JSON form,
 *    which is what every capture already is (the SDK itself parses the CLI's
 *    NDJSON, so no 0.3.280 SDK frame needs it);
 *  - an envelope-valid but malformed frame (a required field missing or
 *    mistyped below the isSDKMessage discriminants: 61 single-point fuzz
 *    mutants of the corpus's 25 frame shapes threw, from ~17 sites, most after
 *    the frame had emitted) no longer throws: its partial batch is discarded
 *    with its state (the inner is rebuilt and re-driven from the journal) and
 *    one core `error {message: "normalizer error", code: <constructor name>}`
 *    takes the next seq. Over every committed native it fires zero times
 *    (e2e agents/claude-agent-sdk/guard.corpus.test.ts).
 * The fallback id stem is held HERE, outside the rebuild's factory: drawn at
 * most once, and only when a fallback id is first needed, so the common path
 * never touches randomness (core's atomic-guard differential runs with it
 * poisoned) and a rebuild re-reads the same stem.
 */
export function createClaudeNormalizer(options: ClaudeNormalizerOptions = {}): Normalizer {
  let stem = options.invokeId;
  const invokeStem = (): string => (stem ??= `claude_${mintInvokeNonce()}`);
  return withAtomicPush(() => createInnerClaudeNormalizer(options, invokeStem));
}

export default createClaudeNormalizer;
export { mapStopReason };
