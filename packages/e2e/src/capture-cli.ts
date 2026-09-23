/**
 * capture-cli.ts — the `pnpm e2e:capture` CLI logic (Task 6 / audit M60).
 *
 * Fixes the audit's "output-path divergence" finding: writes the corpus
 * triple `corpus/<scenario>/<framework>.{native,agjson,coverage}.json` (the
 * path replay.ts / regen.test.ts actually read) PLUS a provenance sidecar
 * (`<framework>.provenance.json`, kind:"capture", real metadata) — instead of
 * the dead `scenarios/<scenario>/cassette.json` the previous inline
 * capture.ts CLI wrote (a format with ZERO readers).
 *
 * NAMING NOTE: `<scenario>` names a `scenarios/<scenario>/scenario.json`
 * definition (prompt/mcpServers/steer) — the CURRENT scenario-AUTHORING
 * namespace. It is independent of the corpus/ directory names already
 * committed (text-tool-turn, app-spec, complete-result, convergence-echo) —
 * those predate this CLI's wiring and were captured/hand-authored through a
 * different, undocumented-CLI process (see the Task 6 report's provenance
 * table). Running this CLI against an existing `scenarios/<name>` writes/
 * overwrites `corpus/<name>/`; it does NOT retroactively regenerate the
 * differently-named legacy corpus entries. Bridging the two namespaces is a
 * separate concern, out of scope here.
 *
 * TWO layers, split for testability (mirrors capture.ts's own
 * deps-injection discipline):
 *   - `runCaptureAndWrite` — keyless-testable via a fake CaptureDeps (exactly
 *     like capture.test.ts drives runCapture). Takes an explicit `outDir` so
 *     tests never touch the real corpus/ directory.
 *   - `runCaptureCli` — the real-wiring entry: OPERATOR-GATED key-presence
 *     check (fails fast, before booting any mock server or allocating a
 *     port), reads `scenarios/<scenario>/scenario.json`, lazily imports the
 *     chosen framework's real capture agent + normalizer, and calls
 *     `runCaptureAndWrite` with `outDir = corpus/<scenario>`.
 *
 * RUNNER CHOICE (reported per the Task 6 brief's explicit ask): `tsx` is NOT
 * a workspace dependency — verified empirically (`node_modules/tsx` absent;
 * adding it would mean a NEW tool for a single script). Node 24's built-in
 * TS type-stripping (`node script.ts`, no flag needed) was tried directly and
 * rejected: it strips types but does NOT resolve the TS convention of
 * `.js`-suffixed relative specifiers to `.ts` files, so any multi-file `.ts`
 * module (i.e. every file in this package) fails to resolve its own imports
 * (`ERR_MODULE_NOT_FOUND` — verified empirically against replay.ts). This
 * package already establishes a vitest-env-gated runner convention for
 * exactly this "not part of the CI gate, operator invokes on demand" shape —
 * `regen.test.ts` (`REGEN=1 npx vitest run ... regen.test.ts`).
 * `capture-cli.test.ts`'s gated suite mirrors it:
 *
 *   CAPTURE=1 CAPTURE_SCENARIO=<scenario> CAPTURE_FRAMEWORK=<claude|openai|adk|vercel> \
 *     ANTHROPIC_API_KEY=... pnpm e2e:capture
 *
 * (`pnpm e2e:capture` = `vitest run --config ../../vitest.config.ts
 * src/capture-cli.test.ts`, per package.json — the explicit `--config` is
 * required since vitest 5, which no longer resolves a parent config; the
 * root config supplies the `@silverprotocol/*` src aliases.)
 */
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Normalizer } from "@silverprotocol/core";
import type { Framework } from "./census.js";
import { census } from "./census.js";
import { serveMock } from "./mcp-mocks/serve.js";
import { Scenario } from "./scenario.js";
import { runCapture, type CaptureDeps, type CaptureRunOptions, type Cassette } from "./capture.js";
import type { ProvenanceSidecar } from "./provenance.js";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The env var each framework's capture agent reads its provider key from. */
const KEY_ENV_VAR: Record<Framework, string> = {
  claude: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  adk: "GOOGLE_API_KEY",
  // The vercel capture runs the @ai-sdk/openai provider — same key as "openai".
  vercel: "OPENAI_API_KEY",
};

