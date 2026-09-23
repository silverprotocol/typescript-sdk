/**
 * Wire projection (audit D5-a). SPEC §0.1 asserts every AgEvent is a plain
 * JSON value, but TypeScript cannot PROVE `AgEvent extends JsonValue`
 * (structural interfaces like AgUsage lack index signatures). These helpers
 * are the single sanctioned crossing: a JSON round-trip typed at the
 * boundary — never a cast. The wire.test round-trip suite is the executable
 * proof that the projection is byte-faithful.
 */
import type { AgEvent, JsonValue } from "./agjson.js";

export function toWire(e: AgEvent): JsonValue {
  const w: JsonValue = JSON.parse(JSON.stringify(e));
  return w;
}

export function toJsonValue(v: unknown): JsonValue {
  const w: JsonValue = JSON.parse(JSON.stringify(v));
  return w;
}

/** The value a cycle is replaced with by {@link toJsonValueSafe} (at the repeated node only). */
export const JSON_SAFE_CIRCULAR = "[Circular]";
/** The value a node nested deeper than {@link JSON_SAFE_MAX_DEPTH} is replaced with. */
export const JSON_SAFE_MAX_DEPTH_MARK = "[MaxDepth]";
/** The nesting depth past which the helpers stop descending (never reached by real data). */
export const JSON_SAFE_MAX_DEPTH = 1000;

/** Why {@link toJsonValueSafe} had to degrade a node that `JSON.stringify` would have thrown on. */
export type JsonSafeIssueKind =
  | "bigint" // converted to its decimal string
  | "circular" // replaced with JSON_SAFE_CIRCULAR
  | "throwing-toJSON" // member omitted (null in an array / at the top)
  | "throwing-getter" // member omitted (null in an array)
  | "throwing-keys" // the node's keys could not be enumerated: node omitted
  | "max-depth"; // replaced with JSON_SAFE_MAX_DEPTH_MARK

/** One degraded node: `path` is `$` for the top, then `.key` / `[index]` segments. */
export interface JsonSafeIssue {
  path: string;
  kind: JsonSafeIssueKind;
}

/**
 * True when `v` is ALREADY a plain JSON value, i.e. exactly what a JSON
 * round-trip of it would produce: `null`, a string, a boolean, a finite
 * number other than `-0`, an array with no holes, or a plain object (prototype
 * `Object.prototype` or `null`, no own `toJSON`) of such values, acyclic and
 * shallower than {@link JSON_SAFE_MAX_DEPTH}. Never throws (a throwing getter
 * or proxy trap answers `false`). The walk allocates nothing per node beyond
 * an ancestor stack, so a facet can afford it on every native event.
 */
export function isJsonValue(v: unknown): v is JsonValue {
  const ancestors: object[] = [];
  const walk = (x: unknown, depth: number): boolean => {
    if (x === null) return true;
    switch (typeof x) {
      case "string":
      case "boolean":
        return true;
      case "number":
        return Number.isFinite(x) && !Object.is(x, -0);
      case "object":
        break;
      default:
        return false; // undefined, function, symbol, bigint
    }
    const o = x as object;
    if (depth >= JSON_SAFE_MAX_DEPTH || ancestors.includes(o)) return false;
    ancestors.push(o);
    try {
      if (Array.isArray(o)) {
        for (let i = 0; i < o.length; i++) {
          if (!(i in o) || !walk(o[i], depth + 1)) return false;
        }
        return true;
      }
      const proto: unknown = Object.getPrototypeOf(o);
      if (proto !== Object.prototype && proto !== null) return false;
      if (typeof (o as { toJSON?: unknown }).toJSON === "function") return false;
      for (const k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
        if (!walk((o as Record<string, unknown>)[k], depth + 1)) return false;
      }
      return true;
    } finally {
      ancestors.pop();
    }
  };
  try {
    return walk(v, 0);
  } catch {
    return false;
  }
}

