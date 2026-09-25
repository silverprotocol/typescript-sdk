/**
 * replay.test.ts — the KEYLESS replay CI gate.
 *
 * Four suites:
 *
 * 1. Claude seed corpus (text-tool-turn / complete-result / app-spec /
 *    convergence-echo):
 *    For each committed `claude.native.json`:
 *      a. `replayCassette(native)` → drive the REAL Claude facet normalizer.
 *      b. SNAPSHOT: assert produced `agjson` deep-equals `claude.agjson.json`.
 *      c. GATE: assert `report.drops === []` AND `report.newFields === []`.
 *
 * 2. OpenAI seed corpus (text-tool-turn / convergence-echo):
 *    For each committed `openai.native.json` (REAL @openai/agents capture):
 *      a. `replayCassette(native)` → drive the REAL OpenAI facet normalizer.
 *      b. SNAPSHOT: assert produced `agjson` deep-equals `openai.agjson.json`.
 *      c. GATE: assert `report.drops === []` AND `report.newFields === []`.
 *
 * 3. ADK seed corpus (convergence-echo / text-tool-turn):
 *    For each committed `adk.native.json` (hand-authored ADK `Event` fixture):
 *      a. `replayCassette(native)` → drive the REAL ADK facet normalizer.
 *      b. SNAPSHOT: assert produced `agjson` deep-equals `adk.agjson.json`.
 *      c. GATE: assert `report.drops === []` AND `report.newFields === []`
 *         (audit M59 — this gate previously did not exist; the ADK facet's
 *         census was 100% unmeasured. Every drop/newField below is triaged
 *         into `transforms.json` / `known-acceptable-drops.json` per the
 *         Task 3 shapes, cited to `google-adk/src/index.ts` — see the Task 4
 *         report for the full triage table).
 *
 * 4. I4 cross-framework convergence gate:
 *    For each scenario that has ALL THREE of `claude.native.json`,
 *    `openai.native.json` AND `adk.native.json`:
 *      a. Replay all three cassettes to produce their respective AgJSON streams.
 *      b. GATE (audit M59): assert EACH framework's `report.drops === []` AND
 *         `report.newFields === []` — the census is no longer computed then
 *         discarded; a real per-framework drop on a convergence scenario now
 *         fails this leg directly, not just the seed-corpus suites above.
 *      c. `canonicalizeAgjson` each stream → CanonicalSchema.
 *      d. `assertConvergent` 3× pairwise (claude↔openai, claude↔adk, openai↔adk)
 *         → throws on structural divergence.
 *    Scenarios missing any framework cassette are SKIPPED gracefully.
 *
 * ★ This is a MACHINERY + SNAPSHOT self-consistency gate, NOT a real-lossiness
 *   gate ★ — the Claude seeds are hand-authored SDKMessage shapes; the OpenAI
 *   seed is a real @openai/agents stream capture. Both prove the pipeline runs
 *   and lock the shape; the real lossiness hunt is a LIVE capture.
 *   See `replay.ts`'s header for the full framing.
 */
