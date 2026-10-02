/**
 * Ids a facet mints across two invokes folded into one Reducer (SPEC §8.0, "Ids across invokes"). A turn or message
 * id derived from an invoke's own native ids differs between invokes whose native ids differ; an id derived from a
 * `toolCallId` (`<toolCallId>:result`, `turn_resume_<toolCallId>`) is fold-unique only while the framework keeps
 * `toolCallId`s unique across the thread.
 *
 * Each case folds one native stream as two invokes. The second invoke's native ids are rewritten (every id token gets
 * a suffix), except the tool call ids when a case keeps them: with every id rewritten, the two invokes share no turn
 * or message id; with the tool call ids kept, they share exactly the ids derived from them. A planted control mints
 * every turn and message id from a per-instance counter: the two invokes share ids though no native id repeats.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Reducer, toWire, type AgEvent, type JsonValue } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";
import { createVercelNormalizer } from "@silverprotocol/vercel-ai";

const corpus = (path: string): JsonValue[] => JSON.parse(readFileSync(new URL(`../corpus/${path}`, import.meta.url), "utf8")) as JsonValue[];
const ID_TOKEN = /\b(?:(?:msg|resp|rs|fc|req|toolu|call|item|ws|sess)_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;

/** The natives with every id token suffixed, except the tokens in `keep`. */
function rewriteIds(natives: JsonValue[], keep: ReadonlySet<string>): JsonValue[] {
  return JSON.parse(JSON.stringify(natives).replace(ID_TOKEN, (t) => (keep.has(t) ? t : `${t}B`))) as JsonValue[];
}
type Push = { push(e: never): AgEvent[]; flush(): AgEvent[] };
function run(n: Push, natives: JsonValue[]): AgEvent[] {
  const out: AgEvent[] = [];
  for (const e of natives) out.push(...n.push(e as never));
  out.push(...n.flush());
  return out;
}
/** The turn and message ids an invoke's events mint. */
function minted(events: AgEvent[]): Set<string> {
  const s = new Set<string>();
  for (const e of events) {
    const w = toWire(e) as Record<string, unknown>;
    if (w["type"] === "turn.start" && typeof w["turnId"] === "string") s.add(w["turnId"]);
    if (w["type"] === "message.start" && typeof w["id"] === "string") s.add(w["id"]);
    if (w["type"] === "tool.done" && typeof w["messageId"] === "string") s.add(w["messageId"]);
  }
  return s;
}
const shared = (a: AgEvent[], b: AgEvent[]) => { const sb = minted(b); return [...minted(a)].filter((x) => sb.has(x)).sort(); };
const fold = (a: AgEvent[], b: AgEvent[]) => { const r = new Reducer(); for (const e of [...a, ...b]) r.push(e); return r; };

/** A vercel-ai stream whose step carries a tool result for a call no part of this invoke opened (a prior call). */
const vercelPriorResult = (callId: string): JsonValue[] => [
  { type: "start" },
  { type: "start-step", request: {}, warnings: [] },
  { type: "tool-result", toolCallId: callId, toolName: "lookup", input: { q: "x" }, output: { found: "x" } },
  { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, response: { id: "resp_vercel1", modelId: "m", timestamp: "2026-10-02T00:00:00.000Z" }, providerMetadata: {} },
  { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
];

const CASES: Array<{ name: string; natives: JsonValue[]; callIds: string[]; make: (invokeId: string) => Push }> = [
  { name: "claude-agent-sdk, a tool result (echo-opus55)", natives: corpus("echo-opus55/claude.native.json"), callIds: ["toolu_01MBrN8cZ6uBvsWWG8XJ16Yt"], make: (i) => createClaudeNormalizer({ invokeId: i }) as unknown as Push },
  { name: "openai-agents, a resumed approval's leading result (approval-tool-gpt6sol-resume-approve)", natives: corpus("approval-tool-gpt6sol-resume-approve/openai.native.json"), callIds: ["call_xqZZcXHOAmS73QrOGrXeJfON"], make: (i) => createOpenaiNormalizer({ invokeId: i }) as unknown as Push },
  { name: "vercel-ai, a prior call's result", natives: vercelPriorResult("call_prior1"), callIds: ["call_prior1"], make: (i) => createVercelNormalizer({ invokeId: i }) as unknown as Push },
];

describe("ids a facet mints across two invokes of one fold", () => {
  for (const c of CASES) {
    it(`${c.name}: with every native id differing, the two invokes share no turn or message id and fold without a resync`, () => {
      const a = run(c.make("inv-a"), c.natives), b = run(c.make("inv-b"), rewriteIds(c.natives, new Set()));
      expect(minted(a).size).toBeGreaterThan(0);
      expect(shared(a, b)).toEqual([]);
      expect(fold(a, b).needsResync).toBe(false);
    });
    it(`${c.name}: with only the tool call id repeated, the two invokes share exactly the ids derived from it`, () => {
      const a = run(c.make("inv-a"), c.natives), b = run(c.make("inv-b"), rewriteIds(c.natives, new Set(c.callIds)));
      const s = shared(a, b);
      expect(s.length).toBeGreaterThan(0);
      expect(s.filter((id) => !c.callIds.some((k) => id.includes(k)))).toEqual([]);
      expect(s.some((id) => c.callIds.some((k) => id === `${k}:result`))).toBe(true);
    });
  }
  it("a planted per-instance counter (control): the two invokes share turn and message ids though no native id repeats", () => {
    const c = CASES[0]!;
    const counter = (i: string): Push => {
      const inner = c.make(i); const map = new Map<string, string>(); let k = 0;
      const id = (x: unknown) => (typeof x === "string" ? (map.get(x) ?? (map.set(x, `id-${++k}`), map.get(x)!)) : x);
      const remap = (es: AgEvent[]) => es.map((e) => { const w = { ...(e as Record<string, unknown>) }; for (const key of ["turnId", "messageId"]) if (key in w) w[key] = id(w[key]); if (w["type"] === "message.start" || w["type"] === "message.end") w["id"] = id(w["id"]); return w as unknown as AgEvent; });
      return { push: (e) => remap(inner.push(e)), flush: () => remap(inner.flush()) };
    };
    const a = run(counter("inv-a"), c.natives), b = run(counter("inv-b"), rewriteIds(c.natives, new Set()));
    expect(shared(run(c.make("inv-a"), c.natives), run(c.make("inv-b"), rewriteIds(c.natives, new Set())))).toEqual([]);
    expect(shared(a, b).length).toBeGreaterThan(0);
  });
});
