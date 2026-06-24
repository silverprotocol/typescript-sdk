import { describe, it, expect } from "vitest";
import { StreamAssembler } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";

describe("@silverprotocol/e2e smoke", () => {
  it("StreamAssembler is a constructor function", () => {
    expect(typeof StreamAssembler).toBe("function");
  });

  it("createClaudeNormalizer is a function", () => {
    expect(typeof createClaudeNormalizer).toBe("function");
  });
});
