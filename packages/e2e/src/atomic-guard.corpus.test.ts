/**
 * atomic-guard.corpus.test.ts — corpus-scale proofs for the per-native guard
 * (the fleet guard ruling, 2026-09-24): core withAtomicPush (option B, for
 * the claude / openai / adk facets) and StreamAssembler checkpoint/rollback
 * (option A, used by vercel-ai).
 *
 * 1. Zero fires: replaying every committed native never produces the guard's
 *    `error {message: "normalizer error"}`.
 * 2. Differential: push(prefix, bad, rest) ≡ push(prefix, rest) + ONE error at
 *    bad's position, every later seq +1, over every committed native. "bad"
 *    drives a REAL frame (so it opens and emits) and then throws.
 * 3. Determinism (B): the differential runs with Date.now, Math.random,
 *    crypto.randomUUID and crypto.getRandomValues poisoned, so any future
 *    nondeterminism in a wrapped facet fails loudly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ingestAgEvents, NORMALIZER_ERROR_MESSAGE, reduce, StreamAssembler, withAtomicPush, type AgEvent, type JsonValue, type Normalizer } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { createVercelNormalizer } from "@silverprotocol/vercel-ai";
import { replayCassette, splitHostCompleteMarker } from "./replay.js";

const CORPUS = join(import.meta.dirname, "..", "corpus");
type Fw = "claude" | "openai" | "adk" | "vercel";
function natives(fw: Fw): Array<[string, JsonValue[]]> {
  const out: Array<[string, JsonValue[]]> = [];
  for (const d of readdirSync(CORPUS)) {
    const f = join(CORPUS, d, `${fw}.native.json`);
    try {
      out.push([d, splitHostCompleteMarker(JSON.parse(readFileSync(f, "utf8")) as JsonValue[]).native]);
    } catch {
      /* no cassette for this framework */
    }
  }
  return out;
}
const FACTORY: Record<Exclude<Fw, "vercel">, () => Normalizer> = {
  claude: () => createClaudeNormalizer(),
  openai: () => createOpenaiNormalizer(),
  adk: () => createAdkNormalizer(),
};
const run = (n: Normalizer, xs: unknown[]): AgEvent[] => [...xs.flatMap((x) => n.push(x)), ...n.flush()];
/** How many events the prefix's pushes emit (no flush: its INV-FLUSH closes are not in the full stream). */
const pushedLen = (n: Normalizer, xs: unknown[]): number => xs.flatMap((x) => n.push(x)).length;
/** No park: the guarded stream passes ingest whole and folds without asking for a resync. */
function expectNoPark(got: AgEvent[], label: string): void {
  const ingested = ingestAgEvents(JSON.parse(JSON.stringify(got)) as JsonValue[]);
  expect(ingested.length, `${label}: ingest kept every event`).toBe(got.length);
  expect(reduce(ingested).needsResync, `${label}: reduce() parked`).toBe(false);
  expect(got.map((e) => e.seq), `${label}: seq contiguous`).toEqual(got.map((_, i) => i));
}
/** The stream without `bad`, with one error at the index its events would have had, later seqs +1. */
function expectedWithError(withoutBad: AgEvent[], at: number, extra: Record<string, string> = {}): unknown[] {
  return [
    ...withoutBad.slice(0, at),
    { type: "error", seq: at, message: NORMALIZER_ERROR_MESSAGE, code: "Error", ...extra },
    ...withoutBad.slice(at).map((e) => ({ ...e, seq: e.seq + 1 })),
  ];
}

