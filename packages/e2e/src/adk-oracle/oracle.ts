/**
 * The google-adk text-window oracle: folds an engine-built native stream through the facet and core, and scores
 * the fold's text against the text each model call (or remote window) was meant to produce.
 *
 * The match partitions the fold's text blocks, in fold order across all messages, onto the intended units. A block
 * extends the first unfinished unit of one source, or starts a later unit of it (the rest of the units it passes is
 * charged as UNDER), and may run on into that source's next unit; a source's units are consumed in order, and
 * different sources may interleave. The best partition minimises OVER (block
 * characters assigned to no unit) plus UNDER (unit characters no block covers), OVER breaking ties. A fold that
 * needs a resync is reported apart (`park`). Reasoning blocks are not scored.
 */
import { reduce, type AgEvent } from "@silverprotocol/core";
import { createAdkNormalizer } from "@silverprotocol/google-adk";

export type Unit = { source: string; call: string | number; seg: number; text: string };
export type Reading = "raw" | "callback";
export type Oracle = {
  leg: string;
  mode: string;
  hcOnly: boolean;
  residual?: string;
  threw: { name: string; message: string } | null;
  note: string | null;
  expected: Reading;
  readings: { raw: Unit[]; callback?: Unit[] };
};
export type Score = { over: number; under: number };
export type Verdict = "MATCH" | "OVER" | "UNDER" | "OVER+UNDER";
/** One leg-mode-fold's recorded result. `blocks` / `units` (the unit diff) only when the verdict is not MATCH. */
export type FoldRecord = {
  verdict: Verdict;
  over: number;
  under: number;
  park: boolean;
  status: "clean" | "by-design" | "stated-residual" | "known-defect";
  alt?: { reading: Reading; verdict: Verdict; over: number; under: number };
  blocks?: string[];
  units?: string[];
};

export function match(blocks: string[], units: Unit[]): Score {
  const sources = [...new Set(units.map((u) => u.source))];
  const queue = sources.map((s) => units.filter((u) => u.source === s).map((u) => u.text).join("\u0000"));
  const chars = (s: number, from: number, to: number) => queue[s]!.slice(from, to).replace(/\u0000/g, "").length;
  const memo = new Map<string, Score>();
  const go = (b: number, pos: number[]): Score => {
    const key = b + ":" + pos.join(",");
    const hit = memo.get(key);
    if (hit) return hit;
    let best: Score;
    if (b === blocks.length) {
      best = { over: 0, under: pos.reduce((a, p, s) => a + chars(s, p, queue[s]!.length), 0) };
    } else {
      const blk = blocks[b]!;
      const skip = go(b + 1, pos);
      best = { over: skip.over + blk.length, under: skip.under };
      for (let s = 0; s < queue.length; s++) {
        const rest = queue[s]!;
        let p = pos[s]!;
        while (rest[p] === "\u0000") p++; // a finished unit: continue into the source's next one
        const starts = [p];
        for (let k = p + 1; k < rest.length; k++) if (rest[k - 1] === "\u0000") starts.push(k); // or start a later unit
        for (const st of starts) {
          let i = 0;
          let j = st;
          while (i < blk.length && j < rest.length) {
            if (rest[j] === "\u0000") { j++; continue; }
            if (rest[j] !== blk[i]) break;
            i++; j++;
          }
          if (i !== blk.length || blk.length === 0) continue;
          const next = pos.slice();
          next[s] = j;
          const r = go(b + 1, next);
          const cand = { over: r.over, under: r.under + chars(s, pos[s]!, st) }; // the units it passes are UNDER
          if (cand.over + cand.under < best.over + best.under || (cand.over + cand.under === best.over + best.under && cand.over < best.over)) best = cand;
        }
      }
    }
    memo.set(key, best);
    return best;
  };
  return go(0, sources.map(() => 0));
}

/** Folds natives through the facet, bare or with host completion; a run that threw is closed by a host error. */
export function fold(natives: unknown[], hc: boolean, threw: Oracle["threw"]): { blocks: string[]; park: boolean } {
  const n = createAdkNormalizer({ invokeId: "o", ...(hc ? { hostCompletion: true } : {}) });
  const out: AgEvent[] = [];
  for (const e of natives) out.push(...n.push(e as never));
  if (threw) out.push(...n.push({ type: "__host_error__", code: threw.name, message: threw.message } as never));
  else if (hc) out.push(...n.push({ type: "__host_complete__" } as never));
  out.push(...n.flush());
  const r = reduce(out);
  const messages = (r.result as unknown as { messages?: Array<{ content?: Array<{ type: string; text?: unknown }> }> }).messages ?? [];
  const blocks = messages.flatMap((m) => (m.content ?? []).filter((b) => b.type === "text" && typeof b.text === "string" && b.text !== "").map((b) => b.text as string));
  return { blocks, park: r.needsResync };
}

