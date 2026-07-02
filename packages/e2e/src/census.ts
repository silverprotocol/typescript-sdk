/**
 * census.ts — value-census lossiness engine for the AgJSON E2E conformance harness.
 *
 * Compares a captured NATIVE event stream (JsonValue) against the normalized
 * AgJSON output and reports which native scalar values had no home in the AgJSON
 * ("drops"), plus which norm-paths are new relative to a known registry.
 *
 * Coverage rule (four steps, evaluated in order for each leaf):
 *   1. transforms.get(leaf.norm) → target norm-path → MAPPED, value-verified:
 *      a non-null source MUST have a leaf at the target norm-path somewhere in
 *      the agjson (any value — this is a structural "did it land at all" check,
 *      not a value-equality check, so legitimate renames like stop_reason→
 *      finishReason and legitimately-ambient targets like isError:false are
 *      NOT false positives). A non-null source whose target is absent ⇒ DROP.
 *      A null source is trivially mapped (nothing to assert).
 *   2. allowlist.get(leaf.norm) → {reviewed, frameworks} → shape-scoped:
 *        - reviewed:"any"        → ignorable regardless of value.
 *        - reviewed:"null-only"  → ignorable ONLY while the value is null; a
 *          populated (non-null) value falls through to Rule 3/4 like any
 *          unregistered leaf (closes the M57/M2 hole where a null-reviewed
 *          drop silently masked a later population of that same path).
 *      An entry whose `frameworks` excludes the current `framework` does not
 *      apply at all (closes the M57 framework-unscoped-guard hole).
 *   3. value is AMBIENT (0, '', false, true, null) → always a drop (never
 *      auto-covered by value-match — coincidental collisions would mask real loss)
 *   4. else (distinctive value): covered iff leaf.value ∈ collectValues(agjson)
 *
 * CAVEAT (spec §4.5): drops===[] is NOT proof of zero real loss for ambient-valued
 * fields unless those fields are explicitly registered in transforms/allowlist.
 * The census is a review-aid and growth-guard, not an exhaustive proof — and Rule 1's
 * presence check does not prove the target carries the SAME value, only that the
 * mapped field landed somewhere (a wrong-but-present value is not caught).
 */

import type { JsonValue } from "@silverprotocol/core";

// ─── Public types ─────────────────────────────────────────────────────────────

export type Scalar = string | number | boolean | null;

export interface Leaf {
  /** Fully-qualified path with concrete indices, e.g. `[2].content[0].text` */
  path: string;
  /** Path with all `[n]` → `[*]`, e.g. `[*].content[*].text` */
  norm: string;
  value: Scalar;
}

/** The set of supported facet normalizer identifiers (guard-scoping domain —
 *  replay.ts infers this from the cassette filename and threads it through). */
export type Framework = "claude" | "openai" | "adk";

/**
 * How a `known-acceptable-drops.json` entry's shape was reviewed:
 *   - "null-only": ignorable ONLY while the source value is null. A populated
 *     value is NOT covered by this entry — it is re-scrutinized like any
 *     unregistered leaf (audit M57/M2 fix).
 *   - "any": ignorable regardless of value — a genuinely homeless field; no
 *     future population would ever gain an AgJSON home.
 */
export type ReviewedShape = "null-only" | "any";

/** One allowlist entry's review scoping (paired with its norm-path key). */
export interface AllowlistReview {
  reviewed: ReviewedShape;
  /** Frameworks this entry's shape was reviewed against. Omitted = applies
   *  regardless of framework (a framework-agnostic entry, or the caller did
   *  not supply a `framework` context). */
  frameworks?: Framework[];
}

export interface CensusInput {
  /** The captured native event stream — an array of raw provider events (JsonValue). */
  native: JsonValue;
  /** The AgJSON output produced by the normalizer. */
  agjson: JsonValue;
  /** source norm-path → target norm-path. A registered source whose value is
   *  non-null asserts a leaf exists at the target norm-path in the agjson. */
  transforms: Map<string, string>;
  /** norm-path → review scoping (reviewed shape + optional framework scope). */
  allowlist: Map<string, AllowlistReview>;
  /** Every classified norm-path (union of transforms, allowlist, and any prior manual triage). */
  registry: Set<string>;
  /** The framework of the cassette being censused. Used to filter allowlist
   *  entries scoped to a different framework (Rule 2). Omitted = no framework
   *  filtering (every allowlist entry applies regardless of scope). */
  framework?: Framework;
}

export interface CensusReport {
  /** Native leaves with no home in the AgJSON (unclassified drops). */
  drops: Leaf[];
  /** norm-paths not in the registry (each appears at most once). */
  newFields: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizePath
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collapses every concrete numeric index `[n]` to `[*]` so that structurally
 * equivalent paths across different array positions compare equal.
 */
export function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, "[*]");
}

