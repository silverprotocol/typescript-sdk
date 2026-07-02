import { describe, it, expect } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import {
  flattenLeaves,
  collectValues,
  normalizePath,
  census,
} from "./census.js";
import type { Leaf, CensusInput, CensusReport, AllowlistReview } from "./census.js";

// ─────────────────────────────────────────────────────────────────────────────
// normalizePath
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizePath", () => {
  it("collapses numeric array indices to [*]", () => {
    expect(normalizePath("[2].a[0].b")).toBe("[*].a[*].b");
  });

  it("collapses multiple indices at root", () => {
    expect(normalizePath("[0][1][2]")).toBe("[*][*][*]");
  });

  it("leaves non-numeric brackets alone", () => {
    expect(normalizePath("a.b.c")).toBe("a.b.c");
  });

  it("handles deeply nested indices", () => {
    expect(normalizePath("[2].message.content[0].citations[0].cited_text")).toBe(
      "[*].message.content[*].citations[*].cited_text",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// flattenLeaves
// ─────────────────────────────────────────────────────────────────────────────

describe("flattenLeaves", () => {
  it("flattens a scalar to a single leaf with empty path", () => {
    const leaves = flattenLeaves("hello");
    expect(leaves).toEqual<Leaf[]>([{ path: "", norm: "", value: "hello" }]);
  });

  it("flattens a flat object", () => {
    const leaves = flattenLeaves({ a: 1, b: "two" });
    expect(leaves).toContainEqual<Leaf>({ path: "a", norm: "a", value: 1 });
    expect(leaves).toContainEqual<Leaf>({ path: "b", norm: "b", value: "two" });
    expect(leaves).toHaveLength(2);
  });

  it("flattens nested object with correct dot-path", () => {
    const leaves = flattenLeaves({ message: { content: "hi" } });
    expect(leaves).toEqual<Leaf[]>([
      { path: "message.content", norm: "message.content", value: "hi" },
    ]);
  });

  it("flattens an array of objects with indexed paths", () => {
    const input: JsonValue = [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1" },
    ];
    const leaves = flattenLeaves(input);
    expect(leaves).toContainEqual<Leaf>({
      path: "[0].type",
      norm: "[*].type",
      value: "text",
    });
    expect(leaves).toContainEqual<Leaf>({
      path: "[0].text",
      norm: "[*].text",
      value: "hello",
    });
    expect(leaves).toContainEqual<Leaf>({
      path: "[1].type",
      norm: "[*].type",
      value: "tool_use",
    });
    expect(leaves).toContainEqual<Leaf>({
      path: "[1].id",
      norm: "[*].id",
      value: "t1",
    });
  });

  it("handles deeply nested array-of-objects (event stream shape)", () => {
    const input: JsonValue = [
      {
        message: {
          content: [{ citations: [{ cited_text: "excerpt" }] }],
        },
      },
    ];
    const leaves = flattenLeaves(input);
    expect(leaves).toContainEqual<Leaf>({
      path: "[0].message.content[0].citations[0].cited_text",
      norm: "[*].message.content[*].citations[*].cited_text",
      value: "excerpt",
    });
  });

  it("flattens null leaf", () => {
    const leaves = flattenLeaves({ x: null });
    expect(leaves).toEqual<Leaf[]>([{ path: "x", norm: "x", value: null }]);
  });

  it("flattens false leaf", () => {
    const leaves = flattenLeaves({ flag: false });
    expect(leaves).toEqual<Leaf[]>([{ path: "flag", norm: "flag", value: false }]);
  });

  it("flattens zero leaf", () => {
    const leaves = flattenLeaves({ duration_ms: 0 });
    expect(leaves).toEqual<Leaf[]>([
      { path: "duration_ms", norm: "duration_ms", value: 0 },
    ]);
  });

  it("uses a provided path prefix", () => {
    const leaves = flattenLeaves({ a: 1 }, "root");
    expect(leaves).toEqual<Leaf[]>([{ path: "root.a", norm: "root.a", value: 1 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// collectValues
// ─────────────────────────────────────────────────────────────────────────────

describe("collectValues", () => {
  it("collects scalars from a flat object", () => {
    const vals = collectValues({ type: "message_start", index: 1 });
    expect(vals.has("message_start")).toBe(true);
    expect(vals.has(1)).toBe(true);
  });

  it("reaches into nested objects and arrays", () => {
    const vals = collectValues({
      events: [{ serverToolRequests: 0, text: "hi" }],
    });
    expect(vals.has(0)).toBe(true);
    expect(vals.has("hi")).toBe(true);
  });

  it("collects null, false, true as distinct members", () => {
    const vals = collectValues({ a: null, b: false, c: true });
    expect(vals.has(null)).toBe(true);
    expect(vals.has(false)).toBe(true);
    expect(vals.has(true)).toBe(true);
  });

  it("collects values inside a JsonValue blob (structuredContent-like)", () => {
    const vals = collectValues({
      structuredContent: { nested: { deep: "treasure" } },
    });
    expect(vals.has("treasure")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// census — core classification rules
// ─────────────────────────────────────────────────────────────────────────────

describe("census", () => {
  // ── helpers ──────────────────────────────────────────────────────────────

  function makeInput(overrides: Partial<CensusInput> = {}): CensusInput {
    return {
      native: [] as JsonValue,
      agjson: {} as JsonValue,
      transforms: new Map<string, string>(),
      allowlist: new Map<string, AllowlistReview>(),
      registry: new Set<string>(),
      ...overrides,
    };
  }

  // ── Rule 4: distinctive value absent from AgJSON → drop ──────────────────

  it("reports a distinctive native value absent from the AgJSON as a drop", () => {
    const input = makeInput({
      native: [{ stop_reason: "end_turn" }],
      agjson: { type: "message_delta" }, // "end_turn" not present
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.value === "end_turn");
    expect(drop).toBeDefined();
    expect(drop?.path).toBe("[0].stop_reason");
    expect(drop?.norm).toBe("[*].stop_reason");
  });

  // ── Rule 4: distinctive value present in AgJSON → NOT a drop ─────────────

  it("does not report a distinctive native value present in the AgJSON as a drop", () => {
    const input = makeInput({
      native: [{ model: "claude-3-5-sonnet-20241022" }],
      agjson: { model: "claude-3-5-sonnet-20241022" }, // present verbatim
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.value === "claude-3-5-sonnet-20241022");
    expect(drop).toBeUndefined();
  });

  // ── ★ Rule 3: THE KEY TEST — ambient 0 is never auto-covered ──────────────
  // Native has duration_ms:0; AgJSON also has serverToolRequests:0.
  // A naive value-set check would see 0 ∈ agJsonValues and mark duration_ms "covered".
  // The ambient rule MUST prevent that masking — duration_ms:0 is still a drop.

  it("★ reports native leaf with value 0 as a drop even when 0 exists in the AgJSON", () => {
    const input = makeInput({
      native: [{ duration_ms: 0 }], // genuinely dropped by normalizer
      agjson: { serverToolRequests: 0 }, // 0 coincidentally present, must NOT mask
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.path === "[0].duration_ms");
    expect(drop).toBeDefined();
    expect(drop?.value).toBe(0);
  });

  it("★ reports native leaf with value '' (empty string) as a drop even when '' exists in the AgJSON", () => {
    const input = makeInput({
      native: [{ stop_sequence: "" }],
      agjson: { text: "" }, // '' coincidentally present
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.path === "[0].stop_sequence");
    expect(drop).toBeDefined();
    expect(drop?.value).toBe("");
  });

  it("★ reports native leaf with value false as a drop even when false exists in the AgJSON", () => {
    const input = makeInput({
      native: [{ streaming: false }],
      agjson: { done: false },
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.path === "[0].streaming");
    expect(drop).toBeDefined();
    expect(drop?.value).toBe(false);
  });

  it("★ reports native leaf with value true as a drop even when true exists in the AgJSON", () => {
    const input = makeInput({
      native: [{ cache_hit: true }],
      agjson: { active: true },
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.path === "[0].cache_hit");
    expect(drop).toBeDefined();
    expect(drop?.value).toBe(true);
  });

  it("★ reports native leaf with value null as a drop even when null exists in the AgJSON", () => {
    const input = makeInput({
      native: [{ tool_calls: null }],
      agjson: { parent: null },
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.path === "[0].tool_calls");
    expect(drop).toBeDefined();
    expect(drop?.value).toBe(null);
  });

  // ── Rule 1: transforms → mapped + value-verified (presence at target) ────

  it("does not report a leaf as a drop when its transforms target is present in the AgJSON (renamed value)", () => {
    const input = makeInput({
      native: [{ stop_reason: "end_turn" }], // "end_turn" NOT in agjson verbatim
      agjson: [{ finishReason: "stop" }], // renamed by normalizer — different value
      transforms: new Map([["[*].stop_reason", "[*].finishReason"]]),
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.norm === "[*].stop_reason");
    expect(drop).toBeUndefined();
  });

  // ── Rule 2: allowlist-path → ignorable, NOT a drop ───────────────────────

  it("does not report a leaf as a drop when its norm-path is 'any'-reviewed in the allowlist", () => {
    const input = makeInput({
      native: [{ usage: { server_tool_use: { web_search_requests: 2 } } }],
      agjson: {},
      allowlist: new Map([
        ["[*].usage.server_tool_use.web_search_requests", { reviewed: "any" }],
      ]),
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find(
      (d) => d.norm === "[*].usage.server_tool_use.web_search_requests",
    );
    expect(drop).toBeUndefined();
  });

  // ── Rule 1 covers ambient SOURCE and/or TARGET values (presence, not
  //    value-equality) — real cases: tool.done.isError is legitimately
  //    false most of the time; uiData.cache.hit/llmCallsAvoided are
  //    legitimately false/0 on a cache miss. Registration in transforms must
  //    NOT be defeated by ambient-ness on either side. ─────────────────────

  it("does not drop an ambient-valued leaf when its transforms target is genuinely present (even with an ambient value)", () => {
    const input = makeInput({
      native: [{ is_error: false }], // ambient false, but genuinely mapped
      agjson: [{ isError: false }], // target present (ambient value — still counts)
      transforms: new Map([["[*].is_error", "[*].isError"]]),
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.norm === "[*].is_error");
    expect(drop).toBeUndefined();
  });

  // ── Type-coercion guard: number 0 !== string "0" ─────────────────────────

  it("does not cover native number 0 with AgJSON string '0' (strict equality)", () => {
    const input = makeInput({
      native: [{ count: 0 }],
      agjson: { count: "0" }, // string "0", NOT number 0
    });
    const report: CensusReport = census(input);
    // count:0 is ambient, so it must be a drop regardless; but also confirm
    // that even for a non-ambient number, string "0" does not cover number 0.
    const drop = report.drops.find((d) => d.path === "[0].count");
    expect(drop).toBeDefined();
  });

  // ── newFields ─────────────────────────────────────────────────────────────

  it("includes a new norm-path in newFields when it is not in the registry", () => {
    const input = makeInput({
      native: [{ stop_reason: "end_turn" }],
      agjson: {},
      registry: new Set<string>(), // empty: stop_reason is new
    });
    const report: CensusReport = census(input);
    expect(report.newFields).toContain("[*].stop_reason");
  });

  it("does not include a norm-path in newFields when it is already in the registry", () => {
    const input = makeInput({
      native: [{ stop_reason: "end_turn" }],
      agjson: {},
      registry: new Set(["[*].stop_reason"]),
    });
    const report: CensusReport = census(input);
    expect(report.newFields).not.toContain("[*].stop_reason");
  });

  it("deduplicates newFields (each norm-path appears at most once)", () => {
    const input = makeInput({
      native: [{ stop_reason: "end_turn" }, { stop_reason: "max_tokens" }],
      agjson: {},
    });
    const report: CensusReport = census(input);
    const count = report.newFields.filter((f) => f === "[*].stop_reason").length;
    expect(count).toBe(1);
  });

  // ── drops is empty when everything is covered / mapped / allowlisted ──────

  it("returns empty drops when all leaves are covered or classified", () => {
    const input = makeInput({
      native: [{ model: "claude-opus-4-5", index: 0, stop_reason: "end_turn" }],
      agjson: [{ model: "claude-opus-4-5", finishReason: "stop" }],
      transforms: new Map([["[*].stop_reason", "[*].finishReason"]]),
      allowlist: new Map([["[*].index", { reviewed: "any" }]]),
    });
    const report: CensusReport = census(input);
    expect(report.drops).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // audit M57 §2.B — the three mutations that PROVED the census was
  // value-blind on registered paths. These tests permanently encode them.
  // ─────────────────────────────────────────────────────────────────────────

  // ── M1-class: a transforms-registered source whose mapped TARGET is
  //    entirely absent from the AgJSON ⇒ DROP (previously: silently green,
  //    since the OLD Rule 1 was `transforms.has(leaf.norm)` with no lookup
  //    into the agjson at all). ─────────────────────────────────────────────

  it("M1-class: a transforms-registered source drops when its target never lands in the AgJSON", () => {
    const input = makeInput({
      native: [{ stop_reason: "end_turn" }],
      agjson: [{ someUnrelatedField: 1 }], // finishReason genuinely never emitted
      transforms: new Map([["[*].stop_reason", "[*].finishReason"]]),
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.norm === "[*].stop_reason");
    expect(drop).toBeDefined();
    expect(drop?.value).toBe("end_turn");
  });

  it("M1-class: a transforms-registered null source is trivially mapped (nothing to assert)", () => {
    const input = makeInput({
      native: [{ stop_sequence: null }],
      agjson: [{ someUnrelatedField: 1 }], // target absent, but source is null
      transforms: new Map([["[*].stop_sequence", "[*].stopSequence"]]),
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.norm === "[*].stop_sequence");
    expect(drop).toBeUndefined();
  });

  // ── M2-class: an allowlist entry reviewed:"null-only" whose source value
  //    is POPULATED ⇒ DROP (previously: silently green, since the OLD Rule 2
  //    was `allowlist.has(leaf.norm)` with no value check at all — a
  //    null-reviewed drop stayed permanently masked even once populated). ──

  it("M2-class: a null-only allowlist entry does NOT cover a populated (non-null) value", () => {
    const input = makeInput({
      native: [{ parent_tool_use_id: "toolu_distinctive_marker" }],
      agjson: [{ someUnrelatedField: 1 }], // the distinctive value has no home
      allowlist: new Map([["[*].parent_tool_use_id", { reviewed: "null-only" }]]),
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.norm === "[*].parent_tool_use_id");
    expect(drop).toBeDefined();
    expect(drop?.value).toBe("toolu_distinctive_marker");
  });

  // ── control: null-valued source under a null-only entry ⇒ ignorable ─────

  it("control: a null-only allowlist entry covers a null-valued source", () => {
    const input = makeInput({
      native: [{ parent_tool_use_id: null }],
      agjson: [{ someUnrelatedField: 1 }],
      allowlist: new Map([["[*].parent_tool_use_id", { reviewed: "null-only" }]]),
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.norm === "[*].parent_tool_use_id");
    expect(drop).toBeUndefined();
  });

  // ── control: an "any"-reviewed entry is ignorable regardless of value ───

  it("control: an 'any'-reviewed allowlist entry covers a populated distinctive value regardless", () => {
    const input = makeInput({
      native: [{ session_id: "sess_distinctive_marker" }],
      agjson: [{ someUnrelatedField: 1 }],
      allowlist: new Map([["[*].session_id", { reviewed: "any" }]]),
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.norm === "[*].session_id");
    expect(drop).toBeUndefined();
  });

  // ── M3-class (money-path): a distinctive non-ambient source (e.g. a real
  //    cache-read token count) is NOT unconditionally waived just because its
  //    reason text happens to describe the CURRENT value as ambient — moving
  //    the entry into transforms means the target must genuinely land. ─────

  it("M3-class: a real distinctive cache-token value is verified against its target, not blanket-waived", () => {
    const input = makeInput({
      native: [{ cached_tokens: 424242 }],
      agjson: [{ someUnrelatedField: 1 }], // cacheReadTokens never landed at all
      transforms: new Map([["[*].cached_tokens", "[*].usage.cacheReadTokens"]]),
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.norm === "[*].cached_tokens");
    expect(drop).toBeDefined();
    expect(drop?.value).toBe(424242);
  });

  // ── per-framework guard scoping: an allowlist entry scoped to a different
  //    framework than the current replay does NOT apply (audit M57 —
  //    framework-unscoped guards could mask a same-norm-path drop on another
  //    framework's cassette). ────────────────────────────────────────────

  it("does not let a framework-scoped allowlist entry cover a leaf from a different framework", () => {
    const input = makeInput({
      native: [{ status: "in_progress" }],
      agjson: [{ someUnrelatedField: 1 }],
      allowlist: new Map([["[*].status", { reviewed: "any", frameworks: ["openai"] }]]),
      framework: "claude",
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.norm === "[*].status");
    expect(drop).toBeDefined();
  });

  it("lets a framework-scoped allowlist entry cover a leaf from its own framework", () => {
    const input = makeInput({
      native: [{ status: "in_progress" }],
      agjson: [{ someUnrelatedField: 1 }],
      allowlist: new Map([["[*].status", { reviewed: "any", frameworks: ["openai"] }]]),
      framework: "openai",
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.norm === "[*].status");
    expect(drop).toBeUndefined();
  });

  it("applies a framework-unscoped allowlist entry (no `frameworks` field) regardless of the current framework", () => {
    const input = makeInput({
      native: [{ status: "in_progress" }],
      agjson: [{ someUnrelatedField: 1 }],
      allowlist: new Map([["[*].status", { reviewed: "any" }]]),
      framework: "claude",
    });
    const report: CensusReport = census(input);
    const drop = report.drops.find((d) => d.norm === "[*].status");
    expect(drop).toBeUndefined();
  });
});
