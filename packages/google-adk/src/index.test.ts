import { describe, it, expect } from "vitest";
import { AgEvent, fromJsonata } from "@silverprotocol/core";
import normalize, {
  adkNormalizer,
  mapFinishReason,
  ruleJsonata,
  type AdkEvent,
  type AdkPart,
} from "./index.js";

// ─── fixture builders (the verified ADK Event + Gemini Content/Part shapes) ───
// See index.ts `AdkEvent` for the primary-source citations. Each builder
// constructs one ADK Event (a Gemini Content + the event metadata).

function event(parts: AdkPart[], extra: Partial<AdkEvent> = {}): AdkEvent {
  return { content: { role: "model", parts }, invocationId: "inv_fixture_1", ...extra };
}

// Every produced event MUST round-trip through the AgEvent schema (spec §4).
function assertAllValid(evs: AgEvent[]): void {
  for (const ev of evs) {
    expect(() => AgEvent.parse(ev)).not.toThrow();
  }
}

// Narrow an emitted event to a specific dotted type (a real type guard, so the
// arm's own fields — e.g. tool.start.providerMetadata — are accessible).
function pick<T extends Extract<AgEvent, { type: string }>["type"]>(
  evs: AgEvent[],
  type: T,
): Extract<AgEvent, { type: T }> | undefined {
  return evs.find((e): e is Extract<AgEvent, { type: T }> => e.type === type);
}

