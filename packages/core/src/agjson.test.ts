import { describe, it, expect } from "vitest";
import { AgentEvent, AgentBlock } from "./agjson.js";

describe("AgentEvent (CORE)", () => {
  it("parses each CORE event variant", () => {
    const samples = [
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "turn.done", seq: 9, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
      { type: "turn.error", seq: 1, message: "boom" },
      { type: "turn.abort", seq: 1 },
      { type: "error", seq: 1, message: "advisory" },
      { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
      { type: "text.start", seq: 2, id: "m1" },
      { type: "text.delta", seq: 3, id: "m1", delta: "hi" },
      { type: "text.end", seq: 4, id: "m1" },
      { type: "message.end", seq: 5, id: "m1" },
      { type: "content.block", seq: 6, block: { type: "text", text: "x" } },
      { type: "tool.start", seq: 7, toolCallId: "c1", name: "search" },
      { type: "tool.args.delta", seq: 8, toolCallId: "c1", delta: '{"q":' },
      { type: "tool.args.assembled", seq: 9, toolCallId: "c1", input: { q: "ok" } },
      {
        type: "tool.done",
        seq: 10,
        toolCallId: "c1",
        content: [{ type: "text", text: "ok" }],
        outcome: "ok",
      },
    ];
    for (const s of samples) expect(AgentEvent.parse(s).type).toBe(s.type);
  });

  it("rejects an unknown event type", () => {
    expect(() => AgentEvent.parse({ type: "nope", seq: 0 })).toThrow();
  });
});

describe("AgentBlock (CORE subset)", () => {
  it("parses text / image / tool-call / tool-result", () => {
    expect(AgentBlock.parse({ type: "text", text: "x" }).type).toBe("text");
    expect(
      AgentBlock.parse({ type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } }).type,
    ).toBe("image");
    expect(AgentBlock.parse({ type: "tool-call", toolCallId: "c1", name: "n", input: {} }).type).toBe(
      "tool-call",
    );
    expect(
      AgentBlock.parse({ type: "tool-result", toolCallId: "c1", content: [], outcome: "ok" }).type,
    ).toBe("tool-result");
  });

  it("round-trips a nested tool-result (recursive content)", () => {
    const r = AgentBlock.parse({
      type: "tool-result",
      toolCallId: "c1",
      content: [{ type: "text", text: "inner" }],
    });
    expect(r.type).toBe("tool-result");
  });

  it("rejects an unknown block type", () => {
    expect(() => AgentBlock.parse({ type: "reasoning", text: "x" })).toThrow();
  });
});
