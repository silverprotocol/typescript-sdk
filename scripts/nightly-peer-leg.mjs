/**
 * nightly-peer-leg.mjs — one matrix leg of the nightly peer check: force a
 * single upstream peer to a given version and run the keyless gate suite
 * against it, recording per-stage outcomes as a machine-readable artifact
 * for `nightly-peer-report.mjs`.
 *
 *   node scripts/nightly-peer-leg.mjs <peer> <version> --out <dir>
 *   e.g. node scripts/nightly-peer-leg.mjs @openai/agents 0.14.0 --out leg-result
 *
 * What it does, in order (CI-only; it MUTATES pnpm-workspace.yaml and the
 * lockfile — run it on a throwaway checkout, never commit the result):
 *   1. append an `overrides:` stanza to pnpm-workspace.yaml pinning
 *      <peer> to <version> workspace-wide. pnpm 11 reads overrides from
 *      pnpm-workspace.yaml, NOT from a package.json `pnpm` field (that field
 *      is no longer read — verified empirically, see pnpm-workspace.yaml).
 *   2. `pnpm install --no-frozen-lockfile` with the release-age and
 *      strict-dep-builds gates neutralized via pnpm_config_* env (see the
 *      install stage below) — the whole point is to test a release that may
 *      be hours old.
 *   3. required stages: `pnpm typecheck`, `pnpm test`, `pnpm e2e:replay`.
 *      Keyless: import/type/wire-fixture breaks, NOT live behavioral drift
 *      (that is `e2e:capture`, a human step with real keys).
 *   4. informational stage: `pnpm fixture-drift`, output captured to
 *      drift.log. Whenever the forced version differs from the e2e pin this
 *      gate fails its pin↔verified-log assertion by construction, so its
 *      exit code is deliberately NOT a signal — but its surface diff is the
 *      most precise "what changed upstream" report we have, so the log
 *      rides along into the filed issue.
 *
 * Writes <dir>/result.json (+ <dir>/drift.log) even when stages fail, THEN
 * exits 1 if any required stage failed — the leg shows red in the Actions
 * UI while the report job still gets its data.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidPackageName, isValidVersion } from "./check-peer-latest.mjs";

const typescriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Append the override stanza. A pre-existing top-level `overrides:` key is
 *  a hard error, not a merge — on a CI checkout it means a committed
 *  override leaked in, which must fail loudly rather than compound. */
function applyOverride(peer, version) {
  const workspaceYaml = resolve(typescriptRoot, "pnpm-workspace.yaml");
  const text = readFileSync(workspaceYaml, "utf8");
  if (/^overrides\s*:/m.test(text)) {
    throw new Error("pnpm-workspace.yaml already has a top-level `overrides:` key — refusing to append a second one");
  }
  const stanza = [
    "",
    "# nightly-peer-check override — appended by scripts/nightly-peer-leg.mjs on a",
    "# throwaway CI checkout. If you are seeing this in a committed file, revert it.",
    "overrides:",
    `  "${peer}": "${version}"`,
    "",
  ].join("\n");
  writeFileSync(workspaceYaml, text.endsWith("\n") ? text + stanza.slice(1) : text + stanza, "utf8");
  console.log(`override applied: ${peer} → ${version} (pnpm-workspace.yaml)`);
}

/** Run one stage. `capture` buffers combined output (for drift.log) instead
 *  of streaming; everything else streams live into the Actions log. */