const verdictOf = (s: Score): Verdict => (s.over && s.under ? "OVER+UNDER" : s.over ? "OVER" : s.under ? "UNDER" : "MATCH");

/** One fold's record; its status is provisional until scoreLeg() reads the fold's host-completed twin. */
export function score(o: Oracle, natives: unknown[], hc: boolean): FoldRecord {
  const f = fold(natives, hc, o.threw);
  const units = o.readings[o.expected] ?? o.readings.raw;
  const s = match(f.blocks, units);
  const verdict = verdictOf(s);
  const clean = verdict === "MATCH" && !f.park;
  const rec: FoldRecord = { verdict, over: s.over, under: s.under, park: f.park, status: clean ? "clean" : o.hcOnly && !hc ? "by-design" : o.residual ? "stated-residual" : "known-defect" };
  const altName: Reading = o.expected === "raw" ? "callback" : "raw";
  const alt = o.readings[altName];
  if (alt) { const a = match(f.blocks, alt); rec.alt = { reading: altName, verdict: verdictOf(a), over: a.over, under: a.under }; }
  if (verdict !== "MATCH") { rec.blocks = f.blocks; rec.units = units.map((u) => u.text); }
  return rec;
}

/** Both folds of a leg-mode. A non-clean fold is a known defect, or a stated residual when the leg names one. A bare
 *  fold of an `hcOnly` leg (a root the facet documents as host-completion-only: a multi-agent root, an after-agent
 *  append; google-adk README, "Completion") is by design only when its host-completed twin is clean; otherwise it
 *  takes its twin's status. */
export function scoreLeg(o: Oracle, natives: unknown[]): { bare: FoldRecord; hc: FoldRecord } {
  const hc = score(o, natives, true);
  const bare = score(o, natives, false);
  if (hc.status === "by-design") hc.status = o.residual ? "stated-residual" : "known-defect";
  if (bare.status !== "clean") bare.status = o.hcOnly && hc.status === "clean" ? "by-design" : hc.status === "clean" ? (o.residual ? "stated-residual" : "known-defect") : hc.status;
  return { bare, hc };
}

/** Moves between two records of one fold, worded for a receipt: "WORSE OVER 0→5", "BETTER park yes→no", …
 *  A park gained is WORSE whatever else moved; components moving opposite ways are MIXED; a move of the status,
 *  the alternative reading or the blocks alone is CHANGED. */
export function moves(was: FoldRecord | undefined, now: FoldRecord): { direction: "WORSE" | "BETTER" | "MIXED" | "CHANGED" | "NEW"; detail: string } | null {
  if (!was) return { direction: "NEW", detail: `${now.verdict}${now.park ? " +park" : ""}` };
  if (JSON.stringify(was) === JSON.stringify(now)) return null;
  const parts: string[] = [];
  if (was.status !== now.status) parts.push(`status ${was.status}→${now.status}`);
  if (was.over !== now.over) parts.push(`OVER ${was.over}→${now.over}`);
  if (was.under !== now.under) parts.push(`UNDER ${was.under}→${now.under}`);
  if (was.park !== now.park) parts.push(`park ${was.park ? "yes" : "no"}→${now.park ? "yes" : "no"}`);
  if (JSON.stringify(was.alt) !== JSON.stringify(now.alt)) parts.push(`alt ${was.alt ? `OVER ${was.alt.over}/UNDER ${was.alt.under}` : "none"}→${now.alt ? `OVER ${now.alt.over}/UNDER ${now.alt.under}` : "none"}`);
  if (JSON.stringify(was.blocks) !== JSON.stringify(now.blocks)) parts.push(`blocks ${was.blocks?.length ?? 0}→${now.blocks?.length ?? 0}`);
  const signs = [Math.sign(now.over - was.over), Math.sign(now.under - was.under), Math.sign(Number(now.park) - Number(was.park))].filter((x) => x !== 0);
  const direction = !was.park && now.park ? "WORSE" : signs.includes(1) && signs.includes(-1) ? "MIXED" : signs.includes(1) ? "WORSE" : signs.includes(-1) ? "BETTER" : "CHANGED";
  return { direction, detail: parts.join(", ") };
}