import { describe, it, expect } from "vitest";
import { readFile, readdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@silverprotocol/core";
import { type AgClosedEventType, AgEvent, Reducer } from "@silverprotocol/core";
import { replayCassette } from "./replay.js";
import { canonicalizeAgjson, assertConvergent } from "./convergence.js";

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");

/**
 * Every Claude seed scenario under corpus/ that ships a committed native cassette.
 * `convergence-echo` joins this list per audit M58: it was previously the ONLY
 * live convergence check with NO snapshot/census backstop of its own — the
 * vacuity-holed I4 assert was its sole gate. It now gets the same
 * agjson-snapshot + census-clean machinery gate every other seed gets.
 *
 * `echo-sonnet5` joins this list per the 2026-07-03 model-release playbook: the
 * FIRST live capture against the new `claude-sonnet-5` model (kind:"capture",
 * real sdkVersion — see corpus/echo-sonnet5/claude.provenance.json), landing the
 * new model's wire shape as a standing measurement rather than a one-off probe.
 */
const CLAUDE_SEEDS = [
  "text-tool-turn",
  "complete-result",
  "app-spec",
  "convergence-echo",
  "echo-sonnet5",
  // 2026-07-25 (workspace#2): the *_update / re-render carry-fidelity sequence
  // — render_card then update_card against ONE ui resourceUri (kind:"capture",
  // claude-sonnet-5 @0.3.217 — see corpus/app-update-sonnet5/claude.provenance.json).
  "app-update-sonnet5",
  // 2026-08-07 (workspace#7): stream_event partials (includePartialMessages:
  // true) — token-granular deltas interleaved with the complete frames they
  // dedupe against, incl. the live wire's binding-before-message_stop ordering
  // (kind:"capture", claude-sonnet-5 @0.3.221 — see
  // corpus/partials-sonnet5/claude.provenance.json).
  "partials-sonnet5",
  // 2026-09-02 (cohort 0.5.4, model-release playbook): the FIRST live captures
  // against `claude-fable-5-1` (GA 2026-09-01; Claude Code 2.1.257+ knows the
  // id, so these ride the @anthropic-ai/claude-agent-sdk 0.3.258 bump).
  // echo/partials/app-update mirror the sonnet5 trio so the two model families
  // stay diffable (kind:"capture", @0.3.258 — see corpus/*-fable51/
  // claude.provenance.json).
  //
  // 2026-09-23 (cohort 0.6.3) status of the trio: echo- and partials-fable51 are
  // refreshed at 0.3.280. partials-fable51 is now a PARTIALS-GRAMMAR seed only:
  // with thinking.display unset, CLI 2.1.280 runs in connector_text mode and the
  // API returns no thinking summary, so this scenario streams no thinking at all
  // (three 0.6.3 re-captures confirmed it; the 0.6.2 refresh had already lost it).
  // Streamed thinking moved to the dedicated thinking-fable51 seed below.
  // app-update-fable51 is DELIBERATELY HELD at its 0.3.272 capture: it is the
  // corpus's only live evidence for narration_block_indexes (the 0.6.2 carry),
  // and three 0.3.280 re-captures produced no narration. Refresh it only with a
  // run that narrates (the guard below fails otherwise).
  "echo-fable51",
  "partials-fable51",
  "app-update-fable51",
  // 2026-09-23 (cohort 0.6.3): the corpus's live STREAMED-THINKING seed. The
  // scenario's thinkingDisplay:"summarized" knob sets the Agent SDK's
  // thinking {type:"adaptive", display:"summarized"}, so thinking blocks and
  // their summary text reach the stream deterministically instead of by chance.
  // First capture: 1 thinking block, 13 thinking_delta (all with summary text),
  // 1 signature_delta, 14 system/thinking_tokens frames.
  "thinking-fable51",
  // 2026-09-23 (cohort 0.6.3, model-release playbook): FIRST live captures on
  // claude-opus-5-5 (GA 2026-09-22; needs Claude Code 2.1.280 / sdk 0.3.280 -
  // older CLIs still send the id but canonicalise it to claude-opus-5, so they
  // price it, default its effort and report canonicalModel as Opus 5). A seeded probe, not the working
  // default: Opus pricing, and thinking cannot be switched off. With display
  // unset none of the three streamed thinking (see the partials-fable51 note).
  "echo-opus55",
  "partials-opus55",
  "app-update-opus55",
  // 2026-09-23 (cohort 0.6.3): claude-opus-5 (GA 2026-07-24) had no corpus seed.
  // Approved 2026-09-15. It is also a Claude Code 2.1.280 refusal-
  // fallback target (bio and frontier_llm refusals; cyber refusals go to
  // claude-opus-4-8), so Opus 5 frames can appear mid-session for consumers who
  // never chose it.
  "echo-opus5",
  // 2026-09-23: the corpus's first MULTI-RESULT invoke (the claude facet's
  // change B live receipt, per the spec: ≥2 results in ONE streaming-input invoke → ≥2
  // AgTurnRecords, each closed once). claude-sonnet-5 @0.3.280; the scenario's
  // `followUps` streams a second prompt into the same query() after the first
  // result. Live: 2 result frames with result_index 0 and 1 (the first live
  // NON-zero result_index; queued_turn_count 0), and the first live
  // user_message_uuid(s) (harness-minted prompt uuids). Folds to 2 turns with
  // distinct per-result turnIds, needsResync false.
  "multi-result-sonnet5",
  // 2026-09-25 (R&D candidate 7, client correlation): the first STREAMED invoke
  // with caller-minted prompt uuids. multi-result's `followUps` (streaming input,
  // a harness-minted uuid per prompt) plus includePartialMessages;
  // claude-sonnet-5 @0.3.280. Live: each prompt's first stream_event
  // (message_start) carries user_message_uuid(s), carried as message.metadata;
  // the first round's complete assistant frame repeats it, the post-tool round
  // does not, and the result repeats it. Folds to 2 turns, needsResync false.
  "partials-uuid-sonnet5",
  // 2026-09-23 (probe queue item 1): the FIRST error seed and the first
  // cassette with is_error:true. The scenario flag expectError keeps the
  // natives the SDK yielded before it threw (the throw is in provenance note).
  // It was captured with a deliberately invalid key (sdk 0.3.280,
  // claude-sonnet-5): 10 system api_retry frames, a synthetic assistant
  // frame with error:authentication_failed, then a success result with
  // is_error:true, api_error_status 401. It folds to
  // turn.error{authentication_failed, retriable:false}, and result-meta
  // carries apiErrorStatus 401 + stopReason (c54eb7f). Enrolled
  // once the claude facet's six dispositions landed.
  "api-error-auth",
  // 2026-09-23 (R&D candidate 20, leg 1 of 3): the first DEFERRED tool call.
  // The scenario knob preToolUseDecision "defer" installs a PreToolUse hook
  // (a22d669), claude-sonnet-5 @0.3.280. The model calls
  // mcp__t__echo, the hook defers it, and the run ends with no throw: result
  // stop_reason and terminal_reason "tool_deferred", deferred_tool_use
  // {id, name, input}. It folds to turn.done{success, finishReason
  // "unknown", finishReasonRaw "tool_deferred"} with the tool block left open
  // (no tool.done). result-meta carries deferredToolUse. The resume legs
  // (resumeFrom this seed; allow / deny) are separate cassettes.
  "defer-tool-sonnet5",
  // 2026-09-23 (rnd capture #1, capture backlog "MCP resource_link"): the
  // first live resource_link tool result, from the new resource-link mock
  // (find_doc returns a text block + one fully populated resource_link).
  // claude-sonnet-5 @0.3.280. The CLI flattens the link into a text block
  // "[Resource link: <name>] <uri> (<description>)" in the tool_result
  // content and keeps the structured copy in tool_use_result.resourceLinks.
  // Since draft.5 (pkg-05) the facet carries that list as a host record on the
  // tool.done's `_meta["anthropic/resourceLinks"]` (through 0.7.x it rode
  // providerMetadata.resourceLinks). All eight leaves are pinned by transforms:
  // the flattened text repeats uri/name/description, so value-match alone
  // could not prove the carry.
  "resource-link-sonnet5",
  // 2026-09-23 (rnd #4, rnd 13+17 Claude leg): Opus 5.5 @0.3.280 with
  // includePartialMessages + thinkingDisplay "summarized", two sequential MCP
  // tools, and a steer asking for a one-sentence progress update before each
  // call. The model writes both updates (58- and 73-char text blocks before
  // each tool_use), but Claude Code stamps narration_block_indexes on NO frame
  // (0 occurrences, partials included), so the facet marks no phase:"interim"
  // (0 phase events). The only corpus stamp is still app-update-fable51, in
  // connector_text mode (display unset), where narration blocks come back
  // EMPTY. So the Claude SHOULD can never fire with text on CLI 2.1.280.
  "narration-opus55",
  // 2026-09-25 (c20; §8.0 item 32, §10 item 47 pair-claude): the two resume
  // legs of the deferred tool (resumeFrom defer-tool-sonnet5, forked; hook
  // allow / deny). The resumed invoke's first frame is the deferred call's
  // tool_result, before system init: the facet opens the invoke's own turn
  // first and lands the result as a role:"tool" message "<toolCallId>:result"
  // in it. Each leg folds clean on its own and after leg 1 through one Reducer
  // with one threadId (defer-resume.test.ts); leg 1 closes paused with one
  // approval ask.
  "defer-tool-sonnet5-resume-allow",
  "defer-tool-sonnet5-resume-deny",
  // Still unenrolled (candidate-20 bar, package decision 6):
  // -resume-unavailable (no MCP server on resume, so the tool is gone). The
  // FIRST result (before init) has is_error:true and stop_reason /
  // terminal_reason "tool_deferred_unavailable", with the same
  // deferred_tool_use and an empty result. It folds as a turn.error close,
  // then the prompt's own success turn.

  // 2026-09-25 (nested-turn capture ask): the first live Claude subagent runs
  // (claude-sonnet-5 @ claude-agent-sdk 0.3.280, captured with auto-memory off
  // and Agent isolation stripped). fg: the nested run closes success before
  // subagent.done, and the Agent run report rides tool.done _meta
  // ["anthropic/agentOutput"]. bg: async_launched keeps the nested run open past
  // its parent's close; a task_notification closes it success and wakes a turn
  // whose result carries origin. fail: a subagent model the API rejects closes
  // the nested turn turn.error{code "failed"}. Ambient values the census cannot
  // value-match are transforms onto where they are carried.
  "subagent-fg-sonnet5",
  "subagent-bg-sonnet5",
  "subagent-fail-sonnet5",
] as const;

/**
 * Every OpenAI seed scenario under corpus/ that ships a committed native cassette.
 * `convergence-echo` joins this list per audit M58 (see the CLAUDE_SEEDS comment).
 *
 * HISTORICAL SEED (stated 2026-09-23 so it stops reading as silent staleness):
 * `echo-gpt55` is deliberately kept at its 2026-07-03 @openai/agents 0.12.0
 * capture as a frozen record of the gpt-5.5 wire; it is not refreshed. Its
 * sibling `app-spec-structured-result` IS refreshed (0.6.3: gpt-5.6-sol at
 * 0.18.0), because it is the only live proof of the structuredContent ->
 * item.customData channel and its name pins no model.
 *
 * `echo-gpt55` joins this list per the 2026-07-03 model-release playbook: the
 * FIRST live capture against the new `gpt-5.5` model (kind:"capture", real
 * sdkVersion — see corpus/echo-gpt55/openai.provenance.json). This capture is
 * ALSO what surfaced Finding #2 (the facet's `toolOutputToAgBlocks` missing the
 * `input_text` array-form discriminant, silently dropping every MCP tool
 * result under `@openai/agents-core` 0.12.0) — fixed the same playbook step.
 *
 * `app-spec-structured-result` joins this list per the 2026-07-03 playbook
 * FOLLOW-UP: the FIRST live capture of a structuredContent-bearing MCP tool
 * (render_card) against gpt-5.5 / agents-core 0.12.0 (kind:"capture" — see
 * corpus/app-spec-structured-result/openai.provenance.json). This capture
 * proves `extractStructuredContent`'s `item.customData.structuredContent`
 * channel end-to-end (the fix for the exploratory finding the echo-gpt55
 * playbook step reported but did not fix — see the openai-agents facet's
 * `extractStructuredContent` doc for the full wire-truth citations).
 */
const OPENAI_SEEDS = [
  "text-tool-turn",
  "convergence-echo",
  "echo-gpt55",
  "app-spec-structured-result",
  // 2026-07-13 model-release playbook (same rationale as echo-sonnet5): the
  // FIRST live capture against gpt-5.6 (@openai/agents 0.13.2), landing the
  // new model's wire shape as a standing measurement rather than a one-off
  // probe (kind:"capture" — see corpus/echo-gpt56/openai.provenance.json).
  "echo-gpt56",
  // 2026-09-05 (cohort 0.6.1): FIRST live capture against gpt-6-astra (GA
  // 2026-09-03; no dated snapshot, reasoning cannot be disabled) through
  // @openai/agents 0.17.0 + openai-node 7.10.0 (kind:"capture" — see
  // corpus/echo-gpt6astra/openai.provenance.json).
  "echo-gpt6astra",
  // 2026-09-23 (cohort 0.6.3): FIRST live captures on gpt-6-sol and gpt-6-luna
  // (GA 2026-09-22) at @openai/agents 0.18.0 + openai-node 7.22.0. The SDK has no
  // model-specific settings for either, so both run at the API-default effort
  // medium. echo-gpt6sol is the FIRST openai seed that actually reasons (30
  // reasoning tokens): its reasoning item arrives as response.output_item.done
  // BEFORE response.completed, while the SDK's reasoning_item_created comes
  // AFTER it, so the facet surfaces it only as ext.openai.late-reasoning.
  // gpt-6-luna chose not to reason on the echo.
  "echo-gpt6sol",
  "echo-gpt6luna",
  // 2026-09-23: the corpus's FIRST live `phase:"commentary"` (the gate
  // for R&D 13+17 stage 2, the draft.4 `phase` field). gpt-6-sol at
  // @openai/agents 0.18.0, reasoningSummary "auto" (echoed back as "detailed",
  // effort medium), three DEPENDENT echo calls with a system-prompt preamble
  // rule: each call's response carries a commentary message before its
  // function_call, folding as text.start.providerMetadata.phase "commentary"
  // ×3 + one "final_answer". Summaries stayed EMPTY (44/6/0 reasoning tokens).
  "commentary-gpt6sol",
  // 2026-09-23 (rnd capture #1): the resource_link leg on OpenAI (gpt-6-sol
  // @ @openai/agents 0.18.0). The agents SDK JSON-stringifies the whole MCP
  // content (text + resource_link) into the function_call_output string
  // before the stream, so tool.done carries it as ONE text block of JSON:
  // lossless as a string, but not structured.
  "resource-link-gpt6sol",
  // 2026-09-24 (fold/flush, enrolled with the group): the openai tool-approval
  // legs (gpt-6-sol @ @openai/agents 0.18.0, live, real SDK order). Leg 1 is the
  // interrupt: the round's deferred close releases as turn.done{paused, asks:[the
  // approval ask]} (openai facet O1), never success. The two resume legs are fresh
  // invokes from the saved RunState: the leading tool result opens its own turn
  // (643e322) and folds without parking. Census per the openai facet's triage: request
  // config echoes and the RunState key are allowlisted; the resumed invoke's tool
  // name joins leg 1's tool-call block by toolCallId.
  "approval-tool-gpt6sol",
  "approval-tool-gpt6sol-resume-approve",
  "approval-tool-gpt6sol-resume-reject",
  // 2026-09-24 (nested-turn capture ask; the 0.7.0 handoff regression's live
  // leg): the first live OpenAI handoff (gpt-6-sol @ @openai/agents 0.18.0).
  // The main agent transfers to "Echoer" (handoff_requested, handoff_occurred,
  // agent_updated_stream_event), which calls the mcp echo tool and answers. On
  // the openai facet's handoff close (b5d8a98) the transfer call gets its tool.done,
  // the nested handoff turn closes success before subagent.done, and the
  // source turn closes success; Echoer's rounds are top-level turns (a
  // transfer, not a sub-run).
  "handoff-gpt6sol",
  // 2026-09-25 (handoff dropped call, A′, step P2′): the live parallel-handoff
  // response (a832444; gpt-6-sol @ @openai/agents 0.18.0). The model calls
  // two transfers; agents-core runs the first and drops the second from the
  // run, so no run item ever names it. Under the per-call release (§8.0 item
  // 14, draft.5) the dropped call stops being pending at handoff_occurred:
  // ext.openai.dropped-call names it, and the source round closes
  // turn.done{success} with its usage instead of flush's turn.abort.
  "handoff-parallel-gpt6sol",
] as const;

/**
 * Every ADK seed scenario under corpus/ that ships a committed native cassette.
 * `text-tool-turn` joins this list per M58 Task 5: a hand-authored ADK fixture
 * (`corpus/text-tool-turn/adk.native.json`) producing the echo task — the SAME
 * task `text-tool-turn/openai.native.json` already captures (see the
 * CONVERGENCE_SCENARIOS comment below for why `text-tool-turn` itself is NOT
 * added to the convergence-scenario list).
 */
const ADK_SEEDS = [
  "convergence-echo",
  "text-tool-turn",
  // 2026-07-13: the FIRST live conformance capture on the OFFICIAL
  // @google/adk (1.3.0, gemini-3.5-flash) — unlike the two hand-authored
  // fixtures above, this is real captured wire (kind:"capture" — see
  // corpus/echo-gemini35/adk.provenance.json).
  "echo-gemini35",
  // 2026-07-13 mirror reconciliation: four live @google/adk 1.3.0 cassettes
  // (gemini-2.5-flash, captured 2026-07-08) originally landed DIRECTLY on the
  // public typescript-sdk mirror by a parallel migration effort and never
  // subtree-pulled back. Adopted here (native + provenance verbatim; agjson/
  // coverage REGENERATED through the current facet — per-turn usage summation
  // + current guard files postdate the mirror's derived copies).
  // 2026-09-23 (cohort 0.6.3): multi-turn, single-tool-call and text-only are
  // grammar seeds whose names pin no model; they had sat at adk 1.3.0 since
  // July and proved nothing about the current peer. MIGRATED to gemini-3.8-flash
  // at adk 2.1.0 (provenance.model changes, agjson changes by design: the
  // draft.3 thought-token fold, thought signatures). tool-error is kept as the
  // HISTORICAL gemini-2.5-flash record; see tool-error-gemini38 below.
  // echo-gemini35/36 and the gemini36/37 app-spec/thinking seeds are likewise
  // historical and model-named - replay-only, not refreshed.
  "multi-turn",
  "single-tool-call",
  "text-only",
  "tool-error",
  // 2026-07-25 ENROLLMENT REPAIR: captured 2026-07-22 (day-one gemini-3.6-flash
  // validation) and verified then via native field-set diff + ad-hoc replay,
  // but never added to this list — the "standing replay seed" claim in the
  // evidence log is CI-enforced only from this commit on.
  "echo-gemini36",
  // 2026-07-25 (workspace#2): FIRST adk MCP-Apps capture — functionResponse
  // .response carries content[]/structuredContent/_meta.ui.resourceUri through
  // the official MCPToolset (kind:"capture", gemini-3.6-flash @1.4.0 — see
  // corpus/app-spec-gemini36/adk.provenance.json).
  "app-spec-gemini36",
  // 2026-08-19 (workspace#14): day-6 gemini-3.7-flash validation trio
  // (kind:"capture", @1.6.0 — see corpus/*-gemini37/adk.provenance.json).
  // Enrolled in the SAME change as the capture, per the 2026-07-25
  // enrollment-repair lesson. thinking-gemini37 is the corpus's FIRST real
  // Gemini thought:true capture (thinkingLevel:"high" scenario knob →
  // thinkingConfig.includeThoughts — summaries are OFF by default on 3.7,
  // no other scenario can produce them): 2 thought parts + signatures →
  // reasoning.start/delta/end + reasoning.opaque.
  "echo-gemini37",
  "app-spec-gemini37",
  "thinking-gemini37",
  // 2026-09-05 (cohort 0.6.1, model-release playbook): the gemini-3.8-flash
  // trio (GA 2026-09-02; same thinking knob and price as 3.7), captured at
  // @google/adk 2.0.0 / genai 2.21.0 and enrolled at capture time.
  "echo-gemini38",
  "app-spec-gemini38",
  "thinking-gemini38",
  // 2026-09-23 (cohort 0.6.3): the error path at @google/adk 2.1.0 on
  // gemini-3.8-flash. A NEW scenario rather than a refresh of tool-error: ADK
  // registers MCP tools WITHOUT the mcp__<server>__ prefix, so tool-error's steer
  // ("mcp__errsrv__fail") names a tool that is not in the toolsDict - on 2.1.0
  // that reaches the new hallucinated-tool envelope (#790), an OPEN
  // decision. This scenario steers the bare name and records the clean MCP
  // isError path. tool-error itself stays as the historical 2.5-flash record.
  "tool-error-gemini38",
  // 2026-09-23 (rnd capture #1): the resource_link leg on ADK (gemini-3.8-flash
  // @2.1.0). MCPToolset hands the MCP content through as
  // functionResponse.response.content[*]. Since draft.5 (§8.0 item 31,
  // pkg-05) the facet maps the resource_link part to ONE resource-link block
  // carrying uri, name, title, description, mimeType, size and annotations (no
  // residual provider-raw: the link has no icons); through 0.7.x it rode whole
  // as a provider-raw block. Transforms pin the seven member leaves to the
  // block; the part's `type` (resource_link → resource-link) is an allowlisted
  // rename.
  "resource-link-gemini38",
  // 2026-09-24 (rnd, ADK shared-state fold): the corpus's first NON-EMPTY
  // actions.stateDelta. The scenario knob adkStateScript drives the ADK capture agent's
  // scripted apply_state_step tool (5bc5351): step 1 writes cfg={a:1,b:2}
  // plus temp:scratch, step 2 writes cfg={a:5}. ADK's Runner trims temp: before
  // yielding, so the native deltas are {cfg:{a:1,b:2}} then {cfg:{a:5}}, carried
  // verbatim as state.delta patches. ADK's own session.state, read back into
  // adk.session-state.json, is {cfg:{a:5}}. draft.3's one-level merge folded
  // the two patches to {cfg:{a:5,b:2}} (an R&D finding); draft.4's per-key
  // replace (pkg-21) folds them to {cfg:{a:5}}, as ADK holds, and the
  // session-state suite below pins that fold == sidecar.
  "state-fold-gemini38",
  // 2026-09-23 (rd-06 A.9 step 5): the FIRST live ADK 2.x WORKFLOW-plane
  // captures (@google/adk 2.1.0, gemini-3.8-flash), rooted at google's
  // agents/google-adk/workflow.ts graph through the scenario knob adkWorkflow.
  // Recorded with the SPEC §8.0 obligation-4 host-completion marker as the
  // last native line, so replay opts the facet into hostCompletion: "complete"
  // closes success from push() (without the marker a completed Workflow
  // flushes turn.abort), and "pause" closes paused on the approve-1 input ask.
  // They carry the plane the facet carries as provider-raw: output, route,
  // nodeInfo, isolationScope, plus actions.agentState on the pause.
  "workflow-complete-gemini38",
  "workflow-pause-gemini38",
] as const;

/**
 * Every Vercel seed scenario under corpus/ that ships a committed native
 * cassette. 2026-07-25 ENROLLMENT REPAIR (same rationale as echo-gemini36
 * above): echo-gpt56/vercel.* landed 2026-07-21/22 (facet v0 live capture,
 * re-captured at ai@7.0.34) and was verified ad-hoc in those work windows,
 * but no vercel gate list existed — this list makes the seeds CI-standing.
 */
const VERCEL_SEEDS = [
  "echo-gpt56",
  // 2026-09-05 (cohort 0.6.1): FIRST live capture against gpt-6-astra (GA
  // 2026-09-03; reasoning cannot be disabled, temperature/top_p rejected) on
  // the vercel facet at ai 7.0.93 / @ai-sdk/openai 4.0.59 — the model's wire
  // shape as a standing measurement (kind:"capture", see
  // corpus/echo-gpt6astra/vercel.provenance.json).
  "echo-gpt6astra",
  // 2026-09-23 (cohort 0.6.3): gpt-6-sol and gpt-6-luna on the vercel facet at
  // ai 7.0.111 / @ai-sdk/openai 4.0.72. Neither id is in the provider's model
  // unions; both classify like gpt-6-astra, so the provider cannot send them a
  // reasoning effort outside low..max.
  "echo-gpt6sol",
  "echo-gpt6luna",
  // 2026-09-23 (capture backlog "Vercel parallel tool calls"): two MCP tools
  // called in ONE step (echo + find_doc), gpt-6-sol @ ai 7.0.111 /
  // @ai-sdk/openai 4.0.72. The wire is two back-to-back tool-input lifecycles
  // and both tool-calls, then both tool-results, in one step. There is NO
  // `parallel` wrapper (the 4.0.45 expansion hazard did not materialize), and
  // no orphan lifecycle at flush. It folds to one message of [tool-call,
  // tool-call, tool-result, tool-result]. It also carries the vercel
  // resource_link shape: the whole MCP result lands on tool.done
  // structuredContent (transforms pin the eight resource_link leaves).
  "parallel-tools-gpt6sol",
  // 2026-09-25 (R&D capture ask, the resource_link vercel leg): the same
  // resource-link-gpt6sol scenario the claude, adk and openai legs recorded, now
  // on vercel (gpt-6-sol @ ai 7.0.111): ONE find_doc call. @ai-sdk/mcp passes the
  // MCP CallToolResult through whole on tool-result.output; the facet carries it
  // as tool.done structuredContent (the resource_link fully structured) plus
  // one text block of the same JSON. Folds to one turn, needsResync false.
  "resource-link-gpt6sol",
  // 2026-09-25 (vercel MCP finding, V1/V4 live legs): the error and MCP Apps
  // mocks on vercel, gpt-6-sol @ ai 7.0.111 + @ai-sdk/mcp. The fail tool's
  // CallToolResult {isError:true} arrives as an ordinary tool-result and folds
  // as tool.done{outcome:"error", isError:true}; render_card's _meta.ui rides
  // tool.done._meta unchanged. Both were captured before the fix and showed
  // the defects live (outcome "ok"; no _meta).
  "tool-error-gpt6sol",
  "app-spec-gpt6sol",
] as const;

/**
 * Narrow `AgEvent` to `AgClosedEventType` by ruling out the open `AgExtEvent`
 * arm (whose `type` always matches `ext.<vendor>.<key>`): that arm's
 * `.catchall(JsonValue)` index signature widens every field access on the
 * union. Same guard `reduce()` uses internally — see `AgClosedEventType`'s doc.
 */
function isClosedEvent(ev: AgEvent): ev is AgClosedEventType {
  return !ev.type.startsWith("ext.");
}

async function readSnapshotForFramework(scn: string, framework: string): Promise<JsonValue[]> {
  const raw = await readFile(join(CORPUS_ROOT, scn, `${framework}.agjson.json`), "utf8");
  return JSON.parse(raw) as JsonValue[];
}

/**
 * guuey#26 / INV-MSG — fold a cassette's `agjson` stream through the
 * NORMATIVE `Reducer` and report both faces of the invariant: parking
 * (`needsResync`) and any message id RE-OPENED after being sealed with
 * `message.end`. A cassette can be snapshot-stable AND census-clean and
 * still be UNUSABLE by a real consumer if its normalizer re-opens a sealed
 * message id — that is exactly what INV-MSG forbids (`reduce()` refuses a
 * sealed message as an attach target, sets `needsResync`, and discards
 * everything after the park). Shared by every seed-corpus suite below so the
 * Claude fix's regression class (see `app-update-sonnet5`, guuey#26) is
 * checked identically for every facet, not just the one it was found in.
 */
function foldThroughReducer(agjson: JsonValue[]): { reducer: Reducer; reopened: string[] } {
  const sealed = new Set<string>();
  const reopened: string[] = [];
  const r = new Reducer();
  for (const raw of agjson) {
    const ev = AgEvent.parse(raw);
    r.push(ev);
    if (!isClosedEvent(ev)) continue;
    if (ev.type === "message.end") sealed.add(ev.id);
    if (ev.type === "message.start" && sealed.has(ev.id)) reopened.push(ev.id);
  }
  return { reducer: r, reopened };
}

/**
 * Spec §4 `outputTokens` inclusion + §10 conformance identity (draft.3): every
 * usage bag on the stream (turn.done / turn.error / message.end, plus each
 * `byModel` entry) must satisfy `inputTokens + outputTokens +
 * (toolUseInputTokens ?? 0) == totalTokens` wherever the provider reported a
 * total, and `reasoningTokens <= outputTokens` wherever both are present in the
 * same snapshot. This is the replay-level assertion that would have caught the
 * pre-draft.3 adk drift (Gemini's exclusive candidatesTokenCount copied
 * verbatim: 394 + 31 != 550 on 10 of 12 adk goldens).
 */
function assertUsageIdentity(agjson: JsonValue[]): void {
  const bags: Array<{ where: string; u: Record<string, JsonValue> }> = [];
  for (const [i, raw] of agjson.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const usage = (raw as Record<string, JsonValue>)["usage"];
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) continue;
    const u = usage as Record<string, JsonValue>;
    bags.push({ where: `[${i}].usage`, u });
    const byModel = u["byModel"];
    if (byModel !== null && typeof byModel === "object" && !Array.isArray(byModel)) {
      for (const [model, mu] of Object.entries(byModel as Record<string, JsonValue>)) {
        if (mu !== null && typeof mu === "object" && !Array.isArray(mu)) {
          bags.push({ where: `[${i}].usage.byModel.${model}`, u: mu as Record<string, JsonValue> });
        }
      }
    }
  }
  for (const { where, u } of bags) {
    const num = (k: string): number | undefined => (typeof u[k] === "number" ? (u[k] as number) : undefined);
    const input = num("inputTokens");
    const output = num("outputTokens");
    const total = num("totalTokens");
    const reasoning = num("reasoningTokens");
    if (total !== undefined && input !== undefined && output !== undefined) {
      expect({ where, identity: input + output + (num("toolUseInputTokens") ?? 0) }).toEqual({ where, identity: total });
    }
    if (reasoning !== undefined && output !== undefined) {
      expect({ where, reasoningWithinOutput: reasoning <= output }).toEqual({ where, reasoningWithinOutput: true });
    }
  }
}

