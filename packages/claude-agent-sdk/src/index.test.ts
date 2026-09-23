import type { UUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
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

// INV-TURN (per-turn ids, sp-protocol ruling B, 2026-09-23): a top-level turn
// is named by the frame that OPENS it, never by the session. Most fixtures
// open on `assistantMsg` (message id "msg_fixture_1"); a turn a result frame
// opens by itself (no assistant frame first) is named by that result's uuid.
const TOP_TURN = "turn_msg_fixture_1";
const RESULT_ONLY_TURN = "turn_00000000-0000-0000-0000-000000000002";

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
  it("maps a result success to turn.done with finishReason stop (a result-only turn opens with its own turn.start, INV-TURN)", () => {
    const evs = run(resultSuccess("end_turn"));
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "turn.done"]);
    expect(evs[1]).toMatchObject({
      type: "turn.done",
      turnId: RESULT_ONLY_TURN,
      finishReason: "stop",
      outcome: { type: "success", result: "all done" },
    });
    assertAllValid(evs);
  });
});

// ─── draft.4: turn.done.finishReasonRaw on a FALLBACK finishReason ──────────
// SPEC §8.0 graceful degradation / §10 item 23 (sp-protocol 89c57db): a
// stop_reason the facet cannot map falls back to "unknown", and the native value
// rides `finishReasonRaw` verbatim. Only on the fallback.
describe("createClaudeNormalizer — finishReasonRaw (draft.4)", () => {
  it("an unmapped stop_reason → finishReason 'unknown' + finishReasonRaw verbatim; every event parses", () => {
    const evs = run(resultSuccess("zz_future"));
    assertAllValid(evs);
    expect(evs[1]).toMatchObject({ type: "turn.done", finishReason: "unknown", finishReasonRaw: "zz_future" });
    // It folds onto the turn record (SPEC §5 turn.done row).
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns[0]).toMatchObject({ finishReason: "unknown", finishReasonRaw: "zz_future" });
  });

  it("NEGATIVE CONTROL: a mapped stop_reason and a null one carry NO finishReasonRaw key (byte-identical to draft.3 output)", () => {
    for (const stop of ["end_turn", "stop_sequence", "max_tokens", "tool_use", "pause_turn", "refusal", "compaction", "model_context_window_exceeded", null]) {
      const evs = run(resultSuccess(stop));
      assertAllValid(evs);
      expect(evs[1]?.type).toBe("turn.done");
      expect("finishReasonRaw" in (evs[0] as object), `stop_reason ${String(stop)}`).toBe(false);
    }
  });
});

// ─── INV-TURN: a RESULT-ONLY turn is opened, not only closed (sp-protocol) ───
// Through the B commit a result with no preceding assistant frame / notice /
// stream emitted a lone terminal, and reduce() minted a stub record whose
// threadId was the turnId. Every turn is now opened by exactly one turn.start.
describe("createClaudeNormalizer — result-only turns open with a turn.start (INV-TURN)", () => {
  function pushAll(frames: unknown[]): AgEvent[] {
    const n = createClaudeNormalizer();
    const evs = [...frames.flatMap((f) => n.push(JsonValue.parse(f))), ...n.flush()];
    assertAllValid(evs);
    return evs;
  }

  it("a RESUMED invoke's leading tool_result (the deferred call's, before init) opens the turn; the invoke's reply joins it; one close; no park", () => {
    // Frame order from sp-probe's live defer-tool-sonnet5-resume-allow capture.
    const leading: unknown = {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_deferred_leg1", content: [{ type: "text", text: "echoed" }] }] },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000f1",
      session_id: "sess_fork",
    };
    const evs = pushAll([
      { type: "command_lifecycle", command_uuid: "c1", state: "started", uuid: "00000000-0000-0000-0000-0000000000f0", session_id: "sess_fork" },
      leading,
      { type: "system", subtype: "init", uuid: "00000000-0000-0000-0000-0000000000f2", session_id: "sess_fork" },
      assistantMsg([{ type: "text", text: "Done.", citations: null }]),
      resultSuccess("end_turn"),
    ]);
    const turnId = "turn_00000000-0000-0000-0000-0000000000f1";
    const types = evs.map((e) => e.type);
    expect(types.indexOf("turn.start")).toBeLessThan(types.indexOf("tool.done"));
    expect(evs.filter((e) => e.type === "turn.start")).toEqual([expect.objectContaining({ turnId, threadId: "sess_fork" })]);
    expect(evs.find((e) => e.type === "tool.done")).toMatchObject({ turnId, toolCallId: "toolu_deferred_leg1" });
    expect(evs.filter((e) => e.type === "turn.done")).toEqual([expect.objectContaining({ turnId })]);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.map((t) => t.turnId)).toEqual([turnId]);
  });

  it("both arms: exactly one turn.start (threadId = the session) before the close; the fold records the real thread root", () => {
    for (const frame of [resultSuccess("end_turn"), resultError("error_max_turns")]) {
      const evs = pushAll([frame]);
      const starts = evs.filter((e) => e.type === "turn.start");
      expect(starts).toHaveLength(1);
      expect(evs[0]).toMatchObject({ type: "turn.start", threadId: "sess_fixture" });
      const r = new Reducer();
      for (const e of evs) r.push(e);
      expect(r.needsResync).toBe(false);
      const turn = r.result().turns[0];
      expect(turn?.threadId).toBe("sess_fixture");
      expect(turn?.threadId).not.toBe(turn?.turnId);
    }
  });

  it("with denials the carrier does not open a second turn.start (the turn is already open)", () => {
    const evs = pushAll([resultWithDenial()]);
    expect(evs.filter((e) => e.type === "turn.start")).toHaveLength(1);
    expect(evs[0]?.type).toBe("turn.start");
  });

  it("a turn an assistant frame opened is NOT re-opened by its result (one turn.start per turn)", () => {
    const evs = pushAll([assistantMsg([{ type: "text", text: "hi", citations: null }]), resultSuccess("end_turn")]);
    expect(evs.filter((e) => e.type === "turn.start")).toHaveLength(1);
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
  it("maps a user tool_result to tool.done with mcp content + outcome; with NO turn open it OPENS one first (INV-TURN)", () => {
    const evs = run(toolResultMsg());
    // A lone top-level tool_result (e.g. a resumed invoke's first frame) opens
    // the turn it lands in, named by the frame's uuid; flush then closes that
    // still-open turn as INV-FLUSH's abort.
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "tool.done", "turn.abort"]);
    const turnId = "turn_00000000-0000-0000-0000-000000000003";
    expect(evs[0]).toMatchObject({ type: "turn.start", turnId, threadId: "sess_fixture" });
    expect(evs[1]).toMatchObject({
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
      turnId,
    });
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
    // The subagent.start seeds the nested turn, so openMessage does NOT
    // synthesize a turn.start. B-strict: the run never got its Task result, so
    // flush closes it with its nested terminal, immediately before subagent.done.
    expect(evs.map((e) => e.type)).toEqual([
      "subagent.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.end",
      "turn.abort",
      "subagent.done",
    ]);
    expect(evs.find((e) => e.type === "turn.abort")).toMatchObject({ turnId: TOP_TURN, reason: "stream-truncated" });
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
    // INV-TURN (B): the nested turn is named by its subagent run's first
    // message id (one nested turn per spawning Task call), the top-level turn by
    // its first message id — never by either session.
    expect(innerDone).toMatchObject({
      type: "tool.done",
      turnId: "turn_msg_sub_1", // NOT "turn_toolu_task"
      messageId: `${INNER_TOOL_ID}:result`,
    });

    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);
    const result = r.result();
    expect(result.turns.map((t) => t.turnId).sort()).toEqual(["turn_msg_sub_1", "turn_msg_top_1"].sort());
    const subTurn = result.turns.find((t) => t.turnId === "turn_msg_sub_1");
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
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "turn.error"]);
    expect(evs[1]).toMatchObject({
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
    expect(msgStart).toMatchObject({ type: "message.start", id: `${RESULT_ONLY_TURN}:denials` });
    const msgEnd = evs.find((e) => e.type === "message.end");
    expect(msgEnd).toMatchObject({ type: "message.end", id: `${RESULT_ONLY_TURN}:denials` });
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

// ─── permission_denials on an ERROR-subtype result (persona queue item 1) ────
// SDKResultError declares permission_denials too (e.g. error_max_turns after a
// denied tool). Through 0.6.4 only the success arm emitted the carrier, so an
// error-subtype result dropped its denials. Both arms now share one carrier,
// emitted at the same point: after the seal, before result-meta and the close.
describe("createClaudeNormalizer — permission_denials on an error-subtype result", () => {
  const ERROR_RESULT_TURN = "turn_00000000-0000-0000-0000-000000000004";
  const DENIALS = [
    { tool_name: "bash", tool_use_id: "toolu_denied_1", tool_input: { command: "rm -rf /" } },
    { tool_name: "Read", tool_use_id: "toolu_denied_2", tool_input: { file_path: "/etc/passwd" } },
  ];
  const errorWithDenials = (extra: { [k: string]: unknown } = {}): unknown => ({
    ...resultError("error_max_turns"),
    permission_denials: DENIALS,
    ...extra,
  });
  function drive(frames: unknown[]): AgEvent[] {
    const n = createClaudeNormalizer();
    const evs = [...frames.flatMap((f) => n.push(JsonValue.parse(f))), ...n.flush()];
    assertAllValid(evs);
    return evs;
  }

  it("emits the denials carrier (tool.start + tool.done denied per denial) BEFORE the turn.error, and it folds", () => {
    const evs = drive([errorWithDenials()]);
    expect(evs.map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "tool.start",
      "tool.done",
      "tool.start",
      "tool.done",
      "message.end",
      "turn.error",
    ]);
    expect(evs[1]).toMatchObject({ type: "message.start", id: `${ERROR_RESULT_TURN}:denials`, turnId: ERROR_RESULT_TURN });
    expect(evs.filter((e) => e.type === "tool.done").map((e) => ("outcome" in e ? e.outcome : undefined))).toEqual(["denied", "denied"]);
    expect(evs[7]).toMatchObject({ type: "turn.error", turnId: ERROR_RESULT_TURN, code: "error_max_turns" });
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.map((m) => m.id)).toContain(`${ERROR_RESULT_TURN}:denials`);
    expect(r.result().turns.find((t) => t.turnId === ERROR_RESULT_TURN)?.outcome).toMatchObject({ type: "error" });
  });

  it("MIRROR: the carrier is event-for-event the success arm's (turn id and seq aside)", () => {
    const ok = drive([{ ...resultSuccess("end_turn"), permission_denials: DENIALS }]);
    const err = drive([errorWithDenials()]);
    expect(denialCarrier(err, true)).toEqual(denialCarrier(ok, true));
    expect(denialCarrier(err)).toHaveLength(6);
  });

  it("the live permission_denied enrichment reaches the error arm's carrier too", () => {
    const evs = drive([
      permissionDeniedMsg({ decision_reason_type: "rule", decision_reason: "matches deny-rule" }),
      errorWithDenials(),
    ]);
    const done = evs.find((e) => e.type === "tool.done" && "toolCallId" in e && e.toolCallId === "toolu_denied_1");
    expect(done).toMatchObject({
      outcome: "denied",
      content: [{ type: "text", text: "This command was blocked by a deny rule (no destructive filesystem operations)." }],
      providerMetadata: { decisionReasonType: "rule", decisionReason: "matches deny-rule" },
    });
  });

  it("with a STASHED close (assistant error frame first), the carrier still precedes that one turn.error", () => {
    const evs = drive([apiErrorAssistantFrame(), errorWithDenials()]);
    const closes = turnCloses(evs);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ type: "turn.error", turnId: API_ERROR_TURN, code: "rate_limit" });
    const carrierAt = evs.findIndex((e) => e.type === "message.start" && "id" in e && e.id === `${API_ERROR_TURN}:denials`);
    expect(carrierAt).toBeGreaterThan(-1);
    expect(carrierAt).toBeLessThan(evs.findIndex((e) => e.type === "turn.error"));
  });

  it("NEGATIVE CONTROL: empty denials stay byte-identical; malformed denials are skipped, never thrown on", () => {
    const bare = drive([resultError("error_max_turns")]);
    expect(bare.map((e) => e.type)).toEqual(["turn.start", "turn.error"]);
    expect(JSON.stringify(drive([{ ...resultError("error_max_turns"), permission_denials: [] }]))).toBe(JSON.stringify(bare));
    for (const bad of ["nope", null, 7, [{ tool_name: 1 }], [{ tool_use_id: "x" }], [null]]) {
      expect(() => drive([{ ...resultError("error_max_turns"), permission_denials: bad }])).not.toThrow();
      expect(JSON.stringify(drive([{ ...resultError("error_max_turns"), permission_denials: bad }]))).toBe(JSON.stringify(bare));
    }
    const partial = drive([{ ...resultError("error_max_turns"), permission_denials: [null, DENIALS[0]] }]);
    expect(partial.filter((e) => e.type === "tool.done")).toHaveLength(1);
  });
});

// ─── Tenet 6: a result frame's usage never throws out of push() ─────────────
// sp-protocol, writing §10.23's claude leg: a result whose `usage` lacks
// `server_tool_use` threw a TypeError out of push() (`!== null` let `undefined`
// through to a dereference). SPEC §8.0: a normalizer MUST NOT throw out of push().
describe("createClaudeNormalizer — result usage is shape-guarded (Tenet 6, SPEC §8.0)", () => {
  const LEAN_USAGE = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 };
  const result = (usage: unknown, extra: { [k: string]: unknown } = {}): unknown => ({
    ...(resultSuccess("end_turn") as object),
    usage,
    ...extra,
  });
  function pushAll(frames: unknown[]): AgEvent[] {
    const n = createClaudeNormalizer();
    return [...frames.flatMap((f) => n.push(JsonValue.parse(f))), ...n.flush()];
  }

  it("usage WITHOUT server_tool_use (a leaner producer): no throw, the token usage is kept, serverToolRequests is absent", () => {
    let evs: AgEvent[] = [];
    expect(() => {
      evs = pushAll([result(LEAN_USAGE)]);
    }).not.toThrow();
    assertAllValid(evs);
    const done = evs.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({ usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, costUsd: 0.05 } });
    // The key has always been written as `undefined` when there is no count
    // (as for a null server_tool_use); it drops out on the JSON wire.
    // (byModel entries keep their own per-model count from modelUsage.)
    expect((done as { usage?: { serverToolRequests?: unknown } }).usage?.serverToolRequests).toBeUndefined();
  });

  it("a PARTIAL server_tool_use (one counter) gives no serverToolRequests — never NaN", () => {
    const evs = pushAll([result({ ...LEAN_USAGE, server_tool_use: { web_search_requests: 2 } })]);
    assertAllValid(evs);
    const usage = (evs.find((e) => e.type === "turn.done") as { usage?: { serverToolRequests?: unknown } }).usage;
    expect(usage).toBeDefined();
    expect(usage?.serverToolRequests).toBeUndefined();
  });

  it("usage or modelUsage ABSENT: no throw, the turn still closes once, with no usage key", () => {
    for (const frame of [
      withoutKey(resultSuccess("end_turn"), "usage"),
      withoutKey(resultSuccess("end_turn"), "modelUsage"),
      { ...(resultSuccess("end_turn") as object), total_cost_usd: "0.05" },
    ]) {
      let evs: AgEvent[] = [];
      expect(() => {
        evs = pushAll([frame]);
      }).not.toThrow();
      const closes = turnCloses(evs);
      expect(closes).toHaveLength(1);
      expect(closes[0]).not.toHaveProperty("usage");
    }
  });

  it("the stashed API-error close with a lean usage (no server_tool_use) closes once with that usage, and never throws", () => {
    let evs: AgEvent[] = [];
    expect(() => {
      evs = pushAll([apiErrorAssistantFrame(), result(LEAN_USAGE, { is_error: true, api_error_status: 429 })]);
    }).not.toThrow();
    const closes = turnCloses(evs);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ type: "turn.error", code: "rate_limit", usage: { inputTokens: 100, outputTokens: 50 } });
  });

  it("NEGATIVE CONTROL: the full typed shape still sums both server-tool counters", () => {
    const evs = pushAll([result({ ...LEAN_USAGE, server_tool_use: { web_search_requests: 2, web_fetch_requests: 3 } })]);
    expect(evs.find((e) => e.type === "turn.done")).toMatchObject({ usage: { serverToolRequests: 5 } });
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
  it("a nested tool_result for a run this invoke never opened opens a run named by its frame (INV-TURN), never the synthetic parent label", () => {
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
    // subagent.start opens the run's turn, the tool.done lands in it, and flush
    // closes it (B-strict: turn.abort, then subagent.done).
    expect(evs.map((e) => e.type)).toEqual(["subagent.start", "tool.done", "turn.abort", "subagent.done"]);
    expect(evs[0]).toMatchObject({ turnId: "turn_00000000-0000-0000-0000-000000000003", parentTurnId: "turn_toolu_parent_subagent_1" });
    expect(evs[1]).toMatchObject({
      type: "tool.done",
      toolCallId: "toolu_fixture_1",
      turnId: "turn_00000000-0000-0000-0000-000000000003",
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

  // 0.3.272: `SDKAssistantMessageError` gained TWO more members —
  // `verification_required` (gated on an out-of-band human verification step)
  // and `cloud_credential_error` (a credential/billing-class failure on the
  // cloud-provider leg). Neither clears by re-sending the turn, so both are
  // deliberate non-retriables — recorded explicitly here, exactly like
  // model_not_found / account_on_hold, so the omission can never be read back
  // as an oversight. The code itself is carried VERBATIM either way.
  it("emits turn.error with retriable:false for verification_required (needs an out-of-band human step)", () => {
    const evs = run(assistantMsgWithError("verification_required"));
    expect(evs).toContainEqual(
      expect.objectContaining({
        type: "turn.error",
        code: "verification_required",
        message: "verification_required",
        retriable: false,
      }),
    );
    assertAllValid(evs);
  });

  it("emits turn.error with retriable:false for cloud_credential_error (credential/billing class, not transient capacity)", () => {
    const evs = run(assistantMsgWithError("cloud_credential_error"));
    expect(evs).toContainEqual(
      expect.objectContaining({
        type: "turn.error",
        code: "cloud_credential_error",
        message: "cloud_credential_error",
        retriable: false,
      }),
    );
    assertAllValid(evs);
  });

  // Negative control for the widening: the retriable SET is unchanged by
  // 0.3.272 — exactly the three transient codes stay true, every other member
  // of the (now 13-wide) union stays false.
  it("the retriable set is unchanged by the 0.3.272 widening (three transient codes, ten non-retriable)", () => {
    const RETRIABLE: NonNullable<SDKAssistantError>[] = ["rate_limit", "server_error", "overloaded"];
    const NON_RETRIABLE: NonNullable<SDKAssistantError>[] = [
      "authentication_failed",
      "oauth_org_not_allowed",
      "account_on_hold",
      "verification_required",
      "billing_error",
      "invalid_request",
      "model_not_found",
      "unknown",
      "max_output_tokens",
      "cloud_credential_error",
    ];
    for (const code of RETRIABLE) {
      const err = run(assistantMsgWithError(code)).find((e) => e.type === "turn.error");
      expect(err).toMatchObject({ code, retriable: true });
    }
    for (const code of NON_RETRIABLE) {
      const err = run(assistantMsgWithError(code)).find((e) => e.type === "turn.error");
      expect(err).toMatchObject({ code, retriable: false });
    }
  });
});

// ─── INV-TURN: one turnId names exactly one turn (sp-protocol ruling B) ──────
// Through 0.6.4 every top-level turn was `turn_${session_id}`, so in a
// multi-turn invoke the second turn's message.start and content landed on T
// AFTER turn.done(T) (no second turn.start: the assembler's seen-turn set
// suppressed it), breaking INV-TURN (SPEC:743); reduce() merged the session's
// turns into one AgTurnRecord, and a resume (same session_id unless
// forkSession) collided across invokes too. A turn is now named by the frame
// that opens it.
describe("createClaudeNormalizer — INV-TURN: one turnId per turn (B, 2026-09-23)", () => {
  function asst(id: string, text: string, uuid: UUID, parent: string | null = null): SDKMessage {
    return {
      type: "assistant",
      message: { ...betaMessage([{ type: "text", text, citations: null }]), id },
      parent_tool_use_id: parent,
      uuid,
      session_id: "sess_fixture",
    };
  }
  function result(uuid: UUID, isError = false): unknown {
    return { ...resultSuccess("end_turn"), uuid, is_error: isError };
  }
  function events(frames: unknown[]): AgEvent[] {
    const n = createClaudeNormalizer();
    const evs = [...frames.flatMap((f) => n.push(JsonValue.parse(f))), ...n.flush()];
    assertAllValid(evs);
    return evs;
  }
  // INV-TURN as a property of the stream, for TOP-LEVEL turns: each turnId is
  // opened (turn.start) before it closes, gets exactly one terminal, and
  // nothing carries it after that terminal. Nested turns (one subagent.start /
  // subagent.done per run) are checked by `assertOneBracketPerRun` below.
  function assertOneTerminalPerTurn(evs: AgEvent[]): void {
    const opened = new Set<string>();
    const closedAt = new Map<string, number>();
    evs.forEach((e, i) => {
      const t = "turnId" in e && typeof e.turnId === "string" ? e.turnId : undefined;
      if (t === undefined) return;
      if (e.type === "turn.start" || e.type === "subagent.start") opened.add(t);
      const closed = closedAt.get(t);
      expect(closed, `${e.type} on ${t} after its terminal`).toBeUndefined();
      if (e.type === "turn.done" || e.type === "turn.error" || e.type === "turn.abort") {
        expect(opened.has(t), `${e.type} on ${t}, which was never opened`).toBe(true);
        closedAt.set(t, i);
      }
    });
  }
  const turnIds = (evs: AgEvent[], type: string): unknown[] =>
    evs.filter((e) => e.type === type).map((e) => ("turnId" in e ? e.turnId : undefined));

  it("fold: two turns in one invoke are two turns — each opened, closed once (turn.done) and folded as its own record", () => {
    const evs = events([
      asst("msg_t1", "first", "00000000-0000-0000-0000-0000000000b1"),
      result("00000000-0000-0000-0000-0000000000b2"),
      asst("msg_t2", "second", "00000000-0000-0000-0000-0000000000b3"),
      result("00000000-0000-0000-0000-0000000000b4"),
    ]);
    expect(turnIds(evs, "turn.start")).toEqual(["turn_msg_t1", "turn_msg_t2"]);
    expect(turnIds(evs, "turn.done")).toEqual(["turn_msg_t1", "turn_msg_t2"]);
    assertOneTerminalPerTurn(evs);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    expect(res.turns.map((t) => [t.turnId, t.outcome?.type])).toEqual([
      ["turn_msg_t1", "success"],
      ["turn_msg_t2", "success"],
    ]);
    expect(res.turns.every((t) => t.usage !== undefined)).toBe(true);
    expect(res.messages.map((m) => [m.id, m.turnId])).toEqual([
      ["msg_t1", "turn_msg_t1"],
      ["msg_t2", "turn_msg_t2"],
    ]);
  });

  it("fold, every close path in one invoke: success, error-subtype result, API-error stash, then a truncated last turn — each turn keeps its own outcome", () => {
    const apiErrTurn = {
      ...(apiErrorAssistantFrame() as object),
      message: { ...betaMessage([{ type: "text", text: "API Error", citations: null }]), id: "msg_t3", model: "<synthetic>" },
      uuid: "00000000-0000-0000-0000-0000000000b7",
    };
    const evs = events([
      asst("msg_t1", "ok", "00000000-0000-0000-0000-0000000000b1"),
      result("00000000-0000-0000-0000-0000000000b2"),
      asst("msg_t2", "then it failed", "00000000-0000-0000-0000-0000000000b3"),
      { ...resultError("error_during_execution"), uuid: "00000000-0000-0000-0000-0000000000b4" },
      apiErrTurn,
      result("00000000-0000-0000-0000-0000000000b8", true),
      asst("msg_t4", "cut off", "00000000-0000-0000-0000-0000000000b9"),
    ]);
    const closes = turnCloses(evs).map((e) => [e.type, "turnId" in e ? e.turnId : undefined]);
    expect(closes).toEqual([
      ["turn.done", "turn_msg_t1"],
      ["turn.error", "turn_msg_t2"],
      ["turn.error", "turn_msg_t3"],
      ["turn.abort", "turn_msg_t4"],
    ]);
    assertOneTerminalPerTurn(evs);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.map((t) => [t.turnId, t.outcome?.type])).toEqual([
      ["turn_msg_t1", "success"],
      ["turn_msg_t2", "error"],
      ["turn_msg_t3", "error"],
      ["turn_msg_t4", "aborted"],
    ]);
  });

  it("the API-error stash of one turn never closes the next turn (the stash is keyed by its own turn)", () => {
    const apiErr = apiErrorAssistantFrame();
    const evs = events([apiErr, asst("msg_next", "next turn, no result yet", "00000000-0000-0000-0000-0000000000c1")]);
    // No result for the error turn: it is still open when msg_next arrives, so
    // msg_next JOINS it (a turn ends only at its result) and the flush closes
    // that ONE turn with the stashed error.
    expect(turnCloses(evs).map((e) => [e.type, "turnId" in e ? e.turnId : undefined])).toEqual([
      ["turn.error", API_ERROR_TURN],
    ]);
    // With the result in between, the next turn is its own and aborts alone.
    const evs2 = events([apiErr, apiErrorResultFrame(), asst("msg_next", "next", "00000000-0000-0000-0000-0000000000c1")]);
    expect(turnCloses(evs2).map((e) => [e.type, "turnId" in e ? e.turnId : undefined])).toEqual([
      ["turn.error", API_ERROR_TURN],
      ["turn.abort", "turn_msg_next"],
    ]);
    assertOneTerminalPerTurn(evs2);
  });

  it("a streamed turn is named at message_start by the same id the complete frame would give it", () => {
    const n = createClaudeNormalizer();
    const frame = (event: Extract<SDKMessage, { type: "stream_event" }>["event"]): unknown => ({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000d2",
      session_id: "sess_fixture",
    });
    const evs = [
      ...n.push(JsonValue.parse(frame({ type: "message_start", message: { ...betaMessage([]), id: "msg_streamed" } }))),
      ...n.push(JsonValue.parse({ ...asst("msg_streamed", "hi", "00000000-0000-0000-0000-0000000000d3") })),
      ...n.push(JsonValue.parse(result("00000000-0000-0000-0000-0000000000d4"))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(turnIds(evs, "turn.start")).toEqual(["turn_msg_streamed"]);
    expect(turnIds(evs, "turn.done")).toEqual(["turn_msg_streamed"]);
  });

  // Nested INV-TURN (per-run bracket, sp-protocol ruling 2026-09-23): each
  // nested turn opens once (subagent.start) and closes once (subagent.done),
  // with none of its events after that close.
  function assertOneBracketPerRun(evs: AgEvent[], runs: number): void {
    const starts = new Map<string, number>();
    const dones = new Map<string, number>();
    evs.forEach((e, i) => {
      const t = "turnId" in e && typeof e.turnId === "string" ? e.turnId : undefined;
      if (t === undefined) return;
      if (e.type === "subagent.start") {
        expect(starts.has(t), `second subagent.start on ${t}`).toBe(false);
        starts.set(t, i);
      }
      expect(dones.has(t), `${e.type} on ${t} after its subagent.done`).toBe(false);
      if (e.type === "subagent.done") {
        expect(starts.has(t), `subagent.done on ${t}, never opened`).toBe(true);
        dones.set(t, i);
      }
    });
    expect([...dones.keys()].sort()).toEqual([...starts.keys()].sort());
    // Never vacuous: the stream must hold exactly the runs the test expects.
    expect(starts.size).toBe(runs);
  }
  function taskResult(toolUseId: string, uuid: UUID): SDKMessage {
    return {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: "done" }], is_error: false }] },
      parent_tool_use_id: null,
      uuid,
      session_id: "sess_fixture",
    };
  }

  it("nested turns: one per subagent RUN (keyed by parent_tool_use_id), ONE bracket each, never the parentTurnId label; B-strict: unreported runs outlive the parent's close", () => {
    const evs = events([
      asst("msg_top", "delegating", "00000000-0000-0000-0000-0000000000e2"),
      asst("msg_run_a1", "a1", "00000000-0000-0000-0000-0000000000e3", "toolu_task_a"),
      asst("msg_run_a2", "a2", "00000000-0000-0000-0000-0000000000e4", "toolu_task_a"),
      asst("msg_run_b1", "b1", "00000000-0000-0000-0000-0000000000e5", "toolu_task_b"),
      result("00000000-0000-0000-0000-0000000000e6"),
    ]);
    const brackets = evs
      .filter((e) => e.type === "subagent.start" || e.type === "subagent.done")
      .map((e) => [e.type, "turnId" in e ? e.turnId : undefined, "parentTurnId" in e ? e.parentTurnId : undefined]);
    // Neither run got its Task tool_result, so neither closes at the parent's
    // result (B-strict: no outcome the framework never reported). Both close at
    // flush, innermost (latest-opened) first, each with its nested terminal
    // immediately before its subagent.done.
    expect(brackets).toEqual([
      ["subagent.start", "turn_msg_run_a1", "turn_toolu_task_a"],
      ["subagent.start", "turn_msg_run_b1", "turn_toolu_task_b"],
      ["subagent.done", "turn_msg_run_b1", "turn_toolu_task_b"],
      ["subagent.done", "turn_msg_run_a1", "turn_toolu_task_a"],
    ]);
    expect(evs.findIndex((e) => e.type === "turn.done")).toBeLessThan(evs.findIndex((e) => e.type === "subagent.done"));
    for (const [i, e] of evs.entries()) {
      if (e.type === "subagent.done") expect(evs[i - 1]).toMatchObject({ type: "turn.abort", turnId: e.turnId, reason: "stream-truncated" });
    }
    assertOneBracketPerRun(evs, 2);
    // Run a's two messages both belong to its one nested turn.
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.map((t) => t.turnId).sort()).toEqual(["turn_msg_run_a1", "turn_msg_run_b1", "turn_msg_top"]);
    expect(r.result().messages.filter((m) => m.turnId === "turn_msg_run_a1").map((m) => m.id)).toEqual(["msg_run_a1", "msg_run_a2"]);
  });

  it("the spawning Task's tool_result closes its run BEFORE that result's tool.done; parallel runs overlap cleanly", () => {
    const evs = events([
      asst("msg_top", "two tasks in parallel", "00000000-0000-0000-0000-0000000000e2"),
      asst("msg_a1", "a1", "00000000-0000-0000-0000-0000000000e3", "toolu_task_a"),
      asst("msg_b1", "b1", "00000000-0000-0000-0000-0000000000e4", "toolu_task_b"),
      asst("msg_a2", "a2", "00000000-0000-0000-0000-0000000000e5", "toolu_task_a"),
      taskResult("toolu_task_a", "00000000-0000-0000-0000-0000000000e6"),
      asst("msg_b2", "b2", "00000000-0000-0000-0000-0000000000e7", "toolu_task_b"),
      taskResult("toolu_task_b", "00000000-0000-0000-0000-0000000000e8"),
      result("00000000-0000-0000-0000-0000000000e9"),
    ]);
    assertOneBracketPerRun(evs, 2);
    const at = (pred: (e: AgEvent) => boolean): number => evs.findIndex(pred);
    const doneA = at((e) => e.type === "subagent.done" && "turnId" in e && e.turnId === "turn_msg_a1");
    const toolDoneA = at((e) => e.type === "tool.done" && "toolCallId" in e && e.toolCallId === "toolu_task_a");
    expect(doneA).toBeGreaterThan(-1);
    expect(doneA).toBeLessThan(toolDoneA);
    // Run b is still open across run a's close, and b2 folds into it.
    const doneB = at((e) => e.type === "subagent.done" && "turnId" in e && e.turnId === "turn_msg_b1");
    expect(doneB).toBeGreaterThan(at((e) => e.type === "message.start" && "id" in e && e.id === "msg_b2"));
    // The Task results are TOP-LEVEL tool.done events, owned by the top turn
    // even while a run is open (explicit turnId, not the LIFO backfill).
    for (const id of ["toolu_task_a", "toolu_task_b"]) {
      expect(evs.find((e) => e.type === "tool.done" && "toolCallId" in e && e.toolCallId === id)).toMatchObject({ turnId: "turn_msg_top" });
    }
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const byTurn = (t: string): unknown[] => r.result().messages.filter((m) => m.turnId === t).map((m) => m.id);
    expect(byTurn("turn_msg_a1")).toEqual(["msg_a1", "msg_a2"]);
    expect(byTurn("turn_msg_b1")).toEqual(["msg_b1", "msg_b2"]);
  });

  it("flush closes a run the stream ended inside with ONE nested turn.abort{stream-truncated} and ONE subagent.done (B-strict), innermost first", () => {
    const evs = events([
      asst("msg_top", "delegating", "00000000-0000-0000-0000-0000000000e2"),
      asst("msg_a1", "a1", "00000000-0000-0000-0000-0000000000e3", "toolu_task_a"),
    ]);
    assertOneBracketPerRun(evs, 1);
    expect(turnCloses(evs).map((e) => [e.type, "turnId" in e ? e.turnId : undefined])).toEqual([
      ["turn.abort", "turn_msg_a1"],
      ["turn.abort", "turn_msg_top"],
    ]);
    expect(evs.find((e) => e.type === "turn.abort" && e.turnId === "turn_msg_a1")).not.toHaveProperty("usage");
  });

  it("a frame for a run that already CLOSED opens a NEW nested turn: a closed nested id is never reopened", () => {
    const evs = events([
      asst("msg_top", "delegating", "00000000-0000-0000-0000-0000000000e2"),
      asst("msg_a1", "a1", "00000000-0000-0000-0000-0000000000e3", "toolu_task_a"),
      taskResult("toolu_task_a", "00000000-0000-0000-0000-0000000000e6"),
      asst("msg_a1", "late frame, same message id", "00000000-0000-0000-0000-0000000000ea", "toolu_task_a"),
      result("00000000-0000-0000-0000-0000000000e9"),
    ]);
    assertOneBracketPerRun(evs, 2);
    expect(turnIds(evs, "subagent.start")).toEqual(["turn_msg_a1", "turn_00000000-0000-0000-0000-0000000000ea"]);
  });

  function userFrame(parent: string | null, toolUseIds: string[], uuid: UUID): SDKMessage {
    return {
      type: "user",
      message: {
        role: "user",
        content: toolUseIds.map((id) => ({ type: "tool_result" as const, tool_use_id: id, content: [{ type: "text" as const, text: "ok" }], is_error: false })),
      },
      parent_tool_use_id: parent,
      uuid,
      session_id: "sess_fixture",
    };
  }
  function toolUseMsg(id: string, toolUseIds: string[], uuid: UUID, parent: string | null = null): SDKMessage {
    return {
      type: "assistant",
      message: {
        ...betaMessage(toolUseIds.map((t) => ({ type: "tool_use" as const, id: t, name: "Task", input: { prompt: "go" } })), { stop_reason: "tool_use" }),
        id,
      },
      parent_tool_use_id: parent,
      uuid,
      session_id: "sess_fixture",
    };
  }

  it("a background agent's nested tool_result AFTER the parent's result stays in its still-open run (B-strict: the run outlives its parent), and flush closes it", () => {
    const evs = events([
      toolUseMsg("msg_top", ["toolu_x"], "00000000-0000-0000-0000-0000000000f1"),
      userFrame(null, ["toolu_x"], "00000000-0000-0000-0000-0000000000f2"), // async ack: the run never opened yet
      toolUseMsg("msg_n1", ["toolu_bash1"], "00000000-0000-0000-0000-0000000000f3", "toolu_x"),
      result("00000000-0000-0000-0000-0000000000f4"),
      userFrame("toolu_x", ["toolu_bash1"], "00000000-0000-0000-0000-0000000000f5"),
    ]);
    assertOneBracketPerRun(evs, 1);
    const late = evs.find((e) => e.type === "tool.done" && "toolCallId" in e && e.toolCallId === "toolu_bash1");
    expect(late).toMatchObject({ turnId: "turn_msg_n1" });
    expect(turnCloses(evs).map((e) => [e.type, "turnId" in e ? e.turnId : undefined])).toEqual([
      ["turn.done", "turn_msg_top"],
      ["turn.abort", "turn_msg_n1"],
    ]);
    expect(fold(evs).needsResync).toBe(false);
  });

  it("nested-in-nested runs close innermost first, each once; a sub-run's Task result (a NESTED user frame) closes it (S2)", () => {
    const evs = events([
      toolUseMsg("msg_top", ["toolu_x"], "00000000-0000-0000-0000-0000000000f1"),
      toolUseMsg("msg_x1", ["toolu_y"], "00000000-0000-0000-0000-0000000000f3", "toolu_x"),
      asst("msg_y1", "deep", "00000000-0000-0000-0000-0000000000f6", "toolu_y"),
      userFrame("toolu_x", ["toolu_y"], "00000000-0000-0000-0000-0000000000f7"),
      userFrame(null, ["toolu_x"], "00000000-0000-0000-0000-0000000000f8"),
      result("00000000-0000-0000-0000-0000000000f9"),
    ]);
    assertOneBracketPerRun(evs, 2);
    const brackets = evs
      .filter((e) => e.type === "subagent.start" || e.type === "subagent.done")
      .map((e) => [e.type, "turnId" in e ? e.turnId : undefined]);
    expect(brackets).toEqual([
      ["subagent.start", "turn_msg_x1"],
      ["subagent.start", "turn_msg_y1"],
      ["subagent.done", "turn_msg_y1"],
      ["subagent.done", "turn_msg_x1"],
    ]);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
  });

  it("several Task results in ONE user frame close each run before its own tool.done (S3)", () => {
    const evs = events([
      toolUseMsg("msg_top", ["toolu_a", "toolu_b"], "00000000-0000-0000-0000-0000000000f1"),
      asst("msg_a1", "a", "00000000-0000-0000-0000-0000000000f3", "toolu_a"),
      asst("msg_b1", "b", "00000000-0000-0000-0000-0000000000f4", "toolu_b"),
      userFrame(null, ["toolu_a", "toolu_b"], "00000000-0000-0000-0000-0000000000f5"),
      result("00000000-0000-0000-0000-0000000000f9"),
    ]);
    assertOneBracketPerRun(evs, 2);
    for (const [run, tool] of [["turn_msg_a1", "toolu_a"], ["turn_msg_b1", "toolu_b"]] as const) {
      const done = evs.findIndex((e) => e.type === "subagent.done" && "turnId" in e && e.turnId === run);
      const td = evs.findIndex((e) => e.type === "tool.done" && "toolCallId" in e && e.toolCallId === tool);
      expect(done).toBeGreaterThan(-1);
      expect(done).toBeLessThan(td);
    }
  });

  it("a retraction's message.remove names the REMOVED message's own turn, even after overlapping runs close out of order (S4)", () => {
    const refused: SDKMessage = {
      type: "assistant",
      message: { ...betaMessage([{ type: "tool_use", id: "toolu_a", name: "Task", input: {} }, { type: "tool_use", id: "toolu_b", name: "Task", input: {} }], { stop_reason: "tool_use" }), id: "msg_refused_top" },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000f1",
      session_id: "sess_fixture",
    };
    const evs = events([
      refused,
      asst("msg_a1", "a", "00000000-0000-0000-0000-0000000000f3", "toolu_a"),
      asst("msg_b1", "b", "00000000-0000-0000-0000-0000000000f4", "toolu_b"),
      userFrame(null, ["toolu_a"], "00000000-0000-0000-0000-0000000000f5"), // closes A while B is open (LIFO skew)
      {
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        direction: "retry",
        original_model: "claude-a",
        fallback_model: "claude-b",
        request_id: null,
        retracted_message_uuids: ["00000000-0000-0000-0000-0000000000f1"],
        content: "Switched.",
        uuid: "00000000-0000-0000-0000-0000000000fa",
        session_id: "sess_fixture",
      },
    ]);
    expect(evs.find((e) => e.type === "message.remove")).toMatchObject({ id: "msg_refused_top", turnId: "turn_msg_refused_top" });
  });

  it("a notice between turns opens the next turn (named by its uuid), and that turn's assistant frame and result join it", () => {
    const notice: SDKMessage = {
      type: "system",
      subtype: "informational",
      level: "info",
      content: "Resuming after a hook.",
      uuid: "00000000-0000-0000-0000-0000000000f9",
      session_id: "sess_fixture",
    };
    const evs = events([
      asst("msg_t1", "first", "00000000-0000-0000-0000-0000000000b1"),
      result("00000000-0000-0000-0000-0000000000b2"),
      notice,
      asst("msg_t2", "second", "00000000-0000-0000-0000-0000000000b3"),
      result("00000000-0000-0000-0000-0000000000b4"),
    ]);
    const second = "turn_00000000-0000-0000-0000-0000000000f9";
    expect(turnIds(evs, "turn.start")).toEqual(["turn_msg_t1", second]);
    expect(turnIds(evs, "turn.done")).toEqual(["turn_msg_t1", second]);
    assertOneTerminalPerTurn(evs);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.map((m) => [m.id, m.turnId])).toEqual([
      ["msg_t1", "turn_msg_t1"],
      ["00000000-0000-0000-0000-0000000000f9", second],
      ["msg_t2", second],
    ]);
  });

  it("a CLOSED id is never reopened: a late frame reusing a closed turn's message id opens a new turn under its own uuid", () => {
    const evs = events([
      asst("msg_t1", "first", "00000000-0000-0000-0000-0000000000b1"),
      result("00000000-0000-0000-0000-0000000000b2"),
      asst("msg_t1", "late same-id frame", "00000000-0000-0000-0000-0000000000b5"),
      result("00000000-0000-0000-0000-0000000000b6"),
    ]);
    expect(turnIds(evs, "turn.done")).toEqual(["turn_msg_t1", "turn_00000000-0000-0000-0000-0000000000b5"]);
    assertOneTerminalPerTurn(evs);
  });

  it("a result with no uuid (the runtime guard checks only discriminants) gets a positional id, never a shared `turn_undefined`", () => {
    const noUuid = (): unknown => withoutKey(resultSuccess("end_turn"), "uuid");
    const evs = events([noUuid(), noUuid()]);
    const ids = turnIds(evs, "turn.done");
    // DC-10: the positional fallback carries this invoke's random stem.
    expect(ids).toEqual([expect.stringMatching(/^turn_claude_[0-9a-f]{16}_frame_1$/), expect.stringMatching(/^turn_claude_[0-9a-f]{16}_frame_2$/)]);
    expect(ids.some((id) => typeof id === "string" && id.includes("undefined"))).toBe(false);
  });

  it("deterministic from the wire, and distinct across two invokes of one resumed session (same session_id)", () => {
    // The ids come only from the wire (no clock, no randomness), so a replay of
    // the same native gives the same stream; across invokes the ids differ
    // because message ids never repeat, while BOTH invokes carry the same
    // session_id, which is what collided before.
    const invoke1 = [asst("msg_i1", "one", "00000000-0000-0000-0000-0000000000a6"), result("00000000-0000-0000-0000-0000000000a7")];
    const invoke2 = [asst("msg_i2", "two", "00000000-0000-0000-0000-0000000000a8"), result("00000000-0000-0000-0000-0000000000a9")];
    expect(events(invoke1)).toStrictEqual(events(invoke1));
    expect(turnIds(events(invoke1), "turn.done")).toEqual(["turn_msg_i1"]);
    expect(turnIds(events(invoke2), "turn.done")).toEqual(["turn_msg_i2"]);
  });
});

