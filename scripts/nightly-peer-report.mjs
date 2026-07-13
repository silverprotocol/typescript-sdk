/**
 * nightly-peer-report.mjs — turn the nightly peer-check results into GitHub
 * issues (the report job of `.github/workflows/nightly-peer-check.yml`).
 *
 *   node scripts/nightly-peer-report.mjs --scan scan.json --results <dir> \
 *     --repo owner/name [--dry-run] [--existing issues.json]
 *
 * Inputs:
 *   --scan     JSON array from check-peer-latest.mjs (one item per peer).
 *   --results  directory of downloaded leg artifacts:
 *              <dir>/peer-result-<facet>/result.json (+ drift.log).
 *   --repo     GitHub `owner/name` to file issues against (in CI:
 *              $GITHUB_REPOSITORY — i.e. the public mirror, the only repo
 *              the workflow's GITHUB_TOKEN can write to).
 *   --dry-run  print every `gh` mutation instead of executing it.
 *   --existing fixture file standing in for the `gh issue list` fetch
 *              (local testing without a token; pairs with --dry-run).
 *
 * Signals (per peer, judged from the scan verdict + leg outcomes):
 *   [peer-drift]  latest is OUTSIDE the declared peer range. Filed even when
 *                 the leg is green — a green leg just means the range bump is
 *                 probably mechanical. Ships the ritual checklist.
 *   [peer-compat] latest is INSIDE the declared range but a required stage
 *                 failed — consumers installing latest get a broken
 *                 combination npm itself won't warn about. Most urgent.
 *   (in range + green leg → no action.)
 *
 * Dedup contract: THE EXACT ISSUE TITLE IS THE KEY. Before filing, every
 * issue under the signal's label is listed (open AND closed) and an exact
 * title match means skip — closing an issue as wontfix therefore stays
 * closed for that version; the next upstream version mints a new title.
 * When a new issue IS filed, still-open issues for the SAME peer + signal
 * (older versions) are closed as superseded. Retitling a filed issue by
 * hand breaks the dedup key and will cause a duplicate on the next run.
 *
 * Exit code: 0 even when issues were filed (red legs already mark the run);
 * 1 only when the report itself could not do its job (missing leg artifact,
 * gh failure) — infra problems must look different from upstream drift.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_STAGES = ["install", "typecheck", "test", "replay"];
const LABELS = {
  "peer-drift": { color: "D93F0B", description: "upstream released outside the declared peer range" },
  "peer-compat": { color: "B60205", description: "latest in-range upstream release breaks the keyless gate suite" },
};

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--scan": args.scan = argv[++i]; break;
      case "--results": args.results = argv[++i]; break;
      case "--repo": args.repo = argv[++i]; break;
      case "--existing": args.existing = argv[++i]; break;
      case "--dry-run": args.dryRun = true; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (!args.scan || !args.results || !args.repo) {
    throw new Error("usage: nightly-peer-report.mjs --scan <file> --results <dir> --repo <owner/name> [--dry-run] [--existing <file>]");
  }
  return args;
}

// ─── gh plumbing ─────────────────────────────────────────────────────────────

function gh(args, { dryRun, capture = true }) {
  if (dryRun) {
    console.log(`[dry-run] gh ${args.join(" ")}`);
    return "";
  }
  const child = spawnSync("gh", args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`gh ${args[0]} ${args[1] ?? ""} exited ${child.status}`);
  return capture ? child.stdout : "";
}

/** Every issue (open AND closed) under `label` — the dedup universe. */
function listIssues(label, { repo, dryRun, existing }) {
  if (existing) {
    return JSON.parse(readFileSync(existing, "utf8")).filter((i) => (i.labels ?? [label]).includes(label));
  }
  if (dryRun) return [];
  return JSON.parse(
    gh(
      ["issue", "list", "--repo", repo, "--label", label, "--state", "all", "--limit", "1000", "--json", "number,title,state"],
      { dryRun },
    ),
  );
}

// ─── issue bodies ────────────────────────────────────────────────────────────

function stageTable(leg) {
  const rows = [...REQUIRED_STAGES, "fixture-drift"].map((k) => {
    const outcome = leg?.stages?.[k] ?? "unknown";
    const mark = outcome === "success" ? "✓" : outcome === "failure" ? "**✖ failure**" : outcome;
    return `| ${k}${k === "fixture-drift" ? " (informational)" : ""} | ${mark} |`;
  });
  return ["| stage | outcome |", "| --- | --- |", ...rows].join("\n");
}

