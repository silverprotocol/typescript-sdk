/**
 * Every recorded native and every engine-built fixture, through its facet:
 * after the host mutates the natives it pushed (every object gains a member,
 * every array an element), the events the facet already returned serialize
 * exactly as before. An emitted event shares no object with a pushed native.
 * claude-agent-sdk, openai-agents and google-adk get that from withAtomicPush,
 * which hands the inner a copy taken before it sees the native; vercel-ai
 * copies each carried value itself (safeJson: structuredClone of
 * toJsonValueSafe).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgEvent } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { createVercelNormalizer } from "@silverprotocol/vercel-ai";

type Fw = "claude" | "openai" | "adk" | "vercel";
const MARK = "__host_complete__";
const ROOT = join(import.meta.dirname, "..");
const make = (fw: Fw, hostCompletion: boolean) =>
  fw === "claude" ? createClaudeNormalizer({ invokeId: fw })
  : fw === "openai" ? createOpenaiNormalizer({ invokeId: fw })
  : fw === "vercel" ? createVercelNormalizer({ invokeId: fw })
  : createAdkNormalizer({ invokeId: fw, ...(hostCompletion ? { hostCompletion: true } : {}) });

const mutateDeep = (v: unknown, seen = new Set<object>()): void => {
  if (v === null || typeof v !== "object" || seen.has(v)) return;
  seen.add(v);
  if (Array.isArray(v)) {
    for (const x of v) mutateDeep(x, seen);
    v.push("MUTATED");
    return;
  }
  for (const k of Object.keys(v)) mutateDeep((v as Record<string, unknown>)[k], seen);
  (v as Record<string, unknown>)["__mutated__"] = 1;
};

type Input = { name: string; fw: Fw; path: string };
const inputs: Input[] = [];
for (const d of readdirSync(join(ROOT, "corpus"))) {
  const p = join(ROOT, "corpus", d);
  if (!statSync(p).isDirectory()) continue;
  for (const f of readdirSync(p)) {
    const m = /^(claude|openai|adk|vercel)\.native\.json$/.exec(f);
    if (m) inputs.push({ name: `corpus/${d}/${f}`, fw: m[1] as Fw, path: join(p, f) });
  }
}
for (const d of readdirSync(join(ROOT, "fixtures"))) {
  const fw: Fw | undefined = d.startsWith("adk") ? "adk" : d.startsWith("openai") ? "openai" : undefined;
  if (fw === undefined) continue;
  for (const f of readdirSync(join(ROOT, "fixtures", d))) {
    if (f.endsWith(".native.json")) inputs.push({ name: `fixtures/${d}/${f}`, fw, path: join(ROOT, "fixtures", d, f) });
  }
}

describe("an emitted event shares no object with a pushed native (mutate after push)", () => {
  it("covers all four facets, the corpus and the engine fixtures", () => {
    expect(new Set(inputs.map((i) => i.fw))).toEqual(new Set(["claude", "openai", "adk", "vercel"]));
    expect(inputs.filter((i) => i.name.startsWith("corpus/")).length).toBeGreaterThanOrEqual(81);
    expect(inputs.some((i) => i.name.startsWith("fixtures/"))).toBe(true);
  });

  for (const fw of ["claude", "openai", "adk", "vercel"] as const) {
    it(`${fw}: no already-returned event changes when the host mutates its natives`, () => {
      const changed: string[] = [];
      for (const input of inputs.filter((i) => i.fw === fw)) {
        for (const hostCompletion of fw === "adk" ? [false, true] : [false]) {
          const all = JSON.parse(readFileSync(input.path, "utf8")) as unknown[];
          const last = all[all.length - 1] as { type?: unknown } | undefined;
          const natives = last?.type === MARK ? all.slice(0, -1) : all;
          const n = make(fw, hostCompletion);
          const evs: AgEvent[] = [];
          for (const native of natives) evs.push(...n.push(native));
          if (hostCompletion) evs.push(...n.push({ type: MARK }));
          evs.push(...n.flush());
          const before = JSON.stringify(evs);
          for (const native of natives) mutateDeep(native);
          if (JSON.stringify(evs) !== before) changed.push(`${input.name}${hostCompletion ? " [host-completed]" : ""}`);
        }
      }
      expect(changed).toEqual([]);
    });
  }
});
