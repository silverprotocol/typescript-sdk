/**
 * census.ts — value-census lossiness engine for the AgJSON E2E conformance harness.
 *
 * Compares a captured NATIVE event stream (JsonValue) against the normalized
 * AgJSON output and reports which native scalar values had no home in the AgJSON
 * ("drops"), plus which norm-paths are new relative to a known registry.
 *
 * Coverage rule (four steps, evaluated in order for each leaf):
 *   1. transforms.has(leaf.norm)  → mapped   → NOT a drop
 *   2. allowlist.has(leaf.norm)   → ignorable → NOT a drop
 *   3. value is AMBIENT (0, '', false, true, null) → always a drop (never
 *      auto-covered by value-match — coincidental collisions would mask real loss)
 *   4. else (distinctive value): covered iff leaf.value ∈ collectValues(agjson)
 *
 * CAVEAT (spec §4.5): drops===[] is NOT proof of zero real loss for ambient-valued
 * fields unless those fields are explicitly registered in transforms/allowlist.
 * The census is a review-aid and growth-guard, not an exhaustive proof.
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

export interface CensusInput {
  /** The captured native event stream — an array of raw provider events (JsonValue). */
  native: JsonValue;
  /** The AgJSON output produced by the normalizer. */
  agjson: JsonValue;
  /** norm-paths whose value is renamed by the normalizer (classified "mapped"). */
  transforms: Set<string>;
  /** norm-paths reviewed as genuinely-unmapped-and-ignorable. */
  allowlist: Set<string>;
  /** Every classified norm-path (union of transforms, allowlist, and any prior manual triage). */
  registry: Set<string>;
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
 *   1. transforms  → mapped   (not a drop)
 *   2. allowlist   → ignorable (not a drop)
 *   3. ambient     → drop     (never auto-covered)
 *   4. distinctive → covered iff value ∈ collectValues(agjson); else drop
 *
 * newFields = leaf.norm values not in registry (deduplicated).
 */
export function census(input: CensusInput): CensusReport {
  const { native, agjson, transforms, allowlist, registry } = input;

  const leaves = flattenLeaves(native);
  const agJsonValues = collectValues(agjson);

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

    // ── Rule 1: transforms (mapped) ─────────────────────────────────────────
    if (transforms.has(leaf.norm)) {
      continue; // mapped — not a drop
    }

    // ── Rule 2: allowlist (ignorable) ────────────────────────────────────────
    if (allowlist.has(leaf.norm)) {
      continue; // ignorable — not a drop
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
