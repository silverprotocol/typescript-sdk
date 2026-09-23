/**
 * The README's usage, offline: push each Event object ADK yields straight into
 * the normalizer (no JSON round trip), as a host iterating `runAsync()` does.
 *
 * Runs the REAL `@google/adk` LlmAgent and InMemoryRunner with a stub
 * `BaseLlm` and an in-process FunctionTool whose result and state writes hold
 * `undefined` members and a Date, the values a live object can carry and a
 * recorded cassette never does. Pins that `push()` never throws on them and
 * that the live object normalizes exactly like its JSON copy.
 */
import { describe, expect, it } from "vitest";
import { BaseLlm, FunctionTool, InMemoryRunner, LlmAgent, type LlmRequest, type LlmResponse } from "@google/adk";
import { FinishReason } from "@google/genai";
import { z } from "zod";
import { toJsonValue, type AgEvent, type JsonValue } from "@silverprotocol/core";
import { createAdkNormalizer } from "@silverprotocol/google-adk";

/** First call: the tool. Once it has answered: final text. */
class OneToolLlm extends BaseLlm {
  constructor() {
    super({ model: "stub-model" });
  }
  async *generateContentAsync(req: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const answered = req.contents.some((c) => (c.parts ?? []).some((p) => p.functionResponse));
    yield answered
      ? { content: { role: "model", parts: [{ text: "Saved." }] }, turnComplete: true, finishReason: FinishReason.STOP }
      : { content: { role: "model", parts: [{ functionCall: { name: "save", args: { note: "n" } } }] }, turnComplete: true };
  }
  async connect(): Promise<never> {
    throw new Error("OneToolLlm: no live connection");
  }
}

const save = new FunctionTool({
  name: "save",
  description: "Save a note.",
  parameters: z.object({ note: z.string() }),
  execute: ({ note }, ctx) => {
    ctx?.state.set("draft", { note, savedAt: new Date(0), revision: undefined });
    return { saved: true, id: undefined, at: new Date(0) };
  },
});

async function liveEvents(): Promise<unknown[]> {
  const runner = new InMemoryRunner({ agent: new LlmAgent({ name: "spike", model: new OneToolLlm(), tools: [save] }) });
  const session = await runner.sessionService.createSession({ appName: runner.appName, userId: "user-1" });
  const events: unknown[] = [];
  for await (const e of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: "Save a note." }] },
    runConfig: { maxLlmCalls: 4 },
  })) {
    events.push(e);
  }
  return events;
}

/** Whether `v` holds, at any depth, an own member value `pred` accepts. */
function holds(v: unknown, pred: (x: unknown) => boolean, seen = new Set<object>()): boolean {
  if (v === null || typeof v !== "object" || seen.has(v)) return false;
  seen.add(v);
  for (const k of Object.keys(v)) {
    const x: unknown = Reflect.get(v, k);
    if (pred(x) || holds(x, pred, seen)) return true;
  }
  return false;
}

function normalize(natives: JsonValue[]): AgEvent[] {
  const n = createAdkNormalizer();
  const out: AgEvent[] = [];
  for (const native of natives) out.push(...n.push(native));
  out.push(...n.flush());
  return out;
}

describe("google-adk facet: live ADK Event objects pushed directly (the README's usage)", () => {
  it("never throws on a live object holding undefined members and a Date, and normalizes exactly like its JSON copy", async () => {
    const live = await liveEvents();
    // The live stream really carries what a cassette cannot: an own member
    // whose value is undefined, and a Date.
    expect(live.some((e) => holds(e, (x) => x === undefined))).toBe(true);
    expect(live.some((e) => holds(e, (x) => x instanceof Date))).toBe(true);
    let direct: AgEvent[] = [];
    expect(() => {
      direct = normalize(live as JsonValue[]);
    }).not.toThrow();
    const viaJson = normalize(live.map((e) => toJsonValue(e)));
    expect(JSON.stringify(direct)).toBe(JSON.stringify(viaJson));
    const patches = direct.filter((e) => e.type === "state.delta").map((e) => (e as { patch: JsonValue }).patch);
    expect(patches).toContainEqual({ draft: { note: "n", savedAt: "1970-01-01T00:00:00.000Z" } });
    expect(direct.some((e) => e.type === "ext.google.unparsed")).toBe(false);
  });
});
