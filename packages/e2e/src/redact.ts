/**
 * redact.ts — capture-time scrub of account-identifying values in native events.
 *
 * A capture records the framework's native stream verbatim, and some
 * frameworks put the provider's raw HTTP response headers on the wire (the
 * vercel facet's `finish-step.response.headers`). A few of those headers
 * identify the capturing account and must never reach the public corpus.
 * runCapture passes every native event through redactNative() before it is
 * normalized, censused or written, so capture and replay see the same bytes.
 *
 * Only VALUES are replaced (with REDACTED); keys stay, so the census still
 * sees the path and its allowlist disposition. Request ids are deliberately
 * NOT redacted: they identify one request, not the account, and every live
 * claude seed has carried request_id since echo-sonnet5.
 */
import type { JsonValue } from "@silverprotocol/core";

export const REDACTED = "<redacted>";

/** Header/field names (matched case-insensitively, at any depth) whose values are redacted. */
export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  "openai-organization",
  "openai-project",
  "anthropic-organization-id",
  "set-cookie",
  "cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
]);

/** Returns a copy of `value` with every REDACTED_KEYS value replaced by REDACTED. */
export function redactNative(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactNative);
  if (value === null || typeof value !== "object") return value;
  const out: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? REDACTED : redactNative(v);
  }
  return out;
}
