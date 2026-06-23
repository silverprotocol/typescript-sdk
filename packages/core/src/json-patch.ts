import type { JsonValue } from "./agjson.js";

// ─────────────────────────────────────────────────────────────────────────────
// Inline RFC-6902 JSON-Patch applier (reduce R6).
//
// Contract: applyPatch(doc, patch) → { ok: true; value: JsonValue } | { ok: false }
//
// Design rules:
//   • NEVER throws — all failure paths return { ok: false }.
//   • PURE — returns a NEW document; never mutates `doc`.
//   • ATOMIC — applies to a working clone; returns { ok: true, value } only if
//     EVERY op succeeds; otherwise returns { ok: false } and `doc` is untouched.
//   • Signals (ok:false) on: malformed patch, malformed op, absent path for
//     replace/remove/move/copy-from, failed test op, out-of-bounds index.
//
// RFC-6901 pointer parsing:
//   • split on "/"; unescape "~1" → "/" then "~0" → "~" (ORDER MATTERS).
//   • "" (empty pointer) = the whole document (root replacement).
// ─────────────────────────────────────────────────────────────────────────────

/** Result type returned by applyPatch. */
export type PatchResult = { ok: true; value: JsonValue } | { ok: false };

/** Failure sentinel — used internally to signal any error without throwing. */
const FAIL: { ok: false } = { ok: false };

/**
 * Discriminated result for internal pointer helpers.
 * Using a distinct wrapper avoids overloading `null` as both a valid JsonValue
 * (e.g. the document IS null) and a failure sentinel — which is the root cause
 * of the null-at-root silent corruption bug (R6 fix 1).
 */
type PointerResult = { ok: true; doc: JsonValue } | { ok: false };

const POINTER_FAIL: PointerResult = { ok: false };

// ── Type guards ────────────────────────────────────────────────────────────────

