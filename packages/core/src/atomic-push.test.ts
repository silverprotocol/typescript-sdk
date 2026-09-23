import { afterEach, describe, expect, it, vi } from "vitest";
import { AgEvent } from "./agjson.js";
import { Reducer } from "./reduce.js";
import { StreamAssembler, type Normalizer } from "./stream-assembler.js";
import { withAtomicPush, NORMALIZER_ERROR_MESSAGE, normalizerErrorCode } from "./atomic-push.js";

/** A small deterministic facet over StreamAssembler, with injectable throws. */
type Toy = { t: string; [k: string]: unknown };
function createToy(opts: { throwOnFlush?: boolean } = {}): Normalizer {
  const a = new StreamAssembler();
  return {
    push(native: unknown): AgEvent[] {
      const n = native as Toy;
      switch (n.t) {
        case "turn":
          a.openTurn(n["id"] as string, "th");
          break;
        case "msg":
          a.openMessage({ id: n["id"] as string, role: "assistant", turnId: n["turn"] as string, threadId: "th" });
          break;
        case "text":
          a.textStart(n["id"] as string, n["msg"] as string);
          a.textDelta(n["id"] as string, n["msg"] as string, n["s"] as string);
          a.textEnd(n["id"] as string, n["msg"] as string);
          break;
        case "boom-after-open": // opens a message, then throws: the batch must vanish
          a.openMessage({ id: n["id"] as string, role: "assistant", turnId: n["turn"] as string, threadId: "th" });
          a.textStart(`${n["id"] as string}:b`, n["id"] as string);
          throw new Error(`SECRET_error_marker ${JSON.stringify(n)}`);
        case "end":
          a.closeMessage(n["msg"] as string);
          break;
        case "done":
          a.closeTurnDone(n["turn"] as string, { outcome: { type: "success" }, finishReason: "stop" });
          break;
        default:
          break;
      }
      return a.drain();
    },
    flush(): AgEvent[] {
      if (opts.throwOnFlush) throw new TypeError("SECRET_flush_marker");
      return a.flush();
    },
  };
}
const run = (n: Normalizer, natives: unknown[]): AgEvent[] => [...natives.flatMap((x) => n.push(x)), ...n.flush()];
const fold = (evs: AgEvent[]) => {
  const r = new Reducer();
  for (const e of evs) r.push(e);
  return r;
};
const seqs = (evs: AgEvent[]) => evs.map((e) => e.seq);
const contiguous = (evs: AgEvent[]) => seqs(evs).every((s, i) => s === i);

const PREFIX: Toy[] = [
  { t: "turn", id: "T" },
  { t: "msg", id: "M1", turn: "T" },
  { t: "text", id: "X1", msg: "M1", s: "hello" },
];
const BAD: Toy = { t: "boom-after-open", id: "M2", turn: "T", secret: "SECRET_native_marker" };
const REST: Toy[] = [
  { t: "text", id: "X2", msg: "M1", s: "world" },
  { t: "end", msg: "M1" },
  { t: "done", turn: "T" },
];

/** The differential expectation: the stream WITHOUT `bad`, with ONE error at its
 *  position and every later seq shifted by +1. */
function expected(atIndexOfBad: number, withoutBad: AgEvent[], code: string): AgEvent[] {
  const errorSeq = atIndexOfBad;
  return [
    ...withoutBad.slice(0, atIndexOfBad),
    { type: "error", seq: errorSeq, message: NORMALIZER_ERROR_MESSAGE, code },
    ...withoutBad.slice(atIndexOfBad).map((e) => ({ ...e, seq: e.seq + 1 })),
  ];
}

