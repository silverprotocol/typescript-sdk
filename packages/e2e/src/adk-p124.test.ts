/**
 * adk-p124.test.ts — SPEC §8.0 item 26's pause signal when a second agent runs
 * after the pausing one, over the engine-built natives in fixtures/adk-p124/
 * (adk-p124-fixtures.gen.test.ts: the real @google/adk engine at the e2e pin,
 * stub models, two instances per shape).
 *
 * Item 26: "A pause is signalled by the event with which ADK ends it (...) or
 * by a non-error final response of the pausing agent while an ask is pending",
 * and "A `flush()` that has seen no pause signal for a turn closes it as a
 * truncation, or with the `turn.error` §8.0 item 35 directs when its
 * invocation met an invocation error (...), never as `paused`."
 *
 * The shapes (a SequentialAgent root: `agent` asks, then `next` answers):
 *  - seq-<kind>: ADK's pause-end event precedes `next`'s final. Paused.
 *  - seq-<kind>-strip: a host plugin cleared the pause-end members, so the
 *    ask is pending, no pause-end event arrives, and only `next`'s final
 *    follows. `next` is not the pausing agent: no signal, so flush() closes a
 *    truncation, and a host-terminal event closes item 35's turn.error.
 *  - sse-seq-credential-strip: the same, but the pausing agent's own finals
 *    arrive while the ask is pending: they signal, so it closes paused.
 *
 * Two PLANTED legs (rewritten natives, labelled as such) isolate what the
 * engine shapes cannot vary alone: (1) sse-seq-credential-strip with
 * `agent`'s finals re-authored as `next`, the author the only change; (2) a
 * seq-<kind> stream with its pause-end members deleted, which closes as the
 * engine's strip run does and equals it modulo run identity.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Reducer, type AgEvent, type JsonValue } from "@silverprotocol/core";
import { ADK_HOST_ERROR_TYPE, createAdkNormalizer } from "@silverprotocol/google-adk";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adk-p124");

type Native = {
  author?: string;
  partial?: boolean;
  invocationId?: string;
  finishReason?: string;
  turnComplete?: boolean;
  errorCode?: string;
  content?: { parts?: Array<{ text?: string; functionCall?: { id?: string; name?: string }; functionResponse?: { id?: string; name?: string } }> };
  actions?: { requestedAuthConfigs?: Record<string, unknown>; requestedToolConfirmations?: Record<string, unknown>; skipSummarization?: boolean };
};

const KINDS = ["credential", "confirmation", "request-input"] as const;
const REAL = KINDS.map((k) => `seq-${k}`);
const STRIP = KINDS.map((k) => `seq-${k}-strip`);
const SSE_STRIP = "sse-seq-credential-strip";
const INSTANCES = [1, 2] as const;

const load = (shape: string, instance: number): Native[] =>
  JSON.parse(readFileSync(join(DIR, `${shape}.${instance}.native.json`), "utf8")) as Native[];
const asJson = (natives: Native[]): JsonValue[] => JSON.parse(JSON.stringify(natives)) as JsonValue[];

const parts = (e: Native) => e.content?.parts ?? [];
const nonEmpty = (o: object | undefined): boolean => o !== undefined && Object.keys(o).length > 0;
/** ADK's pause-end event, read independently of the facet: the confirmation
 *  request, the function response carrying requestedAuthConfigs, or the
 *  content-less skipSummarization event. */
const isPauseEnd = (e: Native): boolean =>
  nonEmpty(e.actions?.requestedToolConfirmations) ||
  nonEmpty(e.actions?.requestedAuthConfigs) ||
  (parts(e).length === 0 && e.actions?.skipSummarization === true);
/** Item 35's final response: not partial, a completion marker, no functionCall, not an in-band error, not a pause end. */
const isFinal = (e: Native): boolean =>
  e.partial !== true &&
  (e.turnComplete === true || e.finishReason !== undefined || e.errorCode !== undefined) &&
  !parts(e).some((p) => p.functionCall !== undefined) &&
  e.errorCode === undefined &&
  !isPauseEnd(e);
const askIndex = (natives: Native[]): number =>
  natives.findIndex((e) => parts(e).some((p) => p.functionCall?.name?.startsWith("adk_request_") === true));
const askIds = (natives: Native[]): string[] =>
  natives.flatMap((e) => parts(e).flatMap((p) => (p.functionCall?.name?.startsWith("adk_request_") === true && p.functionCall.id !== undefined ? [p.functionCall.id] : [])));

type Host = "none" | "complete" | "error";
const HOST_ERROR = { type: ADK_HOST_ERROR_TYPE, code: "HostError", message: "the host run threw" } as JsonValue;

function drive(natives: JsonValue[], host: Host): { events: AgEvent[]; r: Reducer } {
  const n = createAdkNormalizer(host === "complete" ? { hostCompletion: true } : {});
  const events: AgEvent[] = [];
  for (const x of natives) events.push(...n.push(x));
  if (host === "complete") events.push(...n.push({ type: "__host_complete__" } as JsonValue));
  if (host === "error") events.push(...n.push(HOST_ERROR));
  events.push(...n.flush());
  const r = new Reducer();
  for (const e of events) r.push(e);
  return { events, r };
}

