import { describe, it, expect } from "vitest";
import { Reducer } from "./reduce.js";
import { AgEvent } from "./agjson.js";
import { toPersistable, toPersistableWithReport } from "./persist.js";
import * as core from "./index.js";

const fold = (evs: unknown[]) => {
  const r = new Reducer();
  for (const e of evs) r.push(AgEvent.parse(e));
  return r.result();
};
const grounded = [
  { type: "turn.start", seq: 0, turnId: "t1", threadId: "th1" },
  { type: "display.required", seq: 1, turnId: "t1", provider: "google", html: "<p>x</p>" },
  { type: "source", seq: 2, turnId: "t1", sourceId: "s1", source: { url: "https://example.com" } },
  { type: "turn.done", seq: 3, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
];

describe("toPersistable: the fold minus every turn's displayRequired", () => {
  it("omits displayRequired from the turn record, keeps sources and everything else, and does not mutate the fold", () => {
    const f = fold(grounded);
    expect(f.turns[0]!.displayRequired).toEqual([{ provider: "google", html: "<p>x</p>" }]); // precondition
    const before = JSON.stringify(f);
    const p = toPersistable(f);
    expect("displayRequired" in p.turns[0]!).toBe(false);
    expect(p.turns[0]!.sources).toHaveLength(1);
    const { displayRequired: _drop, ...rest } = f.turns[0]!;
    expect(p).toEqual({ ...f, turns: [rest] });
    expect(JSON.stringify(f)).toBe(before); // input untouched, still carries its displayRequired
    expect(f.turns[0]!.displayRequired).toHaveLength(1);
  });

  it("returns a deep copy: mutating the projection never reaches the fold", () => {
    const f = fold(grounded);
    const p = toPersistable(f);
    p.turns[0]!.sources!.push({ sourceId: "zz", source: { url: "https://z" } } as never);
    expect(f.turns[0]!.sources).toHaveLength(1);
  });

  it("a fold with no displayRequired projects to itself", () => {
    const f = fold(grounded.filter((e) => e.type !== "display.required"));
    expect(toPersistable(f)).toEqual(f);
  });

  it("is exported from the core entry point", () => {
    expect(core.toPersistable).toBe(toPersistable);
  });
});

describe("toPersistable memory scopes (draft.6): scope thread and the declared scopes are kept, the rest omitted and reported", () => {
  const mem = (seq: number, scope: string, key: string) => ({ type: "memory.write", seq, turnId: "t1", scope, key, value: { v: key } });
  const withMemory = [
    { type: "turn.start", seq: 0, turnId: "t1", threadId: "th1" },
    mem(1, "agent", "a"),
    mem(2, "user", "u"),
    mem(3, "skill", "s"),
    mem(4, "thread", "t"),
    { type: "turn.done", seq: 5, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
  ];
  const scopes = (r: ReturnType<typeof fold>) => r.memory.map((m) => `${m.scope}:${m.key}`);

  it("with no declaration, only the thread record is kept and the other three are reported in the fold's order", () => {
    const f = fold(withMemory);
    expect(scopes(f)).toEqual(["agent:a", "user:u", "skill:s", "thread:t"]); // precondition
    for (const report of [toPersistableWithReport(f), toPersistableWithReport(f, {}), toPersistableWithReport(f, { memoryScopes: [] })]) {
      expect(scopes(report.result)).toEqual(["thread:t"]);
      expect(report.omitted).toEqual([{ scope: "agent", key: "a" }, { scope: "user", key: "u" }, { scope: "skill", key: "s" }]);
    }
    expect(toPersistable(f)).toEqual(toPersistableWithReport(f).result);
  });

  it("a declared scope is kept in the fold's order with the thread record; the undeclared ones are reported", () => {
    const f = fold(withMemory);
    const r = toPersistableWithReport(f, { memoryScopes: ["user"] });
    expect(scopes(r.result)).toEqual(["user:u", "thread:t"]);
    expect(r.omitted).toEqual([{ scope: "agent", key: "a" }, { scope: "skill", key: "s" }]);
    const all = toPersistableWithReport(f, { memoryScopes: ["agent", "user", "skill"] });
    expect(all.result.memory).toEqual(f.memory);
    expect(all.omitted).toEqual([]);
  });

  it("no call mutates the fold, and a keyless record is reported without a key", () => {
    const f = fold([...withMemory.slice(0, 1), { type: "memory.write", seq: 1, turnId: "t1", scope: "agent", value: 1 }, withMemory[5]!]);
    const before = JSON.stringify(f);
    expect(toPersistableWithReport(f).omitted).toEqual([{ scope: "agent" }]);
    toPersistable(f, { memoryScopes: ["agent"] });
    expect(JSON.stringify(f)).toBe(before);
  });
});
