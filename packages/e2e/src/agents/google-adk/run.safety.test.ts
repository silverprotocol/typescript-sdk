/**
 * run.safety.test.ts — the `adkSafetySettings` capture knob, offline: the
 * LlmAgent's generateContentConfig carries the scenario's genai safety
 * settings, and the REAL @google/adk runner hands them to the model request
 * (a stub model records what it receives; no key, no network).
 */
import { describe, expect, it } from "vitest";
import { BaseLlm, InMemoryRunner, LlmAgent, type LlmRequest, type LlmResponse } from "@google/adk";
import { HarmBlockThreshold, HarmCategory, ThinkingLevel } from "@google/genai";
import { ADK_SAFETY_SETTINGS, adkGenerateContentConfig } from "./run.js";

const lowHarassment = [{ category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE }] as const;

describe("adkGenerateContentConfig — the adkSafetySettings knob", () => {
  it("no knob set: no config, as before", () => {
    expect(adkGenerateContentConfig({})).toBeUndefined();
    expect(adkGenerateContentConfig({ adkSafetySettings: [] })).toBeUndefined();
  });

  it("the thinking knob alone: the same config as before, no safetySettings key", () => {
    expect(adkGenerateContentConfig({ thinkingLevel: "low" })).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingLevel: ThinkingLevel.LOW },
    });
  });

  it("safety settings ride generateContentConfig.safetySettings, alone or beside the thinking config", () => {
    expect(adkGenerateContentConfig({ adkSafetySettings: lowHarassment })).toEqual({
      safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" }],
    });
    expect(adkGenerateContentConfig({ thinkingLevel: "high", adkSafetySettings: lowHarassment })).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingLevel: ThinkingLevel.HIGH },
      safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" }],
    });
  });

  it("the proof export names the config path the knob drives", () => {
    expect(ADK_SAFETY_SETTINGS).toBe("generateContentConfig.safetySettings");
  });
});

/** Records the request config the runner hands the model, then answers "Done.". */
class RecordingLlm extends BaseLlm {
  readonly seen: Array<LlmRequest["config"]> = [];
  constructor() {
    super({ model: "stub-model" });
  }
  async *generateContentAsync(req: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.seen.push(req.config);
    yield { content: { role: "model", parts: [{ text: "Done." }] }, turnComplete: true };
  }
  async connect(): Promise<never> {
    throw new Error("RecordingLlm: no live connection");
  }
}

describe("the real ADK runner hands the knob's safety settings to the model request", () => {
  it("an LlmAgent built with the knob's config accepts it, and the model request carries the settings", async () => {
    const model = new RecordingLlm();
    const generateContentConfig = adkGenerateContentConfig({ adkSafetySettings: lowHarassment });
    const agent = new LlmAgent({ name: "spike", model, instruction: "Say done.", ...(generateContentConfig !== undefined ? { generateContentConfig } : {}) });
    const runner = new InMemoryRunner({ agent });
    const session = await runner.sessionService.createSession({ appName: runner.appName, userId: "user-1" });
    for await (const _ of runner.runAsync({ userId: "user-1", sessionId: session.id, newMessage: { role: "user", parts: [{ text: "Hi" }] } })) void _;
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0]?.safetySettings).toEqual([{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" }]);
  });
});
