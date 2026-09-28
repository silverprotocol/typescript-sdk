/**
 * A forwarded request that a remote agent repeats as its first, submitted
 * status in the "user" role, and that ADK's A2A relay converts into the relayed
 * event's content after the parts of any artifacts it records. The facet maps
 * such an event as if its content parts after the first k (k = the number of
 * parts the recorded artifacts hold, 0 when none), and the long-running ids
 * taken from them, were absent, and emits one content-free
 * ext.google.relay-echo-omitted event for it, inside the turn the event maps
 * into.
 *
 * Every shape is built once with the relay's entries under `customMetadata`
 * and once under `custom_metadata`, at least twice each, and every instance
 * runs through a fresh normalizer with the same invoke id. The repeated status
 * message carries distinct planted leaves in a text part, a function call's
 * arguments, a function response and a thought part.
 */
import { describe, expect, it } from "vitest";
import { AgEvent, JsonValue, Reducer, toJsonValue } from "@silverprotocol/core";
import { ADK_HOST_COMPLETE_TYPE, createAdkNormalizer } from "./index.js";

type Obj = { [k: string]: JsonValue };
const MARKER = "ext.google.relay-echo-omitted";
const MEMBERS = ["customMetadata", "custom_metadata"] as const;
type Member = (typeof MEMBERS)[number];
const TERMINALS = new Set(["turn.done", "turn.error", "turn.abort"]);

let plantCount = 0;
const planted: string[] = [];
/** A distinct leaf, recorded so the checks can look for it on the wire. */
function leaf(tag: string): string {
  const value = `LEAF-${tag}-${plantCount++}`;
  planted.push(value);
  return value;
}

/** The repeated request as the relay converts it (one content part for each
 *  part of the status message, marked as thought when `thought`), and the A2A
 *  parts of that status message. */
function echoParts(tag: string, thought: boolean): { content: Obj[]; a2a: Obj[]; callId: string } {
  const callId = `fc-echo-${tag}-${plantCount}`;
  const text = leaf(`${tag}-text`);
  const args = leaf(`${tag}-args`);
  const result = leaf(`${tag}-result`);
  const thinking = leaf(`${tag}-thought`);
  const mark: Obj = thought ? { thought: true } : {};
  return {
    callId,
    content: [
      { text, ...mark },
      { functionCall: { name: "charge", args: { apiKey: args }, id: callId }, ...mark },
      { functionResponse: { name: "charge", id: callId, response: { result } }, ...mark },
      { text: thinking, thought: true },
    ],
    a2a: [
      { kind: "text", text },
      { kind: "data", data: { name: "charge", args: { apiKey: args }, id: callId }, metadata: { adk_type: "function_call" } },
      { kind: "data", data: { name: "charge", id: callId, response: { result } }, metadata: { adk_type: "function_response" } },
      { kind: "text", text: thinking, metadata: { adk_thought: true } },
    ],
  };
}

