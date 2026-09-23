/**
 * input-check.ts — the reference AgInput receiver check (draft.4 §0.2,
 * workspace#20 decision 6, founder ruling 2026-09-23: option 1, "omit the
 * element, reject the input").
 *
 * A receiver passes unknown object fields through untouched, and REJECTS THE
 * WHOLE INPUT, before acting on any part of it, when the input carries at any
 * depth a value this specification does not define in a closed set
 * (`AgInput.kind`, `AgHitlAnswer.status`, `AgReasoningConfig.effort`, an
 * `AgBlock` `type` inside `messages`, `run.system`, `run.context` or
 * `results[].content`, …). The rejection is typed and names the path:
 *
 * - `unknown-value`: the value at the path is a STRING outside the set there
 *   (zod's codes alone cannot tell this from malformed, so the rule reads the
 *   raw value: SPEC §0.2, bar finding CB-6);
 * - `malformed`: anything else that fails the schema (a missing value, a value
 *   of the wrong JSON type, a non-JSON input);
 * - `major-mismatch`: `version` names another major (§12), checked first.
 *
 * With several problems, the first one in schema order is reported. An
 * accepted input comes back as an own-property deep copy of the RAW value, so
 * unknown fields stay intact at every depth (`__proto__` dropped, as ingest).
 * A sender that receives `unknown-value` at a path inside an `AgBlock[]` MAY
 * resend without that element.
 */
import { AGJSON_VERSION, AgInput, type JsonValue } from "./agjson.js";
import { copyJson } from "./copy-json.js";
import { isJsonValue } from "./wire.js";

export type AgInputCheckCode = "unknown-value" | "malformed" | "major-mismatch";

export type AgInputCheck =
  | { ok: true; input: AgInput }
  | { ok: false; code: AgInputCheckCode; path: (string | number)[] };

type Path = (string | number)[];

/** A zod issue, as far as this check reads it. */
interface Issue {
  code: string;
  path: PropertyKey[];
  values?: readonly unknown[];
  options?: readonly unknown[];
  errors?: Issue[][];
}

/** The raw value at `path`, read through own properties only. */
function at(root: unknown, path: Path): unknown {
  let v: unknown = root;
  for (const k of path) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, k)) return undefined;
    v = (v as Record<string | number, unknown>)[k];
  }
  return v;
}

const toPath = (p: PropertyKey[]): Path => p.filter((k): k is string | number => typeof k !== "symbol");

/**
 * Classify one issue. `unknown-value` iff the raw value at its path is a string
 * outside the closed set there: an enum's `values`, a discriminator's
 * `options`, or, for a plain union, any branch that classifies so. Otherwise
 * `malformed`, at the path of the branch the value came nearest to.
 */
function classify(root: unknown, issue: Issue, prefix: Path): { code: "unknown-value" | "malformed"; path: Path } {
  const path = [...prefix, ...toPath(issue.path)];
  const raw = at(root, path);
  const set = issue.code === "invalid_value" ? issue.values : issue.code === "invalid_union" ? issue.options : undefined;
  if (set !== undefined && typeof raw === "string" && !set.includes(raw)) return { code: "unknown-value", path };
  if (issue.code === "invalid_union" && issue.errors !== undefined && issue.errors.length > 0) {
    const branches = issue.errors
      .filter((b) => b.length > 0)
      .map((b) => classify(root, b[0]!, path));
    const unknown = branches.find((b) => b.code === "unknown-value");
    if (unknown !== undefined) return unknown;
    // The deepest branch path is the shape the value most nearly matched.
    const nearest = branches.reduce<{ code: "malformed"; path: Path } | undefined>(
      (best, b) => (best === undefined || b.path.length > best.path.length ? { code: "malformed", path: b.path } : best),
      undefined,
    );
    if (nearest !== undefined) return nearest;
  }
  return { code: "malformed", path };
}

const MAJOR = AGJSON_VERSION.split(".")[0];

/**
 * Check a received AgInput (draft.4 §0.2). Returns the input, unknown fields
 * intact, or a typed rejection naming the path.
 */
export function checkAgInput(raw: unknown): AgInputCheck {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "version")) {
    const version = (raw as { version?: unknown }).version;
    if (typeof version === "string" && /^\d+\./.test(version) && version.split(".")[0] !== MAJOR) {
      return { ok: false, code: "major-mismatch", path: ["version"] };
    }
  }
  if (!isJsonValue(raw)) return { ok: false, code: "malformed", path: [] };
  const parsed = AgInput.safeParse(raw);
  if (parsed.success) return { ok: true, input: copyJson(raw as JsonValue) as unknown as AgInput };
  const first = parsed.error.issues[0] as unknown as Issue | undefined;
  if (first === undefined) return { ok: false, code: "malformed", path: [] };
  return { ok: false, ...classify(raw, first, []) };
}
