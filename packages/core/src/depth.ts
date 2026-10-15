/**
 * depth.ts — INTERNAL (not re-exported from index.ts).
 *
 * The nesting check run before a value reaches a recursive reader (the schema
 * parse, a deep copy, a JSON Patch application), so that a value nested
 * past a bound is turned away instead of overflowing the call stack.
 */

import type { JsonValue } from "./agjson.js";

/** What one scan of a value found: a node past the bound, and an own `__proto__` member. */
export interface DepthScan {
  tooDeep: boolean;
  hasOwnProto: boolean;
}

/**
 * The objects the fast walk visits before it hands the value to the walk that
 * remembers each node. A JSON-parsed value shares no node, so the memory is
 * overhead for it; a value that shares nodes can make the fast walk revisit
 * them without end, and the budget turns that into the remembering walk.
 */
const SCAN_NODE_BUDGET = 50_000;

/**
 * One iterative pass: whether some node sits deeper than `max` (the root at
 * depth 0, a node's depth the number of containers above it), and whether any
 * object other than an array holds an own `__proto__` member. It visits every
 * object and array, as deleteOwnProtoMember does. With `remember`, a node
 * reached again is walked again only when it is reached deeper than before;
 * without, it returns undefined once it has visited SCAN_NODE_BUDGET objects.
 */
function scanPass(v: unknown, max: number, remember: boolean): DepthScan | undefined {
  const deepest = remember ? new WeakMap<object, number>() : undefined;
  let visits = 0;
  let hasOwnProto = false;
  const nodes: unknown[] = [v];
  const depths: number[] = [0];
  while (nodes.length > 0) {
    const x = nodes.pop();
    const depth = depths.pop()!;
    if (depth > max) return { tooDeep: true, hasOwnProto };
    if (x === null || typeof x !== "object") continue;
    if (deepest !== undefined) {
      const seen = deepest.get(x);
      if (seen !== undefined && seen >= depth) continue;
      deepest.set(x, depth);
    } else if (++visits > SCAN_NODE_BUDGET) {
      return undefined;
    }
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        nodes.push(x[i]);
        depths.push(depth + 1);
      }
      continue;
    }
    if (Object.hasOwn(x, "__proto__")) hasOwnProto = true;
    for (const k of Object.keys(x)) {
      nodes.push((x as Record<string, unknown>)[k]);
      depths.push(depth + 1);
    }
  }
  return { tooDeep: false, hasOwnProto };
}

/**
 * Scan `v` once, never throwing: the fast pass, then, when it runs past its
 * budget, the pass that remembers each node, so a cycle is too deep and a
 * large value is still scanned whole (never turned away for its size). A
 * value it cannot read (a getter or proxy trap that throws) answers not too
 * deep and holding the member, leaving it to the paths that handled it before.
 */
export function scanDepth(v: unknown, max: number): DepthScan {
  try {
    return scanPass(v, max, false) ?? scanPass(v, max, true)!;
  } catch {
    return { tooDeep: false, hasOwnProto: true };
  }
}

/** True when some node of `v` sits deeper than `max`; see {@link scanDepth}. */
export function exceedsDepth(v: unknown, max: number): boolean {
  return scanDepth(v, max).tooDeep;
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
