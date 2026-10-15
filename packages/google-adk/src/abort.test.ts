/**
 * ADK client abort (spec §8.0 items 35 and 26, §10 item 70) over the
 * engine-built streams in e2e/fixtures/adk-abort: @google/adk 2.3.0's real
 * LlmAgent and InMemoryRunner, driven by a scripted model, with the host's
 * abortSignal fired mid-run and runAsync read to its end. Each aborted stream
 * ends with the seal ADK appends (errorCode "INVOCATION_ABORTED"); the
 * c-control streams are the same paused run with no abort. Each run is folded
 * with one normalizer per invoke, bare (normative: host obligation 4 sends no
 * completion event after an abort) and with the host-completion event (a
 * robustness control).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgEvent, JsonValue, Reducer } from "@silverprotocol/core";
import { ADK_HOST_COMPLETE_TYPE, createAdkNormalizer } from "./index.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "e2e", "fixtures");
const ABORT = join(FIXTURES, "adk-abort");
const SEAL_CODE = "INVOCATION_ABORTED";
const SEAL_MESSAGE = "Invocation was aborted by client.";
const TERMINAL = new Set(["turn.done", "turn.error", "turn.abort"]);
const ABORTED_SHAPES = ["a-text", "b-one-call", "b-two-calls", "c-ask-pending", "c-after-pause"];
const ASK_SHAPES = new Set(["c-ask-pending", "c-after-pause"]);

type Native = { readonly [k: string]: JsonValue };
function isObject(v: JsonValue | undefined): v is { readonly [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function readNatives(path: string): Native[] {
  const parsed = JsonValue.parse(JSON.parse(readFileSync(path, "utf8")));
  if (!Array.isArray(parsed)) throw new Error(`${path}: not an array`);
  return parsed.filter(isObject);
}
/** The functionResponse ids, and the functionCall ids and names, of one native. */
function partsOf(e: Native): { responses: string[]; calls: Array<{ id: string; name: string }> } {
  const content = e["content"];
  const parts = isObject(content) ? content["parts"] : undefined;
  const responses: string[] = [];
  const calls: Array<{ id: string; name: string }> = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!isObject(p)) continue;
    const fr = p["functionResponse"];
    if (isObject(fr) && typeof fr["id"] === "string") responses.push(fr["id"]);
    const fc = p["functionCall"];
    if (isObject(fc) && typeof fc["id"] === "string" && typeof fc["name"] === "string") calls.push({ id: fc["id"], name: fc["name"] });
  }
  return { responses, calls };
}
/** One member of an event, read without narrowing the event union. */
const member = (e: AgEvent, k: string): unknown => Reflect.get(e, k);

interface Run {
  label: string;
  shape: string;
  natives: Native[];
  host: boolean;
  perNative: AgEvent[][];
  tail: AgEvent[];
  flushed: AgEvent[];
  all: AgEvent[];
  reducer: Reducer;
}
function fold(file: string, natives: Native[], host: boolean): Run {
  const n = createAdkNormalizer({ invokeId: "adk", ...(host ? { hostCompletion: true } : {}) });
  const perNative = natives.map((e) => n.push(e));
  const tail = host ? n.push({ type: ADK_HOST_COMPLETE_TYPE }) : [];
  const flushed = n.flush();
  const all = [...perNative.flat(), ...tail, ...flushed];
  const reducer = new Reducer();
  for (const e of all) reducer.push(e);
  const shape = file.replace(/\.(none|sse)\.\d\.native\.json$/, "");
  return { label: `${file} ${host ? "host completion" : "bare"}`, shape, natives, host, perNative, tail, flushed, all, reducer };
}
const files = readdirSync(ABORT)
  .filter((f) => f.endsWith(".native.json"))
  .sort();
const runs: Run[] = files.flatMap((f) => [false, true].map((host) => fold(f, readNatives(join(ABORT, f)), host)));
const aborted = runs.filter((r) => ABORTED_SHAPES.includes(r.shape));
const controls = runs.filter((r) => r.shape === "c-control");
const sealOf = (r: Run): Native => {
  const last = r.natives[r.natives.length - 1];
  if (last === undefined) throw new Error(`${r.label}: no natives`);
  return last;
};

