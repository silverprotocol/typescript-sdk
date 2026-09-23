/**
 * input-check.ts — the reference AgInput receiver check (draft.4 §0.2,
 * workspace#20 decision 6: option 1 "omit the element, reject the input";
 * input classes per the founder's ALT-1 ruling, bar wf_a8a31902-fb5).
 *
 * A receiver passes unknown object fields through untouched, and REJECTS THE
 * WHOLE INPUT, before acting on any part of it, when the input fails this
 * specification's schema in any way other than an unknown field. The
 * rejection names ONE path and ONE class:
 *
 * - `major-mismatch`, at `["version"]`: `version` differs in MAJOR (§12);
 * - `unknown-value`: the value at the path is a STRING that the closed set
 *   there does not define (an `AgInput.kind`, an `AgHitlAnswer.status`, a
 *   reasoning `effort`, an `AgBlock` `type`, …). zod's codes alone cannot
 *   tell this from malformed, so the rule reads the raw value (bar CB-6);
 * - `malformed`: every other failure — a missing value, a value of the wrong
 *   JSON type, a value that breaks a stated constraint, a non-JSON input, or
 *   a `protocol` other than `"agjson"` (it names the protocol; it is not a
 *   closed set). An input that is not a JSON object is malformed at `[]`.
 *
 * Order and scope: `protocol` is judged first, then `version`, then the rest.
 * The `AgInputEnvelope` members are checked whatever the `kind`; a member that
 * only an undefined `kind` would select is not checked, nor any other member of
 * an `AgBlock` whose `type` is undefined. When the rest has both malformed and
 * unknown-value problems, the class is malformed, at the path of the first
 * malformed problem in the reference's order; otherwise the first
 * unknown-value. Inside a plain union, only a branch whose shape fits the
 * value's JSON type is read (a string against an enum branch, an object
 * against an object branch).
 *
 * An accepted input comes back as an own-property deep copy of the RAW value,
 * so unknown fields stay intact at every depth (`__proto__` dropped, as
 * ingest). A sender that receives `unknown-value` at a path inside an
 * `AgBlock[]` MAY resend without that element.
 */
import { AGJSON_VERSION, AgInput, AgInputEnvelope, type JsonValue } from "./agjson.js";
import { copyJson } from "./copy-json.js";
import { isJsonValue } from "./wire.js";

export type AgInputCheckCode = "unknown-value" | "malformed" | "major-mismatch";

export type AgInputCheck =
  | { ok: true; input: AgInput }
  | { ok: false; code: AgInputCheckCode; path: (string | number)[] };

type Path = (string | number)[];
type Problem = { code: "unknown-value" | "malformed"; path: Path };

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
const samePath = (a: Path, b: Path) => a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * Every problem one issue stands for. `unknown-value` iff the raw value at its
 * path is a string outside the closed set there (an enum's `values`, a
 * discriminator's `options`); a plain union is read through the branch that
 * fits the value's JSON type; anything else is `malformed`.
 */
function problemsOf(root: unknown, issue: Issue, prefix: Path): Problem[] {
  const path = [...prefix, ...toPath(issue.path)];
  const raw = at(root, path);
  const set = issue.code === "invalid_value" ? issue.values : issue.code === "invalid_union" ? issue.options : undefined;
  if (set !== undefined && typeof raw === "string" && !set.includes(raw)) return [{ code: "unknown-value", path }];
  if (issue.code === "invalid_union" && issue.errors !== undefined && issue.errors.length > 0) {
    // A branch that is malformed AT the union's own path does not fit the
    // value's JSON type (a string branch against an array, an enum against an
    // object); the first branch that fits is the one the value was meant for.
    const fitting = issue.errors
      .map((branch) => branch.flatMap((i) => problemsOf(root, i, path)))
      .filter((ps) => ps.length > 0 && !ps.some((p) => p.code === "malformed" && samePath(p.path, path)));
    return fitting[0] ?? [{ code: "malformed", path }];
  }
  return [{ code: "malformed", path }];
}

const MAJOR = AGJSON_VERSION.split(".")[0];
const reject = (code: AgInputCheckCode, path: Path): AgInputCheck => ({ ok: false, code, path });

/**
 * Check a received AgInput (draft.4 §0.2). Returns the input, unknown fields
 * intact, or a typed rejection naming one path and one class.
 */
export function checkAgInput(raw: unknown): AgInputCheck {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return reject("malformed", []);
  // protocol first: it names the protocol, so anything but "agjson" is not AgJSON at all.
  if (!Object.hasOwn(raw, "protocol") || (raw as { protocol?: unknown }).protocol !== "agjson") return reject("malformed", ["protocol"]);
  // then version: another major is major-mismatch; any other version problem is malformed.
  const version = Object.hasOwn(raw, "version") ? (raw as { version?: unknown }).version : undefined;
  if (typeof version !== "string" || !/^\d+\./.test(version)) return reject("malformed", ["version"]);
  if (version.split(".")[0] !== MAJOR) return reject("major-mismatch", ["version"]);
  // then the rest.
  if (!isJsonValue(raw)) return reject("malformed", []);
  const parsed = AgInput.safeParse(raw);
  if (parsed.success) return { ok: true, input: copyJson(raw as JsonValue) as unknown as AgInput };
  const issues = parsed.error.issues as unknown as Issue[];
  const problems: Problem[] = [];
  // An undefined kind stops zod at the discriminator: judge the envelope
  // members anyway, and never the members only that kind would select.
  if (issues.some((i) => i.code === "invalid_union" && i.options !== undefined && samePath(toPath(i.path), ["kind"]))) {
    const envelope = AgInputEnvelope.safeParse(raw);
    if (!envelope.success) for (const i of envelope.error.issues as unknown as Issue[]) problems.push(...problemsOf(raw, i, []));
  }
  for (const i of issues) problems.push(...problemsOf(raw, i, []));
  const pick = problems.find((p) => p.code === "malformed") ?? problems.find((p) => p.code === "unknown-value");
  return pick === undefined ? reject("malformed", []) : reject(pick.code, pick.path);
}