function run(cmd, args, { capture = false, extraEnv = {} } = {}) {
  const child = spawnSync(cmd, args, {
    cwd: typescriptRoot,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  if (child.error) throw child.error;
  return { ok: child.status === 0, output: capture ? `${child.stdout ?? ""}${child.stderr ?? ""}` : null };
}

function main() {
  const argv = process.argv.slice(2);
  const outFlag = argv.indexOf("--out");
  const positional = argv.filter((_, i) => i !== outFlag && i !== outFlag + 1);
  if (outFlag === -1 || !argv[outFlag + 1] || positional.length !== 2) {
    console.error("usage: node scripts/nightly-peer-leg.mjs <peer> <version> --out <dir>");
    process.exit(2);
  }
  const outDir = resolve(process.cwd(), argv[outFlag + 1]);
  const [peer, version] = positional;
  if (!isValidPackageName(peer)) throw new Error(`not an npm package name: ${JSON.stringify(peer)}`);
  if (!isValidVersion(version)) throw new Error(`not a full semver version: ${JSON.stringify(version)}`);
  mkdirSync(outDir, { recursive: true });

  applyOverride(peer, version);

  const stages = [
    {
      key: "install",
      cmd: ["pnpm", "install", "--no-frozen-lockfile"],
      required: true,
      // Both env overrides verified empirically against pnpm 11.2.2 (note:
      // pnpm 11 ignores npm_config_* entirely — only pnpm_config_* is read):
      //  - minimum_release_age=0: with no explicit minimumReleaseAge the
      //    default gate is LOOSE (installs succeed; pnpm auto-appends to
      //    minimumReleaseAgeExclude — harmless on this throwaway checkout),
      //    but an explicit setting hard-fails exact pins younger than the
      //    threshold with ERR_PNPM_NO_MATURE_MATCHING_VERSION. Testing a
      //    release that may be hours old is this job's entire purpose, so
      //    the gate is pinned off either way.
      //  - strict_dep_builds=false: on CI, a dependency with a lifecycle
      //    script missing from allowBuilds hard-fails the install
      //    (ERR_PNPM_IGNORED_BUILDS) — a newer peer adding one transitive
      //    postinstall would masquerade as [peer-compat]. This downgrades
      //    that to a warning WITHOUT executing the script; if the skipped
      //    script genuinely matters, typecheck/test/replay fail with real
      //    evidence instead.
      extraEnv: {
        pnpm_config_minimum_release_age: "0",
        pnpm_config_strict_dep_builds: "false",
      },
    },
    { key: "typecheck", cmd: ["pnpm", "typecheck"], required: true },
    { key: "test", cmd: ["pnpm", "test"], required: true },
    { key: "replay", cmd: ["pnpm", "e2e:replay"], required: true },
    { key: "fixture-drift", cmd: ["pnpm", "fixture-drift"], required: false, capture: true },
  ];

  const outcomes = {};
  let requiredFailed = false;
  for (const stage of stages) {
    if (outcomes.install === "failure") {
      // no node_modules, nothing downstream can run. Every OTHER failure
      // deliberately does NOT cascade: "typecheck red but test/replay green"
      // (type-only drift) is a distinction the filed issue should carry.
      outcomes[stage.key] = "skipped";
      continue;
    }
    console.log(`::group::${stage.key}${stage.required ? "" : " (informational)"} — ${stage.cmd.join(" ")}`);
    const { ok, output } = run(stage.cmd[0], stage.cmd.slice(1), {
      capture: stage.capture ?? false,
      extraEnv: stage.extraEnv ?? {},
    });
    if (output !== null) {
      process.stdout.write(output);
      if (stage.key === "fixture-drift") writeFileSync(resolve(outDir, "drift.log"), output, "utf8");
    }
    console.log("::endgroup::");
    outcomes[stage.key] = ok ? "success" : "failure";
    if (!ok && stage.required) requiredFailed = true;
  }

  writeFileSync(
    resolve(outDir, "result.json"),
    JSON.stringify({ name: peer, version, stages: outcomes }, null, 2) + "\n",
    "utf8",
  );

  const summary = stages.map((s) => `${s.key}=${outcomes[s.key]}`).join("  ");
  if (requiredFailed) {
    console.error(`✖ ${peer}@${version}: ${summary}`);
    process.exit(1);
  }
  console.log(`✓ ${peer}@${version}: ${summary}`);
}

// No import-safe guard needed: nothing imports this module. Kept as a plain
// entrypoint so `node scripts/nightly-peer-leg.mjs` is the whole interface.
main();
