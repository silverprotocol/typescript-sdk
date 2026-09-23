/**
 * resource-link.ts — registers the "find_doc" tool on an McpServer.
 *
 * Result shape: a short text block plus ONE MCP `resource_link` content block
 * (MCP 2025-06-18: a link to a resource the client may fetch, NOT the resource
 * itself). Every optional field is populated so a capture exercises the whole
 * shape: title, description, mimeType, size and annotations. Deliberately NO
 * structuredContent.
 *
 * Why: the Claude Agent SDK surfaces a tool result's resource_link blocks as
 * `tool_use_result.resourceLinks` (claude-agent-sdk 0.3.257; the facet carries
 * them as tool.done providerMetadata, pre-registered in field-registry), and
 * no scenario could produce one until this mock (capture backlog "MCP
 * resource_link tool results"; rnd capture #1, 2026-09-23).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { knownToolFor } from "./tools.js";

/** The one resource_link the tool returns, exported for tests. */
export const RESOURCE_LINK = {
  type: "resource_link" as const,
  uri: "file:///docs/conformance-probe-resource-link.md",
  name: "conformance-probe-resource-link.md",
  title: "Conformance probe: resource link",
  description: "A document the find_doc tool links to instead of inlining.",
  mimeType: "text/markdown",
  size: 2048,
  annotations: { audience: ["user" as const, "assistant" as const], priority: 0.7 },
};

export function registerResourceLinkTool(server: McpServer): void {
  server.registerTool(
    knownToolFor("resource-link"),
    {
      description: "Finds a document by topic and returns a link to it (not its contents).",
      inputSchema: {
        topic: z.string().optional().describe("What the document is about"),
      },
    },
    (args) => ({
      content: [
        { type: "text" as const, text: `Found one document for "${args.topic ?? "(no topic)"}".` },
        RESOURCE_LINK,
      ],
    }),
  );
}
