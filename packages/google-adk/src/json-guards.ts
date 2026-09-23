/**
 * JSON-shape guards shared by the facet's modules. Internal to
 * @silverprotocol/google-adk (not part of its package exports).
 */
import type { JsonValue } from "@silverprotocol/core";

/** True for a non-null, non-array plain JSON object (guard idiom from the OpenAI facet). */
export function isJsonObject(v: unknown): v is { readonly [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─── genai-optional arm members (adk-13 hardening) ───────────────────────────
// A Part arm's member when it is a string, else undefined. Read through
// `unknown` + `isJsonObject` so a JSON-null arm (a snake_case serializer that
// keeps None) is guarded too, never dereferenced.
export function stringMember(arm: unknown, key: string): string | undefined {
  if (!isJsonObject(arm)) return undefined;
  const v = arm[key];
  return typeof v === "string" ? v : undefined;
}
