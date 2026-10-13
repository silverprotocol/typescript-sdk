/**
 * copy-json.ts
 *
 * The one own-property deep copy every consumer-side reader in core uses, so
 * the §13.7 rule on `__proto__` has a single code path: stage-1 ingest
 * (ingest.ts), the stored-record readers (record.ts) and the input check
 * (input-check.ts). `copyJson` is exported for hosts that seed a fold from
 * their own store. The two walks below apply the same omission on the fold's
 * and the emitter's own paths.
 */
import type { JsonValue } from "./agjson.js";

/**
 * Own-property deep copy of a JSON value, dropping an own `__proto__` member at
 * every depth. Every object and array in the copy has the ordinary prototype.
 * A host that seeds a fold from its own store copies the stored value with it.
 * The copy is iterative, so no nesting depth overflows the stack; a node
 * reached twice is copied once.
 *
 * @beta
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

const PROTO = "__proto__";

/** True for an object this module treats as a JSON node: an array or a plain-or-null-prototype object. */
function isPlainNode(v: object): boolean {
  if (Array.isArray(v)) return true;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * INTERNAL. Removes an own `__proto__` member at every depth of a value the
 * caller owns (a structuredClone copy). `delete` removes own members only, so
 * a node without one is untouched. The walk is iterative and visits each
 * object once, so neither nesting depth nor a cycle bounds it.
 */
export function deleteOwnProtoMember(v: unknown): void {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (x === null || typeof x !== "object" || seen.has(x)) continue;
    seen.add(x);
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) stack.push(x[i]);
      continue;
    }
    const o = x as Record<string, unknown>;
    if (Object.hasOwn(o, PROTO)) delete o[PROTO];
    for (const k in o) if (Object.hasOwn(o, k)) stack.push(o[k]);
  }
}

/**
 * INTERNAL. A copy of `v` without an own `__proto__` member at any depth that
 * never mutates `v`: when any node holds the member, its arrays and plain (or
 * null-prototype) objects are rebuilt with the ordinary prototype, members DEFINED, never
 * assigned; any other value (a function, a class instance) is carried by
 * reference. Returns `v` itself when no node holds the member, so the common
 * case allocates nothing. Both walks are iterative and visit each object once:
 * a node reached twice is copied once, and a cycle is copied as a cycle.
 */
export function withoutOwnProtoMember<T>(v: T): T {
  return (hasOwnProtoMember(v) ? rebuild(v) : v) as T;
}

/**
 * The plain nodes the fast pass visits before it hands the value to the pass
 * that remembers each node. An emitted event is a tree, so remembering costs
 * it a WeakSet entry per node for nothing; a value that shares nodes or holds a
 * cycle can make the fast pass revisit them without end, and the budget turns
 * that into the remembering pass. The fold side's scan (depth.ts) works the
 * same way.
 */
const PROTO_SCAN_NODE_BUDGET = 50_000;

function hasOwnProtoMember(v: unknown): boolean {
  return protoScan(v, false) ?? protoScan(v, true)!;
}

/**
 * One iterative pass over the arrays and plain (or null-prototype) objects of
 * `v`: whether any such object holds an own `__proto__` member. With
 * `remember`, each node is visited once; without, it returns undefined once it
 * has visited PROTO_SCAN_NODE_BUDGET nodes.
 */
function protoScan(v: unknown, remember: boolean): boolean | undefined {
  const seen = remember ? new WeakSet<object>() : undefined;
  let visits = 0;
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (x === null || typeof x !== "object" || !isPlainNode(x)) continue;
    if (seen !== undefined) {
      if (seen.has(x)) continue;
      seen.add(x);
    } else if (++visits > PROTO_SCAN_NODE_BUDGET) {
      return undefined;
    }
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) stack.push(x[i]);
      continue;
    }
    if (Object.hasOwn(x, PROTO)) return true;
    for (const k of Object.keys(x)) stack.push((x as Record<string, unknown>)[k]);
  }
  return false;
}

function rebuild(v: unknown): unknown {
  const copies = new Map<object, unknown[] | Record<string, unknown>>();
  const pending: object[] = [];
  const copyOf = (x: unknown): unknown => {
    if (x === null || typeof x !== "object" || !isPlainNode(x)) return x;
    let c = copies.get(x);
    if (c === undefined) {
      c = Array.isArray(x) ? new Array<unknown>(x.length) : {};
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
      for (let i = 0; i < x.length; i++) if (i in x) (c as unknown[])[i] = copyOf(x[i]);
      continue;
    }
    for (const k of Object.keys(x)) {
      if (k === PROTO) continue;
      Object.defineProperty(c, k, {
        value: copyOf((x as Record<string, unknown>)[k]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return root;
}
