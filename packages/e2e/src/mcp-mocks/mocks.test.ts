/**
 * mocks.test.ts — TDD conformance tests for mock MCP servers.
 *
 * Tests:
 * - knownToolFor returns the three pinned names
 * - Each mock boots, tools/list returns exactly knownToolFor(kind)
 * - callTool returns deterministic shapes
 * - GET /mcp → 405 (NOT 404)
 * - DELETE /mcp → 405
 * - Unknown path → 404
 * - close() frees the port
 */

import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { knownToolFor } from "./tools.js";
import { serveMock } from "./serve.js";
import { callTool } from "./client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Port helper — allocates an OS-assigned ephemeral port, then releases it so
// the mock can bind on it. Not 100% race-free but deterministic enough for
// serial tests on localhost.
// ─────────────────────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("unexpected address")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// knownToolFor — single source of truth
// ─────────────────────────────────────────────────────────────────────────────

describe("knownToolFor", () => {
  it('returns "echo" for kind "text"', () => {
    expect(knownToolFor("text")).toBe("echo");
  });

  it('returns "render_card" for kind "app-spec"', () => {
    expect(knownToolFor("app-spec")).toBe("render_card");
  });

  it('returns "fail" for kind "error"', () => {
    expect(knownToolFor("error")).toBe("fail");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP method routing
// ─────────────────────────────────────────────────────────────────────────────

describe("HTTP routing", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  it("GET /mcp → 405 (not 404)", async () => {
    const port = await getFreePort();
    const mock = serveMock("text", port);
    close = mock.close;

    const res = await fetch(mock.url, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("POST");
  });

  it("DELETE /mcp → 405", async () => {
    const port = await getFreePort();
    const mock = serveMock("text", port);
    close = mock.close;

    const res = await fetch(mock.url, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("unknown path → 404", async () => {
    const port = await getFreePort();
    const mock = serveMock("text", port);
    close = mock.close;

    const base = mock.url.replace(/\/mcp$/, "");
    const res = await fetch(`${base}/unknown-path`);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tools/list — exactly knownToolFor(kind)
// ─────────────────────────────────────────────────────────────────────────────

describe("tools/list", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  it('text mock lists exactly ["echo"]', async () => {
    const port = await getFreePort();
    const mock = serveMock("text", port);
    close = mock.close;

    const result = await callTool(mock.url, "tools/list", null);
    const tools = (result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([knownToolFor("text")]);
  });

  it('app-spec mock lists exactly ["render_card"]', async () => {
    const port = await getFreePort();
    const mock = serveMock("app-spec", port);
    close = mock.close;

    const result = await callTool(mock.url, "tools/list", null);
    const tools = (result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([knownToolFor("app-spec")]);
  });

  it('error mock lists exactly ["fail"]', async () => {
    const port = await getFreePort();
    const mock = serveMock("error", port);
    close = mock.close;

    const result = await callTool(mock.url, "tools/list", null);
    const tools = (result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([knownToolFor("error")]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// callTool shapes
// ─────────────────────────────────────────────────────────────────────────────

describe("text mock (echo)", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  it("returns content with echoed text and NO structuredContent", async () => {
    const port = await getFreePort();
    const mock = serveMock("text", port);
    close = mock.close;

    const args = { message: "hello from test" };
    const result = await callTool(mock.url, knownToolFor("text"), args);

    const r = result as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };
    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.type).toBe("text");
    expect(r.content[0]?.text).toContain("hello from test");
    expect(r.structuredContent).toBeUndefined();
  });
});

describe("app-spec mock (render_card)", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  it("returns structuredContent with cache.hit===false and _meta.ui.resourceUri", async () => {
    const port = await getFreePort();
    const mock = serveMock("app-spec", port);
    close = mock.close;

    const args = { title: "test card" };
    const result = await callTool(mock.url, knownToolFor("app-spec"), args);

    const r = result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: {
        cache: { hit: boolean; llmCallsAvoided: number; kind: string };
      };
      _meta: { ui: { resourceUri: string; visibility: string[] } };
    };

    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.type).toBe("text");

    expect(r.structuredContent.cache.hit).toBe(false);
    expect(r.structuredContent.cache.llmCallsAvoided).toBe(0);
    expect(r.structuredContent.cache.kind).toBe("cold");

    expect(r._meta.ui.resourceUri).toBe("ui://mock/card");
    expect(r._meta.ui.visibility).toContain("model");
  });
});

describe("error mock (fail)", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  it("returns isError===true with error payload", async () => {
    const port = await getFreePort();
    const mock = serveMock("error", port);
    close = mock.close;

    const result = await callTool(mock.url, knownToolFor("error"), {});

    const r = result as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.type).toBe("text");

    const parsed = JSON.parse(r.content[0]?.text ?? "{}") as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe("E_MOCK");
    expect(parsed.error.message).toBe("boom");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// close() frees the port
// ─────────────────────────────────────────────────────────────────────────────

describe("serveMock close()", () => {
  it("frees the port so a subsequent bind on the same port succeeds", async () => {
    const port = await getFreePort();
    const mock = serveMock("text", port);
    await mock.close();

    // If the port is free, this listen+close should succeed without error
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve());
      });
    });
  });
});
