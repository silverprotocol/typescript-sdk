/**
 * A part that holds text beside a payload member (a call, a result, media or
 * code), or two or more payload members. A genai Part holds one kind of data,
 * so such a part is malformed, but each of its members is a native value the
 * facet must not drop. The facet maps it as the same event with the part split
 * into a part holding its text (with its thought signature and any unmapped
 * member) and one part per payload member, each marked as thought when the
 * original part was.
 */
import { describe, expect, it } from "vitest";
import { AgEvent, JsonValue, Reducer, toJsonValue } from "@silverprotocol/core";
import { createAdkNormalizer } from "./index.js";

type Obj = { [k: string]: JsonValue };

function drive(natives: Obj[]): AgEvent[] {
  const n = createAdkNormalizer({ invokeId: "adk" });
  return [...natives.flatMap((e) => n.push(toJsonValue(e))), ...n.flush()];
}
/** An event of the invocation `inv`: every event of one leg shares it, so a result meets its call in one turn. */
const event = (inv: string, parts: Obj[], extra: Obj = {}): Obj => ({ invocationId: inv, author: "agent", content: { role: "model", parts }, ...extra });
const blockOf = (e: AgEvent): unknown => (e.type === "content.block" ? Reflect.get(e, "block") : undefined);
const isThoughtCarry = (e: AgEvent): boolean => JSON.stringify(blockOf(e)) === JSON.stringify({ type: "provider-raw", vendor: "google", raw: { thought: true } });
const typedBlocks = (out: AgEvent[]): string[] =>
  out.flatMap((e) => {
    const b = blockOf(e);
    const t = typeof b === "object" && b !== null ? Reflect.get(b, "type") : undefined;
    return typeof t === "string" && t !== "provider-raw" ? [t] : [];
  });
const count = (out: AgEvent[], type: string): number => out.filter((e) => e.type === type).length;
function blockTexts(out: AgEvent[]): string[] {
  const texts = new Map<string, string>();
  for (const e of out) if (e.type === "text.delta" || e.type === "reasoning.delta") texts.set(`${e.type}:${e.id ?? ""}`, (texts.get(`${e.type}:${e.id ?? ""}`) ?? "") + e.delta);
  return [...texts.values()];
}
/** A stream with tool.start's positional members removed, serialized. They
 *  record the native part's position, which the split parts cannot share, and
 *  are asserted on their own. */
function withoutPositions(out: AgEvent[]): string {
  return JSON.stringify(
    out.map((e) => {
      if (e.type !== "tool.start") return e;
      const o = JSON.parse(JSON.stringify(e));
      delete o.index;
      if (o.providerMetadata?.google !== undefined) {
        delete o.providerMetadata.google.providerCallIndex;
        if (Object.keys(o.providerMetadata.google).length === 0) delete o.providerMetadata.google;
        if (Object.keys(o.providerMetadata).length === 0) delete o.providerMetadata;
      }
      return o;
    }),
  );
}
/** Each tool.start's `index` and providerCallIndex (undefined for a call with an id). */
const member = (v: unknown, key: string): unknown => (typeof v === "object" && v !== null ? Reflect.get(v, key) : undefined);
const positions = (out: AgEvent[]): Array<[unknown, unknown]> =>
  out.flatMap((e): Array<[unknown, unknown]> => (e.type === "tool.start" ? [[member(e, "index"), member(member(member(e, "providerMetadata"), "google"), "providerCallIndex")]] : []));
function expectCleanFold(out: AgEvent[], label: string): void {
  for (const e of out) expect(() => AgEvent.parse(e), label).not.toThrow();
  const r = new Reducer();
  for (const e of out) r.push(e);
  expect(r.needsResync, label).toBe(false);
  const done = new Set(out.flatMap((e) => (e.type === "tool.done" ? [e.toolCallId] : [])));
  for (const e of out) if (e.type === "tool.start") expect(done.has(e.toolCallId), `${label}: ${e.toolCallId} has no result`).toBe(true);
}

