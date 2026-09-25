/**
 * persist.corpus.test.ts — toPersistable over the recorded corpus: for every
 * committed golden, the persistable projection of its fold deep-equals the
 * fold with every turn record's `displayRequired` and every non-thread memory
 * record omitted (no scope declared), and the fold itself is left untouched.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ingestAgEvents, reduce, toPersistable, type JsonValue } from "@silverprotocol/core";

const CORPUS = join(import.meta.dirname, "..", "corpus");

describe("toPersistable over the recorded corpus", () => {
  it("every golden's fold projects to itself minus displayRequired, and the fold is not mutated", () => {
    let goldens = 0;
    let turns = 0;
    let withDisplay = 0;
    for (const d of readdirSync(CORPUS)) {
      for (const f of readdirSync(join(CORPUS, d)).filter((x) => x.endsWith(".agjson.json"))) {
        const events = JSON.parse(readFileSync(join(CORPUS, d, f), "utf8")) as JsonValue[];
        const { result } = reduce(ingestAgEvents(events));
        const before = JSON.stringify(result);
        const expected = {
          ...result,
          // No memoryScopes declared: only scope `thread` memory is kept (draft.6).
          memory: result.memory.filter((m) => m.scope === "thread"),
          turns: result.turns.map((t) => {
            const { displayRequired, ...rest } = t;
            if (displayRequired !== undefined) withDisplay++;
            return rest;
          }),
        };
        expect(isDeepStrictEqual(toPersistable(result), expected), `${d}/${f}`).toBe(true);
        expect(JSON.stringify(result), `${d}/${f} fold mutated`).toBe(before);
        goldens++;
        turns += result.turns.length;
      }
    }
    expect(goldens).toBeGreaterThanOrEqual(58);
    expect(turns).toBeGreaterThan(goldens);
    console.info(`persist sweep: ${goldens} goldens, ${turns} turn records, ${withDisplay} with displayRequired`);
  });
});
