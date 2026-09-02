import type { UUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type AgClosedEventType, AgEvent, JsonValue, Reducer } from "@silverprotocol/core";
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

// Narrow `AgEvent` to `AgClosedEventType` by ruling out the open `AgExtEvent`
// arm (whose `type` always matches `ext.<vendor>.<key>`): that arm's
// `.catchall(JsonValue)` index signature widens every field access on the union.
// Same guard `reduce()` uses internally — see `AgClosedEventType`'s doc in core.
function isClosedEvent(ev: AgEvent): ev is AgClosedEventType {
  return !ev.type.startsWith("ext.");
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
  // `run()` = push the ONE assistant message + flush, with no terminal `result`
  // message ever arriving — a genuinely truncated stream (the session never told
  // us how it ended). Per INV-FLUSH (audit M21) flush() truthfully closes the
  // still-open turn with `turn.abort{stream-truncated}`, never a silent no-op.
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
      { type: "turn.abort", seq: 6, turnId: TOP_TURN, reason: "stream-truncated" },
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
      "turn.abort",
    ]);
  });

  it("allocates a turn-scoped monotonic seq from 0", () => {
    const evs = run(assistantMsg([{ type: "text", text: "hello", citations: null }]));
    expect(evs.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("carries the assistant text through text.delta", () => {
    const evs = run(assistantMsg([{ type: "text", text: "hello world", citations: null }]));
    const delta = evs.find((e) => e.type === "text.delta");
    expect(delta).toMatchObject({ type: "text.delta", delta: "hello world" });
  });
});

describe("createClaudeNormalizer — INV-FLUSH truncation (audit M21)", () => {
  it("flush() aborts a dangling turn as stream-truncated when the terminal result message never arrives", () => {
    // The stream stops after an assistant message but the terminal `result`
    // message never lands (session cut off) — flush() must truthfully abort
    // the still-open turn, never fabricate a success turn.done.
    const n = createClaudeNormalizer();
    const pushed = n.push(JsonValue.parse(assistantMsg([{ type: "text", text: "hello", citations: null }])));
    const flushed = n.flush();
    const out = [...pushed, ...flushed];
    const msgEnd = out.findIndex((e) => e.type === "message.end");
    const abort = out.findIndex((e) => e.type === "turn.abort");
    expect(msgEnd).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(msgEnd);
    expect(out[abort]).toMatchObject({ type: "turn.abort", turnId: TOP_TURN, reason: "stream-truncated" });
    expect(out.some((e) => e.type === "turn.done")).toBe(false);
    assertAllValid(out);
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
      // SPEC §5 tool.done adoption (audit B10; Task 8b): the plain tool_result
      // path always carries a derived messageId so the reducer lands the result
      // in its own dedicated ToolMessage rather than the (possibly already
      // sealed) assistant message — see the messageId-adoption describe block
      // below for the full fold-level regression pin.
      messageId: "toolu_fixture_1:result",
    });
    // Orphan user-side tool.done has no owning message and no parent → no turnId.
    expect((evs[0] as { turnId?: string }).turnId).toBeUndefined();
    assertAllValid(evs);
  });
});

// ── tool.done.messageId adoption (SPEC §5; audit B10; Task 8b) ────────────────
// Regression pin for the Wave-1 park bug: the Claude SDK closes the assistant
// message (message.end) BEFORE the tool_result user message arrives. Pre-Wave-1
// this silently attached the result to the already-sealed assistant message
// (the exact leak M19 was built to close). Post-enforcement (pre-8b) the plain
// tool_result → tool.done call carried no messageId, so the reducer tried (and
// failed) to attach to the assistant message's already-cleared open pointer and
// PARKED the fold (needsResync=true) — everything after the first tool call in
// any claude tool conversation was lost. Nothing in the submodule suites folds
// a REAL claude tool conversation, so this was caught by guuey's blast-radius
// fold-identity capstone. The fix: the facet derives a stable
// `${toolCallId}:result` messageId, engaging the reducer's SPEC §5 adoption
// path (Task 5) — a DEDICATED role:"tool" message, not an attach to the
// assistant message.
describe("createClaudeNormalizer — tool.done.messageId adoption (audit B10 / guuey fold-identity capstone; Task 8b)", () => {
  it("standard tool round-trip (tool_use → message.end → tool_result) folds without park: the result lands in its own ToolMessage, not the sealed assistant message", () => {
    const n = createClaudeNormalizer();
    const toolCallId = "toolu_fixture_1"; // matches toolResultMsg()'s tool_use_id
    const toolUseEvs = n.push(
      JsonValue.parse(
        assistantMsg([{ type: "tool_use", id: toolCallId, name: "get_weather", input: { city: "SF" } }]),
      ),
    );
    const toolDoneEvs = n.push(JsonValue.parse(toolResultMsg()));
    const events = [...toolUseEvs, ...toolDoneEvs];
    assertAllValid(events);

    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);

    const result = r.result();
    const toolMsg = result.messages.find((m) => m.id === `${toolCallId}:result`);
    expect(toolMsg).toMatchObject({ role: "tool" });
    expect(
      toolMsg?.content.some((b) => b.type === "tool-result" && b.toolCallId === toolCallId),
    ).toBe(true);

    // The assistant message (sealed by message.end BEFORE the result arrived)
    // must NOT carry the tool-result block — it adopted its own message.
    const assistantResultMsg = result.messages.find((m) => m.id === "msg_fixture_1");
    expect(assistantResultMsg?.content.every((b) => b.type !== "tool-result")).toBe(true);
  });
});

// ─── guuey#26 — ONE message id ⇒ ONE message lifecycle ────────────────────────
// The Claude Agent SDK delivers ONE assistant message id across MULTIPLE
// `assistant` frames whenever that API message has several content blocks: a
// thinking block arrives as its own complete frame, then the tool_use block
// arrives as a SECOND complete frame carrying the SAME `message.id`. Emitting
// an open/seal pair per FRAME therefore re-opens an id the consumer has already
// sealed — exactly what INV-MSG forbids: `reduce()` refuses a sealed message as
// an attach target, sets `needsResync`, and the whole tail of the turn is
// discarded (guuey#26: a production capture parks at the first tool.start,
// seq 8 of 65 — the render tool result 40 events later never folds).
//
// The invariant these tests pin: within one normalizer lifetime, a message id
// that has been sealed with `message.end` is NEVER re-opened.
//
// This is not synthetic-only: `corpus/app-update-sonnet5/claude.native.json`
// (a live claude-sonnet-5 @0.3.217 capture) is a thinking-then-tool_use split
// on `msg_011CdMAmb6dKtbrbtGX4QPnE`, and the corpus-wide fold gate in
// `packages/e2e/src/replay.test.ts` pins the same invariant against it.
describe("createClaudeNormalizer — split-frame id coalesce (guuey#26)", () => {
  const SPLIT_ID = "msg_split_1";
  const SPLIT_TOOL_ID = "toolu_split_1";

  /** One frame of a MULTI-FRAME assistant message — every frame shares `SPLIT_ID`. */
  function splitFrame(
    content: BetaMessage["content"],
    uuid: UUID,
    usage?: BetaMessage["usage"],
  ): SDKMessage {
    return {
      type: "assistant",
      message: {
        ...betaMessage(content, usage !== undefined ? { usage } : undefined),
        id: SPLIT_ID,
      },
      parent_tool_use_id: null,
      uuid,
      session_id: "sess_fixture",
    };
  }

  const THINKING_FRAME = (): SDKMessage =>
    splitFrame(
      [{ type: "thinking", thinking: "let me check the todos", signature: "sig-abc" }],
      "00000000-0000-0000-0000-0000000000b1",
    );
  const TOOL_USE_FRAME = (): SDKMessage =>
    splitFrame(
      [{ type: "tool_use", id: SPLIT_TOOL_ID, name: "todo_list", input: { all: true } }],
      "00000000-0000-0000-0000-0000000000b2",
    );
  const SPLIT_TOOL_RESULT = (): SDKMessage => {
    const content: UserContent = [
      {
        type: "tool_result",
        tool_use_id: SPLIT_TOOL_ID,
        content: [{ type: "text", text: "buy milk" }],
        is_error: false,
      },
    ];
    return {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000b3",
      session_id: "sess_fixture",
    };
  };

  /**
   * Every message id that is re-opened AFTER having been sealed.
   *
   * Narrows off the open `ext.*` arm first — its `.catchall(JsonValue)` index
   * signature widens every field on the `AgEvent` union (see
   * `AgClosedEventType`'s doc in core).
   */
  function reopenedAfterSeal(evs: AgEvent[]): string[] {
    const sealed = new Set<string>();
    const reopened: string[] = [];
    for (const ev of evs) {
      if (!isClosedEvent(ev)) continue;
      if (ev.type === "message.end") sealed.add(ev.id);
      if (ev.type === "message.start" && sealed.has(ev.id)) reopened.push(ev.id);
    }
    return reopened;
  }

  it("never re-opens a sealed message id (the INV-MSG producer invariant)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(THINKING_FRAME())),
      ...n.push(JsonValue.parse(TOOL_USE_FRAME())),
      ...n.push(JsonValue.parse(SPLIT_TOOL_RESULT())),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(reopenedAfterSeal(evs)).toEqual([]);
  });

  it("emits exactly ONE message.start / ONE message.end for the split id", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(THINKING_FRAME())),
      ...n.push(JsonValue.parse(TOOL_USE_FRAME())),
      ...n.push(JsonValue.parse(SPLIT_TOOL_RESULT())),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.flush(),
    ];
    expect(evs.filter((e) => e.type === "message.start" && e.id === SPLIT_ID)).toHaveLength(1);
    expect(evs.filter((e) => e.type === "message.end" && e.id === SPLIT_ID)).toHaveLength(1);
  });

  it("seals the coalesced message BEFORE the tool_result it precedes (adoption ordering is unchanged)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(THINKING_FRAME())),
      ...n.push(JsonValue.parse(TOOL_USE_FRAME())),
      ...n.push(JsonValue.parse(SPLIT_TOOL_RESULT())),
      ...n.flush(),
    ];
    const types = evs.map((e) => e.type);
    expect(types.indexOf("message.end")).toBeLessThan(types.indexOf("tool.done"));
  });

  it("continues the content-block index across frames — two same-typed blocks never collide on one id", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(
        JsonValue.parse(
          splitFrame(
            [{ type: "text", text: "first", citations: null }],
            "00000000-0000-0000-0000-0000000000b4",
          ),
        ),
      ),
      ...n.push(
        JsonValue.parse(
          splitFrame(
            [{ type: "text", text: "second", citations: null }],
            "00000000-0000-0000-0000-0000000000b5",
          ),
        ),
      ),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const textStarts = evs.filter((e) => e.type === "text.start").map((e) => e.id);
    expect(textStarts).toEqual([`${SPLIT_ID}:text:0`, `${SPLIT_ID}:text:1`]);

    // …and the fold keeps BOTH texts on the one message (no clobber).
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const msg = r.result().messages.find((m) => m.id === SPLIT_ID);
    expect(msg?.content.filter((b) => b.type === "text")).toHaveLength(2);
  });

  it("fold: the thinking→tool_use split turn does NOT park, and the turn's tail survives", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(THINKING_FRAME())),
      ...n.push(JsonValue.parse(TOOL_USE_FRAME())),
      ...n.push(JsonValue.parse(SPLIT_TOOL_RESULT())),
      ...n.push(
        JsonValue.parse(
          splitFrameTail([{ type: "text", text: "you have 1 todo", citations: null }]),
        ),
      ),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.flush(),
    ];
    assertAllValid(evs);

    const r = new Reducer();
    for (const e of evs) r.push(e);
    // THE guuey#26 assertion: the fold never parks…
    expect(r.needsResync).toBe(false);
    const result = r.result();
    // …the reasoning AND the tool call live on the ONE coalesced message…
    const split = result.messages.find((m) => m.id === SPLIT_ID);
    expect(split?.content.some((b) => b.type === "reasoning")).toBe(true);
    expect(
      split?.content.some((b) => b.type === "tool-call" && b.toolCallId === SPLIT_TOOL_ID),
    ).toBe(true);
    // …the tool result adopts its own message…
    const toolMsg = result.messages.find((m) => m.id === `${SPLIT_TOOL_ID}:result`);
    expect(toolMsg?.content.some((b) => b.type === "tool-result")).toBe(true);
    // …and the TAIL of the turn (everything a parked fold would have thrown
    // away) is still there.
    const tail = result.messages.find((m) => m.id === "msg_split_tail");
    expect(tail?.content.some((b) => b.type === "text")).toBe(true);
  });

  it("message.end.usage carries the LAST frame's usage (the SDK repeats it cumulatively per frame)", () => {
    const lastUsage: BetaMessage["usage"] = {
      input_tokens: 11,
      output_tokens: 22,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      iterations: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    };
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(THINKING_FRAME())),
      ...n.push(
        JsonValue.parse(
          splitFrame(
            [{ type: "tool_use", id: SPLIT_TOOL_ID, name: "todo_list", input: { all: true } }],
            "00000000-0000-0000-0000-0000000000b6",
            lastUsage,
          ),
        ),
      ),
      ...n.push(JsonValue.parse(SPLIT_TOOL_RESULT())),
      ...n.flush(),
    ];
    const ends = evs.filter((e) => e.type === "message.end" && e.id === SPLIT_ID);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      usage: { inputTokens: 11, outputTokens: 22, cumulative: true },
    });
  });

  it("a same-id frame arriving AFTER the lifecycle closed rides a derived carrier id — the sealed id is never re-opened", () => {
    // Defensive path: a fold-binding frame (here a tool_result) lands BETWEEN
    // two frames of one message id, so the id is already sealed when the
    // continuation arrives. Re-opening it would park the fold; the blocks
    // instead ride a derived `:cont:<n>` carrier (the facet's established
    // derived-id convention — cf. `<turnId>:denials`, `<toolCallId>:result`).
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(THINKING_FRAME())),
      ...n.push(JsonValue.parse(SPLIT_TOOL_RESULT())),
      ...n.push(JsonValue.parse(TOOL_USE_FRAME())),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(reopenedAfterSeal(evs)).toEqual([]);
    expect(evs.some((e) => e.type === "message.start" && e.id === `${SPLIT_ID}:cont:1`)).toBe(true);

    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const carrier = r.result().messages.find((m) => m.id === `${SPLIT_ID}:cont:1`);
    expect(
      carrier?.content.some((b) => b.type === "tool-call" && b.toolCallId === SPLIT_TOOL_ID),
    ).toBe(true);
  });

  /** A LATER message in the same turn — a different id, i.e. the turn's tail. */
  function splitFrameTail(content: BetaMessage["content"]): SDKMessage {
    return {
      type: "assistant",
      message: { ...betaMessage(content), id: "msg_split_tail" },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000b7",
      session_id: "sess_fixture",
    };
  }
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

