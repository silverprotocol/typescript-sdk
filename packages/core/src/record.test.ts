import { describe, expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { readStoredAgMessage, readStoredAgMessages, readStoredAgMemoryRecords, type AgRecordReport } from "./record.js";
import type { JsonValue } from "./agjson.js";

/** Splice each report's raw back at its index (the reconstruction MUST, SPEC §0.2). */
function reconstructContent(view: { content: JsonValue[] }, reports: AgRecordReport[]): JsonValue[] {
  const content = [...view.content];
  for (const r of reports) content.splice(r.path[1] as number, 0, r.raw);
  return content;
}
function reconstructArray(view: JsonValue[], reports: AgRecordReport[]): JsonValue[] {
  const out = [...view];
  for (const r of reports) out.splice(r.path[0] as number, 0, r.raw);
  return out;
}
/** Every object reachable from `v` has Object.prototype as its prototype. */
function plainPrototypes(v: unknown): boolean {
  if (Array.isArray(v)) return v.every(plainPrototypes);
  if (v === null || typeof v !== "object") return true;
  return Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every(plainPrototypes);
}

describe("readStoredAgMessage — draft.4 §0.2, workspace#20 decision 6 (§10 item N, record leg)", () => {
  const T1 = { type: "text", text: "a", zzKey: "k" };
  const U = { type: "zz" };
  const TR = { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "r" }, { type: "zz" }] };
  const T2 = { type: "text", text: "b" };
  const FIXTURE = { id: "m", role: "assistant", zzTop: 1, usage: { inputTokens: 10, outputTokens: 5, zzCounter: 3 }, content: [T1, U, TR, T2] };

  it("(1)(2) omits the unreadable elements whole, keeps order and unknown fields at every depth, reports each with index, type and verbatim value", () => {
    const r = readStoredAgMessage(structuredClone(FIXTURE));
    expect(isDeepStrictEqual(r.value?.content, [T1, T2])).toBe(true);
    const v = r.value as unknown as typeof FIXTURE;
    expect(v.zzTop).toBe(1);
    expect(v.usage.zzCounter).toBe(3);
    expect((v.content[0] as typeof T1).zzKey).toBe("k");
    expect(r.reports).toEqual([
      { path: ["content", 1], ignoredType: "zz", raw: U },
      { path: ["content", 2], ignoredType: "tool-result", raw: TR },
    ]);
    expect(r.reports).toHaveLength(2);
  });

  it("(3) splicing each report back at its index reproduces the stored record", () => {
    const r = readStoredAgMessage(structuredClone(FIXTURE));
    const rebuilt = { ...(r.value as unknown as typeof FIXTURE), content: reconstructContent(r.value as unknown as { content: JsonValue[] }, r.reports) };
    expect(isDeepStrictEqual(rebuilt, FIXTURE)).toBe(true);
  });

  it("(4) never mutates its input, and the view shares no object with it", () => {
    const input = structuredClone(FIXTURE);
    const before = structuredClone(input);
    const r = readStoredAgMessage(input);
    expect(isDeepStrictEqual(input, before)).toBe(true);
    (r.value!.content[0] as { text: string }).text = "mutated";
    (r.reports[0]!.raw as { type: string }).type = "mutated";
    expect(isDeepStrictEqual(input, before)).toBe(true);
  });

  it("(6) a value that is not a materializable message has no value and exactly one report carrying it verbatim", () => {
    for (const bad of [{ kind: "text", text: "x" }, { id: "m", role: "zz", content: [] }, { id: 1, role: "user", content: [] }, { id: "m", role: "user" }, { id: "m", role: "user", content: [], turnId: 7 }, null, "text", [1]]) {
      const r = readStoredAgMessage(structuredClone(bad));
      expect(r.value, JSON.stringify(bad)).toBeUndefined();
      expect(r.reports).toHaveLength(1);
      expect(r.reports[0]!.path).toEqual([]);
      expect(isDeepStrictEqual(r.reports[0]!.raw, bad)).toBe(true);
    }
  });

  it("an unreadable element does not make the record unreadable, but an invalid defined field does (whole record, one report)", () => {
    const r = readStoredAgMessage({ id: "m", role: "user", content: [{ type: "zz" }], candidateIndex: "one" });
    expect(r.value).toBeUndefined();
    expect(r.reports).toEqual([{ path: [], raw: { id: "m", role: "user", content: [{ type: "zz" }], candidateIndex: "one" } }]);
  });

  it("an undefined closed-set value INSIDE a known block omits that element whole (never coerced, never altered)", () => {
    const CR = { type: "code-result", outcome: "zz", output: "" };
    const r = readStoredAgMessage({ id: "m", role: "assistant", content: [T1, CR] });
    expect(r.value?.content).toEqual([T1]);
    expect(r.reports).toEqual([{ path: ["content", 1], ignoredType: "code-result", raw: CR }]);
  });

  it("an element with no string type is reported without ignoredType", () => {
    const r = readStoredAgMessage({ id: "m", role: "user", content: [7, { type: 9 }] });
    expect(r.value?.content).toEqual([]);
    expect(r.reports).toEqual([{ path: ["content", 0], raw: 7 }, { path: ["content", 1], raw: { type: 9 } }]);
  });

  it("(7) an own __proto__ key at any depth yields only objects whose prototype is Object.prototype", () => {
    const raw = JSON.parse('{"id":"m","role":"user","__proto__":{"polluted":true},"content":[{"type":"text","text":"a","__proto__":{"x":1}},{"type":"zz","__proto__":{"y":2}}]}') as JsonValue;
    const r = readStoredAgMessage(raw);
    expect(r.value).toBeDefined();
    expect(plainPrototypes(r.value)).toBe(true);
    expect(plainPrototypes(r.reports)).toBe(true);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.hasOwn(r.value!, "__proto__")).toBe(false);
  });

  it("a readable record reads back unchanged with zero reports", () => {
    const ok = { id: "m", role: "assistant", content: [T1, T2], turnId: "t", zz: { deep: [1, { k: "v" }] } };
    const r = readStoredAgMessage(structuredClone(ok));
    expect(isDeepStrictEqual(r.value, ok)).toBe(true);
    expect(r.reports).toEqual([]);
  });
});

