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
import { AUDIO_ELIDED_PREFIX, REDACTED, REDACTED_KEYS, REDACTED_PATH, REDACTED_PATH_KEYS } from "./redact.js";

const E2E = join(import.meta.dirname, "..");

/** Every string leaf under a REDACTED_PATH_KEYS key that is not REDACTED_PATH. */
function unredactedPathLeaves(v: JsonValue, path: string): string[] {
  if (typeof v === "string") return v === REDACTED_PATH ? [] : [path];
  if (Array.isArray(v)) return v.flatMap((x, i) => unredactedPathLeaves(x, `${path}[${i}]`));
  if (v === null || typeof v !== "object") return [];
  return Object.entries(v).flatMap(([k, x]) => unredactedPathLeaves(x, `${path}.${k}`));
}

/** Every path under which a REDACTED_KEYS key holds anything but REDACTED, or a
 *  REDACTED_PATH_KEYS key holds a string other than REDACTED_PATH. */
export function unredactedPaths(v: JsonValue, path = "$"): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => unredactedPaths(x, `${path}[${i}]`));
  if (v === null || typeof v !== "object") return [];
  return Object.entries(v).flatMap(([k, x]) =>
    REDACTED_KEYS.has(k.toLowerCase())
      ? x === REDACTED
        ? []
        : [`${path}.${k}`]
      : REDACTED_PATH_KEYS.has(k.toLowerCase())
        ? unredactedPathLeaves(x, `${path}.${k}`)
        : unredactedPaths(x, `${path}.${k}`),
  );
}

/** Every audio payload (mimeType audio/*) whose string `data` was not elided. */
export function unelidedAudio(v: JsonValue, path = "$"): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => unelidedAudio(x, `${path}[${i}]`));
  if (v === null || typeof v !== "object") return [];
  const here =
    typeof v["mimeType"] === "string" && /^audio\//i.test(v["mimeType"]) && typeof v["data"] === "string" && !v["data"].startsWith(AUDIO_ELIDED_PREFIX)
      ? [`${path}.data`]
      : [];
  return [...here, ...Object.entries(v).flatMap(([k, x]) => unelidedAudio(x, `${path}.${k}`))];
}

/**
 * Every drop in a coverage sidecar whose census path runs through a redacted
 * key but whose recorded value is not the redacted form. A drop records the
 * key inside its `path` string, so the key-based walk above cannot see it:
 * a native redacted after capture keeps the raw value in its capture-time
 * sidecar unless the sidecar is redacted too.
 */
export function unredactedDrops(report: JsonValue): string[] {
  const drops = ((report as { drops?: unknown }).drops ?? []) as { path: string; value: JsonValue }[];
  return drops.flatMap((d) => {
    const segs = d.path.split(/\.|\[\d+\]/).filter((s) => s !== "").map((s) => s.toLowerCase());
    if (segs.some((s) => REDACTED_KEYS.has(s))) return d.value === REDACTED && REDACTED_KEYS.has(segs.at(-1)!) ? [] : [d.path];
    // Every string leaf of the value, at any depth, must be REDACTED_PATH (as redactPathLeaves leaves a native).
    if (segs.some((s) => REDACTED_PATH_KEYS.has(s))) return unredactedPathLeaves(d.value, d.path).length === 0 ? [] : [d.path];
    return [];
  });
}

/** An absolute home-directory path (macOS /Users/<name>, Linux /home/<name>) or its CLI slug form. */
const HOME_PATH = /\/(?:Users|home)\/[^/"\\]+|-Users-[A-Za-z0-9._]+-/;

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

  it("no committed corpus or fixture file carries raw audio bytes (every audio/* payload is elided)", () => {
    const offenders = files.flatMap((f) => unelidedAudio(JSON.parse(readFileSync(f, "utf8")) as JsonValue).map((p) => `${relative(E2E, f)} ${p}`));
    expect(offenders).toEqual([]);
    // the gate bites on a live payload, and passes an elided one
    expect(unelidedAudio({ inlineData: { mimeType: "audio/pcm", data: "AAEC" } })).toEqual(["$.inlineData.data"]);
    expect(unelidedAudio({ inlineData: { mimeType: "audio/pcm", data: `${AUDIO_ELIDED_PREFIX}4 chars>` } })).toEqual([]);
  });

  it("no coverage sidecar records a raw value under a redacted key (a drop's path names the key)", () => {
    const sidecars = files.filter((f) => f.endsWith(".coverage.json"));
    expect(sidecars.length).toBeGreaterThan(60);
    const offenders = sidecars.flatMap((f) => unredactedDrops(JSON.parse(readFileSync(f, "utf8")) as JsonValue).map((p) => `${relative(E2E, f)} ${p}`));
    expect(offenders).toEqual([]);
    // the leg bites on a raw token or local path in a drop, and passes the redacted forms
    const drop = (path: string, value: JsonValue) => ({ drops: [{ path, norm: path, value }] });
    expect(unredactedDrops(drop("[0].liveSessionResumptionUpdate.newHandle", "tok-live"))).toEqual(["[0].liveSessionResumptionUpdate.newHandle"]);
    expect(unredactedDrops(drop("[0].liveSessionResumptionUpdate.newHandle", REDACTED))).toEqual([]);
    expect(unredactedDrops(drop("[3].response.headers.set-cookie", "__cf_bm=x"))).toEqual(["[3].response.headers.set-cookie"]);
    expect(unredactedDrops(drop("[0].memory_paths.auto", "/opt/x/memory/"))).toEqual(["[0].memory_paths.auto"]);
    expect(unredactedDrops(drop("[0].memory_paths.auto", REDACTED_PATH))).toEqual([]);
    // an object value under a path key is walked: a raw string leaf at any depth is an offender
    expect(unredactedDrops(drop("[0].memory_paths", { auto: "/opt/x/memory/" }))).toEqual(["[0].memory_paths"]);
    expect(unredactedDrops(drop("[0].memory_paths", { auto: REDACTED_PATH, n: 1 }))).toEqual([]);
    expect(unredactedDrops(drop("[0].usageMetadata.totalTokenCount", 42))).toEqual([]);
  });

  it("no committed corpus or fixture file carries a home-directory path, anywhere (model text included)", () => {
    const offenders = files.filter((f) => HOME_PATH.test(readFileSync(f, "utf8"))).map((f) => relative(E2E, f));
    expect(offenders).toEqual([]);
  });

  it("the gate bites on a local path: a live cwd or memory_paths value in a committed claude native is reported at exactly that path", () => {
    const native = JSON.parse(readFileSync(join(E2E, "corpus", "echo-sonnet5", "claude.native.json"), "utf8")) as JsonValue[];
    const init = native.findIndex((ev) => (ev as { subtype?: string }).subtype === "init");
    expect(init).toBeGreaterThanOrEqual(0);
    expect((native[init] as { cwd?: string }).cwd).toBe(REDACTED_PATH); // committed redacted
    for (const [key, value] of [["cwd", "/Users/someone/repo"], ["memory_paths", { auto: "/Users/someone/.claude/memory/" }]] as const) {
      const mutated = structuredClone(native);
      (mutated[init] as Record<string, JsonValue>)[key] = value as JsonValue;
      const found = unredactedPaths(mutated as JsonValue);
      expect(found, key).toEqual([key === "cwd" ? `$[${init}].cwd` : `$[${init}].memory_paths.auto`]);
      expect(HOME_PATH.test(JSON.stringify(mutated)), key).toBe(true);
    }
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
