import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { REDACTED, redactNative } from "./redact.js";

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

  it("leaves scalars and non-matching trees byte-identical", () => {
    const native: JsonValue = [1, "a", null, true, { type: "text-delta", text: "authorization is a word" }];
    expect(JSON.stringify(redactNative(native))).toBe(JSON.stringify(native));
  });
});
