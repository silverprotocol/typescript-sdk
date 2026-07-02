import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// AgJSON v1 — CORE + EXTENDED + ADVANCED profiles (spec §9). Input arms (§3) are
// added in a later TDD step. Authoritative schema: silverprotocol/SPEC.md.
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
export const AgMeta = z.record(z.string(), JsonValue);
export type AgMeta = z.infer<typeof AgMeta>;

// Source union (spec §2): MCP base64 + the Anthropic/Gemini url/file superset.
export const AgSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("base64"), mediaType: z.string(), data: z.string() }),
  z.object({ type: z.literal("url"), url: z.string(), mediaType: z.string().optional() }),
  z.object({ type: z.literal("file"), fileId: z.string(), mediaType: z.string().optional() }),
]);
export type AgSource = z.infer<typeof AgSource>;

// Finish-reason superset (spec §4).
export const AgFinishReason = z.enum([
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
export type AgFinishReason = z.infer<typeof AgFinishReason>;

// Tool-result outcome (spec §2/§4): `denied` is its own outcome; `input_required` = MCP MRTR pause.
export const ToolOutcome = z.enum(["ok", "error", "denied", "input_required"]);
export type ToolOutcome = z.infer<typeof ToolOutcome>;

// ─── EXTENDED shared sub-types (spec §2 / §4) ────────────────────────────────

// Replay-load-bearing provider metadata (OpenAI itemId etc.). Spec §2 brands it
// nominally distinct from AgMeta; the brand is a compile-time-only phantom
// (`__brand`, never serialized — §0.4) so a provider-replay bag is never confused
// with host-only `_meta`. The provider-replay channel imposes NO key namespacing.
// Runtime validation == AgMeta; `.brand()` adds the zod-native nominal marker
// (the brand is type-level only, never on the wire).
export const AgProviderMeta = AgMeta.brand<"AgProviderMeta">();
export type AgProviderMeta = z.infer<typeof AgProviderMeta>;

// Opaque provider-bound reasoning blob (spec §2): signatures / encrypted /
// redacted reasoning, echoed back byte-identical or multi-turn reasoning breaks.
export const AgOpaqueKind = z.enum(["signature", "ciphertext", "encrypted", "redacted"]);
export type AgOpaqueKind = z.infer<typeof AgOpaqueKind>;
export const AgOpaque = z.object({
  kind: AgOpaqueKind,
  value: z.string(),
  provider: z.string().optional(),
});
export type AgOpaque = z.infer<typeof AgOpaque>;

// MCP content-block annotations (MCP-frozen verbatim — spec §0.4 / §2). Carried
// through reduce() UNCHANGED.
export const AgAnnotations = z.object({
  audience: z.array(z.enum(["user", "assistant"])).optional(),
  priority: z.number().optional(),
  lastModified: z.string().optional(),
});
export type AgAnnotations = z.infer<typeof AgAnnotations>;

// MCP embedded resource (spec §2). UI surfaces ride here (uri="ui://…").
export const AgEmbeddedResource = z.object({
  uri: z.string(),
  mimeType: z.string().optional(),
  text: z.string().optional(),
  blob: z.string().optional(),
  _meta: AgMeta.optional(),
});
export type AgEmbeddedResource = z.infer<typeof AgEmbeddedResource>;

// Citation (spec §2): typed location union; index FRAME + UNIT explicit
// (Gemini grounding = UTF-8 BYTE offsets). Shared head + a kind-discriminated tail.
const AgCitationUnit = z.enum(["char", "byte", "utf16"]);
const AgCitationBounds = z.enum(["[start,end)", "[start,end]"]);
const citationHead = {
  citedText: z.string(),
  source: z.string().optional(),
  title: z.string().optional(),
  confidence: z.union([z.number(), z.array(z.number())]).optional(),
  confidenceScores: z.array(z.number()).optional(),
  encryptedIndex: z.string().optional(),
  indexFrame: z.enum(["source", "response"]).optional(),
};
export const AgCitation = z.discriminatedUnion("kind", [
  z.object({
    ...citationHead,
    kind: z.literal("char"),
    documentIndex: z.number(),
    startCharIndex: z.number(),
    endCharIndex: z.number(),
    unit: AgCitationUnit.optional(),
    bounds: AgCitationBounds.optional(),
  }),
  z.object({
    ...citationHead,
    kind: z.literal("page"),
    documentIndex: z.number(),
    startPage: z.number(),
    endPage: z.number(),
  }),
  z.object({
    ...citationHead,
    kind: z.literal("block"),
    documentIndex: z.number(),
    startBlockIndex: z.number(),
    endBlockIndex: z.number(),
  }),
  z.object({
    ...citationHead,
    kind: z.literal("url"),
    url: z.string(),
    startIndex: z.number().optional(),
    endIndex: z.number().optional(),
    unit: AgCitationUnit.optional(),
    bounds: AgCitationBounds.optional(),
  }),
  z.object({
    ...citationHead,
    kind: z.literal("offset"),
    startIndex: z.number(),
    endIndex: z.number(),
    sourceIds: z.array(z.string()),
    partIndex: z.number().optional(),
    unit: AgCitationUnit,
    bounds: AgCitationBounds,
  }),
]);
export type AgCitation = z.infer<typeof AgCitation>;

// Usage (spec §4). `cumulative:true` ⇒ must de-cumulate (Anthropic).
// Hand-written interface (required for self-recursive `byModel`; mirrors JsonValue / AgBlock pattern).
export interface AgUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  toolUseInputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  cumulative?: boolean;
  byModel?: Record<string, AgUsage>;  // per-model breakdown (self-recursive; A2-additive)
  serverToolRequests?: number;        // server-executed MCP tool-request count (A2-additive)
}
export const AgUsage: z.ZodType<AgUsage> = z.lazy(() =>
  z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    toolUseInputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    costUsd: z.number().optional(),
    cumulative: z.boolean().optional(),
    byModel: z.record(z.string(), AgUsage).optional(),
    serverToolRequests: z.number().optional(),
  }),
);

// Safety signal (spec §4).
export const AgSafety = z.object({
  category: z.string(),
  score: z.number().optional(),
  probability: z.string().optional(),
  blocked: z.boolean().optional(),
});
export type AgSafety = z.infer<typeof AgSafety>;

// HITL choice / auth-config (spec §4 / §7). `AgChoice.value` is opaque.
export const AgChoice = z.object({
  id: z.string(),
  label: z.string(),
  value: JsonValue.optional(),
});
export type AgChoice = z.infer<typeof AgChoice>;

export const AgAuthConfig = z.object({
  scheme: z.string(),
  scopes: z.array(z.string()).optional(),
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  clientId: z.string().optional(),
  audience: z.string().optional(),
});
export type AgAuthConfig = z.infer<typeof AgAuthConfig>;

// HITL ask kind enum (spec §4 / §7) — shared by hitl.ask and AgPausedAsk.
export const AgAskKind = z.enum(["approval", "form", "text", "choice", "auth", "url"]);
export type AgAskKind = z.infer<typeof AgAskKind>;

