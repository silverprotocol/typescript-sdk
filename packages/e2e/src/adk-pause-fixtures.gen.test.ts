/**
 * adk-pause-fixtures.gen.test.ts — generator for the rd-06 P-RED fixture set.
 *
 * NOT part of the CI gate: runs only with GEN_ADK_PAUSE=1. It drives the REAL
 * @google/adk engine (the e2e pin, 2.1.0) with a STUB model — no key, no
 * network — and writes each run's events verbatim (JSON round-trip, the same
 * plain-JSON boundary the capture agent uses) to fixtures/adk-pause/. The
 * events that carry the pause/completion semantics (adk_request_* calls, the
 * workflow's resume record, the confirmation event, the auth function
 * response) are built by the engine, not the model (rd-06 PS-6/CB-4/PS-3), so
 * a stub model is enough to exercise them.
 *
 *   GEN_ADK_PAUSE=1 npx vitest run --config ../../vitest.config.ts src/adk-pause-fixtures.gen.test.ts
 *
 * adk-pause.test.ts asserts SPEC draft.4 §10 item 25 (step-1 scope) over the
 * committed output. Truncated streams are cut from a complete run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  BaseLlm,
  DEFAULT_ROUTE,
  FunctionNode,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  NodeTool,
  RequestInput,
  SequentialAgent,
  Workflow,
  createEvent,
  requestInputTool,
} from "@google/adk";
import { z } from "zod";
import type { JsonValue } from "@silverprotocol/core";
import { buildCaptureWorkflow } from "./agents/google-adk/workflow.js";

export const ADK_PAUSE_DIR = join(import.meta.dirname, "..", "fixtures", "adk-pause");

type Call = { name: string; args: Record<string, unknown> } | undefined;

/** Calls `call` once; after any functionResponse (or with no call) answers "Done." and stops. */
class StubModel extends BaseLlm {
  readonly #call: Call;
  constructor(call: Call) {
    super({ model: "stub" });
    this.#call = call;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async *generateContentAsync(req: any): AsyncGenerator<any, void> {
    const answered = (req.contents ?? []).some((c: { parts?: Array<{ functionResponse?: unknown }> }) =>
      (c.parts ?? []).some((p) => p.functionResponse !== undefined),
    );
    yield answered || this.#call === undefined
      ? { content: { role: "model", parts: [{ text: "Done." }] }, turnComplete: true, finishReason: "STOP" }
      : { content: { role: "model", parts: [{ functionCall: this.#call }] }, turnComplete: true };
  }
  async connect(): Promise<never> {
    throw new Error("StubModel: live connections are not supported");
  }
}

const echoTool = (): FunctionTool =>
  new FunctionTool({
    name: "echo",
    description: "Echo a message.",
    parameters: z.object({ message: z.string() }),
    execute: async ({ message }: { message: string }) => ({ echoed: message }),
  });

const plain = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

async function invoke(
  runner: InMemoryRunner,
  sessionId: string,
  newMessage: { role: "user"; parts: Array<Record<string, unknown>> },
): Promise<JsonValue[]> {
  const out: JsonValue[] = [];
  for await (const ev of runner.runAsync({ userId: "user-1", sessionId, newMessage, runConfig: { maxLlmCalls: 8 } })) {
    out.push(plain(ev));
  }
  return out;
}

type RunnerAgent = ConstructorParameters<typeof InMemoryRunner>[0]["agent"];

async function runOnce(agent: RunnerAgent, prompt = "Echo wf-probe"): Promise<JsonValue[]> {
  const runner = new InMemoryRunner({ agent });
  const s = await runner.sessionService.createSession({ appName: runner.appName, userId: "user-1" });
  return invoke(runner, s.id, { role: "user", parts: [{ text: prompt }] });
}

const workflow = (shape: "pause" | "complete"): Workflow =>
  buildCaptureWorkflow({
    shape,
    model: new StubModel({ name: "echo", args: { message: "wf-probe" } }),
    instruction: "Echo the message with the echo tool.",
    tools: [echoTool()],
  });

/** Index of the first event whose author/node matches, for cutting truncated streams. */
function lastIndexWhere(events: JsonValue[], pred: (e: Record<string, unknown>) => boolean): number {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i] as Record<string, unknown>)) return i;
  return -1;
}

describe.runIf(process.env["GEN_ADK_PAUSE"] === "1")("rd-06 P-RED fixture generation (real @google/adk, stub model)", () => {
  it("writes fixtures/adk-pause/*.native.json", async () => {
    const out: Record<string, JsonValue[]> = {};

    // ── the two e1f7303 workflow shapes (google's own graph builder) ──
    out["wf-pause"] = await runOnce(workflow("pause"));
    out["wf-complete"] = await runOnce(workflow("complete"));

    // ── a Workflow whose terminal node is an LlmAgent ──
    {
      const classify = new FunctionNode("classify", (_c, input: unknown) =>
        createEvent({ output: typeof input === "string" ? input : null, route: "tool" }),
      );
      const spike = new LlmAgent({
        name: "spike",
        model: new StubModel({ name: "echo", args: { message: "wf-probe" } }),
        instruction: "Echo.",
        tools: [echoTool()],
        isolationScope: true,
      });
      const finalize = new FunctionNode("finalize", (_c, input: unknown) => ({ done: true, result: input }));
      out["wf-terminal-llm"] = await runOnce(
        new Workflow({ name: "terminal_llm_workflow", edges: [["START", classify, { tool: spike, [DEFAULT_ROUTE]: finalize }]] }),
      );
    }

    // ── a FunctionNode-only Workflow (no model at all) ──
    {
      const first = new FunctionNode("first", (_c, input: unknown) => ({ seen: input }));
      const second = new FunctionNode("second", (_c, input: unknown) => ({ done: true, result: input }));
      out["wf-functionnode-only"] = await runOnce(new Workflow({ name: "fn_only_workflow", edges: [["START", first, second]] }));
    }

    // ── the pause → resume pair: two invokes on ONE session (one Normalizer each) ──
    {
      const runner = new InMemoryRunner({ agent: workflow("pause") });
      const s = await runner.sessionService.createSession({ appName: runner.appName, userId: "user-1" });
      const first = await invoke(runner, s.id, { role: "user", parts: [{ text: "Echo wf-probe" }] });
      let fcId: string | undefined;
      const walk = (x: unknown): void => {
        if (Array.isArray(x)) return x.forEach(walk);
        if (x === null || typeof x !== "object") return;
        const fc = (x as { functionCall?: { name?: unknown; id?: unknown } }).functionCall;
        if (fc?.name === "adk_request_input" && typeof fc.id === "string") fcId ??= fc.id;
        Object.values(x).forEach(walk);
      };
      walk(first);
      if (fcId === undefined) throw new Error("pause invoke carried no adk_request_input call to answer");
      const second = await invoke(runner, s.id, {
        role: "user",
        parts: [{ functionResponse: { id: fcId, name: "adk_request_input", response: { approved: true } } }],
      });
      out["wf-pause-resume.invoke1"] = first;
      out["wf-pause-resume.invoke2"] = second;
    }

    // ── plain LlmAgent pauses ──
    out["plain-confirmation"] = await runOnce(
      new LlmAgent({
        name: "agent",
        model: new StubModel({ name: "delete_file", args: { path: "/tmp/x" } }),
        instruction: "Delete the file.",
        tools: [
          new FunctionTool({
            name: "delete_file",
            description: "Delete a file.",
            parameters: z.object({ path: z.string() }),
            requireConfirmation: true,
            execute: async () => ({ deleted: true }),
          }),
        ],
      }),
    );
    out["plain-credential"] = await runOnce(
      new LlmAgent({
        name: "agent",
        model: new StubModel({ name: "read_mail", args: {} }),
        instruction: "Read the mail.",
        tools: [
          new FunctionTool({
            name: "read_mail",
            description: "Read mail.",
            parameters: z.object({}),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            execute: async (_a: unknown, toolContext: any) => {
              toolContext.requestCredential({
                authScheme: {
                  type: "oauth2",
                  flows: {
                    authorizationCode: {
                      authorizationUrl: "https://auth.example/authorize",
                      tokenUrl: "https://auth.example/token",
                      scopes: { "mail.read": "" },
                    },
                  },
                },
                rawAuthCredential: { authType: "oauth2", oauth2: { clientId: "cid", clientSecret: "cs" } },
                credentialKey: "mail-cred",
              });
              return { status: "pending auth" };
            },
          }),
        ],
      }),
    );
    out["plain-request-input"] = await runOnce(
      new LlmAgent({
        name: "agent",
        model: new StubModel({ name: requestInputTool.name, args: { message: "Which city?" } }),
        instruction: "Ask for a city.",
        tools: [requestInputTool],
      }),
    );

    // ── a Workflow FunctionNode that requests a credential ──
    {
      const fetchNode = new FunctionNode("fetch", (_c, input: unknown) => ({ fetched: input }), {
        authConfig: { authScheme: { type: "apiKey", in: "header", name: "X-Key" }, credentialKey: "fetch-key" },
      } as never);
      out["wf-functionnode-credential"] = await runOnce(new Workflow({ name: "cred_workflow", edges: [["START", fetchNode]] }));
    }

    // ── a NodeTool inside a plain LlmAgent (nodeInfo inside a plain run, PS-15) ──
    {
      const lookup = new FunctionNode("lookup", (_c, input: unknown) => ({ found: input }), {
        inputSchema: z.object({ q: z.string() }),
      } as never);
      out["nodetool-in-llmagent"] = await runOnce(
        new LlmAgent({
          name: "agent",
          model: new StubModel({ name: "lookup", args: { q: "probe" } }),
          instruction: "Look it up.",
          tools: [new NodeTool(lookup, "lookup", "Look something up.")],
        }),
      );
    }

    // ── known gaps on the legacy path (pinned, not fixed in step 1) ──
    out["known-gap-sequential-root"] = await runOnce(
      new SequentialAgent({
        name: "seq",
        subAgents: [
          new LlmAgent({ name: "a", model: new StubModel(undefined), instruction: "Say done." }),
          new LlmAgent({ name: "b", model: new StubModel(undefined), instruction: "Say done." }),
        ],
      }),
    );
    out["known-gap-after-agent-callback"] = await runOnce(
      new LlmAgent({
        name: "agent",
        model: new StubModel(undefined),
        instruction: "Say done.",
        afterAgentCallback: async () => ({ role: "model", parts: [{ text: "appended by afterAgentCallback" }] }),
      }),
    );

    // ── truncated streams, cut from the complete workflow run ──
    const complete = out["wf-complete"]!;
    const afterClassify = lastIndexWhere(complete, (e) => JSON.stringify(e["nodeInfo"] ?? "").includes("classify"));
    const afterSpikeFinal = lastIndexWhere(complete, (e) => JSON.stringify(e).includes('"text":"Done."'));
    if (afterClassify < 0 || afterSpikeFinal < 0 || afterSpikeFinal <= afterClassify) {
      throw new Error(`cannot cut truncated streams (classify@${afterClassify}, spike final@${afterSpikeFinal})`);
    }
    out["truncated-after-classify"] = complete.slice(0, afterClassify + 1);
    out["truncated-after-spike-final"] = complete.slice(0, afterSpikeFinal + 1);

    mkdirSync(ADK_PAUSE_DIR, { recursive: true });
    for (const [name, events] of Object.entries(out)) {
      writeFileSync(join(ADK_PAUSE_DIR, `${name}.native.json`), JSON.stringify(events, null, 2) + "\n");
    }
  }, 120_000);
});
