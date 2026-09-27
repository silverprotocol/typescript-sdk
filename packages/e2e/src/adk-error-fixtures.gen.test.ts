/**
 * adk-error-fixtures.gen.test.ts — generator for the ADK in-band error fixture set.
 *
 * NOT part of the CI gate: runs only with GEN_ADK_ERROR=1. It drives the REAL
 * @google/adk engine (the e2e pin, 2.1.0): its runners (InMemoryRunner,
 * LoopAgent, ParallelAgent, SequentialAgent, Workflow with a node retryConfig,
 * NodeTool) and its own Gemini model class, whose genai transport is replaced
 * (no key, no network). A streaming call's chunks go through ADK's real
 * StreamingResponseAggregator, so the error events, and the aggregate that
 * repeats one as a stream closes, are the engine's own. Each run's events are
 * written verbatim (a JSON round-trip, the same plain-JSON boundary the capture
 * agent uses) to fixtures/adk-error/.
 *
 *   GEN_ADK_ERROR=1 npx vitest run --config ../../vitest.config.ts src/adk-error-fixtures.gen.test.ts
 *
 * Each fixture is written in the default mode (`<leg>.none`) and in the SSE
 * streaming mode (`<leg>.sse`), except where a leg exists in one mode only.
 * The progressive leg sets ADK_ENABLE_PROGRESSIVE_SSE_STREAMING for its run.
 * Arrival order across parallel branches is steered with delays before a
 * call's first chunk and after its last; the generator checks the recorded
 * order before it writes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FunctionTool,
  Gemini,
  InMemoryRunner,
  LlmAgent,
  LoopAgent,
  NodeTool,
  ParallelAgent,
  SequentialAgent,
  StreamingMode,
  Workflow,
  node,
  requestInputTool,
} from "@google/adk";
import { GenerateContentResponse } from "@google/genai";
import { z } from "zod";
import type { JsonValue } from "@silverprotocol/core";

export const ADK_ERROR_DIR = join(import.meta.dirname, "..", "fixtures", "adk-error");

type Chunk = GenerateContentResponse;
/** One model call: its chunks (streamed in order; merged into one response in the default mode), or a thrown error. */
type Call = { chunks: Chunk[]; delay?: number; tail?: number; throwAfter?: Error } | { throws: Error; delay?: number };

const chunk = (value: Record<string, unknown>): Chunk => Object.assign(new GenerateContentResponse(), value);
const BLOCK_USAGE = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };
const ANSWER_USAGE = { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24 };
const text = (t: string): Chunk => chunk({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const usageOnly = (usage: Record<string, number>): Chunk => chunk({ usageMetadata: usage });
/** A response-level block: a candidate with no content, a finishReason and a finishMessage. */
const block = (opts: { reason?: string; message?: string; usage?: Record<string, number> } = {}): Chunk =>
  chunk({
    candidates: [{ finishReason: opts.reason ?? "SAFETY", finishMessage: opts.message ?? "The response was blocked for safety." }],
    ...(opts.usage ? { usageMetadata: opts.usage } : {}),
  });
const functionCall = (name: string, args: Record<string, unknown>): Chunk =>
  chunk({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }], usageMetadata: ANSWER_USAGE });
const answer = (t: string): Call => ({
  chunks: [text(t), chunk({ candidates: [{ content: { role: "model", parts: [{ text: "." }] }, finishReason: "STOP" }], usageMetadata: ANSWER_USAGE })],
});
const rateLimit = (): Error =>
  new Error(JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }));

/** What the non-streaming API returns for the same call: one candidate holding every chunk's parts, the last
 *  finishReason / finishMessage, and the last usage. A candidate that ends on a block (a finishReason other than
 *  STOP or MAX_TOKENS) is returned without its content, as the API withholds blocked content. */
