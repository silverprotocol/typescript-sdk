/**
 * Pins the ADK value lists scenario.ts writes out (so that module never loads
 * @google/adk at runtime) to the installed @google/adk enums.
 */
import { describe, it, expect } from "vitest";
import { StreamingMode } from "@google/adk";
import { ADK_RUNASYNC_STREAMING_MODES, Scenario } from "./scenario.js";

describe("adkStreamingMode", () => {
  it("lists ADK's StreamingMode values except bidi, which the Live capture owns", () => {
    const all = Object.values(StreamingMode).sort();
    expect([...ADK_RUNASYNC_STREAMING_MODES].every((m) => (all as string[]).includes(m))).toBe(true);
    expect(all.filter((m) => !(ADK_RUNASYNC_STREAMING_MODES as readonly string[]).includes(m))).toEqual([StreamingMode.BIDI]);
  });

  it("accepts none and sse, and rejects bidi and a differently cased value", () => {
    expect(Scenario.parse({ name: "s", prompt: "x", adkStreamingMode: "sse" }).adkStreamingMode).toBe("sse");
    expect(Scenario.parse({ name: "s", prompt: "x", adkStreamingMode: "none" }).adkStreamingMode).toBe("none");
    expect(() => Scenario.parse({ name: "s", prompt: "x", adkStreamingMode: "bidi" })).toThrow();
    expect(() => Scenario.parse({ name: "s", prompt: "x", adkStreamingMode: "SSE" })).toThrow();
  });
});
