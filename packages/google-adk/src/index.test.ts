import { describe, it, expect } from "vitest";
import { AgEvent, AgReduceResult, JsonValue, Reducer, toJsonValue } from "@silverprotocol/core";
import {
  createAdkNormalizer,
  isLossyFinishReason,
  mapFinishReason,
  type AdkEvent,
  type AdkPart,
} from "./index.js";

/** Build one ADK Event (a Gemini Content + event metadata). */
function event(parts: AdkPart[], extra: Partial<AdkEvent> = {}): AdkEvent {
  return { content: { role: "model", parts }, invocationId: "inv_fixture_1", ...extra };
}

/** Serialize an AdkEvent to JsonValue — the cassette/wire boundary the normalizer
 *  consumes. Wire projection (audit D5-a): toJsonValue materializes the native
 *  event as plain JsonValue. */
function toJson(e: AdkEvent): JsonValue {
  return toJsonValue(e);
}

/** Drive a list of events through one normalizer instance, then flush. */
function run(events: AdkEvent[]): AgEvent[] {
  const n = createAdkNormalizer();
  const out: AgEvent[] = [];
  for (const e of events) out.push(...n.push(toJson(e)));
  out.push(...n.flush());
  return out;
}

describe("createAdkNormalizer — text turn lifecycle", () => {
  it("opens a turn, streams an incremental delta, and closes on the final aggregate", () => {
    const out = run([
      event([{ text: "Hello " }], { partial: true, finishReason: "STOP" }),
      event([{ text: "Hello world" }], { partial: false, finishReason: "STOP" }),
    ]);
    const types = out.map((e) => e.type);
    // turn.start + message.start (synthesized), the streamed delta block, then close.
    expect(types).toContain("turn.start");
    // The partial streams "Hello " (1 delta); the aggregate grows past the stream so
    // the residual tail "world" is emitted as a second delta — 2 text.delta total.
    expect(types.filter((t) => t === "text.delta")).toHaveLength(2);
    expect(types).toContain("turn.done");
    const delta = out.find((e) => e.type === "text.delta");
    expect(delta).toMatchObject({ delta: "Hello " });
    const residual = out
      .filter((e) => e.type === "text.delta")
      .map((e) => (e as { delta: string }).delta);
    // The aggregate's residual tail "world" is streamed if not a prefix; here "Hello world"
    // is NOT a prefix of "Hello " so the residual "world" rides as a second delta block.
    expect(residual).toEqual(["Hello ", "world"]);
  });

  it("does NOT close the turn on a function-call aggregate (not is_final_response)", () => {
    const out = run([
      event([{ functionCall: { name: "echo", args: { text: "hi" }, id: "adk-1" } }], {
        partial: false,
        finishReason: "STOP",
      }),
    ]);
    // A partial:false event carrying a functionCall is NOT final → turn stays open until flush.
    const beforeFlush = out.filter((e) => e.type === "turn.done");
    const abortOnFlush = out.filter((e) => e.type === "turn.abort");
    // The pending tool call never resolved before the stream ended, so flush()
    // truthfully aborts the still-open turn as stream-truncated — NEVER a
    // fabricated success close (audit M21). Assert neither is emitted by the
    // function-call event itself: drive it without flush.
    const n = createAdkNormalizer();
    const driven = n.push(
      JSON.parse(
        JSON.stringify(
          event([{ functionCall: { name: "echo", args: { text: "hi" }, id: "adk-1" } }], {
            partial: false,
            finishReason: "STOP",
          })
        )
      )
    );
    expect(driven.map((e) => e.type)).not.toContain("turn.done");
    expect(driven.map((e) => e.type)).not.toContain("turn.abort");
    expect(beforeFlush).toHaveLength(0);
    expect(abortOnFlush).toHaveLength(1); // flush aborts the still-open turn (stream-truncated)
  });

  it("maps STOP to the neutral 'stop' finishReason", () => {
    expect(mapFinishReason("STOP")).toBe("stop");
  });

  it("maps the genai ≥2.16 tool-call finish reasons", () => {
    expect(mapFinishReason("UNEXPECTED_TOOL_CALL")).toBe("unexpected_tool_call");
    // No first-class home yet — interim "other"; the wire string rides
    // provider-raw via the isLossyFinishReason carry (asserted below).
    expect(mapFinishReason("TOO_MANY_TOOL_CALLS")).toBe("other");
    expect(isLossyFinishReason("TOO_MANY_TOOL_CALLS")).toBe(true);
    expect(isLossyFinishReason("UNEXPECTED_TOOL_CALL")).toBe(false);
    expect(isLossyFinishReason("STOP")).toBe(false);
  });

  it("carries a lossy finishReason as message.metadata before the close (TOO_MANY_TOOL_CALLS)", () => {
    const out = run([
      event([{ text: "done" }], {
        partial: false,
        turnComplete: true,
        finishReason: "TOO_MANY_TOOL_CALLS",
      }),
    ]);
    const carries = out.filter((e) => e.type === "message.metadata");
    expect(carries).toHaveLength(1);
    // Same channel + key as the vercel-ai facet's raw-finish carry.
    expect(carries[0]).toMatchObject({
      metadata: { rawFinishReason: "TOO_MANY_TOOL_CALLS" },
    });
    // The carry lands BEFORE the message seals.
    expect(out.findIndex((e) => e.type === "message.metadata")).toBeLessThan(
      out.findIndex((e) => e.type === "message.end")
    );
    expect(out.find((e) => e.type === "turn.done")).toMatchObject({ finishReason: "other" });
  });

  it("carries an UNRECOGNIZED finishReason as message.metadata and maps it to 'unknown'", () => {
    const out = run([
      event([{ text: "done" }], {
        partial: false,
        turnComplete: true,
        finishReason: "SOME_FUTURE_REASON",
      }),
    ]);
    expect(out.find((e) => e.type === "message.metadata")).toMatchObject({
      metadata: { rawFinishReason: "SOME_FUTURE_REASON" },
    });
    expect(out.find((e) => e.type === "turn.done")).toMatchObject({ finishReason: "unknown" });
  });

  it("keys an errorCode-only soft close by its TRUE wire field (rawErrorCode, never finishReason)", () => {
    // Gemini block reason with no errorMessage: a done-path close whose
    // mapping input is the errorCode — the carry must not fabricate a
    // Candidate.finishReason Google never sent.
    const out = run([
      event([{ text: "blocked" }], {
        partial: false,
        turnComplete: true,
        errorCode: "RESOURCE_EXHAUSTED",
      }),
    ]);
    const carry = out.find((e) => e.type === "message.metadata");
    expect(carry).toMatchObject({ metadata: { rawErrorCode: "RESOURCE_EXHAUSTED" } });
    expect((carry as { metadata: object }).metadata).not.toHaveProperty("rawFinishReason");
    expect(out.find((e) => e.type === "turn.done")).toMatchObject({ finishReason: "unknown" });
    // No errorMessage ⇒ still a turn.done close, not turn.error.
    expect(out.some((e) => e.type === "turn.error")).toBe(false);
  });

  it("does NOT carry exactly-mapped finish reasons (STOP close stays noise-free)", () => {
    const out = run([
      event([{ text: "done" }], { partial: false, turnComplete: true, finishReason: "STOP" }),
    ]);
    expect(out.filter((e) => e.type === "message.metadata")).toHaveLength(0);
    expect(out.find((e) => e.type === "turn.done")).toMatchObject({ finishReason: "stop" });
  });
});

describe("createAdkNormalizer — reasoning + content blocks", () => {
  it("maps a thought part to reasoning.start/delta/end + reasoning.opaque signature", () => {
    const out = run([
      event([{ text: "thinking…", thought: true, thoughtSignature: "SIG" }], { partial: true }),
    ]);
    const types = out.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "reasoning.start",
        "reasoning.delta",
        "reasoning.end",
        "reasoning.opaque",
      ])
    );
    expect(out.find((e) => e.type === "reasoning.opaque")).toMatchObject({
      kind: "signature",
      value: "SIG",
      provider: "google",
    });
  });

  it("maps executableCode to a content.block code block", () => {
    const out = run([
      event([{ executableCode: { language: "PYTHON", code: "print(1)" } }], { partial: true }),
    ]);
    const block = out.find((e) => e.type === "content.block");
    expect(block).toMatchObject({ block: { type: "code", code: "print(1)" } });
  });

  it("signed non-thought text (§8.8 sugar path) emits text.start with messageId AND turnId populated (audit B10/#118)", () => {
    const out = run([
      event([{ text: "grounded answer", thoughtSignature: "SIG2" }], { partial: true }),
    ]);
    const textStart = out.find((e) => e.type === "text.start");
    expect(textStart).toBeDefined();
    expect((textStart as { messageId?: string } | undefined)?.messageId).toBeDefined();
    expect(textStart?.turnId).toBeDefined();
    expect((textStart as { providerMetadata?: unknown } | undefined)?.providerMetadata).toMatchObject({
      google: { thoughtSignature: "SIG2" },
    });
  });
});

describe("createAdkNormalizer — standalone arms via emit()", () => {
  it("maps interrupted to turn.abort", () => {
    const out = run([event([], { interrupted: true })]);
    expect(out.find((e) => e.type === "turn.abort")).toMatchObject({ reason: "interrupted" });
  });

  it("an interrupted:true event yields exactly ONE turn.abort(interrupted) and NO turn.done (audit M21)", () => {
    // The self-contradiction repro: before the fix, the interrupted turn.abort
    // was never registered in the facet's own `closedTurns`, so flush() would
    // ALSO fabricate a success turn.done for the same turn.
    const out = run([event([], { interrupted: true })]);
    expect(out.filter((e) => e.type === "turn.abort")).toHaveLength(1);
    expect(out.find((e) => e.type === "turn.abort")).toMatchObject({ reason: "interrupted" });
    expect(out.some((e) => e.type === "turn.done")).toBe(false);
  });

  it("a stream ending without a final aggregate flushes message.end + turn.abort(stream-truncated), NO turn.done (audit M21)", () => {
    // No `interrupted` flag, no `turnComplete`/`finishReason`/`errorCode` ever
    // arrives — the ADK stream just stops mid-turn. flush() must close the
    // dangling message then truthfully abort the still-open turn, never
    // fabricate a success close.
    const n = createAdkNormalizer();
    const pushed = n.push(toJson(event([{ text: "partial…" }], { partial: true })));
    const flushed = n.flush();
    const out = [...pushed, ...flushed];
    const msgEnd = out.findIndex((e) => e.type === "message.end");
    const abort = out.findIndex((e) => e.type === "turn.abort");
    expect(msgEnd).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(msgEnd);
    expect(out[abort]).toMatchObject({ type: "turn.abort", reason: "stream-truncated" });
    expect(out.some((e) => e.type === "turn.done")).toBe(false);
  });

  it("maps actions.transferToAgent to a handoff event", () => {
    const out = run([event([], { actions: { transferToAgent: "billing" } })]);
    expect(out.find((e) => e.type === "handoff")).toMatchObject({
      kind: "transfer",
      toAgentName: "billing",
    });
  });

  it("maps actions.stateDelta to a state.delta event", () => {
    const out = run([event([], { actions: { stateDelta: { cart: 3 } } })]);
    expect(out.find((e) => e.type === "state.delta")).toMatchObject({ patch: { cart: 3 } });
  });

  it("maps a grounding chunk to a source event", () => {
    const out = run([
      event([], {
        groundingMetadata: { groundingChunks: [{ web: { uri: "https://x", title: "X" } }] },
      }),
    ]);
    expect(out.find((e) => e.type === "source")).toMatchObject({
      source: { url: "https://x", title: "X" },
    });
  });
});

