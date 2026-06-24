import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgEvent, JsonValue } from "@silverprotocol/core";
import createClaudeNormalizer, { mapStopReason } from "./index.js";

// Types DERIVED from SDKMessage so the fixtures track the EXACT Anthropic SDK the
// Claude Agent SDK bundles (a root-level @anthropic-ai/sdk copy may differ).
type SDKAssistant = Extract<SDKMessage, { type: "assistant" }>;
type SDKUser = Extract<SDKMessage, { type: "user" }>;
type BetaMessage = SDKAssistant["message"];
type UserContent = SDKUser["message"]["content"];
type SDKAssistantError = SDKAssistant["error"];

// Drive a fresh stateful normalizer once and collect the FULL assembled stream
// (`push` + `flush`). This is the assembled-stream contract: a synthesized
// `turn.start` heads each top-level turn, content/tool events carry a
// backfilled `turnId`, and `seq` is turn-scoped monotonic (never reset per call).
function run(msg: SDKMessage): AgEvent[] {
  const n = createClaudeNormalizer();
  // `push` takes the genuine JSON boundary (`JsonValue`, spec §0.1) — the same
  // type the run-seam delivers after JSON.parse. The `SDKMessage`-typed fixture is
  // validated through the boundary by `JsonValue.parse` (the real wire roundtrip),
  // honest rather than a static cast (`SDKMessage` is not statically a `JsonValue`).
  return [...n.push(JsonValue.parse(msg)), ...n.flush()];
}

// ─── fixtures (the EXACT shapes the run-seam yields; see code-worker.ts) ──────
// A minimal valid BetaUsage for an assistant message (code-worker.ts:93).
const ASSISTANT_USAGE: BetaMessage["usage"] = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  inference_geo: null,
  iterations: null,
  server_tool_use: null,
  service_tier: null,
  speed: null,
};

function betaMessage(
  content: BetaMessage["content"],
  overrides?: Partial<Pick<BetaMessage, "stop_reason" | "stop_details" | "usage">>,
): BetaMessage {
  return {
    id: "msg_fixture_1",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    container: null,
    context_management: null,
    stop_details: null,
    usage: ASSISTANT_USAGE,
    ...overrides,
  };
}

function assistantMsg(
  content: BetaMessage["content"],
  parent_tool_use_id: string | null = null,
  messageOverrides?: Partial<Pick<BetaMessage, "stop_reason" | "stop_details" | "usage">>,
): SDKMessage {
  return {
    type: "assistant",
    message: betaMessage(content, messageOverrides),
    parent_tool_use_id,
    uuid: "00000000-0000-0000-0000-000000000001",
    session_id: "sess_fixture",
  };
}

// SDKResultSuccess fixture — every required field present (code-worker.ts:117).
// Non-zero usage values to enable usage mapping tests.
function resultSuccess(stop_reason: string | null): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: "all done",
    stop_reason,
    is_error: false,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      inference_geo: "unknown",
      iterations: [],
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "standard",
      speed: "standard",
    },
    modelUsage: {
      "claude-opus": {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 10,
        webSearchRequests: 0,
        costUSD: 0.05,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    },
    permission_denials: [],
    uuid: "00000000-0000-0000-0000-000000000002",
    session_id: "sess_fixture",
  };
}

// SDKResultError fixture — for result error branch tests.
type SDKResultSuccessMsg = Extract<SDKMessage, { type: "result"; subtype: "success" }>;
type NonNullableUsageT = SDKResultSuccessMsg["usage"];

function resultError(subtype: "error_max_turns" | "error_during_execution"): SDKMessage {
  const usage: NonNullableUsageT = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: "unknown",
    iterations: [],
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "standard",
    speed: "standard",
  };
  return {
    type: "result",
    subtype,
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    errors: ["max turns reached"],
    uuid: "00000000-0000-0000-0000-000000000004",
    session_id: "sess_fixture",
  };
}

