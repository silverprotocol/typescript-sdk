/**
 * ADK in-band invocation errors (spec §8.0 item 35) over the engine-built
 * streams in e2e/fixtures/adk-error: runs of the real @google/adk runners over
 * its Gemini model class with the transport replaced. Each run is folded with
 * one normalizer per invoke, bare and with the host-completion event; a run
 * that threw is fed its thrown error (the run's sidecar) as the host-terminal
 * event instead. Two adk-pause credential runs are fed a host-terminal event
 * after their pause.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgEvent, JsonValue, Reducer } from "@silverprotocol/core";
import { ADK_HOST_COMPLETE_TYPE, ADK_HOST_ERROR_TYPE, createAdkNormalizer } from "./index.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "e2e", "fixtures");
const TERMINAL = new Set(["turn.done", "turn.error", "turn.abort"]);

type Native = { readonly [k: string]: JsonValue };
type HostError = { code: string; message: string; usage?: JsonValue };

/** Per leg, in both modes: the error events' codes, in order, and the invocation's close. */
interface Expected {
  errors: string[];
  /** The SSE mode's error codes, where they differ from the default mode's. */
  sseErrors?: string[];
  close: { paused: boolean; code: string };
}
const LEGS: Record<string, Expected> = {
  "bare-block-then-streamed-block": { errors: ["SAFETY", "SAFETY"], close: { paused: false, code: "SAFETY" } },
  "block-usage-later": { errors: ["SAFETY"], close: { paused: false, code: "SAFETY" } },
  "block-usage-on-finish": { errors: ["SAFETY"], close: { paused: false, code: "SAFETY" } },
  "chrome-loop-error-each-iteration": { errors: ["NotSupportedError", "NotSupportedError"], close: { paused: false, code: "NotSupportedError" } },
  "confirmation-pause-then-interactions-failed": { errors: ["INTERNAL"], close: { paused: true, code: "INTERNAL" } },
  "credential-pause-stream-throw-then-rerun": { errors: ["429"], close: { paused: true, code: "429" } },
  "credential-pause-usage-report-then-429": { errors: ["429"], close: { paused: true, code: "429" } },
  "credential-step-tool-throw-then-rerun": { errors: ["UNKNOWN_ERROR"], close: { paused: false, code: "UNKNOWN_ERROR" } },
  "interactions-loop-failed-each-iteration": { errors: ["INTERNAL", "INTERNAL"], close: { paused: false, code: "INTERNAL" } },
  "lone-429": { errors: ["429"], close: { paused: false, code: "429" } },
  "loop-identical-block": { errors: ["SAFETY", "SAFETY"], close: { paused: false, code: "SAFETY" } },
  "node-tool-retry": { errors: ["429"], close: { paused: false, code: "429" } },
  "parallel-agent-one-error-a-first": { errors: ["SAFETY"], close: { paused: false, code: "SAFETY" } },
  "parallel-agent-one-error-b-first": { errors: ["SAFETY"], close: { paused: false, code: "SAFETY" } },
  "parallel-agent-two-errors-a-first": { errors: ["SAFETY", "RECITATION"], close: { paused: false, code: "SAFETY" } },
  "parallel-agent-two-errors-b-first": { errors: ["RECITATION", "SAFETY"], close: { paused: false, code: "RECITATION" } },
  "parallel-workflow-one-block-a-first": { errors: ["SAFETY"], close: { paused: false, code: "NodeReportedError" } },
  "parallel-workflow-one-block-b-first": { errors: ["SAFETY"], close: { paused: false, code: "NodeReportedError" } },
  // In SSE the relay's closing event repeats the aggregate's error, which
  // counts as a second error until the relay repeat is recognised.
  "relay-block-on-text-chunk": { errors: ["SAFETY"], sseErrors: ["SAFETY", "SAFETY"], close: { paused: false, code: "SAFETY" } },
  "relay-text-then-block": { errors: ["SAFETY"], sseErrors: ["SAFETY", "SAFETY"], close: { paused: false, code: "SAFETY" } },
  "relay-then-reply-loop-block-no-text-no-usage": { errors: ["SAFETY", "SAFETY"], close: { paused: false, code: "SAFETY" } },
  "relay-then-reply-loop-block-no-text-usage": { errors: ["SAFETY", "SAFETY"], close: { paused: false, code: "SAFETY" } },
  "request-input-tool-throw-then-429": { errors: ["UNKNOWN_ERROR", "429"], close: { paused: false, code: "UNKNOWN_ERROR" } },
  "sequential-429-then-answer": { errors: ["429"], close: { paused: false, code: "429" } },
  "sequential-429-then-credential": { errors: ["429"], close: { paused: true, code: "429" } },
  "sequential-429-then-request-input": { errors: ["429"], close: { paused: true, code: "429" } },
  "sequential-429-then-two-answers": { errors: ["429"], close: { paused: false, code: "429" } },
  "sequential-credential-pause-then-429": { errors: ["429"], close: { paused: true, code: "429" } },
  "text-then-block-no-usage": { errors: ["SAFETY"], close: { paused: false, code: "SAFETY" } },
  "workflow-node-error-unrecovered": { errors: ["SAFETY"], close: { paused: false, code: "NodeReportedError" } },
  "workflow-node-retry": { errors: ["SAFETY", "SAFETY"], close: { paused: false, code: "SAFETY" } },
  // The run throws after both blocks; the thrown error is fed as the host-terminal event.
  "workflow-runnode-same-agent-twice-blocked": { errors: ["SAFETY", "SAFETY"], close: { paused: false, code: "DynamicNodeFailError" } },
};
/** The adk-pause runs fed a host-terminal event after their signalled pause. */
const PAUSE_THEN_HOST_ERROR = ["plain-credential", "after-pause-sse-credential"];
const THROWN_AFTER_PAUSE: HostError = { code: "UNAVAILABLE", message: "The run failed after the pause." };
/** The same thrown error, reporting usage of its own (work the stream did not report). */
const THROWN_AFTER_PAUSE_WITH_USAGE: HostError = { ...THROWN_AFTER_PAUSE, usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };

