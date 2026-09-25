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
import { openaiHandoffAgent, openaiHandoffAgents, openaiMainAgent } from "./run.js";

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

// The parallel-handoff knob (sp-cto's ask on the disclosed residual; sp-probe's
// `openaiHandoffs` → `CaptureRunInput.handoffs`, 3a7557c): several targets, so
// the model can emit two transfer_to_* calls in one response.
describe("openaiHandoffAgents — the handoff list (openaiHandoff or openaiHandoffs)", () => {
  const TWO = [
    { name: "Echoer", instructions: "Call echo, then answer.", handoffDescription: "Echoes a message." },
    { name: "Shouter", instructions: "Call echo in capitals, then answer." },
  ];

  it("neither knob ⇒ undefined", () => {
    expect(openaiHandoffAgents({}, { model: "gpt-6-sol", toolSource: { mcpServers: [] } })).toBeUndefined();
  });

  it("handoffs ⇒ one Agent per target, in knob order, each on the SAME model, model settings and tool source", () => {
    const servers: MCPServer[] = [];
    const agents = openaiHandoffAgents(
      { handoffs: TWO },
      { model: "gpt-6-sol", modelSettings: { reasoning: { summary: "auto" } }, toolSource: { mcpServers: servers } },
    );
    expect(agents?.map((a) => a.name)).toEqual(["Echoer", "Shouter"]);
    expect(agents?.map((a) => a.instructions)).toEqual(["Call echo, then answer.", "Call echo in capitals, then answer."]);
    expect(agents?.[0]?.handoffDescription).toBe("Echoes a message.");
    // An absent handoffDescription stays the SDK's own default.
    expect(agents?.[1]?.handoffDescription).toBe(new Agent({ name: "probe", instructions: "x" }).handoffDescription);
    for (const a of agents ?? []) {
      expect(a).toBeInstanceOf(Agent);
      expect(a.model).toBe("gpt-6-sol");
      expect(a.modelSettings).toMatchObject({ reasoning: { summary: "auto" } });
      expect(a.mcpServers).toBe(servers);
    }
    expect(new Set(agents).size).toBe(2);
  });

  it("handoffs with the approval knob's tool source ⇒ every target carries those same tools", () => {
    const agents = openaiHandoffAgents({ handoffs: TWO }, { model: "gpt-6-sol", toolSource: { tools: [echo] } });
    for (const a of agents ?? []) expect(a.tools).toEqual([echo]);
    expect(agents).toHaveLength(2);
  });

  it("the single handoff knob ⇒ a one-element list, built exactly as openaiHandoffAgent builds it", () => {
    const shared = { model: "gpt-6-sol", modelSettings: { reasoning: { summary: "auto" as const } }, toolSource: { mcpServers: [] } };
    const one = { name: "Echoer", instructions: "x", handoffDescription: "d" };
    const list = openaiHandoffAgents({ handoff: one }, shared);
    const single = openaiHandoffAgent({ handoff: one }, shared);
    expect(list).toHaveLength(1);
    expect(list?.[0]).toEqual(single);
  });

  it("BOTH knobs ⇒ throws, never silently picks one (the scenario schema does not forbid it)", () => {
    expect(() =>
      openaiHandoffAgents({ handoff: TWO[0], handoffs: TWO }, { model: "gpt-6-sol", toolSource: { mcpServers: [] } }),
    ).toThrow(/openaiHandoff OR openaiHandoffs/);
  });
});

describe("openaiMainAgent — the main agent the capture runs", () => {
  it("hands off to EVERY openaiHandoffs target, in knob order, on the capture's model, settings and tool source", () => {
    const servers: MCPServer[] = [];
    const main = openaiMainAgent(
      { systemPrompt: "Route it.", handoffs: [{ name: "Echoer", instructions: "a" }, { name: "Shouter", instructions: "b" }] },
      { model: "gpt-6-sol", modelSettings: { reasoning: { summary: "auto" } }, toolSource: { mcpServers: servers } },
    );
    expect(main.name).toBe("spike");
    expect(main.instructions).toBe("Route it.");
    expect(main.model).toBe("gpt-6-sol");
    expect(main.modelSettings).toMatchObject({ reasoning: { summary: "auto" } });
    expect(main.mcpServers).toBe(servers);
    const targets = main.handoffs.map((h) => (h instanceof Agent ? h : undefined));
    expect(targets.map((h) => h?.name)).toEqual(["Echoer", "Shouter"]);
    for (const h of targets) {
      expect(h?.model).toBe("gpt-6-sol");
      expect(h?.mcpServers).toBe(servers);
    }
  });

  it("the single openaiHandoff knob ⇒ exactly one handoff (handoff-gpt6sol's shape)", () => {
    const main = openaiMainAgent({ handoff: { name: "Echoer", instructions: "a" } }, { model: "gpt-6-sol", toolSource: { mcpServers: [] } });
    expect(main.handoffs.map((h) => (h instanceof Agent ? h.name : undefined))).toEqual(["Echoer"]);
  });

  it("no knob ⇒ the SDK's own empty handoff list, and the default instructions", () => {
    const main = openaiMainAgent({}, { model: "gpt-6-sol", toolSource: { tools: [echo] } });
    expect(main.handoffs).toEqual([]);
    expect(main.instructions).toBe("You are a helpful assistant.");
    expect(main.tools).toEqual([echo]);
  });
});
