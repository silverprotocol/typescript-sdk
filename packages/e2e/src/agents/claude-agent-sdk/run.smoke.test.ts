/**
 * Smoke tests for the standalone Claude capture agent.
 *
 * Validates module-load contract (no CLI resolution at import time) and
 * the public shape of the exported function. No live SDK run — no API key
 * required. Task 7 (operator) exercises the live path.
 */
import { describe, it, expect } from "vitest";

describe("runClaudeCapture — module-load smoke", () => {
  it("importing the module does NOT throw (no module-load CLI resolution)", async () => {
    // The critical invariant: 0.2.141 ships a native binary and self-resolves
    // it at run time, NOT at import time. If resolveClaudeCliPath / spawnClaudeCli
    // were lifted from the ../ggui sample they would throw here.
    const m = await import("./run.js");
    expect(typeof m.runClaudeCapture).toBe("function");
  });

  it("runClaudeCapture is an async generator (returns AsyncIterable)", async () => {
    const { runClaudeCapture } = await import("./run.js");
    // An async generator function returns an object with Symbol.asyncIterator.
    // We can confirm the shape without invoking the SDK by just checking the
    // return value of calling the function (the generator is lazy — no work
    // happens until the caller iterates it).
    const iter = runClaudeCapture({
      prompt: "test",
      mcpServers: {},
      allowedTools: [],
      // No apiKey and ANTHROPIC_API_KEY not set in CI —
      // iteration is NOT started here, so no key error should fire yet.
    });
    expect(iter != null).toBe(true);
    expect(typeof (iter as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
  });
});