// A single paused ask entry (spec §4): shared between hitl.ask and
// AgOutcome.paused.asks[]. `schema` / `metadata.value` are opaque pass-through
// (LangGraph interrupt(value: Any) rides metadata, §7).
export const AgPausedAsk = z.object({
  askId: z.string(),
  kind: AgAskKind,
  message: z.string().optional(),
  toolCallId: z.string().optional(),
  schema: JsonValue.optional(),
  choices: z.array(AgChoice).optional(),
  authConfig: AgAuthConfig.optional(),
  url: z.string().optional(),
  reason: z.string().optional(),
  metadata: AgMeta.optional(),
  requestState: z.string().optional(),
  inputKey: z.string().optional(),
  resumeBinding: z.enum(["id", "positional"]).optional(),
  ordinal: z.number().optional(),
  token: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type AgPausedAsk = z.infer<typeof AgPausedAsk>;

// HITL answer resume payload (spec §7), carried in AgInput.kind:"resume"
// answers[]. There is NO `hitl.answer` wire type — the answer flows INPUT-side.
export const AgHitlAnswer = z.object({
  askId: z.string(),
  status: z.enum(["resolved", "declined", "cancelled"]),
  reply: JsonValue.optional(),
  reason: z.string().optional(),
  ordinal: z.number().optional(),
  token: z.string().optional(),
  requestState: z.string().optional(),
});
export type AgHitlAnswer = z.infer<typeof AgHitlAnswer>;

// MCP MRTR pending-input carrier (spec §2 / §7): rides `tool-result.pendingInput`
// (and `tool.done.pendingInput`) when `outcome==="input_required"`. `inputKeys`
// (plural) = the set of STILL-PENDING request keys (distinct from the singular
// `inputKey` an ask resolves — spec §7).
export const AgPendingInput = z.object({
  requestState: z.string().optional(),
  inputKeys: z.array(z.string()).optional(),
});
export type AgPendingInput = z.infer<typeof AgPendingInput>;

// AgBlock — the full object-form union (spec §2). The SAME union appears in
// both directions (input messages, output content, tool-result.content), so the
// `tool-result.content` arm is recursively `AgBlock[]` and the schema is `z.lazy`.
// CORE = text | image | tool-call | tool-result (spec §9); EXTENDED adds reasoning,
// compaction, search-result, code, code-result, document, file, audio, data,
// provider-raw, resource, resource-link, plus citations on `text`.
// Every EXTENDED arm carries the optional `annotations` / `_meta` side channels
// (and `providerMetadata` where the spec puts it).
type BlockMeta = {
  providerMetadata?: AgProviderMeta;
  annotations?: AgAnnotations;
  _meta?: AgMeta;
};
export type AgBlock =
  | ({ type: "text"; text: string; citations?: AgCitation[] } & BlockMeta)
  | ({ type: "image"; source: AgSource } & BlockMeta)
  | ({ type: "audio"; source: AgSource } & BlockMeta)
  | ({ type: "file"; source: AgSource; filename?: string } & BlockMeta)
  | ({ type: "document"; source: AgSource; title?: string } & BlockMeta)
  | { type: "resource"; resource: AgEmbeddedResource; annotations?: AgAnnotations; _meta?: AgMeta }
  | { type: "resource-link"; uri: string; mimeType?: string; annotations?: AgAnnotations; _meta?: AgMeta }
  | { type: "code"; language: string; code: string; annotations?: AgAnnotations; _meta?: AgMeta }
  | {
      type: "code-result";
      outcome: "ok" | "failed" | "deadline_exceeded";
      output: string;
      annotations?: AgAnnotations;
      _meta?: AgMeta;
    }
  // ONE reasoning block (visible text + optional opaque provider-bound part).
  // opaque/providerMetadata/itemId are REPLAY-LOAD-BEARING (round-trip byte-identical).
  | ({
      type: "reasoning";
      text?: string;
      opaque?: AgOpaque;
      provider?: string;
      providerDetails?: JsonValue;
      itemId?: string;
    } & BlockMeta)
  // A provider-bound conversation summary (Pydantic CompactionPart); mirrors reasoning.
  | { type: "compaction"; text?: string; opaque?: AgOpaque; provider?: string; annotations?: AgAnnotations; _meta?: AgMeta }
  // A grounding/search result carrying an opaque per-result replay blob.
  | {
      type: "search-result";
      url?: string;
      title?: string;
      opaque?: AgOpaque;
      pageAge?: string;
      annotations?: AgAnnotations;
      _meta?: AgMeta;
    }
  | ({
      type: "tool-call";
      toolCallId: string;
      name: string;
      input: JsonValue;
      serverName?: string;
      providerExecuted?: boolean;
      signature?: string; // Gemini thoughtSignature on the tool-call — echo or 400 (replay-load-bearing)
      provider?: string;
      title?: string; // provider/model-supplied tool title (Vercel)
      toolMetadata?: AgMeta; // per-tool metadata bag (Vercel)
      itemId?: string; // OpenAI Responses fc_ item id; DISTINCT from toolCallId (replay-load-bearing)
      providerCallIndex?: number; // Gemini null-id parallel-call positional index (replay-load-bearing, §8)
      uiVisibility?: ("model" | "app")[]; // MCP Apps access-control scope (from tool's _meta.ui.visibility)
    } & BlockMeta)
  | {
      type: "tool-result";
      toolCallId: string;
      content: AgBlock[];
      outcome?: ToolOutcome;
      // ── ADVANCED tool-result channels (spec §2 / §2.1 / §9) — additive over CORE ──
      structuredContent?: JsonValue; // MODEL-facing structured result (base MCP outputSchema; §2.1)
      uiData?: JsonValue; // surface/view, MODEL-HIDDEN (MCP Apps structuredContent / OpenAI Apps component data; §2.1)
      sideData?: JsonValue; // app-only side data (LangChain ToolMessage.artifact; §2.1)
      errorText?: string; // free-form error message (Vercel tool-output-error); present iff outcome==="error"
      errorCode?: string; // structured server-tool error code (Anthropic web_search_tool_result_error.error_code)
      toolMetadata?: AgMeta; // per-tool metadata bag (Vercel)
      dynamic?: boolean; // Vercel dynamic-vs-static tool distinction
      pendingInput?: AgPendingInput; // MCP MRTR carrier when outcome==="input_required"
      isError?: boolean; // MCP-frozen field, kept verbatim (derived: outcome==="error")
      providerMetadata?: AgProviderMeta;
      annotations?: AgAnnotations;
      _meta?: AgMeta;
    }
  | { type: "data"; name: string; id?: string; data: JsonValue; transient?: boolean; annotations?: AgAnnotations; _meta?: AgMeta }
  | { type: "provider-raw"; vendor: string; raw: JsonValue; annotations?: AgAnnotations; _meta?: AgMeta };

// Per-block optional side-channel fields, spread into each arm (spec §2).
const blockMeta = {
  providerMetadata: AgProviderMeta.optional(),
  annotations: AgAnnotations.optional(),
  _meta: AgMeta.optional(),
};
// `resource` / `resource-link` / non-provider-bound blocks carry annotations + _meta
// only (no providerMetadata per spec §2).
const blockAnno = {
  annotations: AgAnnotations.optional(),
  _meta: AgMeta.optional(),
};

export const AgBlock: z.ZodType<AgBlock> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      ...blockMeta,
      type: z.literal("text"),
      text: z.string(),
      citations: z.array(AgCitation).optional(),
    }),
    z.object({ ...blockMeta, type: z.literal("image"), source: AgSource }),
    z.object({ ...blockMeta, type: z.literal("audio"), source: AgSource }),
    z.object({ ...blockMeta, type: z.literal("file"), source: AgSource, filename: z.string().optional() }),
    z.object({ ...blockMeta, type: z.literal("document"), source: AgSource, title: z.string().optional() }),
    z.object({ ...blockAnno, type: z.literal("resource"), resource: AgEmbeddedResource }),
    z.object({ ...blockAnno, type: z.literal("resource-link"), uri: z.string(), mimeType: z.string().optional() }),
    z.object({ ...blockAnno, type: z.literal("code"), language: z.string(), code: z.string() }),
    z.object({
      ...blockAnno,
      type: z.literal("code-result"),
      outcome: z.enum(["ok", "failed", "deadline_exceeded"]),
      output: z.string(),
    }),
    z.object({
      ...blockMeta,
      type: z.literal("reasoning"),
      text: z.string().optional(),
      opaque: AgOpaque.optional(),
      provider: z.string().optional(),
      providerDetails: JsonValue.optional(),
      itemId: z.string().optional(),
    }),
    z.object({
      ...blockAnno,
      type: z.literal("compaction"),
      text: z.string().optional(),
      opaque: AgOpaque.optional(),
      provider: z.string().optional(),
    }),
    z.object({
      ...blockAnno,
      type: z.literal("search-result"),
      url: z.string().optional(),
      title: z.string().optional(),
      opaque: AgOpaque.optional(),
      pageAge: z.string().optional(),
    }),
    z.object({
      ...blockMeta,
      type: z.literal("tool-call"),
      toolCallId: z.string(),
      name: z.string(),
      input: JsonValue,
      serverName: z.string().optional(),
      providerExecuted: z.boolean().optional(),
      signature: z.string().optional(),
      provider: z.string().optional(),
      title: z.string().optional(),
      toolMetadata: AgMeta.optional(),
      itemId: z.string().optional(),
      providerCallIndex: z.number().optional(),
      uiVisibility: z.array(z.enum(["model", "app"])).optional(),
    }),
    z.object({
      type: z.literal("tool-result"),
      toolCallId: z.string(),
      content: z.array(AgBlock),
      outcome: ToolOutcome.optional(),
      // ── ADVANCED tool-result channels (spec §2 / §2.1 / §9) — additive over CORE ──
      structuredContent: JsonValue.optional(),
      uiData: JsonValue.optional(),
      sideData: JsonValue.optional(),
      errorText: z.string().optional(),
      errorCode: z.string().optional(),
      toolMetadata: AgMeta.optional(),
      dynamic: z.boolean().optional(),
      pendingInput: AgPendingInput.optional(),
      isError: z.boolean().optional(),
      providerMetadata: AgProviderMeta.optional(),
      annotations: AgAnnotations.optional(),
      _meta: AgMeta.optional(),
    }),
    z.object({
      ...blockAnno,
      type: z.literal("data"),
      name: z.string(),
      id: z.string().optional(),
      data: JsonValue,
      transient: z.boolean().optional(),
    }),
    z.object({ ...blockAnno, type: z.literal("provider-raw"), vendor: z.string(), raw: JsonValue }),
  ]),
);

