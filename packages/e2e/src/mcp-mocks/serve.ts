/**
 * serve.ts — boots a local mock MCP server on a caller-provided port.
 *
 * Pattern: node:http createServer; POST /mcp → fresh McpServer + stateless
 * StreamableHTTPServerTransport({ sessionIdGenerator: undefined }) per request.
 *
 * ★ GET /mcp AND DELETE /mcp → HTTP 405 with Allow: GET, POST, DELETE
 *   (NOT a 404 catch-all). The Claude Agent SDK MCP client opens a standalone
 *   GET-SSE probe after `initialize`; it treats ONLY 405 as the expected
 *   "no SSE here" case — a 404 throws StreamableHTTPError transport noise.
 *
 * 404 is reserved for genuinely unknown paths.
 */

import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MockKind } from "./tools.js";
import { registerTextTool } from "./text.js";
import { registerAppSpecTool } from "./app-spec.js";
import { registerErrorTool } from "./error.js";

export interface MockHandle {
  /** The MCP endpoint URL, e.g. "http://127.0.0.1:PORT/mcp" */
  url: string;
  /** Closes the server and frees the port. Resolves when the port is released. */
  close(): Promise<void>;
}

function registerTools(server: McpServer, kind: MockKind): void {
  switch (kind) {
    case "text":
      registerTextTool(server);
      break;
    case "app-spec":
      registerAppSpecTool(server);
      break;
    case "error":
      registerErrorTool(server);
      break;
  }
}

/**
 * Boots a mock MCP server for the given kind on the specified port.
 *
 * The caller is responsible for picking a free port (e.g. via a node:net
 * ephemeral-port helper). No Math.random() is used here.
 *
 * The returned MockHandle.url is available immediately (synchronously).
 * close() waits for the server to finish listening before closing, so it
 * always resolves cleanly even if called immediately after serveMock().
 *
 * @param kind - Which mock tool set to expose ("text" | "app-spec" | "error")
 * @param port - TCP port to listen on (must be free)
 * @returns MockHandle with url and close()
 */
export function serveMock(kind: MockKind, port: number): MockHandle {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method?.toUpperCase() ?? "GET";

    if (url === "/mcp") {
      if (method === "POST") {
        // Stateless mode: fresh McpServer + transport per request.
        const mcp = new McpServer({ name: `mock-${kind}`, version: "0.0.0" });
        registerTools(mcp, kind);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });

        res.on("close", () => {
          transport.close().catch(() => undefined);
          mcp.close().catch(() => undefined);
        });

        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => {
          let parsedBody: unknown;
          try {
            parsedBody = body.length > 0 ? JSON.parse(body) : undefined;
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32700, message: "Parse error" },
                id: null,
              }),
            );
            return;
          }

          mcp
            .connect(transport)
            .then(() => transport.handleRequest(req, res, parsedBody))
            .catch((err: unknown) => {
              if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: String(err) },
                    id: null,
                  }),
                );
              }
            });
        });

        return;
      }

      // ★ GET and DELETE on /mcp → 405 (not 404).
      // The Claude Agent SDK MCP client issues a standalone GET-SSE probe after
      // initialize; it treats 405 as the silent "no SSE here" case. A 404
      // would throw a StreamableHTTPError and generate transport noise.
      if (method === "GET" || method === "DELETE") {
        res.writeHead(405, {
          "Allow": "GET, POST, DELETE",
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed (stateless server)." },
            id: null,
          }),
        );
        return;
      }

      // Other methods on /mcp (PUT, PATCH, etc.) → 405
      res.writeHead(405, {
        "Allow": "GET, POST, DELETE",
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
      );
      return;
    }

    // Genuinely unknown path → 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // Track when the server is ready to accept connections.
  // close() awaits this so it never sees "Server is not running."
  const listeningPromise = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  server.listen(port, "127.0.0.1");

  const url = `http://127.0.0.1:${port}/mcp`;

  return {
    url,
    close(): Promise<void> {
      // Wait for listen to complete before calling close() so that Node's
      // http.Server never sees "Server is not running."
      return listeningPromise.then(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          }),
      );
    },
  };
}
