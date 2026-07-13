/**
 * check-peer-latest.mjs — nightly upstream-drift scan (consumed by
 * `.github/workflows/nightly-peer-check.yml`).
 *
 * For every facet package with a non-@silverprotocol peerDependency, fetch
 * the peer's `dist-tags.latest` from the npm registry and evaluate it against
 * the DECLARED peer range (the npm-enforced contract render-compat.mjs also
 * reads). Emits one JSON item per peer — the nightly workflow fans a test
 * matrix out of it and `nightly-peer-report.mjs` turns the combined results
 * into GitHub issues. This script only OBSERVES; it never judges (exit 0
 * whether or not latest is in range — a red scan means the scan itself
 * broke, e.g. the registry was unreachable after retries).
 *
 * Dependency-free by the same no-install discipline as every script here
 * (see vitest.config.ts): instead of the `semver` package this file carries
 * a STRICT evaluator for the only range grammar this repo uses —
 * whitespace-ANDed comparators (`>=A <B`). Anything else (`^`, `~`, `||`,
 * x-ranges) is a hard error, never a guess: extend `parseComparator`
 * consciously if a facet ever needs richer ranges. npm's prerelease rule is
 * preserved (a prerelease only satisfies a range when a comparator carries a
 * prerelease on the SAME [major.minor.patch] tuple), so `2.0.0-rc.1` does
 * NOT satisfy `>=1.0.0 <2` — matching what npm would tell a consumer.
 *
 * Usage:
 *   node scripts/check-peer-latest.mjs               # scan (network)
 *   node scripts/check-peer-latest.mjs --self-test   # assert the evaluator
 *                                                    # against the spec table
 *                                                    # (no network; CI runs
 *                                                    # this before the scan)
 *
 * In GitHub Actions the item list is also written to `$GITHUB_OUTPUT` as
 * `peers=<compact JSON>` and a human table to `$GITHUB_STEP_SUMMARY`.
 */
import { appendFile, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const typescriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── strict semver subset (versions + whitespace-ANDed comparators) ─────────

const VERSION_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Full `major.minor.patch[-prerelease][+build]` only. Build metadata is
 *  parsed and ignored (SemVer §10). Throws on anything else. */
export function parseVersion(v) {
  const m = VERSION_RE.exec(v);
  if (!m) throw new Error(`not a full semver version: ${JSON.stringify(v)}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

export function isValidVersion(v) {
  return typeof v === "string" && VERSION_RE.test(v);
}

/** npm package name (scoped or not) — used to validate before a name is ever
 *  interpolated into a file or command argument. */
export function isValidPackageName(n) {
  return (
    typeof n === "string" &&
    /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/.test(n) &&
    n.length <= 214
  );
}

/** SemVer §11 total order. Returns -1 | 0 | 1 (build metadata ignored). */
export function compareVersions(a, b) {
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1; // release > any of its prereleases
  if (bp.length === 0) return -1;
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return -1; // shorter prerelease sorts first
    if (bp[i] === undefined) return 1;
    if (ap[i] === bp[i]) continue;
    const an = /^\d+$/.test(ap[i]);
    const bn = /^\d+$/.test(bp[i]);
    if (an && bn) return Number(ap[i]) < Number(bp[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1; // numeric < alphanumeric
    return ap[i] < bp[i] ? -1 : 1;
  }
  return 0;
}

/**
 * One comparator: `>=`/`>`/`<`/`<=`/`=`(implied) + version. Partial versions
 * (`<2`, `>=0.2`) are zero-padded, which matches npm's desugaring for `>=`
 * and `<` ONLY (`<2` → `<2.0.0`) — for `>`/`<=` npm bumps the tuple instead
 * (`>1.2` → `>=1.3.0`), so partials there are rejected rather than silently
 * mis-evaluated.
 */
function parseComparator(raw) {
  const m = /^(>=|<=|>|<|=)?(.+)$/.exec(raw);
  const op = m[1] ?? "=";
  let ver = m[2];
  if (/^\d+(\.\d+)?$/.test(ver)) {
    if (op !== ">=" && op !== "<") {
      throw new Error(
        `unsupported partial version in comparator ${JSON.stringify(raw)} — ` +
          `zero-padding only matches npm for \`>=\` and \`<\``,
      );
    }
    const parts = m[2].split("."); // zero-pad to major.minor.patch

    while (parts.length < 3) parts.push("0");
    ver = parts.join(".");
  }
  return { op, version: parseVersion(ver) };
}

