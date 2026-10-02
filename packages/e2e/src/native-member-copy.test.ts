/**
 * A JSON object can hold a member named `__proto__` as data (JSON.parse makes it an own member). Every corpus native
 * is given one, with an object value, on each of its objects at every depth, and replayed through its facet's real
 * normalizer: no emitted event, no wire form of one, and no folded result holds such a member or an object whose
 * prototype is not Object.prototype.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Reducer, toWire, type AgEvent, type JsonValue } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { createVercelNormalizer } from "@silverprotocol/vercel-ai";
import { HOST_COMPLETE_MARKER, inferFramework, splitHostCompleteMarker } from "./replay.js";

const CORPUS = new URL("../corpus/", import.meta.url);

/** `v` with a `__proto__` member (value `{ x: 1 }`) added to every object at every depth, as JSON.parse would make it. */
function withMemberEverywhere(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withMemberEverywhere);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = withMemberEverywhere(x);
    Object.defineProperty(out, "__proto__", { value: { x: 1 }, enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}

/** Every path that holds an own `__proto__` member, or an object whose prototype is not Object.prototype. */
function offenders(v: unknown, path = "", out: string[] = []): string[] {
  if (Array.isArray(v)) { v.forEach((x, i) => offenders(x, `${path}[${i}]`, out)); return out; }
  if (v !== null && typeof v === "object") {
    if (Object.hasOwn(v, "__proto__")) out.push(`${path} member`);
    if (Object.getPrototypeOf(v) !== Object.prototype) out.push(`${path} prototype`);
    for (const [k, x] of Object.entries(v)) offenders(x, `${path}.${k}`, out);
  }
  return out;
}

function drive(file: string, natives: JsonValue[]): AgEvent[] {
  const fw = inferFramework(file);
  const { native, hostCompleted } = splitHostCompleteMarker(natives);
  const n =
    fw === "openai" ? createOpenaiNormalizer({ invokeId: "openai" })
    : fw === "adk" ? createAdkNormalizer({ invokeId: "adk", ...(hostCompleted ? { hostCompletion: true } : {}) })
    : fw === "vercel" ? createVercelNormalizer({ invokeId: "vercel" })
    : createClaudeNormalizer({ invokeId: "claude" });
  const out: AgEvent[] = [];
  for (const e of withMemberEverywhere(native) as JsonValue[]) out.push(...n.push(e));
  if (hostCompleted && fw === "adk") out.push(...n.push({ type: HOST_COMPLETE_MARKER }));
  out.push(...n.flush());
  return out;
}

const natives = readdirSync(CORPUS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(new URL(`${d.name}/`, CORPUS)).filter((f) => f.endsWith(".native.json")).map((f) => `${d.name}/${f}`))
  .sort();

describe("facet events from natives whose objects each hold a member named __proto__", () => {
  it("hold no such member and no object with another prototype, as events, on the wire or folded", () => {
    expect(natives.length).toBeGreaterThan(50);
    const found: string[] = [];
    for (const file of natives) {
      const events = drive(file, JSON.parse(readFileSync(new URL(file, CORPUS), "utf8")) as JsonValue[]);
      const at = (p: string) => { const i = Number(/^\[(\d+)\]/.exec(p)?.[1]); return `${events[i]?.type ?? "?"}${p.replace(/^\[\d+\]/, "")}`; };
      for (const p of offenders(events)) found.push(`${file} event ${at(p)}`);
      for (const p of offenders(events.map((e) => toWire(e)))) found.push(`${file} wire ${at(p)}`);
      const r = new Reducer();
      for (const e of events) r.push(e);
      for (const p of offenders(r.result())) found.push(`${file} folded ${p}`);
    }
    expect(found).toEqual([]);
    expect(({} as { x?: unknown }).x).toBeUndefined();
  }, 120_000);
});
