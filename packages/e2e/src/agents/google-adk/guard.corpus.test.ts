/**
 * The google-adk facet's atomic push() over every committed ADK native (corpus
 * goldens and the adk-pause fixtures):
 * - the last-resort report (a core `error` with the message
 *   "normalizer error") never fires on a real stream;
 * - differential: inserting a native that cannot be mapped at ANY position of
 *   a real stream yields that stream's own output, byte for byte, plus one
 *   error at that position with seq contiguous. That exercises the rebuild
 *   (every accepted native re-driven silently) at every prefix, so it also
 *   pins that the facet is deterministic; the clock and the random source
 *   are made to throw while it runs, so any future use of either fails here.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgEvent, JsonValue } from "@silverprotocol/core";
import { createAdkNormalizer } from "@silverprotocol/google-adk";

const E2E = join(import.meta.dirname, "..", "..", "..");

function streams(): [string, JsonValue[]][] {
  const out: [string, JsonValue[]][] = [];
  for (const d of readdirSync(join(E2E, "corpus"))) {
    const f = join(E2E, "corpus", d, "adk.native.json");
    if (existsSync(f)) out.push([d, JSON.parse(readFileSync(f, "utf8")) as JsonValue[]]);
  }
  const fx = join(E2E, "fixtures", "adk-pause");
  if (existsSync(fx))
    for (const f of readdirSync(fx))
      if (f.endsWith(".native.json")) out.push([f, JSON.parse(readFileSync(join(fx, f), "utf8")) as JsonValue[]]);
  return out;
}

function run(natives: JsonValue[]): AgEvent[] {
  const n = createAdkNormalizer();
  const out: AgEvent[] = [];
  for (const x of natives) out.push(...n.push(x));
  out.push(...n.flush());
  return out;
}

/** An event whose envelope is valid but whose parts are not a list. */
const bad = (invocationId: unknown): JsonValue => ({
  invocationId: typeof invocationId === "string" ? invocationId : "inv_bad",
  content: { role: "model", parts: 1 },
});

describe("google-adk atomic push() over the committed ADK natives", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("the facet must not read the clock");
    });
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("the facet must not read a random source");
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("the last-resort report fires zero times", () => {
    const all = streams();
    expect(all.length).toBeGreaterThan(15);
    const fired = all.filter(([, natives]) =>
      run(natives).some((e) => e.type === "error" && (e as { message?: string }).message === "normalizer error"),
    );
    expect(fired.map(([name]) => name)).toEqual([]);
  });

  it("a failing native inserted at every position: the stream's own output plus one error there, seq contiguous", () => {
    let positions = 0;
    for (const [name, natives] of streams()) {
      const baseline = JSON.stringify(run(natives));
      const inv = (natives.find((x) => typeof x === "object" && x !== null && !Array.isArray(x) && typeof (x as { invocationId?: unknown }).invocationId === "string") as { invocationId?: string } | undefined)?.invocationId;
      for (let k = 0; k <= natives.length; k++) {
        positions++;
        const out = run([...natives.slice(0, k), bad(inv), ...natives.slice(k)]);
        expect(out.map((e) => e.seq), `${name}@${k}`).toEqual(out.map((_, i) => i));
        const errs = out.filter((e) => e.type === "error");
        expect(errs, `${name}@${k}`).toHaveLength(1);
        expect(errs[0]).toMatchObject({ message: "normalizer error", code: "TypeError" });
        const stripped = out.filter((e) => e.type !== "error").map((e, i) => ({ ...e, seq: i }));
        expect(JSON.stringify(stripped), `${name}@${k}`).toBe(baseline);
      }
    }
    expect(positions).toBeGreaterThan(100);
  });
});