type Close = { type: string; turnId: string; outcome?: string; asks?: string[]; reason?: string; code?: string };
function closes(events: AgEvent[]): Close[] {
  return events
    .filter((e) => e.type === "turn.done" || e.type === "turn.error" || e.type === "turn.abort")
    .map((e) => {
      const v = e as { type: string; turnId: string; outcome?: { type?: string; asks?: Array<{ toolCallId?: string }> }; reason?: string; code?: string };
      return {
        type: v.type,
        turnId: v.turnId,
        ...(v.outcome?.type !== undefined ? { outcome: v.outcome.type } : {}),
        ...(v.outcome?.asks !== undefined ? { asks: v.outcome.asks.map((a) => a.toolCallId ?? "") } : {}),
        ...(v.reason !== undefined ? { reason: v.reason } : {}),
        ...(v.code !== undefined ? { code: v.code } : {}),
      };
    });
}

/** Every opened turn has exactly one terminal and the fold is clean. */
function expectClean(events: AgEvent[], r: Reducer): void {
  expect(r.needsResync).toBe(false);
  const opened = events.filter((e) => e.type === "turn.start").map((e) => (e as { turnId: string }).turnId);
  const terms = closes(events).map((c) => c.turnId);
  expect([...terms].sort()).toEqual([...new Set(opened)].sort());
}

const PAUSED = (ids: string[]) => ({ type: "turn.done", outcome: "paused", asks: ids });
const strip = ({ turnId: _t, ...c }: Close) => c;

