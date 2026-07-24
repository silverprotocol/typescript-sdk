/**
 * app-update.ts — registers the "render_card" + "update_card" tool pair on an
 * McpServer: the `*_update` / re-render carry-fidelity sequence
 * (silverprotocol/workspace#2, requested by ggui's e2e re-architecture).
 *
 * Both tools return the MCP App-spec shape ANCHORED ON THE SAME ui resource
 * (`ui://mock/card`) with a monotonic `revision` marker:
 *
 *   render_card → { ...payload, revision: 1, kind: "render" }
 *   update_card → { ...payload, revision: 2, kind: "update" }
 *
 * A scenario steers the model to call render_card then update_card, so the
 * captured wire carries two tool result payloads addressing one resourceUri —
 * the re-render beat as each framework actually transports it. This is
 * Layer-A carry fidelity ONLY: what a revision *means* for rendering is the
 * UI layer's business (MCP Apps / A2UI), not this corpus's.
 *
 * The server is stateless per request (serve.ts boots a fresh McpServer per
 * POST), so the sequence lives in two stateless tools + the steer, not in
 * server-side call counting.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { JsonValue } from "@silverprotocol/core";
import { knownToolsFor } from "./tools.js";

interface CardPayload {
  [key: string]: JsonValue;
}

const RESOURCE_URI = "ui://mock/card";

function cardResult(
  args: { title?: string | undefined; body?: string | undefined },
  revision: number,
  kind: "render" | "update",
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { [key: string]: JsonValue };
  _meta: { [key: string]: JsonValue };
} {
  const payload: CardPayload = {};
  if (args.title !== undefined) payload["title"] = args.title;
  if (args.body !== undefined) payload["body"] = args.body;

  const structuredContent = { ...payload, revision, kind };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    _meta: {
      ui: {
        resourceUri: RESOURCE_URI,
        visibility: ["model"],
      },
    },
  };
}

export function registerAppUpdateTools(server: McpServer): void {
  const [renderName, updateName] = knownToolsFor("app-update") as [string, string];

  server.registerTool(
    renderName,
    {
      description: "Renders a mock UI card (revision 1) and returns the MCP App-spec shape.",
      inputSchema: {
        title: z.string().optional().describe("Card title"),
        body: z.string().optional().describe("Card body text"),
      },
    },
    (args) => cardResult(args, 1, "render"),
  );

  server.registerTool(
    updateName,
    {
      description:
        "Updates the previously rendered mock UI card in place (same resource, revision 2).",
      inputSchema: {
        title: z.string().optional().describe("Updated card title"),
        body: z.string().optional().describe("Updated card body text"),
      },
    },
    (args) => cardResult(args, 2, "update"),
  );
}
