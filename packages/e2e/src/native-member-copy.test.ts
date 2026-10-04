/**
 * A JSON object can hold a member named `__proto__` as data (JSON.parse makes it an own member). Every corpus native
 * is given one, with an object value, on each of its objects at every depth, and replayed through its facet's real
 * normalizer: no emitted event, no wire form of one, and no folded result holds such a member or an object whose
 * prototype is not Object.prototype. The engine-built google-adk natives under fixtures/adk-error and
 * fixtures/adk-oracle are replayed the same way, each bare and with host completion, as they reach paths the corpus
 * does not (a relay's remote events among them). Each of their events that carries relay entries in its customMetadata
 * is also replayed without its content and invocationId, as a native the facet does not recognize and so carries
 * whole (no engine yields one; the carry rebuilds the native without those entries).
 *
 * Each corpus native is also replayed with the member planted once per value kind (object, null, array, primitive)
 * beside a sibling, inside JSON text a native string holds as well, against a control that plants the sibling alone:
 * the events hold no member, keep the event-type sequence, equal the control's (JSON text compared after parse, less
 * the member; one claude-facet divergence is named where it is counted), and carry the sibling. A runtime check verifies that an assigning copy would
 * select a prototype here and that no facet's does. Each native rebuilt with null-prototype objects, and as class
 * instances, replays to ordinary objects equal to the plain native's. No facet's native holds a JSON Patch operation,
 * so a path-token leg has no native to plant.
 *
 * Not every copy is reachable from a native: a host-made usage on openai-agents' host error, vercel-ai's step stop
 * details and an object error's message text occur in no corpus native, so this test does not cover them; their own
 * packages' tests do.
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
const FIXTURES = new URL("../fixtures/", import.meta.url);

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

/** An engine-built google-adk native, bare or closed by host completion. */
function driveAdk(natives: JsonValue[], hostCompleted: boolean): AgEvent[] {
  const n = createAdkNormalizer({ invokeId: "adk", ...(hostCompleted ? { hostCompletion: true } : {}) });
  const out: AgEvent[] = [];
  for (const e of withMemberEverywhere(natives) as JsonValue[]) out.push(...n.push(e));
  if (hostCompleted) out.push(...n.push({ type: HOST_COMPLETE_MARKER }));
  out.push(...n.flush());
  return out;
}

/** Each object event of `natives` whose customMetadata holds an `a2a:` entry, without its content and invocationId. */
function unrecognizedRelayEvents(natives: JsonValue[]): JsonValue[] {
  return natives.flatMap((e) => {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return [];
    const meta = e["customMetadata"];
    if (meta === null || typeof meta !== "object" || Array.isArray(meta) || !Object.keys(meta).some((k) => k.startsWith("a2a:"))) return [];
    const { content: _c, invocationId: _i, ...rest } = e;
    return [rest];
  });
}

const adkFixtures = ["adk-error", "adk-oracle"]
  .flatMap((d) => readdirSync(new URL(`${d}/`, FIXTURES)).filter((f) => f.endsWith(".native.json")).map((f) => `${d}/${f}`))
  .sort();

/** Every offending path of the events, their wire forms and their fold, labelled with `label`. */
function offendersOf(label: string, events: AgEvent[]): string[] {
  const found: string[] = [];
  const at = (p: string) => { const i = Number(/^\[(\d+)\]/.exec(p)?.[1]); return `${events[i]?.type ?? "?"}${p.replace(/^\[\d+\]/, "")}`; };
  for (const p of offenders(events)) found.push(`${label} event ${at(p)}`);
  for (const p of offenders(events.map((e) => toWire(e)))) found.push(`${label} wire ${at(p)}`);
  const r = new Reducer();
  for (const e of events) r.push(e);
  for (const p of offenders(r.result())) found.push(`${label} folded ${p}`);
  return found;
}

const natives = readdirSync(CORPUS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(new URL(`${d.name}/`, CORPUS)).filter((f) => f.endsWith(".native.json")).map((f) => `${d.name}/${f}`))
  .sort();

describe("facet events from natives whose objects each hold a member named __proto__", () => {
  it("hold no such member and no object with another prototype, as events, on the wire or folded", () => {
    expect(natives.length).toBeGreaterThan(50);
    const found: string[] = [];
    for (const file of natives) found.push(...offendersOf(file, drive(file, JSON.parse(readFileSync(new URL(file, CORPUS), "utf8")) as JsonValue[])));
    expect(found).toEqual([]);
    expect(({} as { x?: unknown }).x).toBeUndefined();
  }, 120_000);
});

