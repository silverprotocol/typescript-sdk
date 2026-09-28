/**
 * A forwarded request that a remote agent repeats as its first, submitted
 * status in the "user" role, and that ADK's RemoteA2AAgent converts into the
 * relayed event's content (its last `status.message.parts.length` parts). The
 * facet maps such an event as if those parts, and the long-running ids taken
 * from them, were absent, and emits one content-free
 * ext.google.relay_echo_omitted event for it.
 *
 * The natives are built as ADK's relay builds them (event_converter_utils.js:
 * a status update's message parts become the event's content, and a Task's
 * artifacts come first, then its status message), with distinct planted leaves
 * in text, call arguments, a function response and a thought part.
 *
 * The differentials compare against the same native with the arm neutralised:
 * its recorded status message's role set to the agent's, which no other
 * reader of `a2a:response` looks at (the relay-bookkeeping filter never
 * carries the entry).
 */
import { describe, expect, it } from "vitest";
import { AgEvent, JsonValue, Reducer, toJsonValue } from "@silverprotocol/core";
import { ADK_HOST_COMPLETE_TYPE, createAdkNormalizer } from "./index.js";

type Obj = { [k: string]: JsonValue };
const MARKER = "ext.google.relay_echo_omitted";

let plantCount = 0;
const planted: string[] = [];
/** A distinct leaf, recorded so the checks can look for it on the wire. */
function leaf(tag: string): string {
  const value = `LEAF-${tag}-${plantCount++}`;
  planted.push(value);
  return value;
}

/** The repeated request's parts, as ADK converts them into content (genai
 *  parts), and the A2A parts of the status message they came from. */
function echoParts(tag: string, snake: boolean): { content: Obj[]; a2a: Obj[]; callId: string } {
  const callId = `fc-echo-${tag}-${plantCount}`;
  const text = leaf(`${tag}-text`);
  const args = leaf(`${tag}-args`);
  const result = leaf(`${tag}-result`);
  const thought = leaf(`${tag}-thought`);
  const call = snake ? "function_call" : "functionCall";
  const response = snake ? "function_response" : "functionResponse";
  return {
    callId,
    content: [
      { text },
      { [call]: { name: "charge", args: { apiKey: args }, id: callId } },
      { [response]: { name: "lookup", id: `fr-echo-${tag}`, response: { result } } },
      { text: thought, thought: true },
    ],
    a2a: [
      { kind: "text", text },
      { kind: "data", data: { name: "charge", args: { apiKey: args }, id: callId }, metadata: { adk_type: "function_call" } },
      { kind: "data", data: { name: "lookup", id: `fr-echo-${tag}`, response: { result } }, metadata: { adk_type: "function_response" } },
      { kind: "text", text: thought, metadata: { adk_thought: true } },
    ],
  };
}

interface Leg {
  label: string;
  native: Obj;
  /** The same native with the echo parts and their long-running ids removed, and the arm neutralised. */
  stripped: Obj;
  /** The native with only the arm neutralised (the arm-off reading). */
  armOff: Obj;
  echoCount: number;
  artifactTexts: string[];
}

