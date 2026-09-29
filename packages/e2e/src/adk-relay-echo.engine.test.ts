/**
 * The google-adk facet's relayed-repeat rule over natives the REAL @google/adk 2.1.0 RemoteA2AAgent yielded
 * (fixtures/adk-oracle, relay-echo-*): a remote agent that repeats the forwarded request as its first, submitted,
 * user-role status, in a streaming status-update and in the Task a non-blocking send returns. The repeat's content
 * reaches the wire in no form, one ext.google.relay-echo-omitted names the omitted part count, the artifact text
 * renders once, and the stream folds clean past the repeat.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Reducer, toWire, type AgEvent, type JsonValue } from "@silverprotocol/core";
import { ADK_HOST_COMPLETE_TYPE, createAdkNormalizer } from "@silverprotocol/google-adk";

const MARKER = "ext.google.relay-echo-omitted";
const LEAVES = ["LEAF-echo-text", "LEAF-echo-args", "LEAF-echo-result"];
const natives = (leg: string) => JSON.parse(readFileSync(new URL(`../fixtures/adk-oracle/${leg}.np.native.json`, import.meta.url), "utf8")) as JsonValue[];

function drive(events: JsonValue[], host: boolean): AgEvent[] {
  const n = createAdkNormalizer({ invokeId: "echo", ...(host ? { hostCompletion: true } : {}) });
  const out: AgEvent[] = [];
  for (const e of events) out.push(...n.push(e));
  if (host) out.push(...n.push({ type: ADK_HOST_COMPLETE_TYPE }));
  out.push(...n.flush());
  return out;
}

const LEGS = [
  { leg: "relay-echo-submitted-status-then-artifact", text: "Hello" },
  { leg: "relay-echo-nonblocking-submitted-task", text: "" },
];

describe("google-adk: a relayed repeat of the forwarded request, as real @google/adk 2.1.0 yields it", () => {
  for (const { leg, text } of LEGS) {
    it(`${leg}: the native holds the repeat (3 parts, the planted leaves) and a submitted, user-role relay status`, () => {
      const first = natives(leg)[0] as { content?: { parts?: unknown[] }; customMetadata?: Record<string, { status?: { state?: string; message?: { role?: string } } }> };
      expect(first.content?.parts).toHaveLength(3);
      for (const leaf of LEAVES) expect(JSON.stringify(first).includes(leaf), leaf).toBe(true);
      expect(first.customMetadata?.["a2a:response"]?.status).toEqual({ state: "submitted", message: { role: "user" } });
    });

    for (const host of [false, true]) {
      it(`${leg} (host completion ${host}): no leaf on the wire, one marker after turn.start naming 3 parts, the text once, and a clean fold`, () => {
        const out = drive(natives(leg), host);
        const wire = JSON.stringify(out.map((e) => toWire(e)));
        for (const leaf of LEAVES) expect(wire.includes(leaf), leaf).toBe(false);
        const markers = out.filter((e) => e.type === MARKER);
        expect(markers).toHaveLength(1);
        expect((markers[0] as unknown as { parts: number }).parts).toBe(3);
        const start = out.findIndex((e) => e.type === "turn.start");
        expect(start).toBeGreaterThanOrEqual(0);
        expect(out.indexOf(markers[0]!)).toBeGreaterThan(start);
        expect(out.filter((e) => e.type === "tool.start" || e.type === "tool.done" || e.type === "hitl.ask")).toEqual([]);
        expect(out.flatMap((e) => (e.type === "text.delta" || e.type === "reasoning.delta" ? [e.delta] : [])).join("")).toBe(text);
        const r = new Reducer();
        for (const e of out) r.push(e);
        expect(r.needsResync).toBe(false);
        const after = out.slice(out.indexOf(markers[0]!) + 1);
        expect(after.length).toBeGreaterThan(0);
        if (host) expect(r.result().turns.every((t) => t.outcome !== undefined)).toBe(true);
      });
    }
  }
});