// ─── Task 8c leg 4: inner tool-results route to the SUBAGENT's real turn ──────
// Guuey capstone finding A: the wire-visible `subagent.start.parentTurnId`
// label (e.g. `turn_${TASK_TOOL_ID}`) is a synthetic cross-ref, never opened
// as a real turn. Before this fix, an INNER tool_result belonging to the
// subagent's own session (a `user` message whose `parent_tool_use_id` matches
// the spawning Task call) routed its `tool.done.turnId` to that synthetic
// label — which the reducer's adoption path then fabricated into a phantom
// turn (or, post leg 3, would park loudly). The facet now tracks
// `parent_tool_use_id → subagent turnId` (derived from `subagentStart`) so
// inner results route to the SUBAGENT's OWN turnId instead.
describe("createClaudeNormalizer — inner tool-result routes to the subagent turn (Task 8c leg 4)", () => {
  const TASK_TOOL_ID = "toolu_task";
  const INNER_TOOL_ID = "toolu_inner_search";
  const TOP_SESSION = "sess_top";
  const SUB_SESSION = "sess_sub";

  function topAssistantWithTaskCall(): SDKMessage {
    return {
      type: "assistant",
      // betaMessage() hardcodes id "msg_fixture_1" — give the top and sub
      // messages DISTINCT ids (as real Claude sessions do) so the sub
      // message's message.start does not collide with the top message's
      // already-#sealed id.
      message: { ...betaMessage([
        { type: "text", text: "Now delegating research.", citations: null },
        { type: "tool_use", id: TASK_TOOL_ID, name: "Task", input: { prompt: "research cats" } },
      ]), id: "msg_top_1" },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000a1",
      session_id: TOP_SESSION,
    };
  }

  function subAssistantWithInnerToolUse(): SDKMessage {
    return {
      type: "assistant",
      message: {
        ...betaMessage(
          [{ type: "tool_use", id: INNER_TOOL_ID, name: "search", input: { q: "cats" } }],
          { stop_reason: "tool_use" },
        ),
        id: "msg_sub_1",
      },
      parent_tool_use_id: TASK_TOOL_ID,
      uuid: "00000000-0000-0000-0000-0000000000a2",
      session_id: SUB_SESSION,
    };
  }

  function innerToolResult(): SDKMessage {
    const content: UserContent = [
      {
        type: "tool_result",
        tool_use_id: INNER_TOOL_ID,
        content: [{ type: "text", text: "cats are great" }],
        is_error: false,
      },
    ];
    return {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: TASK_TOOL_ID,
      uuid: "00000000-0000-0000-0000-0000000000a3",
      session_id: SUB_SESSION,
    };
  }

  it("routes the inner tool.done to the SUBAGENT's own turnId, not the synthetic parentTurnId label", () => {
    const n = createClaudeNormalizer();
    const topEvs = n.push(JsonValue.parse(topAssistantWithTaskCall()));
    const subEvs = n.push(JsonValue.parse(subAssistantWithInnerToolUse()));
    const innerResultEvs = n.push(JsonValue.parse(innerToolResult()));
    const events = [...topEvs, ...subEvs, ...innerResultEvs];
    assertAllValid(events);

    const innerDone = events.find(
      (e) => e.type === "tool.done" && (e as { toolCallId: string }).toolCallId === INNER_TOOL_ID,
    );
    expect(innerDone).toMatchObject({
      type: "tool.done",
      turnId: `turn_${SUB_SESSION}`, // NOT "turn_toolu_task"
      messageId: `${INNER_TOOL_ID}:result`,
    });

    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);
    const result = r.result();
    expect(result.turns.map((t) => t.turnId).sort()).toEqual(
      [`turn_${SUB_SESSION}`, `turn_${TOP_SESSION}`].sort(),
    );
    const subTurn = result.turns.find((t) => t.turnId === `turn_${SUB_SESSION}`);
    expect(subTurn?.threadId).toBe(TOP_SESSION); // root threadId, not the synthetic label
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

describe("createClaudeNormalizer — text citations (audit M22)", () => {
  it("attaches citations to text.end and emits NO supplement content.block", () => {
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
    // No id-less duplicate supplement block — citations ride text.end.
    expect(evs.find((e) => e.type === "content.block")).toBeUndefined();
    const textEnd = evs.find((e) => e.type === "text.end");
    expect(textEnd).toMatchObject({
      type: "text.end",
      citations: [
        {
          kind: "url",
          url: "https://example.com",
          encryptedIndex: "enc_abc",
          indexFrame: "response",
        },
      ],
    });
    assertAllValid(evs);
  });

  it("folds to exactly ONE text block, with citations attached (no duplicate-fold)", () => {
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
    const r = new Reducer();
    for (const ev of evs) r.push(ev);
    const blocks = r.result().messages[0]?.content ?? [];
    const textBlocks = blocks.filter((b) => b.type === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toMatchObject({
      type: "text",
      text: "Some text with citations.",
      citations: [{ kind: "url", url: "https://example.com" }],
    });
  });
});

// Shared fixture: a successful result carrying one permission denial (the
// assistant's tool call for "bash" was blocked by the permission system).
function resultWithDenial(): SDKMessage {
  return {
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
}

describe("createClaudeNormalizer — permission_denials", () => {
  it("emits tool.start + tool.done denied for each permission denial, inside a carrier message BEFORE turn close (audit M19)", () => {
    const evs = run(resultWithDenial());
    // The denial carrier message opens+closes BEFORE turn.done: INV-MSG (audit
    // M19) forbids attaching a tool.start/tool.done pair to the already-sealed
    // assistant message or to a closed turn, so the denials get their own
    // message, opened while the turn is still open.
    expect(evs.map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "tool.start",
      "tool.done",
      "message.end",
      "turn.done",
    ]);
    const msgStart = evs.find((e) => e.type === "message.start");
    expect(msgStart).toMatchObject({ type: "message.start", id: "turn_sess_fixture:denials" });
    const msgEnd = evs.find((e) => e.type === "message.end");
    expect(msgEnd).toMatchObject({ type: "message.end", id: "turn_sess_fixture:denials" });
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

  it("permission denials fold into a dedicated carrier message, before turn close (audit M19)", () => {
    const events = run(resultWithDenial());
    // Local narrowing casts: `id` is not common to every `AgEvent` union arm
    // (the `AgExtEvent.catchall(JsonValue)` template-literal `type` widens the
    // union past what `e.type === "..."` alone narrows away — same structural
    // reason documented for the analogous `providerMetadata` reads elsewhere
    // in this test suite), so `Extract` pins the exact, already-checked arm.
    const denialStart = events.findIndex((e) => {
      if (e.type !== "message.start") return false;
      return (e as Extract<AgEvent, { type: "message.start" }>).id.endsWith(":denials");
    });
    const turnDone = events.findIndex((e) => e.type === "turn.done");
    expect(denialStart).toBeGreaterThan(-1);
    expect(
      events.some((e) => {
        if (e.type !== "message.end") return false;
        return (e as Extract<AgEvent, { type: "message.end" }>).id.endsWith(":denials");
      }),
    ).toBe(true);
    expect(denialStart).toBeLessThan(turnDone); // denials precede turn close

    // End-to-end: the fold must NOT park.
    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);
    const carrier = r.result().messages.find((m) => m.id.endsWith(":denials"));
    expect(
      carrier?.content.some((b) => b.type === "tool-result" && b.outcome === "denied"),
    ).toBe(true);
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
      // SPEC §5 tool.done adoption (audit B10; Task 8b): the derived messageId
      // is independent of turnId routing — the subagent-routed result still
      // adopts its own dedicated ToolMessage rather than attaching in-place.
      messageId: "toolu_fixture_1:result",
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

  // Finding #2 (minor, playbook 2026-07-03 SDK-bump adaptation, claude-agent-sdk
  // 0.2.141 → 0.3.199): `SDKAssistantMessageError` gained `overloaded` and
  // `model_not_found`.
  it("emits turn.error with retriable:true for overloaded", () => {
    const evs = run(assistantMsgWithError("overloaded"));
    expect(evs).toContainEqual(
      expect.objectContaining({
        type: "turn.error",
        code: "overloaded",
        retriable: true,
      }),
    );
    assertAllValid(evs);
  });

  it("emits turn.error with retriable:false for model_not_found (permanent misconfiguration, not transient)", () => {
    const evs = run(assistantMsgWithError("model_not_found"));
    expect(evs).toContainEqual(
      expect.objectContaining({
        type: "turn.error",
        code: "model_not_found",
        retriable: false,
      }),
    );
    assertAllValid(evs);
  });

  // 0.3.258: `SDKAssistantMessageError` gained `account_on_hold` — a billing-
  // class hold on the account (first cousin of `billing_error`): cleared by
  // the account holder, never by re-sending the turn → deliberately NOT
  // retriable (explicit false-by-omission, like model_not_found above).
  it("emits turn.error with retriable:false for account_on_hold (billing-class hold, not transient)", () => {
    const evs = run(assistantMsgWithError("account_on_hold"));
    expect(evs).toContainEqual(
      expect.objectContaining({
        type: "turn.error",
        code: "account_on_hold",
        retriable: false,
      }),
    );
    assertAllValid(evs);
  });
});

// ─── Finding #1 (critical): refusal-fallback retraction protocol ─────────────
// playbook 2026-07-03 SDK-bump adaptation (claude-agent-sdk 0.2.141 → 0.3.199).
// New wire: SDKAssistantMessage.supersedes? + the system message
// SDKModelRefusalFallbackMessage{retracted_message_uuids} — the SDK retried a
// refused turn on a fallback model and instructs eviction of the refused leg.
// LOCKED MAPPING: message.remove per retracted uuid, translated through the
// facet's own uuid(msg.uuid)→messageId(m.id / `${tool_use_id}:result`)
// convention — a DIFFERENT id space (SPEC §8 item 19).
describe("createClaudeNormalizer — refusal-fallback retraction (playbook 2026-07-03)", () => {
  const REFUSED_UUID = "00000000-0000-0000-0000-0000000000f1";
  const FALLBACK_UUID = "00000000-0000-0000-0000-0000000000f2";
  const NOTICE_UUID = "00000000-0000-0000-0000-0000000000f3";

  function refusedAssistant(): SDKMessage {
    return {
      type: "assistant",
      message: {
        ...betaMessage([{ type: "text", text: "I can't help with that.", citations: null }], {
          stop_reason: "refusal",
        }),
        id: "msg_refused",
      },
      parent_tool_use_id: null,
      uuid: REFUSED_UUID,
      session_id: "sess_fixture",
    };
  }

  function fallbackAssistant(supersedes: UUID[]): SDKMessage {
    return {
      type: "assistant",
      message: { ...betaMessage([{ type: "text", text: "Sure — here is the answer.", citations: null }]), id: "msg_fallback" },
      parent_tool_use_id: null,
      uuid: FALLBACK_UUID,
      session_id: "sess_fixture",
      supersedes,
    };
  }

  function refusalFallbackNotice(retracted: string[]): SDKMessage {
    return {
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      original_model: "claude-a",
      fallback_model: "claude-b",
      request_id: null,
      retracted_message_uuids: retracted,
      content: "Switched to a fallback model.",
      uuid: NOTICE_UUID,
      session_id: "sess_fixture",
    };
  }

  it("carries the raw uuid list as providerMetadata on the fallback message's first block", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(refusedAssistant())),
      ...n.push(JsonValue.parse(fallbackAssistant([REFUSED_UUID]))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const fallbackTextStart = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_fallback",
    );
    expect(fallbackTextStart).toMatchObject({ providerMetadata: { supersedes: [REFUSED_UUID] } });
  });

  it("supersedes evicts the refused leg via message.remove 'on arrival'", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(refusedAssistant())),
      ...n.push(JsonValue.parse(fallbackAssistant([REFUSED_UUID]))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(evs).toContainEqual(expect.objectContaining({ type: "message.remove", id: "msg_refused" }));
  });

  it("the end-of-turn model_refusal_fallback notice re-evicts idempotently (no error, no fold hazard)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(refusedAssistant())),
      ...n.push(JsonValue.parse(fallbackAssistant([REFUSED_UUID]))),
      ...n.push(JsonValue.parse(refusalFallbackNotice([REFUSED_UUID]))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const removes = evs.filter((e) => e.type === "message.remove");
    // Once from `supersedes` (on arrival), once from the notice (idempotent) —
    // both target the SAME id; reduce()'s #removeMessage no-ops the repeat.
    expect(removes).toHaveLength(2);
    for (const r of removes) expect(r).toMatchObject({ id: "msg_refused" });
  });

  it("retraction targeting an unknown uuid is a graceful no-op (Tenet 6 — never fabricates a remove)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(fallbackAssistant(["00000000-0000-0000-0000-00000000dead"]))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(evs.some((e) => e.type === "message.remove")).toBe(false);
  });

  it("also evicts a tombstoned tool_result frame named in the retraction (not only assistant frames)", () => {
    const n = createClaudeNormalizer();
    const refusedToolResult = toolResultMsg(); // uuid "…0003", produces "toolu_fixture_1:result"
    const evs = [
      ...n.push(JsonValue.parse(refusedToolResult)),
      ...n.push(JsonValue.parse(fallbackAssistant(["00000000-0000-0000-0000-000000000003"]))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(evs).toContainEqual(
      expect.objectContaining({ type: "message.remove", id: "toolu_fixture_1:result" }),
    );
  });

  it("fold: the refused leg is GONE, the fallback leg is present, no resync (money-path safe)", () => {
    const n = createClaudeNormalizer();
    const events = [
      ...n.push(JsonValue.parse(refusedAssistant())),
      ...n.push(JsonValue.parse(fallbackAssistant([REFUSED_UUID]))),
      ...n.push(JsonValue.parse(refusalFallbackNotice([REFUSED_UUID]))),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.flush(),
    ];
    assertAllValid(events);
    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);
    const result = r.result();
    expect(result.messages.find((m) => m.id === "msg_refused")).toBeUndefined();
    const fallbackMsg = result.messages.find((m) => m.id === "msg_fallback");
    expect(fallbackMsg).toBeDefined();
    expect(
      fallbackMsg?.content.some((b) => b.type === "text" && b.text.includes("Sure")),
    ).toBe(true);
  });

  it("usage stays verbatim cumulative — the facet does not invent usage subtraction for the refused leg", () => {
    // The turn's cumulative usage (mapTurnUsage/mapMessageUsage) is untouched by
    // this adaptation: the SDK's own result.usage/modelUsage already accounts for
    // whatever billing the refusal-fallback retry accrued server-side (playbook
    // brief's usage caution). Assert the existing verbatim/cumulative contract
    // still holds unchanged in a retraction turn.
    const n = createClaudeNormalizer();
    const events = [
      ...n.push(JsonValue.parse(refusedAssistant())),
      ...n.push(JsonValue.parse(fallbackAssistant([REFUSED_UUID]))),
      ...n.push(JsonValue.parse(refusalFallbackNotice([REFUSED_UUID]))),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.flush(),
    ];
    const turnDone = events.find((e) => e.type === "turn.done");
    expect(turnDone).toMatchObject({ usage: { cumulative: true } });
  });
});

// ─── SDKInformationalMessage — first-class `notice` message (spec draft.2) ────
// The fixture-drift ratchet's FLAGSHIP finding (2026-07-03) established this
// frame is genuinely conversation/UX-relevant, and draft.1 parked it in the
// `ext.anthropic.informational` lossless carry pending "a first-class notice
// core event" (old SPEC §10 item 21). draft.2 resolved that deferral
// (typescript-sdk#16): the frame now becomes a persisted `role:"notice"`
// message (`noticeSource:"framework"`) with content on a text block and the
// wrapper siblings (`level`/`preventContinuation`/`toolUseId`) riding that
// block's providerMetadata. The ext carry is RETIRED (superseded, not layered
// — one carrier per concept, §0.6); `tool_use_id`, which the old route
// dropped, is now carried.
describe("createClaudeNormalizer — SDKInformationalMessage → notice message (spec draft.2)", () => {
  function informationalMsg(overrides?: {
    level?: "info" | "notice" | "suggestion" | "warning";
    prevent_continuation?: boolean;
    tool_use_id?: string;
  }): SDKMessage {
    return {
      type: "system",
      subtype: "informational",
      content: "Context window is getting full — consider /compact.",
      level: overrides?.level ?? "notice",
      uuid: "00000000-0000-0000-0000-0000000000f4",
      session_id: "sess_fixture",
      ...(overrides?.prevent_continuation !== undefined
        ? { prevent_continuation: overrides.prevent_continuation }
        : {}),
      ...(overrides?.tool_use_id !== undefined ? { tool_use_id: overrides.tool_use_id } : {}),
    };
  }

  it("emits a full notice message: role notice, noticeSource framework, content verbatim on a text block, level on its providerMetadata", () => {
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(informationalMsg())), ...n.flush()];
    assertAllValid(evs);
    const start = evs.find((e) => e.type === "message.start");
    expect(start).toMatchObject({
      id: "00000000-0000-0000-0000-0000000000f4",
      role: "notice",
      noticeSource: "framework",
    });
    const block = evs.find((e) => e.type === "content.block");
    expect(block).toMatchObject({
      block: {
        type: "text",
        text: "Context window is getting full — consider /compact.",
        providerMetadata: { level: "notice" },
      },
    });
    expect(evs.some((e) => e.type === "message.end")).toBe(true);
  });

  it("carries prevent_continuation and tool_use_id (camelCased) when present — tool_use_id is NEW vs the retired ext route", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(
        JsonValue.parse(
          informationalMsg({ level: "warning", prevent_continuation: true, tool_use_id: "toolu_notice_1" }),
        ),
      ),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const block = evs.find((e) => e.type === "content.block");
    expect(block).toMatchObject({
      block: {
        providerMetadata: { level: "warning", preventContinuation: true, toolUseId: "toolu_notice_1" },
      },
    });
  });

  it("omits absent wrapper siblings (no fabricated fields)", () => {
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(informationalMsg())), ...n.flush()];
    const block = evs.find((e) => e.type === "content.block") as {
      block?: { providerMetadata?: { preventContinuation?: unknown; toolUseId?: unknown } };
    };
    expect(block.block?.providerMetadata?.preventContinuation).toBeUndefined();
    expect(block.block?.providerMetadata?.toolUseId).toBeUndefined();
  });

  it("the ext.anthropic.informational carry is RETIRED — never emitted alongside the notice (one carrier per concept)", () => {
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(informationalMsg())), ...n.flush()];
    expect(evs.length).toBeGreaterThan(0); // regression pin: never a silent drop either
    expect(evs.some((e) => e.type === "ext.anthropic.informational")).toBe(false);
  });

  it("fold: the notice persists as an AgMessage {role: notice, noticeSource: framework} in the reduce result", () => {
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(informationalMsg())), ...n.flush()];
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const notice = r.result().messages.find((m) => m.role === "notice");
    expect(notice).toMatchObject({
      id: "00000000-0000-0000-0000-0000000000f4",
      noticeSource: "framework",
      content: [{ type: "text", text: "Context window is getting full — consider /compact." }],
    });
  });

  it("fold: an informational notice sandwiched inside a real turn folds clean through Reducer — needsResync===false, notice row alongside the assistant row", () => {
    const n = createClaudeNormalizer();
    const events = [
      ...n.push(JsonValue.parse(assistantMsg([{ type: "text", text: "hello", citations: null }]))),
      ...n.push(JsonValue.parse(informationalMsg())),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.flush(),
    ];
    assertAllValid(events);
    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);
    const roles = r.result().messages.map((m) => m.role);
    expect(roles).toContain("assistant");
    expect(roles).toContain("notice");
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

// ── tool_result.structuredContent surfacing (A1 §9) ──────────────────────────
// Pins that the Claude normalizer extracts structuredContent from the native
// tool_result block and threads it onto tool.done (producer side).
// The block shape is runtime-extended by the Claude Agent SDK beyond what the
// Anthropic SDK's static ToolResultBlockParam declares; the fixture is a plain
// JsonValue literal (push's parameter type) so it needs no cast.

describe("tool_result.structuredContent surfacing", () => {
  it("surfaces tool_result.structuredContent onto tool.done", () => {
    const n = createClaudeNormalizer();
    const evs = n.push({
      type: "user",
      session_id: "s1",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            is_error: false,
            content: "rendered",
            structuredContent: { cache: { hit: true } },
          },
        ],
      },
    });
    const done = evs.find((e) => e.type === "tool.done");
    expect(done).toMatchObject({
      type: "tool.done",
      toolCallId: "toolu_1",
      structuredContent: { cache: { hit: true } },
    });
  });
});

