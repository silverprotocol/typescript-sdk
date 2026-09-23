/**
 * capture-cli.test.ts — tests for the `pnpm e2e:capture` CLI (Task 6 /
 * audit M60) + the vitest-env-gated LIVE runner.
 *
 * Three suites:
 *   1. `isFramework` unit tests.
 *   2. `runCaptureAndWrite` — keyless, via a fake CaptureDeps boundary
 *      (exactly the capture.test.ts pattern: fake ONLY runAgentCapture; REAL
 *      serveMock/normalizer/census) writing into a tmp dir, NEVER the real
 *      corpus/. Asserts the corpus triple + the kind:"capture" provenance
 *      sidecar land with real metadata.
 *   3. `runCaptureCli` fail-fast — the OPERATOR-GATED key check fires with a
 *      clear message BEFORE the scenario file is even read (proven by
 *      pointing at a nonexistent scenario and still getting the KEY error).
 *
 * ─── THE LIVE RUNNER (OPERATOR-GATED — the actual `pnpm e2e:capture`) ───────
 *
 * Mirrors regen.test.ts's env-gated convention (`tsx` is not a workspace dep;
 * node 24's type-stripping cannot resolve multi-file `.js`-suffixed TS
 * imports — see capture-cli.ts's header for the full runner adjudication):
 *
 *   CAPTURE=1 CAPTURE_SCENARIO=single-tool-call CAPTURE_FRAMEWORK=claude \
 *     ANTHROPIC_API_KEY=sk-... pnpm e2e:capture
 *
 * Key env var per framework: claude=ANTHROPIC_API_KEY, openai=OPENAI_API_KEY,
 * adk=GOOGLE_API_KEY. Writes corpus/<scenario>/<framework>.{native,agjson,
 * coverage,provenance}.json. NOT part of the CI gate — runs only with
 * CAPTURE=1 set by the operator.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonValue } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { census } from "./census.js";
import { serveMock } from "./mcp-mocks/serve.js";
import { Scenario } from "./scenario.js";
import type { CaptureDeps } from "./capture.js";
import {
  isFramework,
  resolveModel,
  resolveSdkVersion,
  assertKnobsHonored,
  resumeSessionFrom,
  resumeRunStateFrom,
  runStatePath,
  assertSameAsLeg1,
  runCaptureAndWrite,
  runCaptureCli,
} from "./capture-cli.js";
import { isProvenanceKind } from "./provenance.js";

// ─── isFramework ─────────────────────────────────────────────────────────────

describe("isFramework", () => {
  it("accepts the three frameworks", () => {
    expect(isFramework("claude")).toBe(true);
    expect(isFramework("openai")).toBe(true);
    expect(isFramework("adk")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isFramework("gemini")).toBe(false);
    expect(isFramework("")).toBe(false);
    expect(isFramework("Claude")).toBe(false);
  });
});

// ─── resolveModel (CAPTURE_MODEL override plumbing) ──────────────────────────

describe("resolveModel", () => {
  const ENV_VAR = "CAPTURE_MODEL";

  function withCaptureModel<T>(value: string | undefined, fn: () => T): T {
    const saved = process.env[ENV_VAR];
    if (value === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = value;
    }
    try {
      return fn();
    } finally {
      if (saved === undefined) {
        delete process.env[ENV_VAR];
      } else {
        process.env[ENV_VAR] = saved;
      }
    }
  }

  it("falls back to each framework's own DEFAULT_MODEL when CAPTURE_MODEL is unset", () => {
    withCaptureModel(undefined, () => {
      expect(resolveModel("claude")).toBe("claude-sonnet-5");
      expect(resolveModel("openai")).toBe("gpt-6-sol");
      expect(resolveModel("adk")).toBe("gemini-3.8-flash");
      expect(resolveModel("vercel")).toBe("gpt-6-sol");
    });
  });

  it("CAPTURE_MODEL wins over the framework default when set", () => {
    withCaptureModel("claude-sonnet-5", () => {
      expect(resolveModel("claude")).toBe("claude-sonnet-5");
    });
    withCaptureModel("gpt-5.5", () => {
      expect(resolveModel("openai")).toBe("gpt-5.5");
    });
  });

  it("an empty-string CAPTURE_MODEL is treated as unset (falls back to default)", () => {
    withCaptureModel("", () => {
      expect(resolveModel("claude")).toBe("claude-sonnet-5");
    });
  });
});

// ─── resolveSdkVersion (keyless — reads real installed package.json) ────────
//
// Regression test for a real bug found during the 2026-07-03 playbook's
// FIRST-EVER live capture run: the naive `require.resolve(\`${pkg}/
// package.json\`)` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` for any package
// whose `exports` map omits a `./package.json` subpath — true of BOTH
// `@anthropic-ai/claude-agent-sdk` and `@openai/agents` as installed here —
// so every prior "capture" silently wrote `sdkVersion: null` to its
// provenance sidecar. This asserts the walk-up-from-main-entry fix actually
// resolves a real, non-null version string.

describe("resolveSdkVersion", () => {
  it("resolves the real installed @anthropic-ai/claude-agent-sdk version (non-null)", async () => {
    const version = await resolveSdkVersion("claude");
    expect(version).not.toBeNull();
    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("resolves the real installed @openai/agents version (non-null)", async () => {
    const version = await resolveSdkVersion("openai");
    expect(version).not.toBeNull();
    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ─── runCaptureAndWrite (keyless, fake boundary, tmp outDir) ─────────────────

/** Minimal honest-SDKMessage stream (lifted from capture.test.ts): one
 *  assistant text turn + one result.success. */
