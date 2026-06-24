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
import { knownToolFor, type MockKind } from "./mcp-mocks/tools.js";

// ─── Scenario schema ──────────────────────────────────────────────────────────

export const Scenario = z.object({
  name: z.string(),
  prompt: z.string(),
  mcpServers: z
    .array(
      z.object({
        key: z.string(),
        kind: z.enum(["text", "app-spec", "error"]),
      }),
    )
    .default([]),
  steer: z.string().optional(),
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
 */
export function derivedTools(s: Scenario): { allowedTools: string[]; expectTools: string[] } {
  const names = s.mcpServers.map(
    ({ key, kind }) => `mcp__${key}__${knownToolFor(kind as MockKind)}`,
  );
  return { allowedTools: [...names], expectTools: [...names] };
}
