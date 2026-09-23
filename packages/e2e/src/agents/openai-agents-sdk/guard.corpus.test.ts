/**
 * The openai facet's last-resort `push()` guard (the core non-terminal `error`
 * event `{message: "normalizer error", code}`, openai-agents/src/index.ts
 * `reportNormalizerError`) must fire ZERO
 * times over every committed openai native (sp-main / sp-cto, 2026-09-24).
 *
 * The guard exists so a facet bug on a malformed event degrades visibly
 * instead of throwing out of push() (SPEC.md:933). But a guard that fires on
 * real wire would HIDE that bug behind a green replay. This leg keeps a fired
 * guard a red test: every real stream the corpus holds must map with no guard
 * firing at all. It is not a snapshot: it replays the natives through a fresh
 * normalizer and counts guard events, so a regen can never bless a firing.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NORMALIZER_ERROR_MESSAGE, type AgEvent, type JsonValue } from "@silverprotocol/core";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";

const CORPUS = join(import.meta.dirname, "..", "..", "..", "corpus");

function openaiNatives(): Array<[string, JsonValue[]]> {
  const out: Array<[string, JsonValue[]]> = [];
  for (const scenario of readdirSync(CORPUS).sort()) {
    const file = join(CORPUS, scenario, "openai.native.json");
    if (!existsSync(file)) continue;
    const parsed: JsonValue = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) out.push([scenario, parsed]);
  }
  return out;
}

function guardFirings(events: readonly AgEvent[]): AgEvent[] {
  return events.filter((e) => e.type === "error" && e.message === NORMALIZER_ERROR_MESSAGE);
}

describe("openai last-resort push() guard — fires 0 times over the committed corpus", () => {
  const natives = openaiNatives();

  it("the corpus actually holds openai natives (the leg is not vacuous)", () => {
    expect(natives.length).toBeGreaterThanOrEqual(10);
    for (const [, events] of natives) expect(events.length).toBeGreaterThan(0);
  });

  it.each(natives)("%s: every native maps with ZERO guard firings", (_scenario, events) => {
    const n = createOpenaiNormalizer({ invokeId: "openai" });
    const emitted = events.flatMap((e) => n.push(e)).concat(n.flush());
    expect(guardFirings(emitted)).toEqual([]);
  });
});

// Determinism (sp-main's precondition for withAtomicPush): a throw rebuilds the
// inner normalizer by re-driving the journal, so the rebuilt state must equal
// the original exactly. Inject one throwing native (an envelope-valid but
// malformed `tool_called` — its drive() dereferences a missing rawItem) at the
// MIDDLE of every committed openai stream: the output must be the untouched
// stream plus ONE error event, with seq ascending and gap-free. Any facet
// nondeterminism (clock, randomness, iteration-order drift) would show here.
describe("openai withAtomicPush rebuild is deterministic over the committed corpus", () => {
  const THROWING_NATIVE: JsonValue = { type: "run_item_stream_event", name: "tool_called", item: {} };
  const stripSeq = (evs: readonly AgEvent[]): unknown[] => evs.map((e) => ({ ...e, seq: 0 }));

  it.each(openaiNatives())("%s: a mid-stream throw ⇒ the untouched stream + one error, seq gap-free", (_scenario, events) => {
    const baseline = (() => {
      const n = createOpenaiNormalizer({ invokeId: "openai" });
      return events.flatMap((e) => n.push(e)).concat(n.flush());
    })();
    const k = Math.floor(events.length / 2);
    const injected = (() => {
      const n = createOpenaiNormalizer({ invokeId: "openai" });
      const out: AgEvent[] = [];
      events.forEach((e, i) => {
        if (i === k) out.push(...n.push(THROWING_NATIVE));
        out.push(...n.push(e));
      });
      return out.concat(n.flush());
    })();
    expect(guardFirings(injected)).toHaveLength(1);
    expect(stripSeq(injected.filter((e) => !guardFirings([e]).length))).toEqual(stripSeq(baseline));
    injected.forEach((e, i) => expect(e.seq).toBe(i));
  });
});