function factsTable(item) {
  return [
    "| | |",
    "| --- | --- |",
    `| facet | \`packages/${item.facet}\` (\`${item.facetPkg}\`) |`,
    `| declared peer range | \`${item.range}\` |`,
    `| latest upstream | \`${item.latest}\` |`,
    `| e2e devDependency pin | \`${item.pinned ?? "—"}\` |`,
    `| newest verified (\`sdk-surface.json\`) | \`${item.newestVerified?.sdkVersion ?? "—"}\` (${item.newestVerified?.date ?? "never"}) |`,
  ].join("\n");
}

function ritualChecklist(item) {
  return [
    `To adopt \`${item.latest}\` (the verification ritual — see the \`scripts/render-compat.mjs\` header):`,
    "",
    `- [ ] override locally (temporary \`overrides:\` stanza in \`pnpm-workspace.yaml\`, or \`node scripts/nightly-peer-leg.mjs ${item.name} ${item.latest} --out /tmp/leg\` on a throwaway checkout) and triage \`pnpm fixture-drift\`'s surface diff into \`packages/${item.facet}/sdk-surface.json\`'s member dispositions (\`members\` / \`sections.*.members\`, whichever this facet uses)`,
    "- [ ] `pnpm typecheck && pnpm test && pnpm e2e:replay` green against it",
    "- [ ] (recommended) live `pnpm e2e:capture` with a real key",
    `- [ ] append the \`packages/${item.facet}/sdk-surface.json#verified\` entry (sdkVersion, date, silverprotocol, evidence) and bump its \`verifiedAt\` to match`,
    `- [ ] bump \`peerDependencies\` in \`packages/${item.facet}/package.json\` + the \`packages/e2e\` devDependency pin (and the facet's own devDependency pin where it has one)`,
    "- [ ] `node scripts/render-compat.mjs` to refresh the README compatibility table",
  ].join("\n");
}

function driftLogSection(item, resultsDir) {
  const logPath = join(resultsDir, `peer-result-${item.facet}`, "drift.log");
  if (!existsSync(logPath)) return "";
  let log = readFileSync(logPath, "utf8");
  const lines = log.split("\n");
  let truncated = "";
  if (lines.length > 120 || log.length > 8_000) {
    log = lines.slice(-120).join("\n").slice(-8_000);
    truncated = "(truncated to the tail — full log in the workflow run's `peer-result` artifact)\n\n";
  }
  return [
    "",
    "<details>",
    `<summary>fixture-drift report against \`${item.latest}\` (informational)</summary>`,
    "",
    "The gate's pin↔verified-log mismatch line is EXPECTED under the nightly override — the surface-diff findings are the signal.",
    "",
    truncated + "```",
    log.trimEnd(),
    "```",
    "",
    "</details>",
  ].join("\n");
}

const FOOTER =
  "\n---\n*Filed automatically by `.github/workflows/nightly-peer-check.yml`. " +
  "The exact title is the dedup key — retitling this issue may cause a duplicate on the next nightly run. " +
  "The gate suite is keyless (`e2e:replay`), so a green run vouches for import/type/wire-fixture compatibility, not live behavior.*";

function driftBody(item, leg, resultsDir) {
  const legVerdict = leg && REQUIRED_STAGES.every((k) => leg.stages?.[k] === "success")
    ? `The keyless gate suite is **green** against \`${item.latest}\` — the range bump is probably mechanical, but still walk the ritual below.`
    : `The keyless gate suite has **failures** against \`${item.latest}\` (table below) — adapter work is likely needed, not just a range bump.`;
  return [
    `\`${item.name}\` published \`${item.latest}\`, which is **outside** the declared peer range of \`${item.facetPkg}\`. ` +
      "Consumers installing latest alongside this facet now get an npm peer warning.",
    "",
    factsTable(item),
    "",
    legVerdict,
    "",
    `Nightly CI, with \`${item.latest}\` forced workspace-wide via pnpm override:`,
    "",
    stageTable(leg),
    "",
    ritualChecklist(item),
    driftLogSection(item, resultsDir),
    FOOTER,
  ].join("\n");
}

