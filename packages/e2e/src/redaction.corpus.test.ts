/**
 * redaction.corpus.test.ts — the committed corpus never carries an
 * account-identifying value (sp-cto's audit of the vercel-header item,
 * 2026-09-24). b86072a redacted the committed vercel natives; this gate keeps
 * any later capture that bypasses capture-time redaction (redact.ts) from
 * reintroducing one: under every REDACTED_KEYS key, at any depth, in every
 * committed JSON file of the corpus and the fixtures, the value is REDACTED.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { JsonValue } from "@silverprotocol/core";
import { REDACTED, REDACTED_KEYS } from "./redact.js";

const E2E = join(import.meta.dirname, "..");

/** Every path under which a REDACTED_KEYS key holds anything but REDACTED. */
export function unredactedPaths(v: JsonValue, path = "$"): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => unredactedPaths(x, `${path}[${i}]`));
  if (v === null || typeof v !== "object") return [];
  return Object.entries(v).flatMap(([k, x]) =>
    REDACTED_KEYS.has(k.toLowerCase()) ? (x === REDACTED ? [] : [`${path}.${k}`]) : unredactedPaths(x, `${path}.${k}`),
  );
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? jsonFiles(p) : name.endsWith(".json") ? [p] : [];
  });
}

describe("the committed corpus carries no account-identifying value", () => {
  const files = [...jsonFiles(join(E2E, "corpus")), ...jsonFiles(join(E2E, "fixtures"))];

  it("every REDACTED_KEYS value in every committed corpus and fixture file is REDACTED", () => {
    expect(files.length).toBeGreaterThan(200);
    const offenders = files.flatMap((f) => unredactedPaths(JSON.parse(readFileSync(f, "utf8")) as JsonValue).map((p) => `${relative(E2E, f)} ${p}`));
    expect(offenders).toEqual([]);
  });

  it("the gate bites: un-redacting one value in a committed vercel native is reported at exactly that path", () => {
    const native = JSON.parse(readFileSync(join(E2E, "corpus", "echo-gpt56", "vercel.native.json"), "utf8")) as JsonValue[];
    const redactedAt = native.flatMap((ev, i) => unredactedPaths(JSON.parse(JSON.stringify(ev).replaceAll(`"${REDACTED}"`, '"LIVE"')) as JsonValue, `$[${i}]`));
    expect(redactedAt.length).toBeGreaterThan(0); // the native really carries redacted headers
    const target = native.findIndex((ev) => JSON.stringify(ev).includes(`"${REDACTED}"`));
    const mutated = structuredClone(native);
    mutated[target] = JSON.parse(JSON.stringify(mutated[target]).replace(`"${REDACTED}"`, '"org-live-value"'));
    const found = unredactedPaths(mutated as JsonValue);
    expect(found).toHaveLength(1);
    expect(found[0]!.startsWith(`$[${target}].`)).toBe(true);
  });
});
