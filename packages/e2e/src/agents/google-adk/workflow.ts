/**
 * ADK 2.x WORKFLOW-plane capture agent (spec R&D item 6, "node lineage";
 * capture-backlog "ADK workflow plane").
 *
 * WHY A SECOND AGENT: `run.ts` drives a plain `LlmAgent`, and a plain LlmAgent
 * never stamps the 2.0 workflow plane — `Event.output` / `route` / `nodeInfo` /
 * `isolationScope` and the object `actions.agentState`. Every one of them is
 * written by `dist/esm/workflow/*` only (the facet carries all five as
 * provider-raw, google-adk/src/index.ts, synthetic-tested until a capture
 * exists). This agent roots the runner at a `Workflow` so the capture sees the
 * real plane. Receipts, `@google/adk` 2.1.0 `dist/esm/workflow/`:
 *
 *   - `nodeInfo.path` on EVERY node event; `nodeInfo.outputFor` on every event
 *     that carries `output` (node_runner.js:393-416, `enrichEvent`).
 *   - `nodeInfo.messageAsOutput` + `output` on the LlmAgent node's final text
 *     (run_llm_agent_as_node.js:119).
 *   - `isolationScope` on every event of a node configured with one; `true`
 *     derives `${nodePath}@${runId}` (node_runner.js:66, :415).
 *   - `actions.agentState` (object `{input}`) ONLY on an interrupt: an event
 *     with `longRunningToolIds` (node_runner.js:302) and the workflow's own
 *     input record (node_runner.js:387). No interrupt, no agentState — hence the
 *     HITL leg below.
 *   - `route` only from a node that emits one (here: an Event built with
 *     `createEvent({ output, route })`, which FunctionNode emits as-is).
 *
 * THE GRAPH (deterministic except the LLM leg, so the model never decides
 * the topology):
 *
 *   START → classify ─route "tool"────────→ spike (LlmAgent) → approve → finalize
 *                    └─route DEFAULT_ROUTE → finalize
 *
 *   - `classify`: FunctionNode; output = the user prompt, route = "tool". The
 *     DEFAULT_ROUTE edge never fires; it makes the edge conditional, which is
 *     what `route` exists for.
 *   - `spike`: the SAME LlmAgent `run.ts` builds (name, MCP toolsets, steer as
 *     instruction, thinking knob), plus `isolationScope: true`. As a node it
 *     runs single_turn with `includeContents: "none"`
 *     (run_llm_agent_as_node.js:24): the model sees the steer + the node input
 *     (classify's output = the prompt) — the same request an echo scenario
 *     sends, so the scenario's expectTools check holds.
 *   - `approve`: FunctionNode that yields a `RequestInput` (HITL) on first run.
 *     The runner turns it into an `adk_request_input` functionCall with
 *     `longRunningToolIds` + `actions.agentState`, and invocation 1 ENDS there
 *     (paused). `rerunOnResume: true` makes the node re-run on resume and emit
 *     its own output event; without it the resume answer silently becomes the
 *     node output with no event (workflow.js:291).
 *   - `finalize`: FunctionNode returning an OBJECT output (structured, not text).
 *
 * TWO INVOCATIONS, ONE CAPTURE: after invocation 1 pauses, the agent resumes
 * the same session with the plain-text answer {@link WORKFLOW_RESUME_TEXT} (a
 * plain-text turn resolves the single pending interrupt,
 * run_node_as_invocation.js:74). The runner appends that message to the session
 * but does not yield it, so the cassette holds every yielded event of both
 * invocations in order, under two `invocationId`s. The answer is scripted: a
 * capture has no human in the loop.
 *
 * `Workflow` is marked experimental upstream (the SDK logs a WARN at
 * construction); the facet peer range is the pin that decides which shape a
 * re-capture sees.
 */

import {
  DEFAULT_ROUTE,
  FunctionNode,
  InMemoryRunner,
  LlmAgent,
  MCPToolset,
  RequestInput,
  Workflow,
  createEvent,
  type BaseLlm,
  type LlmAgentConfig,
} from "@google/adk";
import type { JsonValue } from "@silverprotocol/core";
import { toJsonValue } from "@silverprotocol/core";
import type { CaptureRunInput } from "../types.js";
import { adkGenerateContentConfig } from "./run.js";

/** The fixed HITL interrupt id — a stable id keeps re-captures diffable. */
export const WORKFLOW_INTERRUPT_ID = "approve-1";
/** The scripted plain-text answer that resumes invocation 2. */
export const WORKFLOW_RESUME_TEXT = "approved";
/** The route key `classify` emits. */
export const WORKFLOW_ROUTE = "tool";

