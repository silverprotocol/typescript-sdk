/**
 * run.streaming.test.ts — the `adkStreamingMode` capture knob, offline: the
 * runAsync RunConfig carries the scenario's ADK StreamingMode, and the REAL
 * @google/adk runner asks the model to stream exactly when it is SSE (a stub
 * model records the stream flag it receives; no key, no network).
 */
import { describe, expect, it } from "vitest";
import { BaseLlm, InMemoryRunner, LlmAgent, StreamingMode, type LlmRequest, type LlmResponse } from "@google/adk";
import { ADK_STREAMING_MODE, adkRunConfig } from "./run.js";

describe("adkRunConfig — the adkStreamingMode knob", () => {
  it("no knob set: the RunConfig is as before (maxLlmCalls only)", () => {
    expect(adkRunConfig({})).toEqual({ maxLlmCalls: 8 });
    expect(adkRunConfig({ maxTurns: 3 })).toEqual({ maxLlmCalls: 3 });
  });

  it("the knob sets runConfig.streamingMode", () => {
    expect(adkRunConfig({ adkStreamingMode: StreamingMode.SSE })).toEqual({ maxLlmCalls: 8, streamingMode: "sse" });
    expect(adkRunConfig({ adkStreamingMode: StreamingMode.NONE, maxTurns: 2 })).toEqual({ maxLlmCalls: 2, streamingMode: "none" });
  });

  it("the proof export names the config path the knob drives", () => {
    expect(ADK_STREAMING_MODE).toBe("runConfig.streamingMode");
  });
});

/** Records the stream flag the runner passes, then answers "Done.". */
class RecordingLlm extends BaseLlm {
  readonly streams: Array<boolean | undefined> = [];
  constructor() {
    super({ model: "stub-model" });
  }
  async *generateContentAsync(_req: LlmRequest, stream?: boolean): AsyncGenerator<LlmResponse, void> {
    this.streams.push(stream);
    yield { content: { role: "model", parts: [{ text: "Done." }] }, turnComplete: true };
  }
  async connect(): Promise<never> {
    throw new Error("RecordingLlm: no live connection");
  }
}

async function streamFlagFor(runConfig: ReturnType<typeof adkRunConfig>): Promise<Array<boolean | undefined>> {
  const model = new RecordingLlm();
  const runner = new InMemoryRunner({ agent: new LlmAgent({ name: "spike", model, instruction: "Say done." }) });
  const session = await runner.sessionService.createSession({ appName: runner.appName, userId: "user-1" });
  for await (const _ of runner.runAsync({ userId: "user-1", sessionId: session.id, newMessage: { role: "user", parts: [{ text: "Hi" }] }, runConfig })) void _;
  return model.streams;
}

describe("the real ADK runner asks the model to stream exactly under the SSE knob", () => {
  it("SSE: the model is called with stream true; no knob: stream false", async () => {
    expect(await streamFlagFor(adkRunConfig({ adkStreamingMode: StreamingMode.SSE }))).toEqual([true]);
    expect(await streamFlagFor(adkRunConfig({}))).toEqual([false]);
  });
});