function merged(chunks: Chunk[]): Chunk {
  const parts: Array<Record<string, unknown>> = [];
  const candidate: Record<string, unknown> = {};
  let usage: unknown;
  for (const c of chunks) {
    if (c.usageMetadata) usage = c.usageMetadata;
    const k = c.candidates?.[0];
    if (!k) continue;
    for (const p of k.content?.parts ?? []) {
      const last = parts[parts.length - 1];
      if (typeof p.text === "string" && typeof last?.["text"] === "string") last["text"] = (last["text"] as string) + p.text;
      else parts.push({ ...p });
    }
    if (k.finishReason !== undefined) candidate["finishReason"] = k.finishReason;
    if (k.finishMessage !== undefined) candidate["finishMessage"] = k.finishMessage;
  }
  const blocked = typeof candidate["finishReason"] === "string" && !["STOP", "MAX_TOKENS"].includes(candidate["finishReason"]);
  return chunk({
    candidates: [{ ...(parts.length && !blocked ? { content: { role: "model", parts } } : {}), ...candidate }],
    ...(usage ? { usageMetadata: usage } : {}),
  });
}

const sleep = (ms?: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** ADK's own Gemini class with its transport replaced: call k serves calls[k] (the last entry repeats). */
class ScriptedGemini extends Gemini {
  constructor(name: string, calls: Call[]) {
    super({ model: `gemini-stub-${name}`, apiKey: "stub-not-a-key" });
    let k = 0;
    const next = () => calls[Math.min(k++, calls.length - 1)]!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any)._apiClient = {
      models: {
        generateContentStream: async () => {
          const c = next();
          await sleep(c.delay);
          if ("throws" in c) throw c.throws;
          return (async function* () {
            yield* c.chunks;
            await sleep(c.tail);
            if (c.throwAfter) throw c.throwAfter;
          })();
        },
        generateContent: async () => {
          const c = next();
          await sleep(c.delay);
          if ("throws" in c) throw c.throws;
          if (c.throwAfter) throw new Error("A stream that throws after its chunks has no default-mode form.");
          return merged(c.chunks);
        },
      },
    };
  }
}

/** ADK's Gemini class on its Interactions route (`useInteractionsApi`), with the transport replaced: every call's
 *  interaction ends with status "failed" (streamed: the interaction's start, then the failed status update). */
class FailedInteractionGemini extends Gemini {
  constructor(name: string) {
    super({ model: `gemini-stub-${name}`, apiKey: "stub-not-a-key", useInteractionsApi: true });
    const id = `interaction-${name}-1`;
    const error = { code: "INTERNAL", message: "The interaction failed." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any)._apiClient = {
      interactions: {
        create: async (req: { stream?: boolean }) =>
          req.stream
            ? (async function* () {
                yield { event_type: "interaction.start", interaction: { id, status: "in_progress" } };
                yield { event_type: "interaction.status_update", interaction_id: id, status: "failed", error };
              })()
            : { id, status: "failed", error },
      },
    };
  }
}

/** Several function calls in one model chunk. */
const functionCalls = (calls: Array<[string, Record<string, unknown>]>): Chunk =>
  chunk({
    candidates: [{ content: { role: "model", parts: calls.map(([name, args]) => ({ functionCall: { name, args } })) }, finishReason: "STOP" }],
    usageMetadata: ANSWER_USAGE,
  });

const agent = (name: string, calls: Call[], extra: Record<string, unknown> = {}): LlmAgent =>
  new LlmAgent({ name, model: new ScriptedGemini(name, calls), instruction: "Answer the user.", ...extra });

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

const lookupTool = (): FunctionTool =>
  new FunctionTool({
    name: "lookup",
    description: "Look something up.",
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }: { query: string }) => ({ found: query }),
  });

/** A before-tool callback that throws for the lookup tool: ADK runs a step's calls in order, and the throw escapes
 *  the step's tool handling, so ADK yields it in-band as the step's last event. */
const failingLookupCallback = ({ tool }: { tool: { name: string } }): undefined => {
  if (tool.name === "lookup") throw new Error("The lookup backend is unavailable.");
  return undefined;
};

const deleteTool = (): FunctionTool =>
  new FunctionTool({
    name: "delete_file",
    description: "Delete a file.",
    parameters: z.object({ path: z.string() }),
    requireConfirmation: true,
    execute: async () => ({ deleted: true }),
  });

