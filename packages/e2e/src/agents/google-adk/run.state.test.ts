/**
 * Offline test for the scripted session-state support in the ADK capture agent
 * (run.ts: `adkStateScript`, `onSessionState`).
 *
 * Runs the REAL `@google/adk` LlmAgent and InMemoryRunner end to end with a
 * stub `BaseLlm` that calls `apply_state_step` for step 1, then step 2, then
 * answers. No key, no network. It pins the native stream and ADK's own session
 * state for the script the state-fold seed uses, so an ADK bump that moves
 * either fails here before a capture is spent. It asserts no AgJSON shape:
 * how the fold should treat these writes is the seed's question.
 */
import { describe, expect, it } from "vitest";
import { BaseLlm, InMemoryRunner, LlmAgent, type LlmRequest, type LlmResponse } from "@google/adk";
import { FinishReason } from "@google/genai";
import { toJsonValue, type JsonValue } from "@silverprotocol/core";
import { ADK_OTHER_USER_ID, ADK_STATE_TOOL, adkCrossSessionStates, adkSessionState, adkStateTool, applyAdkStateStep } from "./run.js";

/** The script the seed uses: step 2 REPLACES cfg, and step 1 also writes a
 *  temp: key. */
const SCRIPT: Array<Record<string, JsonValue>> = [{ cfg: { a: 1, b: 2 }, "temp:scratch": "x" }, { cfg: { a: 5 } }];

/** Calls step N+1 once N steps have answered, then gives a final answer. */
class StepLlm extends BaseLlm {
  constructor(private readonly steps: number) {
    super({ model: "stub-model" });
  }
  async *generateContentAsync(req: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const answered = req.contents.flatMap((c) => c.parts ?? []).filter((p) => p.functionResponse).length;
    yield answered < this.steps
      ? {
          content: { role: "model", parts: [{ functionCall: { name: ADK_STATE_TOOL, args: { step: answered + 1 } } }] },
          turnComplete: true,
        }
      : { content: { role: "model", parts: [{ text: "State applied." }] }, turnComplete: true, finishReason: FinishReason.STOP };
  }
  async connect(): Promise<never> {
    throw new Error("StepLlm: no live connection");
  }
}

type Obj = { [k: string]: JsonValue };
const isObj = (v: JsonValue | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: JsonValue | undefined): Obj => (isObj(v) ? v : {});

async function run(script: Array<Record<string, JsonValue>>): Promise<{ natives: Obj[]; state: JsonValue }> {
  const agent = new LlmAgent({ name: "spike", model: new StepLlm(script.length), tools: [adkStateTool(script)] });
  const runner = new InMemoryRunner({ agent });
  const session = await runner.sessionService.createSession({ appName: runner.appName, userId: "user-1" });
  const natives: Obj[] = [];
  for await (const e of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: "Apply the state script." }] },
    runConfig: { maxLlmCalls: 8 },
  })) {
    natives.push(obj(toJsonValue(e)));
  }
  return { natives, state: await adkSessionState(runner, { userId: session.userId, sessionId: session.id }) };
}

describe("ADK capture agent: scripted session state (adkStateScript / onSessionState)", () => {
  it("each step's writes ride its function-response event as actions.stateDelta; the Runner has already dropped the temp: key", async () => {
    const { natives } = await run(SCRIPT);
    const deltas = natives
      .filter((e) => (obj(e["content"])["parts"] as JsonValue[] | undefined)?.some((p) => obj(p)["functionResponse"] !== undefined))
      .map((e) => obj(e["actions"])["stateDelta"]);
    expect(deltas).toEqual([{ cfg: { a: 1, b: 2 } }, { cfg: { a: 5 } }]);
    // Every other event carries an empty delta.
    const nonEmpty = natives.filter((e) => Object.keys(obj(obj(e["actions"])["stateDelta"])).length > 0);
    expect(nonEmpty).toHaveLength(2);
    // No delta on the stream carries a temp: key: the Runner removes it from a
    // non-partial event before yielding (the tool's own answer still lists
    // the keys it wrote).
    for (const e of natives) expect(Object.keys(obj(obj(e["actions"])["stateDelta"])).filter((k) => k.startsWith("temp:"))).toEqual([]);
  });

  it("ADK's own session state is the ground truth: step 2 replaced cfg whole, and no temp: key persists", async () => {
    const { state } = await run(SCRIPT);
    expect(state).toEqual({ cfg: { a: 5 } });
  });

  it("applyAdkStateStep writes one set() per entry, as copies, and answers a missing step with applied: false", () => {
    const writes: [string, unknown][] = [];
    const state = { set: (k: string, v: unknown) => void writes.push([k, v]) };
    expect(applyAdkStateStep(SCRIPT, 1, state)).toEqual({ applied: true, step: 1, keys: ["cfg", "temp:scratch"] });
    expect(writes).toEqual([["cfg", { a: 1, b: 2 }], ["temp:scratch", "x"]]);
    expect(writes[0]![1]).not.toBe(SCRIPT[0]!["cfg"]);
    for (const step of [0, 3, 1.5, -1]) {
      expect(applyAdkStateStep(SCRIPT, step, state)).toEqual({ applied: false, step, keys: [] });
    }
    expect(writes).toHaveLength(2);
  });

  it("the cross-session read: a new session for the same user starts with the user: and app: writes, another user's with the app: write only", async () => {
    const script: Array<Record<string, JsonValue>> = [{ plain: 1, "user:pref": "dark", "app:flag": true, "temp:scratch": "x" }];
    const agent = new LlmAgent({ name: "spike", model: new StepLlm(script.length), tools: [adkStateTool(script)] });
    const runner = new InMemoryRunner({ agent });
    const session = await runner.sessionService.createSession({ appName: runner.appName, userId: "user-1" });
    for await (const _e of runner.runAsync({ userId: "user-1", sessionId: session.id, newMessage: { role: "user", parts: [{ text: "go" }] }, runConfig: { maxLlmCalls: 8 } })) {
      // drain
    }
    expect(await adkSessionState(runner, { userId: "user-1", sessionId: session.id })).toEqual({ plain: 1, "user:pref": "dark", "app:flag": true });
    const states = await adkCrossSessionStates(runner, "user-1");
    expect(states.sameUser).toEqual({ "user:pref": "dark", "app:flag": true });
    expect(states.otherUser).toEqual({ "app:flag": true });
    expect(ADK_OTHER_USER_ID).not.toBe("user-1");
  });

  it("the tool is named by the exported capability proof", () => {
    expect(ADK_STATE_TOOL).toBe("apply_state_step");
    expect(adkStateTool(SCRIPT).name).toBe(ADK_STATE_TOOL);
  });
});