// A user message carrying a tool_result block (the tool.done source, spec §2).
function toolResultMsg(): SDKMessage {
  const content: UserContent = [
    {
      type: "tool_result",
      tool_use_id: "toolu_fixture_1",
      content: [{ type: "text", text: "42" }],
      is_error: false,
    },
  ];
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-000000000003",
    session_id: "sess_fixture",
  };
}

// Every produced event MUST round-trip through the AgEvent schema (spec §4).
function assertAllValid(evs: AgEvent[]): void {
  for (const ev of evs) {
    expect(() => AgEvent.parse(ev)).not.toThrow();
  }
}

// ─── ASSEMBLED-STREAM GOLDENS ─────────────────────────────────────────────────
// These assert the FULL ordered AgEvent[] from the stateful normalizer driving
// the StreamAssembler engine. Three intended differences vs. the old stateless
// claudeNormalizer: (1) a synthesized `turn.start` heads each TOP-LEVEL turn;
// (2) `turnId` is backfilled onto content/tool events; (3) `seq` is turn-scoped
// monotonic. The nested-subagent turn is seeded by `subagent.start`, so it has
// NO synthesized `turn.start`.

const TOP_TURN = "turn_sess_fixture";

describe("createClaudeNormalizer — assistant text (assembled golden)", () => {
  it("synthesizes turn.start, backfills turnId, and uses turn-scoped seq", () => {
    const evs = run(assistantMsg([{ type: "text", text: "hello", citations: null }]));
    expect(evs).toEqual([
      { type: "turn.start", seq: 0, turnId: TOP_TURN, threadId: "sess_fixture" },
      {
        type: "message.start",
        seq: 1,
        id: "msg_fixture_1",
        role: "assistant",
        turnId: TOP_TURN,
        threadId: "sess_fixture",
        model: "claude-test",
      },
      { type: "text.start", seq: 2, id: "msg_fixture_1:text:0", messageId: "msg_fixture_1", turnId: TOP_TURN },
      { type: "text.delta", seq: 3, id: "msg_fixture_1:text:0", messageId: "msg_fixture_1", delta: "hello", turnId: TOP_TURN },
      { type: "text.end", seq: 4, id: "msg_fixture_1:text:0", messageId: "msg_fixture_1", turnId: TOP_TURN },
      {
        type: "message.end",
        seq: 5,
        id: "msg_fixture_1",
        usage: { inputTokens: 0, outputTokens: 0, cumulative: true },
      },
    ]);
    assertAllValid(evs);
  });

  it("event types are in assembled order", () => {
    const evs = run(assistantMsg([{ type: "text", text: "hello", citations: null }]));
    expect(evs.map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.end",
    ]);
  });

  it("allocates a turn-scoped monotonic seq from 0", () => {
    const evs = run(assistantMsg([{ type: "text", text: "hello", citations: null }]));
    expect(evs.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("carries the assistant text through text.delta", () => {
    const evs = run(assistantMsg([{ type: "text", text: "hello world", citations: null }]));
    const delta = evs.find((e) => e.type === "text.delta");
    expect(delta).toMatchObject({ type: "text.delta", delta: "hello world" });
  });
});

describe("createClaudeNormalizer — result success", () => {
  it("maps a result success to turn.done with finishReason stop (NO synthesized turn.start)", () => {
    const evs = run(resultSuccess("end_turn"));
    expect(evs.map((e) => e.type)).toEqual(["turn.done"]);
    expect(evs[0]).toMatchObject({
      type: "turn.done",
      turnId: TOP_TURN,
      finishReason: "stop",
      outcome: { type: "success", result: "all done" },
    });
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — tool_use", () => {
  it("emits tool.start, tool.args.delta and the mandatory tool.args.assembled", () => {
    const evs = run(
      assistantMsg([
        { type: "tool_use", id: "toolu_fixture_1", name: "get_weather", input: { city: "SF" } },
      ]),
    );
    const types = evs.map((e) => e.type);
    expect(types).toContain("tool.start");
    expect(types).toContain("tool.args.delta");
    expect(types).toContain("tool.args.assembled");
    const start = evs.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ toolCallId: "toolu_fixture_1", name: "get_weather", turnId: TOP_TURN });
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "toolu_fixture_1", input: { city: "SF" } });
    assertAllValid(evs);
  });

  it("maps mcp_tool_use.server_name onto tool.start.serverName", () => {
    const evs = run(
      assistantMsg([
        {
          type: "mcp_tool_use",
          id: "toolu_mcp_1",
          name: "search",
          input: { q: "x" },
          server_name: "mcp.ggui.ai",
        },
      ]),
    );
    const start = evs.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ toolCallId: "toolu_mcp_1", name: "search", serverName: "mcp.ggui.ai" });
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — thinking", () => {
  it("emits reasoning.start/delta/end and a signed reasoning.opaque", () => {
    const evs = run(
      assistantMsg([{ type: "thinking", thinking: "let me think", signature: "sig_abc" }]),
    );
    const types = evs.map((e) => e.type);
    expect(types).toContain("reasoning.start");
    expect(types).toContain("reasoning.delta");
    expect(types).toContain("reasoning.end");
    const opaque = evs.find((e) => e.type === "reasoning.opaque");
    expect(opaque).toMatchObject({ kind: "signature", value: "sig_abc", provider: "anthropic" });
    assertAllValid(evs);
  });

  it("omits reasoning.opaque when the thinking block is unsigned", () => {
    const evs = run(
      assistantMsg([{ type: "thinking", thinking: "open thought", signature: "" }]),
    );
    expect(evs.map((e) => e.type)).not.toContain("reasoning.opaque");
    assertAllValid(evs);
  });

  it("emits reasoning.start/end + redacted opaque for redacted_thinking", () => {
    const evs = run(
      assistantMsg([{ type: "redacted_thinking", data: "enc_blob" }]),
    );
    const opaque = evs.find((e) => e.type === "reasoning.opaque");
    expect(opaque).toMatchObject({ kind: "redacted", value: "enc_blob", provider: "anthropic" });
    // No visible reasoning.delta for redacted thinking.
    expect(evs.map((e) => e.type)).not.toContain("reasoning.delta");
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — tool_result", () => {
  it("maps a user tool_result to tool.done with mcp content + outcome (NO turn.start)", () => {
    const evs = run(toolResultMsg());
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "tool.done",
      toolCallId: "toolu_fixture_1",
      outcome: "ok",
      content: [{ type: "text", text: "42" }],
    });
    // Orphan user-side tool.done has no owning message and no parent → no turnId.
    expect((evs[0] as { turnId?: string }).turnId).toBeUndefined();
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — nested subagent turn (assembled golden)", () => {
  it("seeds the nested turn via subagent.start so there is NO synthesized turn.start", () => {
    const evs = run(
      assistantMsg([{ type: "text", text: "sub", citations: null }], "toolu_parent_1"),
    );
    // The nested turnId is turn_<session> (turnIdFor uses the session id); the
    // subagent.start seeds it so openMessage does NOT synthesize a turn.start.
    expect(evs.map((e) => e.type)).toEqual([
      "subagent.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.end",
      "subagent.done",
    ]);
    const start = evs.find((e) => e.type === "subagent.start");
    expect(start).toMatchObject({ turnId: TOP_TURN, parentTurnId: "turn_toolu_parent_1" });
    const done = evs.find((e) => e.type === "subagent.done");
    expect(done).toMatchObject({ turnId: TOP_TURN, parentTurnId: "turn_toolu_parent_1" });
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — graceful guard", () => {
  it("emits exactly one ext.anthropic.unparsed for a non-SDKMessage input, no throw", () => {
    const n = createClaudeNormalizer();
    const evs = [...n.push("not-an-sdk-message"), ...n.flush()];
    expect(evs).toHaveLength(1);
    expect(evs[0]?.type).toBe("ext.anthropic.unparsed");
    // The raw payload is preserved losslessly under `native`.
    expect(evs[0]).toMatchObject({ native: "not-an-sdk-message" });
    assertAllValid(evs);
  });

  it("emits ext.anthropic.unparsed for a structurally-wrong object (type key does NOT clobber)", () => {
    const n = createClaudeNormalizer();
    const evs = [...n.push({ type: "assistant" }), ...n.flush()];
    expect(evs.map((e) => e.type)).toEqual(["ext.anthropic.unparsed"]);
    // The malformed object — which carries its own `type` — is nested under `native`.
    expect(evs[0]).toMatchObject({ native: { type: "assistant" } });
  });
});

describe("mapStopReason", () => {
  it("maps the Anthropic stop_reason superset to AgFinishReason", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("max_tokens")).toBe("token_limit");
    expect(mapStopReason("tool_use")).toBe("tool_call");
    expect(mapStopReason("stop_sequence")).toBe("stop");
    expect(mapStopReason("refusal")).toBe("refusal");
    expect(mapStopReason("pause_turn")).toBe("pause_turn");
    expect(mapStopReason("model_context_window_exceeded")).toBe("context_window_exceeded");
    expect(mapStopReason(null)).toBe("stop");
  });
});

// ─── Extended population tests ───────────────────────────────────────────────

describe("createClaudeNormalizer — result success with usage", () => {
  it("populates turn.done.usage from result success modelUsage", () => {
    const evs = run(resultSuccess("end_turn"));
    const done = evs.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({
      type: "turn.done",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        costUsd: 0.05,
        cumulative: true,
        byModel: { "claude-opus": { inputTokens: 100, outputTokens: 50 } },
      },
    });
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — result error", () => {
  it("maps error_max_turns to turn.error with retriable: false", () => {
    const evs = run(resultError("error_max_turns"));
    expect(evs.map((e) => e.type)).toEqual(["turn.error"]);
    expect(evs[0]).toMatchObject({
      type: "turn.error",
      code: "error_max_turns",
      retriable: false,
      message: "max turns reached",
    });
    assertAllValid(evs);
  });

  it("maps error_during_execution to turn.error with retriable: true", () => {
    const evs = run(resultError("error_during_execution"));
    expect(evs).toContainEqual(
      expect.objectContaining({
        type: "turn.error",
        code: "error_during_execution",
        retriable: true,
      }),
    );
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — refusal stop_reason", () => {
  it("adds safety to turn.done when stop_reason is refusal", () => {
    const evs = run(resultSuccess("refusal"));
    const done = evs.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({
      type: "turn.done",
      finishReason: "refusal",
      safety: [{ category: "refusal", blocked: true }],
    });
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — text citations", () => {
  it("emits a content.block with citations after text.end when citations are present", () => {
    const evs = run(
      assistantMsg([
        {
          type: "text",
          text: "Some text with citations.",
          citations: [
            {
              type: "web_search_result_location",
              url: "https://example.com",
              encrypted_index: "enc_abc",
              title: "Test Page",
              cited_text: "Some text",
            },
          ],
        },
      ]),
    );
    const contentBlock = evs.find(
      (e) => e.type === "content.block" && (e as { block: { type: string } }).block.type === "text",
    );
    expect(contentBlock).toMatchObject({
      type: "content.block",
      block: {
        type: "text",
        text: "Some text with citations.",
        citations: [
          {
            kind: "url",
            url: "https://example.com",
            encryptedIndex: "enc_abc",
            indexFrame: "response",
          },
        ],
      },
    });
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — permission_denials", () => {
  it("emits tool.start + tool.done denied for each permission denial", () => {
    const msg: SDKMessage = {
      type: "result",
      subtype: "success",
      result: "done",
      stop_reason: "end_turn",
      is_error: false,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
        inference_geo: "unknown",
        iterations: [],
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
        service_tier: "standard",
        speed: "standard",
      },
      modelUsage: {},
      permission_denials: [
        { tool_name: "bash", tool_use_id: "toolu_denied_1", tool_input: { command: "rm -rf" } },
      ],
      uuid: "00000000-0000-0000-0000-000000000002",
      session_id: "sess_fixture",
    };
    const evs = run(msg);
    // turn.done first, then the denial tool.start/tool.done pair.
    expect(evs.map((e) => e.type)).toEqual(["turn.done", "tool.start", "tool.done"]);
    const toolStart = evs.find((e) => e.type === "tool.start");
    expect(toolStart).toMatchObject({ type: "tool.start", name: "bash" });
    const toolDone = evs.find((e) => e.type === "tool.done");
    expect(toolDone).toMatchObject({
      type: "tool.done",
      toolCallId: "toolu_denied_1",
      outcome: "denied",
      content: [],
    });
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — message.end usage", () => {
  it("populates message.end.usage from BetaMessage.usage", () => {
    const nonZeroUsage: BetaMessage["usage"] = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      iterations: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    };
    const evs = run(
      assistantMsg([{ type: "text", text: "hi", citations: null }], null, {
        usage: nonZeroUsage,
      }),
    );
    const msgEnd = evs.find((e) => e.type === "message.end");
    expect(msgEnd).toMatchObject({
      type: "message.end",
      usage: { inputTokens: 10, outputTokens: 5, cumulative: true },
    });
    assertAllValid(evs);
  });
});

// ─── B1b: Extended population — providerExecuted, structured_output, parent_tool_use_id, server blocks ──

describe("createClaudeNormalizer — B1b: providerExecuted from caller", () => {
  it("sets providerExecuted: true for server_tool_use blocks", () => {
    const evs = run(
      assistantMsg([
        {
          type: "server_tool_use",
          id: "toolu_server_1",
          name: "web_search",
          input: { query: "test" },
        },
      ]),
    );
    const start = evs.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ providerExecuted: true });
    assertAllValid(evs);
  });

  it("does not set providerExecuted for regular tool_use with no caller", () => {
    const evs = run(
      assistantMsg([
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } },
      ]),
    );
    const start = evs.find((e) => e.type === "tool.start");
    expect(start).toBeDefined();
    const toolStart = evs.find(
      (e): e is Extract<AgEvent, { type: "tool.start" }> => e.type === "tool.start",
    );
    expect(toolStart?.providerExecuted).toBeUndefined();
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — B1b: structured_output", () => {
  it("uses structured_output as turn.done.outcome.result when present", () => {
    const msg: SDKMessage = {
      type: "result",
      subtype: "success",
      result: "string result",
      stop_reason: "end_turn",
      is_error: false,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
        inference_geo: "unknown",
        iterations: [],
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
        service_tier: "standard",
        speed: "standard",
      },
      modelUsage: {},
      permission_denials: [],
      structured_output: { answer: 42 },
      uuid: "00000000-0000-0000-0000-000000000002",
      session_id: "sess_fixture",
    };
    const evs = run(msg);
    const done = evs.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({
      type: "turn.done",
      outcome: { type: "success", result: { answer: 42 } },
    });
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — B1b: parent_tool_use_id on tool.done", () => {
  it("sets tool.done.turnId from parent_tool_use_id on user message", () => {
    const content: UserContent = [
      {
        type: "tool_result",
        tool_use_id: "toolu_fixture_1",
        content: [{ type: "text", text: "result" }],
        is_error: false,
      },
    ];
    const msg: SDKMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: "toolu_parent_subagent_1",
      uuid: "00000000-0000-0000-0000-000000000003",
      session_id: "sess_fixture",
    };
    const evs = run(msg);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "tool.done",
      toolCallId: "toolu_fixture_1",
      turnId: "turn_toolu_parent_subagent_1",
    });
    assertAllValid(evs);
  });
});

// ─── deferral c: assistant error → turn.error ────────────────────────────────

// Build the assistant arm directly (typed `SDKAssistant`, which IS assignable to
// `SDKMessage`) so the `error` field lands on the correct union member — no cast,
// no spread onto a union-typed base whose `user` arm lacks `error`.
function assistantMsgWithError(error: NonNullable<SDKAssistantError>): SDKAssistant {
  return {
    type: "assistant",
    message: betaMessage([]),
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-000000000001",
    session_id: "sess_fixture",
    error,
  };
}

describe("createClaudeNormalizer — deferral c: assistant error → turn.error", () => {
  it("emits turn.error with code and retriable:true for rate_limit", () => {
    const evs = run(assistantMsgWithError("rate_limit"));
    expect(evs).toContainEqual(
      expect.objectContaining({
        type: "turn.error",
        code: "rate_limit",
        retriable: true,
      }),
    );
    assertAllValid(evs);
  });

  it("emits turn.error with retriable:false for billing_error", () => {
    const evs = run(assistantMsgWithError("billing_error"));
    expect(evs).toContainEqual(
      expect.objectContaining({
        type: "turn.error",
        code: "billing_error",
        retriable: false,
      }),
    );
    assertAllValid(evs);
  });

  it("emits turn.error with retriable:true for server_error", () => {
    const evs = run(assistantMsgWithError("server_error"));
    expect(evs).toContainEqual(
      expect.objectContaining({
        type: "turn.error",
        code: "server_error",
        retriable: true,
      }),
    );
    assertAllValid(evs);
  });
});

describe("createClaudeNormalizer — B1b: server blocks semantic homes", () => {
  it("maps compaction block to content.block with type: compaction", () => {
    const evs = run(
      assistantMsg([
        {
          type: "compaction",
          content: "previous context summary",
          encrypted_content: null,
        },
      ]),
    );
    const cb = evs.find((e) => e.type === "content.block");
    expect(cb).toMatchObject({
      type: "content.block",
      block: { type: "compaction", text: "previous context summary", provider: "anthropic" },
    });
    assertAllValid(evs);
  });

  it("maps mcp_tool_result to tool.done (not provider-raw)", () => {
    const evs = run(
      assistantMsg([
        {
          type: "mcp_tool_result",
          tool_use_id: "toolu_mcp_done_1",
          is_error: false,
          content: "tool result text",
        },
      ]),
    );
    const toolDone = evs.find((e) => e.type === "tool.done");
    expect(toolDone).toMatchObject({
      type: "tool.done",
      toolCallId: "toolu_mcp_done_1",
      outcome: "ok",
      content: [{ type: "text", text: "tool result text" }],
    });
    const providerRaw = evs.find(
      (e) =>
        e.type === "content.block" &&
        (e as { block: { type: string } }).block.type === "provider-raw",
    );
    expect(providerRaw).toBeUndefined();
    assertAllValid(evs);
  });
});

// ─── Tenet-6 result-arm hardening ─────────────────────────────────────────────
// These tests verify that the error result arm never throws on malformed input,
// regardless of whether `errors`/`subtype` are well-formed.

describe("Tenet-6 result-arm hardening", () => {
  it("does not throw when an error result has a missing errors array", () => {
    const n = createClaudeNormalizer();
    // malformed error result: no `errors` field, subtype is an error variant.
    // Passed as a plain JSON object literal (valid JsonValue, no cast required).
    const evs = n.push({
      type: "result",
      subtype: "error_during_execution",
      session_id: "s1",
      uuid: "u1",
    });
    const err = evs.find((e) => e.type === "turn.error");
    expect(err).toBeDefined();
    expect(err).toMatchObject({ code: "error_during_execution" });
  });
});

// ─── Subagent inner-tool-result routing contract ──────────────────────────────
// Pins the existing routing: a user message with parent_tool_use_id set routes
// tool.done.turnId to turn_<parent_tool_use_id> (no implicit nesting inference).

describe("subagent inner-tool-result routing contract", () => {
  it("routes tool.done to the parent subagent turn when parent_tool_use_id is set", () => {
    const n = createClaudeNormalizer();
    // Plain JSON object literal — valid JsonValue, no cast required.
    const evs = n.push({
      type: "user",
      session_id: "s1",
      parent_tool_use_id: "toolu_parent",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_child", content: "ok", is_error: false },
        ],
      },
    });
    const done = evs.find((e) => e.type === "tool.done");
    expect(done).toBeDefined();
    expect(done).toMatchObject({ turnId: "turn_toolu_parent" });
  });
});