// ─── draft.4 `phase:"interim"` from narration_block_indexes (§8.0 item 27) ───
// rnd 13+17 stage 2, the claude leg (A.6; a SHOULD per the founder's A.10.5
// ruling). A `thinking` block listed in the frame-local narration_block_indexes
// whose text is NON-EMPTY → phase "interim" on that reasoning block: on
// reasoning.start when the frame is complete-form (known before the first
// delta), on reasoning.end when it streamed (the complete frame precedes the
// block's content_block_stop, CB-13). A listed empty block gets no phase.
describe("createClaudeNormalizer — draft.4 phase:'interim' from narration_block_indexes", () => {
  const SIG = "sig_fixture";
  function frame(id: string, content: unknown[], nbi?: number[]): unknown {
    return {
      type: "assistant",
      message: { ...betaMessage([]), id, content },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000d1",
      session_id: "sess_fixture",
      ...(nbi !== undefined ? { narration_block_indexes: nbi } : {}),
    };
  }
  const thinking = (text: string): unknown => ({ type: "thinking", thinking: text, signature: SIG });
  const text = (t: string): unknown => ({ type: "text", text: t, citations: null });
  function drive(frames: unknown[]): AgEvent[] {
    const n = createClaudeNormalizer();
    const evs = [...frames.flatMap((f) => n.push(JsonValue.parse(f))), ...n.flush()];
    assertAllValid(evs);
    return evs;
  }
  const phases = (evs: AgEvent[], type: string): unknown[] =>
    evs.filter((e) => e.type === type).map((e) => ("phase" in e ? e.phase : undefined));

  it("NON-STREAMED: a listed, non-empty thinking block → phase 'interim' on reasoning.start, folded onto the block", () => {
    const evs = drive([frame("msg_n1", [thinking("Checking the config first.")], [0])]);
    expect(phases(evs, "reasoning.start")).toEqual(["interim"]);
    expect(phases(evs, "reasoning.end")).toEqual([undefined]);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages[0]?.content[0]).toMatchObject({ type: "reasoning", phase: "interim" });
  });

  it("a listed but EMPTY thinking block (display 'omitted'; the app-update-fable51 [4] shape) gets NO phase", () => {
    const evs = drive([frame("msg_n2", [thinking("")], [0])]);
    expect(phases(evs, "reasoning.start")).toEqual([undefined]);
    expect(evs.some((e) => "phase" in e)).toBe(false);
  });

  it("only LISTED THINKING blocks: an unlisted thinking block and a listed text block stay unmarked; the index is frame-local", () => {
    const evs = drive([frame("msg_n3", [text("Here is the plan."), thinking("interim note"), thinking("private")], [0, 1])]);
    // index 0 is a text block (not thinking) → no phase; index 1 → interim; index 2 unlisted → none.
    expect(evs.some((e) => e.type === "text.start" && "phase" in e)).toBe(false);
    expect(phases(evs, "reasoning.start")).toEqual(["interim", undefined]);
  });

  it("the index is FRAME-local across a multi-frame message (the CLI's one-block-per-frame shape): frame 2's [0] is its own thinking block", () => {
    const evs = drive([frame("msg_n5", [text("Let me check.")]), frame("msg_n5", [thinking("Checking the logs now.")], [0])]);
    expect(evs.some((e) => e.type === "text.start" && "phase" in e)).toBe(false);
    expect(phases(evs, "reasoning.start")).toEqual(["interim"]);
  });

  it("NEGATIVE CONTROL: no narration_block_indexes → no phase key anywhere (the unchanged goldens prove byte-identity)", () => {
    const evs = drive([frame("msg_n4", [thinking("some thought")])]);
    expect(evs.some((e) => "phase" in e)).toBe(false);
  });

  describe("STREAMED", () => {
    type SE = Extract<SDKMessage, { type: "stream_event" }>["event"];
    const se = (event: SE): unknown => ({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000d2",
      session_id: "sess_fixture",
    });
    const start = se({ type: "message_start", message: { ...betaMessage([]), id: "msg_s1" } });
    const cbStart = se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
    const delta = (t: string): unknown => se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: t } });
    const sigDelta = se({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: SIG } });
    const stop = se({ type: "content_block_stop", index: 0 });

    it("a listed block with non-empty streamed text → phase 'interim' on reasoning.end (the complete frame precedes the stop), folded", () => {
      const evs = drive([start, cbStart, delta("Now running "), delta("the tests."), sigDelta, frame("msg_s1", [thinking("Now running the tests.")], [0]), stop]);
      expect(phases(evs, "reasoning.start")).toEqual([undefined]);
      expect(phases(evs, "reasoning.end")).toEqual(["interim"]);
      const r = new Reducer();
      for (const e of evs) r.push(e);
      expect(r.needsResync).toBe(false);
      expect(r.result().messages.find((m) => m.id === "msg_s1")?.content[0]).toMatchObject({ type: "reasoning", phase: "interim" });
    });

    it("a listed block whose streamed text is EMPTY gets no phase", () => {
      const evs = drive([start, cbStart, delta(""), sigDelta, frame("msg_s1", [thinking("")], [0]), stop]);
      expect(evs.some((e) => "phase" in e)).toBe(false);
    });

    it("resolves to the RIGHT stream block when it is not index 0 (a text block streamed first); the estimated_tokens delta path counts as text", () => {
      const cbText = se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } });
      const textDelta = se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Plan:" } });
      const stop0 = se({ type: "content_block_stop", index: 0 });
      const cbThink1 = se({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } });
      const delta1 = {
        ...(se({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "" } }) as object),
        event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Running the suite.", estimated_tokens: 12 } },
      };
      const sig1 = se({ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: SIG } });
      const stop1 = se({ type: "content_block_stop", index: 1 });
      const evs = drive([start, cbText, textDelta, frame("msg_s1", [text("Plan:")]), stop0, cbThink1, delta1, sig1, frame("msg_s1", [thinking("Running the suite.")], [0]), stop1]);
      const ends = evs.filter((e) => e.type === "reasoning.end");
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ id: "msg_s1:reasoning:1", phase: "interim" });
      expect(evs.some((e) => e.type === "text.end" && "phase" in e)).toBe(false);
    });

    it("a frame naming an ALREADY-SEALED block never marks the next open block (review MINOR 1)", () => {
      const cbThink1 = se({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } });
      const delta1 = se({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "B" } });
      const stop1 = se({ type: "content_block_stop", index: 1 });
      const evs = drive([start, cbStart, delta("A"), stop, cbThink1, delta1, frame("msg_s1", [thinking("A")], [0]), stop1]);
      expect(evs.some((e) => "phase" in e)).toBe(false);
    });

    it("Tenet 6: a thinking start or delta with no `thinking` key never throws", () => {
      const bareStart = se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
      const malformedStart = { ...(bareStart as object), event: { type: "content_block_start", index: 0, content_block: { type: "thinking", signature: "" } } };
      const malformedDelta = { ...(bareStart as object), event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta" } } };
      // push() itself must not throw (the new `.length` reads are typeof-guarded).
      // Event validity of a malformed delta is a separate, pre-existing matter.
      const n = createClaudeNormalizer();
      expect(() => {
        for (const f of [start, malformedStart, malformedDelta, frame("msg_s1", [thinking("x")], [0]), stop]) n.push(JsonValue.parse(f));
        n.flush();
      }).not.toThrow();
    });

    it("a complete frame arriving AFTER the block's stop (CB-13 violated) leaves phase absent — never a post-seal event", () => {
      const evs = drive([start, cbStart, delta("late marker"), sigDelta, stop, frame("msg_s1", [thinking("late marker")], [0])]);
      expect(evs.some((e) => "phase" in e)).toBe(false);
      expect(evs.filter((e) => e.type === "reasoning.end")).toHaveLength(1);
    });
  });
});

// ─── SDKUserMessageReplay (`isReplay: true`) emits no core event ─────────────
// sp-rnd lead (2026-09-23). Two hazards, both confirmed on fixtures before the fix:
//  - the realistic one: a replay ack landing MID-STREAM ran closePendingMessage()
//    and split the streaming message (test in the stream_event describe below);
//  - the defensive one: a replayed tool_result re-emitted `tool.done`, which after
//    its turn's `turn.done` parked the fold for the rest of the stream (INV-MSG) and
//    in a fresh normalizer parked from the first event. No 0.3.280 CLI replay
//    builder carries tool_results (its history filter requires !toolUseResult), so
//    this half is fixture-only.
describe("createClaudeNormalizer — replayed user frames (isReplay) re-emit nothing", () => {
  function asst(id: string, content: BetaMessage["content"], stop: BetaMessage["stop_reason"], uuid: UUID): SDKMessage {
    return {
      type: "assistant",
      message: { ...betaMessage(content, { stop_reason: stop }), id },
      parent_tool_use_id: null,
      uuid,
      session_id: "sess_fixture",
    };
  }
  const toolUse = (): SDKMessage =>
    asst("msg_tool", [{ type: "tool_use", id: "toolu_fixture_1", name: "Read", input: { path: "a" } }], "tool_use", "00000000-0000-0000-0000-0000000000c1");
  const answer = (): SDKMessage =>
    asst("msg_answer", [{ type: "text", text: "It is 42.", citations: null }], "end_turn", "00000000-0000-0000-0000-0000000000c2");
  const nextTurn = (): SDKMessage =>
    asst("msg_next", [{ type: "text", text: "Next turn.", citations: null }], "end_turn", "00000000-0000-0000-0000-0000000000c3");
  // The replay of `toolResultMsg()`'s tool_result: same content, its own uuid.
  // `flaglessTwin()` is the SAME frame minus `isReplay`, so the negative controls
  // below differ from the replay by the flag alone (not by isSynthetic or uuid).
  const replayContent = (): UserContent => [
    { type: "tool_result", tool_use_id: "toolu_fixture_1", content: [{ type: "text", text: "42" }], is_error: false },
  ];
  function replayedToolResult(): SDKMessage {
    return {
      type: "user",
      message: { role: "user", content: replayContent() },
      parent_tool_use_id: null,
      isSynthetic: true,
      uuid: "00000000-0000-0000-0000-0000000000c4",
      session_id: "sess_fixture",
      isReplay: true,
    };
  }
  function flaglessTwin(): SDKMessage {
    return {
      type: "user",
      message: { role: "user", content: replayContent() },
      parent_tool_use_id: null,
      isSynthetic: true,
      uuid: "00000000-0000-0000-0000-0000000000c4",
      session_id: "sess_fixture",
    };
  }
  function events(frames: SDKMessage[]): AgEvent[] {
    const n = createClaudeNormalizer();
    const evs: AgEvent[] = [];
    for (const f of frames) evs.push(...n.push(JsonValue.parse(f)));
    evs.push(...n.flush());
    assertAllValid(evs);
    return evs;
  }
  function fold(evs: AgEvent[]): Reducer {
    const r = new Reducer();
    for (const e of evs) r.push(e);
    return r;
  }

  it("fold: a replay AFTER turn.done no longer parks — the next turn still folds", () => {
    const evs = events([toolUse(), toolResultMsg(), answer(), resultSuccess("end_turn"), replayedToolResult(), nextTurn(), resultSuccess("end_turn")]);
    expect(evs.filter((e) => e.type === "tool.done")).toHaveLength(1);
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    const result = r.result();
    expect(result.messages.map((m) => m.id)).toEqual(["msg_tool", "toolu_fixture_1:result", "msg_answer", "msg_next"]);
    // INV-TURN (B): the two turns are two records, each named by its first
    // message and closed once, so the second turn no longer folds into the first.
    expect(result.turns.map((t) => [t.turnId, t.outcome?.type])).toEqual([
      ["turn_msg_tool", "success"],
      ["turn_msg_next", "success"],
    ]);
  });

  it("fold: a fresh (resumed) normalizer whose first frame is a replay emits nothing and folds the turn that follows", () => {
    const evs = events([replayedToolResult(), nextTurn(), resultSuccess("end_turn")]);
    expect(evs.some((e) => e.type === "tool.done")).toBe(false);
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.map((m) => m.id)).toEqual(["msg_next"]);
  });

  it("a replay inside its still-open turn is a pure no-op (byte-identical to the stream without it)", () => {
    const base = events([toolUse(), toolResultMsg(), answer(), resultSuccess("end_turn")]);
    const withReplay = events([toolUse(), toolResultMsg(), replayedToolResult(), answer(), resultSuccess("end_turn")]);
    expect(withReplay).toStrictEqual(base);
  });

  it("a replay interleaved between two frames of ONE assistant message does not split it", () => {
    // guuey#26 continuation: two frames sharing an SDK message id fold as one
    // message. The replay returns before `closePendingMessage()`, so it cannot
    // seal the first frame early.
    const part1 = asst("msg_split", [{ type: "text", text: "part one", citations: null }], null, "00000000-0000-0000-0000-0000000000c5");
    const part2 = asst("msg_split", [{ type: "text", text: "part two", citations: null }], "end_turn", "00000000-0000-0000-0000-0000000000c6");
    const base = events([part1, part2, resultSuccess("end_turn")]);
    const withReplay = events([part1, replayedToolResult(), part2, resultSuccess("end_turn")]);
    expect(withReplay).toStrictEqual(base);
    expect(withReplay.filter((e) => e.type === "message.start")).toHaveLength(1);
  });

  it("negative control: the SAME frame with the flag absent, or `isReplay: false`, still emits its tool.done", () => {
    // Absent: the key is not there at all (a plain SDKUserMessage).
    const absent = events([toolUse(), flaglessTwin()]);
    expect(absent.filter((e) => e.type === "tool.done")).toHaveLength(1);
    // `isReplay: false` is a real CLI shape: the compact-summary builder stamps
    // `isReplay: !e.isCompactSummary` (CLI 2.1.280). Only `=== true` is a replay.
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(toolUse())), ...n.push(JsonValue.parse({ ...flaglessTwin(), isReplay: false })), ...n.flush()];
    assertAllValid(evs);
    expect(evs.filter((e) => e.type === "tool.done")).toHaveLength(1);
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

  // ─── X4 (sp-rnd re-cut, 2026-09-23): the rest of the frame rides the carry ──
  // Through 0.6.3 only `retracted_message_uuids` was read; the switch itself
  // (models, direction, scope, refusal category/explanation, the edit-and-retry
  // uuid, `content`) was dropped. The whole frame now rides
  // `ext.anthropic.frame{kind:"model_refusal_fallback"}`, beside its
  // no-fallback sibling (SPEC §8 item 22 / §12), after the removes.

  // Every 0.3.280 field set (sdk.d.ts :5192-5223), including the optional ones
  // the older fixture above leaves out.
  function refusalFallbackNoticeFull(retracted: string[]): SDKMessage {
    return {
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      scope: "local",
      original_model: "claude-a",
      fallback_model: "claude-b",
      request_id: "req_fixture_1",
      api_refusal_category: "cyber",
      api_refusal_explanation: "The request asked for working exploit code.",
      retracted_message_uuids: retracted,
      refused_user_message_uuid: "00000000-0000-0000-0000-0000000000f4",
      content: "Switched to claude-b after a refusal.",
      uuid: NOTICE_UUID,
      session_id: "sess_fixture",
    };
  }

  // An older CLI's frame: every optional field absent.
  function refusalFallbackNoticeOldCli(): SDKMessage {
    return {
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      original_model: "claude-a",
      fallback_model: "claude-b",
      request_id: null,
      content: "Switched to a fallback model.",
      uuid: NOTICE_UUID,
      session_id: "sess_fixture",
    };
  }

  it("carries the WHOLE fallback frame verbatim as ext.anthropic.frame{kind:model_refusal_fallback}, after its removes", () => {
    const notice = refusalFallbackNoticeFull([REFUSED_UUID]);
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(refusedAssistant())),
      ...n.push(JsonValue.parse(notice)),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const frames = evs.filter((e) => e.type === "ext.anthropic.frame");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "model_refusal_fallback" });
    // Verbatim: every field of the native frame, no reinterpretation, no
    // camelCasing (the item-22 contract).
    expect((frames[0] as { frame?: unknown }).frame).toEqual(notice);
    // Order: the retraction first, then the carry (the native frame is itself
    // "emitted AFTER the retraction").
    const removeAt = evs.findIndex((e) => e.type === "message.remove");
    const frameAt = evs.findIndex((e) => e.type === "ext.anthropic.frame");
    expect(removeAt).toBeGreaterThanOrEqual(0);
    expect(removeAt).toBeLessThan(frameAt);
    expect(evs[removeAt]).toMatchObject({ id: "msg_refused" });
  });

  it("an older CLI's frame (no retracted_message_uuids / scope / refusal fields) removes nothing and carries only what arrived", () => {
    const notice = refusalFallbackNoticeOldCli();
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(notice)), ...n.flush()];
    assertAllValid(evs);
    expect(evs.some((e) => e.type === "message.remove")).toBe(false);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "ext.anthropic.frame", kind: "model_refusal_fallback" });
    const frame = (evs[0] as { frame?: unknown }).frame;
    expect(frame).toEqual(notice);
    // Absent stays absent: the facet does not default `scope` to 'session'
    // (the d.ts's reading for an older CLI) or fabricate null refusal fields.
    for (const k of ["scope", "api_refusal_category", "api_refusal_explanation", "refused_user_message_uuid", "retracted_message_uuids"]) {
      expect(Object.keys(frame as object)).not.toContain(k);
    }
  });

  it("negative control: a superseding assistant frame with NO notice emits no model_refusal_fallback carry", () => {
    // The carry is tied to the notice frame. `supersedes` alone keeps its
    // existing eviction and never gets a fabricated switch record.
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(refusedAssistant())),
      ...n.push(JsonValue.parse(fallbackAssistant([REFUSED_UUID]))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(evs.some((e) => e.type === "ext.anthropic.frame")).toBe(false);
    expect(evs).toContainEqual(expect.objectContaining({ type: "message.remove", id: "msg_refused" }));
  });

  it("a notice that arrives AFTER the result frame still carries once and does not park the fold", () => {
    // `emitExt` stamps only `seq` (no turnId/messageId), so an ext frame after
    // the turn's close has no owner to violate; the late remove was already
    // legal (item 19). Pins the ordering the SDK does not promise.
    const n = createClaudeNormalizer();
    const events = [
      ...n.push(JsonValue.parse(refusedAssistant())),
      ...n.push(JsonValue.parse(fallbackAssistant([REFUSED_UUID]))),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.push(JsonValue.parse(refusalFallbackNoticeFull([REFUSED_UUID]))),
      ...n.flush(),
    ];
    assertAllValid(events);
    expect(events.filter((e) => e.type === "ext.anthropic.frame")).toHaveLength(1);
    const doneAt = events.findIndex((e) => e.type === "turn.done");
    const frameAt = events.findIndex((e) => e.type === "ext.anthropic.frame");
    expect(doneAt).toBeLessThan(frameAt);
    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.map((m) => m.id)).toEqual(["msg_fallback"]);
  });

  it("fold: the carried frame is non-folding — refused leg gone, fallback leg the only message, turn closes success, no resync", () => {
    const n = createClaudeNormalizer();
    const events = [
      ...n.push(JsonValue.parse(refusedAssistant())),
      ...n.push(JsonValue.parse(fallbackAssistant([REFUSED_UUID]))),
      ...n.push(JsonValue.parse(refusalFallbackNoticeFull([REFUSED_UUID]))),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.flush(),
    ];
    assertAllValid(events);
    expect(events.filter((e) => e.type === "ext.anthropic.frame")).toHaveLength(1);
    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);
    const result = r.result();
    // The ext frame adds no row (no notice message, no ghost of the refused leg).
    expect(result.messages.map((m) => m.id)).toEqual(["msg_fallback"]);
    // The turn is named by its first (refused) message, which the retraction removed.
    expect(result.turns.find((t) => t.turnId === "turn_msg_refused")?.outcome).toMatchObject({ type: "success" });
  });
});

