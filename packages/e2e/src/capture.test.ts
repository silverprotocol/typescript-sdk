/**
 * capture.test.ts — TDD RED: tests for runCapture.
 *
 * Risk-pass F4: fakes ONLY the LLM/process boundary (runAgentCapture).
 * Uses REAL createClaudeNormalizer (as opts.framework:"claude"'s createNormalizer),
 * REAL census, REAL extractToolCalls, REAL serveMock.
 *
 * The fake native stream is built from HONEST SDKMessage shapes (an assistant turn
 * with a nested tool_use block) so it genuinely exercises normalize→census
 * and tool-extraction — NOT glue-calling-glue.
 */
import { describe, it, expect } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { census } from "./census.js";
import { extractToolCalls } from "./extract-tools.js";
import { serveMock } from "./mcp-mocks/serve.js";
import { Scenario } from "./scenario.js";
import { runCapture, type CaptureDeps, type Cassette } from "./capture.js";

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal honest-SDKMessage native stream: one assistant turn with a
 * tool_use block + one result.success.
 */
function fakeNativeWith(toolName: string): JsonValue[] {
  return [
    {
      type: "assistant",
      session_id: "sess_test",
      parent_tool_use_id: null,
      message: {
        id: "msg_test_001",
        model: "claude-sonnet-4-6",
        role: "assistant",
        stop_reason: "tool_use",
        stop_sequence: null,
        type: "message",
        content: [
          {
            type: "tool_use",
            id: "tool_use_test_001",
            name: toolName,
            input: { message: "hello from fake" },
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 8,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: "sess_test",
      uuid: "result_uuid_001",
      stop_reason: "end_turn",
      result: "Tool called successfully.",
      total_cost_usd: 0.001,
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        server_tool_use: null,
      },
      modelUsage: {},
      permission_denials: [],
    },
  ];
}

/**
 * A native stream with NO tool calls (for testing the expectTools guard).
 */
function fakeNativeNoTools(): JsonValue[] {
  return [
    {
      type: "assistant",
      session_id: "sess_test",
      parent_tool_use_id: null,
      message: {
        id: "msg_text_only",
        model: "claude-sonnet-4-6",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        content: [
          { type: "text", text: "I chose not to call any tools.", citations: null },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 8,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: "sess_test",
      uuid: "result_uuid_002",
      stop_reason: "end_turn",
      result: "Done.",
      total_cost_usd: 0.0005,
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        server_tool_use: null,
      },
      modelUsage: {},
      permission_denials: [],
    },
  ];
}

// Port allocator: deterministic, test-isolated, no Math.random.
let nextPort = 49200;
function allocPort(): number {
  return nextPort++;
}

// ─── deps factory ───────────────────────────────────────────────────────────

function makeRealDeps(fakeStream: JsonValue[]): CaptureDeps {
  return {
    // ★ ONLY the LLM/process boundary is faked.
    async *runAgentCapture(_input) {
      for (const event of fakeStream) {
        yield event;
      }
    },
    // REAL collaborators:
    serveMock,
    createNormalizer: createClaudeNormalizer,
    census,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// runCapture — real pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("runCapture", () => {
  it("produces a 3-part cassette (native, agjson, coverage) for text-only scenario", async () => {
    const scenario = Scenario.parse({
      name: "text-only",
      prompt: "Say something.",
    });

    // text-only has no mcpServers → no tools expected; stream with no tools satisfies expectTools=[]
    const deps = makeRealDeps(fakeNativeNoTools());

    const cassette: Cassette = await runCapture(scenario, deps, { ports: [], framework: "claude" });

    expect(cassette).toHaveProperty("native");
    expect(cassette).toHaveProperty("agjson");
    expect(cassette).toHaveProperty("coverage");
    expect(Array.isArray(cassette.native)).toBe(true);
    expect(Array.isArray(cassette.agjson)).toBe(true);
  });

  it("produces a cassette with a real coverage report from the REAL census", async () => {
    const scenario = Scenario.parse({
      name: "text-only",
      prompt: "Say something.",
    });

    const deps = makeRealDeps(fakeNativeNoTools());
    const cassette = await runCapture(scenario, deps, { ports: [], framework: "claude" });

    // The coverage report must have the census fields (drops, newFields).
    expect(cassette.coverage).toHaveProperty("drops");
    expect(cassette.coverage).toHaveProperty("newFields");
    expect(Array.isArray(cassette.coverage.drops)).toBe(true);
    expect(Array.isArray(cassette.coverage.newFields)).toBe(true);
  });

  it("★ REAL normalizer: agjson contains AgEvents produced by createClaudeNormalizer", async () => {
    const scenario = Scenario.parse({
      name: "text-only",
      prompt: "Say something.",
    });

    const deps = makeRealDeps(fakeNativeNoTools());
    const cassette = await runCapture(scenario, deps, { ports: [], framework: "claude" });

    // The REAL normalizer on an assistant text-only turn emits turn.start, message.start,
    // text.start, text.delta, text.end, message.end, turn.done — at least one event
    // must carry type === "turn.done" from the result.success message.
    const agjson = cassette.agjson as JsonValue[];
    const hasTurnDone = agjson.some(
      (e) => typeof e === "object" && e !== null && !Array.isArray(e) && e["type"] === "turn.done",
    );
    expect(hasTurnDone).toBe(true);
  });

  it("★ REAL extractToolCalls + expectTools check: satisfies expectTools → cassette returned", async () => {
    const scenario = Scenario.parse({
      name: "single-tool-call",
      prompt: "Call the echo tool.",
      mcpServers: [{ key: "t", kind: "text" }],
      steer: "You MUST call mcp__t__echo.",
    });

    const port = allocPort();
    // The fake stream calls mcp__t__echo → satisfies expectTools
    const deps = makeRealDeps(fakeNativeWith("mcp__t__echo"));
    const cassette = await runCapture(scenario, deps, { ports: [port], framework: "claude" });

    expect(cassette).toHaveProperty("native");
    expect(cassette).toHaveProperty("agjson");
    expect(cassette).toHaveProperty("coverage");

    // The native must contain the tool_use block
    const native = cassette.native as JsonValue[];
    const toolCalls = extractToolCalls(native);
    expect(toolCalls).toContain("mcp__t__echo");
  });

  it("★ throws when expectTools is NOT satisfied (no half-cassette written)", async () => {
    const scenario = Scenario.parse({
      name: "single-tool-call",
      prompt: "Call the echo tool.",
      mcpServers: [{ key: "t", kind: "text" }],
    });

    const port = allocPort();
    // The fake stream has NO tool calls → fails expectTools check
    const deps = makeRealDeps(fakeNativeNoTools());

    await expect(
      runCapture(scenario, deps, { ports: [port], framework: "claude" }),
    ).rejects.toThrow();
  });

  it("boots the REAL serveMock for each mcpServer (port is actually listening)", async () => {
    const scenario = Scenario.parse({
      name: "single-tool-call",
      prompt: "Call the echo tool.",
      mcpServers: [{ key: "t", kind: "text" }],
    });

    const port = allocPort();
    let capturedInput: unknown;

    // Wrap runAgentCapture to capture the mcpServers map it receives
    const deps: CaptureDeps = {
      async *runAgentCapture(input) {
        capturedInput = input;
        yield* (async function* () {
          for (const event of fakeNativeWith("mcp__t__echo")) {
            yield event;
          }
        })();
      },
      serveMock,
      createNormalizer: createClaudeNormalizer,
      census,
    };

    await runCapture(scenario, deps, { ports: [port], framework: "claude" });

    // The input passed to runAgentCapture must contain an mcpServers map
    // with "t" as the key and a url pointing to our port.
    expect(capturedInput).toBeDefined();
    const input = capturedInput as { mcpServers: Record<string, { url: string; bearer: string }> };
    const tServer = input.mcpServers["t"];
    expect(tServer).toBeDefined();
    expect(tServer?.url).toContain(`${port}`);
    expect(typeof tServer?.bearer).toBe("string");
  });

  it("forwards opts.model to the agent's CaptureRunInput.model when set", async () => {
    const scenario = Scenario.parse({ name: "text-only", prompt: "Say something." });
    let capturedInput: unknown;

    const deps: CaptureDeps = {
      async *runAgentCapture(input) {
        capturedInput = input;
        yield* (async function* () {
          for (const event of fakeNativeNoTools()) {
            yield event;
          }
        })();
      },
      serveMock,
      createNormalizer: createClaudeNormalizer,
      census,
    };

    await runCapture(scenario, deps, { ports: [], framework: "claude", model: "claude-sonnet-5" });

    const input = capturedInput as { model?: string };
    expect(input.model).toBe("claude-sonnet-5");
  });

  it("omits model from CaptureRunInput when opts.model is not set (agent's own default applies)", async () => {
    const scenario = Scenario.parse({ name: "text-only", prompt: "Say something." });
    let capturedInput: unknown;

    const deps: CaptureDeps = {
      async *runAgentCapture(input) {
        capturedInput = input;
        yield* (async function* () {
          for (const event of fakeNativeNoTools()) {
            yield event;
          }
        })();
      },
      serveMock,
      createNormalizer: createClaudeNormalizer,
      census,
    };

    await runCapture(scenario, deps, { ports: [], framework: "claude" });

    const input = capturedInput as { model?: string };
    expect(input.model).toBeUndefined();
  });
});
