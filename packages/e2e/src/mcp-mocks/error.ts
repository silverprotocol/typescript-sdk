/**
 * error.ts — registers the "fail" tool on an McpServer.
 *
 * Result shape:
 * {
 *   isError: true,
 *   content: [{ type: "text", text: JSON.stringify({ error: { code: "E_MOCK", message: "boom" } }) }]
 * }
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { knownToolFor } from "./tools.js";

export function registerErrorTool(server: McpServer): void {
  server.registerTool(
    knownToolFor("error"),
    {
      description: "Always returns a deterministic error result (isError: true).",
    },
    () => {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: { code: "E_MOCK", message: "boom" } }),
          },
        ],
      };
    },
  );
}
