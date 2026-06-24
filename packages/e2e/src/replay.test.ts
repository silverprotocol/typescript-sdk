/**
 * replay.test.ts — the KEYLESS replay CI gate.
 *
 * Two suites:
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
 * 3. I4 cross-framework convergence gate:
 *    For each scenario that has BOTH `claude.native.json` AND `openai.native.json`:
 *      a. Replay both cassettes to produce their respective AgJSON streams.
 *      b. `canonicalizeAgjson` each stream → CanonicalSchema.
 *      c. `assertConvergent(claude, openai, ctx)` → throws on structural divergence.
 *    Scenarios with only one framework cassette are SKIPPED gracefully.
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
  // Also check all CLAUDE_SEEDS and OPENAI_SEEDS — if a non-convergence scenario
  // somehow acquires both cassettes, it should SKIP (not fail) via fileExists check.
  const allCorpusScenarios = [
    ...new Set([...CLAUDE_SEEDS, ...OPENAI_SEEDS, ...CONVERGENCE_SCENARIOS]),
  ];

  for (const scn of allCorpusScenarios) {
    const isConvergenceScenario = (CONVERGENCE_SCENARIOS as readonly string[]).includes(scn);

    it(`${scn}: ${isConvergenceScenario ? "asserts convergence" : "skips gracefully (not a convergence scenario)"}`, async () => {
      const claudePath = join(CORPUS_ROOT, scn, "claude.native.json");
      const openaiPath = join(CORPUS_ROOT, scn, "openai.native.json");

      const [hasClaudeNative, hasOpenaiNative] = await Promise.all([
        fileExists(claudePath),
        fileExists(openaiPath),
      ]);

      if (!isConvergenceScenario || !hasClaudeNative || !hasOpenaiNative) {
        // Not a convergence scenario, or missing one cassette — skip gracefully.
        console.log(
          `I4 gate: skipping ${scn} (isConvergence=${isConvergenceScenario}, hasClaudeNative=${hasClaudeNative}, hasOpenaiNative=${hasOpenaiNative})`,
        );
        return;
      }

      // Convergence scenario with both cassettes present — assert structural equivalence.
      const [claudeResult, openaiResult] = await Promise.all([
        replayCassette(claudePath, "claude"),
        replayCassette(openaiPath, "openai"),
      ]);

      const claudeCanonical = canonicalizeAgjson(claudeResult.agjson);
      const openaiCanonical = canonicalizeAgjson(openaiResult.agjson);

      // assertConvergent throws with an aggregated diff on any structural mismatch.
      assertConvergent(claudeCanonical, openaiCanonical, {
        scenario: scn,
        fw1: "claude",
        fw2: "openai",
      });

      // If we reach here, the two streams are structurally equivalent.
      expect(true).toBe(true);
    });
  }
});