/** Whitespace-ANDed comparators only; `||` and range sugar are hard errors. */
export function parseRange(range) {
  if (typeof range !== "string" || range.includes("||")) {
    throw new Error(`unsupported range (\`||\` alternatives): ${JSON.stringify(range)}`);
  }
  if (/[~^*]|[\d.]x(\b|$)/i.test(range)) {
    throw new Error(
      `unsupported range sugar in ${JSON.stringify(range)} — ` +
        `this repo's peer ranges are plain \`>=A <B\` comparators; extend parseComparator consciously`,
    );
  }
  const comparators = range.trim().split(/\s+/).filter(Boolean).map(parseComparator);
  if (comparators.length === 0) throw new Error(`empty range: ${JSON.stringify(range)}`);
  return comparators;
}

/** npm-compatible satisfaction, including the prerelease gate. */
export function satisfies(version, range) {
  const v = parseVersion(version);
  const comparators = parseRange(range);
  if (
    v.prerelease.length > 0 &&
    !comparators.some(
      (c) =>
        c.version.prerelease.length > 0 &&
        c.version.major === v.major &&
        c.version.minor === v.minor &&
        c.version.patch === v.patch,
    )
  ) {
    return false; // npm: prereleases never match comparator-only ranges
  }
  return comparators.every((c) => {
    const cmp = compareVersions(v, c.version);
    switch (c.op) {
      case ">=": return cmp >= 0;
      case "<=": return cmp <= 0;
      case ">": return cmp > 0;
      case "<": return cmp < 0;
      case "=": return cmp === 0;
      default: throw new Error(`unreachable op ${c.op}`);
    }
  });
}

// ─── self-test (CI runs this before every scan; no network) ─────────────────

function selfTest() {
  const cases = [
    // the three live facet ranges
    ["0.3.199", ">=0.2.76 <0.4", true],
    ["0.4.0", ">=0.2.76 <0.4", false],
    ["0.2.76", ">=0.2.76 <0.4", true],
    ["0.2.75", ">=0.2.76 <0.4", false],
    ["0.13.9", ">=0.2.0 <0.14", true],
    ["0.14.0", ">=0.2.0 <0.14", false],
    ["1.3.0", ">=1.0.0 <2", true],
    ["2.0.0", ">=1.0.0 <2", false],
    // npm prerelease gate: a prerelease below the upper bound still does NOT satisfy
    ["2.0.0-rc.1", ">=1.0.0 <2", false],
    ["1.5.0-beta.1", ">=1.0.0 <2", false],
    ["1.5.0-beta.1", ">=1.5.0-alpha <2", true], // same-tuple prerelease comparator opens the gate
    // build metadata ignored
    ["1.0.0+build.7", ">=1.0.0 <2", true],
  ];
  for (const [v, range, expected] of cases) {
    const got = satisfies(v, range);
    if (got !== expected) {
      throw new Error(`self-test: satisfies(${v}, ${JSON.stringify(range)}) = ${got}, expected ${expected}`);
    }
  }
  // SemVer §11 ordering chain
  const chain = [
    "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
    "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0",
  ];
  for (let i = 1; i < chain.length; i++) {
    if (compareVersions(parseVersion(chain[i - 1]), parseVersion(chain[i])) !== -1) {
      throw new Error(`self-test: expected ${chain[i - 1]} < ${chain[i]}`);
    }
  }
  // the grammar is closed: sugar and risky partials must throw, not guess
  for (const bad of ["^1.0.0", "~1.2.0", "1.x", ">=1.0.0 || >=2.0.0", ">1.2 <2", "<=1.2 >0", ""]) {
    let threw = false;
    try {
      parseRange(bad);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`self-test: parseRange(${JSON.stringify(bad)}) should have thrown`);
  }
  // partial padding for the two supported operators
  if (!satisfies("1.9.9", ">=1 <2")) throw new Error("self-test: >=1 <2 should admit 1.9.9");
  if (satisfies("2.0.0", ">=1 <2")) throw new Error("self-test: >=1 <2 should exclude 2.0.0");
  if (!satisfies("0.2.0", ">=0.2 <0.14")) throw new Error("self-test: >=0.2 should pad to >=0.2.0");
  console.log(`✓ check-peer-latest self-test: ${cases.length} satisfaction cases + ordering chain + closed grammar`);
}