describe("createClaudeNormalizer — text block with citations omitted (real SDK wire shape)", () => {
  // The @anthropic-ai/sdk type declares `citations: Array | null` (required), but
  // the runtime OMITS it on a plain text block. push() takes the JsonValue boundary,
  // so we feed the genuine omitted shape — no cast.
  const native: JsonValue = {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-000000000001",
    session_id: "sess_fixture",
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello" }], // ← no `citations` key
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
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
      },
    },
  };

  it("does not throw and emits text events with no contentBlock", () => {
    const n = createClaudeNormalizer();
    const evs = [...n.push(native), ...n.flush()];
    const types = evs.map((e) => e.type);
    expect(types).toContain("text.start");
    expect(types).toContain("text.delta");
    expect(types).toContain("text.end");
    expect(types).not.toContain("content.block"); // no citations → no contentBlock
  });
});

// ── tool_use_result sibling mapping (audit B7) ────────────────────────────────
// The Claude Agent SDK attaches a message-level `tool_use_result` sibling to the
// user message carrying the tool_result block(s) — the SDK's own rich MCP result
// (structuredContent incl. render-cache markers, plus `_meta.ui` for MCP Apps),
// distinct from whatever the block itself carries. §2.1 routes it: `_meta.ui`
// present ⇒ uiData (surface data, model-hidden); else ⇒ structuredContent
// (model-facing). The sibling's `_meta` rides verbatim on the event's `_meta`.
// Multi-result messages are ambiguous (the sibling is message-level, not
// per-block) and are skipped rather than misattributed.
describe("tool_use_result sibling mapping (audit B7)", () => {
  const oneToolResult: JsonValue[] = [
    { type: "tool_result", tool_use_id: "c1", content: [] },
  ];
  const twoToolResults: JsonValue[] = [
    { type: "tool_result", tool_use_id: "c1", content: [] },
    { type: "tool_result", tool_use_id: "c2", content: [] },
  ];
  const userMsgWith = (
    sibling: Record<string, JsonValue>,
    content: JsonValue[] = oneToolResult,
  ): JsonValue => ({
    type: "user",
    session_id: "s1",
    parent_tool_use_id: null,
    message: { role: "user", content },
    tool_use_result: sibling,
  });

  it("routes sibling structuredContent to uiData when _meta.ui is present (MCP-Apps)", () => {
    const n = createClaudeNormalizer();
    const evs = n.push(
      userMsgWith({
        structuredContent: { cache: { hit: true, kind: "warm", llmCallsAvoided: 2 } },
        _meta: { ui: { resourceUri: "ui://x", visibility: ["model"] } },
      }),
    );
    const done = evs.find((e) => e.type === "tool.done");
    expect(done?.type === "tool.done" && done.uiData).toEqual({
      cache: { hit: true, kind: "warm", llmCallsAvoided: 2 },
    });
    expect(done?.type === "tool.done" && done._meta).toEqual({
      ui: { resourceUri: "ui://x", visibility: ["model"] },
    });
  });

  it("routes sibling structuredContent to structuredContent when no _meta.ui (base MCP)", () => {
    const n = createClaudeNormalizer();
    const evs = n.push(userMsgWith({ structuredContent: { answer: 42 } }));
    const done = evs.find((e) => e.type === "tool.done");
    expect(done?.type === "tool.done" && done.structuredContent).toEqual({ answer: 42 });
  });

  it("skips the sibling when the message carries more than one tool_result (ambiguous)", () => {
    const msg = userMsgWith({ structuredContent: { x: 1 } }, twoToolResults);
    const n = createClaudeNormalizer();
    const dones = n.push(msg).filter((e) => e.type === "tool.done");
    expect(dones).toHaveLength(2);
    for (const d of dones) expect(d.type === "tool.done" && d.uiData).toBeUndefined();
  });

  // ── 0.3.257 sibling: `resourceLinks` — the MCP result's resource_link blocks
  // (files returned by reference), collected by the CLI beside
  // structuredContent/_meta. Content stays model-faithful; the links ride the
  // adopted tool.done's providerMetadata, key verbatim. ──
  const RESOURCE_LINKS: JsonValue[] = [
    {
      uri: "file:///tmp/report.pdf",
      name: "report.pdf",
      title: "Quarterly report",
      description: "Rendered from the spreadsheet",
      mimeType: "application/pdf",
      size: 48213,
    },
    { uri: "file:///tmp/notes.md", name: "notes.md" },
  ];

  it("carries the sibling's resourceLinks (0.3.257) verbatim as providerMetadata on the adopted tool.done — content stays model-faithful", () => {
    const n = createClaudeNormalizer();
    const evs = n.push(userMsgWith({ structuredContent: { answer: 42 }, resourceLinks: RESOURCE_LINKS }));
    assertAllValid(evs);
    const done = evs.find((e) => e.type === "tool.done");
    expect(done?.type === "tool.done" && done.providerMetadata).toEqual({ resourceLinks: RESOURCE_LINKS });
    // The block's own content (the text the model read) is untouched, and the
    // sibling's other fields still route as before.
    expect(done?.type === "tool.done" && done.content).toEqual([]);
    expect(done?.type === "tool.done" && done.structuredContent).toEqual({ answer: 42 });
  });

  it("skips resourceLinks on a multi-result message (the sibling's single-result attribution rule)", () => {
    const n = createClaudeNormalizer();
    const dones = n
      .push(userMsgWith({ resourceLinks: RESOURCE_LINKS }, twoToolResults))
      .filter((e) => e.type === "tool.done");
    expect(dones).toHaveLength(2);
    for (const d of dones) expect(d.type === "tool.done" && d.providerMetadata).toBeUndefined();
  });

  it("emits NO providerMetadata when the sibling carries no resourceLinks (negative control — pre-0.3.257 output unchanged)", () => {
    const n = createClaudeNormalizer();
    const evs = n.push(userMsgWith({ structuredContent: { answer: 42 } }));
    const done = evs.find((e) => e.type === "tool.done");
    expect(done?.type === "tool.done" && done.providerMetadata).toBeUndefined();
    // A non-array `resourceLinks` (malformed) is likewise ignored, never thrown on.
    const malformed = createClaudeNormalizer().push(userMsgWith({ resourceLinks: "nope" }));
    const doneM = malformed.find((e) => e.type === "tool.done");
    expect(doneM?.type === "tool.done" && doneM.providerMetadata).toBeUndefined();
  });
});

