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
 *     `response.failed` (`response.error.{message,code}` + openai-node ≥7.10.0's
 *      `error.misalignment` block, landed as an adapter notice message whose
 *      text block `_meta["openai/misalignment"]` holds it verbatim — rd-15),
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
 *   - openai ≥6.46 programmatic tool calling — RESOLVED at 0.14.0 (the
 *     2026-07-29 carry): agents-core 0.14.0 promotes `program`/`program_output`
 *     to first-class protocol items (`ToolCallItem` / `RunToolCallOutputItem.
 *     rawItem` arms riding the already-handled `tool_called`/`tool_output`
 *     run-items — `dist/runner/modelOutputs.mjs` pushes them as
 *     `RunToolCallItem`/`RunToolCallOutputItem`), and `caller:{type,callerId}`
 *     provenance is a typed optional on the function/hosted/shell/apply-patch
 *     call+result items. The 0.13.2-era deferral premise (providerData-only
 *     reachability, no converter arm) no longer holds — see
 *     `OpenAIProgramCallItem`/`OpenAIProgramCallResultItem`/`OpenAIToolCaller`.
 *   - `response.inject.created`/`.failed` (hosted multi-agent lifecycle):
 *     verified immaterial — client-initiated echo, no content loss.
 */
import {
  type AgEvent,
  type AgBlock,
  type AgFinishReason,
  AgMeta,
  AgProviderMeta,
  type AgUsage,
  type AgSafety,
  type AgPausedAsk,
  type AgCitation,
  JsonValue,
  type Normalizer,
  StreamAssembler,
  withAtomicPush,
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
  /** NEW at agents-core 0.14.0 (programmatic tool calling): a program-driven
   *  turn can emit MULTIPLE assistant messages — running `commentary` vs the
   *  `final_answer`. This facet folds a response into ONE message, so the
   *  carry is PER-PART, on each matching `text.end`'s providerMetadata (a
   *  message-level `message.metadata` merge would clobber across items with
   *  DIFFERENT phases), plus the id-less `ext.openai.late-message` payload. */
  phase?: "commentary" | "final_answer";
  status: "in_progress" | "completed" | "incomplete";
  content: OpenAIContentPart[];
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

/** protocol `ToolCaller` (agents-core 0.14.0, openai ≥6.46 programmatic tool
 *  calling) — the execution context that issued a tool call: `direct` = the
 *  model itself; `program` = a running `program` item issued it, `callerId`
 *  linking back to that program's own `callId` (the correlation is
 *  REAL-wire, never fabricated here — both fields carried verbatim). An
 *  optional `caller` rides the function/hosted/shell/apply-patch call+result
 *  items (verified against 0.14.0's `dist/types/protocol.d.ts` — NOT the
 *  computer_call/computer_call_result or tool_search items). Carried on
 *  `tool.start`/`tool.done` `providerMetadata` (wire names verbatim, the
 *  claude facet's wrapper-carry precedent); absent caller ⇒ no metadata key. */
export type OpenAIToolCaller = { type: "direct" } | { type: "program"; callerId: string };

/** protocol `FunctionCallItem` (the `rawItem` of a tool_call_item). `callId` is
 *  the model's call_id; `id` is the Responses `fc_…` item id (DISTINCT). */
export interface OpenAIFunctionCallItem {
  type: "function_call";
  callId: string;
  name: string;
  arguments: string; // a JSON STRING — MUST be JSON.parse'd for tool.args.assembled
  status?: "in_progress" | "completed" | "incomplete";
  id?: string; // fc_… Responses item id
  caller?: OpenAIToolCaller;
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
  caller?: OpenAIToolCaller;
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
  caller?: OpenAIToolCaller;
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
  /** NEW at agents-core 0.14.0 (previously absent on this result arm).
   *  `incomplete` joins the outcome mapping ('error', same rule as
   *  `function_call_result` — never success) EVEN when every per-command
   *  exit was clean; the raw value is carried verbatim on tool.done
   *  providerMetadata (the per-command outcomes alone cannot recover it). */
  status?: "in_progress" | "completed" | "incomplete";
  maxOutputLength?: number;
  output: OpenAIShellCallOutputContent[];
  id?: string;
  caller?: OpenAIToolCaller;
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
  caller?: OpenAIToolCaller;
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
  caller?: OpenAIToolCaller;
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
  caller?: OpenAIToolCaller;
  providerData?: { [k: string]: JsonValue };
}

// ── OpenAI programmatic-tool-calling shapes (agents-core 0.14.0 carry,
// 2026-07-29 — supersedes the header's 0.13.2-era KNOWN-DEFERRED bullet.
// Verified against 0.14.0's `dist/types/protocol.d.ts` (`ProgramCallItem` /
// `ProgramCallResultItem` join the `ToolCallItem` / `RunToolCallOutputItem.
// rawItem` unions) and `dist/runner/modelOutputs.mjs` (`output.type ===
// 'program'` -> `RunToolCallItem`, `'program_output'` -> `RunToolCallOutputItem`
// — a PAIRED call+output on the SAME reused `tool_called`/`tool_output` event
// names, mirroring shell_call/apply_patch_call, not hosted_tool_call's
// single-shot collapse).

/** protocol `ProgramCallItem` (a `tool_called` rawItem — the model authored a
 *  PROGRAM that calls tools programmatically; openai ≥6.46). Carries NO `name`
 *  field — the facet synthesizes `name:"builtin:program"` (§8 quirk, the
 *  rawItem-derived convention shared by shell_call/apply_patch_call/
 *  computer_call — deliberately NOT the wrapper's `RunToolCallItem.toolName`
 *  synthetic `'programmatic_tool_calling'`, a wrapper-layer convenience this
 *  facet never consumes). `code` (the model-authored program source) +
 *  `fingerprint` are the call's whole wire payload — carried verbatim as
 *  `tool.args.assembled` input (the shell/apply-patch whole-payload
 *  precedent). Same single-wrapper-is-authoritative rationale as
 *  {@link OpenAIShellCallItem}: no per-fragment argument-delta stream exists
 *  for this shape on this seam, and the raw `output_item.added` carrier
 *  no-ops on the (function_call-only) raw path. */
export interface OpenAIProgramCallItem {
  type: "program";
  callId: string;
  code: string;
  fingerprint: string;
  id?: string;
  providerData?: { [k: string]: JsonValue };
}

/** protocol `ProgramCallResultItem` (the `rawItem` of a `tool_output` run-item
 *  for a completed program call, correlated by `callId`). `output` is a bare
 *  string (mirrors apply_patch_call_output); `status` is a CLOSED
 *  `'completed'|'incomplete'` enum — `incomplete` maps to `outcome:"error"`
 *  (the same rule as `function_call_result`'s incomplete arm: a truncated
 *  program run must never fold as success). Carries NO `caller` field
 *  (the program is the caller, not the callee). */
export interface OpenAIProgramCallResultItem {
  type: "program_output";
  callId: string;
  output: string;
  status: "completed" | "incomplete";
  id?: string;
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
  /**
   * agents-core 0.18.0 (`ToolSearchOutputItem.toolSearchAgentName`,
   * `dist/types/protocol.mjs`:426-432 / `dist/types/protocol.d.ts`:531-534 —
   * the ONLY protocol-schema addition across the whole 0.17.0→0.18.0 span, and
   * present on the OUTPUT item only, never on `ToolSearchCallItem`). Upstream
   * doc: "SDK-only discovery attribution, excluded from provider requests.
   * Names must identify the same logical Agent across reused history. Missing
   * or ambiguous ownership requires a new search; this field does not grant
   * tool execution permissions." An SDK-side field, so its name is already
   * camelCase on the wire we consume (like `executionStatus`/`callerId`) —
   * carried VERBATIM on `tool.done` providerMetadata, never re-cased. Not
   * reachable from any corpus scenario (no scenario configures tool_search), so
   * it is fixture-tested only.
   */
  toolSearchAgentName?: string;
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
  // fixture-drift ratchet's computer_call finding + the 0.14.0 programmatic-
  // tool-calling carry): Shell / Apply-Patch / Computer-Use / Hosted-tool /
  // Program built-ins reuse this SAME event name with a DIFFERENT `rawItem`
  // discriminant — see the interfaces above.
  item: {
    type: "tool_call_item";
    rawItem:
      | OpenAIFunctionCallItem
      | OpenAIShellCallItem
      | OpenAIApplyPatchCallItem
      | OpenAIComputerCallItem
      | OpenAIHostedToolCallItem
      | OpenAIProgramCallItem;
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
      | OpenAIComputerCallResultItem
      | OpenAIProgramCallResultItem;
    output?: JsonValue;
    customData?: JsonValue;
    /**
     * agents-core 0.15.0+ (`RunToolCallOutputItem.executionStatus`, a single
     * literal): present ONLY when the runner actually invoked the function
     * tool (`toolExecution.mjs` sets it right after `invokeFunctionTool`
     * returns). Absent when the result item was synthesized instead — an
     * input-guardrail rejection, a sibling cancellation, an approval refusal —
     * so a consumer can tell a tool's own result from a runner-substituted
     * one. Wrapper-level (not a protocol item field), so the fixture-drift
     * inventory cannot see it; census-caught on the first live capture after
     * 0.14.2 (echo-gpt56 @ 0.17.0). Carried verbatim on `tool.done`
     * providerMetadata alongside `caller`. Built-in tool results (shell /
     * apply_patch / computer / program) never carry it on the SDK side.
     */
    executionStatus?: "executed";
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

/** Minimal projection of `protocol.CompactionItem` (0.14.3, `dist/items.d.ts`
 *  `RunCompactionItem.rawItem`) — "a compaction marker returned by a model".
 *  `encrypted_content` is the replay-load-bearing opaque blob (the openai
 *  analog of the claude facet's compaction `encrypted_content`). */
interface OpenAICompactionItem {
  type: "compaction";
  encrypted_content: string;
  id?: string;
  created_by?: string;
}

interface OpenAICompactionItemCreatedEvent {
  type: "run_item_stream_event";
  name: "compaction_item_created";
  item: { type: "compaction_item"; rawItem: OpenAICompactionItem };
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
  | OpenAIToolApprovalRequestedEvent
  | OpenAICompactionItemCreatedEvent;

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
  /** `model` (OA-12): openai-node `Response.model` — the model id the API
   *  resolved for THIS response (live echo-gpt6sol: `"gpt-6-sol"`), known before
   *  the message opens → `message.start.model`. Typed as the raw `JsonValue` it
   *  is on this seam; string-guarded at the read. */
  response: { id: string; model?: JsonValue };
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
 *  is snake_case. Carried via the `model` carrier.
 *
 *  `status` is the FULL openai-node `ResponseStatus` union and OPTIONAL, exactly
 *  as upstream declares it (openai 7.15.0 `resources/responses/responses.d.ts`:
 *  6186 `ResponseStatus = 'completed'|'failed'|'in_progress'|'cancelled'|
 *  'queued'|'incomplete'`; :997 `status?: ResponseStatus` on `Response`; :1652-
 *  1656 `ResponseCompletedEvent.response: Response` — a `response.completed`
 *  event carries a FULL `Response`, not a pre-filtered success). The previous
 *  `status: "completed" | "incomplete"` narrowing was wire-untrue, and it HID a
 *  wrong mapping: a `response.completed` whose response failed or was cancelled
 *  used to close the turn as a SUCCESS. See the `response.completed` arm. */
interface OpenAIResponsesCompleted {
  type: "response.completed" | "response.incomplete";
  response: {
    id: string;
    status?: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";
    incomplete_details?: { reason?: string };
    usage?: OpenAIResponseUsage;
    /** openai-node `Response.output: ResponseOutputItem[]` — consumed ONLY for its
     *  `type:"reasoning"` members (OA-11; see `terminalReasoningItems`). Typed as
     *  the raw `JsonValue` it is on this seam and narrowed item-by-item there:
     *  the outer guard (`isOpenAIStreamEvent`) validates the envelope only. */
    output?: JsonValue;
  };
}

/** One `type:"reasoning"` member of a terminal event's `response.output`
 *  (openai-node `ResponseReasoningItem`: `id`, `summary: {type:"summary_text";
 *  text}[]`, `encrypted_content?: string | null`), narrowed from `JsonValue`.
 *  `summary[i]` keeps its wire index — it becomes `reasoning.delta.partIndex`
 *  (SPEC `reasoning.start` row: "OpenAI summary_index → partIndex"). */
interface TerminalReasoningItem {
  id: string;
  summary: ReadonlyArray<{ partIndex: number; text: string }>;
  encryptedContent?: string;
}

/**
 * OA-11: extract the reasoning items from a terminal event's `response.output`.
 * This — not `response.output_item.done` — is the replayable source: OpenAI
 * re-encrypts `encrypted_content` per stage (live, echo-gpt6sol natives [4] vs
 * [21]: two different blobs for one `rs_`), and only the terminal blob is the
 * one stateless replay sends back (§10 item 4). The run-item the SDK builds
 * afterwards carries the same terminal blob (natives [22]); its `content[]` is
 * this `summary[]` re-labelled `input_text` (agents-openai 0.18.0
 * `openaiResponsesConverter.mjs`:1481-1497).
 *
 * Deserialization boundary: a non-array `output`, a non-object member, a member
 * with no string `id`, and a non-string summary `text` are all skipped (an
 * id-less reasoning item stays with the run-item path, which already degrades
 * it losslessly). Absent/empty output ⇒ `[]` ⇒ byte-identical to pre-OA-11.
 */
function terminalReasoningItems(output: JsonValue | undefined): TerminalReasoningItem[] {
  if (!Array.isArray(output)) return [];
  const items: TerminalReasoningItem[] = [];
  for (const member of output) {
    if (!isJsonObject(member) || member.type !== "reasoning") continue;
    const id = member.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const summary: { partIndex: number; text: string }[] = [];
    const rawSummary = member.summary;
    if (Array.isArray(rawSummary)) {
      rawSummary.forEach((part, partIndex) => {
        if (isJsonObject(part) && typeof part.text === "string") summary.push({ partIndex, text: part.text });
      });
    }
    const enc = member.encrypted_content;
    items.push({
      id,
      summary,
      ...(typeof enc === "string" && enc.length > 0 ? { encryptedContent: enc } : {}),
    });
  }
  return items;
}

/** The `ResponseStatus` members that ASSERT the response did not succeed
 *  (openai 7.15.0 `responses.d.ts`:6186). `in_progress`/`queued` are
 *  non-terminal — a `response.completed` carrying one is contradictory wire that
 *  asserts no failure — and an unrecognized string is a server-added member of
 *  an open enum; both keep the pre-existing success path rather than have the
 *  facet invent an outcome (Tenet 6). Mirrors — and deliberately outgrows by one
 *  member — @openai/agents-openai 0.18.0's own
 *  `getUnsuccessfulResponseTerminalType` (`dist/openaiResponsesModel.mjs`:851-
 *  863: `status === 'failed' || status === 'incomplete'`): a `cancelled`
 *  response is equally not a successful assistant turn, and AgJSON has no other
 *  channel that would record it. */
const UNSUCCESSFUL_RESPONSE_STATUSES: ReadonlySet<string> = new Set(["failed", "cancelled", "incomplete"]);

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
    // The VERBATIM openai-node (≥6.46) form — snake_case `caller_id`, nullable
    // (`ResponseFunctionToolCall.caller`); normalized to the protocol layer's
    // camelCase `callerId` for the providerMetadata carry (mirrors
    // agents-openai 0.14.0's own `fromOpenAIToolCaller`). This raw path is the
    // AUTHORITATIVE tool.start source for function_call, so caller provenance
    // must ride HERE — the run-item wrapper occurrence stays ignored.
    caller?: { type: "direct" } | { type: "program"; caller_id: string } | null;
    // OA-14: openai-node `ResponseOutputMessage.phase` (`'commentary' |
    // 'final_answer' | null`) — present on a `type:"message"` item AT ADD time
    // (6/8 live openai seeds). Raw `JsonValue`; string-guarded at the read.
    phase?: JsonValue;
  };
}

/** openai-node `ResponseFailedEvent` — the response itself failed (e.g. rate limit).
 *  Carried via the `model` carrier.
 *
 *  `error.misalignment` is openai-node ≥7.10.0 wire (`ResponseError.Misalignment`,
 *  paired with the new code `misalignment_policy_violation` — GPT-6 Astra's
 *  misalignment monitoring): a safety classification (`error_type`, an OPEN
 *  string — "clients must accept additional values"), a public explanation
 *  (`detailed_explanation`) and an optional continuation instruction
 *  (`steer.message`). Typed to the documented subset; the arm carries the WHOLE
 *  object verbatim (JsonValue-validated), so any further server-added key
 *  survives. Reachability: the documented auto-stop applies only to Responses
 *  requests using persisted reasoning, WebSockets, or compaction — none of
 *  which @openai/agents 0.17.0's default HTTP transport uses in the e2e probes
 *  — so the carry is synthetic-tested only (defensive). */
interface OpenAIResponsesFailed {
  type: "response.failed";
  response: {
    id: string;
    error?: {
      message?: string;
      code?: string;
      misalignment?: {
        detailed_explanation?: string;
        error_type?: string;
        steer?: { message: string };
      };
    };
  };
}

/** A top-level streaming error event (spec §4 bare `error`). Non-terminal on
 *  OUR side; TERMINAL upstream from @openai/agents-openai 0.17.1 — see the
 *  `case "error"` arm for what that changes about the surrounding stream. */
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
  | OpenAICompactionItemCreatedEvent
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

/**
 * OA-15 (draft.4 — SPEC.md §8.0 graceful degradation, §10 item 23; sp-protocol
 * 89c57db): the `turn.done` finish fields for a native reason. `finishReason`
 * is `mapFinishReason(reason)`; `finishReasonRaw` — the native value byte for
 * byte — rides along ONLY when that mapping fell back ("other"/"unknown") AND a
 * native string exists. A real mapping (max_output_tokens → token_limit, a bare
 * completion → stop, content_filter → safety_blocked) sets nothing: the companion
 * is for a value with no AgJSON target, not a second copy of a mapped one
 * (sp-protocol's scope ruling; widening it would be a new normative sentence).
 */
function finishReasonFields(
  reason: string | undefined | null,
): { finishReason: AgFinishReason; finishReasonRaw?: string } {
  const finishReason = mapFinishReason(reason);
  const isFallback = finishReason === "other" || finishReason === "unknown";
  return isFallback && typeof reason === "string" ? { finishReason, finishReasonRaw: reason } : { finishReason };
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
// Spec §4 (draft.3): `output_tokens` is already reasoning-INCLUSIVE upstream
// ("billed as output tokens"), so it is carried verbatim and
// `output_tokens_details.reasoning_tokens` lands on `reasoningTokens` as the
// breakdown — never added to outputTokens.
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

// ─── optional 0.14.0 wire fields → providerMetadata (spec §2) ─────────────────
// Wire names ride verbatim at the top level (the claude facet's wrapper-carry
// precedent — AgProviderMeta imposes no key namespacing). Drops undefined
// values; an ALL-absent input yields undefined, never an empty metadata object.
/** PH-2 / OA-14: an OpenAI message `phase` as a vendor MARKER — a non-empty
 *  string, verbatim — or `undefined`. openai-node types it
 *  `'commentary' | 'final_answer' | null`; null and "" carry no marker, so they
 *  yield neither a `providerMetadata.phase` carry nor an ext.openai.late-phase
 *  (sp-protocol ruling (a), SPEC §10 item 26). Read through `unknown`: the
 *  run-item field is envelope-only-validated wire data (JsonValue boundary). */
function vendorPhase(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** PH-2 (draft.4, SPEC §8.0 item 27): the first-class `phase` for an OpenAI
 *  vendor marker — `"commentary"` → `"interim"`; "final_answer", absent and
 *  every other value → `undefined` (a vendor spelling is never copied into
 *  `phase`; it stays verbatim in `providerMetadata`). */
function interimPhase(vendor: string | undefined): "interim" | undefined {
  return vendor === "commentary" ? "interim" : undefined;
}

function openaiProviderMeta(fields: { [k: string]: JsonValue | undefined }): AgProviderMeta | undefined {
  const raw: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) raw[k] = v;
  }
  return Object.keys(raw).length > 0 ? AgProviderMeta.parse(raw) : undefined;
}

/** protocol camelCase `ToolCaller` → its verbatim JsonValue carry ({type} /
 *  {type, callerId} — BOTH fields preserved; `callerId` links to the program
 *  item's own `callId`). */
function callerToJson(caller: OpenAIToolCaller | undefined): JsonValue | undefined {
  return caller === undefined ? undefined : JsonValue.parse(caller);
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

/**
 * workspace#21 (guuey#981): the MCP tool result's `_meta`, riding the same
 * host-convention `customData` channel as `structuredContent` (SPEC.md:340) —
 * agents-core 0.18.0 hands it to `MCPServer.customDataExtractor` as
 * `context.resultMeta` (`dist/mcpUtil.d.ts`:41, `result._meta ?? content._meta`
 * at `dist/mcp.mjs`:700); guuey's worker and this repo's capture agent return it
 * as `customData._meta`. It is a host/protocol annotation (MCP-Apps `ui.*`), so
 * it rides the tool-result block's own `_meta` VERBATIM (SPEC.md:338; §8.0
 * no-drop). sp-protocol ruled this option A on 2026-09-23. A non-object `_meta`
 * (null, string, array) is not a `_meta` → `undefined`, and the block is
 * byte-identical to the pre-#21 output. Mirrors the claude facet's sibling
 * `_meta` parse (claude-agent-sdk/src/index.ts:1872-1876).
 */
function extractResultMeta(customData: JsonValue | undefined): AgMeta | undefined {
  if (!isJsonObject(customData) || !isJsonObject(customData._meta)) return undefined;
  return AgMeta.parse(customData._meta);
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
 *  - reasoning  ← opens at `model:response.output_item.added{reasoning}` (wire
 *                 position), filled from the `model:response.completed` /
 *                 `.incomplete` `response.output` (OA-11 — the final, replayable
 *                 `encrypted_content`); `reasoning_item_created` is the fallback
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
/**
 * The OpenAI Agents SDK normalizer. The inner, deterministic normalizer
 * (`createInnerOpenaiNormalizer` below) is wrapped in core's `withAtomicPush`
 * (sp-probe; sp-main's binding guard ruling, 2026-09-24). Every `push()` is
 * atomic, and none of it lives in the facet:
 * - The native is normalized with `toJsonValueSafe`, so LIVE SDK objects map
 *   exactly like the JSON corpus.
 * - On a throw anywhere in the facet, this native's partial batch is
 *   discarded. The inner is rebuilt from the journal of accepted natives
 *   (identical state and seq; the facet never reads the clock or randomness),
 *   and ONE core `error {message: "normalizer error", code: <constructor
 *   name>}` takes the next seq. It carries no payload and no message text.
 * So push() never throws (SPEC.md:933), no seq is consumed by the discarded
 * batch (INV-SEQ), and no facet state ever believes a block or message is
 * open that never reached the wire.
 */
/** Options for {@link createOpenaiNormalizer}. */
export interface OpenaiNormalizerOptions {
  /**
   * The stem for the ids this facet mints on its own: a fallback turn (a
   * response with no `response.created`, or a host-error sentinel with no turn
   * open) is `turn_<invokeId>_<n>`, and a handoff's subagent turn is
   * `turn_<invokeId>_handoff_<n>`.
   *
   * These ids must be unique across every invoke folded into one reducer. The
   * rnd-14 ruling and INV-BLOCK's collision-free derived ids require it: guuey
   * folds a whole conversation into ONE Reducer, and a repeated turn id
   * re-opens a closed turn, which parks INV-TURN / INV-MSG consumers.
   * sp-protocol's D3 bar (wf_9722b7bc-ba9, DC-10) found the old per-normalizer
   * counters (`turn_openai_<n>`, `turn_handoff_<n>`) repeating across invokes.
   *
   * By default each normalizer draws a fresh `openai_<16 hex>` stem from
   * `crypto.getRandomValues`. It's drawn ONCE, outside the atomic inner
   * factory, so a `withAtomicPush` rebuild mints the SAME ids. Pass one to make
   * the output deterministic (replay, tests). A host that passes one MUST keep
   * it unique per invoke within a fold. Ids taken from the wire
   * (`turn_<response.id>`, `turn_resume_<callId>`) are unaffected. This mirrors
   * the vercel facet's e900d03.
   */
  invokeId?: string;
}

/** 64 random bits as 16 hex chars: the default per-invoke id stem. */
function mintInvokeNonce(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createOpenaiNormalizer(options: OpenaiNormalizerOptions = {}): Normalizer {
  const invokeStem = options.invokeId ?? `openai_${mintInvokeNonce()}`;
  return withAtomicPush(() => createInnerOpenaiNormalizer(invokeStem));
}

function createInnerOpenaiNormalizer(invokeStem: string): Normalizer {
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
  // OA-11 reasoning-block state. `openReasoning`: rs_ id → the message id its
  // block opened in (at `output_item.added{reasoning}`), awaiting its fill from
  // the terminal output; per-response (cleared by `resetResponseState`).
  // `filledReasoning`: every rs_ id whose block has been filled — normalizer-
  // lifetime, because the SDK's `reasoning_item_created` for it lands AFTER the
  // response closed and must dedupe against it (single source per rs_ id).
  const openReasoning = new Map<string, string>();
  const filledReasoning = new Set<string>();
  // OA-14 phase state. `pendingPhase`: message item id → the phase its raw
  // `output_item.added` announced, awaiting that item's `text.start`
  // (per-response). `carriedPhase`: item id → the phase that rode its
  // `text.start` — normalizer-lifetime, because the run-item it retires
  // `ext.openai.late-phase` against lands AFTER the response closed.
  const pendingPhase = new Map<string, string>();
  const carriedPhase = new Map<string, string>();
  // PH-2 (draft.4 stage 2): text stream ids whose `text.start` already set the
  // first-class `phase:"interim"` (so no `*.end` repeats it), and per-stream
  // `text.end` fields learned for a round close that is STASHED (deferred until
  // its tool results land) — consumed by `emitRoundClose`.
  const interimAtStart = new Set<string>();
  const stashedEndFields = new Map<string, { phase?: string; providerMetadata?: AgProviderMeta }>();
  // O1 (fold/flush option 1): callId → the askId of the `hitl.ask{approval}`
  // emitted for it. A deferred round whose still-pending call has one flushes
  // as `paused` naming that ask (INV-FLUSH (2)).
  const askedApprovals = new Map<string, string>();
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
  /** PH-2: is `streamId`'s text.end still pending in a STASHED round close
   *  (a deferred tool round), i.e. not yet emitted? */
  function isStashedTextStream(streamId: string): boolean {
    for (const stashed of stashedCloseByTurn.values()) {
      if (stashed.openTextStreamIds.includes(streamId)) return true;
    }
    return false;
  }

  function endStashedTextStreams(mId: string, textStreamIds: readonly string[]): void {
    for (const streamId of textStreamIds) {
      // PH-2: a phase learned while this close sat stashed rides its text.end.
      const endFields = stashedEndFields.get(streamId);
      stashedEndFields.delete(streamId);
      a.textEnd(streamId, mId, endFields);
    }
  }

  function emitRoundClose(tid: string, mId: string, textStreamIds: readonly string[], fields: TurnDoneFields): void {
    endStashedTextStreams(mId, textStreamIds);
    a.closeMessage(mId);
    a.closeTurnDone(tid, fields);
  }

  /**
   * O1 — release a close deferred under §8.0 item 14 at END OF STREAM (flush) or
   * ahead of a host-fed error, per INV-FLUSH (2) as sp-protocol's fold/flush
   * package words it (A.5; founder: Q1 option 1, "honest flush"). A flush never
   * emits a success turn.done:
   *  - an approval `hitl.ask` was emitted for a still-pending call of this
   *    round ⇒ `turn.done{outcome:{type:"paused", asks}}`, with the deferred
   *    finishReason and usage (the OpenAI approval interruption — the run ends
   *    with no tool_output; sp-probe's live leg-1 capture);
   *  - else a non-success deferred outcome (the content_filter arm) ⇒ released
   *    verbatim;
   *  - else ⇒ `message.end` carrying the round's usage (a per-message usage
   *    carrier, so it isn't lost), then `turn.abort{stream-truncated}`.
   */
  function releaseDeferredClose(tid: string, stashed: StashedRoundClose): void {
    const asks: AgPausedAsk[] = [];
    for (const callId of pendingToolsByTurn.get(tid) ?? []) {
      const askId = askedApprovals.get(callId);
      if (askId !== undefined) asks.push({ askId, kind: "approval", toolCallId: callId });
    }
    if (asks.length > 0) {
      emitRoundClose(tid, stashed.msgId, stashed.openTextStreamIds, { ...stashed.fields, outcome: { type: "paused", asks } });
      return;
    }
    if (stashed.fields.outcome.type !== "success") {
      emitRoundClose(tid, stashed.msgId, stashed.openTextStreamIds, stashed.fields);
      return;
    }
    endStashedTextStreams(stashed.msgId, stashed.openTextStreamIds);
    a.closeMessage(stashed.msgId, stashed.fields.usage);
    a.emit({ type: "turn.abort", turnId: tid, reason: "stream-truncated" });
  }

  /** O1: release every deferred close (insertion order: older rounds first). */
  function releaseAllDeferredCloses(): void {
    for (const [tid, stashed] of stashedCloseByTurn) releaseDeferredClose(tid, stashed);
    stashedCloseByTurn.clear();
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
   * `model` (OA-12) rides `message.start.model` — only the authoritative
   * `response.created` open passes it; a defensive open never invents one.
   */
  function ensureResponseOpen(respId?: string, model?: string): string | undefined {
    // Already closed → never reopen (the duplicate `response.completed` lands here).
    if (respId !== undefined && closedResponses.has(respId)) return undefined;
    if (turnId !== undefined) {
      // Backfill the real id if it arrives after a defensive synthesized open.
      if (respId !== undefined && responseId === undefined) responseId = respId;
      // A resumed invoke's turn (`openTurnForLeadingResult`) opens with no
      // assistant message: the resumed response opens it here, AFTER the
      // leading tool result's own message, so the fold stays chronological.
      if (msgId === undefined) {
        msgId = `msg_${turnId}`;
        a.openMessage({ id: msgId, role: "assistant", turnId, threadId, ...(model !== undefined ? { model } : {}) });
      }
      return responseId ?? turnId;
    }
    responseId = respId;
    turnId = respId !== undefined ? `turn_${respId}` : `turn_${invokeStem}_${++turnCounter}`;
    msgId = `msg_${turnId}`;
    // Task 3 (audit M48 review, Finding 1): survives resetResponseState() —
    // see the closure-state doc above.
    lastTopLevelTurnId = turnId;
    a.openTurn(turnId, threadId);
    a.openMessage({ id: msgId, role: "assistant", turnId, threadId, ...(model !== undefined ? { model } : {}) });
    return responseId ?? turnId;
  }

  /**
   * INV-TURN (SPEC:743) for a RESUMED invoke — sp-protocol's c20 package, A.6
   * (openai): when a tool result's round is unknown to this invoke
   * (`resolvePendingTurnId` misses) and no response is open, the result is the
   * resumed stream's LEADING event (sp-probe's live approval-resume capture,
   * 2026-09-24: after `RunState.fromString` + approve/reject, the approved or
   * rejected call's `tool_output` arrives before any `response.created`). Open a
   * turn for it — `turn_resume_<callId>`: deterministic, and never a leg-1
   * `turn_resp_*` id (INV-XINV) — and land the result as its OWN role:"tool"
   * message (`messageId: "<callId>:result"`). The resumed model response then
   * opens its assistant message in this same turn (`ensureResponseOpen`) and its
   * response.completed closes it. Returns the toolDone fields, or `undefined`
   * when the result joins a known round or an open response (unchanged).
   */
  function openTurnForLeadingResult(callId: string): { turnId: string; messageId: string } | undefined {
    if (turnId === undefined) {
      const opened = `turn_resume_${callId}`;
      turnId = opened;
      lastTopLevelTurnId = opened;
      a.openTurn(opened, threadId);
      return { turnId: opened, messageId: `${callId}:result` };
    }
    // Approve-all (sp-protocol's D3 pin, 2026-09-24): the resuming invoke can
    // replay SEVERAL results before its response. While the resume turn is
    // open with no assistant message yet (turnId set, msgId unset — a state
    // only this helper creates), each further result joins THAT turn as its
    // own role:"tool" message; no second turn opens.
    if (msgId === undefined) return { turnId, messageId: `${callId}:result` };
    return undefined;
  }

  /** rd-15: the misalignment notice (see the `response.failed` arm). */
  function emitMisalignmentNotice(
    responseIdForNotice: string,
    tid: string,
    misalignment: { readonly [k: string]: JsonValue },
    errorMessage: string | undefined,
  ): void {
    const noticeId = `notice_misalignment_${responseIdForNotice}`;
    const textId = `${noticeId}_text`;
    const explanation = misalignment.detailed_explanation;
    const text = typeof explanation === "string" && explanation.length > 0 ? explanation : (errorMessage ?? "");
    a.openMessage({ id: noticeId, role: "notice", noticeSource: "adapter", turnId: tid, threadId });
    a.emit({
      type: "text.start",
      id: textId,
      messageId: noticeId,
      _meta: AgMeta.parse({ "openai/misalignment": JsonValue.parse(misalignment) }),
    });
    if (text.length > 0) a.textDelta(textId, noticeId, text);
    a.textEnd(textId, noticeId);
    a.closeMessage(noticeId);
  }

  /** Reset per-response state after a close. Marks the response closed (close-once). */
  function resetResponseState(): void {
    const key = responseId ?? turnId;
    if (key !== undefined) closedResponses.add(key);
    openTextStreams.clear();
    // OA-11: an rs_ block opened but never filled (e.g. `response.failed`) stays
    // as the spec's own unsealed-block outcome (INV-FLUSH (3)); forget it so a
    // late run-item for it takes the existing `late-reasoning` degrade.
    openReasoning.clear();
    pendingPhase.clear();
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
        // OA-12: so is the resolved model id (JsonValue boundary: string-guarded).
        const rawModelId: unknown = ev.response.model;
        ensureResponseOpen(
          ev.response.id,
          typeof rawModelId === "string" && rawModelId.length > 0 ? rawModelId : undefined,
        );
        return;
      }
      case "response.output_text.delta": {
        ensureResponseOpen();
        if (msgId === undefined) return; // unreachable post-ensure; satisfies the narrowing
        if (!openTextStreams.has(ev.item_id)) {
          openTextStreams.add(ev.item_id);
          // OA-14: the phase announced at output_item.added rides text.start
          // (rnd 13+17 Stage 1, founder ruling 2026-09-23; vercel parity c4f5981).
          const phase = pendingPhase.get(ev.item_id);
          const startMeta = openaiProviderMeta({ phase });
          // PH-2 (draft.4, SPEC §8.0 item 27 + §5 "phase timing"): known before
          // the first delta ⇒ the first-class `phase` goes on text.start.
          const interim = interimPhase(phase);
          a.textStart(ev.item_id, msgId, {
            role: "assistant",
            ...(startMeta !== undefined ? { providerMetadata: startMeta } : {}),
            ...(interim !== undefined ? { phase: interim } : {}),
          });
          if (phase !== undefined) {
            pendingPhase.delete(ev.item_id);
            carriedPhase.set(ev.item_id, phase);
          }
          if (interim !== undefined) interimAtStart.add(ev.item_id);
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
        // OA-11: a reasoning item OPENS its block here — id only, the added event
        // carries no replayable content — so the block takes its wire position
        // ahead of the `fc_` it precedes (§5 block insertion order, SPEC:763;
        // §10 item 4's stateless loop replays `rs_` before its `fc_`). It is
        // filled from the terminal output (`fillReasoningFromTerminalOutput`).
        if (ev.item.type === "reasoning") {
          ensureResponseOpen();
          // typeof guard: the envelope guard does not validate `item.id` (JsonValue boundary).
          const rsId: unknown = ev.item.id;
          if (typeof rsId === "string") openReasoningBlock(rsId);
          return;
        }
        // OA-14: a message item announces its `phase` here, BEFORE its first
        // text delta — record it for that item's `text.start`. Record only: no
        // response open, no emit, so an absent/null/non-string/empty phase is
        // byte-identical to a stream without this event.
        if (ev.item.type === "message") {
          const itemId: unknown = ev.item.id;
          const phase: unknown = ev.item.phase;
          if (typeof itemId === "string" && typeof phase === "string" && phase.length > 0) {
            pendingPhase.set(itemId, phase);
          }
          return;
        }
        // Authoritative tool-start source (canonical model, A1 §"Spike Findings").
        // Only function_call items carry a tool name + call_id; message items are
        // no-op'd here — their lifecycle is handled elsewhere.
        if (ev.item.type === "function_call" && ev.item.call_id !== undefined && ev.item.name !== undefined) {
          const fcId = ev.item.id;
          const callId = ev.item.call_id;
          ensureResponseOpen();
          // Record the fc_→call_id correlation (the raw argument events carry only
          // the fc_ item id, not the call_id; this mapping allows recovery).
          instanceCallIdByItemId.set(fcId, callId);
          // Caller provenance (0.14.0 carry): the raw wire's snake_case
          // `caller_id` is normalized to the protocol layer's camelCase form
          // before the verbatim providerMetadata carry (see the item doc).
          const rawCaller = ev.item.caller;
          const startMeta = openaiProviderMeta({
            caller:
              rawCaller == null
                ? undefined
                : rawCaller.type === "program"
                  ? { type: "program", callerId: rawCaller.caller_id }
                  : { type: "direct" },
          });
          a.toolStart({
            toolCallId: callId,
            name: ev.item.name,
            itemId: fcId,
            ...(startMeta !== undefined ? { providerMetadata: startMeta } : {}),
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
        // OA-11: fill every reasoning block from THIS output (the replayable blob)
        // FIRST — before any branch below can emit message.end / turn.* (INV-MSG:
        // a reasoning.* event must never target a sealed message; core's reduce()
        // does not check that for reasoning.*, so the order is this facet's job).
        fillReasoningFromTerminalOutput(ev.response.output);
        // Snapshot before any deferral: `resetResponseState()` below always
        // clears these, but a deferred close needs them later (Task 4b).
        const currentTurnId = turnId;
        const currentMsgId = msgId;
        const textStreamIds = Array.from(openTextStreams);
        const reason = ev.response.incomplete_details?.reason;
        const usage = mapUsage(ev.response.usage);
        // `status` is OPTIONAL upstream and its enum is OPEN ("clients must
        // accept additional values"), so it is read through `unknown` + a typeof
        // guard rather than trusted through the declared union — this is the
        // deserialization boundary (`push` takes `JsonValue`; the structural
        // guard narrows only the OUTER discriminant). Absent, "completed", a
        // non-terminal member, or an unrecognized server-added string all yield
        // `undefined` here and leave the pre-existing branches byte-identical.
        const rawStatus: unknown = ev.response.status;
        const unsuccessfulStatus =
          typeof rawStatus === "string" && UNSUCCESSFUL_RESPONSE_STATUSES.has(rawStatus) ? rawStatus : undefined;
        // Decision tree (mirrors the canonical model, A1):
        //   refusal recorded         → closeTurnDone success, finishReason:"refusal"
        //   content_filter           → closeTurnDone error-outcome + safety signal
        //   any other incomplete     → closeTurnError{code:reason, usage}
        //   completed, status failed/
        //     cancelled/incomplete   → closeTurnError{code:status, usage}
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
            ...finishReasonFields(reason),
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
        } else if (unsuccessfulStatus !== undefined) {
          // A `response.completed` event whose response did NOT complete
          // (`status` failed / cancelled / incomplete — openai 7.15.0
          // responses.d.ts:1652-1656 + :997 + :6186). Closing that round as a
          // success is a WRONG MAPPING, not a drop: the status is the
          // authoritative outcome and nothing else on this event contradicts it.
          // @openai/agents-openai 0.17.1+ now agrees — it rejects unsuccessful
          // terminal states (0.18.0 `dist/openaiResponsesModel.mjs`:851-876) —
          // but it yields the raw `model` carrier for this event BEFORE throwing
          // (:1338+), so by the time the run aborts this facet has already
          // decided the close; it must therefore decide it correctly HERE.
          // Carries the status as the error `code`, the same shape the
          // `response.incomplete` branch above uses for
          // `incomplete_details.reason`; `message` mirrors it because this arm
          // has no free-text message on the wire (unlike `response.failed`'s
          // `error.message`). ONE exception, for code fidelity: a
          // self-contradictory `response.completed` that reports
          // `status:"incomplete"` AND carries `incomplete_details.reason`
          // prefers the reason, so the code matches byte-for-byte what the
          // `response.incomplete` branch above would have emitted for the same
          // payload — a consumer switching on `code` must not see a coarser
          // value merely because the producer mislabelled the event type.
          // Placed LAST among the error branches so refusal, content_filter and
          // `response.incomplete` keep their exact prior precedence and output.
          const unsuccessfulCode =
            unsuccessfulStatus === "incomplete" ? (reason ?? unsuccessfulStatus) : unsuccessfulStatus;
          endOpenStreamsAndCloseMessage();
          a.closeTurnError(currentTurnId, {
            message: unsuccessfulCode,
            code: unsuccessfulCode,
            ...(usage !== undefined ? { usage } : {}),
          });
        } else {
          finishOrDeferRound(currentTurnId, currentMsgId, textStreamIds, {
            outcome: { type: "success" },
            // OA-15: an unmapped native reason also carries finishReasonRaw.
            ...finishReasonFields(reason),
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
        // openai-node ≥7.10.0: `error.misalignment` (classification + public
        // explanation + `steer.message` continuation instruction). `turn.error`
        // carries only message/code/usage (spec §4), so rd-15 (sp-protocol's
        // package A.6; founder: rides 0.7.0; sp-cto: the carry must sit in a
        // home that FOLDS) lands it as an adapter NOTICE message immediately
        // BEFORE the closing turn.error, in this turn:
        //   message.start {role:"notice", noticeSource:"adapter"} →
        //   one text block, text = `detailed_explanation` verbatim (else
        //   error.message), text.start `_meta["openai/misalignment"]` = the
        //   WHOLE object verbatim (wire names, steer, unknown keys) →
        //   message.end.
        // It folds (a notice row + its block `_meta`), so it is readable and
        // durable. The former live-only ext.openai.misalignment carry is
        // RETIRED (the item-21 one-carrier precedent; no consumer read it).
        // Absent or non-object ⇒ nothing new (byte-identical to the pre-7.10.0
        // output); the isJsonObject guard keeps a malformed wire value away
        // from JsonValue.parse.
        const misalignment = err?.misalignment;
        if (isJsonObject(misalignment)) emitMisalignmentNotice(ev.response.id, turnId, misalignment, err?.message);
        a.closeTurnError(turnId, {
          message: err?.message ?? "response.failed",
          ...(err?.code !== undefined ? { code: err.code } : {}),
        });
        resetResponseState();
        return;
      }
      case "error": {
        // Top-level bare `error` (spec §4). Mapping (UNCHANGED): surface it on the
        // lossless vendor channel and do NOT close the turn — this event carries no
        // response id, no usage and no outcome, so synthesizing a terminal close
        // here would fabricate one (Tenet 6).
        //
        // What DID change is the stream around it. Through @openai/agents-openai
        // 0.17.0 a bare `error` was a genuinely non-terminal advisory: the stream
        // continued and the response still closed on its own terminal event. From
        // 0.17.1 it is TERMINAL upstream — `error` is a member of
        // `TERMINAL_RESPONSES_STREAM_EVENT_TYPES` and
        // `getUnsuccessfulResponseTerminalType` returns it unconditionally (0.18.0
        // `dist/openaiResponsesModel.mjs`:840-863), so the run ABORTS: the loop
        // stashes a `ModelBehaviorError` and throws it once the stream ends
        // (:1276-1294, :1344-1345). The raw `model` carrier for this very event is
        // still yielded first (:1338+, unconditional), so this arm still runs.
        //
        // Consequence on 0.17.1+: no `response.completed`/`.failed`/`.incomplete`
        // ever follows, so the round degrades to `ext.openai.error` PLUS the
        // engine's INV-FLUSH close of the dangling turn —
        // `turn.abort{reason:"stream-truncated"}` (audit M21) — and a `turn.error`
        // materializes only once the host feeds the `__host_error__` sentinel for
        // the thrown `ModelBehaviorError` (see `driveHostError`). NOTE: the
        // `response.failed` arm below is UNAFFECTED by 0.17.1 — it was already a
        // terminal event at 0.17.0 and still closes the turn itself.
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
   * Correlation (OA-14 — id FIRST, FIFO fallback; protocol package rd-13-17
   * §2 stage 1): on the direct OpenAI wire the raw delta's `item_id` and the
   * run-item's `rawItem.id` are the SAME id (all 8 openai corpus seeds), so the
   * stream is matched by id — a completion can no longer land on an earlier
   * part's stream when two are open. Only when the id is unknown to
   * `openTextStreams` does the match fall back to positional FIFO (insertion-
   * ordered): the OpenRouter surface (#128 capture) mints `msg_tmp_` run-item
   * ids in a DIFFERENT id space from its raw `item_id`s.
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
              // phase (0.14.0) has no streamed text.end to ride on this path —
              // it joins the same lossless carry as the text itself.
              ...(item.phase !== undefined ? { phase: item.phase } : {}),
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
          // phase (0.14.0): the live wire delivers the FINAL round's
          // message_output_created AFTER response_done has closed the message
          // (census-caught on the first 0.14.0 gpt-5.6-sol capture), so the
          // text.end carry below is unreachable for it — only tool-round
          // (deferred-close) messages ever reach it. Same post-close degrade
          // convention as late-citations: a dedicated itemId-keyed vendor
          // carry, one per phase-bearing part.
          // OA-14: RETIRED when this id's SAME phase already rode its text.start
          // (the live case); kept — lossless — when only the run-item knows it,
          // or knows a different value.
          // PH-2: null/"" is no marker at all (sp-protocol ruling (a)) — neither
          // a carry nor a late-phase ext.
          const lateItemPhase = vendorPhase(item.phase);
          if (lateItemPhase !== undefined && carriedPhase.get(item.id) !== lateItemPhase) {
            if (isStashedTextStream(item.id)) {
              // PH-2 case (ii): the round close is STASHED (a deferred tool
              // round), so this block's text.end is NOT yet emitted — the §5
              // timing rule makes the end the phase's home (sp-protocol,
              // 2026-09-23). The marker has a first-class home, so no late-phase.
              const interim = interimAtStart.has(item.id) ? undefined : interimPhase(lateItemPhase);
              const endMeta = openaiProviderMeta({ phase: lateItemPhase });
              stashedEndFields.set(item.id, {
                ...(endMeta !== undefined ? { providerMetadata: endMeta } : {}),
                ...(interim !== undefined ? { phase: interim } : {}),
              });
            } else {
              // Case (iii): this block's text.end is already out — never a
              // second end; the vendor marker rides the lossless ext.
              a.emitExt("openai", "late-phase", { itemId: item.id, phase: lateItemPhase });
            }
          }
          continue;
        }
        // OA-14: id first, FIFO fallback — see "Correlation" in the doc above.
        const streamId =
          item.id !== undefined && openTextStreams.has(item.id) ? item.id : openTextStreams.values().next().value;
        if (streamId === undefined) continue; // defensive: no matching open stream
        openTextStreams.delete(streamId);
        const citations = mapAnnotationsToCitations(part.annotations, part.text);
        // phase (0.14.0) rides the matching text.end's providerMetadata —
        // PER-PART, not message.metadata: this facet folds a response into ONE
        // message, and a program-driven turn emits multiple message items with
        // DIFFERENT phases (commentary vs final_answer) whose message-level
        // merge would clobber (see OpenAIAssistantMessageItem.phase's doc).
        const itemPhase = vendorPhase(item.phase);
        const phaseMeta = openaiProviderMeta({ phase: itemPhase });
        // PH-2 case (i): known before this block's text.end ⇒ the end carries
        // the first-class phase, unless text.start already did.
        const endInterim = interimAtStart.has(streamId) ? undefined : interimPhase(itemPhase);
        a.textEnd(
          streamId,
          msgId,
          citations !== undefined || phaseMeta !== undefined || endInterim !== undefined
            ? {
                ...(citations !== undefined ? { citations } : {}),
                ...(phaseMeta !== undefined ? { providerMetadata: phaseMeta } : {}),
                ...(endInterim !== undefined ? { phase: endInterim } : {}),
              }
            : undefined,
        );
      }
    }
  }

  /**
   * OA-11: open the reasoning block for `rsId` in the current message — once per
   * id (a re-announce, or an id already filled, is a no-op). `id` and `itemId`
   * are both the `rs_` id (the run-item path's convention). Called from
   * `output_item.added{reasoning}` so the block takes its WIRE position, and
   * defensively from the terminal fill for an item never announced.
   */
  function openReasoningBlock(rsId: string): void {
    if (msgId === undefined || rsId.length === 0) return;
    if (openReasoning.has(rsId) || filledReasoning.has(rsId)) return;
    a.emit({ type: "reasoning.start", id: rsId, messageId: msgId, itemId: rsId });
    openReasoning.set(rsId, msgId);
  }

  /**
   * OA-11: fill + seal an OPEN reasoning block: one `reasoning.delta` per
   * non-empty summary part (`partIndex` = the wire `summary_index`), then
   * `reasoning.opaque` (the replayable ciphertext, `itemId` = rs_) BEFORE
   * `reasoning.end`, so "sealed" means complete (sp-protocol's recommendation;
   * the Claude signature-before-stop order). The facet never consumes
   * `response.reasoning_summary_text.delta` (the raw default arm drops it), so
   * this is the ONLY place summary text is emitted — no double under INV-DELTA.
   */
  function fillReasoningBlock(
    rsId: string,
    summary: ReadonlyArray<{ partIndex: number; text: string }>,
    encryptedContent: string | undefined,
  ): void {
    const mId = openReasoning.get(rsId);
    if (mId === undefined) return;
    for (const part of summary) {
      if (part.text.length > 0) {
        a.emit({ type: "reasoning.delta", id: rsId, messageId: mId, delta: part.text, partIndex: part.partIndex });
      }
    }
    if (encryptedContent !== undefined) {
      a.emit({
        type: "reasoning.opaque",
        id: rsId,
        messageId: mId,
        kind: "ciphertext",
        value: encryptedContent,
        provider: "openai",
        itemId: rsId,
      });
    }
    a.reasoningEnd(rsId, mId);
    openReasoning.delete(rsId);
    filledReasoning.add(rsId);
  }

  /** OA-11: fill every reasoning block from a terminal event's `response.output`
   *  (see `terminalReasoningItems` for why this, not `output_item.done`, is the
   *  source). An item never announced by `output_item.added` opens here
   *  (defensive — position is then the terminal event's). */
  function fillReasoningFromTerminalOutput(output: JsonValue | undefined): void {
    for (const item of terminalReasoningItems(output)) {
      if (filledReasoning.has(item.id)) continue;
      openReasoningBlock(item.id);
      fillReasoningBlock(item.id, item.summary, item.encryptedContent);
    }
  }

  /**
   * Map a `reasoning_item_created` run-item (Task 3, audit M48). Since OA-11 it
   * is the FALLBACK source: on the live wire it lands after `response.completed`,
   * whose output already filled the block, so a run-item whose `rs_` id is in
   * `filledReasoning` is a no-op (single source per id — no duplicate block, no
   * `late-reasoning` ext). If raw `output_item.added` opened the block but no
   * terminal output has filled it yet, the run-item fills that block in place.
   * Only with NO raw reasoning events for the id (run-item-only streams) does the
   * pre-OA-11 mapping below still run, unchanged:
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
    // OA-11 dedupe: already filled from the terminal output (or an earlier run-item).
    if (item.id !== undefined && filledReasoning.has(item.id)) return;
    // OA-11: raw `output_item.added` opened this block; no terminal output has
    // filled it yet (synthetic ordering) — fill it in place from the run-item,
    // whose `content[]` IS the raw `summary[]` (one part per index).
    if (msgId !== undefined && item.id !== undefined && openReasoning.has(item.id)) {
      const enc = item.providerData?.encrypted_content;
      fillReasoningBlock(
        item.id,
        item.content.map((p, partIndex) => ({ partIndex, text: p.text })),
        typeof enc === "string" && enc.length > 0 ? enc : undefined,
      );
      return;
    }
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
    // OA-11: a terminal output naming this rs_ later must not open a second block.
    if (itemId !== undefined) filledReasoning.add(itemId);
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
    rawItem:
      | OpenAIShellCallResultItem
      | OpenAIApplyPatchCallResultItem
      | OpenAIComputerCallResultItem
      | OpenAIProgramCallResultItem,
  ): void {
    const toolCallId = rawItem.callId;
    let content: AgBlock[];
    let outcome: ToolOutcome;
    let structuredContent: JsonValue | undefined;
    let providerMetadata: AgProviderMeta | undefined;
    if (rawItem.type === "shell_call_output") {
      content = [];
      for (const entry of rawItem.output) {
        const text = [entry.stdout, entry.stderr].filter((s) => s.length > 0).join("\n");
        if (text.length > 0) content.push({ type: "text", text });
      }
      // 0.14.0: the NEW item-level `status` joins the per-command outcome
      // scan — `incomplete` (e.g. a truncated command list) must not fold as
      // success even when every command that DID run exited clean.
      outcome =
        shellOutputHasError(rawItem.output) || rawItem.status === "incomplete" ? "error" : "ok";
      // The full per-command record (stdout/stderr/exit code) is lossy to
      // collapse into text-only content — carry it verbatim as structuredContent
      // too (mirrors the function_call path's ggui-cache-marker precedent).
      structuredContent = JsonValue.parse(rawItem.output);
      // The outcome mapping alone cannot recover `status` ('in_progress' vs
      // 'completed' vs absent all map ok) — carry it verbatim, with caller.
      providerMetadata = openaiProviderMeta({
        caller: callerToJson(rawItem.caller),
        status: rawItem.status,
      });
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
    } else if (rawItem.type === "program_output") {
      // 0.14.0 programmatic tool calling: bare-string output (mirrors the
      // apply_patch arm); the CLOSED status enum's `incomplete` -> error
      // (same rule as function_call_result — never success).
      content = rawItem.output.length > 0 ? [{ type: "text", text: rawItem.output }] : [];
      outcome = rawItem.status === "incomplete" ? "error" : "ok";
    } else {
      content = rawItem.output !== undefined && rawItem.output.length > 0 ? [{ type: "text", text: rawItem.output }] : [];
      outcome = rawItem.status === "failed" ? "error" : "ok";
      providerMetadata = openaiProviderMeta({ caller: callerToJson(rawItem.caller) });
    }
    const doneTurnId = resolvePendingTurnId(toolCallId);
    a.toolDone({
      toolCallId,
      content,
      outcome,
      isError: outcome === "error",
      ...(structuredContent !== undefined ? { structuredContent } : {}),
      ...(providerMetadata !== undefined ? { providerMetadata } : {}),
      ...(doneTurnId !== undefined ? { turnId: doneTurnId } : (openTurnForLeadingResult(toolCallId) ?? {})),
    });
    drainPendingTool(toolCallId, doneTurnId);
  }

  /** Synthesize `name` for the built-in discriminants that carry none on the
   *  wire (§8 quirk) — `shell_call`/`apply_patch_call`/`computer_call`/
   *  `program` have no `name` field at all; `hosted_tool_call` already
   *  carries a real one. (`program`'s wrapper-layer `RunToolCallItem.toolName`
   *  synthetic `'programmatic_tool_calling'` is deliberately NOT adopted —
   *  this facet derives names from the rawItem only; see
   *  {@link OpenAIProgramCallItem}.) */
  function builtinToolName(
    rawItem:
      | OpenAIShellCallItem
      | OpenAIApplyPatchCallItem
      | OpenAIComputerCallItem
      | OpenAIHostedToolCallItem
      | OpenAIProgramCallItem,
  ): string {
    if (rawItem.type === "shell_call") return "builtin:shell";
    if (rawItem.type === "apply_patch_call") return "builtin:apply_patch";
    if (rawItem.type === "computer_call") return "builtin:computer";
    if (rawItem.type === "program") return "builtin:program";
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
  /**
   * OA-13: did OpenAI (the provider) already execute this built-in call? →
   * `tool.start.providerExecuted` (SPEC:632; SPEC:496 "client MUST NOT
   * execute"). Per the installed runtime (agents-core 0.18.0
   * `dist/runner/modelOutputs.mjs`): `hosted_tool_call` always (resolved
   * server-side, :443); `program` always (programmatic tool calling is a hosted
   * tool, :23-28, whose `program_output` arrives in the MODEL output, :435-441);
   * `shell_call` only for a hosted-container shell ("Hosted container shell is
   * executed by the API provider", :511-517), which the item shows as
   * `providerData.environment.type` ≠ `"local"` (openai-node 7.22.0
   * `ResponseLocalEnvironment | ResponseContainerReference | null`, spread into
   * providerData by agents-openai's converter :1318). `computer_call` /
   * `apply_patch_call` run client-side → false (the key is then omitted).
   */
  function builtinProviderExecuted(
    rawItem:
      | OpenAIShellCallItem
      | OpenAIApplyPatchCallItem
      | OpenAIComputerCallItem
      | OpenAIHostedToolCallItem
      | OpenAIProgramCallItem,
  ): boolean {
    if (rawItem.type === "hosted_tool_call" || rawItem.type === "program") return true;
    if (rawItem.type === "shell_call") {
      const env = rawItem.providerData?.environment;
      return isJsonObject(env) && typeof env.type === "string" && env.type !== "local";
    }
    return false;
  }

  function driveBuiltinToolCalled(
    rawItem:
      | OpenAIShellCallItem
      | OpenAIApplyPatchCallItem
      | OpenAIComputerCallItem
      | OpenAIHostedToolCallItem
      | OpenAIProgramCallItem,
  ): void {
    ensureResponseOpen();
    if (msgId === undefined) return; // unreachable post-ensure; satisfies narrowing
    const toolCallId = rawItem.type === "hosted_tool_call" ? (rawItem.id ?? rawItem.name) : rawItem.callId;
    const name = builtinToolName(rawItem);
    // Caller provenance (0.14.0): typed only on the shapes the wire declares
    // it for — computer_call and program carry none (protocol.d.ts).
    const caller =
      rawItem.type === "shell_call" || rawItem.type === "apply_patch_call" || rawItem.type === "hosted_tool_call"
        ? rawItem.caller
        : undefined;
    const startMeta = openaiProviderMeta({ caller: callerToJson(caller) });
    a.toolStart({
      toolCallId,
      name,
      ...(rawItem.id !== undefined ? { itemId: rawItem.id } : {}),
      ...(startMeta !== undefined ? { providerMetadata: startMeta } : {}),
      // OA-13: see builtinProviderExecuted().
      ...(builtinProviderExecuted(rawItem) ? { providerExecuted: true } : {}),
      messageId: msgId,
    });
    const input: JsonValue =
      rawItem.type === "shell_call"
        ? JsonValue.parse(rawItem.action)
        : rawItem.type === "apply_patch_call"
          ? JsonValue.parse(rawItem.operation)
          : rawItem.type === "computer_call"
            ? JsonValue.parse(rawItem.actions ?? rawItem.action ?? {})
            : rawItem.type === "program"
              ? // The call's whole wire payload, verbatim (the shell/apply-patch
                // precedent): `code` is the model-authored program source.
                { code: rawItem.code, fingerprint: rawItem.fingerprint }
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
      // OA-13: the item says where it ran — only `execution:"server"` is the
      // provider's (SPEC:496); "client" (the SDK's own loader / a custom
      // execute()) and absent leave the key off.
      ...(rawItem.execution === "server" ? { providerExecuted: true } : {}),
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
    // agents-core 0.18.0 discovery attribution (`toolSearchAgentName`) — the
    // ONE protocol delta in the 0.17.0→0.18.0 span. Carried verbatim on the
    // tool lifecycle that already surfaces this search's attribution, following
    // the `executionStatus` precedent (`tool.done` providerMetadata, dropped
    // entirely when absent — `openaiProviderMeta` returns `undefined` for an
    // all-undefined bag, so an output without it is byte-identical to the
    // pre-0.18.0 emission). Read through `unknown` + a typeof guard: this is
    // the deserialization boundary, where a non-string would otherwise reach
    // `AgProviderMeta.parse`.
    const rawAgentName: unknown = rawItem.toolSearchAgentName;
    const searchMeta = openaiProviderMeta({
      toolSearchAgentName: typeof rawAgentName === "string" ? rawAgentName : undefined,
    });
    a.toolDone({
      toolCallId,
      content,
      outcome: "ok",
      ...(searchMeta !== undefined ? { providerMetadata: searchMeta } : {}),
      ...(doneTurnId !== undefined ? { turnId: doneTurnId } : (openTurnForLeadingResult(toolCallId) ?? {})),
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
    // O1 (§8.0 item 14 as amended): a host-fed error arriving while a round's
    // close is deferred releases that close per INV-FLUSH (2) BEFORE the
    // normalizer closes the error (PS-21).
    releaseAllDeferredCloses();
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
          // computer_call_result finding + the 0.14.0 program_output carry:
          // Shell/Apply-Patch/Computer-Use/Program results do NOT share
          // `OpenAIFunctionCallResultItem.output`'s shape — see
          // `driveBuiltinToolOutput`'s doc for why the generic path below is
          // wrong for them (the orphan-hazard this adaptation fixes).
          if (
            rawItem.type === "shell_call_output" ||
            rawItem.type === "apply_patch_call_output" ||
            rawItem.type === "computer_call_result" ||
            rawItem.type === "program_output"
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
          // workspace#21: `customData._meta` → block `_meta`; with `_meta.ui` the
          // payload is MCP-Apps view data → ALSO `uiData` (SPEC.md:332), leaving
          // `structuredContent` as it was (the :340 mapping; ggui's cache marker
          // rides it). §2.1's "exactly one consumer" is per channel (sp-protocol,
          // option A). Mirrors claude-agent-sdk/src/index.ts:1926-1946.
          const resultMeta = extractResultMeta(event.item.customData);
          // A CLONE, not an alias: the two channels reach different consumers, and
          // one mutating its copy must not reach the other.
          const uiData =
            resultMeta !== undefined && resultMeta["ui"] !== undefined && structuredContent !== undefined
              ? JsonValue.parse(structuredContent)
              : undefined;
          // Task 4b: resolve the OWNING turn explicitly (this result may land
          // after a later round has opened, so the engine's #lastTurn backfill
          // could misattribute it) and pass it through so toolDone binds to the
          // correct — possibly already-closed-pending-this-result — turn.
          const doneTurnId = resolvePendingTurnId(rawItem.callId);
          // Caller provenance (0.14.0) — the result item's own optional field,
          // distinct from the call-side carry on tool.start — and the 0.15.0
          // wrapper-level `executionStatus` marker (see the projection's doc):
          // both verbatim, both dropped when absent.
          const doneMeta = openaiProviderMeta({
            caller: callerToJson(rawItem.caller),
            executionStatus: event.item.executionStatus,
          });
          a.toolDone({
            toolCallId: rawItem.callId,
            content,
            outcome,
            isError: rawItem.status === "incomplete",
            ...(structuredContent !== undefined ? { structuredContent } : {}),
            ...(uiData !== undefined ? { uiData } : {}),
            ...(resultMeta !== undefined ? { _meta: resultMeta } : {}),
            ...(doneMeta !== undefined ? { providerMetadata: doneMeta } : {}),
            ...(doneTurnId !== undefined ? { turnId: doneTurnId } : (openTurnForLeadingResult(rawItem.callId) ?? {})),
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
            // §"Spike Findings"). Caller provenance (0.14.0) rides that same
            // authoritative raw item (verbatim openai-node ≥6.46 wire), so
            // ignoring the wrapper copy here loses nothing.
            return;
          }
          // Finding #1 (critical): Shell / Apply-Patch / Hosted-tool /
          // Program built-ins — this run-item wrapper (not the raw stream) is
          // the SOLE tool-start source for these (see `driveBuiltinToolCalled`'s
          // doc).
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
          // FALLBACK source since OA-11 (the raw terminal output fills first; an
          // already-filled rs_ is a no-op) — see driveReasoningItemCreated's docstring.
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
          const handoffTurnId = `turn_${invokeStem}_handoff_${ordinal}`;
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
        case "compaction_item_created": {
          // 0.14.3: a compaction marker returned by the model — the openai
          // analog of the claude facet's compaction content block, mapped to
          // the SAME first-class §4 vocabulary (cross-framework convergence:
          // one compaction shape for every folded consumer). The
          // `encrypted_content` blob is replay-load-bearing (spec §2/§8) and
          // rides the block's ciphertext opaque, exactly like claude's.
          // `id`/`created_by` are narrow disclosed residuals (the compaction
          // AgBlock arm carries no provider-metadata slot — a spec-process
          // decision, recorded in sdk-surface.json). No messageId: the marker
          // is turn-scoped, not message-scoped — the engine backfills turnId.
          const item = event.item.rawItem;
          a.contentBlock(undefined, {
            type: "compaction",
            opaque: {
              kind: "ciphertext",
              value: item.encrypted_content,
              provider: "openai",
            },
            provider: "openai",
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
          askedApprovals.set(item.callId, `approval_${item.callId}`);
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
      // LV: a host may push the SDK's LIVE stream objects (undefined members,
      // Dates, class instances, cycles), not the JSON round-tripped shape the
      // corpus records, and the carried-member `JsonValue.parse` sites threw a
      // ZodError on them (sp-main's no-throw check, 2026-09-24: 6 of 9 live
      // shapes). The native arrives already normalized: `withAtomicPush` ran core's
      // `toJsonValueSafe` on it (JSON semantics per node: toJSON honoured,
      // undefined dropped, Date → ISO string), and it owns the no-throw
      // guarantee too. This inner push MUST NOT catch; a throw here is the
      // wrapper's signal to discard the batch and rebuild.
      if (!isOpenAIStreamEvent(native)) {
        // Graceful guard (Tenet 6): route a genuinely unrecognisable payload through
        // the lossless vendor channel rather than throwing. Nest under `native` so a
        // payload carrying its own `type` key does NOT clobber the event type.
        // A COPY via JsonValue.parse, like every other carry path: plain input
        // arrives by reference, so carrying it as-is would alias the host's
        // object into an emitted event, and would forward an own `__proto__`
        // key (sp-cto's checks, 2026-09-24).
        a.emitExt("openai", "unparsed", { native: JsonValue.parse(native) });
        return a.drain();
      }
      drive(native);
      return a.drain();
    },
    flush(): AgEvent[] {
      // O1 (INV-FLUSH as amended; fold/flush option 1): release the deferred
      // closes FIRST — they are older rounds, so their message.end precedes the
      // live response's (insertion order, CB-16) — as paused / verbatim /
      // message.end+usage then turn.abort (`releaseDeferredClose`); a flush
      // never emits a success turn.done.
      releaseAllDeferredCloses();
      // Then close any dangling open response (a stream that ended before
      // response.completed): its message ends here and the engine's flush
      // aborts its turn as stream-truncated.
      if (turnId !== undefined) closeResponse();
      // Flush the engine's dangling open messages / turns (I7).
      return a.flush();
    },
  };
}