function relayed(bagKey: "customMetadata" | "custom_metadata", response: Obj, task: string): Obj {
  return { [bagKey]: { "a2a:response": response, "a2a:task_id": task, "a2a:context_id": `ctx-${task}`, note: "kept" } };
}
const isObj = (v: JsonValue | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** The native with its recorded status message in the agent's role. */
function neutralised(native: Obj, bagKey: string): Obj {
  const bag = native[bagKey];
  if (!isObj(bag)) return native;
  const response = bag["a2a:response"];
  const status = isObj(response) ? response["status"] : undefined;
  const message = isObj(status) ? status["message"] : undefined;
  if (!isObj(response) || !isObj(status) || !isObj(message)) return native;
  const role = message["role"] === "ROLE_USER" ? "ROLE_AGENT" : "agent";
  return { ...native, [bagKey]: { ...bag, "a2a:response": { ...response, status: { ...status, message: { ...message, role } } } } };
}

/** Shape (i): a streaming status update at submitted. (ii): a non-blocking
 *  Task at submitted, the only event. (iii): a Task at submitted with artifact
 *  parts, then the repeated status message. "python-status": ADK-Python's relay
 *  records the whole task as `a2a:response` for a status update too, and
 *  converts the repeated message into user-role content marked thought.
 *  "python-a2a1": the same relay on a2a-sdk 1.x records the task as protobuf
 *  JSON, with no `kind` and the enums TASK_STATE_SUBMITTED and ROLE_USER. */
function positive(shape: "status" | "task" | "task-artifacts" | "python-status" | "python-a2a1", snake: boolean, i: number): Leg {
  const tag = `${shape}${snake ? "-snake" : ""}-${i}`;
  const bagKey = snake ? "custom_metadata" : "customMetadata";
  const task = `task-${tag}`;
  const echo = echoParts(tag, snake);
  const artifactTexts = shape === "task-artifacts" ? [`Artifact one of ${tag}. `, `Artifact two of ${tag}.`] : [];
  const artifacts = artifactTexts.map((text) => ({ text }));
  const message = { kind: "message", role: "user", messageId: `m-${tag}`, parts: echo.a2a };
  const response: Obj =
    shape === "status"
      ? { kind: "status-update", taskId: task, contextId: `ctx-${task}`, final: false, status: { state: "submitted", message } }
      : shape === "python-status"
        ? { kind: "task", id: task, contextId: `ctx-${task}`, status: { state: "submitted", message }, history: [] }
        : shape === "python-a2a1"
          ? {
              id: task,
              contextId: `ctx-${task}`,
              status: { state: "TASK_STATE_SUBMITTED", message: { messageId: `m-${tag}`, contextId: `ctx-${task}`, taskId: task, role: "ROLE_USER", parts: echo.a2a }, timestamp: "2026-09-28T00:00:00Z" },
              history: [{ messageId: `m-${tag}`, contextId: `ctx-${task}`, taskId: task, role: "ROLE_USER", parts: echo.a2a }],
            }
      : {
          kind: "task",
          id: task,
          contextId: `ctx-${task}`,
          status: { state: "submitted", message },
          ...(shape === "task-artifacts" ? { artifacts: [{ artifactId: `art-${tag}`, parts: artifactTexts.map((text) => ({ kind: "text", text })) }] } : {}),
        };
  const ids = snake ? "long_running_tool_ids" : "longRunningToolIds";
  const base: Obj = {
    invocationId: `inv-${tag}`,
    author: "helper",
    ...(shape === "status" ? { partial: true, turnComplete: false } : { turnComplete: false }),
    [ids]: [echo.callId],
    ...relayed(bagKey, response, task),
  };
  const python = shape === "python-status" || shape === "python-a2a1";
  const role = python ? "user" : "model";
  const echoContent = python ? echo.content.map((p) => ({ ...p, thought: true })) : echo.content;
  const native: Obj = { ...base, content: { role, parts: [...artifacts, ...echoContent] } };
  const stripped = neutralised({ ...base, [ids]: [], content: { role, parts: artifacts } }, bagKey);
  return { label: tag, native, stripped, armOff: neutralised(native, bagKey), echoCount: echo.content.length, artifactTexts };
}

function drive(natives: Obj[], host: boolean): AgEvent[] {
  const n = createAdkNormalizer({ invokeId: "adk", ...(host ? { hostCompletion: true } : {}) });
  const out: AgEvent[] = [];
  for (const e of natives) out.push(...n.push(toJsonValue(e)));
  if (host) out.push(...n.push({ type: ADK_HOST_COMPLETE_TYPE }));
  out.push(...n.flush());
  return out;
}
/** A stream without its markers, seq renumbered, serialized. */
function withoutMarkers(out: AgEvent[]): string {
  return JSON.stringify(out.filter((e) => e.type !== MARKER).map((e, i) => ({ ...e, seq: i })));
}
function expectNoLeaf(out: AgEvent[], label: string): void {
  const wire = JSON.stringify(out);
  const deltas = new Map<string, string>();
  for (const e of out) if (e.type === "text.delta" || e.type === "reasoning.delta") deltas.set(e.id ?? "", (deltas.get(e.id ?? "") ?? "") + e.delta);
  for (const value of planted) {
    expect(wire.includes(value), `${label}: ${value}`).toBe(false);
    for (const text of deltas.values()) expect(text.includes(value), `${label}: ${value} in a block`).toBe(false);
  }
}
function expectCleanFold(out: AgEvent[], label: string, everyCallAnswered = true): void {
  for (const e of out) expect(() => AgEvent.parse(e), label).not.toThrow();
  const r = new Reducer();
  for (const e of out) r.push(e);
  expect(r.needsResync, label).toBe(false);
  if (!everyCallAnswered) return;
  const calls = out.flatMap((e) => (e.type === "tool.start" ? [e.toolCallId] : []));
  const done = new Set(out.flatMap((e) => (e.type === "tool.done" ? [e.toolCallId] : [])));
  for (const call of calls) expect(done.has(call), `${label}: ${call} has no result`).toBe(true);
}

// @google/adk's shapes under `customMetadata`; under `custom_metadata` (an
// event serialized from Python), a status update, a submitted task with no
// artifact, and ADK-Python's own record of a status update.
const positives: Leg[] = [
  ...(["status", "task", "task-artifacts"] as const).flatMap((shape) => [0, 1].map((i) => positive(shape, false, i))),
  ...(["status", "task", "python-status"] as const).flatMap((shape) => [0, 1].map((i) => positive(shape, true, i))),
  // ADK-Python's relay on a2a-sdk 1.x, under either spelling of the metadata member.
  ...[false, true].flatMap((snake) => [0, 1].map((i) => positive("python-a2a1", snake, i))),
];

describe("createAdkNormalizer — a forwarded request a remote agent repeats as a submitted user-role status is omitted", () => {
  it("each repeat, relayed as a streaming status update, a non-blocking Task or a Task with artifacts, under either spelling of the metadata member, reaches the wire in no form: no planted value, raw or in any block's text", () => {
    expect(positives).toHaveLength(16);
    for (const leg of positives) for (const host of [false, true]) expectNoLeaf(drive([leg.native], host), `${leg.label} host=${host}`);
    // All the legs in one fold, too.
    expectNoLeaf(drive(positives.map((l) => l.native), true), "one fold");
  });

  it("an event carrying a repeat maps exactly as the same event with those parts and their long-running ids removed: its markers aside, the stream is byte-identical, with no tool.start, tool.done or hitl.ask from the repeat", () => {
    for (const leg of positives) {
      for (const host of [false, true]) {
        const out = drive([leg.native], host);
        expect(withoutMarkers(out), `${leg.label} host=${host}`).toBe(JSON.stringify(drive([leg.stripped], host)));
        expect(out.some((e) => e.type === "tool.start" || e.type === "tool.done" || e.type === "hitl.ask"), leg.label).toBe(false);
      }
    }
  });

  it("the long-running ids a repeat's calls contributed go with them: a Workflow node's relayed repeat, after an ask of the run, does not signal that ask's pause, as a node's contentless long-running call would", () => {
    for (const i of [0, 1]) {
      const leg = positive("task", false, 10 + i);
      // A request-input call: an ask of the run whose pause is not signalled yet.
      const ask: Obj = {
        invocationId: `inv-task-10-${i}`,
        author: "gate",
        content: { role: "model", parts: [{ functionCall: { name: "adk_request_input", args: { message: "City?" }, id: `ri-${i}` } }] },
        longRunningToolIds: [`ri-${i}`],
      };
      const node = (n: Obj): Obj => ({ ...n, invocationId: `inv-task-10-${i}`, nodeInfo: { path: "helper" } });
      for (const host of [false, true]) {
        const out = drive([ask, node(leg.native)], host);
        expect(withoutMarkers(out), `#${i} host=${host}`).toBe(JSON.stringify(drive([ask, node(leg.stripped)], host)));
      }
    }
  });

  it("each such event yields exactly one ext.google.relay_echo_omitted, whose only member beyond the envelope is the number of parts it omitted", () => {
    for (const leg of positives) {
      const out = drive([leg.native], false);
      const markers = out.filter((e) => e.type === MARKER);
      expect(markers, leg.label).toHaveLength(1);
      const [marker] = markers;
      expect(Object.keys(marker ?? {}).sort(), leg.label).toEqual(["parts", "seq", "type"]);
      expect(marker, leg.label).toMatchObject({ parts: leg.echoCount });
    }
  });

  it("a Task's artifact parts map as they do with the omission off: the same text blocks, byte for byte", () => {
    for (const leg of positives.filter((l) => l.artifactTexts.length > 0)) {
      const blocks = (out: AgEvent[]) => JSON.stringify(out.filter((e) => e.type.startsWith("text.")).slice(0, 3 * leg.artifactTexts.length).map((e, i) => ({ ...e, seq: i })));
      const on = drive([leg.native], true);
      expect(on.flatMap((e) => (e.type === "text.delta" ? [e.delta] : [])), leg.label).toEqual(leg.artifactTexts);
      expect(blocks(on.filter((e) => e.type !== MARKER)), leg.label).toBe(blocks(drive([leg.armOff], true)));
    }
  });

  it("push() never throws on such an event, every event validates, and each fold ends with no resync and no tool call without its result", () => {
    for (const leg of positives) for (const host of [false, true]) expectCleanFold(drive([leg.native], host), `${leg.label} host=${host}`);
    expectCleanFold(drive(positives.map((l) => l.native), true), "one fold");
  });
});

describe("createAdkNormalizer — a user-role or submitted message that is not a repeated request maps as before", () => {
  const userParts = (tag: string): Obj[] => [
    { text: `User text ${tag}.` },
    { functionResponse: { name: "lookup", id: `fr-${tag}`, response: { result: `Result ${tag}.` } } },
  ];
  const statusResponse = (tag: string, state: string, role: string, parts: Obj[]): Obj => ({
    kind: "status-update",
    taskId: `task-${tag}`,
    contextId: `ctx-${tag}`,
    final: false,
    status: { state, message: { kind: "message", role, messageId: `m-${tag}`, parts } },
  });
  const negatives = (i: number): Array<[string, Obj[]]> => {
    const t = `neg-${i}`;
    const call: Obj = { invocationId: `inv-${t}`, author: "helper", content: { role: "model", parts: [{ functionCall: { name: "lookup", args: {}, id: `fr-${t}-b` } }] } };
    return [
      [
        "(a) an agent-role status update at submitted",
        [{ invocationId: `inv-${t}`, author: "helper", partial: true, content: { role: "model", parts: [{ text: `Agent says ${t}.` }, { functionCall: { name: "lookup", args: { q: t }, id: `fc-${t}-a` } }, ...userParts(`${t}-a`).slice(1)] }, customMetadata: { "a2a:response": statusResponse(`${t}-a`, "submitted", "agent", [{ kind: "text", text: `Agent says ${t}.` }, { kind: "data", data: {} }, { kind: "data", data: {} }]) } }],
      ],
      [
        "(b) a user-role status update at working carrying a function response (a remote workflow's tool result)",
        [call, { invocationId: `inv-${t}`, author: "helper", partial: true, content: { role: "model", parts: [{ functionResponse: { name: "lookup", id: `fr-${t}-b`, response: { result: `Tool result ${t}.` } } }] }, customMetadata: { "a2a:response": statusResponse(`${t}-b`, "working", "user", []) } }],
      ],
      [
        "(c) the same user-role parts on an event with no a2a:response, and with an entry of another kind",
        [
          { invocationId: `inv-${t}`, author: "helper", partial: true, content: { role: "model", parts: userParts(`${t}-c1`) } },
          { invocationId: `inv-${t}`, author: "helper", partial: true, content: { role: "model", parts: userParts(`${t}-c2`) }, customMetadata: { "a2a:response": { ...statusResponse(`${t}-c2`, "submitted", "user", [{ kind: "text", text: "x" }, { kind: "data", data: {} }]), kind: "artifact-update" } } },
        ],
      ],
      [
        "(d) a Task at another state with a user-role status message",
        [{ invocationId: `inv-${t}`, author: "helper", turnComplete: true, content: { role: "model", parts: userParts(`${t}-d`) }, customMetadata: { "a2a:response": { kind: "task", id: `task-${t}-d`, status: { state: "input-required", message: { kind: "message", role: "user", parts: [{ kind: "text", text: "x" }] } } } } }],
      ],
      [
        "(e) a submitted Task whose repeated message the host already removed",
        [{ invocationId: `inv-${t}`, author: "helper", content: { role: "model", parts: [{ text: `Artifact ${t}.` }] }, customMetadata: { "a2a:response": { kind: "task", id: `task-${t}-e`, status: { state: "submitted" }, artifacts: [{ artifactId: "a", parts: [{ kind: "text", text: `Artifact ${t}.` }] }] } } }],
      ],
      [
        "(g) an a2a-sdk 1.x record at TASK_STATE_WORKING whose message is ROLE_USER, a tool result",
        [{ invocationId: `inv-${t}`, author: "helper", content: { role: "user", parts: [{ functionResponse: { name: "lookup", id: `fr-${t}-g`, response: { result: `Tool result ${t}.` } } }] }, custom_metadata: { "a2a:response": { id: `task-${t}-g`, status: { state: "TASK_STATE_WORKING", message: { role: "ROLE_USER", parts: [{ data: {} }] } } } } }],
      ],
      [
        "(h) an a2a-sdk 1.x record at TASK_STATE_SUBMITTED whose message is ROLE_AGENT",
        [{ invocationId: `inv-${t}`, author: "helper", content: { role: "model", parts: [{ text: `Agent says ${t}.`, thought: true }] }, custom_metadata: { "a2a:response": { id: `task-${t}-h`, status: { state: "TASK_STATE_SUBMITTED", message: { role: "ROLE_AGENT", parts: [{ text: `Agent says ${t}.` }] } } } } }],
      ],
      [
        "(i) an a2a-sdk 1.x submitted task that holds an artifact part, which ADK-Python converts from its artifacts",
        [{ invocationId: `inv-${t}`, author: "helper", content: { role: "model", parts: [{ text: `Artifact ${t}.`, thought: true }] }, customMetadata: { "a2a:response": { id: `task-${t}-i`, status: { state: "TASK_STATE_SUBMITTED", message: { role: "ROLE_USER", parts: [{ text: `Forwarded ${t}.` }] } }, artifacts: [{ artifactId: "a", parts: [{ text: `Artifact ${t}.` }] }] } } }],
      ],
      [
        "(f) a submitted task relayed by ADK-Python, which converts its artifacts and not its user-role status message",
        [
          {
            invocationId: `inv-${t}`,
            author: "helper",
            content: { role: "model", parts: [{ text: `Artifact ${t}.`, thought: true }] },
            custom_metadata: {
              "a2a:response": {
                kind: "task",
                id: `task-${t}-f`,
                status: { state: "submitted", message: { kind: "message", role: "user", parts: [{ kind: "text", text: `Forwarded ${t}.` }] } },
                artifacts: [{ artifactId: "a", parts: [{ kind: "text", text: `Artifact ${t}.` }] }],
              },
            },
          },
        ],
      ],
    ];
  };

  it("each control (an agent-role submitted status, a user-role working status with a tool result, no a2a:response or another kind, a Task at another state, a repeat the host removed, a submitted task ADK-Python relays from its artifacts, and a2a-sdk 1.x records at another state, in the agent's role or holding an artifact) maps byte for byte as with the omission off, with no marker", () => {
    for (const i of [0, 1]) {
      for (const [label, natives] of negatives(i)) {
        for (const host of [false, true]) {
          const out = drive(natives, host);
          const off = drive(natives.map((n) => neutralised(neutralised(n, "customMetadata"), "custom_metadata")), host);
          expect(JSON.stringify(out), `${label} #${i} host=${host}`).toBe(JSON.stringify(off));
          expect(out.some((e) => e.type === MARKER), label).toBe(false);
          expectCleanFold(out, `${label} #${i} host=${host}`, false);
        }
      }
    }
  });

  it("a remote workflow's tool result relayed in the user role while working keeps its tool.done, which folds against its call", () => {
    for (const i of [0, 1]) {
      const [, natives] = negatives(i)[1] ?? ["", []];
      const out = drive(natives, true);
      expect(out.filter((e) => e.type === "tool.done").map((e) => (e.type === "tool.done" ? e.toolCallId : "")), `#${i}`).toEqual([`fr-neg-${i}-b`]);
      expectCleanFold(out, `#${i}`);
    }
  });
});
