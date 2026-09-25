/**
 * capture.test.ts — TDD RED: tests for runCapture.
 *
 * Risk-pass F4: fakes ONLY the LLM/process boundary (runAgentCapture).
 * Uses REAL createClaudeNormalizer (as opts.framework:"claude"'s createNormalizer),
 * REAL census, REAL extractToolCalls, REAL serveMock.
 *
 * The fake native stream is built from HONEST SDKMessage shapes (an assistant turn
 * with a nested tool_use block) so it genuinely exercises normalize→census
 * and tool-extraction — NOT glue-calling-glue.
 */
import { describe, it, expect } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { census } from "./census.js";
import { extractToolCalls } from "./extract-tools.js";
import { serveMock } from "./mcp-mocks/serve.js";
import { Scenario } from "./scenario.js";
import { runCapture, type CaptureDeps, type Cassette } from "./capture.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Reducer } from "@silverprotocol/core";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { HOST_COMPLETE_MARKER, replayNatives } from "./replay.js";

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal honest-SDKMessage native stream: one assistant turn with a
 * tool_use block + one result.success.
 */
function fakeNativeWith(toolName: string): JsonValue[] {
  return [
    {
      type: "assistant",
      session_id: "sess_test",
      parent_tool_use_id: null,
      message: {
        id: "msg_test_001",
        model: "claude-sonnet-4-6",
        role: "assistant",
        stop_reason: "tool_use",
        stop_sequence: null,
        type: "message",
        content: [
          {
            type: "tool_use",
            id: "tool_use_test_001",
            name: toolName,
            input: { message: "hello from fake" },
          },
        ],
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
      result: "Tool called successfully.",
      total_cost_usd: 0.001,
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

/**
 * A native stream with NO tool calls (for testing the expectTools guard).
 */
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
        content: [
          { type: "text", text: "I chose not to call any tools.", citations: null },
        ],
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
      uuid: "result_uuid_002",
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

// Port allocator: deterministic, test-isolated, no Math.random.
let nextPort = 49200;
function allocPort(): number {
  return nextPort++;
}

// ─── deps factory ───────────────────────────────────────────────────────────

function makeRealDeps(fakeStream: JsonValue[]): CaptureDeps {
  return {
    // ★ ONLY the LLM/process boundary is faked.
    async *runAgentCapture(_input) {
      for (const event of fakeStream) {
        yield event;
      }
    },
    // REAL collaborators:
    serveMock,
    createNormalizer: createClaudeNormalizer,
    census,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// runCapture — real pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("runCapture", () => {
  it("forwards scenario.followUps to CaptureRunInput.followUpPrompts when set, and omits it otherwise", async () => {
    const seen: unknown[] = [];
    const deps = (): CaptureDeps => ({
      async *runAgentCapture(input) {
        seen.push(input);
        yield* fakeNativeNoTools();
      },
      serveMock,
      createNormalizer: createClaudeNormalizer,
      census,
    });
    await runCapture(Scenario.parse({ name: "multi-result", prompt: "first", followUps: ["second"] }), deps(), {
      ports: [],
      framework: "claude",
    });
    await runCapture(Scenario.parse({ name: "text-only", prompt: "only" }), deps(), { ports: [], framework: "claude" });
    expect((seen[0] as { followUpPrompts?: string[] }).followUpPrompts).toEqual(["second"]);
    expect("followUpPrompts" in (seen[1] as object)).toBe(false);
  });

  it("produces a 3-part cassette (native, agjson, coverage) for text-only scenario", async () => {
    const scenario = Scenario.parse({
      name: "text-only",
      prompt: "Say something.",
    });

    // text-only has no mcpServers → no tools expected; stream with no tools satisfies expectTools=[]
    const deps = makeRealDeps(fakeNativeNoTools());

    const cassette: Cassette = await runCapture(scenario, deps, { ports: [], framework: "claude" });

    expect(cassette).toHaveProperty("native");
    expect(cassette).toHaveProperty("agjson");
    expect(cassette).toHaveProperty("coverage");
    expect(Array.isArray(cassette.native)).toBe(true);
    expect(Array.isArray(cassette.agjson)).toBe(true);
  });

  it("produces a cassette with a real coverage report from the REAL census", async () => {
    const scenario = Scenario.parse({
      name: "text-only",
      prompt: "Say something.",
    });

    const deps = makeRealDeps(fakeNativeNoTools());
    const cassette = await runCapture(scenario, deps, { ports: [], framework: "claude" });

    // The coverage report must have the census fields (drops, newFields).
    expect(cassette.coverage).toHaveProperty("drops");
    expect(cassette.coverage).toHaveProperty("newFields");
    expect(Array.isArray(cassette.coverage.drops)).toBe(true);
    expect(Array.isArray(cassette.coverage.newFields)).toBe(true);
  });

  it("★ REAL normalizer: agjson contains AgEvents produced by createClaudeNormalizer", async () => {
    const scenario = Scenario.parse({
      name: "text-only",
      prompt: "Say something.",
    });

    const deps = makeRealDeps(fakeNativeNoTools());
    const cassette = await runCapture(scenario, deps, { ports: [], framework: "claude" });

    // The REAL normalizer on an assistant text-only turn emits turn.start, message.start,
    // text.start, text.delta, text.end, message.end, turn.done — at least one event
    // must carry type === "turn.done" from the result.success message.
    const agjson = cassette.agjson as JsonValue[];
    const hasTurnDone = agjson.some(
      (e) => typeof e === "object" && e !== null && !Array.isArray(e) && e["type"] === "turn.done",
    );
    expect(hasTurnDone).toBe(true);
  });

  it("★ REAL extractToolCalls + expectTools check: satisfies expectTools → cassette returned", async () => {
    const scenario = Scenario.parse({
      name: "single-tool-call",
      prompt: "Call the echo tool.",
      mcpServers: [{ key: "t", kind: "text" }],
      steer: "You MUST call mcp__t__echo.",
    });

    const port = allocPort();
    // The fake stream calls mcp__t__echo → satisfies expectTools
    const deps = makeRealDeps(fakeNativeWith("mcp__t__echo"));
    const cassette = await runCapture(scenario, deps, { ports: [port], framework: "claude" });

    expect(cassette).toHaveProperty("native");
    expect(cassette).toHaveProperty("agjson");
    expect(cassette).toHaveProperty("coverage");

    // The native must contain the tool_use block
    const native = cassette.native as JsonValue[];
    const toolCalls = extractToolCalls(native);
    expect(toolCalls).toContain("mcp__t__echo");
  });

  it("★ throws when expectTools is NOT satisfied (no half-cassette written)", async () => {
    const scenario = Scenario.parse({
      name: "single-tool-call",
      prompt: "Call the echo tool.",
      mcpServers: [{ key: "t", kind: "text" }],
    });

    const port = allocPort();
    // The fake stream has NO tool calls → fails expectTools check
    const deps = makeRealDeps(fakeNativeNoTools());

    await expect(
      runCapture(scenario, deps, { ports: [port], framework: "claude" }),
    ).rejects.toThrow();
  });

  it("boots the REAL serveMock for each mcpServer (port is actually listening)", async () => {
    const scenario = Scenario.parse({
      name: "single-tool-call",
      prompt: "Call the echo tool.",
      mcpServers: [{ key: "t", kind: "text" }],
    });

    const port = allocPort();
    let capturedInput: unknown;

    // Wrap runAgentCapture to capture the mcpServers map it receives
    const deps: CaptureDeps = {
      async *runAgentCapture(input) {
        capturedInput = input;
        yield* (async function* () {
          for (const event of fakeNativeWith("mcp__t__echo")) {
            yield event;
          }
        })();
      },
      serveMock,
      createNormalizer: createClaudeNormalizer,
      census,
    };

    await runCapture(scenario, deps, { ports: [port], framework: "claude" });

    // The input passed to runAgentCapture must contain an mcpServers map
    // with "t" as the key and a url pointing to our port.
    expect(capturedInput).toBeDefined();
    const input = capturedInput as { mcpServers: Record<string, { url: string; bearer: string }> };
    const tServer = input.mcpServers["t"];
    expect(tServer).toBeDefined();
    expect(tServer?.url).toContain(`${port}`);
    expect(typeof tServer?.bearer).toBe("string");
  });

  it("forwards opts.model to the agent's CaptureRunInput.model when set", async () => {
    const scenario = Scenario.parse({ name: "text-only", prompt: "Say something." });
    let capturedInput: unknown;

    const deps: CaptureDeps = {
      async *runAgentCapture(input) {
        capturedInput = input;
        yield* (async function* () {
          for (const event of fakeNativeNoTools()) {
            yield event;
          }
        })();
      },
      serveMock,
      createNormalizer: createClaudeNormalizer,
      census,
    };

    await runCapture(scenario, deps, { ports: [], framework: "claude", model: "claude-sonnet-5" });

    const input = capturedInput as { model?: string };
    expect(input.model).toBe("claude-sonnet-5");
  });

  it("omits model from CaptureRunInput when opts.model is not set (agent's own default applies)", async () => {
    const scenario = Scenario.parse({ name: "text-only", prompt: "Say something." });
    let capturedInput: unknown;

    const deps: CaptureDeps = {
      async *runAgentCapture(input) {
        capturedInput = input;
        yield* (async function* () {
          for (const event of fakeNativeNoTools()) {
            yield event;
          }
        })();
      },
      serveMock,
      createNormalizer: createClaudeNormalizer,
      census,
    };

    await runCapture(scenario, deps, { ports: [], framework: "claude" });

    const input = capturedInput as { model?: string };
    expect(input.model).toBeUndefined();
  });

  // Input-capturing deps for the thinkingLevel plumbing tests below: records
  // the CaptureRunInput and streams the no-tools fake capture.
  function makeInputCapturingDeps(): { deps: CaptureDeps; input: () => unknown } {
    let captured: unknown;
    const deps: CaptureDeps = {
      async *runAgentCapture(input) {
        captured = input;
        yield* fakeNativeNoTools();
      },
      serveMock,
      createNormalizer: createClaudeNormalizer,
      census,
    };
    return { deps, input: () => captured };
  }

  it("forwards scenario.thinkingLevel to CaptureRunInput.thinkingLevel when set", async () => {
    const scenario = Scenario.parse({
      name: "thinking-gemini37",
      prompt: "Say something.",
      thinkingLevel: "high",
    });
    const { deps, input } = makeInputCapturingDeps();

    await runCapture(scenario, deps, { ports: [], framework: "claude" });

    expect((input() as { thinkingLevel?: string }).thinkingLevel).toBe("high");
  });

  it("omits thinkingLevel from CaptureRunInput when the scenario does not set it", async () => {
    const scenario = Scenario.parse({ name: "text-only", prompt: "Say something." });
    const { deps, input } = makeInputCapturingDeps();

    await runCapture(scenario, deps, { ports: [], framework: "claude" });

    expect((input() as { thinkingLevel?: string }).thinkingLevel).toBeUndefined();
  });

  it("forwards scenario.reasoningSummary to CaptureRunInput.reasoningSummary when set, and omits it otherwise", async () => {
    const withKnob = makeInputCapturingDeps();
    await runCapture(
      Scenario.parse({ name: "commentary-gpt6sol", prompt: "Say something.", reasoningSummary: "auto" }),
      withKnob.deps,
      { ports: [], framework: "claude" },
    );
    expect((withKnob.input() as { reasoningSummary?: string }).reasoningSummary).toBe("auto");

    const without = makeInputCapturingDeps();
    await runCapture(Scenario.parse({ name: "text-only", prompt: "Say something." }), without.deps, {
      ports: [],
      framework: "claude",
    });
    expect("reasoningSummary" in (without.input() as object)).toBe(false);
  });

  it("forwards scenario.preToolUseDecision and opts.resumeSessionId to CaptureRunInput when set, and omits both otherwise", async () => {
    const withKnobs = makeInputCapturingDeps();
    await runCapture(
      Scenario.parse({ name: "defer-tool-sonnet5-resume-deny", prompt: "Continue.", preToolUseDecision: "deny" }),
      withKnobs.deps,
      { ports: [], framework: "claude", resumeSessionId: "sess-leg-1" },
    );
    expect(withKnobs.input()).toMatchObject({ preToolUseDecision: "deny", resumeSessionId: "sess-leg-1" });

    const without = makeInputCapturingDeps();
    await runCapture(Scenario.parse({ name: "text-only", prompt: "Say something." }), without.deps, {
      ports: [],
      framework: "claude",
    });
    expect("preToolUseDecision" in (without.input() as object)).toBe(false);
    expect("resumeSessionId" in (without.input() as object)).toBe(false);
  });

  it("forwards scenario.toolApproval, opts.resumeRunState and opts.onRunState (openai approval legs), and omits them otherwise", async () => {
    const seen: string[] = [];
    const leg1 = makeInputCapturingDeps();
    await runCapture(Scenario.parse({ name: "approval-tool-gpt6sol", prompt: "x", toolApproval: "interrupt" }), leg1.deps, {
      ports: [],
      framework: "openai",
      onRunState: (s) => seen.push(s),
    });
    const leg1Input = leg1.input() as { toolApproval?: string; onRunState?: (s: string) => void };
    expect(leg1Input.toolApproval).toBe("interrupt");
    leg1Input.onRunState?.("rs");
    expect(seen).toEqual(["rs"]);
    const resume = makeInputCapturingDeps();
    await runCapture(Scenario.parse({ name: "approval-tool-gpt6sol-resume-approve", prompt: "x", toolApproval: "approve" }), resume.deps, {
      ports: [],
      framework: "openai",
      resumeRunState: "rs",
    });
    expect(resume.input()).toMatchObject({ toolApproval: "approve", resumeRunState: "rs" });
    const plain = makeInputCapturingDeps();
    await runCapture(Scenario.parse({ name: "text-only", prompt: "x" }), plain.deps, { ports: [], framework: "openai" });
    for (const k of ["toolApproval", "resumeRunState", "onRunState"]) expect(k in (plain.input() as object)).toBe(false);
  });

  it("an openai resume leg (resumeRunState) skips the expectTools check, like a claude resume", async () => {
    const scenario = Scenario.parse({ name: "approval-tool-gpt6sol-resume-reject", prompt: "x", mcpServers: [{ key: "t", kind: "text" }], toolApproval: "reject" });
    const resumed = makeInputCapturingDeps();
    await expect(runCapture(scenario, resumed.deps, { ports: [0], framework: "openai", resumeRunState: "rs" })).resolves.toHaveProperty("native");
  });

  it("forwards scenario.claudeSubagents as subagents and scenario.openaiHandoff as handoff, and omits them otherwise", async () => {
    const agents = { helper: { description: "echoes", prompt: "Call echo.", background: true, maxTurns: 3 } };
    const claude = makeInputCapturingDeps();
    await runCapture(Scenario.parse({ name: "subagent-bg", prompt: "x", claudeSubagents: agents }), claude.deps, { ports: [], framework: "claude" });
    expect((claude.input() as { subagents?: unknown }).subagents).toEqual(agents);
    const handoff = { name: "Specialist", instructions: "Answer.", handoffDescription: "answers" };
    const openai = makeInputCapturingDeps();
    await runCapture(Scenario.parse({ name: "handoff", prompt: "x", openaiHandoff: handoff }), openai.deps, { ports: [], framework: "openai" });
    expect((openai.input() as { handoff?: unknown }).handoff).toEqual(handoff);
    const plain = makeInputCapturingDeps();
    await runCapture(Scenario.parse({ name: "text-only", prompt: "x" }), plain.deps, { ports: [], framework: "claude" });
    for (const k of ["subagents", "handoff", "handoffs"]) expect(k in (plain.input() as object)).toBe(false);
  });

  it("forwards scenario.openaiHandoffs as handoffs (several targets), leaving handoff unset", async () => {
    const targets = [
      { name: "Echoer", instructions: "Echo." },
      { name: "Shouter", instructions: "Shout.", handoffDescription: "shouts" },
    ];
    const deps = makeInputCapturingDeps();
    await runCapture(Scenario.parse({ name: "handoff-parallel", prompt: "x", openaiHandoffs: targets }), deps.deps, { ports: [], framework: "openai" });
    expect((deps.input() as { handoffs?: unknown }).handoffs).toEqual(targets);
    expect("handoff" in (deps.input() as object)).toBe(false);
  });

  it("forwards scenario.adkStateScript and records the session state the agent reports via onSessionState", async () => {
    const script = [{ cfg: { a: 1, b: 2 }, "temp:scratch": "x" }, { cfg: { a: 5 } }];
    let seenScript: unknown;
    const deps: CaptureDeps = {
      async *runAgentCapture(input) {
        seenScript = input.adkStateScript;
        yield* fakeNativeNoTools();
        input.onSessionState?.({ cfg: { a: 5 } });
      },
      serveMock,
      createNormalizer: createClaudeNormalizer,
      census,
    };
    const cassette = await runCapture(Scenario.parse({ name: "state-fold", prompt: "x", adkStateScript: script }), deps, {
      ports: [],
      framework: "claude",
    });
    expect(seenScript).toEqual(script);
    expect(cassette.sessionState).toEqual({ cfg: { a: 5 } });
    const plainRun = await runCapture(Scenario.parse({ name: "text-only", prompt: "x" }), makeRealDeps(fakeNativeNoTools()), {
      ports: [],
      framework: "claude",
    });
    expect("sessionState" in plainRun).toBe(false);
  });

  it("a resume leg skips the expectTools check (its tool call was made in the leg it resumes); a fresh run still enforces it", async () => {
    const scenario = Scenario.parse({
      name: "defer-tool-sonnet5-resume-allow",
      prompt: "Continue.",
      mcpServers: [{ key: "t", kind: "text" }],
    });
    const resumed = makeInputCapturingDeps();
    await expect(
      runCapture(scenario, resumed.deps, { ports: [0], framework: "claude", resumeSessionId: "sess-leg-1" }),
    ).resolves.toHaveProperty("native");
    const fresh = makeInputCapturingDeps();
    await expect(runCapture(scenario, fresh.deps, { ports: [0], framework: "claude" })).rejects.toThrow(
      /did not call expected tools: mcp__t__echo/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// host-completion marker (SPEC §8.0 host obligation 4; rd-06 A.9 step 5)
// ─────────────────────────────────────────────────────────────────────────────

describe("runCapture — hostCompletion records the host-completion marker (adk)", () => {
  // google's engine-built Workflow run (P-RED): it ends on finalize's output
  // event with no in-band run terminal, the shape obligation 4 exists for.
  const WF_COMPLETE = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "fixtures", "adk-pause", "wf-complete.native.json"), "utf8"),
  ) as JsonValue[];
  const adkDeps = (hostCompletion: boolean): CaptureDeps => ({
    async *runAgentCapture() {
      yield* WF_COMPLETE;
    },
    serveMock,
    createNormalizer: () => createAdkNormalizer({ invokeId: "adk", ...(hostCompletion ? { hostCompletion: true } : {}) }),
    census,
    ...(hostCompletion ? { hostCompletion: true } : {}),
  });
  const scenario = Scenario.parse({ name: "text-only", prompt: "Echo wf-probe" });

  it("appends the marker as the LAST native line, and the capture's agjson equals replay's", async () => {
    const cassette = await runCapture(scenario, adkDeps(true), { ports: [], framework: "adk" });
    expect(cassette.native).toHaveLength(WF_COMPLETE.length + 1);
    expect(cassette.native.at(-1)).toEqual({ type: HOST_COMPLETE_MARKER });
    const replayed = await replayNatives(cassette.native, "adk");
    expect(replayed.hostCompleted).toBe(true);
    expect(cassette.agjson).toEqual(replayed.agjson);
  });

  it("the completed workflow closes success from push() and folds without parking", async () => {
    const { agjson } = await runCapture(scenario, adkDeps(true), { ports: [], framework: "adk" });
    const done = agjson.filter((e) => (e as { type: string }).type === "turn.done");
    expect(done.map((e) => (e as { outcome: { type: string } }).outcome.type)).toEqual(["success"]);
    expect(agjson.some((e) => (e as { type: string }).type === "turn.abort")).toBe(false);
    const r = new Reducer();
    for (const ev of agjson) r.push(ev as never);
    expect(r.needsResync).toBe(false);
  });

  it("the census reads the natives WITHOUT the marker", async () => {
    const cassette = await runCapture(scenario, adkDeps(true), { ports: [], framework: "adk" });
    const bare = await runCapture(scenario, adkDeps(false), { ports: [], framework: "adk" });
    expect(cassette.coverage).toEqual(
      census({
        native: WF_COMPLETE,
        agjson: cassette.agjson,
        transforms: new Map(),
        allowlist: new Map(),
        registry: new Set(),
        framework: "adk",
      }),
    );
    expect(bare.native).toEqual(WF_COMPLETE);
  });

  it("without hostCompletion nothing is appended (negative control: the run ends in the INV-FLUSH abort)", async () => {
    const { native, agjson } = await runCapture(scenario, adkDeps(false), { ports: [], framework: "adk" });
    expect(native).toEqual(WF_COMPLETE);
    expect(agjson.some((e) => (e as { type: string }).type === "turn.abort")).toBe(true);
  });
});

describe("runCapture — account-identifying values are redacted before anything reads them", () => {
  it("the cassette's native carries <redacted> for response-header identifiers, and the normalizer never saw the originals", async () => {
    const withHeaders = [
      ...fakeNativeNoTools(),
      { type: "probe-headers", response: { headers: { "openai-organization": "acct-org", "openai-project": "proj_x", "set-cookie": "c=1" } } },
    ] as JsonValue[];
    const cassette = await runCapture(Scenario.parse({ name: "text-only", prompt: "Say something." }), makeRealDeps(withHeaders), {
      ports: [],
      framework: "claude",
    });
    const all = JSON.stringify(cassette);
    expect(all).not.toContain("acct-org");
    expect(all).not.toContain("proj_x");
    expect(all).not.toContain("c=1");
    expect(JSON.stringify(cassette.native.at(-1))).toContain('"openai-organization":"<redacted>"');
  });
});
