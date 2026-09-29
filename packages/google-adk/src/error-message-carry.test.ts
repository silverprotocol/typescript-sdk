/**
 * An ADK event that carries `errorMessage` without an `errorCode` (ADK's A2A
 * relay reports its own failure that way, and a remote executor's failure the
 * relay passes on) is not an in-band invocation error, so it yields no `error`
 * event and closes nothing differently. Its message is still a native value
 * with no other home: it rides the event-level provider-raw carry verbatim.
 */
import { describe, expect, it } from "vitest";
import { AgEvent, JsonValue, Reducer, toJsonValue } from "@silverprotocol/core";
import { ADK_HOST_COMPLETE_TYPE, createAdkNormalizer } from "./index.js";

type Obj = { [k: string]: JsonValue };

function drive(natives: Obj[], host: boolean): AgEvent[] {
  const n = createAdkNormalizer({ invokeId: "adk", ...(host ? { hostCompletion: true } : {}) });
  return [...natives.flatMap((e) => n.push(toJsonValue(e))), ...(host ? n.push({ type: ADK_HOST_COMPLETE_TYPE }) : []), ...n.flush()];
}
/** The provider-raw blocks' raw members that carry an errorMessage. */
function carried(out: AgEvent[]): Obj[] {
  return out.flatMap((e) => {
    if (e.type !== "content.block") return [];
    const block: unknown = Reflect.get(e, "block");
    const raw: unknown = typeof block === "object" && block !== null && Reflect.get(block, "type") === "provider-raw" ? Reflect.get(block, "raw") : undefined;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.hasOwn(raw, "errorMessage") ? [Object.fromEntries(Object.entries(raw))] : [];
  });
}
const terminals = (out: AgEvent[]): Array<[string, unknown]> =>
  out.flatMap((e): Array<[string, unknown]> => (/^turn\.(done|error|abort)$/.test(e.type) ? [[e.type, Reflect.get(e, "code") ?? Reflect.get(e, "reason") ?? null]] : []));
function expectCleanFold(out: AgEvent[], label: string): void {
  for (const e of out) expect(() => AgEvent.parse(e), label).not.toThrow();
  const r = new Reducer();
  for (const e of out) r.push(e);
  expect(r.needsResync, label).toBe(false);
}

const block = (inv: string, task: string): Obj => ({
  invocationId: inv,
  author: "helper",
  turnComplete: true,
  errorCode: "SAFETY",
  errorMessage: "The response was blocked for safety.",
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  customMetadata: { "a2a:request": {}, "a2a:response": { kind: "status-update" }, "a2a:task_id": task, "a2a:context_id": `ctx-${task}` },
});