interface Kind {
  label: string;
  /** Events the leg places before the part (a result's call). */
  before: Obj[];
  payload: Obj;
  /** Events after the part that answer a call it holds. */
  after: Obj[];
  expect: { toolStart: number; toolDone: number; blocks: string[] };
}
const kinds = (i: number, inv: string): Kind[] => {
  const t = `k${i}`;
  const result = (id: string | undefined, name = "lookup"): Obj => ({ functionResponse: { name, ...(id !== undefined ? { id } : {}), response: { forecast: `Sunny ${t}` } } });
  return [
    { label: "a call", before: [], payload: { functionCall: { name: "lookup", args: { city: `City ${t}` }, id: `fc-${t}` } }, after: [event(inv, [result(`fc-${t}`)])], expect: { toolStart: 1, toolDone: 1, blocks: [] } },
    { label: "a call with no id", before: [], payload: { functionCall: { name: "lookup", args: { city: `City ${t}` } } }, after: [event(inv, [result(undefined)])], expect: { toolStart: 1, toolDone: 1, blocks: [] } },
    { label: "a response, after its call", before: [event(inv, [{ functionCall: { name: "lookup", args: {}, id: `fr-${t}` } }])], payload: result(`fr-${t}`), after: [], expect: { toolStart: 1, toolDone: 1, blocks: [] } },
    { label: "a response with no id, after its call", before: [event(inv, [{ functionCall: { name: "lookup", args: {} } }])], payload: result(undefined), after: [], expect: { toolStart: 1, toolDone: 1, blocks: [] } },
    { label: "inline data", before: [], payload: { inlineData: { mimeType: "image/png", data: `aW1n${i}` } }, after: [], expect: { toolStart: 0, toolDone: 0, blocks: ["image"] } },
    { label: "file data", before: [], payload: { fileData: { mimeType: "application/pdf", fileUri: `gs://b/r-${t}.pdf` } }, after: [], expect: { toolStart: 0, toolDone: 0, blocks: ["resource-link"] } },
    { label: "executable code", before: [], payload: { executableCode: { language: "PYTHON", code: `print(${i})` } }, after: [], expect: { toolStart: 0, toolDone: 0, blocks: ["code"] } },
    { label: "a code execution result", before: [], payload: { codeExecutionResult: { outcome: "OUTCOME_OK", output: `${i}\n` } }, after: [], expect: { toolStart: 0, toolDone: 0, blocks: ["code-result"] } },
  ];
};
const KINDS = kinds(0, "").length;
/** Each leg as [label, its invocation id, its kind, marked, i]. */
const legs = [0, 1].flatMap((i) =>
  [...Array(KINDS).keys()].flatMap((j) =>
    [false, true].map((marked): [string, string, Kind, boolean, number] => {
      const inv = `inv-${i}-${j}-${marked}`;
      const k = kinds(i, inv)[j] ?? kinds(i, inv)[0]!;
      return [`${k.label} #${i}${marked ? " marked" : ""}`, inv, k, marked, i];
    }),
  ),
);
const mark = (marked: boolean): Obj => (marked ? { thought: true } : {});

