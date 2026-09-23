/**
 * adk-pause.test.ts — rd-06 P-RED: the ADK pause/completion fixture set,
 * pinned against SPEC draft.4 §10 item 25 at google-adk STEP-1 scope.
 *
 * The fixtures under fixtures/adk-pause/ are built by the REAL @google/adk
 * engine with a stub model (adk-pause-fixtures.gen.test.ts). One Normalizer per
 * invoke (§8.0 Lifetime); the pause → resume pair is folded by ONE host Reducer.
 *
 * Step-1 classes (sp-google fa23c5c → e7cb467, 0.6.6):
 *  - PAUSE: the turn closes `turn.done {outcome:"paused", finishReason:"paused"}`
 *    from push(), with one ask per pending request.
 *  - ABORT_AT_FLUSH: a completed Workflow or a truncated stream closes
 *    `turn.abort` from flush(), NEVER success. (A completed Workflow flushing
 *    abort is step 1's disclosed known gap; the host-completion signal of
 *    §8.0 obligation 4 cures it in step 2.)
 *  - SUCCESS: a plain LlmAgent run closes success.
 * Every class: needsResync false, exactly one terminal per opened turn, and no
 * event targets a turn after its terminal.
 *
 * Step 2 (sp-google, draft.4 §8.0 item 26 + host obligation 4) adds:
 *  - the answer-id rule: each ask's toolCallId is its adk_request_* call id;
 *  - credential → auth / confirmation → approval (wf-functionnode-credential
 *    is now a PAUSE);
 *  - the sentinel-fed close: with `createAdkNormalizer({ hostCompletion: true })`
 *    and `{type:"__host_complete__"}` after the natives, a completed run closes
 *    success from push(), and the two plain-plane parks fold clean.
 * The KNOWN GAPS stay pinned on the legacy path (option off), where they still
 * park: rd-06 PS-2.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Reducer, type AgEvent, type JsonValue } from "@silverprotocol/core";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { HOST_COMPLETE_MARKER, replayNatives, splitHostCompleteMarker } from "./replay.js";

const E2E = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(E2E, "fixtures", "adk-pause");
const CORPUS = join(E2E, "corpus");

type Tagged = { ev: AgEvent; from: "push" | "flush"; invoke: number };
const TERMINALS = new Set(["turn.done", "turn.error", "turn.abort"]);

const load = (name: string): JsonValue[] => JSON.parse(readFileSync(join(DIR, `${name}.native.json`), "utf8")) as JsonValue[];

const SENTINEL = { type: HOST_COMPLETE_MARKER } as JsonValue;

/** One Normalizer per invoke; every invoke folds into ONE Reducer. With
 *  `hostCompleted`, each invoke is driven with the step-2 opt-in and the
 *  sentinel is pushed after its natives (a normal return). */
function foldWith(hostCompleted: boolean, ...invokes: JsonValue[][]): { r: Reducer; tagged: Tagged[] } {
  const r = new Reducer();
  const tagged: Tagged[] = [];
  invokes.forEach((natives, invoke) => {
    const n = createAdkNormalizer(hostCompleted ? { hostCompletion: true } : {});
    const feed = hostCompleted ? [...natives, SENTINEL] : natives;
    for (const f of feed) for (const ev of n.push(f)) tagged.push({ ev, from: "push", invoke });
    for (const ev of n.flush()) tagged.push({ ev, from: "flush", invoke });
  });
  for (const t of tagged) r.push(t.ev);
  return { r, tagged };
}
const fold = (...invokes: JsonValue[][]) => foldWith(false, ...invokes);

/** The ids of the reserved adk_request_* calls in a native stream (item 26's answer ids). */
function reservedCallIds(natives: JsonValue[]): string[] {
  const ids: string[] = [];
  for (const e of natives) {
    const parts = ((e as { content?: { parts?: unknown[] } }).content?.parts ?? []) as Array<{ functionCall?: { name?: string; id?: string } }>;
    for (const p of parts) {
      const name = p.functionCall?.name;
      if (typeof name === "string" && name.startsWith("adk_request_") && typeof p.functionCall?.id === "string") ids.push(p.functionCall.id);
    }
  }
  return [...new Set(ids)];
}

