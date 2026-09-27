/**
 * Engine fixtures for the google-adk text-window oracle (adk-oracle.test.ts): real @google/adk runners (the version
 * packages/e2e pins) over scripted transports, no key and no network (adk-oracle/engine.ts, adk-oracle/legs.ts).
 * Each leg-mode writes fixtures/adk-oracle/<leg>.<mode>.native.json (the events the runner yielded) and
 * <leg>.<mode>.oracle.json (the text each model call, remote window or Live turn was meant to produce, its source,
 * and the readings).
 *
 * Never part of the gate:
 *   GEN_ADK_ORACLE=1      regenerate the fixtures (then re-stamp the expectations: see adk-oracle.test.ts)
 *   GEN_ADK_ORACLE=check  regenerate into .tmp/adk-oracle-check/ and compare every fold's record with the committed
 *                         fixtures' (natives differ by their random ids; the records must not), e.g. after an ADK bump
 *   npx vitest run --config ../../vitest.config.ts src/adk-oracle-fixtures.gen.test.ts   (from packages/e2e)
 *
 * Relay customMetadata entries are reduced to what the fold needs, by one allowlist (RELAY_KEEP): `a2a:response`
 * keeps `kind` and an artifact's `artifactId` (the relay stream a facet window rule keys on), the task and context
 * ids stay, and any other relay entry keeps no member. A written native is refused if an entry holds more.
 *
 * Not a leg: two open windows of one author and path that differ only by branch, closed by an event without one.
 * No ADK 2.1 runner yields it (ParallelAgent branches are different authors, NodeTool calls run one after the other
 * and their errors carry the branch, and dynamic runNode windows differ by path); the facet's unit tests cover it.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Mapped } from "./adk-oracle/legs.js";
import { scoreLeg, type FoldRecord, type Oracle } from "./adk-oracle/oracle.js";
import { redactNative } from "./redact.js";
import type { JsonValue } from "@silverprotocol/core";

// The engine and the legs load @google/adk; they are imported only when a generation runs, never in the gate.
const engine = () => Promise.all([import("./adk-oracle/engine.js"), import("./adk-oracle/legs.js")]);

const FIXTURES = new URL("../fixtures/adk-oracle/", import.meta.url);
const CHECK = new URL("../.tmp/adk-oracle-check/", import.meta.url);
const MODE = process.env["GEN_ADK_ORACLE"];

/** What each relay customMetadata entry keeps: member paths, or every member (the ids). Any other `a2a:` entry
 *  keeps none. */
const RELAY_KEEP: Record<string, readonly string[] | "all"> = { "a2a:response": ["kind", "artifact.artifactId"], "a2a:task_id": "all", "a2a:context_id": "all" };
const pick = (v: unknown, paths: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const keys = path.split(".");
    let src: unknown = v;
    for (const k of keys) src = src && typeof src === "object" ? (src as Record<string, unknown>)[k] : undefined;
    if (src === undefined) continue;
    let dst = out;
    keys.slice(0, -1).forEach((k) => { dst = (dst[k] ??= {}) as Record<string, unknown>; });
    dst[keys[keys.length - 1]!] = src;
  }
  return out;
};
/** Relay customMetadata entries reduced to what the fold needs (RELAY_KEEP). */
function reduceRelayEntries(natives: Record<string, unknown>[]): Record<string, unknown>[] {
  return natives.map((ev) => {
    const cm = ev["customMetadata"];
    if (!cm || typeof cm !== "object" || Array.isArray(cm)) return ev;
    const out: Record<string, unknown> = { ...(cm as Record<string, unknown>) };
    for (const [k, v] of Object.entries(out)) if (k.startsWith("a2a:") && RELAY_KEEP[k] !== "all") out[k] = pick(v, (RELAY_KEEP[k] as readonly string[] | undefined) ?? []);
    return { ...ev, customMetadata: out };
  });
}
/** true when every relay entry of every native holds only what RELAY_KEEP lets it keep. */
const relayEntriesReduced = (natives: Record<string, unknown>[]): boolean =>
  natives.every((ev) => Object.entries((ev["customMetadata"] ?? {}) as Record<string, unknown>).every(([k, v]) => !k.startsWith("a2a:") || RELAY_KEEP[k] === "all" || JSON.stringify(v) === JSON.stringify(pick(v, (RELAY_KEEP[k] as readonly string[] | undefined) ?? []))));