// ─── SDKInformationalMessage — first-class `notice` message (spec draft.2) ────
// The fixture-drift ratchet's FLAGSHIP finding (2026-07-03) established this
// frame is genuinely conversation/UX-relevant, and draft.1 parked it in the
// `ext.anthropic.informational` lossless carry pending "a first-class notice
// core event" (old SPEC §8.0 item 21). draft.2 resolved that deferral
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
  it("a nested tool.done with no frame uuid lands in a run opened under this invoke's fallback stem, parented by the spawning call's label", () => {
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
    const start = evs.find((e) => e.type === "subagent.start");
    expect(start).toMatchObject({ parentTurnId: "turn_toolu_parent", turnId: expect.stringMatching(/^turn_claude_[0-9a-f]{16}_frame_1$/) });
    expect(done).toMatchObject({ turnId: start !== undefined && "turnId" in start ? start.turnId : "missing" });
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

// X4 (2026-09-23): the half-mapped fallback arm. Its retraction names a uuid a
// fresh normalizer never saw, so `message.remove` is a no-op (item 19) and the
// uniform carry is the ONLY event — the same shape the table below pins for
// every fully carried arm. The describe block above covers the mapped half.
function modelRefusalFallbackMsg(): SDKMessage {
  return {
    type: "system",
    subtype: "model_refusal_fallback",
    trigger: "refusal",
    direction: "retry",
    scope: "session",
    original_model: "claude-opus-test",
    fallback_model: "claude-fallback-test",
    request_id: "req_124",
    api_refusal_category: null,
    api_refusal_explanation: null,
    retracted_message_uuids: ["00000000-0000-0000-0000-0000000000a5"],
    refused_user_message_uuid: null,
    content: "Switched to claude-fallback-test after a refusal.",
    uuid: "00000000-0000-0000-0000-0000000000a4",
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
  // X4: carried AND mapped (its retraction -> message.remove, a no-op here).
  { armName: "SDKModelRefusalFallbackMessage", kind: "model_refusal_fallback", msg: modelRefusalFallbackMsg() },
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

// ─── runtime-only top-level frame types ride the uniform carry ───────────────
// The frames below are VERBATIM from corpus/multi-result-sonnet5 (sp-probe's
// live streaming-input capture, claude-sonnet-5 @0.3.280): `command_lifecycle`
// is not a member of the 0.3.280 SDKMessage union, so no d.ts diff saw it, and
// the facet dropped it silently until the unknown-type net.
describe("createClaudeNormalizer — runtime-only top-level types (command_lifecycle) ride ext.anthropic.frame", () => {
  const SESSION = "17edf6d0-c55c-47c1-a79c-a2941b3b8432";
  const lifecycle = (state: string, uuid: string): unknown => ({
    type: "command_lifecycle",
    command_uuid: "39a0ff85-af78-4b53-add6-a2a9cbd21c57",
    state,
    uuid,
    session_id: SESSION,
  });
  const QUEUED = lifecycle("queued", "600f9197-3843-4bee-8ae1-303a2d58e3c3");
  const STARTED = lifecycle("started", "c3d06780-d739-49c4-9020-a5cb8ac46b8b");
  const COMPLETED = lifecycle("completed", "9294d414-e5aa-42ea-a69e-41f3e6e1750c");

  it("each live frame → exactly one ext.anthropic.frame{kind:'command_lifecycle'}, verbatim, no park", () => {
    for (const f of [QUEUED, STARTED, COMPLETED]) {
      const n = createClaudeNormalizer();
      const evs = [...n.push(JsonValue.parse(f)), ...n.flush()];
      assertAllValid(evs);
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({ type: "ext.anthropic.frame", kind: "command_lifecycle" });
      expect((evs[0] as { frame?: unknown }).frame).toEqual(f);
      const r = new Reducer();
      for (const e of evs) r.push(e);
      expect(r.needsResync).toBe(false);
    }
  });

  it("the live ordering (queued, started, the turn, result, completed) folds one turn, closed once, no resync", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(QUEUED)),
      ...n.push(JsonValue.parse(STARTED)),
      ...n.push(JsonValue.parse(assistantMsg([{ type: "text", text: "done", citations: null }]))),
      ...n.push(JsonValue.parse(resultSuccess("end_turn"))),
      ...n.push(JsonValue.parse(COMPLETED)),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(evs.filter((e) => e.type === "ext.anthropic.frame").map((e) => (e as { frame?: { state?: string } }).frame?.state)).toEqual([
      "queued",
      "started",
      "completed",
    ]);
    expect(evs.filter((e) => e.type === "turn.done")).toHaveLength(1);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.map((t) => t.outcome?.type)).toEqual(["success"]);
  });

  it("NEGATIVE CONTROL: a KNOWN router-plane type still emits nothing (the net covers only undeclared types)", () => {
    for (const f of [
      { type: "rate_limit_event", rate_limit_info: { status: "allowed" }, uuid: "00000000-0000-0000-0000-0000000000b1", session_id: SESSION },
      { type: "tool_progress", tool_use_id: "toolu_x", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 1, uuid: "00000000-0000-0000-0000-0000000000b2", session_id: SESSION },
      { type: "system", subtype: "init", uuid: "00000000-0000-0000-0000-0000000000b3", session_id: SESSION },
    ]) {
      const n = createClaudeNormalizer();
      expect([...n.push(JsonValue.parse(f)), ...n.flush()], f.type).toEqual([]);
    }
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

  // ── 0.3.259 plural companion: `user_message_uuids` — every client uuid whose
  // prompt this turn consumed so far, in consumption order (a prompt batch the
  // host merged into one turn; the singular is the LAST member). Present
  // exactly when the singular is, on the same first reply frame; joins the
  // SAME bag under the SAME once-per-message flag, wire name verbatim. ──
  const USER_MESSAGE_UUID_FIRST = "018f0000-0000-7000-8000-00000000d001";
  const USER_MESSAGE_UUIDS = [USER_MESSAGE_UUID_FIRST, USER_MESSAGE_UUID];

  it("carries user_message_uuids verbatim beside user_message_uuid in the first-block providerMetadata (0.3.259)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(
        JsonValue.parse(
          wrapperAssistant({ user_message_uuid: USER_MESSAGE_UUID, user_message_uuids: USER_MESSAGE_UUIDS }),
        ),
      ),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown };
    // Exact bag: both members, order preserved, nothing else fabricated.
    expect(firstBlock.providerMetadata).toEqual({
      user_message_uuid: USER_MESSAGE_UUID,
      user_message_uuids: USER_MESSAGE_UUIDS,
    });
    // Complete-only mode: the first-block carrier is the ONLY channel.
    expect(evs.some((e) => e.type === "message.metadata")).toBe(false);
  });

  it("user_message_uuids on a BLOCK-LESS frame rides message.metadata with the other wrapper siblings (fallback channel)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(
        JsonValue.parse(
          wrapperAssistant(
            { aborted: true, user_message_uuid: USER_MESSAGE_UUID, user_message_uuids: USER_MESSAGE_UUIDS },
            [],
          ),
        ),
      ),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const metas = evs.filter((e) => e.type === "message.metadata");
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      messageId: "msg_wrapper",
      metadata: { aborted: true, user_message_uuid: USER_MESSAGE_UUID, user_message_uuids: USER_MESSAGE_UUIDS },
    });
  });

  it("emits NO user_message_uuids key when the frame carries only the singular (negative control — the 0.3.258 bag is byte-identical), and a malformed list is ignored, never thrown", () => {
    // Singular only — the pre-0.3.259 producer shape.
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(wrapperAssistant({ user_message_uuid: USER_MESSAGE_UUID }))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown };
    expect(firstBlock.providerMetadata).toEqual({ user_message_uuid: USER_MESSAGE_UUID });

    // Malformed list (a non-string member) — shape-guarded out; the singular still rides.
    const m = createClaudeNormalizer();
    const evsM = [
      ...m.push(
        JsonValue.parse(
          wrapperAssistant({ user_message_uuid: USER_MESSAGE_UUID, user_message_uuids: [USER_MESSAGE_UUID, 7] }),
        ),
      ),
      ...m.flush(),
    ];
    assertAllValid(evsM);
    const firstBlockM = evsM.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown };
    expect(firstBlockM.providerMetadata).toEqual({ user_message_uuid: USER_MESSAGE_UUID });
  });

  // ── 0.3.268 (0.3.272 bump): `resume_reason` — the THIRD leg of the turn-
  // binding family. Why this frame's turn is the automatic re-run of a turn a
  // worker restart interrupted; 0.3.269 stamps it on the SAME frames as
  // user_message_uuid / user_message_uuids, so it rides the SAME bag under the
  // SAME once-per-message flag, wire name verbatim. ──
  const RESUME_REASON = "host_draining";

  it("carries resume_reason verbatim beside the uuid family in the first-block providerMetadata (0.3.268)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(
        JsonValue.parse(
          wrapperAssistant({
            user_message_uuid: USER_MESSAGE_UUID,
            user_message_uuids: USER_MESSAGE_UUIDS,
            resume_reason: RESUME_REASON,
          }),
        ),
      ),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown };
    expect(firstBlock.providerMetadata).toEqual({
      user_message_uuid: USER_MESSAGE_UUID,
      user_message_uuids: USER_MESSAGE_UUIDS,
      resume_reason: RESUME_REASON,
    });
  });

  it("resume_reason ALONE still triggers the family carry (a re-run whose opener could not be vouched carries the reason with no echo)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(wrapperAssistant({ resume_reason: "interrupted_turn" }))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown };
    expect(firstBlock.providerMetadata).toEqual({ resume_reason: "interrupted_turn" });
  });

  // -- 0.3.272: `narration_block_indexes` -- which of THIS frame's content blocks
  // are user-facing NARRATION (Anthropic's thinking.display:"updates" progress
  // updates) rather than private reasoning. Undeclared in sdk.d.ts, read through
  // the JSON boundary. A per-frame CONTENT fact like `aborted`, so deliberately
  // NOT under the turn-binding flag. First observed live on app-update-fable51
  // (cohort 0.6.2). --

  it("carries narration_block_indexes verbatim on the first block's HOST-ONLY _meta, not providerMetadata (0.3.272; X5)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(wrapperAssistant({ narration_block_indexes: [0] }))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown; _meta?: unknown };
    expect(firstBlock._meta).toEqual({ narration_block_indexes: [0] });
    expect(firstBlock.providerMetadata).toBeUndefined();
    // Fold: `_meta` lands on the block itself (per-frame anchoring kept).
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const block = r.result().messages.find((m) => m.id === "msg_wrapper")?.content[0];
    expect(block).toMatchObject({ type: "text", _meta: { narration_block_indexes: [0] } });
    // reduce() leaves the key present with an `undefined` value on text blocks
    // (its delta merge assigns it), so check the value, not `in`.
    expect(block?.type === "text" ? block.providerMetadata : "not-a-text-block").toBeUndefined();
  });

  it("narration_block_indexes rides the bag ALONGSIDE the turn-binding family without consuming its once-per-message flag", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(
        JsonValue.parse(
          wrapperAssistant({ user_message_uuid: USER_MESSAGE_UUID, narration_block_indexes: [0, 2] }),
        ),
      ),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown; _meta?: unknown };
    // X5: the bag splits by key — the turn-binding uuid stays replay-side, the
    // narration list goes host-side.
    expect(firstBlock.providerMetadata).toEqual({ user_message_uuid: USER_MESSAGE_UUID });
    expect(firstBlock._meta).toEqual({ narration_block_indexes: [0, 2] });
  });

  it("X5 fallback: a TOOL-first frame (tool.start folds no _meta) routes the host-only half through message.metadata, which folds", () => {
    const toolFirst = {
      ...assistantMsg(
        [
          { type: "tool_use", id: "toolu_x5", name: "Read", input: { path: "a" } },
          { type: "text", text: "narrated", citations: null },
        ],
        null,
        { stop_reason: "tool_use" },
      ),
      narration_block_indexes: [1],
    };
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(toolFirst)), ...n.flush()];
    assertAllValid(evs);
    const toolStart = evs.find((e) => e.type === "tool.start");
    expect(toolStart).toBeDefined();
    expect(toolStart !== undefined && "_meta" in toolStart).toBe(false);
    expect(toolStart !== undefined && "providerMetadata" in toolStart).toBe(false);
    const meta = evs.filter((e) => e.type === "message.metadata");
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({ messageId: "msg_fixture_1", metadata: { narration_block_indexes: [1] } });
    // It lands before the seal, and it folds onto the message.
    const types = evs.map((e) => e.type);
    expect(types.indexOf("message.metadata")).toBeLessThan(types.indexOf("message.end"));
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.find((m) => m.id === "msg_fixture_1")?.metadata).toEqual({ narration_block_indexes: [1] });
  });

  it("X5 fallback, MIXED bag on a tool-first frame: the replay half stays on tool.start.providerMetadata, only the host half moves", () => {
    const mixed = {
      ...assistantMsg([{ type: "tool_use", id: "toolu_x5m", name: "Read", input: { path: "a" } }], null, {
        stop_reason: "tool_use",
      }),
      aborted: true,
      narration_block_indexes: [0],
    };
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(mixed)), ...n.flush()];
    assertAllValid(evs);
    const toolStart = evs.find((e) => e.type === "tool.start");
    expect(toolStart).toBeDefined();
    expect(toolStart).toMatchObject({ providerMetadata: { aborted: true } });
    expect((toolStart as { providerMetadata?: unknown }).providerMetadata).toEqual({ aborted: true });
    expect(toolStart !== undefined && "_meta" in toolStart).toBe(false);
    const meta = evs.filter((e) => e.type === "message.metadata");
    expect(meta).toHaveLength(1);
    expect((meta[0] as { metadata?: unknown }).metadata).toEqual({ narration_block_indexes: [0] });
  });

  // First blocks with NO providerMetadata slot (compaction, a content.block)
  // or whose event belongs to ANOTHER message (mcp_tool_result → the adopted
  // `<id>:result` tool.done) used to drop the replay half of the wrapper bag
  // silently. Both halves now ride the assistant message's message.metadata.
  function frameWithFirst(first: unknown, wrapper: { [k: string]: unknown }): unknown {
    return {
      type: "assistant",
      message: {
        ...betaMessage([]),
        id: "msg_nonanchor",
        content: [first, { type: "text", text: "after", citations: null }],
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000c9",
      session_id: "sess_fixture",
      ...wrapper,
    };
  }

  it("a COMPACTION-first frame keeps BOTH wrapper halves on message.metadata, in wire order, folded onto the message", () => {
    const wrapper = { supersedes: ["00000000-0000-0000-0000-0000000000c8"], aborted: true, narration_block_indexes: [1] };
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(frameWithFirst({ type: "compaction", content: "summary", encrypted_content: null }, wrapper))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const meta = evs.filter((e) => e.type === "message.metadata");
    expect(meta).toHaveLength(1);
    expect(JSON.stringify((meta[0] as { metadata?: unknown }).metadata)).toBe(JSON.stringify(wrapper));
    for (const e of evs) {
      if (e.type === "message.metadata") continue;
      expect(JSON.stringify(e)).not.toContain("supersedes");
    }
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.find((m) => m.id === "msg_nonanchor")?.metadata).toEqual(wrapper);
  });

  it("an MCP_TOOL_RESULT-first frame keeps its wrapper facts on the ASSISTANT message, never on the adopted tool-result message", () => {
    const wrapper = { resumed_from_incomplete_thinking: true };
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(
        JsonValue.parse(
          frameWithFirst({ type: "mcp_tool_result", tool_use_id: "toolu_mcp_1", is_error: false, content: [{ type: "text", text: "ok" }] }, wrapper),
        ),
      ),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(evs.find((e) => e.type === "message.metadata")).toMatchObject({ messageId: "msg_nonanchor", metadata: wrapper });
    const toolDone = evs.find((e) => e.type === "tool.done");
    expect(toolDone !== undefined && "providerMetadata" in toolDone).toBe(false);
  });

  it("NEGATIVE CONTROL: a text-first frame still anchors both halves on text.start and emits no message.metadata", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(wrapperAssistant({ aborted: true, narration_block_indexes: [0] }))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    expect(evs.some((e) => e.type === "message.metadata")).toBe(false);
    expect(evs.find((e) => e.type === "text.start")).toMatchObject({ providerMetadata: { aborted: true }, _meta: { narration_block_indexes: [0] } });
  });

  it("NEGATIVE CONTROL: absent or malformed narration_block_indexes leaves the stream byte-identical (nothing new is carried)", () => {
    const bare = (() => {
      const n = createClaudeNormalizer();
      return [...n.push(JsonValue.parse(wrapperAssistant({}))), ...n.flush()];
    })();
    for (const bad of [[], "0", [0, "1"], [1.5], [-1], null, 0]) {
      const n = createClaudeNormalizer();
      const evs = [
        ...n.push(JsonValue.parse(wrapperAssistant({ narration_block_indexes: bad }))),
        ...n.flush(),
      ];
      assertAllValid(evs);
      expect(JSON.stringify(evs)).toBe(JSON.stringify(bare));
    }
    const firstBlock = bare.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown; _meta?: unknown };
    expect(firstBlock.providerMetadata).toBeUndefined();
    expect(firstBlock._meta).toBeUndefined();
  });

  it("resume_reason on a BLOCK-LESS frame rides message.metadata with the other wrapper siblings (fallback channel)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(
        JsonValue.parse(
          wrapperAssistant({ aborted: true, user_message_uuid: USER_MESSAGE_UUID, resume_reason: RESUME_REASON }, []),
        ),
      ),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const metas = evs.filter((e) => e.type === "message.metadata");
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      messageId: "msg_wrapper",
      metadata: { aborted: true, user_message_uuid: USER_MESSAGE_UUID, resume_reason: RESUME_REASON },
    });
  });

  it("emits NO resume_reason key when the frame lacks it (negative control — the 0.3.261 bag is byte-identical), and a non-string is ignored, never thrown", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(
        JsonValue.parse(
          wrapperAssistant({ user_message_uuid: USER_MESSAGE_UUID, user_message_uuids: USER_MESSAGE_UUIDS }),
        ),
      ),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const firstBlock = evs.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown };
    expect(firstBlock.providerMetadata).toEqual({
      user_message_uuid: USER_MESSAGE_UUID,
      user_message_uuids: USER_MESSAGE_UUIDS,
    });

    // A frame with NO turn-binding member at all carries no bag whatsoever.
    const bare = [...createClaudeNormalizer().push(JsonValue.parse(wrapperAssistant({})))];
    const bareBlock = bare.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown };
    expect(bareBlock.providerMetadata).toBeUndefined();

    // Non-string resume_reason — guarded out; the uuid still rides, nothing throws.
    const m = createClaudeNormalizer();
    const evsM = [
      ...m.push(JsonValue.parse(wrapperAssistant({ user_message_uuid: USER_MESSAGE_UUID, resume_reason: 7 }))),
      ...m.flush(),
    ];
    assertAllValid(evsM);
    const firstBlockM = evsM.find(
      (e) => e.type === "text.start" && (e as { messageId?: string }).messageId === "msg_wrapper",
    ) as { providerMetadata?: unknown };
    expect(firstBlockM.providerMetadata).toEqual({ user_message_uuid: USER_MESSAGE_UUID });
  });
});