describe("createAdkNormalizer — a part that holds text beside a payload member maps as the same part split in two", () => {
  it("text beside each payload kind (a call, with or without an id; a response, with or without an id; inline data; file data; code; a code result), marked as thought or not, maps byte for byte as a text part followed by a part holding the payload alone, marked alike: one text or reasoning block with the text, and the payload through its own arm", () => {
    expect(legs).toHaveLength(32);
    for (const [label, inv, k, marked, i] of legs) {
      const text = `Text ${i} beside ${k.label}.`;
      const combined = drive([...k.before, event(inv, [{ text, ...k.payload, ...mark(marked) }]), ...k.after]);
      const split = drive([...k.before, event(inv, [{ text, ...mark(marked) }, { ...k.payload, ...mark(marked) }]), ...k.after]);
      expect(withoutPositions(combined), label).toBe(withoutPositions(split));
      // Every call of these legs is its event's native part 0; a call with no
      // id (its id minted as <turn>:call:<n>) also records that position.
      const minted = combined.flatMap((e) => (e.type === "tool.start" ? [/:call:\d+$/.test(String(member(e, "toolCallId")))] : []));
      expect(positions(combined), label).toEqual(minted.map((m) => [0, m ? 0 : undefined]));
      expect(blockTexts(combined), label).toContain(text);
      expect(count(combined, marked ? "reasoning.start" : "text.start"), label).toBe(1);
      expect(count(combined, "tool.start"), label).toBe(k.expect.toolStart);
      expect(count(combined, "tool.done"), label).toBe(k.expect.toolDone);
      expect(typedBlocks(combined), label).toEqual(k.expect.blocks);
      expect(combined.filter(isThoughtCarry), label).toHaveLength(marked ? 1 : 0);
      expectCleanFold(combined, label);
    }
  });

  it("the part's thought signature and an unmapped member stay with its text half, and are carried once", () => {
    for (const i of [0, 1]) {
      for (const marked of [false, true]) {
        const label = `#${i} marked=${marked}`;
        const call: Obj = { functionCall: { name: "lookup", args: { q: `${i}` }, id: `fc-sig-${i}` } };
        const answer = event(`sig-${i}-${marked}`, [{ functionResponse: { name: "lookup", id: `fc-sig-${i}`, response: { ok: true } } }]);
        const extra: Obj = { thoughtSignature: `c2ln${i}`, partMetadata: { tag: `meta-${i}` } };
        const combined = drive([event(`sig-${i}-${marked}`, [{ text: `Signed ${i}.`, ...call, ...extra, ...mark(marked) }]), answer]);
        const split = drive([event(`sig-${i}-${marked}`, [{ text: `Signed ${i}.`, ...extra, ...mark(marked) }, { ...call, ...mark(marked) }]), answer]);
        expect(withoutPositions(combined), label).toBe(withoutPositions(split));
        expect(positions(combined), label).toEqual([[0, undefined]]);
        expect(JSON.stringify(combined).split(`meta-${i}`).length - 1, label).toBe(1);
        expect(combined.find((e) => e.type === "tool.args.assembled"), label).not.toHaveProperty("signature");
      }
    }
  });
});

describe("createAdkNormalizer — a call split out of a part records the native part's position", () => {
  it("text beside a call with no id, then a call with no id: providerCallIndex and tool.start's index are 0 then 1, the native parts' positions, not the split ones", () => {
    for (const i of [0, 1]) {
      const inv = `pos-${i}`;
      const out = drive([
        event(inv, [{ text: `Two calls ${i}.`, functionCall: { name: "lookup", args: { q: `a${i}` } } }, { functionCall: { name: "lookup", args: { q: `b${i}` } } }]),
        event(inv, [{ functionResponse: { name: "lookup", response: { r: 1 } } }, { functionResponse: { name: "lookup", response: { r: 2 } } }]),
      ]);
      expect(positions(out), `#${i}`).toEqual([[0, 0], [1, 1]]);
      expectCleanFold(out, `#${i}`);
    }
  });
});

