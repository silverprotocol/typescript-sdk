import { describe, it, expect } from "vitest";
import {
  reduce,
  Reducer,
  AgEvent,
  AgClosedEvent,
  AgReduceResult,
  AgInput,
  AgA2uiFunctionResponse,
  AgA2uiError,
  toWire,
  toJsonValue,
} from "@silverprotocol/core";
import type { JsonValue } from "@silverprotocol/core";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import type { AdkEvent, AdkPart } from "@silverprotocol/google-adk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";

// ─────────────────────────────────────────────────────────────────────────────
// §10 Conformance Suite (audit M55 — "§10 items are prose, zero executable
// fixtures — folklore-grade conformance").
//
// Home: packages/e2e, not core. This file needs BOTH the core reduce()/AgEvent
// surface (for the framework-neutral items) AND the facet normalizers
// (createAdkNormalizer / createOpenaiNormalizer) for the framework-scoped
// items — e2e is the one package in this workspace that already depends on
// core + all three facets (claude-agent-sdk, google-adk, openai-agents).
//
// Every SPEC.md §10 item (HEAD: 20 items — grown from M55's original 19
// through batches A–C) gets exactly one disposition per leg:
//
//   RUNNABLE    a self-contained fixture below IS the proof of the claim.
//               Reduce-level event vectors for framework-neutral items;
//               facet-driven (createXNormalizer over a minimal native event
//               vector) for framework-scoped items.
//   COVERED-BY  the proof already lives in a named EXISTING test elsewhere
//               in this workspace; this file carries a thin confirming
//               re-assertion of the same claim + the file:line citation
//               (never a re-import or a duplicate of a big suite).
//   N/A         it.skip with the §8/§10 scoping citation: either the claim
//               needs an AgJSON→native emit/re-input surface this ingest-only
//               SDK does not ship (§10 preamble: "ingest-only normalizers
//               record them N/A"), or the claim is scoped to a framework
//               with no in-repo emitter (only claude-agent-sdk, google-adk,
//               openai-agents exist here — no LangChain/LangGraph/Pydantic-AI
//               facet).
//
// The manifest below is the 20-item accounting the task requires: every
// SPEC.md §10 item NUMBER 1–20 is represented by at least one manifest row.
// Items 4 and 17 expand into lettered/named legs because SPEC.md's own item
// text splits their claims across sub-claims with different testability —
// "no item silently absent" is enforced per LEG, and the accounting test
// below asserts the union of item numbers is exactly {1..20}.
// ─────────────────────────────────────────────────────────────────────────────

type Disposition = "RUNNABLE" | "COVERED-BY" | "N/A";

interface Section10Item {
  n: number; // SPEC.md §10 item number (1-20)
  leg?: string; // sub-leg label when the item's own text splits its claim
  title: string;
  disposition: Disposition;
  citation: string;
}

