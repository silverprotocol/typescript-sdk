/**
 * replay.test.ts — the KEYLESS replay CI gate (Task 6 deliverable).
 *
 * For each committed seed cassette `corpus/<scn>/claude.native.json`:
 *   1. `replayCassette(native)` → drive the REAL Claude facet normalizer.
 *   2. SNAPSHOT: assert the produced `agjson` deep-equals the committed
 *      `claude.agjson.json` (regression lock on the AgJSON shape).
 *   3. GATE: assert `report.drops === []` AND `report.newFields === []` — the
 *      census found no unclassified native value with no AgJSON home, and no
 *      norm-path outside the committed `field-registry.json`.
 *
 * ★ This is a MACHINERY + SNAPSHOT self-consistency gate, NOT a real-lossiness
 *   gate ★ — the seeds are hand-authored SDKMessage shapes (the facet's own
 *   read-set), transcribed from the guuey nocode-runtime test fixtures, so they
 *   surface ~zero drops by construction. They prove the pipeline runs and lock
 *   the shape; the real lossiness hunt is the operator's Task 7 LIVE capture.
 *   See `replay.ts`'s header for the full framing.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@silverprotocol/core";
import { replayCassette } from "./replay.js";

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");

/** Every seed scenario under corpus/ that ships a committed native cassette. */
const SEEDS = ["text-tool-turn", "complete-result", "app-spec"] as const;

async function readSnapshot(scn: string): Promise<JsonValue[]> {
  const raw = await readFile(join(CORPUS_ROOT, scn, "claude.agjson.json"), "utf8");
  return JSON.parse(raw) as JsonValue[];
}

describe("replay CI gate — seed corpus (machinery/snapshot self-consistency)", () => {
  for (const scn of SEEDS) {
    describe(scn, () => {
      it("agjson deep-equals the committed claude.agjson.json snapshot", async () => {
        const { agjson } = await replayCassette(join(CORPUS_ROOT, scn, "claude.native.json"));
        const expected = await readSnapshot(scn);
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