describe("adkNormalizer — text part fan-out", () => {
  it("maps a { text } part to the text.start/delta/end lifecycle", async () => {
    const evs = await normalize(event([{ text: "hello world" }]));
    expect(evs.map((e) => e.type)).toEqual(["text.start", "text.delta", "text.end"]);
    const delta = evs.find((e) => e.type === "text.delta");
    expect(delta).toMatchObject({ delta: "hello world" });
    assertAllValid(evs);
  });

  it("allocates a monotonic seq from 0 across the parts[] fan-out", async () => {
    const evs = await normalize(event([{ text: "a" }, { text: "b" }]));
    expect(evs.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(evs.map((e) => e.type)).toEqual([
      "text.start",
      "text.delta",
      "text.end",
      "text.start",
      "text.delta",
      "text.end",
    ]);
    assertAllValid(evs);
  });

  it("preserves a NON-thought text part's thoughtSignature on the text event providerMetadata (§8.8, grounded turn)", async () => {
    // The Google-Search-grounded turn: a visible (non-thought) text part carries a
    // thoughtSignature. Dropping it = a hard 400 on turn N+1. The signature rides
    // the text event's providerMetadata replay channel under `google` (reduce()
    // lands it on the text block's providerMetadata).
    const evs = await normalize(event([{ text: "grounded answer", thoughtSignature: "sig_grounded" }]));
    expect(evs.map((e) => e.type)).toEqual(["text.start", "text.delta", "text.end"]);
    const start = pick(evs, "text.start");
    const end = pick(evs, "text.end");
    // The signature SURVIVES on both the open and the seal events.
    expect(start).toMatchObject({ providerMetadata: { google: { thoughtSignature: "sig_grounded" } } });
    expect(end).toMatchObject({ providerMetadata: { google: { thoughtSignature: "sig_grounded" } } });
    assertAllValid(evs);
  });

  it("omits providerMetadata on a plain (unsigned) text part", async () => {
    const evs = await normalize(event([{ text: "plain" }]));
    const start = pick(evs, "text.start");
    expect(start?.providerMetadata).toBeUndefined();
    assertAllValid(evs);
  });
});

describe("adkNormalizer — reasoning (thought:true) + thoughtSignature (§8.8)", () => {
  it("routes a thought part to reasoning.* (NOT text) and rides the signature on reasoning.opaque", async () => {
    const evs = await normalize(
      event([{ text: "let me think", thought: true, thoughtSignature: "c2lnLXRob3VnaHQ=" }]),
    );
    const types = evs.map((e) => e.type);
    expect(types).toEqual(["reasoning.start", "reasoning.delta", "reasoning.end", "reasoning.opaque"]);
    expect(types).not.toContain("text.start");
    const delta = evs.find((e) => e.type === "reasoning.delta");
    expect(delta).toMatchObject({ delta: "let me think" });
    const opaque = evs.find((e) => e.type === "reasoning.opaque");
    expect(opaque).toMatchObject({ kind: "signature", value: "c2lnLXRob3VnaHQ=", provider: "google" });
    assertAllValid(evs);
  });

  it("omits reasoning.opaque when a thought part carries no signature", async () => {
    const evs = await normalize(event([{ text: "thinking", thought: true }]));
    expect(evs.map((e) => e.type)).toEqual(["reasoning.start", "reasoning.delta", "reasoning.end"]);
    assertAllValid(evs);
  });
});

describe("adkNormalizer — functionCall part (dict args, no string-parse)", () => {
  it("emits tool.start, tool.args.delta and the MANDATORY tool.args.assembled with the dict args", async () => {
    const evs = await normalize(
      event([{ functionCall: { name: "get_weather", args: { city: "SF", units: "c" }, id: "fc_1" } }]),
    );
    expect(evs.map((e) => e.type)).toEqual(["tool.start", "tool.args.delta", "tool.args.assembled"]);
    const start = evs.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ toolCallId: "fc_1", name: "get_weather" });
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    // args is ALREADY an object — passed through verbatim (NOT JSON.parse'd).
    expect(assembled).toMatchObject({ toolCallId: "fc_1", input: { city: "SF", units: "c" } });
    const delta = evs.find((e) => e.type === "tool.args.delta");
    expect(delta).toMatchObject({ delta: '{"city":"SF","units":"c"}' });
    assertAllValid(evs);
  });

  it("rides the tool-call thoughtSignature on tool.args.assembled.signature (§8.8)", async () => {
    const evs = await normalize(
      event([
        {
          functionCall: { name: "search", args: { q: "x" }, id: "fc_sig" },
          thoughtSignature: "c2lnLWNhbGw=",
        },
      ]),
    );
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ signature: "c2lnLWNhbGw=" });
    assertAllValid(evs);
  });

  it("synthesizes a stable toolCallId + records providerCallIndex when functionCall.id is null (§8.2)", async () => {
    const evs = await normalize(
      event([
        { functionCall: { name: "f0", args: { a: 1 } } },
        { functionCall: { name: "f1", args: { b: 2 } } },
      ]),
    );
    const starts = evs.filter((e) => e.type === "tool.start");
    expect(starts).toHaveLength(2);
    // Stable synthesized ids by positional index.
    expect(starts[0]).toMatchObject({
      toolCallId: "adk_call_0",
      name: "f0",
      // providerCallIndex recorded on providerMetadata.google (replay-load-bearing).
      providerMetadata: { google: { providerCallIndex: 0 } },
    });
    expect(starts[1]).toMatchObject({
      toolCallId: "adk_call_1",
      name: "f1",
      providerMetadata: { google: { providerCallIndex: 1 } },
    });
    assertAllValid(evs);
  });

  it("synthesizes the toolCallId + records providerCallIndex when functionCall.id is EXPLICITLY null (§8.2)", async () => {
    // `id` is OFTEN null on the Dev API (declared `string | null`); the explicit
    // null is the realistic wire shape and must hit the synthesized-id branch.
    const evs = await normalize(event([{ functionCall: { name: "f0", args: { a: 1 }, id: null } }]));
    const start = pick(evs, "tool.start");
    expect(start).toMatchObject({
      toolCallId: "adk_call_0",
      name: "f0",
      providerMetadata: { google: { providerCallIndex: 0 } },
    });
    assertAllValid(evs);
  });

  it("synthesizes the functionResponse toolCallId when functionResponse.id is null", async () => {
    const evs = await normalize(
      event([{ functionResponse: { name: "calc", id: null, response: { result: 42 } } }]),
    );
    expect(evs[0]).toMatchObject({ type: "tool.done", toolCallId: "adk_call_0" });
    assertAllValid(evs);
  });

  it("omits providerCallIndex when functionCall.id is present", async () => {
    const evs = await normalize(event([{ functionCall: { name: "f", args: {}, id: "real_id" } }]));
    const start = pick(evs, "tool.start");
    expect(start).toMatchObject({ toolCallId: "real_id" });
    // No providerMetadata is set when the real id is present (id was supplied).
    expect(start?.providerMetadata).toBeUndefined();
    assertAllValid(evs);
  });
});

describe("adkNormalizer — functionResponse part → tool.done (MCP resource shape)", () => {
  it("preserves an MCP { content: [...] } response shape as tool.done content blocks", async () => {
    const evs = await normalize(
      event([
        {
          functionResponse: {
            name: "get_weather",
            id: "fc_1",
            response: { content: [{ type: "text", text: "72F sunny" }] },
          },
        },
      ]),
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "tool.done",
      toolCallId: "fc_1",
      outcome: "ok",
      content: [{ type: "text", text: "72F sunny" }],
    });
    assertAllValid(evs);
  });

  it("maps a plain-object response to a typed data block keyed by the tool name", async () => {
    const evs = await normalize(
      event([{ functionResponse: { name: "calc", id: "fc_2", response: { result: 42 } } }]),
    );
    expect(evs[0]).toMatchObject({
      type: "tool.done",
      toolCallId: "fc_2",
      content: [{ type: "data", name: "calc", data: { result: 42 } }],
    });
    assertAllValid(evs);
  });
});

