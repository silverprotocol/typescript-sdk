/**
 * extract-tools.ts — extractToolCalls: walks a native capture-agent event
 * stream and collects tool-call names, dispatched by `framework` (default
 * "claude" — every pre-existing call site is unaffected).
 *
 * Three per-framework readers, each ground-truthed against the ACTUAL shape
 * of the committed native cassettes (not guessed):
 *
 *   - claude (★ Risk-pass F2): the three block types checked here match
 *     EXACTLY what the claude-agent-sdk normalizer reads (index.ts L299-301):
 *       - "tool_use"        — regular MCP/function tool call
 *       - "server_tool_use" — server-executed tool (e.g. web_search)
 *       - "mcp_tool_use"    — MCP tool call with explicit server_name field
 *     Names collected from assistant message.content[] arrays.
 *
 *   - openai: `@openai/agents` RunItemStreamEvent — verified against
 *     corpus/text-tool-turn/openai.native.json[14]:
 *       { type:"run_item_stream_event", item: { type:"tool_call_item",
 *         rawItem: { type:"function_call", name } } }
 *
 *   - adk: a Google ADK `Event`'s `content.parts[]` — verified against
 *     corpus/text-tool-turn/adk.native.json[0]:
 *       { content: { parts: [{ functionCall: { name } }] } }
 */
import type { JsonValue } from "@silverprotocol/core";
import type { Framework } from "./census.js";

const TOOL_BLOCK_TYPES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

function isObject(v: JsonValue | undefined): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Walks a raw Claude SDK event stream (assistant message.content[] blocks). */
function extractClaudeToolCalls(native: JsonValue[]): string[] {
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

/** Walks a raw @openai/agents RunStreamEvent stream (tool_call_item rawItems). */
function extractOpenaiToolCalls(native: JsonValue[]): string[] {
  const names: string[] = [];

  for (const event of native) {
    if (!isObject(event)) continue;
    if (event["type"] !== "run_item_stream_event") continue;

    const item = event["item"];
    if (!isObject(item)) continue;
    if (item["type"] !== "tool_call_item") continue;

    const rawItem = item["rawItem"];
    if (!isObject(rawItem)) continue;
    if (rawItem["type"] !== "function_call") continue;

    const name = rawItem["name"];
    if (typeof name === "string") {
      names.push(name);
    }
  }

  return names;
}

/** Walks a raw Google ADK Event stream (content.parts[].functionCall). */
function extractAdkToolCalls(native: JsonValue[]): string[] {
  const names: string[] = [];

  for (const event of native) {
    if (!isObject(event)) continue;

    const content = event["content"];
    if (!isObject(content)) continue;

    const parts = content["parts"];
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (!isObject(part)) continue;
      const functionCall = part["functionCall"];
      if (!isObject(functionCall)) continue;

      const name = functionCall["name"];
      if (typeof name === "string") {
        names.push(name);
      }
    }
  }

  return names;
}

/**
 * Returns the names of every tool call in `native`, dispatched by
 * `framework` (default `"claude"`).
 */
/** Walks a raw Vercel AI SDK TextStreamPart stream ({type:"tool-call"} parts). */
function extractVercelToolCalls(native: JsonValue[]): string[] {
  const names: string[] = [];
  for (const event of native) {
    if (!isObject(event)) continue;
    if (event["type"] !== "tool-call") continue;
    const name = event["toolName"];
    if (typeof name === "string") {
      names.push(name);
    }
  }
  return names;
}

export function extractToolCalls(native: JsonValue[], framework: Framework = "claude"): string[] {
  if (framework === "openai") return extractOpenaiToolCalls(native);
  if (framework === "adk") return extractAdkToolCalls(native);
  if (framework === "vercel") return extractVercelToolCalls(native);
  return extractClaudeToolCalls(native);
}