/** The npm package whose installed `package.json#version` is this
 *  framework's `sdkVersion` provenance field. */
const SDK_PACKAGE: Record<Framework, string> = {
  claude: "@anthropic-ai/claude-agent-sdk",
  openai: "@openai/agents",
  adk: "@google/adk",
  vercel: "ai",
};

/** The default model each capture agent uses when `CaptureRunOptions.model`
 *  is not set. This table is the SINGLE authority: the `?? "<model>"`
 *  fallback literals inside each agents/<fw>/run.ts are CLI-unreachable
 *  (capture-cli always resolves a model and capture.ts always forwards it)
 *  and have drifted behind — do not read them as defaults. Overridable
 *  per-run via the `CAPTURE_MODEL` env var (see `resolveModel` below) —
 *  e.g. for capturing a newly-released model before it becomes the default
 *  here. */
const DEFAULT_MODEL: Record<Framework, string> = {
  // Policy (two clauses, founder-ruled 2026-09-02 for Claude and 2026-09-05
  // for OpenAI): each default is the newest model live-verified with that facet
  // in the committed corpus (see corpus/*/​*.provenance.json) AND
  // cost-appropriate as the WORKING default — the model every refresh capture
  // and regen pays for. A frontier model at a multiple of the working model's
  // price, or one that cannot switch reasoning off, stays a SEEDED PROBE
  // (echo-fable51, echo-gpt6astra) rather than the default. Bump only after a
  // clean capture at the new model lands as a replay seed.
  claude: "claude-sonnet-5",
  // 2026-09-23 (cohort 0.6.3, founder-ruled): bumped from gpt-5.6-sol. The
  // echo-gpt6sol seeds landed clean on both the openai and vercel facets;
  // gpt-6-sol costs HALF of gpt-5.6-sol ($2/$10 vs $4/$20 per MTok) and the API
  // can switch its reasoning off, so it meets both policy clauses. It has no
  // dated snapshot: the id IS the model. Consequence to know: @openai/agents
  // 0.18.0 has no gpt-6-sol setting, so every openai capture now runs at the
  // API-default effort medium (gpt-5.6-sol ran at none) and produces reasoning
  // items; on the Vercel stack gpt-5.6-sol already reasoned, so little changes.
  openai: "gpt-6-sol",
  // 2026-09-05: bumped from gemini-3.7-flash — the gemini-3.8-flash trio
  // (echo/app-spec/thinking) landed as replay seeds (GA 2026-09-02; same
  // thinking knob, same price). 2026-08-19: 3.6 → 3.7 (workspace#14).
  adk: "gemini-3.8-flash",
  // Same model family as "openai" — the two facets share provider + corpus.
  vercel: "gpt-6-sol",
};

/**
 * Resolves the model ID for this capture run: `CAPTURE_MODEL` env var wins
 * when set (non-empty), else the framework's own `DEFAULT_MODEL`. A single
 * env var (not per-framework) is intentional — one capture invocation
 * targets exactly one framework, so there is no ambiguity to disambiguate.
 *
 * Exported for direct unit testing (pure function of env + framework — no
 * need to drive it through the OPERATOR-GATED `runCaptureCli`).
 */
export function resolveModel(framework: Framework): string {
  const override = process.env["CAPTURE_MODEL"];
  return override && override.length > 0 ? override : DEFAULT_MODEL[framework];
}

const FRAMEWORKS: readonly Framework[] = ["claude", "openai", "adk", "vercel"];

/** Type-predicate guard — no cast on the value. */
export function isFramework(v: string): v is Framework {
  return (FRAMEWORKS as readonly string[]).includes(v);
}