describe("adkNormalizer — inlineData part → content.block", () => {
  it("routes an image/* inlineData blob to an image block (base64 source)", async () => {
    const evs = await normalize(event([{ inlineData: { mimeType: "image/png", data: "aW1n" } }]));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "content.block",
      block: { type: "image", source: { type: "base64", mediaType: "image/png", data: "aW1n" } },
    });
    assertAllValid(evs);
  });

  it("routes an audio/* inlineData blob to an audio block", async () => {
    const evs = await normalize(event([{ inlineData: { mimeType: "audio/mp3", data: "YXVk" } }]));
    expect(evs[0]).toMatchObject({ type: "content.block", block: { type: "audio" } });
    assertAllValid(evs);
  });
});

describe("adkNormalizer — code parts → content.block", () => {
  it("maps executableCode to a code block (defensive language map)", async () => {
    const evs = await normalize(event([{ executableCode: { language: "PYTHON", code: "print(1)" } }]));
    expect(evs[0]).toMatchObject({ type: "content.block", block: { type: "code", language: "python", code: "print(1)" } });
    assertAllValid(evs);
  });

  it("maps codeExecutionResult to a code-result block (outcome enum map)", async () => {
    const evs = await normalize(
      event([{ codeExecutionResult: { outcome: "OUTCOME_OK", output: "1\n" } }]),
    );
    expect(evs[0]).toMatchObject({ type: "content.block", block: { type: "code-result", outcome: "ok", output: "1\n" } });
    assertAllValid(evs);
  });
});

describe("adkNormalizer — aggregate suppression (§8.3, the #1 double-render)", () => {
  it("drops the partial:false aggregate's already-streamed text (NO double-render)", async () => {
    // The ADK streams partial:true increments, then a FINAL partial:false aggregate
    // that RE-SENDS the full content. The aggregate text must NOT re-render.
    const stream1 = await adkNormalizer(event([{ text: "Hello " }], { partial: true }));
    const stream2 = await adkNormalizer(event([{ text: "Hello world" }], { partial: true }));
    // Both partial increments stream their text.
    expect(stream1.map((e) => e.type)).toEqual(["text.start", "text.delta", "text.end"]);
    expect(stream2.map((e) => e.type)).toEqual(["text.start", "text.delta", "text.end"]);

    // The aggregate restates the full streamed text + carries the turn completion.
    const aggregate = await adkNormalizer(
      event([{ text: "Hello world" }], { partial: false, turnComplete: true }),
    );
    // The restated text is SUPPRESSED; only turn.done (the final-only signal) rides.
    expect(aggregate.map((e) => e.type)).toEqual(["turn.done"]);
    assertAllValid([...stream1, ...stream2, ...aggregate]);
  });

  it("keeps a functionCall that rides ONLY the final aggregate event", async () => {
    // Stream some text, then the aggregate restates the text AND adds the tool call
    // (function calls never stream as partials) — text dropped, call kept.
    await adkNormalizer(event([{ text: "ok" }], { partial: true }));
    const aggregate = await adkNormalizer(
      event(
        [{ text: "ok" }, { functionCall: { name: "act", args: { x: 1 }, id: "fc_agg" } }],
        { partial: false, turnComplete: true },
      ),
    );
    const types = aggregate.map((e) => e.type);
    expect(types).not.toContain("text.start"); // streamed text suppressed
    expect(types).toContain("tool.start"); // final-only call kept
    expect(types).toContain("tool.args.assembled");
    expect(types).toContain("turn.done");
    assertAllValid(aggregate);
  });

  it("emits only the residual tail when the aggregate grows past the stream", async () => {
    await adkNormalizer(event([{ text: "Hello " }], { partial: true, invocationId: "inv_resid" }));
    const aggregate = await adkNormalizer(
      event([{ text: "Hello world!" }], { partial: false, turnComplete: true, invocationId: "inv_resid" }),
    );
    const delta = aggregate.find((e) => e.type === "text.delta");
    // Only the tail beyond the streamed "Hello " prefix is emitted.
    expect(delta).toMatchObject({ delta: "world!" });
    assertAllValid(aggregate);
  });

  it("does NOT suppress a standalone final event that never streamed", async () => {
    // No prior partial for this turn → the final event is the sole carrier; emit fully.
    const evs = await adkNormalizer(
      event([{ text: "single shot" }], { partial: false, turnComplete: true, invocationId: "inv_solo" }),
    );
    expect(evs.map((e) => e.type)).toEqual(["text.start", "text.delta", "text.end", "turn.done"]);
    assertAllValid(evs);
  });
});

