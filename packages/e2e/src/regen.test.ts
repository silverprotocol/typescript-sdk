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
  // Task 4b: deferred round-close (message.end + turn.done past a late
  // tool.done) reorders this scenario's tool-turn round — see
  // or-responses-regression.test.ts and index.test.ts (Task 4b describe block)
  // for the INV-MSG rationale. Verified: the ONLY delta is the close-reordering
  // (tool.done now precedes message.end/turn.done); no field additions/drops.
  { scenario: "text-tool-turn", framework: "openai" },
  // Task 6: INV-FLUSH turn closure (audit M21). This 2-message seed
  // (assistant tool-call + user tool-result) never delivers a terminal
  // `result` message — a genuinely truncated stream. flush() now truthfully
  // closes the still-open turn with `turn.abort{stream-truncated}` instead of
  // silently no-op'ing. Verified: the ONLY delta is the appended trailing
  // turn.abort event; no field additions/drops on the existing 9 events.
  { scenario: "app-spec", framework: "claude" },
  // Task 4 (audit M59): the ADK facet's census was never measured — this is
  // the FIRST-EVER regen of an ADK snapshot pair. See replay.test.ts's ADK
  // seed suite + the Task 4 report for the full drop/newField triage.
  { scenario: "convergence-echo", framework: "adk" },
  // Task 5 (audit M58): convergence-echo previously had NO claude/openai
  // agjson+coverage snapshot of its own — the vacuity-holed I4 assert was
  // its sole gate. FIRST-EVER regen of these two pairs; see the Task 5
  // report for the census outcome (both clean — no new triage needed).
  { scenario: "convergence-echo", framework: "claude" },
  { scenario: "convergence-echo", framework: "openai" },
  // Task 5 (audit M58): FIRST-EVER regen of the hand-authored
  // text-tool-turn/adk.native.json fixture (mirrors convergence-echo's
  // event grammar for the SAME echo task text-tool-turn/openai.native.json
  // already captures — see the Task 5 report for the 3-way convergence
  // investigation and why text-tool-turn is NOT added to
  // CONVERGENCE_SCENARIOS).
  { scenario: "text-tool-turn", framework: "adk" },
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
