/**
 * trigger-carrier.corpus.test.ts — pkg-07 leg F5 (the trigger/carrier
 * agreement). On every claude golden, the turns whose turn.start carries
 * `trigger.ref` R are exactly the turns whose opening frame stamped
 * `user_message_uuid` R, which the facet carries on the first block's `_meta`
 * or as `message.metadata` (draft.5 host records). No turn.start carries a
 * trigger without that stamp, and no openai, adk or vercel golden carries a
 * trigger at all. It reads the committed goldens, so it pins their shape; the
 * replay deep-equal pins the facet to them.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CORPUS = join(import.meta.dirname, "..", "corpus");
type Ev = { [k: string]: any };

function agreement(events: Ev[]): { triggers: Map<string, Set<string>>; stamps: Map<string, Set<string>> } {
  const triggers = new Map<string, Set<string>>();
  const stamps = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, ref: unknown, turnId: unknown) => {
    if (typeof ref !== "string" || typeof turnId !== "string") return;
    if (!m.has(ref)) m.set(ref, new Set());
    m.get(ref)!.add(turnId);
  };
  const msgTurn = new Map<string, string>();
  for (const e of events) {
    if (e["type"] === "message.start") msgTurn.set(e["id"], e["turnId"]);
    if (e["type"] === "turn.start" && e["trigger"] !== undefined) add(triggers, e["trigger"]?.ref, e["turnId"]);
    if (e["type"] === "message.metadata") add(stamps, e["metadata"]?.["user_message_uuid"], msgTurn.get(e["messageId"]));
    if (/\.start$/.test(String(e["type"])) && e["_meta"] !== undefined) add(stamps, e["_meta"]?.["user_message_uuid"], e["turnId"] ?? msgTurn.get(e["messageId"]));
  }
  return { triggers, stamps };
}
const canon = (m: Map<string, Set<string>>) => JSON.stringify([...m].map(([k, v]) => [k, [...v].sort()]).sort());

describe("pkg-07 F5: turn.start trigger ↔ user_message_uuid stamp agreement over the corpus", () => {
  it("claude goldens: trigger refs and stamps name the same turns; other frameworks carry no trigger", () => {
    let triggerCount = 0;
    const wrong: string[] = [];
    for (const d of readdirSync(CORPUS).sort()) {
      for (const f of readdirSync(join(CORPUS, d)).filter((x) => x.endsWith(".agjson.json")).sort()) {
        const evs = JSON.parse(readFileSync(join(CORPUS, d, f), "utf8")) as Ev[];
        const { triggers, stamps } = agreement(evs);
        for (const s of triggers.values()) triggerCount += s.size;
        if (!f.startsWith("claude.")) {
          if (triggers.size > 0) wrong.push(`${d}/${f}: a non-claude golden carries a trigger`);
          continue;
        }
        if (canon(triggers) !== canon(stamps)) wrong.push(`${d}/${f}: triggers ${canon(triggers)} ≠ stamps ${canon(stamps)}`);
      }
    }
    expect(wrong).toEqual([]);
    // Non-vacuity: the streaming-input seeds carry live triggers.
    expect(triggerCount).toBeGreaterThanOrEqual(5);
  });
});