describe("replay CI gate — Claude seed corpus (machinery/snapshot self-consistency)", () => {
  for (const scn of CLAUDE_SEEDS) {
    describe(scn, () => {
      it("agjson deep-equals the committed claude.agjson.json snapshot", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "claude.native.json"));
        const expected = await readSnapshotForFramework(scn, "claude");
        expect(agjson).toEqual(expected);
      });

      it("census reports NO drops and NO new fields (the gate)", async () => {
        const { report } = await replayCassette(join(CORPUS_ROOT, scn, "claude.native.json"));
        expect(report.drops).toEqual([]);
        expect(report.newFields).toEqual([]);
      });

      it("usage obeys the draft.3 inclusion identity (input + output (+ toolUseInput) == total; reasoning <= output)", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "claude.native.json"));
        assertUsageIdentity(agjson);
      });

      // guuey#26. A cassette can be snapshot-stable AND census-clean and still
      // be unusable by a real consumer: if the producer re-opens a message id
      // it already sealed, INV-MSG makes `reduce()` park (`needsResync`) and
      // every event after the park is discarded. `app-update-sonnet5` — a live
      // claude-sonnet-5 capture whose thinking and tool_use blocks arrive as
      // two frames of ONE message id — parked exactly this way, and no gate in
      // this repo noticed, because none of them ever FOLDED a cassette.
      it("folds through the normative Reducer WITHOUT parking, and never re-opens a sealed id (guuey#26 / INV-MSG)", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "claude.native.json"));
        const { reducer, reopened } = foldThroughReducer(agjson);
        expect(reopened).toEqual([]);
        expect(reducer.needsResync).toBe(false);
      });
    });
  }
});

