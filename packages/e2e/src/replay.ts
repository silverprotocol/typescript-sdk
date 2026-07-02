/**
 * replay.ts — the KEYLESS replay CI gate for the AgJSON E2E conformance harness.
 *
 * Loads a committed native cassette (`corpus/<scn>/<framework>.native.json`, a raw
 * event stream as JsonValue[]), runs it through the REAL facet normalizer for the
 * given framework (`createClaudeNormalizer` or `createOpenaiNormalizer` — push each
 * event, then flush), and runs the value `census` against the produced AgJSON,
 * loading the three committed guard JSONs (`transforms.json`,
 * `known-acceptable-drops.json`, `field-registry.json`).
 *
 * ★ HONEST FRAMING — what this gate IS and IS NOT ★
 *
 * The seed cassettes under `corpus/` are NOT captured live bytes. The Claude seeds
 * are HAND-AUTHORED `SDKMessage` shapes; the OpenAI seed is a REAL capture from the
 * `@openai/agents` runtime (trimmed to the minimal text-tool-turn scenario). Because
 * the seeds are written to the same shape the facet reads, this replay gate is a
 * MACHINERY + SNAPSHOT self-consistency gate:
 *
 *   - it proves the pipeline RUNS end-to-end (native → normalizer → AgEvent[]),
 *   - it LOCKS the produced AgJSON shape (snapshot/regression), and
 *   - it GUARDS against drift in the census triage (drops / newFields stay empty).
 *
 * It is NOT a real-lossiness gate: by construction it surfaces ~zero drops, since
 * the seeds carry no value-bearing native field outside the facet's read-set
 * except the deliberately-guarded result-metadata + App-spec/cache surfaces. The
 * REAL lossiness hunt is the operator's LIVE capture (real provider bytes
 * against `transforms.json` / `known-acceptable-drops.json`), which can surface
 * genuine drops this deterministic keyless gate cannot.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@silverprotocol/core";
import { toWire } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
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

// ─── framework selector ────────────────────────────────────────────────────────

/** The set of supported facet normalizer identifiers. */
export type Framework = "claude" | "openai" | "adk";

/**
 * Infer the framework from a cassette filename (e.g. `claude.native.json` →
 * `"claude"`, `openai.native.json` → `"openai"`, `adk.native.json` → `"adk"`).
 * Falls back to `"claude"` so existing callers that do NOT pass a framework
 * remain forward-compatible.
 */
export function inferFramework(nativePath: string): Framework {
  const base = nativePath.split("/").pop() ?? "";
  if (base.startsWith("openai.")) return "openai";
  if (base.startsWith("adk.")) return "adk";
  return "claude";
}

// ─── the replay primitive ──────────────────────────────────────────────────────

/**
 * Replay one native cassette through the real facet normalizer + census.
 *
 * The framework is inferred from the filename (`claude.*` → Claude,
 * `openai.*` → OpenAI). Pass an explicit `framework` to override.
 *
 * @param nativePath  Absolute path to a `<framework>.native.json`.
 * @param framework   Optional override; inferred from filename when omitted.
 * @returns The produced AgJSON event stream + the census report.
 */
export async function replayCassette(
  nativePath: string,
  framework?: Framework,
): Promise<ReplayResult> {
  const native = await readJsonArray(nativePath);
  const fw = framework ?? inferFramework(nativePath);

  // ── Drive the real facet normalizer: push each event, then flush. ──────────
  const normalizer =
    fw === "openai"
      ? createOpenaiNormalizer()
      : fw === "adk"
        ? createAdkNormalizer()
        : createClaudeNormalizer();
  const agjson: JsonValue[] = [];
  for (const event of native) {
    for (const e of normalizer.push(event)) {
      // Wire projection (audit D5-a) — toWire materializes the AgEvent as
      // plain JsonValue, exactly as the wire delivers it.
      agjson.push(toWire(e));
    }
  }
  for (const e of normalizer.flush()) {
    agjson.push(toWire(e));
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
