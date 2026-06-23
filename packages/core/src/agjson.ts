import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// AgJSON v1 — CORE profile (spec §9). EXTENDED / ADVANCED / input arms are added
// in later TDD steps. Authoritative schema: silverprotocol/SPEC.md.
// ─────────────────────────────────────────────────────────────────────────────

// Opaque JSON value (spec §0.1 "unknown" = any-JSON pass-through; NEVER `any`).
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

// Host-only namespaced side metadata (spec §0.4 `_meta`).
export const AgentMeta = z.record(z.string(), JsonValue);
export type AgentMeta = z.infer<typeof AgentMeta>;

// Source union (spec §2): MCP base64 + the Anthropic/Gemini url/file superset.
export const AgentSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("base64"), mediaType: z.string(), data: z.string() }),
  z.object({ type: z.literal("url"), url: z.string(), mediaType: z.string().optional() }),
  z.object({ type: z.literal("file"), fileId: z.string(), mediaType: z.string().optional() }),
]);
export type AgentSource = z.infer<typeof AgentSource>;

// Finish-reason superset (spec §4).
export const AgentFinishReason = z.enum([
  "stop",
  "token_limit",
  "context_window_exceeded",
  "tool_call",
  "paused",
  "pause_turn",
  "refusal",
  "safety_blocked",
  "malformed_tool_call",
  "unexpected_tool_call",
  "rejected",
  "other",
  "unknown",
]);
export type AgentFinishReason = z.infer<typeof AgentFinishReason>;

// Tool-result outcome (spec §2/§4): `denied` is its own outcome; `input_required` = MCP MRTR pause.
export const ToolOutcome = z.enum(["ok", "error", "denied", "input_required"]);
export type ToolOutcome = z.infer<typeof ToolOutcome>;

// AgentBlock — CORE subset: text | image | tool-call | tool-result (spec §9).
// `tool-result.content` is recursively `AgentBlock[]`, so the schema is `z.lazy`.
// EXTENDED/ADVANCED blocks and the `structuredContent`/`uiData`/`sideData` channels
// are added in later steps (CORE carries `content` + `outcome` only, spec §9).
export type AgentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AgentSource }
  | { type: "tool-call"; toolCallId: string; name: string; input: JsonValue }
  | { type: "tool-result"; toolCallId: string; content: AgentBlock[]; outcome?: ToolOutcome };

export const AgentBlock: z.ZodType<AgentBlock> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image"), source: AgentSource }),
    z.object({
      type: z.literal("tool-call"),
      toolCallId: z.string(),
      name: z.string(),
      input: JsonValue,
    }),
    z.object({
      type: z.literal("tool-result"),
      toolCallId: z.string(),
      content: z.array(AgentBlock),
      outcome: ToolOutcome.optional(),
    }),
  ]),
);

// Outcome (spec §4). The within-run pause `{type:"paused", asks}` is EXTENDED (HITL) — added later.
export const AgentOutcome = z.discriminatedUnion("type", [
  z.object({ type: z.literal("success"), result: JsonValue.optional() }),
  z.object({ type: z.literal("error"), message: z.string(), code: z.string().optional() }),
  z.object({ type: z.literal("rejected"), reason: z.string().optional() }),
]);
export type AgentOutcome = z.infer<typeof AgentOutcome>;

export const AgentRole = z.enum(["user", "assistant", "tool", "system"]);
export type AgentRole = z.infer<typeof AgentRole>;

// Event base (spec §4): `seq` = global monotonic ordinal; `turnId` names the owning turn;
// `messageId` (when present) names the open message the event attaches to.
// Spread FIRST in each arm so an arm's required field overrides the optional base field.
const base = {
  seq: z.number(),
  ts: z.number().optional(),
  id: z.string().optional(),
  turnId: z.string().optional(),
  messageId: z.string().optional(),
  parentId: z.string().optional(),
  _meta: AgentMeta.optional(),
};

// AgentEvent — CORE subset (spec §9). EXTENDED/ADVANCED arms appended in later steps.
export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("turn.start"), threadId: z.string(), turnId: z.string() }),
  z.object({
    ...base,
    type: z.literal("turn.done"),
    turnId: z.string(),
    outcome: AgentOutcome,
    finishReason: AgentFinishReason,
  }),
  z.object({
    ...base,
    type: z.literal("turn.error"),
    message: z.string(),
    code: z.string().optional(),
    retriable: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal("turn.abort"), reason: z.string().optional() }),
  z.object({
    ...base,
    type: z.literal("error"),
    message: z.string(),
    code: z.string().optional(),
    retriable: z.boolean().optional(),
  }), // non-terminal advisory (spec §0.3 bare-noun event)
  z.object({
    ...base,
    type: z.literal("message.start"),
    id: z.string(),
    role: AgentRole,
    turnId: z.string(),
    threadId: z.string(),
    stepId: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("message.end"), id: z.string() }),
  z.object({
    ...base,
    type: z.literal("text.start"),
    id: z.string(),
    role: z.literal("assistant").optional(),
  }),
  z.object({ ...base, type: z.literal("text.delta"), id: z.string(), delta: z.string() }),
  z.object({ ...base, type: z.literal("text.end"), id: z.string() }),
  z.object({
    ...base,
    type: z.literal("content.block"),
    block: AgentBlock,
    transient: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal("tool.start"), toolCallId: z.string(), name: z.string() }),
  z.object({
    ...base,
    type: z.literal("tool.args.delta"),
    toolCallId: z.string(),
    delta: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("tool.args.assembled"),
    toolCallId: z.string(),
    input: JsonValue,
  }),
  z.object({
    ...base,
    type: z.literal("tool.done"),
    toolCallId: z.string(),
    messageId: z.string().optional(),
    content: z.array(AgentBlock),
    outcome: ToolOutcome.optional(),
    isError: z.boolean().optional(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