// ─── fixture-drift ratchet — the 16 remaining `silently-dropped` claude arms
// (2026-07-03 follow-up to the SDKInformationalMessage flagship fix above) ────
// Per-arm decision procedure (see `.superpowers/sdd/claude-arms-disposition-report.md`
// for the full table + wire-shape citations):
//  1. SDKPermissionDeniedMessage -> HANDLED: routed into the existing W1
//     `<turnId>:denials` carrier (audit M19) as enrichment, not a duplicate pair.
//  2. The other 15 -> uniform lossless carry `ext.anthropic.frame{kind, frame}`
//     (SPEC §8 item 22 / §12) — including the Task* subagent-progress family
//     and SDKModelRefusalNoFallbackMessage, both STUDIED against an
//     existing-home mapping and rejected (see index.ts's `anthropicFrameKind`
//     doc comment for the full reasoning: tool_use_id is OPTIONAL on every
//     Task* arm, so the family is a broader "tasks panel" superset, not 1:1
//     with Task-tool subagent adoption; forcing the mapping risks the M22
//     double-fold hazard).

// Every fixture below includes a representative slice of the arm's OPTIONAL
// fields (not just the required minimum) so the "byte-preserved frame" assertion
// actually exercises verbatim carry rather than an accidentally-minimal shape.

function modelRefusalNoFallbackMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "model_refusal_no_fallback",
    original_model: "claude-opus-test",
    request_id: "req_123",
    api_refusal_category: "content_policy",
    api_refusal_explanation: "The request violates usage policy.",
    refused_user_message_uuid: "00000000-0000-0000-0000-0000000000a1",
    content: "I can't help with that request.",
    uuid: "00000000-0000-0000-0000-0000000000a2",
    session_id: "sess_fixture",
  };
}

function localCommandOutputMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "local_command_output",
    content: "Compacted 12 messages, saved 4200 tokens.",
    uuid: "00000000-0000-0000-0000-0000000000b1",
    session_id: "sess_fixture",
  };
}

function thinkingTokensMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "thinking_tokens",
    estimated_tokens: 197,
    estimated_tokens_delta: 147,
    uuid: "00000000-0000-0000-0000-0000000000c9",
    session_id: "sess_fixture",
  };
}

function hookProgressMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "hook_progress",
    hook_id: "hook_1",
    hook_name: "lint-on-save",
    hook_event: "PostToolUse",
    stdout: "Running eslint...\n",
    stderr: "",
    output: "Running eslint...\n",
    uuid: "00000000-0000-0000-0000-0000000000c1",
    session_id: "sess_fixture",
  };
}

function hookResponseMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "hook_response",
    hook_id: "hook_1",
    hook_name: "lint-on-save",
    hook_event: "PostToolUse",
    output: "0 problems",
    stdout: "0 problems",
    stderr: "",
    exit_code: 0,
    outcome: "success",
    uuid: "00000000-0000-0000-0000-0000000000c2",
    session_id: "sess_fixture",
  };
}

function authStatusMsg(): SDKMessage {
  return {
    type: "auth_status",
    isAuthenticating: true,
    output: ["Visit https://example.com/authorize to continue."],
    uuid: "00000000-0000-0000-0000-0000000000d1",
    session_id: "sess_fixture",
  };
}

function taskNotificationMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "task_1",
    tool_use_id: "toolu_task_1",
    status: "completed",
    output_file: "/tmp/task_1_output.md",
    summary: "Investigated the failing test and found the root cause.",
    uuid: "00000000-0000-0000-0000-0000000000e1",
    session_id: "sess_fixture",
  };
}

function taskStartedMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: "task_1",
    tool_use_id: "toolu_task_1",
    description: "Research the flaky test failure.",
    subagent_type: "general-purpose",
    uuid: "00000000-0000-0000-0000-0000000000e2",
    session_id: "sess_fixture",
  };
}

function taskUpdatedMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "task_updated",
    task_id: "task_1",
    patch: { status: "running", description: "Still investigating." },
    uuid: "00000000-0000-0000-0000-0000000000e3",
    session_id: "sess_fixture",
  };
}

function taskProgressMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "task_progress",
    task_id: "task_1",
    tool_use_id: "toolu_task_1",
    description: "Investigating the flaky test.",
    usage: { total_tokens: 500, tool_uses: 2, duration_ms: 1200 },
    last_tool_name: "Bash",
    summary: "Ran the test suite twice to confirm flakiness.",
    uuid: "00000000-0000-0000-0000-0000000000e4",
    session_id: "sess_fixture",
  };
}

function conversationResetMsg(): SDKMessage {
  return {
    type: "conversation_reset",
    new_conversation_id: "00000000-0000-0000-0000-0000000000c1",
    uuid: "00000000-0000-0000-0000-0000000000c2",
    session_id: "sess_fixture",
  };
}

function backgroundTasksChangedMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [
      { task_id: "task_1", task_type: "subagent", description: "Research the flaky test failure." },
      { task_id: "task_2", task_type: "local_workflow", description: "Run the nightly audit workflow." },
    ],
    uuid: "00000000-0000-0000-0000-0000000000e5",
    session_id: "sess_fixture",
  };
}

function notificationMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "notification",
    key: "long_running_tool",
    text: "This tool call is taking longer than usual.",
    priority: "medium",
    uuid: "00000000-0000-0000-0000-0000000000f1",
    session_id: "sess_fixture",
  };
}

function filesPersistedMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "files_persisted",
    files: [{ filename: "report.pdf", file_id: "file_1" }],
    failed: [{ filename: "chart.png", error: "upload timed out" }],
    processed_at: "2026-07-03T00:00:00Z",
    uuid: "00000000-0000-0000-0000-0000000000f2",
    session_id: "sess_fixture",
  };
}

function toolUseSummaryMsg(): SDKMessage {
  return {
    type: "tool_use_summary",
    summary: "Read 3 files and ran 1 test suite.",
    preceding_tool_use_ids: ["toolu_1", "toolu_2", "toolu_3"],
    uuid: "00000000-0000-0000-0000-0000000000f3",
    session_id: "sess_fixture",
  };
}

function memoryRecallMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "memory_recall",
    mode: "select",
    memories: [
      { path: "/home/user/.claude/memory/project.md", scope: "personal", content: "Prefers tabs over spaces." },
    ],
    uuid: "00000000-0000-0000-0000-0000000000f5",
    session_id: "sess_fixture",
  };
}

function promptSuggestionMsg(): SDKMessage {
  return {
    type: "prompt_suggestion",
    suggestion: "Would you like me to also update the changelog?",
    uuid: "00000000-0000-0000-0000-0000000000f6",
    session_id: "sess_fixture",
  };
}

function mirrorErrorMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "mirror_error",
    error: "Failed to sync session to cloud mirror: connection reset.",
    key: { projectKey: "proj_1", sessionId: "sess_fixture" },
    uuid: "00000000-0000-0000-0000-0000000000f7",
    session_id: "sess_fixture",
  };
}

const CARRIED_ARMS: ReadonlyArray<{ armName: string; kind: string; msg: SDKMessage }> = [
  { armName: "SDKModelRefusalNoFallbackMessage", kind: "model_refusal_no_fallback", msg: modelRefusalNoFallbackMsg() },
  { armName: "SDKLocalCommandOutputMessage", kind: "local_command_output", msg: localCommandOutputMsg() },
  { armName: "SDKHookProgressMessage", kind: "hook_progress", msg: hookProgressMsg() },
  // cohort 0.5.4 (corpus/partials-fable51): the thinking-progress ping — see
  // CARRIED_SYSTEM_SUBTYPES for why it left router-plane.
  { armName: "SDKThinkingTokensMessage", kind: "thinking_tokens", msg: thinkingTokensMsg() },
  { armName: "SDKHookResponseMessage", kind: "hook_response", msg: hookResponseMsg() },
  { armName: "SDKAuthStatusMessage", kind: "auth_status", msg: authStatusMsg() },
  { armName: "SDKTaskNotificationMessage", kind: "task_notification", msg: taskNotificationMsg() },
  { armName: "SDKTaskStartedMessage", kind: "task_started", msg: taskStartedMsg() },
  { armName: "SDKTaskUpdatedMessage", kind: "task_updated", msg: taskUpdatedMsg() },
  { armName: "SDKTaskProgressMessage", kind: "task_progress", msg: taskProgressMsg() },
  { armName: "SDKBackgroundTasksChangedMessage", kind: "background_tasks_changed", msg: backgroundTasksChangedMsg() },
  { armName: "SDKConversationResetMessage", kind: "conversation_reset", msg: conversationResetMsg() },
  { armName: "SDKNotificationMessage", kind: "notification", msg: notificationMsg() },
  { armName: "SDKFilesPersistedEvent", kind: "files_persisted", msg: filesPersistedMsg() },
  { armName: "SDKToolUseSummaryMessage", kind: "tool_use_summary", msg: toolUseSummaryMsg() },
  { armName: "SDKMemoryRecallMessage", kind: "memory_recall", msg: memoryRecallMsg() },
  { armName: "SDKPromptSuggestionMessage", kind: "prompt_suggestion", msg: promptSuggestionMsg() },
  { armName: "SDKMirrorErrorMessage", kind: "mirror_error", msg: mirrorErrorMsg() },
];