const plain = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
type RunnerAgent = ConstructorParameters<typeof InMemoryRunner>[0]["agent"];
type Mode = "none" | "sse" | "progressive";

/** One invocation on a fresh session. A run that throws (a Workflow node that fails for good) keeps what it
 *  yielded; the generator records that it threw. */
type Run = { events: JsonValue[]; threw?: string; thrown?: { name: string; message: string } };
async function run(root: RunnerAgent, mode: Mode): Promise<Run> {
  if (mode === "progressive") process.env["ADK_ENABLE_PROGRESSIVE_SSE_STREAMING"] = "1";
  else delete process.env["ADK_ENABLE_PROGRESSIVE_SSE_STREAMING"];
  try {
    const runner = new InMemoryRunner({ agent: root });
    const s = await runner.sessionService.createSession({ appName: runner.appName, userId: "user-1" });
    const events: JsonValue[] = [];
    let threw: string | undefined;
    let thrown: { name: string; message: string } | undefined;
    try {
      for await (const ev of runner.runAsync({
        userId: "user-1",
        sessionId: s.id,
        newMessage: { role: "user", parts: [{ text: "Answer the question." }] },
        runConfig: { maxLlmCalls: 12, streamingMode: mode === "none" ? StreamingMode.NONE : StreamingMode.SSE },
      })) events.push(plain(ev));
    } catch (e) {
      threw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      thrown = e instanceof Error ? { name: e.name, message: e.message } : { name: typeof e, message: String(e) };
    }
    return { events, ...(threw ? { threw, thrown } : {}) };
  } finally {
    delete process.env["ADK_ENABLE_PROGRESSIVE_SSE_STREAMING"];
  }
}

type Ev = { author?: string; branch?: string; partial?: boolean; errorCode?: string; errorMessage?: string; usageMetadata?: unknown; content?: { parts?: Array<Record<string, unknown>> } };
const errorRows = (events: JsonValue[]) => (events as Ev[]).filter((e) => e.errorCode !== undefined).map((e) => `${e.author}:${e.errorCode}:${e.partial === false ? "aggregate" : "report"}`);
const authorsInOrder = (events: JsonValue[]) => (events as Ev[]).map((e) => e.author).filter((a, i, all) => a !== all[i - 1]);

const retry = { maxAttempts: 3, initialDelay: 0, maxDelay: 0, jitter: 0 };

/** Every leg: its builder (a fresh tree per run), the modes it is written in, and a shape check on what ADK
 *  yielded (the generator refuses to write a fixture whose shape drifted). */
type Leg = { name: string; modes: Mode[]; build: () => RunnerAgent; check?: (r: Run, mode: Mode) => void };

type Act = { actions?: { requestedAuthConfigs?: object; requestedToolConfirmations?: object; skipSummarization?: boolean } };
const firstIndex = (events: JsonValue[], pred: (e: Ev & Act) => boolean) => (events as Array<Ev & Act>).findIndex(pred);
const isAuthPause = (e: Act) => Object.keys(e.actions?.requestedAuthConfigs ?? {}).length > 0;
const isConfirmation = (e: Act) => Object.keys(e.actions?.requestedToolConfirmations ?? {}).length > 0;
const isSkipSummarization = (e: Act) => e.actions?.skipSummarization === true;
const hasText = (e: Ev) => (e.content?.parts ?? []).some((p) => typeof p["text"] === "string");