describe("replay CI gate — OpenAI seed corpus (machinery/snapshot self-consistency)", () => {
  for (const scn of OPENAI_SEEDS) {
    describe(scn, () => {
      it("agjson deep-equals the committed openai.agjson.json snapshot", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "openai.native.json"));
        const expected = await readSnapshotForFramework(scn, "openai");
        expect(agjson).toEqual(expected);
      });

      it("census reports NO drops and NO new fields (the gate)", async () => {
        const { report } = await replayCassette(join(CORPUS_ROOT, scn, "openai.native.json"));
        expect(report.drops).toEqual([]);
        expect(report.newFields).toEqual([]);
      });

      it("usage obeys the draft.3 inclusion identity (input + output (+ toolUseInput) == total; reasoning <= output)", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "openai.native.json"));
        assertUsageIdentity(agjson);
      });

      // guuey#26 ride-along. The Claude facet's per-frame open/seal parked the
      // Reducer whenever one API message spanned multiple frames (a live
      // production incident — see the Claude suite's comment above). This is
      // the SAME class of check for the OpenAI facet's own cassettes: a
      // snapshot-stable, census-clean stream is worthless to a real consumer
      // if it re-opens a message id it already sealed. `echo-gpt55`/
      // `echo-gpt56`/`app-spec-structured-result` are REAL `@openai/agents`
      // captures (not hand-authored), so this pins the invariant against
      // genuine wire behavior, not just the seed machinery.
      it("folds through the normative Reducer WITHOUT parking, and never re-opens a sealed id (guuey#26 / INV-MSG ride-along)", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "openai.native.json"));
        const { reducer, reopened } = foldThroughReducer(agjson);
        expect(reopened).toEqual([]);
        expect(reducer.needsResync).toBe(false);
      });
    });
  }
});

