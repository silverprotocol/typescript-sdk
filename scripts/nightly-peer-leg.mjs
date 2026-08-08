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

/**
 * Lockstep families: peers whose upstream publishes EXACT-pinned sibling
 * packages that must move together. The @ai-sdk family each pins
 * `@ai-sdk/provider-utils` exactly; forcing `ai` alone against the verified
 * (older) sibling pins installs TWO provider-utils copies whose
 * unique-symbol-branded `Schema` types break typecheck — which is upstream's
 * permanent, documented property, not a facet regression. Four consecutive
 * nightly filings during the 2026-08 vercel patch streak (typescript-sdk#12,
 * #14) re-discovered exactly that skew. The leg therefore forces the WHOLE
 * family to latest together — the documented supported pairing a consumer
 * following the compat table installs — so genuine facet-vs-new-ai breaks
 * still surface while the pure-skew noise class stops filing.
 */
const LOCKSTEP_FAMILIES = {
  // Membership is DERIVED, not hardcoded: the real family is "e2e's @ai-sdk
  // devDeps" — a future @ai-sdk provider added there would otherwise silently
  // under-force and the skew noise class would return (review finding).
  ai: () => {
    const e2e = JSON.parse(readFileSync(resolve(typescriptRoot, "packages/e2e/package.json"), "utf8"));
    return Object.keys(e2e.devDependencies ?? {}).filter((n) => n.startsWith("@ai-sdk/"));
  },
};

/** `npm view` with the same retry posture as check-peer-latest.mjs's
 *  fetchLatest: nightly red must mean "look at me", never "the registry
 *  blipped". Throws (with the real cause) after the last attempt. */
function npmView(viewArgs, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    const child = spawnSync("npm", ["view", ...viewArgs], { encoding: "utf8" });
    if (child.status === 0) return (child.stdout ?? "").trim();
    lastErr = [child.error?.message, `status=${child.status}`, (child.stderr ?? "").trim()]
      .filter(Boolean)
      .join(" ");
    if (i < attempts) spawnSync("sleep", [String(2 * i)]);
  }
  throw new Error(`npm view ${viewArgs.join(" ")} failed after ${attempts} attempts: ${lastErr}`);
}

/** Resolve a package's `latest` dist-tag from the registry. */
function latestOf(pkg) {
  const version = npmView([pkg, "version"]);
  if (!isValidVersion(version)) {
    throw new Error(`latest of lockstep sibling ${pkg} is not a version: ${JSON.stringify(version)}`);
  }
  return version;
}

/** The exact `@ai-sdk/provider-utils` pin of `name@ver`, or null when it has
 *  no such dependency (excluded from the coherence comparison). */
function providerUtilsPinOf(name, ver) {
  const raw = npmView([`${name}@${ver}`, "dependencies", "--json"]);
  if (raw.length === 0) return null;
  const deps = JSON.parse(raw);
  return typeof deps["@ai-sdk/provider-utils"] === "string" ? deps["@ai-sdk/provider-utils"] : null;
}

/**
 * Resolve the full forced combination: the peer plus its lockstep siblings
 * at their own latests — then verify the combination is COHERENT (every
 * member's exact `@ai-sdk/provider-utils` pin agrees). "Latest of each" is
 * not automatically "the blessed pairing": an upstream publish skew (ai out
 * minutes before its siblings) would force a mismatched pu pair — the exact
 * noise class the family force exists to silence (review finding). A skewed
 * combination is reported as `skew`, not tested.
 */
function resolveFamilyOverrides(peer, version) {
  const overrides = { [peer]: version };
  const family = LOCKSTEP_FAMILIES[peer]?.() ?? [];
  for (const sibling of family) overrides[sibling] = latestOf(sibling);
  if (family.length > 0) {
    const pins = {};
    for (const [name, ver] of Object.entries(overrides)) {
      const pin = providerUtilsPinOf(name, ver);
      if (pin !== null) pins[`${name}@${ver}`] = pin;
    }
    if (new Set(Object.values(pins)).size > 1) {
      return { overrides, skew: `mismatched @ai-sdk/provider-utils pins across the forced family: ${JSON.stringify(pins)}` };
    }
  }
  return { overrides };
}