async function generate(dir: URL): Promise<string[]> {
  const [{ capture, mapCalls, state, unitsOf }, { LEGS }] = await engine();
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const leg of LEGS) {
    for (const mode of leg.modes) {
      state.tag = leg.tag !== false;
      const built = leg.build(mode);
      const r = built.capture ? await built.capture() : await capture(built.root!, { mode: mode === "none" ? "none" : "sse", progressive: mode === "prog", plugins: built.plugins ?? [] });
      const mapped: Mapped[] = built.mapped ? built.mapped(r) : mapCalls(r.natives, r.calls);
      const base = unitsOf(mapped);
      const raw = leg.units ? leg.units(base, mapped, mode, r) : base;
      const alt = leg.readings ? leg.readings.transform(raw, mapped, mode, r) : null;
      const oracle: Oracle & Record<string, unknown> = {
        leg: leg.id, mode, hcOnly: !!leg.hcOnly, ...(leg.residual ? { residual: leg.residual } : {}), threw: r.thrown,
        note: [leg.note, leg.readings?.note].filter(Boolean).join("; ") || null,
        expected: leg.readings?.expected ?? "raw", readings: { raw, ...(alt ? { callback: alt } : {}) },
        ...(r.stripped.length ? { stripped: r.stripped } : {}),
        calls: mapped.map(({ call, agent, source, firstNative, segments, threw, cut, planned, connection }) => ({ call, agent, source, firstNative, segments, threw, ...(cut ? { cut, planned } : {}), ...(connection !== undefined ? { connection } : {}) })),
      };
      // Scrubbed as every committed native is (redact.ts): a Live resumption handle, even a scripted one, is written REDACTED.
      const reduced = reduceRelayEntries(r.natives);
      if (!relayEntriesReduced(reduced)) throw new Error(`${leg.id}.${mode}: a relay customMetadata entry holds more than RELAY_KEEP lets it keep`);
      const natives = JSON.stringify(redactNative(reduced as unknown as JsonValue), null, 1) + "\n";
      if (natives.includes("__oracle")) throw new Error(`${leg.id}.${mode}: an oracle tag survived in the natives`);
      for (const local of [homedir(), process.cwd()]) if (natives.includes(local)) throw new Error(`${leg.id}.${mode}: a native carries a local path`);
      writeFileSync(new URL(`${leg.id}.${mode}.native.json`, dir), natives);
      writeFileSync(new URL(`${leg.id}.${mode}.oracle.json`, dir), JSON.stringify(oracle, null, 1) + "\n");
      written.push(`${leg.id}.${mode}`);
    }
  }
  return written;
}

function records(dir: URL): Record<string, FoldRecord> {
  const out: Record<string, FoldRecord> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".oracle.json")).sort()) {
    const o = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as Oracle;
    const natives = JSON.parse(readFileSync(new URL(f.replace(".oracle.json", ".native.json"), dir), "utf8")) as unknown[];
    const { bare, hc } = scoreLeg(o, natives);
    out[`${o.leg}.${o.mode}.bare`] = bare;
    out[`${o.leg}.${o.mode}.hc`] = hc;
  }
  return out;
}

describe.runIf(MODE === "1")("google-adk oracle fixture generation (real @google/adk, scripted transports)", () => {
  it("writes every leg-mode's natives and oracle sidecar", async () => {
    for (const f of readdirSync(FIXTURES, { withFileTypes: true })) if (f.isFile() && /\.(native|oracle)\.json$/.test(f.name)) rmSync(new URL(f.name, FIXTURES));
    const written = await generate(FIXTURES);
    const [, { LEGS }] = await engine();
    expect(written.length).toBe(LEGS.reduce((a, l) => a + l.modes.length, 0));
  }, 600_000);
});

describe.runIf(MODE === "check")("google-adk oracle fixtures, regenerated (records compared, not bytes)", () => {
  it("a fresh generation scores every fold exactly as the committed fixtures do", async () => {
    rmSync(CHECK, { recursive: true, force: true });
    await generate(CHECK);
    const committed = records(FIXTURES);
    const fresh = records(CHECK);
    const diff = Object.keys({ ...committed, ...fresh }).filter((k) => JSON.stringify(committed[k]) !== JSON.stringify(fresh[k]));
    expect(diff, diff.map((k) => `${k}: ${JSON.stringify(committed[k])} → ${JSON.stringify(fresh[k])}`).join("\n")).toEqual([]);
  }, 600_000);
});
