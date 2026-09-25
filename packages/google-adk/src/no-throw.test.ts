/**
 * push() and flush() never throw (SPEC §8.0), including on an event whose
 * envelope is valid but whose inner members have unexpected types. Every
 * member path of a set of well-formed base events (one per facet arm) is
 * replaced by each wrong-typed value, and deleted. No case may throw, and a
 * failure the facet cannot map is reported only as a core `error` event
 * carrying a fixed message and the error's constructor name.
 */
import { describe, expect, it } from "vitest";
import { createAdkNormalizer } from "./index.js";
import type { AgEvent } from "@silverprotocol/core";
type J = unknown;
const inv = "inv_fz";
const bases: Record<string, J[]> = {
  text: [{ invocationId: inv, author: "a", content: { role: "model", parts: [{ text: "hi", thoughtSignature: "s" }] }, partial: false, turnComplete: true, finishReason: "STOP", usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3, thoughtsTokenCount: 0 } }],
  thought: [{ invocationId: inv, content: { role: "model", parts: [{ thought: true, text: "t", thoughtSignature: "s" }, { text: "a" }] }, turnComplete: true, finishReason: "STOP" }],
  partialStream: [
    { invocationId: inv, content: { role: "model", parts: [{ text: "He" }] }, partial: true },
    { invocationId: inv, content: { role: "model", parts: [{ text: "Hello" }] }, partial: false, turnComplete: true, finishReason: "STOP" },
  ],
  toolLoop: [
    { invocationId: inv, content: { role: "model", parts: [{ functionCall: { name: "echo", args: { m: "x" }, id: "c1" } }] }, longRunningToolIds: ["c1"] },
    { invocationId: inv, content: { role: "user", parts: [{ functionResponse: { name: "echo", response: { content: [{ type: "text", text: "x" }], isError: false }, id: "c1" } }] } },
  ],
  nullIdCall: [
    { invocationId: inv, content: { role: "model", parts: [{ functionCall: { name: "echo", args: { m: "x" } } }] } },
    { invocationId: inv, content: { role: "user", parts: [{ functionResponse: { name: "echo", response: { ok: true } } }] } },
  ],
  actions: [{ invocationId: inv, content: { role: "model", parts: [{ text: "x" }] }, actions: { stateDelta: { k: 1 }, artifactDelta: { f: 1 }, transferToAgent: "b", escalate: true, skipSummarization: true, agentState: { input: { a: 1 } }, endOfAgent: true, requestedAuthConfigs: { c9: { authScheme: { type: "oauth2", flows: { implicit: { authorizationUrl: "u", scopes: { s: "d" } } } }, rawAuthCredential: { authType: "oauth2", oauth2: { clientId: "c" } }, credentialKey: "k" } }, requestedToolConfirmations: { c8: { hint: "h", confirmed: false, payload: { p: 1 } } } }, turnComplete: true }],
  reserved: [
    { invocationId: inv, content: { role: "model", parts: [{ functionCall: { name: "adk_request_credential", args: { functionCallId: "o", authConfig: { authScheme: { type: "apiKey", in: "header", name: "X" } } }, id: "r1" } }, { functionCall: { name: "adk_request_confirmation", args: { originalFunctionCall: { id: "o2", name: "t", args: {} }, toolConfirmation: { hint: "h" } }, id: "r2" } }, { functionCall: { name: "adk_request_input", args: { message: "m", response_schema: { type: "object" } }, id: "r3" } }] }, longRunningToolIds: ["r1", "r2", "r3"], turnComplete: true },
  ],
  media: [{ invocationId: inv, content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "AA==", displayName: "d" } }, { fileData: { fileUri: "gs://x", mimeType: "text/plain" } }, { executableCode: { code: "print(1)", language: "PYTHON" } }, { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" } }, { videoMetadata: { fps: 1 } }] }, turnComplete: true }],
  grounding: [{ invocationId: inv, content: { role: "model", parts: [{ text: "abc" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "u", title: "t" } }], groundingSupports: [{ segment: { startIndex: 0, endIndex: 1, text: "a" }, groundingChunkIndices: [0] }] }, turnComplete: true, finishReason: "STOP" }],
  workflow: [{ invocationId: inv, author: "n", content: { role: "model", parts: [{ text: "{}" }] }, nodeInfo: { path: "wf.n", outputFor: ["wf.n"] }, output: { r: 1 }, route: "x", isolationScope: "s" }],
  blocked: [{ invocationId: inv, promptFeedback: { blockReason: "SAFETY", safetyRatings: [{ category: "c", probability: "HIGH" }] } }],
  errorEv: [{ invocationId: inv, errorCode: "E", errorMessage: "m", interrupted: true }],
  compacted: [{ invocationId: inv, isCompacted: true, startTime: 1, endTime: 2, compactedContent: { role: "model", parts: [{ text: "s" }] } }],
};
const BAD: J[] = [null, 1, "x", true, [], {}, [1], { a: 1 }];
function paths(v: J, p: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v as object)) { const q = [...p, Array.isArray(v) ? Number(k) : k]; out.push(q); paths(x, q, out); }
  }
  return out;
}
const DEL = Symbol("del");
function setAt(root: J, path: (string | number)[], val: J | typeof DEL): J {
  const c = structuredClone(root);
  let o: { [k: string]: unknown } | unknown[] = c as { [k: string]: unknown };
  for (let i = 0; i < path.length - 1; i++) o = (o as { [k: string]: unknown })[path[i]!] as { [k: string]: unknown };
  const last = path[path.length - 1]!;
  if (val === DEL) {
    if (Array.isArray(o)) o.splice(Number(last), 1);
    else delete (o as { [k: string]: unknown })[last];
  } else (o as { [k: string]: unknown })[last] = val;
  return c;
}