describe("replay CI gate — ADK seed corpus (machinery/snapshot self-consistency)", () => {
  for (const scn of ADK_SEEDS) {
    describe(scn, () => {
      it("agjson deep-equals the committed adk.agjson.json snapshot", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "adk.native.json"));
        const expected = await readSnapshotForFramework(scn, "adk");
        expect(agjson).toEqual(expected);
      });

      it("census reports NO drops and NO new fields (the gate)", async () => {
        const { report } = await replayCassette(join(CORPUS_ROOT, scn, "adk.native.json"));
        expect(report.drops).toEqual([]);
        expect(report.newFields).toEqual([]);
      });

      it("usage obeys the draft.3 inclusion identity (input + output (+ toolUseInput) == total; reasoning <= output)", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "adk.native.json"));
        assertUsageIdentity(agjson);
      });

      // guuey#26 ride-along (see the OpenAI suite's comment above for the full
      // rationale). `echo-gemini35`/`echo-gemini36`/`multi-turn`/
      // `single-tool-call`/`text-only`/`tool-error`/`app-spec-gemini36` are
      // REAL `@google/adk` captures — this pins the same "sealed id never
      // re-opens" invariant against genuine ADK wire behavior.
      it("folds through the normative Reducer WITHOUT parking, and never re-opens a sealed id (guuey#26 / INV-MSG ride-along)", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "adk.native.json"));
        const { reducer, reopened } = foldThroughReducer(agjson);
        expect(reopened).toEqual([]);
        expect(reducer.needsResync).toBe(false);
      });
    });
  }
});