function isNative(v: JsonValue): v is Native {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function readNatives(path: string): Native[] {
  const parsed = JsonValue.parse(JSON.parse(readFileSync(path, "utf8")));
  if (!Array.isArray(parsed)) throw new Error(`${path}: not an array`);
  return parsed.filter(isNative);
}
function thrownOf(path: string): HostError | undefined {
  const sidecar = path.replace(/\.native\.json$/, ".sidecar.json");
  if (!existsSync(sidecar)) return undefined;
  const parsed = JsonValue.parse(JSON.parse(readFileSync(sidecar, "utf8")));
  const thrown = isNative(parsed) ? parsed["thrown"] : undefined;
  if (thrown === undefined || !isNative(thrown)) return undefined;
  const name = thrown["name"];
  const message = thrown["message"];
  return typeof name === "string" && typeof message === "string" ? { code: name, message } : undefined;
}

interface Run {
  file: string;
  leg: string;
  host: boolean;
  natives: Native[];
  hostError: HostError | undefined;
  perNative: AgEvent[][];
  flushed: AgEvent[];
  all: AgEvent[];
}
function fold(file: string, leg: string, natives: Native[], host: boolean, hostError: HostError | undefined, invokeId = "adk"): Run {
  const n = createAdkNormalizer({ invokeId, ...(host ? { hostCompletion: true } : {}) });
  const perNative = natives.map((e) => n.push(e));
  const tail = hostError !== undefined ? n.push({ type: ADK_HOST_ERROR_TYPE, ...hostError }) : host ? n.push({ type: ADK_HOST_COMPLETE_TYPE }) : [];
  const flushed = n.flush();
  return { file, leg, host, natives, hostError, perNative, flushed, all: [...perNative.flat(), ...tail, ...flushed] };
}

const errorRuns: Run[] = readdirSync(join(FIXTURES, "adk-error"))
  .filter((f) => f.endsWith(".native.json"))
  .sort()
  .flatMap((f) => {
    const path = join(FIXTURES, "adk-error", f);
    const leg = f.replace(/\.(none|sse|progressive)\.native\.json$/, "");
    const natives = readNatives(path);
    const thrown = thrownOf(path);
    return [false, true].map((host) => fold(f, leg, natives, host, thrown));
  });
/** The engine-built adk-error runs that meet an in-band error after a
 *  signalled pause, fed a host-terminal event at the end. */
const PAUSE_ERROR_THEN_HOST_ERROR = ["credential-pause-usage-report-then-429"];
const pauseErrorRuns: Run[] = PAUSE_ERROR_THEN_HOST_ERROR.flatMap((leg) =>
  readdirSync(join(FIXTURES, "adk-error"))
    .filter((f) => f.startsWith(`${leg}.`) && f.endsWith(".native.json"))
    .sort()
    .flatMap((f) => {
      const natives = readNatives(join(FIXTURES, "adk-error", f));
      return [false, true].map((host) => fold(f, leg, natives, host, THROWN_AFTER_PAUSE_WITH_USAGE));
    }),
);
const pauseRuns: Run[] = PAUSE_THEN_HOST_ERROR.flatMap((leg) => {
  const f = `${leg}.native.json`;
  const natives = readNatives(join(FIXTURES, "adk-pause", f));
  return [false, true].map((host) => fold(f, leg, natives, host, THROWN_AFTER_PAUSE));
});
const label = (r: Run) => `${r.file} ${r.host ? "host completion" : "bare"}`;

const inBand = (e: Native): HostError | undefined => {
  const code = e["errorCode"];
  const message = e["errorMessage"];
  return typeof code === "string" && typeof message === "string" ? { code, message } : undefined;
};
/** A turn.done's outcome type and paused asks, read without narrowing the event union. */
const outcomeType = (e: AgEvent): unknown => {
  const o: unknown = Reflect.get(e, "outcome");
  return typeof o === "object" && o !== null ? Reflect.get(o, "type") : undefined;
};
const outcomeAsks = (e: AgEvent): unknown => {
  const o: unknown = Reflect.get(e, "outcome");
  return typeof o === "object" && o !== null ? Reflect.get(o, "asks") : undefined;
};
const sourceOf = (e: Native): string => {
  const nodeInfo = e["nodeInfo"];
  const path = nodeInfo !== undefined && isNative(nodeInfo) ? nodeInfo["path"] : undefined;
  return JSON.stringify([e["author"] ?? null, e["branch"] ?? null, path ?? null]);
};
const numberAt = (u: JsonValue | undefined, k: string): number => {
  const v = u !== undefined && isNative(u) ? u[k] : undefined;
  return typeof v === "number" ? v : 0;
};

/**
 * Spec §10 <N5>'s usage: the field-wise sum of the invocation's non-partial
 * usage reports, with an aggregate that repeats an in-band error (a
 * partial:false event carrying the errorCode and errorMessage of the previous
 * event of its source, which did not carry partial:false) counted once with
 * the event it repeats, from the later of the two reports.
 */
function expectedUsage(natives: Native[]): { inputTokens: number; outputTokens: number } {
  const counted: Array<JsonValue | undefined> = [];
  const previous = new Map<string, { partialFalse: boolean; error: HostError | undefined; slot: number | undefined; usage: JsonValue | undefined }>();
  for (const e of natives) {
    const source = sourceOf(e);
    const prev = previous.get(source);
    const error = inBand(e);
    const usage = e["usageMetadata"];
    let slot: number | undefined;
    const repeat =
      error !== undefined && e["partial"] === false && prev !== undefined && !prev.partialFalse && prev.error?.code === error.code && prev.error.message === error.message;
    if (repeat && prev !== undefined) {
      const later = usage ?? prev.usage;
      if (prev.slot !== undefined) {
        if (usage !== undefined) counted[prev.slot] = usage;
        slot = prev.slot;
      } else if (later !== undefined) {
        slot = counted.push(later) - 1;
      }
    } else if (e["partial"] !== true && usage !== undefined) {
      slot = counted.push(usage) - 1;
    }
    previous.set(source, { partialFalse: e["partial"] === false, error, slot, usage });
  }
  let inputTokens = 0;
  let outputTokens = 0;
  for (const u of counted) {
    inputTokens += numberAt(u, "promptTokenCount");
    outputTokens += numberAt(u, "candidatesTokenCount") + numberAt(u, "thoughtsTokenCount");
  }
  return { inputTokens, outputTokens };
}

/** The text as it was streamed: each source's chunks, and a non-partial text that does not close a chunk stream. */
function streamedText(natives: Native[]): string {
  let text = "";
  const streaming = new Set<string>();
  for (const e of natives) {
    const content = e["content"];
    const parts = content !== undefined && isNative(content) ? content["parts"] : undefined;
    const own = Array.isArray(parts)
      ? parts.flatMap((p) => (isNative(p) && typeof p["text"] === "string" && p["thought"] !== true ? [p["text"]] : [])).join("")
      : "";
    const source = sourceOf(e);
    if (e["partial"] === true) {
      text += own;
      if (own.length > 0) streaming.add(source);
    } else if (own.length > 0) {
      if (!streaming.has(source)) text += own;
      streaming.delete(source);
    } else if (e["errorCode"] === undefined && e["finishReason"] === undefined && e["partial"] === false) {
      streaming.delete(source);
    }
  }
  return text;
}

function expectCleanFold(r: Run): void {
  for (const e of r.all) expect(() => AgEvent.parse(e), label(r)).not.toThrow();
  const reducer = new Reducer();
  for (const e of r.all) reducer.push(e);
  expect(reducer.needsResync, label(r)).toBe(false);
  for (const turnId of r.all.flatMap((e) => (e.type === "turn.start" ? [e.turnId] : []))) {
    const own = r.all.filter((e) => e.turnId === turnId);
    const ends = own.filter((e) => TERMINAL.has(e.type));
    expect(ends, `${label(r)} ${turnId}`).toHaveLength(1);
    expect(own.at(-1), `${label(r)} ${turnId}`).toBe(ends[0]);
  }
}

describe("createAdkNormalizer — ADK in-band invocation errors over engine-built runs (§8.0 item 35, §10 <N5>)", () => {
  it("every expected leg has runs in both modes, and every run has an expected leg", () => {
    expect(new Set(errorRuns.map((r) => r.leg))).toEqual(new Set(Object.keys(LEGS)));
    expect(errorRuns.length).toBeGreaterThanOrEqual(2 * Object.keys(LEGS).length);
  });

  it("every run folds without a resync, every opened turn has exactly one terminal and nothing after it, and no turn closes as success", () => {
    for (const r of [...errorRuns, ...pauseRuns, ...pauseErrorRuns]) {
      expectCleanFold(r);
      const successes = r.all.filter((e) => e.type === "turn.done" && outcomeType(e) === "success");
      expect(successes, label(r)).toEqual([]);
    }
  });

  it("each in-band invocation error yields exactly one error event, carrying its errorCode, from the push() that received it; an aggregate that repeats one yields none, and flush() yields none", () => {
    for (const r of errorRuns) {
      const expected = LEGS[r.leg];
      if (expected === undefined) throw new Error(`no expectation for ${r.leg}`);
      const errors = r.file.includes(".sse.") ? (expected.sseErrors ?? expected.errors) : expected.errors;
      expect(r.all.flatMap((e) => (e.type === "error" ? [e.code] : [])), label(r)).toEqual(errors);
      r.perNative.forEach((batch, i) => {
        for (const e of batch.filter((x) => x.type === "error")) {
          expect(e.type === "error" ? e.code : undefined, `${label(r)} native ${i}`).toBe(inBand(r.natives[i]!)?.code);
        }
      });
      expect(r.flushed.some((e) => e.type === "error"), label(r)).toBe(false);
    }
    for (const r of pauseRuns) expect(r.all.some((e) => e.type === "error"), label(r)).toBe(false);
  });

  it("the text of each message folds once, as it was streamed", () => {
    for (const r of errorRuns) {
      const folded = r.all.flatMap((e) => (e.type === "text.delta" ? [e.delta] : [])).join("");
      expect(folded, label(r)).toBe(streamedText(r.natives));
    }
  });

  it("with no signalled pause, the invocation's turn closes with exactly one turn.error after every content event, carrying the host-terminal event's code when one was fed, else the first in-band error's, and the field-wise sum of the non-partial usage reports with a repeating aggregate counted once", () => {
    for (const r of errorRuns) {
      const expected = LEGS[r.leg];
      if (expected === undefined || expected.close.paused) continue;
      const ends = r.all.filter((e) => TERMINAL.has(e.type));
      expect(ends.map((e) => e.type), label(r)).toEqual(["turn.error"]);
      const end = ends[0];
      if (end === undefined || end.type !== "turn.error") throw new Error(label(r));
      expect(r.all.at(-1), label(r)).toBe(end);
      expect(end.code, label(r)).toBe(r.hostError?.code ?? expected.close.code);
      const hasFunctionCallRound = r.natives.some((e) => JSON.stringify(e["content"] ?? null).includes('"functionCall"'));
      if (hasFunctionCallRound && r.file.includes(".sse.")) {
        expect(end.usage, label(r)).toBeDefined();
      } else {
        const usage = expectedUsage(r.natives);
        if (usage.inputTokens === 0 && usage.outputTokens === 0) expect(end.usage, label(r)).toBeUndefined();
        else expect(end.usage, label(r)).toMatchObject(usage);
      }
    }
  });

  it("the two arrival orders of each ParallelAgent and parallel-Workflow run give the same terminal type and usage, and with one erroring branch the same code", () => {
    const pairs = errorRuns.filter((r) => r.leg.endsWith("-a-first"));
    expect(pairs.length).toBeGreaterThan(0);
    for (const a of pairs) {
      const b = errorRuns.find((r) => r.file === a.file.replace("-a-first", "-b-first") && r.host === a.host);
      if (b === undefined) continue; // a leg that exists in one order only in this mode
      const endOf = (r: Run) => r.all.filter((e) => TERMINAL.has(e.type)).at(-1);
      const ea = endOf(a);
      const eb = endOf(b);
      expect(eb?.type, label(b)).toBe(ea?.type);
      expect(eb !== undefined && "usage" in eb ? eb.usage : undefined, label(b)).toEqual(ea !== undefined && "usage" in ea ? ea.usage : undefined);
      if (a.leg.includes("one-")) expect(eb !== undefined && eb.type === "turn.error" ? eb.code : undefined, label(b)).toBe(ea !== undefined && ea.type === "turn.error" ? ea.code : undefined);
    }
  });

  it("with a signalled pause, the asking turn closes turn.done paused with its asks, then exactly one other top-level turn, opened after that close and carrying one message with no content, closes turn.error; bare, flush() opens no turn or message but that one", () => {
    const paused = [...errorRuns.filter((r) => LEGS[r.leg]?.close.paused === true), ...pauseRuns, ...pauseErrorRuns];
    expect(paused.length).toBeGreaterThan(0);
    for (const r of paused) {
      const ends = r.all.filter((e) => TERMINAL.has(e.type));
      expect(ends.map((e) => e.type), label(r)).toEqual(["turn.done", "turn.error"]);
      const [done, error] = ends;
      if (done === undefined || done.type !== "turn.done" || error === undefined || error.type !== "turn.error") throw new Error(label(r));
      expect(outcomeType(done), label(r)).toBe("paused");
      expect(done.finishReason, label(r)).toBe("paused");
      const asks = outcomeAsks(done);
      expect(Array.isArray(asks) ? asks.length : 0, label(r)).toBeGreaterThan(0);
      expect(error.code, label(r)).toBe(r.hostError?.code ?? LEGS[r.leg]?.close.code);
      expect(error.usage, label(r)).toEqual(r.hostError?.usage);
      const errorMessage = r.all.find((e) => e.type === "message.start" && e.turnId === error.turnId);
      const errorTurn = r.all.filter((e) => e.turnId === error.turnId || (e.type === "message.end" && e.id === errorMessage?.id));
      expect(errorTurn.map((e) => e.type), label(r)).toEqual(["turn.start", "message.start", "message.end", "turn.error"]);
      expect(r.all.indexOf(errorTurn[0]!), label(r)).toBeGreaterThan(r.all.indexOf(done));
      if (!r.host) {
        const opened = r.flushed.filter((e) => e.type === "turn.start" || e.type === "message.start").map((e) => e.turnId);
        // A host-terminal event opens the error turn from its own push().
        expect(opened, label(r)).toEqual(r.hostError === undefined ? [error.turnId, error.turnId] : []);
      }
    }
  });

  it("after a signalled pause and an in-band error, a host-terminal event closes the asking turn paused, then the one error turn with the host's code and only the host's usage, on the engine-built runs, bare and with host completion", () => {
    expect(pauseErrorRuns.length).toBeGreaterThanOrEqual(2);
    for (const r of pauseErrorRuns) {
      expectCleanFold(r);
      expect(r.all.flatMap((e) => (e.type === "error" ? [e.code] : [])), label(r)).toEqual(LEGS[r.leg]?.errors);
      const ends = r.all.filter((e) => TERMINAL.has(e.type));
      expect(ends.map((e) => e.type), label(r)).toEqual(["turn.done", "turn.error"]);
      const [done, error] = ends;
      expect(done === undefined ? undefined : outcomeType(done), label(r)).toBe("paused");
      expect(error === undefined ? undefined : Reflect.get(error, "code"), label(r)).toBe(THROWN_AFTER_PAUSE_WITH_USAGE.code);
      expect(error === undefined ? undefined : Reflect.get(error, "usage"), label(r)).toEqual(THROWN_AFTER_PAUSE_WITH_USAGE.usage);
    }
  });

  it("a Workflow whose entry runs one agent twice concurrently without a sub-branch, both runs ending on a block: each run's block counts once (twice the block's usage), and the one turn.error carries the first in-band code without the host-terminal event and the thrown error's code with it", () => {
    const leg = "workflow-runnode-same-agent-twice-blocked";
    const files = readdirSync(join(FIXTURES, "adk-error")).filter((f) => f.startsWith(`${leg}.`) && f.endsWith(".native.json"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const path = join(FIXTURES, "adk-error", f);
      const natives = readNatives(path);
      const thrown = thrownOf(path);
      expect(thrown, f).toBeDefined();
      for (const host of [false, true]) {
        for (const [fed, code] of [
          [undefined, "SAFETY"],
          [thrown, thrown?.code],
        ] as const) {
          const r = fold(f, leg, natives, host, fed);
          const label = `${f} host=${host} fed=${fed !== undefined}`;
          expectCleanFold(r);
          const ends = r.all.filter((e) => TERMINAL.has(e.type));
          expect(ends.map((e) => [e.type, Reflect.get(e, "code")]), label).toEqual([["turn.error", code]]);
          expect(Reflect.get(ends[0] ?? {}, "usage"), label).toMatchObject(expectedUsage(natives));
          expect(expectedUsage(natives), label).toEqual({ inputTokens: 20, outputTokens: 10 });
        }
      }
    }
  });
});

describe("createAdkNormalizer — a host-terminal error after an in-band error", () => {
  /** The expected field-wise sum: per-kind counts add (absent is 0); a total
   *  or a cost adds only when both records carry it, and is omitted otherwise. */
  const expectedSum = (accumulated: unknown, host: { [k: string]: number }): { [k: string]: unknown } => {
    const acc: { [k: string]: unknown } = typeof accumulated === "object" && accumulated !== null ? { ...accumulated } : {};
    const out: { [k: string]: unknown } = { ...acc };
    const aggregates = new Set(["totalTokens", "totalTokensRaw", "costUsd"]);
    for (const k of new Set([...Object.keys(acc), ...Object.keys(host)])) {
      const x = acc[k];
      const y = host[k];
      if (aggregates.has(k)) {
        if (typeof x === "number" && typeof y === "number") out[k] = x + y;
        else delete out[k];
      } else if (typeof y === "number") out[k] = (typeof x === "number" ? x : 0) + y;
    }
    return out;
  };

  it("an invocation that met an in-band error and ends with the host's error carrying usage closes one turn.error with the host's code and the turn's accumulated usage plus the host's, field by field, a total only when both carry one", () => {
    for (const i of [0, 1]) {
      for (const host of [false, true]) {
        for (const [shape, hostUsage] of [
          ["with a total", { inputTokens: 900 + i, outputTokens: 90, totalTokens: 990 + i }],
          ["counts, no total", { inputTokens: 900 + i, outputTokens: 90 }],
        ] as const) {
          const label = `#${i} host=${host} ${shape}`;
          const inv = `inv-host-usage-${i}`;
          const natives: Native[] = [
            { invocationId: inv, author: "worker", content: { role: "model", parts: [{ functionCall: { name: "lookup", args: {}, id: `fc-${i}` } }] }, usageMetadata: { promptTokenCount: 10 + i, candidatesTokenCount: 5, totalTokenCount: 15 + i } },
            { invocationId: inv, author: "worker", errorCode: "RESOURCE_EXHAUSTED", errorMessage: `quota ${i}`, usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 0, totalTokenCount: 7 } },
          ];
          const closeOf = (hostError: HostError) => fold("synthetic", "host-usage", natives, host, hostError).all.filter((e) => e.type === "turn.error");
          const withUsage = closeOf({ code: "UNAVAILABLE", message: `run failed ${i}`, usage: hostUsage });
          const without = closeOf({ code: "UNAVAILABLE", message: `run failed ${i}` });
          expect(withUsage, label).toHaveLength(1);
          expect(withUsage[0], label).toMatchObject({ code: "UNAVAILABLE" });
          const usageOf = (e: AgEvent | undefined): unknown => (e === undefined ? undefined : Reflect.get(e, "usage"));
          const accumulated = usageOf(without[0]);
          expect(accumulated, label).toBeDefined();
          expect(usageOf(withUsage[0]), label).toEqual(expectedSum(accumulated, hostUsage));
          expect(usageOf(withUsage[0]), label).not.toEqual(accumulated);
        }
      }
    }
  });
});
