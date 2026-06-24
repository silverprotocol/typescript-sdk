/**
 * client.ts — minimal JSON-RPC client for mock MCP servers.
 *
 * Supports both application/json and text/event-stream (SSE) framed responses.
 * Used by tests to drive tools/list and tools/call against mock servers.
 */

import type { JsonValue } from "@silverprotocol/core";

/**
 * Posts a JSON-RPC request to the MCP endpoint.
 *
 * For tools/call: method = "tools/call", params = { name, arguments: args }
 * For tools/list: method = "tools/list", params = {}
 *
 * Parses both application/json and text/event-stream framed responses.
 * Returns the result field from the JSON-RPC response, or throws on error.
 *
 * @param mcpUrl  - Full URL of the MCP endpoint (e.g. "http://127.0.0.1:PORT/mcp")
 * @param method  - JSON-RPC method name ("tools/call" or "tools/list")
 * @param args    - Arguments: for tools/call pass the tool args; for tools/list pass null
 */
export async function callTool(
  mcpUrl: string,
  method: string,
  args: JsonValue,
): Promise<JsonValue> {
  let rpcMethod: string;
  let params: Record<string, JsonValue>;

  if (method === "tools/list") {
    rpcMethod = "tools/list";
    params = {};
  } else {
    // Assume it's a tool name — issue a tools/call
    rpcMethod = "tools/call";
    params = {
      name: method,
      arguments: args ?? {},
    };
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: rpcMethod,
    params,
  });

  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body,
  });

  if (!res.ok && res.status !== 200) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(`MCP request failed: HTTP ${res.status} — ${text}`);
  }

  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    // SSE-framed response: read all data: lines and take the last JSON-RPC message
    const text = await res.text();
    return parseSSEResult(text);
  }

  // Plain JSON response
  const json = (await res.json()) as Record<string, JsonValue>;

  if ("error" in json && json["error"] !== undefined) {
    throw new Error(
      `JSON-RPC error: ${JSON.stringify(json["error"])}`,
    );
  }

  const result = json["result"];
  if (result === undefined) {
    throw new Error(`Unexpected JSON-RPC response (no result): ${JSON.stringify(json)}`);
  }
  return result;
}

/**
 * Parses an SSE (text/event-stream) body and extracts the result from the
 * last JSON-RPC message that has a `result` field.
 */
function parseSSEResult(text: string): JsonValue {
  const lines = text.split("\n");
  let lastResult: JsonValue | undefined;

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice("data: ".length).trim();
    if (data === "[DONE]" || data === "") continue;

    let parsed: Record<string, JsonValue>;
    try {
      parsed = JSON.parse(data) as Record<string, JsonValue>;
    } catch {
      continue;
    }

    if ("result" in parsed && parsed["result"] !== undefined) {
      lastResult = parsed["result"];
    }
  }

  if (lastResult === undefined) {
    throw new Error(`No result found in SSE response: ${text.slice(0, 500)}`);
  }
  return lastResult;
}
