/**
 * tools.ts — single source of truth for pinned mock tool names.
 *
 * knownToolFor(kind) / knownToolsFor(kind) are the ONLY places these names are
 * defined. All other code (serve.ts, client.ts, tests, capture agent) must
 * import from here rather than hardcoding a literal.
 */

export type MockKind = "text" | "app-spec" | "app-update" | "error";

const TOOL_NAMES: Record<MockKind, string[]> = {
  "text": ["echo"],
  "app-spec": ["render_card"],
  // The *_update / re-render sequence: the server is stateless per request
  // (serve.ts boots a fresh McpServer per POST), so the render→update beat is
  // TWO stateless tools sharing one ui resourceUri rather than one stateful
  // tool — the steer drives the sequence.
  "app-update": ["render_card", "update_card"],
  "error": ["fail"],
};

/**
 * Returns the pinned tool name for the given mock kind.
 *
 * - "text"       → "echo"
 * - "app-spec"   → "render_card"
 * - "app-update" → "update_card" (the kind's DISTINCTIVE tool; use
 *                  knownToolsFor for the full set it registers)
 * - "error"      → "fail"
 */
export function knownToolFor(kind: MockKind): string {
  const names = TOOL_NAMES[kind];
  return names[names.length - 1] as string;
}

/**
 * Returns ALL pinned tool names the given mock kind registers, in call order.
 * Single-tool kinds return a one-element array; "app-update" returns
 * ["render_card", "update_card"].
 */
export function knownToolsFor(kind: MockKind): string[] {
  return [...TOOL_NAMES[kind]];
}