// ─── SDKResultSuccess.deferred_tool_use → result-meta.deferredToolUse ────────
// The tool call a host's PreToolUse `defer` decision parked (CLI "Deferred tool
// resume"): content the host must act on, previously dropped (seat queue item
// 3's triage). Carried whole and verbatim on the existing result-meta bag.
describe("createClaudeNormalizer — deferred_tool_use rides ext.anthropic.result-meta", () => {
  const DEFERRED = { id: "toolu_deferred_1", name: "Bash", input: { command: "deploy --prod" } };

  it("carries deferred_tool_use verbatim as result-meta.deferredToolUse, before the close, without touching the fold", () => {
    const evs = run({ ...(resultSuccess("tool_use") as object), deferred_tool_use: DEFERRED } as unknown as SDKMessage);
    assertAllValid(evs);
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect(evs[1]).toMatchObject({ deferredToolUse: DEFERRED });
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns[0]?.outcome).toMatchObject({ type: "success" });
  });

  it("NEGATIVE CONTROL: absent or non-object deferred_tool_use emits nothing new (byte-identical)", () => {
    const bare = run(resultSuccess("end_turn"));
    expect(bare.map((e) => e.type)).toEqual(["turn.start", "turn.done"]);
    for (const bad of [null, "Bash", 7, ["x"]]) {
      const evs = run({ ...(resultSuccess("end_turn") as object), deferred_tool_use: bad } as unknown as SDKMessage);
      expect(JSON.stringify(evs)).toBe(JSON.stringify(bare));
    }
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
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect(evs[1]).toMatchObject({
      type: "ext.anthropic.result-meta",
      fastModeDisabledReason: "extra_usage_disabled",
      modelUsage: { "claude-opus": { canonicalModel: "claude-opus-4-7", provider: "bedrock" } },
    });
    // turn.done itself is unchanged — usage.byModel still maps the token/cost fields.
    expect(evs[2]).toMatchObject({
      type: "turn.done",
      finishReason: "stop",
      usage: { byModel: { "claude-opus": { inputTokens: 100, costUsd: 0.05 } } },
    });
    assertAllValid(evs);
  });

  it("emits the carry with modelUsage identity alone (no fabricated fastModeDisabledReason key)", () => {
    const evs = run(resultSuccessWithMeta());
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect(evs[1]).toMatchObject({
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
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.error"]);
    expect(evs[1]).toMatchObject({
      type: "ext.anthropic.result-meta",
      fastModeDisabledReason: "network_error",
    });
    expect(evs[2]).toMatchObject({
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
    expect(success.map((e) => e.type)).toEqual(["turn.start", "turn.done"]);
    const error = run(resultError("error_max_turns"));
    expect(error.map((e) => e.type)).toEqual(["turn.start", "turn.error"]);
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
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect(evs[1]).toMatchObject({
      type: "ext.anthropic.result-meta",
      modelUsage: {
        "claude-opus": { canonicalModel: "claude-opus-4-7", provider: "bedrock", costBasis: "managed" },
      },
    });
    // turn.done's byModel still maps the token/cost fields, identity-free.
    expect(evs[2]).toMatchObject({
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
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect(evs[1]).toMatchObject({
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
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.error"]);
    expect(evs[1]).toMatchObject({
      type: "ext.anthropic.result-meta",
      userMessageUuid: UMU,
      queuedTurnCount: 2,
    });
    expect(evs[2]).toMatchObject({ type: "turn.error", code: "error_during_execution", retriable: true });
    assertAllValid(evs);
  });

  it("negative control: an identity without costBasis and frames without the two siblings emit no such keys — pre-0.3.258 output byte-identical", () => {
    const evs = run({
      ...(resultSuccess("end_turn") as SDKResultSuccessMsg),
      modelUsage: IDENTITY_ONLY_MODEL_USAGE,
    });
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    const meta = evs[1] as {
      modelUsage?: { [model: string]: { costBasis?: unknown } | undefined };
      userMessageUuid?: unknown;
      queuedTurnCount?: unknown;
    };
    expect(meta.modelUsage?.["claude-opus"]).toEqual({ canonicalModel: "claude-opus-4-7", provider: "bedrock" });
    expect(meta.modelUsage?.["claude-opus"]?.costBasis).toBeUndefined();
    expect(meta.userMessageUuid).toBeUndefined();
    expect(meta.queuedTurnCount).toBeUndefined();
    // The frozen fixtures (no identity, no siblings) still emit NO result-meta at all.
    expect(run(resultSuccess("end_turn")).map((e) => e.type)).toEqual(["turn.start", "turn.done"]);
    expect(run(resultError("error_max_turns")).map((e) => e.type)).toEqual(["turn.start", "turn.error"]);
  });

  // ── 0.3.259 (0.3.261 bump): `user_message_uuids` on BOTH result arms — the
  // first-frame list PLUS any queued user message folded into the running turn
  // between tool rounds, so the result copy can be LONGER than the reply frame's.
  // Carried verbatim as `userMessageUuids` beside `userMessageUuid`. ──
  const UMU_FIRST = "018f0000-0000-7000-8000-00000000e000";
  const UMU_QUEUED = "018f0000-0000-7000-8000-00000000e002";
  const UMUS = [UMU_FIRST, UMU, UMU_QUEUED];

  it("carries userMessageUuids (order preserved) beside userMessageUuid on the SUCCESS arm (0.3.259)", () => {
    const msg: SDKResultSuccessMsg = {
      ...(resultSuccess("end_turn") as SDKResultSuccessMsg),
      user_message_uuid: UMU,
      user_message_uuids: UMUS,
    };
    const evs = run(msg);
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect(evs[1]).toMatchObject({
      type: "ext.anthropic.result-meta",
      userMessageUuid: UMU,
      userMessageUuids: UMUS,
    });
    expect((evs[1] as { userMessageUuids?: unknown }).userMessageUuids).toEqual(UMUS);
    assertAllValid(evs);
  });

  it("carries userMessageUuids on the ERROR arm too, before turn.error (0.3.259)", () => {
    const msg: SDKResultErrorMsg = {
      ...(resultError("error_during_execution") as SDKResultErrorMsg),
      user_message_uuid: UMU,
      user_message_uuids: UMUS,
    };
    const evs = run(msg);
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.error"]);
    expect(evs[1]).toMatchObject({
      type: "ext.anthropic.result-meta",
      userMessageUuid: UMU,
      userMessageUuids: UMUS,
    });
    expect(evs[2]).toMatchObject({ type: "turn.error", code: "error_during_execution", retriable: true });
    assertAllValid(evs);
  });

  it("negative control: a singular-only result emits NO userMessageUuids key (0.3.258 output byte-identical); a malformed list is ignored, never thrown", () => {
    const singularOnly = run({ ...(resultSuccess("end_turn") as SDKResultSuccessMsg), user_message_uuid: UMU });
    expect(singularOnly.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect(singularOnly[1]).toEqual({
      type: "ext.anthropic.result-meta",
      userMessageUuid: UMU,
      turnId: (singularOnly[1] as { turnId: string }).turnId,
      seq: (singularOnly[1] as { seq: number }).seq,
    });
    expect((singularOnly[1] as { userMessageUuids?: unknown }).userMessageUuids).toBeUndefined();

    // Malformed (a non-string member) — assembled at the JSON boundary, no cast.
    const wire: unknown = { ...resultSuccess("end_turn"), user_message_uuid: UMU, user_message_uuids: [UMU, 7] };
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(wire)), ...n.flush()];
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect((evs[1] as { userMessageUuid?: unknown }).userMessageUuid).toBe(UMU);
    expect((evs[1] as { userMessageUuids?: unknown }).userMessageUuids).toBeUndefined();
    // Not-an-array — same outcome.
    const wire2: unknown = { ...resultSuccess("end_turn"), user_message_uuids: "nope" };
    const m = createClaudeNormalizer();
    const evs2 = [...m.push(JsonValue.parse(wire2)), ...m.flush()];
    expect(evs2.map((e) => e.type)).toEqual(["turn.start", "turn.done"]);
  });

  // ── 0.3.268 (0.3.272 bump): three more result-frame siblings on the SAME
  // ext.anthropic.result-meta carrier — `resume_reason` (both arms, the
  // result-frame leg of the turn-binding family), `result_index` (both arms,
  // the delivery-integrity sequence) and `local_command` (SUCCESS arm only,
  // read through the JSON boundary since the union declares no such field). ──
  const RESUME_REASON = "checkpoint_restore";

  it("carries resumeReason on the SUCCESS arm beside the uuid family it disambiguates (0.3.268)", () => {
    const msg: SDKResultSuccessMsg = {
      ...(resultSuccess("end_turn") as SDKResultSuccessMsg),
      user_message_uuid: UMU,
      resume_reason: RESUME_REASON,
    };
    const evs = run(msg);
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect(evs[1]).toMatchObject({
      type: "ext.anthropic.result-meta",
      userMessageUuid: UMU,
      resumeReason: RESUME_REASON,
    });
    assertAllValid(evs);
  });

  it("carries resumeReason on the ERROR arm too, before turn.error (0.3.268)", () => {
    const msg: SDKResultErrorMsg = {
      ...(resultError("error_during_execution") as SDKResultErrorMsg),
      resume_reason: "interrupted_turn",
    };
    const evs = run(msg);
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.error"]);
    expect(evs[1]).toMatchObject({ type: "ext.anthropic.result-meta", resumeReason: "interrupted_turn" });
    expect(evs[2]).toMatchObject({ type: "turn.error", code: "error_during_execution", retriable: true });
    assertAllValid(evs);
  });

  it("carries resultIndex on BOTH arms — 0 is a REAL value (the first result of every run), never dropped by truthiness", () => {
    const first = run({ ...(resultSuccess("end_turn") as SDKResultSuccessMsg), result_index: 0 });
    expect(first.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect(first[1]).toMatchObject({ type: "ext.anthropic.result-meta", resultIndex: 0 });
    // Explicitly: the key EXISTS and is the number 0, not absent.
    expect((first[1] as { resultIndex?: unknown }).resultIndex).toBe(0);
    assertAllValid(first);

    const later = run({ ...(resultSuccess("end_turn") as SDKResultSuccessMsg), result_index: 7 });
    expect(later[1]).toMatchObject({ resultIndex: 7 });

    const errored = run({
      ...(resultError("error_during_execution") as SDKResultErrorMsg),
      result_index: 3,
    });
    expect(errored.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.error"]);
    expect(errored[1]).toMatchObject({ type: "ext.anthropic.result-meta", resultIndex: 3 });
    assertAllValid(errored);
  });

  it("carries localCommand on the SUCCESS arm (read through the JSON boundary — declared on that arm only)", () => {
    // The wire shape of a turn that ran a slash command without entering the
    // model loop: the CLI writes the sanitized, slugified command name.
    const wire: unknown = { ...resultSuccess("end_turn"), local_command: "context", result_index: 0 };
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(wire)), ...n.flush()];
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect(evs[1]).toMatchObject({
      type: "ext.anthropic.result-meta",
      localCommand: "context",
      resultIndex: 0,
    });
    assertAllValid(evs);

    // The producer's own collapsed values ("custom" for a non-first-party
    // command, "mcp" for an MCP one) are carried verbatim — never re-derived.
    const custom: unknown = { ...resultSuccess("end_turn"), local_command: "custom" };
    const m = createClaudeNormalizer();
    const evsC = [...m.push(JsonValue.parse(custom)), ...m.flush()];
    expect(evsC[1]).toMatchObject({ localCommand: "custom" });

    // A non-string is guarded out, never thrown on (Tenet 6).
    const bad: unknown = { ...resultSuccess("end_turn"), local_command: 7 };
    const k = createClaudeNormalizer();
    const evsB = [...k.push(JsonValue.parse(bad)), ...k.flush()];
    expect(evsB.map((e) => e.type)).toEqual(["turn.start", "turn.done"]);
  });

  it("negative control: frames without the three 0.3.268 siblings emit no such keys — pre-0.3.268 output byte-identical", () => {
    const withOld = run({ ...(resultSuccess("end_turn") as SDKResultSuccessMsg), user_message_uuid: UMU });
    expect(withOld.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    // The whole carrier, exhaustively: exactly the 0.3.258 bag, nothing added.
    expect(withOld[1]).toEqual({
      type: "ext.anthropic.result-meta",
      userMessageUuid: UMU,
      turnId: (withOld[1] as { turnId: string }).turnId,
      seq: (withOld[1] as { seq: number }).seq,
    });

    // And the frozen fixtures (no siblings at all) still emit NO result-meta
    // (a result-only turn opens with its own turn.start, INV-TURN).
    expect(run(resultSuccess("end_turn")).map((e) => e.type)).toEqual(["turn.start", "turn.done"]);
    expect(run(resultError("error_max_turns")).map((e) => e.type)).toEqual(["turn.start", "turn.error"]);
  });

  it("fold: the 0.3.268 siblings inside a real turn fold clean through Reducer — needsResync===false", () => {
    const n = createClaudeNormalizer();
    const wire: unknown = {
      ...resultSuccess("end_turn"),
      user_message_uuid: UMU,
      resume_reason: RESUME_REASON,
      result_index: 0,
      local_command: "usage",
    };
    const events = [
      ...n.push(JsonValue.parse(assistantMsg([{ type: "text", text: "hello", citations: null }]))),
      ...n.push(JsonValue.parse(wire)),
      ...n.flush(),
    ];
    assertAllValid(events);
    const meta = events.find((e) => e.type === "ext.anthropic.result-meta");
    expect(meta).toMatchObject({
      userMessageUuid: UMU,
      resumeReason: RESUME_REASON,
      resultIndex: 0,
      localCommand: "usage",
    });
    const r = new Reducer();
    for (const e of events) r.push(e);
    expect(r.needsResync).toBe(false);
  });
});

// ─── 0.3.257 thinking-token telemetry → AgUsage.reasoningTokens ──────────────
// `ModelUsage.thinkingTokens` ("already counted inside outputTokens") and the
// wire-level `usage.output_tokens_details.thinking_tokens` (undeclared on the
// bundled BetaUsage/BetaMessageDeltaUsage 0.93.0 — read through the runtime
// guard) both land on `reasoningTokens` as a SUBSET of outputTokens — the spec
// §4 rule since draft.3 (openai copies the inclusive upstream counter; adk folds
// Gemini's sibling thoughts in since 0.6.0). Absent ⇒ no key (byte-identical).
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
    opts?: {
      parent?: string | null;
      ttft?: number;
      userMessageUuid?: string;
      userMessageUuids?: string[];
      resumeReason?: string;
    },
  ): SDKMessage {
    return {
      type: "stream_event",
      event,
      parent_tool_use_id: opts?.parent ?? null,
      uuid: "00000000-0000-0000-0000-0000000000c1",
      session_id: "sess_fixture",
      ...(opts?.ttft !== undefined ? { ttft_ms: opts.ttft } : {}),
      ...(opts?.userMessageUuid !== undefined ? { user_message_uuid: opts.userMessageUuid } : {}),
      ...(opts?.userMessageUuids !== undefined ? { user_message_uuids: opts.userMessageUuids } : {}),
      ...(opts?.resumeReason !== undefined ? { resume_reason: opts.resumeReason } : {}),
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

  it("a replayed prompt ACK mid-stream (isReplay, string content) neither splits the message nor strands its tail", () => {
    // The CLI sends replay acks when it accepts stdin input and never holds them,
    // so an ack can land between partials. Before the isReplay guard the user
    // branch ran closePendingMessage() on it: the message split in two, and the
    // complete frame re-opened a `:cont:` copy (sp-rnd lead, 2026-09-23).
    const ack: SDKMessage = {
      type: "user",
      message: { role: "user", content: "and also check the tests" },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000d1",
      session_id: "sess_fixture",
      isReplay: true,
    };
    const head = [streamFrame(messageStart()), streamFrame(cbStartText(0)), streamFrame(cbDeltaText(0, "hel"))];
    const tail = [
      streamFrame(cbDeltaText(0, "lo")),
      streamFrame(cbStop(0)),
      streamFrame(msgDelta(5)),
      streamFrame(msgStop()),
      completeFrame([{ type: "text", text: "hello", citations: null }]),
      resultSuccess("end_turn"),
    ];
    const n1 = createClaudeNormalizer();
    const base = [...pushAll(n1, [...head, ...tail]), ...n1.flush()];
    const n2 = createClaudeNormalizer();
    const withAck = [...pushAll(n2, [...head, ack, ...tail]), ...n2.flush()];
    assertAllValid(withAck);
    expect(withAck).toStrictEqual(base);
    const r = new Reducer();
    for (const e of withAck) r.push(e);
    expect(r.needsResync).toBe(false);
    const result = r.result();
    expect(result.messages.map((m) => m.id)).toEqual([STREAM_ID]);
    expect(result.messages[0]?.content).toMatchObject([{ type: "text", text: "hello" }]);
  });

  it("X5: a STREAMED (suppressed) complete frame carrying host keys rides the combined bag on message.metadata, unchanged", () => {
    // The realistic partials + thinking.display:"updates" path: the stream
    // already emitted the blocks, so the complete frame's wrapper bag has no
    // block to anchor on and rides message.metadata WHOLE and in wire order,
    // exactly as before X5 (message.metadata is already AgMeta). No stream
    // event gains `_meta` or a narration key.
    const n = createClaudeNormalizer();
    const evs = [
      ...pushAll(n, TEXT_STREAM()),
      ...n.push(
        JsonValue.parse({
          ...completeFrame([{ type: "text", text: "hello", citations: null }]),
          aborted: true,
          narration_block_indexes: [0],
        }),
      ),
      ...pushAll(n, [resultSuccess("end_turn")]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const meta = evs.filter((e) => e.type === "message.metadata");
    expect(meta).toHaveLength(1);
    expect(JSON.stringify((meta[0] as { metadata?: unknown }).metadata)).toBe(
      JSON.stringify({ aborted: true, narration_block_indexes: [0] }),
    );
    for (const e of evs) {
      if (e.type === "message.metadata") continue;
      expect(JSON.stringify(e)).not.toContain("narration_block_indexes");
      expect("_meta" in e).toBe(false);
    }
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.find((m) => m.id === STREAM_ID)?.metadata).toEqual({
      aborted: true,
      narration_block_indexes: [0],
    });
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

  // ── 0.3.259 (0.3.261 bump): `user_message_uuids` on the partial envelope —
  // the plural companion, present exactly when the singular is, on the same
  // first non-ping stream event. Rides the SAME single message.metadata
  // emission (wire names verbatim), never a second one. ──
  const STREAM_UMU_FIRST = "018f0000-0000-7000-8000-00000000d000";
  const STREAM_UMUS = [STREAM_UMU_FIRST, STREAM_UMU];

  it("carries user_message_uuids in the SAME single message.metadata emission as user_message_uuid — once, even when the complete frame is stamped too (0.3.259)", () => {
    const n = createClaudeNormalizer();
    const stampedComplete: SDKMessage = {
      ...completeFrame([{ type: "text", text: "hi", citations: null }]),
      user_message_uuid: STREAM_UMU,
      user_message_uuids: STREAM_UMUS,
    } as SDKMessage;
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart(), { userMessageUuid: STREAM_UMU, userMessageUuids: STREAM_UMUS }),
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
    // Exactly ONE metadata event carries the family, and it carries BOTH members.
    const metas = evs.filter(
      (e) =>
        isClosedEvent(e) &&
        e.type === "message.metadata" &&
        (e.metadata["user_message_uuid"] !== undefined || e.metadata["user_message_uuids"] !== undefined),
    );
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      messageId: STREAM_ID,
      metadata: { user_message_uuid: STREAM_UMU, user_message_uuids: STREAM_UMUS },
    });
    // Bound to the reply BEFORE any content streamed.
    const types = evs.map((e) => e.type);
    expect(types.indexOf("message.metadata")).toBeLessThan(types.indexOf("text.start"));
    // …and no first-block providerMetadata twin (the complete frame was content-suppressed).
    const textStart = evs.find((e) => e.type === "text.start") as { providerMetadata?: unknown };
    expect(textStart.providerMetadata).toBeUndefined();
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
  });

  it("emits NO user_message_uuids key when the stream carries only the singular (negative control — the 0.3.258 emission is byte-identical)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart(), { userMessageUuid: STREAM_UMU }),
        streamFrame(cbStartText(0)),
        streamFrame(cbDeltaText(0, "hi")),
        streamFrame(cbStop(0)),
        streamFrame(msgStop()),
        completeFrame([{ type: "text", text: "hi", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const metas = evs.filter((e) => isClosedEvent(e) && e.type === "message.metadata");
    expect(metas).toHaveLength(1);
    expect((metas[0] as { metadata: unknown }).metadata).toEqual({ user_message_uuid: STREAM_UMU });
    // …and the unstamped wire carries neither key at all.
    const evsBare = [
      ...pushAll(createClaudeNormalizer(), [
        ...TEXT_STREAM(),
        completeFrame([{ type: "text", text: "hello", citations: null }]),
        resultSuccess("end_turn"),
      ]),
    ];
    expect(
      evsBare.some(
        (e) => isClosedEvent(e) && e.type === "message.metadata" && e.metadata["user_message_uuids"] !== undefined,
      ),
    ).toBe(false);
  });

  // ── 0.3.268 (0.3.272 bump): `resume_reason` on the partial envelope — the
  // THIRD leg of the turn-binding family. The upstream 0.3.269 entry changes
  // user_message_uuid, user_message_uuids AND resume_reason under ONE rule
  // ("stamped on a turn's first complete assistant message as well as its first
  // stream event when partial messages are on"), so it MUST share the family's
  // once-per-message flag: the streamed lifecycle carries once, and the
  // content-suppressed complete frame that joins it must NOT carry again. ──
  const STREAM_RESUME_REASON = "container_recreated";

  it("carries resume_reason in the SAME single message.metadata emission as the uuid family — never twice, even when the complete frame is stamped too (0.3.268)", () => {
    const n = createClaudeNormalizer();
    // The 0.3.269 shape exactly: the stream event AND the first complete
    // assistant message both stamped with all three family members.
    const stampedComplete: SDKMessage = {
      ...completeFrame([{ type: "text", text: "hi", citations: null }]),
      user_message_uuid: STREAM_UMU,
      user_message_uuids: STREAM_UMUS,
      resume_reason: STREAM_RESUME_REASON,
    } as SDKMessage;
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart(), {
          userMessageUuid: STREAM_UMU,
          userMessageUuids: STREAM_UMUS,
          resumeReason: STREAM_RESUME_REASON,
        }),
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
    // THE regression bar: exactly ONE message.metadata event on the whole
    // streamed lifecycle (an unguarded resume_reason write would make two).
    const metas = evs.filter((e) => isClosedEvent(e) && e.type === "message.metadata");
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      messageId: STREAM_ID,
      metadata: {
        user_message_uuid: STREAM_UMU,
        user_message_uuids: STREAM_UMUS,
        resume_reason: STREAM_RESUME_REASON,
      },
    });
    // Bound to the reply BEFORE any content streamed.
    const types = evs.map((e) => e.type);
    expect(types.indexOf("message.metadata")).toBeLessThan(types.indexOf("text.start"));
    // …and no first-block providerMetadata twin (the complete frame was suppressed).
    const textStart = evs.find((e) => e.type === "text.start") as { providerMetadata?: unknown };
    expect(textStart.providerMetadata).toBeUndefined();
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
  });

  it("resume_reason ALONE on the stream still triggers the family carry, and still only once", () => {
    const n = createClaudeNormalizer();
    const stampedComplete: SDKMessage = {
      ...completeFrame([{ type: "text", text: "hi", citations: null }]),
      resume_reason: STREAM_RESUME_REASON,
    } as SDKMessage;
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart(), { resumeReason: STREAM_RESUME_REASON }),
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
    const metas = evs.filter((e) => isClosedEvent(e) && e.type === "message.metadata");
    expect(metas).toHaveLength(1);
    expect((metas[0] as { metadata: unknown }).metadata).toEqual({ resume_reason: STREAM_RESUME_REASON });
  });

  it("emits NO resume_reason key when the stream lacks it (negative control — the 0.3.261 emission is byte-identical)", () => {
    const n = createClaudeNormalizer();
    const evs = [
      ...pushAll(n, [
        streamFrame(messageStart(), { userMessageUuid: STREAM_UMU, userMessageUuids: STREAM_UMUS }),
        streamFrame(cbStartText(0)),
        streamFrame(cbDeltaText(0, "hi")),
        streamFrame(cbStop(0)),
        streamFrame(msgStop()),
        completeFrame([{ type: "text", text: "hi", citations: null }]),
        resultSuccess("end_turn"),
      ]),
      ...n.flush(),
    ];
    assertAllValid(evs);
    const metas = evs.filter((e) => isClosedEvent(e) && e.type === "message.metadata");
    expect(metas).toHaveLength(1);
    expect((metas[0] as { metadata: unknown }).metadata).toEqual({
      user_message_uuid: STREAM_UMU,
      user_message_uuids: STREAM_UMUS,
    });
    // …and a wholly unstamped stream carries no metadata event at all.
    const evsBare = pushAll(createClaudeNormalizer(), [
      ...TEXT_STREAM(),
      completeFrame([{ type: "text", text: "hello", citations: null }]),
      resultSuccess("end_turn"),
    ]);
    expect(evsBare.some((e) => e.type === "message.metadata")).toBe(false);
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
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.done"]);
    expect((evs[1] as { subagentStats?: unknown }).subagentStats).toEqual(STATS);
    assertAllValid(evs);
  });

  it("emits NO subagentStats key (and no result-meta at all) when the frame lacks it — byte-identical pre-0.3.258 output", () => {
    const evs = run(resultSuccess("end_turn"));
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "turn.done"]);
  });

  it("a malformed (non-object) subagent_stats is ignored, never thrown (Tenet 6)", () => {
    const wire: unknown = { ...resultSuccess("end_turn"), subagent_stats: "nope" };
    const n = createClaudeNormalizer();
    const evs = [...n.push(JsonValue.parse(wire)), ...n.flush()];
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "turn.done"]);
  });
});

