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
import { knownToolsFor, type MockKind } from "./mcp-mocks/tools.js";
import type { Framework } from "./census.js";

// ─── Scenario schema ──────────────────────────────────────────────────────────

export const Scenario = z.object({
  name: z.string(),
  prompt: z.string(),
  mcpServers: z
    .array(
      z.object({
        key: z.string(),
        kind: z.enum(["text", "app-spec", "app-update", "error"]),
      }),
    )
    .default([]),
  steer: z.string().optional(),
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
 * NOTE (subagent scenario): scenarios/subagent/scenario.json is structurally
 * identical to single-tool-call (same mcp__t__echo derivation). The subagent
 * distinction is prompt-steered today (via `steer`); it will become
 * structurally distinct once subagent routing lands. The Scenario schema uses
 * Zod's default strip mode, so `_note` keys in JSON are silently dropped —
 * keep this prose note here rather than in the JSON file.
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