/**
 * Walks up from a resolved module file until it finds the `package.json`
 * whose `name` field matches `pkgName`, and returns its parsed contents.
 *
 * `require.resolve(\`${pkg}/package.json\`)` (the naive approach) THROWS
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` for any package whose `exports` map omits
 * a `./package.json` subpath — verified empirically (playbook 2026-07-03
 * live capture run): BOTH `@anthropic-ai/claude-agent-sdk` (0.2.141 AND
 * 0.3.199) and `@openai/agents` (0.12.0) have `exports` maps with no
 * `./package.json` entry, so that call silently threw and the caller's
 * try/catch returned `null` for every capture ever run — a bug that never
 * surfaced because no live capture had run before this playbook step. The
 * package's own `.` export (its main entry) IS always resolvable, so this
 * walks up from there — bounded to 5 levels (real packages are 0-2 levels
 * deep: e.g. `@anthropic-ai/claude-agent-sdk`'s main is `sdk.mjs` directly in
 * the package root; `@openai/agents`'s main is one level down in `dist/`).
 */
async function readPackageJsonByWalkingUpFrom(
  mainEntryPath: string,
  pkgName: string,
): Promise<{ version?: string } | null> {
  let dir = dirname(mainEntryPath);
  for (let depth = 0; depth < 5; depth++) {
    const candidate = join(dir, "package.json");
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === pkgName) {
        return parsed;
      }
    } catch {
      // Not found at this level (or unparsable) — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/** Reads the installed SDK package's own `package.json#version` — the REAL
 *  resolved version (not the package.json range, which may be a caret).
 *  Exported for direct unit testing (keyless — reads only local
 *  node_modules, no network/API key needed). */
export async function resolveSdkVersion(framework: Framework): Promise<string | null> {
  try {
    const pkgName = SDK_PACKAGE[framework];
    const mainEntryPath = require.resolve(pkgName);
    const parsed = await readPackageJsonByWalkingUpFrom(mainEntryPath, pkgName);
    return parsed?.version ?? null;
  } catch {
    return null;
  }
}

// ─── layer 1: keyless-testable (fake CaptureDeps + explicit outDir) ──────────

/**
 * Runs one capture via `runCapture` and writes the corpus triple + a
 * `kind:"capture"` provenance sidecar into `outDir`. Keyless-testable: pass a
 * fake `deps.runAgentCapture` exactly like capture.test.ts does.
 */
export async function runCaptureAndWrite(
  scenario: Scenario,
  deps: CaptureDeps,
  opts: CaptureRunOptions,
  outDir: string,
  provenanceMeta: { sdkVersion: string | null; model: string | null },
): Promise<{ outDir: string; cassette: Cassette }> {
  const cassette = await runCapture(scenario, deps, opts);
  await mkdir(outDir, { recursive: true });

  const provenance: ProvenanceSidecar = {
    kind: "capture",
    capturedAt: new Date().toISOString(),
    sdkVersion: provenanceMeta.sdkVersion,
    model: provenanceMeta.model,
    ...(cassette.runError !== undefined
      ? { note: `expectError seed: the run threw after its last native event: ${cassette.runError}` }
      : {}),
  };

  const fw = opts.framework;
  await Promise.all([
    writeFile(join(outDir, `${fw}.native.json`), JSON.stringify(cassette.native, null, 2) + "\n", "utf8"),
    writeFile(join(outDir, `${fw}.agjson.json`), JSON.stringify(cassette.agjson, null, 2) + "\n", "utf8"),
    writeFile(join(outDir, `${fw}.coverage.json`), JSON.stringify(cassette.coverage, null, 2) + "\n", "utf8"),
    writeFile(join(outDir, `${fw}.provenance.json`), JSON.stringify(provenance, null, 2) + "\n", "utf8"),
    // Ground truth for a state-fold seed: the framework's own session state,
    // read back after the run. Harness data; replay never reads it.
    ...(cassette.sessionState !== undefined
      ? [writeFile(join(outDir, `${fw}.session-state.json`), JSON.stringify(cassette.sessionState, null, 2) + "\n", "utf8")]
      : []),
  ]);

  return { outDir, cassette };
}

// ─── layer 2: real-wiring CLI entry (OPERATOR-GATED) ─────────────────────────

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not get ephemeral port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Scenario knobs that change what a capture MEANS, and that only some capture
 * agents honor. `proof` names an export the loaded agent module must have,
 * which shows the running tree implements the knob.
 *
 * Why this exists: on 2026-09-23 a resume-leg capture ran on a lineage whose
 * claude run.ts predated the hook/resume support (a22d669). The agent silently
 * ignored preToolUseDecision and the resume, and recorded a FRESH session under
 * a resume-leg name. A capture must fail before spending an API call instead.
 */
export const KNOB_SUPPORT: Readonly<
  Record<
    "preToolUseDecision" | "resumeFrom" | "adkWorkflow" | "adkStateScript",
    { frameworks: readonly Framework[]; proof?: string }
  >
> = {
  preToolUseDecision: { frameworks: ["claude"], proof: "captureQueryExtras" },
  resumeFrom: { frameworks: ["claude"], proof: "captureQueryExtras" },
  adkWorkflow: { frameworks: ["adk"], proof: "runAdkWorkflowCapture" },
  adkStateScript: { frameworks: ["adk"], proof: "ADK_STATE_TOOL" },
};

/**
 * Throws if the scenario sets a KNOB_SUPPORT knob that `framework` does not
 * honor, or that the loaded `agentModule` cannot prove it implements.
 * Exported for unit testing.
 */
export function assertKnobsHonored(scenario: Scenario, framework: Framework, agentModule: object): void {
  for (const [knob, support] of Object.entries(KNOB_SUPPORT)) {
    if ((scenario as Record<string, unknown>)[knob] === undefined) continue;
    if (!support.frameworks.includes(framework)) {
      throw new Error(
        `e2e:capture: scenario "${scenario.name}" sets ${knob}, which only the ${support.frameworks.join("/")} ` +
          `capture agent honors (framework="${framework}"). No capture attempted.`,
      );
    }
    if (support.proof !== undefined && !(support.proof in agentModule)) {
      throw new Error(
        `e2e:capture: scenario "${scenario.name}" sets ${knob}, but this tree's ${framework} capture agent does not ` +
          `export ${support.proof}, so it would silently ignore the knob. Capture on a tree whose agent implements it. ` +
          `No capture attempted.`,
      );
    }
  }
}

/** Resolves { runAgentCapture, createNormalizer } for one framework via a
 *  lazy import — importing capture-cli.ts never requires all three provider
 *  SDKs to be resolvable, only the one actually invoked. Every branch first
 *  checks the scenario's knobs against the loaded agent (assertKnobsHonored). */
async function loadFrameworkDeps(
  framework: Framework,
  scenario: Scenario,
): Promise<{
  runAgentCapture: CaptureDeps["runAgentCapture"];
  createNormalizer: () => Normalizer;
  hostCompletion?: boolean;
}> {
  if (framework === "claude") {
    const [agent, { createClaudeNormalizer }] = await Promise.all([
      import("./agents/claude-agent-sdk/run.js"),
      import("@silverprotocol/claude-agent-sdk"),
    ]);
    assertKnobsHonored(scenario, framework, agent);
    return { runAgentCapture: agent.runClaudeCapture, createNormalizer: createClaudeNormalizer };
  }
  if (framework === "openai") {
    const [agent, { createOpenaiNormalizer }] = await Promise.all([
      import("./agents/openai-agents-sdk/run.js"),
      import("@silverprotocol/openai-agents"),
    ]);
    assertKnobsHonored(scenario, framework, agent);
    return { runAgentCapture: agent.runOpenaiCapture, createNormalizer: createOpenaiNormalizer };
  }
  if (framework === "vercel") {
    const [agent, { createVercelNormalizer }] = await Promise.all([
      import("./agents/vercel-ai/run.js"),
      import("@silverprotocol/vercel-ai"),
    ]);
    assertKnobsHonored(scenario, framework, agent);
    const { runVercelCapture } = agent;
    // The same fixed id stem replay uses (replay.ts), so a fresh capture's
    // agjson equals its replay; the facet's default stem is random.
    return { runAgentCapture: runVercelCapture, createNormalizer: () => createVercelNormalizer({ invokeId: "vercel" }) };
  }
  const [adkAgent, workflowAgent, { createAdkNormalizer }] = await Promise.all([
    import("./agents/google-adk/run.js"),
    import("./agents/google-adk/workflow.js"),
    import("@silverprotocol/google-adk"),
  ]);
  // Both adk agent modules together prove the knobs (runAdkWorkflowCapture, ADK_STATE_TOOL).
  assertKnobsHonored(scenario, framework, { ...adkAgent, ...workflowAgent });
  const { runAdkCapture } = adkAgent;
  const { runAdkWorkflowCapture } = workflowAgent;
  const shape = scenario.adkWorkflow;
  return {
    runAgentCapture: shape !== undefined ? (input) => runAdkWorkflowCapture(input, shape) : runAdkCapture,
    // SPEC §8.0 host obligation 4: adk-js has no in-band run terminal, so the
    // capture (the host) records the completion marker after a normal return
    // and feeds it to the facet through its opt-in, as replay.ts does with a
    // recorded marker. Every committed ADK golden replays byte-identically
    // with or without it (sp-google 613fd7f), so plain re-captures are safe.
    createNormalizer: () => createAdkNormalizer({ hostCompletion: true }),
    hostCompletion: true,
  };
}

/**
 * The session a `resumeFrom` scenario resumes: the `session_id` of the LAST
 * result frame in the named seed's committed claude cassette. claude only
 * (the other agents have no resume input). Exported for unit testing.
 */
export async function resumeSessionFrom(seed: string, framework: Framework, corpusRoot = join(PACKAGE_ROOT, "corpus")): Promise<string> {
  if (framework !== "claude") {
    throw new Error(`e2e:capture: resumeFrom is claude-only (framework="${framework}")`);
  }
  const path = join(corpusRoot, seed, "claude.native.json");
  let native: unknown;
  try {
    native = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`e2e:capture: resumeFrom "${seed}": no committed cassette at ${path}`);
  }
  const results = (Array.isArray(native) ? native : []).filter(
    (e): e is { type: "result"; session_id: string } =>
      e !== null && typeof e === "object" && e.type === "result" && typeof e.session_id === "string",
  );
  const last = results.at(-1);
  if (last === undefined) throw new Error(`e2e:capture: resumeFrom "${seed}": its cassette has no result frame with a session_id`);
  return last.session_id;
}

