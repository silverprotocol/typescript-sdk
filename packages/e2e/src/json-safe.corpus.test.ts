/**
 * json-safe.corpus.test.ts — the serialized identity proof for core's
 * toJsonValueSafe over the whole committed corpus.
 *
 * Facets call toJsonValueSafe once, on the whole native, at push() entry. Every
 * committed cassette was recorded through JSON, so every native must already
 * be plain JSON: isJsonValue answers true, and toJsonValueSafe returns the
 * SAME reference. That makes the push()-entry call a no-op on replay, so no
 * golden can move because of it.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isJsonValue, toJsonValue, toJsonValueSafe, type JsonValue } from "@silverprotocol/core";

const E2E = join(import.meta.dirname, "..");
function natives(): Array<[string, JsonValue[]]> {
  const out: Array<[string, JsonValue[]]> = [];
  for (const d of readdirSync(join(E2E, "corpus"))) {
    for (const f of readdirSync(join(E2E, "corpus", d)).filter((x) => x.endsWith(".native.json"))) {
      out.push([`corpus/${d}/${f}`, JSON.parse(readFileSync(join(E2E, "corpus", d, f), "utf8")) as JsonValue[]]);
    }
  }
  const fx = join(E2E, "fixtures", "adk-pause");
  if (existsSync(fx)) {
    for (const f of readdirSync(fx).filter((x) => x.endsWith(".native.json"))) {
      out.push([`fixtures/adk-pause/${f}`, JSON.parse(readFileSync(join(fx, f), "utf8")) as JsonValue[]]);
    }
  }
  return out;
}

describe("toJsonValueSafe over every committed native (identity: the push()-entry call is a replay no-op)", () => {
  const all = natives();
  it("finds the corpus", () => {
    expect(all.length).toBeGreaterThanOrEqual(70);
  });
  it("every native event is plain JSON and comes back by identity, serializing as its JSON round trip", () => {
    let events = 0;
    for (const [name, list] of all) {
      for (const [i, ev] of list.entries()) {
        events++;
        expect(isJsonValue(ev), `${name}[${i}]`).toBe(true);
        expect(toJsonValueSafe(ev), `${name}[${i}]`).toBe(ev);
      }
      expect(JSON.stringify(toJsonValueSafe(list))).toBe(JSON.stringify(toJsonValue(list)));
    }
    expect(events).toBeGreaterThanOrEqual(1400);
  });
});
