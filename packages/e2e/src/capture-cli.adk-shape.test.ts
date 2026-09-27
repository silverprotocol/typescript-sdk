/**
 * The adk capture path wires assertAdkShapeHonors: loadFrameworkDeps refuses
 * a scenario whose knob the chosen capture shape would drop, before any API
 * call. The real adk agent modules are imported statically, so the builder's
 * dynamic imports hit the module cache (a cold vendor-SDK import inside a
 * test can outlast the test timeout on a loaded machine).
 */
import { describe, it, expect } from "vitest";
import "./agents/google-adk/run.js";
import "./agents/google-adk/workflow.js";
import "./agents/google-adk/live.js";
import "@silverprotocol/google-adk";
import { loadFrameworkDeps } from "./capture-cli.js";
import { Scenario } from "./scenario.js";

describe("loadFrameworkDeps (adk): knobs the capture shape would drop", () => {
  const safety = [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" }];
  const parse = (extra: Record<string, unknown>) => Scenario.parse({ name: "shape", prompt: "x", ...extra });

  it("refuses adkStreamingMode with adkLive or adkWorkflow, and adkSafetySettings with adkLive", async () => {
    await expect(loadFrameworkDeps("adk", parse({ adkStreamingMode: "sse", adkLive: {} }))).rejects.toThrow(/adkStreamingMode with adkLive/);
    await expect(loadFrameworkDeps("adk", parse({ adkStreamingMode: "sse", adkWorkflow: "pause" }))).rejects.toThrow(/adkStreamingMode with adkWorkflow/);
    await expect(loadFrameworkDeps("adk", parse({ adkSafetySettings: safety, adkLive: {} }))).rejects.toThrow(/adkSafetySettings with adkLive/);
  });

  it("resolves the plain agent for sse with safety settings", async () => {
    const deps = await loadFrameworkDeps("adk", parse({ adkStreamingMode: "sse", adkSafetySettings: safety }));
    expect(typeof deps.runAgentCapture).toBe("function");
  });
});
