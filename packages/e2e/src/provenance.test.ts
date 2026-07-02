/**
 * provenance.test.ts — the growth-guard for unlabeled corpora (Task 6 /
 * audit M60 §2.B).
 *
 * Two suites:
 *   1. `isProvenanceKind` unit tests.
 *   2. The growth-guard itself: every `corpus/*​/*.native.json` MUST have a
 *      sibling `<same-stem>.provenance.json` with a valid `kind`. Walks the
 *      REAL corpus/ directory (no fixture list to keep in sync — any future
 *      native cassette, from this task or any later one, is covered
 *      automatically the moment it's committed).
 */
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@silverprotocol/core";
import { isProvenanceKind } from "./provenance.js";

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");

describe("isProvenanceKind", () => {
  it("accepts \"capture\"", () => {
    expect(isProvenanceKind("capture")).toBe(true);
  });

  it("accepts \"fixture\"", () => {
    expect(isProvenanceKind("fixture")).toBe(true);
  });

  it("rejects any other string", () => {
    expect(isProvenanceKind("live")).toBe(false);
    expect(isProvenanceKind("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isProvenanceKind(null)).toBe(false);
    expect(isProvenanceKind(undefined)).toBe(false);
    expect(isProvenanceKind(42)).toBe(false);
    expect(isProvenanceKind({ kind: "capture" })).toBe(false);
  });
});

// ─── the growth-guard ─────────────────────────────────────────────────────

/** Every `<scenario>/<framework>.native.json` under corpus/, discovered by
 *  walking the real directory tree (not a hardcoded list). */
async function findNativeCassettes(): Promise<{ scenario: string; framework: string; path: string }[]> {
  const out: { scenario: string; framework: string; path: string }[] = [];
  const scenarioDirs = await readdir(CORPUS_ROOT, { withFileTypes: true });
  for (const dirent of scenarioDirs) {
    if (!dirent.isDirectory()) continue;
    const scenario = dirent.name;
    const scenarioDir = join(CORPUS_ROOT, scenario);
    const files = await readdir(scenarioDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      const match = /^(.+)\.native\.json$/.exec(file.name);
      if (!match) continue;
      out.push({ scenario, framework: match[1] ?? "", path: join(scenarioDir, file.name) });
    }
  }
  return out;
}

describe("provenance growth-guard — every native cassette has a valid sidecar", () => {
  it("finds at least one native cassette (non-vacuity — the walk itself works)", async () => {
    const cassettes = await findNativeCassettes();
    expect(cassettes.length).toBeGreaterThan(0);
  });

  it("EVERY corpus/*/*.native.json has a sibling *.provenance.json with a valid kind", async () => {
    const cassettes = await findNativeCassettes();
    const failures: string[] = [];

    for (const { scenario, framework, path } of cassettes) {
      const sidecarPath = path.replace(/\.native\.json$/, ".provenance.json");
      let raw: string;
      try {
        raw = await readFile(sidecarPath, "utf8");
      } catch {
        failures.push(`${scenario}/${framework}: MISSING sidecar at ${sidecarPath}`);
        continue;
      }

      let parsed: JsonValue;
      try {
        parsed = JSON.parse(raw) as JsonValue;
      } catch {
        failures.push(`${scenario}/${framework}: sidecar is not valid JSON (${sidecarPath})`);
        continue;
      }

      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        failures.push(`${scenario}/${framework}: sidecar is not a JSON object (${sidecarPath})`);
        continue;
      }

      const kind = parsed["kind"];
      if (!isProvenanceKind(kind)) {
        failures.push(
          `${scenario}/${framework}: sidecar has an invalid "kind" (${JSON.stringify(kind)}) at ${sidecarPath}`,
        );
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });
});
