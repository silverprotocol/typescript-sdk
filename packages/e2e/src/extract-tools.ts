/**
 * extract-tools.ts — extractToolCalls: walks a native Claude SDK event stream
 * and collects tool-call block names.
 *
 * ★ Risk-pass F2: The three block types checked here match EXACTLY what the
 * claude-agent-sdk normalizer reads (index.ts L299-301):
 *   - "tool_use"        — regular MCP/function tool call
 *   - "server_tool_use" — server-executed tool (e.g. web_search)
 *   - "mcp_tool_use"    — MCP tool call with explicit server_name field
 *
 * Returns the list of block.name values from all assistant messages in the stream.
 */
import type { JsonValue } from "@silverprotocol/core";

const TOOL_BLOCK_TYPES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

function isObject(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Walks `native` (an array of raw Claude SDK events) and returns the names of
 * every tool-call block in assistant message.content[] arrays.
 *
 * Block types counted: "tool_use", "server_tool_use", "mcp_tool_use".
 */
export function extractToolCalls(native: JsonValue[]): string[] {
  const names: string[] = [];

  for (const event of native) {
    if (!isObject(event)) continue;
    if (event["type"] !== "assistant") continue;

    const message: JsonValue | undefined = event["message"];
    if (message === undefined || !isObject(message)) continue;

    const content = message["content"];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isObject(block)) continue;
      const blockType = block["type"];
      if (typeof blockType !== "string") continue;
      if (!TOOL_BLOCK_TYPES.has(blockType)) continue;

      const name = block["name"];
      if (typeof name === "string") {
        names.push(name);
      }
    }
  }

  return names;
}
