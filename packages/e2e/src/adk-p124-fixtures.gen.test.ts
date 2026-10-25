/**
 * adk-p124-fixtures.gen.test.ts — generator for fixtures/adk-p124/, the
 * engine-built vectors of SPEC §8.0 item 26's pause signal when a second agent
 * runs after the pausing one.
 *
 * NOT part of the CI gate: runs only with GEN_ADK_P124=1. It drives the REAL
 * @google/adk engine (the e2e pin) with stub models (no key, no network) and
 * writes each run's yielded events verbatim (JSON round-trip) as
 * `<shape>.<instance>.native.json`, two instances per shape, each a fresh
 * runner and session (so ids and timestamps differ between instances).
 *
 *   GEN_ADK_P124=1 npx vitest run --config ../../vitest.config.ts src/adk-p124-fixtures.gen.test.ts
 *
 * Every shape is a SequentialAgent root whose first sub-agent `agent` raises
 * an ask and whose second sub-agent `next` answers "Done.":
 *  - seq-credential, seq-confirmation, seq-request-input: ADK's own stream.
 *    The pause-end event ADK yields (the function response carrying
 *    requestedAuthConfigs, the confirmation request carrying
 *    requestedToolConfirmations, the content-less skipSummarization event)
 *    precedes `next`'s final response.
 *  - <the same>-strip: the same run with a host plugin whose onEventCallback
 *    clears those pause-end members from the event the runner yields and
 *    stores. The runner applies onEventCallback after the agent's flow has
 *    acted on the event (runner/runner.js, runAsync), so the run itself is
 *    unchanged: an ask stays pending, no pause-end event arrives, and only
 *    `next`'s final response follows.
 *  - sse-seq-credential-strip: the credential shape under streamingMode SSE
 *    through ADK's own Gemini class with its transport stubbed, with the same
 *    plugin. ADK runs the pausing agent's model again after the credential
 *    request (agents/llm_agent.js step loop), so `agent`'s own final responses
 *    (the aggregator's content-less STOP tail, then its text) arrive while the
 *    ask is pending and before `next`'s.
 *
 * Not producible at the pin: an `adk_request_input` call that the MODEL emits
 * on an agent without requestInputTool. ADK cannot resolve the tool and
 * answers the call at once with an error function response, so no ask stays
 * pending (the run loops until maxLlmCalls).
 *
 * adk-p124.test.ts asserts the vectors.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  BaseLlm,
  BasePlugin,
  FunctionTool,
  Gemini,
  InMemoryRunner,
  LlmAgent,
  SequentialAgent,
  StreamingMode,
  requestInputTool,
} from "@google/adk";
import type { Event } from "@google/adk";
import { GenerateContentResponse } from "@google/genai";
import { z } from "zod";
import type { JsonValue } from "@silverprotocol/core";

export const ADK_P124_DIR = join(import.meta.dirname, "..", "fixtures", "adk-p124");

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

/** ADK's Gemini class with its transport replaced: chunks go through ADK's own
 *  StreamingResponseAggregator under streamingMode SSE. First call: one
 *  function-call chunk with STOP and usage; after a functionResponse: a text
 *  partial, then a final text chunk with STOP and usage. */
class SseTransportGemini extends Gemini {
  constructor(call: { name: string; args: Record<string, unknown> }) {
    super({ model: "gemini-stub", apiKey: "stub-not-a-key" });
    const chunk = (value: Record<string, unknown>) => Object.assign(new GenerateContentResponse(), value);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any)._apiClient = {
      models: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        generateContentStream: async (req: any) => {
          const answered = (req.contents ?? []).some((c: { parts?: Array<{ functionResponse?: unknown }> }) =>
            (c.parts ?? []).some((p) => p.functionResponse !== undefined),
          );
          const chunks = answered
            ? [
                chunk({ candidates: [{ content: { role: "model", parts: [{ text: "Waiting for " }] } }] }),
                chunk({
                  candidates: [{ content: { role: "model", parts: [{ text: "authorization." }] }, finishReason: "STOP" }],
                  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24 },
                }),
              ]
            : [
                chunk({
                  candidates: [{ content: { role: "model", parts: [{ functionCall: call }] }, finishReason: "STOP" }],
                  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
                }),
              ];
          return (async function* () {
            yield* chunks;
          })();
        },
        generateContent: async () => {
          throw new Error("SseTransportGemini: only the streaming path is stubbed");
        },
      },
    };
  }
}

