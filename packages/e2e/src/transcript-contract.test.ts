/**
 * transcript-contract.test.ts — the Layer-B gate (FIXTURES.md "Layer B",
 * workspace#10).
 *
 * Layer-B transcripts are AUTHORED host-plane wire (not framework cassettes):
 * no facet normalizes them and no agjson golden exists, so they do not ride
 * the replay/census/fold machinery. Each enrolls here instead, with a
 * dedicated suite asserting exactly its DECLARED stable set — frame ordering,
 * tool/method names, structural shape, and cross-frame correlation
 * EQUALITIES. Literal values (ids, hashes, timestamps, prose) are incidental
 * per the FIXTURES.md contract and are never asserted.
 *
 * The guest-gesture suite arms itself when the transcript lands
 * (corpus/guest-gesture/ggui.native.json — filed by ggui per workspace#10's
 * enrollment draft; producer-side refresh ritual). Until then it skips, and
 * the always-on enrollment-completeness test below guards against a
 * half-landed enrollment (transcript without provenance, or vice versa).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
const GG_DIR = join(CORPUS_ROOT, "guest-gesture");
const GG_TRANSCRIPT = join(GG_DIR, "ggui.native.json");
const GG_PROVENANCE = join(GG_DIR, "ggui.provenance.json");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function load(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function isObj(v: Json | undefined): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every value found under `key` anywhere in `v` (depth-first, in order). */
function deepCollect(v: Json | undefined, key: string): Json[] {
  const out: Json[] = [];
  const walk = (node: Json | undefined): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isObj(node)) return;
    for (const [k, val] of Object.entries(node)) {
      if (k === key) out.push(val);
      walk(val);
    }
  };
  walk(v);
  return out;
}

/** The single distinct value under `key` in `v` — asserts exactly one. */
function theOne(v: Json | undefined, key: string): Json {
  const distinct = [...new Set(deepCollect(v, key).map((x) => JSON.stringify(x)))];
  expect(distinct, `expected exactly one distinct \`${key}\``).toHaveLength(1);
  return JSON.parse(distinct[0] ?? "null") as Json;
}

// Envelope tolerance: a frame may be a bare payload or a JSON-RPC envelope —
// method/tool discriminants and result bodies are read structurally, not by a
// pinned envelope shape (the envelope framing is ggui's; the STABLE set is
// the discriminants and equalities, per workspace#10).
function methodOf(frame: Json): string | undefined {
  return isObj(frame) && typeof frame["method"] === "string" ? frame["method"] : undefined;
}
function toolNameOf(frame: Json): string | undefined {
  if (!isObj(frame)) return undefined;
  const params = frame["params"];
  if (isObj(params) && typeof params["name"] === "string") return params["name"];
  return undefined;
}
function resultOf(frame: Json): Json {
  return isObj(frame) && frame["result"] !== undefined ? frame["result"] : frame;
}

describe("Layer-B enrollment completeness (always on)", () => {
  it("guest-gesture: transcript and authored provenance land together or not at all", () => {
    if (!existsSync(GG_DIR)) return; // nothing enrolled — nothing to guard
    expect(existsSync(GG_TRANSCRIPT), "ggui.native.json missing").toBe(true);
    expect(existsSync(GG_PROVENANCE), "ggui.provenance.json missing").toBe(true);
    const prov = load(GG_PROVENANCE);
    expect(isObj(prov) && prov["kind"]).toBe("authored");
  });
});

