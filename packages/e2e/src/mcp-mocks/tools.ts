/**
 * tools.ts — single source of truth for pinned mock tool names.
 *
 * knownToolFor(kind) is the ONLY place these names are defined.
 * All other code (serve.ts, client.ts, tests, capture agent) must import
 * from here rather than hardcoding a literal.
 */

export type MockKind = "text" | "app-spec" | "error";

const TOOL_NAMES: Record<MockKind, string> = {
  "text": "echo",
  "app-spec": "render_card",
  "error": "fail",
};

/**
 * Returns the pinned tool name for the given mock kind.
 *
 * - "text"     → "echo"
 * - "app-spec" → "render_card"
 * - "error"    → "fail"
 */
export function knownToolFor(kind: MockKind): string {
  return TOOL_NAMES[kind];
}