describe("createClaudeNormalizer — thinking_delta.estimated_tokens (runtime-only; Fable 5.1 display:omitted) → reasoning.delta _meta (host-only, live-only; X5)", () => {
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

  function allEvents(deltas: unknown[]): AgEvent[] {
    const n = createClaudeNormalizer();
    const evs = [
      ...n.push(JsonValue.parse(frame(start))),
      ...n.push(JsonValue.parse(frame(cbStartThinking))),
      ...deltas.flatMap((d) => n.push(JsonValue.parse(d))),
      ...n.flush(),
    ];
    assertAllValid(evs);
    return evs;
  }
  function reasoningDeltas(deltas: unknown[]): Array<{ delta: string; providerMetadata?: unknown; _meta?: unknown }> {
    return allEvents(deltas).filter((e) => e.type === "reasoning.delta") as Array<{
      delta: string;
      providerMetadata?: unknown;
      _meta?: unknown;
    }>;
  }

  it("carries a numeric estimate verbatim and a null estimate as null on _meta, never providerMetadata", () => {
    const out = reasoningDeltas([thinkingDelta({ estimated_tokens: 50 }), thinkingDelta({ estimated_tokens: null })]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ delta: "", _meta: { estimated_tokens: 50 } });
    expect(out[1]).toMatchObject({ delta: "", _meta: { estimated_tokens: null } });
    for (const d of out) expect("providerMetadata" in d).toBe(false);
  });

  it("emits NO _meta and NO providerMetadata key when the delta carries no estimated_tokens (pre-Fable wire, byte-identical)", () => {
    const out = reasoningDeltas([thinkingDelta({})]);
    expect(out).toHaveLength(1);
    expect("providerMetadata" in out[0]!).toBe(false);
    expect("_meta" in out[0]!).toBe(false);
  });

  it("fold: the estimate is LIVE-ONLY — the reasoning block folds with no estimate on either bag, and nothing parks", () => {
    // `reduce()` folds `_meta` only on start events; a delta's `_meta` is live.
    const evs = allEvents([thinkingDelta({ estimated_tokens: 50 }), thinkingDelta({ estimated_tokens: 80 })]);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const block = r.result().messages.find((m) => m.id === "msg_fable_1")?.content[0];
    expect(block).toMatchObject({ type: "reasoning" });
    expect(JSON.stringify(block)).not.toContain("estimated_tokens");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cohort 0.6.3 sweep (claude-agent-sdk 0.3.272 → 0.3.280, CLI 2.1.280).
// ─────────────────────────────────────────────────────────────────────────────

// Shared fixtures for the API-error turn. The CLI delivers it as TWO frames:
// the synthetic assistant message carrying `error` (plus the undeclared
// is_api_error_message / api_error / api_error_params / api_error_code
// siblings), then the turn's result, `subtype: "success"` with
// `is_error: true`, the error text in `result`, the HTTP status in
// `api_error_status` and the undeclared `api_error_code`. Both are assembled at
// the JSON boundary (`unknown`): the undeclared fields have no typed home.
const API_ERROR_TEXT = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}';

function apiErrorAssistantFrame(extra: { [k: string]: unknown } = {}, content?: unknown[]): unknown {
  return {
    type: "assistant",
    message: {
      ...betaMessage([], { stop_reason: "stop_sequence" }),
      id: "msg_api_error_1",
      model: "<synthetic>",
      content: content ?? [{ type: "text", text: API_ERROR_TEXT, citations: null }],
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-0000000000e1",
    session_id: "sess_fixture",
    error: "rate_limit",
    is_api_error_message: true,
    ...extra,
  };
}

function apiErrorResultFrame(extra: { [k: string]: unknown } = {}): unknown {
  return {
    ...resultSuccess("stop_sequence"),
    is_error: true,
    result: API_ERROR_TEXT,
    api_error_status: 429,
    ...extra,
  };
}

// INV-TURN (per-turn ids, B): a turn that opens on `apiErrorAssistantFrame` is
// named by its message id; as a NESTED frame it names its nested turn the same
// way, and never a top-level one.
const API_ERROR_TURN = "turn_msg_api_error_1";

// The same frame with one wire key removed (an older producer's shape).
function withoutKey(frame: unknown, key: string): unknown {
  if (typeof frame !== "object" || frame === null) return frame;
  return Object.fromEntries(Object.entries(frame).filter(([k]) => k !== key));
}

function drive(frames: unknown[]): AgEvent[] {
  const n = createClaudeNormalizer();
  const evs = [...frames.flatMap((f) => n.push(JsonValue.parse(f))), ...n.flush()];
  assertAllValid(evs);
  return evs;
}

function turnCloses(evs: AgEvent[]): AgEvent[] {
  return evs.filter((e) => e.type === "turn.done" || e.type === "turn.error" || e.type === "turn.abort");
}

// The `<turnId>:denials` carrier's events, its message.start through its
// message.end, each without `seq` (which counts the turn's earlier events) —
// so an API-error turn's carrier compares event-for-event with a normal one.
// `abstractTurn`: the carrier is named after its turn (`<turnId>:denials`), and
// since the per-turn ids (INV-TURN, B) two turns that open on different frames
// are named differently, so a cross-turn comparison replaces the turn id with a
// placeholder. Everything else must still match event for event.
function denialCarrier(evs: AgEvent[], abstractTurn = false): unknown[] {
  const isCarrier = (e: AgEvent, type: "message.start" | "message.end"): boolean =>
    e.type === type && "id" in e && typeof e.id === "string" && e.id.endsWith(":denials");
  const start = evs.findIndex((e) => isCarrier(e, "message.start"));
  const end = evs.findIndex((e) => isCarrier(e, "message.end"));
  if (start < 0 || end < start) return [];
  const carrier = evs.slice(start, end + 1).map((e) => withoutKey(e, "seq"));
  const first = evs[start];
  const turnId = first !== undefined && "turnId" in first && typeof first.turnId === "string" ? first.turnId : undefined;
  if (!abstractTurn || turnId === undefined) return carrier;
  // Structured: only `turnId` itself and the `<turnId>:denials` message ids.
  const abstractKey = (v: unknown): unknown =>
    v === turnId ? "<turn>" : typeof v === "string" && v.startsWith(`${turnId}:`) ? `<turn>${v.slice(turnId.length)}` : v;
  return carrier.map((e) =>
    typeof e === "object" && e !== null
      ? Object.fromEntries(
          Object.entries(e).map(([k, v]) => [k, k === "turnId" || k === "id" || k === "messageId" ? abstractKey(v) : v]),
        )
      : e,
  );
}

function fold(evs: AgEvent[]): Reducer {
  const r = new Reducer();
  for (const e of evs) r.push(e);
  return r;
}

// The usage `mapTurnUsage` builds from `resultSuccess` (and so from
// `apiErrorResultFrame`): the mapping turn.done has always carried.
const RESULT_USAGE = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 20,
  cacheWriteTokens: 10,
  serverToolRequests: 0,
  costUsd: 0.05,
  cumulative: true,
  byModel: {
    "claude-opus": {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      costUsd: 0.05,
      serverToolRequests: 0,
      cumulative: true,
    },
  },
};

// An ERROR-subtype result carrying `resultSuccess`'s usage trio (the error
// fixture's own usage is all zeros, which would not show whose usage landed).
function errorResultWithUsage(): unknown {
  const ok = resultSuccess("end_turn");
  const err = resultError("error_during_execution");
  if (ok.type !== "result" || err.type !== "result") throw new Error("fixture shape");
  return { ...err, total_cost_usd: ok.total_cost_usd, usage: ok.usage, modelUsage: ok.modelUsage };
}

// A second API-error assistant frame (its own message id and uuid), to show
// which error frame's fields a turn keeps.
function secondApiErrorAssistantFrame(error: NonNullable<SDKAssistantError>): unknown {
  return apiErrorAssistantFrame({
    error,
    uuid: "00000000-0000-0000-0000-0000000000e2",
    message: {
      ...betaMessage([{ type: "text", text: "second API error", citations: null }], { stop_reason: "stop_sequence" }),
      id: "msg_api_error_2",
      model: "<synthetic>",
    },
  });
}

describe("createClaudeNormalizer — CL-09: an API-error turn closes as turn.error, never as success", () => {
  it("the two-frame sequence (assistant `error` frame, then success result with is_error:true) closes the turn exactly ONCE, as turn.error carrying the result's usage", () => {
    const evs = drive([apiErrorAssistantFrame(), apiErrorResultFrame()]);
    // result-meta carries the error close's api_error_status + stop_reason.
    expect(evs.map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.end",
      "ext.anthropic.result-meta",
      "turn.error",
    ]);
    const closes = turnCloses(evs);
    expect(closes).toHaveLength(1);
    // The assistant frame's error fields; the result frame's usage.
    expect(closes[0]).toEqual({
      type: "turn.error",
      seq: expect.any(Number),
      turnId: API_ERROR_TURN,
      message: "rate_limit",
      code: "rate_limit",
      retriable: true,
      usage: RESULT_USAGE,
    });
    expect(evs.some((e) => e.type === "turn.done")).toBe(false);
  });

  it("the RESULT frame emits the close: the assistant error frame seals its message and stops there", () => {
    const n = createClaudeNormalizer();
    const atAssistant = n.push(JsonValue.parse(apiErrorAssistantFrame()));
    expect(atAssistant.map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.end",
    ]);
    const atResult = n.push(JsonValue.parse(apiErrorResultFrame()));
    expect(atResult.map((e) => e.type)).toEqual(["ext.anthropic.result-meta", "turn.error"]);
    // Nothing is left for the flush to close.
    expect(n.flush()).toEqual([]);
  });

  it("fold: reduce() records the API-error turn as an error, with the result's usage, not as a success whose result is the error text", () => {
    const r = fold(drive([apiErrorAssistantFrame(), apiErrorResultFrame()]));
    expect(r.needsResync).toBe(false);
    const turn = r.result().turns.find((t) => t.turnId === API_ERROR_TURN);
    expect(turn?.outcome).toEqual({ type: "error", message: "rate_limit", code: "rate_limit" });
    expect(turn?.usage).toEqual(RESULT_USAGE);
  });

  it("result-meta rides BEFORE the close, as on every other turn, and opens no message on the turn", () => {
    const evs = drive([
      apiErrorAssistantFrame(),
      apiErrorResultFrame({ api_error_code: "rate_limit_exceeded", result_index: 0 }),
    ]);
    const sealAt = evs.findIndex((e) => e.type === "message.end");
    expect(evs.slice(sealAt + 1).map((e) => e.type)).toEqual(["ext.anthropic.result-meta", "turn.error"]);
    expect(evs[sealAt + 1]).toMatchObject({ apiErrorCode: "rate_limit_exceeded", resultIndex: 0 });
    // The assistant frame decided the close: its code, not the result's api_error_code.
    expect(evs[sealAt + 2]).toMatchObject({ code: "rate_limit", usage: RESULT_USAGE });
    expect(turnCloses(evs)).toHaveLength(1);
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.find((t) => t.turnId === API_ERROR_TURN)?.outcome).toMatchObject({ type: "error" });
  });

  it("denials on an API-error turn (stashed close) open the SAME `<turnId>:denials` carrier as a normal turn, in the same place — carrier, result-meta, then ONE turn.error with usage", () => {
    const live: unknown = {
      ...permissionDeniedMsg({ decision_reason_type: "rule", decision_reason: "matches deny-rule 'no rm -rf'" }),
      decision_reason_code: "outside_reads_blocked",
    };
    const denials = [
      { tool_name: "bash", tool_use_id: "toolu_denied_1", tool_input: { command: "rm -rf" } },
      { tool_name: "Read", tool_use_id: "toolu_denied_2", tool_input: { file_path: "/etc/passwd" } },
    ];
    // result_index forces a result-meta, so its position is pinned too.
    const evs = drive([
      live,
      apiErrorAssistantFrame(),
      apiErrorResultFrame({ permission_denials: denials, result_index: 0 }),
    ]);
    const sealAt = evs.findIndex((e) => e.type === "message.end");
    // After the error message's seal: the carrier, the ext carry, the close.
    expect(evs.slice(sealAt + 1).map((e) => e.type)).toEqual([
      "message.start",
      "tool.start",
      "tool.done",
      "tool.start",
      "tool.done",
      "message.end",
      "ext.anthropic.result-meta",
      "turn.error",
    ]);
    // The same live frame and denials on an ordinary (is_error:false) turn:
    // the carrier is event-for-event identical (seq aside — it counts the
    // error turn's earlier events), and it sits in the same place, between
    // the sealed content and result-meta → close.
    const normal = drive([live, { ...resultSuccess("end_turn"), permission_denials: denials, result_index: 0 }]);
    expect(normal.map((e) => e.type)).toEqual([
      "turn.start",
      ...evs.slice(sealAt + 1, -1).map((e) => e.type),
      "turn.done",
    ]);
    expect(denialCarrier(evs, true)).toEqual(denialCarrier(normal, true));
    expect(denialCarrier(evs)[0]).toMatchObject({
      type: "message.start",
      id: `${API_ERROR_TURN}:denials`,
      turnId: API_ERROR_TURN,
    });
    // The live enrichment (with the decisionReasonCode carry) rides the
    // carrier's tool.done, as on every turn; the bare denial fabricates nothing.
    const dones = evs.filter((e): e is Extract<AgEvent, { type: "tool.done" }> => e.type === "tool.done");
    expect(dones[0]).toMatchObject({
      toolCallId: "toolu_denied_1",
      outcome: "denied",
      content: [{ type: "text", text: "This command was blocked by a deny rule (no destructive filesystem operations)." }],
      providerMetadata: {
        decisionReasonType: "rule",
        decisionReasonCode: "outside_reads_blocked",
        decisionReason: "matches deny-rule 'no rm -rf'",
      },
    });
    expect(dones[1]).toMatchObject({ toolCallId: "toolu_denied_2", outcome: "denied", content: [] });
    expect(dones[1]).not.toHaveProperty("providerMetadata");
    // result-meta carries only resultMetaPayload's keys — never the denials.
    const meta = evs.find((e) => e.type === "ext.anthropic.result-meta");
    expect(meta).toMatchObject({ resultIndex: 0 });
    expect(meta).not.toHaveProperty("permissionDenials");
    // One close, the stashed turn.error, with the result's usage.
    expect(turnCloses(evs)).toEqual([
      {
        type: "turn.error",
        seq: expect.any(Number),
        turnId: API_ERROR_TURN,
        message: "rate_limit",
        code: "rate_limit",
        retriable: true,
        usage: RESULT_USAGE,
      },
    ]);
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    const carrier = r.result().messages.find((m) => m.id === `${API_ERROR_TURN}:denials`);
    expect(carrier?.content.filter((b) => b.type === "tool-result" && b.outcome === "denied")).toHaveLength(2);
    const turn = r.result().turns.find((t) => t.turnId === API_ERROR_TURN);
    expect(turn?.outcome).toEqual({ type: "error", message: "rate_limit", code: "rate_limit" });
    expect(turn?.usage).toEqual(RESULT_USAGE);
  });

  it("a stashed error closes the turn on ANY success result of it: an is_error:false result emits the stashed turn.error (with usage), never turn.done", () => {
    const evs = drive([apiErrorAssistantFrame(), resultSuccess("end_turn")]);
    const closes = turnCloses(evs);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ type: "turn.error", code: "rate_limit", retriable: true, usage: RESULT_USAGE });
    // Its denials take the ordinary carrier too: the turn is still open when
    // the result frame arrives.
    const withDenial = drive([apiErrorAssistantFrame(), resultWithDenial()]);
    const sealAt = withDenial.findIndex((e) => e.type === "message.end");
    // The turn closes as turn.error, so the result's stop_reason rides result-meta.
    expect(withDenial.slice(sealAt + 1).map((e) => e.type)).toEqual([
      "message.start",
      "tool.start",
      "tool.done",
      "message.end",
      "ext.anthropic.result-meta",
      "turn.error",
    ]);
    expect(withDenial.find((e) => e.type === "ext.anthropic.result-meta")).toMatchObject({ stopReason: "end_turn" });
    const normal = run(resultWithDenial());
    expect(denialCarrier(withDenial)).toHaveLength(4);
    expect(denialCarrier(withDenial, true)).toEqual(denialCarrier(normal, true));
    // The one close carries the usage the ordinary turn.done carries.
    const normalDone = normal.find((e): e is Extract<AgEvent, { type: "turn.done" }> => e.type === "turn.done");
    expect(normalDone?.usage).toBeDefined();
    expect(turnCloses(withDenial)).toEqual([
      {
        type: "turn.error",
        seq: expect.any(Number),
        turnId: API_ERROR_TURN,
        message: "rate_limit",
        code: "rate_limit",
        retriable: true,
        usage: normalDone?.usage,
      },
    ]);
    expect(fold(withDenial).needsResync).toBe(false);
  });

  it("NEGATIVE CONTROL: result-meta never carries a `permissionDenials` key, on any path that has denials", () => {
    const live = permissionDeniedMsg({ decision_reason_type: "rule" });
    const denials = [{ tool_name: "bash", tool_use_id: "toolu_denied_1", tool_input: { command: "rm -rf" } }];
    // result_index forces a result-meta on every path, so none passes vacuously.
    const extra = { permission_denials: denials, result_index: 0 };
    const errorArm = { ...resultError("error_during_execution"), ...extra };
    // [path, frames, result-meta events expected]
    const paths: Array<[string, unknown[], number]> = [
      ["ordinary success", [live, { ...resultSuccess("end_turn"), ...extra }], 1],
      ["result-only API error", [live, apiErrorResultFrame(extra)], 1],
      ["stashed + is_error:true success", [live, apiErrorAssistantFrame(), apiErrorResultFrame(extra)], 1],
      ["stashed + is_error:false success", [live, apiErrorAssistantFrame(), { ...resultSuccess("end_turn"), ...extra }], 1],
      ["stashed + error-arm result", [live, apiErrorAssistantFrame(), errorArm], 1],
      ["error-arm result alone", [live, errorArm], 1],
      ["stashed, no result (flush)", [live, apiErrorAssistantFrame()], 0],
      ["LIVE 401 pair", [LIVE_ASSISTANT_ERROR_FRAME, LIVE_RESULT_FRAME], 1],
    ];
    for (const [name, frames, metaCount] of paths) {
      const evs = drive(frames);
      const metas = evs.filter((e) => e.type === "ext.anthropic.result-meta");
      expect(metas, name).toHaveLength(metaCount);
      for (const meta of metas) expect(meta, name).not.toHaveProperty("permissionDenials");
      expect(turnCloses(evs), name).toHaveLength(1);
    }
  });

  it("assistant error frame + ERROR-subtype result → ONE turn.error (the stashed one, no longer two), carrying that result's usage", () => {
    const evs = drive([apiErrorAssistantFrame(), errorResultWithUsage()]);
    const closes = turnCloses(evs);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toEqual({
      type: "turn.error",
      seq: expect.any(Number),
      turnId: API_ERROR_TURN,
      message: "rate_limit",
      code: "rate_limit",
      retriable: true,
      usage: RESULT_USAGE,
    });
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    const turn = r.result().turns.find((t) => t.turnId === API_ERROR_TURN);
    expect(turn?.outcome).toEqual({ type: "error", message: "rate_limit", code: "rate_limit" });
    expect(turn?.usage).toEqual(RESULT_USAGE);

    // Without a stash the error arm is unchanged: its own fields, no usage key.
    // (A result-only turn: named by the error result's own uuid.)
    const alone = turnCloses(drive([errorResultWithUsage()]));
    expect(alone).toEqual([
      {
        type: "turn.error",
        seq: expect.any(Number),
        turnId: "turn_00000000-0000-0000-0000-000000000004",
        message: "max turns reached",
        code: "error_during_execution",
        retriable: true,
      },
    ]);
    expect(alone[0]).not.toHaveProperty("usage");
  });

  it("Tenet 6: a malformed error-subtype result (no usage trio) after an assistant error frame still closes once, with no usage key, and never throws", () => {
    const n = createClaudeNormalizer();
    n.push(JsonValue.parse(apiErrorAssistantFrame()));
    const out = n.push({ type: "result", subtype: "error_during_execution", session_id: "sess_fixture", uuid: "u1" });
    const closes = turnCloses(out);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ type: "turn.error", code: "rate_limit", retriable: true });
    expect(closes[0]).not.toHaveProperty("usage");
    expect(n.flush()).toEqual([]);
    // A PARTIAL usage trio (objects present, but a member mapTurnUsage
    // dereferences is missing or null) is malformed too: still one close, no usage.
    const partials: unknown[] = [
      { usage: {}, modelUsage: {}, total_cost_usd: 0 },
      { usage: { input_tokens: 1, server_tool_use: null }, modelUsage: { m: null }, total_cost_usd: 0 },
    ];
    for (const partial of partials) {
      const p = createClaudeNormalizer();
      p.push(JsonValue.parse(apiErrorAssistantFrame()));
      const frame: unknown = {
        type: "result",
        subtype: "error_during_execution",
        session_id: "sess_fixture",
        uuid: "u1",
        ...(typeof partial === "object" && partial !== null ? partial : {}),
      };
      const pOut = p.push(JsonValue.parse(frame));
      expect(turnCloses(pOut)).toHaveLength(1);
      expect(turnCloses(pOut)[0]).toMatchObject({ type: "turn.error", code: "rate_limit" });
      expect(turnCloses(pOut)[0]).not.toHaveProperty("usage");
      expect(p.flush()).toEqual([]);
    }
  });

  it("FLUSH FALLBACK: an assistant error frame, then end of stream → ONE turn.error at flush (stashed fields, no usage), never turn.abort", () => {
    const n = createClaudeNormalizer();
    const pushed = n.push(JsonValue.parse(apiErrorAssistantFrame()));
    expect(turnCloses(pushed)).toEqual([]);
    const flushed = n.flush();
    expect(flushed).toEqual([
      {
        type: "turn.error",
        seq: expect.any(Number),
        turnId: API_ERROR_TURN,
        message: "rate_limit",
        code: "rate_limit",
        retriable: true,
      },
    ]);
    expect(flushed[0]).not.toHaveProperty("usage");
    const evs = [...pushed, ...flushed];
    assertAllValid(evs);
    expect(evs.some((e) => e.type === "turn.abort")).toBe(false);
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.find((t) => t.turnId === API_ERROR_TURN)?.outcome).toEqual({
      type: "error",
      message: "rate_limit",
      code: "rate_limit",
    });
  });

  it("FIRST error wins: two assistant error frames before the close keep the first frame's fields — at the result and at flush", () => {
    const frames = [
      apiErrorAssistantFrame({ error: "authentication_failed" }),
      secondApiErrorAssistantFrame("rate_limit"),
    ];
    const evs = drive([...frames, apiErrorResultFrame()]);
    const closes = turnCloses(evs);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      turnId: API_ERROR_TURN,
      message: "authentication_failed",
      code: "authentication_failed",
      retriable: false,
      usage: RESULT_USAGE,
    });
    // Both messages are sealed before the one close.
    const types = evs.map((e) => e.type);
    expect(types.filter((t) => t === "message.end")).toHaveLength(2);
    expect(types.lastIndexOf("message.end")).toBeLessThan(types.indexOf("turn.error"));

    const atFlush = turnCloses(drive(frames));
    expect(atFlush).toHaveLength(1);
    expect(atFlush[0]).toMatchObject({ code: "authentication_failed", retriable: false });
    expect(atFlush[0]).not.toHaveProperty("usage");
  });

  // sp-protocol ruling 1 (2026-09-23): a nested-origin error never closes the
  // parent; the parent closes as an error only when its OWN result says so. The
  // nested failure rides a non-terminal `error` event on the NESTED turn.
  const nestedErrors = (evs: AgEvent[]): unknown[] =>
    evs
      .filter((e) => e.type === "error")
      .map((e) => ({ turnId: "turnId" in e ? e.turnId : undefined, code: "code" in e ? e.code : undefined, retriable: "retriable" in e ? e.retriable : undefined }));

  it("ruling 1 (protocol's repro): a nested rate_limit does NOT close a recovered parent — the parent closes success, the nested turn gets one non-terminal `error`", () => {
    const top = assistantMsg([{ type: "tool_use", id: "toolu_t", name: "Task", input: { prompt: "research" } }], null, { stop_reason: "tool_use" });
    const nested = apiErrorAssistantFrame({ parent_tool_use_id: "toolu_t" });
    const taskFailed: unknown = {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t", content: [{ type: "text", text: "subagent failed" }], is_error: true }] },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000d5",
      session_id: "sess_fixture",
    };
    const m2 = { ...(assistantMsg([{ type: "text", text: "recovered", citations: null }]) as object), message: { ...betaMessage([{ type: "text", text: "recovered", citations: null }]), id: "msg_recovered" }, uuid: "00000000-0000-0000-0000-0000000000d6" };
    const evs = drive([top, nested, taskFailed, m2, resultSuccess("end_turn")]);
    // B-strict: the failed Task closes the nested turn with its stashed API error
    // (it wins over the tool_result's own text), no usage, then subagent.done.
    expect(turnCloses(evs).map((e) => [e.type, "turnId" in e ? e.turnId : undefined])).toEqual([
      ["turn.error", API_ERROR_TURN],
      ["turn.done", TOP_TURN],
    ]);
    const nestedClose = evs.findIndex((e) => e.type === "turn.error");
    expect(evs[nestedClose]).toMatchObject({ code: "rate_limit", retriable: true });
    expect(evs[nestedClose]).not.toHaveProperty("usage");
    expect(evs[nestedClose + 1]).toMatchObject({ type: "subagent.done", turnId: API_ERROR_TURN });
    expect(nestedErrors(evs)).toEqual([{ turnId: API_ERROR_TURN, code: "rate_limit", retriable: true }]);
    // Owned by the nested turn: inside its bracket, before its subagent.done.
    const errAt = evs.findIndex((e) => e.type === "error");
    expect(errAt).toBeGreaterThan(evs.findIndex((e) => e.type === "subagent.start"));
    expect(errAt).toBeLessThan(evs.findIndex((e) => e.type === "subagent.done"));
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.find((t) => t.turnId === TOP_TURN)?.outcome).toMatchObject({ type: "success" });
  });

  it("ruling 1: a nested error no longer masks the parent's OWN later error — a top-level billing_error closes the parent as billing_error", () => {
    const top = assistantMsg([{ type: "text", text: "delegating", citations: null }]);
    const nested = apiErrorAssistantFrame({ parent_tool_use_id: "toolu_t" });
    const ownError = { ...(apiErrorAssistantFrame({ error: "billing_error" }) as object), message: { ...betaMessage([{ type: "text", text: API_ERROR_TEXT, citations: null }]), id: "msg_own_error", model: "<synthetic>" }, uuid: "00000000-0000-0000-0000-0000000000d9" };
    const evs = drive([top, nested, ownError, apiErrorResultFrame()]);
    // The parent closes on its OWN billing_error; the nested run (no Task result)
    // outlives it and closes at flush with its own stashed rate_limit (B-strict).
    expect(turnCloses(evs)).toHaveLength(2);
    expect(turnCloses(evs)[0]).toMatchObject({ type: "turn.error", turnId: TOP_TURN, code: "billing_error", retriable: false, usage: RESULT_USAGE });
    expect(turnCloses(evs)[1]).toMatchObject({ type: "turn.error", turnId: API_ERROR_TURN, code: "rate_limit" });
    expect(turnCloses(evs)[1]).not.toHaveProperty("usage");
    expect(nestedErrors(evs)).toEqual([{ turnId: API_ERROR_TURN, code: "rate_limit", retriable: true }]);
  });

  it("ruling 1: when the parent's OWN result says error, it closes as that result's error (not the nested frame's), and a flush with no result aborts the parent", () => {
    const top = assistantMsg([{ type: "text", text: "delegating", citations: null }]);
    const nested = apiErrorAssistantFrame({ parent_tool_use_id: "toolu_parent_1" });
    const evs = drive([top, nested, apiErrorResultFrame()]);
    // No top-level stash: the is_error result closes with its own fields. The
    // nested run closes at flush with its own stashed error (B-strict).
    expect(turnCloses(evs).map((e) => [e.type, "turnId" in e ? e.turnId : undefined, "code" in e ? e.code : undefined])).toEqual([
      ["turn.error", TOP_TURN, "api_error"],
      ["turn.error", API_ERROR_TURN, "rate_limit"],
    ]);
    const alone = drive([top, nested]);
    expect(turnCloses(alone).map((e) => [e.type, "turnId" in e ? e.turnId : undefined])).toEqual([
      ["turn.error", API_ERROR_TURN],
      ["turn.abort", TOP_TURN],
    ]);
    expect(nestedErrors(alone)).toEqual([{ turnId: API_ERROR_TURN, code: "rate_limit", retriable: true }]);
  });

  it("a NESTED error frame with NO top-level turn open fabricates no TOP-LEVEL close (the nested turn closes as its own error), and a later turn is not tainted", () => {
    const nested = apiErrorAssistantFrame({ parent_tool_use_id: "toolu_parent_1" });
    // Stream starts inside a subagent, then a result: the result closes its own
    // result-only turn with ITS fields (not the nested frame's rate_limit).
    const evs = drive([nested, apiErrorResultFrame()]);
    expect(turnCloses(evs)).toHaveLength(2);
    expect(turnCloses(evs)[0]).toMatchObject({ turnId: RESULT_ONLY_TURN, code: "api_error", retriable: true });
    expect(turnCloses(evs)[1]).toMatchObject({ type: "turn.error", turnId: API_ERROR_TURN, code: "rate_limit" });
    // Nested frame alone: no top-level turn ever opened, so no TOP-LEVEL terminal
    // at flush; the nested turn closes with its own failure (B-strict), after its
    // live non-terminal `error`.
    const nestedAlone = drive([nested]);
    expect(turnCloses(nestedAlone).map((e) => [e.type, "turnId" in e ? e.turnId : undefined])).toEqual([["turn.error", API_ERROR_TURN]]);
    expect(nestedErrors(nestedAlone)).toEqual([{ turnId: API_ERROR_TURN, code: "rate_limit", retriable: true }]);
    // Background subagent frames AFTER a result (review of b8ea926, MAJOR 1):
    // the next turn is named by ITS first message and closes as it ended.
    const next = { ...(assistantMsg([{ type: "text", text: "turn two", citations: null }]) as object), message: { ...betaMessage([{ type: "text", text: "turn two", citations: null }]), id: "msg_turn_two" }, uuid: "00000000-0000-0000-0000-0000000000d7" };
    const after = drive([
      assistantMsg([{ type: "text", text: "turn one", citations: null }]),
      resultSuccess("end_turn"),
      nested,
      next,
      { ...resultSuccess("end_turn"), uuid: "00000000-0000-0000-0000-0000000000d8" },
    ]);
    expect(turnCloses(after).map((e) => [e.type, "turnId" in e ? e.turnId : undefined])).toEqual([
      ["turn.done", TOP_TURN],
      ["turn.done", "turn_msg_turn_two"],
      ["turn.error", API_ERROR_TURN],
    ]);
  });

  it("result-only path (no assistant error frame was seen): the result closes the turn with turn.error — message = result text, code = api_error_code, retriable from the HTTP status, usage kept", () => {
    const evs = drive([apiErrorResultFrame({ api_error_code: "rate_limit_exceeded" })]);
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.error"]);
    expect(evs[1]).toMatchObject({ apiErrorCode: "rate_limit_exceeded" });
    expect(evs[2]).toMatchObject({
      type: "turn.error",
      turnId: RESULT_ONLY_TURN,
      message: API_ERROR_TEXT,
      code: "rate_limit_exceeded",
      retriable: true,
      // The same usage mapping turn.done carried before the fix.
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.05, cumulative: true },
    });
    expect(turnCloses(evs)).toHaveLength(1);
  });

  it("result-only path: code falls back to 'api_error'; retriable only for status 429 or >= 500", () => {
    const table: Array<[unknown, boolean]> = [
      [429, true],
      [500, true],
      [503, true],
      [529, true],
      [400, false],
      [401, false],
      [403, false],
      [404, false],
      [413, false],
      [null, false],
    ];
    for (const [status, retriable] of table) {
      const evs = drive([apiErrorResultFrame({ api_error_status: status })]);
      const err = evs.find((e) => e.type === "turn.error");
      expect(err, `status ${String(status)}`).toMatchObject({ code: "api_error", message: API_ERROR_TEXT, retriable });
    }
    // Absent status (an older producer): not retriable, still an error close.
    const evs = drive([withoutKey(apiErrorResultFrame(), "api_error_status")]);
    expect(evs.map((e) => e.type)).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.error"]);
    expect(evs[1]).toMatchObject({ stopReason: "stop_sequence" });
    expect(evs[1]).not.toHaveProperty("apiErrorStatus");
    expect(evs[2]).toMatchObject({ code: "api_error", retriable: false });
  });

  it("result-only path with denials: the `<turnId>:denials` carrier opens as on every turn — then turn.error", () => {
    const evs = drive([
      apiErrorResultFrame({
        permission_denials: [{ tool_name: "bash", tool_use_id: "toolu_denied_1", tool_input: { command: "rm -rf" } }],
      }),
    ]);
    expect(evs.map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "tool.start",
      "tool.done",
      "message.end",
      "ext.anthropic.result-meta",
      "turn.error",
    ]);
    // Only the error close's own carries: api_error_status + stop_reason.
    expect(evs.find((e) => e.type === "ext.anthropic.result-meta")).toMatchObject({ apiErrorStatus: 429, stopReason: "stop_sequence" });
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.find((t) => t.turnId === RESULT_ONLY_TURN)?.outcome).toMatchObject({ type: "error", code: "api_error" });
  });

  it("NEGATIVE CONTROL: with no assistant error frame, is_error false or absent keeps the success path byte-for-byte", () => {
    // The frozen success fixture's exact wire bytes, pinned from the facet
    // before CL-09 (identical at HEAD and before the stash). The one change
    // since: the per-turn ids (INV-TURN, B) name this result-only turn by the
    // result's uuid, not by the session.
    // And since the result-only turn.start (INV-TURN), a turn.start at seq 0.
    const GOLDEN =
      '[{"type":"turn.start","seq":0,"turnId":"turn_00000000-0000-0000-0000-000000000002","threadId":"sess_fixture"},' +
      '{"type":"turn.done","seq":1,"turnId":"turn_00000000-0000-0000-0000-000000000002","outcome":{"type":"success","result":"all done"},' +
      '"finishReason":"stop","usage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":20,"cacheWriteTokens":10,' +
      '"serverToolRequests":0,"costUsd":0.05,"cumulative":true,"byModel":{"claude-opus":{"inputTokens":100,' +
      '"outputTokens":50,"cacheReadTokens":20,"cacheWriteTokens":10,"costUsd":0.05,"serverToolRequests":0,' +
      '"cumulative":true}}}}]';
    expect(JSON.stringify(run(resultSuccess("end_turn")))).toBe(GOLDEN);
    // is_error absent: identical to is_error false, byte for byte.
    expect(JSON.stringify(drive([withoutKey(resultSuccess("end_turn"), "is_error")]))).toBe(GOLDEN);
    // A non-boolean truthy is_error is NOT an API-error turn (strict === true).
    expect(JSON.stringify(drive([{ ...resultSuccess("end_turn"), is_error: "true" }]))).toBe(GOLDEN);
    // Denials on an is_error:false result still use the carrier (golden shape).
    expect(run(resultWithDenial()).map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "tool.start",
      "tool.done",
      "message.end",
      "turn.done",
    ]);
  });

  it("the stash never leaks into a later turn of the same session (every result consumes it)", () => {
    // Turn 1 errors (two-frame pair). Turn 2 is result-only with is_error:true:
    // it gets its own close, built from its own frame.
    const evs = drive([apiErrorAssistantFrame(), apiErrorResultFrame(), apiErrorResultFrame({ api_error_status: 500 })]);
    const closes = turnCloses(evs);
    expect(closes.map((e) => e.type)).toEqual(["turn.error", "turn.error"]);
    expect(closes[0]).toMatchObject({ code: "rate_limit" });
    expect(closes[1]).toMatchObject({ code: "api_error", message: API_ERROR_TEXT, retriable: true });

    // Turn 2 a plain success: turn.done, not turn 1's stale error.
    const thenSuccess = drive([apiErrorAssistantFrame(), apiErrorResultFrame(), resultSuccess("end_turn")]);
    expect(turnCloses(thenSuccess).map((e) => e.type)).toEqual(["turn.error", "turn.done"]);

    // An ERROR-arm result consumes the stash too (emitting it), so the next
    // result-only API-error turn still gets its own close.
    const viaErrorArm = drive([
      apiErrorAssistantFrame(),
      resultError("error_during_execution"),
      apiErrorResultFrame(),
    ]);
    expect(turnCloses(viaErrorArm).map((e) => e.type)).toEqual(["turn.error", "turn.error"]);
    expect(turnCloses(viaErrorArm)[0]).toMatchObject({ code: "rate_limit" });
    expect(turnCloses(viaErrorArm)[1]).toMatchObject({ code: "api_error", message: API_ERROR_TEXT });

    // And so does an is_error:FALSE success result.
    const viaPlainSuccess = drive([apiErrorAssistantFrame(), resultSuccess("end_turn"), apiErrorResultFrame()]);
    expect(turnCloses(viaPlainSuccess).map((e) => e.type)).toEqual(["turn.error", "turn.error"]);
    expect(turnCloses(viaPlainSuccess)[0]).toMatchObject({ code: "rate_limit" });
    expect(turnCloses(viaPlainSuccess)[1]).toMatchObject({ code: "api_error", message: API_ERROR_TEXT });
  });
});

// LIVE EVIDENCE (cohort 0.6.3: claude-agent-sdk 0.3.280, CLI 2.1.280, captured
// 2026-09-22): the frames `query()` yielded for an invalid ANTHROPIC_API_KEY.
// Ten `system`/`api_retry` frames (trimmed here) preceded these two, which are
// verbatim except for scrubbed ids. The CLI gave up after its retries and
// delivered the API error as the synthetic assistant frame (`error:
// "authentication_failed"`) followed by a `subtype: "success"` result with
// `is_error: true` and `api_error_status: 401`.
const LIVE_SESSION = "00000000-0000-4000-8000-00000000c109";
const LIVE_API_ERROR_TEXT = "Failed to authenticate. API Error: 401 API key is invalid.";
const LIVE_ASSISTANT_ERROR_FRAME = {
  type: "assistant",
  message: {
    diagnostics: null,
    id: "00000000-0000-4000-8000-0000000c1091",
    container: null,
    model: "<synthetic>",
    role: "assistant",
    stop_details: null,
    stop_reason: "stop_sequence",
    stop_sequence: "",
    type: "message",
    usage: {
      output_tokens_details: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: null,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: null,
      iterations: null,
      speed: null,
    },
    content: [{ type: "text", text: LIVE_API_ERROR_TEXT }],
    context_management: null,
  },
  parent_tool_use_id: null,
  session_id: LIVE_SESSION,
  uuid: "00000000-0000-4000-8000-0000000c1092",
  timestamp: "2026-09-22T20:05:16.188Z",
  error: "authentication_failed",
  is_api_error_message: true,
};
const LIVE_RESULT_FRAME = {
  duration_api_ms: 0,
  stop_reason: "stop_sequence",
  session_id: LIVE_SESSION,
  total_cost_usd: 0,
  usage: {
    output_tokens_details: { thinking_tokens: 0 },
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: "",
    iterations: [],
    speed: "standard",
  },
  modelUsage: {},
  permission_denials: [],
  terminal_reason: "api_error",
  fast_mode_state: "off",
  fast_mode_disabled_reason: "sdk_opt_in_required",
  subagent_stats: {
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
  },
  is_error: true,
  num_turns: 1,
  subtype: "success",
  api_error_status: 401,
  result: LIVE_API_ERROR_TEXT,
  type: "result",
  duration_ms: 174756,
  uuid: "00000000-0000-4000-8000-0000000c1093",
  queued_turn_count: 0,
  result_index: 0,
};

