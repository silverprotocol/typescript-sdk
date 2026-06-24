/**
 * app-spec.ts — registers the "render_card" tool on an McpServer.
 *
 * Result shape:
 * {
 *   content: [{ type: "text", text: JSON.stringify(payload) }],
 *   structuredContent: { ...payload, cache: { hit: false, llmCallsAvoided: 0, kind: "cold" } },
 *   _meta: { ui: { resourceUri: "ui://mock/card", visibility: ["model"] } }
 * }
 *
 * This synthesizes the MCP App-spec shape + ggui render-cache-marker.
 * The capture agent's metering reads structuredContent.cache.hit.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { JsonValue } from "@silverprotocol/core";
import { knownToolFor } from "./tools.js";

interface AppSpecPayload {
  [key: string]: JsonValue;
}

export function registerAppSpecTool(server: McpServer): void {
  server.registerTool(
    knownToolFor("app-spec"),
    {
      description: "Renders a mock UI card and returns the MCP App-spec shape.",
      inputSchema: {
        title: z.string().optional().describe("Card title"),
        body: z.string().optional().describe("Card body text"),
      },
    },
    (args) => {
      const payload: AppSpecPayload = {};
      if (args.title !== undefined) payload["title"] = args.title;
      if (args.body !== undefined) payload["body"] = args.body;

      const structuredContent = {
        ...payload,
        cache: {
          hit: false,
          llmCallsAvoided: 0,
          kind: "cold",
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent,
        _meta: {
          ui: {
            resourceUri: "ui://mock/card",
            visibility: ["model"],
          },
        },
      };
    },
  );
}