const terminals = (tagged: Tagged[]): Tagged[] => tagged.filter((t) => TERMINALS.has(t.ev.type));
const turnOf = (ev: AgEvent): string | undefined => (ev as { turnId?: string }).turnId;

/** Every opened turn has exactly one terminal, and no event targets a turn after it. */
function expectOneTerminalAndNothingAfter(tagged: Tagged[]): void {
  const opened = new Set(tagged.filter((t) => t.ev.type === "turn.start").map((t) => turnOf(t.ev)!));
  const closes = new Map<string, number>();
  for (const t of terminals(tagged)) closes.set(turnOf(t.ev)!, (closes.get(turnOf(t.ev)!) ?? 0) + 1);
  for (const id of opened) expect(closes.get(id), `turn ${id} terminals`).toBe(1);
  const closed = new Set<string>();
  for (const t of tagged) {
    const id = turnOf(t.ev);
    if (id !== undefined) expect(closed.has(id), `${t.ev.type} targets closed turn ${id}`).toBe(false);
    if (TERMINALS.has(t.ev.type) && id !== undefined) closed.add(id);
  }
}

type Outcome = { type?: string; asks?: unknown[] };
const outcomeOf = (ev: AgEvent): Outcome => ((ev as { outcome?: Outcome }).outcome ?? {});

const PAUSE = ["wf-pause", "plain-confirmation", "plain-credential", "plain-request-input", "wf-functionnode-credential"] as const;
/** Completed runs: turn.abort at flush on the legacy path; success from push() with the sentinel. */
const COMPLETED = ["wf-complete", "wf-terminal-llm", "wf-functionnode-only"] as const;
/** Truncated streams: never success (a host never feeds the sentinel after an abnormal end). */
const TRUNCATED = ["truncated-after-classify", "truncated-after-spike-final"] as const;
const ABORT_AT_FLUSH = [...COMPLETED, ...TRUNCATED] as const;
const SUCCESS = ["nodetool-in-llmagent"] as const;
const KNOWN_GAPS = ["known-gap-sequential-root", "known-gap-after-agent-callback"] as const;