/**
 * Materialize ANY live value as a `JsonValue`, and never throw.
 *
 * TOTAL by contract: for every input it returns a `JsonValue`. It never
 * throws and never returns anything that is not JSON; the degraded forms below
 * are themselves JSON (a string, or an omitted member).
 *
 * For a facet at a LIVE boundary (in practice once, on the whole native, at
 * `push()` entry): a framework hands over in-process objects that may hold
 * `undefined`, a `Date`, `NaN`, a `BigInt`, a function, a cycle or a throwing
 * getter. `JsonValue.parse` is a validator, and it throws on those;
 * `toJsonValue` (a JSON round-trip) throws on a BigInt or a cycle. A
 * Normalizer MUST NOT throw out of `push()` (SPEC.md §8.0). Keep
 * `JsonValue.parse` for validating data that is already JSON.
 *
 * Plain JSON input (see {@link isJsonValue}) is returned UNCHANGED, as the same
 * reference, with no copy. Anything else is rebuilt as a fresh value that
 * applies `JSON.stringify`'s own rules per node, so for JSON-able input the
 * result serializes identically to `toJsonValue(v)`:
 * - `toJSON` is honoured once per node, with the member key (a `Date` becomes
 *   its ISO string; a class instance defining `toJSON` becomes its result);
 * - boxed `Number` / `String` / `Boolean` / `BigInt` are unwrapped;
 * - `NaN` and ±`Infinity` become `null`, and `-0` becomes `0`;
 * - an `undefined`, function or symbol member is omitted from an object, and
 *   becomes `null` in an array (a hole too);
 * - an object contributes its own enumerable string keys, in `Object.keys`
 *   order (a `Map` or `Set` therefore becomes `{}`, as in JSON).
 *
 * Where `JSON.stringify` would throw, it degrades per node instead and keeps
 * every JSON-able sibling:
 * - a `BigInt` becomes its decimal string;
 * - a cycle becomes {@link JSON_SAFE_CIRCULAR} at the node that repeats an
 *   ancestor. A value shared by two branches but not its own ancestor is
 *   serialized in full each time, as JSON does;
 * - a throwing `toJSON` or getter omits that member (`null` in an array and
 *   for the top-level value);
 * - a node whose keys cannot be enumerated (e.g. a proxy trap throws) is
 *   omitted likewise;
 * - nesting past {@link JSON_SAFE_MAX_DEPTH} levels becomes
 *   {@link JSON_SAFE_MAX_DEPTH_MARK}, so a pathological structure cannot
 *   overflow the stack.
 *
 * A `__proto__` key is kept as an ordinary own data member on BOTH paths (as
 * `JSON.parse` does), never as a prototype. The helper does not strip it: a
 * consumer that must drop it does so downstream (ingest's copy does, and the
 * facets' scrub/allowlist paths skip it explicitly). A top-level value that
 * JSON would drop (`undefined`, a function, a symbol) returns `null`. To learn
 * WHICH nodes degraded, use {@link toJsonValueSafeWithIssues}.
 *
 * ALIASING: unlike `toJsonValue` (which always deep-copies through a JSON
 * round-trip), plain input is returned BY REFERENCE, so its nodes can end up
 * inside emitted events. A caller that needs isolation copies the result
 * ({@link isJsonValue} is the cheap check). A facet must neither mutate the
 * returned value nor retain it past the `push()` that produced it.
 */
export function toJsonValueSafe(v: unknown): JsonValue {
  return toJsonValueSafeWithIssues(v).value;
}

/**
 * {@link toJsonValueSafe}, plus the list of nodes it had to degrade (empty when
 * the input was JSON-able). A consumer that must not forward an invented value
 * can branch on `issues.length > 0` instead of using `value`.
 */
export function toJsonValueSafeWithIssues(v: unknown): { value: JsonValue; issues: readonly JsonSafeIssue[] } {
  if (isJsonValue(v)) return { value: v, issues: [] };
  const issues: JsonSafeIssue[] = [];
  const ancestors: object[] = [];
  const OMIT = Symbol("omit");
  const child = (path: string, key: string, inArray: boolean): string => (inArray ? `${path}[${key}]` : `${path}.${key}`);

  const convert = (value: unknown, key: string, path: string, depth: number): JsonValue | typeof OMIT => {
    let x = value;
    try {
      if (x !== null && (typeof x === "object" || typeof x === "bigint") && typeof (x as { toJSON?: unknown }).toJSON === "function") {
        x = (x as { toJSON: (k: string) => unknown }).toJSON(key);
      }
    } catch {
      issues.push({ path, kind: "throwing-toJSON" });
      return OMIT;
    }
    if (typeof x === "object" && x !== null) {
      if (x instanceof Number) x = Number(x);
      else if (x instanceof String) x = String(x);
      else if (x instanceof Boolean) x = x.valueOf();
      else if (Object.prototype.toString.call(x) === "[object BigInt]") x = (x as { valueOf(): unknown }).valueOf();
    }
    if (x === null) return null;
    switch (typeof x) {
      case "string":
      case "boolean":
        return x;
      case "number":
        return Number.isFinite(x) ? (Object.is(x, -0) ? 0 : x) : null;
      case "bigint":
        issues.push({ path, kind: "bigint" });
        return x.toString();
      case "undefined":
      case "function":
      case "symbol":
        return OMIT;
      default:
        break;
    }
    const obj = x as object;
    if (ancestors.includes(obj)) {
      issues.push({ path, kind: "circular" });
      return JSON_SAFE_CIRCULAR;
    }
    if (depth >= JSON_SAFE_MAX_DEPTH) {
      issues.push({ path, kind: "max-depth" });
      return JSON_SAFE_MAX_DEPTH_MARK;
    }
    ancestors.push(obj);
    try {
      if (Array.isArray(obj)) {
        let length: number;
        try {
          length = obj.length;
        } catch {
          issues.push({ path, kind: "throwing-keys" });
          return OMIT;
        }
        const out: JsonValue[] = [];
        for (let i = 0; i < length; i++) {
          const p = child(path, String(i), true);
          let item: unknown;
          try {
            item = obj[i];
          } catch {
            issues.push({ path: p, kind: "throwing-getter" });
            out.push(null);
            continue;
          }
          const c = convert(item, String(i), p, depth + 1);
          out.push(c === OMIT ? null : c);
        }
        return out;
      }
      let keys: string[];
      try {
        keys = Object.keys(obj);
      } catch {
        issues.push({ path, kind: "throwing-keys" });
        return OMIT;
      }
      const out: { [k: string]: JsonValue } = {};
      for (const k of keys) {
        const p = child(path, k, false);
        let item: unknown;
        try {
          item = (obj as Record<string, unknown>)[k];
        } catch {
          issues.push({ path: p, kind: "throwing-getter" });
          continue;
        }
        const c = convert(item, k, p, depth + 1);
        if (c === OMIT) continue;
        // A data property, never a prototype write, even for "__proto__".
        Object.defineProperty(out, k, { value: c, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally {
      ancestors.pop();
    }
  };

  const top = convert(v, "", "$", 0);
  return { value: top === OMIT ? null : top, issues };
}
