/**
 * scenario.ts — Scenario schema (Zod) + derivedTools helper.
 *
 * ★ Risk-pass F2: allowedTools + expectTools are DERIVED, never authored.
 * For each mcpServers[] entry, the tool name is `mcp__${key}__${knownToolFor(kind)}`.
 * knownToolFor is the SINGLE SOURCE OF TRUTH (mcp-mocks/tools.ts) so the names
 * can never drift from the mock servers.
 *
 * The Scenario schema does NOT contain allowedTools/expectTools fields.
 */
import { z } from "zod";
import { JsonValue } from "@silverprotocol/core";
import { knownToolsFor, type MockKind } from "./mcp-mocks/tools.js";
import type { Framework } from "./census.js";

// ─── Scenario schema ──────────────────────────────────────────────────────────

/** One handoff target the openai capture agent builds (same model and MCP servers as the main agent). */
const HandoffTarget = z.object({
  name: z.string().min(1),
  instructions: z.string().min(1),
  handoffDescription: z.string().min(1).optional(),
});

export const Scenario = z.object({
  name: z.string(),
  prompt: z.string(),
  mcpServers: z
    .array(
      z.object({
        key: z.string(),
        kind: z.enum(["text", "app-spec", "app-update", "error", "resource-link"]),
      }),
    )
    .default([]),
  steer: z.string().optional(),
  // Claude follow-up prompts (claude-agent-sdk only; the other capture agents
  // ignore it). Presence runs ONE query() in streaming-input mode: `prompt`
  // first, then each follow-up only after the previous `result` frame, so a
  // single invoke yields one result per prompt. Added 2026-09-23 for sp-claude
  // B's live receipt (≥2 results in one invoke → ≥2 AgTurnRecords, each
  // closed once). At least one non-empty follow-up when present.
  followUps: z.array(z.string().min(1)).min(1).optional(),
  // workspace#7: run the capture with token-granular partials enabled.
  // Claude-only today (`includePartialMessages: true` on the Agent SDK query);
  // the other capture agents ignore it. Declared per-SCENARIO, not per-run, so
  // a partials cassette is reproducibly a partials cassette.
  includePartialMessages: z.boolean().optional(),
  // Gemini thinking knob (google-adk only today; the other capture agents
  // ignore it). Presence enables `thinkingConfig { includeThoughts: true,
  // thinkingLevel }` on the LlmAgent's generateContentConfig. Declared
  // per-SCENARIO (same rationale as includePartialMessages) so a thinking
  // cassette is reproducibly a thinking cassette. gemini-3.7-flash returns NO
  // thought summaries by default — without this knob a capture can never
  // produce `thought: true` parts. Levels are 3.7's set (low/medium/high;
  // "minimal" is rejected server-side even though genai's ThinkingLevel enum
  // still declares MINIMAL).
  //
  // OPERATOR NOTE: scenario names pin no model (capture-cli DEFAULT_MODEL /
  // CAPTURE_MODEL decide) — so until DEFAULT_MODEL.adk reaches a
  // thinking_level-generation model, a scenario setting this knob MUST be
  // captured with an explicit CAPTURE_MODEL (e.g. gemini-3.7-flash);
  // thinkingLevel against a thinking_budget-generation default is a
  // server-side 400 or a cassette recorded on the wrong model.
  thinkingLevel: z.enum(["low", "medium", "high"]).optional(),
  // Claude thinking-display knob (claude-agent-sdk only; the other capture
  // agents ignore it). Presence sets the Agent SDK's
  // `thinking: { type: "adaptive", display }`. Added 2026-09-23 (cohort 0.6.3)
  // because with display UNSET, CLI 2.1.280 selects its `connector_text` mode:
  // the API returns only the between-tool narration, never a thinking summary,
  // so a partials capture of Fable 5.1 or Opus 5.5 streams NO thinking_delta /
  // signature_delta at all. That is how the 0.6.2 refresh of partials-fable51
  // silently lost the corpus's only live streamed-thinking coverage, and three
  // re-captures in 0.6.3 confirmed it is not luck. Declared per-SCENARIO, like
  // includePartialMessages and thinkingLevel, so a thinking cassette is
  // reproducibly a thinking cassette. "summarized" is the value that makes
  // thinking blocks (and their summary text) reach the stream.
  thinkingDisplay: z.enum(["summarized", "omitted"]).optional(),
  // OpenAI reasoning-summary knob (openai-agents only; the other capture agents
  // ignore it). Presence asks the Responses API for reasoning summaries
  // (`modelSettings.reasoning.summary`). Added 2026-09-23 for the founder-gated
  // commentary capture (rnd 13+17 stage 2): the corpus's live OpenAI legs carry
  // only phase "final_answer" and empty summaries, and without this knob a
  // capture cannot ask for summary text at all. Model-named seeds using it
  // MUST be captured with an explicit CAPTURE_MODEL, like thinkingLevel.
  reasoningSummary: z.enum(["auto", "concise", "detailed"]).optional(),
  // Google ADK 2.x workflow-plane knob (google-adk only; the other capture
  // agents ignore it). Presence roots the capture at a Workflow instead of a
  // plain LlmAgent (agents/google-adk/workflow.ts): "pause" ends the invoke at
  // a HITL RequestInput node, "complete" runs the graph to its end. Added
  // 2026-09-23 for rd-06 A.9 step 5, the live workflow cassettes recorded with
  // the host-completion marker. Model-named seeds using it MUST be captured
  // with an explicit CAPTURE_MODEL, like thinkingLevel.
  adkWorkflow: z.enum(["pause", "complete"]).optional(),
  // Error-seed knob (any framework). The run is EXPECTED to throw: the Claude
  // Agent SDK surfaces an API error in-band (an assistant frame with `error`,
  // then a result with is_error:true and api_error_status) and THEN throws out
  // of the query iterator. With the flag, runCapture keeps the natives that
  // arrived before the throw, skips the expectTools check (a failed run calls
  // no tools; declare no mcpServers), records no host-completion marker, and
  // capture-cli writes the thrown message into provenance `note`. A run that
  // returns normally FAILS the capture, so an error-seed name can never hold a
  // success cassette. Added 2026-09-23 (probe queue item 1: until now no
  // cassette carried is_error:true, because the throw escaped runCapture).
  expectError: z.literal(true).optional(),
  // Deferred-tool knobs (claude-agent-sdk only; R&D candidate 20, 2026-09-23).
  // preToolUseDecision installs a PreToolUse hook answering every tool call
  // with that decision: "defer" parks the call as the result's
  // deferred_tool_use; "allow" / "deny" are the resume legs' answers.
  // resumeFrom names an earlier SEED (a corpus/ dir) whose committed claude
  // cassette's result session_id this capture resumes (a separate invoke and
  // a separate cassette, SPEC §8.0 Lifetime). Model-named seeds using them
  // MUST be captured with an explicit CAPTURE_MODEL.
  preToolUseDecision: z.enum(["defer", "allow", "deny"]).optional(),
  // OpenAI tool-approval knob (openai-agents only; sp-openai 82b3aae,
  // 2026-09-24). "interrupt" is leg 1: every MCP tool needs approval, so the
  // run stops on the first call; the harness keeps its RunState OUT of the
  // corpus (capture-cli.ts runStatePath). "approve" / "reject" is a resume leg
  // and needs resumeFrom naming leg 1's seed.
  toolApproval: z.enum(["interrupt", "approve", "reject"]).optional(),
  // resumeFrom, for openai: the seed whose leg-1 capture saved its RunState at
  // capture time in this checkout (never committed; it can carry the
  // conversation, tool arguments and response ids). The resume leg must use
  // leg 1's steer, MCP servers and model (capture-cli enforces it).
  resumeFrom: z.string().min(1).optional(),
  // Shared-state knob (google-adk only; rnd's ADK state-fold candidate,
  // 2026-09-24). Each entry is one step's state writes: the agent registers
  // apply_state_step({step}), which writes entry step-1 through
  // toolContext.state (sp-google 5bc5351), so the values never depend on the
  // model. The capture also reads ADK's session.state back after the run into
  // a <fw>.session-state.json sidecar, as ground truth for the fold.
  adkStateScript: z.array(z.record(z.string(), JsonValue)).min(1).optional(),
  // Subagent knob (claude-agent-sdk only; the nested-turn package's capture ask,
  // 2026-09-24). Each entry is a programmatic subagent the agent passes as the
  // query's options.agents, with the built-in Agent tool enabled and
  // auto-allowed. A definition with background:true runs as a background task
  // (the Agent tool_result is async_launched): the capture keeps its input open
  // until every launched task's system/task_notification has arrived and the
  // turn it wakes has closed. A `model` the API rejects is how a FAILING
  // subagent is recorded. Model-named seeds MUST be captured with CAPTURE_MODEL.
  claudeSubagents: z
    .record(
      z.string().min(1),
      z.object({
        description: z.string().min(1),
        prompt: z.string().min(1),
        tools: z.array(z.string().min(1)).optional(),
        model: z.string().min(1).optional(),
        maxTurns: z.number().int().positive().optional(),
        background: z.boolean().optional(),
      }),
    )
    .refine((r) => Object.keys(r).length > 0, "claudeSubagents needs at least one agent")
    .optional(),
  // Handoff knob (openai-agents only; the same capture ask). The agent builds a
  // second Agent with these instructions (same model and MCP servers) and puts
  // it in the main agent's `handoffs`; the steer tells the main agent to hand
  // off, so the native stream carries handoff_requested / handoff_occurred and
  // the second agent's turn.
  openaiHandoff: HandoffTarget.optional(),
  // Parallel-handoff knob (openai-agents only; cto's review of the handoff
  // close, 2026-09-25): SEVERAL handoff targets on the main agent, so a model
  // can emit more than one transfer_to_* call in one response (the Responses
  // API defaults parallel_tool_calls on). A separate knob from openaiHandoff,
  // with its own KNOB_SUPPORT proof, so an agent that only knows one target
  // fails loud instead of silently capturing a single-target run. Use one of
  // the two knobs, not both.
  openaiHandoffs: z.array(HandoffTarget).min(2).optional(),
  // Live (bidi) knob (google-adk only; cto's barge-in ask, 2026-09-25): the
  // capture runs runner.runLive with a LiveRequestQueue (sp-google's live.ts).
  // `prompt` is the first user content; `bargeIn` is sent ONCE as a second
  // user content at the model's first output of that turn, while it is still
  // generating. `responseModality` defaults to TEXT; AUDIO turns on output
  // transcription (audio payloads are elided at capture, redact.ts). Needs a
  // Live model (CAPTURE_MODEL, e.g. gemini-3.8-live: gemini-3.8-flash has no
  // bidiGenerateContent). Not combinable with adkWorkflow.
  adkLive: z
    .object({
      bargeIn: z.string().min(1),
      responseModality: z.enum(["TEXT", "AUDIO"]).optional(),
    })
    .optional(),
});

