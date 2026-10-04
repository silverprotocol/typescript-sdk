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
 *
 * @beta
 */
export function copyJson(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(copyJson);
  if (v === null || typeof v !== "object") return v;
  const out: { [k: string]: JsonValue } = {};
  for (const k of Object.keys(v)) {
    if (k === "__proto__") continue;
    // DEFINED, never assigned (belt and braces with the skip above).
    Object.defineProperty(out, k, {
      value: copyJson((v as { [k: string]: JsonValue })[k]!),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

const PROTO = "__proto__";

/** Walk depth past which a node is left as is: a cycle, or nesting no JSON text reaches. */
const MAX_WALK_DEPTH = 512;

/** True for an object this module treats as a JSON node: an array or a plain-or-null-prototype object. */
function isPlainNode(v: object): boolean {
  if (Array.isArray(v)) return true;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * INTERNAL. Removes an own `__proto__` member at every depth of a value the
 * caller owns (a structuredClone copy). `delete` removes own members only, so
 * a node without one is untouched. A cycle stops at {@link MAX_WALK_DEPTH}.
 */
export function deleteOwnProtoMember(v: unknown, depth = 0): void {
  if (v === null || typeof v !== "object" || depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) deleteOwnProtoMember(v[i], depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  if (Object.hasOwn(o, PROTO)) delete o[PROTO];
  for (const k in o) if (Object.hasOwn(o, k)) deleteOwnProtoMember(o[k], depth + 1);
}

/**
 * INTERNAL. A copy of `v` without an own `__proto__` member at any depth that
 * never mutates `v`: when any node holds the member, its arrays and plain (or
 * null-prototype) objects are rebuilt with the ordinary prototype, members DEFINED, never
 * assigned; any other value (a function, a class instance) is carried by
 * reference. Returns `v` itself when no node holds the member, so the common
 * case allocates nothing. A cycle stops at {@link MAX_WALK_DEPTH}.
 */
export function withoutOwnProtoMember<T>(v: T): T {
  return (hasOwnProtoMember(v, 0) ? rebuild(v, 0) : v) as T;
}

function hasOwnProtoMember(v: unknown, depth: number): boolean {
  if (v === null || typeof v !== "object" || depth > MAX_WALK_DEPTH || !isPlainNode(v)) return false;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (hasOwnProtoMember(v[i], depth + 1)) return true;
    return false;
  }
  const o = v as Record<string, unknown>;
  if (Object.hasOwn(o, PROTO)) return true;
  for (const k in o) if (Object.hasOwn(o, k) && hasOwnProtoMember(o[k], depth + 1)) return true;
  return false;
}

function rebuild(v: unknown, depth: number): unknown {
  if (v === null || typeof v !== "object" || depth > MAX_WALK_DEPTH || !isPlainNode(v)) return v;
  if (Array.isArray(v)) return v.map((item) => rebuild(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    if (k === PROTO) continue;
    Object.defineProperty(out, k, {
      value: rebuild((v as Record<string, unknown>)[k], depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
