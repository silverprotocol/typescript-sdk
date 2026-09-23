/**
 * Offline test for the ADK workflow-plane capture agent (workflow.ts).
 *
 * Runs the REAL `@google/adk` Workflow engine and InMemoryRunner end to end,
 * with a stub `BaseLlm` and an in-process `FunctionTool` in place of Gemini and
 * the MCP mock: no key, no network. It pins what the live capture relies on —
 * that this graph stamps all five workflow-plane surfaces (output, route,
 * nodeInfo, isolationScope, object actions.agentState) across the two
 * invocations — so an ADK bump that moves any of them fails here before a
 * capture is spent. It pins the NATIVE stream only: how the facet should map a
 * workflow invocation's turn boundaries is open (spec R&D item 6), so no AgJSON
 * shape is asserted here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BaseLlm, FunctionTool, type LlmRequest, type LlmResponse } from "@google/adk";
import { FinishReason } from "@google/genai";
import { z } from "zod";
import type { JsonValue } from "@silverprotocol/core";
import {
  WORKFLOW_INTERRUPT_ID,
  WORKFLOW_RESUME_TEXT,
  WORKFLOW_ROUTE,
  buildCaptureWorkflow,
  driveCaptureWorkflow,
  runAdkWorkflowCapture,
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

async function capture(): Promise<Obj[]> {
  const workflow = buildCaptureWorkflow({
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

describe("buildCaptureWorkflow + driveCaptureWorkflow — offline, stub model", () => {
  it("stamps all five workflow-plane surfaces across two invocations", async () => {
    const events = await capture();
    const invocations = [...new Set(events.map((e) => e["invocationId"]))];
    expect(invocations).toHaveLength(2);
    const [inv1, inv2] = invocations;

    // nodeInfo.path on every event; outputFor on every event with output.
    for (const e of events) {
      expect(typeof obj(e["nodeInfo"])["path"]).toBe("string");
      if (e["output"] !== undefined) expect(obj(e["nodeInfo"])["outputFor"]).toBeDefined();
    }

    // route: classify's routing event.
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

    // agentState (an OBJECT) only on invocation 1's interrupt events.
    const withState = events.filter((e) => obj(e["actions"])["agentState"] !== undefined);
    expect(withState.length).toBeGreaterThanOrEqual(1);
    for (const e of withState) {
      expect(e["invocationId"]).toBe(inv1);
      expect(isObj(obj(e["actions"])["agentState"])).toBe(true);
      expect(e["longRunningToolIds"]).toEqual([WORKFLOW_INTERRUPT_ID]);
    }
    const ask = withState.find((e) => e["author"] === "approve");
    expect(JSON.stringify(ask?.["content"])).toContain('"name":"adk_request_input"');
    // The workflow's own input record closes invocation 1 (no content).
    expect(events.filter((e) => e["invocationId"] === inv1).at(-1)?.["author"]).toBe(
      "spike_workflow",
    );

    // Invocation 2: the re-run approve node and finalize both emit output.
    const second = events.filter((e) => e["invocationId"] === inv2);
    expect(second.map((e) => [e["author"], e["output"]])).toEqual([
      ["approve", { approved: WORKFLOW_RESUME_TEXT, draft: "Echoed: wf-probe" }],
      [
        "finalize",
        { done: true, result: { approved: WORKFLOW_RESUME_TEXT, draft: "Echoed: wf-probe" } },
      ],
    ]);
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
    const iter = runAdkWorkflowCapture({ prompt: "test", mcpServers: {}, allowedTools: [] });
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(/GOOGLE_API_KEY/);
  });
});
