/**
 * SPEC §13.7: a member named `__proto__` in a native is dropped, at every
 * depth, and never passed through, and no emitted object takes it as its
 * prototype. Each site below is a native value the facet carries into an
 * event, planted with such a member at the carried value's top and one level
 * down (JSON.parse makes both own members), beside sibling members that are
 * kept.
 */
import { describe, expect, it } from "vitest";
import { AgEvent, JsonValue, Reducer, toWire } from "@silverprotocol/core";
import { ADK_HOST_COMPLETE_TYPE, createAdkNormalizer } from "./index.js";
import { withoutProtoMembers } from "./json-guards.js";

type Obj = { [k: string]: JsonValue };

/** The key the natives are written with, renamed to `__proto__` when parsed. */
const KEY = "planted-member-key";
/** A planted value: the member at its top and one level down, beside kept siblings. */
const plant = (extra: Obj = {}): Obj => ({ [KEY]: { planted: 1 }, nested: { [KEY]: { planted: 1 }, kept: 1 }, ...extra });
/** The natives as JSON.parse reads them with the member, and without it. */
function parsed(natives: Obj[]): { planted: unknown[]; control: unknown[] } {
  const text = JSON.stringify(natives);
  const planted: unknown = JSON.parse(text.split(`"${KEY}"`).join('"__proto__"'));
  const control: unknown = JSON.parse(text, (k, v: unknown) => (k === KEY ? undefined : v));
  return { planted: Array.isArray(planted) ? planted : [], control: Array.isArray(control) ? control : [] };
}

const INV = "inv-member";
const USAGE: Obj = { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24, promptTokensDetails: [{ modality: "TEXT", tokenCount: 20 }] };
const callEvent = (functionCall: Obj, extra: Obj = {}): Obj => ({
  invocationId: INV,
  author: "helper",
  id: "ev-call",
  content: { role: "model", parts: [{ functionCall }] },
  usageMetadata: USAGE,
  finishReason: "STOP",
  ...extra,
});
const responseEvent = (response: Obj): Obj => ({
  invocationId: INV,
  author: "helper",
  id: "ev-response",
  content: { role: "user", parts: [{ functionResponse: { id: "call-1", name: "lookup", response } }] },
});
const finalEvent = (extra: Obj = {}): Obj => ({
  invocationId: INV,
  author: "helper",
  id: "ev-final",
  content: { role: "model", parts: [{ text: "Done here." }] },
  usageMetadata: USAGE,
  finishReason: "STOP",
  ...extra,
});
const lookup = callEvent({ name: "lookup", id: "call-1", args: { q: "x" } });
const withResponse = (response: Obj): Obj[] => [lookup, responseEvent(response), finalEvent()];
const asking = (name: string, args: Obj): Obj[] => [callEvent({ name, id: "call-1", args }, { longRunningToolIds: ["call-1"] })];
const MCP_TEXT: Obj = { type: "text", text: "ok" };

/** Each carried site as [label, the natives written with the planted member]. */
const SITES: Array<[string, Obj[]]> = [
  ["a function response", withResponse({ ok: true, ...plant() })],
  ["an MCP result's structuredContent", withResponse({ content: [MCP_TEXT], structuredContent: plant() })],
  ["an MCP result's _meta", withResponse({ content: [MCP_TEXT], _meta: plant() })],
  ["an MCP result's non-text part", withResponse({ content: [{ type: "image", data: "aGk=", mimeType: "image/png", ...plant() }] })],
  ["an MCP resource link's other members", withResponse({ content: [{ type: "resource_link", uri: "ui://x", name: "x", icons: [plant()] }] })],
  [
    "a grounding support's confidence scores",
    [
      lookup,
      responseEvent({ ok: true }),
      finalEvent({
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://example.com", title: "e" } }],
          groundingSupports: [{ segment: { startIndex: 0, endIndex: 4, text: "Done" }, groundingChunkIndices: [0], confidenceScores: [plant()] }],
        },
      }),
    ],
  ],
  ["an adk_request_input call's response_schema", asking("adk_request_input", { message: "Which city?", response_schema: plant({ type: "object" }) })],
  ["an adk_request_input call's payload", asking("adk_request_input", { message: "Which city?", payload: plant() })],
  [
    "an adk_request_confirmation call's payload",
    asking("adk_request_confirmation", { originalFunctionCall: { name: "t", id: "o1", args: {} }, toolConfirmation: { hint: "ok?", payload: plant() } }),
  ],
  [
    "an adk_request_credential call's scopes",
    asking("adk_request_credential", {
      functionCallId: "o1",
      authConfig: { authScheme: { type: "oauth2" }, exchangedAuthCredential: { authType: "oauth2", oauth2: { scopes: [plant()] } } },
    }),
  ],
  [
    "a Live usage report's prompt token details",
    [lookup, responseEvent({ ok: true }), finalEvent({ usageMetadata: { promptTokenCount: 20, responseTokenCount: 5, totalTokenCount: 25, promptTokensDetails: [plant({ modality: "TEXT", tokenCount: 1 })] } })],
  ],
  ["a native the facet does not read", [lookup, { foo: plant() }, responseEvent({ ok: true }), finalEvent()]],
  [
    "a native the facet does not read, with relay bookkeeping in its customMetadata",
    [lookup, { ...plant(), customMetadata: { "a2a:request": {}, note: "x" } }, responseEvent({ ok: true }), finalEvent()],
  ],
];