describe("createAdkNormalizer — the ADK client-abort seal (SPEC §8.0 item 35, §10 item 70)", () => {
  it("the fixtures: five aborted shapes and the paused control, each in the default and SSE modes, two instances each; every aborted stream ends with the seal, and the control holds none", () => {
    const shapes = [...ABORTED_SHAPES, "c-control"];
    expect(files).toEqual(shapes.flatMap((s) => ["none", "sse"].flatMap((m) => [1, 2].map((i) => `${s}.${m}.${i}.native.json`))).sort());
    expect(aborted).toHaveLength(2 * 20);
    for (const r of aborted) {
      expect(sealOf(r)["errorCode"], r.label).toBe(SEAL_CODE);
      expect(sealOf(r)["errorMessage"], r.label).toBe(SEAL_MESSAGE);
      expect(r.natives.slice(0, -1).some((e) => e["errorCode"] !== undefined), r.label).toBe(false);
    }
    for (const r of controls) expect(r.natives.some((e) => e["errorCode"] !== undefined), r.label).toBe(false);
  });

  it("the seal's push() closes the turn with exactly one turn.abort whose reason is cancelled, as the invocation's last event; nothing follows it, from the host-completion event or flush()", () => {
    for (const r of aborted) {
      const fromSeal = r.perNative[r.perNative.length - 1] ?? [];
      const terminals = r.all.filter((e) => TERMINAL.has(e.type));
      expect(terminals.map((e) => [e.type, member(e, "reason")]), r.label).toEqual([["turn.abort", "cancelled"]]);
      expect(fromSeal.at(-1)?.type, r.label).toBe("turn.abort");
      expect(r.all.at(-1)?.type, r.label).toBe("turn.abort");
      expect(r.tail, r.label).toEqual([]);
      expect(r.flushed, r.label).toEqual([]);
    }
  });

  it("no error event and no turn.error is emitted, and no turn closes paused or as success", () => {
    for (const r of aborted) {
      expect(r.all.filter((e) => e.type === "error"), r.label).toEqual([]);
      expect(r.all.filter((e) => e.type === "turn.error"), r.label).toEqual([]);
      expect(r.all.filter((e) => e.type === "turn.done"), r.label).toEqual([]);
      expect(r.all.filter((e) => e.type === "turn.start"), r.label).toHaveLength(1);
    }
  });

  it("before the turn.abort, one tool.done {outcome error, isError, errorText the seal's message} per functionResponse part of the seal, the adk_request_confirmation call's included", () => {
    for (const r of aborted) {
      const sealed = partsOf(sealOf(r)).responses;
      const dones = r.all.filter((e) => e.type === "tool.done");
      expect(dones.map((e) => member(e, "toolCallId")).sort(), r.label).toEqual([...sealed].sort());
      for (const d of dones) {
        expect(member(d, "outcome"), r.label).toBe("error");
        expect(member(d, "isError"), r.label).toBe(true);
        expect(member(d, "errorText"), r.label).toBe(SEAL_MESSAGE);
      }
      const abortAt = r.all.findIndex((e) => e.type === "turn.abort");
      for (const d of dones) expect(r.all.indexOf(d), r.label).toBeLessThan(abortAt);
      const expected = r.shape === "a-text" ? 0 : r.shape === "b-one-call" ? 1 : 2;
      expect(sealed, r.label).toHaveLength(expected);
      if (ASK_SHAPES.has(r.shape)) {
        const ask = r.natives.flatMap((e) => partsOf(e).calls).find((c) => c.name === "adk_request_confirmation");
        expect(ask, r.label).toBeDefined();
        expect(sealed, r.label).toContain(ask?.id);
      }
    }
  });

  it("an ask the seal answers is no longer pending: one hitl.ask, and the folded turn record is {aborted, cancelled} with no asks", () => {
    for (const r of aborted) {
      expect(r.all.filter((e) => e.type === "hitl.ask"), r.label).toHaveLength(ASK_SHAPES.has(r.shape) ? 1 : 0);
      const turns = r.reducer.result().turns;
      expect(turns, r.label).toHaveLength(1);
      expect(turns[0]?.outcome, r.label).toEqual({ type: "aborted", reason: "cancelled" });
    }
  });

  it("every event passes AgEvent validation, the fold needs no resync, and it holds one tool-result block per sealed call", () => {
    for (const r of aborted) {
      for (const e of r.all) expect(() => AgEvent.parse(e), `${r.label} ${e.type}`).not.toThrow();
      expect(r.reducer.needsResync, r.label).toBe(false);
      const results = r.reducer
        .result()
        .messages.flatMap((m) => m.content)
        .filter((b) => b.type === "tool-result")
        .map((b) => Reflect.get(b, "toolCallId"));
      expect(results.sort(), r.label).toEqual([...partsOf(sealOf(r)).responses].sort());
    }
  });

  it("the message.end before the turn.abort carries the turn's usage, the sum of its non-partial usage reports, when a model event reported one, and none otherwise", () => {
    for (const r of aborted) {
      const reports = r.natives.flatMap((e) => {
        const um = e["usageMetadata"];
        return e["partial"] !== true && isObject(um) ? [um] : [];
      });
      const abortAt = r.all.findIndex((e) => e.type === "turn.abort");
      const end = r.all[abortAt - 1];
      expect(end?.type, r.label).toBe("message.end");
      if (r.shape === "a-text") {
        expect(reports, r.label).toEqual([]);
        expect(end === undefined ? undefined : member(end, "usage"), r.label).toBeUndefined();
        continue;
      }
      expect(reports.length, r.label).toBeGreaterThan(0);
      const sum = (k: string): number => reports.reduce((s, um) => s + (typeof um[k] === "number" ? um[k] : 0), 0);
      expect(end === undefined ? undefined : member(end, "usage"), r.label).toEqual({
        inputTokens: sum("promptTokenCount"),
        outputTokens: sum("candidatesTokenCount"),
        totalTokens: sum("totalTokenCount"),
        cumulative: false,
      });
    }
  });

  it("the seal's code and message ride verbatim in the event-level provider-raw carry", () => {
    for (const r of aborted) {
      const fromSeal = r.perNative[r.perNative.length - 1] ?? [];
      const raws = fromSeal.flatMap((e) => {
        const block = e.type === "content.block" ? member(e, "block") : undefined;
        return typeof block === "object" && block !== null && Reflect.get(block, "type") === "provider-raw" ? [Reflect.get(block, "raw")] : [];
      });
      expect(raws, r.label).toEqual([{ errorCode: SEAL_CODE, errorMessage: SEAL_MESSAGE }]);
    }
  });
});

