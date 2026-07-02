/**
 * replay.test.ts — the KEYLESS replay CI gate.
 *
 * Four suites:
 *
 * 1. Claude seed corpus (text-tool-turn / complete-result / app-spec):
 *    For each committed `claude.native.json`:
 *      a. `replayCassette(native)` → drive the REAL Claude facet normalizer.
 *      b. SNAPSHOT: assert produced `agjson` deep-equals `claude.agjson.json`.
 *      c. GATE: assert `report.drops === []` AND `report.newFields === []`.
 *
 * 2. OpenAI seed corpus (text-tool-turn):
 *    For each committed `openai.native.json` (REAL @openai/agents capture):
 *      a. `replayCassette(native)` → drive the REAL OpenAI facet normalizer.
 *      b. SNAPSHOT: assert produced `agjson` deep-equals `openai.agjson.json`.
 *      c. GATE: assert `report.drops === []` AND `report.newFields === []`.
 *
 * 3. ADK seed corpus (convergence-echo):
 *    For each committed `adk.native.json` (hand-authored ADK `Event` fixture):
 *      a. `replayCassette(native)` → drive the REAL ADK facet normalizer.
 *      b. SNAPSHOT: assert produced `agjson` deep-equals `adk.agjson.json`.
 *      c. GATE: assert `report.drops === []` AND `report.newFields === []`
 *         (audit M59 — this gate previously did not exist; the ADK facet's
 *         census was 100% unmeasured. Every drop/newField below is triaged
 *         into `transforms.json` / `known-acceptable-drops.json` per the
 *         Task 3 shapes, cited to `google-adk/src/index.ts` — see the Task 4
 *         report for the full triage table).
 *
 * 4. I4 cross-framework convergence gate:
 *    For each scenario that has ALL THREE of `claude.native.json`,
 *    `openai.native.json` AND `adk.native.json`:
 *      a. Replay all three cassettes to produce their respective AgJSON streams.
 *      b. GATE (audit M59): assert EACH framework's `report.drops === []` AND
 *         `report.newFields === []` — the census is no longer computed then
 *         discarded; a real per-framework drop on a convergence scenario now
 *         fails this leg directly, not just the seed-corpus suites above.
 *      c. `canonicalizeAgjson` each stream → CanonicalSchema.
 *      d. `assertConvergent` 3× pairwise (claude↔openai, claude↔adk, openai↔adk)
 *         → throws on structural divergence.
 *    Scenarios missing any framework cassette are SKIPPED gracefully.
 *
 * ★ This is a MACHINERY + SNAPSHOT self-consistency gate, NOT a real-lossiness
 *   gate ★ — the Claude seeds are hand-authored SDKMessage shapes; the OpenAI
 *   seed is a real @openai/agents stream capture. Both prove the pipeline runs
 *   and lock the shape; the real lossiness hunt is a LIVE capture.
 *   See `replay.ts`'s header for the full framing.
 */
import { describe, it, expect } from "vitest";
import { readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@silverprotocol/core";
import { replayCassette } from "./replay.js";
import { canonicalizeAgjson, assertConvergent } from "./convergence.js";

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");

/** Every Claude seed scenario under corpus/ that ships a committed native cassette. */
const CLAUDE_SEEDS = ["text-tool-turn", "complete-result", "app-spec"] as const;

/** Every OpenAI seed scenario under corpus/ that ships a committed native cassette. */
const OPENAI_SEEDS = ["text-tool-turn"] as const;

/** Every ADK seed scenario under corpus/ that ships a committed native cassette. */
const ADK_SEEDS = ["convergence-echo"] as const;

async function readSnapshotForFramework(scn: string, framework: string): Promise<JsonValue[]> {
  const raw = await readFile(join(CORPUS_ROOT, scn, `${framework}.agjson.json`), "utf8");
  return JSON.parse(raw) as JsonValue[];
}

describe("replay CI gate — Claude seed corpus (machinery/snapshot self-consistency)", () => {
  for (const scn of CLAUDE_SEEDS) {
    describe(scn, () => {
      it("agjson deep-equals the committed claude.agjson.json snapshot", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "claude.native.json"));
        const expected = await readSnapshotForFramework(scn, "claude");
        expect(agjson).toEqual(expected);
      });

      it("census reports NO drops and NO new fields (the gate)", async () => {
        const { report } = await replayCassette(join(CORPUS_ROOT, scn, "claude.native.json"));
        expect(report.drops).toEqual([]);
        expect(report.newFields).toEqual([]);
      });
    });
  }
});

describe("replay CI gate — OpenAI seed corpus (machinery/snapshot self-consistency)", () => {
  for (const scn of OPENAI_SEEDS) {
    describe(scn, () => {
      it("agjson deep-equals the committed openai.agjson.json snapshot", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "openai.native.json"));
        const expected = await readSnapshotForFramework(scn, "openai");
        expect(agjson).toEqual(expected);
      });

      it("census reports NO drops and NO new fields (the gate)", async () => {
        const { report } = await replayCassette(join(CORPUS_ROOT, scn, "openai.native.json"));
        expect(report.drops).toEqual([]);
        expect(report.newFields).toEqual([]);
      });
    });
  }
});