/** Narrow JsonValue to a plain JSON object (non-array, non-null). */
function isJsonObject(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Narrow JsonValue to a JSON array. */
function isJsonArray(v: JsonValue): v is JsonValue[] {
  return Array.isArray(v);
}

// ── RFC-6901 pointer helpers ──────────────────────────────────────────────────

/**
 * Parse a RFC-6901 JSON Pointer string into its reference-token array.
 * Empty string → [] (root).
 * "/foo/bar" → ["foo", "bar"].
 * Unescaping: "~1" → "/" then "~0" → "~" (order mandated by spec).
 */
function parsePointer(ptr: string): string[] | null {
  if (ptr === "") return [];
  if (!ptr.startsWith("/")) return null; // malformed — must start with "/"
  return ptr
    .slice(1)
    .split("/")
    .map((tok) => tok.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Resolve a JSON Pointer in a document, returning { parent, key, value } on
 * success, or null on failure (absent path, wrong type at an intermediate node).
 *
 * `parent` is the object/array containing `key`; for the root pointer ([])
 * there is no parent, so parent=null and key="" are returned (callers handle
 * root as a special case).
 */
function resolve(
  doc: JsonValue,
  tokens: string[],
): { parent: { [k: string]: JsonValue } | JsonValue[]; key: string; value: JsonValue } | { parent: null; key: ""; value: JsonValue } | null {
  if (tokens.length === 0) {
    return { parent: null, key: "", value: doc };
  }

  let node: JsonValue = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    if (tok === undefined) return null;
    if (isJsonArray(node)) {
      const idx = arrayIndex(tok, node.length, false);
      if (idx === null) return null;
      const child = node[idx];
      if (child === undefined) return null;
      node = child;
    } else if (isJsonObject(node)) {
      const child = node[tok];
      if (child === undefined) return null;
      node = child;
    } else {
      return null; // scalar — can't descend further
    }
  }

  const lastTok = tokens[tokens.length - 1];
  if (lastTok === undefined) return null;

  if (isJsonArray(node)) {
    const idx = arrayIndex(lastTok, node.length, false);
    if (idx === null) return null;
    const value = node[idx];
    if (value === undefined) return null;
    return { parent: node, key: String(idx), value };
  } else if (isJsonObject(node)) {
    const value = node[lastTok];
    if (value === undefined) return null;
    return { parent: node, key: lastTok, value };
  }
  return null;
}

/**
 * Convert a JSON Pointer token to a numeric array index.
 * - "0".."n" are valid non-negative integers.
 * - "-" is the append-sentinel (only valid for `add`).
 * - Out-of-bounds for the given length → null.
 *
 * @param tok       The token string.
 * @param len       Current array length.
 * @param allowDash If true, "-" maps to `len` (append position for `add`).
 */
function arrayIndex(tok: string, len: number, allowDash: boolean): number | null {
  if (tok === "-") {
    return allowDash ? len : null;
  }
  // RFC-6902: leading zeros are disallowed except for "0" itself.
  if (!/^\d+$/.test(tok)) return null;
  if (tok.length > 1 && tok.startsWith("0")) return null;
  const n = Number(tok);
  // For non-add ops: must be within [0, len-1]; for add, [0, len] is handled by the caller.
  if (n > len) return null;
  return n;
}

// ── Structural set/remove helpers (operate on a working clone) ────────────────

/**
 * Set a value at the given pointer tokens in `doc`.
 * For `add` semantics pass `isAdd=true` — enables "-" sentinel and insertion.
 * For `replace` semantics pass `isAdd=false` — target must already exist.
 * Returns a PointerResult: { ok: true; doc: JsonValue } on success, { ok: false }
 * on failure. Uses a discriminated wrapper (not null) so that a legitimate null
 * document value (e.g. root replacement with null) is never confused with failure.
 */
function pointerSet(
  doc: JsonValue,
  tokens: string[],
  value: JsonValue,
  isAdd: boolean,
): PointerResult {
  if (tokens.length === 0) {
    // Root replacement: always ok. value may legally be null.
    return { ok: true, doc: value };
  }

  // Recurse to find the parent container.
  if (tokens.length === 1) {
    const tok = tokens[0];
    if (tok === undefined) return POINTER_FAIL;

    if (isJsonArray(doc)) {
      const idx = arrayIndex(tok, doc.length, isAdd);
      if (idx === null) return POINTER_FAIL;
      if (!isAdd && idx >= doc.length) return POINTER_FAIL; // replace requires existing
      const copy: JsonValue[] = [...doc];
      if (isAdd) {
        copy.splice(idx, 0, value);
      } else {
        copy[idx] = value;
      }
      return { ok: true, doc: copy };
    } else if (isJsonObject(doc)) {
      // Object: add creates/replaces; replace requires the key to exist.
      if (!isAdd && !(tok in doc)) return POINTER_FAIL; // replace: key must exist
      return { ok: true, doc: { ...doc, [tok]: value } };
    }
    return POINTER_FAIL; // scalar — cannot descend
  }

  // Multi-segment: recurse into the next node.
  const tok = tokens[0];
  if (tok === undefined) return POINTER_FAIL;
  const rest = tokens.slice(1);

  if (isJsonArray(doc)) {
    const idx = arrayIndex(tok, doc.length, false);
    if (idx === null || idx >= doc.length) return POINTER_FAIL;
    const child = doc[idx];
    if (child === undefined) return POINTER_FAIL;
    const childResult = pointerSet(child, rest, value, isAdd);
    if (!childResult.ok) return POINTER_FAIL;
    const copy: JsonValue[] = [...doc];
    copy[idx] = childResult.doc;
    return { ok: true, doc: copy };
  } else if (isJsonObject(doc)) {
    const child = doc[tok];
    if (child === undefined) return POINTER_FAIL;
    const childResult = pointerSet(child, rest, value, isAdd);
    if (!childResult.ok) return POINTER_FAIL;
    return { ok: true, doc: { ...doc, [tok]: childResult.doc } };
  }
  return POINTER_FAIL; // scalar — cannot descend
}

/**
 * Remove the value at the given pointer tokens in `doc`.
 * Returns a PointerResult: { ok: true; doc: JsonValue } on success, { ok: false }
 * on failure. Uses a discriminated wrapper (not null) so that legitimate null
 * values in the document are never confused with failure.
 */
function pointerRemove(doc: JsonValue, tokens: string[]): PointerResult {
  if (tokens.length === 0) {
    // RFC-6902: removing the root is invalid.
    return POINTER_FAIL;
  }

  if (tokens.length === 1) {
    const tok = tokens[0];
    if (tok === undefined) return POINTER_FAIL;

    if (isJsonArray(doc)) {
      // "-" is not a valid remove target (append-only sentinel).
      const idx = arrayIndex(tok, doc.length, false);
      if (idx === null || idx >= doc.length) return POINTER_FAIL;
      const copy: JsonValue[] = [...doc];
      copy.splice(idx, 1);
      return { ok: true, doc: copy };
    } else if (isJsonObject(doc)) {
      if (!(tok in doc)) return POINTER_FAIL;
      const { [tok]: _removed, ...rest } = doc;
      return { ok: true, doc: rest };
    }
    return POINTER_FAIL;
  }

  // Multi-segment: recurse.
  const tok = tokens[0];
  if (tok === undefined) return POINTER_FAIL;
  const rest = tokens.slice(1);

  if (isJsonArray(doc)) {
    const idx = arrayIndex(tok, doc.length, false);
    if (idx === null || idx >= doc.length) return POINTER_FAIL;
    const child = doc[idx];
    if (child === undefined) return POINTER_FAIL;
    const childResult = pointerRemove(child, rest);
    if (!childResult.ok) return POINTER_FAIL;
    const copy: JsonValue[] = [...doc];
    copy[idx] = childResult.doc;
    return { ok: true, doc: copy };
  } else if (isJsonObject(doc)) {
    const child = doc[tok];
    if (child === undefined) return POINTER_FAIL;
    const childResult = pointerRemove(child, rest);
    if (!childResult.ok) return POINTER_FAIL;
    return { ok: true, doc: { ...doc, [tok]: childResult.doc } };
  }
  return POINTER_FAIL;
}

// ── Deep-equality for `test` op ───────────────────────────────────────────────

/** RFC-6902 §4.6 deep equality — structural JSON equality (no undefined, no NaN). */
function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (isJsonArray(a) && isJsonArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i];
      const bi = b[i];
      if (ai === undefined || bi === undefined) return false;
      if (!deepEqual(ai, bi)) return false;
    }
    return true;
  }
  if (isJsonArray(a) || isJsonArray(b)) return false;
  if (isJsonObject(a) && isJsonObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!(k in b)) return false;
      const av = a[k];
      const bv = b[k];
      if (av === undefined || bv === undefined) return false;
      if (!deepEqual(av, bv)) return false;
    }
    return true;
  }
  return false;
}

