import { describe, expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { checkAgInput } from "./input-check.js";
import { AGJSON_VERSION } from "./agjson.js";

const ENV = { protocol: "agjson", version: AGJSON_VERSION, threadId: "th", turnId: "t" };
const start = (extra: Record<string, unknown>) => ({ ...ENV, kind: "start", messages: [], ...extra });
const reject = (raw: unknown) => {
  const r = checkAgInput(raw);
  if (r.ok) throw new Error(`accepted: ${JSON.stringify(raw)}`);
  return { code: r.code, path: r.path };
};

describe("checkAgInput — draft.4 §0.2, workspace#20 decision 6 (§10 item N, input leg)", () => {
  it("(1) an undefined AgHitlAnswer status → unknown-value at its path", () => {
    expect(reject({ ...ENV, kind: "resume", answers: [{ askId: "a", status: "resolved" }, { askId: "b", status: "zz" }] })).toEqual({ code: "unknown-value", path: ["answers", 1, "status"] });
  });

  it("(2) an undefined kind → unknown-value at [kind]", () => {
    expect(reject({ ...ENV, kind: "zz" })).toEqual({ code: "unknown-value", path: ["kind"] });
  });

  it("(3) an undefined reasoning effort → unknown-value at its path", () => {
    expect(reject(start({ run: { reasoning: { mode: "enabled", effort: "xhigh" } } }))).toEqual({ code: "unknown-value", path: ["run", "reasoning", "effort"] });
  });

  it("(4) an undefined AgBlock type inside messages, run.system, run.context or results[].content → unknown-value at that type", () => {
    const zz = [{ type: "text", text: "a" }, { type: "zz" }];
    expect(reject(start({ messages: [{ id: "m", role: "user", content: zz }] }))).toEqual({ code: "unknown-value", path: ["messages", 0, "content", 1, "type"] });
    expect(reject(start({ run: { system: zz } }))).toEqual({ code: "unknown-value", path: ["run", "system", 1, "type"] });
    expect(reject(start({ run: { context: zz } }))).toEqual({ code: "unknown-value", path: ["run", "context", 1, "type"] });
    expect(reject({ ...ENV, kind: "tool-result", results: [{ toolCallId: "c", content: zz }] })).toEqual({ code: "unknown-value", path: ["results", 0, "content", 1, "type"] });
  });

  it("an undefined value in a closed set inside a known block, or in a union's enum branch, is unknown-value too", () => {
    expect(reject(start({ messages: [{ id: "m", role: "user", content: [{ type: "code-result", outcome: "zz", output: "" }] }] }))).toEqual({ code: "unknown-value", path: ["messages", 0, "content", 0, "outcome"] });
    expect(reject(start({ run: { toolChoice: "zz" } }))).toEqual({ code: "unknown-value", path: ["run", "toolChoice"] });
    expect(reject(start({ run: { toolChoice: { type: "zz", name: "t" } } }))).toEqual({ code: "unknown-value", path: ["run", "toolChoice", "type"] });
    expect(reject(start({ messages: [{ id: "m", role: "zz", content: [] }] }))).toEqual({ code: "unknown-value", path: ["messages", 0, "role"] });
  });

  it("(5)(6)(7) a wrong JSON type or a missing value is malformed, never unknown-value", () => {
    expect(reject({ ...ENV, kind: 9 })).toEqual({ code: "malformed", path: ["kind"] });
    expect(reject({ ...ENV })).toEqual({ code: "malformed", path: ["kind"] });
    expect(reject({ ...ENV, kind: "resume", answers: [{ askId: "a" }] })).toEqual({ code: "malformed", path: ["answers", 0, "status"] });
    expect(reject(start({ capabilities: { hitl: { grantModes: {} } } }))).toEqual({ code: "malformed", path: ["capabilities", "hitl", "grantModes"] });
    expect(reject(start({ run: { reasoning: { mode: "enabled", effort: 3 } } }))).toEqual({ code: "malformed", path: ["run", "reasoning", "effort"] });
    // A union value of neither branch's JSON type: malformed, at the union.
    expect(reject(start({ run: { toolChoice: 5 } }))).toEqual({ code: "malformed", path: ["run", "toolChoice"] });
    // A block that matched the array branch but has a wrong-typed member: malformed at that member.
    expect(reject(start({ run: { system: [{ type: "text", text: 5 }] } }))).toEqual({ code: "malformed", path: ["run", "system", 0, "text"] });
    // grantModeId on a non-resolved answer fails the answer's refinement: malformed.
    expect(reject({ ...ENV, kind: "resume", answers: [{ askId: "a", status: "declined", grantModeId: "g" }] }).code).toBe("malformed");
    for (const notAnInput of [null, "start", [ENV], 7]) expect(reject(notAnInput).code).toBe("malformed");
  });

  it("(8) another major version → major-mismatch at [version], checked before anything else", () => {
    expect(reject({ ...ENV, version: "2.0.0", kind: "start", messages: [] })).toEqual({ code: "major-mismatch", path: ["version"] });
    expect(reject({ ...ENV, version: "2.0.0", kind: "zz" })).toEqual({ code: "major-mismatch", path: ["version"] });
    expect(checkAgInput({ ...ENV, version: "1.9.0", kind: "start", messages: [] }).ok).toBe(true);
    expect(reject({ ...ENV, version: "latest", kind: "start", messages: [] })).toEqual({ code: "malformed", path: ["version"] });
  });

  it("(9)(10) unknown fields are accepted and returned intact at every depth (answers, capabilities top-level and nested)", () => {
    const resume = { ...ENV, kind: "resume", answers: [{ askId: "a", status: "resolved", zzExtra: { k: 1 } }] };
    const r1 = checkAgInput(structuredClone(resume));
    expect(r1.ok && isDeepStrictEqual(r1.input, resume)).toBe(true);
    const caps = start({ capabilities: { zzTop: true, hitl: { ask: true, zzNested: [1] }, streaming: { partialMessages: true, zz: "x" } }, zzEnvelope: 1 });
    const r2 = checkAgInput(structuredClone(caps));
    expect(r2.ok && isDeepStrictEqual(r2.input, caps)).toBe(true);
  });

  it("the accepted input is a copy: the input is never mutated and shares no object with the result; __proto__ never selects a prototype", () => {
    const input = start({ messages: [{ id: "m", role: "user", content: [{ type: "text", text: "a" }] }] });
    const before = structuredClone(input);
    const r = checkAgInput(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    (r.input as unknown as { messages: { id: string }[] }).messages[0]!.id = "mutated";
    expect(isDeepStrictEqual(input, before)).toBe(true);
    const polluted = JSON.parse(`{"protocol":"agjson","version":"${AGJSON_VERSION}","threadId":"th","turnId":"t","kind":"start","messages":[],"__proto__":{"polluted":true}}`);
    const r2 = checkAgInput(polluted);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(Object.getPrototypeOf(r2.input)).toBe(Object.prototype);
      expect(Object.hasOwn(r2.input, "__proto__")).toBe(false);
    }
  });

  it("a live, non-JSON input (undefined member, Date) is malformed at [] before the schema runs", () => {
    expect(reject({ ...start({}), state: { when: new Date(0) } })).toEqual({ code: "malformed", path: [] });
    expect(reject({ ...start({}), metadata: { k: undefined } })).toEqual({ code: "malformed", path: [] });
  });

  it("several problems: the first in schema order is reported", () => {
    expect(reject({ ...ENV, kind: "resume", answers: [{ askId: "a", status: "zz" }, { askId: 1, status: "resolved" }] })).toEqual({ code: "unknown-value", path: ["answers", 0, "status"] });
  });
});