describe("createClaudeNormalizer — uniform vendor-frame carry (ext.anthropic.frame, fixture-drift ratchet)", () => {
  it.each(CARRIED_ARMS)(
    "$armName emits exactly one ext.anthropic.frame{kind:$kind}, byte-preserved, no park on fold",
    ({ kind, msg }) => {
      const n = createClaudeNormalizer();
      const evs = [...n.push(JsonValue.parse(msg)), ...n.flush()];
      assertAllValid(evs);
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({ type: "ext.anthropic.frame", kind });
      // `frame` rides the VERBATIM native message — no field-by-field
      // reinterpretation. Same narrowing convention as the
      // SDKInformationalMessage tests above (AgExtEvent's `type` is a
      // regex-validated `string`, not a discriminated-union literal, so
      // `Extract`/`===`-narrowing can't pin the ext arm the way it does for
      // AgClosedEventType members).
      expect((evs[0] as { frame?: unknown }).frame).toEqual(msg);

      const r = new Reducer();
      for (const e of evs) r.push(e);
      expect(r.needsResync).toBe(false);
    },
  );

  it("a carried frame sandwiched inside a real turn does not false-park the fold (M22/M46 lesson)", () => {
    const n = createClaudeNormalizer();
    const events = [
      ...n.push(JsonValue.parse(assistantMsg([{ type: "text", text: "hi", citations: null }]))),
      ...n.push(JsonValue.parse(localCommandOutputMsg())),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.flush(),
    ];
    assertAllValid(events);
    expect(events.some((e) => e.type === "ext.anthropic.frame")).toBe(true);
    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);
  });
});

// ─── SDKPermissionDeniedMessage — the "real judgment case" existing-home fix ──
// (audit M19's W1 `<turnId>:denials` carrier). The standalone live denial
// notice is the SAME fact the terminal `permission_denials[]` aggregate
// already turns into a tool.start+tool.done{denied} pair — this fix enriches
// THAT pair (rejection message text + decision-reason/agent-id
// providerMetadata) instead of emitting a second, duplicate pair (M22).
function permissionDeniedMsg(overrides?: {
  agent_id?: string;
  decision_reason_type?: string;
  decision_reason?: string;
}): SDKMessage {
  return {
    type: "system",
    subtype: "permission_denied",
    tool_name: "bash",
    tool_use_id: "toolu_denied_1",
    message: "This command was blocked by a deny rule (no destructive filesystem operations).",
    ...(overrides?.agent_id !== undefined ? { agent_id: overrides.agent_id } : {}),
    ...(overrides?.decision_reason_type !== undefined ? { decision_reason_type: overrides.decision_reason_type } : {}),
    ...(overrides?.decision_reason !== undefined ? { decision_reason: overrides.decision_reason } : {}),
    uuid: "00000000-0000-0000-0000-0000000000g1",
    session_id: "sess_fixture",
  };
}

describe("createClaudeNormalizer — SDKPermissionDeniedMessage enriches the W1 <turnId>:denials carrier (audit M19)", () => {
  it("the live frame alone produces NO standalone event (recorded, not emitted — avoids the M22 double-fold hazard)", () => {
    const n = createClaudeNormalizer();
    const evs = n.push(JsonValue.parse(permissionDeniedMsg()));
    expect(evs).toHaveLength(0);
  });

  it("enriches the aggregate denial's tool.done with the live rejection message + decision-reason providerMetadata", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(
        JsonValue.parse(
          permissionDeniedMsg({
            agent_id: "agent_1",
            decision_reason_type: "rule",
            decision_reason: "matches deny-rule 'no rm -rf'",
          }),
        ),
      ),
      ...n.push(JsonValue.parse(resultWithDenial())),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const toolStarts = evs.filter(
      (e): e is Extract<AgEvent, { type: "tool.start" }> =>
        e.type === "tool.start" && e.toolCallId === "toolu_denied_1",
    );
    const toolDones = evs.filter(
      (e): e is Extract<AgEvent, { type: "tool.done" }> => e.type === "tool.done" && e.toolCallId === "toolu_denied_1",
    );
    // No duplicate pair from the live frame — exactly the ONE pair the
    // already-handled aggregate produces, now enriched.
    expect(toolStarts).toHaveLength(1);
    expect(toolDones).toHaveLength(1);
    expect(toolDones[0]).toMatchObject({
      outcome: "denied",
      content: [{ type: "text", text: "This command was blocked by a deny rule (no destructive filesystem operations)." }],
      providerMetadata: {
        decisionReasonType: "rule",
        decisionReason: "matches deny-rule 'no rm -rf'",
        agentId: "agent_1",
      },
    });
  });

  it("falls back to empty content + no providerMetadata when no live frame preceded the aggregate (pre-existing behavior unchanged)", () => {
    const evs = run(resultWithDenial());
    const toolDone = evs.find(
      (e): e is Extract<AgEvent, { type: "tool.done" }> => e.type === "tool.done",
    );
    expect(toolDone).toMatchObject({ outcome: "denied", content: [] });
    expect(toolDone?.providerMetadata).toBeUndefined();
  });

  it("fold: the enriched denial carrier folds clean through Reducer — needsResync===false", () => {
    const n = createClaudeNormalizer();
    const events = [
      ...n.push(JsonValue.parse(permissionDeniedMsg({ decision_reason: "classifier auto-deny" }))),
      ...n.push(JsonValue.parse(resultWithDenial())),
      ...n.flush(),
    ];
    assertAllValid(events);
    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);
  });
});

// ─── fixture-drift gate: the claude manifest must have ZERO remaining
// `silently-dropped` members (this task's entire point) ───────────────────────
interface SdkSurfaceManifestEntry {
  disposition: string;
  note: string;
}
interface SdkSurfaceManifest {
  members: Record<string, SdkSurfaceManifestEntry>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 0.3.217 wrapper-level assistant carries (bump-audit gap closure): the
// `resumed_from_incomplete_thinking` (replay-load-bearing per its own doc) and
// `aborted` (interrupt-truncation signal) wrapper siblings join the supersedes
// first-block providerMetadata carrier (§8 item 8); a BLOCK-LESS aborted frame
// rides message.metadata instead (no block to anchor).
// ─────────────────────────────────────────────────────────────────────────────

describe("createClaudeNormalizer — 0.3.217 wrapper-level carries (resumed_from_incomplete_thinking / aborted)", () => {
  function wrapperAssistant(extra: { [k: string]: unknown }, content?: unknown[]): unknown {
    return {
      type: "assistant",
      message: {
        ...betaMessage(
          (content ?? [{ type: "text", text: "continued answer.", citations: null }]) as never,
        ),
        id: "msg_wrapper",
      },
      parent_tool_use_id: null,
      uuid: "018f0000-0000-7000-8000-00000000aaaa",
      session_id: "sess_fixture",
      ...extra,
    };
  }

  it("carries resumed_from_incomplete_thinking:true as providerMetadata on the first block", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(wrapperAssistant({ resumed_from_incomplete_thinking: true }))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    );
    expect(firstBlock).toMatchObject({
      providerMetadata: { resumed_from_incomplete_thinking: true },
    });
  });

  it("carries aborted:true the same way, merged with supersedes when both present", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(
        JsonValue.parse(
          wrapperAssistant({
            aborted: true,
            supersedes: ["018f0000-0000-7000-8000-00000000bbbb"],
          }),
        ),
      ),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    );
    expect(firstBlock).toMatchObject({
      providerMetadata: {
        aborted: true,
        supersedes: ["018f0000-0000-7000-8000-00000000bbbb"],
      },
    });
  });

  it("BLOCK-LESS aborted frame: the carry rides a message.metadata event (no block to anchor)", () => {
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(wrapperAssistant({ aborted: true }, []))), ...n.flush()];
    assertAllValid(evs);
    const meta = evs.find((e) => e.type === "message.metadata");
    expect(meta).toMatchObject({ messageId: "msg_wrapper", metadata: { aborted: true } });
  });

  it("emits NO wrapper carry when neither flag nor supersedes is present (existing wire unchanged)", () => {
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(wrapperAssistant({}))), ...n.flush()];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown };
    expect(firstBlock.providerMetadata).toBeUndefined();
    expect(evs.some((e) => e.type === "message.metadata")).toBe(false);
  });

  // ── 0.3.230 sibling: `context_usage`, the structured twin of the /context
  // report riding the synthetic assistant message that delivers the markdown
  // table. Joins the same first-block carrier, structure verbatim. ──
  const CONTEXT_USAGE = {
    model: "claude-opus",
    total_tokens: 154000,
    raw_max_tokens: 200000,
    percentage: 77,
    categories: [{ name: "messages", tokens: 120000 }],
    mcp_tools: [{ name: "mcp__linear__create_issue", server_name: "linear", tokens: 800 }],
    memory_files: [{ path: "MEMORY.md", type: "User", tokens: 400 }],
    agents: [{ agent_type: "Explore", source: "built-in", tokens: 900 }],
  };

  it("carries context_usage verbatim as providerMetadata on the first block (0.3.230)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(wrapperAssistant({ context_usage: CONTEXT_USAGE }))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    );
    expect(firstBlock).toMatchObject({ providerMetadata: { context_usage: CONTEXT_USAGE } });
  });

  it("fold: a context_usage carrier folds clean through Reducer — needsResync===false", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(wrapperAssistant({ context_usage: CONTEXT_USAGE }))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
  });

  // ── 0.3.258 sibling: `user_message_uuid` — the client uuid of the user
  // message this turn answers, stamped on the turn's FIRST reply frame only.
  // Joins the same first-block carrier, wire name verbatim. ──
  const USER_MESSAGE_UUID = "018f0000-0000-7000-8000-00000000d002";

  it("carries user_message_uuid verbatim as providerMetadata on the first block (0.3.258)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(wrapperAssistant({ user_message_uuid: USER_MESSAGE_UUID }))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    );
    expect(firstBlock).toMatchObject({ providerMetadata: { user_message_uuid: USER_MESSAGE_UUID } });
    // Complete-only mode: the first-block carrier is the ONLY channel — no
    // message.metadata twin.
    expect(evs.some((e) => e.type === "message.metadata")).toBe(false);
  });

  it("user_message_uuid on a BLOCK-LESS frame rides message.metadata, merged with the other wrapper siblings", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(wrapperAssistant({ aborted: true, user_message_uuid: USER_MESSAGE_UUID }, []))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const meta = evs.find((e) => e.type === "message.metadata");
    expect(meta).toMatchObject({
      messageId: "msg_wrapper",
      metadata: { aborted: true, user_message_uuid: USER_MESSAGE_UUID },
    });
  });

  it("emits NO user_message_uuid key when the frame lacks it — the other wrapper siblings are unaffected (negative control)", () => {
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(wrapperAssistant({ aborted: true }))), ...n.flush()];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: { user_message_uuid?: unknown } };
    expect(firstBlock).toMatchObject({ providerMetadata: { aborted: true } });
    expect(firstBlock.providerMetadata?.user_message_uuid).toBeUndefined();
  });
});