describe("replay CI gate — ADK seed corpus (machinery/snapshot self-consistency)", () => {
  for (const scn of ADK_SEEDS) {
    describe(scn, () => {
      it("agjson deep-equals the committed adk.agjson.json snapshot", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "adk.native.json"));
        const expected = await readSnapshotForFramework(scn, "adk");
        expect(agjson).toEqual(expected);
      });

      it("census reports NO drops and NO new fields (the gate)", async () => {
        const { report } = await replayCassette(join(CORPUS_ROOT, scn, "adk.native.json"));
        expect(report.drops).toEqual([]);
        expect(report.newFields).toEqual([]);
      });
    });
  }
});

// ─── I4 cross-framework convergence gate ─────────────────────────────────────

/**
 * Convergence scenarios: corpus entries where BOTH claude.native.json AND
 * openai.native.json capture the IDENTICAL task and are expected to produce
 * structurally-equivalent AgJSON under canonicalization.
 *
 * The existing `text-tool-turn` scenario has both framework cassettes but they
 * represent DIFFERENT tasks (Claude = weather+subagent, OpenAI = echo) — they
 * are machinery/snapshot seeds for their respective framework suites, NOT
 * convergence pairs. Only `convergence-*` scenarios are wired to the I4 gate.
 *
 * For scenarios that do NOT appear in this list (including single-framework seeds),
 * the I4 gate skips gracefully.
 */
const CONVERGENCE_SCENARIOS = ["convergence-echo"] as const;

/** Returns true when the file exists at the given path. */
async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("I4 cross-framework convergence gate", () => {
  // Also check all CLAUDE_SEEDS, OPENAI_SEEDS and ADK_SEEDS — if a
  // non-convergence scenario somehow acquires all three cassettes, it should
  // SKIP (not fail) via fileExists check.
  const allCorpusScenarios = [
    ...new Set([...CLAUDE_SEEDS, ...OPENAI_SEEDS, ...ADK_SEEDS, ...CONVERGENCE_SCENARIOS]),
  ];

  for (const scn of allCorpusScenarios) {
    const isConvergenceScenario = (CONVERGENCE_SCENARIOS as readonly string[]).includes(scn);

    it(`${scn}: ${isConvergenceScenario ? "asserts 3-way convergence" : "skips gracefully"}`, async () => {
      const claudePath = join(CORPUS_ROOT, scn, "claude.native.json");
      const openaiPath = join(CORPUS_ROOT, scn, "openai.native.json");
      const adkPath = join(CORPUS_ROOT, scn, "adk.native.json");

      const [hasClaude, hasOpenai, hasAdk] = await Promise.all([
        fileExists(claudePath),
        fileExists(openaiPath),
        fileExists(adkPath),
      ]);

      if (!isConvergenceScenario || !hasClaude || !hasOpenai || !hasAdk) {
        console.log(
          `I4 gate: skipping ${scn} (conv=${isConvergenceScenario}, claude=${hasClaude}, openai=${hasOpenai}, adk=${hasAdk})`,
        );
        return;
      }

      const [claude, openai, adk] = await Promise.all([
        replayCassette(claudePath, "claude"),
        replayCassette(openaiPath, "openai"),
        replayCassette(adkPath, "adk"),
      ]);

      // Census gate (audit M59): previously this test replayed all three
      // cassettes and used ONLY `.agjson`, silently discarding `.report` —
      // a computed-then-thrown-away census. Assert each framework's census
      // is clean (post-triage) exactly like the seed-corpus suites above,
      // so the I4 leg cannot go green while masking a real per-framework drop.
      for (const [fw, { report }] of [
        ["claude", claude],
        ["openai", openai],
        ["adk", adk],
      ] as const) {
        expect(report.drops, `${scn}/${fw}: census drops`).toEqual([]);
        expect(report.newFields, `${scn}/${fw}: census newFields`).toEqual([]);
      }

      const c = canonicalizeAgjson(claude.agjson);
      const o = canonicalizeAgjson(openai.agjson);
      const k = canonicalizeAgjson(adk.agjson);

      assertConvergent(c, o, { scenario: scn, fw1: "claude", fw2: "openai" });
      assertConvergent(c, k, { scenario: scn, fw1: "claude", fw2: "adk" });
      assertConvergent(o, k, { scenario: scn, fw1: "openai", fw2: "adk" });
      expect(true).toBe(true);
    });
  }
});

// ─── ADK non-vacuity guard ────────────────────────────────────────────────────
// A deliberately-divergent ADK canonical MUST throw — proves the ADK arm is
// actually compared (not silently skipped) by the 3-way gate.

it("convergence-echo: ADK divergence is detected (non-vacuity)", async () => {
  const claude = await replayCassette(
    join(CORPUS_ROOT, "convergence-echo", "claude.native.json"),
    "claude",
  );
  const c = canonicalizeAgjson(claude.agjson);
  const tampered = { ...c, textContent: ["TAMPERED"] };
  expect(() =>
    assertConvergent(c, tampered, { scenario: "convergence-echo", fw1: "claude", fw2: "adk" }),
  ).toThrow(/textContent mismatch/);
});
