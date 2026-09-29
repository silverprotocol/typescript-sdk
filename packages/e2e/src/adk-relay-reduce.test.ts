/**
 * The relay reduction every engine-built relay native passes (adk-relay-reduce.ts): what an `a2a:*` entry keeps is
 * structure, never text, and the writer's guard accepts exactly what the reduction produces.
 */
import { describe, expect, it } from "vitest";
import { RELAY_KEEP, pick, reduceRelayEntries, relayEntriesReduced } from "./adk-relay-reduce.js";

const native = (customMetadata: Record<string, unknown>) => ({ author: "helper", customMetadata });
const RAW = native({
  "a2a:request": { message: { role: "user", parts: [{ kind: "text", text: "the forwarded request" }] } },
  "a2a:response": {
    kind: "task",
    id: "task-1",
    status: { state: "submitted", timestamp: "t", message: { kind: "message", role: "user", messageId: "m", parts: [{ kind: "text", text: "an echoed leaf" }] } },
    artifacts: [{ artifactId: "a1", name: "answer", parts: [{ kind: "text", text: "remote text" }, { kind: "data", data: { secret: 1 } }] }],
    history: [{ role: "user", parts: [{ kind: "text", text: "history text" }] }],
  },
  "a2a:task_id": "task-1",
  "a2a:context_id": "ctx-1",
  note: "a non-relay entry is left alone",
});

describe("relay reduction (the relay natives of the engine-built fixture sets)", () => {
  it("keeps kind, the status state and message role, and each artifact's id and part kinds; no text, data, request or history survives", () => {
    const [out] = reduceRelayEntries([RAW]);
    expect(out!["customMetadata"]).toEqual({
      "a2a:request": {},
      "a2a:response": { kind: "task", status: { state: "submitted", message: { role: "user" } }, artifacts: [{ artifactId: "a1", parts: [{ kind: "text" }, { kind: "data" }] }] },
      "a2a:task_id": "task-1",
      "a2a:context_id": "ctx-1",
      note: "a non-relay entry is left alone",
    });
    const wire = JSON.stringify(out);
    for (const text of ["the forwarded request", "an echoed leaf", "remote text", "history text", "secret"]) expect(wire.includes(text), text).toBe(false);
  });

  it("keeps an artifact update's artifactId and nothing of its parts", () => {
    const [out] = reduceRelayEntries([native({ "a2a:response": { kind: "artifact-update", artifact: { artifactId: "a1", parts: [{ kind: "text", text: "Hel" }] }, append: false } })]);
    expect(out!["customMetadata"]).toEqual({ "a2a:response": { kind: "artifact-update", artifact: { artifactId: "a1" } } });
  });

  it("the guard accepts the reduced native and refuses the raw one, and reducing twice changes nothing", () => {
    const reduced = reduceRelayEntries([RAW]);
    expect(relayEntriesReduced(reduced)).toBe(true);
    expect(relayEntriesReduced([RAW])).toBe(false);
    expect(reduceRelayEntries(reduced)).toEqual(reduced);
    const planted = structuredClone(reduced);
    ((planted[0]!["customMetadata"] as Record<string, Record<string, unknown>>)["a2a:response"]!["status"] as Record<string, unknown>)["message"] = { role: "user", parts: [{ kind: "text", text: "x" }] };
    expect(relayEntriesReduced(planted)).toBe(false);
  });

  it("a path whose last segment is an array (`artifacts[]`) is refused, so no element is ever kept whole", () => {
    expect(() => pick({ artifacts: [{ parts: [{ kind: "text", text: "remote text" }] }] }, ["artifacts[]"])).toThrow(/must be followed by the member it keeps/);
    for (const paths of Object.values(RELAY_KEEP)) if (paths !== "all") for (const path of paths) expect(path.endsWith("[]"), path).toBe(false);
  });
});
