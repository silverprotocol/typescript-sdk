// ADK 2.3.0 client-abort native capture. A scripted stub model (BaseLlm) drives
// a real LlmAgent + InMemoryRunner; the abortSignal fires mid-run and the host
// keeps reading runAsync. Writes every event runAsync yields, verbatim JSON.
import { BaseLlm, LlmAgent, InMemoryRunner, FunctionTool, StreamingMode } from "@google/adk";
import { z } from "zod";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = new URL("./caps/", import.meta.url);

class StubLlm extends BaseLlm {
  constructor(script) { super({ model: "stub-model" }); this.script = script; this.round = 0; }
  async *generateContentAsync(req, stream) { yield* this.script(this.round++, stream); }
  async connect() { throw new Error("no live"); }
}
const usage = { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 };

// Each shape: [name, build(ctl) → {agent, onEvent(ev, ctl)}]
const SHAPES = {
  // (a) text streaming, abort fires after the first text event reaches the host
  "a-text": (ctl) => ({
    agent: new LlmAgent({ name: "helper", instruction: "x", model: new StubLlm(async function* (r, stream) {
      if (stream) {
        yield { content: { role: "model", parts: [{ text: "Hel" }] }, partial: true };
        await sleep(50);
        yield { content: { role: "model", parts: [{ text: "lo" }] }, partial: true };
        await sleep(50);
        yield { content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP", usageMetadata: usage };
      } else {
        await sleep(100);
        yield { content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP", usageMetadata: usage };
      }
    }) }),
    timer: (ctl, mode) => mode === "NONE" ? setTimeout(() => ctl.abort(), 30) : undefined,
    onEvent: (ev, ctl) => { if (ev.content?.parts?.some((p) => p.text) && !ctl.signal.aborted) ctl.abort(); },
  }),
  // (b1) one dangling call: the tool runs until the abort, then returns
  "b-one-call": (ctl) => dangling(ctl, 1),
  // (b2) two dangling calls in one model event (same author/branch/scope)
  "b-two-calls": (ctl) => dangling(ctl, 2),
  // (c) an ask pending: the tool requests confirmation; abort after the ask reaches the host
  "c-ask-pending": (ctl) => ({
    agent: new LlmAgent({ name: "helper", instruction: "x", tools: [new FunctionTool({ name: "transfer", description: "t", parameters: z.object({ amount: z.number() }),
      execute: async (_a, toolContext) => { if (!toolContext.toolConfirmation) { toolContext.requestConfirmation({ hint: "Approve?", payload: { amount: 5 } }); return { status: "pending" }; } return { ok: true }; } })],
      model: new StubLlm(async function* (r) {
        if (r === 0) yield { content: { role: "model", parts: [{ functionCall: { id: "call-ask", name: "transfer", args: { amount: 5 } } }] }, finishReason: "STOP", usageMetadata: usage };
        else { await sleep(100); yield { content: { role: "model", parts: [{ text: "Waiting for approval." }] }, finishReason: "STOP", usageMetadata: usage }; }
      }) }),
    onEvent: (ev, ctl) => { if (ev.content?.parts?.some((p) => p.functionCall?.name === "adk_request_confirmation") && !ctl.signal.aborted) ctl.abort(); },
  }),
  // (c-control) the same paused run with no abort: the natives a pause yields
  "c-control": (ctl) => askShape(ctl, () => false),
  // (c-after-pause) abort when the pause-end event (requestedToolConfirmations) reaches the host
  "c-after-pause": (ctl) => askShape(ctl, (ev) => Object.keys(ev.actions?.requestedToolConfirmations ?? {}).length > 0),
};
function askShape(ctl, when) {
  const s = SHAPES["c-ask-pending"](ctl);
  return { agent: s.agent, onEvent: (ev, c) => { if (when(ev) && !c.signal.aborted) c.abort(); } };
}
function dangling(ctl, n) {
  return {
    agent: new LlmAgent({ name: "helper", instruction: "x", tools: [new FunctionTool({ name: "lookup", description: "l", parameters: z.object({ q: z.string() }),
      execute: async () => { while (!ctl.signal.aborted) await sleep(10); return { ok: true }; } })],
      model: new StubLlm(async function* (r) {
        if (r === 0) yield { content: { role: "model", parts: Array.from({ length: n }, (_, i) => ({ functionCall: { id: `call-${i + 1}`, name: "lookup", args: { q: `x${i}` } } })) }, finishReason: "STOP", usageMetadata: usage };
        else yield { content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP", usageMetadata: usage };
      }) }),
    onEvent: (ev, ctl) => { if (ev.content?.parts?.some((p) => p.functionCall) && !ctl.signal.aborted) setTimeout(() => ctl.abort(), 30); },
  };
}

for (const [name, build] of Object.entries(SHAPES)) {
  for (const mode of ["NONE", "SSE"]) {
    for (const inst of [1, 2]) {
      const ctl = new AbortController();
      const { agent, onEvent, timer } = build(ctl);
      const runner = new InMemoryRunner({ agent, appName: "abortcap" });
      const session = await runner.sessionService.createSession({ appName: "abortcap", userId: "u" });
      if (timer) timer(ctl, mode);
      const events = [];
      let error = null;
      try {
        for await (const ev of runner.runAsync({ userId: "u", sessionId: session.id, newMessage: { role: "user", parts: [{ text: "go" }] }, runConfig: { streamingMode: StreamingMode[mode] }, abortSignal: ctl.signal })) {
          events.push(JSON.parse(JSON.stringify(ev)));
          onEvent(ev, ctl);
        }
      } catch (e) { error = String(e?.name ?? e); }
      const stored = (await runner.sessionService.getSession({ appName: "abortcap", userId: "u", sessionId: session.id })).events.map((e) => JSON.parse(JSON.stringify(e)));
      const file = `${name}.${mode}.${inst}.json`;
      fs.writeFileSync(new URL(file, OUT), JSON.stringify({ shape: name, streamingMode: mode, instance: inst, adk: "2.3.0", aborted: ctl.signal.aborted, error, yielded: events, sessionEvents: stored }, null, 2) + "\n");
      console.log(file, "yielded", events.length, "abortEvents", events.filter((e) => e.errorCode === "INVOCATION_ABORTED").length, "stored", stored.length, error ?? "");
    }
  }
}