// Outcome (spec §4). The within-run pause `{type:"paused", asks}` is the EXTENDED
// (HITL) arm: the turn parks on one or more asks; `result` MAY accompany a pause
// (a partial value emitted before parking).
export const AgOutcome = z.discriminatedUnion("type", [
  z.object({ type: z.literal("success"), result: JsonValue.optional() }),
  z.object({ type: z.literal("error"), message: z.string(), code: z.string().optional() }),
  z.object({ type: z.literal("rejected"), reason: z.string().optional() }),
  z.object({ type: z.literal("paused"), asks: z.array(AgPausedAsk), result: JsonValue.optional() }),
]);
export type AgOutcome = z.infer<typeof AgOutcome>;

export const AgRole = z.enum(["user", "assistant", "tool", "system"]);
export type AgRole = z.infer<typeof AgRole>;

// Sentinel for removing all messages in a turn (spec §4 message.remove / §5).
export const REMOVE_ALL = "*" as const;

// ─── ADVANCED helper types (spec §2 / §3 / §4 / §9) ──────────────────────────

// The unified message object (spec §3.2): one type, both directions. Input-only
// fields are optional. Carried by `messages.snapshot` and reconstructed into
// `AgReduceResult.messages` (§5). `messageMetadata` is an opaque app bag
// (Vercel usage accounting + the A2UI `a2uiClientDataModel` snapshot key, §11.1).
export const AgMessage = z.object({
  id: z.string(),
  role: AgRole,
  content: z.array(AgBlock),
  turnId: z.string().optional(),
  threadId: z.string().optional(),
  candidateIndex: z.number().optional(), // absent ⇒ candidate 0 (§5 partitioning)
  referenceTurnIds: z.array(z.string()).optional(),
  messageMetadata: JsonValue.optional(),
  extensions: z.array(z.string()).optional(),
  metadata: AgMeta.optional(),
  agentId: z.string().optional(),   // agent that produced this message (A2-additive)
  agentName: z.string().optional(), // human-readable agent name (A2-additive)
  agentRole: z.string().optional(), // role of the agent in the pipeline (A2-additive)
  model: z.string().optional(),     // model that produced this message (A2-additive)
  usage: AgUsage.optional(),        // per-message token usage (landed from message.end.usage; A2-additive)
});
export type AgMessage = z.infer<typeof AgMessage>;

// The A2A streamed-artifact ENTITY (spec §2 — the ONLY meaning of "artifact").
// Side-channel, NOT an AgBlock; reduce() lands these in
// `AgReduceResult.artifacts` (§5). `extensions` = foreign A2A active-extension URIs.
export const AgArtifact = z.object({
  artifactId: z.string(),
  turnId: z.string(),
  threadId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(AgBlock),
  extensions: z.array(z.string()).optional(),
  _meta: AgMeta.optional(),
});
export type AgArtifact = z.infer<typeof AgArtifact>;

// Turn trigger descriptor (A2-additive; folded from turn.start.trigger onto AgTurnRecord.trigger).
export const AgTrigger = z.object({
  kind: z.enum(["user", "resume", "schedule", "webhook", "email", "agent", "cron", "unknown"]),
  ref: z.string().optional(),
});
export type AgTrigger = z.infer<typeof AgTrigger>;

// A folded handoff edge (spec §2 `AgTurnRecord.handoffs[]` / §4 handoff event).
export const AgHandoffRecord = z.object({
  kind: z.enum(["transfer", "escalate"]).optional(),
  fromAgentId: z.string().optional(),
  toAgentId: z.string().optional(),
  toAgentName: z.string().optional(),
});
export type AgHandoffRecord = z.infer<typeof AgHandoffRecord>;

// A ToS-must-render record (spec §2 `AgTurnRecord.displayRequired[]` / §4
// display.required event).
export const AgDisplayRequired = z.object({
  provider: z.string(),
  html: z.string(),
});
export type AgDisplayRequired = z.infer<typeof AgDisplayRequired>;