describe("withAtomicPush (per-native atomicity, the fleet guard; option B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("differential: push(prefix, bad, rest) ≡ push(prefix, rest) + one error at bad's position; the +1 renumbering is explicit", () => {
    const reference = run(createToy(), [...PREFIX, ...REST]);
    const refPrefixLen = run(createToy(), PREFIX).filter((e) => e.type !== "turn.abort" && e.type !== "message.end").length;
    const got = run(withAtomicPush(() => createToy()), [...PREFIX, BAD, ...REST]);
    expect(got).toEqual(expected(refPrefixLen, reference, "Error"));
    expect(contiguous(got)).toBe(true);
    // The half-opened M2 never reaches the wire.
    expect(JSON.stringify(got)).not.toContain('"M2"');
  });

  it("the throw after an open leaves no park, INV-MSG and INV-BLOCK hold", () => {
    const got = run(withAtomicPush(() => createToy()), [...PREFIX, BAD, ...REST]);
    const r = fold(got);
    expect(r.needsResync).toBe(false);
    const res = r.result();
    expect(res.messages.map((m) => m.id)).toEqual(["M1"]);
    expect(res.messages[0]?.content.map((b) => (b as { text?: string }).text)).toEqual(["hello", "world"]);
    expect(res.turns.map((t) => t.turnId)).toEqual(["T"]);
  });

  it("neither the error's message nor the native reaches the wire: only the constructor name", () => {
    const got = run(withAtomicPush(() => createToy()), [...PREFIX, BAD, ...REST]);
    expect(JSON.stringify(got)).not.toContain("SECRET_");
    expect(got.filter((e) => e.type === "error")).toEqual([
      expect.objectContaining({ message: NORMALIZER_ERROR_MESSAGE, code: "Error" }),
    ]);
  });

  it("two throws: seq stays ascending and gap-free and never repeats (+1 per error)", () => {
    const bad2: Toy = { ...BAD, id: "M3" };
    const got = run(withAtomicPush(() => createToy()), [...PREFIX, BAD, { t: "text", id: "X2", msg: "M1", s: "a" }, bad2, ...REST.slice(1)]);
    expect(contiguous(got)).toBe(true);
    expect(got.filter((e) => e.type === "error")).toHaveLength(2);
    expect(fold(got).needsResync).toBe(false);
  });

  it("no throw: the inner's events come back unchanged (same references)", () => {
    const inner = createToy();
    const pushes: AgEvent[][] = [];
    const wrapped = withAtomicPush(() => ({
      push: (n) => {
        const out = inner.push(n);
        pushes.push(out);
        return out;
      },
      flush: () => inner.flush(),
    }));
    for (const [i, n] of [...PREFIX, ...REST].entries()) {
      const out = wrapped.push(n);
      out.forEach((e, j) => expect(e).toBe(pushes[i]?.[j]));
    }
  });

  it("flush() that throws: error, then the wrapper closes what the consumer saw open (INV-FLUSH), no throw", () => {
    const got = run(withAtomicPush(() => createToy({ throwOnFlush: true })), PREFIX);
    expect(got.map((e) => e.type).slice(-3)).toEqual(["error", "message.end", "turn.abort"]);
    expect(JSON.stringify(got)).not.toContain("SECRET_");
    expect(got.find((e) => e.type === "error")).toMatchObject({ code: "TypeError" });
    expect(contiguous(got)).toBe(true);
    expect(fold(got).needsResync).toBe(false);
  });

  it("the journal holds COPIES: a host mutating a pushed native later cannot skew a rebuild", () => {
    const natives: Toy[] = structuredClone([...PREFIX]);
    const wrapped = withAtomicPush(() => createToy());
    const got: AgEvent[] = [];
    for (const n of natives) got.push(...wrapped.push(n));
    for (const n of natives) n["id"] = "MUTATED"; // host mutation after push
    for (const n of [BAD, ...REST]) got.push(...wrapped.push(n));
    got.push(...wrapped.flush());
    expect(JSON.stringify(got)).not.toContain("MUTATED");
    expect(fold(got).needsResync).toBe(false);
  });

  it("determinism is pinned: a poisoned clock and poisoned randomness during the re-drive change nothing", () => {
    const clean = run(withAtomicPush(() => createToy()), [...PREFIX, BAD, ...REST]);
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now called during a rebuild");
    });
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random called during a rebuild");
    });
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("randomUUID called during a rebuild");
    });
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("getRandomValues called during a rebuild");
    });
    const poisoned = run(withAtomicPush(() => createToy()), [...PREFIX, BAD, ...REST]);
    expect(poisoned).toEqual(clean);
  });

  it("a throw during the rebuild itself (double fault) is caught: push() still never throws", () => {
    let builds = 0;
    const wrapped = withAtomicPush(() => {
      builds++;
      const inner = createToy();
      return {
        push: (n) => {
          if (builds > 1 && (n as Toy).t === "msg") throw new RangeError("rebuild fault");
          return inner.push(n);
        },
        flush: () => inner.flush(),
      };
    });
    const got: AgEvent[] = [];
    expect(() => {
      for (const n of [...PREFIX, BAD, ...REST]) got.push(...wrapped.push(n));
      got.push(...wrapped.flush());
    }).not.toThrow();
    expect(got.filter((e) => e.type === "error").length).toBeGreaterThanOrEqual(1);
  });

  it("normalizerErrorCode: the constructor name only", () => {
    expect(normalizerErrorCode(new TypeError("SECRET_x"))).toBe("TypeError");
    expect(normalizerErrorCode(new (class MyErr extends Error {})("y"))).toBe("MyErr");
    expect(normalizerErrorCode("a string")).toBe("NonError");
  });
});
