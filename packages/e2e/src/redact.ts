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
 * The Claude CLI likewise records local filesystem paths of the capturing
 * machine (REDACTED_PATH_KEYS: its init `cwd` and `memory_paths`, a background
 * task's output file), which name the operator's home directory.
 *
 * Only VALUES are replaced (with REDACTED, or REDACTED_PATH for a path); keys
 * stay, so the census still sees the path and its allowlist disposition. Request ids are deliberately
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
  // Gemini Live's liveSessionResumptionUpdate.newHandle: a token that resumes
  // the live session (with the account's key), so it never reaches the corpus.
  "newhandle",
]);

/** What every string under a REDACTED_PATH_KEYS key becomes. */
export const REDACTED_PATH = "<redacted-path>";

/**
 * Keys (matched case-insensitively, at any depth) whose values are local
 * filesystem paths of the capturing machine: the Claude CLI's system/init
 * `cwd` and `memory_paths` (its auto-memory directory), and a background
 * task's `output_file` / `outputFile`. They name the operator's home directory
 * and account, so they never reach the public corpus. Every STRING leaf under
 * such a key becomes REDACTED_PATH; keys, nesting and non-string values stay,
 * so the census sees exactly the same paths (`[*].memory_paths.auto` stays a
 * string leaf).
 */
export const REDACTED_PATH_KEYS: ReadonlySet<string> = new Set(["cwd", "memory_paths", "output_file", "outputfile"]);

/**
 * An audio payload (an object whose `mimeType` is audio/*, e.g. Gemini Live's
 * `inlineData {mimeType: "audio/pcm;rate=24000", data}`) keeps its size but
 * never its bytes: its string `data` becomes `<audio-elided:N chars>`. Raw
 * audio is the user's or the model's voice; the corpus carries transcriptions
 * (text), never the audio itself.
 */
export const AUDIO_ELIDED_PREFIX = "<audio-elided:";
const isAudioPayload = (o: { [k: string]: JsonValue }): boolean =>
  typeof o["mimeType"] === "string" && /^audio\//i.test(o["mimeType"]) && typeof o["data"] === "string";

/** Every string leaf of `v` becomes REDACTED_PATH; structure and other values stay. */
function redactPathLeaves(v: JsonValue): JsonValue {
  if (typeof v === "string") return REDACTED_PATH;
  if (Array.isArray(v)) return v.map(redactPathLeaves);
  if (v === null || typeof v !== "object") return v;
  const out: { [k: string]: JsonValue } = {};
  for (const [k, x] of Object.entries(v)) {
    Object.defineProperty(out, k, { value: redactPathLeaves(x), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * Returns a copy of `value` with every REDACTED_KEYS value replaced by REDACTED
 * and every string under a REDACTED_PATH_KEYS key replaced by REDACTED_PATH.
 * Every key is DEFINED, never assigned, so a key named `__proto__` (JSON.parse
 * keeps it as an own property) stays an own data key in the recording: assigning
 * it would silently drop a string value, or set the copy's prototype to an
 * object value.
 */
export function redactNative(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactNative);
  if (value === null || typeof value !== "object") return value;
  const out: { [k: string]: JsonValue } = {};
  const audio = isAudioPayload(value);
  for (const [k, v] of Object.entries(value)) {
    Object.defineProperty(out, k, {
      value: REDACTED_KEYS.has(k.toLowerCase())
        ? REDACTED
        : REDACTED_PATH_KEYS.has(k.toLowerCase())
          ? redactPathLeaves(v)
          : audio && k === "data" && typeof v === "string" && !v.startsWith(AUDIO_ELIDED_PREFIX)
            ? `${AUDIO_ELIDED_PREFIX}${v.length} chars>`
            : redactNative(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