// Agent→client capabilities (spec §3 / §6 / §11.5) — the in-band other half of
// negotiation, an A2A AgentCard-compatible superset advertised on the first turn
// (carrier: the `agent.capabilities` event, §4). Defined here (before AgTurnRecord)
// so AgTurnRecord can reference it without z.lazy().
export const AgCapabilities = z.object({
  streaming: z.object({ partialMessages: z.boolean().optional() }).optional(),
  pushNotifications: z.boolean().optional(),
  securitySchemes: z.array(AgAuthConfig).optional(),
  extensions: z.array(z.string()).optional(), // foreign A2A active-extension URIs
  uiCatalogs: z.array(z.string()).optional(),
  profile: z.enum(["CORE", "EXTENDED", "ADVANCED"]).optional(),
});
export type AgCapabilities = z.infer<typeof AgCapabilities>;

// Per-turn folded record (spec §2): paused asks, prompt.blocked safety, handoffs,
// sources, lifecycle state. Part of AgReduceResult; restorable on snapshot resync (§5).
export const AgTurnRecord = z.object({
  turnId: z.string(),
  parentTurnId: z.string().optional(),
  threadId: z.string(),
  outcome: AgOutcome.optional(),
  finishReason: AgFinishReason.optional(),
  usage: AgUsage.optional(),
  safety: z.array(AgSafety).optional(),
  handoffs: z.array(AgHandoffRecord).optional(),
  sourceIds: z.array(z.string()).optional(),
  asks: z.array(AgPausedAsk).optional(),
  taskState: z.string().optional(), // verbatim A2A TaskState with no outcome target (A44)
  displayRequired: z.array(AgDisplayRequired).optional(),
  trigger: AgTrigger.optional(), // what triggered this turn (A2-additive)
  guardrails: z.array(z.object({
    target: z.enum(["input", "output", "tool"]),
    passed: z.boolean(),
    action: z.enum(["block", "retry", "rewrite", "override", "terminate"]).optional(),
    reason: z.string().optional(),
    guardrailName: z.string().optional(),
    safety: z.array(AgSafety).optional(),
  })).optional(), // guardrail evaluations folded from guardrail.result events (A2-additive)
  capabilities: AgCapabilities.optional(), // agent's AgCapabilities folded from agent.capabilities (first-turn negotiation; spec §5)
});
export type AgTurnRecord = z.infer<typeof AgTurnRecord>;

// A folded memory write (spec §5) — the landing record for memory.write events,
// parallel to AgArtifact. Side-channel; NOT an AgBlock. scope="thread" records are
// bound to threadId and REPLACED by a messages.snapshot; scope="agent"/"user"/"skill"
// are a SEPARATE cross-thread persistence axis (durable, NOT bound by the §1.1 thread
// containment tree) and are untouched by a per-thread snapshot.
export const AgMemoryRecord = z.object({
  scope: z.enum(["agent", "user", "skill", "thread"]),
  key: z.string().optional(),
  value: JsonValue,            // required on the LANDED record (the fold seeds it)
  reason: z.string().optional(),
  durable: z.boolean().optional(),
  turnId: z.string().optional(),
  threadId: z.string().optional(),
});
export type AgMemoryRecord = z.infer<typeof AgMemoryRecord>;

// reduce() landing container (spec §2 / §5) — the well-typed return of the fold.
export const AgReduceResult = z.object({
  messages: z.array(AgMessage),
  artifacts: z.array(AgArtifact),
  memory: z.array(AgMemoryRecord), // memory side-channel (parallel to artifacts; required)
  turns: z.array(AgTurnRecord),
  state: JsonValue.optional(), // shared-state working copy (opaque, §11.1)
});
export type AgReduceResult = z.infer<typeof AgReduceResult>;

// A client-advertised frontend tool (spec §3 `AgClientCapabilities.frontendTools[]`).
// `inputSchema` is an opaque JSON Schema (pass-through per §0.1).
export const AgFrontendTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: JsonValue,
});
export type AgFrontendTool = z.infer<typeof AgFrontendTool>;

// Client→agent capabilities (spec §3) — the inbound half of the in-band negotiation.
export const AgClientCapabilities = z.object({
  frontendTools: z.array(AgFrontendTool).optional(),
  hitl: z
    .object({
      ask: z.boolean().optional(),
      approveWithEdits: z.boolean().optional(),
      form: z.boolean().optional(),
      auth: z.boolean().optional(),
    })
    .optional(),
  streaming: z.object({ partialMessages: z.boolean().optional() }).optional(),
  uiResources: z
    .object({
      catalogs: z.array(z.string()).optional(),
      htmlResources: z.boolean().optional(),
    })
    .optional(),
  state: z.object({ jsonPatch: z.boolean().optional() }).optional(),
});
export type AgClientCapabilities = z.infer<typeof AgClientCapabilities>;

// ─── INPUT (spec §3) ─────────────────────────────────────────────────────────

// Reasoning request knob (spec §3): neutral mapping over OpenAI o-series `effort`
// + Anthropic/Gemini thinking `budgetTokens`.
export const AgReasoningConfig = z.object({
  mode: z.enum(["enabled", "disabled"]),
  effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  budgetTokens: z.number().optional(),
});
export type AgReasoningConfig = z.infer<typeof AgReasoningConfig>;

// A tool definition carried by `start.run.tools[]` (spec §3). `inputSchema` is an
// opaque JSON Schema (§0.1). `uiVisibility` = MCP Apps access-control scope
// (from the tool's `_meta.ui.visibility`): "model" = model-callable, "app" = app-only.
export const AgToolDef = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: JsonValue,
  strict: z.boolean().optional(),
  providerExecuted: z.boolean().optional(),
  uiVisibility: z.array(z.enum(["model", "app"])).optional(),
  source: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("mcp"), serverName: z.string() }),
      z.object({ type: z.literal("function") }),
      z.object({ type: z.literal("frontend") }),
    ])
    .optional(),
  _meta: AgMeta.optional(),
});
export type AgToolDef = z.infer<typeof AgToolDef>;

// Run configuration carried by the `start` kind (spec §3). `system`/`context`
// revert faithfully to text or AgBlock[]; `responseFormat.schema` is opaque (§0.1).
export const AgRunConfig = z.object({
  model: z.string().optional(),
  system: z.union([z.string(), z.array(AgBlock)]).optional(),
  tools: z.array(AgToolDef).optional(),
  toolChoice: z
    .union([
      z.enum(["auto", "none", "required"]),
      z.object({ type: z.literal("tool"), name: z.string() }),
    ])
    .optional(),
  responseFormat: z
    .object({
      type: z.literal("json_schema"),
      name: z.string().optional(),
      schema: JsonValue,
      strict: z.boolean().optional(),
    })
    .optional(),
  reasoning: AgReasoningConfig.optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  stopSequences: z.array(z.string()).optional(),
  context: z.array(AgBlock).optional(),
  pushNotification: z
    .object({
      url: z.string(),
      token: z.string().optional(),
      auth: z.object({ scheme: z.string(), credentials: z.string().optional() }).optional(),
    })
    .optional(),
});
export type AgRunConfig = z.infer<typeof AgRunConfig>;

