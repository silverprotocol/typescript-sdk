/**
 * Keyless unit tests for the openai capture agent's handoff knob (sp-probe's
 * nested-turn package ask, 2026-09-24: a live OpenAI handoff cassette gates §10
 * item 22 and the facet's `handoff_occurred` terminal mapping).
 * `CaptureRunInput.handoff` builds a second Agent that the main agent can hand
 * off to. No API key, no network: the builder is pure.
 */
import { describe, expect, it } from "vitest";
// Static on purpose (see run.smoke.test.ts): the vendor SDK's cold load runs at collection.
import { Agent, tool, type MCPServer } from "@openai/agents";
import { openaiHandoffAgent } from "./run.js";

const echo = tool({
  name: "echo",
  description: "Echoes the input.",
  parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
  strict: true,
  execute: async (args: unknown) => JSON.stringify(args),
});

describe("openaiHandoffAgent — the handoff knob", () => {
  it("absent ⇒ undefined (the main agent gets no handoffs: byte-identical to before)", () => {
    expect(openaiHandoffAgent({}, { model: "gpt-6-sol", toolSource: { mcpServers: [] } })).toBeUndefined();
  });

  it("set ⇒ an Agent with the knob's name, instructions and handoffDescription, on the SAME model, model settings and MCP servers", () => {
    const servers: MCPServer[] = [];
    const h = openaiHandoffAgent(
      { handoff: { name: "Echoer", instructions: "Call echo, then answer.", handoffDescription: "Echoes a message." } },
      { model: "gpt-6-sol", modelSettings: { reasoning: { summary: "auto" } }, toolSource: { mcpServers: servers } },
    );
    expect(h).toBeInstanceOf(Agent);
    expect(h?.name).toBe("Echoer");
    expect(h?.instructions).toBe("Call echo, then answer.");
    expect(h?.handoffDescription).toBe("Echoes a message.");
    expect(h?.model).toBe("gpt-6-sol");
    expect(h?.modelSettings).toMatchObject({ reasoning: { summary: "auto" } });
    expect(h?.mcpServers).toBe(servers);
  });

  it("with the approval knob's tool source, the handoff agent carries those same tools", () => {
    const h = openaiHandoffAgent({ handoff: { name: "Echoer", instructions: "x" } }, { model: "gpt-6-sol", toolSource: { tools: [echo] } });
    expect(h?.tools).toEqual([echo]);
    expect(h?.mcpServers).toEqual([]);
  });

  it("a main Agent built with handoffs:[it] can hand off to it (the SDK's own handoff list)", () => {
    const h = openaiHandoffAgent({ handoff: { name: "Echoer", instructions: "x" } }, { model: "gpt-6-sol", toolSource: { mcpServers: [] } });
    if (h === undefined) throw new Error("expected a handoff agent");
    const main = new Agent({ name: "spike", instructions: "hand off", handoffs: [h] });
    expect(main.handoffs).toEqual([h]);
  });
});
