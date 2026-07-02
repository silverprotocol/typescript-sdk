/**
 * regen.test.ts — deterministic snapshot regenerator (Task 7 Step 4 mechanism,
 * introduced early by Task 3 because its own engine fix legitimately drifts a
 * committed golden snapshot — see the commit body for the drift analysis).
 *
 * NOT part of the CI gate — runs only with REGEN=1, replays the committed
 * native cassette through the CURRENT normalizer, and rewrites the agjson +
 * coverage snapshots. Native cassettes are never touched.
 *
 *   REGEN=1 npx vitest run --root sdks/typescript packages/e2e/src/regen.test.ts
 *
 * `scenarios` lists ONLY the {scenario, framework} pairs whose committed
 * snapshot actually drifted for the change being landed — never a blanket
 * regen of the whole corpus. Extend this list per-task as later tasks in the
 * Wave 1 sequence cause further (verified-legitimate) drift.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { replayCassette } from "./replay.js";

const scenarios: Array<{ scenario: string; framework: "claude" | "openai" | "adk" }> = [
  { scenario: "text-tool-turn", framework: "claude" },
];

describe.runIf(process.env["REGEN"] === "1")("snapshot regeneration", () => {
  for (const { scenario, framework } of scenarios) {
    it(`regenerates ${scenario}/${framework}`, async () => {
      const dir = join(import.meta.dirname, "..", "corpus", scenario);
      const { agjson, report } = await replayCassette(join(dir, `${framework}.native.json`), framework);
      writeFileSync(join(dir, `${framework}.agjson.json`), JSON.stringify(agjson, null, 2) + "\n");
      writeFileSync(
        join(dir, `${framework}.coverage.json`),
        JSON.stringify(report, null, 2) + "\n"
      );
    });
  }
});
