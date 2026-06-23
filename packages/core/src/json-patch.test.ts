import { describe, it, expect } from "vitest";
import { applyPatch } from "./json-patch.js";
import type { JsonValue } from "./agjson.js";

// ─────────────────────────────────────────────────────────────────────────────
// R6 — RFC-6902 JSON-Patch applier conformance tests
// ─────────────────────────────────────────────────────────────────────────────

describe("applyPatch — add", () => {
  it("(a) add a new key to an object", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "add", path: "/b", value: 2 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1, b: 2 });
  });

  it("(b) add replaces an existing key", () => {
    const doc: JsonValue = { a: 1, b: 0 };
    const result = applyPatch(doc, [{ op: "add", path: "/b", value: 99 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1, b: 99 });
  });

  it("(c) add inserts into array at index (shifts existing elements)", () => {
    const doc: JsonValue = [1, 2, 3];
    const result = applyPatch(doc, [{ op: "add", path: "/1", value: 99 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([1, 99, 2, 3]);
  });

  it("(d) add with '-' appends to array", () => {
    const doc: JsonValue = [1, 2];
    const result = applyPatch(doc, [{ op: "add", path: "/-", value: 3 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([1, 2, 3]);
  });

  it("(e) add at nested path", () => {
    const doc: JsonValue = { x: { y: 1 } };
    const result = applyPatch(doc, [{ op: "add", path: "/x/z", value: "new" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ x: { y: 1, z: "new" } });
  });

  it("(f) add at array path within nested object", () => {
    const doc: JsonValue = { items: ["a", "b"] };
    const result = applyPatch(doc, [{ op: "add", path: "/items/-", value: "c" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ items: ["a", "b", "c"] });
  });
});

describe("applyPatch — remove", () => {
  it("(a) remove an existing object key", () => {
    const doc: JsonValue = { a: 1, b: 2 };
    const result = applyPatch(doc, [{ op: "remove", path: "/a" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ b: 2 });
  });

  it("(b) remove an array element (shifts remaining)", () => {
    const doc: JsonValue = [1, 2, 3];
    const result = applyPatch(doc, [{ op: "remove", path: "/1" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([1, 3]);
  });

  it("(c) remove nested path", () => {
    const doc: JsonValue = { a: { b: { c: 42 } } };
    const result = applyPatch(doc, [{ op: "remove", path: "/a/b/c" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: { b: {} } });
  });

  it("(d) remove absent key → ok:false (not throw)", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "remove", path: "/z" }]);
    expect(result.ok).toBe(false);
  });

  it("(e) remove absent nested path → ok:false", () => {
    const doc: JsonValue = { a: { b: 1 } };
    const result = applyPatch(doc, [{ op: "remove", path: "/a/z" }]);
    expect(result.ok).toBe(false);
  });
});

describe("applyPatch — replace", () => {
  it("(a) replace an existing key", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "replace", path: "/a", value: 99 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 99 });
  });

  it("(b) replace an array element", () => {
    const doc: JsonValue = [1, 2, 3];
    const result = applyPatch(doc, [{ op: "replace", path: "/0", value: 42 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([42, 2, 3]);
  });

  it("(c) replace absent key → ok:false (not throw)", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "replace", path: "/z", value: 2 }]);
    expect(result.ok).toBe(false);
  });

  it("(d) replace nested path", () => {
    const doc: JsonValue = { a: { b: 1 } };
    const result = applyPatch(doc, [{ op: "replace", path: "/a/b", value: 99 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: { b: 99 } });
  });

  it("(e) root replace (empty pointer)", () => {
    const doc: JsonValue = { old: true };
    const result = applyPatch(doc, [{ op: "replace", path: "", value: { brand: "new" } }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ brand: "new" });
  });
});

describe("applyPatch — RFC-6901 pointer escaping", () => {
  it("(a) key containing '/' (escaped as ~1)", () => {
    const doc: JsonValue = { "a/b": 1 };
    const result = applyPatch(doc, [{ op: "replace", path: "/a~1b", value: 99 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ "a/b": 99 });
  });

  it("(b) key containing '~' (escaped as ~0)", () => {
    const doc: JsonValue = { "m~n": 1 };
    const result = applyPatch(doc, [{ op: "replace", path: "/m~0n", value: 99 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ "m~n": 99 });
  });

  it("(c) ~01 escapes to literal ~/ (tilde then slash) — ~0 then ~1, not ~1 then ~0 confusion", () => {
    // The key is "~/" — RFC-6901 encodes this as "~01" (first ~0→~ gives "~/",
    // the remaining "1" is part of the token — wait, that's not right).
    // Correct: to encode "~/", write "~0~1" (tilde escaped first, then slash).
    const doc: JsonValue = { "~/": 42 };
    const result = applyPatch(doc, [{ op: "replace", path: "/~0~1", value: 99 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ "~/": 99 });
  });

  it("(d) add to a key with special characters (both ~ and /)", () => {
    const doc: JsonValue = {};
    const result = applyPatch(doc, [{ op: "add", path: "/a~1b~0c", value: true }]);
    // Decoded: "a/b~c"
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ "a/b~c": true });
  });
});

describe("applyPatch — move", () => {
  it("(a) move a key within an object", () => {
    const doc: JsonValue = { a: 1, b: 2 };
    const result = applyPatch(doc, [{ op: "move", from: "/a", path: "/c" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ b: 2, c: 1 });
  });

  it("(b) move an element from one array index to another", () => {
    const doc: JsonValue = [1, 2, 3];
    const result = applyPatch(doc, [{ op: "move", from: "/0", path: "/2" }]);
    expect(result.ok).toBe(true);
    // Remove index 0 → [2,3]; then add at index 2 → [2,3,1]
    if (result.ok) expect(result.value).toEqual([2, 3, 1]);
  });

  it("(c) move with absent 'from' → ok:false", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "move", from: "/z", path: "/b" }]);
    expect(result.ok).toBe(false);
  });

  it("(d) move into own descendant is illegal → ok:false", () => {
    const doc: JsonValue = { a: { b: 1 } };
    // Moving /a into /a/c — /a is a prefix of /a/c
    const result = applyPatch(doc, [{ op: "move", from: "/a", path: "/a/c" }]);
    expect(result.ok).toBe(false);
  });

  it("(e) move missing 'from' field → ok:false", () => {
    const doc: JsonValue = { a: 1 };
    // op has no 'from' field
    const result = applyPatch(doc, [{ op: "move", path: "/b" }]);
    expect(result.ok).toBe(false);
  });
});

describe("applyPatch — copy", () => {
  it("(a) copy an object key to a new key", () => {
    const doc: JsonValue = { a: { x: 1 } };
    const result = applyPatch(doc, [{ op: "copy", from: "/a", path: "/b" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it("(b) copy is deep (mutating the source after should not affect the copy)", () => {
    const inner: JsonValue = { x: 1 };
    const doc: JsonValue = { a: inner };
    const result = applyPatch(doc, [{ op: "copy", from: "/a", path: "/b" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Apply another patch that mutates /a — /b should be unaffected.
      const result2 = applyPatch(result.value, [{ op: "replace", path: "/a/x", value: 99 }]);
      expect(result2.ok).toBe(true);
      if (result2.ok) {
        expect((result2.value as { [k: string]: JsonValue })["b"]).toEqual({ x: 1 });
      }
    }
  });

  it("(c) copy with absent 'from' path → ok:false", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "copy", from: "/z", path: "/b" }]);
    expect(result.ok).toBe(false);
  });
});

describe("applyPatch — test", () => {
  it("(a) test passes when value matches → ok:true (doc unchanged)", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "test", path: "/a", value: 1 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1 });
  });

  it("(b) test fails when value does not match → ok:false", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "test", path: "/a", value: 2 }]);
    expect(result.ok).toBe(false);
  });

  it("(c) test fails for absent path → ok:false", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "test", path: "/z", value: 1 }]);
    expect(result.ok).toBe(false);
  });

  it("(d) test with deep object equality", () => {
    const doc: JsonValue = { a: { b: [1, 2, 3] } };
    const result = applyPatch(doc, [{ op: "test", path: "/a", value: { b: [1, 2, 3] } }]);
    expect(result.ok).toBe(true);
  });

  it("(e) test deep equality fails with different array content", () => {
    const doc: JsonValue = { a: [1, 2, 3] };
    const result = applyPatch(doc, [{ op: "test", path: "/a", value: [1, 2, 4] }]);
    expect(result.ok).toBe(false);
  });
});