const LEGS: Leg[] = [
  // SSE aggregate legs: a response-level block that carries a finish message.
  { name: "block-usage-on-finish", modes: ["sse"], build: () => agent("assistant", [{ chunks: [block({ usage: BLOCK_USAGE })] }]),
    check: (r) => expect(errorRows(r.events)).toEqual(["assistant:SAFETY:report", "assistant:SAFETY:aggregate"]) },
  { name: "block-usage-later", modes: ["sse"], build: () => agent("assistant", [{ chunks: [block(), usageOnly(BLOCK_USAGE)] }]),
    check: (r) => expect(errorRows(r.events)).toEqual(["assistant:SAFETY:report", "assistant:SAFETY:aggregate"]) },
  { name: "text-then-block-no-usage", modes: ["sse"], build: () => agent("assistant", [{ chunks: [text("Here is the start of "), text("an answer"), block()] }]),
    check: (r) => expect(errorRows(r.events)).toEqual(["assistant:SAFETY:report", "assistant:SAFETY:aggregate"]) },
  // The first call meets the block with no usage and no text (no aggregate); the second streams text and ends on
  // the same block (an aggregate follows its own report).
  { name: "bare-block-then-streamed-block", modes: ["sse"], build: () => new LoopAgent({ name: "loop", maxIterations: 2, subAgents: [agent("assistant", [{ chunks: [block()] }, { chunks: [text("Partial answer"), block({ usage: BLOCK_USAGE })] }])] }),
    check: (r) => expect(errorRows(r.events)).toEqual(["assistant:SAFETY:report", "assistant:SAFETY:report", "assistant:SAFETY:aggregate"]) },
  // No merge of genuine failures: the same agent meets the identical block twice.
  { name: "loop-identical-block", modes: ["none", "sse"], build: () => new LoopAgent({ name: "loop", maxIterations: 2, subAgents: [agent("assistant", [{ chunks: [block({ usage: BLOCK_USAGE })] }])] }),
    check: (r, m) => expect(errorRows(r.events)).toEqual(m === "none" ? ["assistant:SAFETY:report", "assistant:SAFETY:report"] : ["assistant:SAFETY:report", "assistant:SAFETY:aggregate", "assistant:SAFETY:report", "assistant:SAFETY:aggregate"]) },
  { name: "workflow-node-retry", modes: ["none", "sse"], build: () => new Workflow({ name: "flow", edges: [["START", node(agent("assistant", [{ chunks: [block({ usage: BLOCK_USAGE })] }, { chunks: [block({ usage: BLOCK_USAGE })] }, answer("Recovered")]), { retryConfig: retry })]] }),
    check: (r) => { expect(errorRows(r.events).filter((x) => x.endsWith(":report"))).toHaveLength(2); expect(r.threw).toBeUndefined(); } },
  // Order: ParallelAgent, two branches with different in-band errors; the second branch lands inside the first's
  // report→aggregate window in one order and after it in the other. Every branch completes in both orders.
  { name: "parallel-agent-two-errors-a-first", modes: ["none", "sse"], build: () => new ParallelAgent({ name: "fanout", subAgents: [
      agent("alpha", [{ chunks: [text("Alpha "), block({ usage: BLOCK_USAGE })], tail: 60 }]),
      agent("beta", [{ chunks: [text("Beta "), block({ reason: "RECITATION", message: "The response recited a source.", usage: BLOCK_USAGE })], delay: 20 }])] }),
    check: (r) => expect(authorsInOrder(r.events)[0]).toBe("alpha") },
  { name: "parallel-agent-two-errors-b-first", modes: ["none", "sse"], build: () => new ParallelAgent({ name: "fanout", subAgents: [
      agent("alpha", [{ chunks: [text("Alpha "), block({ usage: BLOCK_USAGE })], delay: 20 }]),
      agent("beta", [{ chunks: [text("Beta "), block({ reason: "RECITATION", message: "The response recited a source.", usage: BLOCK_USAGE })], tail: 60 }])] }),
    check: (r) => expect(authorsInOrder(r.events)[0]).toBe("beta") },
  { name: "parallel-agent-one-error-a-first", modes: ["none", "sse"], build: () => new ParallelAgent({ name: "fanout", subAgents: [
      agent("alpha", [{ chunks: [block({ usage: BLOCK_USAGE })], tail: 60 }]),
      agent("beta", [{ ...answer("Beta answered"), delay: 20 }])] }),
    check: (r) => expect(authorsInOrder(r.events)[0]).toBe("alpha") },
  { name: "parallel-agent-one-error-b-first", modes: ["none", "sse"], build: () => new ParallelAgent({ name: "fanout", subAgents: [
      agent("alpha", [{ chunks: [block({ usage: BLOCK_USAGE })], delay: 40 }]),
      agent("beta", [answer("Beta answered")])] }),
    check: (r) => expect(authorsInOrder(r.events)[0]).toBe("beta") },
  // Order: a Workflow with two parallel nodes, one meeting the block. The sibling completes before the failing
  // node fails in BOTH orders (a failing node aborts a sibling still in flight). The a-first order exists in SSE
  // only: in the default mode the failing node's one event is also its end, so no sibling can finish after it.
  { name: "parallel-workflow-one-block-a-first", modes: ["sse"], build: () => new Workflow({ name: "flow", edges: [["START", [
      agent("alpha", [{ chunks: [block({ usage: BLOCK_USAGE })], tail: 80 }]),
      agent("beta", [{ ...answer("Beta answered"), delay: 20 }])]]] }),
    check: (r) => { expect(authorsInOrder(r.events)[0]).toBe("alpha"); expect((r.events as Ev[]).filter((e) => e.author === "beta" && e.partial === false && e.usageMetadata)).toHaveLength(1); } },
  { name: "parallel-workflow-one-block-b-first", modes: ["none", "sse"], build: () => new Workflow({ name: "flow", edges: [["START", [
      agent("alpha", [{ chunks: [block({ usage: BLOCK_USAGE })], delay: 40 }]),
      agent("beta", [answer("Beta answered")])]]] }),
    check: (r) => { expect(authorsInOrder(r.events)[0]).toBe("beta"); expect((r.events as Ev[]).filter((e) => e.author === "beta" && e.partial !== true && e.usageMetadata)).toHaveLength(1); } },
  // Error then pause: a first sub-agent's in-band rate-limit error, then a second sub-agent that pauses.
  { name: "sequential-429-then-credential", modes: ["none", "sse"], build: () => new SequentialAgent({ name: "root", subAgents: [
      agent("first", [{ throws: rateLimit() }]),
      agent("second", [{ chunks: [functionCall("read_mail", {})] }, answer("Waiting for authorization")], { tools: [credentialTool()] })] }),
    check: (r) => expect(errorRows(r.events)).toEqual(["first:429:report"]) },
  { name: "sequential-429-then-request-input", modes: ["none", "sse"], build: () => new SequentialAgent({ name: "root", subAgents: [
      agent("first", [{ throws: rateLimit() }]),
      agent("second", [{ chunks: [functionCall(requestInputTool.name, { message: "Which city?" })] }, answer("Unused")], { tools: [requestInputTool] })] }),
    check: (r) => expect(errorRows(r.events)).toEqual(["first:429:report"]) },
  // The fixed cost: a plain agent whose node tool's node meets an in-band error, then succeeds on retry.
  { name: "node-tool-retry", modes: ["none", "sse"], build: () => agent("assistant", [{ chunks: [functionCall("lookup", { request: "weather" })] }, answer("It is sunny")], {
      tools: [new NodeTool(node(agent("lookup", [{ throws: rateLimit() }, answer("Sunny")]), { retryConfig: retry, inputSchema: z.string() }))] }),
    check: (r) => expect(errorRows(r.events)).toEqual(["lookup:429:report"]) },
  // A rate-limit error that ADK yields in-band in a SequentialAgent's first sub-agent; the later sub-agents answer.
  { name: "sequential-429-then-answer", modes: ["none", "sse"], build: () => new SequentialAgent({ name: "root", subAgents: [
      agent("first", [{ throws: rateLimit() }]), agent("second", [answer("The second agent answered")])] }),
    check: (r) => { expect(errorRows(r.events)).toEqual(["first:429:report"]); expect(authorsInOrder(r.events)).toEqual(["first", "second"]); } },
  { name: "sequential-429-then-two-answers", modes: ["none", "sse"], build: () => new SequentialAgent({ name: "root", subAgents: [
      agent("first", [{ throws: rateLimit() }]), agent("second", [answer("The second agent answered")]), agent("third", [answer("The third agent answered")])] }),
    check: (r) => { expect(errorRows(r.events)).toEqual(["first:429:report"]); expect(authorsInOrder(r.events)).toEqual(["first", "second", "third"]); } },
  // A lone in-band error that ends the run.
  { name: "lone-429", modes: ["none", "sse"], build: () => agent("assistant", [{ throws: rateLimit() }]),
    check: (r) => { expect(errorRows(r.events)).toEqual(["assistant:429:report"]); expect(r.events).toHaveLength(1); expect(r.threw).toBeUndefined(); } },
  // A Workflow node whose in-band error is not recovered: the run throws, and the sidecar records the thrown error
  // (a host feeds it as the host-terminal event).
  { name: "workflow-node-error-unrecovered", modes: ["none", "sse"], build: () => new Workflow({ name: "flow", edges: [["START", agent("assistant", [{ chunks: [block({ usage: BLOCK_USAGE })] }])]] }),
    check: (r) => { expect(errorRows(r.events)[0]).toBe("assistant:SAFETY:report"); expect(r.thrown?.name).toBe("NodeReportedError"); } },
  // A credential pause whose step the aggregator closes with a content-less usage report, so ADK re-runs the model;
  // that later step meets a rate-limit error. SSE only: the default mode has no such report and does not re-run.
  { name: "credential-pause-usage-report-then-429", modes: ["sse"], build: () => agent("assistant", [{ chunks: [functionCall("read_mail", {})] }, { throws: rateLimit() }], { tools: [credentialTool()] }),
    check: (r) => {
      const pause = firstIndex(r.events, isAuthPause), report = firstIndex(r.events, (e) => !hasText(e) && (e.content?.parts ?? []).length === 0 && e.usageMetadata !== undefined && e.errorCode === undefined), error = firstIndex(r.events, (e) => e.errorCode === "429");
      expect(pause).toBeGreaterThanOrEqual(0); expect(report).toBeGreaterThan(pause); expect(error).toBeGreaterThan(report);
    } },
  // A confirmation pause in a non-last sub-agent; the next sub-agent's Interactions-route call ends "failed".
  { name: "confirmation-pause-then-interactions-failed", modes: ["none", "sse"], build: () => new SequentialAgent({ name: "root", subAgents: [
      agent("first", [{ chunks: [functionCall("delete_file", { path: "notes/draft.txt" })] }, answer("Unused")], { tools: [deleteTool()] }),
      new LlmAgent({ name: "second", model: new FailedInteractionGemini("second"), instruction: "Answer the user." })] }),
    check: (r) => { const c = firstIndex(r.events, isConfirmation), e = firstIndex(r.events, (x) => x.errorCode === "INTERNAL"); expect(c).toBeGreaterThanOrEqual(0); expect(e).toBeGreaterThan(c); expect(errorRows(r.events)).toEqual(["second:INTERNAL:report"]); } },
  // The pausing step's tool handling throws (the credential call runs, then a later call's before-tool callback
  // throws), so no pause-end event is emitted; ADK yields the throw in-band as the step's last event and, because
  // the step had tool calls, runs a further model round.
  { name: "credential-step-tool-throw-then-rerun", modes: ["none", "sse"], build: () => agent("assistant", [{ chunks: [functionCalls([["read_mail", {}], ["lookup", { query: "inbox" }]])] }, answer("Please authorize the mail tool")], { tools: [credentialTool(), lookupTool()], beforeToolCallback: failingLookupCallback }),
    check: (r) => { const e = firstIndex(r.events, (x) => x.errorCode !== undefined); expect(errorRows(r.events)).toEqual(["assistant:UNKNOWN_ERROR:report"]); expect(firstIndex(r.events, isAuthPause)).toBe(-1); expect((r.events as Ev[]).slice(e + 1).some(hasText)).toBe(true); } },
  // The pause is signalled (the credential request's function response), then the same step's stream throws a
  // rate-limit error that ADK yields in-band; the step had tool calls, so ADK runs a further model round. SSE only.
  { name: "credential-pause-stream-throw-then-rerun", modes: ["sse"], build: () => agent("assistant", [{ chunks: [functionCall("read_mail", {})], throwAfter: rateLimit() }, answer("Please authorize the mail tool")], { tools: [credentialTool()] }),
    check: (r) => { const p = firstIndex(r.events, isAuthPause), e = firstIndex(r.events, (x) => x.errorCode === "429"); expect(p).toBeGreaterThanOrEqual(0); expect(e).toBeGreaterThan(p); expect((r.events as Ev[]).slice(e + 1).some(hasText)).toBe(true); } },
  // After a signalled pause, an in-band error: the first sub-agent pauses on a credential request, the second meets
  // a rate-limit error.
  { name: "sequential-credential-pause-then-429", modes: ["none", "sse"], build: () => new SequentialAgent({ name: "root", subAgents: [
      agent("first", [{ chunks: [functionCall("read_mail", {})] }, answer("Waiting for authorization")], { tools: [credentialTool()] }),
      agent("second", [{ throws: rateLimit() }])] }),
    check: (r) => { const p = firstIndex(r.events, isAuthPause), e = firstIndex(r.events, (x) => x.errorCode === "429"); expect(p).toBeGreaterThanOrEqual(0); expect(e).toBeGreaterThan(p); expect(errorRows(r.events)).toEqual(["second:429:report"]); } },
  // A request-input call whose pause is not signalled: the same step's tool handling throws before the
  // skip-summarization event, and the model's further round meets a rate-limit error that ends the run.
  { name: "request-input-tool-throw-then-429", modes: ["none", "sse"], build: () => agent("assistant", [{ chunks: [functionCalls([[requestInputTool.name, { message: "Which city?" }], ["lookup", { query: "cities" }]])] }, { throws: rateLimit() }], { tools: [requestInputTool, lookupTool()], beforeToolCallback: failingLookupCallback }),
    check: (r) => { expect(firstIndex(r.events, isSkipSummarization)).toBe(-1); expect(errorRows(r.events)).toEqual(["assistant:UNKNOWN_ERROR:report", "assistant:429:report"]); } },
  // Progressive SSE: the original arrives as partial:true, then the aggregate.
  { name: "block-usage-on-finish", modes: ["progressive"], build: () => agent("assistant", [{ chunks: [block({ usage: BLOCK_USAGE })] }]),
    check: (r) => expect((r.events as Ev[]).filter((e) => e.errorCode !== undefined).map((e) => e.partial)).toEqual([true, false]) },
];