/**
 * pkg-21 (draft.4 §5 per-key replace): a `<framework>.session-state.json`
 * sidecar is the framework's OWN shared state, read back after the run (ADK's
 * session.state); it is ground truth, never replayed (FIXTURES.md). The
 * reference fold of the committed golden must hold exactly that state. The
 * suite walks the corpus, so a new sidecar is gated the day it is committed.
 */
describe("shared state — the reference fold equals the framework's own session state (session-state sidecars)", () => {
  it("every <framework>.session-state.json equals reduce(golden).state, and the fold does not park", async () => {
    const checked: string[] = [];
    for (const scn of (await readdir(CORPUS_ROOT)).sort()) {
      const sidecars = (await readdir(join(CORPUS_ROOT, scn)).catch(() => [] as string[])).filter((f) => f.endsWith(".session-state.json"));
      for (const f of sidecars) {
        const framework = f.slice(0, -".session-state.json".length);
        const truth = JSON.parse(await readFile(join(CORPUS_ROOT, scn, f), "utf8")) as JsonValue;
        const { reducer } = foldThroughReducer(await readSnapshotForFramework(scn, framework));
        expect({ where: `${scn}/${framework}`, needsResync: reducer.needsResync }).toEqual({ where: `${scn}/${framework}`, needsResync: false });
        expect({ where: `${scn}/${framework}`, state: reducer.result().state }).toEqual({ where: `${scn}/${framework}`, state: truth });
        checked.push(`${scn}/${framework}`);
      }
    }
    // Non-vacuity: the corpus's first sidecar (state-fold-gemini38, ADK) is checked.
    expect(checked).toContain("state-fold-gemini38/adk");
  });
});

describe("replay CI gate — Vercel seed corpus (machinery/snapshot self-consistency)", () => {
  for (const scn of VERCEL_SEEDS) {
    describe(scn, () => {
      it("agjson deep-equals the committed vercel.agjson.json snapshot", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "vercel.native.json"));
        const expected = await readSnapshotForFramework(scn, "vercel");
        expect(agjson).toEqual(expected);
      });

      it("census reports NO drops and NO new fields (the gate)", async () => {
        const { report } = await replayCassette(join(CORPUS_ROOT, scn, "vercel.native.json"));
        expect(report.drops).toEqual([]);
        expect(report.newFields).toEqual([]);
      });

      it("usage obeys the draft.3 inclusion identity (input + output (+ toolUseInput) == total; reasoning <= output)", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "vercel.native.json"));
        assertUsageIdentity(agjson);
      });

      // guuey#26 ride-along, fourth facet: same INV-MSG fold gate as the
      // claude/openai/adk suites above, pinned before this facet's first
      // live consumer too (see foldThroughReducer's doc).
      it("folds through the normative Reducer WITHOUT parking, and never re-opens a sealed id (guuey#26 / INV-MSG)", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "vercel.native.json"));
        const { reducer, reopened } = foldThroughReducer(agjson);
        expect(reopened).toEqual([]);
        expect(reducer.needsResync).toBe(false);
      });
    });
  }
});

