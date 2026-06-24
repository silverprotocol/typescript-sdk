/**
 * text.ts — registers the "echo" tool on an McpServer.
 *
 * Result shape: { content: [{ type: "text", text: "<echo of input>" }] }
 * Deliberately NO structuredContent — this is a plain text-only tool.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { knownToolFor } from "./tools.js";

export function registerTextTool(server: McpServer): void {
  server.registerTool(
    knownToolFor("text"),
    {
      description: "Echoes the input message back as text.",
      inputSchema: {
        message: z.string().optional().describe("The text to echo"),
      },
    },
    (args) => {
      const text = args.message ?? "(no message)";
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
