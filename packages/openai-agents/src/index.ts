/**
 * `@silverprotocol/openai-agents` — the OpenAI Agents SDK normalizer.
 *
 * Translates the OpenAI Agents JS SDK stream-event union into AgJSON events
 * (`AgEvent[]`, spec §4). The Agents SDK surfaces TWO event families on its
 * `RunStreamEvent` stream:
 *   1. `RunItemStreamEvent` (type:"run_item_stream_event") — a SEMANTIC wrapper
 *      around a completed `RunItem` (message / tool-call / tool-output /
 *      reasoning). Its `item.rawItem` is the protocol item.
 *   2. `RunRawModelStreamEvent` (type:"raw_model_stream_event") — its `data` is the
 *      Agents SDK's own `ResponseStreamEvent` union (`@openai/agents` protocol
 *      `StreamEvent`): the literals `output_text_delta`, `response_started`,
 *      `response_done`, and a generic `model` carrier (`{ type:"model"; event }`).
 *      The verbatim openai-node Responses events (`response.output_text.delta`,
 *      `response.function_call_arguments.delta`/`.done`, `response.completed`) ride
 *      INSIDE the `model` carrier's `event` field and use snake_case fields
 *      (`item_id`, `arguments`, `delta`, `output_index`, `sequence_number`,
 *      `incomplete_details`) — NOT camelCase.
 *
 * Both families are needed: the run-item wrapper gives the assembled tool-call /
 * reasoning items (with the `fc_`/`rs_` ids that are replay-load-bearing), while
 * the raw Responses deltas (in the `model` carrier) carry the streamed text + the
 * per-fragment tool-call argument accumulation the spec mandates (§8.1).
 *
 * The sole entry point is the STATEFUL {@link createOpenaiNormalizer} factory:
 * one fresh `StreamAssembler` per factory call holds the per-invoke closure state
 * (turn anchoring, fc_→call_id correlation, arg buffers, refusal flag) and drives
 * the engine from the SINGLE authoritative source per concern (BINDING canonical
 * model, plan §"Spike Findings"). `seq` is allocated monotonically from 0 by the
 * engine; the Router rebases to a global ordinal downstream (out of scope here).
 * This is the sole normalizer contract for this package — no rule-based
 * alternative exists.
 *
 * The `OpenAIStreamEvent` discriminated union below is a faithful PROJECTION of
 * the verified `@openai/agents` `RunStreamEvent` union + the openai-node
 * `ResponseStreamEvent` shapes — hand-defined as the fixture contract (the
 * subset the normalizer consumes) until the OpenAI runtime is wired. It is NOT a
 * raw-provider-event redefinition with an invented shape; field names match the
 * primary sources (snake_case for the openai-node Responses events). Verified
 * against the primary sources (June 2026):
 *   - openai/openai-agents-js packages/agents-core/src/events.ts
 *     (`RunItemStreamEvent` + `RunItemStreamEventName`;
 *      `RunRawModelStreamEvent.data: ResponseStreamEvent`)
 *   - openai/openai-agents-js packages/agents-core/src/items.ts
 *     (`RunMessageOutputItem`/`RunToolCallItem`/`RunToolCallOutputItem`/`RunReasoningItem`/
 *      `RunHandoffCallItem.{rawItem,agent}`/`RunHandoffOutputItem.{rawItem,sourceAgent,targetAgent}`)
 *   - openai/openai-agents-js packages/agents-core/src/types/protocol.ts
 *     (`AssistantMessageItem` / `FunctionCallItem.{callId,name,arguments,id}` /
 *      `FunctionCallResultItem.{callId,output}` / `ReasoningItem.{id,content,providerData}`;
 *      the `StreamEvent` union: `output_text_delta` {delta}, `response_started`,
 *      `response_done` {response}, and the generic `model` carrier {type:"model", event})
 *   - openai/openai-node responses event types (the `model` carrier's `event`):
 *     `response.output_text.delta` (`item_id`/`delta`/`output_index`/`content_index`/`sequence_number`),
 *     `response.function_call_arguments.delta` (`item_id`/`delta`),
 *     `response.function_call_arguments.done` (`arguments`/`item_id`),
 *     `response.completed`/`response.incomplete` (`response.incomplete_details.reason`),
 *     and the reasoning item `rs_…` + `encrypted_content` stateless-replay payload
 *     (the `reasoning.encrypted_content` include; rides `ReasoningItem.providerData`).
 *
 * `@openai/agents` is declared an OPTIONAL peerDependency (for when its native
 * types are wanted) but is NOT imported — this package is fixture-only and the
 * SDK is not installed.
 *
 * KNOWN-DEFERRED (@openai/agents 0.13.2 audit, 2026-07-13 — adversarially
 * verified against both versions' dists; every surface below is OPT-IN and
 * needs a live capture before a faithful mapping slice, per fixture
 * discipline):
 *   - EXPERIMENTAL hosted multi-agent (`@openai/agents-openai/experimental/
 *     hosted-multi-agent`, opt-in via `multi_agent:{enabled:true}` +
 *     `OpenAI-Beta: responses_multi_agent=v1`): subagent `response.output_text.
 *     delta`s are indistinguishable from root-agent text at this seam (FIFO
 *     textEnd would mis-correlate); `agent_message` / `multi_agent_call` /
 *     `multi_agent_call_output` collaboration items and `agent.agent_name`
 *     attribution no-op in the raw-model arms; merged multi-response usage
 *     never reaches the `model:response.completed` usage seam (turn.done
 *     undercounts). Consumers of AgJSON see a plausible single-agent turn —
 *     mapping this without live wire would fabricate correlation (Tenet 6).
 *   - openai ≥6.46 programmatic tool calling (`program`/`program_output` output
 *     items + `caller:{type,caller_id}` on tool items; reachable only via the
 *     `providerData` tool escape hatch — agents-openai 0.13.2's own converters
 *     add no arm, so nothing reaches the run-item seam either): raw
 *     `output_item.added/.done` carriers no-op here; `caller` attribution rides
 *     unread in providerData.
 *   - `response.inject.created`/`.failed` (hosted multi-agent lifecycle):
 *     verified immaterial — client-initiated echo, no content loss.
 */
import {
  type AgEvent,
  type AgBlock,
  type AgFinishReason,
  type AgUsage,
  type AgSafety,
  type AgCitation,
  JsonValue,
  type Normalizer,
  StreamAssembler,
  type ToolOutcome,
  type TurnDoneFields,
} from "@silverprotocol/core";

// ─────────────────────────────────────────────────────────────────────────────
// OpenAIStreamEvent — the HAND-DEFINED fixture contract (verified shapes above).
// A minimal faithful projection of the @openai/agents `RunStreamEvent` union +
// the underlying OpenAI Responses streaming events the runtime would emit.
// ─────────────────────────────────────────────────────────────────────────────

/** Assistant message content part (protocol `OutputText`). */
export interface OpenAIOutputText {
  type: "output_text";
  text: string;
  /** url_citation and file_citation annotations on the text part. */
  annotations?: OpenAIAnnotation[];
}