// The spec version this SDK implements (SPEC.md status line + §12). Consumers
// reject a MAJOR mismatch and accept any same-major version (§12 negotiation).
export const AGJSON_VERSION = "1.0.0-draft.1";

const agjsonWireVersion = z
  .string()
  .refine((v) => /^\d+\./.test(v) && v.split(".")[0] === AGJSON_VERSION.split(".")[0], {
    message: `AgJSON major-version mismatch (this SDK implements ${AGJSON_VERSION})`,
  });

// Shared envelope fields on EVERY AgInput variant (spec §3). `state` = shared-
// state echo (opaque, §11.1); `metadata` may carry namespaced runtime-replay
// handles (LangGraph `langgraph/threadId` / `langgraph/checkpointId`, A50).
export const AgInputEnvelope = z.object({
  protocol: z.literal("agjson"),
  version: agjsonWireVersion,
  threadId: z.string(),
  turnId: z.string(),
  parentTurnId: z.string().optional(),
  capabilities: AgClientCapabilities.optional(),
  state: JsonValue.optional(),
  metadata: AgMeta.optional(),
});
export type AgInputEnvelope = z.infer<typeof AgInputEnvelope>;
const inputEnvelope = {
  protocol: z.literal("agjson"),
  version: agjsonWireVersion,
  threadId: z.string(),
  turnId: z.string(),
  parentTurnId: z.string().optional(),
  capabilities: AgClientCapabilities.optional(),
  state: JsonValue.optional(),
  metadata: AgMeta.optional(),
};

// ─── SURFACE INTERACTION (spec §3 / §6 / §11.8 un-merge) ─────────────────────
// There is NO merged AgUiAction. A shared AgSurfaceEnvelope carries the
// correlation fields at the AgJSON layer (§1.3, §4 surface addressing) and five
// per-spec-faithful constructs (A2UI ×3, MCP Apps, OpenAI Apps) — each keeping
// its OWN frozen field names — form AgSurfaceInteraction.

// Shared correlation envelope for ALL surface interactions (spec §3).
export const AgSurfaceEnvelope = z.object({
  surface: z.enum(["a2ui", "mcp-app", "openai-app"]),
  surfaceId: z.string(),
  toolCallId: z.string().optional(),
  turnId: z.string().optional(),
  threadId: z.string().optional(),
  _meta: AgMeta.optional(),
});
export type AgSurfaceEnvelope = z.infer<typeof AgSurfaceEnvelope>;
// Envelope fields spread into each surface-interaction arm. The `surface`
// literal is overridden per-arm (the discriminant), so it is omitted here.
const surfaceEnvelope = {
  surfaceId: z.string(),
  toolCallId: z.string().optional(),
  turnId: z.string().optional(),
  threadId: z.string().optional(),
  _meta: AgMeta.optional(),
};

// A2UI v1.0 client→server `action` (A2UI-frozen names VERBATIM, §0.4). `context`
// = the A2UI resolved data-bindings — the SOLE sanctioned Record<string, unknown>
// (map shape known: string keys; each value opaque per §0.1).
export const AgA2uiSurfaceAction = z.object({
  ...surfaceEnvelope,
  surface: z.literal("a2ui"),
  a2uiMessage: z.literal("action"),
  name: z.string(),
  sourceComponentId: z.string(),
  timestamp: z.string(),
  context: z.record(z.string(), z.unknown()),
  wantResponse: z.boolean().optional(),
  actionId: z.string().optional(),
});
export type AgA2uiSurfaceAction = z.infer<typeof AgA2uiSurfaceAction>;

// A2UI v1.0 client→server `functionResponse` (inbound leg of the server
// callFunction RPC). `value` is the opaque return value (§0.1).
export const AgA2uiFunctionResponse = z.object({
  ...surfaceEnvelope,
  surface: z.literal("a2ui"),
  a2uiMessage: z.literal("function-response"),
  functionCallId: z.string(),
  call: z.string(),
  value: JsonValue,
});
export type AgA2uiFunctionResponse = z.infer<typeof AgA2uiFunctionResponse>;

// A2UI v1.0 client→server `error` (Generic Error, upstream-faithful): carries
// EXACTLY ONE of surfaceId (surface-scoped) | functionCallId (function-call
// failure). `path` = JSON-Pointer; REQUIRED when code === "VALIDATION_FAILED".
export const AgA2uiError = z
  .object({
    ...surfaceEnvelope,
    surfaceId: z.string().optional(), // overrides the envelope: XOR with functionCallId
    surface: z.literal("a2ui"),
    a2uiMessage: z.literal("error"),
    functionCallId: z.string().optional(),
    code: z.string(),
    message: z.string(),
    path: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.surfaceId === undefined) === (v.functionCallId === undefined)) {
      ctx.addIssue({
        code: "custom",
        message:
          "AgA2uiError carries exactly one of surfaceId | functionCallId (A2UI v1.0 Generic Error)",
        path: ["surfaceId"],
      });
    }
    if (v.code === "VALIDATION_FAILED" && v.path === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "VALIDATION_FAILED requires path (JSON-Pointer)",
        path: ["path"],
      });
    }
  });
export type AgA2uiError = z.infer<typeof AgA2uiError>;

// MCP Apps 2026-01-26 view→host RPCs (nested union on the verbatim JSON-RPC
// `method`). `content`/`structuredContent` kept VERBATIM (MCP-frozen, §0.4).
// ui/request-display-mode has NO modal mode (OpenAI-only).
export const AgMcpAppViewMessage = z.discriminatedUnion("method", [
  z.object({
    ...surfaceEnvelope,
    surface: z.literal("mcp-app"),
    method: z.literal("ui/update-model-context"),
    params: z.object({ content: z.array(AgBlock).optional(), structuredContent: JsonValue.optional() }),
  }),
  z.object({
    ...surfaceEnvelope,
    surface: z.literal("mcp-app"),
    method: z.literal("ui/message"),
    params: z.object({
      role: z.literal("user"),
      content: z.object({ type: z.literal("text"), text: z.string() }),
    }),
  }),
  z.object({
    ...surfaceEnvelope,
    surface: z.literal("mcp-app"),
    method: z.literal("ui/request-display-mode"),
    params: z.object({ mode: z.enum(["inline", "fullscreen", "pip"]) }),
  }),
  z.object({
    ...surfaceEnvelope,
    surface: z.literal("mcp-app"),
    method: z.literal("ui/open-link"),
    params: z.object({ url: z.string() }),
  }),
]);
export type AgMcpAppViewMessage = z.infer<typeof AgMcpAppViewMessage>;