describe("createAdkNormalizer — a part that holds two or more payload members maps each of them", () => {
  it("a call beside inline data, with and without text, marked as thought or not, maps as one part per member in arm order, the first holding the rest of the part: a tool call and an image", () => {
    for (const i of [0, 1]) {
      for (const marked of [false, true]) {
        for (const withText of [false, true]) {
          const label = `#${i} marked=${marked} text=${withText}`;
          const call: Obj = { functionCall: { name: "lookup", args: { q: `${i}` }, id: `fc-multi-${i}-${withText}` } };
          const image: Obj = { inlineData: { mimeType: "image/png", data: `aW1n${i}` } };
          const inv = `multi-${i}-${marked}-${withText}`;
          const answer = event(inv, [{ functionResponse: { name: "lookup", id: `fc-multi-${i}-${withText}`, response: { ok: true } } }]);
          const text: Obj = withText ? { text: `Both ${i}.` } : {};
          const combined = drive([event(inv, [{ ...image, ...call, ...text, thoughtSignature: `c2ln${i}`, ...mark(marked) }]), answer]);
          const parts: Obj[] = withText
            ? [{ ...text, thoughtSignature: `c2ln${i}`, ...mark(marked) }, { ...call, ...mark(marked) }, { ...image, ...mark(marked) }]
            : [{ ...call, thoughtSignature: `c2ln${i}`, ...mark(marked) }, { ...image, ...mark(marked) }];
          const split = drive([event(inv, parts), answer]);
          expect(withoutPositions(combined), label).toBe(withoutPositions(split));
          expect(positions(combined), label).toEqual([[0, undefined]]);
          expect(count(combined, "tool.start"), label).toBe(1);
          expect(typedBlocks(combined), label).toEqual(["image"]);
          expectCleanFold(combined, label);
        }
      }
    }
  });
});

describe("createAdkNormalizer — text beside a payload member on the aggregate path", () => {
  it("streamed text, then the partial:false aggregate re-sending that text beside each payload kind, maps the text once and the payload once; a call with or without an id also streamed beside the text in the partial maps once", () => {
    for (const i of [0, 1]) {
      for (const j of Array(KINDS).keys()) {
        const probe = kinds(i, "")[j] ?? kinds(i, "")[0]!;
        const variants: boolean[] = probe.payload["functionCall"] !== undefined ? [false, true] : [false];
        for (const inPartial of variants) {
          const tag = `agg-${i}-${j}-${inPartial}`;
          const k = kinds(i, tag)[j] ?? probe;
          const label = `${k.label} #${i} inPartial=${inPartial}`;
          const text = `Streamed ${i} beside ${k.label}.`;
          const out = drive([
            ...k.before,
            event(tag, [{ text, ...(inPartial ? k.payload : {}) }], { partial: true }),
            event(tag, [{ text, ...k.payload }], { partial: false }),
            ...k.after,
          ]);
          expect(blockTexts(out).join(""), label).toBe(text);
          expect(count(out, "tool.start"), label).toBe(k.expect.toolStart);
          expect(count(out, "tool.done"), label).toBe(k.expect.toolDone);
          expect(typedBlocks(out), label).toEqual(k.expect.blocks);
          expectCleanFold(out, label);
        }
      }
    }
  });
});

