/**
 * replay.ts — the KEYLESS replay CI gate for the AgJSON E2E conformance harness.
 *
 * Loads a committed native cassette (`corpus/<scn>/claude.native.json`, a raw
 * `SDKMessage[]` as JsonValue), runs it through the REAL Claude facet normalizer
 * (`createClaudeNormalizer` — push each event, then flush), and runs the value
 * `census` against the produced AgJSON, loading the three committed guard JSONs
 * (`transforms.json`, `known-acceptable-drops.json`, `field-registry.json`).
 *
 * ★ HONEST FRAMING — what this gate IS and IS NOT ★
 *
 * The seed cassettes under `corpus/` are NOT captured Claude bytes. They are
 * HAND-AUTHORED `SDKMessage` shapes, transcribed from the guuey facet's own
 * read-set test fixtures (`fold-identity.test.ts` `representativeTurn()` and
 * `sse-server.test.ts` `COMPLETE_SUCCESS_RESULT`), plus a hand-authored App-spec
 * seed. Because the seeds are written to the same shape the facet reads, this
 * replay gate is a MACHINERY + SNAPSHOT self-consistency gate:
 *
 *   - it proves the pipeline RUNS end-to-end (native → normalizer → AgEvent[]),
 *   - it LOCKS the produced AgJSON shape (snapshot/regression), and
 *   - it GUARDS against drift in the census triage (drops / newFields stay empty).
 *
 * It is NOT a real-lossiness gate: by construction it surfaces ~zero drops, since
 * the seeds carry no value-bearing native field outside the facet's read-set
 * except the deliberately-guarded result-metadata + App-spec/cache surfaces. The
 * REAL lossiness hunt is the operator's Task 7 LIVE capture (real Claude bytes
 * against `transforms.json` / `known-acceptable-drops.json`), which can surface
 * genuine drops this deterministic keyless gate cannot.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { census, type CensusReport } from "./census.js";

// ─── locating the guard JSONs (package root, alongside corpus/) ──────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Package root = one level up from src/. */
const PACKAGE_ROOT = join(__dirname, "..");

const TRANSFORMS_PATH = join(PACKAGE_ROOT, "transforms.json");
const ALLOWLIST_PATH = join(PACKAGE_ROOT, "known-acceptable-drops.json");
const REGISTRY_PATH = join(PACKAGE_ROOT, "field-registry.json");

// ─── public result type ──────────────────────────────────────────────────────

export interface ReplayResult {
  /** The AgEvent stream the normalizer produced, materialized as JsonValue[]. */
  agjson: JsonValue[];
  /** The census lossiness report for this cassette against the guard JSONs. */
  report: CensusReport;
}

// ─── JSON loaders (typed, no `as any` / `Record<string, unknown>`) ────────────

/** Read + parse a JSON file into a `JsonValue` (the genuine deserialization boundary). */
async function readJsonValue(path: string): Promise<JsonValue> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as JsonValue;
}

/** Read a JSON file that must be a `JsonValue[]` (the native cassette / agjson). */
async function readJsonArray(path: string): Promise<JsonValue[]> {
  const value = await readJsonValue(path);
  if (!Array.isArray(value)) {
    throw new Error(`replay: expected a JSON array at ${path}`);
  }
  return value;
}

/** Read a JSON file that must be a sorted array of strings (transforms / registry). */
async function readStringArray(path: string): Promise<string[]> {
  const value = await readJsonValue(path);
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`replay: expected a JSON array of strings at ${path}`);
  }
  return value as string[];
}

/** One `{ path, reason }` record in the known-acceptable-drops allowlist. */
export interface AllowlistEntry {
  path: string;
  reason: string;
}

/** Read the allowlist file: a sorted array of `{ path, reason }` records. */
async function readAllowlist(path: string): Promise<AllowlistEntry[]> {
  const value = await readJsonValue(path);
  if (!Array.isArray(value)) {
    throw new Error(`replay: expected a JSON array at ${path}`);
  }
  const out: AllowlistEntry[] = [];
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.reason !== "string"
    ) {
      throw new Error(`replay: malformed allowlist entry at ${path}`);
    }
    out.push({ path: entry.path, reason: entry.reason });
  }
  return out;
}

// ─── the replay primitive ──────────────────────────────────────────────────────

/**
 * Replay one native cassette through the real Claude normalizer + census.
 *
 * @param nativePath  Absolute path to a `claude.native.json` (a `SDKMessage[]`).
 * @returns The produced AgJSON event stream + the census report.
 */
export async function replayCassette(nativePath: string): Promise<ReplayResult> {
  const native = await readJsonArray(nativePath);

  // ── Drive the real facet normalizer: push each event, then flush. ──────────
  const normalizer = createClaudeNormalizer();
  const agjson: JsonValue[] = [];
  for (const event of native) {
    for (const e of normalizer.push(event)) {
      // AgEvent is a valid JsonValue (spec §0.1) — round-trip through JSON so the
      // committed snapshot compares plain JSON, exactly as the wire delivers it.
      agjson.push(JSON.parse(JSON.stringify(e)) as JsonValue);
    }
  }
  for (const e of normalizer.flush()) {
    agjson.push(JSON.parse(JSON.stringify(e)) as JsonValue);
  }

  // ── Load the three guard JSONs + run census. ───────────────────────────────
  const [transforms, allowlistEntries, registry] = await Promise.all([
    readStringArray(TRANSFORMS_PATH),
    readAllowlist(ALLOWLIST_PATH),
    readStringArray(REGISTRY_PATH),
  ]);

  const report = census({
    native,
    agjson,
    transforms: new Set(transforms),
    allowlist: new Set(allowlistEntries.map((e) => e.path)),
    registry: new Set(registry),
  });

  return { agjson, report };
}
