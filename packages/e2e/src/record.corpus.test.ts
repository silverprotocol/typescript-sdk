/**
 * record.corpus.test.ts — the stored-record readers over the recorded corpus
 * (draft.4 §0.2, workspace#20 decision 6; §10 item N record leg, check 8):
 * every message and memory record folded from every committed golden,
 * stored as JSON, reads back deep-equal with ZERO reports.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ingestAgEvents, readStoredAgMemoryRecords, readStoredAgMessages, reduce, type JsonValue } from "@silverprotocol/core";

const CORPUS = join(import.meta.dirname, "..", "corpus");

describe("stored-record readers over the recorded corpus", () => {
  it("every folded message and memory record reads back unchanged, with no report", () => {
    let goldens = 0;
    let messages = 0;
    let blocks = 0;
    let memory = 0;
    for (const d of readdirSync(CORPUS)) {
      for (const f of readdirSync(join(CORPUS, d)).filter((x) => x.endsWith(".agjson.json"))) {
        const events = JSON.parse(readFileSync(join(CORPUS, d, f), "utf8")) as JsonValue[];
        const { result } = reduce(ingestAgEvents(events));
        const stored = JSON.parse(JSON.stringify(result)) as { messages: JsonValue[]; memory: JsonValue[] };
        const m = readStoredAgMessages(stored.messages);
        expect(m.reports, `${d}/${f} messages`).toEqual([]);
        expect(isDeepStrictEqual(m.value, stored.messages), `${d}/${f} messages`).toBe(true);
        const r = readStoredAgMemoryRecords(stored.memory);
        expect(r.reports, `${d}/${f} memory`).toEqual([]);
        expect(isDeepStrictEqual(r.value, stored.memory), `${d}/${f} memory`).toBe(true);
        goldens++;
        messages += m.value.length;
        blocks += m.value.reduce((n, x) => n + x.content.length, 0);
        memory += r.value.length;
      }
    }
    expect(goldens).toBeGreaterThanOrEqual(58);
    expect(messages).toBeGreaterThan(100);
    expect(blocks).toBeGreaterThan(messages);
    console.info(`record sweep: ${goldens} goldens, ${messages} messages, ${blocks} blocks, ${memory} memory records`);
  });
});