describe("createClaudeNormalizer — 0.3.220 result-meta carry (fast_mode_disabled_reason / ModelUsage serving identity)", () => {
  type SDKResultSuccessT = Extract<SDKMessage, { type: "result"; subtype: "success" }>;
  type SDKResultErrorT = Exclude<Extract<SDKMessage, { type: "result" }>, { subtype: "success" }>;

  // The 0.3.220 additions layered onto the frozen result fixtures: NEW frames,
  // the pre-0.3.220 fixtures above stay byte-identical (negative control below).
  const SERVING_MODEL_USAGE: SDKResultSuccessT["modelUsage"] = {
    "claude-opus": {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10,
      webSearchRequests: 0,
      costUSD: 0.05,
      contextWindow: 200000,
      maxOutputTokens: 8192,
      canonicalModel: "claude-opus-4-7",
      provider: "bedrock",
    },
  };

  function resultSuccessWithMeta(
    reason?: SDKResultSuccessT["fast_mode_disabled_reason"],
  ): SDKMessage {
    return {
      ...(resultSuccess("end_turn") as SDKResultSuccessT),
      ...(reason !== undefined ? { fast_mode_disabled_reason: reason } : {}),
      modelUsage: SERVING_MODEL_USAGE,
    };
  }

  it("carries fast_mode_disabled_reason + per-model canonicalModel/provider as ONE ext.anthropic.result-meta before turn.done", () => {
    const evs = run(resultSuccessWithMeta("extra_usage_disabled"));
    expect(evs.map((e) => e.type)).toEqual(["ext.anthropic.result-meta", "turn.done"]);
    expect(evs[0]).toMatchObject({
      type: "ext.anthropic.result-meta",
      fastModeDisabledReason: "extra_usage_disabled",
      modelUsage: { "claude-opus": { canonicalModel: "claude-opus-4-7", provider: "bedrock" } },
    });
    // turn.done itself is unchanged — usage.byModel still maps the token/cost fields.
    expect(evs[1]).toMatchObject({
      type: "turn.done",
      finishReason: "stop",
      usage: { byModel: { "claude-opus": { inputTokens: 100, costUsd: 0.05 } } },
    });
    assertAllValid(evs);
  });

  it("emits the carry with modelUsage identity alone (no fabricated fastModeDisabledReason key)", () => {
    const evs = run(resultSuccessWithMeta());
    expect(evs.map((e) => e.type)).toEqual(["ext.anthropic.result-meta", "turn.done"]);
    expect(evs[0]).toMatchObject({
      modelUsage: { "claude-opus": { canonicalModel: "claude-opus-4-7", provider: "bedrock" } },
    });
    expect((evs[0] as { fastModeDisabledReason?: unknown }).fastModeDisabledReason).toBeUndefined();
  });

  it("carries fast_mode_disabled_reason on the ERROR result arm too, before turn.error", () => {
    const msg: SDKResultErrorT = {
      ...(resultError("error_during_execution") as SDKResultErrorT),
      fast_mode_disabled_reason: "network_error",
    };
    const evs = run(msg);
    expect(evs.map((e) => e.type)).toEqual(["ext.anthropic.result-meta", "turn.error"]);
    expect(evs[0]).toMatchObject({
      type: "ext.anthropic.result-meta",
      fastModeDisabledReason: "network_error",
    });
    expect(evs[1]).toMatchObject({
      type: "turn.error",
      code: "error_during_execution",
      retriable: true,
    });
    assertAllValid(evs);
  });

  it("emits NO result-meta when the fields are absent — pre-0.3.220 result frames stay byte-identical", () => {
    // The frozen fixtures carry neither fast_mode_disabled_reason nor any
    // modelUsage identity field — exactly the pre-0.3.220 wire.
    const success = run(resultSuccess("end_turn"));
    expect(success.map((e) => e.type)).toEqual(["turn.done"]);
    const error = run(resultError("error_max_turns"));
    expect(error.map((e) => e.type)).toEqual(["turn.error"]);
  });

  it("fold: a result-meta carry sandwiched inside a real turn folds clean through Reducer — needsResync===false", () => {
    const n = createClaudeNormalizer();
    const events = [
      ...n.push(JsonValue.parse(assistantMsg([{ type: "text", text: "hello", citations: null }]))),
      ...n.push(JsonValue.parse(resultSuccessWithMeta("extra_usage_disabled"))),
      ...n.flush(),
    ];
    assertAllValid(events);
    expect(events.some((e) => e.type === "ext.anthropic.result-meta")).toBe(true);

    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);
  });
});

describe("createClaudeNormalizer — 0.3.258 result-meta additions (ModelUsage.costBasis / user_message_uuid / queued_turn_count)", () => {
  type SDKResultErrorMsg = Exclude<Extract<SDKMessage, { type: "result" }>, { subtype: "success" }>;
  const UMU = "018f0000-0000-7000-8000-00000000e001";

  // The frozen per-model fixture + the 0.3.220 identity + the 0.3.246 costBasis.
  const PRICED_MODEL_USAGE: SDKResultSuccessMsg["modelUsage"] = {
    "claude-opus": {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10,
      webSearchRequests: 0,
      costUSD: 0.05,
      contextWindow: 200000,
      maxOutputTokens: 8192,
      canonicalModel: "claude-opus-4-7",
      provider: "bedrock",
      costBasis: "managed",
    },
  };
  // Same identity WITHOUT costBasis (the pre-0.3.246 identity shape).
  const IDENTITY_ONLY_MODEL_USAGE: SDKResultSuccessMsg["modelUsage"] = {
    "claude-opus": {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10,
      webSearchRequests: 0,
      costUSD: 0.05,
      contextWindow: 200000,
      maxOutputTokens: 8192,
      canonicalModel: "claude-opus-4-7",
      provider: "bedrock",
    },
  };

  it("carries ModelUsage.costBasis inside the per-model identity beside canonicalModel/provider", () => {
    const msg: SDKResultSuccessMsg = {
      ...(resultSuccess("end_turn") as SDKResultSuccessMsg),
      modelUsage: PRICED_MODEL_USAGE,
    };
    const evs = run(msg);
    expect(evs.map((e) => e.type)).toEqual(["ext.anthropic.result-meta", "turn.done"]);
    expect(evs[0]).toMatchObject({
      type: "ext.anthropic.result-meta",
      modelUsage: {
        "claude-opus": { canonicalModel: "claude-opus-4-7", provider: "bedrock", costBasis: "managed" },
      },
    });
    // turn.done's byModel still maps the token/cost fields, identity-free.
    expect(evs[1]).toMatchObject({
      type: "turn.done",
      usage: { byModel: { "claude-opus": { inputTokens: 100, costUsd: 0.05 } } },
    });
    assertAllValid(evs);
  });

  it("carries userMessageUuid + queuedTurnCount top-level on the SUCCESS arm — queuedTurnCount 0 is a real value, kept", () => {
    const msg: SDKResultSuccessMsg = {
      ...(resultSuccess("end_turn") as SDKResultSuccessMsg),
      user_message_uuid: UMU,
      queued_turn_count: 0,
    };
    const evs = run(msg);
    expect(evs.map((e) => e.type)).toEqual(["ext.anthropic.result-meta", "turn.done"]);
    expect(evs[0]).toMatchObject({
      type: "ext.anthropic.result-meta",
      userMessageUuid: UMU,
      queuedTurnCount: 0,
    });
    // Nothing fabricated beside them.
    expect((evs[0] as { fastModeDisabledReason?: unknown }).fastModeDisabledReason).toBeUndefined();
    expect((evs[0] as { modelUsage?: unknown }).modelUsage).toBeUndefined();
    assertAllValid(evs);
  });

  it("carries userMessageUuid + queuedTurnCount on the ERROR arm too (SDKResultError gained user_message_uuid in 0.3.258), before turn.error", () => {
    const msg: SDKResultErrorMsg = {
      ...(resultError("error_during_execution") as SDKResultErrorMsg),
      user_message_uuid: UMU,
      queued_turn_count: 2,
    };
    const evs = run(msg);
    expect(evs.map((e) => e.type)).toEqual(["ext.anthropic.result-meta", "turn.error"]);
    expect(evs[0]).toMatchObject({
      type: "ext.anthropic.result-meta",
      userMessageUuid: UMU,
      queuedTurnCount: 2,
    });
    expect(evs[1]).toMatchObject({ type: "turn.error", code: "error_during_execution", retriable: true });
    assertAllValid(evs);
  });

  it("negative control: an identity without costBasis and frames without the two siblings emit no such keys — pre-0.3.258 output byte-identical", () => {
    const evs = run({
      ...(resultSuccess("end_turn") as SDKResultSuccessMsg),
      modelUsage: IDENTITY_ONLY_MODEL_USAGE,
    });
    expect(evs.map((e) => e.type)).toEqual(["ext.anthropic.result-meta", "turn.done"]);
    const meta = evs[0] as {
      modelUsage?: { [model: string]: { costBasis?: unknown } | undefined };
      userMessageUuid?: unknown;
      queuedTurnCount?: unknown;
    };
    expect(meta.modelUsage?.["claude-opus"]).toEqual({ canonicalModel: "claude-opus-4-7", provider: "bedrock" });
    expect(meta.modelUsage?.["claude-opus"]?.costBasis).toBeUndefined();
    expect(meta.userMessageUuid).toBeUndefined();
    expect(meta.queuedTurnCount).toBeUndefined();
    // The frozen fixtures (no identity, no siblings) still emit NO result-meta at all.
    expect(run(resultSuccess("end_turn")).map((e) => e.type)).toEqual(["turn.done"]);
    expect(run(resultError("error_max_turns")).map((e) => e.type)).toEqual(["turn.error"]);
  });
});

// ─── 0.3.257 thinking-token telemetry → AgUsage.reasoningTokens ──────────────
// `ModelUsage.thinkingTokens` ("already counted inside outputTokens") and the
// wire-level `usage.output_tokens_details.thinking_tokens` (undeclared on the
// bundled BetaUsage/BetaMessageDeltaUsage 0.93.0 — read through the runtime
// guard) both land on `reasoningTokens` as a SUBSET of outputTokens, the same
// convention the openai/adk facets follow. Absent ⇒ no key (byte-identical).
describe("createClaudeNormalizer — 0.3.257 thinking-token telemetry → reasoningTokens (subset of outputTokens)", () => {
  type UsageBag = {
    usage?: { reasoningTokens?: unknown; byModel?: { [model: string]: { reasoningTokens?: unknown } | undefined } };
  };
  const base = (): SDKResultSuccessMsg => resultSuccess("end_turn") as SDKResultSuccessMsg;

  it("modelUsage.<model>.thinkingTokens → turn.done usage.byModel.<model>.reasoningTokens", () => {
    const msg: SDKResultSuccessMsg = {
      ...base(),
      modelUsage: {
        "claude-opus": {
          inputTokens: 100,
          outputTokens: 50,
          thinkingTokens: 12,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 10,
          webSearchRequests: 0,
          costUSD: 0.05,
          contextWindow: 200000,
          maxOutputTokens: 8192,
        },
      },
    };
    const evs = run(msg);
    const done = evs.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({
      type: "turn.done",
      usage: { outputTokens: 50, byModel: { "claude-opus": { outputTokens: 50, reasoningTokens: 12 } } },
    });
    // The aggregate usage carried no output_tokens_details — no top-level key fabricated.
    expect((done as UsageBag).usage?.reasoningTokens).toBeUndefined();
    assertAllValid(evs);
  });

  it("result usage.output_tokens_details.thinking_tokens (runtime-guarded — undeclared on BetaUsage 0.93.0) → turn.done usage.reasoningTokens", () => {
    const b = base();
    // The wire carries the field the peer type does not declare — assembled at
    // the JsonValue boundary, exactly as the run-seam delivers it.
    const wire: unknown = { ...b, usage: { ...b.usage, output_tokens_details: { thinking_tokens: 7 } } };
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(wire)), ...n.flush()];
    const done = evs.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({
      type: "turn.done",
      usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 7, cumulative: true },
    });
    assertAllValid(evs);
  });

  it("assistant message.usage.output_tokens_details.thinking_tokens → message.end usage.reasoningTokens", () => {
    const b = assistantMsg([{ type: "text", text: "hi", citations: null }]) as SDKAssistant;
    const wire: unknown = {
      ...b,
      message: { ...b.message, usage: { ...b.message.usage, output_tokens_details: { thinking_tokens: 3 } } },
    };
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(wire)), ...n.flush()];
    const end = evs.find((e) => e.type === "message.end");
    expect(end).toMatchObject({
      type: "message.end",
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 3, cumulative: true },
    });
    assertAllValid(evs);
  });

  it("a malformed output_tokens_details never throws and fabricates no key (Tenet 6)", () => {
    const b = base();
    const wire: unknown = { ...b, usage: { ...b.usage, output_tokens_details: "nope" } };
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(wire)), ...n.flush()];
    const done = evs.find((e) => e.type === "turn.done");
    expect(done).toBeDefined();
    expect((done as UsageBag).usage?.reasoningTokens).toBeUndefined();
  });

  it("negative control: the frozen fixtures (no thinking telemetry) emit no reasoningTokens anywhere — pre-0.3.257 output byte-identical", () => {
    const evs = [
      ...run(assistantMsg([{ type: "text", text: "hi", citations: null }])),
      ...run(resultSuccess("end_turn")),
    ];
    const carriers = evs.filter((e) => e.type === "message.end" || e.type === "turn.done");
    expect(carriers).toHaveLength(2);
    for (const e of carriers) {
      const bag = (e as UsageBag).usage;
      expect(bag).toBeDefined();
      expect(bag?.reasoningTokens).toBeUndefined();
      for (const bm of Object.values(bag?.byModel ?? {})) expect(bm?.reasoningTokens).toBeUndefined();
    }
  });
});

describe("fixture-drift ratchet — packages/claude-agent-sdk/sdk-surface.json manifest", () => {
  function loadManifest(): SdkSurfaceManifest {
    const manifestPath = fileURLToPath(new URL("../sdk-surface.json", import.meta.url));
    return JSON.parse(readFileSync(manifestPath, "utf8")) as SdkSurfaceManifest;
  }

  it("has ZERO remaining silently-dropped members", () => {
    const manifest = loadManifest();
    const silentlyDropped = Object.entries(manifest.members)
      .filter(([, entry]) => entry.disposition === "silently-dropped")
      .map(([name]) => name);
    expect(silentlyDropped).toEqual([]);
  });

  it("every member disposes to a recognised, non-dropped disposition", () => {
    const manifest = loadManifest();
    const VALID = new Set(["handled", "carried", "router-plane", "not-applicable"]);
    const invalid = Object.entries(manifest.members)
      .filter(([, entry]) => !VALID.has(entry.disposition))
      .map(([name, entry]) => `${name}: ${entry.disposition}`);
    expect(invalid).toEqual([]);
  });
});

