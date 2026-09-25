/**
 * live.test.ts — the Live barge-in capture agent, offline: the real
 * `Runner.runLive` and LlmAgent live loop, with a scripted live connection in
 * place of Gemini Live (no key, no network). The stub reacts to what the agent
 * sends: the prompt starts a first turn; the barge-in either interrupts it, or
 * arrives after it finished, or is never answered.
 */
import { describe, expect, it } from "vitest";
import { BaseLlm, type BaseLlmConnection, type LlmResponse } from "@google/adk";
import type { JsonValue } from "@silverprotocol/core";
import { runLiveBargeIn } from "./live.js";

type Behaviour = "interrupts" | "finishes-first" | "never-completes" | "interrupts-twice";
const text = (t: string) => ({ role: "model", parts: [{ text: t }] });

class ScriptedLive extends BaseLlm {
  readonly log: string[] = [];
  constructor(private readonly behaviour: Behaviour) {
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
    const log = this.log;
    const behaviour = this.behaviour;
    const push = (...rs: LlmResponse[]) => {
      out.push(...rs);
      wake?.();
    };
    return {
      async sendHistory() {},
      async sendRealtime() {},
      async sendContent(content) {
        contents++;
        log.push(`recv:${content.parts?.[0]?.text ?? ""}`);
        if (contents === 1) push({ content: text("Once upon "), partial: true });
        else if (contents === 2 && behaviour === "interrupts")
          push({ interrupted: true }, { content: text("Sure."), partial: true }, { content: text("Sure.") }, { turnComplete: true });
        else if (contents === 2 && behaviour === "interrupts-twice")
          // The first generation keeps talking briefly before the interrupt lands.
          push({ content: text("a time "), partial: true }, { interrupted: true }, { turnComplete: true }, { content: text("Well, "), partial: true });
        else if (contents === 3 && behaviour === "interrupts-twice")
          push({ interrupted: true }, { turnComplete: true }, { content: text("Noon."), partial: true }, { content: text("Noon.") }, { turnComplete: true });
        else if (contents === 2 && behaviour === "finishes-first")
          push({ content: text("Once upon a time.") }, { turnComplete: true }, { content: text("Sure."), partial: true }, { content: text("Sure.") }, { turnComplete: true });
      },
      async *receive() {
        for (;;) {
          for (let r = out.shift(); r !== undefined; r = out.shift()) {
            log.push(r.interrupted === true ? "emit:interrupted" : r.turnComplete === true ? "emit:turnComplete" : `emit:${r.partial === true ? "partial" : "final"}`);
            yield r;
          }
          if (closed) return;
          await new Promise<void>((res) => {
            wake = res;
          });
        }
      },
      async close() {
        closed = true;
        log.push("close");
        wake?.();
      },
    };
  }
}

async function drive(behaviour: Behaviour, capMs: number, bargeIn: string | readonly string[] = "Stop — what time is it?") {
  const model = new ScriptedLive(behaviour);
  const events: JsonValue[] = [];
  const started = Date.now();
  for await (const e of runLiveBargeIn({ model, instruction: "Tell a story.", prompt: "Tell me a long story.", bargeIn, responseModality: "TEXT", capMs, graceMs: 500 }))
    events.push(e);
  return { events, log: model.log, elapsed: Date.now() - started };
}
const has = (events: JsonValue[], key: string) => events.some((e) => e !== null && typeof e === "object" && !Array.isArray(e) && e[key] === true);

describe("runLiveBargeIn — the Live barge-in capture, offline (real runLive, scripted live connection)", () => {
  it("sends the barge-in once, at the first model partial, and closes when the barge-in's reply completes after the interrupt", async () => {
    const { events, log, elapsed } = await drive("interrupts", 5000);
    expect(log.slice(0, 3)).toEqual(["recv:Tell me a long story.", "emit:partial", "recv:Stop — what time is it?"]);
    expect(log.filter((l) => l.startsWith("recv:"))).toHaveLength(2);
    expect(has(events, "interrupted")).toBe(true);
    expect(has(events, "turnComplete")).toBe(true);
    expect(log.indexOf("close")).toBeGreaterThan(log.lastIndexOf("emit:turnComplete"));
    expect(elapsed).toBeLessThan(4000);
  });

  it("with no interrupt (the first turn finished on its own), closes at the SECOND turnComplete after the barge-in", async () => {
    const { events, log, elapsed } = await drive("finishes-first", 5000);
    expect(has(events, "interrupted")).toBe(false);
    const completes = log.map((l, i) => (l === "emit:turnComplete" ? i : -1)).filter((i) => i >= 0);
    expect(completes).toHaveLength(2);
    expect(log.indexOf("close")).toBeGreaterThan(completes[1]!);
    expect(elapsed).toBeLessThan(4000);
  });

  it("two barge-ins: the second goes out at the first output of the generation after the first one's turnComplete, and the queue closes when the last reply completes", async () => {
    const { log, elapsed } = await drive("interrupts-twice", 5000, ["Stop — what time is it?", "And the date?"]);
    expect(log.filter((l) => l.startsWith("recv:"))).toEqual(["recv:Tell me a long story.", "recv:Stop — what time is it?", "recv:And the date?"]);
    const second = log.indexOf("recv:And the date?");
    const firstComplete = log.indexOf("emit:turnComplete");
    expect(firstComplete).toBeGreaterThan(log.indexOf("recv:Stop — what time is it?"));
    expect(second).toBeGreaterThan(firstComplete);
    expect(log[second - 1]).toBe("emit:partial");
    expect(log.indexOf("close")).toBeGreaterThan(log.lastIndexOf("emit:turnComplete"));
    expect(elapsed).toBeLessThan(4000);
  });

  it("a single barge-in given as a one-item list behaves exactly like the string", async () => {
    const asString = await drive("interrupts", 5000, "Stop — what time is it?");
    const asList = await drive("interrupts", 5000, ["Stop — what time is it?"]);
    expect(JSON.stringify(asList.log)).toBe(JSON.stringify(asString.log));
    const strip = (es: JsonValue[]) => JSON.stringify(es, (k, v) => (k === "id" || k === "timestamp" || k === "invocationId" ? undefined : v));
    expect(strip(asList.events)).toBe(strip(asString.events));
  });

  it("a reply that never completes: the cap closes the queue and the stream ends", async () => {
    const { events, log, elapsed } = await drive("never-completes", 300);
    expect(events.length).toBeGreaterThan(0);
    expect(log).toContain("close");
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(3000);
  });
});
