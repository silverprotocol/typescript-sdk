/**
 * stability-window.test.ts — the GA stability-window instrument: "zero change
 * in the serialized replay of every existing native cassette" across a window.
 *
 * NOT part of the CI gate. It runs only with STABILITY set:
 *
 *   STABILITY=record npx vitest run --config ../../vitest.config.ts src/stability-window.test.ts
 *     Writes the baseline (STABILITY_BASELINE, default stability-baseline.json in
 *     this package): the git ref it was taken at and, for every corpus native
 *     cassette, the hash of its natives and of its serialized replay — the
 *     AgEvent stream (toWire), the reference fold (reduce), its storage
 *     projection (toPersistable, what a host persists) and needsResync — on
 *     the recorded path and, for a cassette that records the host-completion
 *     marker, on the marker-less path too.
 *
 *   STABILITY=check npx vitest run --config ../../vitest.config.ts src/stability-window.test.ts
 *     For every stream in the baseline, reads its natives AT THE BASELINE REF
 *     (so a re-captured cassette is judged by replaying its old natives),
 *     verifies them against the recorded hash, replays them through the
 *     current code and reports every stream whose events, fold or needsResync
 *     changed (with the first differing event), and separately counts the
 *     streams that park on either path. Cassettes added since the baseline are
 *     listed, never failed. The run fails on any change and on any park.
 *
 * The report is also written to STABILITY_REPORT when set.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ingestAgEvents, reduce, toPersistable, type JsonValue } from "@silverprotocol/core";
import { replayNatives, splitHostCompleteMarker, type Framework } from "./replay.js";

const MODE = process.env["STABILITY"];
const PKG = join(import.meta.dirname, "..");
const CORPUS = join(PKG, "corpus");
const BASELINE = process.env["STABILITY_BASELINE"] ?? join(PKG, "stability-baseline.json");
const FRAMEWORKS: Framework[] = ["claude", "openai", "adk", "vercel"];

interface PathDigest {
  events: string;
  fold: string;
  /** The storage projection a host persists: toPersistable(fold). */
  persisted: string;
  needsResync: boolean;
  eventCount: number;
}
interface StreamEntry {
  /** Repo-relative path of the native cassette. */
  native: string;
  nativeSha: string;
  recorded: PathDigest;
  /** The marker-less path, only for a cassette that records the host-completion marker. */
  plain?: PathDigest;
}
interface Baseline {
  ref: string;
  recordedAt: string;
  streams: Record<string, StreamEntry>;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const git = (args: string[]) => execFileSync("git", args, { cwd: PKG, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const REPO = git(["rev-parse", "--show-toplevel"]).trim();

async function digest(natives: JsonValue[], fw: Framework): Promise<{ digest: PathDigest; events: string }> {
  const { agjson } = await replayNatives(natives, fw);
  const events = JSON.stringify(agjson);
  const { result, needsResync } = reduce(ingestAgEvents(agjson));
  return {
    digest: { events: sha(events), fold: sha(JSON.stringify(result)), persisted: sha(JSON.stringify(toPersistable(result))), needsResync, eventCount: agjson.length },
    events,
  };
}

async function streamDigests(raw: string, fw: Framework) {
  const natives = JSON.parse(raw) as JsonValue[];
  const recorded = await digest(natives, fw);
  const split = splitHostCompleteMarker(natives);
  const plain = split.hostCompleted ? await digest(split.native, fw) : undefined;
  return { recorded, plain };
}

function corpusStreams(): Array<{ key: string; fw: Framework; path: string }> {
  const out: Array<{ key: string; fw: Framework; path: string }> = [];
  for (const scn of readdirSync(CORPUS).sort()) {
    for (const fw of FRAMEWORKS) {
      const p = join(CORPUS, scn, `${fw}.native.json`);
      if (existsSync(p)) out.push({ key: `${scn}/${fw}`, fw, path: p });
    }
  }
  return out;
}

/** The golden committed beside a native at `ref`, re-serialized compactly (JSON.stringify), or undefined. */
function goldenAt(ref: string, nativePath: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(git(["show", `${ref}:${nativePath.replace(/\.native\.json$/, ".agjson.json")}`])) as JsonValue[]);
  } catch {
    return undefined;
  }
}

/** The index of the first event whose serialization differs, and both sides. */
function firstDifference(before: string, after: string): string {
  const a = JSON.parse(before) as JsonValue[];
  const b = JSON.parse(after) as JsonValue[];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = JSON.stringify(a[i]);
    const y = JSON.stringify(b[i]);
    if (x !== y) return `event ${i}: ${String(x).slice(0, 160)} → ${String(y).slice(0, 160)}`;
  }
  return "no event differs (fold or count only)";
}