// ─── workspace#7 — stream_event partials (includePartialMessages: true) ───────
// The SDK interleaves `{type:"stream_event", event: BetaRawMessageStreamEvent}`
// frames BEFORE each complete assistant frame. The facet maps partials to the
// SAME lifecycles under the SAME ids and content-suppresses the complete frame
// that joins the streamed lifecycle. The acceptance bar (the issue's own):
// reducer state after partials + suppressed-complete ≡ today's complete-only
// state, and INV-MSG holds throughout.
describe("createClaudeNormalizer — stream_event partials (workspace#7)", () => {
  type SDKPartial = Extract<SDKMessage, { type: "stream_event" }>;
  type StreamEvent = SDKPartial["event"];

  const STREAM_ID = "msg_stream_1";
  const STREAM_TOOL_ID = "toolu_stream_1";

  function streamFrame(
    event: StreamEvent,
    opts?: { parent?: string | null; ttft?: number; userMessageUuid?: string },
  ): SDKMessage {
    return {
      type: "stream_event",
      event,
      parent_tool_use_id: opts?.parent ?? null,
      uuid: "00000000-0000-0000-0000-0000000000c1",
      session_id: "sess_fixture",
      ...(opts?.ttft !== undefined ? { ttft_ms: opts.ttft } : {}),
      ...(opts?.userMessageUuid !== undefined ? { user_message_uuid: opts.userMessageUuid } : {}),
    };
  }

  const messageStart = (id: string = STREAM_ID): StreamEvent => ({
    type: "message_start",
    message: { ...betaMessage([]), id },
  });
  const cbStartText = (index: number): StreamEvent => ({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "", citations: null },
  });
  const cbDeltaText = (index: number, text: string): StreamEvent => ({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
  const cbStartThinking = (index: number): StreamEvent => ({
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "", signature: "" },
  });
  const cbDeltaThinking = (index: number, thinking: string): StreamEvent => ({
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking },
  });
  const cbDeltaSignature = (index: number, signature: string): StreamEvent => ({
    type: "content_block_delta",
    index,
    delta: { type: "signature_delta", signature },
  });
  const cbStartTool = (index: number): StreamEvent => ({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id: STREAM_TOOL_ID, name: "get_weather", input: {} },
  });
  const cbDeltaJson = (index: number, partial_json: string): StreamEvent => ({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json },
  });
  const cbStop = (index: number): StreamEvent => ({ type: "content_block_stop", index });
  const msgDelta = (output_tokens: number): StreamEvent => ({
    type: "message_delta",
    context_management: null,
    delta: { container: null, stop_details: null, stop_reason: "end_turn", stop_sequence: null },
    usage: {
      input_tokens: null,
      output_tokens,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      iterations: null,
      server_tool_use: null,
    },
  });
  const msgStop = (): StreamEvent => ({ type: "message_stop" });

  /** The complete assistant frame that FOLLOWS the stream for the same id. */
  function completeFrame(
    content: BetaMessage["content"],
    overrides?: Partial<Pick<BetaMessage, "usage">>,
  ): SDKMessage {
    return {
      type: "assistant",
      message: { ...betaMessage(content, overrides), id: STREAM_ID },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000c9",
      session_id: "sess_fixture",
    };
  }

  function pushAll(n: ReturnType<typeof createClaudeNormalizer>, msgs: SDKMessage[]): AgEvent[] {
    const out: AgEvent[] = [];
    for (const m of msgs) out.push(...n.push(JsonValue.parse(m)));
    return out;
  }

  const TEXT_STREAM = (): SDKMessage[] => [
    streamFrame(messageStart()),
    streamFrame(cbStartText(0)),
    streamFrame(cbDeltaText(0, "hel")),
    streamFrame(cbDeltaText(0, "lo")),
    streamFrame(cbStop(0)),
    streamFrame(msgDelta(5)),
    streamFrame(msgStop()),
  ];

  it("maps partials to incremental deltas — each push drains its events immediately, and the complete frame re-emits NOTHING", () => {
    const n = createClaudeNormalizer();
    // The incremental guarantee itself: a text_delta frame yields its event in
    // the SAME push (no end-of-turn burst).
    const headBatch = pushAll(n, [streamFrame(messageStart()), streamFrame(cbStartText(0))]);
    expect(headBatch.map((e) => e.type)).toEqual(["turn.start", "message.start", "text.start"]);
    const deltaBatch = n.push(JsonValue.parse(streamFrame(cbDeltaText(0, "hel"))));
    expect(deltaBatch.map((e) => e.type)).toEqual(["text.delta"]);
    const evs = [
      ...headBatch,
      ...deltaBatch,
      ...pushAll(n, [
        streamFrame(cbDeltaText(0, "lo")),
        streamFrame(cbStop(0)),
        streamFrame(msgDelta(5)),
        streamFrame(msgStop()),
        completeFrame([{ type: "text", text: "hello", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    // Dedupe: exactly the two streamed deltas — the complete frame added none.
    const deltas = evs.filter((e) => isClosedEvent(e) && e.type === "text.delta");
    expect(deltas.map((e) => (e.type === "text.delta" ? e.delta : ""))).toEqual(["hel", "lo"]);
    expect(evs.filter((e) => e.type === "text.start")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "text.end")).toHaveLength(1);
  });

  it("INV-MSG: one message.start / one message.end across partials + complete, never a re-open", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...pushAll(n, [
        ...TEXT_STREAM(),
        completeFrame([{ type: "text", text: "hello", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(evs.filter((e) => e.type === "message.start" && e.id === STREAM_ID)).toHaveLength(1);
    expect(evs.filter((e) => e.type === "message.end" && e.id === STREAM_ID)).toHaveLength(1);
    const sealed = new Set<string>();
    for (const ev of evs) {
      if (!isClosedEvent(ev)) continue;
      if (ev.type === "message.end") sealed.add(ev.id);
      if (ev.type === "message.start") expect(sealed.has(ev.id)).toBe(false);
    }
  });

  it("THE acceptance bar: reducer state after partials + suppressed-complete equals the complete-only state", () => {
    const streamed = createClaudeNormalizer();
    const streamedEvs = [
      ...pushAll(streamed, [
        ...TEXT_STREAM(),
        completeFrame([{ type: "text", text: "hello", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...streamed.flush(),
    ];
    const completeOnly = createClaudeNormalizer();
    const completeEvs = [
      ...pushAll(completeOnly, [
        completeFrame([{ type: "text", text: "hello", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...completeOnly.flush(),
    ];
    const rs = new Reducer();
    for (const e of streamedEvs) rs.push(e);
    const rc = new Reducer();
    for (const e of completeEvs) rc.push(e);
    expect(rs.needsResync).toBe(false);
    expect(rc.needsResync).toBe(false);
    expect(rs.result()).toEqual(rc.result());
  });

  it("streams thinking with a buffered signature — reasoning.opaque parity with the complete arm", () => {
    const streamed = createClaudeNormalizer();
    const streamedEvs = [
      ...pushAll(streamed, [
        streamFrame(messageStart()),
        streamFrame(cbStartThinking(0)),
        streamFrame(cbDeltaThinking(0, "let me ")),
        streamFrame(cbDeltaThinking(0, "think")),
        streamFrame(cbDeltaSignature(0, "sig-xyz")),
        streamFrame(cbStop(0)),
        streamFrame(msgStop()),
        completeFrame([{ type: "thinking", thinking: "let me think", signature: "sig-xyz" }]),
        resultSuccess("end_turn"),
      ]),
      ...streamed.flush(),
    ];
    assertAllValid(streamedEvs);
    const opaques = streamedEvs.filter((e) => isClosedEvent(e) && e.type === "reasoning.opaque");
    expect(opaques).toHaveLength(1);
    expect(opaques[0]).toMatchObject({ kind: "signature", value: "sig-xyz", provider: "anthropic" });

    const completeOnly = createClaudeNormalizer();
    const completeEvs = [
      ...pushAll(completeOnly, [
        completeFrame([{ type: "thinking", thinking: "let me think", signature: "sig-xyz" }]),
        resultSuccess("end_turn"),
      ]),
      ...completeOnly.flush(),
    ];
    const rs = new Reducer();
    for (const e of streamedEvs) rs.push(e);
    const rc = new Reducer();
    for (const e of completeEvs) rc.push(e);
    expect(rs.result()).toEqual(rc.result());
  });

  it("streams tool args via input_json_delta and emits the MANDATORY args.assembled at stop — tool_result adoption still binds", () => {
    const n = createClaudeNormalizer();
    const toolResult: UserContent = [
      {
        type: "tool_result",
        tool_use_id: STREAM_TOOL_ID,
        content: [{ type: "text", text: "sunny" }],
        is_error: false,
      },
    ];
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart()),
        streamFrame(cbStartTool(0)),
        streamFrame(cbDeltaJson(0, '{"ci')),
        streamFrame(cbDeltaJson(0, 'ty":"SF"}')),
        streamFrame(cbStop(0)),
        streamFrame(msgStop()),
        completeFrame([
          { type: "tool_use", id: STREAM_TOOL_ID, name: "get_weather", input: { city: "SF" } },
        ]),
        {
          type: "user",
          message: { role: "user", content: toolResult },
          parent_tool_use_id: null,
          uuid: "00000000-0000-0000-0000-0000000000ca",
          session_id: "sess_fixture",
        },
        resultSuccess("end_turn"),
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const argDeltas = evs.filter((e) => isClosedEvent(e) && e.type === "tool.args.delta");
    expect(argDeltas.map((e) => (e.type === "tool.args.delta" ? e.delta : ""))).toEqual([
      '{"ci',
      'ty":"SF"}',
    ]);
    const assembled = evs.filter((e) => isClosedEvent(e) && e.type === "tool.args.assembled");
    expect(assembled).toHaveLength(1);
    expect(assembled[0]).toMatchObject({ toolCallId: STREAM_TOOL_ID, input: { city: "SF" } });
    // ONE tool.start (the complete frame re-emitted nothing) and the adopted result.
    expect(evs.filter((e) => e.type === "tool.start")).toHaveLength(1);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const toolMsg = r.result().messages.find((m) => m.id === `${STREAM_TOOL_ID}:result`);
    expect(toolMsg?.content.some((b) => b.type === "tool-result")).toBe(true);
  });

  it("carries ttft_ms once via message.metadata (wire name verbatim), never twice", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart(), { ttft: 923 }),
        streamFrame(cbStartText(0), { ttft: 923 }),
        streamFrame(cbDeltaText(0, "hi"), { ttft: 923 }),
        streamFrame(cbStop(0)),
        streamFrame(msgStop()),
        completeFrame([{ type: "text", text: "hi", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const metas = evs.filter(
      (e) => isClosedEvent(e) && e.type === "message.metadata" && e.metadata["ttft_ms"] === 923,
    );
    expect(metas).toHaveLength(1);
  });

  it("an aborted stream (no stop, no complete frame) still seals cleanly on flush — no dangling lifecycles", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart()),
        streamFrame(cbStartText(0)),
        streamFrame(cbDeltaText(0, "partial answ")),
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const types = evs.filter(isClosedEvent).map((e) => e.type);
    // finalize (text.end) precedes the seal (message.end): nothing dangles.
    expect(types.indexOf("text.end")).toBeGreaterThan(-1);
    expect(types.indexOf("text.end")).toBeLessThan(types.indexOf("message.end"));
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
  });

  it("orphan stream frames (no message_start observed) ride the lossless ext.anthropic.frame carry", () => {
    const n = createClaudeNormalizer();
    const evs = n.push(JsonValue.parse(streamFrame(cbDeltaText(0, "orphan"))));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "ext.anthropic.frame", kind: "stream_event" });
  });

  it("wrapper carry on a SUPPRESSED complete frame rides message.metadata (no first-block anchor exists)", () => {
    const n = createClaudeNormalizer();
    const abortedComplete: SDKMessage = {
      ...completeFrame([{ type: "text", text: "hel", citations: null }]),
      aborted: true,
    } as SDKMessage;
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart()),
        streamFrame(cbStartText(0)),
        streamFrame(cbDeltaText(0, "hel")),
        streamFrame(cbStop(0)),
        abortedComplete,
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const metas = evs.filter(
      (e) => isClosedEvent(e) && e.type === "message.metadata" && e.metadata["aborted"] === true,
    );
    expect(metas).toHaveLength(1);
    // …and the complete frame's text was NOT re-emitted.
    expect(evs.filter((e) => e.type === "text.start")).toHaveLength(1);
  });

  it("nested (subagent) partials: subagent.start seeds the streamed turn; the nested complete frame joins it", () => {
    const n = createClaudeNormalizer();
    const nestedComplete: SDKMessage = {
      type: "assistant",
      message: { ...betaMessage([{ type: "text", text: "sub", citations: null }]), id: STREAM_ID },
      parent_tool_use_id: "toolu_parent_9",
      uuid: "00000000-0000-0000-0000-0000000000cb",
      session_id: "sess_fixture",
    };
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart(), { parent: "toolu_parent_9" }),
        streamFrame(cbStartText(0), { parent: "toolu_parent_9" }),
        streamFrame(cbDeltaText(0, "sub"), { parent: "toolu_parent_9" }),
        streamFrame(cbStop(0), { parent: "toolu_parent_9" }),
        streamFrame(msgStop(), { parent: "toolu_parent_9" }),
        nestedComplete,
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(evs.filter((e) => e.type === "subagent.start")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "subagent.done")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "message.start")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "text.delta")).toHaveLength(1);
  });

  it("a carried ext frame BETWEEN stream events never splits the streamed message (guuey#26 parity)", () => {
    const n = createClaudeNormalizer();
    const hookFrame: SDKMessage = JSON.parse(
      JSON.stringify({
        type: "system",
        subtype: "hook_progress",
        hook_name: "PostToolUse",
        output: "…",
        uuid: "00000000-0000-0000-0000-0000000000cc",
        session_id: "sess_fixture",
      }),
    ) as SDKMessage;
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart()),
        streamFrame(cbStartText(0)),
        streamFrame(cbDeltaText(0, "hel")),
        hookFrame,
        streamFrame(cbDeltaText(0, "lo")),
        streamFrame(cbStop(0)),
        streamFrame(msgStop()),
        completeFrame([{ type: "text", text: "hello", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(evs.filter((e) => e.type === "message.start")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "message.end")).toHaveLength(1);
    const deltas = evs.filter((e) => isClosedEvent(e) && e.type === "text.delta");
    expect(deltas.map((e) => (e.type === "text.delta" ? e.delta : ""))).toEqual(["hel", "lo"]);
  });

  it("byte-parity: a partials-free run is untouched by the arm (golden equality with a fresh normalizer)", () => {
    const withArm = createClaudeNormalizer();
    const evsA = [
      ...pushAll(withArm, [
        assistantMsg([{ type: "text", text: "hello", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...withArm.flush(),
    ];
    const again = createClaudeNormalizer();
    const evsB = [
      ...pushAll(again, [
        assistantMsg([{ type: "text", text: "hello", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...again.flush(),
    ];
    expect(evsA).toEqual(evsB);
  });

  // ── 0.3.258: `user_message_uuid` on the partial envelope — stamped on the
  // turn's FIRST non-ping stream event; same channel + once-per-message rule
  // as ttft_ms, with the flag shared with the complete arm's wrapper carry. ──
  const STREAM_UMU = "018f0000-0000-7000-8000-00000000d001";

  it("carries user_message_uuid once via message.metadata (wire name verbatim) from the first non-ping stream event — never twice, even when the complete frame is stamped too", () => {
    const n = createClaudeNormalizer();
    // Defensive double-stamp: the SDK normally stamps the stream OR the first
    // complete frame, never both — the shared flag must hold either way.
    const stampedComplete: SDKMessage = {
      ...completeFrame([{ type: "text", text: "hi", citations: null }]),
      user_message_uuid: STREAM_UMU,
    } as SDKMessage;
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart(), { userMessageUuid: STREAM_UMU }),
        streamFrame(cbStartText(0)),
        streamFrame(cbDeltaText(0, "hi")),
        streamFrame(cbStop(0)),
        streamFrame(msgStop()),
        stampedComplete,
        resultSuccess("end_turn"),
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const metas = evs.filter(
      (e) =>
        isClosedEvent(e) && e.type === "message.metadata" && e.metadata["user_message_uuid"] === STREAM_UMU,
    );
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ messageId: STREAM_ID });
    // Bound to the reply BEFORE any content streamed: the carry precedes the first block.
    const types = evs.map((e) => e.type);
    expect(types.indexOf("message.metadata")).toBeLessThan(types.indexOf("text.start"));
    // …and no first-block providerMetadata twin (the complete frame was content-suppressed).
    const textStart = evs.find((e) => e.type === "text.start") as { providerMetadata?: unknown };
    expect(textStart.providerMetadata).toBeUndefined();
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
  });

  it("emits NO user_message_uuid carry when the stream lacks it (negative control — the ttft-free wire is unchanged)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...pushAll(n, [
        ...TEXT_STREAM(),
        completeFrame([{ type: "text", text: "hello", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...n.flush(),
    ];
    expect(
      evs.some(
        (e) => isClosedEvent(e) && e.type === "message.metadata" && e.metadata["user_message_uuid"] !== undefined,
      ),
    ).toBe(false);
  });

  // ── 0.3.257: `thinking_tokens` inside message_delta usage — the ONLY frame
  // that carries it in the observed wire (corpus/partials-sonnet5: the
  // CLI-assembled complete frame's usage has no output_tokens_details), so the
  // streamed count must survive the complete frame's join. ──
  const msgDeltaWithThinking = (output_tokens: number, thinking_tokens: number): unknown => {
    const base = msgDelta(output_tokens);
    return base.type === "message_delta"
      ? { ...base, usage: { ...base.usage, output_tokens_details: { thinking_tokens } } }
      : base;
  };
  const rawStreamFrame = (event: unknown): JsonValue =>
    JsonValue.parse({ ...streamFrame(msgStop()), event });

  it("message_delta usage.output_tokens_details.thinking_tokens → message.end usage.reasoningTokens, surviving the complete frame's join", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart()),
        streamFrame(cbStartText(0)),
        streamFrame(cbDeltaText(0, "hi")),
        streamFrame(cbStop(0)),
      ]),
      ...n.push(rawStreamFrame(msgDeltaWithThinking(5, 3))),
      ...pushAll(n, [
        streamFrame(msgStop()),
        completeFrame([{ type: "text", text: "hi", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const end = evs.find((e) => e.type === "message.end" && e.id === STREAM_ID);
    // outputTokens: the complete frame's copy (0, the frozen fixture) still
    // overwrites the streamed 5 — every field the complete frame names wins as
    // before; reasoningTokens, which only the stream delivered, survives.
    expect(end).toMatchObject({
      type: "message.end",
      usage: { outputTokens: 0, reasoningTokens: 3, cumulative: true },
    });
  });

  it("an aborted stream (no complete frame) seals with the streamed reasoningTokens on flush", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...pushAll(n, [streamFrame(messageStart()), streamFrame(cbStartText(0)), streamFrame(cbDeltaText(0, "part"))]),
      ...n.push(rawStreamFrame(msgDeltaWithThinking(9, 4))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const end = evs.find((e) => e.type === "message.end" && e.id === STREAM_ID);
    expect(end).toMatchObject({ type: "message.end", usage: { outputTokens: 9, reasoningTokens: 4 } });
  });

  it("negative control: a message_delta without output_tokens_details leaves message.end usage key-for-key as before", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...pushAll(n, [
        ...TEXT_STREAM(),
        completeFrame([{ type: "text", text: "hello", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...n.flush(),
    ];
    const end = evs.find((e) => e.type === "message.end" && e.id === STREAM_ID) as {
      usage?: { reasoningTokens?: unknown };
    };
    expect(end.usage).toEqual({ inputTokens: 0, outputTokens: 0, cumulative: true });
    expect(end.usage?.reasoningTokens).toBeUndefined();
  });
});

// ─── ClaudeNormalizerOptions.threadId — caller-owned partition root ───────────
// guuey#415: the four construction sites relabeled the SDK `session_id` as
// `threadId`, and the placeholder leaked into consumers that persist events
// verbatim under their own thread identity. The runtime that knows the real
// thread id passes it at construction; absent, the legacy relabeling stands
// (cassette-stable default).
describe("createClaudeNormalizer — options.threadId (guuey#415)", () => {
  const textContent: BetaMessage["content"] = [{ type: "text", text: "hello", citations: null }];

  function threadIdsOf(evs: AgEvent[]): string[] {
    return evs.flatMap((e) => {
      const t = (e as { threadId?: unknown }).threadId;
      return typeof t === "string" ? [t] : [];
    });
  }

  it("stamps the caller's threadId everywhere instead of relabeling session_id", () => {
    const n = createClaudeNormalizer({ threadId: "thread_runtime_1" });
    const evs = [...n.push(JsonValue.parse(assistantMsg(textContent))), ...n.flush()];
    const ids = threadIdsOf(evs);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set(["thread_runtime_1"]));
    // The wire session id must not survive as any threadId. (Synthesized
    // turn ids still embed it as opaque identifiers — that is not a threadId.)
    expect(ids).not.toContain("sess_fixture");
  });

  it("absent option preserves the legacy session_id relabeling (cassette-stable default)", () => {
    const ids = threadIdsOf(run(assistantMsg(textContent)));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set(["sess_fixture"]));
  });
});

// ─── cohort 0.5.4 census-caught carries (2026-09-02, the first 0.3.258 + Fable 5.1 captures) ──
describe("createClaudeNormalizer — result-frame subagent_stats (runtime-only, 0.3.258 wire) → result-meta.subagentStats", () => {
  const STATS = {
    spawned: 0,
    requested: { background: 0, foreground: 0, unset: 0 },
    started_in_background: 0,
    max_depth: 0,
    spawned_by_subagents: 0,
    completed: 0,
    failed: 0,
    killed: { parent: 0, user: 0, system: 0 },
    refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
    by_type: {},
  };

  it("carries the whole subagent_stats object verbatim (ambient zeros included) beside the other result-meta siblings", () => {
    // Undeclared on SDKResultSuccess through 0.3.258 — assemble at the JSON boundary, no cast.
    const wire: unknown = { ...resultSuccess("end_turn"), subagent_stats: STATS };
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(wire)), ...n.flush()];
    expect(evs.map((e) => e.type)).toEqual(["ext.anthropic.result-meta", "turn.done"]);
    expect((evs[0] as { subagentStats?: unknown }).subagentStats).toEqual(STATS);
    assertAllValid(evs);
  });

  it("emits NO subagentStats key (and no result-meta at all) when the frame lacks it — byte-identical pre-0.3.258 output", () => {
    const evs = run(resultSuccess("end_turn"));
    expect(evs.map((e) => e.type)).toEqual(["turn.done"]);
  });

  it("a malformed (non-object) subagent_stats is ignored, never thrown (Tenet 6)", () => {
    const wire: unknown = { ...resultSuccess("end_turn"), subagent_stats: "nope" };
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(wire)), ...n.flush()];
    expect(evs.map((e) => e.type)).toEqual(["turn.done"]);
  });
});

describe("createClaudeNormalizer — thinking_delta.estimated_tokens (runtime-only; Fable 5.1 display:omitted) → reasoning.delta providerMetadata", () => {
  type SDKPartial = Extract<SDKMessage, { type: "stream_event" }>;
  type StreamEvent = SDKPartial["event"];
  const frame = (event: StreamEvent): SDKMessage => ({
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-0000000000d1",
    session_id: "sess_fixture",
  });
  const start: StreamEvent = { type: "message_start", message: { ...betaMessage([]), id: "msg_fable_1" } };
  const cbStartThinking: StreamEvent = {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  };
  const thinkingDelta = (extra: Record<string, unknown>): unknown => ({
    ...frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } }),
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "", ...extra } },
  });

  function reasoningDeltas(deltas: unknown[]): Array<{ delta: string; providerMetadata?: unknown }> {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(frame(start))),
      ...n.push(JsonValue.parse(frame(cbStartThinking))),
      ...deltas.flatMap((d) => n.push(JsonValue.parse(d))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    return evs.filter((e) => e.type === "reasoning.delta") as Array<{ delta: string; providerMetadata?: unknown }>;
  }

  it("carries a numeric estimate verbatim and a null estimate as null (both are real wire values)", () => {
    const out = reasoningDeltas([thinkingDelta({ estimated_tokens: 50 }), thinkingDelta({ estimated_tokens: null })]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ delta: "", providerMetadata: { estimated_tokens: 50 } });
    expect(out[1]).toMatchObject({ delta: "", providerMetadata: { estimated_tokens: null } });
  });

  it("emits NO providerMetadata key when the delta carries no estimated_tokens (pre-Fable wire, byte-identical)", () => {
    const out = reasoningDeltas([thinkingDelta({})]);
    expect(out).toHaveLength(1);
    expect("providerMetadata" in out[0]!).toBe(false);
  });
});