/** Clears ADK's pause-end members from the event the runner yields and stores. */
class StripPauseEnd extends BasePlugin {
  constructor() {
    super("strip_pause_end");
  }
  override async onEventCallback({ event }: { event: Event }): Promise<Event | undefined> {
    const actions = event.actions;
    const nonEmpty = (o: object | undefined): boolean => o !== undefined && Object.keys(o).length > 0;
    if (!(nonEmpty(actions.requestedAuthConfigs) || nonEmpty(actions.requestedToolConfirmations) || actions.skipSummarization === true)) {
      return undefined;
    }
    const copy: Event = Object.assign(Object.create(Object.getPrototypeOf(event) as object) as Event, event);
    copy.actions = { ...actions, requestedAuthConfigs: {}, requestedToolConfirmations: {}, skipSummarization: undefined };
    return copy;
  }
}

const credentialTool = (): FunctionTool =>
  new FunctionTool({
    name: "read_mail",
    description: "Read mail.",
    parameters: z.object({}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_a: unknown, toolContext: any) => {
      toolContext.requestCredential({ authScheme: { type: "apiKey", in: "header", name: "X-Key" }, credentialKey: "mail-key" });
      return { status: "authorization requested" };
    },
  });

const confirmationTool = (): FunctionTool =>
  new FunctionTool({
    name: "delete_file",
    description: "Delete a file.",
    parameters: z.object({ path: z.string() }),
    requireConfirmation: true,
    execute: async () => ({ deleted: true }),
  });

const pausing = {
  credential: () =>
    new LlmAgent({ name: "agent", model: new StubModel({ name: "read_mail", args: {} }), instruction: "Read the mail.", tools: [credentialTool()] }),
  confirmation: () =>
    new LlmAgent({ name: "agent", model: new StubModel({ name: "delete_file", args: { path: "/tmp/x" } }), instruction: "Delete the file.", tools: [confirmationTool()] }),
  "request-input": () =>
    new LlmAgent({ name: "agent", model: new StubModel({ name: requestInputTool.name, args: { message: "Which city?" } }), instruction: "Ask for a city.", tools: [requestInputTool] }),
  "sse-credential": () =>
    new LlmAgent({ name: "agent", model: new SseTransportGemini({ name: "read_mail", args: {} }), instruction: "Read the mail.", tools: [credentialTool()] }),
} as const;

const next = (): LlmAgent => new LlmAgent({ name: "next", model: new StubModel(undefined), instruction: "Say done." });

const plain = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

async function runSeq(first: keyof typeof pausing, strip: boolean, streamingMode: StreamingMode): Promise<JsonValue[]> {
  const agent = new SequentialAgent({ name: "root", subAgents: [pausing[first](), next()] });
  const runner = new InMemoryRunner({ agent, plugins: strip ? [new StripPauseEnd()] : [] });
  const session = await runner.sessionService.createSession({ appName: runner.appName, userId: "user-1" });
  const out: JsonValue[] = [];
  for await (const ev of runner.runAsync({
    userId: "user-1",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: "go" }] },
    runConfig: { maxLlmCalls: 8, streamingMode },
  })) {
    out.push(plain(ev));
  }
  return out;
}

const SHAPES: ReadonlyArray<{ name: string; first: keyof typeof pausing; strip: boolean; mode: StreamingMode }> = [
  { name: "seq-credential", first: "credential", strip: false, mode: StreamingMode.NONE },
  { name: "seq-confirmation", first: "confirmation", strip: false, mode: StreamingMode.NONE },
  { name: "seq-request-input", first: "request-input", strip: false, mode: StreamingMode.NONE },
  { name: "seq-credential-strip", first: "credential", strip: true, mode: StreamingMode.NONE },
  { name: "seq-confirmation-strip", first: "confirmation", strip: true, mode: StreamingMode.NONE },
  { name: "seq-request-input-strip", first: "request-input", strip: true, mode: StreamingMode.NONE },
  { name: "sse-seq-credential-strip", first: "sse-credential", strip: true, mode: StreamingMode.SSE },
];

describe.runIf(process.env["GEN_ADK_P124"] === "1")("ADK P124 fixture generation (real @google/adk, stub models)", () => {
  it("writes fixtures/adk-p124/*.native.json", async () => {
    mkdirSync(ADK_P124_DIR, { recursive: true });
    for (const shape of SHAPES) {
      for (const instance of [1, 2]) {
        const events = await runSeq(shape.first, shape.strip, shape.mode);
        writeFileSync(join(ADK_P124_DIR, `${shape.name}.${instance}.native.json`), JSON.stringify(events, null, 2) + "\n");
      }
    }
  }, 120_000);
});