// ─── result-meta: apiErrorStatus + an error close's stopReason ───────────────
// The api-error-auth seed's census drops 5 and 6 (sp-probe): `api_error_status`
// was read only for `retriable`, and `stop_reason` on a result that closes as
// turn.error had no home (turn.error has no finishReason; finishReasonRaw is
// turn.done-only). Both ride result-meta verbatim; stopReason ONLY on an error
// close, so a success close keeps it on finishReason alone.
describe("createClaudeNormalizer — result-meta apiErrorStatus / error-close stopReason", () => {
  function pushAll(frames: unknown[]): AgEvent[] {
    const n = createClaudeNormalizer();
    const evs = [...frames.flatMap((f) => n.push(JsonValue.parse(f))), ...n.flush()];
    assertAllValid(evs);
    return evs;
  }
  const meta = (evs: AgEvent[]): AgEvent | undefined => evs.find((e) => e.type === "ext.anthropic.result-meta");

  it("an error-subtype result carries its stop_reason; a present api_error_status rides beside it", () => {
    const evs = pushAll([{ ...(resultError("error_max_turns") as object), stop_reason: "tool_use", api_error_status: 529 }]);
    expect(meta(evs)).toMatchObject({ stopReason: "tool_use", apiErrorStatus: 529 });
  });

  it("NEGATIVE CONTROL: a SUCCESS close keeps stop_reason on finishReason only — no result-meta at all (byte-identical)", () => {
    const evs = pushAll([resultSuccess("end_turn")]);
    expect(meta(evs)).toBeUndefined();
    expect(evs.find((e) => e.type === "turn.done")).toMatchObject({ finishReason: "stop" });
  });

  it("NEGATIVE CONTROL: a null or non-number api_error_status carries no key", () => {
    for (const bad of [null, "401"]) {
      const evs = pushAll([{ ...(resultError("error_max_turns") as object), stop_reason: null, api_error_status: bad }]);
      expect(meta(evs) === undefined || !("apiErrorStatus" in (meta(evs) as object))).toBe(true);
    }
  });
});

describe("createClaudeNormalizer — CL-09 LIVE: the captured invalid-API-key frames (401)", () => {
  // INV-TURN (B): named by the live error frame's message id, not the session.
  const LIVE_TURN = "turn_00000000-0000-4000-8000-0000000c1091";

  it("close the turn exactly ONCE, as turn.error authentication_failed (retriable false) carrying the result's usage", () => {
    const evs = drive([LIVE_ASSISTANT_ERROR_FRAME, LIVE_RESULT_FRAME]);
    expect(evs.map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.end",
      "ext.anthropic.result-meta",
      "turn.error",
    ]);
    expect(evs[6]).toMatchObject({
      fastModeDisabledReason: "sdk_opt_in_required",
      queuedTurnCount: 0,
      resultIndex: 0,
    });
    // The live 401 frame's own error facts ride result-meta too (sp-probe's
    // api-error-auth seed): the HTTP status, and the stop_reason an error close
    // has no finishReason slot for.
    expect(evs[6]).toMatchObject({ apiErrorStatus: 401, stopReason: "stop_sequence" });
    const closes = turnCloses(evs);
    expect(closes).toEqual([
      {
        type: "turn.error",
        seq: expect.any(Number),
        turnId: LIVE_TURN,
        message: "authentication_failed",
        code: "authentication_failed",
        retriable: false,
        // The live result's usage: zero tokens and zero cost (the request never
        // authenticated), present all the same. No byModel: modelUsage is {}.
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          serverToolRequests: 0,
          costUsd: 0,
          cumulative: true,
        },
      },
    ]);
    expect(evs.some((e) => e.type === "turn.done" || e.type === "turn.abort")).toBe(false);
  });

  it("reduce() folds the live turn as an error, with its usage, and does not park", () => {
    const r = fold(drive([LIVE_ASSISTANT_ERROR_FRAME, LIVE_RESULT_FRAME]));
    expect(r.needsResync).toBe(false);
    const turn = r.result().turns.find((t) => t.turnId === LIVE_TURN);
    expect(turn?.outcome).toEqual({
      type: "error",
      message: "authentication_failed",
      code: "authentication_failed",
    });
    expect(turn?.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0, cumulative: true });
  });
});

describe("createClaudeNormalizer — the API-error triad (api_error / api_error_params / api_error_code, CLI 2.1.280, undeclared) on the assistant error frame", () => {
  const TRIAD = {
    api_error: "provider_credentials",
    api_error_params: { provider: "bedrock", remedy: "refresh_command" },
    api_error_code: "credentials_expired",
  };

  it("carries all three verbatim, as ONE unit, on the first block's HOST-ONLY _meta (X5); is_api_error_message is NOT carried", () => {
    const evs = drive([apiErrorAssistantFrame(TRIAD)]);
    const first = evs.find((e) => e.type === "text.start");
    expect(first).toMatchObject({ _meta: TRIAD });
    expect((first as { _meta: { [k: string]: unknown } })._meta).toEqual(TRIAD);
    // Nothing of the triad stays on the replay-load-bearing channel.
    expect("providerMetadata" in (first as object)).toBe(false);
    // Fold: the triad lands on the text block's `_meta`, and the turn closes error.
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync).toBe(false);
    const block = r.result().messages.find((m) => m.id === "msg_api_error_1")?.content[0];
    expect(block).toMatchObject({ type: "text", _meta: TRIAD });
    expect(r.result().turns.find((t) => t.turnId === API_ERROR_TURN)?.outcome).toMatchObject({ type: "error" });
    // The carry lands on the message BEFORE its seal and the turn close.
    const types = evs.map((e) => e.type);
    expect(types.indexOf("text.start")).toBeLessThan(types.indexOf("message.end"));
    expect(types.indexOf("message.end")).toBeLessThan(types.indexOf("turn.error"));
  });

  it("each member carries alone (per-frame facts, no member gates another)", () => {
    for (const [k, v] of Object.entries(TRIAD)) {
      const first = drive([apiErrorAssistantFrame({ [k]: v })]).find((e) => e.type === "text.start");
      expect((first as { _meta?: unknown })._meta).toEqual({ [k]: v });
      expect("providerMetadata" in (first as object)).toBe(false);
    }
  });

  it("BLOCK-LESS error frame: the triad rides message.metadata, before message.end and turn.error", () => {
    const evs = drive([apiErrorAssistantFrame(TRIAD, [])]);
    expect(evs.map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "message.metadata",
      "message.end",
      "turn.error",
    ]);
    expect(evs[2]).toMatchObject({ messageId: "msg_api_error_1", metadata: TRIAD });
  });

  it("sits OUTSIDE the turn-binding guard: rides the bag beside user_message_uuid without consuming the once-per-message flag", () => {
    const uuid = "018f0000-0000-7000-8000-00000000e0e0";
    const evs = drive([apiErrorAssistantFrame({ ...TRIAD, user_message_uuid: uuid })]);
    const first = evs.find((e) => e.type === "text.start");
    // X5: split by key — the turn-binding uuid replay-side, the triad host-side.
    expect((first as { providerMetadata?: unknown }).providerMetadata).toEqual({ user_message_uuid: uuid });
    expect((first as { _meta?: unknown })._meta).toEqual(TRIAD);

    // The discriminating case: a CONTINUATION frame of the same message, after
    // an earlier frame already consumed the turn-binding flag. The triad must
    // still ride this frame's first block (only the turn-binding family is
    // once-per-message); a carry moved inside the guard would drop it here.
    const earlier = withoutKey(
      withoutKey(apiErrorAssistantFrame({ user_message_uuid: uuid }), "error"),
      "is_api_error_message",
    );
    const cont = drive([earlier, apiErrorAssistantFrame({ ...TRIAD, user_message_uuid: uuid })]);
    const starts = cont.filter((e) => e.type === "text.start");
    expect(starts).toHaveLength(2);
    expect((starts[0] as { providerMetadata?: unknown }).providerMetadata).toEqual({ user_message_uuid: uuid });
    expect("_meta" in (starts[0] as object)).toBe(false);
    expect((starts[1] as { _meta?: unknown })._meta).toEqual(TRIAD);
    expect("providerMetadata" in (starts[1] as object)).toBe(false);
    expect(cont.filter((e) => e.type === "message.start")).toHaveLength(1);
  });

  it("NEGATIVE CONTROL: absent or malformed triad members leave the stream byte-identical", () => {
    const bare = drive([apiErrorAssistantFrame()]);
    const first = bare.find((e) => e.type === "text.start");
    expect((first as { providerMetadata?: unknown }).providerMetadata).toBeUndefined();
    expect((first as { _meta?: unknown })._meta).toBeUndefined();
    expect(bare.some((e) => e.type === "message.metadata")).toBe(false);
    const malformed = drive([
      apiErrorAssistantFrame({ api_error: 7, api_error_params: "remedy", api_error_code: null }),
    ]);
    expect(malformed).toEqual(bare);
    // And an ordinary (non-error) assistant frame is untouched.
    expect(run(assistantMsg([{ type: "text", text: "hello", citations: null }]))).toEqual(
      drive([assistantMsg([{ type: "text", text: "hello", citations: null }])]),
    );
  });

  it("result-meta.apiErrorCode on the SUCCESS result; absent ⇒ no key, and a non-string is ignored", () => {
    const withCode = drive([apiErrorAssistantFrame(), apiErrorResultFrame({ api_error_code: "overloaded_error" })]);
    expect(withCode.find((e) => e.type === "ext.anthropic.result-meta")).toMatchObject({
      apiErrorCode: "overloaded_error",
    });
    const without = drive([apiErrorAssistantFrame(), apiErrorResultFrame()]);
    expect(without.find((e) => e.type === "ext.anthropic.result-meta")).not.toHaveProperty("apiErrorCode");
    const bad = drive([apiErrorAssistantFrame(), apiErrorResultFrame({ api_error_code: 42 })]);
    expect(bad).toEqual(without);
  });
});

describe("createClaudeNormalizer — usage_report (0.3.273, fixture-only: claude.ai-subscriber sessions) → wrapper carry", () => {
  const USAGE_REPORT = {
    session: {
      total_cost_usd: 1.25,
      total_api_duration_ms: 42000,
      total_duration_ms: 90000,
      total_lines_added: 12,
      total_lines_removed: 0,
      model_usage: {},
    },
    rate_limits: {
      limits: [
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 0,
          resets_at: null,
          scope: null,
          severity: "normal",
          is_active: false,
        },
      ],
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    },
  };

  function usageFrame(extra: { [k: string]: unknown }, content?: unknown[]): unknown {
    return {
      type: "assistant",
      message: {
        ...betaMessage([]),
        id: "msg_usage_1",
        content: content ?? [{ type: "text", text: "Session usage: $1.25", citations: null }],
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000u1",
      session_id: "sess_fixture",
      ...extra,
    };
  }

  it("carries usage_report whole and verbatim (ambient zeros / nulls / false included) on the first block", () => {
    const evs = drive([usageFrame({ usage_report: USAGE_REPORT })]);
    const first = evs.find((e) => e.type === "text.start");
    expect((first as { providerMetadata?: unknown }).providerMetadata).toEqual({ usage_report: USAGE_REPORT });
    expect(fold(evs).needsResync).toBe(false);
  });

  it("merges with the other wrapper siblings (context_usage, aborted) in the one bag", () => {
    const ctx = { model: "claude-opus", total_tokens: 1, raw_max_tokens: 2, percentage: 50, categories: [] };
    const evs = drive([usageFrame({ usage_report: USAGE_REPORT, context_usage: ctx, aborted: true })]);
    const first = evs.find((e) => e.type === "text.start");
    expect((first as { providerMetadata?: unknown }).providerMetadata).toEqual({
      aborted: true,
      context_usage: ctx,
      usage_report: USAGE_REPORT,
    });
  });

  it("sits OUTSIDE the turn-binding guard: a continuation frame after the flag was consumed still carries it", () => {
    const uuid = "018f0000-0000-7000-8000-00000000u0u0";
    const evs = drive([usageFrame({ user_message_uuid: uuid }), usageFrame({ usage_report: USAGE_REPORT })]);
    const starts = evs.filter((e) => e.type === "text.start");
    expect(starts).toHaveLength(2);
    expect((starts[0] as { providerMetadata?: unknown }).providerMetadata).toEqual({ user_message_uuid: uuid });
    expect((starts[1] as { providerMetadata?: unknown }).providerMetadata).toEqual({ usage_report: USAGE_REPORT });
  });

  it("BLOCK-LESS frame: usage_report rides message.metadata", () => {
    const evs = drive([usageFrame({ usage_report: USAGE_REPORT }, [])]);
    expect(evs.find((e) => e.type === "message.metadata")).toMatchObject({
      messageId: "msg_usage_1",
      metadata: { usage_report: USAGE_REPORT },
    });
  });

  it("NEGATIVE CONTROL: no usage_report ⇒ no providerMetadata, no message.metadata", () => {
    const evs = drive([usageFrame({})]);
    const first = evs.find((e) => e.type === "text.start");
    expect((first as { providerMetadata?: unknown }).providerMetadata).toBeUndefined();
    expect(evs.some((e) => e.type === "message.metadata")).toBe(false);
  });
});

describe("createClaudeNormalizer — startup_failure_reason (0.3.274, SDKResultError) → result-meta + turn.error.retriable", () => {
  type SDKResultErrorT = Exclude<Extract<SDKMessage, { type: "result" }>, { subtype: "success" }>;
  type StartupFailureReason = NonNullable<SDKResultErrorT["startup_failure_reason"]>;

  // EVERY documented value, exhaustively (a Record forces a compile error when
  // upstream adds one, so a new value is a decision, never a silent default).
  // true ⇔ upstream itself says a retry may help — only worktree_unverified
  // ("retrying may succeed"). org_verify_failed, remote_settings_required_unavailable
  // and session_held_by_background are deliberate false: upstream never calls
  // them retriable (see `startupFailureRetriable` in src).
  const EXPECTED_RETRIABLE: Record<StartupFailureReason, boolean> = {
    org_pin_api_key_conflict: false,
    org_verify_failed: false,
    org_pin_mismatch: false,
    managed_settings_invalid: false,
    remote_settings_required_unavailable: false,
    gateway_signin_required: false,
    gateway_access_denied: false,
    proxy_invalid: false,
    temp_dir_unusable: false,
    cwd_unavailable: false,
    shell_tool_missing: false,
    session_held_by_background: false,
    worktree_resume_refused: false,
    worktree_unverified: true,
    cli_version_too_old: false,
    bypass_root: false,
  };

  // The zeroed error_during_execution result a stream-json run writes before
  // exiting on a known startup failure ("errors carries the same text as stderr").
  function startupFailure(reason: string): unknown {
    return {
      ...resultError("error_during_execution"),
      errors: ["Claude Code could not start: see stderr"],
      startup_failure_reason: reason,
    };
  }

  it("table: every documented value is carried verbatim as startupFailureReason and decides retriable", () => {
    const table = Object.entries(EXPECTED_RETRIABLE);
    expect(table).toHaveLength(16);
    for (const [reason, retriable] of table) {
      const evs = drive([startupFailure(reason)]);
      expect(evs.map((e) => e.type), reason).toEqual(["turn.start", "ext.anthropic.result-meta", "turn.error"]);
      expect(evs[1], reason).toMatchObject({ startupFailureReason: reason });
      expect(evs[2], reason).toMatchObject({
        type: "turn.error",
        code: "error_during_execution",
        message: "Claude Code could not start: see stderr",
        retriable,
      });
    }
  });

  it("an unknown future value is carried and is NOT retriable (the enum's 'offer the fix instead of a retry' framing)", () => {
    const evs = drive([startupFailure("some_new_reason")]);
    expect(evs[1]).toMatchObject({ startupFailureReason: "some_new_reason" });
    expect(evs[2]).toMatchObject({ type: "turn.error", retriable: false });
  });

  it("NEGATIVE CONTROL: absent (or non-string) reason keeps the old rule and emits no result-meta — byte-identical", () => {
    const during = run(resultError("error_during_execution"));
    expect(during.map((e) => e.type)).toEqual(["turn.start", "turn.error"]);
    expect(during[1]).toMatchObject({ code: "error_during_execution", retriable: true });
    const maxTurns = run(resultError("error_max_turns"));
    expect(maxTurns[1]).toMatchObject({ code: "error_max_turns", retriable: false });
    const malformed = drive([{ ...resultError("error_during_execution"), startup_failure_reason: 3 }]);
    expect(malformed).toEqual(during);
  });
});

describe("createClaudeNormalizer — decision_reason_code (CLI 2.1.280, undeclared) on the live permission_denied frame", () => {
  it("enriches the denial carrier's providerMetadata with decisionReasonCode beside decisionReasonType", () => {
    const live: unknown = {
      ...permissionDeniedMsg({ decision_reason_type: "rule", decision_reason: "outside the working directory" }),
      decision_reason_code: "outside_reads_blocked",
    };
    const evs = drive([live, resultWithDenial()]);
    const done = evs.find((e) => e.type === "tool.done");
    expect((done as { providerMetadata?: unknown }).providerMetadata).toEqual({
      decisionReasonType: "rule",
      decisionReasonCode: "outside_reads_blocked",
      decisionReason: "outside the working directory",
    });
    expect(fold(evs).needsResync).toBe(false);
  });

  it("the code alone still produces the bag (it is a real reason a host can act on)", () => {
    const live: unknown = { ...permissionDeniedMsg(), decision_reason_code: "memory_paused" };
    const done = drive([live, resultWithDenial()]).find((e) => e.type === "tool.done");
    expect((done as { providerMetadata?: unknown }).providerMetadata).toEqual({ decisionReasonCode: "memory_paused" });
  });

  it("NEGATIVE CONTROL: absent or non-string code leaves the enriched pair byte-identical", () => {
    const base = permissionDeniedMsg({ agent_id: "agent_1", decision_reason_type: "classifier" });
    const without = drive([base, resultWithDenial()]);
    const done = without.find((e) => e.type === "tool.done");
    expect((done as { providerMetadata?: unknown }).providerMetadata).toEqual({
      decisionReasonType: "classifier",
      agentId: "agent_1",
    });
    const malformed = drive([{ ...base, decision_reason_code: ["memory_paused"] }, resultWithDenial()]);
    expect(malformed).toEqual(without);
    // No live code, no live fields: still no bag at all (pre-existing behavior).
    const bare = drive([permissionDeniedMsg(), resultWithDenial()]).find((e) => e.type === "tool.done");
    expect((bare as { providerMetadata?: unknown }).providerMetadata).toBeUndefined();
  });
});

// ─── C + D: a harness-stamped denial is `outcome:"denied"`, closed once ──────
// sp-protocol (2026-09-23), conformance, ships in 0.7.0:
//  C: the CLI stamps each is_error tool_result with `tool_result_meta[]
//     .non_execution_kind` (runtime-only). user-rejected / permission-rule /
//     automode-* → "denied" with NO isError / errorText (the native message stays
//     in content); interrupted / cancelled / absent / unknown → "error" unchanged.
//     Never inferred from the result text.
//  D: a permission_denials entry whose id already has its final tool.done in
//     this invoke is skipped; an id not yet closed still gets its carrier pair.
// Live shape: sp-probe's defer-tool-sonnet5-resume-deny (d8cde06, not yet
// enrolled): 3 PreToolUse-hook-blocked calls, each result stamped
// "permission-rule", and the result's permission_denials naming all 3.
describe("createClaudeNormalizer — non_execution_kind denials (C) and the closed-call denials skip (D)", () => {
  const HOOK_TEXT = "PreToolUse:mcp__t__echo hook error: Blocked by hook";

  function useFrame(msgId: string, toolUseId: string, uuid: string): unknown {
    return {
      type: "assistant",
      message: { ...betaMessage([{ type: "tool_use", id: toolUseId, name: "mcp__t__echo", input: { message: "x" } }]), id: msgId },
      parent_tool_use_id: null,
      uuid,
      session_id: "sess_fixture",
    };
  }

  // A tool_result frame; `kind` undefined → no tool_result_meta at all.
  function resultFrame(toolUseId: string, uuid: string, kind?: string, isError = true): unknown {
    return {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: HOOK_TEXT, is_error: isError, tool_use_id: toolUseId }] },
      parent_tool_use_id: null,
      uuid,
      session_id: "sess_fixture",
      tool_use_result: `Error: ${HOOK_TEXT}`,
      ...(kind !== undefined ? { tool_result_meta: [{ id: toolUseId, non_execution_kind: kind }] } : {}),
    };
  }

  function successWithDenials(ids: string[], uuid = "00000000-0000-0000-0000-0000000000d9"): unknown {
    const base: unknown = JSON.parse(JSON.stringify(resultWithDenial()));
    return {
      ...(typeof base === "object" && base !== null ? base : {}),
      uuid,
      permission_denials: ids.map((id) => ({ tool_name: "mcp__t__echo", tool_use_id: id, tool_input: { message: "x" } })),
    };
  }

  function dones(evs: AgEvent[]): Array<{ [k: string]: unknown }> {
    const out: Array<{ [k: string]: unknown }> = [];
    for (const e of evs) if (e.type === "tool.done") out.push(Object.fromEntries(Object.entries(e)));
    return out;
  }

  function oneCall(kind: string | undefined, isError = true): { [k: string]: unknown } | undefined {
    return dones(drive([useFrame("msg_c1", "toolu_c1", "00000000-0000-0000-0000-0000000000c1"), resultFrame("toolu_c1", "00000000-0000-0000-0000-0000000000c2", kind, isError)]))[0];
  }

  it("C: user-rejected, permission-rule and automode-* map to denied, with no isError and no errorText; the native message stays in content", () => {
    // The CLI 2.1.280 enum's three automode-* values, plus one it does not have
    // yet (the prefix rule covers future automode reasons).
    for (const kind of ["user-rejected", "permission-rule", "automode-blocked", "automode-unavailable", "automode-parsing-error", "automode-future-reason"]) {
      const done = oneCall(kind);
      expect(done, kind).toMatchObject({ toolCallId: "toolu_c1", outcome: "denied", content: [{ type: "text", text: HOOK_TEXT }] });
      expect(done !== undefined && "isError" in done, kind).toBe(false);
      expect(done !== undefined && "errorText" in done, kind).toBe(false);
    }
  });

  it("C: interrupted, cancelled, absent meta and an unknown kind all stay error with isError:true (no guessing)", () => {
    for (const kind of ["interrupted", "cancelled", undefined, "zz_future_kind", "automode", "user-rejected-ish"]) {
      expect(oneCall(kind), String(kind)).toMatchObject({ toolCallId: "toolu_c1", outcome: "error", isError: true });
    }
  });

  it("C negative control: is_error:false keeps outcome ok even when a denial kind is stamped", () => {
    expect(oneCall("permission-rule", false)).toMatchObject({ outcome: "ok", isError: false });
  });

  it("C: the kind is matched by tool_use_id; a meta entry for another id, a non-array meta or a malformed entry changes nothing and never throws", () => {
    const withMeta = (meta: unknown): unknown => {
      const f = resultFrame("toolu_c1", "00000000-0000-0000-0000-0000000000c2");
      return { ...(typeof f === "object" && f !== null ? f : {}), tool_result_meta: meta };
    };
    for (const meta of [
      [{ id: "toolu_other", non_execution_kind: "permission-rule" }],
      { id: "toolu_c1", non_execution_kind: "permission-rule" },
      [{ id: "toolu_c1" }],
      [{ id: "toolu_c1", non_execution_kind: 7 }],
      [null, "x", { non_execution_kind: "permission-rule" }],
    ]) {
      const n = createClaudeNormalizer();
      expect(() => n.push(JsonValue.parse(useFrame("msg_c1", "toolu_c1", "00000000-0000-0000-0000-0000000000c1")))).not.toThrow();
      const evs = n.push(JsonValue.parse(withMeta(meta)));
      expect(dones(evs)[0], JSON.stringify(meta)).toMatchObject({ outcome: "error", isError: true });
    }
  });

  it("C: denied folds as denied (a tool-result block with no isError); the result frame's own error restatement is not an errorText", () => {
    const r = fold(drive([useFrame("msg_c1", "toolu_c1", "00000000-0000-0000-0000-0000000000c1"), resultFrame("toolu_c1", "00000000-0000-0000-0000-0000000000c2", "user-rejected"), resultSuccess("end_turn")]));
    expect(r.needsResync).toBe(false);
    const blocks = r.result().messages.flatMap((m) => m.content).filter((b) => "toolCallId" in b && b.toolCallId === "toolu_c1" && "outcome" in b);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ outcome: "denied" });
    expect("isError" in (blocks[0] ?? {})).toBe(false);
    expect("errorText" in (blocks[0] ?? {})).toBe(false);
  });

  it("leg-3 shape (live): 3 hook-blocked results + 3 permission_denials give exactly 3 tool.done, all denied, no carrier, no park", () => {
    const ids = ["toolu_01BREEQMQdDW8fsY1Gu1W1ZK", "toolu_01PJVmyct9fYViJerxicP94g", "toolu_01KPeZiYEqgnJjRpREHuihWx"];
    const evs = drive([
      { type: "command_lifecycle", command_uuid: "c1", state: "started", uuid: "00000000-0000-0000-0000-0000000000e0", session_id: "sess_fixture" },
      // the resumed invoke's leading result (the deferred call's), before init
      resultFrame(ids[0] ?? "", "00000000-0000-0000-0000-0000000000e1", "permission-rule"),
      { type: "system", subtype: "init", uuid: "00000000-0000-0000-0000-0000000000e2", session_id: "sess_fixture" },
      useFrame("msg_leg3_a", ids[1] ?? "", "00000000-0000-0000-0000-0000000000e3"),
      resultFrame(ids[1] ?? "", "00000000-0000-0000-0000-0000000000e4", "permission-rule"),
      useFrame("msg_leg3_b", ids[2] ?? "", "00000000-0000-0000-0000-0000000000e5"),
      resultFrame(ids[2] ?? "", "00000000-0000-0000-0000-0000000000e6", "permission-rule"),
      assistantMsg([{ type: "text", text: "Blocked three times; stopping.", citations: null }]),
      successWithDenials(ids),
    ]);
    const done = dones(evs);
    expect(done.map((d) => [d["toolCallId"], d["outcome"]])).toEqual(ids.map((id) => [id, "denied"]));
    for (const d of done) expect("isError" in d).toBe(false);
    // D: no second tool.start for any id, and no `<turn>:denials` carrier at all.
    for (const id of ids.slice(1)) expect(evs.filter((e) => e.type === "tool.start" && e.toolCallId === id)).toHaveLength(1);
    expect(denialCarrier(evs)).toEqual([]);
    expect(turnCloses(evs)).toHaveLength(1);
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.map((t) => t.outcome?.type)).toEqual(["success"]);
  });

  it("D: only the denials not yet closed get the carrier pair (mixed list)", () => {
    const evs = drive([
      useFrame("msg_d1", "toolu_d1", "00000000-0000-0000-0000-0000000000a1"),
      resultFrame("toolu_d1", "00000000-0000-0000-0000-0000000000a2", "permission-rule"),
      successWithDenials(["toolu_d1", "toolu_never_ran"]),
    ]);
    expect(dones(evs).map((d) => [d["toolCallId"], d["outcome"]])).toEqual([
      ["toolu_d1", "denied"],
      ["toolu_never_ran", "denied"],
    ]);
    const carrier = denialCarrier(evs);
    const carried: unknown[] = [];
    for (const e of carrier) if (typeof e === "object" && e !== null && "toolCallId" in e) carried.push(e.toolCallId);
    expect(carried).toEqual(["toolu_never_ran", "toolu_never_ran"]);
    expect(fold(evs).needsResync).toBe(false);
  });

  it("D: an error-closed call (no meta: a CLI that stamps none) is not re-closed by a denial — it stays error, one tool.start, no park", () => {
    const evs = drive([
      useFrame("msg_d1", "toolu_d1", "00000000-0000-0000-0000-0000000000a1"),
      resultFrame("toolu_d1", "00000000-0000-0000-0000-0000000000a2"),
      successWithDenials(["toolu_d1"]),
    ]);
    expect(dones(evs).map((d) => [d["toolCallId"], d["outcome"]])).toEqual([["toolu_d1", "error"]]);
    expect(evs.filter((e) => e.type === "tool.start")).toHaveLength(1);
    expect(denialCarrier(evs)).toEqual([]);
    expect(fold(evs).needsResync).toBe(false);
  });

  it("D: a denial repeated within one list or across two results in the invoke gets ONE pair (its carrier closed it)", () => {
    const within = drive([successWithDenials(["toolu_x", "toolu_x"])]);
    expect(dones(within).map((d) => d["toolCallId"])).toEqual(["toolu_x"]);
    const n = createClaudeNormalizer();
    const across = [
      ...n.push(JsonValue.parse(successWithDenials(["toolu_x"], "00000000-0000-0000-0000-0000000000b1"))),
      ...n.push(JsonValue.parse(successWithDenials(["toolu_x"], "00000000-0000-0000-0000-0000000000b2"))),
      ...n.flush(),
    ];
    assertAllValid(across);
    expect(dones(across).map((d) => d["toolCallId"])).toEqual(["toolu_x"]);
    expect(across.filter((e) => e.type === "tool.start")).toHaveLength(1);
    expect(fold(across).needsResync).toBe(false);
  });

  it("D keeps the live notice: a permission_denied frame's decision context rides the closing tool_result's tool.done (the carrier no longer does)", () => {
    const evs = drive([
      assistantMsg([{ type: "tool_use", id: "toolu_denied_1", name: "bash", input: { command: "rm -rf" } }]),
      permissionDeniedMsg({ decision_reason_type: "rule", decision_reason: "deny rule", agent_id: "agent_1" }),
      resultFrame("toolu_denied_1", "00000000-0000-0000-0000-0000000000a2", "permission-rule"),
      resultWithDenial(),
    ]);
    const done = dones(evs);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      toolCallId: "toolu_denied_1",
      outcome: "denied",
      providerMetadata: { decisionReasonType: "rule", decisionReason: "deny rule", agentId: "agent_1" },
    });
    expect(denialCarrier(evs)).toEqual([]);
    // Negative control: with no live notice, the closing tool.done has no bag.
    const bare = dones(drive([useFrame("msg_c1", "toolu_c1", "00000000-0000-0000-0000-0000000000c1"), resultFrame("toolu_c1", "00000000-0000-0000-0000-0000000000c2", "permission-rule")]))[0];
    expect(bare !== undefined && "providerMetadata" in bare).toBe(false);
  });

  // Second key (sp-protocol, after 6d980a5): a live permission_denied notice
  // seen before an UNSTAMPED is_error result marks it denied. 2.1.280 stamps no
  // kind on a frame with more than one tool_result, and an older CLI stamps none.
  function twoResultFrame(a: string, b: string): unknown {
    return {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", content: "denied by rule", is_error: true, tool_use_id: a },
          { type: "tool_result", content: [{ type: "text", text: "ran" }], is_error: false, tool_use_id: b },
        ],
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000f7",
      session_id: "sess_fixture",
    };
  }

  it("notice key: with no stamped kind, a prior permission_denied notice for the id closes it denied (no isError), carrying the notice context", () => {
    const evs = drive([
      assistantMsg([{ type: "tool_use", id: "toolu_denied_1", name: "bash", input: { command: "rm -rf" } }]),
      permissionDeniedMsg({ decision_reason_type: "rule" }),
      resultFrame("toolu_denied_1", "00000000-0000-0000-0000-0000000000a2"),
      resultWithDenial(),
    ]);
    const done = dones(evs);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ toolCallId: "toolu_denied_1", outcome: "denied", providerMetadata: { decisionReasonType: "rule" } });
    expect(done[0] !== undefined && "isError" in done[0]).toBe(false);
    expect(denialCarrier(evs)).toEqual([]);
    expect(fold(evs).needsResync).toBe(false);
  });

  it("notice key: the unstamped two-result frame (2.1.280 stamps no kind there): the noticed call is denied, its sibling stays ok", () => {
    const evs = drive([
      assistantMsg([
        { type: "tool_use", id: "toolu_denied_1", name: "bash", input: { command: "rm -rf" } },
        { type: "tool_use", id: "toolu_ok_1", name: "bash", input: { command: "ls" } },
      ]),
      permissionDeniedMsg(),
      twoResultFrame("toolu_denied_1", "toolu_ok_1"),
    ]);
    expect(dones(evs).map((d) => [d["toolCallId"], d["outcome"], d["isError"]])).toEqual([
      ["toolu_denied_1", "denied", undefined],
      ["toolu_ok_1", "ok", false],
    ]);
  });

  it("notice key negative controls: a stamped kind stays primary; is_error:false stays ok; a notice for another id, or one that arrives AFTER the result, changes nothing", () => {
    const stampedInterrupted = dones(drive([permissionDeniedMsg(), resultFrame("toolu_denied_1", "00000000-0000-0000-0000-0000000000a2", "interrupted")]))[0];
    expect(stampedInterrupted).toMatchObject({ outcome: "error", isError: true });
    const notError = dones(drive([permissionDeniedMsg(), resultFrame("toolu_denied_1", "00000000-0000-0000-0000-0000000000a2", undefined, false)]))[0];
    expect(notError).toMatchObject({ outcome: "ok", isError: false });
    const otherId = dones(drive([permissionDeniedMsg(), resultFrame("toolu_other", "00000000-0000-0000-0000-0000000000a2")]))[0];
    expect(otherId).toMatchObject({ outcome: "error", isError: true });
    // No retroactive change: a result already closed stays as it closed.
    const late = drive([resultFrame("toolu_denied_1", "00000000-0000-0000-0000-0000000000a2"), permissionDeniedMsg()]);
    expect(dones(late).map((d) => d["outcome"])).toEqual(["error"]);
  });
});