describe("createAdkNormalizer — the client-abort seal after an earlier close or an earlier in-band error", () => {
  it("an in-band error earlier in the invocation stays a non-terminal error event: the seal still closes the one turn as turn.abort cancelled, and no turn.error follows from the host-completion event or flush()", () => {
    for (const r of aborted) {
      const seal = sealOf(r);
      const error: Native = { invocationId: seal["invocationId"] ?? null, author: "helper", errorCode: "429", errorMessage: "Resource has been exhausted (e.g. check quota)." };
      const run = fold(`${r.label} 429 first`, [...r.natives.slice(0, -1), error, seal], r.host);
      expect(run.all.filter((e) => e.type === "error").map((e) => member(e, "code")), run.label).toEqual(["429"]);
      expect(run.all.filter((e) => TERMINAL.has(e.type)).map((e) => [e.type, member(e, "reason")]), run.label).toEqual([["turn.abort", "cancelled"]]);
      expect(run.all.at(-1)?.type, run.label).toBe("turn.abort");
      expect(run.tail, run.label).toEqual([]);
      expect(run.flushed, run.label).toEqual([]);
      expect(run.reducer.needsResync, run.label).toBe(false);
    }
  });

  it("a seal pushed after the host-completion event (which host obligation 4 sends only after a run that returned normally) adds no second terminal, and maps as the same event without the seal's code would, apart from the carried code and message", () => {
    const types = (evs: AgEvent[]): string[] => evs.map((e) => e.type);
    // The default-mode a-text streams hold the seal alone: no turn is open when the completion event arrives.
    const withPrefix = aborted.filter((x) => x.host && x.natives.length > 1);
    expect(withPrefix).toHaveLength(20 - 2);
    for (const r of withPrefix) {
      const seal = sealOf(r);
      const { errorCode: _code, errorMessage: _message, ...plain } = seal;
      const after = (last: Native): { before: AgEvent[]; fromLast: AgEvent[]; flushed: AgEvent[] } => {
        const n = createAdkNormalizer({ invokeId: "adk", hostCompletion: true });
        const before = [...r.natives.slice(0, -1).flatMap((e) => n.push(e)), ...n.push({ type: ADK_HOST_COMPLETE_TYPE })];
        return { before, fromLast: n.push(last), flushed: n.flush() };
      };
      const sealed = after(seal);
      const control = after(plain);
      expect(sealed.before.filter((e) => TERMINAL.has(e.type)), r.label).toHaveLength(1);
      expect([...sealed.fromLast, ...sealed.flushed].filter((e) => TERMINAL.has(e.type)), r.label).toEqual([]);
      expect(types(sealed.fromLast).filter((t) => t !== "content.block"), r.label).toEqual(types(control.fromLast).filter((t) => t !== "content.block"));
      expect(sealed.flushed, r.label).toEqual([]);
    }
  });
});