describe("createAdkNormalizer — an error message without an error code rides the event-level carry", () => {
  const messages = ["partOrString cannot be an empty array", "Remote agent request failed: connection refused"];
  /** Each shape as [label, natives, the expected terminals bare, with host completion]. */
  const shapes = (message: string, i: number): Array<[string, Obj[], Array<[string, unknown]>, Array<[string, unknown]>]> => {
    const inv = `inv-carry-${i}`;
    const failure = (extra: Obj = {}): Obj => ({ invocationId: inv, author: "helper", errorMessage: message, ...extra });
    return [
      ["on its own, closing the call", [failure({ turnComplete: true })], [["turn.done", null]], [["turn.done", null]]],
      ["on its own, not closing it", [failure()], [["turn.abort", "stream-truncated"]], [["turn.done", null]]],
      ["after streamed text", [{ invocationId: inv, author: "helper", content: { role: "model", parts: [{ text: `Hi ${i}.` }] }, partial: true }, failure({ turnComplete: true })], [["turn.done", null]], [["turn.done", null]]],
      ["after a relayed block", [block(inv, `task-${i}`), failure({ turnComplete: true })], [["turn.error", "SAFETY"]], [["turn.error", "SAFETY"]]],
    ];
  };

  it("in each shape (on its own, closing the call or not, after streamed text, after a relayed block), the message rides verbatim in exactly one provider-raw block, no error event comes of it, and the turn closes as it does without the carry", () => {
    for (const [i, message] of messages.entries()) {
      for (const [label, natives, bare, hc] of shapes(message, i)) {
        for (const host of [false, true]) {
          const tag = `${label} #${i} host=${host}`;
          const out = drive(natives, host);
          expect(carried(out).map((raw) => raw["errorMessage"]), tag).toEqual([message]);
          expect(out.filter((e) => e.type === "error").map((e) => Reflect.get(e, "code")), tag).toEqual(label === "after a relayed block" ? ["SAFETY"] : []);
          expect(terminals(out), tag).toEqual(host ? hc : bare);
          expectCleanFold(out, tag);
        }
      }
    }
  });

  it("the remote failure ADK's A2A relay passes on after a relayed block, as engine-built by @google/adk 2.1.0 (a LoopAgent over a RemoteA2AAgent whose second iteration's empty message fails), with and without the block's usage, carries its message once", () => {
    const real = (withUsage: boolean): Obj[] => [
      {
        author: "helper",
        errorCode: "SAFETY",
        errorMessage: "The response was blocked for safety.",
        ...(withUsage ? { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } } : {}),
        customMetadata: { "a2a:request": {}, "a2a:response": { kind: "status-update" }, "a2a:task_id": "16787a53-891b-4bba-b8d7-26291b06049b", "a2a:context_id": "6852a163-65ad-46a7-a2af-c8f9c6e4975d" },
        actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {}, escalate: false },
        id: "f3pwRav2",
        invocationId: "e-2a610a2e-1980-473d-b9b1-062f457704a6",
        longRunningToolIds: [],
        timestamp: 1790676643522,
        turnComplete: true,
      },
      {
        author: "helper",
        invocationId: "e-2a610a2e-1980-473d-b9b1-062f457704a6",
        errorMessage: "partOrString cannot be an empty array",
        turnComplete: true,
        id: "IMuUjLeh",
        actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {} },
        longRunningToolIds: [],
        timestamp: 1790676643523,
      },
    ];
    for (const withUsage of [true, false]) {
      for (const host of [false, true]) {
        const tag = `usage=${withUsage} host=${host}`;
        const out = drive(real(withUsage), host);
        expect(carried(out).map((raw) => raw["errorMessage"]), tag).toEqual(["partOrString cannot be an empty array"]);
        expect(out.filter((e) => e.type === "error"), tag).toHaveLength(1);
        expect(terminals(out), tag).toEqual([["turn.error", "SAFETY"]]);
        expectCleanFold(out, tag);
      }
    }
  });

  it("an in-band error (both an error code and an error message) carries neither in the provider-raw block: item 35 maps the pair", () => {
    for (const i of [0, 1]) {
      for (const host of [false, true]) {
        const out = drive([block(`inv-pair-${i}`, `task-pair-${i}`)], host);
        expect(carried(out), `#${i} host=${host}`).toEqual([]);
        expect(out.filter((e) => e.type === "error").map((e) => Reflect.get(e, "code")), `#${i} host=${host}`).toEqual(["SAFETY"]);
      }
    }
  });

  it("an error code that is not a string, beside an error message, is no in-band error either: both ride the carry verbatim", () => {
    for (const [i, code] of [500, true].entries()) {
      for (const host of [false, true]) {
        const tag = `${JSON.stringify(code)} host=${host}`;
        const out = drive([{ invocationId: `inv-code-${i}`, author: "helper", errorCode: code, errorMessage: `failed ${i}`, turnComplete: true }], host);
        expect(carried(out), tag).toEqual([{ errorCode: code, errorMessage: `failed ${i}` }]);
        expect(out.some((e) => e.type === "error"), tag).toBe(false);
      }
    }
  });
});
