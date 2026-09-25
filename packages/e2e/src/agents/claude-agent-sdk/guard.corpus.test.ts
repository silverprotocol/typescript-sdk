/**
 * The claude facet's last-resort push() guard (core withAtomicPush's non-terminal
 * `error` event `{message: "normalizer error", code}`, claude-agent-sdk/src/index.ts
 * `createClaudeNormalizer`) must fire ZERO times over every committed claude
 * native.
 *
 * The guard exists so a facet bug on a malformed frame degrades visibly instead
 * of throwing out of push() (SPEC.md:933). A guard that fired on real wire would
 * HIDE that bug behind a green replay, so this leg keeps a fired guard a red
 * test. It is not a snapshot: it replays the natives through a fresh normalizer
 * and counts guard events, so a regen can never bless a firing.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NORMALIZER_ERROR_MESSAGE, type AgEvent, type JsonValue } from "@silverprotocol/core";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";

const CORPUS = join(import.meta.dirname, "..", "..", "..", "corpus");

function claudeNatives(): Array<[string, JsonValue[]]> {
  const out: Array<[string, JsonValue[]]> = [];
  for (const scenario of readdirSync(CORPUS).sort()) {
    const file = join(CORPUS, scenario, "claude.native.json");
    if (!existsSync(file)) continue;
    const parsed: JsonValue = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) out.push([scenario, parsed]);
  }
  return out;
}

function guardFirings(events: readonly AgEvent[]): AgEvent[] {
  return events.filter((e) => e.type === "error" && e.message === NORMALIZER_ERROR_MESSAGE);
}

describe("claude last-resort push() guard — fires 0 times over the committed corpus", () => {
  const natives = claudeNatives();

  it("the corpus actually holds claude natives (the leg is not vacuous)", () => {
    expect(natives.length).toBeGreaterThanOrEqual(20);
    for (const [, events] of natives) expect(events.length).toBeGreaterThan(0);
  });

  it.each(natives)("%s: every native maps with ZERO guard firings", (_scenario, events) => {
    const n = createClaudeNormalizer();
    const emitted = events.flatMap((e) => n.push(e)).concat(n.flush());
    expect(guardFirings(emitted)).toEqual([]);
  });
});

// Determinism (withAtomicPush's precondition): a throw rebuilds the
// inner normalizer by re-driving the journal, so the rebuilt state must equal
// the original exactly. Inject one throwing frame, envelope-valid but malformed
// (an assistant frame whose second content block is null: it opens its turn,
// message and first block, THEN throws), at the MIDDLE of every committed claude
// stream. The output must be the untouched stream plus ONE error event, seq
// ascending and gap-free. Any facet nondeterminism (clock, randomness,
// iteration-order drift) would show here. invokeId is pinned so the two
// normalizers share their fallback id stem (the only per-invoke randomness,
// minted outside the rebuild).
describe("claude withAtomicPush rebuild is deterministic over the committed corpus", () => {
  const THROWING_NATIVE: JsonValue = {
    type: "assistant",
    message: { id: "msg_guard_throw", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "x", citations: null }, null], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-00000000g000",
    session_id: "guard",
  };
  const stripSeq = (evs: readonly AgEvent[]): unknown[] => evs.map((e) => ({ ...e, seq: 0 }));

  it.each(claudeNatives())("%s: a mid-stream throw ⇒ the untouched stream + one error, seq gap-free", (_scenario, events) => {
    const baseline = (() => {
      const n = createClaudeNormalizer({ invokeId: "guard" });
      return events.flatMap((e) => n.push(e)).concat(n.flush());
    })();
    const k = Math.floor(events.length / 2);
    const injected = (() => {
      const n = createClaudeNormalizer({ invokeId: "guard" });
      const out: AgEvent[] = [];
      events.forEach((e, i) => {
        if (i === k) out.push(...n.push(THROWING_NATIVE));
        out.push(...n.push(e));
      });
      return out.concat(n.flush());
    })();
    expect(guardFirings(injected)).toHaveLength(1);
    expect(stripSeq(injected.filter((e) => guardFirings([e]).length === 0))).toEqual(stripSeq(baseline));
    injected.forEach((e, i) => expect(e.seq).toBe(i));
  });
});
