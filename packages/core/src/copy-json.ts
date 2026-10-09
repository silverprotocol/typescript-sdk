/**
 * copy-json.ts — INTERNAL (not re-exported from index.ts).
 *
 * The one own-property deep copy every consumer-side reader in core uses, so
 * the §13 rule on `__proto__` has a single code path: stage-1 ingest
 * (ingest.ts), the stored-record readers (record.ts) and the input check
 * (input-check.ts).
 */
import type { JsonValue } from "./agjson.js";

/**
 * Own-property deep copy of a JSON value, dropping `__proto__` at every depth.
 * The copy is iterative, so no nesting depth overflows the stack; a node
 * reached twice is copied once.
 */
export function copyJson(v: JsonValue): JsonValue {
  type Node = JsonValue[] | { [k: string]: JsonValue };
  const copies = new Map<object, Node>();
  const pending: object[] = [];
  const copyOf = (x: JsonValue): JsonValue => {
    if (x === null || typeof x !== "object") return x;
    let c = copies.get(x);
    if (c === undefined) {
      c = Array.isArray(x) ? [] : {};
      copies.set(x, c);
      pending.push(x);
    }
    return c;
  };
  const root = copyOf(v);
  while (pending.length > 0) {
    const x = pending.pop()!;
    const c = copies.get(x)!;
    if (Array.isArray(x)) {
      for (const item of x) (c as JsonValue[]).push(copyOf(item));
      continue;
    }
    for (const k of Object.keys(x)) {
      if (k === "__proto__") continue;
      // DEFINED, never assigned (belt and braces with the skip above).
      Object.defineProperty(c, k, {
        value: copyOf((x as { [k: string]: JsonValue })[k]!),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return root;
}