export type Scenario = z.infer<typeof Scenario>;

// ─── derivedTools ─────────────────────────────────────────────────────────────

/**
 * Returns the allowedTools + expectTools lists derived from the scenario's
 * mcpServers declarations.
 *
 * For each server: `mcp__${key}__${knownToolFor(kind)}`.
 *
 * Both lists are identical — every declared server's tool is expected to be
 * called (so capture validation can confirm the LLM actually used each tool).
 *
 * NOTE (subagent scenarios): scenarios/subagent and the subagent-*-sonnet5
 * seeds define their subagents with the `claudeSubagents` knob, so the echo
 * call is the SUBAGENT's (a nested frame), not the main agent's. A seed whose
 * subagent calls no tool (bg, fail) declares no mcpServers, so its
 * expectTools list is empty. The Scenario schema uses Zod's default strip
 * mode, so `_note` keys in JSON are silently dropped — keep prose notes here
 * rather than in the JSON files.
 *
 * NOTE (framework param, Task 6): `mcp__<key>__<tool>` is the Claude Agent
 * SDK's OWN permission-gate naming convention for MCP-sourced tools — it is
 * NOT a general MCP or AgJSON concept. The openai-agents-sdk / google-adk
 * capture agents discover + call tools by their BARE registered name (no
 * server-key prefix); this is ground-truthed against the real committed
 * native cassettes (`corpus/text-tool-turn/{openai,adk}.native.json` both
 * carry `name: "echo"`, never `"mcp__t__echo"`). `framework` defaults to
 * `"claude"` so every pre-existing call site is unaffected.
 */
export function derivedTools(
  s: Scenario,
  framework: Framework = "claude",
): { allowedTools: string[]; expectTools: string[] } {
  // flatMap: a kind may register MORE than one tool (app-update registers
  // render_card + update_card — the *_update/re-render sequence). Every
  // registered tool is both allowed and expected.
  const names = s.mcpServers.flatMap(({ key, kind }) =>
    knownToolsFor(kind as MockKind).map((tool) =>
      framework === "claude" ? `mcp__${key}__${tool}` : tool,
    ),
  );
  return { allowedTools: [...names], expectTools: [...names] };
}