describe("the per-native guard over the committed corpus", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fires ZERO times on replay of every committed native (all frameworks)", async () => {
    let cassettes = 0;
    for (const d of readdirSync(CORPUS)) {
      for (const f of readdirSync(join(CORPUS, d)).filter((x) => x.endsWith(".native.json"))) {
        const { agjson } = await replayCassette(join(CORPUS, d, f));
        cassettes++;
        const fired = agjson.filter((e) => (e as { message?: string }).message === NORMALIZER_ERROR_MESSAGE);
        expect(fired, `${d}/${f}`).toEqual([]);
      }
    }
    expect(cassettes).toBeGreaterThanOrEqual(50);
  });

  for (const fw of ["claude", "openai", "adk"] as const) {
    it(`B, ${fw}: push(prefix, bad, rest) ≡ push(prefix, rest) + one error, +1 renumbered; clock and randomness poisoned`, () => {
      vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("Date.now in a facet"); });
      vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("Math.random in a facet"); });
      vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => { throw new Error("randomUUID in a facet"); });
      vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => { throw new Error("getRandomValues in a facet"); });
      const all = natives(fw);
      expect(all.length).toBeGreaterThan(0);
      let emittedBeforeThrow = 0;
      let emittingK = 0;
      for (const [name, frames] of all) {
        if (frames.length < 3) continue;
        // bad = the first frame from the midpoint on that emits, so the throw discards real partial output.
        const probe = FACTORY[fw]();
        const emits = frames.map((x) => probe.push(x).length);
        const mid = Math.floor(frames.length / 2);
        const found = emits.findIndex((c, i) => i >= mid && c > 0);
        const k = found >= 0 ? found : mid;
        if (found >= 0) emittingK++;
        const without = [...frames.slice(0, k), ...frames.slice(k + 1)];
        const reference = run(FACTORY[fw](), without);
        const at = pushedLen(FACTORY[fw](), frames.slice(0, k));
        const BAD = { __bad: frames[k] };
        const wrapped = withAtomicPush(() => {
          const f = FACTORY[fw]();
          return {
            push: (n: unknown) => {
              if (n !== null && typeof n === "object" && "__bad" in n) {
                if (f.push((n as { __bad: unknown }).__bad).length > 0) emittedBeforeThrow++; // really drives the frame
                throw new Error(`SECRET_marker ${JSON.stringify(n).slice(0, 40)}`);
              }
              return f.push(n);
            },
            flush: () => f.flush(),
          };
        });
        const got = run(wrapped, [...frames.slice(0, k), BAD, ...frames.slice(k + 1)]);
        expect(got, `${fw} ${name} k=${k}`).toEqual(expectedWithError(reference, at));
        expectNoPark(got, `${fw} ${name}`);
        expect(JSON.stringify(got)).not.toContain("SECRET_");
      }
      expect(emittedBeforeThrow, fw).toBe(emittingK);
      expect(emittingK, fw).toBeGreaterThanOrEqual(all.length - 2);
    });
  }

  it("A, vercel: a throw after the first assembler call of a start-step ≡ the stream without it + one error", () => {
    const all = natives("vercel");
    expect(all.length).toBeGreaterThan(0);
    const methods = Object.getOwnPropertyNames(StreamAssembler.prototype).filter(
      (m) => !["constructor", "drain", "flush", "checkpoint", "rollback"].includes(m),
    ) as Array<keyof StreamAssembler>;
    for (const [name, frames] of all) {
      const k = frames.findIndex((f) => (f as { type?: string }).type === "start-step");
      expect(k, name).toBeGreaterThanOrEqual(0);
      const without = [...frames.slice(0, k), ...frames.slice(k + 1)];
      const reference = run(createVercelNormalizer({ invokeId: "vercel" }), without);
      const at = pushedLen(createVercelNormalizer({ invokeId: "vercel" }), frames.slice(0, k));
      const n = createVercelNormalizer({ invokeId: "vercel" });
      const got: AgEvent[] = [];
      for (const [i, f] of frames.entries()) {
        if (i !== k) {
          got.push(...n.push(f));
          continue;
        }
        let calls = 0;
        const spies = methods.map((m) => {
          const proto = StreamAssembler.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
          const original = proto[m as string]!;
          return vi.spyOn(proto, m as string).mockImplementation(function (this: StreamAssembler, ...args: unknown[]) {
            calls++;
            if (calls === 2) throw new Error("SECRET_marker after an open");
            return original.apply(this, args);
          });
        });
        got.push(...n.push({ ...(f as object), secret: "SECRET_native" }));
        spies.forEach((s) => s.mockRestore());
        expect(calls, `${name}: the throw came after an open`).toBeGreaterThanOrEqual(2);
      }
      got.push(...n.flush());
      // Option A emits through the assembler, which stamps the open turn's id (spec-valid on `error`).
      expect(got, name).toEqual(expectedWithError(reference, at, { turnId: "turn_vercel_1" }));
      expectNoPark(got, `vercel ${name}`);
      expect(JSON.stringify(got)).not.toContain("SECRET_");
    }
  });
});
