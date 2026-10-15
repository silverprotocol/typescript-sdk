/**
 * clone.ts — INTERNAL (not re-exported from index.ts).
 *
 * The deep copy the fold and its helpers use for isolation (push, the
 * snapshot stores, result(), the persistable projection, JSON Patch). It is
 * core's own, so core never needs the host's global `structuredClone`, which
 * some JavaScript engines (React Native's Hermes among them) do not provide.
 */

/**
 * Thrown by {@link cloneValue} for a value it does not copy. The fold's push
 * catches it and folds the event as pushed, as it did for a value the global
 * `structuredClone` refused.
 */
export class CloneError extends TypeError {
  constructor(what: string) {
    super(`cloneValue: ${what} cannot be cloned`);
    this.name = "CloneError";
  }
}

/** A built-in object `structuredClone` copies by type; this clone does not copy it. */
function isTypedBuiltin(x: object): boolean {
  return (
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
 * A deep copy of `v` with the global `structuredClone`'s result on every value
 * the fold holds: primitives (`undefined`, `-0`, `NaN` and BigInt included)
 * as they are; an array as an array of the same length, holes kept and
 * `undefined` kept (never `null`); any other object as an ordinary object of
 * its own enumerable string-keyed members in their order, each read once (a
 * getter runs once), an own `__proto__` member DEFINED as an own member, the
 * prototype the ordinary one. A node reached twice is copied once and a cycle
 * is copied as a cycle. The copy is iterative, so no nesting depth overflows
 * the stack.
 *
 * Throws {@link CloneError}, as `structuredClone` throws, on a function or a
 * symbol anywhere in `v`. Unlike `structuredClone`, it also throws on a
 * built-in it would copy by type (a Date, RegExp, Map, Set, Error, ArrayBuffer
 * or typed array, a boxed primitive): no AgJSON value holds one.
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
      if (!Array.isArray(x) && isTypedBuiltin(x)) throw new CloneError("a typed built-in object");
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