// ─── sp-probe's resume-unavailable leg (7c6880f): two census new-fields ───────
// `message.diagnostics` rides the first block's host-only `_meta` (once per SDK
// message id); a live user frame with no tool_result (the CLI's isSynthetic
// nudge) rides `ext.anthropic.frame{kind:"user"}` verbatim.
describe("createClaudeNormalizer — message.diagnostics and CLI-added user frames (resume-unavailable leg)", () => {
  const DIAG = { cache_miss_reason: { type: "tools_changed", cache_missed_input_tokens: 3258 } };

  function frameWith(msgId: string, uuid: string, block: unknown, diagnostics: unknown): unknown {
    return {
      type: "assistant",
      message: { ...betaMessage([]), id: msgId, content: [block], ...(diagnostics !== undefined ? { diagnostics } : {}) },
      parent_tool_use_id: null,
      uuid,
      session_id: "sess_fixture",
    };
  }
  const thinking = { type: "thinking", thinking: "", signature: "sig" };
  const text = (t: string): unknown => ({ type: "text", text: t, citations: null });

  function blockStarts(evs: AgEvent[]): Array<{ [k: string]: unknown }> {
    const out: Array<{ [k: string]: unknown }> = [];
    for (const e of evs) if (e.type === "text.start" || e.type === "reasoning.start") out.push(Object.fromEntries(Object.entries(e)));
    return out;
  }

  function nudge(content: unknown = [{ type: "text", text: "[Your previous response had no visible output. Please continue and produce a user-visible response.]" }]): unknown {
    return {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "sess_fixture",
      uuid: "00000000-0000-0000-0000-0000000000n5",
      isSynthetic: true,
    };
  }

  it("diagnostics rides the first block's HOST-ONLY _meta verbatim (never providerMetadata) and folds onto the block", () => {
    const evs = drive([frameWith("msg_diag", "00000000-0000-0000-0000-0000000000d1", thinking, DIAG)]);
    const [start] = blockStarts(evs);
    expect(start).toMatchObject({ type: "reasoning.start", _meta: { diagnostics: DIAG } });
    expect(start?.["providerMetadata"]).toBeUndefined();
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.find((m) => m.id === "msg_diag")?.content[0]).toMatchObject({ _meta: { diagnostics: DIAG } });
  });

  it("once per SDK message id: the same value on a later frame of the message is not repeated; a changed value or a new message carries again", () => {
    const evs = drive([
      frameWith("msg_diag", "00000000-0000-0000-0000-0000000000d1", thinking, DIAG),
      frameWith("msg_diag", "00000000-0000-0000-0000-0000000000d2", text("a"), DIAG),
      frameWith("msg_diag", "00000000-0000-0000-0000-0000000000d3", text("b"), { cache_miss_reason: { type: "model_changed" } }),
      frameWith("msg_diag2", "00000000-0000-0000-0000-0000000000d4", text("c"), DIAG),
    ]);
    expect(blockStarts(evs).map((e) => e["_meta"])).toEqual([
      { diagnostics: DIAG },
      undefined,
      { diagnostics: { cache_miss_reason: { type: "model_changed" } } },
      { diagnostics: DIAG },
    ]);
    expect(fold(evs).needsResync).toBe(false);
  });

  it("negative control: diagnostics null, absent or not an object adds no _meta (output unchanged)", () => {
    for (const d of [null, undefined, "x", [1]]) {
      const [start] = blockStarts(drive([frameWith("msg_diag", "00000000-0000-0000-0000-0000000000d1", text("a"), d)]));
      expect(start !== undefined && "_meta" in start, JSON.stringify(d)).toBe(false);
    }
  });

  it("the CLI's isSynthetic nudge rides ext.anthropic.frame{kind:'user'} verbatim, after the open message is sealed", () => {
    const frame = nudge();
    const evs = drive([frameWith("msg_empty", "00000000-0000-0000-0000-0000000000d1", thinking, null), frame, resultSuccess("end_turn")]);
    const carried = evs.filter((e) => e.type === "ext.anthropic.frame");
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ kind: "user", frame: JsonValue.parse(frame) });
    const types = evs.map((e) => e.type);
    expect(types.indexOf("message.end")).toBeLessThan(types.indexOf("ext.anthropic.frame"));
    expect(fold(evs).needsResync).toBe(false);
  });

  it("a string-content live user frame is carried too; a tool_result frame and a replay are not (negative controls)", () => {
    expect(drive([nudge("plain string content")]).filter((e) => e.type === "ext.anthropic.frame")).toHaveLength(1);
    const toolResult = drive([assistantMsg([{ type: "tool_use", id: "toolu_fixture_1", name: "t", input: {} }]), toolResultMsg()]);
    expect(toolResult.filter((e) => e.type === "ext.anthropic.frame")).toHaveLength(0);
    const replay = { ...(typeof nudge() === "object" ? Object.fromEntries(Object.entries(nudge() ?? {})) : {}), isReplay: true };
    expect(drive([replay])).toEqual([]);
  });

  it("the live leg shape: an unavailable close, then an empty-thinking reply with diagnostics, the nudge, and the success close: no park, both carried", () => {
    const evs = drive([
      { type: "command_lifecycle", command_uuid: "c1", state: "started", uuid: "00000000-0000-0000-0000-0000000000e0", session_id: "sess_fixture" },
      {
        ...(typeof resultSuccess("end_turn") === "object" ? Object.fromEntries(Object.entries(resultSuccess("end_turn"))) : {}),
        is_error: true,
        result: "",
        stop_reason: "tool_deferred_unavailable",
        terminal_reason: "tool_deferred_unavailable",
        deferred_tool_use: { id: "toolu_deferred", name: "mcp__t__echo", input: { message: "x" } },
        uuid: "00000000-0000-0000-0000-0000000000e1",
      },
      frameWith("msg_after", "00000000-0000-0000-0000-0000000000e2", thinking, DIAG),
      nudge(),
      resultSuccess("end_turn"),
    ]);
    expect(turnCloses(evs).map((e) => e.type)).toEqual(["turn.error", "turn.done"]);
    expect(blockStarts(evs)[0]).toMatchObject({ _meta: { diagnostics: DIAG } });
    expect(evs.filter((e) => e.type === "ext.anthropic.frame").map((e) => ("kind" in e ? e.kind : undefined))).toEqual(["command_lifecycle", "user"]);
    expect(fold(evs).needsResync).toBe(false);
  });
});

// ─── result-only error close: code from a non-API terminal_reason (sp-protocol,
// facet-local, 2026-09-23) ────────────────────────────────────────────────────
// The CLI sets is_error on a result that is NOT an API error: sp-probe's
// resume-unavailable leg (7c6880f), terminal_reason "tool_deferred_unavailable",
// result "". code = api_error_code, else a terminal_reason other than
// "completed" (a live API error's own is "api_error", the same code), else
// "api_error"; message = the non-empty result, else the code.
describe("createClaudeNormalizer — the result-only error close names a non-API terminal_reason", () => {
  function isErrorResult(extra: { [k: string]: unknown }): unknown {
    const base = Object.fromEntries(Object.entries(resultSuccess("end_turn")));
    return { ...base, is_error: true, ...extra };
  }
  function close(frame: unknown): { [k: string]: unknown } | undefined {
    const c = turnCloses(drive([frame]))[0];
    return c === undefined ? undefined : Object.fromEntries(Object.entries(c));
  }

  it("the live unavailable shape closes turn.error{code and message: 'tool_deferred_unavailable', retriable:false}; the fold records it", () => {
    const frame = isErrorResult({
      result: "",
      stop_reason: "tool_deferred_unavailable",
      terminal_reason: "tool_deferred_unavailable",
      deferred_tool_use: { id: "toolu_deferred", name: "mcp__t__echo", input: { message: "x" } },
    });
    expect(close(frame)).toMatchObject({
      type: "turn.error",
      message: "tool_deferred_unavailable",
      code: "tool_deferred_unavailable",
      retriable: false,
    });
    const r = fold(drive([frame]));
    expect(r.needsResync).toBe(false);
    expect(r.result().turns[0]?.outcome).toMatchObject({ type: "error", code: "tool_deferred_unavailable" });
  });

  it("precedence: api_error_code beats terminal_reason; a non-empty result stays the message", () => {
    expect(close(isErrorResult({ api_error_code: "billing_blocked", terminal_reason: "tool_deferred_unavailable", result: "Billing." }))).toMatchObject({
      code: "billing_blocked",
      message: "Billing.",
    });
    expect(close(isErrorResult({ terminal_reason: "budget_exhausted", result: "Out of budget." }))).toMatchObject({
      code: "budget_exhausted",
      message: "Out of budget.",
    });
  });

  it("negative controls: terminal_reason 'api_error', 'completed', empty or absent keeps code 'api_error' and the result text (the live api-error-auth close is unchanged)", () => {
    for (const tr of ["api_error", "completed", "", undefined]) {
      const frame = isErrorResult({ result: "API Error: 401", ...(tr !== undefined ? { terminal_reason: tr } : {}) });
      expect(close(frame), String(tr)).toMatchObject({ code: "api_error", message: "API Error: 401" });
    }
  });

  it("an empty result with no cause falls back to the code as the message (never an empty message)", () => {
    expect(close(isErrorResult({ result: "" }))).toMatchObject({ code: "api_error", message: "api_error" });
  });

  it("mirror: when the assistant error frame already decided the close, the result's terminal_reason changes nothing", () => {
    const withStash = drive([apiErrorAssistantFrame(), apiErrorResultFrame({ terminal_reason: "tool_deferred_unavailable" })]);
    const without = drive([apiErrorAssistantFrame(), apiErrorResultFrame()]);
    expect(turnCloses(withStash)).toEqual(turnCloses(without));
  });
});

// ─── SPEC:933 — push() never throws on a LIVE (not JSON round-tripped) frame ──
// sp-google found it on google-adk; sp-probe reproduced it here (bb319bf): a
// host pushing an in-process object whose members are not JSON (an undefined
// member, a Date, NaN, a function) made push() THROW (ZodError from a
// JsonValue.parse site; `JSON.stringify(input)` for the args delta on a cycle).
// No 0.3.280 SDK frame trips it: the SDK parses the CLI's NDJSON, and its one
// in-process frame (mirror_error) is strings only. The fix normalizes the frame
// ONCE at push() entry (core toJsonValueSafe), so a live frame folds exactly as
// its JSON form, which is what every capture already is.
describe("createClaudeNormalizer — a live, non-JSON frame never throws out of push() (SPEC:933)", () => {
  // `push` is typed JsonValue; a host that skips the JSON boundary gets here
  // without a type error (e.g. `any` from a relay). Reach it the same way.
  function pushLive(frames: unknown[]): AgEvent[] {
    const n = createClaudeNormalizer();
    const push: (native: unknown) => AgEvent[] = (native) => Reflect.apply(n.push, n, [native]);
    return [...frames.flatMap((f) => push(f)), ...n.flush()];
  }
  function pushJson(frames: unknown[]): AgEvent[] {
    const n = createClaudeNormalizer();
    return [...frames.flatMap((f) => n.push(JsonValue.parse(JSON.parse(JSON.stringify(f))))), ...n.flush()];
  }
  function toolUseFrame(input: unknown): unknown {
    return {
      type: "assistant",
      message: { ...betaMessage([]), content: [{ type: "tool_use", id: "toolu_live", name: "t", input }] },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000l1",
      session_id: "sess_fixture",
    };
  }

  it("RED-first (sp-probe's reproduction): tool_use.input {a: undefined, d: Date} folds exactly as its JSON form", () => {
    const frames = [toolUseFrame({ a: undefined, d: new Date(0), keep: 1 })];
    expect(() => pushLive(frames)).not.toThrow();
    expect(JSON.stringify(pushLive(frames))).toBe(JSON.stringify(pushJson(frames)));
    expect(pushLive(frames).find((e) => e.type === "tool.args.assembled")).toMatchObject({ input: { d: "1970-01-01T00:00:00.000Z", keep: 1 } });
  });

  it("every JSON-defined hostile member, at every carry site, folds serialized-identical to its JSON round trip", () => {
    const hostile: Array<[string, unknown]> = [
      ["undefined member", { a: undefined, b: 1 }],
      ["Date", { when: new Date(0) }],
      ["NaN and Infinity", { n: NaN, i: Infinity }],
      ["function", { f: () => 1, b: 2 }],
    ];
    const sites: Array<[string, (v: unknown) => unknown[]]> = [
      ["tool_use.input", (v) => [toolUseFrame(v)]],
      ["carried frame", (v) => [{ type: "command_lifecycle", command_uuid: "c", state: "started", uuid: "00000000-0000-0000-0000-0000000000l2", session_id: "sess_fixture", extra: v }]],
      ["unknown top-level type", (v) => [{ type: "zz_future", uuid: "00000000-0000-0000-0000-0000000000l3", session_id: "sess_fixture", extra: v }]],
      ["tool_result structuredContent", (v) => [
        toolUseFrame({}),
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_live", content: [], is_error: false, structuredContent: v }] }, parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-0000000000l4", session_id: "sess_fixture" },
      ]],
      ["result structured_output", (v) => [{ ...Object.fromEntries(Object.entries(resultSuccess("end_turn"))), structured_output: v }]],
    ];
    for (const [hName, value] of hostile) {
      for (const [sName, build] of sites) {
        const frames = build(value);
        let live: AgEvent[] = [];
        expect(() => { live = pushLive(frames); }, `${sName} / ${hName}`).not.toThrow();
        expect(JSON.stringify(live), `${sName} / ${hName}`).toBe(JSON.stringify(pushJson(frames)));
      }
    }
  });

  it("where JSON has no form, core's documented rule applies: a BigInt is its decimal string, a node repeating an ancestor is \"[Circular]\"", () => {
    const cyc: { [k: string]: unknown } = { keep: 1 };
    cyc["self"] = cyc;
    const evs = pushLive([toolUseFrame({ big: 10n, cyc })]);
    expect(evs.find((e) => e.type === "tool.args.assembled")).toMatchObject({ input: { big: "10", cyc: { keep: 1, self: "[Circular]" } } });
    expect(evs.find((e) => e.type === "tool.args.delta")).toMatchObject({ delta: JSON.stringify({ big: "10", cyc: { keep: 1, self: "[Circular]" } }) });
    // Every carry site survives both, and the fold never parks.
    for (const frames of [
      [{ type: "command_lifecycle", command_uuid: "c", state: "started", uuid: "00000000-0000-0000-0000-0000000000l2", session_id: "sess_fixture", extra: { big: 1n, cyc } }],
      [{ type: "zz_future", uuid: "00000000-0000-0000-0000-0000000000l3", session_id: "sess_fixture", extra: { big: 1n, cyc } }],
      [{ ...Object.fromEntries(Object.entries(resultSuccess("end_turn"))), structured_output: { big: 1n, cyc } }],
    ]) {
      let live: AgEvent[] = [];
      expect(() => { live = pushLive(frames); }).not.toThrow();
      expect(fold(live).needsResync).toBe(false);
    }
  });

  it("a frame that is not an SDKMessage after conversion still lands on ext.anthropic.unparsed, converted (never a throw)", () => {
    const evs = pushLive([{ type: 42, junk: undefined, when: new Date(0) }]);
    expect(evs).toEqual([expect.objectContaining({ type: "ext.anthropic.unparsed", native: { type: 42, when: "1970-01-01T00:00:00.000Z" } })]);
  });

  it("negative control: a plain-JSON frame's output is unchanged (the fixture every other test pushes)", () => {
    const frames = [toolUseFrame({ city: "SF" }), resultSuccess("end_turn")];
    expect(JSON.stringify(pushLive(frames))).toBe(JSON.stringify(pushJson(frames)));
  });
});

// ─── no emitted event aliases the pushed frame (cto, on the live-JSON swap) ───
// toJsonValueSafe hands a JSON frame back BY REFERENCE, and core's
// StreamAssembler does not copy, so any native value the facet puts into an
// event without a zod parse (which copies) is shared with the host's live
// object. Four paths did (all pre-dating the swap): result-meta.userMessageUuids,
// the streamed turn-binding message.metadata.user_message_uuids, the block-less
// wrapper message.metadata (narration_block_indexes / user_message_uuids), and
// ext.anthropic.unparsed.native (the whole frame).
describe("createClaudeNormalizer — no emitted event shares an object with the pushed frame", () => {
  function refsOf(v: unknown, set: Set<object> = new Set()): Set<object> {
    if (typeof v === "object" && v !== null && !set.has(v)) {
      set.add(v);
      for (const x of Object.values(v)) refsOf(x, set);
    }
    return set;
  }
  function aliases(ev: unknown, refs: Set<object>, path: string, out: string[]): string[] {
    if (typeof ev === "object" && ev !== null) {
      if (refs.has(ev)) out.push(path);
      for (const [k, x] of Object.entries(ev)) aliases(x, refs, `${path}.${k}`, out);
    }
    return out;
  }
  function aliasPaths(frames: unknown[]): string[] {
    const n = createClaudeNormalizer();
    const push: (native: unknown) => AgEvent[] = (native) => Reflect.apply(n.push, n, [native]);
    const out: string[] = [];
    for (const f of frames) {
      const refs = refsOf(f);
      for (const ev of push(f)) aliases(ev, refs, ev.type, out);
    }
    for (const ev of n.flush()) aliases(ev, new Set(), ev.type, out);
    return out;
  }
  const UUIDS = ["00000000-0000-0000-0000-0000000000u1", "00000000-0000-0000-0000-0000000000u2"];

  it("result-meta.userMessageUuids is a copy", () => {
    const frame = { ...Object.fromEntries(Object.entries(resultSuccess("end_turn"))), user_message_uuids: [...UUIDS] };
    const evs = drive([frame]);
    expect(evs.find((e) => e.type === "ext.anthropic.result-meta")).toMatchObject({ userMessageUuids: UUIDS });
    expect(aliasPaths([frame])).toEqual([]);
  });

  it("the block-less wrapper message.metadata (narration_block_indexes, user_message_uuids) is a copy", () => {
    const frame = {
      type: "assistant",
      message: { ...betaMessage([]), id: "msg_blockless" },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000a1",
      session_id: "sess_fixture",
      narration_block_indexes: [0],
      user_message_uuids: [...UUIDS],
    };
    const evs = drive([frame]);
    expect(evs.some((e) => e.type === "message.metadata")).toBe(true);
    expect(aliasPaths([frame])).toEqual([]);
  });

  it("the streamed turn-binding message.metadata.user_message_uuids is a copy", () => {
    const start = {
      type: "stream_event",
      event: { type: "message_start", message: { ...betaMessage([]), id: "msg_streamed" } },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000s1",
      session_id: "sess_fixture",
      user_message_uuids: [...UUIDS],
    };
    const evs = drive([start]);
    expect(evs.find((e) => e.type === "message.metadata")).toMatchObject({ metadata: { user_message_uuids: UUIDS } });
    expect(aliasPaths([start])).toEqual([]);
  });

  // The same three checks over every committed claude native (sp-probe's corpus,
  // all JSON: exactly the frames push() now hands through by reference).
  const corpusDir = fileURLToPath(new URL("../../e2e/corpus/", import.meta.url));
  function corpusSeeds(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const d of readdirSync(corpusDir)) {
      const p = `${corpusDir}${d}/claude.native.json`;
      if (existsSync(p)) out.push([d, readFileSync(p, "utf8")]);
    }
    return out;
  }
  function framesOf(text: string): unknown[] {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  }

  it("corpus: no emitted event shares an object with its pushed frame (every committed claude native)", () => {
    const seeds = corpusSeeds();
    expect(seeds.length).toBeGreaterThan(20);
    for (const [seed, text] of seeds) expect(aliasPaths(framesOf(text)), seed).toEqual([]);
  });

  it("corpus: the facet never mutates a pushed frame (deep-frozen frames replay without a throw)", () => {
    const deepFreeze = (v: unknown): unknown => {
      if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
        Object.freeze(v);
        for (const x of Object.values(v)) deepFreeze(x);
      }
      return v;
    };
    for (const [seed, text] of corpusSeeds()) {
      const n = createClaudeNormalizer();
      const push: (native: unknown) => AgEvent[] = (native) => Reflect.apply(n.push, n, [native]);
      expect(() => { for (const f of framesOf(text)) push(deepFreeze(f)); n.flush(); }, seed).not.toThrow();
    }
  });

  it("corpus: the facet keeps no reference it reads later (scrambling each frame after its push changes no later output)", () => {
    const scramble = (v: unknown, seen: Set<object> = new Set()): void => {
      if (typeof v === "object" && v !== null && !seen.has(v)) {
        seen.add(v);
        for (const k of Object.keys(v)) {
          scramble(Reflect.get(v, k), seen);
          Reflect.set(v, k, "SCRAMBLED");
        }
      }
    };
    for (const [seed, text] of corpusSeeds()) {
      const clean = createClaudeNormalizer();
      const expected = JSON.stringify([...framesOf(text).flatMap((f) => clean.push(JsonValue.parse(f))), ...clean.flush()]);
      const n = createClaudeNormalizer();
      const push: (native: unknown) => AgEvent[] = (native) => Reflect.apply(n.push, n, [native]);
      const seen: unknown[] = [];
      for (const f of framesOf(text)) {
        seen.push(...JSON.parse(JSON.stringify(push(f))));
        scramble(f);
      }
      seen.push(...JSON.parse(JSON.stringify(n.flush())));
      expect(JSON.stringify(seen), seed).toBe(expected);
    }
  });

  it("ext.anthropic.unparsed carries a copy of the (converted) frame, not the host's object", () => {
    const junk = { type: 42, nested: { deep: [1, { x: 2 }] } };
    const evs = aliasPaths([junk]);
    expect(evs).toEqual([]);
    expect(drive([junk])).toEqual([expect.objectContaining({ type: "ext.anthropic.unparsed", native: junk })]);
  });
});

// ─── DC-10: the positional fallback turn id is unique across invokes ──────────
// sp-protocol's D3 bar / sp-probe's cross-invoke guard: guuey folds a whole
// conversation into ONE Reducer, and `turn_frame_<n>` (a result with no uuid)
// depended only on wire position, so two invokes named the same turn. The
// fold did NOT park: a silent id reuse, so ids are compared directly.
describe("createClaudeNormalizer — DC-10: fallback turn ids never repeat across invokes", () => {
  const noUuidResult = (): unknown => ({
    type: "result", subtype: "success", is_error: false, result: "hi", session_id: "s", num_turns: 1,
    duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
  });
  const starts = (evs: AgEvent[]): string[] => {
    const out: string[] = [];
    for (const e of evs) if (e.type === "turn.start" && e.turnId !== undefined) out.push(e.turnId);
    return out;
  };
  const invoke = (n: ReturnType<typeof createClaudeNormalizer>): AgEvent[] => [...n.push(JsonValue.parse(noUuidResult())), ...n.flush()];

  it("sp-probe's leg: two fresh normalizers, the same uuid-less result, folded into ONE Reducer: distinct turn ids, no park, two turns", () => {
    const first = invoke(createClaudeNormalizer());
    const second = invoke(createClaudeNormalizer());
    expect(starts(first)).toHaveLength(1);
    expect(starts(second)).toHaveLength(1);
    expect(starts(second).filter((t) => starts(first).includes(t))).toEqual([]);
    const r = fold([...first, ...second]);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns).toHaveLength(2);
  });

  it("the stem is minted once per normalizer, outside the atomic-push rebuild: a fallback id minted after a rebuild shares the stem of one minted before it", () => {
    const n = createClaudeNormalizer();
    const push: (native: unknown) => AgEvent[] = (native) => Reflect.apply(n.push, n, [native]);
    const throwing = { type: "assistant", message: { ...betaMessage([]), id: "msg_x", content: [null] }, parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-0000000000x1", session_id: "s" };
    const evs = [...push(noUuidResult()), ...push(throwing), ...push(noUuidResult()), ...n.flush()];
    expect(evs.filter((e) => e.type === "error")).toHaveLength(1);
    const ids = starts(evs);
    expect(ids).toHaveLength(2);
    const stem = (id: string): string | undefined => /^turn_(claude_[0-9a-f]{16})_frame_\d+$/.exec(id)?.[1];
    expect(stem(ids[0] ?? "")).toBeDefined();
    expect(stem(ids[1] ?? "")).toBe(stem(ids[0] ?? ""));
    expect(new Set(ids).size).toBe(2);
  });

  it("invokeId pins the stem (capture / replay / tests); the normal path is unchanged by it", () => {
    expect(starts(invoke(createClaudeNormalizer({ invokeId: "pin" })))).toEqual(["turn_pin_frame_1"]);
    const evs = drive([assistantMsg([{ type: "text", text: "hi", citations: null }]), resultSuccess("end_turn")]);
    expect(starts(evs)).toEqual([TOP_TURN]);
  });
});

