import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { REDACTED, REDACTED_PATH, redactNative } from "./redact.js";

describe("redactNative", () => {
  const headers = {
    "openai-organization": "some-org",
    "OpenAI-Project": "proj_abc",
    "set-cookie": "__cf_bm=x",
    "x-request-id": "req_123",
    "content-type": "text/event-stream",
  };

  it("replaces the values of account-identifying keys at any depth, case-insensitively, and keeps every key", () => {
    const native: JsonValue = [{ type: "finish-step", response: { id: "resp_1", headers } }, { type: "finish" }];
    const out = redactNative(native) as Array<{ response?: { headers: Record<string, string> } }>;
    expect(out[0]?.response?.headers).toEqual({
      "openai-organization": REDACTED,
      "OpenAI-Project": REDACTED,
      "set-cookie": REDACTED,
      "x-request-id": "req_123",
      "content-type": "text/event-stream",
    });
    expect(out[1]).toEqual({ type: "finish" });
  });

  it("does not mutate its input, and is idempotent", () => {
    const native: JsonValue = { response: { headers } };
    const once = redactNative(native);
    expect((native as { response: { headers: Record<string, string> } }).response.headers["openai-organization"]).toBe("some-org");
    expect(redactNative(once)).toEqual(once);
  });

  it("a key named __proto__ stays an own data key (its value redacted-walked), never a prototype, never dropped", () => {
    const native = JSON.parse('{"headers":{"__proto__":{"Authorization":"Bearer live","keep":1},"x-request-id":"r"},"__proto__":"str"}') as JsonValue;
    const out = redactNative(native) as Record<string, unknown>;
    const headers = out["headers"] as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.hasOwn(headers, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse('{"headers":{"__proto__":{"Authorization":"<redacted>","keep":1},"x-request-id":"r"},"__proto__":"str"}'));
    expect(JSON.stringify(out)).not.toContain("Bearer live");
  });

  it("replaces every string under a local-path key (claude init cwd and memory_paths, a task's output file) and keeps the structure", () => {
    const init: JsonValue = {
      type: "system",
      subtype: "init",
      cwd: "/Users/someone/work/repo",
      memory_paths: { auto: "/Users/someone/.claude/projects/-Users-someone-work-repo/memory/" },
      tools: ["Task"],
    };
    expect(redactNative(init)).toEqual({ type: "system", subtype: "init", cwd: REDACTED_PATH, memory_paths: { auto: REDACTED_PATH }, tools: ["Task"] });
    const note: JsonValue = { type: "system", subtype: "task_notification", output_file: "/private/tmp/x/tasks/a1", status: "completed" };
    expect(redactNative(note)).toEqual({ type: "system", subtype: "task_notification", output_file: REDACTED_PATH, status: "completed" });
    const result: JsonValue = { type: "user", tool_use_result: { status: "async_launched", outputFile: "/private/tmp/x/tasks/a2", isAsync: true } };
    expect(redactNative(result)).toEqual({ type: "user", tool_use_result: { status: "async_launched", outputFile: REDACTED_PATH, isAsync: true } });
    expect(redactNative(redactNative(init))).toEqual(redactNative(init));
  });

  it("leaves scalars and non-matching trees byte-identical", () => {
    const native: JsonValue = [1, "a", null, true, { type: "text-delta", text: "authorization is a word" }];
    expect(JSON.stringify(redactNative(native))).toBe(JSON.stringify(native));
  });
});