/** Append the override stanza for the resolved combination. A pre-existing
 *  top-level `overrides:` key is a hard error, not a merge — on a CI
 *  checkout it means a committed override leaked in, which must fail loudly
 *  rather than compound. */
function applyOverride(overrides) {
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
    ...Object.entries(overrides).map(([name, ver]) => `  "${name}": "${ver}"`),
    "",
  ].join("\n");
  writeFileSync(workspaceYaml, text.endsWith("\n") ? text + stanza.slice(1) : text + stanza, "utf8");
  for (const [name, ver] of Object.entries(overrides)) {
    console.log(`override applied: ${name} → ${ver} (pnpm-workspace.yaml)`);
  }
}

/** An aborted leg still writes result.json: an artifact-less leg makes the
 *  report file a wrong, dedup-poisoned issue body (the hazard the workflow's
 *  `!cancelled()` wiring exists to prevent — review finding). */
function writeAborted(outDir, peer, version, kind, detail) {
  writeFileSync(
    resolve(outDir, "result.json"),
    JSON.stringify({ name: peer, version, stages: {}, aborted: { kind, detail } }, null, 2) + "\n",
    "utf8",
  );
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

  let resolved;
  try {
    resolved = resolveFamilyOverrides(peer, version);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    writeAborted(outDir, peer, version, "leg-infra", detail);
    console.error(`✖ leg infra failure before any stage: ${detail}`);
    process.exit(1);
  }
  if (resolved.skew !== undefined) {
    // Benign transient (upstream mid-publish) — surfaced in the report
    // summary, never filed, and the leg stays green: red must mean evidence.
    writeAborted(outDir, peer, version, "lockstep-skew", resolved.skew);
    console.log(`− leg skipped (lockstep publish skew): ${resolved.skew}`);
    return;
  }
  const overrides = resolved.overrides;
  applyOverride(overrides);

  // Policy neutralization for EVERY stage of this throwaway leg (note: pnpm 11
  // ignores npm_config_* entirely — only pnpm_config_* is read):
  //  - minimum_release_age=0: testing a release that may be hours old is this
  //    job's entire purpose. Two distinct enforcement points need it — the
  //    resolution gate at `pnpm install` (hard-fails exact pins younger than an
  //    explicit threshold, ERR_PNPM_NO_MATURE_MATCHING_VERSION), AND pnpm 11's
  //    verify-deps-before-run lockfile check that re-validates the lockfile
  //    against supply-chain policies on every subsequent `pnpm <script>`
  //    invocation. The original implementation attached this env to the
  //    install stage only, so the leg's install PASSED and then `pnpm
  //    typecheck` rejected the freshly-written lockfile entries
  //    (ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION) — the false [peer-compat]
  //    signal in run 29681822311 (issue #2). Neutralization must ride every
  //    stage.
  //  - strict_dep_builds=false: on CI, a dependency with a lifecycle script
  //    missing from allowBuilds hard-fails the install
  //    (ERR_PNPM_IGNORED_BUILDS) — a newer peer adding one transitive
  //    postinstall would masquerade as [peer-compat]. Downgraded to a warning
  //    WITHOUT executing the script; if the skipped script genuinely matters,
  //    typecheck/test/replay fail with real evidence instead.
  const LEG_ENV = {
    pnpm_config_minimum_release_age: "0",
    pnpm_config_strict_dep_builds: "false",
  };

  const stages = [
    {
      key: "install",
      cmd: ["pnpm", "install", "--no-frozen-lockfile"],
      required: true,
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
      extraEnv: { ...LEG_ENV, ...(stage.extraEnv ?? {}) },
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
    // `overrides` records the FULL forced combination (peer + lockstep
    // siblings) so the filed issue's evidence is honest about what ran;
    // the report reads name/version/stages and ignores unknown keys.
    JSON.stringify({ name: peer, version, stages: outcomes, overrides }, null, 2) + "\n",
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
