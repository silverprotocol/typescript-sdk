/**
 * live-fold.test.ts — Live tool calls, folded: the REAL `Runner.runLive` and
 * LlmAgent live loop (via the capture agent's `runLiveBargeIn`) with a scripted
 * live connection in place of Gemini Live, its natives pushed into the facet
 * with no host-completion marker and folded by the reference Reducer.
 *
 * The connection yields what ADK's aggregator yields on a model whose name has
 * no "-flash-live": a function call is held until the server's turnComplete,
 * then yielded, followed by a bare `{ turnComplete: true }`
 * (utils/live_connection_utils.js:143-165, :188-208, @google/adk 2.1.0). The
 * receive loop runs the tool and yields its response before it pulls that
 * turnComplete, so the call generation's turnComplete arrives between the
 * function response and the model's reply.
 */
import { describe, expect, it } from "vitest";
import { BaseLlm, FunctionTool, type BaseLlmConnection, type LlmResponse } from "@google/adk";
import { z } from "zod";
import { Reducer, type AgEvent, type JsonValue } from "@silverprotocol/core";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { runLiveBargeIn } from "./live.js";

const text = (t: string) => ({ role: "model", parts: [{ text: t }] });
const call = (id: string) => ({ role: "model", parts: [{ functionCall: { name: "lookup", args: { city: "Seoul" }, id } }] });

/** Replies, in order, to each content the agent sends (the prompt, a barge-in, a function response). */
class ScriptedLive extends BaseLlm {
  constructor(private readonly replies: ReadonlyArray<readonly LlmResponse[]>) {
    super({ model: "live-stub" });
  }
  // eslint-disable-next-line require-yield
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    throw new Error("live only");
  }
  async connect(): Promise<BaseLlmConnection> {
    const out: LlmResponse[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let contents = 0;
    const replies = this.replies;
    return {
      async sendHistory() {},
      async sendRealtime() {},
      async sendContent() {
        out.push(...(replies[contents++] ?? []));
        wake?.();
      },
      async *receive() {
        for (;;) {
          for (let r = out.shift(); r !== undefined; r = out.shift()) yield r;
          if (closed) return;
          await new Promise<void>((res) => {
            wake = res;
          });
        }
      },
      async close() {
        closed = true;
        wake?.();
      },
    };
  }
}

async function foldLive(replies: ReadonlyArray<readonly LlmResponse[]>, bargeIn?: string) {
  let executed = 0;
  const lookup = new FunctionTool({
    name: "lookup",
    description: "Look up the weather for a city.",
    parameters: z.object({ city: z.string() }),
    execute: () => {
      executed++;
      return { weather: "sunny" };
    },
  });
  const natives: JsonValue[] = [];
  for await (const e of runLiveBargeIn({
    model: new ScriptedLive(replies),
    instruction: "Answer with the tool.",
    prompt: "What is the weather in Seoul?",
    ...(bargeIn !== undefined ? { bargeIn } : {}),
    tools: [lookup],
    responseModality: "TEXT",
    capMs: 5000,
    graceMs: 500,
  }))
    natives.push(e);
  const n = createAdkNormalizer({ invokeId: "adk" });
  const pushed: AgEvent[] = natives.flatMap((x) => n.push(x));
  const flushed = n.flush();
  const r = new Reducer();
  for (const e of [...pushed, ...flushed]) r.push(e);
  return { pushed, flushed, reducer: r, executed };
}

const terminals = (events: AgEvent[]) =>
  events.filter((e) => e.type === "turn.done" || e.type === "turn.error" || e.type === "turn.abort");

describe("Live tool calls through runLive, folded with no host-completion marker", () => {
  it("two tool calls in one session: each call generation's turnComplete leaves the turn open, and the reply's closes it once", async () => {
    const { pushed, flushed, reducer, executed } = await foldLive([
      [{ content: call("fc-1") }, { turnComplete: true }],
      [{ content: text("Checking again.") }, { content: call("fc-2") }, { turnComplete: true }],
      [{ content: text("All "), partial: true }, { content: text("All done.") }, { turnComplete: true }],
    ]);
    expect(executed).toBe(2);
    expect(pushed.filter((e) => e.type === "tool.done")).toHaveLength(2);
    expect(terminals([...pushed, ...flushed])).toEqual([expect.objectContaining({ type: "turn.done", outcome: { type: "success" } })]);
    expect(terminals(flushed)).toEqual([]);
    expect(reducer.needsResync).toBe(false);
    expect(reducer.result().turns).toHaveLength(1);
  });

  it("a tool call in the generation after a barge-in: the interrupted generation aborts, and the reply generation's call and reply share its turn", async () => {
    const { pushed, flushed, reducer, executed } = await foldLive(
      [
        [{ content: text("Once upon "), partial: true }],
        [{ interrupted: true }, { turnComplete: true }, { content: call("fc-1") }, { turnComplete: true }],
        [{ content: text("It is "), partial: true }, { content: text("It is noon.") }, { turnComplete: true }],
      ],
      "Stop — what time is it? Use the tool.",
    );
    expect(executed).toBe(1);
    const all = [...pushed, ...flushed];
    expect(terminals(all).map((e) => e.type)).toEqual(["turn.abort", "turn.done"]);
    const toolDone = all.find((e) => e.type === "tool.done");
    expect(toolDone?.turnId).toMatch(/_g1$/);
    expect(terminals(all)[1]?.turnId).toMatch(/_g1$/);
    expect(terminals(flushed)).toEqual([]);
    expect(reducer.needsResync).toBe(false);
    const turns = reducer.result().turns;
    expect(turns.map((t) => t.outcome?.type)).toEqual(["aborted", "success"]);
  });
});