describe("applyPatch — root pointer (empty string)", () => {
  it("(a) add at root replaces the whole document", () => {
    const doc: JsonValue = { old: true };
    const result = applyPatch(doc, [{ op: "add", path: "", value: 42 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it("(b) test at root checks the whole document", () => {
    const doc: JsonValue = [1, 2];
    const result = applyPatch(doc, [{ op: "test", path: "", value: [1, 2] }]);
    expect(result.ok).toBe(true);
  });
});

describe("applyPatch — malformed inputs → ok:false (NEVER throws)", () => {
  it("(a) non-array patch → ok:false", () => {
    const doc: JsonValue = {};
    const result = applyPatch(doc, { op: "add", path: "/a", value: 1 });
    expect(result.ok).toBe(false);
  });

  it("(b) patch element that is not an object → ok:false", () => {
    const doc: JsonValue = {};
    const result = applyPatch(doc, ["not an op object"]);
    expect(result.ok).toBe(false);
  });

  it("(c) op missing 'op' field → ok:false", () => {
    const doc: JsonValue = {};
    const result = applyPatch(doc, [{ path: "/a", value: 1 }]);
    expect(result.ok).toBe(false);
  });

  it("(d) op missing 'path' field → ok:false", () => {
    const doc: JsonValue = {};
    const result = applyPatch(doc, [{ op: "add", value: 1 }]);
    expect(result.ok).toBe(false);
  });

  it("(e) 'add' missing 'value' field → ok:false", () => {
    const doc: JsonValue = {};
    const result = applyPatch(doc, [{ op: "add", path: "/a" }]);
    expect(result.ok).toBe(false);
  });

  it("(f) 'replace' missing 'value' field → ok:false", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "replace", path: "/a" }]);
    expect(result.ok).toBe(false);
  });

  it("(g) 'test' missing 'value' field → ok:false", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "test", path: "/a" }]);
    expect(result.ok).toBe(false);
  });

  it("(h) unknown op → ok:false", () => {
    const doc: JsonValue = {};
    const result = applyPatch(doc, [{ op: "unknown-op", path: "/a", value: 1 }]);
    expect(result.ok).toBe(false);
  });

  it("(i) pointer not starting with '/' (non-root) → ok:false", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "remove", path: "a" }]);
    expect(result.ok).toBe(false);
  });

  it("(j) patch is null → ok:false", () => {
    const doc: JsonValue = {};
    const result = applyPatch(doc, null);
    expect(result.ok).toBe(false);
  });

  it("(k) patch is a number → ok:false", () => {
    const doc: JsonValue = {};
    const result = applyPatch(doc, 42);
    expect(result.ok).toBe(false);
  });
});