describe("rd-06 P-RED: ADK pause / completion closure (§10 item 25, step-1 scope)", () => {
  it("the fixture set is complete (non-vacuity)", () => {
    const have = readdirSync(DIR).filter((f) => f.endsWith(".native.json")).map((f) => f.replace(".native.json", "")).sort();
    const want = [...PAUSE, ...ABORT_AT_FLUSH, ...SUCCESS, ...KNOWN_GAPS, "wf-pause-resume.invoke1", "wf-pause-resume.invoke2"].sort();
    expect(have).toEqual(want);
  });

  for (const name of PAUSE) {
    it(`${name}: closes paused from push(), one ask per pending request, no park`, () => {
      const { r, tagged } = fold(load(name));
      expect(r.needsResync).toBe(false);
      expectOneTerminalAndNothingAfter(tagged);
      const [term] = terminals(tagged);
      expect(term?.ev.type).toBe("turn.done");
      expect(term?.from).toBe("push");
      expect(outcomeOf(term!.ev).type).toBe("paused");
      expect((term!.ev as { finishReason?: string }).finishReason).toBe("paused");
      expect(outcomeOf(term!.ev).asks).toHaveLength(1);
      expect(tagged.filter((t) => t.ev.type === "hitl.ask")).toHaveLength(1);
      // item 26 answer-id rule: the ask is keyed by the reserved call's id.
      const natives = load(name);
      const ids = reservedCallIds(natives);
      expect(ids).toHaveLength(1);
      expect((outcomeOf(term!.ev).asks?.[0] as { toolCallId?: string }).toolCallId).toBe(ids[0]);
      // With the sentinel fed the pause still closes paused from push(), exactly once.
      const hc = foldWith(true, natives);
      expect(hc.r.needsResync).toBe(false);
      expectOneTerminalAndNothingAfter(hc.tagged);
      expect(outcomeOf(terminals(hc.tagged)[0]!.ev).type).toBe("paused");
    });
  }

  for (const name of COMPLETED) {
    it(`${name}: with the host-completion sentinel fed, closes success from push() (step 2, obligation 4)`, () => {
      const { r, tagged } = foldWith(true, load(name));
      expect(r.needsResync).toBe(false);
      expectOneTerminalAndNothingAfter(tagged);
      const [term] = terminals(tagged);
      expect(term?.ev.type).toBe("turn.done");
      expect(term?.from).toBe("push");
      expect(outcomeOf(term!.ev).type).toBe("success");
    });
  }

  for (const name of ABORT_AT_FLUSH) {
    it(`${name}: closes turn.abort from flush(), never success, no park`, () => {
      const { r, tagged } = fold(load(name));
      expect(r.needsResync).toBe(false);
      expectOneTerminalAndNothingAfter(tagged);
      const [term] = terminals(tagged);
      expect(term?.ev.type).toBe("turn.abort");
      expect(term?.from).toBe("flush");
      expect(tagged.some((t) => t.ev.type === "turn.done" && outcomeOf(t.ev).type === "success")).toBe(false);
    });
  }

  for (const name of SUCCESS) {
    it(`${name}: a plain LlmAgent run (nodeInfo from a NodeTool inside it) closes success, no park`, () => {
      const { r, tagged } = fold(load(name));
      expect(r.needsResync).toBe(false);
      expectOneTerminalAndNothingAfter(tagged);
      const [term] = terminals(tagged);
      expect(term?.ev.type).toBe("turn.done");
      expect(outcomeOf(term!.ev).type).toBe("success");
    });
  }

  it("wf-pause-resume: the pause and its resume (two invokes, two Normalizers) fold in ONE Reducer without parking", () => {
    const { r, tagged } = fold(load("wf-pause-resume.invoke1"), load("wf-pause-resume.invoke2"));
    expect(r.needsResync).toBe(false);
    expectOneTerminalAndNothingAfter(tagged);
    const terms = terminals(tagged);
    expect(terms.map((t) => [t.invoke, t.ev.type, t.from])).toEqual([
      [0, "turn.done", "push"],
      [1, "turn.abort", "flush"],
    ]);
    expect(outcomeOf(terms[0]!.ev).type).toBe("paused");
    expect(r.result().turns).toHaveLength(2);
  });

  for (const name of KNOWN_GAPS) {
    it(`KNOWN GAP on the legacy path (rd-06 PS-2): ${name} still parks without the host-completion opt-in`, () => {
      const { r, tagged } = fold(load(name));
      expect(r.needsResync).toBe(true);
      const [term] = terminals(tagged);
      expect(term?.ev.type).toBe("turn.done");
      expect(term?.from).toBe("push");
    });

    it(`${name}: FIXED on the opt-in path — with the sentinel fed it folds clean and closes success from push()`, () => {
      const { r, tagged } = foldWith(true, load(name));
      expect(r.needsResync).toBe(false);
      expectOneTerminalAndNothingAfter(tagged);
      const [term] = terminals(tagged);
      expect(term?.from).toBe("push");
      expect(outcomeOf(term!.ev).type).toBe("success");
    });
  }
});

