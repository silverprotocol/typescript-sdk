#!/usr/bin/env node
/**
 * pack→install→import smoke (audit B13): proves the published tarballs are
 * importable by an outsider. pnpm pack rewrites workspace:* to real versions;
 * core installs first so the facets' @silverprotocol/core dep resolves from
 * the local tree via npm's already-satisfied-in-tree reuse (nothing is on
 * npm yet — verified empirically: registry.npmjs.org/@silverprotocol/core
 * 404s, and a sequential `npm install core.tgz` then `npm install
 * facet.tgz` resolves the facet's dependency without any registry hit).
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkgs = ["core", "claude-agent-sdk", "openai-agents", "google-adk", "vercel-ai"];
const work = mkdtempSync(join(tmpdir(), "sp-pack-smoke-"));
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "pipe" }).toString();

// `pnpm pack` names tarballs `<scope-stripped>-<name>-<version>.tgz`, e.g.
// @silverprotocol/openai-agents@0.1.0 -> silverprotocol-openai-agents-0.1.0.tgz
// (verified empirically). Match by exact prefix, not substring, so e.g. "core"
// can never accidentally match another package's tarball name.
const tarballs = {};
for (const p of pkgs) {
  const dir = join(root, "packages", p);
  const before = new Set(readdirSync(work));
  run("pnpm pack --pack-destination " + work, dir);
  const tgz = readdirSync(work).find(
    (f) => !before.has(f) && f.startsWith(`silverprotocol-${p}-`) && f.endsWith(".tgz"),
  );
  if (!tgz) throw new Error(`no tarball for ${p} (pack-destination: ${work})`);
  tarballs[p] = join(work, tgz);
}

const app = join(work, "app");
run(`mkdir -p ${app}`);
writeFileSync(
  join(app, "package.json"),
  JSON.stringify({ name: "smoke", private: true, type: "module" }),
);
// core first: the facets' @silverprotocol/core dependency (rewritten from
// workspace:* to an exact version by pnpm pack) must resolve from this
// already-installed local copy, not the registry.
run(`npm install ${tarballs["core"]} --no-audit --no-fund`, app);
for (const p of pkgs.slice(1)) run(`npm install ${tarballs[p]} --no-audit --no-fund`, app);

const checks = [
  [
    "@silverprotocol/core",
    "m => { if (typeof m.AGJSON_VERSION !== 'string' || typeof m.Reducer !== 'function' || typeof m.ingestAgEvent !== 'function') throw new Error('core exports missing'); }",
  ],
  [
    "@silverprotocol/claude-agent-sdk",
    "m => { if (typeof m.createClaudeNormalizer !== 'function') throw new Error('claude export missing'); }",
  ],
  [
    "@silverprotocol/openai-agents",
    "m => { if (typeof m.createOpenaiNormalizer !== 'function') throw new Error('openai export missing'); }",
  ],
  [
    "@silverprotocol/google-adk",
    "m => { if (typeof m.createAdkNormalizer !== 'function') throw new Error('adk export missing'); }",
  ],
  [
    "@silverprotocol/vercel-ai",
    "m => { if (typeof m.createVercelNormalizer !== 'function') throw new Error('vercel export missing'); }",
  ],
];
for (const [name, fn] of checks) {
  run(`node -e "import('${name}').then(${fn}).then(() => console.log('ok ${name}'))"`, app);
  console.log(`ok ${name}`);
}
console.log("pack-smoke: all five packages import clean");