const isObj = (v: JsonValue | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** The native with its `a2a:response` entry removed, and with its metadata
 *  member removed when that empties it. */
function withoutResponse(native: Obj): Obj {
  let out = native;
  for (const member of MEMBERS) {
    const bag = out[member];
    if (!isObj(bag) || !("a2a:response" in bag)) continue;
    const rest = Object.fromEntries(Object.entries(bag).filter(([k]) => k !== "a2a:response"));
    out = Object.keys(rest).length > 0 ? { ...out, [member]: rest } : Object.fromEntries(Object.entries(out).filter(([k]) => k !== member));
  }
  return out;
}

/** (i) a streaming status update; (ii) a task at submitted, the only event of
 *  a non-blocking send; (iii) such a task with artifact parts, its content the
 *  artifact parts, then the message's; (iv) such a task with no artifact part,
 *  its content the message's parts marked as thought (ADK-Python's relay);
 *  (v) the same in the a2a-sdk 1.x spelling (no `kind`, TASK_STATE_SUBMITTED,
 *  ROLE_USER); and a relay whose part converter maps one of the message's
 *  parts to two content parts, so the content holds more parts than the
 *  message. */
type Shape = "i" | "ii" | "iii" | "iv" | "v" | "list-converter";
interface Leg {
  label: string;
  native: Obj;
  /** The same native with its content parts after the first k, and their long-running ids, removed. */
  stripped: Obj;
  omitted: number;
  artifactTexts: string[];
}

function positive(shape: Shape, member: Member, i: number): Leg {
  const tag = `${shape}-${member}-${i}`;
  const task = `task-${tag}`;
  const python = shape === "iv" || shape === "v" || shape === "list-converter";
  const echo = echoParts(tag, python);
  const artifactTexts = shape === "iii" ? [`Artifact one of ${tag}. `, `Artifact two of ${tag}.`] : [];
  const message = { kind: "message", role: "user", messageId: `m-${tag}`, parts: echo.a2a };
  const response: Obj =
    shape === "i"
      ? { kind: "status-update", taskId: task, contextId: `ctx-${task}`, final: false, status: { state: "submitted", message } }
      : shape === "v"
        ? {
            id: task,
            contextId: `ctx-${task}`,
            status: { state: "TASK_STATE_SUBMITTED", message: { messageId: `m-${tag}`, contextId: `ctx-${task}`, taskId: task, role: "ROLE_USER", parts: echo.a2a } },
            history: [{ messageId: `m-${tag}`, contextId: `ctx-${task}`, taskId: task, role: "ROLE_USER", parts: echo.a2a }],
          }
        : {
            kind: "task",
            id: task,
            contextId: `ctx-${task}`,
            status: { state: "submitted", message },
            ...(artifactTexts.length > 0 ? { artifacts: [{ artifactId: `art-${tag}`, parts: artifactTexts.map((text) => ({ kind: "text", text })) }] } : {}),
          };
  const extra: Obj[] = shape === "list-converter" ? [{ text: leaf(`${tag}-second`), thought: true }] : [];
  const echoContent = [...echo.content.slice(0, 1), ...extra, ...echo.content.slice(1)];
  const kept = artifactTexts.map((text) => ({ text }));
  const role = python ? "user" : "model";
  const base: Obj = {
    invocationId: `inv-${tag}`,
    author: "helper",
    ...(shape === "i" ? { partial: true } : {}),
    turnComplete: false,
    [member]: { "a2a:response": response, "a2a:task_id": task, "a2a:context_id": `ctx-${task}`, note: "kept" },
  };
  return {
    label: tag,
    native: { ...base, longRunningToolIds: [echo.callId], content: { role, parts: [...kept, ...echoContent] } },
    stripped: { ...base, longRunningToolIds: [], content: { role, parts: kept } },
    omitted: echoContent.length,
    artifactTexts,
  };
}

function drive(natives: Obj[], host: boolean): AgEvent[] {
  const n = createAdkNormalizer({ invokeId: "adk", ...(host ? { hostCompletion: true } : {}) });
  const out: AgEvent[] = [];
  for (const e of natives) out.push(...n.push(toJsonValue(e)));
  if (host) out.push(...n.push({ type: ADK_HOST_COMPLETE_TYPE }));
  out.push(...n.flush());
  return out;
}
/** A stream with every marker removed and the later seqs renumbered, serialized. */
function serialized(out: AgEvent[]): string {
  return JSON.stringify(out.filter((e) => e.type !== MARKER).map((e, i) => ({ ...e, seq: i })));
}
function expectNoLeaf(out: AgEvent[], label: string): void {
  const wire = JSON.stringify(out);
  const blocks = new Map<string, string>();
  for (const e of out) if (e.type === "text.delta" || e.type === "reasoning.delta") blocks.set(e.id ?? "", (blocks.get(e.id ?? "") ?? "") + e.delta);
  for (const value of planted) {
    expect(wire.includes(value) || wire.includes(JSON.stringify(value)), `${label}: ${value}`).toBe(false);
    for (const text of blocks.values()) expect(text.includes(value), `${label}: ${value} in a block`).toBe(false);
  }
}
function expectCleanFold(out: AgEvent[], label: string): void {
  for (const e of out) expect(() => AgEvent.parse(e), label).not.toThrow();
  const r = new Reducer();
  for (const e of out) r.push(e);
  expect(r.needsResync, label).toBe(false);
  const done = new Set(out.flatMap((e) => (e.type === "tool.done" ? [e.toolCallId] : [])));
  for (const e of out) if (e.type === "tool.start") expect(done.has(e.toolCallId), `${label}: ${e.toolCallId} has no result`).toBe(true);
}
/** The one marker of a single-native stream sits after its turn's turn.start
 *  and before that turn's terminal. */
function expectMarkerInsideTurn(out: AgEvent[], label: string): void {
  const markers = out.filter((e) => e.type === MARKER);
  expect(markers, label).toHaveLength(1);
  const [marker] = markers;
  const opened = out.find((e) => e.type === "turn.start");
  const turnId = opened?.type === "turn.start" ? opened.turnId : undefined;
  const closed = out.find((e) => TERMINALS.has(e.type) && "turnId" in e && e.turnId === turnId);
  expect(turnId, label).toBeDefined();
  expect(closed, label).toBeDefined();
  expect(opened?.seq ?? Infinity, label).toBeLessThan(marker?.seq ?? -1);
  expect(marker?.seq ?? Infinity, label).toBeLessThan(closed?.seq ?? -1);
}

const SHAPES: Shape[] = ["i", "ii", "iii", "iv", "v", "list-converter"];
const positives: Leg[] = SHAPES.flatMap((shape) => MEMBERS.flatMap((member) => [0, 1].map((i) => positive(shape, member, i))));

describe("createAdkNormalizer — a forwarded request a remote agent repeats as a submitted user-role status is omitted", () => {
  it("each repeat, relayed as a streaming status update, a non-blocking task, a task with artifacts, a task converted as thought, the a2a-sdk 1.x record, or through a converter that maps one part to two, under either spelling of the metadata member, reaches the wire in no form: no planted value, raw or in any block's text", () => {
    expect(positives).toHaveLength(24);
    for (const leg of positives) for (const host of [false, true]) expectNoLeaf(drive([leg.native], host), `${leg.label} host=${host}`);
    expectNoLeaf(drive(positives.map((l) => l.native), true), "one fold");
  });

  it("an event carrying a repeat maps exactly as the same event with its content parts after the first k and their long-running ids removed, its markers aside, with no tool.start, tool.done or hitl.ask from the repeat; that stripped event emits no marker", () => {
    for (const leg of positives) {
      for (const host of [false, true]) {
        const label = `${leg.label} host=${host}`;
        const out = drive([leg.native], host);
        const again = drive([leg.stripped], host);
        expect(serialized(out), label).toBe(JSON.stringify(again));
        expect(again.some((e) => e.type === MARKER), label).toBe(false);
        expect(out.some((e) => e.type === "tool.start" || e.type === "tool.done" || e.type === "hitl.ask"), label).toBe(false);
      }
    }
  });

  it("each such event yields exactly one ext.google.relay-echo-omitted, after its turn's turn.start and before that turn's terminal, whose only member beyond the envelope is the number of parts it omitted", () => {
    for (const leg of positives) {
      for (const host of [false, true]) {
        const label = `${leg.label} host=${host}`;
        const out = drive([leg.native], host);
        expectMarkerInsideTurn(out, label);
        const marker = out.find((e) => e.type === MARKER);
        expect(Object.keys(marker ?? {}).sort(), label).toEqual(["parts", "seq", "type"]);
        expect(marker, label).toMatchObject({ parts: leg.omitted });
      }
    }
  });

  it("a non-blocking task whose only content was the repeat, with only the relay's entries in its metadata, yields the marker alone inside its turn, before the terminal that event or the flush emits, and the fold ends clean", () => {
    /** The native with only the relay's own entries in its metadata member. */
    const relayOnly = (native: Obj): Obj =>
      Object.fromEntries(Object.entries(native).map(([k, v]) => [k, MEMBERS.some((m) => m === k) && isObj(v) ? Object.fromEntries(Object.entries(v).filter(([e]) => e.startsWith("a2a:"))) : v]));
    for (const leg of positives.filter((l) => l.label.startsWith("ii-"))) {
      for (const [host, turnComplete] of [[false, false], [true, false], [false, true], [true, true]] as const) {
        const label = `${leg.label} host=${host} turnComplete=${turnComplete}`;
        const out = drive([{ ...relayOnly(leg.native), turnComplete }], host);
        expectMarkerInsideTurn(out, label);
        const types = out.map((e) => e.type);
        expect(types.filter((t) => !t.startsWith("turn.") && !t.startsWith("message.") && t !== MARKER), label).toEqual([]);
        expectCleanFold(out, label);
      }
    }
  });

  it("the long-running ids a repeat's calls contributed go with them: a Workflow node's relayed repeat, after an ask of the run, does not signal that ask's pause, as a node's contentless long-running call would", () => {
    for (const member of MEMBERS) {
      for (const i of [0, 1]) {
        const leg = positive("ii", member, 10 + i);
        const invocationId = leg.native["invocationId"] ?? "";
        // A request-input call: an ask of the run whose pause is not signalled yet.
        const ask: Obj = {
          invocationId,
          author: "gate",
          content: { role: "model", parts: [{ functionCall: { name: "adk_request_input", args: { message: "City?" }, id: `ri-${member}-${i}` } }] },
          longRunningToolIds: [`ri-${member}-${i}`],
        };
        const node = (n: Obj): Obj => ({ ...n, nodeInfo: { path: "helper" } });
        for (const host of [false, true]) {
          const label = `${leg.label} host=${host}`;
          const out = drive([ask, node(leg.native)], host);
          expect(serialized(out), label).toBe(JSON.stringify(drive([ask, node(leg.stripped)], host)));
          expect(out.filter((e) => e.type === MARKER), label).toHaveLength(1);
        }
      }
    }
  });

  it("a task's artifact parts, the first k content parts, map as the same text blocks as with the repeat absent", () => {
    for (const leg of positives.filter((l) => l.artifactTexts.length > 0)) {
      for (const host of [false, true]) {
        const deltas = (out: AgEvent[]) => out.flatMap((e) => (e.type === "text.delta" ? [e.delta] : []));
        expect(deltas(drive([leg.native], host)), leg.label).toEqual(leg.artifactTexts);
      }
    }
  });

  it("a converter that maps one of a submitted task's artifact parts to two content parts leaves more parts than k: the parts after the first k are omitted, and the marker counts them", () => {
    for (const member of MEMBERS) {
      for (const i of [0, 1]) {
        const tag = `wide-artifact-${member}-${i}`;
        const native: Obj = {
          invocationId: `inv-${tag}`,
          author: "helper",
          content: { role: "user", parts: [{ text: `Artifact of ${tag}.`, thought: true }, { text: `Its second half, ${tag}.`, thought: true }] },
          [member]: {
            "a2a:response": {
              kind: "task",
              id: `task-${tag}`,
              status: { state: "submitted", message: { kind: "message", role: "user", parts: [{ kind: "text", text: `Forwarded ${tag}.` }] } },
              artifacts: [{ artifactId: "a", parts: [{ kind: "text", text: `Artifact of ${tag}.` }] }],
            },
          },
        };
        const out = drive([native], true);
        expect(out.filter((e) => e.type === MARKER), tag).toMatchObject([{ parts: 1 }]);
        expect(JSON.stringify(out).includes("Its second half"), tag).toBe(false);
        expectCleanFold(out, tag);
      }
    }
  });

  it("over one fold of every instance, push() never throws, every event validates, and the fold ends with no resync and no tool call without its result", () => {
    for (const host of [false, true]) expectCleanFold(drive(positives.map((l) => l.native), host), `one fold host=${host}`);
  });
});

describe("createAdkNormalizer — a user-role or submitted message that is not a repeated request maps as before", () => {
  const record03 = (tag: string, kind: string, state: string, role: string, parts: Obj[], extra: Obj = {}): Obj => ({
    kind,
    ...(kind === "status-update" ? { taskId: `task-${tag}`, final: false } : { id: `task-${tag}` }),
    contextId: `ctx-${tag}`,
    status: { state, message: { kind: "message", role, messageId: `m-${tag}`, parts } },
    ...extra,
  });
  const record1 = (tag: string, state: string, role: string, parts: Obj[], extra: Obj = {}): Obj => ({
    id: `task-${tag}`,
    contextId: `ctx-${tag}`,
    status: { state, message: { messageId: `m-${tag}`, role, parts } },
    ...extra,
  });
  /** A relayed event; its metadata member holds the recorded response alone, or with other entries. */
  const event = (tag: string, member: Member, alone: boolean, content: Obj, response: Obj | undefined, extra: Obj = {}): Obj => ({
    invocationId: `inv-${tag}`,
    author: "helper",
    content,
    [member]: { ...(response !== undefined ? { "a2a:response": response } : {}), ...(alone && response !== undefined ? {} : { "a2a:task_id": `task-${tag}`, note: "kept" }) },
    ...extra,
  });
  const callOf = (tag: string, id: string): Obj => ({ invocationId: `inv-${tag}`, author: "helper", content: { role: "model", parts: [{ functionCall: { name: "lookup", args: {}, id } }] } });
  const one: Obj[] = [{ kind: "text", text: "x" }];
  const artifact = (tag: string): Obj => ({ artifacts: [{ artifactId: "a", parts: [{ kind: "text", text: `Artifact ${tag}.` }] }] });

  /** Each control as [label, the events its leg places before it, the control]. */
  const controls = (member: Member, i: number): Array<[string, Obj[], Obj]> => {
    const t = `ctl-${member}-${i}`;
    const alone = i === 1;
    const echo = echoParts(`${t}-c`, false);
    return [
      [
        "(a) an agent-role status update at submitted carrying text, a call and its result",
        [],
        event(`${t}-a`, member, alone, { role: "model", parts: [{ text: `Agent says ${t}.` }, { functionCall: { name: "lookup", args: { q: t }, id: `fc-${t}-a` } }, { functionResponse: { name: "lookup", id: `fc-${t}-a`, response: { r: 1 } } }] }, record03(`${t}-a`, "status-update", "submitted", "agent", [...one, ...one, ...one]), { partial: true }),
      ],
      [
        "(b) a user-role status update at working carrying a function response, after its call",
        [callOf(`${t}-b`, `fr-${t}-b`)],
        event(`${t}-b`, member, alone, { role: "model", parts: [{ functionResponse: { name: "lookup", id: `fr-${t}-b`, response: { result: `Tool result ${t}.` } } }] }, record03(`${t}-b`, "status-update", "working", "user", one), { partial: true }),
      ],
      ["(c) shape (i)'s parts on an event with no a2a:response", [], event(`${t}-c`, member, alone, { role: "model", parts: echo.content }, undefined, { partial: true })],
      ["(d) a task at another state with a user-role status message", [], event(`${t}-d`, member, alone, { role: "model", parts: [{ text: `Asked ${t}.` }] }, record03(`${t}-d`, "task", "input-required", "user", one), { turnComplete: true })],
      [
        "(e) a task at submitted with a user-role status message that holds an artifact part, its content that artifact's parts",
        [],
        event(`${t}-e`, member, alone, { role: "user", parts: [{ text: `Artifact ${t}-e.`, thought: true }] }, record03(`${t}-e`, "task", "submitted", "user", [...one, ...one], artifact(`${t}-e`))),
      ],
      [
        "(f) the a2a-sdk 1.x record at TASK_STATE_WORKING with a ROLE_USER message carrying a function response, after its call",
        [callOf(`${t}-f`, `fr-${t}-f`)],
        event(`${t}-f`, member, alone, { role: "user", parts: [{ functionResponse: { name: "lookup", id: `fr-${t}-f`, response: { result: `Tool result ${t}.` } } }] }, record1(`${t}-f`, "TASK_STATE_WORKING", "ROLE_USER", one)),
      ],
      ["(g) the a2a-sdk 1.x record at TASK_STATE_SUBMITTED with a ROLE_AGENT message", [], event(`${t}-g`, member, alone, { role: "model", parts: [{ text: `Agent says ${t}.`, thought: true }] }, record1(`${t}-g`, "TASK_STATE_SUBMITTED", "ROLE_AGENT", one))],
      [
        "(h) the a2a-sdk 1.x record at TASK_STATE_SUBMITTED with a ROLE_USER message whose task holds an artifact part, its content that artifact's parts",
        [],
        event(`${t}-h`, member, alone, { role: "user", parts: [{ text: `Artifact ${t}-h.`, thought: true }] }, record1(`${t}-h`, "TASK_STATE_SUBMITTED", "ROLE_USER", [...one, ...one], artifact(`${t}-h`))),
      ],
    ];
  };
  const all = MEMBERS.flatMap((member) => [0, 1].flatMap((i) => controls(member, i)));

  it("each control (an agent-role submitted status, a user-role working tool result, no a2a:response, a task at another state, a submitted task converted from its artifact, and the a2a-sdk 1.x record at another state, in the agent's role, or holding an artifact), under either spelling of the metadata member, maps byte for byte as the same native with its a2a:response removed, with no marker", () => {
    expect(all).toHaveLength(32);
    for (const [label, before, control] of all) {
      for (const host of [false, true]) {
        const out = drive([...before, control], host);
        expect(JSON.stringify(out), `${label} host=${host}`).toBe(JSON.stringify(drive([...before, withoutResponse(control)], host)));
        expect(out.some((e) => e.type === MARKER), label).toBe(false);
      }
    }
  });

  it("the user-role tool results relayed while working, (b) and (f), keep their tool.done, which folds against its call; one fold of every control ends with no resync and no tool call without its result", () => {
    const legs = all.filter(([label]) => label.startsWith("(b)") || label.startsWith("(f)"));
    expect(legs).toHaveLength(8);
    for (const [label, before, control] of legs) {
      const out = drive([...before, control], true);
      const call = before[0]?.["content"];
      const id = isObj(call) && Array.isArray(call["parts"]) && isObj(call["parts"][0]) && isObj(call["parts"][0]["functionCall"]) ? call["parts"][0]["functionCall"]["id"] : undefined;
      expect(out.filter((e) => e.type === "tool.done").map((e) => (e.type === "tool.done" ? e.toolCallId : "")), label).toEqual([id]);
      expectCleanFold(out, label);
    }
    for (const host of [false, true]) expectCleanFold(drive(all.flatMap(([, before, control]) => [...before, control]), host), `one fold host=${host}`);
  });
});