describe("createAdkNormalizer never throws on a malformed event with a valid envelope", () => {
  it("every wrong-typed or deleted member of every base event: no throw from push() or flush(); an unmappable failure is only a core error event", () => {
    let cases = 0;
    let reported = 0;
    let differential = 0;
    const thrown: string[] = [];
    for (const [name, evs] of Object.entries(bases)) {
      evs.forEach((ev, ei) => {
        for (const p of paths(ev)) {
          for (const bad of [...BAD, DEL]) {
            cases++;
            const mutated = evs.map((e, j) => (j === ei ? setAt(e, p, bad) : e));
            const n = createAdkNormalizer({ invokeId: "adk" });
            const per: AgEvent[][] = [];
            try {
              for (const m of mutated) per.push(n.push(m as never));
              per.push(n.flush());
            } catch (e) {
              thrown.push(`${name}[${ei}].${p.join(".")}: ${String(e)}`);
              continue;
            }
            const out = per.flat();
            // Atomic: a native reported as an error left no other trace, so the
            // run equals the same stream without it, byte for byte, once the
            // error is removed and seq renumbered.
            if (per[ei]!.some((x) => x.type === "error")) {
              differential++;
              expect(per[ei]!.map((x) => x.type)).toEqual(["error"]);
              const n2 = createAdkNormalizer({ invokeId: "adk" });
              const without: AgEvent[] = [];
              mutated.forEach((m, j) => {
                if (j !== ei) without.push(...n2.push(m as never));
              });
              without.push(...n2.flush());
              const stripped = out.filter((x) => x.type !== "error").map((x, i) => ({ ...x, seq: i }));
              expect(JSON.stringify(stripped), `${name}[${ei}].${p.join(".")}`).toBe(JSON.stringify(without));
            }
            expect(out.map((x) => x.seq)).toEqual(out.map((_, i) => i));
            for (const e of out.filter((x) => x.type === "error")) {
              reported++;
              // Only the fixed message, the constructor name and the owner
              // references the assembler backfills; nothing from the native.
              for (const k of Object.keys(e)) expect(["type", "seq", "message", "code", "turnId"]).toContain(k);
              expect(typeof (e as { code?: unknown }).code).toBe("string");
              expect(e).toMatchObject({ message: "normalizer error" });
            }
          }
        }
      });
    }
    expect(thrown).toEqual([]);
    expect(cases).toBeGreaterThan(2000);
    // The guard is exercised: many of these cases reach it.
    expect(reported).toBeGreaterThan(100);
    expect(differential).toBeGreaterThan(100);
  });
});
