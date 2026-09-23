/**
 * cross-invoke-ids.test.ts — turn ids never repeat across the invokes of one
 * fold (sp-protocol's D3 bar, DC-10; rd-14's "ids unique across invokes").
 *
 * guuey folds a whole conversation into ONE Reducer, one invoke after another,
 * each from a fresh normalizer (SPEC §8.0 Lifetime). An id minted from the
 * native (a response id, an invocation id, a result uuid) is unique by
 * construction; a FALLBACK id minted when the native has none must be unique
 * too, or two invokes name the same turn. Each leg drives a facet's fallback
 * path twice, with two fresh normalizers built the way a host builds them,
 * folds both into one Reducer, and asserts no turnId repeats. A repeated
 * closed turn does not always park the reducer, so the ids are compared
 * directly; the fold's needsResync is asserted too.
 */
import { describe, expect, it } from "vitest";
import { Reducer, type AgEvent, type Normalizer } from "@silverprotocol/core";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { createVercelNormalizer } from "@silverprotocol/vercel-ai";

const run = (n: Normalizer, natives: unknown[]): AgEvent[] => [...natives.flatMap((x) => n.push(x)), ...n.flush()];
const turnIds = (evs: AgEvent[]) => evs.filter((e) => e.type === "turn.start").map((e) => (e as { turnId: string }).turnId);
const U = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const LEGS: Array<{ facet: string; path: string; make: () => Normalizer; natives: unknown[] }> = [
  {
    facet: "openai",
    path: "a host error with no turn open (the max_turns sentinel)",
    make: () => createOpenaiNormalizer(),
    natives: [{ type: "__host_error__", code: "max_turns", message: "Max turns exceeded" }],
  },
  {
    facet: "openai",
    path: "text before any response.created (no response id)",
    make: () => createOpenaiNormalizer(),
    natives: [{ type: "raw_model_stream_event", data: { type: "model", event: { type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: "hi" } } }],
  },
  {
    facet: "google-adk",
    path: "a host error with no turn open",
    make: () => createAdkNormalizer(),
    natives: [{ type: "__host_error__", code: "E", message: "failed" }],
  },
  {
    facet: "google-adk",
    path: "an event with neither invocationId nor id",
    make: () => createAdkNormalizer(),
    natives: [{ author: "agent", content: { role: "model", parts: [{ text: "hi" }] } }],
  },
  {
    facet: "claude",
    path: "a result frame without uuid (the positional turn_frame_<n> fallback)",
    make: () => createClaudeNormalizer(),
    natives: [
      { type: "result", subtype: "success", is_error: false, result: "hi", session_id: "s", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] },
    ],
  },
  {
    facet: "vercel-ai",
    path: "the default id stem (no invokeId)",
    make: () => createVercelNormalizer(),
    natives: [
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", text: "hi" },
      { type: "text-end", id: "t" },
      { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage: U, response: { id: "r", timestamp: "1970-01-01T00:00:00.000Z", modelId: "m" } },
      { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: U },
    ],
  },
];

describe("cross-invoke turn ids: two invokes of one facet, folded into ONE Reducer, never repeat a turnId (D3 bar, DC-10)", () => {
  for (const { facet, path, make, natives } of LEGS) {
    it(`${facet}: ${path}`, () => {
      const first = run(make(), natives);
      const second = run(make(), natives);
      expect(turnIds(first).length, "the first invoke opened a turn (non-vacuity)").toBeGreaterThan(0);
      expect(turnIds(second).length, "the second invoke opened a turn (non-vacuity)").toBeGreaterThan(0);
      const repeated = turnIds(second).filter((t) => turnIds(first).includes(t));
      expect(repeated, "turnIds of invoke 2 that invoke 1 already used").toEqual([]);
      const r = new Reducer();
      for (const e of [...first, ...second]) r.push(e);
      expect(r.needsResync).toBe(false);
      expect(r.result().turns.length).toBe(turnIds(first).length + turnIds(second).length);
    });
  }
});
