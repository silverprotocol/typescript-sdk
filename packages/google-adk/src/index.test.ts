import { describe, it, expect } from "vitest";
import { AgEvent, AgReduceResult, JsonValue, Reducer, toJsonValue } from "@silverprotocol/core";
import { createAdkNormalizer, mapFinishReason, type AdkEvent, type AdkPart } from "./index.js";

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
});