// ─── the atomic-push guard (core withAtomicPush; the fleet guard ruling) ──────
// An envelope-valid but malformed frame throws inside the inner normalizer;
// its partial batch and state are discarded (rebuild + re-drive), and one core
// `error` takes the next seq.
describe("createClaudeNormalizer — withAtomicPush: a throwing frame leaves no trace but one payload-free error", () => {
  // Passes isSDKMessage (message.id, content array), opens its turn, message
  // and text block, THEN throws on the null block.
  const throwsAfterOpen = (): unknown => ({
    type: "assistant",
    message: { ...betaMessage([]), id: "msg_guard_throw", content: [{ type: "text", text: "partial", citations: null }, null] },
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-0000000000g9",
    session_id: "sess_fixture",
  });
  const guardErrors = (evs: AgEvent[]): AgEvent[] => evs.filter((e) => e.type === "error" && e.message === "normalizer error");

  it("(a) a throw after the frame opened a turn, message and block, then normal frames: one error, nothing of the frame, seq gap-free, no park, every message closed once", () => {
    const n = createClaudeNormalizer();
    const push: (native: unknown) => AgEvent[] = (native) => Reflect.apply(n.push, n, [native]);
    const evs = [
      ...push(assistantMsg([{ type: "text", text: "before", citations: null }])),
      ...push(throwsAfterOpen()),
      ...push(resultSuccess("end_turn")),
      ...push({ ...Object.fromEntries(Object.entries(assistantMsg([{ type: "text", text: "after", citations: null }]))), message: { ...betaMessage([{ type: "text", text: "after", citations: null }]), id: "msg_after" }, uuid: "00000000-0000-0000-0000-0000000000g8" }),
      ...n.flush(),
    ];
    expect(guardErrors(evs)).toEqual([expect.objectContaining({ type: "error", message: "normalizer error", code: "TypeError" })]);
    expect(JSON.stringify(evs)).not.toContain("msg_guard_throw");
    expect(JSON.stringify(evs)).not.toContain("partial");
    evs.forEach((e, i) => expect(e.seq).toBe(i));
    const starts = evs.filter((e) => e.type === "message.start").map((e) => ("id" in e ? e.id : undefined));
    const ends = evs.filter((e) => e.type === "message.end").map((e) => ("id" in e ? e.id : undefined));
    expect([...ends].sort()).toEqual([...starts].sort());
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().turns.map((t) => t.outcome?.type)).toEqual(["success", "aborted"]);
  });

  it("(b) a SECRET_ marker in the thrown error's message and in the native never reaches the wire", () => {
    const secretNative = {
      type: "assistant",
      message: { ...betaMessage([]), id: "msg_secret", content: [{ type: "tool_use", id: "toolu_secret", name: "t", input: { SECRET_native: "SECRET_value" } }] },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-0000000000g7",
      session_id: "sess_fixture",
    };
    const realStringify = JSON.stringify;
    // Throw from inside the facet, AFTER tool.start: the args-delta stringify of
    // exactly this tool input, with the marker in the error's message.
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((v: unknown, ...rest: unknown[]) => {
      if (typeof v === "object" && v !== null && Object.hasOwn(v, "SECRET_native")) throw new SyntaxError("bad input SECRET_error");
      return Reflect.apply(realStringify, JSON, [v, ...rest]);
    });
    let evs: AgEvent[] = [];
    try {
      const n = createClaudeNormalizer();
      evs = [...n.push(JsonValue.parse(secretNative)), ...n.flush()];
    } finally {
      spy.mockRestore();
    }
    expect(guardErrors(evs)).toEqual([expect.objectContaining({ code: "SyntaxError" })]);
    expect(JSON.stringify(evs)).not.toContain("SECRET_");
    expect(evs).toEqual([expect.objectContaining({ type: "error", message: "normalizer error", code: "SyntaxError", seq: 0 })]);
  });
});

// ─── rd-15: defer the field, fix the carries (founder ruling 2026-09-24) ──────
// cto's conditions: every carry sits in a home that FOLDS (readable and durable),
// never providerMetadata; zero golden moves (no committed native carries these).
describe("createClaudeNormalizer — rd-15 carries: host-readable homes that fold", () => {
  function frameWith(extra: { [k: string]: unknown }, message: { [k: string]: unknown } = {}): { [k: string]: unknown } {
    return {
      ...Object.fromEntries(Object.entries(assistantMsg([{ type: "text", text: "hi", citations: null }]))),
      message: { ...betaMessage([{ type: "text", text: "hi", citations: null }]), ...message },
      ...extra,
    };
  }
  const firstBlockStart = (evs: AgEvent[]): { [k: string]: unknown } | undefined => {
    const e = evs.find((x) => x.type === "text.start");
    return e === undefined ? undefined : Object.fromEntries(Object.entries(e));
  };

  it("error_details, advisor_model and attribution_agent ride the first block's HOST-ONLY _meta verbatim and fold onto the block", () => {
    const wrapper = { error_details: "prompt is too long: 210000 tokens > 200000 maximum", advisor_model: "claude-opus-5-5", attribution_agent: "code-reviewer" };
    const evs = drive([frameWith(wrapper), resultSuccess("end_turn")]);
    const start = firstBlockStart(evs);
    expect(start?.["_meta"]).toEqual(wrapper);
    expect(start?.["providerMetadata"]).toBeUndefined();
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.find((m) => m.id === "msg_fixture_1")?.content[0]).toMatchObject({ _meta: wrapper });
  });

  it("negative control: absent or non-string wrapper values carry nothing (output unchanged)", () => {
    const plain = drive([frameWith({}), resultSuccess("end_turn")]);
    const junk = drive([frameWith({ error_details: 7, advisor_model: null, attribution_agent: { a: 1 } }), resultSuccess("end_turn")]);
    expect(JSON.stringify(junk)).toBe(JSON.stringify(plain));
    expect(firstBlockStart(plain) !== undefined && "_meta" in (firstBlockStart(plain) ?? {})).toBe(false);
  });

  const REFUSAL = {
    type: "refusal",
    category: "cyber",
    explanation: "This request was declined.",
    fallback_credit_token: "SECRET_credit_top",
    fallbacks: [{ model: "claude-opus-5-5", fallback_credit_token: "SECRET_credit_nested" }],
  };
  const REFUSAL_CARRIED = { type: "refusal", category: "cyber", explanation: "This request was declined.", fallbacks: [{ model: "claude-opus-5-5" }] };

  it("a non-null stop_details rides the closing turn.done.messageMetadata (naming its message), every fallback_credit_token stripped, and folds onto that message", () => {
    const evs = drive([frameWith({}, { stop_details: REFUSAL, stop_reason: "refusal" }), resultSuccess("refusal")]);
    const done = evs.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({ messageId: "msg_fixture_1", messageMetadata: { stop_details: REFUSAL_CARRIED } });
    expect(JSON.stringify(evs)).not.toContain("fallback_credit_token");
    expect(JSON.stringify(evs)).not.toContain("SECRET_credit");
    const r = fold(evs);
    expect(r.needsResync).toBe(false);
    expect(r.result().messages.find((m) => m.id === "msg_fixture_1")?.messageMetadata).toEqual({ stop_details: REFUSAL_CARRIED });
  });

  it("only the CLOSING response's value: a later top-level response of the turn without stop_details clears it", () => {
    const later = { ...frameWith({}, { id: "msg_later" }), uuid: "00000000-0000-0000-0000-0000000000r2" };
    const evs = drive([frameWith({}, { stop_details: REFUSAL }), later, resultSuccess("end_turn")]);
    const done = evs.find((e) => e.type === "turn.done");
    expect(done !== undefined && ("messageMetadata" in done || "messageId" in done)).toBe(false);
  });

  it("negative control: null stop_details (every committed golden) leaves turn.done byte-identical; a nested frame's stop_details is not the turn's", () => {
    const withNull = drive([frameWith({}, { stop_details: null }), resultSuccess("end_turn")]);
    const without = drive([frameWith({}), resultSuccess("end_turn")]);
    expect(JSON.stringify(withNull)).toBe(JSON.stringify(without));
    const done = withNull.find((e) => e.type === "turn.done");
    expect(done !== undefined && ("messageMetadata" in done || "messageId" in done)).toBe(false);
    const nested = { ...frameWith({}, { id: "msg_nested", stop_details: REFUSAL }), parent_tool_use_id: "toolu_task", uuid: "00000000-0000-0000-0000-0000000000r3" };
    const withNested = drive([frameWith({}), nested, resultSuccess("end_turn")]);
    const nestedDone = withNested.find((e) => e.type === "turn.done");
    expect(nestedDone !== undefined && "messageMetadata" in nestedDone).toBe(false);
  });
});

// ─── B-strict nested terminals (draft.4; the founder's nested-turn ruling Q1) ──
// sp-protocol's §10 item 22 statement, checked on every stream below: for every
// subagent.start, exactly ONE turn.done | turn.error | turn.abort with that
// turnId, carrying no usage, IMMEDIATELY followed by that turn's subagent.done;
// no nested turnId equals a turn.start turnId; and folding the stream with its
// subagent.done events removed gives a structurally identical AgReduceResult.
describe("createClaudeNormalizer — B-strict nested terminals", () => {
  const TERMINALS = new Set(["turn.done", "turn.error", "turn.abort"]);
  function assertBStrict(evs: AgEvent[]): void {
    const nested: string[] = [];
    for (const e of evs) if (e.type === "subagent.start" && e.turnId !== undefined) nested.push(e.turnId);
    const topStarts = new Set<string>();
    for (const e of evs) if (e.type === "turn.start" && e.turnId !== undefined) topStarts.add(e.turnId);
    for (const id of nested) {
      expect(topStarts.has(id), `nested ${id} is also a top-level turn`).toBe(false);
      const closes = evs.flatMap((e, i) => (TERMINALS.has(e.type) && "turnId" in e && e.turnId === id ? [i] : []));
      expect(closes, `terminals for ${id}`).toHaveLength(1);
      const at = closes[0] ?? -1;
      expect(evs[at], `nested terminal ${id} carries no usage`).not.toHaveProperty("usage");
      expect(evs[at + 1], `subagent.done right after ${id}'s terminal`).toMatchObject({ type: "subagent.done", turnId: id });
    }
    // Removing events leaves seq holes, which park under INV-SEQ, so the
    // subagent.done-free stream is renumbered gap-free before it is folded.
    const whole = fold(evs);
    const withoutDone = fold(evs.filter((e) => e.type !== "subagent.done").map((e, i) => ({ ...e, seq: i })));
    expect(whole.needsResync).toBe(false);
    expect(withoutDone.needsResync).toBe(false);
    expect(withoutDone.result()).toEqual(whole.result());
  }
  const taskUse = (id: string): unknown =>
    assistantMsg([{ type: "tool_use", id, name: "Task", input: { prompt: "research" } }], null, { stop_reason: "tool_use" });
  const nestedText = (msgId: string, parent: string, uuid: string): unknown => ({
    ...Object.fromEntries(Object.entries(assistantMsg([{ type: "text", text: "working", citations: null }], parent))),
    message: { ...betaMessage([{ type: "text", text: "working", citations: null }]), id: msgId },
    uuid,
  });
  const taskResult = (id: string, extra: { [k: string]: unknown } = {}, isError = false, text = "done"): unknown => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] },
    parent_tool_use_id: null,
    uuid: `00000000-0000-0000-0000-0000000000b${id.slice(-1)}`,
    session_id: "sess_fixture",
    ...extra,
  });
  const notification = (fields: { [k: string]: unknown }): unknown => ({
    type: "system", subtype: "task_notification", task_id: "task_1", output_file: "/tmp/o", summary: "", uuid: "00000000-0000-0000-0000-0000000000c9", session_id: "sess_fixture", ...fields,
  });
  const closesOf = (evs: AgEvent[], turnId: string): unknown[] =>
    evs.filter((e) => TERMINALS.has(e.type) && "turnId" in e && e.turnId === turnId).map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== "seq")));

  it("a foreground Task that COMPLETED closes its nested turn with turn.done{success, finishReason:'unknown'}, no usage, right before subagent.done; the fold records it", () => {
    const evs = drive([taskUse("toolu_t1"), nestedText("msg_sub1", "toolu_t1", "00000000-0000-0000-0000-0000000000a1"), taskResult("toolu_t1", { tool_use_result: { status: "completed", agentId: "a1" } }), resultSuccess("end_turn")]);
    expect(closesOf(evs, "turn_msg_sub1")).toEqual([{ type: "turn.done", turnId: "turn_msg_sub1", outcome: { type: "success" }, finishReason: "unknown" }]);
    assertBStrict(evs);
    expect(fold(evs).result().turns.find((t) => t.turnId === "turn_msg_sub1")?.outcome).toEqual({ type: "success" });
  });

  it("a failed Task (is_error) closes its nested turn with turn.error naming the tool result's text, no usage", () => {
    const evs = drive([taskUse("toolu_t2"), nestedText("msg_sub2", "toolu_t2", "00000000-0000-0000-0000-0000000000a2"), taskResult("toolu_t2", {}, true, "subagent crashed"), resultSuccess("end_turn")]);
    expect(closesOf(evs, "turn_msg_sub2")).toEqual([{ type: "turn.error", turnId: "turn_msg_sub2", message: "subagent crashed" }]);
    assertBStrict(evs);
  });

  it("a BACKGROUND launch (status async_launched) keeps the run open past the parent's close; a task_notification closes it: completed → success, failed → error, stopped → aborted", () => {
    for (const [status, expected] of [
      ["completed", { type: "turn.done", outcome: { type: "success" }, finishReason: "unknown" }],
      ["failed", { type: "turn.error", message: "it broke", code: "failed" }],
      ["stopped", { type: "turn.abort", reason: "stopped" }],
    ] as const) {
      const evs = drive([
        taskUse("toolu_t3"),
        nestedText("msg_sub3", "toolu_t3", "00000000-0000-0000-0000-0000000000a3"),
        taskResult("toolu_t3", { tool_use_result: { status: "async_launched", agentId: "a3" } }),
        resultSuccess("end_turn"),
        notification({ tool_use_id: "toolu_t3", status, summary: "it broke" }),
      ]);
      const types = evs.map((e) => e.type);
      expect(types.indexOf("turn.done"), status).toBeLessThan(evs.findIndex((e) => e.type === "subagent.done"));
      expect(closesOf(evs, "turn_msg_sub3"), status).toEqual([{ turnId: "turn_msg_sub3", ...expected }]);
      assertBStrict(evs);
    }
  });

  it("a task_notification without tool_use_id correlates through its task_started's task_id; one for an unknown task closes nothing", () => {
    const started = { type: "system", subtype: "task_started", task_id: "task_1", tool_use_id: "toolu_t4", description: "d", uuid: "00000000-0000-0000-0000-0000000000c8", session_id: "sess_fixture" };
    const evs = drive([taskUse("toolu_t4"), started, nestedText("msg_sub4", "toolu_t4", "00000000-0000-0000-0000-0000000000a4"), taskResult("toolu_t4", { tool_use_result: { status: "async_launched" } }), resultSuccess("end_turn"), notification({ status: "completed" })]);
    expect(closesOf(evs, "turn_msg_sub4")).toEqual([{ type: "turn.done", turnId: "turn_msg_sub4", outcome: { type: "success" }, finishReason: "unknown" }]);
    assertBStrict(evs);
    const stray = drive([taskUse("toolu_t5"), nestedText("msg_sub5", "toolu_t5", "00000000-0000-0000-0000-0000000000a5"), taskResult("toolu_t5", { tool_use_result: { status: "remote_launched" } }), resultSuccess("end_turn"), notification({ task_id: "task_other", status: "completed" })]);
    expect(closesOf(stray, "turn_msg_sub5")).toEqual([{ type: "turn.abort", turnId: "turn_msg_sub5", reason: "stream-truncated" }]);
    assertBStrict(stray);
  });

  it("no success is ever fabricated for a background run: with no notification, flush aborts it", () => {
    const evs = drive([taskUse("toolu_t6"), nestedText("msg_sub6", "toolu_t6", "00000000-0000-0000-0000-0000000000a6"), taskResult("toolu_t6", { tool_use_result: { status: "async_launched" } }), resultSuccess("end_turn")]);
    expect(closesOf(evs, "turn_msg_sub6")).toEqual([{ type: "turn.abort", turnId: "turn_msg_sub6", reason: "stream-truncated" }]);
    assertBStrict(evs);
  });

  it("a Task result with no attributable tool_use_result (a multi-result frame) is the completion report: success (pending the live capture)", () => {
    const both = {
      type: "user",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_t7", content: [{ type: "text", text: "done" }], is_error: false },
        { type: "tool_result", tool_use_id: "toolu_other", content: [{ type: "text", text: "x" }], is_error: false },
      ] },
      parent_tool_use_id: null,
      tool_use_result: { status: "async_launched" },
      uuid: "00000000-0000-0000-0000-0000000000b7",
      session_id: "sess_fixture",
    };
    const evs = drive([taskUse("toolu_t7"), nestedText("msg_sub7", "toolu_t7", "00000000-0000-0000-0000-0000000000a7"), both, resultSuccess("end_turn")]);
    expect(closesOf(evs, "turn_msg_sub7")).toEqual([{ type: "turn.done", turnId: "turn_msg_sub7", outcome: { type: "success" }, finishReason: "unknown" }]);
    assertBStrict(evs);
  });

  it("the §10 item 22 property holds on every nested stream the facet tests build here (terminal before subagent.done, no usage, fold unchanged without subagent.done)", () => {
    const streams: unknown[][] = [
      [taskUse("toolu_p1"), nestedText("msg_p1", "toolu_p1", "00000000-0000-0000-0000-0000000000a8"), nestedText("msg_p2", "toolu_p1", "00000000-0000-0000-0000-0000000000a9"), taskResult("toolu_p1", { tool_use_result: { status: "completed" } }), resultSuccess("end_turn")],
      [taskUse("toolu_p2"), nestedText("msg_p3", "toolu_p2", "00000000-0000-0000-0000-0000000000aa"), apiErrorAssistantFrame({ parent_tool_use_id: "toolu_p2" }), taskResult("toolu_p2", {}, true), resultSuccess("end_turn")],
      [nestedText("msg_p4", "toolu_p3", "00000000-0000-0000-0000-0000000000ab")],
    ];
    for (const frames of streams) assertBStrict(drive(frames));
  });
});

// ─── every verbatim carrier drops provider credit tokens at any depth ─────────
// "A normalizer MUST NOT emit a provider credit or bearer token in any event"
// (rd-15 / §13.7 queued) holds on EVERY path that forwards a native subtree
// whole, not only the stop_details carry. Each case injects, at depth, a subtree
// {keep, deep:[{fallback_credit_token, other}]} into one carrier: KEEP_<n> must
// reach the wire (the path really carried it), the token must not.
describe("createClaudeNormalizer — verbatim carries drop provider credit tokens at any depth", () => {
  const sub = (n: number): { [k: string]: unknown } => ({ keep: `KEEP_${n}`, deep: [{ fallback_credit_token: `SECRET_credit_${n}`, other: 1 }] });
  const asstWith = (content: unknown[], wrapper: { [k: string]: unknown } = {}, message: { [k: string]: unknown } = {}): unknown => ({
    ...Object.fromEntries(Object.entries(assistantMsg([]))),
    message: { ...betaMessage([]), content, ...message },
    ...wrapper,
  });
  const text = { type: "text", text: "hi", citations: null };
  const streamStart: unknown = { type: "stream_event", event: { type: "message_start", message: { ...betaMessage([]), id: "msg_stream_tok" } }, parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-0000000000s1", session_id: "sess_fixture" };
  const CASES: Array<[string, (n: number) => unknown[]]> = [
    ["provider-raw assistant block", (n) => [asstWith([{ type: "zz_server_result", ...sub(n) }])]],
    ["provider-raw tool-result part", (n) => [
      asstWith([{ type: "tool_use", id: "toolu_tok", name: "t", input: {} }]),
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_tok", content: [{ type: "zz_part", ...sub(n) }], is_error: false }] }, parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-0000000000t2", session_id: "sess_fixture" },
    ]],
    ["stream_event frame (unmappable)", (n) => [streamStart, { type: "stream_event", event: { type: "zz_future_event", ...sub(n) }, parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-0000000000s2", session_id: "sess_fixture" }]],
    ["stream provider-raw block", (n) => [streamStart, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "zz_server_result", ...sub(n) } }, parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-0000000000s3", session_id: "sess_fixture" }]],
    ["wrapper context_usage", (n) => [asstWith([text], { context_usage: sub(n) })]],
    ["wrapper usage_report", (n) => [asstWith([text], { usage_report: sub(n) })]],
    ["message diagnostics", (n) => [asstWith([text], {}, { diagnostics: sub(n) })]],
    ["wrapper api_error_params", (n) => [asstWith([text], { api_error_params: sub(n) })]],
    ["result subagent_stats", (n) => [{ ...Object.fromEntries(Object.entries(resultSuccess("end_turn"))), subagent_stats: sub(n) }]],
    ["CLI-added user frame", (n) => [{ type: "user", message: { role: "user", content: [{ type: "text", text: "nudge" }] }, parent_tool_use_id: null, isSynthetic: true, uuid: "00000000-0000-0000-0000-0000000000u9", session_id: "sess_fixture", extra: sub(n) }]],
    ["model_refusal_fallback frame", (n) => [{ ...Object.fromEntries(Object.entries(modelRefusalFallbackMsg())), extra: sub(n) }]],
    ["item-22 carried frame", (n) => [{ ...Object.fromEntries(Object.entries(hookResponseMsg())), extra: sub(n) }]],
    ["unknown top-level frame", (n) => [{ type: "zz_future_type", uuid: "00000000-0000-0000-0000-0000000000z1", session_id: "sess_fixture", ...sub(n) }]],
    ["ext.anthropic.unparsed", (n) => [{ type: 42, ...sub(n) }]],
  ];

  it.each(CASES.map(([name, build], i) => [name, build, i] as const))("%s: the subtree is carried, its fallback_credit_token is not", (_name, build, i) => {
    const wire = JSON.stringify(drive(build(i)));
    expect(wire).toContain(`KEEP_${i}`);
    expect(wire).not.toContain("fallback_credit_token");
    expect(wire).not.toContain("SECRET_");
  });

  it("negative control: a model- or tool-authored payload is NOT stripped (a key named fallback_credit_token in tool input is user content)", () => {
    const evs = drive([asstWith([{ type: "tool_use", id: "toolu_user", name: "t", input: { fallback_credit_token: "user-data" } }])]);
    expect(evs.find((e) => e.type === "tool.args.assembled")).toMatchObject({ input: { fallback_credit_token: "user-data" } });
  });
});

// ─── ids across invokes: a nested result for a run this invoke never opened ────
// sp-protocol's message.start bar (wf_140b3183-767) restates rd-14's rule as a
// §8.0 producer MUST: turn ids never repeat across the invokes one Reducer
// folds. The top-level no-open-turn tool.done the bar cited already opens its
// own uuid-named turn (B-resume 37185be). The nested case did not: it named the
// synthetic `turn_<parent_tool_use_id>`, a turn nobody opened, repeated by every
// invoke that started mid-run, and the one-Reducer fold parked.
describe("createClaudeNormalizer — ids across invokes: no-open-turn results", () => {
  const U = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const asstFrame = (id: string, content: unknown[], uuid: string): unknown => ({
    ...Object.fromEntries(Object.entries(assistantMsg([]))),
    message: { ...betaMessage([]), id, content },
    uuid,
  });
  const toolResultFrame = (toolUseId: string, uuid: string, parent: string | null): unknown => ({
    type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: "ok" }], is_error: false }] }, parent_tool_use_id: parent, uuid, session_id: "sess_fixture",
  });
  const namedTurns = (evs: AgEvent[]): Set<string> => {
    const out = new Set<string>();
    for (const e of evs) if ("turnId" in e && typeof e.turnId === "string") out.add(e.turnId);
    return out;
  };
  const twoInvokes = (inv1: unknown[], inv2: unknown[]): { e1: AgEvent[]; e2: AgEvent[]; repeated: string[]; r: Reducer } => {
    const e1 = drive(inv1);
    const e2 = drive(inv2);
    const first = namedTurns(e1);
    const repeated = [...namedTurns(e2)].filter((t) => first.has(t));
    return { e1, e2, repeated, r: fold([...e1, ...e2]) };
  };

  it("a background agent's nested result in a LATER invoke (its run never opened there): no turn id repeats, and one Reducer folds both invokes without a park", () => {
    const { e2, repeated, r } = twoInvokes(
      [asstFrame("msg_b1", [{ type: "tool_use", id: "toolu_bg", name: "Task", input: {} }], U(11)), toolResultFrame("toolu_x1", U(12), "toolu_bg"), { ...resultSuccess("end_turn"), uuid: U(13) }],
      [toolResultFrame("toolu_x2", U(21), "toolu_bg"), asstFrame("msg_b2", [{ type: "text", text: "next", citations: null }], U(22)), { ...resultSuccess("end_turn"), uuid: U(23) }],
    );
    expect(repeated).toEqual([]);
    expect(r.needsResync).toBe(false);
    expect(e2.find((e) => e.type === "tool.done")).toMatchObject({ toolCallId: "toolu_x2", turnId: `turn_${U(21)}` });
  });

  it("the path the bar cited: a top-level tool_result with no turn open (a resumed invoke's first frame) opens its own uuid-named turn: no repeat, no park", () => {
    const { e2, repeated, r } = twoInvokes(
      [asstFrame("msg_a1", [{ type: "tool_use", id: "toolu_def", name: "t", input: {} }], U(1)), { ...resultSuccess("end_turn"), uuid: U(2) }],
      [toolResultFrame("toolu_def", U(3), null), asstFrame("msg_a2", [{ type: "text", text: "done", citations: null }], U(4)), { ...resultSuccess("end_turn"), uuid: U(5) }],
    );
    expect(repeated).toEqual([]);
    expect(r.needsResync).toBe(false);
    expect(e2.find((e) => e.type === "tool.done")).toMatchObject({ turnId: `turn_${U(3)}` });
  });
});

// ─── C1: an honest flush (INV-FLUSH (3), draft.4; the fold/flush ruling) ──────
// The founder's ruling: "snapshot fold + honest flush; opaque at flush
// FORBIDDEN". A flush lands no new content: only lifecycle closes (text.end with
// already-received citations, reasoning.end, message.end, the turn/nested
// closes). The open blocks' scratch is DROPPED: no tool.args.assembled minted
// from a truncated partial_json (CB-12), no reasoning.opaque, no compaction
// content.block. §10 item 26 leg (a), claude's share.
describe("createClaudeNormalizer — C1: flush never mints content", () => {
  const se = (event: unknown, uuid = "00000000-0000-0000-0000-0000000000f0"): unknown => ({
    type: "stream_event", event, parent_tool_use_id: null, uuid, session_id: "sess_fixture",
  });
  const SIG = "SIGNATURE_RECEIVED_IN_FULL";
  // A stream cut off with an open text block, an open reasoning block (its
  // signature fully received), a partial tool call and an open compaction block.
  const truncated = (): unknown[] => [
    se({ type: "message_start", message: { ...betaMessage([]), id: "msg_cut" } }),
    se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } }),
    se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial answer" } }),
    se({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } }),
    se({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "hmm" } }),
    se({ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: SIG } }),
    se({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_cut", name: "get_weather", input: {} } }),
    se({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city": "S' } }),
    se({ type: "content_block_start", index: 3, content_block: { type: "compaction", content: "summary so far", encrypted_content: "ENC" } }),
  ];
  const ALLOWED_AT_FLUSH = new Set(["text.end", "reasoning.end", "step.done", "subagent.done", "message.end", "turn.abort", "turn.error"]);

  it("leg (a): every flush() event is a content-free lifecycle close; nothing is minted; no success; every turn folds to a defined outcome", () => {
    const n = createClaudeNormalizer();
    const before = truncated().flatMap((f) => n.push(JsonValue.parse(f)));
    const atFlush = n.flush();
    const all = [...before, ...atFlush];
    assertAllValid(all);
    expect(atFlush.map((e) => e.type).filter((t) => !ALLOWED_AT_FLUSH.has(t))).toEqual([]);
    for (const t of ["tool.args.assembled", "reasoning.opaque", "content.block"]) expect(all.filter((e) => e.type === t), t).toEqual([]);
    expect(JSON.stringify(all)).not.toContain(SIG);
    // The partial args still rode the deltas losslessly; only the authoritative
    // assembled input is not minted.
    expect(all.filter((e) => e.type === "tool.args.delta").map((e) => ("delta" in e ? e.delta : undefined))).toEqual(['{"city": "S']);
    expect(atFlush.some((e) => isClosedEvent(e) && e.type === "turn.done" && e.outcome.type === "success")).toBe(false);
    // The text block still closes (text.end at flush stays), and so does the reasoning block, with no phase.
    expect(atFlush.filter((e) => e.type === "text.end" || e.type === "reasoning.end").map((e) => e.type)).toEqual(["text.end", "reasoning.end"]);
    expect(atFlush.find((e) => e.type === "reasoning.end")).not.toHaveProperty("phase");
    const r = fold(all);
    expect(r.needsResync).toBe(false);
    for (const t of r.result().turns) expect(t.outcome, t.turnId).toBeDefined();
  });

  it("negative control: a binding frame that seals the message MID-stream (not a flush) still finalizes the open tool call as its content_block_stop would", () => {
    const sealing = { type: "user", message: { role: "user", content: [{ type: "text", text: "interrupt" }] }, parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-0000000000f9", session_id: "sess_fixture" };
    const frames = [
      se({ type: "message_start", message: { ...betaMessage([]), id: "msg_mid" } }),
      se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_mid", name: "get_weather", input: {} } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city": "SF"}' } }),
      sealing,
    ];
    const n = createClaudeNormalizer();
    const evs = frames.flatMap((f) => n.push(JsonValue.parse(f)));
    expect(evs.find((e) => e.type === "tool.args.assembled")).toMatchObject({ toolCallId: "toolu_mid", input: { city: "SF" } });
  });
});
