/**
 * The engine behind fixtures/adk-oracle: real @google/adk 2.x runners (the version packages/e2e pins) over scripted
 * transports, with the text each model call was meant to produce recorded at the transport. No key, no network.
 *
 *  - Gemini: ADK's Gemini class with its genai client scripted. Each call is numbered; its chunks carry the number,
 *    and ADK's SSE aggregator (patched here to copy it) tags what it yields with it, so every native maps to the call
 *    that produced it. The tags are stripped before a native is written, and a surviving tag is an error.
 *  - Chrome: ADK's ChromeBuiltInLlm over a scripted Prompt API (a ReadableStream of pieces).
 *  - Live: ADK's Gemini class over a scripted Live socket; the real GeminiLlmConnection, LiveResponseAggregator and
 *    the runLiveFlow reconnect run.
 *
 * A streamed call's units are the chunks its transport actually yielded (a sibling's failure can abort it).
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as adk from "@google/adk";
import { GenerateContentResponse } from "@google/genai";

/* The engine drives framework internals by shape. */
type Any = any;

export type Chunk = Record<string, unknown>;
export type ChunkEntry = Chunk | { c: Chunk; d?: number };
export type Script = ChunkEntry[] | { chunks?: ChunkEntry[]; delay?: number; gap?: number; tail?: number; throwAfter?: string; throws?: string };
export type CallLog = {
  call: number;
  agent: string;
  mode: "sse" | "none" | "chrome" | "live";
  segments: string[];
  threw: boolean;
  yielded?: Chunk[];
  planned?: string[];
  cut?: boolean;
  connection?: number;
};
export type Captured = { natives: Record<string, unknown>[]; thrown: { name: string; message: string } | null; calls: CallLog[]; stripped: (number | null)[]; served: string[] };

export const state: { tag: boolean; calls: CallLog[]; stripped: (number | null)[]; served: string[] } = { tag: true, calls: [], stripped: [], served: [] };

// ADK's SSE aggregator: copy a chunk's call number onto what it yields (customMetadata.__oracle_call).
const req = createRequire(import.meta.url);
const esmRoot = dirname(req.resolve("@google/adk").replace(/dist\/cjs\/index\.(c?js)$/, "dist/esm/index.js"));
const streaming: Any = await import(pathToFileURL(join(esmRoot, "utils", "streaming_utils.js")).href);
// @google/adk 2.3.0 renamed the class GeminiStreamingResponseAggregator (same processResponse/close shape).
const SRAClass: Any = streaming.GeminiStreamingResponseAggregator ?? streaming.StreamingResponseAggregator;
if (typeof SRAClass !== "function") throw new Error(`adk-oracle: no SSE aggregator class in ${Object.keys(streaming).join(", ")}`);
const SRA: Any = SRAClass.prototype;
const TAG = "__oracle_call";
const CREATED = "__oracle_cm_created";
const tagOut = (r: Any, k: number | undefined): Any => {
  if (!state.tag || k === undefined || !r) return r;
  const created = r.customMetadata === undefined;
  r.customMetadata = { ...(r.customMetadata ?? {}), [TAG]: k, ...(created ? { [CREATED]: true } : {}) };
  return r;
};
if (!SRA.__oraclePatched) {
  const process0 = SRA.processResponse;
  SRA.processResponse = async function* (this: Any, response: Any) {
    if (response && response.__oracleCall !== undefined) this.__oracleCall = response.__oracleCall;
    for await (const r of process0.call(this, response)) yield tagOut(r, this.__oracleCall);
  };
  const close0 = SRA.close;
  SRA.close = function (this: Any) { return tagOut(close0.call(this), this.__oracleCall); };
  SRA.__oraclePatched = true;
}

