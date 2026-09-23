/**
 * isolation.corpus.test.ts — store-time isolation of the reference Reducer over
 * the recorded corpus: for every committed golden and every event in it, a
 * host that mutates that event in place right after push() (adds a key to
 * every object at every depth, appends to every array) leaves result()
 * unchanged. push() folds its own copy of the event; result() clones on the
 * way out.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgEvent, ingestAgEvents, Reducer, type JsonValue } from "@silverprotocol/core";

const CORPUS = join(import.meta.dirname, "..", "corpus");

/** Mutate every container of `v` in place: a new key on each object, a new element on each array. */
function mutateDeep(v: unknown): void {
  if (Array.isArray(v)) {
    for (const x of v) mutateDeep(x);
    v.push("zz-host-mutation");
    return;
  }
  if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v)) mutateDeep((v as Record<string, unknown>)[k]);
    (v as Record<string, unknown>)["zz-host-mutation"] = 1;
  }
}

describe("store-time isolation over the recorded corpus", () => {
  it("mutating any pushed event after push() never moves the fold", () => {
    const moved: string[] = [];
    let goldens = 0;
    let checked = 0;
    for (const d of readdirSync(CORPUS).sort()) {
      for (const f of readdirSync(join(CORPUS, d)).filter((x) => x.endsWith(".agjson.json")).sort()) {
        const events = ingestAgEvents(JSON.parse(readFileSync(join(CORPUS, d, f), "utf8")) as JsonValue[]) as AgEvent[];
        const base = new Reducer();
        for (const ev of structuredClone(events)) base.push(ev);
        const want = JSON.stringify(base.result());
        for (let i = 0; i < events.length; i++) {
          const evs = structuredClone(events);
          const r = new Reducer();
          for (let j = 0; j < evs.length; j++) {
            r.push(evs[j]!);
            if (j === i) mutateDeep(evs[j]);
          }
          if (JSON.stringify(r.result()) !== want) moved.push(`${d}/${f} #${i} ${evs[i]!.type}`);
          checked++;
        }
        goldens++;
      }
    }
    expect(moved).toEqual([]);
    // Non-vacuity: the whole corpus was walked.
    expect(goldens).toBeGreaterThanOrEqual(58);
    expect(checked).toBeGreaterThan(1000);
  });
});
