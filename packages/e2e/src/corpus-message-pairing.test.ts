/**
 * SPEC §5.0 INV-MSG: every `message.start` is paired with exactly one `message.end`. Scanned over every committed
 * golden: per message id, each end closes an open start, no start is left open at the end of the stream, and a sealed
 * id starts again only after a `message.remove` of it (which un-seals it, so the later start opens a new pairing).
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Ev = { type?: string; id?: string };
type State = "open" | "sealed" | "removed";
const CORPUS = new URL("../corpus/", import.meta.url);

/** Every pairing violation in one stream, as `<index>:<what> <id>`. */
export function pairingViolations(events: Ev[]): string[] {
  const state = new Map<string, State>();
  const out: string[] = [];
  events.forEach((e, i) => {
    if (e.id === undefined) return;
    if (e.type === "message.start") {
      if (state.get(e.id) === "open") out.push(`${i}:start-while-open ${e.id}`);
      if (state.get(e.id) === "sealed") out.push(`${i}:start-after-seal ${e.id}`);
      state.set(e.id, "open");
    } else if (e.type === "message.end") {
      if (state.get(e.id) !== "open") out.push(`${i}:end-without-open-start ${e.id}`);
      state.set(e.id, "sealed");
    } else if (e.type === "message.remove") {
      // a removed message is un-sealed (INV-MSG); the remove-all sentinel removes every message it can name
      for (const id of e.id === "*" ? [...state.keys()] : [e.id]) if (state.get(id) !== "open") state.set(id, "removed");
    }
  });
  for (const [id, s] of state) if (s === "open") out.push(`end:never-ended ${id}`);
  return out;
}

const goldens = readdirSync(CORPUS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(new URL(`${d.name}/`, CORPUS)).filter((f) => f.endsWith(".agjson.json")).map((f) => `${d.name}/${f}`))
  .sort();

describe("INV-MSG over the corpus: every message.start pairs with exactly one message.end", () => {
  it("every golden pairs each message.start with exactly one message.end", () => {
    expect(goldens.length).toBeGreaterThan(50);
    let starts = 0;
    const bad: string[] = [];
    for (const g of goldens) {
      const events = JSON.parse(readFileSync(new URL(g, CORPUS), "utf8")) as Ev[];
      starts += events.filter((e) => e.type === "message.start").length;
      for (const v of pairingViolations(events)) bad.push(`${g} ${v}`);
    }
    expect(starts).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });

  it("the scan reports an unended start, a doubled end, an orphan end, a start over an open one and a restart after a seal", () => {
    const s = (id: string) => ({ type: "message.start", id });
    const e = (id: string) => ({ type: "message.end", id });
    expect(pairingViolations([s("m1"), e("m1"), s("m2"), e("m2")])).toEqual([]);
    expect(pairingViolations([s("m1"), e("m1"), { type: "message.remove", id: "m1" }, s("m1"), e("m1")])).toEqual([]);
    expect(pairingViolations([s("m1"), e("m1"), s("m1"), e("m1")])).toEqual(["2:start-after-seal m1"]);
    expect(pairingViolations([s("m1")])).toEqual(["end:never-ended m1"]);
    expect(pairingViolations([s("m1"), e("m1"), e("m1")])).toEqual(["2:end-without-open-start m1"]);
    expect(pairingViolations([e("m1")])).toEqual(["0:end-without-open-start m1"]);
    expect(pairingViolations([s("m1"), s("m1"), e("m1")])).toEqual(["1:start-while-open m1"]);
  });
});