/**
 * The real `pnpm e2e:capture <scenario> <framework>` entry point.
 *
 * OPERATOR-GATED: fails fast with a clear message when the framework's
 * provider API key env var is absent — BEFORE reading the scenario file,
 * allocating a port, or booting any mock server.
 */
export async function runCaptureCli(scenarioName: string, framework: Framework): Promise<string> {
  const keyEnvVar = KEY_ENV_VAR[framework];
  const apiKey = process.env[keyEnvVar];
  if (!apiKey) {
    throw new Error(
      `e2e:capture: ${keyEnvVar} is required for framework="${framework}" (OPERATOR-GATED — ` +
        `no live provider call is attempted without it). Set it and re-run.`,
    );
  }

  const scenarioDir = join(PACKAGE_ROOT, "scenarios", scenarioName);
  const scenarioFile = join(scenarioDir, "scenario.json");

  let raw: string;
  try {
    raw = await readFile(scenarioFile, "utf8");
  } catch {
    throw new Error(`e2e:capture: scenario not found: ${scenarioFile}`);
  }
  const scenario = Scenario.parse(JSON.parse(raw));

  const ports = await Promise.all(scenario.mcpServers.map(() => freePort()));
  const { runAgentCapture, createNormalizer, hostCompletion } = await loadFrameworkDeps(framework, scenario);
  const deps: CaptureDeps = {
    runAgentCapture,
    serveMock,
    createNormalizer,
    census,
    ...(hostCompletion === true ? { hostCompletion } : {}),
  };

  const sdkVersion = await resolveSdkVersion(framework);
  const model = resolveModel(framework);
  const outDir = join(PACKAGE_ROOT, "corpus", scenarioName);
  const resumeSessionId =
    scenario.resumeFrom !== undefined ? await resumeSessionFrom(scenario.resumeFrom, framework) : undefined;

  const { outDir: written } = await runCaptureAndWrite(
    scenario,
    deps,
    { ports, framework, apiKey, model, ...(resumeSessionId !== undefined ? { resumeSessionId } : {}) },
    outDir,
    { sdkVersion, model },
  );

  return written;
}