describe.runIf(process.env["GEN_ADK_ERROR"] === "1")("ADK in-band error fixture generation (real @google/adk, scripted Gemini transport)", () => {
  it("writes fixtures/adk-error/*.native.json", async () => {
    const out: Record<string, JsonValue[]> = {};
    const sidecars: Record<string, { thrown: { name: string; message: string } }> = {};
    const summary: string[] = [];
    for (const leg of LEGS) {
      for (const mode of leg.modes) {
        const r = await run(leg.build(), mode);
        leg.check?.(r, mode);
        const file = `${leg.name}.${mode}`;
        out[file] = r.events;
        if (r.thrown) sidecars[file] = { thrown: r.thrown };
        summary.push(`${file}: ${r.events.length} events · errors ${JSON.stringify(errorRows(r.events))}${r.threw ? ` · run threw ${r.threw}` : ""}`);
      }
    }
    mkdirSync(ADK_ERROR_DIR, { recursive: true });
    for (const [name, events] of Object.entries(out)) {
      writeFileSync(join(ADK_ERROR_DIR, `${name}.native.json`), JSON.stringify(events, null, 2) + "\n");
    }
    // A run that threw: the error a host catches from runAsync, to feed as the host-terminal event.
    for (const [name, sidecar] of Object.entries(sidecars)) {
      writeFileSync(join(ADK_ERROR_DIR, `${name}.sidecar.json`), JSON.stringify(sidecar, null, 2) + "\n");
    }
    writeFileSync(join(import.meta.dirname, "..", ".tmp", "adk-error-gen.summary.txt"), summary.join("\n") + "\n");
  }, 120_000);
});