describe("applyPatch — atomicity (partial failure = no result)", () => {
  it("(a) if 2nd of 3 ops fails, whole patch returns ok:false and doc is NOT mutated", () => {
    const doc: JsonValue = { a: 1 };
    const original = structuredClone(doc);

    // Op 1: valid add
    // Op 2: replace absent key → FAIL
    // Op 3: valid add (should never run)
    const result = applyPatch(doc, [
      { op: "add", path: "/b", value: 2 },
      { op: "replace", path: "/z", value: 99 }, // /z doesn't exist → FAIL
      { op: "add", path: "/c", value: 3 },
    ]);

    // Overall result must be failure.
    expect(result.ok).toBe(false);
    // The original `doc` must be unchanged.
    expect(doc).toEqual(original);
  });

  it("(b) successful 3-op patch does not mutate the original doc", () => {
    const doc: JsonValue = { a: 1 };

    const result = applyPatch(doc, [
      { op: "add", path: "/b", value: 2 },
      { op: "add", path: "/c", value: 3 },
      { op: "remove", path: "/a" },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ b: 2, c: 3 });
    }
    // doc is still unmodified.
    expect(doc).toEqual({ a: 1 });
  });

  it("(c) test op failing mid-patch causes full rollback → ok:false, doc unchanged", () => {
    const doc: JsonValue = { a: 1, b: 2 };
    const original = structuredClone(doc);

    const result = applyPatch(doc, [
      { op: "replace", path: "/a", value: 99 }, // succeeds
      { op: "test", path: "/b", value: 999 },   // fails — b is 2, not 999
      { op: "replace", path: "/b", value: 0 },  // never runs
    ]);

    expect(result.ok).toBe(false);
    expect(doc).toEqual(original);
  });
});

describe("applyPatch — multi-op success path", () => {
  it("applies all ops in order and returns the final document", () => {
    const doc: JsonValue = { a: 1, b: 2, c: [10, 20] };

    const result = applyPatch(doc, [
      { op: "replace", path: "/a", value: 100 },
      { op: "remove", path: "/b" },
      { op: "add", path: "/c/-", value: 30 },
      { op: "test", path: "/c/0", value: 10 },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: 100, c: [10, 20, 30] });
    }
  });
});

describe("applyPatch — empty patch", () => {
  it("empty patch array → ok:true, value equals original doc", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1 });
  });
});

// ── Fix 2: null-at-root regression tests (R6 bug fix) ────────────────────────
// These guard against the silent data-corruption bug where `null` was used as
// BOTH a valid JsonValue and the internal failure sentinel: a valid patch that
// sets the root document to JSON null wrongly returned { ok:false }.

describe("applyPatch — null value at root (regression R6)", () => {
  it("(a) add null at root → ok:true, value is null", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "add", path: "", value: null }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it("(b) replace with null at root → ok:true, value is null", () => {
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "replace", path: "", value: null }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it("(c) move a null field to root → ok:true, value is null", () => {
    // { a: null } — move /a (null) to root ""
    const doc: JsonValue = { a: null };
    const result = applyPatch(doc, [{ op: "move", from: "/a", path: "" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it("(d) copy a null field to root → ok:true, value is null", () => {
    // { a: null } — copy /a (null) to root ""
    const doc: JsonValue = { a: null };
    const result = applyPatch(doc, [{ op: "copy", from: "/a", path: "" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });
});

// ── Fix 3: minor test gaps noted in code review ───────────────────────────────

describe("applyPatch — edge cases (Fix 3)", () => {
  it("add to missing intermediate parent → ok:false", () => {
    // /x doesn't exist on { a: 1 }, so /x/y is unreachable
    const doc: JsonValue = { a: 1 };
    const result = applyPatch(doc, [{ op: "add", path: "/x/y", value: 42 }]);
    expect(result.ok).toBe(false);
  });

  it("move identity (from === path) → ok:true, document unchanged", () => {
    const doc: JsonValue = { a: 1, b: 2 };
    const result = applyPatch(doc, [{ op: "move", from: "/a", path: "/a" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1, b: 2 });
  });
});
