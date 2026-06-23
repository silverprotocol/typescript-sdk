import { describe, it, expect } from "vitest";
import { reduce, Reducer } from "./reduce.js";
import { AgReduceResult } from "./agjson.js";

describe("reduce — scaffold", () => {
  it("reduce([]) returns the empty container (4 arrays, no state key)", () => {
    const r = reduce([]);
    expect(r).toEqual({ messages: [], artifacts: [], memory: [], turns: [] });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
  it("Reducer fed nothing matches reduce([]) and needsResync is false", () => {
    const acc = new Reducer();
    expect(acc.result()).toEqual(reduce([]));
    expect(acc.needsResync).toBe(false);
  });
  // ALIASING REGRESSION (must-fix #7): a held snapshot must not see later pushes.
  // (full assertion lands once R2 implements text; here, assert result() arrays are
  //  fresh objects — result() twice yields deep-equal-but-not-identical arrays.)
  it("result() returns fresh (non-aliased) arrays each call", () => {
    const acc = new Reducer();
    expect(acc.result().messages).not.toBe(acc.result().messages);
  });
});
