/**
 * clone.ts — INTERNAL (not re-exported from index.ts).
 *
 * The deep copy the fold and its helpers use for isolation (push, the
 * snapshot stores, result(), the persistable projection, JSON Patch). It is
 * core's own, so core never needs the host's global `structuredClone`, which
 * some JavaScript engines (React Native's Hermes among them) do not provide.
 */

/**
 * Thrown by {@link cloneValue} for a function or a symbol, the values the global
 * `structuredClone` refuses too. The fold's push catches it and folds the
 * event as pushed, as it always did.
 */
export class CloneError extends TypeError {
  constructor(what: string) {
    super(`cloneValue: ${what} cannot be cloned`);
    this.name = "CloneError";
  }
}

/** The Object.prototype.toString tags of the built-ins `structuredClone` copies by type. */
const TYPED_BUILTIN_TAGS = new Set([
  "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Error",
  "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "Boolean", "Number", "String", "BigInt", "Symbol",
]);

/**
 * A built-in object `structuredClone` copies by type; this clone carries it by
 * reference. Decided by the object's tag as well as by `instanceof`, so a
 * built-in from another realm (a vm context, an iframe), which no `instanceof`
 * here recognises, is carried the same way rather than copied as a plain object.
 */
function isTypedBuiltin(x: object): boolean {
  return (
    TYPED_BUILTIN_TAGS.has(Object.prototype.toString.call(x).slice(8, -1)) ||
    x instanceof Date ||
    x instanceof RegExp ||
    x instanceof Map ||
    x instanceof Set ||
    x instanceof WeakMap ||
    x instanceof WeakSet ||
    x instanceof Promise ||
    x instanceof Error ||
    x instanceof ArrayBuffer ||
    ArrayBuffer.isView(x) ||
    x instanceof Boolean ||
    x instanceof Number ||
    x instanceof String ||
    (typeof SharedArrayBuffer === "function" && x instanceof SharedArrayBuffer)
  );
}

/**
 * A deep copy of `v`, with these results. Primitives (`undefined`, `-0`, `NaN`
 * and BigInt included) are returned as they are. An array becomes an array of
 * the same length, holes kept and `undefined` kept (never `null`). A typed
 * built-in (a Date, RegExp, Map, Set, WeakMap, WeakSet, Promise, Error,
 * ArrayBuffer, SharedArrayBuffer, DataView or typed array, a boxed primitive),
 * from this realm or another, is NOT copied: the copy holds that object itself,
 * shared with `v`. Any other object becomes an ordinary object of its own
 * enumerable string-keyed members in their order, each read once (a getter
 * runs once), an own `__proto__` member DEFINED as an own member. A node
 * reached twice is copied once, and a cycle is copied as a cycle. The copy is
 * iterative, so no nesting depth overflows the stack.
 *
 * On a JSON value, and on these with `undefined`, holes, shared nodes or
 * cycles in them, the result is the global `structuredClone`'s. The two differ
 * on a typed built-in: `structuredClone` copies most of them by type and throws
 * on a WeakMap, WeakSet, Promise or boxed symbol, where this clone shares each
 * one. No AgJSON value holds a typed built-in.
 *
 * Throws {@link CloneError}, as `structuredClone` throws, on a function or a
 * symbol anywhere in `v`.
 */
export function cloneValue<T>(v: T): T {
  const copies = new Map<object, unknown[] | Record<string, unknown>>();
  const pending: object[] = [];
  const copyOf = (x: unknown): unknown => {
    if (typeof x === "function") throw new CloneError("a function");
    if (typeof x === "symbol") throw new CloneError("a symbol");
    if (x === null || typeof x !== "object") return x;
    let c = copies.get(x);
    if (c === undefined) {
      if (!Array.isArray(x) && isTypedBuiltin(x)) return x; // carried by reference
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
    for (const k of Object.keys(x)) {
      // DEFINED, never assigned: an own `__proto__` member stays an own member.
      Object.defineProperty(c, k, {
        value: copyOf((x as Record<string, unknown>)[k]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return root as T;
}