describe("engine-built google-adk natives whose objects each hold a member named __proto__", () => {
  it("hold no such member and no object with another prototype, as events, on the wire or folded, bare or host-completed", () => {
    expect(adkFixtures.length).toBeGreaterThan(200);
    const found: string[] = [];
    let relayEvents = 0;
    for (const file of adkFixtures) {
      const natives = JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as JsonValue[];
      for (const hc of [false, true]) found.push(...offendersOf(`${file}${hc ? " (host-completed)" : ""}`, driveAdk(natives, hc)));
      const relay = unrecognizedRelayEvents(natives);
      relayEvents += relay.length;
      if (relay.length > 0) found.push(...offendersOf(`${file} (relay events, unrecognized)`, driveAdk(relay, false)));
    }
    expect(relayEvents).toBeGreaterThan(50);
    expect(found).toEqual([]);
    expect(({} as { x?: unknown }).x).toBeUndefined();
  }, 240_000);
});

// ── Each value kind, planted beside a sibling, against an unplanted control ──────────────────────────────────────

const SIBLING = "zzPlanted";

/** True when a string holds JSON text for an object or array. */
function jsonText(s: string): unknown {
  if (!/^\s*[[{]/.test(s)) return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `v` with `members` defined (never assigned) on every object at every depth, below the top-level array, and inside
 * every JSON text a string holds, re-serialized.
 */
function planted(v: unknown, members: Record<string, unknown>): unknown {
  if (typeof v === "string") {
    const parsed = jsonText(v);
    return parsed === undefined ? v : JSON.stringify(planted(parsed, members));
  }
  if (Array.isArray(v)) return v.map((x) => planted(x, members));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = planted(x, members);
    for (const [k, x] of Object.entries(members)) {
      Object.defineProperty(out, k, { value: structuredClone(x), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

/** The same value with every object rebuilt on a null prototype, or as an instance of a class. */
class NativeRecord {}
function rebuilt(v: unknown, make: () => object): unknown {
  if (Array.isArray(v)) return v.map((x) => rebuilt(x, make));
  if (v !== null && typeof v === "object") {
    const out = make() as Record<string, unknown>;
    for (const [k, x] of Object.entries(v)) {
      Object.defineProperty(out, k, { value: rebuilt(x, make), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

/** A comparable form: JSON text parsed, and an own `__proto__` omitted from it, so a serialized native compares by content. */
function comparable(v: unknown): unknown {
  if (typeof v === "string") {
    const parsed = jsonText(v);
    return parsed === undefined ? v : { "(json)": comparable(parsed) };
  }
  if (Array.isArray(v)) return v.map(comparable);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "__proto__") Object.defineProperty(out, k, { value: comparable(x), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}

/**
 * Removes, in place, `providerMetadata.wireInput` from each planted tool.args.assembled event whose control twin has
 * none (and the emptied `providerMetadata` bag with it). Returns how many it removed.
 */
function withoutPlantedOnlyWireInput(got: unknown[], want: unknown[]): number {
  let n = 0;
  got.forEach((g, i) => {
    const e = g as { type?: unknown; providerMetadata?: Record<string, unknown> };
    const c = want[i] as { providerMetadata?: Record<string, unknown> } | undefined;
    if (e?.type !== "tool.args.assembled" || e.providerMetadata?.["wireInput"] === undefined) return;
    if (c?.providerMetadata?.["wireInput"] !== undefined) return;
    delete e.providerMetadata["wireInput"];
    if (Object.keys(e.providerMetadata).length === 0) delete e.providerMetadata;
    n++;
  });
  return n;
}

function driveWith(file: string, natives: JsonValue[], shape: (native: JsonValue[]) => unknown): AgEvent[] {
  const fw = inferFramework(file);
  const { native, hostCompleted } = splitHostCompleteMarker(natives);
  const n =
    fw === "openai" ? createOpenaiNormalizer({ invokeId: "openai" })
    : fw === "adk" ? createAdkNormalizer({ invokeId: "adk", ...(hostCompleted ? { hostCompletion: true } : {}) })
    : fw === "vercel" ? createVercelNormalizer({ invokeId: "vercel" })
    : createClaudeNormalizer({ invokeId: "claude" });
  const out: AgEvent[] = [];
  for (const e of shape(native) as JsonValue[]) out.push(...n.push(e));
  if (hostCompleted && fw === "adk") out.push(...n.push({ type: HOST_COMPLETE_MARKER }));
  out.push(...n.flush());
  return out;
}

const VALUE_KINDS: Array<[string, unknown]> = [
  ["object", { x: 1 }],
  ["null", null],
  ["array", [{ x: 1 }]],
  ["primitive", "x"],
];

/** The runtime's `__proto__` accessor is live when an assignment through it selects a prototype. */
const accessorLive = ((): boolean => {
  const o: Record<string, unknown> = {};
  try {
    o["__proto__"] = { marker: 1 };
  } catch {
    return false;
  }
  return (o as { marker?: unknown }).marker === 1;
})();

describe("facet events from natives planted with each value kind beside a carried sibling", () => {
  for (const [kind, value] of VALUE_KINDS) {
    it(`${kind}: no member and no other prototype at any depth, and the events equal the sibling-only control's`, () => {
      const found: string[] = [];
      const carried = new Set<string>();
      let plantedFiles = 0;
      let claudeWireInputOnlyPlanted = 0;
      for (const file of natives) {
        const raw = JSON.parse(readFileSync(new URL(file, CORPUS), "utf8")) as JsonValue[];
        const control = driveWith(file, raw, (n) => planted(n, { [SIBLING]: 1 }));
        const events = driveWith(file, raw, (n) => {
          const p = planted(n, { ["__proto__"]: value, [SIBLING]: 1 });
          if (JSON.stringify(p).includes('"__proto__":')) plantedFiles++;
          return p;
        });
        found.push(...offendersOf(file, events));
        if (JSON.stringify(events.map((e) => e.type)) !== JSON.stringify(control.map((e) => e.type))) found.push(`${file} event types differ`);
        const [got, want] = [comparable(events), comparable(control)] as [unknown[], unknown[]];
        if (inferFramework(file) === "claude") claudeWireInputOnlyPlanted += withoutPlantedOnlyWireInput(got, want);
        if (JSON.stringify(got) !== JSON.stringify(want)) found.push(`${file} events differ from the control`);
        for (const e of events) if (JSON.stringify(e).includes(SIBLING)) carried.add(`${inferFramework(file)} ${e.type}`);
      }
      expect(found).toEqual([]);
      expect(plantedFiles).toBe(natives.length); // every native really holds the member
      // Known divergence, routed to the claude facet: when the planted member makes a tool's wire input differ from
      // its content input, the facet carries the wire input as providerMetadata.wireInput, which the control lacks.
      // This count reaching 0 means the facet no longer does so: remove withoutPlantedOnlyWireInput then.
      expect(claudeWireInputOnlyPlanted).toBeGreaterThan(0);
      // Non-vacuity: the sibling planted beside the member reaches tool input on every facet, and shared state on google-adk.
      for (const fw of ["claude", "openai", "adk", "vercel"]) expect(carried, fw).toContain(`${fw} tool.args.assembled`);
      expect(carried).toContain("adk state.delta");
      expect(({} as { x?: unknown }).x).toBeUndefined();
    }, 240_000);
  }

  it("the runtime check: an assigning copy of a planted native would select a prototype here, and no facet's does", () => {
    if (accessorLive) {
      const assigned = Object.assign({}, JSON.parse('{"__proto__":{"marker":1}}') as object);
      expect((assigned as { marker?: unknown }).marker).toBe(1);
    }
    const found: string[] = [];
    for (const file of natives) {
      const raw = JSON.parse(readFileSync(new URL(file, CORPUS), "utf8")) as JsonValue[];
      const events = driveWith(file, raw, (n) => planted(n, { ["__proto__"]: { marker: 1 } }));
      const walk = (v: unknown, path: string): void => {
        if (v === null || typeof v !== "object") return;
        if ((v as { marker?: unknown }).marker !== undefined) found.push(`${file} ${path}`);
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      };
      events.forEach((e, i) => walk(e, `[${i}] ${e.type}`));
      const r = new Reducer();
      for (const e of events) r.push(e);
      walk(r.result(), "folded");
    }
    expect(found).toEqual([]);
  }, 240_000);
});

describe("facet events from natives built with a null prototype or as class instances", () => {
  const shapes: Array<[string, () => object]> = [
    ["null prototype", () => Object.create(null) as object],
    ["class instance", () => new NativeRecord()],
  ];
  for (const [name, make] of shapes) {
    it(`${name}: every emitted and folded object is ordinary, and the events equal the plain native's`, () => {
      const found: string[] = [];
      for (const file of natives) {
        const raw = JSON.parse(readFileSync(new URL(file, CORPUS), "utf8")) as JsonValue[];
        const plain = driveWith(file, raw, (n) => n);
        const events = driveWith(file, raw, (n) => rebuilt(n, make));
        found.push(...offendersOf(file, events));
        if (JSON.stringify(comparable(events)) !== JSON.stringify(comparable(plain))) found.push(`${file} events differ from the plain native's`);
      }
      expect(found).toEqual([]);
    }, 240_000);
  }
});
