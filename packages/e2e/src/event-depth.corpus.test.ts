// A facet carries a native member it does not read (here an ADK event's
// customMetadata entry) after core's toJsonValueSafe caps it at
// JSON_SAFE_MAX_DEPTH, a few levels below the emitted event's root. Those
// events must stay inside the consumer's event bound: ingested, not rejected,
// and folded as before.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JSON_SAFE_MAX_DEPTH, Reducer, ingestAgEvent, toWire, type AgEvent, type AgIngestReject, type JsonValue } from "@silverprotocol/core";

/** Core's event depth bound (internal to core on this release line): JSON_SAFE_MAX_DEPTH plus a 16-level allowance. */
const AG_EVENT_MAX_DEPTH = JSON_SAFE_MAX_DEPTH + 16;
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { HOST_COMPLETE_MARKER } from "./replay.js";

const NATIVE = new URL("../corpus/echo-gemini38/adk.native.json", import.meta.url);

const nest = (n: number): JsonValue => {
  let v: JsonValue = { s: 1 };
  for (let i = 1; i < n; i++) v = { k: v };
  return v;
};
const depthOf = (v: unknown): number => {
  let max = 0;
  const stack: Array<[unknown, number]> = [[v, 0]];
  while (stack.length > 0) {
    const [x, d] = stack.pop()!;
    if (d > max) max = d;
    if (x !== null && typeof x === "object") for (const y of Object.values(x)) stack.push([y, d + 1]);
  }
  return max;
};

function emit(planted: JsonValue | undefined): JsonValue[] {
  const natives = JSON.parse(readFileSync(NATIVE, "utf8")) as JsonValue[];
  const n = createAdkNormalizer({ invokeId: "adk" });
  const out: AgEvent[] = [];
  for (const e of natives) {
    if (e !== null && typeof e === "object" && !Array.isArray(e) && e["type"] === HOST_COMPLETE_MARKER) continue;
    const withEntry =
      planted !== undefined && e !== null && typeof e === "object" && !Array.isArray(e) && "content" in e ? { ...e, customMetadata: { entry: planted } } : e;
    out.push(...n.push(withEntry));
  }
  out.push(...n.flush());
  return out.map((e) => JSON.parse(JSON.stringify(toWire(e))) as JsonValue);
}

describe("a facet carry capped at the emit side's bound stays inside the event bound", () => {
  for (const d of [JSON_SAFE_MAX_DEPTH - 1, JSON_SAFE_MAX_DEPTH, 5000, 12000]) {
    it(`an ADK customMetadata entry nested ${d} deep: every emitted event is ingested, none is rejected, and the fold equals the in-process fold`, () => {
      const wire = emit(nest(d));
      expect(wire.some((w) => JSON.stringify(w).includes('"entry"'))).toBe(true);
      const deepest = Math.max(...wire.map(depthOf));
      expect(deepest).toBeGreaterThan(JSON_SAFE_MAX_DEPTH - 1);
      expect(deepest).toBeLessThanOrEqual(AG_EVENT_MAX_DEPTH);
      const rejects: AgIngestReject[] = [];
      const decoded = wire.map((w) => ingestAgEvent(w, { onReject: (x) => rejects.push(x) }));
      expect(rejects).toEqual([]);
      expect(decoded.every((e) => e !== undefined && e.type !== "ext.agjson.ignored")).toBe(true);
      const a = new Reducer();
      for (const e of decoded) a.push(e!);
      const b = new Reducer();
      for (const w of wire) b.push(w as unknown as AgEvent);
      expect(a.needsResync).toBe(false);
      expect(JSON.stringify(a.result())).toBe(JSON.stringify(b.result()));
    });
  }

  it("the deepest carry the cap allows sits two levels below the native's member, at event depth 1002", () => {
    expect(Math.max(...emit(nest(5000)).map(depthOf))).toBe(JSON_SAFE_MAX_DEPTH + 2);
  });
});