// ─────────────────────────────────────────────────────────────────────────────
// flattenLeaves
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively walks `value` and returns every primitive (Scalar) leaf with its
 * fully-qualified `path` and the normalized `norm`.
 *
 * Path conventions:
 *   - Object key: append `.key`  (or just `key` at root)
 *   - Array element: append `[i]`
 *
 * @param value  The JSON value to walk.
 * @param path   Optional prefix for the current position (default: "").
 */
export function flattenLeaves(value: JsonValue, path = ""): Leaf[] {
  if (value === null || typeof value !== "object") {
    // Scalar leaf
    const scalar = value as Scalar;
    return [{ path, norm: normalizePath(path), value: scalar }];
  }

  if (Array.isArray(value)) {
    const result: Leaf[] = [];
    for (let i = 0; i < value.length; i++) {
      const childPath = `${path}[${i}]`;
      const item = value[i];
      if (item !== undefined) {
        result.push(...flattenLeaves(item, childPath));
      }
    }
    return result;
  }

  // Plain object
  const result: Leaf[] = [];
  for (const key of Object.keys(value)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    const child = (value as Record<string, JsonValue>)[key];
    if (child !== undefined) {
      result.push(...flattenLeaves(child, childPath));
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// collectValues
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively walks the AgJSON output and returns a Set of every Scalar present,
 * including values nested inside opaque JsonValue blobs (structuredContent,
 * provider-raw `raw`, etc.).
 */
export function collectValues(agjson: JsonValue): Set<Scalar> {
  const result = new Set<Scalar>();

  function walk(v: JsonValue): void {
    if (v === null || typeof v !== "object") {
      result.add(v as Scalar);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== undefined) walk(item);
      }
      return;
    }
    for (const key of Object.keys(v)) {
      const child = (v as Record<string, JsonValue>)[key];
      if (child !== undefined) walk(child);
    }
  }

  walk(agjson);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ambient scalar guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the value is an "ambient" scalar — one that is so common
 * across unrelated fields that a coincidental presence in the AgJSON value-set
 * cannot be trusted as coverage evidence.
 *
 * Ambient scalars: 0, '' (empty string), false, true, null.
 */
function isAmbient(v: Scalar): boolean {
  return v === 0 || v === "" || v === false || v === true || v === null;
}

// ─────────────────────────────────────────────────────────────────────────────
// census
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produces a CensusReport for one normalizer run.
 *
 * Classification order for each native leaf:
 *   1. transforms  → mapped, value-verified (drop iff non-null source AND the
 *      target norm-path has NO leaf anywhere in the agjson — presence, not
 *      value-equality; see the module header)
 *   2. allowlist   → shape-scoped ignorable (reviewed:"any" always applies;
 *      reviewed:"null-only" applies only while value===null; an entry scoped
 *      to `frameworks` that excludes the current `framework` does not apply)
 *   3. ambient     → drop     (never auto-covered)
 *   4. distinctive → covered iff value ∈ collectValues(agjson); else drop
 *
 * newFields = leaf.norm values not in registry (deduplicated).
 */
export function census(input: CensusInput): CensusReport {
  const { native, agjson, transforms, allowlist, registry, framework } = input;

  const leaves = flattenLeaves(native);
  const agJsonValues = collectValues(agjson);
  const agJsonNormPaths = new Set(flattenLeaves(agjson).map((l) => l.norm));

  const drops: Leaf[] = [];
  const seenNewFields = new Set<string>();
  const newFields: string[] = [];

  for (const leaf of leaves) {
    // Track new norm-paths (before classification, so even mapped/allowlisted
    // paths that are new to the registry are surfaced for triage).
    if (!registry.has(leaf.norm) && !seenNewFields.has(leaf.norm)) {
      seenNewFields.add(leaf.norm);
      newFields.push(leaf.norm);
    }

    // ── Rule 1: transforms (mapped, value-verifying) ────────────────────────
    const target = transforms.get(leaf.norm);
    if (target !== undefined) {
      if (leaf.value !== null && !agJsonNormPaths.has(target)) {
        // The mapped target never landed anywhere in the agjson — a genuine
        // drop (audit M57/M1: a transforms-registered value that vanishes).
        drops.push(leaf);
      }
      continue; // registered — Rule 1 owns this leaf either way
    }

    // ── Rule 2: allowlist (shape-scoped) ─────────────────────────────────────
    const review = allowlist.get(leaf.norm);
    if (review !== undefined) {
      const outOfScope =
        review.frameworks !== undefined &&
        framework !== undefined &&
        !review.frameworks.includes(framework);
      if (!outOfScope && (review.reviewed === "any" || leaf.value === null)) {
        continue; // ignorable
      }
      // reviewed:"null-only" with a populated value (or out-of-scope framework)
      // falls through to Rule 3/4 below — audit M57/M2 fix.
    }

    // ── Rule 3: ambient scalar ────────────────────────────────────────────────
    if (isAmbient(leaf.value)) {
      drops.push(leaf); // always a drop — never auto-covered
      continue;
    }

    // ── Rule 4: distinctive value — check verbatim presence in AgJSON ────────
    if (!agJsonValues.has(leaf.value)) {
      drops.push(leaf);
    }
  }

  return { drops, newFields };
}
