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
  // Playbook 2026-07-03 (model-release run): FIRST-EVER regen of the new
  // live-model seed cassettes. The corpus triple `pnpm e2e:capture` writes at
  // capture time computes `coverage.json` against EMPTY guard maps (capture.ts's
  // runCapture inline census — it never loads transforms.json/known-acceptable-
  // drops.json/field-registry.json), so the committed coverage.json needs this
  // regen pass to reflect the REAL guard-filtered census (the one replay.test.ts's
  // CI gate actually asserts against). echo-gpt55/openai's agjson.json ALSO needs
  // regenerating for a second reason: it was captured before this same playbook
  // step's Finding #2 fix (toolOutputToAgBlocks's missing "input_text" arm) — the
  // committed capture-time agjson had `tool.done.content: []` (the tool result
  // text silently dropped); this regen re-normalizes the SAME native.json through
  // the FIXED facet.
  { scenario: "echo-sonnet5", framework: "claude" },
  { scenario: "echo-gpt55", framework: "openai" },
  // Playbook 2026-07-03 follow-up (structuredContent under 0.12.0 fix): FIRST
  // live capture of a structuredContent-bearing MCP tool (render_card,
  // app-spec-structured-result) against gpt-5.5 / agents-core 0.12.0, proving
  // the customDataExtractor + extractStructuredContent fix end-to-end. Same
  // empty-guard-maps reason as echo-sonnet5/echo-gpt55 above — the committed
  // coverage.json needs this regen pass to reflect the real guard-filtered
  // census (drops===[], newFields===[] after triage — see known-acceptable-
  // drops.json/transforms.json/field-registry.json additions in the same commit).
  { scenario: "app-spec-structured-result", framework: "openai" },
  // Playbook 2026-07-13 (model-release run, gpt-5.6 + official @google/adk):
  // FIRST-EVER regen of the two new live seeds. Same empty-guard-maps reason
  // as echo-sonnet5/echo-gpt55 above. echo-gemini35/adk's agjson.json ALSO
  // needs regenerating for a second reason: it was captured before the
  // per-turn usage-summation fix this same playbook step landed (the census
  // caught the tool round's usageMetadata — incl. thoughtsTokenCount 125 —
  // vanishing from turn.done; the regen re-normalizes the SAME native.json
  // through the fixed facet).
  { scenario: "echo-gpt56", framework: "openai" },
  { scenario: "echo-gemini35", framework: "adk" },
  // Mirror reconciliation (2026-07-13): four live @google/adk 1.3.0 cassettes
  // captured 2026-07-08 directly on the public mirror (parallel migration,
  // never subtree-pulled). native+provenance adopted verbatim; these regen
  // targets produce their agjson/coverage through the CURRENT facet (per-turn
  // usage summation) + current guard files — the mirror's derived copies were
  // deliberately not adopted.
  { scenario: "multi-turn", framework: "adk" },
  { scenario: "single-tool-call", framework: "adk" },
  { scenario: "text-only", framework: "adk" },
  { scenario: "tool-error", framework: "adk" },
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
