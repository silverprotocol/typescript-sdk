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
import { StreamProviderError, type TextStreamPart, type ToolSet } from "ai";
import { toJsonValue } from "@silverprotocol/core";
import { projectStreamPartErrors } from "./run.js";

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

describe("projectStreamPartErrors — Error-carrying parts survive the JsonValue round-trip", () => {
  /** Raw OpenAI Responses `error` SSE frame, as @ai-sdk/openai hands it to the SDK. */
  const FRAME = {
    type: "error",
    code: "rate_limit_exceeded",
    message: "Rate limit reached for gpt-4o-mini",
    param: null,
    sequence_number: 3,
  };

  it("a part with no Error instance is returned BY REFERENCE (serialization byte-identical)", () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "start" },
      { type: "text-delta", id: "t1", text: "hi" },
      { type: "error", error: "plain string error" },
      { type: "error", error: FRAME }, // pre-7.0.80 unwrapped frame — a plain object
    ];
    for (const part of parts) {
      expect(projectStreamPartErrors(part)).toBe(part);
      expect(JSON.stringify(projectStreamPartErrors(part))).toBe(JSON.stringify(part));
    }
  });

  it("the REAL ai@7 StreamProviderError round-trips WITH its message and every own prop", () => {
    const error = new StreamProviderError({
      message: "Rate limit reached for gpt-4o-mini",
      type: "server_error",
      code: "rate_limit_exceeded",
      statusCode: 429,
      data: FRAME,
      // isRetryable omitted ⇒ SDK-inferred from 429
    });
    const part: TextStreamPart<ToolSet> = { type: "error", error };
    // The gap this guards against: the bare round-trip drops `message`.
    const bare = toJsonValue(part) as { error: { message?: unknown } };
    expect("message" in bare.error).toBe(false);
    expect(toJsonValue(projectStreamPartErrors(part))).toStrictEqual({
      type: "error",
      error: {
        name: "AI_StreamProviderError",
        message: "Rate limit reached for gpt-4o-mini",
        type: "server_error",
        code: "rate_limit_exceeded",
        statusCode: 429,
        isRetryable: true,
        data: FRAME,
      },
    });
  });

  it("a plain Error projects to {name, message}; a nested Error `cause` projects recursively", () => {
    const plain: TextStreamPart<ToolSet> = { type: "error", error: new Error("boom") };
    expect(toJsonValue(projectStreamPartErrors(plain))).toStrictEqual({
      type: "error",
      error: { name: "Error", message: "boom" },
    });
    const nested: TextStreamPart<ToolSet> = {
      type: "error",
      error: new StreamProviderError({
        message: "outer",
        isRetryable: false,
        cause: new Error("inner"),
      }),
    };
    expect(toJsonValue(projectStreamPartErrors(nested))).toStrictEqual({
      type: "error",
      error: {
        name: "AI_StreamProviderError",
        message: "outer",
        cause: { name: "Error", message: "inner" },
        isRetryable: false,
      },
    });
  });
});