// OpenAI Apps SDK widget (window.openai) component→server RPCs (nested union on
// `method`). OpenAI-frozen names VERBATIM (§0.4). `callTool` is a SPEC-UNIQUE
// surface interaction, NOT the normalized tool-call. requestDisplayMode has NO
// modal mode. `toolResponseMetadata` is the OpenAI-only global echo (shared
// across all arms, so it is spread into each).
const openAiWidgetBase = {
  ...surfaceEnvelope,
  surface: z.literal("openai-app"),
  toolResponseMetadata: JsonValue.optional(),
};
export const AgOpenAiWidgetAction = z.discriminatedUnion("method", [
  z.object({ ...openAiWidgetBase, method: z.literal("setWidgetState"), widgetState: JsonValue }),
  z.object({
    ...openAiWidgetBase,
    method: z.literal("callTool"),
    name: z.string(),
    args: JsonValue,
    callId: z.string(),
  }),
  z.object({
    ...openAiWidgetBase,
    method: z.literal("sendFollowUpMessage"),
    prompt: z.string(),
    scrollToBottom: z.boolean().optional(),
  }),
  z.object({
    ...openAiWidgetBase,
    method: z.literal("requestDisplayMode"),
    mode: z.enum(["inline", "pip", "fullscreen"]),
    requestId: z.string(),
  }),
]);
export type AgOpenAiWidgetAction = z.infer<typeof AgOpenAiWidgetAction>;

// The surface-interaction union (spec §3 / §6). Element type of
// resume.uiActions[]. Discriminated on `surface`; the three A2UI legs narrow
// further on the inner `a2uiMessage` discriminant.
export const AgSurfaceInteraction = z.union([
  AgA2uiSurfaceAction,
  AgA2uiFunctionResponse,
  AgA2uiError,
  AgMcpAppViewMessage,
  AgOpenAiWidgetAction,
]);
export type AgSurfaceInteraction = z.infer<typeof AgSurfaceInteraction>;

// A single client-executed tool-result flowing back IN (spec §3 `tool-result`
// kind `results[]`). The INPUT-side counterpart of the tool-result block; carries
// the 4 channels (§2.1) + async flags (`willContinue`/`scheduling`).
export const AgInputToolResult = z.object({
  toolCallId: z.string(),
  content: z.array(AgBlock),
  outcome: ToolOutcome.optional(),
  structuredContent: JsonValue.optional(),
  uiData: JsonValue.optional(),
  sideData: JsonValue.optional(),
  errorText: z.string().optional(),
  errorCode: z.string().optional(),
  providerMetadata: AgProviderMeta.optional(),
  toolMetadata: AgMeta.optional(),
  dynamic: z.boolean().optional(),
  pendingInput: AgPendingInput.optional(),
  isError: z.boolean().optional(),
  willContinue: z.boolean().optional(),
  scheduling: z.enum(["when_idle", "preempt", "silent"]).optional(),
  annotations: AgAnnotations.optional(),
  _meta: AgMeta.optional(),
});
export type AgInputToolResult = z.infer<typeof AgInputToolResult>;

// AgInput — the input envelope (spec §3): a discriminated union on `kind`
// (start | resume | tool-result) over the shared AgInputEnvelope.
export const AgInput = z.discriminatedUnion("kind", [
  z.object({
    ...inputEnvelope,
    kind: z.literal("start"),
    messages: z.array(AgMessage),
    run: AgRunConfig.optional(),
  }),
  z.object({
    ...inputEnvelope,
    kind: z.literal("resume"),
    answers: z.array(AgHitlAnswer).optional(),
    uiActions: z.array(AgSurfaceInteraction).optional(),
  }),
  z.object({
    ...inputEnvelope,
    kind: z.literal("tool-result"),
    results: z.array(AgInputToolResult),
  }),
]);
export type AgInput = z.infer<typeof AgInput>;

// Surface display-mode enum (spec §4 `ui.display-mode`). Upstream OpenAI Apps
// DisplayMode = pip | inline | fullscreen; MCP Apps ui/request-display-mode has
// the same set. There is NO modal display mode (OpenAI's modal is the separate
// requestModal API, not carried here).
export const AgDisplayMode = z.enum(["inline", "pip", "fullscreen"]);
export type AgDisplayMode = z.infer<typeof AgDisplayMode>;

// Surface-RPC error (spec §4 `ui.result` / `ui.action-result`): `path` =
// JSON-Pointer for an A2UI VALIDATION_FAILED reciprocal rejection.
export const AgSurfaceError = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});
export type AgSurfaceError = z.infer<typeof AgSurfaceError>;

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
  _meta: AgMeta.optional(),
};