describe("createAdkNormalizer — a credential request or reply beside text keeps its scrub", () => {
  const secrets: string[] = [];
  const secret = (tag: string): string => {
    const v = `PLANTED-SECRET-${tag}-${secrets.length}`;
    secrets.push(v);
    return v;
  };
  const authConfig = (tag: string): Obj => ({
    authScheme: { type: "oauth2", flows: { authorizationCode: { authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", scopes: {} } } },
    rawAuthCredential: { authType: "oauth2", oauth2: { clientId: "client", clientSecret: secret(`${tag}-client`) } },
    exchangedAuthCredential: { authType: "oauth2", oauth2: { accessToken: secret(`${tag}-access`), refreshToken: secret(`${tag}-refresh`) } },
    credentialKey: `key-${tag}`,
  });
  const credentialCall = (tag: string, id: string): Obj => ({
    functionCall: { name: "adk_request_credential", id, args: { functionCallId: `orig-${tag}`, authConfig: authConfig(`${tag}-call`), extra: secret(`${tag}-extra`) } },
  });
  const credentialReply = (tag: string, id: string | undefined): Obj => ({
    functionResponse: { name: "adk_request_credential", ...(id !== undefined ? { id } : {}), response: authConfig(`${tag}-reply`) },
  });
  function expectNoSecret(out: AgEvent[], label: string): void {
    const wire = JSON.stringify(out);
    for (const v of secrets) {
      expect(wire.includes(v), `${label}: ${v}`).toBe(false);
      for (const t of blockTexts(out)) expect(t.includes(v), `${label}: ${v} in a block`).toBe(false);
    }
  }

  it("a credential request beside text, on a single event and on the aggregate path, maps its call with the scrubbed arguments, and no planted secret reaches the wire, raw or in any block", () => {
    for (const i of [0, 1]) {
      const tag = `cred-call-${i}`;
      const single = drive([event(tag, [{ text: `Sign in ${i}.`, ...credentialCall(tag, `cc-${i}`) }])]);
      const aggregate = drive([event(`${tag}-agg`, [{ text: `Sign in ${i}.` }], { partial: true }), event(`${tag}-agg`, [{ text: `Sign in ${i}.`, ...credentialCall(`${tag}-agg`, `cca-${i}`) }], { partial: false })]);
      for (const [label, out] of [[`${tag} single`, single], [`${tag} aggregate`, aggregate]] as const) {
        expect(out.filter((e) => e.type === "tool.start" && e.name === "adk_request_credential"), label).toHaveLength(1);
        expectNoSecret(out, label);
      }
    }
  });

  it("a credential reply beside text, after its call, on a single event and on the aggregate path, maps its tool.done with the scrubbed response, and no planted secret reaches the wire", () => {
    for (const i of [0, 1]) {
      const tag = `cred-reply-${i}`;
      const call = event(tag, [credentialCall(`${tag}-c`, `cr-${i}`)]);
      const single = drive([call, event(tag, [{ text: `Here it is ${i}.`, ...credentialReply(tag, `cr-${i}`) }])]);
      const aggregate = drive([call, event(tag, [{ text: `Here it is ${i}.` }], { partial: true }), event(tag, [{ text: `Here it is ${i}.`, ...credentialReply(`${tag}-agg`, `cr-${i}`) }], { partial: false })]);
      for (const [label, out] of [[`${tag} single`, single], [`${tag} aggregate`, aggregate]] as const) {
        expect(out.filter((e) => e.type === "tool.done" && e.toolCallId === `cr-${i}`), label).toHaveLength(1);
        expectNoSecret(out, label);
      }
    }
  });

  it("a credential reply with no id beside text, with no call pending under its name, rides the orphan carry with its scrubbed response, and no planted secret reaches the wire", () => {
    for (const i of [0, 1]) {
      const tag = `cred-orphan-${i}`;
      const out = drive([event(tag, [{ text: `Orphan ${i}.`, ...credentialReply(tag, undefined) }])]);
      const carried = out.filter((e) => e.type === "ext.google.unparsed");
      expect(carried, tag).toHaveLength(1);
      expect(JSON.stringify(carried[0]), tag).toContain("adk_request_credential");
      expect(count(out, "tool.done"), tag).toBe(0);
      expectNoSecret(out, tag);
    }
  });

  it("a reply with no id beside text resolves to the id the facet minted for the earlier call with no id, by the event's null-id pass", () => {
    for (const i of [0, 1]) {
      const tag = `null-pass-${i}`;
      const out = drive([event(tag, [{ functionCall: { name: "lookup", args: { q: `${i}` } } }]), event(tag, [{ text: `Result ${i}.`, functionResponse: { name: "lookup", response: { ok: i } } }])]);
      const start = out.find((e) => e.type === "tool.start");
      const done = out.find((e) => e.type === "tool.done");
      expect(start?.type === "tool.start" ? start.toolCallId : undefined, tag).toBeDefined();
      expect(done?.type === "tool.done" ? done.toolCallId : "", tag).toBe(start?.type === "tool.start" ? start.toolCallId : "none");
      expectCleanFold(out, tag);
    }
  });
});