// ── Op shape guards ───────────────────────────────────────────────────────────

/** Narrow an op entry to the expected shape before dispatching. */
function isObj(v: JsonValue): v is { [k: string]: JsonValue } {
  return isJsonObject(v);
}

function getString(obj: { [k: string]: JsonValue }, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

// ── applyPatch ────────────────────────────────────────────────────────────────

/**
 * Apply an RFC-6902 JSON Patch to `doc`.
 *
 * PURE: returns a new document; never mutates `doc`.
 * ATOMIC: if any op fails, returns { ok: false } — no partial result is ever
 *   returned.
 * NEVER THROWS: all error paths return { ok: false }.
 *
 * @param doc   The document to patch (not mutated).
 * @param patch The patch — must be a JSON array of op objects.
 * @returns     { ok: true; value: JsonValue } | { ok: false }
 */
export function applyPatch(doc: JsonValue, patch: JsonValue): PatchResult {
  try {
    // Reject non-array patch.
    if (!Array.isArray(patch)) return FAIL;

    // Apply all ops to a working copy (structuredClone for isolation from `doc`).
    let working: JsonValue = structuredClone(doc);

    for (const rawOp of patch) {
      if (rawOp === undefined) return FAIL;
      if (!isObj(rawOp)) return FAIL;

      const op = getString(rawOp, "op");
      const pathStr = getString(rawOp, "path");
      if (op === null || pathStr === null) return FAIL;

      const pathTokens = parsePointer(pathStr);
      if (pathTokens === null) return FAIL;

      switch (op) {
        case "add": {
          const value = rawOp["value"];
          if (value === undefined) return FAIL;
          const result = pointerSet(working, pathTokens, value, true);
          if (!result.ok) return FAIL;
          working = result.doc;
          break;
        }

        case "remove": {
          const result = pointerRemove(working, pathTokens);
          if (!result.ok) return FAIL;
          working = result.doc;
          break;
        }

        case "replace": {
          const value = rawOp["value"];
          if (value === undefined) return FAIL;
          const result = pointerSet(working, pathTokens, value, false);
          if (!result.ok) return FAIL;
          working = result.doc;
          break;
        }

        case "move": {
          const fromStr = getString(rawOp, "from");
          if (fromStr === null) return FAIL;
          const fromTokens = parsePointer(fromStr);
          if (fromTokens === null) return FAIL;

          // A move into one of its own descendants is illegal.
          if (isProperPrefix(fromTokens, pathTokens)) return FAIL;

          // Identity move (from === path): no-op per RFC-6902 §4.4 semantics.
          if (fromStr === pathStr) break;

          // Get the value at `from`.
          const resolved = resolve(working, fromTokens);
          if (resolved === null) return FAIL;
          const movedValue = resolved.value;

          // Remove from `from`.
          const afterRemove = pointerRemove(working, fromTokens);
          if (!afterRemove.ok) return FAIL;

          // Add at `path`.
          const afterAdd = pointerSet(afterRemove.doc, pathTokens, movedValue, true);
          if (!afterAdd.ok) return FAIL;
          working = afterAdd.doc;
          break;
        }

        case "copy": {
          const fromStr = getString(rawOp, "from");
          if (fromStr === null) return FAIL;
          const fromTokens = parsePointer(fromStr);
          if (fromTokens === null) return FAIL;

          // Get the value at `from`.
          const resolved = resolve(working, fromTokens);
          if (resolved === null) return FAIL;
          // Deep-clone the copied value to keep the patch pure.
          const copiedValue: JsonValue = structuredClone(resolved.value);

          // Add at `path`.
          const result = pointerSet(working, pathTokens, copiedValue, true);
          if (!result.ok) return FAIL;
          working = result.doc;
          break;
        }

        case "test": {
          const value = rawOp["value"];
          if (value === undefined) return FAIL;

          const resolved = resolve(working, pathTokens);
          if (resolved === null) return FAIL;
          if (!deepEqual(resolved.value, value)) return FAIL;
          // `test` op does not modify the document.
          break;
        }

        default:
          // Unknown op → fail.
          return FAIL;
      }
    }

    return { ok: true, value: working };
  } catch {
    // Catch-all: structuredClone or anything unexpected — never propagate.
    return FAIL;
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Returns true if `prefix` is a proper prefix of `tokens`
 * (i.e., every element of prefix equals the corresponding element of tokens,
 * and tokens is strictly longer). Used to detect illegal move-into-descendant.
 */
function isProperPrefix(prefix: string[], tokens: string[]): boolean {
  if (prefix.length >= tokens.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== tokens[i]) return false;
  }
  return true;
}