describe("readStoredAgMessages / readStoredAgMemoryRecords — arrays of stored records", () => {
  it("messages: an unreadable message is omitted at [i]; element reports are prefixed with the message index", () => {
    const M0 = { id: "a", role: "user", content: [{ type: "text", text: "x" }] };
    const M1 = { id: "b", role: "zz", content: [] };
    const M2 = { id: "c", role: "assistant", content: [{ type: "zz" }, { type: "text", text: "y" }] };
    const r = readStoredAgMessages([M0, M1, M2]);
    expect(r.value.map((m) => m.id)).toEqual(["a", "c"]);
    expect(r.value[1]!.content).toEqual([{ type: "text", text: "y" }]);
    expect(r.reports).toEqual([
      { path: [1], raw: M1 },
      { path: [2, "content", 0], ignoredType: "zz", raw: { type: "zz" } },
    ]);
  });

  it("(5) memory: [R1, R2 with scope 'zz', R3] reads as [R1, R3] with unknown fields intact and one report at [1]; reconstruction holds", () => {
    const R1 = { scope: "thread", key: "k1", value: { a: 1 }, zz: "keep" };
    const R2 = { scope: "zz", key: "k2", value: 2 };
    const R3 = { scope: "user", value: null, reason: "r", zzNested: { q: [1] } };
    const input = [R1, R2, R3];
    const before = structuredClone(input);
    const r = readStoredAgMemoryRecords(input);
    expect(isDeepStrictEqual(r.value, [R1, R3])).toBe(true);
    expect(r.reports).toEqual([{ path: [1], raw: R2 }]);
    expect(isDeepStrictEqual(reconstructArray(r.value as unknown as JsonValue[], r.reports), before)).toBe(true);
    expect(isDeepStrictEqual(input, before)).toBe(true);
  });

  it("memory: a record missing its required value, or not an object, is omitted and reported", () => {
    const r = readStoredAgMemoryRecords([{ scope: "agent" }, "x", { scope: "skill", value: 0 }]);
    expect(r.value).toEqual([{ scope: "skill", value: 0 }]);
    expect(r.reports.map((x) => x.path)).toEqual([[0], [1]]);
  });

  it("a non-array argument is one report at [] and an empty value", () => {
    expect(readStoredAgMessages({ id: "m" } as never)).toEqual({ value: [], reports: [{ path: [], raw: { id: "m" } }] });
    expect(readStoredAgMemoryRecords("x" as never)).toEqual({ value: [], reports: [{ path: [], raw: "x" }] });
  });
});