// ─── I4 cross-framework convergence gate ─────────────────────────────────────

/**
 * Convergence scenarios: corpus entries where claude.native.json,
 * openai.native.json AND adk.native.json capture the IDENTICAL task and are
 * expected to produce structurally-equivalent AgJSON under canonicalization.
 *
 * The existing `text-tool-turn` scenario now has all three framework cassettes
 * (Task 5 added `adk.native.json`) but they do NOT capture the identical task:
 * Claude's `text-tool-turn/claude.native.json` is a hand-authored
 * weather+subagent fixture (2 tool calls, a thinking block, a subagent turn) —
 * an entirely different scenario from OpenAI's REAL @openai/agents echo-task
 * capture (`text-tool-turn/openai.native.json`, byte-identical to
 * `convergence-echo/openai.native.json`) that Task 5's ADK fixture correctly
 * mirrors. This is a PRE-EXISTING divergence (claude's fixture predates any
 * convergence intent for this scenario — it exists solely as a
 * single-framework machinery/snapshot seed) — CONFIRMED empirically (Task 5):
 * wiring `text-tool-turn` into this list throws
 * `assertConvergent`'s claude-vs-openai check on eventSequence/toolCalls/
 * textContent/toolResults before the ADK arm is even reached. Per the M58
 * brief's explicit contingency ("do not weaken the gate or tune the fixture
 * to dodge a genuine mismatch"), `text-tool-turn` stays OUT of
 * CONVERGENCE_SCENARIOS — see the dedicated regression test below
 * ("text-tool-turn: claude vs openai — pre-existing task mismatch (BLOCKED,
 * not a fixture bug)") that pins the real divergence so it can't silently
 * regress into a false "converges" claim. Only `convergence-*` scenarios (and
 * any scenario future work makes genuinely task-identical across all three
 * cassettes) belong in this list.
 *
 * For scenarios that do NOT appear in this list (including single-framework seeds),
 * the I4 gate skips gracefully.
 */
const CONVERGENCE_SCENARIOS = ["convergence-echo"] as const;

/** Returns true when the file exists at the given path. */
async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("I4 cross-framework convergence gate", () => {
  // Also check all CLAUDE_SEEDS, OPENAI_SEEDS and ADK_SEEDS — if a
  // non-convergence scenario somehow acquires all three cassettes, it should
  // SKIP (not fail) via fileExists check.
  const allCorpusScenarios = [
    ...new Set([...CLAUDE_SEEDS, ...OPENAI_SEEDS, ...ADK_SEEDS, ...CONVERGENCE_SCENARIOS]),
  ];

  for (const scn of allCorpusScenarios) {
    const isConvergenceScenario = (CONVERGENCE_SCENARIOS as readonly string[]).includes(scn);

    it(`${scn}: ${isConvergenceScenario ? "asserts 3-way convergence" : "skips gracefully"}`, async () => {
      const claudePath = join(CORPUS_ROOT, scn, "claude.native.json");
      const openaiPath = join(CORPUS_ROOT, scn, "openai.native.json");
      const adkPath = join(CORPUS_ROOT, scn, "adk.native.json");

      const [hasClaude, hasOpenai, hasAdk] = await Promise.all([
        fileExists(claudePath),
        fileExists(openaiPath),
        fileExists(adkPath),
      ]);

      if (!isConvergenceScenario || !hasClaude || !hasOpenai || !hasAdk) {
        console.log(
          `I4 gate: skipping ${scn} (conv=${isConvergenceScenario}, claude=${hasClaude}, openai=${hasOpenai}, adk=${hasAdk})`,
        );
        return;
      }

      const [claude, openai, adk] = await Promise.all([
        replayCassette(claudePath, "claude"),
        replayCassette(openaiPath, "openai"),
        replayCassette(adkPath, "adk"),
      ]);

      // Census gate (audit M59): previously this test replayed all three
      // cassettes and used ONLY `.agjson`, silently discarding `.report` —
      // a computed-then-thrown-away census. Assert each framework's census
      // is clean (post-triage) exactly like the seed-corpus suites above,
      // so the I4 leg cannot go green while masking a real per-framework drop.
      for (const [fw, { report }] of [
        ["claude", claude],
        ["openai", openai],
        ["adk", adk],
      ] as const) {
        expect(report.drops, `${scn}/${fw}: census drops`).toEqual([]);
        expect(report.newFields, `${scn}/${fw}: census newFields`).toEqual([]);
      }

      const c = canonicalizeAgjson(claude.agjson);
      const o = canonicalizeAgjson(openai.agjson);
      const k = canonicalizeAgjson(adk.agjson);

      assertConvergent(c, o, { scenario: scn, fw1: "claude", fw2: "openai" });
      assertConvergent(c, k, { scenario: scn, fw1: "claude", fw2: "adk" });
      assertConvergent(o, k, { scenario: scn, fw1: "openai", fw2: "adk" });
      expect(true).toBe(true);
    });
  }
});

// ─── ADK non-vacuity guard ────────────────────────────────────────────────────
// A deliberately-divergent ADK canonical MUST throw — proves the ADK arm is
// actually compared (not silently skipped) by the 3-way gate.

it("convergence-echo: ADK divergence is detected (non-vacuity)", async () => {
  const claude = await replayCassette(
    join(CORPUS_ROOT, "convergence-echo", "claude.native.json"),
    "claude",
  );
  const c = canonicalizeAgjson(claude.agjson);
  const tampered = { ...c, textContent: ["TAMPERED"] };
  expect(() =>
    assertConvergent(c, tampered, { scenario: "convergence-echo", fw1: "claude", fw2: "adk" }),
  ).toThrow(/textContent mismatch/);
});

