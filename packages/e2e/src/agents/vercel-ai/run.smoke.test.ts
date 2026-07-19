/**
 * Smoke tests for the standalone Vercel AI SDK capture agent.
 *
 * Structural validation only (mirrors ../google-adk/run.smoke.test.ts).
 * Validates module-load contract, the public shape of the exported function,
 * and the OPERATOR-GATED key-absent failure. No live SDK run — no API key
 * required, no MCP server booted. The operator exercises the live path with
 * a real OPENAI_API_KEY.
 */
import { afterEach, describe, expect, it } from "vitest";

const ORIGINAL_KEY = process.env["OPENAI_API_KEY"];

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env["OPENAI_API_KEY"];
  } else {
    process.env["OPENAI_API_KEY"] = ORIGINAL_KEY;
  }
});

describe("runVercelCapture — module-load smoke", () => {
  it("importing the module does NOT throw", async () => {
    const m = await import("./run.js");
    expect(typeof m.runVercelCapture).toBe("function");
  });

  it("runVercelCapture is an async generator (returns AsyncIterable) — lazy, no work until iterated", async () => {
    const { runVercelCapture } = await import("./run.js");
    delete process.env["OPENAI_API_KEY"];
    const iter = runVercelCapture({
      prompt: "test",
      mcpServers: {},
      allowedTools: [],
      // No apiKey and OPENAI_API_KEY unset — iteration is NOT started here,
      // so no key error should fire yet (async generator body is lazy).
    });
    expect(iter != null).toBe(true);
    expect(typeof (iter as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
  });

  it("★ OPERATOR-GATED: throws a clear error on first iteration when no key is available", async () => {
    const { runVercelCapture } = await import("./run.js");
    delete process.env["OPENAI_API_KEY"];
    const iter = runVercelCapture({ prompt: "test", mcpServers: {}, allowedTools: [] });
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
