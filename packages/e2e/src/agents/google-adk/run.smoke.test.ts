/**
 * Smoke tests for the standalone Google ADK (`@google/adk`) capture agent.
 *
 * Structural validation only (Task 6 — see run.ts's header for the full
 * adjudication). Validates module-load contract, the public shape of the
 * exported function, and the OPERATOR-GATED key-absent failure. No live SDK
 * run — no API key required, no MCP server booted. The operator exercises
 * the live path with a real GOOGLE_API_KEY.
 */
import { afterEach, describe, expect, it } from "vitest";
// Static on purpose: the vendor SDK's cold load runs at collection, which
// vitest does not time. Inside the test body it raced testTimeout on a busy
// box (101.9 s at load avg ~300, 2026-09-23). A throw at import still fails
// this file, so the module-load contract still gates. run.ts reads the key
// only inside runAdkCapture, so importing before ORIGINAL_KEY is safe.
import * as runModule from "./run.js";

const ORIGINAL_KEY = process.env["GOOGLE_API_KEY"];

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env["GOOGLE_API_KEY"];
  } else {
    process.env["GOOGLE_API_KEY"] = ORIGINAL_KEY;
  }
});

describe("runAdkCapture — module-load smoke", () => {
  it("importing the module does NOT throw", () => {
    expect(typeof runModule.runAdkCapture).toBe("function");
  });

  it("runAdkCapture is an async generator (returns AsyncIterable) — lazy, no work until iterated", async () => {
    const { runAdkCapture } = await import("./run.js");
    delete process.env["GOOGLE_API_KEY"];
    const iter = runAdkCapture({
      prompt: "test",
      mcpServers: {},
      allowedTools: [],
      // No apiKey and GOOGLE_API_KEY unset — iteration is NOT started here,
      // so no key error should fire yet (async generator body is lazy).
    });
    expect(iter != null).toBe(true);
    expect(typeof (iter as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
  });

  it("★ OPERATOR-GATED: throws a clear error on first iteration when no key is available", async () => {
    const { runAdkCapture } = await import("./run.js");
    delete process.env["GOOGLE_API_KEY"];
    const iter = runAdkCapture({ prompt: "test", mcpServers: {}, allowedTools: [] });
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(/GOOGLE_API_KEY/);
  });
});