describe("createAdkNormalizer — groundingMetadata.groundingSupports → text.end citations (audit M22)", () => {
  it("collects ALL segment citations into ONE array on the streamed text block's text.end (no per-segment supplements)", () => {
    const out = run([
      event([{ text: "Paris is the capital of France. It has a population of 2 million." }], {
        partial: false,
        finishReason: "STOP",
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://x.test/france", title: "France" } }],
          groundingSupports: [
            {
              segment: { startIndex: 0, endIndex: 32, text: "Paris is the capital of France." },
              groundingChunkIndices: [0],
              confidenceScores: [0.9],
            },
            {
              segment: { startIndex: 33, endIndex: 68, text: "It has a population of 2 million." },
              groundingChunkIndices: [0],
              confidenceScores: [0.8],
            },
          ],
        },
      }),
    ]);
    // No id-less per-segment supplement blocks.
    expect(out.filter((e) => e.type === "content.block")).toHaveLength(0);
    const textEnd = out.find((e) => e.type === "text.end") as { citations?: Array<{ startIndex?: number }> };
    expect(textEnd).toBeDefined();
    expect(textEnd?.citations).toHaveLength(2);
    expect(textEnd?.citations?.[0]).toMatchObject({ startIndex: 0, endIndex: 32 });
    expect(textEnd?.citations?.[1]).toMatchObject({ startIndex: 33, endIndex: 68 });
    // The source event for the grounding chunk is still emitted (unrelated to the
    // per-segment supplement removal).
    expect(out.find((e) => e.type === "source")).toMatchObject({
      sourceId: "grounding_0",
      source: { url: "https://x.test/france" },
    });
  });

  it("folds to exactly ONE text block, with both segment citations attached", () => {
    const evs = run([
      event([{ text: "Paris is the capital of France." }], {
        partial: false,
        finishReason: "STOP",
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://x.test/france", title: "France" } }],
          groundingSupports: [
            {
              segment: { startIndex: 0, endIndex: 32, text: "Paris is the capital of France." },
              groundingChunkIndices: [0],
            },
          ],
        },
      }),
    ]);
    const r = new Reducer();
    for (const ev of evs) r.push(ev);
    const blocks = r.result().messages[0]?.content ?? [];
    const textBlocks = blocks.filter((b) => b.type === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toMatchObject({
      type: "text",
      text: "Paris is the capital of France.",
      citations: [{ kind: "offset", startIndex: 0, endIndex: 32 }],
    });
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });
});

