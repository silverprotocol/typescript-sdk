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
import { join } from "node:path";
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
      expect(resolveModel("claude")).toBe("claude-sonnet-4-6");
      expect(resolveModel("openai")).toBe("gpt-4o-mini");
      expect(resolveModel("adk")).toBe("gemini-2.5-flash");
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
      expect(resolveModel("claude")).toBe("claude-sonnet-4-6");
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
        model: "claude-sonnet-4-6",
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
        { sdkVersion: "0.2.141", model: "claude-sonnet-4-6" },
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
      expect(p["model"]).toBe("claude-sonnet-4-6");
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
        "e2e:capture: set CAPTURE_SCENARIO=<scenarios/ dir name> and CAPTURE_FRAMEWORK=<claude|openai|adk>",
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
