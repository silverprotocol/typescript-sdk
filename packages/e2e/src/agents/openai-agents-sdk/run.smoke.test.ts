/**
 * Smoke tests for the standalone OpenAI Agents SDK capture agent.
 *
 * Structural validation only (Task 6) — validates module-load contract and
 * the public shape of the exported function, PLUS the OPERATOR-GATED
 * key-absent failure (fails fast, no live SDK / network call). No live SDK
 * run — no API key required, no MCP server booted. The operator exercises
 * the live path with a real OPENAI_API_KEY.
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

describe("runOpenaiCapture — module-load smoke", () => {
  it("importing the module does NOT throw", async () => {
    const m = await import("./run.js");
    expect(typeof m.runOpenaiCapture).toBe("function");
  });

  it("runOpenaiCapture is an async generator (returns AsyncIterable) — lazy, no work until iterated", async () => {
    const { runOpenaiCapture } = await import("./run.js");
    delete process.env["OPENAI_API_KEY"];
    const iter = runOpenaiCapture({
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
    const { runOpenaiCapture } = await import("./run.js");
    delete process.env["OPENAI_API_KEY"];
    const iter = runOpenaiCapture({ prompt: "test", mcpServers: {}, allowedTools: [] });
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
