/**
 * extract-tools.test.ts — TDD RED: tests for extractToolCalls.
 *
 * All tests MUST FAIL before extract-tools.ts exists.
 */
import { describe, it, expect } from "vitest";
import type { JsonValue } from "@silverprotocol/core";

// This import WILL fail until extract-tools.ts is created — that's the RED step.
import { extractToolCalls } from "./extract-tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// extractToolCalls
// ─────────────────────────────────────────────────────────────────────────────

describe("extractToolCalls", () => {
  it("returns [] for an empty native stream", () => {
    expect(extractToolCalls([])).toEqual([]);
  });

  it("returns [] for a stream with no assistant messages", () => {
    const native: JsonValue[] = [
      { type: "result", subtype: "success" },
    ];
    expect(extractToolCalls(native)).toEqual([]);
  });

  it("extracts a tool_use block name from an assistant message", () => {
    const native: JsonValue[] = [
      {
        type: "assistant",
        message: {
          id: "msg_001",
          content: [
            {
              type: "tool_use",
              id: "tu_001",
              name: "mcp__t__echo",
              input: { message: "hello" },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ];
    expect(extractToolCalls(native)).toContain("mcp__t__echo");
  });

  it("extracts a server_tool_use block name", () => {
    const native: JsonValue[] = [
      {
        type: "assistant",
        message: {
          id: "msg_002",
          content: [
            {
              type: "server_tool_use",
              id: "stu_001",
              name: "web_search",
              input: { query: "hello" },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ];
    expect(extractToolCalls(native)).toContain("web_search");
  });

  it("extracts an mcp_tool_use block name", () => {
    const native: JsonValue[] = [
      {
        type: "assistant",
        message: {
          id: "msg_003",
          content: [
            {
              type: "mcp_tool_use",
              id: "mtu_001",
              name: "mcp__cards__render_card",
              input: { title: "Test" },
              server_name: "cards",
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ];
    expect(extractToolCalls(native)).toContain("mcp__cards__render_card");
  });

  it("extracts tool names from multiple assistant messages", () => {
    const native: JsonValue[] = [
      {
        type: "assistant",
        message: {
          id: "msg_001",
          content: [
            { type: "tool_use", id: "tu_1", name: "mcp__a__echo", input: {} },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "done" },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_002",
          content: [
            { type: "tool_use", id: "tu_2", name: "mcp__b__render_card", input: {} },
          ],
          usage: { input_tokens: 15, output_tokens: 8 },
        },
      },
    ];
    const calls = extractToolCalls(native);
    expect(calls).toContain("mcp__a__echo");
    expect(calls).toContain("mcp__b__render_card");
  });

  it("extracts multiple tool calls from a single assistant message content array", () => {
    const native: JsonValue[] = [
      {
        type: "assistant",
        message: {
          id: "msg_001",
          content: [
            { type: "text", text: "I'll call both tools." },
            { type: "tool_use", id: "tu_1", name: "mcp__a__echo", input: {} },
            { type: "tool_use", id: "tu_2", name: "mcp__b__fail", input: {} },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ];
    const calls = extractToolCalls(native);
    expect(calls).toContain("mcp__a__echo");
    expect(calls).toContain("mcp__b__fail");
    expect(calls).toHaveLength(2);
  });

  it("ignores text and other non-tool content blocks", () => {
    const native: JsonValue[] = [
      {
        type: "assistant",
        message: {
          id: "msg_001",
          content: [
            { type: "text", text: "Just text, no tools." },
            { type: "mcp_tool_result", tool_use_id: "tu_1", content: "result" },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ];
    expect(extractToolCalls(native)).toEqual([]);
  });

  it("ignores events that are not assistant messages", () => {
    const native: JsonValue[] = [
      // A stray object that looks tool-like but is at the top level, not nested
      { type: "tool_use", name: "should-be-ignored", id: "fake" },
    ];
    expect(extractToolCalls(native)).toEqual([]);
  });

  it("handles messages with no content array gracefully", () => {
    const native: JsonValue[] = [
      { type: "assistant", message: { id: "msg_001", usage: {} } },
    ];
    expect(extractToolCalls(native)).toEqual([]);
  });
});
