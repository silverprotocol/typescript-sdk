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

  it("CB-9: resume.uiActions reports the member that is actually wrong (surface first, then its own discriminant)", () => {
    const ui = (a: Record<string, unknown>) => ({ ...ENV, kind: "resume", uiActions: [{ surfaceId: "s1", ...a }] });
    // protocol's vector: a non-string url is a wrong JSON type → malformed, at the url.
    expect(reject(ui({ surface: "mcp-app", method: "ui/open-link", params: { url: 5 } }))).toEqual({ code: "malformed", path: ["uiActions", 0, "params", "url"] });
    // an undefined method of a defined surface → unknown-value at the method, not at `surface`.
    expect(reject(ui({ surface: "mcp-app", method: "zz", params: {} }))).toEqual({ code: "unknown-value", path: ["uiActions", 0, "method"] });
    expect(reject(ui({ surface: "mcp-app", params: {} }))).toEqual({ code: "malformed", path: ["uiActions", 0, "method"] });
    expect(reject(ui({ surface: "mcp-app", method: "ui/request-display-mode", params: { mode: "modal" } }))).toEqual({ code: "unknown-value", path: ["uiActions", 0, "params", "mode"] });
    expect(reject(ui({ surface: "a2ui", a2uiMessage: "action", sourceComponentId: "c", timestamp: "t", context: {} }))).toEqual({ code: "malformed", path: ["uiActions", 0, "name"] });
    expect(reject(ui({ surface: "a2ui", a2uiMessage: "zz" }))).toEqual({ code: "unknown-value", path: ["uiActions", 0, "a2uiMessage"] });
    expect(reject(ui({ surface: "openai-app", method: "callTool", name: "n", args: {} }))).toEqual({ code: "malformed", path: ["uiActions", 0, "callId"] });
    expect(reject(ui({ surface: "openai-app", method: "requestDisplayMode", mode: "modal", requestId: "r" }))).toEqual({ code: "unknown-value", path: ["uiActions", 0, "mode"] });
    // an undefined surface → unknown-value at `surface`; a wrong-typed one → malformed.
    expect(reject(ui({ surface: "zz" }))).toEqual({ code: "unknown-value", path: ["uiActions", 0, "surface"] });
    expect(reject(ui({ surface: 9 }))).toEqual({ code: "malformed", path: ["uiActions", 0, "surface"] });
    // and a valid interaction still passes, unknown fields intact.
    const ok = ui({ surface: "mcp-app", method: "ui/open-link", params: { url: "https://x.example", zz: 1 } });
    const r = checkAgInput(structuredClone(ok));
    expect(r.ok && isDeepStrictEqual(r.input, ok)).toBe(true);
  });

  it("several problems: malformed beats unknown-value, whatever the order (ALT-1; flipped from first-issue-wins)", () => {
    expect(reject({ ...ENV, kind: "resume", answers: [{ askId: "a", status: "zz" }, { askId: 1, status: "resolved" }] })).toEqual({ code: "malformed", path: ["answers", 1, "askId"] });
    expect(reject({ ...ENV, kind: "resume", answers: [{ askId: 1, status: "resolved" }, { askId: "a", status: "zz" }] })).toEqual({ code: "malformed", path: ["answers", 0, "askId"] });
  });

  describe("capabilities.uiResources.viewMessageTurns (draft.4, founder ruling on view-message turns)", () => {
    it("an MCP-shaped object where the boolean belongs → malformed at its path", () => {
      expect(reject(start({ capabilities: { uiResources: { viewMessageTurns: { text: {} } } } }))).toEqual({
        code: "malformed",
        path: ["capabilities", "uiResources", "viewMessageTurns"],
      });
      expect(reject(start({ capabilities: { uiResources: { viewMessageTurns: "true" } } }))).toEqual({
        code: "malformed",
        path: ["capabilities", "uiResources", "viewMessageTurns"],
      });
    });

    it("round-trips beside htmlResources and an unknown sibling, all intact", () => {
      const raw = start({ capabilities: { uiResources: { htmlResources: true, viewMessageTurns: true, zzFuture: 1 } } });
      const r = checkAgInput(structuredClone(raw));
      expect(r.ok).toBe(true);
      if (r.ok) expect(isDeepStrictEqual(r.input, raw)).toBe(true);
      const off = start({ capabilities: { uiResources: { viewMessageTurns: false } } });
      const r2 = checkAgInput(structuredClone(off));
      expect(r2.ok && isDeepStrictEqual(r2.input, off)).toBe(true);
    });
  });

  describe("ALT-1 input classes (founder ruling on decision 6, bar wf_a8a31902-fb5; §10 item 29 inputs b11-b17)", () => {
    it("protocol is judged FIRST: a protocol other than agjson is malformed at [protocol], before version and before kind (b11)", () => {
      expect(reject({ ...ENV, protocol: "foo", kind: "start", messages: [] })).toEqual({ code: "malformed", path: ["protocol"] });
      expect(reject({ ...ENV, protocol: "foo", kind: "zz" })).toEqual({ code: "malformed", path: ["protocol"] });
      // not AgJSON 2.x: not AgJSON at all
      expect(reject({ ...ENV, protocol: "foo", version: "2.0.0", kind: "start", messages: [] })).toEqual({ code: "malformed", path: ["protocol"] });
      const { protocol: _p, ...noProtocol } = ENV;
      expect(reject({ ...noProtocol, kind: "start", messages: [] })).toEqual({ code: "malformed", path: ["protocol"] });
    });

    it("then version: another major is major-mismatch (b12); a missing or non-semver version is malformed at [version]", () => {
      expect(reject({ ...ENV, version: "2.0.0", kind: "start", messages: [] })).toEqual({ code: "major-mismatch", path: ["version"] });
      const { version: _v, ...noVersion } = ENV;
      expect(reject({ ...noVersion, kind: "start", messages: [] })).toEqual({ code: "malformed", path: ["version"] });
      expect(reject({ ...ENV, version: 1, kind: "start", messages: [] })).toEqual({ code: "malformed", path: ["version"] });
    });

    it("envelope members are checked whatever the kind, and malformed beats unknown-value (b13)", () => {
      expect(reject({ ...ENV, threadId: 5, kind: "zz" })).toEqual({ code: "malformed", path: ["threadId"] });
      expect(reject({ ...ENV, capabilities: { hitl: { grantModes: {} } }, kind: "zz" })).toEqual({ code: "malformed", path: ["capabilities", "hitl", "grantModes"] });
    });

    it("a member only an undefined kind would select is not checked (b14)", () => {
      expect(reject({ ...ENV, kind: "zz", messages: 5 })).toEqual({ code: "unknown-value", path: ["kind"] });
    });

    it("malformed beats unknown-value in either array order; members of an undefined-type block are not checked (b15)", () => {
      const msg = (content: unknown[]) => start({ messages: [{ id: "m", role: "user", content }] });
      expect(reject(msg([{ type: "zz", text: 5 }, { type: "text" }]))).toEqual({ code: "malformed", path: ["messages", 0, "content", 1, "text"] });
      expect(reject(msg([{ type: "text" }, { type: "zz", text: 5 }]))).toEqual({ code: "malformed", path: ["messages", 0, "content", 0, "text"] });
      // the same through a plain union (run.system: string | AgBlock[]): the array branch is the one that fits
      expect(reject(start({ run: { system: [{ type: "zz", text: 5 }, { type: "text" }] } }))).toEqual({ code: "malformed", path: ["run", "system", 1, "text"] });
      // with only unknown-value problems the class stays unknown-value
      expect(reject(msg([{ type: "zz", text: 5 }]))).toEqual({ code: "unknown-value", path: ["messages", 0, "content", 0, "type"] });
    });

    it("a frozen closed set is still unknown-value (b16), and a malformed member of a defined surface interaction is malformed at its own path (b17)", () => {
      expect(reject(start({ messages: [{ id: "m", role: "zz", content: [] }] }))).toEqual({ code: "unknown-value", path: ["messages", 0, "role"] });
      const r = checkAgInput({ ...ENV, kind: "resume", uiActions: [{ surface: "mcp-app", surfaceId: "s", method: "ui/open-link", params: { url: 5 } }] });
      expect(!r.ok && r.code).toBe("malformed");
      expect(!r.ok && isDeepStrictEqual(r.path.slice(0, 3), ["uiActions", 0, "params"])).toBe(true);
    });

    it("an unknown field is tolerated: a valid input carrying unknown fields at every depth is accepted with them intact", () => {
      const withUnknown = { ...start({ messages: [{ id: "m", role: "user", content: [{ type: "text", text: "a", zzBlock: 1 }], zzMsg: true }] }), zzTop: { any: "thing" } };
      const r = checkAgInput(structuredClone(withUnknown));
      expect(r.ok).toBe(true);
      expect(r.ok && isDeepStrictEqual(r.input, withUnknown)).toBe(true);
    });

    it("a non-object input is malformed at [] before anything else", () => {
      for (const x of [null, "start", [ENV], 7, true]) expect(reject(x)).toEqual({ code: "malformed", path: [] });
    });
  });
});
