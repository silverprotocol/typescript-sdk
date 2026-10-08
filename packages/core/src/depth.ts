/**
 * depth.ts — INTERNAL (not re-exported from index.ts).
 *
 * The nesting check run before a value reaches a recursive reader (the schema
 * parse, structuredClone, a JSON Patch application), so that a value nested
 * past a bound is turned away instead of overflowing the call stack.
 */

import type { JsonValue } from "./agjson.js";

/**
 * True when some node of `v` sits deeper than `max`, the root at depth 0 and a
 * node's depth the number of containers above it. The walk is iterative, so it
 * never overflows the stack, and a node reached again is walked again only
 * when it is reached deeper than before; a cycle is therefore too deep. It
 * never throws: a value it cannot read (a getter or proxy trap that throws)
 * answers false, leaving that value to the paths that handled it before.
 */
export function exceedsDepth(v: unknown, max: number): boolean {
  try {
    const deepest = new WeakMap<object, number>();
    const stack: Array<[unknown, number]> = [[v, 0]];
    while (stack.length > 0) {
      const [x, depth] = stack.pop()!;
      if (depth > max) return true;
      if (x === null || typeof x !== "object") continue;
      const seen = deepest.get(x);
      if (seen !== undefined && seen >= depth) continue;
      deepest.set(x, depth);
      if (Array.isArray(x)) {
        for (let i = 0; i < x.length; i++) stack.push([x[i], depth + 1]);
        continue;
      }
      for (const k of Object.keys(x)) stack.push([(x as Record<string, unknown>)[k], depth + 1]);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * isJsonValue's test with a caller's depth bound in place of
 * JSON_SAFE_MAX_DEPTH: true when `v` is a plain JSON value (null, a string, a
 * boolean, a finite number other than -0, an array with no holes, or a plain
 * or null-prototype object without an own toJSON, of such values) whose
 * deepest node sits no deeper than `max`, the root at depth 0. Iterative, so
 * it never overflows the stack; a cycle is too deep. Never throws: a value it
 * cannot read answers false.
 */
export function isJsonValueWithin(v: unknown, max: number): v is JsonValue {
  try {
    const deepest = new WeakMap<object, number>();
    const stack: Array<[unknown, number]> = [[v, 0]];
    while (stack.length > 0) {
      const [x, depth] = stack.pop()!;
      if (depth > max) return false;
      if (x === null) continue;
      switch (typeof x) {
        case "string":
        case "boolean":
          continue;
        case "number":
          if (!Number.isFinite(x) || Object.is(x, -0)) return false;
          continue;
        case "object":
          break;
        default:
          return false; // undefined, function, symbol, bigint
      }
      const o = x as object;
      const seen = deepest.get(o);
      if (seen !== undefined && seen >= depth) continue;
      deepest.set(o, depth);
      if (Array.isArray(o)) {
        for (let i = 0; i < o.length; i++) {
          if (!(i in o)) return false;
          stack.push([o[i], depth + 1]);
        }
        continue;
      }
      const proto: unknown = Object.getPrototypeOf(o);
      if (proto !== Object.prototype && proto !== null) return false;
      if (typeof (o as { toJSON?: unknown }).toJSON === "function") return false;
      for (const k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k)) stack.push([(o as Record<string, unknown>)[k], depth + 1]);
      }
    }
    return true;
  } catch {
    return false;
  }
}
