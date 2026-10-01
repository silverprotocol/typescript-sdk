/**
 * JSON-shape guards shared by the facet's modules. Internal to
 * @silverprotocol/google-adk (not part of its package exports).
 */
import type { JsonValue } from "@silverprotocol/core";

/** True for a non-null, non-array plain JSON object (guard idiom from the OpenAI facet). */
export function isJsonObject(v: unknown): v is { readonly [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─── genai-optional arm members (hardening) ───────────────────────────────────
// A Part arm's member when it is a string, else undefined. Read through
// `unknown` + `isJsonObject` so a JSON-null arm (a snake_case serializer that
// keeps None) is guarded too, never dereferenced.
export function stringMember(arm: unknown, key: string): string | undefined {
  if (!isJsonObject(arm)) return undefined;
  const v = arm[key];
  return typeof v === "string" ? v : undefined;
}

// ─── members named __proto__ (SPEC §13.7) ─────────────────────────────────────
// A native read from JSON can hold an own member named `__proto__` (JSON.parse
// makes one, and core keeps it as data when it reads a native). §13.7 has such
// a member dropped, at every depth, and never passed through: push() reads
// every native through withoutProtoMembers before anything else reads it, so
// no carry passes one on and no copy can take one as its prototype.

/** True when the value holds an own member named `__proto__`, at any depth. */
function holdsProtoMember(v: JsonValue): boolean {
  if (Array.isArray(v)) return v.some(holdsProtoMember);
  if (!isJsonObject(v)) return false;
  return Object.hasOwn(v, "__proto__") || Object.values(v).some(holdsProtoMember);
}

/** An own-property copy of the value without its `__proto__` members, at every depth. */
function copyWithoutProtoMembers(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(copyWithoutProtoMembers);
  if (!isJsonObject(v)) return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => k !== "__proto__")
      .map(([k, member]): [string, JsonValue] => [k, copyWithoutProtoMembers(member)]),
  );
}

/** The value without its members named `__proto__`, at every depth: the value
 *  itself when it holds none (nothing is copied), else an own-property copy
 *  without them, every other member kept. The argument is not changed. */
export function withoutProtoMembers(v: JsonValue): JsonValue {
  return holdsProtoMember(v) ? copyWithoutProtoMembers(v) : v;
}