describe("replay: the recorded host-completion marker (rd-06; draft.4 §8.0 host obligation 4)", () => {
  const marker = { type: HOST_COMPLETE_MARKER } as JsonValue;

  it("only a trailing marker line counts: it is split off and reported; a mid-stream one is left alone", () => {
    const events = load("wf-complete");
    expect(splitHostCompleteMarker([...events, marker])).toEqual({ native: events, hostCompleted: true });
    expect(splitHostCompleteMarker(events)).toEqual({ native: events, hostCompleted: false });
    const mid = [events[0]!, marker, ...events.slice(1)];
    expect(splitHostCompleteMarker(mid)).toEqual({ native: mid, hostCompleted: false });
    const extraKey = [...events, { type: HOST_COMPLETE_MARKER, at: 1 } as JsonValue];
    expect(splitHostCompleteMarker(extraKey).hostCompleted).toBe(false);
  });

  const adkGoldens = readdirSync(CORPUS).filter((d) => {
    try {
      readFileSync(join(CORPUS, d, "adk.native.json"));
      return true;
    } catch {
      return false;
    }
  });

  // Goldens whose run has NO in-band terminal, where the marker is what closes
  // it (rd-06 A.9 step 5 live captures): without it a completed Workflow
  // flushes turn.abort; with it the facet closes success from push(). Every
  // other ADK golden ends on an in-band close, which the marker leaves as is.
  const MARKER_CLOSES = new Set(["workflow-complete-gemini38"]);

  // The bare natives of a golden: a cassette captured since rd-06 A.9 step 5
  // records the marker itself (capture-cli sets hostCompletion for adk).
  const bareNatives = (d: string): { native: JsonValue[]; recorded: boolean } => {
    const split = splitHostCompleteMarker(
      JSON.parse(readFileSync(join(CORPUS, d, "adk.native.json"), "utf8")) as JsonValue[],
    );
    return { native: split.native, recorded: split.hostCompleted };
  };

  it(`the ADK goldens with an in-band close (${adkGoldens.length - MARKER_CLOSES.size} of ${adkGoldens.length}) replay byte-identically with and without a trailing marker (it drives the hostCompletion opt-in; the golden close is the same event at the same seq)`, async () => {
    expect(adkGoldens.length).toBeGreaterThan(0);
    for (const d of adkGoldens.filter((g) => !MARKER_CLOSES.has(g))) {
      const { native } = bareNatives(d);
      const plain = await replayNatives(native, "adk");
      const marked = await replayNatives([...native, marker], "adk");
      expect(marked.hostCompleted, d).toBe(true);
      expect(plain.hostCompleted, d).toBe(false);
      expect(JSON.stringify(marked.agjson), d).toBe(JSON.stringify(plain.agjson));
      expect(marked.report, d).toEqual(plain.report);
    }
  });

  it("a completed live Workflow closes success only with the marker (without it, the INV-FLUSH abort); its golden records the marker", async () => {
    for (const d of MARKER_CLOSES) {
      expect(adkGoldens, d).toContain(d);
      const { native, recorded } = bareNatives(d);
      expect(recorded, d).toBe(true);
      const plain = await replayNatives(native, "adk");
      const marked = await replayNatives([...native, marker], "adk");
      const closes = (agjson: JsonValue[]) =>
        agjson
          .map((e) => e as { type: string; outcome?: { type: string } })
          .filter((e) => e.type === "turn.done" || e.type === "turn.abort")
          .map((e) => (e.type === "turn.done" ? `done:${e.outcome?.type}` : "abort"));
      expect(closes(plain.agjson), d).toEqual(["abort"]);
      expect(closes(marked.agjson), d).toEqual(["done:success"]);
      // The census sees the difference too: the abort has no home for the
      // model's native finishReason "STOP"; the marker's success close maps it.
      expect(marked.report, d).toEqual({ drops: [], newFields: [] });
      expect([...new Set(plain.report.drops.map((x) => `${x.norm}=${String(x.value)}`))], d).toEqual([
        "[*].finishReason=STOP",
      ]);
      const golden = JSON.parse(readFileSync(join(CORPUS, d, "adk.agjson.json"), "utf8")) as JsonValue[];
      expect(JSON.stringify(marked.agjson), d).toBe(JSON.stringify(golden));
    }
  });
});