describe("createAdkNormalizer — tool arms", () => {
  it("emits one tool.start+args.assembled and dedupes the partial:false aggregate", () => {
    const fc = { functionCall: { name: "echo", args: { text: "hi" }, id: "adk-1" } };
    const out = run([
      event([fc], { partial: true, finishReason: "STOP" }),
      event([fc], { partial: false, finishReason: "STOP" }), // aggregate re-send
    ]);
    expect(out.filter((e) => e.type === "tool.start")).toHaveLength(1);
    const start = out.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ type: "tool.start", toolCallId: "adk-1", name: "echo" });
    const assembled = out.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "adk-1", input: { text: "hi" } });
  });

  it("correlates a functionResponse to its call by the shared adk-<uuid> id", () => {
    const out = run([
      event(
        [
          {
            functionResponse: {
              name: "echo",
              id: "adk-1",
              response: { content: [{ type: "text", text: "echo: hi" }] },
            },
          },
        ],
        {}
      ),
    ]);
    const done = out.find((e) => e.type === "tool.done");
    expect(done).toMatchObject({
      toolCallId: "adk-1",
      outcome: "ok",
      content: [{ type: "text", text: "echo: hi" }],
    });
  });

  it("carries MCP-Apps siblings (structuredContent + _meta) alongside the content array onto tool.done's §2.1 channels (workspace#2, app-spec-gemini36 census finding)", () => {
    const out = run([
      event(
        [
          {
            functionResponse: {
              name: "render_card",
              id: "adk-1",
              response: {
                content: [{ type: "text", text: '{"title":"Hello","body":"World"}' }],
                structuredContent: {
                  title: "Hello",
                  body: "World",
                  cache: { hit: false, llmCallsAvoided: 0, kind: "cold" },
                },
                _meta: { ui: { resourceUri: "ui://mock/card", visibility: ["model"] } },
              },
            },
          },
        ],
        {}
      ),
    ]);
    const done = out.find((e) => e.type === "tool.done");
    expect(done).toMatchObject({
      toolCallId: "adk-1",
      outcome: "ok",
      content: [{ type: "text", text: '{"title":"Hello","body":"World"}' }],
      structuredContent: {
        title: "Hello",
        body: "World",
        cache: { hit: false, llmCallsAvoided: 0, kind: "cold" },
      },
      _meta: { ui: { resourceUri: "ui://mock/card", visibility: ["model"] } },
    });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("does NOT set structuredContent/_meta when the MCP-shape response lacks them (echo shape unchanged)", () => {
    const out = run([
      event(
        [
          {
            functionResponse: {
              name: "echo",
              id: "adk-1",
              response: { content: [{ type: "text", text: "echo: hi" }] },
            },
          },
        ],
        {}
      ),
    ]);
    const done = out.find((e) => e.type === "tool.done") as Record<string, unknown>;
    expect("structuredContent" in done).toBe(false);
    expect("_meta" in done).toBe(false);
  });

  // ─── audit M47: null-id fallback must mint per-INVOKE-ordinal ids, never
  // per-event-positional ids — and the aggregate re-send dedup must key on
  // content/window identity, not minted-id equality. ──────────────────────────

  it("mints distinct per-invoke-ordinal ids for two SEQUENTIAL null-id calls at the same parts[0] index, and correlates each functionResponse to the right call (audit M47 repro)", () => {
    const out = run([
      event([{ functionCall: { name: "toolA", args: { a: 1 } } }], {
        partial: false,
        finishReason: "STOP",
      }),
      event([{ functionCall: { name: "toolB", args: { b: 2 } } }], {
        partial: false,
        finishReason: "STOP",
      }),
      event(
        [
          {
            functionResponse: {
              name: "toolA",
              response: { content: [{ type: "text", text: "A done" }] },
            },
          },
        ],
        {}
      ),
      event(
        [
          {
            functionResponse: {
              name: "toolB",
              response: { content: [{ type: "text", text: "B done" }] },
            },
          },
        ],
        {}
      ),
    ]);
    const starts = out.filter((e) => e.type === "tool.start") as Array<{
      toolCallId: string;
      name: string;
    }>;
    // Before the fix: toolB silently vanished (index collision) — assert BOTH emit.
    expect(starts).toHaveLength(2);
    const startA = starts.find((s) => s.name === "toolA");
    const startB = starts.find((s) => s.name === "toolB");
    expect(startA).toBeDefined();
    expect(startB).toBeDefined();
    // Distinct minted ids — never a per-event-positional collision (`adk_call_0` twice).
    expect(startA?.toolCallId).not.toBe(startB?.toolCallId);
    // Identity never derives from the per-event positional index alone: the
    // second call's id must not equal the ordinal-0 form the FIRST call gets.
    expect(startB?.toolCallId).not.toBe(startA?.toolCallId);

    const dones = out.filter((e) => e.type === "tool.done") as Array<{
      toolCallId: string;
      content: Array<{ text?: string }>;
    }>;
    expect(dones).toHaveLength(2);
    // Before the fix: BOTH results were mis-keyed to the same collided id.
    // Each response must correlate to ITS OWN call's minted id.
    const doneA = dones.find((d) => d.toolCallId === startA?.toolCallId);
    const doneB = dones.find((d) => d.toolCallId === startB?.toolCallId);
    expect(doneA?.content[0]?.text).toBe("A done");
    expect(doneB?.content[0]?.text).toBe("B done");
  });

  it("dedupes the partial:false aggregate re-send of a NULL-id call by content identity (not minted-id equality), and the response still correlates to the ONE minted id", () => {
    const fc = { functionCall: { name: "echo", args: { text: "hi" } } }; // no id
    const out = run([
      event([fc], { partial: true, finishReason: "STOP" }),
      event([fc], { partial: false, finishReason: "STOP" }), // aggregate re-send, identical content
      event(
        [
          {
            functionResponse: {
              name: "echo",
              response: { content: [{ type: "text", text: "echo: hi" }] },
            },
          },
        ],
        {}
      ),
    ]);
    const starts = out.filter((e) => e.type === "tool.start");
    expect(starts).toHaveLength(1); // the content-identical aggregate resend must NOT re-emit
    const start = starts[0] as { toolCallId: string };
    const done = out.find((e) => e.type === "tool.done") as { toolCallId: string } | undefined;
    expect(done?.toolCallId).toBe(start.toolCallId);
  });

  // ─── review findings (b)/(c) on M47: window-scoped resend dedup +
  // positional/orphan functionResponse correlation ──────────────────────────

  it("does NOT collapse a genuinely repeated invocation across two SEPARATE aggregate-resend windows — each mints+emits its own start, correctly paired to its own response (review finding b)", () => {
    const fc = { functionCall: { name: "echo", args: { text: "hi" } } }; // no id, identical content both times
    const out = run([
      event([fc], { partial: true, finishReason: "STOP" }), // window 1 opens
      event([fc], { partial: false, finishReason: "STOP" }), // window 1 aggregate closes (suppresses its resend)
      event([fc], { partial: true, finishReason: "STOP" }), // window 2 opens — SAME content, window 1 already closed
      event([fc], { partial: false, finishReason: "STOP" }), // window 2 aggregate closes (suppresses ITS OWN resend)
      event(
        [{ functionResponse: { name: "echo", response: { content: [{ type: "text", text: "first" }] } } }],
        {}
      ),
      event(
        [{ functionResponse: { name: "echo", response: { content: [{ type: "text", text: "second" }] } } }],
        {}
      ),
    ]);
    const starts = out.filter((e) => e.type === "tool.start") as Array<{ toolCallId: string }>;
    // Before the fix: window 2's partial was ALSO collapsed into window 1's
    // still-"unresolved" id (no response had landed yet) — only ONE start.
    expect(starts).toHaveLength(2);
    expect(starts[0]?.toolCallId).not.toBe(starts[1]?.toolCallId);
    const dones = out.filter((e) => e.type === "tool.done") as Array<{
      toolCallId: string;
      content: Array<{ text?: string }>;
    }>;
    expect(dones).toHaveLength(2);
    const startIds = new Set(starts.map((s) => s.toolCallId));
    // No dangling done: every response correlates to a REAL prior start.
    for (const d of dones) expect(startIds.has(d.toolCallId)).toBe(true);
    const first = dones.find((d) => d.content[0]?.text === "first");
    const second = dones.find((d) => d.content[0]?.text === "second");
    expect(first?.toolCallId).toBe(starts[0]?.toolCallId);
    expect(second?.toolCallId).toBe(starts[1]?.toolCallId);
  });

  it("a genuinely repeated invocation with NO partial precursor at all (flat standalone repeats) still yields two paired start/done, never a dangling done (review finding b2)", () => {
    const fc = { functionCall: { name: "echo", args: { text: "hi" } } };
    const out = run([
      event([fc], { partial: false, finishReason: "STOP" }), // call 1 (standalone, no window)
      event([fc], { partial: false, finishReason: "STOP" }), // call 2 (standalone, SAME content, BEFORE any response)
      event(
        [{ functionResponse: { name: "echo", response: { content: [{ type: "text", text: "first" }] } } }],
        {}
      ),
      event(
        [{ functionResponse: { name: "echo", response: { content: [{ type: "text", text: "second" }] } } }],
        {}
      ),
    ]);
    const starts = out.filter((e) => e.type === "tool.start") as Array<{ toolCallId: string }>;
    // Before the fix: call 2 was swallowed by the "unresolved" content-key
    // dedup — only ONE start, and the second response then minted a FRESH,
    // never-started id (a dangling tool.done).
    expect(starts).toHaveLength(2);
    const dones = out.filter((e) => e.type === "tool.done") as Array<{ toolCallId: string }>;
    expect(dones).toHaveLength(2);
    const startIds = new Set(starts.map((s) => s.toolCallId));
    for (const d of dones) expect(startIds.has(d.toolCallId)).toBe(true); // no orphan/dangling done
  });

  it("an unrelated intervening non-partial event does NOT wipe a still-open resend window — the true aggregate resend still dedupes to ONE start (round-3 review finding on M47)", () => {
    const echoFc = { functionCall: { name: "echo", args: { text: "hi" } } }; // no id — window-tracked
    const out = run([
      event([echoFc], { partial: true, finishReason: "STOP" }), // echo's resend window opens
      event([{ functionCall: { name: "other", args: { x: 1 }, id: "adk-other" } }], {
        partial: false,
        finishReason: "STOP",
      }), // UNRELATED non-partial event (different tool, real id) — must NOT clear echo's window
      event([echoFc], { partial: false, finishReason: "STOP" }), // echo's TRUE aggregate resend, closes its own window
      event(
        [{ functionResponse: { name: "echo", response: { content: [{ type: "text", text: "echo: hi" }] } } }],
        {}
      ),
      event(
        [
          {
            functionResponse: {
              name: "other",
              id: "adk-other",
              response: { content: [{ type: "text", text: "other done" }] },
            },
          },
        ],
        {}
      ),
    ]);
    const starts = out.filter((e) => e.type === "tool.start") as Array<{ toolCallId: string; name: string }>;
    const echoStarts = starts.filter((s) => s.name === "echo");
    const otherStarts = starts.filter((s) => s.name === "other");
    // Before the fix: the unrelated "other" non-partial event wiped the WHOLE
    // per-turn window map, so echo's true aggregate resend saw no open budget
    // and re-minted+re-emitted a SECOND tool.start (duplicate).
    expect(echoStarts).toHaveLength(1);
    expect(otherStarts).toHaveLength(1);
    const dones = out.filter((e) => e.type === "tool.done") as Array<{ toolCallId: string }>;
    expect(dones).toHaveLength(2); // one per call, correctly paired — no dangling done
    const startIds = new Set(starts.map((s) => s.toolCallId));
    for (const d of dones) expect(startIds.has(d.toolCallId)).toBe(true);
  });

  it("ONE event carrying TWO same-name functionResponses correlates POSITIONALLY to the two pending calls (Gemini parallel-call convention, review finding c-i)", () => {
    const out = run([
      event([{ functionCall: { name: "search", args: { q: "apple" } } }], {
        partial: false,
        finishReason: "STOP",
      }),
      event([{ functionCall: { name: "search", args: { q: "banana" } } }], {
        partial: false,
        finishReason: "STOP",
      }),
      event(
        [
          {
            functionResponse: {
              name: "search",
              response: { content: [{ type: "text", text: "apple result" }] },
            },
          },
          {
            functionResponse: {
              name: "search",
              response: { content: [{ type: "text", text: "banana result" }] },
            },
          },
        ],
        {}
      ),
    ]);
    const starts = out.filter((e) => e.type === "tool.start") as Array<{ toolCallId: string }>;
    expect(starts).toHaveLength(2);
    const dones = out.filter((e) => e.type === "tool.done") as Array<{
      toolCallId: string;
      content: Array<{ text?: string }>;
    }>;
    expect(dones).toHaveLength(2);
    const first = dones.find((d) => d.toolCallId === starts[0]?.toolCallId);
    const second = dones.find((d) => d.toolCallId === starts[1]?.toolCallId);
    expect(first?.content[0]?.text).toBe("apple result");
    expect(second?.content[0]?.text).toBe("banana result");
  });

  it("an ORPHAN functionResponse (no pending call under that name) does NOT fabricate a dangling tool.done — it rides losslessly via ext.google.unparsed (review finding c-iii)", () => {
    const out = run([
      event(
        [
          {
            functionResponse: {
              name: "ghost",
              response: { content: [{ type: "text", text: "nobody called me" }] },
            },
          },
        ],
        {}
      ),
    ]);
    expect(out.some((e) => e.type === "tool.done")).toBe(false);
    const ext = out.find((e) => e.type === "ext.google.unparsed");
    expect(ext).toBeDefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

// ─── Part A: parity tests for arms covered only in the legacy index.test.ts ──

describe("createAdkNormalizer — promptFeedback.blockReason → prompt.blocked", () => {
  it("emits prompt.blocked with reason:safety and safetyRatings when promptFeedback.blockReason is SAFETY", () => {
    const out = run([
      event([], {
        promptFeedback: {
          blockReason: "SAFETY",
          safetyRatings: [
            { category: "HARM_CATEGORY_DANGEROUS", probability: "HIGH", score: 0.9, blocked: true },
          ],
        },
      }),
    ]);
    const blocked = out.find((e) => e.type === "prompt.blocked");
    expect(blocked).toMatchObject({
      type: "prompt.blocked",
      reason: "safety",
      safety: [{ category: "HARM_CATEGORY_DANGEROUS", probability: "HIGH", score: 0.9, blocked: true }],
    });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("emits prompt.blocked with reason:other when blockReason is OTHER (no safetyRatings)", () => {
    const out = run([event([], { promptFeedback: { blockReason: "OTHER" } })]);
    const blocked = out.find((e) => e.type === "prompt.blocked");
    expect(blocked).toMatchObject({ type: "prompt.blocked", reason: "other" });
    expect((blocked as { safety?: unknown } | undefined)?.safety).toBeUndefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — actions.requestedAuthConfigs → hitl.ask (kind auth)", () => {
  // ADK serializes requestedAuthConfigs as dict[str, AuthConfig] keyed by the
  // function-call-id; the AuthConfig is complex/framework-specific and rides
  // opaque in metadata.
  it("emits hitl.ask auth for each requestedAuthConfig dict entry (key = call id)", () => {
    const out = run([
      event([], {
        actions: {
          requestedAuthConfigs: {
            fc_gmail_1: {
              authScheme: { type: "oauth2", flows: {} },
              credentialKey: "adk_gmail_cred",
            },
          },
        },
      }),
    ]);
    const ask = out.find((e) => e.type === "hitl.ask");
    expect(ask).toMatchObject({
      type: "hitl.ask",
      askId: "auth_fc_gmail_1",
      kind: "auth",
      toolCallId: "fc_gmail_1",
      metadata: {
        authConfig: { authScheme: { type: "oauth2", flows: {} }, credentialKey: "adk_gmail_cred" },
      },
    });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("emits no hitl.ask and does not throw when the dicts are empty {} (real ADK shape)", () => {
    // Regression: real ADK sends requestedAuthConfigs/requestedToolConfirmations
    // as {} (empty object) on EVERY event — iterating that as an array threw
    // "actions.requestedAuthConfigs is not iterable" on every ADK event.
    const out = run([
      event([], {
        actions: { requestedAuthConfigs: {}, requestedToolConfirmations: {} },
      }),
    ]);
    expect(out.some((e) => e.type === "hitl.ask")).toBe(false);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — hitl.ask auth: flat `authConfig` view + native AuthConfig verbatim in metadata (SPEC §8.0 item 12)", () => {
  // `authConfig` is the AgAuthConfig view (scheme verbatim from
  // authScheme.type; URLs/scopes by ADK's own auth_handler.js:112-128
  // derivation; clientId/audience from rawAuthCredential.oauth2). The native
  // AuthConfig rides WHOLE in metadata.authConfig, so the ask stays lossless
  // (sp-protocol confirmed 2026-09-23).
  function askFor(native: JsonValue): AgEvent {
    const out = run([event([], { actions: { requestedAuthConfigs: { fc_1: native } } })]);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    const ask = out.find((e) => e.type === "hitl.ask");
    if (ask === undefined) throw new Error("no hitl.ask");
    return ask;
  }
  const viewOf = (ask: AgEvent): unknown => (ask as { authConfig?: unknown }).authConfig;
  const metaOf = (ask: AgEvent): unknown =>
    (ask as { metadata?: { authConfig?: unknown } }).metadata?.authConfig;

  const oauth2Native = {
    authScheme: {
      type: "oauth2",
      flows: {
        authorizationCode: {
          authorizationUrl: "https://accounts.example/auth",
          tokenUrl: "https://accounts.example/token",
          scopes: { "mail.read": "Read mail", "mail.send": "Send mail" },
        },
      },
    },
    rawAuthCredential: {
      authType: "oauth2",
      oauth2: { clientId: "cid-123", clientSecret: "SECRET-CS", audience: "aud-1" },
    },
    exchangedAuthCredential: {
      authType: "oauth2",
      oauth2: { clientId: "cid-123", accessToken: "SECRET-AT", refreshToken: "SECRET-RT", state: "st-9" },
    },
    credentialKey: "adk_mail_cred",
  };

  it("oauth2 authorizationCode → full view; the native config rides whole and verbatim in metadata", () => {
    const ask = askFor(oauth2Native);
    expect(viewOf(ask)).toEqual({
      scheme: "oauth2",
      scopes: ["mail.read", "mail.send"],
      authorizationUrl: "https://accounts.example/auth",
      tokenUrl: "https://accounts.example/token",
      clientId: "cid-123",
      audience: "aud-1",
    });
    expect(metaOf(ask)).toEqual(oauth2Native);
  });

  it("no secret-bearing field ever reaches the view (clientSecret, tokens, state, exchangedAuthCredential, credentialKey)", () => {
    const view = JSON.stringify(viewOf(askFor(oauth2Native)));
    for (const leak of ["SECRET", "st-9", "adk_mail_cred", "exchangedAuthCredential", "clientSecret", "accessToken"]) {
      expect(view).not.toContain(leak);
    }
  });

  it("oauth2 flow precedence follows ADK's auth_handler.js:119 (implicit > authorizationCode > clientCredentials > password)", () => {
    const ask = askFor({
      authScheme: {
        type: "oauth2",
        flows: {
          clientCredentials: { tokenUrl: "https://cc.example/token", scopes: { cc: "" } },
          implicit: { authorizationUrl: "https://imp.example/auth", scopes: { imp: "" } },
        },
      },
      credentialKey: "k",
    });
    expect(viewOf(ask)).toEqual({ scheme: "oauth2", scopes: ["imp"], authorizationUrl: "https://imp.example/auth" });
  });

  it("OIDC with config → authorizationEndpoint / tokenEndpoint / scopes", () => {
    const ask = askFor({
      authScheme: {
        type: "openIdConnect",
        openIdConnectUrl: "https://idp.example/.well-known/openid-configuration",
        authorizationEndpoint: "https://idp.example/authorize",
        tokenEndpoint: "https://idp.example/token",
        scopes: ["openid", "email"],
      },
      credentialKey: "k",
    });
    expect(viewOf(ask)).toEqual({
      scheme: "openIdConnect",
      scopes: ["openid", "email"],
      authorizationUrl: "https://idp.example/authorize",
      tokenUrl: "https://idp.example/token",
    });
  });

  it("apiKey → scheme only", () => {
    const native = { authScheme: { type: "apiKey", in: "header", name: "X-Api-Key" }, credentialKey: "k" };
    const ask = askFor(native);
    expect(viewOf(ask)).toEqual({ scheme: "apiKey" });
    expect(metaOf(ask)).toEqual(native);
  });

  it("no string scheme → NO authConfig key (never invented); metadata unchanged", () => {
    const natives: JsonValue[] = [
      { credentialKey: "k" },
      { authScheme: { flows: {} }, credentialKey: "k" },
      { authScheme: { type: 7 }, credentialKey: "k" },
      { scope: "x" },
    ];
    for (const native of natives) {
      const ask = askFor(native);
      expect(Object.keys(ask)).not.toContain("authConfig");
      expect(metaOf(ask)).toEqual(native);
    }
  });

  it("absent requestedAuthConfigs → no hitl.ask and no authConfig anywhere (byte-identical)", () => {
    const out = run([event([{ text: "hi" }], { actions: { stateDelta: {} }, turnComplete: true, finishReason: "STOP" })]);
    expect(out.some((e) => e.type === "hitl.ask")).toBe(false);
    expect(JSON.stringify(out)).not.toContain("authConfig");
  });

  it("the paused close folds the SAME ask (view included) into turn.done asks, and folds cleanly", () => {
    const out = run([
      event([], {
        actions: { requestedAuthConfigs: { fc_1: oauth2Native } },
        turnComplete: true,
        finishReason: "STOP",
      }),
    ]);
    const ask = out.find((e) => e.type === "hitl.ask");
    const done = out.find((e) => e.type === "turn.done");
    const asks = (done as { outcome?: { type?: string; asks?: unknown[] } } | undefined)?.outcome?.asks;
    expect(asks).toHaveLength(1);
    expect(asks?.[0]).toMatchObject({ kind: "auth", toolCallId: "fc_1", authConfig: viewOf(ask ?? out[0]!) });
    const r = new Reducer();
    for (const ev of out) r.push(ev);
    expect(r.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });
});

describe("createAdkNormalizer — actions.requestedToolConfirmations → hitl.ask (kind approval)", () => {
  // ADK serializes requestedToolConfirmations as dict[str, ToolConfirmation]
  // keyed by the function-call-id; hint -> message, confirmed/payload -> metadata.
  it("emits hitl.ask approval for each requestedToolConfirmation dict entry (key = call id)", () => {
    const out = run([
      event([], {
        actions: {
          requestedToolConfirmations: {
            fc_del_1: { hint: "Confirm delete?", confirmed: false, payload: { path: "/x" } },
          },
        },
      }),
    ]);
    const ask = out.find((e) => e.type === "hitl.ask");
    expect(ask).toMatchObject({
      type: "hitl.ask",
      askId: "approval_fc_del_1",
      kind: "approval",
      toolCallId: "fc_del_1",
      message: "Confirm delete?",
      metadata: { confirmed: false, payload: { path: "/x" } },
    });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — HITL pauses fold as outcome:paused at the real close path (audit M26)", () => {
  // The pause-signaling event carries no functionCall part (the call itself
  // already streamed in an earlier event) but DOES carry the completion
  // signals (turnComplete/finishReason) that make maybeCloseTurn's
  // is_final_response check true — the REAL close path, not flush/truncation.
  it("requestedAuthConfigs on the close-path event folds turn.done to outcome:paused with the ask, NOT success", () => {
    const out = run([
      event([], {
        partial: false,
        turnComplete: true,
        actions: {
          requestedAuthConfigs: {
            fc_gmail_1: { authScheme: { type: "oauth2", flows: {} }, credentialKey: "adk_gmail_cred" },
          },
        },
      }),
    ]);
    const done = out.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({
      type: "turn.done",
      outcome: {
        type: "paused",
        asks: [
          {
            askId: "auth_fc_gmail_1",
            kind: "auth",
            toolCallId: "fc_gmail_1",
            metadata: {
              authConfig: { authScheme: { type: "oauth2", flows: {} }, credentialKey: "adk_gmail_cred" },
            },
          },
        ],
      },
    });
    expect(out.some((e) => e.type === "turn.abort")).toBe(false);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("requestedToolConfirmations on the close-path event folds turn.done to outcome:paused with the ask, NOT success", () => {
    const out = run([
      event([], {
        partial: false,
        turnComplete: true,
        actions: {
          requestedToolConfirmations: {
            fc_del_1: { hint: "Confirm delete?", confirmed: false, payload: { path: "/x" } },
          },
        },
      }),
    ]);
    const done = out.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({
      type: "turn.done",
      outcome: {
        type: "paused",
        asks: [
          {
            askId: "approval_fc_del_1",
            kind: "approval",
            toolCallId: "fc_del_1",
            message: "Confirm delete?",
            metadata: { confirmed: false, payload: { path: "/x" } },
          },
        ],
      },
    });
    expect(out.some((e) => e.type === "turn.abort")).toBe(false);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("folds asks from BOTH arms on the same close-path event, in emission order", () => {
    const out = run([
      event([], {
        partial: false,
        turnComplete: true,
        actions: {
          requestedAuthConfigs: {
            fc_a: { scope: "x" },
            fc_b: { scope: "y" },
          },
          requestedToolConfirmations: {
            fc_c: { hint: "confirm?" },
          },
        },
      }),
    ]);
    const done = out.find((e) => e.type === "turn.done") as
      | { outcome?: { type?: string; asks?: Array<{ askId: string }> } }
      | undefined;
    expect(done?.outcome?.type).toBe("paused");
    expect(done?.outcome?.asks?.map((a) => a.askId)).toEqual(["auth_fc_a", "auth_fc_b", "approval_fc_c"]);
  });

  it("a resolved/no-asks close-path event still closes outcome:success (control)", () => {
    const out = run([
      event([{ text: "Hello" }], { partial: false, turnComplete: true, finishReason: "STOP" }),
    ]);
    const done = out.find((e) => e.type === "turn.done");
    expect(done).toMatchObject({ type: "turn.done", outcome: { type: "success" } });
  });

  it("a truncated stream with pending asks but no close-path completion aborts at flush — never fabricates paused (INV-FLUSH)", () => {
    // No turnComplete/finishReason/errorCode on this event, so maybeCloseTurn's
    // is_final_response check never fires; the stream ends without a terminal.
    // A truncated pause is a truncation (INV-FLUSH) — flush() aborts, it does
    // NOT consult the pending-asks bookkeeping to fabricate a paused close.
    const out = run([
      event([], {
        actions: {
          requestedAuthConfigs: { fc_gmail_1: { scope: "x" } },
        },
      }),
    ]);
    expect(out.some((e) => e.type === "hitl.ask")).toBe(true);
    expect(out.some((e) => e.type === "turn.done")).toBe(false);
    expect(out.find((e) => e.type === "turn.abort")).toBeDefined();
  });
});

describe("createAdkNormalizer — groundingMetadata.searchEntryPoint → display.required", () => {
  it("emits display.required for searchEntryPoint.renderedContent", () => {
    const out = run([
      event([], {
        groundingMetadata: {
          searchEntryPoint: { renderedContent: "<b>Search results</b>" },
        },
      }),
    ]);
    const disp = out.find((e) => e.type === "display.required");
    expect(disp).toMatchObject({
      type: "display.required",
      provider: "google",
      html: "<b>Search results</b>",
    });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — actions.escalate:true → handoff escalate", () => {
  it("emits handoff with kind:escalate when actions.escalate is true", () => {
    const out = run([event([], { actions: { escalate: true } })]);
    const handoff = out.find((e) => e.type === "handoff");
    expect(handoff).toMatchObject({ type: "handoff", kind: "escalate" });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — unmapped actions → content.block provider-raw", () => {
  it("carries artifactDelta in a provider-raw content.block (lossless opaque passthrough)", () => {
    const out = run([
      event([], { actions: { artifactDelta: { doc1: "patch-v1" } } }),
    ]);
    const raw = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw" &&
        typeof (e as { block: { raw?: unknown } }).block === "object" &&
        "artifactDelta" in ((e as { block: { raw: object } }).block.raw as object),
    );
    expect(raw).toBeDefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("does NOT emit provider-raw when no unmapped action fields are present", () => {
    const out = run([event([], { actions: { transferToAgent: "billing" } })]);
    const blocks = out.filter(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw",
    );
    expect(blocks).toHaveLength(0);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — event-level unmapped fields → content.block provider-raw", () => {
  it("carries citationMetadata in a provider-raw content.block", () => {
    const out = run([
      event([], {
        citationMetadata: {
          citations: [{ uri: "https://example.com", title: "Example", startIndex: 0, endIndex: 5 }],
        },
      }),
    ]);
    const raw = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw" &&
        "citationMetadata" in ((e as { block: { raw: object } }).block.raw as object),
    );
    expect(raw).toBeDefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("carries customMetadata in a provider-raw content.block", () => {
    const out = run([event([], { customMetadata: { traceId: "t1", score: 0.9 } })]);
    const raw = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw" &&
        "customMetadata" in ((e as { block: { raw: object } }).block.raw as object),
    );
    expect(raw).toBeDefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("carries both citationMetadata and customMetadata in a single provider-raw block when both present", () => {
    const out = run([
      event([], {
        citationMetadata: { citations: [{ uri: "https://x", title: "X", startIndex: 0, endIndex: 3 }] },
        customMetadata: { version: 2 },
      }),
    ]);
    // One combined provider-raw block for both event-level unmapped fields.
    const raws = out.filter(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw",
    );
    expect(raws.length).toBeGreaterThanOrEqual(1);
    const combined = raws.find(
      (e) =>
        "citationMetadata" in ((e as { block: { raw: object } }).block.raw as object) &&
        "customMetadata" in ((e as { block: { raw: object } }).block.raw as object),
    );
    expect(combined).toBeDefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  // fixture-drift ratchet (google-adk-ratchet task): candidateIndex/branch
  // were real upstream Event/LlmResponse fields the hand-typed AdkEvent
  // contract either lacked (candidateIndex — @iqai/adk-era surface, absent
  // from the official @google/adk 1.3.0; the carry stays as harmless
  // tolerance for older wire) or declared but NEVER READ (branch) —
  // genuinely vanishing findings, folded into this SAME event-level
  // unmapped-fields carry. Both are genuinely OPTIONAL wire payloads
  // (multi-candidate / multi-agent-branch scenarios only). modelVersion
  // joined on the official-SDK retarget (2026-07-13): a genuinely-optional
  // @google/adk 1.3.0 LlmResponse field, same carry precedent.
  it("carries candidateIndex in a provider-raw content.block", () => {
    const out = run([event([], { candidateIndex: 1 })]);
    const raw = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw" &&
        "candidateIndex" in ((e as { block: { raw: object } }).block.raw as object),
    );
    expect(raw).toBeDefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("carries branch in a provider-raw content.block", () => {
    const out = run([event([], { branch: "agent_1.agent_2" })]);
    const raw = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw" &&
        "branch" in ((e as { block: { raw: object } }).block.raw as object),
    );
    expect(raw).toBeDefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("carries modelVersion in a provider-raw content.block (official @google/adk 1.3.0 retarget)", () => {
    const out = run([event([], { modelVersion: "gemini-3.5-flash-001" })]);
    const raw = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw" &&
        "modelVersion" in ((e as { block: { raw: object } }).block.raw as object),
    );
    expect(raw).toBeDefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("carries interactionId in a provider-raw content.block (@google/adk 1.4.0 LlmResponse field)", () => {
    const out = run([event([], { interactionId: "int_abc123" })]);
    const raw = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw" &&
        "interactionId" in ((e as { block: { raw: object } }).block.raw as object),
    );
    expect(raw).toBeDefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  // `author`/`timestamp` are ALSO real, currently-unread AdkEvent fields, but
  // are DELIBERATELY excluded from the generic carry (unlike branch/
  // modelVersion above): on the official @google/adk 1.3.0 Event interface
  // `timestamp` is REQUIRED and `author?` optional-in-type but set by the
  // runner on every appended event in practice
  // (present on EVERY event, not an occasional payload) — auto-carrying them
  // here would emit a provider-raw content.block on every single native
  // event, which empirically broke packages/e2e's captured golden fixtures
  // and cross-framework convergence assertions (out of this ratchet's
  // facet+manifests+script+SPEC-§8 boundary to regenerate). Disposed
  // honestly as `silently-dropped` in sdk-surface.json instead of landed —
  // this test documents that boundary explicitly rather than leaving it an
  // untested assumption.
  it("does NOT carry author/timestamp (ubiquitous-on-the-real-wire fields; disposed silently-dropped)", () => {
    const out = run([event([], { author: "billing_agent", timestamp: "2026-07-03T00:00:00Z" })]);
    const blocks = out.filter(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw",
    );
    expect(blocks).toHaveLength(0);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — unmapped Part fields → content.block provider-raw", () => {
  // fixture-drift ratchet (google-adk-ratchet task): mediaResolution/videoMetadata/
  // toolCall/toolResponse/partMetadata are real @google/genai `Part` fields with
  // NO route anywhere in driveAdkPart's if-chain — a genuinely-vanishing finding
  // (Tenet-6), fixed via the SAME provider-raw content.block carry pattern
  // already used for unmapped actions/event fields. SPEC §8 item 23.
  it("carries videoMetadata ALONGSIDE the already-handled inlineData block on the SAME part", () => {
    // genai's own doc: videoMetadata "should only be specified while the video
    // data is presented in inline_data or file_data" — i.e. it is a SIBLING of
    // an already-matched primary kind, not a standalone part. The if-chain
    // returns as soon as it matches `inlineData`, so this proves the carry
    // fires BEFORE that early return, not only when nothing else matches.
    const out = run([
      event([
        {
          inlineData: { mimeType: "video/mp4", data: "AAAA" },
          videoMetadata: { startOffset: "1.0s", endOffset: "3.0s" },
        },
      ]),
    ]);
    const fileBlock = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "file",
    );
    expect(fileBlock).toBeDefined();
    const rawBlock = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw" &&
        "videoMetadata" in ((e as { block: { raw: object } }).block.raw as object),
    );
    expect(rawBlock).toBeDefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("carries a standalone toolCall/toolResponse/mediaResolution/partMetadata part", () => {
    const out = run([
      event([
        {
          toolCall: { name: "google_search" },
          toolResponse: { result: "ok" },
          mediaResolution: { level: "MEDIA_RESOLUTION_LOW" },
          partMetadata: { source: "upload.txt" },
        },
      ]),
    ]);
    const raw = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw" &&
        "toolCall" in ((e as { block: { raw: object } }).block.raw as object) &&
        "toolResponse" in ((e as { block: { raw: object } }).block.raw as object) &&
        "mediaResolution" in ((e as { block: { raw: object } }).block.raw as object) &&
        "partMetadata" in ((e as { block: { raw: object } }).block.raw as object),
    );
    expect(raw).toBeDefined();
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("does NOT emit provider-raw for a plain text part with none of these fields", () => {
    const out = run([event([{ text: "hello" }], { partial: false, turnComplete: true })]);
    const blocks = out.filter(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw",
    );
    expect(blocks).toHaveLength(0);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — per-turn usage summation (echo-gemini35 live-capture finding, 2026-07-13)", () => {
  // ADK usageMetadata is PER-LLM-CALL and one turn spans every round of the
  // invocation — turn.done usage must SUM the rounds, not report only the
  // closing event's call (which silently dropped the tool round's tokens and
  // the whole thoughtsTokenCount on the real gemini-3.5-flash wire).
  it("sums usageMetadata across the invocation's rounds (tool round + final round)", () => {
    const out = run([
      // Round 1: functionCall (never closes the turn) — with thinking tokens.
      event([{ functionCall: { id: "fc_1", name: "echo", args: { message: "hi" } } }], {
        finishReason: "STOP",
        usageMetadata: { promptTokenCount: 109, candidatesTokenCount: 22, totalTokenCount: 256, thoughtsTokenCount: 125 },
      }),
      // Tool result (no usage).
      event([{ functionResponse: { id: "fc_1", name: "echo", response: { output: "hi" } } }]),
      // Round 2: final text — closes the turn.
      event([{ text: "Echoed: hi" }], {
        finishReason: "STOP",
        usageMetadata: { promptTokenCount: 285, candidatesTokenCount: 9, totalTokenCount: 294 },
      }),
    ]);
    const done = out.find((e) => e.type === "turn.done") as { usage?: Record<string, unknown> };
    // draft.3 §4: outputTokens INCLUDES reasoning — round 1's 22 candidates +
    // 125 thoughts and round 2's 9 candidates fold to 156; the provider total
    // identity now holds: 394 + 156 == 550.
    expect(done?.usage).toMatchObject({
      cumulative: false,
      inputTokens: 394,
      outputTokens: 156,
      totalTokens: 550,
      reasoningTokens: 125,
    });
    expect((done?.usage?.["inputTokens"] as number) + (done?.usage?.["outputTokens"] as number)).toBe(550);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  // ─── draft.3 §4 / §8.0 item 24: reasoning-inclusive outputTokens ──────────
  it("thoughts-free usageMetadata normalizes byte-identically to draft.2 (negative control: no reasoningTokens key, outputTokens = candidates)", () => {
    const out = run([
      event([{ text: "plain" }], {
        finishReason: "STOP",
        usageMetadata: { promptTokenCount: 181, candidatesTokenCount: 19, totalTokenCount: 200 },
      }),
    ]);
    const done = out.find((e) => e.type === "turn.done") as { usage?: Record<string, unknown> };
    expect(done?.usage).toEqual({ cumulative: false, inputTokens: 181, outputTokens: 19, totalTokens: 200 });
    expect("reasoningTokens" in (done?.usage ?? {})).toBe(false);
  });

  it("an already-inclusive endpoint (prompt + candidates == total with thoughts present) is NOT double-added — the identity guard", () => {
    const out = run([
      event([{ text: "x" }], {
        finishReason: "STOP",
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 30, totalTokenCount: 150 },
      }),
    ]);
    const done = out.find((e) => e.type === "turn.done") as { usage?: Record<string, unknown> };
    expect(done?.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, reasoningTokens: 30, totalTokens: 150 });
  });

  it("the spec's literal §10 item 21 example folds as written: {109, 22, 125, 256} → outputTokens 147", () => {
    const out = run([
      event([{ text: "x" }], {
        finishReason: "STOP",
        usageMetadata: { promptTokenCount: 109, candidatesTokenCount: 22, thoughtsTokenCount: 125, totalTokenCount: 256 },
      }),
    ]);
    const done = out.find((e) => e.type === "turn.done") as { usage?: Record<string, unknown> };
    expect(done?.usage).toEqual({ cumulative: false, inputTokens: 109, outputTokens: 147, reasoningTokens: 125, totalTokens: 256 });
  });

  it("contradictory data (thoughts present, candidates absent, total balancing on prompt alone) still folds — the guard needs a candidates count to mean anything", () => {
    const out = run([
      event([{ text: "x" }], { finishReason: "STOP", usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 7, totalTokenCount: 10 } }),
    ]);
    const done = out.find((e) => e.type === "turn.done") as { usage?: Record<string, unknown> };
    expect(done?.usage).toMatchObject({ inputTokens: 10, outputTokens: 7, reasoningTokens: 7, totalTokens: 10 });
  });

  it("thoughts without a candidates count (never observed live) still fold: outputTokens = thoughts", () => {
    const out = run([
      event([{ text: "x" }], { finishReason: "STOP", usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 7 } }),
    ]);
    const done = out.find((e) => e.type === "turn.done") as { usage?: Record<string, unknown> };
    expect(done?.usage).toMatchObject({ inputTokens: 10, outputTokens: 7, reasoningTokens: 7 });
    expect("totalTokens" in (done?.usage ?? {})).toBe(false);
  });

  it("counts each round ONCE despite the partial:true stream + partial:false aggregate re-send carrying the same usage (§8.3)", () => {
    const usage1 = { promptTokenCount: 82, candidatesTokenCount: 15, totalTokenCount: 97 };
    const usage2 = { promptTokenCount: 99, candidatesTokenCount: 4, totalTokenCount: 103 };
    const out = run([
      event([{ functionCall: { id: "fc_1", name: "echo", args: { message: "hi" } } }], { partial: true, finishReason: "STOP", usageMetadata: usage1 }),
      event([{ functionCall: { id: "fc_1", name: "echo", args: { message: "hi" } } }], { partial: false, finishReason: "STOP", usageMetadata: usage1 }),
      event([{ functionResponse: { id: "fc_1", name: "echo", response: { output: "hi" } } }]),
      event([{ text: "Echoed: hi" }], { partial: true, finishReason: "STOP", usageMetadata: usage2 }),
      event([{ text: "Echoed: hi" }], { partial: false, finishReason: "STOP", usageMetadata: usage2 }),
    ]);
    const done = out.find((e) => e.type === "turn.done") as { usage?: Record<string, unknown> };
    // 97-round + 103-round each counted exactly once: 82+99 / 15+4 / 97+103.
    expect(done?.usage).toMatchObject({ inputTokens: 181, outputTokens: 19, totalTokens: 200 });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

// ─── adk 1.5.0 + genai 2.15.0 peer-bump carries (2026-08-04) ─────────────────

describe("createAdkNormalizer — genai 2.15.0 Part.audioTranscription → provider-raw carry", () => {
  // The FIRST new genai `Part` field since the partKind ratchet was seeded at
  // 14 members: "Output only. The transcription of the audio part." — a
  // Transcription {text, finished, languageCode, speakerLabel, words[]} riding
  // ALONGSIDE the audio inlineData part it transcribes (the same sibling
  // situation as videoMetadata), so it joins the SAME unconditional
  // unmapped-part-fields carry checked BEFORE the if-chain's early returns.
  // Carried WHOLE, never split: first-class text treatment (the event-level
  // outputTranscription _meta stamp precedent) would orphan speakerLabel/words.
  const transcription = {
    text: "hello there",
    finished: true,
    languageCode: "en-US",
    speakerLabel: "spk_1",
    words: [
      { word: "hello", startOffset: "0s", endOffset: "0.4s" },
      { word: "there", startOffset: "0.4s", endOffset: "0.8s" },
    ],
  };
  const audioPartEvent = (withTranscription: boolean) =>
    event(
      [
        {
          inlineData: { mimeType: "audio/pcm", data: "AAAA" },
          ...(withTranscription ? { audioTranscription: transcription } : {}),
        },
      ],
      { partial: false, turnComplete: true, finishReason: "STOP" }
    );

  it("carries the WHOLE Transcription (speakerLabel + words included) ALONGSIDE the already-handled audio inlineData block on the SAME part", () => {
    const out = run([audioPartEvent(true)]);
    const audioBlock = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "audio",
    );
    expect(audioBlock).toBeDefined();
    const rawBlock = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw" &&
        "audioTranscription" in ((e as { block: { raw: object } }).block.raw as object),
    );
    expect(rawBlock).toBeDefined();
    // Lossless: the carry preserves the full 2.15.0 Transcription shape,
    // including the new speakerLabel + WordInfo duration-string offsets.
    expect(
      ((rawBlock as { block: { raw: Record<string, unknown> } }).block.raw)["audioTranscription"],
    ).toEqual(transcription);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("the audioTranscription stream folds cleanly through the Reducer (INV-MSG fold gate: no parks)", () => {
    const evs = run([audioPartEvent(true)]);
    const r = new Reducer();
    for (const ev of evs) r.push(ev);
    expect(r.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });

  it("a 2.12.0-shaped audio part (no audioTranscription) stays byte-identical — NO provider-raw, no new key anywhere (negative control)", () => {
    const out = run([audioPartEvent(false)]);
    const raws = out.filter(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw",
    );
    expect(raws).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain("audioTranscription");
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — adk 1.5.0 CompactedEvent projection → provider-raw carry", () => {
  // CompactedEvent (isCompacted/startTime/endTime/compactedContent + the NEW
  // 1.5.0 isScratchpad, the anchored compactor's persistent scratchpad) is a
  // session-history-plane Event SUBTYPE: compactors rewrite session.events IN
  // PLACE and never yield one on the runner.runAsync boundary — this carry is
  // session-REPLAY ingestion tolerance (the candidateIndex off-inventory
  // precedent), so it can never fire on live-captured wire.
  const compacted = (extra: Partial<AdkEvent> = {}) =>
    event([{ text: "User asked about X; agent answered Y." }], {
      isCompacted: true,
      startTime: 1754265600,
      endTime: 1754269200,
      compactedContent: "User asked about X; agent answered Y.",
      author: "system",
      partial: false,
      turnComplete: true,
      finishReason: "STOP",
      ...extra,
    });
  const findCompactedRaw = (out: AgEvent[]) =>
    out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "provider-raw" &&
        "isCompacted" in ((e as { block: { raw: object } }).block.raw as object),
    ) as { block: { raw: Record<string, unknown> } } | undefined;

  it("carries the full projection with isScratchpad:true — and the ubiquitous author field still does NOT leak into the carry", () => {
    const out = run([compacted({ isScratchpad: true })]);
    const raw = findCompactedRaw(out);
    expect(raw).toBeDefined();
    expect(raw?.block.raw).toEqual({
      isCompacted: true,
      startTime: 1754265600,
      endTime: 1754269200,
      compactedContent: "User asked about X; agent answered Y.",
      isScratchpad: true,
    });
    // author:"system" is set on every compactor-produced event — the
    // silently-dropped disposition must hold for the subtype too.
    expect("author" in (raw?.block.raw ?? {})).toBe(false);
    // The summary content itself still streams as ordinary text.
    expect(out.some((e) => e.type === "text.delta")).toBe(true);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("carries an explicit isScratchpad:false losslessly (present-check, not truthiness)", () => {
    const out = run([compacted({ isScratchpad: false })]);
    const raw = findCompactedRaw(out);
    expect(raw?.block.raw["isScratchpad"]).toBe(false);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("a 1.4.0-shaped CompactedEvent (no isScratchpad) carries the package WITHOUT an isScratchpad key (negative control)", () => {
    const out = run([compacted()]);
    const raw = findCompactedRaw(out);
    expect(raw).toBeDefined();
    expect("isScratchpad" in (raw?.block.raw ?? {})).toBe(false);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("a scratchpad-compacted turn plus a normal turn fold cleanly through the Reducer (no parks, no re-opened sealed ids)", () => {
    const evs = run([
      compacted({ isScratchpad: true }),
      event([{ text: "fresh turn" }], {
        invocationId: "inv_fixture_2",
        partial: false,
        turnComplete: true,
        finishReason: "STOP",
      }),
    ]);
    const r = new Reducer();
    for (const ev of evs) r.push(ev);
    expect(r.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });

  it("a 1.4.0-shaped plain event stream never mentions the compacted keys (byte-identical negative control)", () => {
    const out = run([
      event([{ text: "plain" }], { partial: false, turnComplete: true, finishReason: "STOP" }),
    ]);
    expect(JSON.stringify(out)).not.toContain("isScratchpad");
    expect(JSON.stringify(out)).not.toContain("compactedContent");
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

// ─── adk 2.0.0 + genai 2.20.0 peer-bump carries (2026-09-02) ─────────────────

/** The provider-raw content.block whose raw bag carries `key`, if any. */
function findProviderRawWith(out: AgEvent[], key: string) {
  return out.find(
    (e) =>
      e.type === "content.block" &&
      typeof (e as { block?: unknown }).block === "object" &&
      (e as { block: { type?: string } }).block !== null &&
      (e as { block: { type: string } }).block.type === "provider-raw" &&
      key in ((e as { block: { raw: object } }).block.raw as object),
  ) as { block: { raw: Record<string, unknown> } } | undefined;
}

/** Every provider-raw content.block in the stream (negative controls assert none). */
function providerRawBlocks(out: AgEvent[]): AgEvent[] {
  return out.filter(
    (e) =>
      e.type === "content.block" &&
      typeof (e as { block?: unknown }).block === "object" &&
      (e as { block: { type?: string } }).block !== null &&
      (e as { block: { type: string } }).block.type === "provider-raw",
  );
}

describe("createAdkNormalizer — adk 2.0.0 workflow-plane Event fields → provider-raw carry", () => {
  // output/route/nodeInfo/isolationScope are the four new optional `Event`
  // own-fields in 2.0.0's event.d.ts. They are stamped ONLY by the new
  // workflow plane (dist/esm/workflow/node_runner.js sets output/route on node
  // results; run_llm_agent_as_node.js stamps nodeInfo.messageAsOutput +
  // isolationScope) and round-tripped by vertex_ai_session_service.js — a
  // plain LlmAgent runner.runAsync stream never carries them, so this carry
  // is workflow-plane/session-replay ingestion tolerance (the CompactedEvent/
  // isScratchpad + interactionId precedents) and cannot fire on the standing
  // gemini37 trio. The fixtures below mirror the upstream d.ts shapes exactly:
  // Route = RouteKey | RouteKey[] (RouteKey = string|number|boolean), NodeInfo
  // = {path?, outputFor?: string[], messageAsOutput?}, output: unknown.
  const workflowFields = {
    output: { verdict: "approved", score: 0.92 },
    route: ["approve", "notify"],
    nodeInfo: { path: "wf.review.0", outputFor: ["wf.review.0", "wf.review"], messageAsOutput: true },
    isolationScope: "wf.review.0@run_7",
  };
  const workflowEvent = (extra: Partial<AdkEvent> = {}) =>
    event([{ text: "Approved." }], {
      partial: false,
      turnComplete: true,
      finishReason: "STOP",
      author: "reviewer",
      ...extra,
    });

  it("carries all four workflow fields in ONE event-level provider-raw block (nodeInfo as a whole object) — and the ubiquitous author field still does NOT leak", () => {
    const out = run([workflowEvent(workflowFields)]);
    const raw = findProviderRawWith(out, "nodeInfo");
    expect(raw).toBeDefined();
    expect(raw?.block.raw).toEqual(workflowFields);
    expect("author" in (raw?.block.raw ?? {})).toBe(false);
    // Exactly one provider-raw block: the quartet joins the existing
    // unmappedEvent ledger rather than fanning out per field.
    expect(providerRawBlocks(out)).toHaveLength(1);
    // The node's textual content itself still streams as ordinary text.
    expect(out.some((e) => e.type === "text.delta")).toBe(true);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("carries a scalar RouteKey route and a falsy one losslessly (present-check, not truthiness)", () => {
    const single = run([workflowEvent({ route: "approve" })]);
    expect(findProviderRawWith(single, "route")?.block.raw).toEqual({ route: "approve" });
    const falsy = run([workflowEvent({ route: false })]);
    expect(findProviderRawWith(falsy, "route")?.block.raw).toEqual({ route: false });
    const zero = run([workflowEvent({ route: 0 })]);
    expect(findProviderRawWith(zero, "route")?.block.raw).toEqual({ route: 0 });
    for (const ev of [...single, ...falsy, ...zero]) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("carries each field independently (a node event may stamp only isolationScope, or only output)", () => {
    const scoped = run([workflowEvent({ isolationScope: "wf.child.1@run_7" })]);
    expect(findProviderRawWith(scoped, "isolationScope")?.block.raw).toEqual({
      isolationScope: "wf.child.1@run_7",
    });
    const produced = run([workflowEvent({ output: "plain string output" })]);
    expect(findProviderRawWith(produced, "output")?.block.raw).toEqual({
      output: "plain string output",
    });
    for (const ev of [...scoped, ...produced]) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("joins the existing unmappedEvent ledger alongside interactionId/branch in the SAME block", () => {
    const out = run([
      workflowEvent({ ...workflowFields, interactionId: "int_wf_1", branch: "wf.review" }),
    ]);
    const raw = findProviderRawWith(out, "nodeInfo");
    expect(raw?.block.raw).toEqual({ interactionId: "int_wf_1", branch: "wf.review", ...workflowFields });
    expect(providerRawBlocks(out)).toHaveLength(1);
  });

  it("a workflow-node turn plus a plain turn fold cleanly through the Reducer (INV-MSG fold gate: no parks)", () => {
    const evs = run([
      workflowEvent(workflowFields),
      event([{ text: "fresh turn" }], {
        invocationId: "inv_fixture_2",
        partial: false,
        turnComplete: true,
        finishReason: "STOP",
      }),
    ]);
    const r = new Reducer();
    for (const ev of evs) r.push(ev);
    expect(r.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });

  it("a 1.6.0-shaped event (none of the four fields) stays byte-identical — NO provider-raw, no new key anywhere (negative control)", () => {
    const out = run([workflowEvent()]);
    expect(providerRawBlocks(out)).toHaveLength(0);
    const json = JSON.stringify(out);
    for (const key of ["output", "route", "nodeInfo", "isolationScope"]) {
      expect(json).not.toContain(`"${key}"`);
    }
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — adk 2.0.0 EventActions.agentState (object-valued) → unmappedActions carry", () => {
  // 2.0.0 promotes agentState/endOfAgent to FIRST-CLASS EventActions members
  // (event_actions.d.ts). Both were already on the hand-typed contract and
  // ledger-carried — but agentState was typed `string`, while the official
  // shape is `Record<string, unknown>` (node_runner.js writes `{ input }` /
  // a resumable-checkpoint snapshot). The contract is widened to JsonValue
  // and the value routed through JsonValue.parse at the boundary.
  const snapshot = {
    input: { query: "refund order 42" },
    checkpoint: { step: 3, pending: ["notify"], done: true },
  };
  const actionsEvent = (actions: NonNullable<AdkEvent["actions"]>) =>
    event([{ text: "done" }], { partial: false, turnComplete: true, finishReason: "STOP", actions });

  it("carries an OBJECT-valued agentState losslessly (nested objects + arrays intact), alongside endOfAgent", () => {
    const out = run([actionsEvent({ agentState: snapshot, endOfAgent: true })]);
    const raw = findProviderRawWith(out, "agentState");
    expect(raw).toBeDefined();
    expect(raw?.block.raw).toEqual({ agentState: snapshot, endOfAgent: true });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("still carries a legacy string-valued agentState (pre-2.0.0 hand-typed shape — older-wire tolerance)", () => {
    const out = run([actionsEvent({ agentState: "opaque-legacy-state" })]);
    expect(findProviderRawWith(out, "agentState")?.block.raw).toEqual({
      agentState: "opaque-legacy-state",
    });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("an object-valued agentState folds cleanly through the Reducer (no parks)", () => {
    const evs = run([actionsEvent({ agentState: snapshot, endOfAgent: true })]);
    const r = new Reducer();
    for (const ev of evs) r.push(ev);
    expect(r.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });

  it("a 1.6.0-shaped actions bag (stateDelta only, no agentState/endOfAgent) stays byte-identical — state.delta emitted, NO provider-raw (negative control)", () => {
    const out = run([actionsEvent({ stateDelta: { step: 1 } })]);
    expect(out.some((e) => e.type === "state.delta")).toBe(true);
    expect(providerRawBlocks(out)).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain("agentState");
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — genai 2.20.0 Part.mediaProcessing → provider-raw carry", () => {
  // The ONE new genai `Part` field 2.17.1 -> 2.20.0: "How the model processes
  // this part's media for understanding." — the MediaProcessing enum
  // (MEDIA_PROCESSING_UNSPECIFIED | STATIC | AGENTIC), a request-side hint
  // riding ALONGSIDE the inlineData/fileData part it qualifies — the same
  // sibling situation as mediaResolution/videoMetadata, so it joins the SAME
  // unconditional unmapped-part-fields carry checked BEFORE the if-chain's
  // early returns (an else-fallback would never see it on a part whose
  // primary kind already matched).
  const mediaPartEvent = (extra: Partial<AdkPart> = {}) =>
    event([{ inlineData: { mimeType: "video/mp4", data: "AAAA" }, ...extra }], {
      partial: false,
      turnComplete: true,
      finishReason: "STOP",
    });

  it("carries mediaProcessing ALONGSIDE the already-handled inlineData block on the SAME part (videoMetadata precedent)", () => {
    const out = run([mediaPartEvent({ mediaProcessing: "AGENTIC" })]);
    const fileBlock = out.find(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type === "file",
    );
    expect(fileBlock).toBeDefined();
    expect(findProviderRawWith(out, "mediaProcessing")?.block.raw).toEqual({
      mediaProcessing: "AGENTIC",
    });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("rides in the SAME single provider-raw block as its videoMetadata sibling (one ledger, not two blocks)", () => {
    const out = run([
      mediaPartEvent({
        mediaProcessing: "STATIC",
        videoMetadata: { startOffset: "1.0s", endOffset: "3.0s", fps: 2 },
      }),
    ]);
    expect(findProviderRawWith(out, "mediaProcessing")?.block.raw).toEqual({
      videoMetadata: { startOffset: "1.0s", endOffset: "3.0s", fps: 2 },
      mediaProcessing: "STATIC",
    });
    expect(providerRawBlocks(out)).toHaveLength(1);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("also carries it beside a fileData part (the other media kind the hint qualifies)", () => {
    const out = run([
      event([
        {
          fileData: { mimeType: "video/mp4", fileUri: "gs://bucket/clip.mp4" },
          mediaProcessing: "MEDIA_PROCESSING_UNSPECIFIED",
        },
      ]),
    ]);
    expect(out.some((e) => e.type === "content.block" && (e as { block: { type: string } }).block.type === "resource-link")).toBe(true);
    expect(findProviderRawWith(out, "mediaProcessing")?.block.raw).toEqual({
      mediaProcessing: "MEDIA_PROCESSING_UNSPECIFIED",
    });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("a 2.17.1-shaped media part (no mediaProcessing) stays byte-identical — NO provider-raw, no new key anywhere (negative control)", () => {
    const out = run([mediaPartEvent()]);
    expect(providerRawBlocks(out)).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain("mediaProcessing");
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

// ─── adk 2.1.0 + genai 2.24.0 peer-bump carries (cohort 0.6.3, 2026-09-23) ───

/** Drop `seq` so two streams can be compared structurally across an inserted event. */
function withoutSeq(out: AgEvent[]): unknown[] {
  return out.map((e) => {
    const { seq: _seq, ...rest } = e as AgEvent & { seq?: number };
    return rest;
  });
}

/** Every non-provider-raw content.block's `block` (the typed arms). */
function typedBlocks(out: AgEvent[]): Array<Record<string, unknown>> {
  return out
    .filter(
      (e) =>
        e.type === "content.block" &&
        typeof (e as { block?: unknown }).block === "object" &&
        (e as { block: { type?: string } }).block !== null &&
        (e as { block: { type: string } }).block.type !== "provider-raw",
    )
    .map((e) => (e as { block: Record<string, unknown> }).block);
}

describe("createAdkNormalizer — genai 2.24.0 Part.speechMetadata → provider-raw carry (adk-01)", () => {
  // The ONE new genai `Part` field 2.22.0 -> 2.24.0 (Part 16 -> 17 members):
  // "Extra metadata associated with the part for speech synthesis, such as
  // speaker and style. Only valid when `Part.data` is set to `text`." —
  // SpeechMetadata {speaker?, style?}, a request-side TTS hint riding
  // ALONGSIDE a text part. The text arm returns early, so the carry MUST sit
  // in the unconditional unmapped-part-fields block (mediaProcessing
  // precedent), never an else-fallback.
  const speech = { speaker: "Joe", style: "excited, fast-paced" };
  const textPartEvent = (extra: Partial<AdkPart> = {}) =>
    event([{ text: "Hello there", ...extra }], {
      partial: false,
      turnComplete: true,
      finishReason: "STOP",
    });

  it("carries speechMetadata ALONGSIDE the already-handled text block on the SAME part (mirror)", () => {
    const out = run([textPartEvent({ speechMetadata: speech })]);
    // The text arm still maps (the carry never displaces the primary kind).
    expect(out.filter((e) => e.type === "text.delta").map((e) => (e as { delta: string }).delta)).toEqual([
      "Hello there",
    ]);
    // Lossless, verbatim wire key (camelCase on the genai JS wire).
    expect(findProviderRawWith(out, "speechMetadata")?.block.raw).toEqual({ speechMetadata: speech });
    expect(providerRawBlocks(out)).toHaveLength(1);
    // Ledger position: the unconditional block runs BEFORE the text arm.
    expect(out.findIndex((e) => e.type === "content.block")).toBeLessThan(
      out.findIndex((e) => e.type === "text.start"),
    );
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("is purely ADDITIVE: minus the one provider-raw event, the stream equals the field-absent stream", () => {
    const withField = withoutSeq(run([textPartEvent({ speechMetadata: speech })])).filter(
      (e) =>
        !(
          (e as { type?: string }).type === "content.block" &&
          (e as { block: { type: string } }).block.type === "provider-raw"
        ),
    );
    expect(withField).toEqual(withoutSeq(run([textPartEvent()])));
  });

  it("present-checks, never truthiness: an EMPTY SpeechMetadata {} and a (falsy) JSON null both ride", () => {
    const out = run([textPartEvent({ speechMetadata: {} })]);
    expect(findProviderRawWith(out, "speechMetadata")?.block.raw).toEqual({ speechMetadata: {} });
    // `{}` is truthy in JS, so only the falsy null actually discriminates a
    // `!== undefined` present-check from a truthiness check (reviewer mutation
    // `if (part.speechMetadata)` survived the `{}` case alone).
    const nulled = run([textPartEvent({ speechMetadata: null })]);
    expect(findProviderRawWith(nulled, "speechMetadata")?.block.raw).toEqual({ speechMetadata: null });
    for (const ev of [...out, ...nulled]) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("rides in the SAME single provider-raw block as a mediaProcessing sibling (one ledger, not two blocks)", () => {
    const out = run([textPartEvent({ mediaProcessing: "STATIC", speechMetadata: speech })]);
    expect(providerRawBlocks(out)).toHaveLength(1);
    const raw = findProviderRawWith(out, "speechMetadata")?.block.raw;
    expect(raw).toEqual({ mediaProcessing: "STATIC", speechMetadata: speech });
    // Ledger insertion order is the named-field order in driveAdkPart.
    expect(Object.keys(raw ?? {})).toEqual(["mediaProcessing", "speechMetadata"]);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });

  it("the partial:false aggregate re-send does NOT double-carry it (the suppressed aggregate text part never re-enters driveAdkPart)", () => {
    const out = run([
      event([{ text: "Hello there", speechMetadata: speech }], { partial: true }),
      event([{ text: "Hello there", speechMetadata: speech }], {
        partial: false,
        turnComplete: true,
        finishReason: "STOP",
      }),
    ]);
    expect(providerRawBlocks(out)).toHaveLength(1);
    const r = new Reducer();
    for (const ev of out) r.push(ev);
    expect(r.needsResync).toBe(false);
    expect(() => AgReduceResult.parse(r.result())).not.toThrow();
  });

  it("a 2.22.0-shaped text part (no speechMetadata) stays byte-identical — NO provider-raw, no new key anywhere (negative control)", () => {
    const out = run([textPartEvent()]);
    expect(providerRawBlocks(out)).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain("speechMetadata");
    expect(out.map((e) => e.type)).toEqual([
      "turn.start",
      "message.start",
      "text.start",
      "text.delta",
      "text.end",
      "message.end",
      "turn.done",
    ]);
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});

describe("createAdkNormalizer — genai-optional arm members ride provider-raw, never crash or emit a schema-invalid block (adk-13)", () => {
  // genai types Blob `mimeType?`/`data?`, ExecutableCode `code?` and FileData
  // `fileUri?` as OPTIONAL (doc-"Required" only; upstream adk #868 fixed the
  // same assumption for code). A missing member the AgBlock arm REQUIRES
  // routes the WHOLE arm, verbatim and keyed by its wire field name, to one
  // provider-raw block. No live capture has shown any of these shapes.
  const mediaEvent = (part: AdkPart) =>
    event([part], { partial: false, turnComplete: true, finishReason: "STOP" });

  /** Push raw JSON (shapes the AdkPart projection does not admit, e.g. a null arm). */
  function runRaw(native: JsonValue): AgEvent[] {
    const n = createAdkNormalizer();
    return [...n.push(native), ...n.flush()];
  }

  describe("inlineData", () => {
    it("PRESENT mimeType + data maps exactly as before (image / audio / file arms)", () => {
      const out = run([
        mediaEvent({ inlineData: { mimeType: "image/png", data: "AAAA" } }),
        mediaEvent({ inlineData: { mimeType: "audio/wav", data: "BBBB" } }),
        mediaEvent({ inlineData: { mimeType: "video/mp4", data: "CCCC" } }),
      ]);
      expect(typedBlocks(out)).toEqual([
        { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } },
        { type: "audio", source: { type: "base64", mediaType: "audio/wav", data: "BBBB" } },
        { type: "file", source: { type: "base64", mediaType: "video/mp4", data: "CCCC" } },
      ]);
      expect(providerRawBlocks(out)).toHaveLength(0);
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    });

    it("typeof, never truthiness: empty-string mimeType/data still map to a media block", () => {
      const out = run([mediaEvent({ inlineData: { mimeType: "", data: "" } })]);
      expect(typedBlocks(out)).toEqual([
        { type: "file", source: { type: "base64", mediaType: "", data: "" } },
      ]);
      expect(providerRawBlocks(out)).toHaveLength(0);
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    });

    it("ABSENT mimeType does not throw (was `mimeType.startsWith` TypeError) — the Blob rides provider-raw", () => {
      let out: AgEvent[] = [];
      expect(() => {
        out = run([mediaEvent({ inlineData: { data: "AAAA" } })]);
      }).not.toThrow();
      expect(typedBlocks(out)).toHaveLength(0);
      expect(findProviderRawWith(out, "inlineData")?.block.raw).toEqual({ inlineData: { data: "AAAA" } });
      expect(out.some((e) => e.type === "turn.done")).toBe(true);
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    });

    it("ABSENT data never emits a data-less base64 source — the Blob rides provider-raw", () => {
      const out = run([mediaEvent({ inlineData: { mimeType: "image/png" } })]);
      expect(typedBlocks(out)).toHaveLength(0);
      expect(findProviderRawWith(out, "inlineData")?.block.raw).toEqual({
        inlineData: { mimeType: "image/png" },
      });
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    });

    it("an EMPTY Blob {} and a JSON-null arm both ride provider-raw verbatim", () => {
      const empty = run([mediaEvent({ inlineData: {} })]);
      expect(findProviderRawWith(empty, "inlineData")?.block.raw).toEqual({ inlineData: {} });
      const nulled = runRaw({
        content: { role: "model", parts: [{ inlineData: null }] },
        invocationId: "inv_fixture_1",
      });
      expect(findProviderRawWith(nulled, "inlineData")?.block.raw).toEqual({ inlineData: null });
      for (const ev of [...empty, ...nulled]) expect(() => AgEvent.parse(ev)).not.toThrow();
    });

    it("the arm carry is its OWN block after the sibling-field ledger block (both lossless)", () => {
      const out = run([
        mediaEvent({ inlineData: { data: "AAAA" }, videoMetadata: { startOffset: "1.0s" } }),
      ]);
      expect(providerRawBlocks(out).map((e) => (e as { block: { raw: unknown } }).block.raw)).toEqual([
        { videoMetadata: { startOffset: "1.0s" } },
        { inlineData: { data: "AAAA" } },
      ]);
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    });

    it("branch order is unchanged: a text part carrying a malformed inlineData still takes the text arm, no carry (the media arm is never reached)", () => {
      const out = run([mediaEvent({ text: "hi", inlineData: { data: "AAAA" } })]);
      expect(out.some((e) => e.type === "text.delta")).toBe(true);
      expect(providerRawBlocks(out)).toHaveLength(0);
      expect(typedBlocks(out)).toHaveLength(0);
    });

    it("a malformed-arm stream folds cleanly through the Reducer", () => {
      const r = new Reducer();
      for (const ev of run([mediaEvent({ inlineData: { mimeType: "image/png" } })])) r.push(ev);
      expect(r.needsResync).toBe(false);
      expect(() => AgReduceResult.parse(r.result())).not.toThrow();
    });
  });

  describe("executableCode", () => {
    it("PRESENT code maps to the code block exactly as before", () => {
      const out = run([mediaEvent({ executableCode: { language: "PYTHON", code: "print(1)" } })]);
      expect(typedBlocks(out)).toEqual([{ type: "code", language: "python", code: "print(1)" }]);
      expect(providerRawBlocks(out)).toHaveLength(0);
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    });

    it("typeof, never truthiness: an empty-string code still maps to a code block", () => {
      const out = run([mediaEvent({ executableCode: { code: "" } })]);
      expect(typedBlocks(out)).toEqual([{ type: "code", language: "python", code: "" }]);
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    });

    it("ABSENT code never emits a code-less (schema-invalid) code block — the arm rides provider-raw, id included", () => {
      const out = runRaw({
        content: { role: "model", parts: [{ executableCode: { language: "PYTHON", id: "exec_1" } }] },
        invocationId: "inv_fixture_1",
        turnComplete: true,
      });
      expect(typedBlocks(out)).toHaveLength(0);
      expect(findProviderRawWith(out, "executableCode")?.block.raw).toEqual({
        executableCode: { language: "PYTHON", id: "exec_1" },
      });
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    });
  });

  describe("fileData", () => {
    it("PRESENT fileUri maps to the resource-link block exactly as before (mimeType optional)", () => {
      const out = run([
        mediaEvent({ fileData: { mimeType: "video/mp4", fileUri: "gs://bucket/clip.mp4" } }),
        mediaEvent({ fileData: { fileUri: "gs://bucket/any" } }),
      ]);
      expect(typedBlocks(out)).toEqual([
        { type: "resource-link", uri: "gs://bucket/clip.mp4", mimeType: "video/mp4" },
        { type: "resource-link", uri: "gs://bucket/any", mimeType: undefined },
      ]);
      // The absent mimeType serializes away (no key on the wire), as before.
      expect(JSON.stringify(typedBlocks(out)[1])).toBe('{"type":"resource-link","uri":"gs://bucket/any"}');
      expect(providerRawBlocks(out)).toHaveLength(0);
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    });

    it("typeof, never truthiness: an empty-string fileUri still maps to a resource-link", () => {
      const out = run([mediaEvent({ fileData: { fileUri: "" } })]);
      expect(typedBlocks(out)).toEqual([{ type: "resource-link", uri: "", mimeType: undefined }]);
      expect(providerRawBlocks(out)).toHaveLength(0);
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    });

    it("ABSENT fileUri never emits a uri-less (schema-invalid) resource-link — the arm rides provider-raw", () => {
      const out = run([mediaEvent({ fileData: { mimeType: "video/mp4" } })]);
      expect(typedBlocks(out)).toHaveLength(0);
      expect(findProviderRawWith(out, "fileData")?.block.raw).toEqual({
        fileData: { mimeType: "video/mp4" },
      });
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    });
  });
});

describe("createAdkNormalizer — genai 2.24.0 Blob/FileData.displayName (existing field or carry, never a new literal)", () => {
  // genai 2.24.0 drops "not supported in Gemini API" from displayName's doc on
  // Blob and FileData, so the name may now reach the wire. Blob → file.filename
  // (SPEC §2) or providerMetadata.google.displayName on image/audio (no name
  // slot); FileData → a sibling provider-raw, because resource-link has no name
  // slot. Absent ⇒ byte-identical.
  const one = (part: AdkPart) => run([event([part], { partial: false, turnComplete: true, finishReason: "STOP" })]);
  const expectValid = (out: AgEvent[]) => {
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    const r = new Reducer();
    for (const ev of out) r.push(ev);
    expect(r.needsResync).toBe(false);
  };

  it("a file-arm Blob → file.filename", () => {
    const out = one({ inlineData: { mimeType: "application/pdf", data: "JVBE", displayName: "invoice.pdf" } });
    expect(typedBlocks(out)).toEqual([
      { type: "file", source: { type: "base64", mediaType: "application/pdf", data: "JVBE" }, filename: "invoice.pdf" },
    ]);
    expect(providerRawBlocks(out)).toHaveLength(0);
    expectValid(out);
  });

  it("image and audio Blobs → providerMetadata.google.displayName (no name slot)", () => {
    const out = run([
      event([{ inlineData: { mimeType: "image/png", data: "AAAA", displayName: "chart.png" } }]),
      event([{ inlineData: { mimeType: "audio/wav", data: "BBBB", displayName: "memo.wav" } }], {
        partial: false,
        turnComplete: true,
        finishReason: "STOP",
      }),
    ]);
    expect(typedBlocks(out)).toEqual([
      {
        type: "image",
        source: { type: "base64", mediaType: "image/png", data: "AAAA" },
        providerMetadata: { google: { displayName: "chart.png" } },
      },
      {
        type: "audio",
        source: { type: "base64", mediaType: "audio/wav", data: "BBBB" },
        providerMetadata: { google: { displayName: "memo.wav" } },
      },
    ]);
    expectValid(out);
  });

  it("FileData → the resource-link unchanged, then a sibling provider-raw {fileData:{displayName}}", () => {
    const out = one({ fileData: { fileUri: "gs://b/report.pdf", mimeType: "application/pdf", displayName: "Q3 report" } });
    expect(typedBlocks(out)).toEqual([{ type: "resource-link", uri: "gs://b/report.pdf", mimeType: "application/pdf" }]);
    expect(providerRawBlocks(out).map((e) => (e as { block: { raw: unknown } }).block.raw)).toEqual([
      { fileData: { displayName: "Q3 report" } },
    ]);
    expectValid(out);
  });

  it("negative control: absent displayName stays byte-identical (no filename, no providerMetadata, no carry)", () => {
    const out = run([
      event([{ inlineData: { mimeType: "application/pdf", data: "JVBE" } }]),
      event([{ inlineData: { mimeType: "image/png", data: "AAAA" } }]),
      event([{ fileData: { fileUri: "gs://b/o" } }], { partial: false, turnComplete: true, finishReason: "STOP" }),
    ]);
    const json = JSON.stringify(out);
    for (const k of ["filename", "displayName", "providerMetadata"]) expect(json).not.toContain(k);
    expect(providerRawBlocks(out)).toHaveLength(0);
  });

  it("a JSON-null displayName is absent (null guard)", () => {
    const n = createAdkNormalizer();
    const out = [
      ...n.push({
        content: {
          role: "model",
          parts: [
            { inlineData: { mimeType: "application/pdf", data: "JVBE", displayName: null } },
            { fileData: { fileUri: "gs://b/o", displayName: null } },
          ],
        },
        invocationId: "inv_fixture_1",
        turnComplete: true,
      }),
      ...n.flush(),
    ];
    expect(JSON.stringify(out)).not.toContain("displayName");
    expectValid(out);
  });

  it("an unmappable Blob carrying displayName rides verbatim once (no second carry)", () => {
    const out = one({ inlineData: { data: "AAAA", displayName: "x.bin" } });
    expect(providerRawBlocks(out).map((e) => (e as { block: { raw: unknown } }).block.raw)).toEqual([
      { inlineData: { data: "AAAA", displayName: "x.bin" } },
    ]);
  });
});

describe("createAdkNormalizer — JSON-null guard: a null arm is carried, a null member is absent, nothing is dereferenced", () => {
  // A snake_case serializer that keeps Python None (session payloads) can hand
  // the facet `null` where the genai types say "optional". The AdkPart
  // projection cannot express these shapes, so they go in as raw JSON. No live
  // capture has shown any of them.
  const INV = "inv_fixture_1";
  const partsEvent = (parts: JsonValue[], extra: { [k: string]: JsonValue } = {}): JsonValue => ({
    content: { role: "model", parts },
    invocationId: INV,
    turnComplete: true,
    finishReason: "STOP",
    ...extra,
  });
  function runRaw(...natives: JsonValue[]): AgEvent[] {
    const n = createAdkNormalizer();
    return [...natives.flatMap((v) => n.push(v)), ...n.flush()];
  }
  function expectValidAndFolds(out: AgEvent[]): void {
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    const r = new Reducer();
    for (const ev of out) r.push(ev);
    expect(r.needsResync).toBe(false);
  }

  describe("a null MEMBER is absent: output is byte-identical to the member left out", () => {
    it("thought part: text null (was `null.length`)", () => {
      const nulled = runRaw(partsEvent([{ thought: true, text: null }]));
      expect(nulled).toEqual(runRaw(partsEvent([{ thought: true }])));
      expect(nulled.some((e) => e.type === "reasoning.start")).toBe(true);
      expect(nulled.some((e) => e.type === "reasoning.delta")).toBe(false);
      expectValidAndFolds(nulled);
    });

    it("text part: text null emits no text block (was textDelta(null))", () => {
      const nulled = runRaw(partsEvent([{ text: null }]));
      expect(nulled).toEqual(runRaw(partsEvent([{}])));
      expect(nulled.some((e) => e.type.startsWith("text."))).toBe(false);
      expectValidAndFolds(nulled);
    });

    it("text null beside a functionCall no longer swallows the call", () => {
      const call = { id: "call_1", name: "echo", args: { message: "hi" } };
      const nulled = runRaw(partsEvent([{ text: null, functionCall: call }], { finishReason: null }));
      expect(nulled).toEqual(runRaw(partsEvent([{ functionCall: call }], { finishReason: null })));
      expect(nulled.filter((e) => e.type === "tool.start")).toHaveLength(1);
      for (const ev of nulled) expect(() => AgEvent.parse(ev)).not.toThrow();
    });

    it("a partial null-text part never reaches the streamed-text accumulator", () => {
      const partial = (parts: JsonValue[]): JsonValue => ({
        content: { role: "model", parts },
        invocationId: INV,
        partial: true,
      });
      const aggregate = partsEvent([{ text: "Hello" }]);
      const nulled = runRaw(partial([{ text: "Hel" }]), partial([{ text: null }]), aggregate);
      expect(nulled).toEqual(runRaw(partial([{ text: "Hel" }]), partial([{}]), aggregate));
      expect(JSON.stringify(nulled)).not.toContain("null\"");
      expectValidAndFolds(nulled);
    });

    it("codeExecutionResult: null outcome/output take their existing defaults", () => {
      const nulled = runRaw(partsEvent([{ codeExecutionResult: { outcome: null, output: null } }]));
      expect(nulled).toEqual(runRaw(partsEvent([{ codeExecutionResult: {} }])));
      expect(typedBlocks(nulled)).toEqual([{ type: "code-result", outcome: "failed", output: "" }]);
      expectValidAndFolds(nulled);
    });

    it("executableCode: null language maps as absent → python (was `null.toLowerCase()`)", () => {
      const nulled = runRaw(partsEvent([{ executableCode: { code: "print(1)", language: null } }]));
      expect(nulled).toEqual(runRaw(partsEvent([{ executableCode: { code: "print(1)" } }])));
      expect(typedBlocks(nulled)).toEqual([{ type: "code", language: "python", code: "print(1)" }]);
      expectValidAndFolds(nulled);
    });

    it("fileData: null mimeType is left out of the resource-link (it rode as null)", () => {
      const nulled = runRaw(partsEvent([{ fileData: { fileUri: "gs://b/o", mimeType: null } }]));
      expect(nulled).toEqual(runRaw(partsEvent([{ fileData: { fileUri: "gs://b/o" } }])));
      expectValidAndFolds(nulled);
    });

    it("functionResponse: null response maps as absent (was dereferenced for `content`)", () => {
      const call = partsEvent([{ functionCall: { id: "call_1", name: "echo", args: {} } }], {
        finishReason: null,
        turnComplete: null,
      });
      const resp = (response: JsonValue | undefined): JsonValue =>
        partsEvent([
          response === undefined
            ? { functionResponse: { id: "call_1", name: "echo" } }
            : { functionResponse: { id: "call_1", name: "echo", response } },
        ]);
      const nulled = runRaw(call, resp(null));
      expect(nulled).toEqual(runRaw(call, resp(undefined)));
      expect(nulled.filter((e) => e.type === "tool.done")).toHaveLength(1);
      expectValidAndFolds(nulled);
    });

    it("transcription: a null text emits no transcription block (it rode as null)", () => {
      const nulled = runRaw(
        partsEvent([], { inputTranscription: { text: null }, outputTranscription: { text: null } }),
      );
      expect(nulled).toEqual(
        runRaw(partsEvent([], { inputTranscription: {}, outputTranscription: {} })),
      );
      expectValidAndFolds(nulled);
    });
  });

  describe("a null ARM rides provider-raw verbatim (adk-13 precedent), never dereferenced", () => {
    for (const field of ["codeExecutionResult", "functionCall", "functionResponse"]) {
      it(`${field}: null`, () => {
        let out: AgEvent[] = [];
        expect(() => {
          out = runRaw(partsEvent([{ [field]: null }]));
        }).not.toThrow();
        expect(findProviderRawWith(out, field)?.block.raw).toEqual({ [field]: null });
        expect(typedBlocks(out)).toHaveLength(0);
        expect(out.some((e) => e.type.startsWith("tool."))).toBe(false);
        expectValidAndFolds(out);
      });
    }
  });

  describe("negative controls: present values map exactly as before", () => {
    it("string members still map (language, mimeType, outcome/output, text)", () => {
      const out = runRaw(
        partsEvent([
          { text: "hi" },
          { executableCode: { code: "x", language: "PYTHON" } },
          { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" } },
          { fileData: { fileUri: "gs://b/o", mimeType: "text/plain" } },
        ]),
      );
      expect(out.some((e) => e.type === "text.delta")).toBe(true);
      expect(typedBlocks(out)).toEqual([
        { type: "code", language: "python", code: "x" },
        { type: "code-result", outcome: "ok", output: "1" },
        { type: "resource-link", uri: "gs://b/o", mimeType: "text/plain" },
      ]);
      expect(providerRawBlocks(out)).toHaveLength(0);
      expectValidAndFolds(out);
    });
  });
});

describe("createAdkNormalizer — adk 2.1.0 unresolvable-tool `{error}` envelope (adk-10, OPEN FOUNDER DECISION)", () => {
  // OPEN FOUNDER DECISION (adk-10, cohort 0.6.3): should ADK's own tool-failure
  // envelope `{ error: "<message>" }` classify as tool.done outcome "error"?
  // This test PINS THE CURRENT BEHAVIOUR (outcome "ok", the whole response
  // carried losslessly as a `data` block) and is the SINGLE place to flip if
  // the answer is yes. Pre-existing gap: the facet reads only MCP's
  // `isError` flag, so ADK's envelope has classified "ok" since at least 2.0.0
  // (MCPTool rejections, throwing FunctionTools — functions.js 2.0.0:316).
  // 2.1.0 adds a third trigger: an unregistered / hallucinated tool name no
  // longer throws out of runAsync but is answered by `answerUnresolvableCall`
  // (functions.js 2.1.0:251-289) with EXACTLY this envelope, built by
  // `buildResponseEvent` as a user-role functionResponse event.
  it("classifies `Function X is not found in the toolsDict.` as outcome ok and carries it verbatim (current mapping)", () => {
    const callId = "adk-5b0e7c1a-9f7d-4c2e-8a51-3d2f6e0b9c47";
    const envelope = { error: "Function lookup_weather is not found in the toolsDict." };
    const out = run([
      event([{ functionCall: { name: "lookup_weather", args: { city: "Seoul" }, id: callId } }], {
        partial: false,
        finishReason: "STOP",
      }),
      {
        invocationId: "inv_fixture_1",
        author: "spike",
        content: {
          role: "user",
          parts: [{ functionResponse: { name: "lookup_weather", response: envelope, id: callId } }],
        },
      },
    ]);
    const dones = out.filter((e) => e.type === "tool.done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({
      toolCallId: callId,
      // adk-10: flip to "error" here if the founder picks reclassification.
      outcome: "ok",
      content: [{ type: "data", name: "lookup_weather", data: envelope }],
    });
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
  });
});
