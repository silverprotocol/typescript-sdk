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
 * NOT asserted here (step 2 scope): the answer-id rule for asks, the
 * credential → auth / confirmation → approval family, and the sentinel-fed
 * success close. KNOWN GAPS pinned as they behave today: a SequentialAgent root
 * and afterAgentCallback content (rd-06 PS-2). Flip those pins when step 2's
 * host-completion opt-in lands.
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

/** One Normalizer per invoke; every invoke folds into ONE Reducer. */
function fold(...invokes: JsonValue[][]): { r: Reducer; tagged: Tagged[] } {
  const r = new Reducer();
  const tagged: Tagged[] = [];
  invokes.forEach((natives, invoke) => {
    const n = createAdkNormalizer();
    for (const f of natives) for (const ev of n.push(f)) tagged.push({ ev, from: "push", invoke });
    for (const ev of n.flush()) tagged.push({ ev, from: "flush", invoke });
  });
  for (const t of tagged) r.push(t.ev);
  return { r, tagged };
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

const PAUSE = ["wf-pause", "plain-confirmation", "plain-credential", "plain-request-input"] as const;
const ABORT_AT_FLUSH = [
  "wf-complete",
  "wf-terminal-llm",
  "wf-functionnode-only",
  "wf-functionnode-credential",
  "truncated-after-classify",
  "truncated-after-spike-final",
] as const;
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
    it(`KNOWN GAP (rd-06 PS-2, step 2 fixes it): ${name} parks today — flip this pin when the host-completion opt-in lands`, () => {
      const { r, tagged } = fold(load(name));
      expect(r.needsResync).toBe(true);
      const [term] = terminals(tagged);
      expect(term?.ev.type).toBe("turn.done");
      expect(term?.from).toBe("push");
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

  it(`all ${adkGoldens.length} ADK goldens replay byte-identically with and without a trailing marker (it never reaches the facet)`, async () => {
    expect(adkGoldens.length).toBeGreaterThan(0);
    for (const d of adkGoldens) {
      const native = JSON.parse(readFileSync(join(CORPUS, d, "adk.native.json"), "utf8")) as JsonValue[];
      const plain = await replayNatives(native, "adk");
      const marked = await replayNatives([...native, marker], "adk");
      expect(marked.hostCompleted, d).toBe(true);
      expect(plain.hostCompleted, d).toBe(false);
      expect(JSON.stringify(marked.agjson), d).toBe(JSON.stringify(plain.agjson));
      expect(marked.report, d).toEqual(plain.report);
    }
  });
});