describe("adkNormalizer — turn completion → turn.done (§4)", () => {
  it("synthesizes turn.done from turnComplete with success + finishReason stop", async () => {
    const evs = await normalize(event([], { turnComplete: true }));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "turn.done",
      turnId: "turn_inv_fixture_1",
      outcome: { type: "success" },
      finishReason: "stop",
    });
    assertAllValid(evs);
  });

  it("maps a SAFETY finishReason to safety_blocked", async () => {
    const evs = await normalize(event([], { finishReason: "SAFETY" }));
    expect(evs.find((e) => e.type === "turn.done")).toMatchObject({ finishReason: "safety_blocked" });
    assertAllValid(evs);
  });

  it("maps a MAX_TOKENS finishReason to token_limit", async () => {
    const evs = await normalize(event([], { finishReason: "MAX_TOKENS" }));
    expect(evs.find((e) => e.type === "turn.done")).toMatchObject({ finishReason: "token_limit" });
    assertAllValid(evs);
  });

  it("seals turn.done from a bare errorCode (no finishReason, no turnComplete)", async () => {
    // A non-STOP finish that carries ONLY errorCode (a block reason) must still
    // seal the turn — mapFinishReason folds finishReason ?? errorCode.
    const evs = await normalize(event([], { errorCode: "SAFETY" }));
    const done = pick(evs, "turn.done");
    expect(done).toMatchObject({
      type: "turn.done",
      turnId: "turn_inv_fixture_1",
      outcome: { type: "success" },
      finishReason: "safety_blocked",
    });
    assertAllValid(evs);
  });

  it("does NOT synthesize turn.done on a partial:true increment", async () => {
    const evs = await adkNormalizer(
      event([{ text: "x" }], { partial: true, turnComplete: false, invocationId: "inv_np" }),
    );
    expect(evs.map((e) => e.type)).not.toContain("turn.done");
  });
});

describe("mapFinishReason", () => {
  it("maps the Gemini/ADK finishReason superset to AgFinishReason", () => {
    expect(mapFinishReason(undefined)).toBe("stop");
    expect(mapFinishReason("STOP")).toBe("stop");
    expect(mapFinishReason("MAX_TOKENS")).toBe("token_limit");
    expect(mapFinishReason("SAFETY")).toBe("safety_blocked");
    expect(mapFinishReason("RECITATION")).toBe("safety_blocked");
    expect(mapFinishReason("MALFORMED_FUNCTION_CALL")).toBe("malformed_tool_call");
    expect(mapFinishReason("OTHER")).toBe("other");
    expect(mapFinishReason("SOMETHING_NEW")).toBe("unknown");
  });
});

// ─── the portable JSONata rule (structural subset) ───────────────────────────
describe("rule.jsonata — portable structural subset (parts[] $map)", () => {
  it("maps the text-part structural subset the same as the TS normalizer", async () => {
    const run = fromJsonata(ruleJsonata);
    const evs = await run(event([{ text: "hello" }]));
    expect(evs.map((e) => e.type)).toEqual(["text.start", "text.delta", "text.end"]);
    expect(evs.map((e) => e.seq)).toEqual([0, 1, 2]);
    const delta = evs.find((e) => e.type === "text.delta");
    expect(delta).toMatchObject({ delta: "hello" });
    assertAllValid(evs);
  });

  it("maps the functionCall tool.start + tool.args.delta with dict args (assembled stays in TS)", async () => {
    const run = fromJsonata(ruleJsonata);
    const evs = await run(event([{ functionCall: { name: "get_weather", args: { city: "SF" }, id: "fc_j" } }]));
    // JSONata has no JSON parser, so the rule covers ONLY the parse-free structural
    // backbone (tool.start + the stringified-args tool.args.delta). The mandatory
    // parsed tool.args.assembled is authoritative in the TS normalizer.
    expect(evs.map((e) => e.type)).toEqual(["tool.start", "tool.args.delta"]);
    const start = evs.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ toolCallId: "fc_j", name: "get_weather" });
    assertAllValid(evs);
  });

  it("skips thought parts and non-text/non-call parts in the structural subset", async () => {
    const run = fromJsonata(ruleJsonata);
    const evs = await run(
      event([{ text: "thinking", thought: true }, { inlineData: { mimeType: "image/png", data: "x" } }]),
    );
    // Neither a thought part nor an inlineData part is in the structural subset.
    expect(evs).toEqual([]);
  });
});