const unwrap = (x: ChunkEntry): { c: Chunk; d?: number } => ("c" in x && !("candidates" in x) && !("usageMetadata" in x) ? (x as { c: Chunk; d?: number }) : { c: x as Chunk });
const asError = (v: unknown): unknown => (typeof v === "string" ? new Error(v) : v);
const sleep = (ms?: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const chunk = (v: Chunk, k?: number): Any => {
  const c = Object.assign(new GenerateContentResponse(), v);
  if (k !== undefined) Object.defineProperty(c, "__oracleCall", { value: k, enumerable: false });
  return c;
};

// Chunk builders.
export const T = (t: string): Chunk => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
export const FC = (name: string, args: Record<string, unknown> = {}, id?: string): Chunk => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args, ...(id ? { id } : {}) } }] } }] });
export const TFC = (t: string, name: string, args: Record<string, unknown> = {}): Chunk => ({ candidates: [{ content: { role: "model", parts: [{ text: t }, { functionCall: { name, args } }] } }] });
export const STOP = (t: string, usage?: Chunk): Chunk => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] }, finishReason: "STOP" }], ...(usage ? { usageMetadata: usage } : {}) });
export const END = (usage?: Chunk): Chunk => ({ candidates: [{ finishReason: "STOP" }], ...(usage ? { usageMetadata: usage } : {}) });
export const BLOCK = ({ reason = "SAFETY", message, usage }: { reason?: string; message?: string; usage?: Chunk } = {}): Chunk => ({ candidates: [{ finishReason: reason, ...(message ? { finishMessage: message } : {}) }], ...(usage ? { usageMetadata: usage } : {}) });
export const USAGE = (usage: Chunk): Chunk => ({ usageMetadata: usage });
export const U = (n = 15): Chunk => ({ promptTokenCount: n - 5, candidatesTokenCount: 5, totalTokenCount: n });

/** A call's intended text units: its text parts in order, split at each function call (thoughts excluded). */
export function segmentsOf(entries: ChunkEntry[]): string[] {
  const segs: string[] = [];
  let cur = "";
  for (const s of entries.map((x) => unwrap(x).c) as Any[]) {
    for (const p of s?.candidates?.[0]?.content?.parts ?? []) {
      if (p.functionCall) { if (cur) segs.push(cur); cur = ""; }
      else if (typeof p.text === "string" && !p.thought) cur += p.text;
    }
  }
  if (cur) segs.push(cur);
  return segs;
}
function merged(entries: ChunkEntry[]): Chunk {
  const parts: Any[] = [];
  const cand: Any = {};
  const top: Any = {};
  for (const s of entries.map((x) => unwrap(x).c) as Any[]) {
    if (s.usageMetadata) top.usageMetadata = s.usageMetadata;
    const k = s.candidates?.[0];
    if (!k) continue;
    for (const p of k.content?.parts ?? []) {
      const last = parts[parts.length - 1];
      if (typeof p.text === "string" && !p.thought && typeof last?.text === "string" && !last.thought) last.text += p.text;
      else parts.push({ ...p });
    }
    for (const f of ["finishReason", "finishMessage"]) if (k[f] !== undefined) cand[f] = k[f];
  }
  const blocked = typeof cand.finishReason === "string" && !["STOP", "MAX_TOKENS"].includes(cand.finishReason);
  return { candidates: [{ ...(parts.length && !blocked ? { content: { role: "model", parts } } : {}), ...cand }], ...top };
}

/** ADK's Gemini class with its transport scripted; strict: an exhausted script throws "no script left". */
export class ScriptedGemini extends adk.Gemini {
  constructor(name: string, script: Script[], { strict = false, model }: { strict?: boolean; model?: string } = {}) {
    super({ model: model ?? `gemini-stub-${name}`, apiKey: "stub-not-a-key" });
    let n = 0;
    const next = (mode: "sse" | "none") => {
      const i = n++;
      const e: Script = strict ? (i < script.length ? script[i]! : { throws: `no script left for ${name}` }) : script[Math.min(i, script.length - 1)]!;
      const spec = Array.isArray(e) ? { chunks: e } : { chunks: [] as ChunkEntry[], ...e };
      const log: CallLog = { call: state.calls.length, agent: name, mode, segments: spec.throws ? [] : segmentsOf(spec.chunks), threw: !!spec.throws, ...(mode === "sse" ? { yielded: [] } : {}) };
      state.calls.push(log);
      return { spec, log };
    };
    (this as Any)._apiClient = { models: {
      generateContentStream: async () => {
        const { spec, log } = next("sse");
        await sleep(spec.delay);
        if (spec.throws) throw asError(spec.throws);
        return (async function* () {
          for (let i = 0; i < spec.chunks.length; i++) {
            const { c, d } = unwrap(spec.chunks[i]!);
            if (i) await sleep(spec.gap);
            await sleep(d);
            log.yielded!.push(c);
            yield chunk(structuredClone(c), log.call);
          }
          await sleep(spec.tail);
          if (spec.throwAfter) throw asError(spec.throwAfter);
        })();
      },
      generateContent: async () => {
        const { spec } = next("none");
        await sleep(spec.delay);
        if (spec.throws) throw asError(spec.throws);
        return chunk(merged(structuredClone(spec.chunks)));
      },
    } };
  }
}