function compatBody(item, leg, resultsDir) {
  return [
    `\`${item.name}@${item.latest}\` is **inside** the declared peer range \`${item.range}\` of \`${item.facetPkg}\`, ` +
      "but the keyless gate suite fails against it — consumers installing latest get a broken combination **today**, with no npm warning. " +
      "Either fix the facet or tighten the range's upper bound (and release) so npm warns honestly.",
    "",
    factsTable(item),
    "",
    stageTable(leg),
    "",
    ritualChecklist(item),
    driftLogSection(item, resultsDir),
    FOOTER,
  ].join("\n");
}

// ─── main ────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scan = JSON.parse(readFileSync(args.scan, "utf8"));
  const resultsDir = resolve(args.results);
  const summaryRows = [];
  const infraProblems = [];
  const bodyDir = mkdtempSync(join(tmpdir(), "peer-report-"));

  for (const label of Object.keys(LABELS)) {
    gh(
      ["label", "create", label, "--repo", args.repo, "--color", LABELS[label].color, "--description", LABELS[label].description, "--force"],
      { dryRun: args.dryRun, capture: false },
    );
  }

  for (const item of scan) {
    const legPath = join(resultsDir, `peer-result-${item.facet}`, "result.json");
    const leg = existsSync(legPath) ? JSON.parse(readFileSync(legPath, "utf8")) : null;
    if (!leg) infraProblems.push(`missing leg artifact for ${item.facet} (expected ${legPath})`);
    const requiredFailed = !leg || !REQUIRED_STAGES.every((k) => leg.stages?.[k] === "success");

    let signal = null;
    if (!item.inRange) signal = "peer-drift";
    else if (leg && requiredFailed) signal = "peer-compat";
    // in range + missing leg: an infra problem, not evidence of breakage —
    // recorded above, never filed as [peer-compat].

    if (!signal) {
      summaryRows.push(`| \`${item.name}\` | \`${item.latest}\` | in range, gate green | — |`);
      continue;
    }

    const title =
      signal === "peer-drift"
        ? `[peer-drift] ${item.name}@${item.latest} is outside the declared peer range`
        : `[peer-compat] ${item.name}@${item.latest} fails CI within the declared peer range`;
    const existing = listIssues(signal, { repo: args.repo, dryRun: args.dryRun, existing: args.existing });
    const match = existing.find((i) => i.title === title);
    if (match) {
      console.log(`already filed (${match.state} #${match.number}): ${title}`);
      summaryRows.push(`| \`${item.name}\` | \`${item.latest}\` | ${signal} | already filed #${match.number} (${match.state}) |`);
      continue;
    }

    const bodyFile = join(bodyDir, `${item.facet}-${signal}.md`);
    const body = signal === "peer-drift" ? driftBody(item, leg, resultsDir) : compatBody(item, leg, resultsDir);
    writeFileSync(bodyFile, body, "utf8");
    if (args.dryRun) console.log(`[dry-run] issue body for ${JSON.stringify(title)}:\n${body}\n`);
    const createdUrl = gh(
      ["issue", "create", "--repo", args.repo, "--title", title, "--body-file", bodyFile, "--label", signal],
      { dryRun: args.dryRun },
    ).trim();
    const createdRef = createdUrl ? `#${createdUrl.split("/").pop()}` : "(dry-run)";
    console.log(`filed ${createdRef}: ${title}`);
    summaryRows.push(`| \`${item.name}\` | \`${item.latest}\` | ${signal} | filed ${createdRef} |`);

    // supersede: older still-open issues for the same peer + signal.
    const prefix = `[${signal}] ${item.name}@`;
    for (const old of existing.filter((i) => i.state === "OPEN" && i.title.startsWith(prefix) && i.title !== title)) {
      gh(
        ["issue", "close", String(old.number), "--repo", args.repo, "--comment",
         `Superseded by ${createdRef}: \`${item.name}\` latest is now \`${item.latest}\`.`],
        { dryRun: args.dryRun, capture: false },
      );
      console.log(`closed superseded #${old.number}: ${old.title}`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ["### Nightly peer report", "", "| peer | latest | verdict | action |", "| --- | --- | --- | --- |", ...summaryRows, ""].join("\n"),
    );
  }
  if (infraProblems.length > 0) {
    console.error(`✖ report incomplete:\n  ${infraProblems.join("\n  ")}`);
    process.exit(1);
  }
}

// Import-safe guard kept for symmetry with the other scripts (and so a test
// harness could import the body builders without side effects).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