describe.runIf(existsSync(GG_TRANSCRIPT))(
  "transcript-contract — guest-gesture (Layer B, workspace#10)",
  () => {
    // Lazy: describe factories run at COLLECTION even when runIf skips the
    // suite, so the read must not happen until a test actually executes.
    let cached: Json[] | undefined;
    const frames = (): Json[] => (cached ??= load(GG_TRANSCRIPT) as Json[]);

    it("is the six-frame round-trip in declared order", () => {
      expect(Array.isArray(frames())).toBe(true);
      expect(frames()).toHaveLength(6);
      // [0] render tool result · [1] submit call · [2] submit result ·
      // [3] doorbell · [4] consume call · [5] consume result
      expect(methodOf(frames()[1] as Json)).toBe("tools/call");
      expect(toolNameOf(frames()[1] as Json)).toBe("ggui_runtime_submit_action");
      expect(methodOf(frames()[3] as Json)).toBe("ui/message");
      expect(methodOf(frames()[4] as Json)).toBe("tools/call");
      expect(toolNameOf(frames()[4] as Json)).toBe("ggui_consume");
    });

    it("render result carries the MCP-Apps bootstrap and the ggui_consume hint", () => {
      const render = resultOf(frames()[0] as Json);
      const resourceUris = deepCollect(render, "resourceUri").filter((v) => typeof v === "string");
      expect(resourceUris.length, "_meta.ui.resourceUri missing").toBeGreaterThan(0);
      const nextSteps = deepCollect(render, "nextStep");
      expect(nextSteps.some((n) => isObj(n) && n["tool"] === "ggui_consume")).toBe(true);
    });

    it("submit result reports consumerPresent:false — the doorbell's precondition", () => {
      const consumerPresent = deepCollect(resultOf(frames()[2] as Json), "consumerPresent");
      expect(consumerPresent).toContain(false);
    });

    it("doorbell carries non-empty directive text AND the structured user-action mirror", () => {
      const doorbell = frames()[3] as Json;
      const texts = deepCollect(doorbell, "text").filter(
        (t) => typeof t === "string" && t.length > 0,
      );
      expect(texts.length, "doorbell directive text missing/empty").toBeGreaterThan(0);
      const mirrors = deepCollect(doorbell, "ai.ggui/userAction").filter(isObj);
      expect(mirrors, '_meta["ai.ggui/userAction"] mirror missing').toHaveLength(1);
      expect(mirrors[0]?.["kind"]).toBe("user-action");
      const nextSteps = deepCollect(mirrors[0] as Json, "nextStep");
      expect(nextSteps.some((n) => isObj(n) && n["tool"] === "ggui_consume")).toBe(true);
    });

    it("consume result drains EXACTLY the one gesture, with the full action-entry shape", () => {
      const actionEntries = deepCollect(resultOf(frames()[5] as Json), "intent").length;
      expect(actionEntries, "expected exactly one drained gesture").toBe(1);
      const consume = resultOf(frames()[5] as Json);
      for (const key of ["sessionId", "intent", "actionData", "uiContext", "actionId", "firedAt"]) {
        expect(deepCollect(consume, key).length, `consume entry missing \`${key}\``).toBeGreaterThan(0);
      }
      expect(deepCollect(consume, "type")).toContain("action");
    });

    it("correlation equalities: ONE sessionId threads the round-trip; the actionId reappears on mirror and drain", () => {
      // sessionId: every frame that mentions one mentions THE one.
      const sessionIds = new Set(
        frames().flatMap((f) => deepCollect(f, "sessionId")).map((v) => JSON.stringify(v)),
      );
      expect([...sessionIds], "sessionId must be single-valued across the round-trip").toHaveLength(1);
      // actionId: the doorbell mirror's equals the drained entry's (values
      // incidental; the EQUALITY is the stable fact).
      const mirrorActionId = theOne(frames()[3] as Json, "actionId");
      const drainedActionId = theOne(resultOf(frames()[5] as Json), "actionId");
      expect(mirrorActionId).toEqual(drainedActionId);
    });

    it("provenance: kind 'authored' with a per-frame source map (the Layer-B admission requirement)", () => {
      const prov = load(GG_PROVENANCE);
      expect(isObj(prov) && prov["kind"]).toBe("authored");
      const sourceMap = isObj(prov) ? prov["sourceMap"] : undefined;
      expect(Array.isArray(sourceMap), "provenance.sourceMap missing").toBe(true);
      expect((sourceMap as Json[]).length, "source map must cover every frame").toBe(6);
    });
  },
);