describe("ADK pause signal with a second agent after the pausing one (§8.0 item 26, engine-built)", () => {
  it("the fixture set is complete: seven shapes, two instances each, from distinct runs (non-vacuity)", () => {
    const have = readdirSync(DIR).filter((f) => f.endsWith(".native.json")).sort();
    const want = [...REAL, ...STRIP, SSE_STRIP].flatMap((s) => INSTANCES.map((i) => `${s}.${i}.native.json`)).sort();
    expect(have).toEqual(want);
    for (const s of [...REAL, ...STRIP, SSE_STRIP]) {
      const [a, b] = INSTANCES.map((i) => load(s, i)[0]?.invocationId);
      expect(a).toBeTypeOf("string");
      expect(a).not.toBe(b);
    }
  });

  for (const shape of [...REAL, ...STRIP, SSE_STRIP]) {
    for (const i of INSTANCES) {
      it(`${shape}.${i}: authors — \`agent\` raises the one ask, \`next\`'s final ends the stream, and the pause-end event ${REAL.includes(shape) ? "precedes" : "is absent before"} it`, () => {
        const natives = load(shape, i);
        const ask = askIndex(natives);
        expect(ask).toBeGreaterThanOrEqual(0);
        expect(natives[ask]!.author).toBe("agent");
        expect(askIds(natives)).toHaveLength(1);
        const firstNext = natives.findIndex((e) => e.author === "next");
        expect(firstNext).toBeGreaterThan(ask);
        expect(natives.slice(firstNext).every((e) => e.author === "next")).toBe(true);
        const last = natives[natives.length - 1]!;
        expect(last.author).toBe("next");
        expect(isFinal(last)).toBe(true);
        // The ask stays pending: no functionResponse answers its adk_request_* call.
        const [askId] = askIds(natives);
        expect(natives.some((e) => parts(e).some((p) => p.functionResponse?.id === askId))).toBe(false);
        const ends = natives.flatMap((e, k) => (isPauseEnd(e) ? [k] : []));
        const agentFinalsWhileAsking = natives.flatMap((e, k) => (k > ask && k < firstNext && e.author === "agent" && isFinal(e) ? [k] : []));
        if (REAL.includes(shape)) {
          expect(ends).toHaveLength(1);
          expect(natives[ends[0]!]!.author).toBe("agent");
          expect(ends[0]!).toBeGreaterThanOrEqual(ask);
          expect(ends[0]!).toBeLessThan(firstNext);
          expect(agentFinalsWhileAsking).toEqual([]);
        } else if (shape === SSE_STRIP) {
          expect(ends).toEqual([]);
          expect(agentFinalsWhileAsking.length).toBeGreaterThan(0);
        } else {
          expect(ends).toEqual([]);
          expect(agentFinalsWhileAsking).toEqual([]);
        }
      });
    }
  }

  for (const shape of REAL) {
    for (const i of INSTANCES) {
      it(`${shape}.${i}: the pause-end event signals — paused at flush and on host completion; a host error closes paused, then the error turn`, () => {
        const natives = asJson(load(shape, i));
        const ids = askIds(load(shape, i));
        for (const host of ["none", "complete"] as const) {
          const { events, r } = drive(natives, host);
          expectClean(events, r);
          expect(closes(events).map(strip)).toEqual([PAUSED(ids)]);
        }
        const { events, r } = drive(natives, "error");
        expectClean(events, r);
        const c = closes(events);
        expect(c.map(strip)).toEqual([PAUSED(ids), { type: "turn.error", code: "HostError" }]);
        expect(c[1]!.turnId).toBe(`${c[0]!.turnId}_error`);
      });
    }
  }

  for (const shape of STRIP) {
    for (const i of INSTANCES) {
      it(`${shape}.${i}: only another agent's final follows the pending ask — flush closes a truncation, a host error closes item 35's turn.error, never paused`, () => {
        const natives = asJson(load(shape, i));
        const bare = drive(natives, "none");
        expectClean(bare.events, bare.r);
        expect(closes(bare.events).map(strip)).toEqual([{ type: "turn.abort", reason: "stream-truncated" }]);
        const err = drive(natives, "error");
        expectClean(err.events, err.r);
        expect(closes(err.events).map(strip)).toEqual([{ type: "turn.error", code: "HostError" }]);
        // Host obligation 4 (SPEC §8.0): on the host-completion event a turn with an ask pending closes paused, signal or not.
        const hc = drive(natives, "complete");
        expectClean(hc.events, hc.r);
        expect(closes(hc.events).map(strip)).toEqual([PAUSED(askIds(load(shape, i)))]);
      });
    }
  }

  for (const i of INSTANCES) {
    it(`${SSE_STRIP}.${i}: the pausing agent's own final while the ask is pending signals — paused at flush; a host error closes paused, then the error turn`, () => {
      const natives = asJson(load(SSE_STRIP, i));
      const ids = askIds(load(SSE_STRIP, i));
      const bare = drive(natives, "none");
      expectClean(bare.events, bare.r);
      expect(closes(bare.events).map(strip)).toEqual([PAUSED(ids)]);
      const err = drive(natives, "error");
      expectClean(err.events, err.r);
      expect(closes(err.events).map(strip)).toEqual([PAUSED(ids), { type: "turn.error", code: "HostError" }]);
    });

    it(`PLANTED ${SSE_STRIP}.${i} with \`agent\`'s finals re-authored as \`next\` (the author the only change): no signal — a truncation at flush, item 35's turn.error on a host error`, () => {
      const real = load(SSE_STRIP, i);
      const ask = askIndex(real);
      let moved = 0;
      const planted = real.map((e, k) => {
        if (k > ask && e.author === "agent" && isFinal(e)) {
          moved++;
          return { ...e, author: "next" };
        }
        return e;
      });
      expect(moved).toBeGreaterThan(0);
      const bare = drive(asJson(planted), "none");
      expectClean(bare.events, bare.r);
      expect(closes(bare.events).map(strip)).toEqual([{ type: "turn.abort", reason: "stream-truncated" }]);
      const err = drive(asJson(planted), "error");
      expectClean(err.events, err.r);
      expect(closes(err.events).map(strip)).toEqual([{ type: "turn.error", code: "HostError" }]);
    });
  }

  /** Run identity, masked for the plant/engine differential: every UUID-shaped
   *  string (renumbered by first occurrence), `timestamp`, and an event's own
   *  `id` (ADK's 8-character random event id, renumbered likewise). Nothing
   *  else is masked, the pause-end members included. */
  function canon(natives: Native[]): string {
    const seen = new Map<string, string>();
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    return JSON.stringify(natives, (key, value: unknown) => {
      if (key === "timestamp") return undefined;
      if (key === "id" && typeof value === "string" && /^[A-Za-z0-9]{8}$/.test(value)) {
        if (!seen.has(value)) seen.set(value, `E${seen.size}`);
        return seen.get(value);
      }
      if (typeof value === "string")
        return value.replace(uuid, (u) => {
          if (!seen.has(u)) seen.set(u, `U${seen.size}`);
          return seen.get(u)!;
        });
      return value;
    });
  }

  for (const kind of KINDS) {
    for (const i of INSTANCES) {
      it(`PLANTED seq-${kind}.${i} minus its pause-end members closes as the engine's seq-${kind}-strip.${i} does, and equals it modulo run identity`, () => {
        const real = load(`seq-${kind}`, i);
        let removed = 0;
        const planted = real.map((e) => {
          if (!isPauseEnd(e)) return e;
          removed++;
          const { skipSummarization: _s, ...rest } = e.actions ?? {};
          return { ...e, actions: { ...rest, requestedAuthConfigs: {}, requestedToolConfirmations: {} } };
        });
        expect(removed).toBe(1);
        const engine = load(`seq-${kind}-strip`, i);
        expect(canon(planted)).toBe(canon(engine));
        for (const host of ["none", "error"] as const) {
          expect(closes(drive(asJson(planted), host).events).map(strip)).toEqual(closes(drive(asJson(engine), host).events).map(strip));
        }
      });
    }
  }
});
