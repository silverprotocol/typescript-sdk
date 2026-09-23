/**
 * Offline test for the ADK workflow-plane capture agent (workflow.ts).
 *
 * Runs the REAL `@google/adk` Workflow engine and InMemoryRunner end to end,
 * with a stub `BaseLlm` and an in-process `FunctionTool` in place of Gemini and
 * the MCP mock: no key, no network. It pins what each single-invoke capture
 * shape relies on, so an ADK bump that moves any surface fails here before a
 * capture is spent. It pins the NATIVE stream only: how the facet should map a
 * workflow invoke's turn boundaries is open (spec R&D item 6), so no AgJSON
 * shape is asserted here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BaseLlm, FunctionTool, type LlmRequest, type LlmResponse } from "@google/adk";
import { FinishReason } from "@google/genai";
import { z } from "zod";
import type { JsonValue } from "@silverprotocol/core";
import {
  WORKFLOW_INTERRUPT_ID,
  WORKFLOW_ROUTE,
  buildCaptureWorkflow,
  driveCaptureWorkflow,
  runAdkWorkflowCapture,
  type WorkflowShape,
} from "./workflow.js";

/** First call: a functionCall to `echo`. Once a functionResponse is in the
 *  request: final text. The same two-call shape an echo scenario produces. */
class StubLlm extends BaseLlm {
  constructor() {
    super({ model: "stub-model" });
  }
  async *generateContentAsync(req: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const answered = req.contents.some((c) => (c.parts ?? []).some((p) => p.functionResponse));
    yield answered
      ? {
          content: { role: "model", parts: [{ text: "Echoed: wf-probe" }] },
          turnComplete: true,
          finishReason: FinishReason.STOP,
        }
      : {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "echo", args: { message: "wf-probe" } } }],
          },
          turnComplete: true,
        };
  }
  async connect(): Promise<never> {
    throw new Error("StubLlm: no live connection");
  }
}

const echo = new FunctionTool({
  name: "echo",
  description: "Echo the message back.",
  parameters: z.object({ message: z.string() }),
  execute: async ({ message }) => ({ echoed: message }),
});

type Obj = { [k: string]: JsonValue };
const isObj = (v: JsonValue | undefined): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: JsonValue | undefined): Obj => (isObj(v) ? v : {});

async function capture(shape: WorkflowShape): Promise<Obj[]> {
  const workflow = buildCaptureWorkflow({
    shape,
    model: new StubLlm(),
    instruction: "You MUST call the echo tool with message='wf-probe'.",
    tools: [echo],
  });
  const out: Obj[] = [];
  for await (const e of driveCaptureWorkflow(workflow, { prompt: "Echo wf-probe", maxLlmCalls: 8 })) {
    out.push(obj(e));
  }
  return out;
}

/** The four surfaces both shapes share. */
function expectSharedPlane(events: Obj[]): void {
  // One capture = one invoke (SPEC §8.0 Lifetime).
  expect(new Set(events.map((e) => e["invocationId"])).size).toBe(1);

  // nodeInfo.path on every event; outputFor on every event with output.
  for (const e of events) {
    expect(typeof obj(e["nodeInfo"])["path"]).toBe("string");
    if (e["output"] !== undefined) expect(obj(e["nodeInfo"])["outputFor"]).toBeDefined();
  }

  // route: classify's routing event, and only that one.
  const routed = events.filter((e) => e["route"] !== undefined);
  expect(routed.map((e) => [e["author"], e["route"]])).toEqual([["classify", WORKFLOW_ROUTE]]);

  // isolationScope: every event of the LlmAgent node, and only those.
  const spike = events.filter((e) => e["author"] === "spike");
  expect(spike.length).toBeGreaterThanOrEqual(3); // call, response, final text
  for (const e of events) {
    expect(e["isolationScope"] !== undefined).toBe(e["author"] === "spike");
  }
  expect(spike[0]?.["isolationScope"]).toMatch(/^spike_workflow\.spike@/);

  // messageAsOutput + output on the LlmAgent's final text.
  const final = spike.find((e) => obj(e["nodeInfo"])["messageAsOutput"] === true);
  expect(final?.["output"]).toBe("Echoed: wf-probe");
}

describe("workflow capture shapes — offline, stub model, real engine", () => {
  it("pause: one invoke carrying all five surfaces, ending on the workflow's input record", async () => {
    const events = await capture("pause");
    expectSharedPlane(events);

    // agentState (an OBJECT) only on the interrupt events.
    const withState = events.filter((e) => obj(e["actions"])["agentState"] !== undefined);
    expect(withState.map((e) => e["author"])).toEqual(["approve", "spike_workflow"]);
    for (const e of withState) {
      expect(isObj(obj(e["actions"])["agentState"])).toBe(true);
      expect(e["longRunningToolIds"]).toEqual([WORKFLOW_INTERRUPT_ID]);
    }
    expect(JSON.stringify(withState[0]?.["content"])).toContain('"name":"adk_request_input"');

    // The invoke ends on the workflow's own content-less input record;
    // finalize never runs.
    const last = events.at(-1);
    expect(last?.["author"]).toBe("spike_workflow");
    expect(last?.["content"]).toBeUndefined();
    expect(events.some((e) => e["author"] === "finalize")).toBe(false);
  }, 60_000);

  it("complete: one invoke that ends on finalize's output with no end marker (adk-js 2.1.0)", async () => {
    const events = await capture("complete");
    expectSharedPlane(events);

    // No interrupt, so no agentState.
    expect(events.some((e) => obj(e["actions"])["agentState"] !== undefined)).toBe(false);

    const last = events.at(-1);
    expect(last?.["author"]).toBe("finalize");
    expect(last?.["output"]).toEqual({ done: true, result: "Echoed: wf-probe" });
    // TRIPWIRE for upstream-issue-draft-end-of-agent.md: adk-python marks a
    // clean finish (terminal outputFor names the workflow; end_of_agent when
    // resumable). If either assertion fails after a bump, adk-js ported it and
    // the facet's workflow turn-close mapping (spec R&D item 6) can use it.
    expect(obj(last?.["nodeInfo"])["outputFor"]).toEqual(["spike_workflow.finalize"]);
    expect(events.some((e) => obj(e["actions"])["endOfAgent"] !== undefined)).toBe(false);
  }, 60_000);
});

describe("runAdkWorkflowCapture — OPERATOR-GATED key check (mirrors run.smoke.test.ts)", () => {
  const original = process.env["GOOGLE_API_KEY"];
  afterEach(() => {
    if (original === undefined) delete process.env["GOOGLE_API_KEY"];
    else process.env["GOOGLE_API_KEY"] = original;
  });

  it("is lazy: no work and no key check until iterated", () => {
    delete process.env["GOOGLE_API_KEY"];
    const iter = runAdkWorkflowCapture({ prompt: "test", mcpServers: {}, allowedTools: [] });
    expect(typeof iter[Symbol.asyncIterator]).toBe("function");
  });

  it("throws a clear error on first iteration when no key is available", async () => {
    delete process.env["GOOGLE_API_KEY"];
    const iter = runAdkWorkflowCapture({ prompt: "test", mcpServers: {}, allowedTools: [] }, "complete");
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(/GOOGLE_API_KEY/);
  });
});