function fakeNativeNoTools(): JsonValue[] {
  return [
    {
      type: "assistant",
      session_id: "sess_test",
      parent_tool_use_id: null,
      message: {
        id: "msg_text_only",
        model: "claude-sonnet-5",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        content: [{ type: "text", text: "Hello from the fake boundary.", citations: null }],
        usage: {
          input_tokens: 10,
          output_tokens: 8,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: "sess_test",
      uuid: "result_uuid_001",
      stop_reason: "end_turn",
      result: "Done.",
      total_cost_usd: 0.0005,
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        server_tool_use: null,
      },
      modelUsage: {},
      permission_denials: [],
    },
  ];
}

function makeDeps(): CaptureDeps {
  return {
    // ★ ONLY the LLM/process boundary is faked (capture.test.ts's F4 rule).
    async *runAgentCapture(_input) {
      for (const event of fakeNativeNoTools()) {
        yield event;
      }
    },
    serveMock,
    createNormalizer: createClaudeNormalizer,
    census,
  };
}

async function readJson(path: string): Promise<JsonValue> {
  return JSON.parse(await readFile(path, "utf8")) as JsonValue;
}

describe("runCaptureAndWrite", () => {
  it("writes the corpus triple + a kind:\"capture\" provenance sidecar with real metadata", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "capture-cli-test-"));
    try {
      const scenario = Scenario.parse({ name: "text-only", prompt: "Say something." });
      const before = Date.now();

      await runCaptureAndWrite(
        scenario,
        makeDeps(),
        { ports: [], framework: "claude" },
        outDir,
        { sdkVersion: "0.2.141", model: "claude-sonnet-5" },
      );

      // The corpus triple — the path shape replay.ts actually reads
      // (audit M60's output-path divergence fix).
      const native = await readJson(join(outDir, "claude.native.json"));
      const agjson = await readJson(join(outDir, "claude.agjson.json"));
      const coverage = await readJson(join(outDir, "claude.coverage.json"));
      expect(Array.isArray(native)).toBe(true);
      expect((native as JsonValue[]).length).toBe(2);
      expect(Array.isArray(agjson)).toBe(true);
      expect((agjson as JsonValue[]).length).toBeGreaterThan(0);
      expect(coverage).toHaveProperty("drops");
      expect(coverage).toHaveProperty("newFields");

      // The provenance sidecar.
      const provenance = await readJson(join(outDir, "claude.provenance.json"));
      expect(provenance !== null && typeof provenance === "object" && !Array.isArray(provenance)).toBe(true);
      const p = provenance as { [k: string]: JsonValue };
      expect(isProvenanceKind(p["kind"])).toBe(true);
      expect(p["kind"]).toBe("capture");
      expect(p["sdkVersion"]).toBe("0.2.141");
      expect(p["model"]).toBe("claude-sonnet-5");
      // capturedAt is a REAL just-now ISO timestamp, not null/invented.
      expect(typeof p["capturedAt"]).toBe("string");
      const capturedAt = Date.parse(p["capturedAt"] as string);
      expect(capturedAt).toBeGreaterThanOrEqual(before - 1000);
      expect(capturedAt).toBeLessThanOrEqual(Date.now() + 1000);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("null metadata stays null (unknown is never invented)", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "capture-cli-test-"));
    try {
      const scenario = Scenario.parse({ name: "text-only", prompt: "Say something." });
      await runCaptureAndWrite(
        scenario,
        makeDeps(),
        { ports: [], framework: "claude" },
        outDir,
        { sdkVersion: null, model: null },
      );
      const p = (await readJson(join(outDir, "claude.provenance.json"))) as { [k: string]: JsonValue };
      expect(p["sdkVersion"]).toBeNull();
      expect(p["model"]).toBeNull();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("propagates runCapture's expectTools throw — NO files are written on a failed capture", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "capture-cli-test-"));
    try {
      // single-tool-call expects mcp__t__echo; the fake stream has no tool calls.
      const scenario = Scenario.parse({
        name: "single-tool-call",
        prompt: "Call the echo tool.",
        mcpServers: [{ key: "t", kind: "text" }],
      });
      await expect(
        runCaptureAndWrite(
          scenario,
          makeDeps(),
          { ports: [49399], framework: "claude" },
          outDir,
          { sdkVersion: null, model: null },
        ),
      ).rejects.toThrow(/did not call expected tools/);
      // No half-cassette (runCapture throws before runCaptureAndWrite writes).
      await expect(readFile(join(outDir, "claude.native.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(outDir, "claude.provenance.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

// ─── runCaptureCli — OPERATOR-GATED fail-fast ────────────────────────────────

describe("runCaptureCli — key fail-fast (OPERATOR-GATED)", () => {
  const CASES = [
    { framework: "claude", envVar: "ANTHROPIC_API_KEY" },
    { framework: "openai", envVar: "OPENAI_API_KEY" },
    { framework: "adk", envVar: "GOOGLE_API_KEY" },
  ] as const;

  for (const { framework, envVar } of CASES) {
    it(`${framework}: fails fast citing ${envVar} BEFORE reading the scenario (key checked first)`, async () => {
      const saved = process.env[envVar];
      delete process.env[envVar];
      try {
        // A scenario name that does NOT exist — if the key check did not come
        // first, we'd see the "scenario not found" error instead.
        await expect(
          runCaptureCli("no-such-scenario-xyz", framework),
        ).rejects.toThrow(new RegExp(envVar));
      } finally {
        if (saved === undefined) {
          delete process.env[envVar];
        } else {
          process.env[envVar] = saved;
        }
      }
    });
  }

  it("with a key present, a missing scenario fails with the scenario-not-found error", async () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-fake-key-for-path-test";
    try {
      await expect(runCaptureCli("no-such-scenario-xyz", "claude")).rejects.toThrow(
        /scenario not found/,
      );
    } finally {
      if (saved === undefined) {
        delete process.env["ANTHROPIC_API_KEY"];
      } else {
        process.env["ANTHROPIC_API_KEY"] = saved;
      }
    }
  });
});

// ─── THE LIVE RUNNER (CAPTURE=1 — operator-invoked, never in CI) ─────────────

describe.runIf(process.env["CAPTURE"] === "1")("e2e:capture — LIVE (operator)", () => {
  it("captures the requested scenario/framework and writes the corpus triple + sidecar", async () => {
    const scenarioName = process.env["CAPTURE_SCENARIO"];
    const frameworkRaw = process.env["CAPTURE_FRAMEWORK"];
    if (!scenarioName || !frameworkRaw) {
      throw new Error(
        "e2e:capture: set CAPTURE_SCENARIO=<scenarios/ dir name> and CAPTURE_FRAMEWORK=<claude|openai|adk|vercel>",
      );
    }
    if (!isFramework(frameworkRaw)) {
      throw new Error(
        `e2e:capture: unknown CAPTURE_FRAMEWORK "${frameworkRaw}" (expected claude|openai|adk)`,
      );
    }
    const outDir = await runCaptureCli(scenarioName, frameworkRaw);
    console.log(`e2e:capture: corpus triple + provenance sidecar written to ${outDir}`);
  }, 300000);
});

// ─── expectError: an error seed persists the natives the run yielded before it threw ──
describe("runCaptureAndWrite — expectError (error seeds; probe queue item 1)", () => {
  // The Claude Agent SDK surfaces an API error in-band and THEN throws out of
  // the query iterator; this boundary does the same after the result frame.
  const throwingDeps = (message: string, hostCompletion = false): CaptureDeps => ({
    async *runAgentCapture(_input) {
      yield* fakeNativeNoTools();
      throw new Error(message);
    },
    serveMock,
    createNormalizer: createClaudeNormalizer,
    census,
    ...(hostCompletion ? { hostCompletion: true } : {}),
  });

  it("writes the natives that arrived before the throw, and the thrown message into provenance note", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "capture-cli-test-"));
    try {
      const scenario = Scenario.parse({ name: "api-error", prompt: "Say something.", expectError: true });
      const { cassette } = await runCaptureAndWrite(
        scenario,
        throwingDeps("Claude Code process exited with code 1", true),
        { ports: [], framework: "claude" },
        outDir,
        { sdkVersion: "0.3.280", model: "claude-sonnet-5" },
      );
      expect(cassette.runError).toBe("Claude Code process exited with code 1");
      // Both frames kept; NO host-completion marker after a throw, even with hostCompletion set.
      expect(await readJson(join(outDir, "claude.native.json"))).toEqual(fakeNativeNoTools());
      const p = (await readJson(join(outDir, "claude.provenance.json"))) as { [k: string]: JsonValue };
      expect(p["kind"]).toBe("capture");
      expect(p["note"]).toBe(
        "expectError seed: the run threw after its last native event: Claude Code process exited with code 1",
      );
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("an expectError scenario whose run returns normally fails the capture and writes nothing", async () => {
    const outDir = join(await mkdtemp(join(tmpdir(), "capture-cli-test-")), "out");
    try {
      const scenario = Scenario.parse({ name: "api-error", prompt: "Say something.", expectError: true });
      await expect(
        runCaptureAndWrite(scenario, makeDeps(), { ports: [], framework: "claude" }, outDir, {
          sdkVersion: null,
          model: null,
        }),
      ).rejects.toThrow(/expects the run to fail \(expectError\) but it returned normally/);
      await expect(readFile(join(outDir, "claude.native.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dirname(outDir), { recursive: true, force: true });
    }
  });

  it("without expectError a throw still propagates and writes nothing (negative control)", async () => {
    const outDir = join(await mkdtemp(join(tmpdir(), "capture-cli-test-")), "out");
    try {
      const scenario = Scenario.parse({ name: "text-only", prompt: "Say something." });
      await expect(
        runCaptureAndWrite(scenario, throwingDeps("boom"), { ports: [], framework: "claude" }, outDir, {
          sdkVersion: null,
          model: null,
        }),
      ).rejects.toThrow("boom");
      await expect(readFile(join(outDir, "claude.native.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dirname(outDir), { recursive: true, force: true });
    }
  });

  it("the expectTools check is skipped for a run that threw (a failed run calls no tools)", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "capture-cli-test-"));
    try {
      const scenario = Scenario.parse({
        name: "api-error",
        prompt: "Echo.",
        mcpServers: [{ key: "t", kind: "text" }],
        expectError: true,
      });
      const { cassette } = await runCaptureAndWrite(
        scenario,
        throwingDeps("401"),
        { ports: [0], framework: "claude" },
        outDir,
        { sdkVersion: null, model: null },
      );
      expect(cassette.runError).toBe("401");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

// ─── resumeFrom: the session a resume leg resumes (R&D candidate 20) ──────────
describe("resumeSessionFrom", () => {
  it("returns the LAST result frame's session_id from the seed's committed claude cassette", async () => {
    const root = await mkdtemp(join(tmpdir(), "capture-cli-test-"));
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(root, "leg-1"));
      await writeFile(
        join(root, "leg-1", "claude.native.json"),
        JSON.stringify([
          { type: "system", subtype: "init", session_id: "s-init" },
          { type: "result", subtype: "success", session_id: "s-first" },
          { type: "result", subtype: "success", session_id: "s-last" },
        ]),
      );
      expect(await resumeSessionFrom("leg-1", "claude", root)).toBe("s-last");
      await expect(resumeSessionFrom("missing", "claude", root)).rejects.toThrow(/no committed cassette/);
      await writeFile(join(root, "leg-1", "claude.native.json"), JSON.stringify([{ type: "system", session_id: "x" }]));
      await expect(resumeSessionFrom("leg-1", "claude", root)).rejects.toThrow(/no result frame/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is claude-only", async () => {
    await expect(resumeSessionFrom("defer-tool-sonnet5", "openai")).rejects.toThrow(/claude-only/);
  });

  it("resolves the committed defer-tool-sonnet5 leg to its live session", async () => {
    expect(await resumeSessionFrom("defer-tool-sonnet5", "claude")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ─── knob guard: a capture fails loud when its agent would ignore a knob ─────
describe("assertKnobsHonored", () => {
  const withKnobs = (extra: Record<string, unknown>) => Scenario.parse({ name: "probe-knobs", prompt: "x", ...extra });
  const claudeWithHooks = { runClaudeCapture: () => undefined, captureQueryExtras: () => ({}) };
  const claudeWithoutHooks = { runClaudeCapture: () => undefined };

  it("passes a scenario with no guarded knob on any framework and any agent", () => {
    for (const fw of ["claude", "openai", "adk", "vercel"] as const) {
      expect(() => assertKnobsHonored(withKnobs({}), fw, {})).not.toThrow();
    }
  });

  it("passes preToolUseDecision / resumeFrom on a claude agent that exports captureQueryExtras", () => {
    expect(() => assertKnobsHonored(withKnobs({ preToolUseDecision: "defer" }), "claude", claudeWithHooks)).not.toThrow();
    expect(() => assertKnobsHonored(withKnobs({ resumeFrom: "defer-tool-sonnet5" }), "claude", claudeWithHooks)).not.toThrow();
  });

  it("FAILS on a claude agent that lacks captureQueryExtras (the silent fresh-session capture of 2026-09-23)", () => {
    expect(() => assertKnobsHonored(withKnobs({ resumeFrom: "defer-tool-sonnet5" }), "claude", claudeWithoutHooks)).toThrow(
      /does not export captureQueryExtras, so it would silently ignore the knob/,
    );
    expect(() => assertKnobsHonored(withKnobs({ preToolUseDecision: "deny" }), "claude", claudeWithoutHooks)).toThrow(
      /preToolUseDecision/,
    );
  });

  it("FAILS a claude-only knob on another framework, and adkWorkflow off adk", () => {
    expect(() => assertKnobsHonored(withKnobs({ preToolUseDecision: "defer" }), "openai", claudeWithHooks)).toThrow(
      /only the claude capture agent honors/,
    );
    expect(() => assertKnobsHonored(withKnobs({ adkWorkflow: "pause" }), "claude", claudeWithHooks)).toThrow(
      /only the adk capture agent honors/,
    );
    expect(() => assertKnobsHonored(withKnobs({ adkWorkflow: "pause" }), "adk", { runAdkWorkflowCapture: () => undefined })).not.toThrow();
  });
});

describe("openai tool approval: the knob guard, the RunState location and the leg-1 match (sp-openai 82b3aae)", () => {
  const withKnobs = (extra: Record<string, unknown>) => Scenario.parse({ name: "approval-probe", prompt: "x", ...extra });
  const openaiWithApproval = { runOpenaiCapture: () => undefined, openaiApprovalPlan: () => undefined };

  it("toolApproval and resumeFrom pass on an openai agent that exports openaiApprovalPlan, and fail without it", () => {
    expect(() => assertKnobsHonored(withKnobs({ toolApproval: "interrupt" }), "openai", openaiWithApproval)).not.toThrow();
    expect(() => assertKnobsHonored(withKnobs({ toolApproval: "approve", resumeFrom: "leg-1" }), "openai", openaiWithApproval)).not.toThrow();
    expect(() => assertKnobsHonored(withKnobs({ toolApproval: "reject", resumeFrom: "leg-1" }), "openai", { runOpenaiCapture: () => undefined })).toThrow(
      /does not export openaiApprovalPlan/,
    );
    // resumeFrom's proof is per framework: claude still needs captureQueryExtras.
    expect(() => assertKnobsHonored(withKnobs({ resumeFrom: "leg-1" }), "claude", openaiWithApproval)).toThrow(/does not export captureQueryExtras/);
    expect(() => assertKnobsHonored(withKnobs({ toolApproval: "interrupt" }), "claude", { captureQueryExtras: () => ({}) })).toThrow(
      /only the openai capture agent honors/,
    );
    expect(() => assertKnobsHonored(withKnobs({ resumeFrom: "leg-1" }), "adk", {})).toThrow(/only the claude\/openai capture agent honors/);
  });

  it("the RunState lives under the package's gitignored .tmp/capture-state, keyed by seed, never in corpus/", async () => {
    expect(runStatePath("approval-tool-gpt6sol")).toMatch(/[\\/]packages[\\/]e2e[\\/]\.tmp[\\/]capture-state[\\/]approval-tool-gpt6sol[\\/]openai\.runstate$/);
    expect(runStatePath("x")).not.toMatch(/[\\/]corpus[\\/]/);
    const root = await mkdtemp(join(tmpdir(), "capture-cli-test-"));
    try {
      await expect(resumeRunStateFrom("leg-1", root)).rejects.toThrow(/no saved RunState .*never committed/);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(dirname(runStatePath("leg-1", root)), { recursive: true });
      await writeFile(runStatePath("leg-1", root), "state-string", "utf8");
      expect(await resumeRunStateFrom("leg-1", root)).toBe("state-string");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a resume leg must match leg 1's steer, MCP servers and model; any difference fails before a capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "capture-cli-test-"));
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const leg1 = { name: "leg-1", prompt: "call it", steer: "S", mcpServers: [{ key: "t", kind: "text" }], toolApproval: "interrupt" };
      await mkdir(join(root, "scenarios", "leg-1"), { recursive: true });
      await writeFile(join(root, "scenarios", "leg-1", "scenario.json"), JSON.stringify(leg1));
      await mkdir(join(root, "corpus", "leg-1"), { recursive: true });
      await writeFile(join(root, "corpus", "leg-1", "openai.provenance.json"), JSON.stringify({ kind: "capture", model: "gpt-6-sol" }));
      const resume = (extra: Record<string, unknown>) =>
        Scenario.parse({ name: "leg-1-resume-approve", prompt: "Continue.", steer: "S", mcpServers: [{ key: "t", kind: "text" }], toolApproval: "approve", resumeFrom: "leg-1", ...extra });
      await expect(assertSameAsLeg1(resume({}), "gpt-6-sol", root)).resolves.toBeUndefined();
      await expect(assertSameAsLeg1(resume({ steer: "other" }), "gpt-6-sol", root)).rejects.toThrow(/steer differ/);
      await expect(assertSameAsLeg1(resume({ mcpServers: [] }), "gpt-6-sol", root)).rejects.toThrow(/mcpServers differ/);
      await expect(assertSameAsLeg1(resume({}), "gpt-6-luna", root)).rejects.toThrow(/model \(leg 1 gpt-6-sol, this leg gpt-6-luna\)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("adkStateScript: the knob guard and the session-state sidecar", () => {
  const scenario = Scenario.parse({ name: "state-fold", prompt: "x", adkStateScript: [{ cfg: { a: 1 } }] });

  it("passes on an adk agent that exports ADK_STATE_TOOL, fails without it or off adk", () => {
    expect(() => assertKnobsHonored(scenario, "adk", { ADK_STATE_TOOL: "apply_state_step" })).not.toThrow();
    expect(() => assertKnobsHonored(scenario, "adk", {})).toThrow(/does not export ADK_STATE_TOOL/);
    expect(() => assertKnobsHonored(scenario, "claude", { ADK_STATE_TOOL: "x" })).toThrow(/only the adk capture agent honors/);
  });

  it("runCaptureAndWrite writes <fw>.session-state.json when the agent reports session state, and not otherwise", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "capture-cli-test-"));
    try {
      const deps: CaptureDeps = {
        async *runAgentCapture(input) {
          yield* fakeNativeNoTools();
          input.onSessionState?.({ cfg: { a: 5 } });
        },
        serveMock,
        createNormalizer: createClaudeNormalizer,
        census,
      };
      await runCaptureAndWrite(scenario, deps, { ports: [], framework: "claude" }, outDir, { sdkVersion: null, model: null });
      expect(await readJson(join(outDir, "claude.session-state.json"))).toEqual({ cfg: { a: 5 } });
      const plainDir = join(outDir, "plain");
      await runCaptureAndWrite(Scenario.parse({ name: "text-only", prompt: "x" }), makeDeps(), { ports: [], framework: "claude" }, plainDir, {
        sdkVersion: null,
        model: null,
      });
      await expect(readFile(join(plainDir, "claude.session-state.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

describe("claudeSubagents and openaiHandoff: the knob guards (nested-turn capture ask)", () => {
  const withKnobs = (extra: Record<string, unknown>) => Scenario.parse({ name: "nested-probe", prompt: "x", ...extra });
  const agents = { helper: { description: "echoes", prompt: "Call echo." } };

  it("claudeSubagents passes only on a claude agent that exports claudeSubagentOptions", () => {
    expect(() => assertKnobsHonored(withKnobs({ claudeSubagents: agents }), "claude", { claudeSubagentOptions: () => ({}) })).not.toThrow();
    expect(() => assertKnobsHonored(withKnobs({ claudeSubagents: agents }), "claude", { captureQueryExtras: () => ({}) })).toThrow(
      /does not export claudeSubagentOptions/,
    );
    expect(() => assertKnobsHonored(withKnobs({ claudeSubagents: agents }), "openai", { claudeSubagentOptions: () => ({}) })).toThrow(
      /only the claude capture agent honors/,
    );
  });

  it("openaiHandoff passes only on an openai agent that exports openaiHandoffAgent", () => {
    const handoff = { name: "Specialist", instructions: "Answer." };
    expect(() => assertKnobsHonored(withKnobs({ openaiHandoff: handoff }), "openai", { openaiHandoffAgent: () => undefined })).not.toThrow();
    expect(() => assertKnobsHonored(withKnobs({ openaiHandoff: handoff }), "openai", { runOpenaiCapture: () => undefined })).toThrow(
      /does not export openaiHandoffAgent/,
    );
    expect(() => assertKnobsHonored(withKnobs({ openaiHandoff: handoff }), "claude", { openaiHandoffAgent: () => undefined })).toThrow(
      /only the openai capture agent honors/,
    );
  });

  it("the scenario schema rejects an empty agent map and a definition without a prompt", () => {
    expect(() => withKnobs({ claudeSubagents: {} })).toThrow();
    expect(() => withKnobs({ claudeSubagents: { helper: { description: "d" } } })).toThrow();
    expect(() => withKnobs({ openaiHandoff: { name: "" , instructions: "i" } })).toThrow();
  });
});