/** ADK's ChromeBuiltInLlm over a scripted Prompt API: each prompt streams the next entry's pieces. */
export function chromeModel(name: string, script: string[][], { strict = false }: { strict?: boolean } = {}): adk.BaseLlm {
  let n = 0;
  const nextEntry = () => {
    const i = n++;
    if (strict && i >= script.length) throw new Error(`no script left for ${name}`);
    const e = script[Math.min(i, script.length - 1)]!;
    state.calls.push({ call: state.calls.length, agent: name, mode: "chrome", segments: [e.join("")].filter(Boolean), threw: false });
    return e;
  };
  const session: Any = {
    clone: () => session, destroy() {}, addEventListener() {},
    prompt: async () => nextEntry().join(""),
    promptStreaming: () => { const pieces = nextEntry(); let i = 0; return new ReadableStream({ pull(c) { if (i < pieces.length) c.enqueue(pieces[i++]); else c.close(); } }); },
  };
  return new (adk as Any).ChromeBuiltInLlm({ languageModel: { availability: async () => "available", create: async () => session } });
}

/** ADK's Gemini class over a scripted Live socket: scripts[0] fires on the first client send, scripts[k>0] on the
 *  k-th (re)connect. Each connection is one logged call; its units are its modelTurn texts, one per turn. */
export function liveModel(name: string, scripts: Chunk[][], { model = "gemini-live-2.5-flash-preview" } = {}): adk.BaseLlm {
  const g: Any = new adk.Gemini({ model, apiKey: "stub-not-a-key" });
  let n = 0;
  g._liveApiClient = { live: { connect: async ({ callbacks }: Any) => {
    const k = n++;
    const script = scripts[k] ?? [];
    const segs: string[] = [];
    let cur = "";
    for (const m of script as Any[]) {
      for (const p of m.serverContent?.modelTurn?.parts ?? []) if (typeof p.text === "string" && !p.thought) cur += p.text;
      if (m.serverContent?.turnComplete && cur) { segs.push(cur); cur = ""; }
    }
    if (cur) segs.push(cur);
    state.calls.push({ call: state.calls.length, agent: name, mode: "live", connection: k, segments: segs, threw: false });
    let sent = false;
    const fire = () => { if (sent) return; sent = true; setTimeout(() => { for (const m of script) callbacks.onmessage(structuredClone(m)); }, 5); };
    if (k > 0) fire();
    return { sendClientContent: fire, sendRealtimeInput: fire, sendToolResponse: () => {}, close: () => callbacks.onclose() };
  } } };
  return g;
}

/** JSON form of an event, as a host serializes it; only a true cycle (an object inside itself) becomes "[Circular]" —
 *  a reference shared by two members is written out twice, as JSON.stringify would. */
const plain = (v: unknown): Record<string, unknown> => {
  const walk = (x: Any, ancestors: Set<object>): Any => {
    if (x && typeof x === "object" && typeof x.toJSON === "function") x = x.toJSON();
    if (typeof x === "function" || typeof x === "symbol") return undefined;
    if (!x || typeof x !== "object") return x;
    if (ancestors.has(x)) return "[Circular]";
    ancestors.add(x);
    const out = Array.isArray(x)
      ? x.map((y) => { const w = walk(y, ancestors); return w === undefined ? null : w; })
      : Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, ancestors)] as const).filter(([, w]) => w !== undefined));
    ancestors.delete(x);
    return out;
  };
  return JSON.parse(JSON.stringify(walk(v, new Set())));
};
function settle(calls: CallLog[]): CallLog[] {
  return calls.map((c) => {
    if (!c.yielded) return { ...c };
    const { yielded, ...rest } = c;
    const got = segmentsOf(yielded);
    return JSON.stringify(got) === JSON.stringify(c.segments) ? rest : { ...rest, segments: got, planned: c.segments, cut: true };
  });
}
const thrownOf = (e: unknown) => ({ name: (e as Any)?.name ?? "Error", message: String((e as Any)?.message ?? e) });

/** Runs a root once over runAsync (SSE, progressive SSE, or the default mode). */
export async function capture(root: Any, { mode = "sse", progressive = false, plugins = [] as Any[], prompt = "go" }: { mode?: "sse" | "none"; progressive?: boolean; plugins?: Any[]; prompt?: string } = {}): Promise<Captured> {
  if (progressive) process.env["ADK_ENABLE_PROGRESSIVE_SSE_STREAMING"] = "1";
  else delete process.env["ADK_ENABLE_PROGRESSIVE_SSE_STREAMING"];
  state.calls = []; state.stripped = []; state.served = [];
  try {
    const runner = new adk.InMemoryRunner({ agent: root, appName: "oracle", plugins });
    const s = await runner.sessionService.createSession({ appName: "oracle", userId: "u" });
    const natives: Record<string, unknown>[] = [];
    let thrown: Captured["thrown"] = null;
    try {
      for await (const ev of runner.runAsync({ userId: "u", sessionId: s.id, newMessage: { role: "user", parts: [{ text: prompt }] }, runConfig: { streamingMode: mode === "none" ? adk.StreamingMode.NONE : adk.StreamingMode.SSE } })) natives.push(plain(ev));
    } catch (e) { thrown = thrownOf(e); }
    return { natives, thrown, calls: settle(state.calls), stripped: state.stripped.slice(), served: state.served.slice() };
  } finally { delete process.env["ADK_ENABLE_PROGRESSIVE_SSE_STREAMING"]; }
}

