/**
 * scenario.test.ts — TDD RED: tests for Scenario schema + derivedTools.
 *
 * All tests MUST FAIL before scenario.ts exists.
 */
import { describe, it, expect } from "vitest";

// These imports WILL fail until scenario.ts is created — that's the RED step.
import { Scenario, derivedTools } from "./scenario.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scenario.parse
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario.parse", () => {
  it("parses a minimal scenario (no mcpServers, no steer)", () => {
    const raw = { name: "text-only", prompt: "Say hello." };
    const s = Scenario.parse(raw);
    expect(s.name).toBe("text-only");
    expect(s.prompt).toBe("Say hello.");
    expect(s.mcpServers).toEqual([]);
    expect(s.steer).toBeUndefined();
  });

  it("parses a scenario with one text server", () => {
    const raw = {
      name: "single-tool-call",
      prompt: "Call the text tool.",
      mcpServers: [{ key: "t", kind: "text" }],
      steer: "You MUST call the tool named mcp__t__echo.",
    };
    const s = Scenario.parse(raw);
    expect(s.mcpServers).toHaveLength(1);
    expect(s.mcpServers[0]).toEqual({ key: "t", kind: "text" });
    expect(s.steer).toBe("You MUST call the tool named mcp__t__echo.");
  });

  it("parses a scenario with app-spec and error servers", () => {
    const raw = {
      name: "multi-server",
      prompt: "Call both tools.",
      mcpServers: [
        { key: "cards", kind: "app-spec" },
        { key: "errsrv", kind: "error" },
      ],
    };
    const s = Scenario.parse(raw);
    expect(s.mcpServers).toHaveLength(2);
    expect(s.mcpServers[0]).toEqual({ key: "cards", kind: "app-spec" });
    expect(s.mcpServers[1]).toEqual({ key: "errsrv", kind: "error" });
  });

  it("rejects an unknown mcpServers kind", () => {
    const raw = {
      name: "bad",
      prompt: "bad",
      mcpServers: [{ key: "x", kind: "unknown-kind" }],
    };
    expect(() => Scenario.parse(raw)).toThrow();
  });

  it("rejects missing name", () => {
    expect(() => Scenario.parse({ prompt: "x" })).toThrow();
  });

  it("rejects missing prompt", () => {
    expect(() => Scenario.parse({ name: "x" })).toThrow();
  });

  it("does NOT have allowedTools or expectTools as schema fields", () => {
    // These must be DERIVED, never authored. The schema must not accept them as fields.
    const raw = {
      name: "derived-check",
      prompt: "test",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      allowedTools: ["some-tool"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expectTools: ["other-tool"],
    };
    // Zod strips unknown keys by default — parse must succeed (no error) but
    // the resulting Scenario type must not carry allowedTools/expectTools.
    const s = Scenario.parse(raw);
    expect("allowedTools" in s).toBe(false);
    expect("expectTools" in s).toBe(false);
  });

  it("parses the optional thinkingLevel knob", () => {
    const s = Scenario.parse({
      name: "thinking-gemini37",
      prompt: "Think, then act.",
      thinkingLevel: "high",
    });
    expect(s.thinkingLevel).toBe("high");
    // Absent by default — a non-thinking cassette stays a non-thinking cassette.
    expect(Scenario.parse({ name: "x", prompt: "y" }).thinkingLevel).toBeUndefined();
  });

  it("rejects thinking levels outside 3.7's low/medium/high set", () => {
    // "minimal" exists in genai's ThinkingLevel enum but gemini-3.7-flash
    // rejects it server-side — the schema refuses it up front.
    expect(() =>
      Scenario.parse({ name: "x", prompt: "y", thinkingLevel: "minimal" }),
    ).toThrow();
    expect(() => Scenario.parse({ name: "x", prompt: "y", thinkingLevel: "HIGH" })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// derivedTools
// ─────────────────────────────────────────────────────────────────────────────

describe("derivedTools", () => {
  it("returns empty allowedTools and expectTools for a scenario with no mcpServers", () => {
    const s = Scenario.parse({ name: "text-only", prompt: "hi" });
    const { allowedTools, expectTools } = derivedTools(s);
    expect(allowedTools).toEqual([]);
    expect(expectTools).toEqual([]);
  });

  it("derives mcp__key__echo for a text server", () => {
    const s = Scenario.parse({
      name: "single-tool-call",
      prompt: "call echo",
      mcpServers: [{ key: "t", kind: "text" }],
    });
    const { allowedTools, expectTools } = derivedTools(s);
    expect(allowedTools).toContain("mcp__t__echo");
    expect(expectTools).toContain("mcp__t__echo");
  });

  it("derives BOTH mcp__key__render_card and mcp__key__update_card for an app-update server (multi-tool kind)", () => {
    const s = Scenario.parse({
      name: "app-update",
      prompt: "p",
      mcpServers: [{ key: "cards", kind: "app-update" }],
    });
    const { allowedTools, expectTools } = derivedTools(s);
    expect(allowedTools).toEqual(["mcp__cards__render_card", "mcp__cards__update_card"]);
    expect(expectTools).toEqual(allowedTools);
    // bare names on the non-claude naming path
    expect(derivedTools(s, "adk").expectTools).toEqual(["render_card", "update_card"]);
  });

  it("derives mcp__key__render_card for an app-spec server", () => {
    const s = Scenario.parse({
      name: "app-spec",
      prompt: "render a card",
      mcpServers: [{ key: "cards", kind: "app-spec" }],
    });
    const { allowedTools, expectTools } = derivedTools(s);
    expect(allowedTools).toContain("mcp__cards__render_card");
    expect(expectTools).toContain("mcp__cards__render_card");
  });

  it("derives mcp__key__fail for an error server", () => {
    const s = Scenario.parse({
      name: "tool-error",
      prompt: "cause an error",
      mcpServers: [{ key: "errsrv", kind: "error" }],
    });
    const { allowedTools, expectTools } = derivedTools(s);
    expect(allowedTools).toContain("mcp__errsrv__fail");
    expect(expectTools).toContain("mcp__errsrv__fail");
  });

  it("★ derived names exactly match knownToolFor output (drift guard)", async () => {
    // This is the CRITICAL drift guard — importing knownToolFor from the same
    // single source of truth ensures mcp__key__<tool> names are never hand-authored.
    const { knownToolFor } = await import("./mcp-mocks/tools.js");

    const s = Scenario.parse({
      name: "multi",
      prompt: "call all",
      mcpServers: [
        { key: "a", kind: "text" },
        { key: "b", kind: "app-spec" },
        { key: "c", kind: "error" },
      ],
    });
    const { allowedTools } = derivedTools(s);

    expect(allowedTools).toContain(`mcp__a__${knownToolFor("text")}`);
    expect(allowedTools).toContain(`mcp__b__${knownToolFor("app-spec")}`);
    expect(allowedTools).toContain(`mcp__c__${knownToolFor("error")}`);
    expect(allowedTools).toHaveLength(3);
  });

  it("allowedTools === expectTools (every declared server's tool must be called)", () => {
    const s = Scenario.parse({
      name: "all-three",
      prompt: "use all tools",
      mcpServers: [
        { key: "a", kind: "text" },
        { key: "b", kind: "app-spec" },
        { key: "c", kind: "error" },
      ],
    });
    const { allowedTools, expectTools } = derivedTools(s);
    expect(allowedTools).toEqual(expectTools);
  });

  // ── framework param (Task 6) ──────────────────────────────────────────────
  //
  // Claude Code's own MCP-tool-naming convention (`mcp__<server>__<tool>`) is
  // an artifact of the Claude Agent SDK's permission-gate string — it is NOT
  // how the openai-agents-sdk / google-adk capture agents register or record
  // tool calls. Ground-truthed against real committed native cassettes:
  // `corpus/text-tool-turn/openai.native.json`'s tool_call_item.rawItem.name
  // and `corpus/text-tool-turn/adk.native.json`'s content.parts[].functionCall.name
  // both carry the BARE tool name ("echo"), never the mcp__key__ prefix.
  it("omitting framework defaults to claude (prefixed names) — backward compatible", () => {
    const s = Scenario.parse({
      name: "single-tool-call",
      prompt: "call echo",
      mcpServers: [{ key: "t", kind: "text" }],
    });
    expect(derivedTools(s)).toEqual(derivedTools(s, "claude"));
  });

  it("framework=openai derives BARE tool names (no mcp__key__ prefix)", () => {
    const s = Scenario.parse({
      name: "single-tool-call",
      prompt: "call echo",
      mcpServers: [{ key: "t", kind: "text" }],
    });
    const { allowedTools, expectTools } = derivedTools(s, "openai");
    expect(allowedTools).toEqual(["echo"]);
    expect(expectTools).toEqual(["echo"]);
  });

  it("framework=adk derives BARE tool names (no mcp__key__ prefix)", () => {
    const s = Scenario.parse({
      name: "single-tool-call",
      prompt: "call echo",
      mcpServers: [{ key: "t", kind: "text" }],
    });
    const { allowedTools, expectTools } = derivedTools(s, "adk");
    expect(allowedTools).toEqual(["echo"]);
    expect(expectTools).toEqual(["echo"]);
  });
});