/** url_citation annotation on an output_text part (openai-node `ResponseCitationAnnotation`). */
export interface OpenAIUrlCitationAnnotation {
  type: "url_citation";
  url: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

/** file_citation annotation on an output_text part. */
export interface OpenAIFileCitationAnnotation {
  type: "file_citation";
  file_id?: string;
  filename?: string;
  index?: number;
}

/** The subset of annotations that the normalizer handles. */
export type OpenAIAnnotation = OpenAIUrlCitationAnnotation | OpenAIFileCitationAnnotation;

/** `Refusal` content part — the model refused to answer (openai-node `ResponseOutputRefusal`). */
export interface OpenAIRefusal {
  type: "refusal";
  refusal: string;
}

/** Union of assistant message content parts the normalizer handles. */
export type OpenAIContentPart = OpenAIOutputText | OpenAIRefusal;

/** protocol `AssistantMessageItem` (the `rawItem` of a message_output_item). */
export interface OpenAIAssistantMessageItem {
  type?: "message";
  role: "assistant";
  status: "in_progress" | "completed" | "incomplete";
  content: OpenAIContentPart[];
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

/** protocol `FunctionCallItem` (the `rawItem` of a tool_call_item). `callId` is
 *  the model's call_id; `id` is the Responses `fc_…` item id (DISTINCT). */
export interface OpenAIFunctionCallItem {
  type: "function_call";
  callId: string;
  name: string;
  arguments: string; // a JSON STRING — MUST be JSON.parse'd for tool.args.assembled
  status?: "in_progress" | "completed" | "incomplete";
  id?: string; // fc_… Responses item id
  providerData?: { [k: string]: JsonValue };
}

/** protocol `ToolOutputText` — the BARE-OBJECT arm of `FunctionCallResultItem.
 *  output` (`output: {type:"text", text}`, not wrapped in an array). */
export interface OpenAIToolOutputText {
  type: "text";
  text: string;
}

/**
 * protocol array-form element of `FunctionCallResultItem.output`
 * (`output: [...]`) — playbook 2026-07-03 SDK-bump adaptation, Finding #2
 * (critical). `@openai/agents-core` 0.12.0's real zod schema
 * (`protocol.d.ts`'s `FunctionCallResultItem`) discriminates the ARRAY arm's
 * elements with `input_text`/`input_image`/`input_file` literals — DIFFERENT
 * from the bare-object arm's `text`/`image`/`file` literals ({@link
 * OpenAIToolOutputText}). The prior 0.12.0 adaptation missed this: it typed
 * the array arm as `OpenAIToolOutputText[]` (i.e. assumed array elements ALSO
 * use `type:"text"`), so `toolOutputToAgBlocks`'s `part.type === "text"`
 * check never matched a real array-shaped tool result — VERIFIED LIVE
 * (playbook 2026-07-03, echo-gpt55 capture): every MCP tool call's result
 * silently produced `tool.done.content: []`, discarding the tool's entire
 * output text. `@openai/agents-core` 0.12.0 uses this array+`input_text`
 * shape for MCP-routed tool-call results (the common case for this SDK's own
 * MCP client) — this was never exercised by a live capture before now (the
 * committed openai seed cassettes predate 0.12.0). Only the text arm is
 * modeled/handled here, matching the PRE-EXISTING scope of the bare-object
 * arm (which also only maps `type:"text"`, never `type:"image"`/`"file"`) —
 * `input_image`/`input_file` array elements remain intentionally unhandled.
 */
export interface OpenAIToolOutputInputText {
  type: "input_text";
  text: string;
}

/** protocol `FunctionCallResultItem` (the `rawItem` of a tool_call_output_item).
 *  `output` is a string, a bare content object ({@link OpenAIToolOutputText}),
 *  or a content-part ARRAY ({@link OpenAIToolOutputInputText}[]) — the wrapper's
 *  own `output` field carries the stringified primary output. */
export interface OpenAIFunctionCallResultItem {
  type: "function_call_result";
  name: string;
  callId: string;
  status: "in_progress" | "completed" | "incomplete";
  output: string | OpenAIToolOutputText | OpenAIToolOutputInputText[];
  providerData?: { [k: string]: JsonValue };
}

// ── OpenAI native BUILT-IN tool call shapes (playbook 2026-07-03 SDK-bump
// adaptation, Finding #1 — @openai/agents-core 0.2.1 → 0.12.0). Shell /
// Apply-Patch / Hosted-tool calls carry NO dedicated RunItemStreamEventName —
// they reuse the pre-existing `tool_called`/`tool_output` names with NEW
// `rawItem` shapes (verified against @openai/agents-core 0.12.0's
// `types/protocol.ts`: `ShellCallItem` / `ShellCallResultItem` /
// `ApplyPatchCallItem` / `ApplyPatchCallResultItem` / `HostedToolCallItem`).

/** protocol `ShellAction` — the shell tool's per-call command spec. */
export interface OpenAIShellAction {
  commands: string[];
  timeoutMs?: number;
  maxOutputLength?: number;
}

/** protocol `ShellCallItem` (a `tool_called` rawItem for OpenAI's native shell
 *  built-in tool). Carries NO `name` field — the wire identifies the tool
 *  purely by `type`; the facet synthesizes `name:"builtin:shell"` (§8 quirk).
 *  Unlike `function_call`, there is no per-fragment argument-delta stream for
 *  this shape on this seam — the whole `action` arrives complete on this ONE
 *  wrapper, so this run-item (not the raw stream) is the sole tool-start
 *  source for it. */
export interface OpenAIShellCallItem {
  type: "shell_call";
  callId: string;
  status?: "in_progress" | "completed" | "incomplete";
  action: OpenAIShellAction;
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

/** protocol `ShellCallOutcome` (per-command exit signal). */
export interface OpenAIShellCallOutcome {
  type: "timeout" | "exit";
  exitCode?: number | null;
}

/** protocol `ShellCallOutputContent` (one command's stdout/stderr/outcome). */
export interface OpenAIShellCallOutputContent {
  stdout: string;
  stderr: string;
  outcome: OpenAIShellCallOutcome;
}

/** protocol `ShellCallResultItem` (the `rawItem` of a `tool_output` run-item for
 *  a completed shell call). `output` is an ARRAY of per-command results — a
 *  DIFFERENT shape from `OpenAIFunctionCallResultItem.output` (a bare string /
 *  content-part union); the two must NOT be handled by the same generic path
 *  (that was the orphan-hazard: shape-compatible-enough field NAMES let a
 *  `tool.done` fire with silently-empty content). */
export interface OpenAIShellCallResultItem {
  type: "shell_call_output";
  callId: string;
  maxOutputLength?: number;
  output: OpenAIShellCallOutputContent[];
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

/** protocol `ApplyPatchOperation` (one file edit — create/update/delete). */
export interface OpenAIApplyPatchOperation {
  type: "create_file" | "update_file" | "delete_file";
  path: string;
  diff?: string;
  moveTo?: string;
}

/** protocol `ApplyPatchCallItem` (a `tool_called` rawItem for OpenAI's native
 *  apply-patch built-in tool). Carries NO `name` field; the facet synthesizes
 *  `name:"builtin:apply_patch"` (§8 quirk). Same single-wrapper-is-authoritative
 *  rationale as {@link OpenAIShellCallItem}. */
export interface OpenAIApplyPatchCallItem {
  type: "apply_patch_call";
  callId: string;
  status: "in_progress" | "completed";
  operation: OpenAIApplyPatchOperation;
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

/** protocol `ApplyPatchCallResultItem` (the `rawItem` of a `tool_output`
 *  run-item for a completed apply-patch call). */
export interface OpenAIApplyPatchCallResultItem {
  type: "apply_patch_call_output";
  callId: string;
  status: "completed" | "failed";
  output?: string;
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

/** protocol `HostedToolCallItem` (a `tool_called` rawItem for a
 *  provider-HOSTED built-in tool — web_search / code_interpreter /
 *  file_search / image_generation / mcp / … — normalized into this ONE
 *  umbrella shape only at the run-item layer: the raw `response.output_item.
 *  added` event NEVER carries `item.type === "hosted_tool_call"` literally —
 *  each underlying OpenAI hosted tool has its OWN distinct raw wire type, so
 *  this discriminant only exists here). UNLIKE `function_call`/`shell_call`/
 *  `apply_patch_call`, this item carries its OWN `output` when it streams:
 *  OpenAI's hosted tools execute server-side within the same model turn, so
 *  by the time this wrapper delivers it, the call is already resolved —
 *  there is no separate `tool_output` run-item for this shape (verified
 *  against @openai/agents-core 0.12.0's `runner/modelOutputs.mjs`: a
 *  `hosted_tool_call` output item is pushed as a single `RunToolCallItem`,
 *  never paired with a `RunToolCallOutputItem`). The facet emits
 *  `tool.start` + `tool.done` TOGETHER from this one event. */
export interface OpenAIHostedToolCallItem {
  type: "hosted_tool_call";
  id?: string;
  name: string;
  arguments?: string;
  status?: string;
  output?: string;
  providerData?: { [k: string]: JsonValue };
}

// ── OpenAI native Computer-Use built-in tool shapes (fixture-drift ratchet
// finding, 2026-07-03 — Task 6's `sdk-surface.json` inventory surfaced that
// `computer_call`/`computer_call_result` ride the SAME `tool_called`/
// `tool_output` event names Finding #1 already fixed for shell/apply-patch,
// but were left uncovered by that fix. Verified against
// @openai/agents-core 0.12.0's `dist/types/protocol.d.ts`: `ComputerUseCallItem`
// / `ComputerCallResultItem`.)

/** protocol `ComputerUseCallItem` (a `tool_called` rawItem for OpenAI's native
 *  Computer-Use built-in tool). Carries NO `name` field — the facet synthesizes
 *  `name:"builtin:computer"` (§8 quirk, mirrors shell_call/apply_patch_call).
 *  The wire carries BOTH `action` (a single computer action — click/scroll/type/screenshot/…)
 *  and `actions` (a batch array of actions); the SDK's own runtime reads `actions` FIRST
 *  (if populated), falling back to `action`. Both are OPTIONAL on the wire and carried
 *  through verbatim as the tool's args payload; nested fields are not interpreted here
 *  (fixture discipline: type only what is consumed — the facet never branches on a
 *  specific action kind). Same single-wrapper-is-authoritative rationale as
 *  {@link OpenAIShellCallItem}: no per-fragment argument-delta stream exists for this
 *  shape on this seam. The normalizer MUST mirror the SDK's precedence: `actions ?? action ?? {}`. */
export interface OpenAIComputerCallItem {
  type: "computer_call";
  callId: string;
  status: "in_progress" | "completed" | "incomplete";
  action?: JsonValue;
  actions?: JsonValue;
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

/** protocol `ComputerCallResultItem` (the `rawItem` of a `tool_output` run-item
 *  for a completed Computer-Use call). `output` is ALWAYS the
 *  `computer_screenshot` shape (a base64-encoded PNG screenshot) — NO
 *  `status`/error discriminant exists on this wire arm (unlike shell/apply-
 *  patch results), so the facet maps every occurrence to `outcome:"ok"`. */
export interface OpenAIComputerCallResultItem {
  type: "computer_call_result";
  callId: string;
  output: { type: "computer_screenshot"; data: string };
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

// ── OpenAI native Tool-Search built-in shapes (fixture-drift ratchet
// disposition, 2026-07-03 — the last weak `carried` entries. Verified against
// @openai/agents-core 0.12.0's `dist/types/protocol.d.ts`: `ToolSearchCallItem`
// / `ToolSearchOutputItem`; `dist/events.d.ts`: `tool_search_called`/
// `tool_search_output_created` are DEDICATED `RunItemStreamEventName` literals
// — UNLIKE shell/apply-patch/computer/hosted-tool (§8 item 20), which all
// REUSE the pre-existing `tool_called`/`tool_output` names. `dist/runner/
// modelOutputs.mjs` confirms the PAIRED shape (mirrors shell_call/
// apply_patch_call/computer_call, not hosted_tool_call's single-shot
// collapse): `processModelResponse`/`processModelResponseAsync` push a
// `RunToolSearchCallItem` then, when the output is already resolved this SAME
// step — server-hosted execution returns both together in one
// `modelResponse.output`; client execution resolves synchronously via the
// SDK's own built-in `{paths}` loader or an AWAITED custom `toolSearchTool.
// execute()` — a `RunToolSearchOutputItem` right after; `dist/runner/
// streaming.mjs`'s `getRunItemStreamEventName` maps each RunItem class to its
// OWN event name, so these stream as TWO SEPARATE `RunItemStreamEvent`s (a
// `tool_search_called` followed by a `tool_search_output_created`), not one
// collapsed event.

/** protocol `ToolSearchCallItem` (a `tool_search_called` rawItem — the model
 *  searching a large tool catalog before invoking a specific tool; hosted
 *  server-side (`execution:"server"`) or client-executed (`execution:
 *  "client"`, either `Runner`'s built-in `{paths:string[]}` loader or a
 *  custom `toolSearchTool({execution:"client", execute})`)). Carries NO
 *  `name` field — the facet synthesizes `name:"builtin:tool_search"` (§8
 *  quirk, mirrors shell_call/apply_patch_call/computer_call). UNLIKE those
 *  three (and unlike every other builtin's REQUIRED `callId: z.ZodString`),
 *  `call_id`/`callId` are BOTH optional AND nullable on this wire — the
 *  SDK's own runtime (`dist/tooling.mjs`'s `getToolSearchProviderCallId`/
 *  `getToolSearchMatchKey`) falls back through `providerData.call_id` →
 *  `providerData.callId` → the item's own `id` → (only when NEITHER side of
 *  a pairing has ANY identifiable id) blind FIFO positional matching against
 *  pending calls. `resolveToolSearchCallId` (below, near `driveToolSearchCalled`)
 *  mirrors the id-fallback chain — NOT the FIFO fallback: fabricating a
 *  positional-match correlation with no supporting id would risk silently
 *  pairing two UNRELATED calls, so that case instead degrades to
 *  `ext.openai.unparsed` (Tenet 6 — never fabricate a correlation id).
 *  `arguments` is `z.ZodUnknown` (NOT a JSON STRING like `FunctionCallItem.
 *  arguments`) — provider-defined (`{paths, query}` for the built-in hosted
 *  loader; a custom shape for a registered `toolSearchTool`) — carried
 *  through verbatim like `computer_call`'s `action`/`actions`, never
 *  JSON.parsed. */
export interface OpenAIToolSearchCallItem {
  type: "tool_search_call";
  id?: string;
  call_id?: string | null;
  callId?: string | null;
  execution?: "client" | "server";
  arguments?: JsonValue;
  status?: string;
  providerData?: { [k: string]: JsonValue };
}

/** protocol `ToolSearchOutputItem` (the `tool_search_output_created` rawItem
 *  for a resolved tool-search call). `tools` is, per the SDK's own zod-schema
 *  doc comment, "tool references or concrete tool definitions" — an array of
 *  provider-defined records (`{type:"tool_reference", functionName,
 *  namespace}` / a serialized function-tool definition / `{type:"namespace",
 *  name, description, tools:[...]}` / hosted-MCP provider data) — a
 *  structured retrieval LISTING, never natural-language text. Carried
 *  verbatim as a single AgBlock `data` block (the spec's escape hatch for
 *  structured non-text tool content — mirrors `computer_call_result`'s
 *  `file`-block treatment of its OWN non-text payload) rather than inventing
 *  a text rendering with no wire precedent; this is ALREADY full-fidelity
 *  (unlike `shell_call_output`'s lossy stdout/stderr join), so no separate
 *  `structuredContent` duplicate is warranted. `status` is an UNCONSTRAINED
 *  string (unlike shell/apply-patch's closed `'in_progress'|'completed'|
 *  'incomplete'` enum) — no documented error discriminant exists on this
 *  wire arm, so — mirroring `computer_call_result`'s identical precedent —
 *  every occurrence maps to `outcome:"ok"`. */
export interface OpenAIToolSearchOutputItem {
  type: "tool_search_output";
  id?: string;
  call_id?: string | null;
  callId?: string | null;
  execution?: "client" | "server";
  status?: string;
  tools: { [k: string]: JsonValue }[];
  providerData?: { [k: string]: JsonValue };
}

/** protocol `InputText` (the visible reasoning content part). */
export interface OpenAIReasoningTextPart {
  type: "input_text";
  text: string;
}

/** protocol `ReasoningItem` (the `rawItem` of a reasoning_item). The `rs_…` id +
 *  the `encrypted_content` (under `providerData`, the Responses stateless-replay
 *  payload) are replay-load-bearing (spec §8.2/§10.4). */
export interface OpenAIReasoningItem {
  type: "reasoning";
  id?: string; // rs_… Responses reasoning item id
  content: OpenAIReasoningTextPart[];
  providerData?: { encrypted_content?: string; [k: string]: JsonValue | undefined };
}

// ── run_item_stream_event arms (one per consumed RunItemStreamEventName) ──────
interface OpenAIMessageOutputEvent {
  type: "run_item_stream_event";
  name: "message_output_created";
  item: { type: "message_output_item"; rawItem: OpenAIAssistantMessageItem };
}
interface OpenAIToolCalledEvent {
  type: "run_item_stream_event";
  name: "tool_called";
  // Widened (playbook 2026-07-03 SDK-bump adaptation, Finding #1 + the
  // fixture-drift ratchet's computer_call finding): Shell / Apply-Patch /
  // Computer-Use / Hosted-tool built-ins reuse this SAME event name with a
  // DIFFERENT `rawItem` discriminant — see the four interfaces above.
  item: {
    type: "tool_call_item";
    rawItem:
      | OpenAIFunctionCallItem
      | OpenAIShellCallItem
      | OpenAIApplyPatchCallItem
      | OpenAIComputerCallItem
      | OpenAIHostedToolCallItem;
  };
}
interface OpenAIToolOutputEvent {
  type: "run_item_stream_event";
  name: "tool_output";
  // `item.rawItem` carries the protocol FunctionCallResultItem (callId, output, status)
  // — OR, widened (Finding #1 + the fixture-drift ratchet's computer_call_result
  // finding), a Shell/Apply-Patch/Computer-Use result (DIFFERENT `output`
  // shape per discriminant; `hosted_tool_call` never reaches this event, see its
  // own doc).
  //
  // structuredContent (the ggui cache marker, spec §2.1/§4) has TWO
  // peer-supported homes on this wrapper (playbook 2026-07-03 follow-up,
  // `extractStructuredContent`'s doc has the full wire-truth citations):
  //  - `item.customData` — populated ONLY when the caller's `MCPServer`
  //    config sets `customDataExtractor` (agents-core 0.12.0+); this is the
  //    ONLY channel `@openai/agents`'s NATIVE MCP client ever carries real
  //    structuredContent through, verified against agents-core 0.12.0's
  //    `mcpToFunctionTool`.
  //  - `item.output` (the wrapper-level field) — a defensive/legacy home:
  //    an object keyed by `.structuredContent`, for callers that front their
  //    OWN local (non-MCP-native) function tools returning a full
  //    `CallToolResult`-shaped object verbatim. NEVER produced by
  //    `@openai/agents`'s native MCP client in any peer-declared version
  //    (0.2.0–0.12.x) — kept as defense-in-depth, not a verified wire shape.
  //    Under 0.12.0's native MCP client this field is instead a
  //    JSON-stringified STRING (e.g. `'{"type":"text","text":"…"}'`) with no
  //    structuredContent inside it — parsed SAFELY as a fallback.
  // Cast-free extraction uses `isJsonObject` + `JsonValue.parse` throughout.
  item: {
    type: "tool_call_output_item";
    rawItem:
      | OpenAIFunctionCallResultItem
      | OpenAIShellCallResultItem
      | OpenAIApplyPatchCallResultItem
      | OpenAIComputerCallResultItem;
    output?: JsonValue;
    customData?: JsonValue;
  };
}

/** `tool_search_called` — a DEDICATED run-item event name (verified against
 *  @openai/agents-core 0.12.0's `dist/events.d.ts`: `RunItemStreamEventName`
 *  gained `'tool_search_called'`/`'tool_search_output_created'` as their OWN
 *  literals — UNLIKE shell/apply-patch/computer/hosted-tool, which all reuse
 *  the pre-existing `tool_called`/`tool_output` names (§8 item 20). The
 *  run-item's own `.type` discriminant is `"tool_search_call_item"` (verified
 *  against `dist/items.d.ts`'s `RunToolSearchCallItem`). See
 *  `OpenAIToolSearchCallItem`'s doc for the full wire-truth citations. */
interface OpenAIToolSearchCalledEvent {
  type: "run_item_stream_event";
  name: "tool_search_called";
  item: { type: "tool_search_call_item"; rawItem: OpenAIToolSearchCallItem };
}

/** `tool_search_output_created` — the paired completion event (see
 *  `OpenAIToolSearchOutputItem`'s doc for the wire-truth citations on why
 *  this is PAIRED, not collapsed like `hosted_tool_call`). The run-item's own
 *  `.type` discriminant is `"tool_search_output_item"` (`dist/items.d.ts`'s
 *  `RunToolSearchOutputItem`). */
interface OpenAIToolSearchOutputCreatedEvent {
  type: "run_item_stream_event";
  name: "tool_search_output_created";
  item: { type: "tool_search_output_item"; rawItem: OpenAIToolSearchOutputItem };
}

interface OpenAIReasoningEvent {
  type: "run_item_stream_event";
  name: "reasoning_item_created";
  item: { type: "reasoning_item"; rawItem: OpenAIReasoningItem };
}

/** Minimal projection of `@openai/agents`' `Agent` class — only `.name` is
 *  consumed anywhere on this seam (fixture discipline: type ONLY what you
 *  consume). Rides on `handoff_requested`'s wrapper (`agent`, the SOURCE
 *  agent) and `handoff_occurred`'s wrapper (`sourceAgent`/`targetAgent`) —
 *  audit M48 review, Finding 1. */
export interface OpenAIAgentRef {
  name: string;
}

/** A handoff call item (`RunHandoffCallItem.rawItem`) — verified against
 *  @openai/agents-core 0.2.1's `protocol.FunctionCallItem`: `name`,
 *  `arguments`, `callId`, `status?`, `id?`, `providerData?`. It carries NO
 *  `targetAgent` field — that was an invented field on a false premise
 *  (audit M48 review, Finding 1): the transfer target is not resolvable at
 *  this point on the real wire (see {@link OpenAIHandoffRequestedEvent}). */
interface OpenAIHandoffCallItem {
  type: "function_call";
  name: string;
  callId: string;
  arguments: string;
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

/** `handoff_requested` — the run-item wrapper (`RunHandoffCallItem`) carries
 *  `agent` (real d.ts naming): the SOURCE agent whose LLM call produced this
 *  handoff call — NOT the transfer target. The target agent is resolved only
 *  once the handoff actually executes (verified against
 *  @openai/agents-core 0.2.1's `runImplementation.mjs`: `executeHandoffCalls`
 *  calls `handoff.onInvokeHandoff` — which resolves the new agent — AFTER
 *  the `RunHandoffCallItem` carrying this event is already constructed), and
 *  only appears on {@link OpenAIHandoffOccurredEvent}'s `targetAgent` below
 *  (audit M48 review, Finding 1). */
interface OpenAIHandoffRequestedEvent {
  type: "run_item_stream_event";
  name: "handoff_requested";
  item: { type: "handoff_call_item"; rawItem: OpenAIHandoffCallItem; agent: OpenAIAgentRef };
}

/** `handoff_occurred` — the REAL completion signal the original
 *  `handoff_requested` mapping assumed did not exist (audit M48 review,
 *  Finding 1; verified against @openai/agents-core 0.2.1's `events.d.ts`:
 *  `RunItemStreamEventName` includes `'handoff_occurred'`). The wrapper is a
 *  `RunHandoffOutputItem`: `rawItem` (the transfer's tool-output message,
 *  protocol `FunctionCallResultItem`-shaped — reuses
 *  {@link OpenAIFunctionCallResultItem}), `sourceAgent`, `targetAgent` (both
 *  {@link OpenAIAgentRef}) — this is where BOTH agent identities are finally
 *  known. */
interface OpenAIHandoffOccurredItem {
  type: "handoff_output_item";
  rawItem: OpenAIFunctionCallResultItem;
  sourceAgent: OpenAIAgentRef;
  targetAgent: OpenAIAgentRef;
}

interface OpenAIHandoffOccurredEvent {
  type: "run_item_stream_event";
  name: "handoff_occurred";
  item: OpenAIHandoffOccurredItem;
}

/** A tool approval request item (RunToolApprovalItem) — the function call that
 *  needs human approval rides in rawItem. */
interface OpenAIToolApprovalItem {
  type: "function_call";
  name: string;
  callId: string;
  arguments: string;
  id?: string;
}

interface OpenAIToolApprovalRequestedEvent {
  type: "run_item_stream_event";
  name: "tool_approval_requested";
  item: { type: "tool_approval_item"; rawItem: OpenAIToolApprovalItem };
}

/** The union of every `run_item_stream_event` arm this fixture contract declares
 *  (one per consumed `RunItemStreamEventName`). Used to hold a WIDENED reference
 *  to a run-item event in the drive() switch's `default` arm (Task 3, audit M48):
 *  once every declared `name` literal has its own `case`, TS narrows the switched-
 *  on `event` to `never` inside `default` — legally so, since every name this type
 *  declares IS handled — but a real-wire `RunItemStreamEventName` this hand-typed
 *  union does NOT declare (e.g. `mcp_approval_requested`, `mcp_list_tools`) still
 *  reaches `default` at RUNTIME (the outer guard only checks `typeof name ===
 *  "string"`, file header). A binding declared at this wider (but still concrete,
 *  non-`any`/`unknown`) type reads `.name`/`.item` without the `never` narrowing
 *  the switched expression itself is subject to — not a cast, since the runtime
 *  value genuinely does have this type shape (any run-item event IS one of these
 *  seven interfaces at the TS boundary; `default` is where the STATIC type and the
 *  DYNAMIC reality provably diverge, mirroring the M46 "widen, don't cast" fix).
 *  `handoff_occurred` used to be cited here as an example of an undeclared name —
 *  it is now a declared arm (audit M48 review, Finding 1: the fixture originally
 *  claimed no completion signal existed for a handoff; it does). */
type OpenAIRunItemEvent =
  | OpenAIMessageOutputEvent
  | OpenAIToolCalledEvent
  | OpenAIToolOutputEvent
  | OpenAIToolSearchCalledEvent
  | OpenAIToolSearchOutputCreatedEvent
  | OpenAIReasoningEvent
  | OpenAIHandoffRequestedEvent
  | OpenAIHandoffOccurredEvent
  | OpenAIToolApprovalRequestedEvent;

// ── raw_model_stream_event arm ───────────────────────────────────────────────
// `RunRawModelStreamEvent.data` is the Agents SDK's own `ResponseStreamEvent`
// union (`@openai/agents` protocol `StreamEvent`): the literals below + the
// generic `model` carrier. The verbatim openai-node Responses events ride INSIDE
// the carrier's `event` field, using snake_case.

/** openai-node `ResponseCreatedEvent` — the turn-open boundary. The real
 *  `response.id` is present here at the START of the stream (spike-confirmed),
 *  so it is the authoritative turn-anchor source (A1 canonical model). Carried via
 *  the `model` carrier. */
interface OpenAIResponsesCreated {
  type: "response.created";
  response: { id: string };
}
/** openai-node `ResponseFunctionCallArgumentsDeltaEvent` — the per-fragment
 *  argument delta (snake_case `item_id`/`delta`). */
interface OpenAIResponsesFnArgsDelta {
  type: "response.function_call_arguments.delta";
  item_id: string; // the fc_… Responses item id (buffer key + tool-call itemId)
  delta: string;
}
/** openai-node `ResponseFunctionCallArgumentsDoneEvent` — the sealed full
 *  arguments JSON string (snake_case `arguments`/`item_id`). */
interface OpenAIResponsesFnArgsDone {
  type: "response.function_call_arguments.done";
  item_id: string; // the fc_… Responses item id
  arguments: string;
}
/** openai-node `ResponseTextDeltaEvent` — a streamed assistant-text fragment
 *  (snake_case `item_id`/`delta`). Carried via the `model` carrier. */
interface OpenAIResponsesTextDelta {
  type: "response.output_text.delta";
  item_id: string;
  delta: string;
}
/** openai-node `ResponseTextDoneEvent` — the assistant-text stream for `item_id`
 *  is complete (`text` carries the full assembled string). Carried via the `model`
 *  carrier. Authoritative `text.end` source per the canonical event model (A1). */
interface OpenAIResponsesTextDone {
  type: "response.output_text.done";
  item_id: string;
  text?: string;
}
/** openai-node `ResponseUsage` — per-response token counts (snake_case).
 *  Extends to include provider-specific fields like OpenRouter's `cost` superset.
 *  `cache_write_tokens` is openai ≥6.46 wire (GPT-5.6-era explicit prompt
 *  caching; required member of `InputTokensDetails` there, absent ≤6.44). */
interface OpenAIResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
  cost?: number;
}

/** openai-node `ResponseCompletedEvent`/incomplete — `response.incomplete_details`
 *  is snake_case. Carried via the `model` carrier. */
interface OpenAIResponsesCompleted {
  type: "response.completed" | "response.incomplete";
  response: {
    id: string;
    status: "completed" | "incomplete";
    incomplete_details?: { reason?: string };
    usage?: OpenAIResponseUsage;
  };
}

/** openai-node `ResponseOutputItemAddedEvent` — fired when a new output item starts.
 *  When `item.type === "function_call"`, this is the AUTHORITATIVE tool-start source
 *  (canonical model, A1). Note: the raw Responses event uses snake_case `call_id`
 *  (DISTINCT from the run-item's camelCase `callId`). Carried via the `model` carrier. */
interface OpenAIResponsesOutputItemAdded {
  type: "response.output_item.added";
  item: {
    id: string; // the fc_… Responses item id
    type: string; // "function_call" | "message" | "reasoning" | …
    call_id?: string; // snake_case — only present when type==="function_call"
    name?: string; // tool name — only present when type==="function_call"
    status?: string;
    arguments?: string;
  };
}

/** openai-node `ResponseFailedEvent` — the response itself failed (e.g. rate limit).
 *  Carried via the `model` carrier. */
interface OpenAIResponsesFailed {
  type: "response.failed";
  response: {
    id: string;
    error?: { message?: string; code?: string };
  };
}

/** A top-level streaming error event (non-terminal advisory, spec §4). */
interface OpenAIResponsesError {
  type: "error";
  message: string;
  code?: string;
}

/** The faithful projection of the openai-node `ResponseStreamEvent` events the
 *  normalizer consumes (the carrier `event` payload). */
type OpenAIRawResponsesEvent =
  | OpenAIResponsesCreated
  | OpenAIResponsesOutputItemAdded
  | OpenAIResponsesFnArgsDelta
  | OpenAIResponsesFnArgsDone
  | OpenAIResponsesTextDelta
  | OpenAIResponsesTextDone
  | OpenAIResponsesCompleted
  | OpenAIResponsesFailed
  | OpenAIResponsesError;

// ── the Agents SDK `StreamEvent` union (RunRawModelStreamEvent.data) ──────────
/** `StreamEventTextStream` — `{ type:"output_text_delta"; delta }`. */
interface OpenAIStreamEventTextDelta {
  type: "output_text_delta";
  delta: string;
}
/** `StreamEventResponseStarted` — `{ type:"response_started" }`. */
interface OpenAIStreamEventResponseStarted {
  type: "response_started";
}
/** `StreamEventResponseCompleted` — `{ type:"response_done"; response? }`. */
interface OpenAIStreamEventResponseDone {
  type: "response_done";
  response?: { id: string; usage?: OpenAIResponseUsage };
}
/** `StreamEventGenericItem` — the generic `model` carrier. The verbatim
 *  openai-node Responses event rides in `event`. */
interface OpenAIStreamEventModel {
  type: "model";
  event: OpenAIRawResponsesEvent;
}
/** The SDK `ResponseStreamEvent`/`StreamEvent` union (`RunRawModelStreamEvent.data`). */
type OpenAIResponseStreamEvent =
  | OpenAIStreamEventTextDelta
  | OpenAIStreamEventResponseStarted
  | OpenAIStreamEventResponseDone
  | OpenAIStreamEventModel;

interface OpenAIRawModelStreamEvent {
  type: "raw_model_stream_event";
  data: OpenAIResponseStreamEvent;
}

/** A SYNTHETIC terminal sentinel the host feeds the normalizer when the
 *  `@openai/agents` runtime THROWS `MaxTurnsExceededError` from
 *  `await stream.completed` after the stream ends (the spike confirmed
 *  `max_turns` is NOT a native stream event). The host (T6) catches the throw
 *  and injects this; the normalizer maps it to `turn.error{code:"max_turns",…}`.
 *  Modeled as a real arm of the native union (NOT cast) so the guard + drive
 *  switch handle it type-safely. `usage` mirrors the neutral `AgUsage` shape. */
export interface OpenAIHostError {
  type: "__host_error__";
  code: string;
  message: string;
  usage?: AgUsage;
}

/** The fixture-contract input union (verified shapes; see file header). */
export type OpenAIStreamEvent =
  | OpenAIMessageOutputEvent
  | OpenAIToolCalledEvent
  | OpenAIToolOutputEvent
  | OpenAIToolSearchCalledEvent
  | OpenAIToolSearchOutputCreatedEvent
  | OpenAIReasoningEvent
  | OpenAIHandoffRequestedEvent
  | OpenAIHandoffOccurredEvent
  | OpenAIToolApprovalRequestedEvent
  | OpenAIRawModelStreamEvent
  | OpenAIHostError;

// ─── finish-reason → AgFinishReason (spec §4) ─────────────────────────────────
// Maps any OpenAI completion / `response.incomplete_details.reason` to the
// neutral AgFinishReason superset. A bare `response.completed` (no reason) = stop.
export function mapFinishReason(reason: string | undefined | null): AgFinishReason {
  switch (reason) {
    case undefined:
    case null:
    case "stop":
    case "completed":
      return "stop";
    case "max_output_tokens":
    case "max_tokens":
      return "token_limit";
    case "content_filter":
      return "safety_blocked";
    default:
      return "unknown";
  }
}

// ─── tool-output content → AgBlock[] (spec §2) ────────────────────────────────
function toolOutputToAgBlocks(
  output: OpenAIFunctionCallResultItem["output"],
): AgBlock[] {
  if (typeof output === "string") {
    return output.length > 0 ? [{ type: "text", text: output }] : [];
  }
  const parts = Array.isArray(output) ? output : [output];
  const out: AgBlock[] = [];
  for (const part of parts) {
    // Two DIFFERENT text discriminants ride this seam (Finding #2 above):
    // "text" on the bare-object arm, "input_text" on the array arm.
    if (part.type === "text" || part.type === "input_text") {
      out.push({ type: "text", text: part.text });
    }
  }
  return out;
}

// ─── usage mapping: OpenAI response usage → AgUsage ──────────────────────────
// cumulative:false — OpenAI usage is FINAL (not cumulative like Anthropic).
function mapUsage(usage: OpenAIResponseUsage | undefined): AgUsage | undefined {
  if (usage === undefined) return undefined;
  const u: AgUsage = { cumulative: false };
  if (usage.input_tokens !== undefined) u.inputTokens = usage.input_tokens;
  if (usage.output_tokens !== undefined) u.outputTokens = usage.output_tokens;
  if (usage.total_tokens !== undefined) u.totalTokens = usage.total_tokens;
  if (usage.input_tokens_details?.cached_tokens !== undefined)
    u.cacheReadTokens = usage.input_tokens_details.cached_tokens;
  if (usage.input_tokens_details?.cache_write_tokens !== undefined)
    u.cacheWriteTokens = usage.input_tokens_details.cache_write_tokens;
  if (usage.output_tokens_details?.reasoning_tokens !== undefined)
    u.reasoningTokens = usage.output_tokens_details.reasoning_tokens;
  // Provider-reported cost (e.g. OpenRouter `cost`) maps verbatim to costUsd.
  if (usage.cost !== undefined) u.costUsd = usage.cost;
  return u;
}

// ─── url_citation annotation → AgCitation ──────────────────────────────────
// `partText` is the source output_text part's text string; used to extract the
// cited substring from the char-offset indices carried by the annotation (Fix 3).
function mapAnnotationsToCitations(
  annotations: OpenAIAnnotation[] | undefined,
  partText: string,
): AgCitation[] | undefined {
  if (annotations === undefined || annotations.length === 0) return undefined;
  const out: AgCitation[] = [];
  for (const ann of annotations) {
    if (ann.type === "url_citation") {
      // Extract the cited substring from the part text when both offsets are present
      // and valid (Fix 3). Fall back to "" when any guard condition fails.
      const startIdx = ann.start_index;
      const endIdx = ann.end_index;
      const citedText =
        startIdx !== undefined && endIdx !== undefined && startIdx >= 0 && endIdx <= partText.length
          ? partText.slice(startIdx, endIdx)
          : "";
      const cit: AgCitation = {
        kind: "url",
        url: ann.url,
        citedText,
        indexFrame: "response",
      };
      if (ann.title !== undefined) cit.title = ann.title;
      if (startIdx !== undefined) cit.startIndex = startIdx;
      if (endIdx !== undefined) cit.endIndex = endIdx;
      out.push(cit);
    }
    // file_citation: no url-kind match; skip (deferred to a later slice — only remaining silent annotation drop)
  }
  return out.length > 0 ? out : undefined;
}

// ─── structural guard: unknown → OpenAIStreamEvent ────────────────────────────
// `createOpenaiNormalizer().push` receives the genuine JSON boundary (`JsonValue`,
// spec §0.1). The run-seam yields well-formed `OpenAIStreamEvent`s, but this is the
// deserialization boundary, so we confirm the OUTER discriminant before driving the
// engine. A user-defined type guard (not a cast) narrows on success; a failure routes
// the raw payload to `ext.openai.unparsed` and returns (graceful, Tenet 6).
//
// The guard takes `unknown` (not `JsonValue`): `OpenAIStreamEvent`'s nested
// interfaces have no index signature, so a `v is OpenAIStreamEvent` predicate over a
// `JsonValue` param is rejected by TS (TS2677). `unknown` is the genuine boundary
// input type and is predicate-compatible; the caller passes a `JsonValue`, which
// widens to `unknown` losslessly (mirrors the Claude facet's `isSDKMessage`).
function isJsonObject(v: unknown): v is { readonly [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Extract `structuredContent` (the ggui cache-marker channel, spec §2.1/§4)
 * from a `tool_output` run-item's wrapper fields. Playbook 2026-07-03
 * follow-up — the ORIGINAL extraction (feat 0969469) assumed `wrapperOutput`
 * would be an object keyed by `.structuredContent`; a live capture
 * (`echo-gpt55`, gpt-5.5 / agents-core 0.12.0) proved that assumption never
 * matches real `@openai/agents` native-MCP wire — `wrapperOutput` there is a
 * JSON-STRINGIFIED string (`'{"type":"text","text":"…"}'`), because
 * `RunToolCallOutputItem.toJSON()` (agents-core 0.12.0's `dist/items.mjs`)
 * runs `.output` through `toSmartString`, which passes strings through
 * unchanged but JSON.stringifies objects — and the object it stringifies
 * (`content[0]`, the raw MCP content ITEM) never had a `.structuredContent`
 * sibling to begin with: `mcpToFunctionTool`'s `invoke()`
 * (agents-core 0.12.0's `dist/mcp.mjs:672-738`) reads
 * `result.structuredContent` off the full `CallToolResult` but discards it
 * unless `useStructuredContent` is `true` (which instead merges it into the
 * MODEL-VISIBLE text — a spec violation, not a fix; rejected, see
 * `packages/e2e/src/agents/openai-agents-sdk/run.ts`) — so under the SDK
 * default, structuredContent is unconditionally dropped BEFORE it ever
 * reaches `item.output`. This is true for `@openai/agents-core` 0.2.1 too
 * (grep-verified: zero mentions of `structuredContent` anywhere in its
 * `dist/`) — the whole `>=0.2.0 <0.13` peer range's native MCP client drops
 * it by default; there is no version where the ORIGINAL assumed shape was
 * ever real wire truth for a native-MCP-routed tool call.
 *
 * The ONE real channel `@openai/agents-core` 0.12.0 offers is
 * `MCPServer.customDataExtractor` (absent before 0.12): a per-server
 * callback that receives `{ …, structuredContent }` and whose (JSON-
 * validated, SDK-normalized) return value lands verbatim on
 * `RunToolCallOutputItem.customData` — a NEW sibling field to `.output`,
 * included as-is (not smart-stringified) by `toJSON()`. This requires the
 * CALLER (the agent/worker that constructs the `MCPServer`) to opt in —
 * the facet cannot conjure data the wire never carries. Two homes are
 * checked, in order:
 *
 *  1. `customData.structuredContent` — the 0.12.0+ channel above.
 *  2. `wrapperOutput.structuredContent` — kept as defense-in-depth for
 *     callers whose OWN local (non-MCP-native) tool wrapping manually
 *     returns a full `CallToolResult`-shaped object (unverified against the
 *     SDK's native MCP client, but a real possible shape for a custom local
 *     tool's return value); also tried after a SAFE `JSON.parse` when
 *     `wrapperOutput` is a string (never throws out of `push()` — Tenet 6;
 *     a parse failure or a parsed value with no `.structuredContent` key is
 *     the ordinary case for a plain-text tool result, not an anomaly worth
 *     an `ext` carry).
 *
 * Neither home firing (the common case — most tool results carry no
 * structuredContent at all) is NOT a drop: it correctly yields `undefined`.
 */
function extractStructuredContent(
  wrapperOutput: JsonValue | undefined,
  customData: JsonValue | undefined,
): JsonValue | undefined {
  if (isJsonObject(customData) && isJsonObject(customData.structuredContent)) {
    return JsonValue.parse(customData.structuredContent);
  }
  if (isJsonObject(wrapperOutput) && isJsonObject(wrapperOutput.structuredContent)) {
    return JsonValue.parse(wrapperOutput.structuredContent);
  }
  if (typeof wrapperOutput === "string") {
    try {
      const parsed: unknown = JSON.parse(wrapperOutput);
      if (isJsonObject(parsed) && isJsonObject(parsed.structuredContent)) {
        return JsonValue.parse(parsed.structuredContent);
      }
    } catch {
      // Not JSON, or JSON with no `.structuredContent` key — the ordinary
      // shape for a plain-text tool result. No structuredContent to extract;
      // never throw out of push() (Tenet 6).
    }
  }
  return undefined;
}

// Only the OUTER envelope is validated here (the RunStreamEvent families: a
// `run_item_stream_event` with a string `name`, a `raw_model_stream_event` with a
// `data` object, or the synthetic `__host_error__` terminal sentinel the host feeds
// on `MaxTurnsExceededError`). The inner `drive` switch handles every nested arm
// structurally and no-ops anything it does not recognise — so a partially-shaped-but-
// well-typed event is never lost, and only a genuinely non-OpenAI-shaped payload
// falls to `unparsed`.
function isOpenAIStreamEvent(v: unknown): v is OpenAIStreamEvent {
  if (!isJsonObject(v)) return false;
  if (v.type === "run_item_stream_event") return typeof v.name === "string";
  if (v.type === "raw_model_stream_event") return isJsonObject(v.data);
  if (v.type === "__host_error__")
    return typeof v.code === "string" && typeof v.message === "string";
  return false;
}

// ─── the stateful normalizer (A1 §5-6) ────────────────────────────────────────
/**
 * Build a stateful OpenAI-facet normalizer over a fresh {@link StreamAssembler}.
 *
 * OpenAI has no native `turn.start` and the assistant turn is delivered as a
 * stream of redundant representations (the SDK emits `response_started`, a
 * `model:response.created`, an in-progress duplicate, BOTH a flattened
 * `output_text_delta` literal and the real item-id-keyed
 * `model:response.output_text.delta`, a `response_done` literal, and TWO
 * `model:response.completed` events per response). The normalizer drives the
 * engine from the SINGLE authoritative source per concern (BINDING canonical
 * model, plan §"Spike Findings") and ignores the rest:
 *
 *  - turn open  ← `model:response.created` (real `response.id` present at start)
 *  - text       ← `model:response.output_text.delta` (carries `item_id`)
 *  - text end   ← the `message_output_created` run-item (authoritative close +
 *                 citations carrier, audit M22 — `response.output_text.done` is a
 *                 no-op; text streams left open by it fall to the defensive
 *                 close-any-dangling-stream fallback in `closeResponse()` /
 *                 `endOpenStreamsAndCloseMessage()` / `emitRoundClose()`)
 *  - turn close ← `model:response.completed` (guard close-once)
 *
 * `ensureResponseOpen()` opens turn + message exactly once per response;
 * `closeResponse()` resets per-response state so the duplicate `response.completed`
 * is a no-op.
 *
 * `reasoning_item_created` / `tool_approval_requested` (Task 3, audit M48) map to
 * `reasoning.start/delta/end/opaque` and `hitl.ask{kind:"approval"}` respectively —
 * see `driveReasoningItemCreated` and the run-item switch below for the full
 * rationale. `handoff_requested` / `handoff_occurred` (Task 3, audit M48 review
 * Finding 1) map to a `subagentStart`/`subagentDone` PAIR bracketing the transfer —
 * the ORIGINAL Task-3 mapping used a standalone `handoff` event on the false premise
 * that the wire carried no completion signal; `handoff_occurred` IS that signal
 * (verified against the installed `@openai/agents-core` 0.2.1 peer dep's
 * `events.d.ts`). The bare `handoff` event still fires — carrying `toAgentName` —
 * but only once it's actually known, at `handoff_occurred` (the target agent is not
 * resolvable at `handoff_requested` time on the real wire; see the run-item switch's
 * `handoff_requested`/`handoff_occurred` cases for the full rationale, including why
 * identity can't ride the `subagentStart` call itself). `emitExt` is reserved for a
 * genuinely unrecognisable OUTER envelope AND — per the run-item switch's default
 * arm — a genuinely-unknown run-item `name` (mirrors the Claude facet).
 */
export function createOpenaiNormalizer(): Normalizer {
  const a = new StreamAssembler();
  // OpenAI's native stream carries no thread/session id (unlike Claude's
  // `session_id`), so the threadId is a fixed facet label. The Router rebases
  // ids downstream.
  const threadId = "openai";

  // Per-response anchoring state (one open response at a time on this seam).
  let turnCounter = 0;
  let turnId: string | undefined; // current open response's turn id
  let msgId: string | undefined; // current open message id
  let responseId: string | undefined; // real response.id once known
  // Open text streams keyed by Responses item_id (textStart once per id).
  const openTextStreams = new Set<string>();
  // Close-once guard: the SDK emits `response.completed` TWICE per response. Once a
  // response.id (or a synthesized turnId) has been closed, any further terminal event
  // for it is a no-op — it must NOT reopen a fresh message/turn.
  const closedResponses = new Set<string>();

  // Task 3 (audit M48 review, Finding 1) — handoff-bracket state. Every
  // run-item event on this seam arrives AFTER its owning round's
  // `response.completed` on the real wire (M22 late-citations / Task 4b
  // late-tool-result precedent — verified against @openai/agents-core
  // 0.2.1's `run.mjs`/`runImplementation.mjs`: `streamStepItemsToRunResult`
  // streams `processedResponse.newItems` — which includes the
  // `handoff_call_item` — only AFTER the raw-event loop for that round
  // completes, and the `handoff_output_item` from `executeHandoffCalls`
  // streams later still, before the NEXT round's `response.created`). So by
  // the time either `handoff_requested` or `handoff_occurred` lands, the
  // per-response `turnId` var above has already been reset to `undefined` by
  // `resetResponseState()` — this facet needs a tracker that SURVIVES that
  // reset to resolve "the round that requested the handoff" as the subagent
  // bracket's `parentTurnId`. Set once per genuinely-new round in
  // `ensureResponseOpen()`; never cleared on close (deliberately — that's
  // the whole point). Intermediate response rounds after a handoff continue
  // opening their OWN top-level turns from their own `response.id` (openai's
  // turn model) — the subagent pair BRACKETS the transfer, it does not
  // re-parent later rounds to it.
  let lastTopLevelTurnId: string | undefined;
  // Per-invoke ordinal for the synthetic subagent turnId (`turn_handoff_<n>`).
  let handoffOrdinal = 0;
  // FIFO queue of open handoff brackets awaiting their matching
  // `handoff_occurred` (paired turnId + the SAME parentTurnId `subagentStart`
  // used — `subagentDone` must replay it verbatim, mirroring the
  // claude-agent-sdk facet's paired start/done convention). Only one handoff
  // genuinely executes per round on the real wire (`executeHandoffCalls`
  // rejects the rest), so in practice at most one entry is ever open — FIFO
  // is the defensively-correct match rule regardless.
  const openHandoffs: { turnId: string; parentTurnId: string }[] = [];

  // Per-instance tool state (T5b — replaces the module-level statics for the factory path).
  // fc_… item id → model call_id correlation, populated by response.output_item.added
  // (the AUTHORITATIVE tool-start source per the canonical model, A1).
  const instanceCallIdByItemId = new Map<string, string>();
  // Accumulated function_call_arguments.delta fragments, keyed by fc_ item id.
  // The engine accumulates for downstream use; `.done.arguments` carries the full
  // string so argBuffers is primarily for the fallback path.
  const instanceArgBuffers = new Map<string, string>();

  // Refusal tracking (T5c — instance state mirroring the old module-level
  // `pendingRefusal`). Set when a `message_output_created` run-item carries a
  // `refusal` content part; the downstream `response.completed` arm then closes
  // the turn with `finishReason:"refusal"`. Cleared on every response close so it
  // never leaks across turns.
  let pendingRefusal = false;

  // ── Task 4b: defer a round's close past its pending tool results ───────────
  // (SPEC §5.0 INV-MSG). On the real wire, the `tool_output` run-item arrives
  // AFTER `response.completed` — closing at native-close time would put a later
  // `tool.done` on an already-sealed message / closed turn, which `reduce()`
  // correctly parks (resync). Per-turn pending set: toolCallIds that have had
  // `tool.start` emitted but no `tool.done` yet.
  const pendingToolsByTurn = new Map<string, Set<string>>();
  // toolCallId → the turnId it started under. `tool_output` may land after this
  // response's local `turnId` var has been reset (resetResponseState runs at
  // native-close time regardless of deferral) and/or after a NEW round has
  // opened, so the engine's #lastTurn backfill could misattribute a late result
  // to the wrong turn without this explicit map.
  const turnIdByToolCallId = new Map<string, string>();

  /**
   * Register `callId` as pending a `tool.done` under the CURRENT open turn
   * (Task 4b). Shared by the raw `response.output_item.added` function_call
   * path and the built-in Shell/Apply-Patch `tool_called` synthesis path
   * (playbook 2026-07-03 SDK-bump adaptation, Finding #1) — both start a call
   * whose result arrives via a LATER `tool_output` run-item. No-ops if no turn
   * is open (defensive; every caller already calls `ensureResponseOpen()` first).
   */
  function registerPendingTool(callId: string): void {
    if (turnId === undefined) return;
    let pending = pendingToolsByTurn.get(turnId);
    if (pending === undefined) {
      pending = new Set<string>();
      pendingToolsByTurn.set(turnId, pending);
    }
    pending.add(callId);
    turnIdByToolCallId.set(callId, turnId);
  }
  // A round's close is MORE than `closeTurnDone`: `reduce()`'s message.end
  // handler (SPEC §5.0 INV-MSG, same enforcement commit) clears the message's
  // open-pointer UNCONDITIONALLY — independent of turn state — so a `tool.done`
  // landing after `message.end` resync-parks just as surely as one landing
  // after `turn.done`. Deferring `turn.done` alone is NOT sufficient: closing
  // the message must be deferred too, or the late `tool.done` has nowhere live
  // to attach. So the stash captures everything `endOpenStreamsAndCloseMessage`
  // + `closeTurnDone` need — captured because `resetResponseState()` (which
  // always runs at native-close time, deferred or not) clears the local
  // `msgId`/`openTextStreams` vars before the drain can replay them.
  interface StashedRoundClose {
    msgId: string;
    openTextStreamIds: string[];
    fields: TurnDoneFields;
  }
  // Stashed close for a turn whose pending set was non-empty at close time,
  // keyed by turnId. Consumed the moment its pending set drains (emitted right
  // after the draining `tool.done`, same push() batch), or by `flush()`
  // verbatim if the result never arrives (the round genuinely completed — a
  // missing tool result must not swallow the close).
  const stashedCloseByTurn = new Map<string, StashedRoundClose>();

  /**
   * End open text streams + close the message + closeTurnDone for `tid`, using
   * whichever values are live right now (immediate path) or were captured at
   * defer time (drain path) — same three calls either way.
   */
  function emitRoundClose(tid: string, mId: string, textStreamIds: readonly string[], fields: TurnDoneFields): void {
    for (const streamId of textStreamIds) a.textEnd(streamId, mId);
    a.closeMessage(mId);
    a.closeTurnDone(tid, fields);
  }

  /**
   * Close the round now, unless `tid`'s pending-tool set is non-empty — in
   * which case stash everything the close needs (message id, dangling text
   * stream ids, turn.done fields) for the `tool_output` handler (or `flush()`)
   * to replay later. `closeTurnError` paths never call this (they close
   * immediately via `endOpenStreamsAndCloseMessage` — an errored round's
   * pending results are moot, by design).
   */
  function finishOrDeferRound(tid: string, mId: string, textStreamIds: readonly string[], fields: TurnDoneFields): void {
    const pending = pendingToolsByTurn.get(tid);
    if (pending !== undefined && pending.size > 0) {
      stashedCloseByTurn.set(tid, { msgId: mId, openTextStreamIds: [...textStreamIds], fields });
      return;
    }
    emitRoundClose(tid, mId, textStreamIds, fields);
  }

  /**
   * Open the turn + message exactly once per response. Uses the real `response.id`
   * (`turn_<id>`) when known; synthesizes a stable id only if `response.created` was
   * somehow absent (defensive — the spike confirms the id is always present at start).
   * Returns the close-once key (the real response.id, else the synthesized turnId),
   * or `undefined` when the response has already been closed (caller must no-op).
   */
  function ensureResponseOpen(respId?: string): string | undefined {
    // Already closed → never reopen (the duplicate `response.completed` lands here).
    if (respId !== undefined && closedResponses.has(respId)) return undefined;
    if (turnId !== undefined) {
      // Backfill the real id if it arrives after a defensive synthesized open.
      if (respId !== undefined && responseId === undefined) responseId = respId;
      return responseId ?? turnId;
    }
    responseId = respId;
    turnId = respId !== undefined ? `turn_${respId}` : `turn_${threadId}_${++turnCounter}`;
    msgId = `msg_${turnId}`;
    // Task 3 (audit M48 review, Finding 1): survives resetResponseState() —
    // see the closure-state doc above.
    lastTopLevelTurnId = turnId;
    a.openTurn(turnId, threadId);
    a.openMessage({ id: msgId, role: "assistant", turnId, threadId });
    return responseId ?? turnId;
  }

  /** Reset per-response state after a close. Marks the response closed (close-once). */
  function resetResponseState(): void {
    const key = responseId ?? turnId;
    if (key !== undefined) closedResponses.add(key);
    openTextStreams.clear();
    turnId = undefined;
    msgId = undefined;
    responseId = undefined;
    pendingRefusal = false;
  }

  /**
   * Close any dangling open message/turn (flush path: a stream ended before
   * `response.completed`). Ends open text streams, closes the message, and reuses
   * `resetResponseState` so the response is marked closed.
   */
  function closeResponse(): void {
    if (msgId !== undefined) {
      for (const streamId of openTextStreams) a.textEnd(streamId, msgId);
      a.closeMessage(msgId);
    }
    resetResponseState();
  }

  /** Drive the engine from one verbatim openai-node Responses event (snake_case). */
  function driveRawResponsesEvent(ev: OpenAIRawResponsesEvent): void {
    switch (ev.type) {
      case "response.created": {
        // Authoritative turn open — the real response.id is present at start.
        ensureResponseOpen(ev.response.id);
        return;
      }
      case "response.output_text.delta": {
        ensureResponseOpen();
        if (msgId === undefined) return; // unreachable post-ensure; satisfies the narrowing
        if (!openTextStreams.has(ev.item_id)) {
          openTextStreams.add(ev.item_id);
          a.textStart(ev.item_id, msgId, { role: "assistant" });
        }
        // OpenAI text deltas are suffix-only fragments (cumulative:false, the default).
        a.textDelta(ev.item_id, msgId, ev.delta, { cumulative: false });
        return;
      }
      case "response.output_text.done": {
        // NO-OP (audit M22): the citations carrier — `message_output_created` — is
        // the authoritative text-end source (it also reports refusal parts and
        // arrives with the annotated part, so closing here would emit `text.end`
        // BEFORE citations are known). The stream stays in `openTextStreams`;
        // `driveMessageOutputCreated` closes it (with citations if present), or —
        // defensively, if that run-item never arrives — `closeResponse()` /
        // `endOpenStreamsAndCloseMessage()` / `emitRoundClose()` do at native close.
        return;
      }
      case "response.output_item.added": {
        // Authoritative tool-start source (canonical model, A1 §"Spike Findings").
        // Only function_call items carry a tool name + call_id; other item types
        // (message, reasoning) are no-op'd here — their lifecycle is handled elsewhere.
        if (ev.item.type === "function_call" && ev.item.call_id !== undefined && ev.item.name !== undefined) {
          const fcId = ev.item.id;
          const callId = ev.item.call_id;
          ensureResponseOpen();
          // Record the fc_→call_id correlation (the raw argument events carry only
          // the fc_ item id, not the call_id; this mapping allows recovery).
          instanceCallIdByItemId.set(fcId, callId);
          a.toolStart({
            toolCallId: callId,
            name: ev.item.name,
            itemId: fcId,
            messageId: msgId,
          });
          // Task 4b: this call is now pending a tool.done under the current turn
          // (ensureResponseOpen() above guarantees `turnId` is defined here).
          registerPendingTool(callId);
        }
        return;
      }
      case "response.function_call_arguments.delta": {
        // Accumulate the fragment per fc_ item id (spec §8.1).
        const prevDelta = instanceArgBuffers.get(ev.item_id) ?? "";
        instanceArgBuffers.set(ev.item_id, prevDelta + ev.delta);
        // Resolve to call_id for the engine (fall back to fc_ id defensively).
        const callIdDelta = instanceCallIdByItemId.get(ev.item_id) ?? ev.item_id;
        a.toolArgsDelta(callIdDelta, ev.delta, { cumulative: false });
        return;
      }
      case "response.function_call_arguments.done": {
        // Seal accumulated buffer → toolArgsAssembled. Prefer the event's full
        // `arguments` string (the engine accumulates the delta path); fall back to
        // the instance buffer when the done event omits it (defensive).
        //
        // `ev.arguments` is typed `string`, but this is the deserialization
        // boundary (audit M46, §2.B): a nonconforming provider (OpenRouter et
        // al.) can hand back an empty string, truncated JSON, or omit the
        // field entirely — `JSON.parse` throws `SyntaxError` on the first two
        // and `.length` throws `TypeError` on the third, all three of which
        // used to escape push() uncaught. Widen the local binding (no cast —
        // the boundary genuinely can hand back less than the type promises)
        // and guard the parse: on any failure, degrade to a best-effort
        // `tool.args.assembled` with `input:{}` (keeps the tool-call block
        // fold-coherent, Tenet 6) and route the untouched raw signal through
        // `ext.openai.unparsed` instead of throwing — an explicit `null`
        // marker distinguishes "field never arrived" from "field arrived
        // empty" (`""`), both preserved losslessly.
        const rawArguments: string | undefined = ev.arguments;
        const buffered = instanceArgBuffers.get(ev.item_id) ?? "";
        const candidate =
          rawArguments !== undefined && rawArguments.length > 0 ? rawArguments : buffered;
        const callIdDone = instanceCallIdByItemId.get(ev.item_id) ?? ev.item_id;
        let input: JsonValue;
        try {
          input = JsonValue.parse(JSON.parse(candidate));
        } catch {
          input = {};
          a.emitExt("openai", "unparsed", { itemId: ev.item_id, arguments: rawArguments ?? null });
        }
        a.toolArgsAssembled(callIdDone, input);
        instanceArgBuffers.delete(ev.item_id);
        return;
      }
      case "response.completed":
      case "response.incomplete": {
        // Terminal close — guard close-once (the SDK emits completed TWICE). A
        // `undefined` return means this response is already closed → no-op the dupe.
        if (ensureResponseOpen(ev.response.id) === undefined) return;
        if (turnId === undefined) return; // unreachable post-ensure; satisfies narrowing
        if (msgId === undefined) return; // unreachable post-ensure; satisfies narrowing
        // Snapshot before any deferral: `resetResponseState()` below always
        // clears these, but a deferred close needs them later (Task 4b).
        const currentTurnId = turnId;
        const currentMsgId = msgId;
        const textStreamIds = Array.from(openTextStreams);
        const reason = ev.response.incomplete_details?.reason;
        const usage = mapUsage(ev.response.usage);
        // Decision tree (mirrors the canonical model, A1):
        //   refusal recorded         → closeTurnDone success, finishReason:"refusal"
        //   content_filter           → closeTurnDone error-outcome + safety signal
        //   any other incomplete     → closeTurnError{code:reason, usage}
        //   plain completed          → closeTurnDone success
        // Task 4b: every closeTurnDone arm below routes through
        // `finishOrDeferRound` — a round with pending tool results stashes its
        // ENTIRE close (message + turn) instead of emitting (INV-MSG).
        // closeTurnError does NOT defer (an errored round's pending results are
        // moot, by design) — it still closes the message immediately here.
        if (pendingRefusal) {
          finishOrDeferRound(currentTurnId, currentMsgId, textStreamIds, {
            outcome: { type: "success" },
            finishReason: "refusal",
            ...(usage !== undefined ? { usage } : {}),
          });
        } else if (reason === "content_filter") {
          const safety: AgSafety[] = [{ category: "content_filter", blocked: true }];
          finishOrDeferRound(currentTurnId, currentMsgId, textStreamIds, {
            outcome: { type: "error", message: "content_filter" },
            finishReason: mapFinishReason(reason),
            safety,
            ...(usage !== undefined ? { usage } : {}),
          });
        } else if (ev.type === "response.incomplete") {
          endOpenStreamsAndCloseMessage();
          a.closeTurnError(currentTurnId, {
            message: reason ?? "incomplete",
            ...(reason !== undefined ? { code: reason } : {}),
            ...(usage !== undefined ? { usage } : {}),
          });
        } else {
          finishOrDeferRound(currentTurnId, currentMsgId, textStreamIds, {
            outcome: { type: "success" },
            finishReason: mapFinishReason(reason),
            ...(usage !== undefined ? { usage } : {}),
          });
        }
        resetResponseState();
        return;
      }
      case "response.failed": {
        // The response itself failed (rate limit, server error, …). Close-once guard.
        if (ensureResponseOpen(ev.response.id) === undefined) return;
        if (turnId === undefined) return; // unreachable post-ensure; satisfies narrowing
        endOpenStreamsAndCloseMessage();
        const err = ev.response.error;
        a.closeTurnError(turnId, {
          message: err?.message ?? "response.failed",
          ...(err?.code !== undefined ? { code: err.code } : {}),
        });
        resetResponseState();
        return;
      }
      case "error": {
        // Top-level NON-terminal advisory (spec §4 bare `error`). It does NOT close
        // the turn — surface it on the lossless vendor channel without disturbing the
        // open response lifecycle.
        a.emitExt("openai", "error", {
          message: ev.message,
          ...(ev.code !== undefined ? { code: ev.code } : {}),
        });
        return;
      }
      // Duplicate raw families IGNORED per the canonical model:
      //   response.output_text.done is its own no-op arm above (audit M22);
      //   response.output_item.done, response.in_progress, content_part.* are not
      //   authoritative sources.
      default:
        return;
    }
  }

  /** End any still-open text streams (defensive), then close the open message. */
  function endOpenStreamsAndCloseMessage(): void {
    if (msgId !== undefined) {
      for (const streamId of openTextStreams) a.textEnd(streamId, msgId);
      a.closeMessage(msgId);
    }
  }

  /**
   * Map a `message_output_created` run-item: the AUTHORITATIVE text-end +
   * citations source (audit M22). The text itself already streamed from the raw
   * `response.output_text.delta` path — this MUST NOT re-emit it — but the
   * `output_text` part's annotations are only known here (they are not present on
   * `response.output_text.done`), so THIS is where the matching open text stream
   * actually closes: `a.textEnd(id, msgId, { citations })`, citations attached
   * directly to the streamed block (never a duplicate id-less supplement). A
   * `refusal` part sets `pendingRefusal` so the downstream `response.completed`
   * arm closes with `finishReason:"refusal"` (no text stream to close for it).
   *
   * Correlation: the Responses `item_id` used by the raw delta/done events and the
   * run-item wrapper's `rawItem.id` are DIFFERENT id spaces on this SDK's surface,
   * so the match is positional — FIFO against `openTextStreams` (insertion-ordered;
   * in practice exactly one open stream per output_text part).
   *
   * On the real wire this run-item can arrive AFTER `response.completed` (verified
   * by the #128 OpenRouter capture — round 2's `message_output_created` lands last,
   * past the terminal close). Never `ensureResponseOpen()` here: doing so would
   * open a PHANTOM new turn once the response has already closed. If `msgId` is
   * `undefined` (already closed) the matching stream was already ended — without
   * citations — by the native-close fallback (`emitRoundClose` et al.); degrade
   * gracefully and skip the `text.end` re-target. If the late part still carries
   * annotations, though, they are NOT yet lost anywhere else — silently dropping
   * them here would violate Tenet 6. Route them losslessly through the facet's
   * existing unparsed/ext convention instead: `ext.openai.late-citations` carrying
   * the run-item id + the raw annotations array verbatim (review finding on M22).
   * A part with no annotations has nothing to lose — the plain `continue` stays.
   *
   * ID-LESS SYNTHESIZED MESSAGE (agents-core ≥0.13.2): `errorHandlers.
   * invalidFinalOutput` recovery pushes a final assistant message built by
   * `createRunErrorFinalOutputItem` (errorHandlers.mjs:23 → helpers/message.mjs:
   * 45-59) — `{type:"message", role:"assistant", status:"completed", content:
   * [{type:"output_text", text}]}` with NO `id`, NO annotations, and NO preceding
   * `response.output_text.delta` events (the handler synthesizes the text; it
   * never streamed). It arrives past the terminal close, where the drop points
   * below would eat its text — a completed turn whose SDK-reported final output
   * never reaches AgJSON (Tenet 6 violation). Every message the model itself
   * produces carries an id on this seam (`msg_…`/`msg_tmp_…`, #128 capture), so
   * `item.id === undefined` discriminates "this text never streamed". Id-less
   * parts are handled FIRST and never enter the FIFO stream match: pairing a
   * never-streamed part against an open stream would close the model's own
   * stream against the wrong text (and drop the synthesized text with it).
   * Routing: text → `ext.openai.late-message` (with the retained top-level
   * turnId as the `forTurnId` fold anchor); annotations (none in practice for the synthesized
   * item, but structurally possible) keep riding the DOCUMENTED
   * `ext.openai.late-citations` channel — late-message never absorbs it.
   * Never emit real text.start/delta/end here — fabricating a stream id for a
   * block the wire never streamed is exactly the correlation-invention Tenet 6
   * forbids, and grafting text onto a closed turn breaks INV-MSG at the
   * Reducer. Cost of the discriminator on a hypothetical provider that omits
   * message ids on genuinely-streamed text: one redundant vendor ext event —
   * never a duplicated or corrupted core stream.
   */
  function driveMessageOutputCreated(item: OpenAIAssistantMessageItem): void {
    for (const part of item.content) {
      if (part.type === "refusal") {
        pendingRefusal = true;
        continue;
      }
      if (part.type === "output_text") {
        if (item.id === undefined) {
          // Id-less ⇒ synthesized, never streamed — see doc above. The typeof
          // guard is load-bearing: rawItem is envelope-only-validated wire
          // data, and push() must never throw (Tenet 6).
          if (typeof part.text === "string" && part.text.length > 0) {
            // `forTurnId`, not `turnId`: the envelope's `turnId` is a RESERVED
            // ext key (engine-owned; a payload `turnId` would relocate under
            // `shadowed` per the M49 anti-clobber).
            const anchor = turnId ?? lastTopLevelTurnId;
            a.emitExt("openai", "late-message", {
              text: part.text,
              ...(anchor !== undefined ? { forTurnId: anchor } : {}),
            });
          }
          if (part.annotations !== undefined && part.annotations.length > 0) {
            a.emitExt("openai", "late-citations", {
              annotations: JsonValue.parse(part.annotations),
            });
          }
          continue;
        }
        if (msgId === undefined) {
          // response already closed — see doc above.
          if (part.annotations !== undefined && part.annotations.length > 0) {
            a.emitExt("openai", "late-citations", {
              itemId: item.id,
              annotations: JsonValue.parse(part.annotations),
            });
          }
          continue;
        }
        const streamId = openTextStreams.values().next().value;
        if (streamId === undefined) continue; // defensive: no matching open stream
        openTextStreams.delete(streamId);
        const citations = mapAnnotationsToCitations(part.annotations, part.text);
        a.textEnd(streamId, msgId, citations !== undefined ? { citations } : undefined);
      }
    }
  }

  /**
   * Map a `reasoning_item_created` run-item (Task 3, audit M48): the SOLE source
   * for reasoning content on this seam — `response.output_item.added` only special-
   * cases `item.type==="function_call"` (canonical model, A1); it carries no
   * `content`/`providerData` for a `reasoning` item, so it structurally cannot
   * supply the summary text or the ZDR blob and is left untouched (single-source
   * per concern, no double-emit).
   *
   * The run-item wrapper delivers the reasoning item as ONE completed unit (unlike
   * the incremental text/tool-arg deltas elsewhere in this facet), so
   * start/delta/end/opaque all fire together, in that order, from this single call:
   *  - `reasoning.start`  — opens the block; `itemId` carries the `rs_…` id.
   *  - `reasoning.delta`  — the joined `input_text` parts, only if non-empty.
   *  - `reasoning.end`    — closes the block.
   *  - `reasoning.opaque` — ONLY when `providerData.encrypted_content` is present:
   *    the OpenAI ZDR (`store:false`) stateless-replay blob (spec §8.2/§10.4),
   *    `kind:"ciphertext"`, with `itemId` carrying the `rs_…` id again (REPLAY-
   *    LOAD-BEARING — `reduce()`'s `reasoning.opaque` handler sets `block.itemId`
   *    from it, spec §4 row for `reasoning.opaque`).
   *
   * `id`/`itemId` reuse the `rs_…` item id (falling back to a fixed placeholder
   * only in the defensive case the id is absent — mirrors the original T5 port,
   * commit c1f6f71, since deleted unported until this task).
   *
   * `reasoningStart`/`reasoningOpaque` carry `itemId`, which the StreamAssembler
   * sugar methods do not expose a parameter for (only `reasoningDelta`/
   * `reasoningEnd` are used via sugar) — `a.emit()` is the documented base
   * primitive for exactly this case (StreamAssembler docstring: "guarantees no
   * AgClosedEventType is ever unreachable").
   *
   * Mirrors `driveMessageOutputCreated`/`tool_output`: assumes the response is
   * already open (every response always opens via `response.created` before any
   * run-item can arrive) rather than calling `ensureResponseOpen()` — reopening
   * here would risk a phantom turn on a late arrival. If `msgId` is undefined
   * (response already closed) this degrades gracefully — but NOT to a bare no-op
   * when there is something REPLAY-LOAD-BEARING to lose: a plain summary-text-only
   * late arrival has nothing irrecoverable to drop (the reasoning block itself
   * never got opened, so `reasoning.start`/`.delta`/`.end` staying unemitted is the
   * correct degrade), but the `rs_`/`encrypted_content` ZDR blob (spec §8.2/§10.4)
   * is exactly the kind of payload Tenet 6 exists for — silently dropping it here
   * was a genuine loss (review finding on M48). Mirrors `ext.openai.late-citations`
   * (M22) exactly: route it through the lossless vendor channel instead of the bare
   * return.
   */
  function driveReasoningItemCreated(item: OpenAIReasoningItem): void {
    if (msgId === undefined) {
      // response already closed — see doc above.
      const lateEncrypted = item.providerData?.encrypted_content;
      if (typeof lateEncrypted === "string" && lateEncrypted.length > 0) {
        a.emitExt("openai", "late-reasoning", {
          ...(item.id !== undefined ? { itemId: item.id } : {}),
          encryptedContent: lateEncrypted,
        });
      }
      return;
    }
    const id = item.id ?? "reasoning";
    const itemId = item.id;
    const text = item.content.map((p) => p.text).join("");
    a.emit({ type: "reasoning.start", id, messageId: msgId, ...(itemId !== undefined ? { itemId } : {}) });
    if (text.length > 0) a.reasoningDelta(id, msgId, text);
    a.reasoningEnd(id, msgId);
    const encrypted = item.providerData?.encrypted_content;
    if (typeof encrypted === "string" && encrypted.length > 0) {
      a.emit({
        type: "reasoning.opaque",
        id,
        messageId: msgId,
        kind: "ciphertext",
        value: encrypted,
        provider: "openai",
        ...(itemId !== undefined ? { itemId } : {}),
      });
    }
  }

  /** Resolve the turn a pending tool call started under (Task 4b) — a plain
   *  lookup, no side effects; call BEFORE `a.toolDone` so its `turnId` field
   *  can be set explicitly (the result may land after a later round opened). */
  function resolvePendingTurnId(callId: string): string | undefined {
    return turnIdByToolCallId.get(callId);
  }

  /**
   * After `a.toolDone` has fired for `callId` under `doneTurnId`, clear the
   * pending bookkeeping and — if the turn's pending set just drained to empty
   * — replay any stashed deferred round-close (Task 4b, INV-MSG). Shared by
   * the `function_call` `tool_output` arm and the built-in Shell/Apply-Patch
   * `tool_output` arm (playbook 2026-07-03 SDK-bump adaptation, Finding #1).
   */
  function drainPendingTool(callId: string, doneTurnId: string | undefined): void {
    if (doneTurnId === undefined) return;
    turnIdByToolCallId.delete(callId);
    const pending = pendingToolsByTurn.get(doneTurnId);
    if (pending === undefined) return;
    pending.delete(callId);
    if (pending.size === 0) {
      const stashed = stashedCloseByTurn.get(doneTurnId);
      if (stashed !== undefined) {
        // The pending set just drained — emit the deferred message.end +
        // turn.done immediately after this tool.done, same push() batch
        // (INV-MSG: the message must still be open when tool.done lands, so
        // message.end waits for this too).
        stashedCloseByTurn.delete(doneTurnId);
        emitRoundClose(doneTurnId, stashed.msgId, stashed.openTextStreamIds, stashed.fields);
      }
    }
  }

  /** True if any shell command in `entries` timed out or exited non-zero. */
  function shellOutputHasError(entries: readonly OpenAIShellCallOutputContent[]): boolean {
    for (const entry of entries) {
      if (entry.outcome.type === "timeout") return true;
      if (entry.outcome.type === "exit" && entry.outcome.exitCode !== 0) return true;
    }
    return false;
  }

  /**
   * Map a `tool_output` run-item whose `rawItem` is a Shell, Apply-Patch, or
   * Computer-Use result (playbook 2026-07-03 SDK-bump adaptation, Finding #1;
   * `computer_call_result` added by the fixture-drift ratchet finding, same
   * date). These do NOT share `OpenAIFunctionCallResultItem`'s `output` shape
   * (a bare string / content-part union) — `shell_call_output.output` is an
   * ARRAY of per-command `{stdout,stderr,outcome}` records,
   * `apply_patch_call_output.output` is an optional bare string,
   * `computer_call_result.output` is a `{type:"computer_screenshot", data}`
   * base64-PNG record — so they need their OWN mapping, not
   * `toolOutputToAgBlocks` (that was the orphan hazard: calling the generic
   * function_call mapper on these shapes silently produced EMPTY content,
   * since none of these record types has the `.type === "text"` discriminant
   * `toolOutputToAgBlocks` checks for).
   */
  function driveBuiltinToolOutput(
    rawItem: OpenAIShellCallResultItem | OpenAIApplyPatchCallResultItem | OpenAIComputerCallResultItem,
  ): void {
    const toolCallId = rawItem.callId;
    let content: AgBlock[];
    let outcome: ToolOutcome;
    let structuredContent: JsonValue | undefined;
    if (rawItem.type === "shell_call_output") {
      content = [];
      for (const entry of rawItem.output) {
        const text = [entry.stdout, entry.stderr].filter((s) => s.length > 0).join("\n");
        if (text.length > 0) content.push({ type: "text", text });
      }
      outcome = shellOutputHasError(rawItem.output) ? "error" : "ok";
      // The full per-command record (stdout/stderr/exit code) is lossy to
      // collapse into text-only content — carry it verbatim as structuredContent
      // too (mirrors the function_call path's ggui-cache-marker precedent).
      structuredContent = JsonValue.parse(rawItem.output);
    } else if (rawItem.type === "computer_call_result") {
      // spec §8 item 20's extended discriminant: the screenshot is base64 image
      // data, not text — land it as an AgBlock `file` block (AgSource's
      // `base64` arm) rather than dropping it via the text-only path.
      content = [
        {
          type: "file",
          source: { type: "base64", mediaType: "image/png", data: rawItem.output.data },
          filename: "screenshot.png",
        },
      ];
      // No status/error discriminant exists on this wire arm (unlike shell/apply-patch).
      outcome = "ok";
    } else {
      content = rawItem.output !== undefined && rawItem.output.length > 0 ? [{ type: "text", text: rawItem.output }] : [];
      outcome = rawItem.status === "failed" ? "error" : "ok";
    }
    const doneTurnId = resolvePendingTurnId(toolCallId);
    a.toolDone({
      toolCallId,
      content,
      outcome,
      isError: outcome === "error",
      ...(structuredContent !== undefined ? { structuredContent } : {}),
      ...(doneTurnId !== undefined ? { turnId: doneTurnId } : {}),
    });
    drainPendingTool(toolCallId, doneTurnId);
  }

  /** Synthesize `name` for the built-in discriminants that carry none on the
   *  wire (§8 quirk) — `shell_call`/`apply_patch_call`/`computer_call` have no
   *  `name` field at all; `hosted_tool_call` already carries a real one. */
  function builtinToolName(
    rawItem: OpenAIShellCallItem | OpenAIApplyPatchCallItem | OpenAIComputerCallItem | OpenAIHostedToolCallItem,
  ): string {
    if (rawItem.type === "shell_call") return "builtin:shell";
    if (rawItem.type === "apply_patch_call") return "builtin:apply_patch";
    if (rawItem.type === "computer_call") return "builtin:computer";
    return rawItem.name;
  }

  /** Parse a JSON-string tool argument at the deserialization boundary,
   *  degrading gracefully (Tenet 6) rather than throwing on malformed input —
   *  mirrors `response.function_call_arguments.done`'s established degrade
   *  path (audit M46). */
  function parseJsonArguments(itemId: string | undefined, raw: string | undefined): JsonValue {
    if (raw === undefined || raw.length === 0) return {};
    try {
      return JsonValue.parse(JSON.parse(raw));
    } catch {
      a.emitExt("openai", "unparsed", { itemId: itemId ?? null, arguments: raw });
      return {};
    }
  }

  /**
   * Map a `tool_called` run-item whose `rawItem` is one of OpenAI's native
   * built-in tool call shapes (Shell / Apply-Patch / Computer-Use / Hosted-tool
   * — playbook 2026-07-03 SDK-bump adaptation, Finding #1; `computer_call`
   * added by the fixture-drift ratchet finding, same date). Unlike
   * `function_call` (whose tool-start rides the raw `response.output_item.
   * added` stream — the authoritative source, canonical model A1), this
   * run-item wrapper is the SOLE source for these four: `shell_call`/
   * `apply_patch_call`/`computer_call` carry no per-fragment argument-delta
   * stream on this seam (no equivalent of
   * `response.function_call_arguments.delta` exists for them — the whole
   * action/operation arrives complete on this one wrapper), and
   * `hosted_tool_call` has no raw-wire literal AT ALL (see its own doc — it is
   * an agents-core-internal umbrella normalized only at this run-item layer).
   * `ensureResponseOpen()` mirrors the raw function_call path's treatment
   * (both are tool-START signals expected EARLY in a round, unlike the
   * LATE-arriving `tool_output`/`message_output_created` run-items this file
   * already documents) — residual ordering risk if a future capture shows
   * otherwise is flagged in the adaptation report, not silently assumed away.
   *
   * `shell_call`/`apply_patch_call`/`computer_call` are PENDING calls (their
   * result arrives via a LATER `tool_output` run-item, same Task-4b
   * deferred-round-close discipline as `function_call`) — registered via
   * `registerPendingTool`. `hosted_tool_call` is different: OpenAI's hosted
   * tools execute server-side within the SAME model turn, so the item is
   * already resolved (`output` present) by the time this wrapper streams —
   * `tool.start` + `tool.done` fire together from this ONE event (see its own
   * doc) — no pending registration.
   */
  function driveBuiltinToolCalled(
    rawItem: OpenAIShellCallItem | OpenAIApplyPatchCallItem | OpenAIComputerCallItem | OpenAIHostedToolCallItem,
  ): void {
    ensureResponseOpen();
    if (msgId === undefined) return; // unreachable post-ensure; satisfies narrowing
    const toolCallId = rawItem.type === "hosted_tool_call" ? (rawItem.id ?? rawItem.name) : rawItem.callId;
    const name = builtinToolName(rawItem);
    a.toolStart({
      toolCallId,
      name,
      ...(rawItem.id !== undefined ? { itemId: rawItem.id } : {}),
      messageId: msgId,
    });
    const input: JsonValue =
      rawItem.type === "shell_call"
        ? JsonValue.parse(rawItem.action)
        : rawItem.type === "apply_patch_call"
          ? JsonValue.parse(rawItem.operation)
          : rawItem.type === "computer_call"
            ? JsonValue.parse(rawItem.actions ?? rawItem.action ?? {})
            : parseJsonArguments(rawItem.id, rawItem.arguments);
    a.toolArgsDelta(toolCallId, JSON.stringify(input));
    a.toolArgsAssembled(toolCallId, input);
    if (rawItem.type === "hosted_tool_call") {
      const content: AgBlock[] =
        rawItem.output !== undefined && rawItem.output.length > 0 ? [{ type: "text", text: rawItem.output }] : [];
      a.toolDone({ toolCallId, content, outcome: "ok" });
      return;
    }
    registerPendingTool(toolCallId);
  }

  /**
   * Resolve the correlation id for a `tool_search_call`/`tool_search_output`
   * pair — matches agents-core 0.12.0's own id-fallback chain exactly
   * (`dist/tooling.mjs`'s `getToolSearchProviderCallId`/`getToolSearchMatchKey`:
   * `providerData.call_id ?? providerData.callId ?? call_id ?? callId ?? id`),
   * with providerData fields checked FIRST. Stops short of the SDK's blind FIFO
   * positional fallback (used by the real runtime only when NEITHER a field NOR
   * `id` resolves on EITHER side of a pairing — not something this per-event
   * facet can safely replicate: blindly popping the oldest pending call would
   * risk silently correlating two UNRELATED tool_search calls with no supporting
   * id at all). Returns undefined when genuinely unresolvable — the caller
   * degrades to `ext.openai.unparsed` rather than fabricating a correlation id
   * (Tenet 6).
   */
  function resolveToolSearchCallId(
    rawItem: OpenAIToolSearchCallItem | OpenAIToolSearchOutputItem,
  ): string | undefined {
    const providerData = rawItem.providerData;
    if (isJsonObject(providerData)) {
      if (typeof providerData.call_id === "string" && providerData.call_id.length > 0) return providerData.call_id;
      if (typeof providerData.callId === "string" && providerData.callId.length > 0) return providerData.callId;
    }
    if (typeof rawItem.call_id === "string" && rawItem.call_id.length > 0) return rawItem.call_id;
    if (typeof rawItem.callId === "string" && rawItem.callId.length > 0) return rawItem.callId;
    if (typeof rawItem.id === "string" && rawItem.id.length > 0) return rawItem.id;
    return undefined;
  }

  /**
   * Map a `tool_search_called` run-item (fixture-drift ratchet disposition,
   * 2026-07-03 — the manifest's four `tool_search_*` entries flip from
   * `carried` to `handled`). A DEDICATED event name, not a `tool_called`
   * reuse (see `OpenAIToolSearchCalledEvent`'s doc) — this run-item wrapper
   * is the SOLE tool-start source (no raw-stream literal exists for it, same
   * rationale as `hosted_tool_call`/shell/apply-patch/computer). `arguments`
   * (`z.ZodUnknown`) is carried through verbatim like `computer_call`'s
   * `action`/`actions` (never JSON.parsed — it is not a JSON STRING like
   * `FunctionCallItem.arguments`). Registers as a PENDING tool (Task 4b
   * discipline) — the paired `tool_search_output_created` typically lands in
   * the SAME step (server-hosted execution, or synchronously-resolved client
   * execution — see the file header's wire-truth citations), but if the
   * call's execution can't be resolved this turn (no client `toolSearchTool`
   * configured and no immediate hosted-server output), it may never arrive —
   * the existing INV-FLUSH stream-truncation handling degrades that exactly
   * like any other unresolved pending tool call, no special-casing needed.
   */
  function driveToolSearchCalled(rawItem: OpenAIToolSearchCallItem): void {
    ensureResponseOpen();
    if (msgId === undefined) return; // unreachable post-ensure; satisfies narrowing
    const toolCallId = resolveToolSearchCallId(rawItem);
    if (toolCallId === undefined) {
      // Genuinely unresolvable correlation id — never fabricate one (Tenet 6).
      a.emitExt("openai", "unparsed", { name: "tool_search_called", item: JsonValue.parse(rawItem) });
      return;
    }
    a.toolStart({
      toolCallId,
      name: "builtin:tool_search",
      ...(rawItem.id !== undefined ? { itemId: rawItem.id } : {}),
      messageId: msgId,
    });
    const input: JsonValue = JsonValue.parse(rawItem.arguments ?? {});
    a.toolArgsDelta(toolCallId, JSON.stringify(input));
    a.toolArgsAssembled(toolCallId, input);
    registerPendingTool(toolCallId);
  }

  /**
   * Map a `tool_search_output_created` run-item — the paired completion (see
   * `OpenAIToolSearchOutputItem`'s doc). `tools` is a structured retrieval
   * listing (tool references/definitions), never natural-language text —
   * carried verbatim as a single AgBlock `data` block (the spec's escape
   * hatch for structured non-text tool content) rather than inventing a text
   * rendering with no wire precedent; this is ALREADY full-fidelity (no lossy
   * collapse occurs, unlike `shell_call_output`'s stdout/stderr join), so no
   * separate `structuredContent` duplicate is needed. No error discriminant
   * exists on this wire's free-form `status` string — mirrors
   * `computer_call_result`'s identical precedent: every occurrence maps to
   * `outcome:"ok"`.
   */
  function driveToolSearchOutput(rawItem: OpenAIToolSearchOutputItem): void {
    const toolCallId = resolveToolSearchCallId(rawItem);
    if (toolCallId === undefined) {
      a.emitExt("openai", "unparsed", { name: "tool_search_output_created", item: JsonValue.parse(rawItem) });
      return;
    }
    const content: AgBlock[] = [{ type: "data", name: "tool_search_results", data: JsonValue.parse(rawItem.tools) }];
    const doneTurnId = resolvePendingTurnId(toolCallId);
    a.toolDone({
      toolCallId,
      content,
      outcome: "ok",
      ...(doneTurnId !== undefined ? { turnId: doneTurnId } : {}),
    });
    drainPendingTool(toolCallId, doneTurnId);
  }

  /**
   * Map the synthetic `__host_error__` sentinel (host feeds it on
   * `MaxTurnsExceededError`) to a terminal `turn.error{code, message, usage}`.
   *  - A response turn is OPEN → close THAT turn (end streams, close message,
   *    closeTurnError) so the error lands on the well-formed open turn.
   *  - NO turn open (max_turns fired after the last response already completed) →
   *    open a FRESH terminal turn via `ensureResponseOpen()` (which emits a
   *    `turn.start` + `message.start` — `closeTurnError` alone does NOT synthesize
   *    `turn.start`, so a bare close would leave a malformed start-less turn),
   *    close its message, then closeTurnError. Either way the error is emitted on
   *    a turn that has a `turn.start`.
   */
  function driveHostError(event: OpenAIHostError): void {
    ensureResponseOpen();
    if (turnId === undefined) return; // unreachable post-ensure; satisfies narrowing
    endOpenStreamsAndCloseMessage();
    a.closeTurnError(turnId, {
      message: event.message,
      code: event.code,
      ...(event.usage !== undefined ? { usage: event.usage } : {}),
    });
    resetResponseState();
  }

  /** Drive the engine from one (already-narrowed) OpenAIStreamEvent. */
  function drive(event: OpenAIStreamEvent): void {
    if (event.type === "__host_error__") {
      driveHostError(event);
      return;
    }
    if (event.type === "run_item_stream_event") {
      // Widened reference for the switch's `default` arm — see OpenAIRunItemEvent's
      // docstring (Task 3, audit M48).
      const runItemEvent: OpenAIRunItemEvent = event;
      switch (event.name) {
        case "tool_output": {
          const rawItem = event.item.rawItem;
          // Finding #1 (critical) + the fixture-drift ratchet's
          // computer_call_result finding: Shell/Apply-Patch/Computer-Use
          // results do NOT share `OpenAIFunctionCallResultItem.output`'s shape
          // — see `driveBuiltinToolOutput`'s doc for why the generic path
          // below is wrong for them (the orphan-hazard this adaptation fixes).
          if (
            rawItem.type === "shell_call_output" ||
            rawItem.type === "apply_patch_call_output" ||
            rawItem.type === "computer_call_result"
          ) {
            driveBuiltinToolOutput(rawItem);
            return;
          }
          // Authoritative tool-result source (canonical model, A1). Drives toolDone
          // with content + structuredContent (the ggui cache marker — see
          // `extractStructuredContent`'s doc for the two peer-supported homes and
          // the playbook 2026-07-03 wire-truth findings behind them).
          const outcome: ToolOutcome = rawItem.status === "incomplete" ? "error" : "ok";
          const content = toolOutputToAgBlocks(rawItem.output);
          const structuredContent = extractStructuredContent(event.item.output, event.item.customData);
          // Task 4b: resolve the OWNING turn explicitly (this result may land
          // after a later round has opened, so the engine's #lastTurn backfill
          // could misattribute it) and pass it through so toolDone binds to the
          // correct — possibly already-closed-pending-this-result — turn.
          const doneTurnId = resolvePendingTurnId(rawItem.callId);
          a.toolDone({
            toolCallId: rawItem.callId,
            content,
            outcome,
            isError: rawItem.status === "incomplete",
            ...(structuredContent !== undefined ? { structuredContent } : {}),
            ...(doneTurnId !== undefined ? { turnId: doneTurnId } : {}),
          });
          drainPendingTool(rawItem.callId, doneTurnId);
          return;
        }
        case "message_output_created":
          // CITATIONS SUPPLEMENT only — the text already streamed from the raw delta
          // (canonical model, A1). Records refusal + emits citation blocks; no text.
          driveMessageOutputCreated(event.item.rawItem);
          return;
        case "tool_called": {
          const rawItem = event.item.rawItem;
          if (rawItem.type === "function_call") {
            // IGNORED — superseded by model:response.output_item.added, which is
            // the authoritative tool-start source (canonical model, A1
            // §"Spike Findings").
            return;
          }
          // Finding #1 (critical): Shell / Apply-Patch / Hosted-tool built-ins
          // — this run-item wrapper (not the raw stream) is the SOLE tool-start
          // source for these three (see `driveBuiltinToolCalled`'s doc).
          driveBuiltinToolCalled(rawItem);
          return;
        }
        case "tool_search_called":
          // Fixture-drift ratchet disposition (2026-07-03) — a DEDICATED
          // event name (not a `tool_called` reuse). See
          // `driveToolSearchCalled`'s doc for the full lifecycle rationale.
          driveToolSearchCalled(event.item.rawItem);
          return;
        case "tool_search_output_created":
          driveToolSearchOutput(event.item.rawItem);
          return;
        case "reasoning_item_created":
          // SOLE source for reasoning content — see driveReasoningItemCreated's
          // docstring for the single-sourcing rationale (Task 3, audit M48).
          driveReasoningItemCreated(event.item.rawItem);
          return;
        case "handoff_requested": {
          // Task 3 (audit M48 review, Finding 1) handoff mapping — FALSE-PREMISE
          // FIX. The original mapping (a standalone `handoff` event) assumed the
          // wire carried no completion signal for a handoff, so a `subagentStart`
          // that MUST be matched by `subagentDone` couldn't be used safely (an
          // unmatched one gets INV-FLUSH-aborted as `turn.abort{reason:"stream-
          // truncated"}`, audit M21 — misrepresenting a genuinely-completed
          // handoff). That premise was FALSE: `handoff_occurred` IS the
          // completion signal (verified against the installed `@openai/agents`
          // 0.2.1 peer dep's `events.d.ts` — `RunItemStreamEventName` includes
          // `'handoff_occurred'`). So the nested-turn lifecycle IS determinable:
          // bracket the transfer with `subagentStart` now / `subagentDone` at the
          // matching `handoff_occurred` below (FIFO via `openHandoffs`).
          //
          // `item.agent` (real d.ts naming) is the SOURCE agent — the one whose
          // LLM call produced this handoff call — NOT the transfer target (see
          // `OpenAIHandoffRequestedEvent`'s doc: the target isn't resolved until
          // the handoff actually executes). There is therefore no target identity
          // to carry at this point — an earlier draft of this fix assumed there
          // was; corrected. `StreamAssembler.subagentStart`'s SUGAR signature also
          // carries neither `agentId` nor `agentName` params (only the
          // `subagent.start` AgEvent SCHEMA arm does, agjson.ts — a live-only
          // field the fold doesn't land on `AgTurnRecord` either, reduce.ts) and
          // this fix's commit scope excludes core/stream-assembler.ts, so identity
          // rides the follow-up bare `handoff` event instead (spec §4 bare-noun
          // EVENT carve-out), emitted once it's actually known — paired with
          // `subagentDone` in the `handoff_occurred` case below.
          const ordinal = ++handoffOrdinal;
          const handoffTurnId = `turn_handoff_${ordinal}`;
          const parentTurnId = lastTopLevelTurnId ?? threadId;
          openHandoffs.push({ turnId: handoffTurnId, parentTurnId });
          a.subagentStart(handoffTurnId, parentTurnId);
          return;
        }
        case "handoff_occurred": {
          // Task 3 (audit M48 review, Finding 1) — the REAL completion signal.
          // Both agent identities are finally known here (`RunHandoffOutputItem.
          // sourceAgent`/`targetAgent`), so this is where the identity-carrying
          // `handoff` event fires (mirrors the ORIGINAL mapping's shape —
          // `kind:"transfer"` + `toAgentName` — just correctly timed to when the
          // data actually exists on the wire). `fromAgentId`/`toAgentId` are still
          // never fabricated from a name (no agent-id concept exists anywhere on
          // this seam, unlike google-adk's per-message agentId/agentName).
          const item = event.item;
          const open = openHandoffs.shift(); // FIFO — see openHandoffs' doc.
          if (open !== undefined) a.subagentDone(open.turnId, open.parentTurnId);
          // Defensive orphan (no open bracket — e.g. a resumed/truncated stream):
          // still emit the `handoff` event losslessly rather than dropping the
          // now-known identity (Tenet 6) — it just doesn't close anything.
          a.emit({
            type: "handoff",
            kind: "transfer",
            toAgentName: item.targetAgent.name,
          });
          return;
        }
        case "tool_approval_requested": {
          // Task 3 (audit M48): a human-in-the-loop approval gate on a pending
          // tool call. `askId` mirrors the `approval_${callId}` convention already
          // established by the google-adk facet's `requestedToolConfirmations` arm
          // (index.ts:653) for the same `kind:"approval"` semantics. The M26
          // paused-fold discipline (surfacing this on the turn's `outcome.paused`)
          // is ADK-scoped for this batch — `hitl.ask` is LIVE-ONLY on the fold
          // (reduce.ts R9: no accumulator mutation), so emitting the ask alone is
          // complete; the host/turn-close owns any pause semantics.
          const item = event.item.rawItem;
          a.emit({
            type: "hitl.ask",
            askId: `approval_${item.callId}`,
            kind: "approval",
            toolCallId: item.callId,
          });
          return;
        }
        default:
          // A genuinely-unknown run-item name (a real-wire RunItemStreamEventName
          // this fixture-contract union does not declare — e.g.
          // `mcp_approval_requested`, `mcp_list_tools`). The OUTER guard
          // (`isOpenAIStreamEvent`) validates only `typeof name === "string"` (file
          // header), so an unrecognised name reaches here at runtime despite
          // `event`'s TS-narrowed `never` type (every literal this union declares
          // is handled by a case above). Route losslessly per Tenet 6 — this is the
          // file's stated ext.openai.unparsed convention for genuinely-unknown
          // run-items (audit M48; previously a silent no-op here).
          a.emitExt("openai", "unparsed", {
            name: runItemEvent.name,
            item: JsonValue.parse(runItemEvent.item),
          });
          return;
      }
    }

    // raw_model_stream_event — `data` is the Agents SDK ResponseStreamEvent union.
    const data = event.data;
    switch (data.type) {
      case "model": {
        // The verbatim openai-node Responses event rides in `event` (snake_case).
        driveRawResponsesEvent(data.event);
        return;
      }
      // IGNORE the SDK-flattened duplicates (canonical model):
      //   response_started   — duplicate of model:response.created
      //   output_text_delta  — flattened duplicate of model:response.output_text.delta
      //   response_done      — duplicate of model:response.completed
      case "response_started":
      case "output_text_delta":
      case "response_done":
      default:
        return;
    }
  }

  return {
    push(native: JsonValue): AgEvent[] {
      if (!isOpenAIStreamEvent(native)) {
        // Graceful guard (Tenet 6): route a genuinely unrecognisable payload through
        // the lossless vendor channel rather than throwing. Nest under `native` so a
        // payload carrying its own `type` key does NOT clobber the event type.
        a.emitExt("openai", "unparsed", { native });
        return a.drain();
      }
      drive(native);
      return a.drain();
    },
    flush(): AgEvent[] {
      // Close any dangling open response (e.g. a stream that ended before
      // response.completed) — unrelated to Task 4b: that round never reached a
      // native close signal at all, so it has no stashed closeTurnDone.
      if (turnId !== undefined) closeResponse();
      // Task 4b: emit any still-stashed closes BEFORE delegating to the engine's
      // flush. Each stashed round genuinely completed on the wire — a tool
      // result that never arrives must not swallow that close (message.end +
      // turn.done both replay here, verbatim, in the order INV-MSG requires).
      for (const [tid, stashed] of stashedCloseByTurn) {
        emitRoundClose(tid, stashed.msgId, stashed.openTextStreamIds, stashed.fields);
      }
      stashedCloseByTurn.clear();
      // Flush the engine's dangling open messages (I7).
      return a.flush();
    },
  };
}
