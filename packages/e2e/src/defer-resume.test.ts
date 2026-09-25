/**
 * defer-resume.test.ts — c20, draft.5 §10 item 47 (the cross-invoke tool
 * result): the two-invoke pairs the corpus holds, each folded the way a host
 * folds them, with one Normalizer per invoke (§8.0 Lifetime) and ONE Reducer
 * over both invokes.
 *
 *  - pair-claude: defer-tool-sonnet5 (the deferred call; it closes paused with
 *    one approval ask) + each of -resume-allow / -resume-deny, with one
 *    threadId passed to both normalizers (the forked resume carries its own
 *    session id).
 *  - pair-openai: approval-tool-gpt6sol + each of -resume-approve /
 *    -resume-reject.
 *
 * The resume's result is a cross-invoke tool result: the resuming invoke opens
 * its own turn, emits no tool.start for the call, and lands exactly one final
 * tool.done naming its own `<toolCallId>:result` message, which folds to a
 * role:"tool" message beside the first invoke's tool-call. §10.27(producers)
 * checks turn.start / message.start id recurrence across a fold; this test
 * adds the messageId recurrence it does not make. pair-vercel is a synthetic
 * fixture pair in vercel-ai's own suite.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Reducer, type AgEvent, type JsonValue } from "@silverprotocol/core";
import { replayNatives } from "./replay.js";

const CORPUS = join(import.meta.dirname, "..", "corpus");
type Ev = AgEvent & { [k: string]: unknown };

async function replay(scenario: string, fw: "claude" | "openai", threadId?: string): Promise<Ev[]> {
  const native = JSON.parse(readFileSync(join(CORPUS, scenario, `${fw}.native.json`), "utf8")) as JsonValue[];
  return (await replayNatives(native, fw, threadId !== undefined ? { threadId } : {})).agjson as unknown as Ev[];
}
function fold(evs: Ev[]): Reducer {
  const r = new Reducer();
  for (const e of evs) r.push(e);
  return r;
}
const turnStarts = (evs: Ev[]) => new Set(evs.filter((e) => e.type === "turn.start").map((e) => e["turnId"] as string));
const messageIds = (evs: Ev[]) => new Set(evs.filter((e) => e.type === "message.start").map((e) => e["id"] as string));

interface Pair {
  leg: string;
  first: string;
  resume: string;
  fw: "claude" | "openai";
  threadId?: string;
  outcome?: "ok" | "denied";
  resumeTurnId?: (callId: string) => string;
}
const PAIRS: Pair[] = [
  { leg: "pair-claude allow", first: "defer-tool-sonnet5", resume: "defer-tool-sonnet5-resume-allow", fw: "claude", threadId: "th-defer", outcome: "ok" },
  { leg: "pair-claude deny", first: "defer-tool-sonnet5", resume: "defer-tool-sonnet5-resume-deny", fw: "claude", threadId: "th-defer", outcome: "denied" },
  { leg: "pair-openai approve", first: "approval-tool-gpt6sol", resume: "approval-tool-gpt6sol-resume-approve", fw: "openai", resumeTurnId: (id) => `turn_resume_${id}` },
  // agents-core 0.18.0 carries no structural rejection signal, so no outcome is pinned on reject.
  { leg: "pair-openai reject", first: "approval-tool-gpt6sol", resume: "approval-tool-gpt6sol-resume-reject", fw: "openai", resumeTurnId: (id) => `turn_resume_${id}` },
];

describe("§10 item 47: a cross-invoke tool result folds as its own role:'tool' message of the resuming invoke (c20)", () => {
  for (const p of PAIRS) {
    it(`${p.leg}: ${p.first} + ${p.resume}`, async () => {
      const first = await replay(p.first, p.fw, p.threadId);
      const resume = await replay(p.resume, p.fw, p.threadId);

      // The first invoke closes paused with exactly one approval ask; that ask names the call.
      const last = first[first.length - 1]!;
      expect(last.type).toBe("turn.done");
      const asks = ((last as { outcome?: { type?: string; asks?: Array<{ kind: string; toolCallId: string }> } }).outcome ?? {}) as { type?: string; asks?: Array<{ kind: string; toolCallId: string }> };
      expect(asks.type).toBe("paused");
      expect(asks.asks).toHaveLength(1);
      expect(asks.asks![0]!.kind).toBe("approval");
      const id = asks.asks![0]!.toolCallId;
      if (p.fw === "claude") expect(id).toBe("toolu_01BREEQMQdDW8fsY1Gu1W1ZK");

      const r1 = fold(first);
      const r2 = fold(resume);
      const rPair = fold([...first, ...resume]); // the resume's seq restarts at 0
      expect([r1.needsResync, r2.needsResync, rPair.needsResync]).toEqual([false, false, false]);

      // The resuming invoke: no tool.start for the call, exactly one final tool.done.
      expect(resume.filter((e) => e.type === "tool.start" && e["toolCallId"] === id)).toHaveLength(0);
      const finals = resume.filter((e) => e.type === "tool.done" && e["toolCallId"] === id && e["more"] !== true);
      expect(finals).toHaveLength(1);
      const done = finals[0]!;
      // It names a turn this invoke opened, new to the fold, and its own new message.
      expect(turnStarts(resume).has(done["turnId"] as string)).toBe(true);
      expect(turnStarts(first).has(done["turnId"] as string)).toBe(false);
      if (p.resumeTurnId !== undefined) expect(done["turnId"]).toBe(p.resumeTurnId(id));
      expect(done["messageId"]).toBe(`${id}:result`);
      expect(messageIds(first).has(done["messageId"] as string)).toBe(false);

      // The pair fold: one tool-call and one tool-result for the call, in different turns; the result is a tool message.
      const res = rPair.result();
      const msg = res.messages.find((m) => m.id === done["messageId"]);
      expect(msg?.role).toBe("tool");
      const where = (type: string) => res.messages.flatMap((m) => m.content.filter((b) => b.type === type && (b as { toolCallId?: string }).toolCallId === id).map(() => m.turnId));
      expect(where("tool-call")).toHaveLength(1);
      expect(where("tool-result")).toHaveLength(1);
      expect(where("tool-call")[0]).not.toBe(where("tool-result")[0]);

      // The first invoke's turn record is not disturbed by the resume.
      const firstTurn = (last as { turnId: string }).turnId;
      expect(rPair.result().turns.find((t) => t.turnId === firstTurn)).toEqual(r1.result().turns.find((t) => t.turnId === firstTurn));

      if (p.outcome === "ok") expect(done["outcome"]).toBe("ok");
      if (p.outcome === "denied") {
        expect(done["outcome"]).toBe("denied");
        expect("isError" in done).toBe(false);
        expect("errorText" in done).toBe(false);
      }
    });
  }

  it("without one threadId, the claude pair's invokes fold on their own session threads (why replay takes the option)", async () => {
    const first = await replay("defer-tool-sonnet5", "claude");
    const resume = await replay("defer-tool-sonnet5-resume-allow", "claude");
    const t1 = new Set(fold(first).result().turns.map((t) => t.threadId));
    const t2 = new Set(fold(resume).result().turns.map((t) => t.threadId));
    expect([...t1].some((t) => t2.has(t))).toBe(false);
    const pinned = new Set([...fold(await replay("defer-tool-sonnet5", "claude", "th")).result().turns, ...fold(await replay("defer-tool-sonnet5-resume-allow", "claude", "th")).result().turns].map((t) => t.threadId));
    expect([...pinned]).toEqual(["th"]);
  });
});
