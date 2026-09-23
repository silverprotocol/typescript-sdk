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
// Static on purpose: the vendor SDK's cold load runs at collection, which
// vitest does not time. Inside the test body it raced testTimeout on a busy
// box (43.7 s at load avg ~300, 2026-09-23). A throw at import still fails
// this file, so the module-load contract still gates. run.ts reads the key
// only inside runOpenaiCapture, so importing before ORIGINAL_KEY is safe.
import * as runModule from "./run.js";

const ORIGINAL_KEY = process.env["OPENAI_API_KEY"];

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env["OPENAI_API_KEY"];
  } else {
    process.env["OPENAI_API_KEY"] = ORIGINAL_KEY;
  }
});

describe("runOpenaiCapture — module-load smoke", () => {
  it("importing the module does NOT throw", () => {
    expect(typeof runModule.runOpenaiCapture).toBe("function");
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

// The commentary capture (commentary-gpt6sol, sp-probe ad6f19f) needs reasoning
// summaries: `CaptureRunInput.reasoningSummary` → the Agent's
// `modelSettings.reasoning.summary` (agents-core 0.18.0 dist/model.d.ts:37,
// `ModelSettingsReasoning.summary: 'auto' | 'concise' | 'detailed' | null`).
// Keyless: the helper is pure, so no SDK run or network is involved.
describe("openaiModelSettings — reasoningSummary knob", () => {
  it.each(["auto", "concise", "detailed"] as const)("reasoningSummary %s → { reasoning: { summary } }", (summary) => {
    expect(
      runModule.openaiModelSettings({ prompt: "p", mcpServers: {}, allowedTools: [], reasoningSummary: summary }),
    ).toEqual({ reasoning: { summary } });
  });

  it("absent → undefined (the Agent gets NO modelSettings key — byte-identical to before the knob)", () => {
    expect(runModule.openaiModelSettings({ prompt: "p", mcpServers: {}, allowedTools: [] })).toBeUndefined();
  });
});