// ─── registry ────────────────────────────────────────────────────────────────

/** `dist-tags.latest` via the tiny dist-tags endpoint, falling back to the
 *  abbreviated packument. Retries transient failures (nightly red should mean
 *  "look at me", not "the registry blipped"). */
async function fetchLatest(name) {
  const encoded = name.replace("/", "%2F");
  const attempts = [0, 2_000, 8_000];
  let lastErr;
  for (const delay of attempts) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      let latest;
      const res = await fetch(`https://registry.npmjs.org/-/package/${encoded}/dist-tags`, {
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        latest = (await res.json()).latest;
      } else {
        const packument = await fetch(`https://registry.npmjs.org/${encoded}`, {
          headers: { accept: "application/vnd.npm.install-v1+json" },
        });
        if (!packument.ok) {
          throw new Error(`registry ${res.status} (dist-tags) / ${packument.status} (packument)`);
        }
        latest = (await packument.json())["dist-tags"]?.latest;
      }
      if (!isValidVersion(latest)) {
        throw new Error(`dist-tags.latest is not a full semver version: ${JSON.stringify(latest)}`);
      }
      return latest;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`${name}: could not resolve dist-tags.latest after ${attempts.length} attempts: ${lastErr}`);
}

// ─── discovery ───────────────────────────────────────────────────────────────

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** One scan item per non-@silverprotocol peerDependency across packages/*. */
async function discoverPeers() {
  const packagesDir = resolve(typescriptRoot, "packages");
  const e2ePkg = await readJson(resolve(packagesDir, "e2e", "package.json"));
  const items = [];
  for (const facet of (await readdir(packagesDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    const pkg = await readJson(resolve(packagesDir, facet, "package.json"));
    const peers = Object.entries(pkg.peerDependencies ?? {}).filter(
      ([name]) => !name.startsWith("@silverprotocol/"),
    );
    for (const [name, range] of peers) {
      if (!isValidPackageName(name)) throw new Error(`${facet}: suspicious peer name ${JSON.stringify(name)}`);
      parseRange(range); // fail fast on a range the evaluator can't hold
      let newestVerified = null;
      try {
        const surface = await readJson(resolve(packagesDir, facet, "sdk-surface.json"));
        const last = surface.verified?.at(-1);
        if (last) newestVerified = { sdkVersion: last.sdkVersion, date: last.date };
      } catch {
        // facet without an sdk-surface.json — fine, the field stays null
      }
      items.push({
        name,
        range,
        facet,
        facetPkg: pkg.name,
        pinned: e2ePkg.devDependencies?.[name] ?? null,
        newestVerified,
      });
    }
  }
  if (items.length === 0) {
    throw new Error("no non-@silverprotocol peerDependencies found under packages/* — discovery is broken");
  }
  return items;
}

async function main() {
  if (process.argv.slice(2).includes("--self-test")) {
    selfTest();
    return;
  }
  const items = await discoverPeers();
  for (const item of items) {
    item.latest = await fetchLatest(item.name);
    item.inRange = satisfies(item.latest, item.range);
  }

  const lines = items.map(
    (i) =>
      `${i.inRange ? "✓" : "✖"} ${i.name}  latest ${i.latest}  range \`${i.range}\`  ` +
      (i.inRange ? "(in range)" : "→ OUT OF DECLARED RANGE") +
      `  [e2e pin ${i.pinned ?? "—"}, newest verified ${i.newestVerified?.sdkVersion ?? "—"}]`,
  );
  console.log(lines.join("\n"));

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `peers=${JSON.stringify(items)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = items.map(
      (i) =>
        `| \`${i.name}\` | \`${i.range}\` | \`${i.latest}\` | ${i.inRange ? "✓" : "**✖ out of range**"} | \`${i.pinned ?? "—"}\` |`,
    );
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      ["### Upstream peer scan", "", "| peer | declared range | latest | in range | e2e pin |", "| --- | --- | --- | --- | --- |", ...rows, ""].join("\n"),
    );
  }
}

// Import-safe: nightly-peer-leg.mjs / nightly-peer-report.mjs import the
// validators without triggering a scan (same pattern as render-compat.mjs).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