// ─── text-tool-turn: pre-existing claude/openai task mismatch (M58 Task 5) ───
//
// Task 5 added `corpus/text-tool-turn/adk.native.json` — a hand-authored ADK
// fixture producing the SAME echo task `text-tool-turn/openai.native.json`
// already captures (mirroring `convergence-echo/adk.native.json`'s event
// grammar). Wiring `text-tool-turn` into CONVERGENCE_SCENARIOS to make it a
// 3-way check was investigated and found BLOCKED: `text-tool-turn/
// claude.native.json` is a DIFFERENT, pre-existing hand-authored fixture
// (weather+subagent: 2 tool calls, a thinking block, a subagent turn) that
// predates any convergence intent for this scenario — it exists solely as
// Claude's own single-framework machinery/snapshot seed (see CLAUDE_SEEDS
// above). This is a REAL semantic divergence, not a bug in the new ADK
// fixture (which converges cleanly with the OpenAI echo task — see the
// assertion below). Per the M58 brief's contingency, the gate is NOT weakened
// and the fixture is NOT tuned to dodge the mismatch; this test PINS the
// divergence so a future accidental CONVERGENCE_SCENARIOS addition fails
// loudly with a clear pointer back to this comment instead of silently
// asserting a false "converges".
it("text-tool-turn: claude vs openai — pre-existing task mismatch (BLOCKED, not a fixture bug)", async () => {
  const [claude, openai, adk] = await Promise.all([
    replayCassette(join(CORPUS_ROOT, "text-tool-turn", "claude.native.json"), "claude"),
    replayCassette(join(CORPUS_ROOT, "text-tool-turn", "openai.native.json"), "openai"),
    replayCassette(join(CORPUS_ROOT, "text-tool-turn", "adk.native.json"), "adk"),
  ]);
  const c = canonicalizeAgjson(claude.agjson);
  const o = canonicalizeAgjson(openai.agjson);
  const k = canonicalizeAgjson(adk.agjson);

  // claude (weather+subagent) vs openai (echo) — REAL divergence, pre-existing.
  expect(() =>
    assertConvergent(c, o, { scenario: "text-tool-turn", fw1: "claude", fw2: "openai" }),
  ).toThrow(/toolCalls\.length mismatch|textContent mismatch/);

  // The new ADK fixture is NOT the source of the divergence: it converges
  // cleanly with openai's echo task (the task it was authored to match).
  expect(() =>
    assertConvergent(o, k, { scenario: "text-tool-turn", fw1: "openai", fw2: "adk" }),
  ).not.toThrow();

  // ...and correspondingly diverges from claude's DIFFERENT weather+subagent
  // task, for the exact same pre-existing reason as claude-vs-openai above.
  expect(() =>
    assertConvergent(c, k, { scenario: "text-tool-turn", fw1: "claude", fw2: "adk" }),
  ).toThrow(/toolCalls\.length mismatch|textContent mismatch/);
});

/**
 * SURFACE GUARD (2026-09-23, cohort 0.6.3). A seed that exists for ONE wire
 * surface must still carry that surface after a refresh. Replay alone cannot see
 * this: a refreshed cassette is always self-consistent, so a refresh that happens
 * to land a run without the surface stays green while the coverage silently
 * disappears. That happened: the 0.6.2 refresh of partials-fable51 landed a
 * thinking-free run and deleted the corpus's only live streamed-thinking evidence,
 * and a 0.6.3 refresh of app-update-fable51 would have deleted the only live
 * narration evidence the same way. Each entry names the seed, the surface, and a
 * predicate over the NATIVE cassette.
 */
const SURFACE_GUARDS: ReadonlyArray<{
  scenario: string;
  framework: string;
  surface: string;
  count: (native: JsonValue[]) => number;
}> = [
  {
    scenario: "multi-result-sonnet5",
    framework: "claude",
    surface: "a SECOND result frame in the same invoke (the multi-result evidence)",
    count: (n) =>
      n.filter((f) => f !== null && typeof f === "object" && !Array.isArray(f) && f["type"] === "result").length - 1,
  },
  {
    scenario: "partials-uuid-sonnet5",
    framework: "claude",
    surface: "a stream_event message_start stamped with user_message_uuid (the streamed client-correlation evidence)",
    count: (n) =>
      n.filter((f) => {
        if (f === null || typeof f !== "object" || Array.isArray(f) || f["type"] !== "stream_event") return false;
        const ev = f["event"];
        return ev !== null && typeof ev === "object" && !Array.isArray(ev) && ev["type"] === "message_start" && typeof f["user_message_uuid"] === "string";
      }).length,
  },
  {
    scenario: "thinking-fable51",
    framework: "claude",
    surface: "stream_event thinking_delta WITH summary text",
    count: (n) =>
      n.filter((f) => {
        if (f === null || typeof f !== "object" || Array.isArray(f) || f["type"] !== "stream_event") return false;
        const ev = f["event"];
        if (ev === null || typeof ev !== "object" || Array.isArray(ev)) return false;
        const d = ev["delta"];
        if (d === null || typeof d !== "object" || Array.isArray(d)) return false;
        return d["type"] === "thinking_delta" && typeof d["thinking"] === "string" && d["thinking"].length > 0;
      }).length,
  },
  {
    scenario: "thinking-fable51",
    framework: "claude",
    surface: "stream_event signature_delta",
    count: (n) =>
      n.filter((f) => {
        if (f === null || typeof f !== "object" || Array.isArray(f) || f["type"] !== "stream_event") return false;
        const ev = f["event"];
        if (ev === null || typeof ev !== "object" || Array.isArray(ev)) return false;
        const d = ev["delta"];
        return d !== null && typeof d === "object" && !Array.isArray(d) && d["type"] === "signature_delta";
      }).length,
  },
  {
    scenario: "app-update-fable51",
    framework: "claude",
    surface: "assistant narration_block_indexes",
    // Non-empty: a refresh landing narration_block_indexes: [] or null must fail.
    count: (n) =>
      n.filter((f) => {
        if (f === null || typeof f !== "object" || Array.isArray(f)) return false;
        const v = f["narration_block_indexes"];
        return Array.isArray(v) && v.length > 0;
      }).length,
  },
  {
    scenario: "thinking-gemini38",
    framework: "adk",
    surface: "Gemini thought:true parts",
    count: (n) => JSON.stringify(n).split('"thought":true').length - 1,
  },
  {
    scenario: "tool-error-gemini38",
    framework: "adk",
    surface: "an MCP isError:true function response (the clean error path)",
    count: (n) => JSON.stringify(n).split('\\"isError\\":true').length - 1 + (JSON.stringify(n).split('"isError":true').length - 1),
  },
  {
    scenario: "commentary-gpt6sol",
    framework: "openai",
    surface: 'a live phase:"commentary" message (the gated evidence for the draft.4 phase field)',
    count: (n) => JSON.stringify(n).split('"phase":"commentary"').length - 1,
  },
  {
    scenario: "echo-gpt6sol",
    framework: "openai",
    surface: "a reasoning item (the only openai seed that reasons; late-reasoning evidence)",
    count: (n) => JSON.stringify(n).split('"type":"reasoning"').length - 1,
  },
  {
    scenario: "app-spec-structured-result",
    framework: "openai",
    surface: "item.customData.structuredContent (the only live proof of that channel)",
    count: (n) => JSON.stringify(n).split('"customData":{"structuredContent"').length - 1,
  },
];

describe("surface guard — a seed keeps the surface it exists for", () => {
  for (const g of SURFACE_GUARDS) {
    it(`${g.scenario}/${g.framework} still carries ${g.surface}`, async () => {
      const raw: unknown = JSON.parse(await readFile(join(CORPUS_ROOT, g.scenario, `${g.framework}.native.json`), "utf8"));
      expect(Array.isArray(raw)).toBe(true);
      const native = raw as JsonValue[];
      expect(g.count(native), `${g.scenario} lost its reason to exist: no ${g.surface}. Re-capture until a run carries it, or hold the previous cassette.`).toBeGreaterThan(0);
    });
  }
});