const SPEC_10_MANIFEST: Section10Item[] = [
  { n: 1, title: "reduce() invariant (full fold table + block insertion order)", disposition: "COVERED-BY", citation: "reduce.test.ts:2301-2333 \"R10 capstone\"" },
  { n: 2, title: "Reconnect (forward-gap park + snapshot-resync; backward jump folds normally)", disposition: "COVERED-BY", citation: "reduce.test.ts:1828-1953 (R9 e1-e6) + :1635-1828 (d1-d4)" },
  { n: 3, title: "Tool-result routing matrix (content/structuredContent/uiData/sideData)", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.3" },
  { n: 4, leg: "a", title: "Gemini signature loop — tool-call signature (ingest leg)", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.4(a), facet-driven via createAdkNormalizer" },
  { n: 4, leg: "b", title: "Gemini signature loop — thinking-only turn", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.4(b), facet-driven via createAdkNormalizer" },
  { n: 4, leg: "c", title: "Gemini signature loop — Google-Search-grounded turn", disposition: "N/A", citation: "§10 preamble emit/re-input carve-out; no built-in-tool-step signature carrier in google-adk" },
  { n: 4, leg: "openai", title: "OpenAI stateless reasoning loop (rs_/encrypted_content)", disposition: "N/A", citation: "§10 preamble emit/re-input carve-out (ingest-capture sub-claim already COVERED by openai-agents/src/index.test.ts:1212-1258)" },
  { n: 5, title: "Source round-trips (MCP base64 + Anthropic url/file)", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.5" },
  { n: 6, title: "Mandatory display (display.required not dropped)", disposition: "COVERED-BY", citation: "reduce.test.ts:1049 \"(h) display.required appends…\"" },
  { n: 7, title: "safety_blocked category", disposition: "COVERED-BY", citation: "openai-agents/src/index.test.ts:776 \"content_filter incomplete…\"" },
  { n: 8, title: "Cumulative-usage verbatim fold (INV-DELTA)", disposition: "COVERED-BY", citation: "reduce.test.ts:791-826 (a) + :91 (b2)" },
  { n: 9, title: "ADK aggregate suppression", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.9, facet-driven via createAdkNormalizer" },
  { n: 10, title: "Index→id re-key (LangChain/Pydantic)", disposition: "N/A", citation: "no LangChain/Pydantic-AI facet in this repo" },
  { n: 11, title: "LangGraph positional pause", disposition: "N/A", citation: "no LangGraph facet in this repo" },
  { n: 12, title: "Interleaved subagent + parent", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.12, reduce-level" },
  { n: 13, title: "Replay-blob round-trips", disposition: "N/A", citation: "§10 preamble emit/re-input carve-out (ingest-capture sub-claim already COVERED by reduce.test.ts:280)" },
  { n: 14, title: "A2UI RPC round-trips (per-arm)", disposition: "COVERED-BY", citation: "agjson.test.ts:1003-1253 \"AgSurfaceInteraction\"" },
  { n: 15, title: "Gemini parallel ordering", disposition: "N/A", citation: "§10 preamble emit/re-input carve-out; §8 item 7 scoping" },
  { n: 16, title: "A2A initial-Task (no double-seed on artifact update)", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.16, reduce-level" },
  { n: 17, leg: "a", title: "Signature reassembly — reasoning.opaque.delta fragments", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.17(a), reduce-level" },
  { n: 17, leg: "b", title: "Signature reassembly — id-fragmented tool call (Pydantic)", disposition: "N/A", citation: "no Pydantic-AI facet in this repo" },
  { n: 18, title: "MCP MRTR requestState round-trip", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.18, wire/schema-level" },
  { n: 19, title: "A2UI component streaming", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.19, wire round-trip" },
  { n: 20, title: "Malformed input at a trust boundary", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.20" },
];

describe("§10 conformance accounting (audit M55)", () => {
  it("covers every SPEC.md §10 item 1–20 at least once, each row disposed RUNNABLE | COVERED-BY | N/A", () => {
    const nums = new Set(SPEC_10_MANIFEST.map((i) => i.n));
    expect(Array.from(nums).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const item of SPEC_10_MANIFEST) {
      expect(["RUNNABLE", "COVERED-BY", "N/A"]).toContain(item.disposition);
      expect(item.citation.length).toBeGreaterThan(0);
    }
  });
});

// Shared reduce-level event helpers (mirrors core/src/reduce.test.ts's own
// TURN_START/MSG_START convention).
const TURN_START = { type: "turn.start" as const, seq: 0, threadId: "th1", turnId: "t1" };
const MSG_START = {
  type: "message.start" as const,
  seq: 1,
  id: "m1",
  role: "assistant" as const,
  turnId: "t1",
  threadId: "th1",
};

// ─────────────────────────────────────────────────────────────────────────────
// §10.1 — reduce() invariant (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.1 — reduce() invariant: stream → reduce == AgReduceResult (full §5 fold table incl. block insertion order)", () => {
  it("COVERED-BY reduce.test.ts:2301-2333 \"reduce — R10 capstone\" (byte-identity against a hand-spelled EXPECTED_RESULT + interleaved-block-kind ordering over the FULL folding table); thin confirming re-assertion below", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      { type: "text.start", seq: 2, id: "b1", turnId: "t1" },
      { type: "text.delta", seq: 3, id: "b1", delta: "hi" },
      { type: "text.end", seq: 4, id: "b1" },
      { type: "reasoning.start", seq: 5, id: "b2", turnId: "t1" },
      { type: "reasoning.delta", seq: 6, id: "b2", delta: "thinking" },
      { type: "reasoning.end", seq: 7, id: "b2" },
      { type: "tool.start", seq: 8, toolCallId: "tc1", name: "calc", turnId: "t1", threadId: "th1" },
      { type: "tool.args.assembled", seq: 9, toolCallId: "tc1", input: { x: 1 } },
      { type: "turn.done", seq: 10, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
    ]).result;
    const content = r.messages[0]?.content ?? [];
    expect(content.map((b) => b.type)).toEqual(["text", "reasoning", "tool-call"]); // insertion order preserved
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.2 — Reconnect (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.2 — Reconnect: stream-with-gap + messages.snapshot → reduce == AgReduceResult", () => {
  it("COVERED-BY reduce.test.ts:1828-1953 (R9 e1-e6 forward-gap/park/snapshot-recovery) + :1635-1828 (d1-d4 messages.snapshot conditional-replace); thin confirming re-assertion: forward gap parks, snapshot resyncs, backward jump (new-invoke 0-restart) folds normally", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "text.start", seq: 5, id: "b1", turnId: "t1" }); // forward gap (skipped seq 1-4)
    expect(acc.needsResync).toBe(true);
    acc.push({
      type: "messages.snapshot",
      seq: 6,
      messages: [{ id: "recovered", role: "assistant", content: [], turnId: "t1", threadId: "th1" }],
    });
    expect(acc.needsResync).toBe(false); // snapshot-resync clears the park

    // A backward seq jump — a new invoke's 0-restart — folds normally, no park.
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t2" });
    expect(acc.needsResync).toBe(false);
    expect(acc.result().turns.find((t) => t.turnId === "t2")).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.3 — Tool-result routing matrix (RUNNABLE)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.3 — tool-result routing matrix: content→model, structuredContent→model(structured), uiData→surface(model-hidden), sideData→app-only (SPEC §2.1)", () => {
  it("all four channels survive the fold independently, verbatim, with no cross-channel bleed", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      { type: "tool.start", seq: 2, toolCallId: "tc1", name: "search", turnId: "t1", threadId: "th1" },
      {
        type: "tool.done",
        seq: 3,
        toolCallId: "tc1",
        turnId: "t1",
        threadId: "th1",
        content: [{ type: "text", text: "3 results" }], // → model (content)
        structuredContent: { rows: [1, 2, 3] }, // → model, structured (structuredContent)
        uiData: { view: "table", rows: [1, 2, 3] }, // → surface/view, model-HIDDEN (uiData)
        sideData: { cacheKey: "internal-only" }, // → app-only (sideData)
        outcome: "ok",
      },
    ]).result;
    const block = r.messages[0]?.content[1];
    expect(block?.type).toBe("tool-result");
    if (block?.type === "tool-result") {
      expect(block.content).toEqual([{ type: "text", text: "3 results" }]);
      expect(block.structuredContent).toEqual({ rows: [1, 2, 3] });
      expect(block.uiData).toEqual({ view: "table", rows: [1, 2, 3] });
      expect(block.sideData).toEqual({ cacheKey: "internal-only" });
    }
    // Routing semantics (SPEC §2.1): reduce() has no "audience" flag — the
    // audience is ENCODED by which field a consumer reads. This fixture
    // proves the four channels are independently addressable and never
    // conflated (e.g. sideData never leaks into content/structuredContent).
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.4 — Gemini signature loop + OpenAI stateless reasoning loop (mixed)
// ─────────────────────────────────────────────────────────────────────────────

function adkEvent(parts: AdkPart[], extra: Partial<AdkEvent> = {}): AdkEvent {
  return { content: { role: "model", parts }, invocationId: "inv_s10_4", ...extra };
}

describe("§10.4 — Gemini signature loop + OpenAI stateless reasoning loop", () => {
  it("(a) a tool-call's thoughtSignature survives the ingest leg — functionCall part's thoughtSignature lands on the tool-call block's signature field (facet-driven via createAdkNormalizer)", () => {
    const n = createAdkNormalizer();
    const native = adkEvent([{ functionCall: { name: "echo", args: { x: 1 }, id: "adk-s10-4a" }, thoughtSignature: "SIG_TOOL_CALL" }], {
      partial: true,
    });
    const out = n.push(toJsonValue(native)).concat(n.flush());

    const r = new Reducer();
    for (const ev of out) r.push(ev);
    const block = r.result().messages[0]?.content.find((b) => b.type === "tool-call");
    expect(block?.type === "tool-call" && block.signature).toBe("SIG_TOOL_CALL");
  });

  it.skip(
    "(a-reinput) tool-call signature re-input leg — N/A: no facet in this repo ships an AgJSON→native emit/re-input surface (§10 preamble: \"ingest-only normalizers record them N/A\"; §8 item 7 scoping)",
    () => {},
  );

  it("(b) a thinking-only turn's thoughtSignature lands on the reasoning block's opaque carrier — message/reasoning-targeted, NOT tool-call-targeted (ingest leg; facet-driven via createAdkNormalizer)", () => {
    const n = createAdkNormalizer();
    const native = adkEvent([{ text: "pondering…", thought: true, thoughtSignature: "SIG_THINK_ONLY" }], {
      partial: true,
    });
    const out = n.push(toJsonValue(native)).concat(n.flush());
    const opaque = out.find((e) => e.type === "reasoning.opaque");
    expect(opaque).toMatchObject({ kind: "signature", value: "SIG_THINK_ONLY", provider: "google" });
    expect(out.find((e) => e.type === "tool.args.assembled")).toBeUndefined(); // NOT a tool-call target

    const r = new Reducer();
    for (const ev of out) r.push(ev);
    const block = r.result().messages[0]?.content.find((b) => b.type === "reasoning");
    expect(block?.type === "reasoning" && block.opaque?.value).toBe("SIG_THINK_ONLY");
    // Re-input (echoing this signature back to Gemini on turn N+1 to avoid a
    // 400) is OUT OF SCOPE for this ingest-only SDK — see legs (a)/(c) above.
  });

  it.skip(
    "(c) a Google-Search-grounded turn's signature survives emit→reduce→re-input — N/A: google-adk has no built-in-tool-step (google_search_call/result) signature carrier, and no facet in this repo ships a re-input surface (§10 preamble)",
    () => {},
  );

  it.skip(
    "(d) OpenAI stateless reasoning loop — N/A: the item's claim is emit→reduce→re-input survival; no facet in this repo ships an AgJSON→native emit/re-input surface (§10 preamble). The ingest-capture sub-claim (rs_ id + summary text + encrypted_content handling; exhaustive: no-summary, no-encrypted-content, late-arrival edge cases) is already COVERED by openai-agents/src/index.test.ts:1212-1258",
    () => {},
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.5 — Source round-trips (RUNNABLE)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.5 — source round-trips: MCP base64 and Anthropic url/file both survive (AgSource merge)", () => {
  it("an MCP base64 source and an Anthropic file source both fold byte-identical onto turn.sources[]", () => {
    const r = reduce([
      TURN_START,
      {
        type: "source",
        seq: 1,
        turnId: "t1",
        sourceId: "src-mcp",
        source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" },
      },
      {
        type: "source",
        seq: 2,
        turnId: "t1",
        sourceId: "src-anthropic",
        source: { type: "file", fileId: "file_abc123", mediaType: "application/pdf" },
      },
    ]).result;
    const turn = r.turns[0];
    expect(turn?.sourceIds).toEqual(["src-mcp", "src-anthropic"]);
    expect(turn?.sources?.[0]).toMatchObject({
      sourceId: "src-mcp",
      source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" },
    });
    expect(turn?.sources?.[1]).toMatchObject({
      sourceId: "src-anthropic",
      source: { type: "file", fileId: "file_abc123", mediaType: "application/pdf" },
    });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.6 — Mandatory display (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.6 — Mandatory display: a display.required event is not dropped (ToS)", () => {
  it("COVERED-BY reduce.test.ts:1049 \"(h) display.required appends to AgTurnRecord.displayRequired[]\"; thin confirming re-assertion", () => {
    const r = reduce([
      TURN_START,
      { type: "display.required", seq: 1, turnId: "t1", provider: "google", html: "<p>Required notice</p>" },
    ]).result;
    expect(r.turns[0]?.displayRequired).toEqual([{ provider: "google", html: "<p>Required notice</p>" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.7 — safety_blocked category (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.7 — safety_blocked category: finishReason:\"safety_blocked\" SHOULD carry populated safety[].category when the source provides it; MAY be empty otherwise", () => {
  it("COVERED-BY openai-agents/src/index.test.ts:776 \"content_filter incomplete → turn.done error outcome + safety (NOT turn.error)\" (facet-driven, createOpenaiNormalizer, proves the populated-category leg); thin schema-level confirming re-assertion that turn.done accepts BOTH shapes the spec sanctions", () => {
    // AgClosedEvent (not AgEvent) — discriminant narrowing on the plain
    // discriminatedUnion, avoiding the AgExtEvent.catchall(JsonValue) field
    // widening AgEvent carries (see agjson.ts's AgClosedEventType doc comment).
    const populated = AgClosedEvent.parse({
      type: "turn.done",
      seq: 1,
      turnId: "t1",
      outcome: { type: "error", message: "blocked" },
      finishReason: "safety_blocked",
      safety: [{ category: "content_filter", blocked: true }],
    });
    const bare = AgClosedEvent.parse({
      type: "turn.done",
      seq: 1,
      turnId: "t1",
      outcome: { type: "error", message: "blocked" },
      finishReason: "safety_blocked",
      safety: [],
    });
    expect(populated.type === "turn.done" && populated.safety?.[0]?.category).toBe("content_filter");
    expect(bare.type === "turn.done" && bare.safety).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.8 — Cumulative-usage verbatim fold (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.8 — cumulative-usage verbatim fold: a cumulative Anthropic usage stream folds with running totals preserved verbatim, cumulative:true intact (INV-DELTA)", () => {
  it("COVERED-BY reduce.test.ts:791-826 \"(a) turn.done sets finishReason/usage(verbatim)/safety/outcome\" + :91 \"(b2) message.end.usage lands verbatim\"; thin confirming re-assertion", () => {
    const r = reduce([
      TURN_START,
      {
        type: "turn.done",
        seq: 1,
        turnId: "t1",
        outcome: { type: "success" },
        finishReason: "stop",
        usage: { inputTokens: 500, outputTokens: 200, cumulative: true },
      },
    ]).result;
    // VERBATIM — nothing in the pipeline subtracts or de-cumulates.
    expect(r.turns[0]?.usage).toEqual({ inputTokens: 500, outputTokens: 200, cumulative: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.9 — ADK aggregate suppression (RUNNABLE, facet-driven)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.9 — ADK aggregate suppression: a partial:false aggregate re-send reduces without double-render", () => {
  it("a partial:true tool call followed by its partial:false aggregate re-send yields exactly ONE tool-call block", () => {
    const n = createAdkNormalizer();
    const fc: AdkPart = { functionCall: { name: "echo", args: { text: "hi" }, id: "adk-s10-9" } };
    const out = n
      .push(toJsonValue(adkEvent([fc], { partial: true, finishReason: "STOP" })))
      .concat(n.push(toJsonValue(adkEvent([fc], { partial: false, finishReason: "STOP" })))) // aggregate re-send
      .concat(n.flush());
    expect(out.filter((e) => e.type === "tool.start")).toHaveLength(1);

    const r = new Reducer();
    for (const ev of out) r.push(ev);
    const toolCalls = r.result().messages[0]?.content.filter((b) => b.type === "tool-call") ?? [];
    expect(toolCalls).toHaveLength(1); // no double-render through the fold
    expect(r.needsResync).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.10 / §10.11 — LangChain/Pydantic index→id re-key; LangGraph positional pause (N/A)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.10 — index→id re-key (LangChain/Pydantic index-keyed delta stream)", () => {
  it.skip(
    "N/A: no LangChain / Pydantic-AI facet exists in this repo (only claude-agent-sdk, google-adk, openai-agents)",
    () => {},
  );
});

describe("§10.11 — LangGraph positional pause (two interrupt()s in one node)", () => {
  it.skip("N/A: no LangGraph facet exists in this repo (only claude-agent-sdk, google-adk, openai-agents)", () => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.12 — Interleaved subagent + parent (RUNNABLE, reduce-level)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.12 — interleaved subagent + parent: an interleaved stream folds to the correct per-turn messages (each block routed by its event turnId)", () => {
  it("content interleaved between a parent turn and a nested subagent turn lands in the right per-turn message, never bleeding across turns", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "parent" },
      { type: "message.start", seq: 1, id: "m-parent", role: "assistant", turnId: "parent", threadId: "th1" },
      { type: "text.start", seq: 2, id: "b-parent-1", turnId: "parent" },
      { type: "text.delta", seq: 3, id: "b-parent-1", delta: "before subagent" },
      { type: "text.end", seq: 4, id: "b-parent-1" },
      { type: "subagent.start", seq: 5, turnId: "child", parentTurnId: "parent", agentName: "helper" },
      { type: "message.start", seq: 6, id: "m-child", role: "assistant", turnId: "child", threadId: "th1" },
      { type: "text.start", seq: 7, id: "b-child-1", turnId: "child" },
      { type: "text.delta", seq: 8, id: "b-child-1", delta: "subagent work" },
      { type: "text.end", seq: 9, id: "b-child-1" },
      { type: "subagent.done", seq: 10, turnId: "child", parentTurnId: "parent" },
      { type: "text.start", seq: 11, id: "b-parent-2", turnId: "parent" },
      { type: "text.delta", seq: 12, id: "b-parent-2", delta: "after subagent" },
      { type: "text.end", seq: 13, id: "b-parent-2" },
    ]).result;

    expect(r.turns).toHaveLength(2);
    const parentMsg = r.messages.find((m) => m.id === "m-parent");
    const childMsg = r.messages.find((m) => m.id === "m-child");
    expect(parentMsg?.content).toHaveLength(2);
    expect(childMsg?.content).toHaveLength(1);
    if (parentMsg?.content[0]?.type === "text") expect(parentMsg.content[0].text).toBe("before subagent");
    if (parentMsg?.content[1]?.type === "text") expect(parentMsg.content[1].text).toBe("after subagent");
    if (childMsg?.content[0]?.type === "text") expect(childMsg.content[0].text).toBe("subagent work");
    const childTurn = r.turns.find((t) => t.turnId === "child");
    expect(childTurn?.parentTurnId).toBe("parent");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.13 — Replay-blob round-trips (N/A)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.13 — replay-blob round-trips (Anthropic reasoning opaque, web-search encrypted_content, Pydantic CompactionPart, bare-key _meta / flat metadata)", () => {
  it.skip(
    "N/A: the item's claim is emit→reduce→re-input survival; no facet in this repo ships an AgJSON→native emit/re-input surface (§10 preamble: \"ingest-only normalizers record them N/A\"). The ingest-capture half of the opaque-value sub-claim (signature/redacted byte-identical through the fold) is already COVERED by reduce.test.ts:280 \"(b) reasoning.start + delta + opaque + end → reasoning block; opaque.value round-trips\"",
    () => {},
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.14 — A2UI RPC round-trips (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.14 — A2UI RPC round-trips (per-arm)", () => {
  it("COVERED-BY agjson.test.ts:1003-1253 \"AgSurfaceInteraction (§3 / §6 / §11.8 un-merge)\" (exhaustive per-arm schema coverage); thin confirming re-assertion of the specific §10.14 claims", () => {
    // callFunction → AgA2uiFunctionResponse round-trips BOTH functionCallId AND call.
    const fr = AgA2uiFunctionResponse.parse({
      surface: "a2ui",
      surfaceId: "s1",
      a2uiMessage: "function-response",
      functionCallId: "fc1",
      call: "getWeather",
      value: { temp: 72 },
    });
    expect(fr.functionCallId).toBe("fc1");
    expect(fr.call).toBe("getWeather");

    // AgA2uiError: both-fields and neither-fields shapes are REJECTED (upstream XOR).
    expect(() =>
      AgA2uiError.parse({
        surface: "a2ui",
        surfaceId: "s1",
        functionCallId: "fc1",
        a2uiMessage: "error",
        code: "SOME_ERROR",
        message: "boom",
      }),
    ).toThrow();
    expect(() =>
      AgA2uiError.parse({ surface: "a2ui", a2uiMessage: "error", code: "SOME_ERROR", message: "boom" }),
    ).toThrow();

    // VALIDATION_FAILED.path (JSON-Pointer) reaches ui.result.error.path (surface-scoped arm).
    const err = AgA2uiError.parse({
      surface: "a2ui",
      surfaceId: "s1",
      a2uiMessage: "error",
      code: "VALIDATION_FAILED",
      message: "bad value",
      path: "/form/field-a",
    });
    expect(err.path).toBe("/form/field-a");

    // The OpenAI callTool reply round-trips as ui.widget.result {surfaceId, callId, result}.
    const reply = AgEvent.parse({ type: "ui.widget.result", seq: 1, surfaceId: "s1", callId: "call1", result: "42" });
    expect(reply).toMatchObject({ type: "ui.widget.result", callId: "call1", result: "42" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.15 — Gemini parallel ordering (N/A)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.15 — Gemini parallel ordering: a 2-call parallel turn's grouped FC1,FC2,FR1,FR2 ordering survives emit→reduce→re-input", () => {
  it.skip(
    "N/A: the claim is specifically about the emit-side re-input ordering rule (§8 item 7 — group ALL tool-calls AHEAD of ALL tool-results when emitting to Gemini contents[]); no facet in this repo implements that re-input direction (§10 preamble)",
    () => {},
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.16 — A2A initial-Task (RUNNABLE, reduce-level)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.16 — A2A initial-Task: an initial Task carrying an artifact + a later artifact-update for the same artifactId yields exactly ONE artifact", () => {
  it("a seeded artifact followed by a LATER same-artifactId update (no second artifact.start) yields ONE artifact record with the seed preserved, not lost or duplicated", () => {
    const r = reduce([
      TURN_START,
      // ── initial Task snapshot: ONE artifact.start + seed parts ──
      { type: "artifact.start", seq: 1, artifactId: "art-a2a-1", turnId: "t1", threadId: "th1", name: "report" },
      {
        type: "artifact.delta",
        seq: 2,
        artifactId: "art-a2a-1",
        part: { type: "text", text: "initial section" },
        append: false,
      },
      { type: "artifact.end", seq: 3, artifactId: "art-a2a-1", lastChunk: true },
      // ── a LATER TaskArtifactUpdateEvent for the SAME artifactId — lands as an
      //    ADDITIONAL delta, never a second artifact.start (which would wipe
      //    parts[] — structurally identical to the ADK-aggregate hazard, §8
      //    item 11) ──
      {
        type: "artifact.delta",
        seq: 4,
        artifactId: "art-a2a-1",
        part: { type: "text", text: "updated section" },
        append: false,
      },
    ]).result;
    expect(r.artifacts).toHaveLength(1); // exactly ONE artifact, never a duplicate record
    const art = r.artifacts[0];
    expect(art?.artifactId).toBe("art-a2a-1");
    expect(art?.parts).toHaveLength(2); // the initial seed is NOT lost by the later update
    if (art?.parts[0]?.type === "text") expect(art.parts[0].text).toBe("initial section");
    if (art?.parts[1]?.type === "text") expect(art.parts[1].text).toBe("updated section");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.17 — Signature reassembly (mixed)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.17 — signature reassembly", () => {
  it("(a) a 2-fragment reasoning.opaque.delta signature reassembles byte-identically (reduce-level, framework-neutral)", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      { type: "reasoning.start", seq: 2, id: "r1", turnId: "t1" },
      { type: "reasoning.opaque.delta", seq: 3, id: "r1", delta: "FRAG_ONE_" },
      { type: "reasoning.opaque.delta", seq: 4, id: "r1", delta: "FRAG_TWO" },
      { type: "reasoning.opaque", seq: 5, id: "r1", kind: "signature", value: "IGNORED_FALLBACK", provider: "google" },
    ]).result;
    const block = r.messages[0]?.content.find((b) => b.type === "reasoning");
    expect(block?.type === "reasoning" && block.opaque).toEqual({
      kind: "signature",
      value: "FRAG_ONE_FRAG_TWO", // scratch-buffer concatenation wins over the terminal event's own value
      provider: "google",
    });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  it.skip(
    "(b) an id-fragmented tool call (Pydantic tool_name_delta/tool_call_id_delta) assembles to a single stable toolCallId — N/A: no Pydantic-AI facet in this repo",
    () => {},
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.18 — MCP MRTR requestState round-trip (RUNNABLE, wire/schema-level)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.18 — MCP MRTR: requestState survives emit→reduce→re-input byte-identical; resume is a fresh AgInput carrying the echoed requestState", () => {
  it("requestState on hitl.ask survives byte-identical into the echoed AgHitlAnswer inside a fresh AgInput{kind:resume} — a wire/schema-level round trip every implementation performs directly (AgInput is a first-party consumer contract, not a framework-specific emit surface, so it is NOT gated by the §10 preamble's emit-surface carve-out)", () => {
    const ask = AgEvent.parse({
      type: "hitl.ask",
      seq: 1,
      askId: "ask-mrtr-1",
      kind: "form",
      turnId: "t1",
      threadId: "th1",
      toolCallId: "tc1",
      requestState: "MRTR_OPAQUE_BLOB_DO_NOT_INSPECT",
      inputKey: "field-a",
    });
    if (ask.type !== "hitl.ask") throw new Error("expected hitl.ask");

    // The app echoes requestState BYTE-IDENTICAL — it MUST NOT inspect/decode it (SPEC §13).
    const resume = AgInput.parse({
      protocol: "agjson",
      version: "1.0.0-draft.1",
      threadId: "th1",
      turnId: "t1",
      kind: "resume",
      answers: [
        {
          askId: ask.askId,
          status: "resolved",
          reply: { value: "user answer" },
          requestState: ask.requestState, // the echo
        },
      ],
    });
    if (resume.kind !== "resume") throw new Error("expected resume");
    expect(resume.answers?.[0]?.requestState).toBe("MRTR_OPAQUE_BLOB_DO_NOT_INSPECT");
    expect(resume.answers?.[0]?.requestState).toBe(ask.requestState); // byte-identical, not re-derived
  });

  it.skip(
    "live MCP re-input (the echoed requestState actually resuming a real MCP server call) is N/A — no facet in this repo consumes AgInput to drive a live MCP session",
    () => {},
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.19 — A2UI component streaming (RUNNABLE, wire round-trip)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.19 — A2UI component streaming: createSurface + updateComponents + updateDataModel + deleteSurface round-trips through ui.surface.* / ui.data-model, Layer-A opaque", () => {
  it("the streamed adjacency-list (incl. id:\"root\") and catalogId survive byte-identical through the JSON wire projection", () => {
    const components = [
      { id: "root", component: "Column", children: ["child-1"] },
      { id: "child-1", component: "Text", text: "hello" },
    ];
    const dataModel = { greeting: "hello" };

    const start = AgEvent.parse({
      type: "ui.surface.start",
      seq: 1,
      surfaceId: "s1",
      catalogId: "cat-a2ui-v1",
      components,
      dataModel,
      sendDataModel: true,
    });
    const update = AgEvent.parse({
      type: "ui.surface.update",
      seq: 2,
      surfaceId: "s1",
      components: [{ id: "child-1", component: "Text", text: "updated" }],
    });
    const dataModelPush = AgEvent.parse({
      type: "ui.data-model",
      seq: 3,
      surfaceId: "s1",
      path: "/greeting",
      value: "updated greeting",
    });
    const end = AgEvent.parse({ type: "ui.surface.end", seq: 4, surfaceId: "s1" });

    for (const ev of [start, update, dataModelPush, end]) {
      const wired = AgEvent.parse(toWire(ev));
      expect(wired).toEqual(ev); // byte-identical through the wire projection
    }
    if (start.type !== "ui.surface.start") throw new Error("expected ui.surface.start");
    expect(start.catalogId).toBe("cat-a2ui-v1"); // catalogId round-trips by reference
    expect(start.components).toEqual(components); // opaque payload verbatim, incl. id:"root"

    // These events are LIVE-ONLY / non-folding (SPEC §5/§9) — COVERED-BY
    // reduce.test.ts:1953 "(f) live-only events (…/ui.surface.start/…) produce
    // NO change" for the no-fold half of this claim (not re-asserted here).
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.20 — Malformed input at a trust boundary (RUNNABLE)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.20 — malformed input at a trust boundary: a schema-invalid event is rejected before folding; the reducer's fold state and resync condition are unaffected by the rejected event", () => {
  it("a schema-invalid event fails AgEvent.safeParse (typed error, never reaches push()); a validated stream around it folds cleanly with needsResync unaffected", () => {
    // Malformed per the AgEvent superRefine cross-field invariant (message.remove
    // REMOVE_ALL id="*" requires turnId). Schema-shape rejection itself is
    // already COVERED-BY agjson.test.ts:1266 "rejects message.remove
    // REMOVE_ALL ('*') without a turnId" + :1262 "rejects memory.write
    // carrying BOTH value and patch, or NEITHER". This fixture adds the
    // REDUCER-INTEGRATION half: the trust boundary sits IN FRONT of push(),
    // so a rejected event never reaches — and cannot corrupt — fold state.
    const malformed = { type: "message.remove", seq: 5, id: "*" }; // missing turnId
    const parsed = AgEvent.safeParse(malformed);
    expect(parsed.success).toBe(false); // typed error to the caller, before folding

    const r = new Reducer();
    r.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    r.push({ type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
    // A validating caller (ingest boundary) never pushes the rejected event —
    // only well-formed events downstream of the schema gate reach the reducer.
    r.push({ type: "text.start", seq: 2, id: "b1", turnId: "t1" });
    r.push({ type: "text.delta", seq: 3, id: "b1", delta: "unaffected" });
    r.push({ type: "text.end", seq: 4, id: "b1" });
    const result = r.result();
    expect(result.messages[0]?.content[0]).toMatchObject({ type: "text", text: "unaffected" });
    expect(r.needsResync).toBe(false); // fold state / resync condition unaffected by the rejected event
  });
});
