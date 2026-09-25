import { describe, it, expect } from "vitest";
import { Reducer } from "./reduce.js";
import { AgEvent } from "./agjson.js";
import { toPersistable } from "./persist.js";
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