export interface CaptureWorkflowOptions {
  /** A model id, or a `BaseLlm` instance (the offline test's stub). */
  model: string | BaseLlm;
  instruction: string;
  tools: NonNullable<LlmAgentConfig["tools"]>;
  generateContentConfig?: LlmAgentConfig["generateContentConfig"];
}

/** Builds the capture graph (see the header). Pure: no key, no network. */
export function buildCaptureWorkflow(opts: CaptureWorkflowOptions): Workflow {
  const classify = new FunctionNode("classify", (_ctx, input: unknown) =>
    createEvent({ output: typeof input === "string" ? input : null, route: WORKFLOW_ROUTE }),
  );
  const spike = new LlmAgent({
    name: "spike",
    model: opts.model,
    instruction: opts.instruction,
    tools: opts.tools,
    isolationScope: true,
    ...(opts.generateContentConfig !== undefined
      ? { generateContentConfig: opts.generateContentConfig }
      : {}),
  });
  const approve = new FunctionNode(
    "approve",
    async function* (ctx, input: unknown) {
      const answer = ctx.resumeInputs[WORKFLOW_INTERRUPT_ID];
      if (answer === undefined) {
        yield new RequestInput({
          interruptId: WORKFLOW_INTERRUPT_ID,
          message: "Approve the echo result?",
          payload: { draft: input },
        });
        return;
      }
      yield { approved: answer, draft: input };
    },
    { rerunOnResume: true },
  );
  const finalize = new FunctionNode("finalize", (_ctx, input: unknown) => ({
    done: true,
    result: input,
  }));
  return new Workflow({
    name: "spike_workflow",
    edges: [
      ["START", classify, { [WORKFLOW_ROUTE]: spike, [DEFAULT_ROUTE]: finalize }],
      [spike, approve, finalize],
    ],
  });
}

export interface DriveWorkflowOptions {
  prompt: string;
  maxLlmCalls: number;
  abortSignal?: AbortSignal;
}

/**
 * Runs the workflow as two invocations on one session: the prompt (pauses at
 * `approve`), then the scripted resume. Yields every event as a plain
 * `JsonValue` (the same `toJsonValue` boundary as `run.ts`).
 */
export async function* driveCaptureWorkflow(
  workflow: Workflow,
  opts: DriveWorkflowOptions,
): AsyncIterable<JsonValue> {
  const runner = new InMemoryRunner({ agent: workflow });
  const session = await runner.sessionService.createSession({
    appName: runner.appName,
    userId: "user-1",
  });
  for (const text of [opts.prompt, WORKFLOW_RESUME_TEXT]) {
    const stream = runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text }] },
      runConfig: { maxLlmCalls: opts.maxLlmCalls },
      ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
    });
    for await (const event of stream) {
      yield toJsonValue(event);
    }
  }
}

/**
 * The workflow-plane `CaptureRunFn`: same input contract, key gate, MCP wiring
 * and thinking knob as `runAdkCapture`, rooted at {@link buildCaptureWorkflow}.
 */
export async function* runAdkWorkflowCapture(input: CaptureRunInput): AsyncIterable<JsonValue> {
  const apiKey = input.apiKey ?? process.env["GOOGLE_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "GOOGLE_API_KEY is required: set it via CaptureRunInput.apiKey or the GOOGLE_API_KEY environment variable",
    );
  }
  process.env["GOOGLE_API_KEY"] = apiKey;

  const toolsets = Object.values(input.mcpServers).map(
    (cfg) =>
      new MCPToolset({
        type: "StreamableHTTPConnectionParams",
        url: cfg.url,
        transportOptions: {
          requestInit: { headers: { Authorization: `Bearer ${cfg.bearer}` } },
        },
      }),
  );

  try {
    const generateContentConfig = adkGenerateContentConfig(input);
    const workflow = buildCaptureWorkflow({
      model: input.model ?? "gemini-2.5-flash",
      instruction: input.systemPrompt ?? "You are a helpful assistant.",
      tools: toolsets,
      ...(generateContentConfig !== undefined ? { generateContentConfig } : {}),
    });
    yield* driveCaptureWorkflow(workflow, {
      prompt: input.prompt,
      maxLlmCalls: input.maxTurns ?? 8,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });
  } finally {
    await Promise.all(toolsets.map((toolset) => toolset.close()));
  }
}