// AgEvent — the CLOSED discriminated union of all dotted/bare-noun event types
// (CORE + EXTENDED + ADVANCED, spec §9). The open `ext.<vendor>.<key>` vendor
// extension (§4/§12) CANNOT live in a discriminatedUnion (its `type` is an open
// template-literal, not a fixed literal), so it is a sibling `AgExtEvent` joined
// via `.or()` below. Kept as a named const for clarity.
export const AgClosedEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("turn.start"), threadId: z.string(), turnId: z.string(), trigger: AgTrigger.optional() }),
  z.object({
    ...base,
    type: z.literal("turn.done"),
    turnId: z.string(),
    outcome: AgOutcome,
    finishReason: AgFinishReason,
    usage: AgUsage.optional(), // EXTENDED — per-turn usage (spec §4)
    safety: z.array(AgSafety).optional(), // EXTENDED — safety signals (spec §4)
    messageId: z.string().optional(),
    messageMetadata: JsonValue.optional(), // Vercel usage accounting / A2UI snapshot (§4 / §11.1)
    taskState: z.string().optional(), // verbatim A2A TaskState with no outcome target (§2)
  }),
  z.object({
    ...base,
    type: z.literal("turn.error"),
    message: z.string(),
    code: z.string().optional(),
    retriable: z.boolean().optional(),
    usage: AgUsage.optional(), // EXTENDED — accrued usage on an interrupted turn (A1)
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
    role: AgRole,
    turnId: z.string(),
    threadId: z.string(),
    stepId: z.string().optional(),
    extensions: z.array(z.string()).optional(), // foreign A2A active-extension URIs (§0.5)
    candidateIndex: z.number().optional(), // absent ⇒ candidate 0 (§5 partitioning)
    agentId: z.string().optional(),   // agent that produced this message (A2-additive)
    agentName: z.string().optional(), // human-readable agent name (A2-additive)
    agentRole: z.string().optional(), // role of the agent in the pipeline (A2-additive)
    model: z.string().optional(),     // model that produced this message (A2-additive)
  }),
  z.object({ ...base, type: z.literal("message.end"), id: z.string(), usage: AgUsage.optional() }), // usage = per-message token carrier (review #4)
  z.object({
    ...base,
    type: z.literal("text.start"),
    id: z.string(),
    role: z.literal("assistant").optional(),
    index: z.number().optional(),
    previousPartKind: z.string().optional(),
    providerMetadata: AgProviderMeta.optional(),
    candidateIndex: z.number().optional(), // absent ⇒ candidate 0 (§5 partitioning)
  }),
  z.object({
    ...base,
    type: z.literal("text.delta"),
    id: z.string(),
    delta: z.string(),
    providerMetadata: AgProviderMeta.optional(),
  }),
  z.object({ ...base, type: z.literal("text.end"), id: z.string(), providerMetadata: AgProviderMeta.optional() }),
  z.object({
    ...base,
    type: z.literal("content.block"),
    block: AgBlock,
    transient: z.boolean().optional(),
    candidateIndex: z.number().optional(), // absent ⇒ candidate 0 (§5 partitioning)
  }),
  z.object({
    ...base,
    type: z.literal("tool.start"),
    toolCallId: z.string(),
    name: z.string(),
    index: z.number().optional(),
    dynamic: z.boolean().optional(),
    serverName: z.string().optional(),
    providerExecuted: z.boolean().optional(),
    requiresApproval: z.boolean().optional(),
    title: z.string().optional(),
    toolMetadata: AgMeta.optional(),
    uiVisibility: z.array(z.enum(["model", "app"])).optional(),
    itemId: z.string().optional(),
    providerMetadata: AgProviderMeta.optional(),
    candidateIndex: z.number().optional(), // absent ⇒ candidate 0 (§5 partitioning)
    longRunning: z.boolean().optional(),   // hint: this tool call may take a long time (A2-additive)
  }),
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
    signature: z.string().optional(), // Gemini tool-call signature rides here (replay-load-bearing)
    title: z.string().optional(),
    toolMetadata: AgMeta.optional(),
    providerMetadata: AgProviderMeta.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("tool.done"),
    toolCallId: z.string(),
    messageId: z.string().optional(),
    content: z.array(AgBlock),
    outcome: ToolOutcome.optional(),
    isError: z.boolean().optional(),
    // ── ADVANCED tool-result channels (spec §2.1 / §4 / §9) — additive over CORE ──
    structuredContent: JsonValue.optional(),
    uiData: JsonValue.optional(),
    sideData: JsonValue.optional(),
    errorText: z.string().optional(),
    errorCode: z.string().optional(),
    providerMetadata: AgProviderMeta.optional(),
    toolMetadata: AgMeta.optional(),
    dynamic: z.boolean().optional(),
    pendingInput: AgPendingInput.optional(),
    skipSummarization: z.boolean().optional(), // output-only async flag (§2.2)
    more: z.boolean().optional(), // output-only async flag — more:true SETS preliminary (§2.2)
    preliminary: z.boolean().optional(), // output-only async flag (§2.2)
    candidateIndex: z.number().optional(), // absent ⇒ candidate 0 (§5 partitioning)
  }),

  // ─── EXTENDED events (spec §4 / §9) ────────────────────────────────────────
  // ── REASONING ──
  z.object({
    ...base,
    type: z.literal("reasoning.start"),
    id: z.string(),
    mode: z.enum(["summarized", "full"]).optional(),
    partIndex: z.number().optional(),
    previousPartKind: z.string().optional(),
    providerMetadata: AgProviderMeta.optional(),
    itemId: z.string().optional(),
    candidateIndex: z.number().optional(), // absent ⇒ candidate 0 (§5 partitioning)
  }),
  z.object({
    ...base,
    type: z.literal("reasoning.delta"),
    id: z.string(),
    delta: z.string(),
    partIndex: z.number().optional(),
    providerMetadata: AgProviderMeta.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("reasoning.end"),
    id: z.string(),
    provider: z.string().optional(),
    providerMetadata: AgProviderMeta.optional(),
  }),
  // REPLACE — sets `opaque` on the reasoning block named by `id` (replay-load-bearing).
  z.object({
    ...base,
    type: z.literal("reasoning.opaque"),
    id: z.string(),
    kind: AgOpaqueKind,
    value: z.string(),
    provider: z.string().optional(),
    itemId: z.string().optional(),
  }),
  // APPENDS to a per-id signature scratch buffer (Pydantic signature_delta).
  z.object({ ...base, type: z.literal("reasoning.opaque.delta"), id: z.string(), delta: z.string() }),
  // ── STEP ──
  z.object({
    ...base,
    type: z.literal("step.start"),
    id: z.string(),
    stepName: z.string().optional(),
    turnId: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("step.done"),
    id: z.string(),
    stepName: z.string().optional(),
    usage: AgUsage.optional(),
  }),
  // ── SUBAGENT / HANDOFF ── (subagent.start is the SOLE nested-turn opener)
  z.object({
    ...base,
    type: z.literal("subagent.start"),
    turnId: z.string(),
    parentTurnId: z.string(),
    agentId: z.string().optional(),
    agentName: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("subagent.done"), turnId: z.string(), parentTurnId: z.string() }),
  z.object({
    ...base,
    type: z.literal("handoff"), // bare-noun EVENT carve-out (spec §0.3)
    kind: z.enum(["transfer", "escalate"]).optional(),
    fromAgentId: z.string().optional(),
    toAgentId: z.string().optional(),
    toAgentName: z.string().optional(),
  }),
  // ── SOURCE ── (bare-noun EVENT carve-out, spec §0.3) — offset-citation bind target
  z.object({
    ...base,
    type: z.literal("source"),
    sourceId: z.string(),
    source: z.union([
      AgSource,
      z.object({ url: z.string(), title: z.string().optional() }),
      z.object({
        type: z.literal("document"),
        mediaType: z.string().optional(),
        title: z.string().optional(),
        filename: z.string().optional(),
      }),
    ]),
    chunkIndex: z.number().optional(),
    providerMetadata: AgProviderMeta.optional(),
  }),
  // ── PROMPT SAFETY ──
  z.object({
    ...base,
    type: z.literal("prompt.blocked"),
    reason: z.enum(["safety", "blocklist", "prohibited", "other"]),
    safety: z.array(AgSafety).optional(),
  }),
  // ── MESSAGE OPERATIONS ──
  // id="*" (REMOVE_ALL) requires turnId — enforced by superRefine on AgEvent (below).
  z.object({ ...base, type: z.literal("message.remove"),
    id: z.union([z.string(), z.literal("*")]),   // "*" = REMOVE_ALL
    turnId: z.string().optional() }),
  // ── MEMORY SIDE-CHANNEL ──
  // value and patch are both optional here; exactly-one invariant enforced by superRefine on AgEvent.
  z.object({ ...base, type: z.literal("memory.write"),
    scope: z.enum(["agent", "user", "skill", "thread"]),
    key: z.string().optional(),
    value: JsonValue.optional(), patch: JsonValue.optional(),  // exactly one — see superRefine
    reason: z.string().optional(), durable: z.boolean().optional() }),
  // ── GUARDRAIL EVALUATION (A2-additive; §0.3 closed set — `result` segment already reserved) ──
  z.object({
    ...base,
    type: z.literal("guardrail.result"),
    target: z.enum(["input", "output", "tool"]),
    passed: z.boolean(),
    action: z.enum(["block", "retry", "rewrite", "override", "terminate"]).optional(),
    reason: z.string().optional(),
    guardrailName: z.string().optional(),
    safety: z.array(AgSafety).optional(),
  }),
  // ── HITL (one family; spec §7) ──
  z.object({
    ...base,
    type: z.literal("hitl.ask"),
    askId: z.string(),
    kind: AgAskKind,
    message: z.string().optional(),
    schema: JsonValue.optional(),
    choices: z.array(AgChoice).optional(),
    authConfig: AgAuthConfig.optional(),
    url: z.string().optional(),
    toolCallId: z.string().optional(),
    continuation: z.enum(["resume", "turn"]).optional(),
    reason: z.string().optional(),
    metadata: AgMeta.optional(),
    requestState: z.string().optional(),
    inputKey: z.string().optional(),
    resumeBinding: z.enum(["id", "positional"]).optional(),
    ordinal: z.number().optional(),
    token: z.string().optional(),
    expiresAt: z.string().optional(),
  }),

  // ─── ADVANCED events (spec §4 / §9) ────────────────────────────────────────
  // ── OPAQUE / ADVANCED STATE PASSTHROUGH (LangGraph values/updates) ──
  // `snapshot` = full graph-state dict ("values" stream mode); REPLACE on fold (§5).
  z.object({ ...base, type: z.literal("state.snapshot"), snapshot: JsonValue }),
  // `patch` = LangGraph "updates" ({node:{key:value}}) OR an RFC-6902 JSON Patch — both opaque.
  z.object({ ...base, type: z.literal("state.delta"), patch: JsonValue }),
  // ── STREAMED ARTIFACTS (A2A) — side-channel landing (§5) ──
  z.object({
    ...base,
    type: z.literal("artifact.start"),
    artifactId: z.string(),
    turnId: z.string(),
    threadId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    extensions: z.array(z.string()).optional(),
  }),
  z.object({
    ...base,
    type: z.literal("artifact.delta"),
    artifactId: z.string(),
    part: AgBlock,
    append: z.boolean(),
  }),
  z.object({ ...base, type: z.literal("artifact.end"), artifactId: z.string(), lastChunk: z.literal(true) }),
  // ── RECONNECT / RESYNC ── full-state resync; REPLACE messages + turns + artifacts (§5).
  // memory REPLACES ONLY scope="thread" records; cross-thread (agent/user/skill) are untouched.
  z.object({
    ...base,
    type: z.literal("messages.snapshot"),
    messages: z.array(AgMessage),
    turns: z.array(AgTurnRecord).optional(),
    artifacts: z.array(AgArtifact).optional(),
    memory: z.array(AgMemoryRecord).optional(),
  }),
  // ── HOST DISPLAY/RUNTIME HINT ── live-only; `capabilities` here = HOST surface render hint (A30).
  z.object({
    ...base,
    type: z.literal("host.context"),
    theme: JsonValue.optional(),
    capabilities: JsonValue.optional(),
    container: JsonValue.optional(),
  }),
  // ── CAPABILITY NEGOTIATION (agent→client, first turn) ──
  z.object({ ...base, type: z.literal("agent.capabilities"), capabilities: AgCapabilities }),
  // ── MESSAGE METADATA ── merge into the message named by messageId (open assistant message when absent).
  z.object({ ...base, type: z.literal("message.metadata"), messageId: z.string().optional(), metadata: AgMeta }),
  // ── MANDATORY DISPLAY (ToS) ── recorded on the turn, MUST NOT be dropped (§5).
  z.object({ ...base, type: z.literal("display.required"), provider: z.string(), html: z.string() }),
  // ── AGENT ↔ SURFACE RPC (A2UI v1.0 + OpenAI Apps SDK) — live-only / non-folding (§5) ──
  z.object({
    ...base,
    type: z.literal("ui.call"),
    surfaceId: z.string(),
    callId: z.string(),
    method: z.string(),
    args: JsonValue.optional(),
    wantResponse: z.boolean().optional(),
    callableFrom: z.enum(["clientOnly", "remoteOnly", "clientOrRemote"]).optional(),
  }),
  z.object({
    ...base,
    type: z.literal("ui.result"),
    surfaceId: z.string(),
    callId: z.string(),
    method: z.string().optional(),
    value: JsonValue.optional(),
    error: AgSurfaceError.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("ui.action-result"),
    surfaceId: z.string(),
    actionId: z.string(),
    value: JsonValue.optional(),
    error: AgSurfaceError.optional(),
  }),
  // OpenAI Apps SDK window.openai.callTool reply leg — `result` is a string returned to the widget.
  z.object({ ...base, type: z.literal("ui.widget.result"), surfaceId: z.string(), callId: z.string(), result: z.string() }),
  z.object({
    ...base,
    type: z.literal("ui.display-mode"),
    mode: AgDisplayMode,
    granted: AgDisplayMode.optional(), // authoritative reply leg (A52)
    surfaceId: z.string().optional(),
    toolCallId: z.string().optional(),
  }),
  // ── A2UI SURFACE LIFECYCLE + DATA-MODEL PUSH (server→renderer; opaque) ──
  // catalogId carried BY REFERENCE; components/dataModel/surfaceProperties OPAQUE (zero component schema).
  z.object({
    ...base,
    type: z.literal("ui.surface.start"),
    surfaceId: z.string(),
    catalogId: z.string(),
    surfaceProperties: JsonValue.optional(),
    sendDataModel: z.boolean().optional(),
    components: JsonValue.optional(),
    dataModel: JsonValue.optional(),
    toolCallId: z.string().optional(),
  }),
  // A2UI updateComponents — the streamed adjacency-list passes through VERBATIM.
  z.object({ ...base, type: z.literal("ui.surface.update"), surfaceId: z.string(), components: JsonValue }),
  z.object({ ...base, type: z.literal("ui.surface.end"), surfaceId: z.string() }),
  // A2UI updateDataModel push; path = JSON-Pointer (default "/"); absent value = delete-at-path; value OPAQUE.
  z.object({
    ...base,
    type: z.literal("ui.data-model"),
    surfaceId: z.string(),
    path: z.string().optional(),
    value: JsonValue.optional(),
  }),
]);