describe("createAdkNormalizer — the client-abort route is keyed on the seal's errorCode value (SPEC §10 item 70, negative controls)", () => {
  it("the same paused run with no abort still closes paused at the invocation's end, naming the adk_request_confirmation ask", () => {
    expect(controls).toHaveLength(2 * 4);
    for (const r of controls) {
      const ask = r.natives.flatMap((e) => partsOf(e).calls).find((c) => c.name === "adk_request_confirmation");
      const terminals = r.all.filter((e) => TERMINAL.has(e.type));
      expect(terminals.map((e) => e.type), r.label).toEqual(["turn.done"]);
      const outcome = terminals[0] === undefined ? undefined : member(terminals[0], "outcome");
      expect(outcome, r.label).toMatchObject({ type: "paused", asks: [{ toolCallId: ask?.id }] });
      expect(Reflect.get(Object(outcome), "asks"), r.label).toHaveLength(1);
      expect(r.reducer.needsResync, r.label).toBe(false);
    }
  });

  it("the seal's exact shape with any other errorCode keeps item 35's route: one error event, then one turn.error with that code, and the ask it answers is no longer pending, so no turn closes paused", () => {
    for (const r of aborted) {
      const seal = sealOf(r);
      const natives = [...r.natives.slice(0, -1), { ...seal, errorCode: "INVOCATION_ABORTED_X" }];
      const other = fold(`${r.label} recoded`, natives, r.host);
      expect(other.all.filter((e) => e.type === "error").map((e) => member(e, "code")), other.label).toEqual(["INVOCATION_ABORTED_X"]);
      expect(other.all.filter((e) => TERMINAL.has(e.type)).map((e) => [e.type, member(e, "code")]), other.label).toEqual([["turn.error", "INVOCATION_ABORTED_X"]]);
      expect(other.all.filter((e) => e.type === "turn.start"), other.label).toHaveLength(1);
      expect(other.reducer.needsResync, other.label).toBe(false);
    }
  });

  it("an ask answered within the invocation by an event that is not the seal is no longer pending either: the paused run with that answer appended closes nothing paused (SPEC §8.0 item 26)", () => {
    for (const r of controls) {
      const ask = r.natives.flatMap((e) => partsOf(e).calls).find((c) => c.name === "adk_request_confirmation");
      const last = r.natives[r.natives.length - 1];
      expect(ask, r.label).toBeDefined();
      const answer: Native = {
        invocationId: last?.["invocationId"] ?? null,
        author: "helper",
        content: { role: "user", parts: [{ functionResponse: { id: ask?.id ?? "", name: "adk_request_confirmation", response: { confirmed: false } } }] },
      };
      const answered = fold(`${r.label} answered`, [...r.natives, answer], r.host);
      const terminals = answered.all.filter((e) => TERMINAL.has(e.type));
      expect(terminals, answered.label).toHaveLength(1);
      expect(terminals.map((e) => Reflect.get(Object(member(e, "outcome")), "type")), answered.label).not.toContain("paused");
      expect(answered.reducer.result().turns[0]?.outcome?.type, answered.label).not.toBe("paused");
      expect(answered.reducer.needsResync, answered.label).toBe(false);
    }
  });

  it("the engine-built lone 429 (errorCode beside errorMessage, ending the run) still emits one error and closes turn.error 429", () => {
    const lone = readdirSync(join(FIXTURES, "adk-error")).filter((f) => f.startsWith("lone-429.") && f.endsWith(".native.json"));
    expect(lone.length).toBeGreaterThanOrEqual(2);
    for (const f of lone) {
      for (const host of [false, true]) {
        const r = fold(f, readNatives(join(FIXTURES, "adk-error", f)), host);
        expect(r.all.filter((e) => e.type === "error").map((e) => member(e, "code")), r.label).toEqual(["429"]);
        expect(r.all.filter((e) => TERMINAL.has(e.type)).map((e) => [e.type, member(e, "code")]), r.label).toEqual([["turn.error", "429"]]);
        expect(r.all.at(-1)?.type, r.label).toBe("turn.error");
      }
    }
  });
});
