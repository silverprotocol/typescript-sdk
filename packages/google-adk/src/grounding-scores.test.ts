/**
 * A grounding support's confidenceScores list that holds anything but finite
 * numbers (genai types it number[]) has no AgCitation home: the citation omits
 * the member, the support's other members map as before, and the list rides
 * verbatim in the event-level provider-raw carry at its native path, one entry
 * per support. A list of numbers, or an absent one, maps as before.
 */
import { describe, expect, it } from "vitest";
import { AgEvent, JsonValue, Reducer, toJsonValue } from "@silverprotocol/core";
import { createAdkNormalizer } from "./index.js";

type Obj = { [k: string]: JsonValue };

function run(natives: Obj[]): AgEvent[] {
  const n = createAdkNormalizer({ invokeId: "adk" });
  return [...natives.flatMap((e) => n.push(toJsonValue(e))), ...n.flush()];
}
function citations(out: AgEvent[]): unknown[] {
  return out.flatMap((e) => {
    const list: unknown = e.type === "text.end" ? Reflect.get(e, "citations") : undefined;
    return Array.isArray(list) ? list : [];
  });
}
function carried(out: AgEvent[]): unknown[] {
  return out.flatMap((e) => {
    const block: unknown = e.type === "content.block" ? Reflect.get(e, "block") : undefined;
    const raw: unknown = typeof block === "object" && block !== null && Reflect.get(block, "type") === "provider-raw" ? Reflect.get(block, "raw") : undefined;
    const grounding: unknown = typeof raw === "object" && raw !== null ? Reflect.get(raw, "groundingMetadata") : undefined;
    return grounding === undefined ? [] : [grounding];
  });
}
const grounded = (i: number, scores: Array<JsonValue | undefined>): Obj => ({
  invocationId: `inv-ground-${i}`,
  author: "search",
  content: { role: "model", parts: [{ text: `Paris is the capital ${i}. It is large.` }] },
  finishReason: "STOP",
  groundingMetadata: {
    groundingChunks: [{ web: { uri: `https://example.com/a${i}`, title: "a" } }, { web: { uri: `https://example.com/b${i}`, title: "b" } }],
    groundingSupports: scores.map((s, k) => ({
      segment: { startIndex: k * 10, endIndex: k * 10 + 9, text: `segment ${k}` },
      groundingChunkIndices: [0, 1],
      ...(s !== undefined ? { confidenceScores: s } : {}),
    })),
  },
});

describe("createAdkNormalizer — a grounding support's confidence scores that are not all numbers", () => {
  const malformed: JsonValue[] = [[0.9, "high"], "0.9", [0.9, null], { a: 1 }];

  it("the citation omits confidenceScores, keeps its offsets, sourceIds and cited text, every event is a valid AgEvent, and the fold is clean", () => {
    for (const [i, bad] of malformed.entries()) {
      const out = run([grounded(i, [bad, [0.7, 0.4]])]);
      for (const e of out) expect(() => AgEvent.parse(e), `#${i}`).not.toThrow();
      const [first, second] = citations(out);
      expect(first, `#${i}`).toEqual({ kind: "offset", unit: "byte", startIndex: 0, endIndex: 9, bounds: "[start,end)", sourceIds: ["grounding_0", "grounding_1"], citedText: "segment 0", indexFrame: "response" });
      expect(second, `#${i}`).toMatchObject({ sourceIds: ["grounding_0", "grounding_1"], confidenceScores: [0.7, 0.4] });
      const r = new Reducer();
      for (const e of out) r.push(e);
      expect(r.needsResync, `#${i}`).toBe(false);
    }
  });

  it("the list rides verbatim in the event-level provider-raw carry, one entry per support in order, empty for a support whose list mapped", () => {
    for (const [i, bad] of malformed.entries()) {
      expect(carried(run([grounded(i, [[0.7, 0.4], bad, undefined])])), `#${i}`).toEqual([{ groundingSupports: [{}, { confidenceScores: bad }, {}] }]);
    }
  });

  it("lists of numbers, an empty list and an absent list map as before, and nothing is carried", () => {
    for (const i of [0, 1]) {
      const out = run([grounded(i, [[0.9, 0.1], [], undefined])]);
      expect(citations(out).map((c) => Reflect.get(Object(c), "confidenceScores")), `#${i}`).toEqual([[0.9, 0.1], [], []]);
      expect(carried(out), `#${i}`).toEqual([]);
    }
  });
});