// AgClosedEventType — the TypeScript-level discriminated union of all closed event
// members. Exported for consumers (e.g. the reduce() fold) that must switch on
// ev.type after ruling out the open AgExtEvent arm: the AgExtEvent catchall(JsonValue)
// index signature widens every field on the AgEvent union, so callers that need proper
// field narrowing should narrow (via a type guard) to AgClosedEventType after an ext-pattern guard.
export type AgClosedEventType = z.infer<typeof AgClosedEvent>;

// Open namespaced vendor-extension event `ext.<vendor>.<key>` (spec §4 / §9 / §12,
// RFC-6648: no `x-` prefix). A discriminatedUnion can't hold an open template-literal
// discriminant, so this is a sibling object validated on the `type` regex, with the
// extra `[k]: unknown` keys constrained to `JsonValue` via `.catchall`.
export const AgExtEvent = z
  .object({
    ...base,
    type: z.string().regex(/^ext\.[^.]+\..+$/),
  })
  .catchall(JsonValue);
export type AgExtEvent = z.infer<typeof AgExtEvent>;

// AgEvent = the closed discriminated union OR the open ext event. A bare unknown
// `type` (e.g. {type:"nope"}) matches neither arm and still REJECTS.
// Cross-field invariants live here (discriminatedUnion arms cannot carry .refine —
// it would produce ZodEffects, breaking the discriminatedUnion):
//   (1) message.remove id="*" (REMOVE_ALL) requires turnId
//   (2) memory.write requires exactly one of value | patch
export const AgEvent = AgClosedEvent.or(AgExtEvent).superRefine((ev, ctx) => {
  if (ev.type === "message.remove" && ev.id === "*" && ev.turnId === undefined)
    ctx.addIssue({ code: "custom", message: "message.remove id='*' (REMOVE_ALL) requires turnId" });
  if (ev.type === "memory.write" && (ev.value !== undefined) === (ev.patch !== undefined))
    ctx.addIssue({ code: "custom", message: "memory.write requires exactly one of value | patch" });
});
export type AgEvent = z.infer<typeof AgEvent>;