/** Runs a root over runLive: one user turn; the queue closes on the first turnComplete, else a 3 s cap closes it
 *  and aborts 500 ms later. */
export async function captureLive(root: Any, { runConfig = { responseModalities: ["TEXT"] } as Any, prompt = "go" } = {}): Promise<Captured> {
  state.calls = []; state.stripped = []; state.served = [];
  const runner = new adk.InMemoryRunner({ agent: root });
  const s = await runner.sessionService.createSession({ appName: runner.appName, userId: "u" });
  const queue = new adk.LiveRequestQueue();
  queue.sendContent({ role: "user", parts: [{ text: prompt }] });
  const abort = new AbortController();
  const cap = setTimeout(() => { queue.close(); setTimeout(() => abort.abort(), 500); }, 3000);
  const natives: Record<string, unknown>[] = [];
  let thrown: Captured["thrown"] = null;
  try {
    for await (const ev of (runner as Any).runLive({ userId: "u", sessionId: s.id, liveRequestQueue: queue, runConfig, abortSignal: abort.signal })) {
      natives.push(plain(ev));
      if ((ev as Any).turnComplete === true) queue.close();
    }
  } catch (e) { thrown = thrownOf(e); }
  clearTimeout(cap);
  return { natives, thrown, calls: state.calls.slice(), stripped: [], served: [] };
}

export const scopeOf = (e: Any): string => `${e.author ?? ""}|${e.branch ?? ""}|${e.nodeInfo?.path ?? ""}`;

/** Maps each call to its source scope and first native; strips the tags (and refuses a native where one survives).
 *  Untagged calls (default mode, Chrome) map by order: an agent's k-th call to its k-th model event. */
export function mapCalls(natives: Any[], calls: CallLog[]): Array<CallLog & { source: string; firstNative: number | null }> {
  const first = new Map<number, number>();
  const scope = new Map<number, string>();
  natives.forEach((e, i) => { const k = e.customMetadata?.[TAG]; if (k !== undefined && !first.has(k)) { first.set(k, i); scope.set(k, scopeOf(e)); } });
  const byAgent = new Map<string, CallLog[]>();
  for (const c of calls) if (!scope.has(c.call)) { if (!byAgent.has(c.agent)) byAgent.set(c.agent, []); byAgent.get(c.agent)!.push(c); }
  for (const [agent, cs] of byAgent) {
    const evs = natives.map((e, i) => [e, i] as const).filter(([e]) => e.author === agent && (e.errorCode !== undefined || (e.content?.role === "model" && (e.content.parts ?? []).length)) && e.customMetadata?.[TAG] === undefined);
    cs.forEach((c, j) => { const hit = evs[j]; scope.set(c.call, hit ? scopeOf(hit[0]) : `${agent}||`); if (hit) first.set(c.call, hit[1]); });
  }
  const strip = (o: Any): void => {
    if (Array.isArray(o)) { o.forEach(strip); return; }
    if (!o || typeof o !== "object") return;
    if (o.customMetadata && typeof o.customMetadata === "object") {
      const cm = o.customMetadata;
      const created = cm[CREATED];
      delete cm[TAG]; delete cm[CREATED];
      if (created && Object.keys(cm).length === 0) delete o.customMetadata;
    }
    for (const v of Object.values(o)) strip(v);
  };
  strip(natives);
  if (JSON.stringify(natives).includes("__oracle")) throw new Error("an oracle tag survived in the natives");
  return calls.map((c) => ({ ...c, source: scope.get(c.call) ?? `${c.agent}||`, firstNative: first.get(c.call) ?? null }));
}

export type Unit = { source: string; call: string | number; seg: number; text: string };
export const unitsOf = (mapped: Array<{ source: string; call: number; segments: string[] }>): Unit[] =>
  mapped.flatMap((c) => c.segments.map((text, i) => ({ source: c.source, call: c.call, seg: i, text })));
export { adk };
