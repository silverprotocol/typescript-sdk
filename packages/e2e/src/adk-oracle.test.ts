/**
 * The google-adk text-window oracle gate. Every fixture in fixtures/adk-oracle is an engine-built native stream
 * (real @google/adk runners over scripted transports, adk-oracle-fixtures.gen.test.ts) with a sidecar naming the
 * text each model call, remote window or Live turn was meant to produce. Each is folded through the facet and core,
 * bare and with host completion, and scored (adk-oracle/oracle.ts).
 *
 * The gate records ground truth and ratchets both ways: fixtures/adk-oracle/expected.json holds every fold's
 * record (verdict, OVER / UNDER, park, the unit diff when not a match, and the known defects as such), and any fold
 * whose record moves fails: a WORSE fold, and a BETTER one as stale, until the expectations are re-stamped with
 *
 *   ADK_ORACLE_WRITE=1 npx vitest run --config ../../vitest.config.ts src/adk-oracle.test.ts   (from packages/e2e)
 *
 * so the expectations diff states every fold a change moves.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { match, moves, scoreLeg, type FoldRecord, type Oracle, type Unit } from "./adk-oracle/oracle.js";

const DIR = new URL("../fixtures/adk-oracle/", import.meta.url);
const EXPECTED = new URL("expected.json", DIR);
const WRITE_CMD = "ADK_ORACLE_WRITE=1 npx vitest run --config ../../vitest.config.ts src/adk-oracle.test.ts (from packages/e2e)";

function scoreAll(): Record<string, FoldRecord> {
  const out: Record<string, FoldRecord> = {};
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".oracle.json")).sort()) {
    const o = JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as Oracle;
    const natives = JSON.parse(readFileSync(new URL(f.replace(".oracle.json", ".native.json"), DIR), "utf8")) as unknown[];
    const { bare, hc } = scoreLeg(o, natives);
    out[`${o.leg}.${o.mode}.bare`] = bare;
    out[`${o.leg}.${o.mode}.hc`] = hc;
  }
  return out;
}

describe("google-adk text-window oracle (engine fixtures, ground truth per model call)", () => {
  it("every fold's record equals fixtures/adk-oracle/expected.json (a WORSE or a stale BETTER fold fails until re-stamped)", () => {
    const now = scoreAll();
    if (process.env["ADK_ORACLE_WRITE"] === "1") {
      writeFileSync(EXPECTED, JSON.stringify(now, null, 1) + "\n");
      return;
    }
    const was = JSON.parse(readFileSync(EXPECTED, "utf8")) as Record<string, FoldRecord>;
    const lines: string[] = [];
    for (const k of Object.keys(now)) {
      const m = moves(was[k], now[k]!);
      if (m) lines.push(`${m.direction.padEnd(7)} ${k}: ${m.detail}`);
    }
    for (const k of Object.keys(was)) if (!(k in now)) lines.push(`GONE    ${k}`);
    expect(lines, lines.length ? `${lines.length} fold(s) moved; if intended, re-stamp and put the expectations diff in the receipt:\n  ${WRITE_CMD}\n${lines.join("\n")}` : "").toEqual([]);
  });

  it("the expectations name no fold as clean unless it matches with no park, and a bare fold is by design only when its host-completed twin is clean", () => {
    const was = JSON.parse(readFileSync(EXPECTED, "utf8")) as Record<string, FoldRecord>;
    for (const [k, r] of Object.entries(was)) {
      const clean = r.verdict === "MATCH" && !r.park;
      expect(r.status === "clean", k).toBe(clean);
      if (r.status === "by-design") {
        expect(k.endsWith(".bare"), k).toBe(true);
        expect(was[k.replace(/\.bare$/, ".hc")]?.status, `${k}: its host-completed twin`).toBe("clean");
      }
    }
  });
});

describe("the oracle's match and move rules", () => {
  const u = (text: string, source = "a"): Unit => ({ source, call: 0, seg: 0, text });

  it("match: a block may start a later unit of its source, charging the rest of the unit it leaves as UNDER", () => {
    expect(match(["Hel", "World"], [u("Hello"), u("World")])).toEqual({ over: 0, under: 2 });
    expect(match(["Hello", "World"], [u("Hello"), u("World")])).toEqual({ over: 0, under: 0 });
    expect(match(["World", "Hello"], [u("Hello"), u("World")])).toEqual({ over: 5, under: 5 });
    expect(match(["B", "A"], [u("A", "x"), u("B", "y")])).toEqual({ over: 0, under: 0 });
  });

  it("moves: a park gained is WORSE whatever else moved, opposite moves are MIXED, a status or block change alone is CHANGED", () => {
    const r = (over: number, under: number, park: boolean, extra: Partial<FoldRecord> = {}): FoldRecord => ({ verdict: over || under ? "OVER" : "MATCH", over, under, park, status: "known-defect", ...extra });
    expect(moves(r(5, 0, false), r(0, 0, true))?.direction).toBe("WORSE");
    expect(moves(r(0, 5, false), r(3, 0, false))?.direction).toBe("MIXED");
    expect(moves(r(0, 0, true), r(0, 0, false))?.direction).toBe("BETTER");
    expect(moves(r(4, 0, false), r(2, 0, false))?.direction).toBe("BETTER");
    expect(moves(r(0, 0, false), r(2, 0, false))?.direction).toBe("WORSE");
    expect(moves(r(0, 0, false, { blocks: ["a"] }), r(0, 0, false, { blocks: ["a", "b"] }))).toEqual({ direction: "CHANGED", detail: "blocks 1→2" });
    expect(moves(r(0, 0, false, { status: "by-design" }), r(0, 0, false))).toEqual({ direction: "CHANGED", detail: "status by-design→known-defect" });
    expect(moves(r(1, 1, false), r(1, 1, false))).toBeNull();
  });
});