describe.runIf(MODE === "record")("stability window: record the baseline", () => {
  it("writes the serialized-replay digest of every corpus native cassette", async () => {
    const baseline: Baseline = { ref: git(["rev-parse", "HEAD"]).trim(), recordedAt: new Date().toISOString(), streams: {} };
    for (const s of corpusStreams()) {
      const raw = readFileSync(s.path, "utf8");
      const { recorded, plain } = await streamDigests(raw, s.fw);
      baseline.streams[s.key] = {
        native: relative(REPO, s.path),
        nativeSha: sha(raw),
        recorded: recorded.digest,
        ...(plain !== undefined ? { plain: plain.digest } : {}),
      };
    }
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
    console.info(`stability baseline: ${Object.keys(baseline.streams).length} streams at ${baseline.ref} → ${BASELINE}`);
    expect(Object.keys(baseline.streams).length).toBeGreaterThan(0);
  });
});

describe.runIf(MODE === "check")("stability window: check against the baseline", () => {
  it("every baseline stream replays byte-identically through the current code (its natives read at the baseline ref)", async () => {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
    const changed: string[] = [];
    const parked: string[] = [];
    const lines: string[] = [];
    for (const [key, entry] of Object.entries(baseline.streams)) {
      const fw = key.split("/")[1] as Framework;
      const raw = git(["show", `${baseline.ref}:${entry.native}`]);
      if (sha(raw) !== entry.nativeSha) {
        changed.push(key);
        lines.push(`${key}: the natives at ${baseline.ref} do not match the recorded hash`);
        continue;
      }
      const { recorded, plain } = await streamDigests(raw, fw);
      for (const [label, now, then] of [
        ["recorded", recorded, entry.recorded],
        ["plain", plain, entry.plain],
      ] as const) {
        if (then === undefined && now === undefined) continue;
        if (now?.digest.needsResync === true) parked.push(`${key} (${label})`);
        if (then === undefined || now === undefined || now.digest.events !== then.events || now.digest.fold !== then.fold || now.digest.persisted !== then.persisted || now.digest.needsResync !== then.needsResync) {
          changed.push(`${key} (${label})`);
          // The recorded path's "before" side is the golden committed at the
          // baseline ref (the harness regenerates it from the same replay).
          const before = label === "recorded" ? goldenAt(baseline.ref, entry.native) : undefined;
          lines.push(
            `${key} (${label}): events ${then?.events.slice(0, 12)} → ${now?.digest.events.slice(0, 12)}, fold ${then?.fold.slice(0, 12)} → ${now?.digest.fold.slice(0, 12)}, persisted ${then?.persisted.slice(0, 12)} → ${now?.digest.persisted.slice(0, 12)}, needsResync ${then?.needsResync} → ${now?.digest.needsResync}, count ${then?.eventCount} → ${now?.digest.eventCount}` +
              (before !== undefined && now !== undefined ? `; ${firstDifference(before, now.events)}` : ""),
          );
        }
      }
    }
    const added = corpusStreams().map((s) => s.key).filter((k) => !(k in baseline.streams));
    const report = [
      `stability window vs ${baseline.ref} (recorded ${baseline.recordedAt}): ${Object.keys(baseline.streams).length} baseline streams, ${changed.length} changed, ${added.length} added`,
      `parked on either path: ${parked.length}${parked.length > 0 ? ` (${parked.join(", ")})` : ""}`,
      ...lines,
      ...(added.length > 0 ? [`added (not judged): ${added.join(", ")}`] : []),
    ].join("\n");
    if (process.env["STABILITY_REPORT"] !== undefined) writeFileSync(process.env["STABILITY_REPORT"], report + "\n");
    console.info(report);
    expect(changed).toEqual([]);
    expect(parked).toEqual([]);
  });
});