type Fold = { events: AgEvent[]; wire: JsonValue[]; result: unknown; resync: boolean };
function fold(natives: unknown[], host: boolean): Fold {
  const n = createAdkNormalizer({ invokeId: "adk", ...(host ? { hostCompletion: true } : {}) });
  const events = [...natives.flatMap((e) => n.push(e)), ...(host ? n.push({ type: ADK_HOST_COMPLETE_TYPE }) : []), ...n.flush()];
  const r = new Reducer();
  for (const e of events) r.push(e);
  return { events, wire: events.map((e) => toWire(e)), result: r.result(), resync: r.needsResync };
}
/** Whether the event is a valid AgEvent (a site's malformed native element can make one invalid either way). */
function parses(e: AgEvent): boolean {
  try {
    AgEvent.parse(e);
    return true;
  } catch {
    return false;
  }
}
/** The paths of objects holding an own `__proto__` member, and of objects whose prototype is not the ordinary one. */
function scan(v: unknown, path = "", found: { own: string[]; prototype: string[] } = { own: [], prototype: [] }): { own: string[]; prototype: string[] } {
  if (typeof v !== "object" || v === null) return found;
  const ordinary = Array.isArray(v) ? Array.prototype : Object.prototype;
  if (Object.getPrototypeOf(v) !== ordinary) found.prototype.push(path);
  if (Object.hasOwn(v, "__proto__")) found.own.push(path);
  for (const k of Object.keys(v)) scan(Reflect.get(v, k), `${path}.${k}`, found);
  return found;
}
const runs = SITES.flatMap(([label, natives]) => {
  const { planted, control } = parsed(natives);
  return [false, true].map((host) => ({ tag: `${label} host=${host}`, planted, control, out: fold(planted, host), want: fold(control, host) }));
});

describe("createAdkNormalizer — a member named __proto__ in a native is dropped at every depth (SPEC §13.7)", () => {
  it("each site's planted natives hold the member at the carried value's top and one level down, and the site carries the value's siblings", () => {
    expect(SITES).toHaveLength(13);
    for (const r of runs) {
      expect(scan(r.planted).own.length, r.tag).toBe(2);
      expect(scan(r.control).own, r.tag).toEqual([]);
      expect(JSON.stringify(r.want.events), r.tag).toContain('"nested":{"kept":1}');
    }
  });

  it("at each site, the planted natives give the same events, wire frames and fold result as the natives without the member, valid and resyncing exactly where theirs are", () => {
    for (const r of runs) {
      expect(JSON.stringify(r.out.events), r.tag).toBe(JSON.stringify(r.want.events));
      expect(JSON.stringify(r.out.wire), r.tag).toBe(JSON.stringify(r.want.wire));
      expect(JSON.stringify(r.out.result), r.tag).toBe(JSON.stringify(r.want.result));
      expect(r.out.resync, r.tag).toBe(r.want.resync);
      expect(r.out.events.map(parses), r.tag).toEqual(r.want.events.map(parses));
    }
  });

  it("no emitted event, wire frame or fold result holds an own __proto__ member, at any depth", () => {
    for (const r of runs) {
      expect(scan(r.out.events).own, r.tag).toEqual([]);
      expect(scan(r.out.wire).own, r.tag).toEqual([]);
      expect(scan(r.out.result).own, r.tag).toEqual([]);
    }
  });

  it("every emitted object keeps its ordinary prototype, and Object.prototype gains no member", () => {
    for (const r of runs) {
      expect(scan(r.out.events).prototype, r.tag).toEqual([]);
      expect(scan(r.out.wire).prototype, r.tag).toEqual([]);
      expect(scan(r.out.result).prototype, r.tag).toEqual([]);
    }
    expect(Reflect.get({}, "planted")).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });
});

describe("withoutProtoMembers", () => {
  it("returns a value without the member as it is, uncopied, at every depth", () => {
    const values: JsonValue[] = [{ a: { b: [1, { c: null }] } }, [{ d: "e" }], "s", 3, null, true];
    for (const v of values) expect(withoutProtoMembers(v)).toBe(v);
  });

  it("drops the member inside objects and arrays at every depth, keeps every other member in order, and leaves the argument as it was", () => {
    const text = '{"a":1,"__proto__":{"x":1},"b":[{"__proto__":{"y":1},"c":2}],"d":{"e":{"__proto__":{"z":1},"f":3}}}';
    const out = withoutProtoMembers(JSON.parse(text));
    expect(JSON.stringify(out)).toBe('{"a":1,"b":[{"c":2}],"d":{"e":{"f":3}}}');
    expect(scan(out)).toEqual({ own: [], prototype: [] });
    const input: JsonValue = JSON.parse(text);
    withoutProtoMembers(input);
    expect(JSON.stringify(input)).toBe(text);
    expect(scan(input).own).toEqual(["", ".b.0", ".d.e"]);
  });
});
