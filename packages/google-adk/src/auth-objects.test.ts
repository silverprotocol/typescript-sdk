/**
 * Direct tests for the auth-object helpers. push() hands them plain JSON (it
 * reads every native through core's toJsonValueSafe first), so the branches
 * that handle a non-JSON value are reachable only from here. They are kept as
 * defence in depth and pinned so a mutation cannot silently remove them.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import { carryNodeValue, changedOutputRendering, holdsAuthCredential, scrubStateMap } from "./auth-objects.js";

const credential = { authType: "apiKey", apiKey: "SECRET_direct" };

describe("auth-objects helpers, called directly with values push() never passes them", () => {
  it("scrubStateMap: once an entry is omitted, a remaining non-JSON entry is dropped rather than thrown on", () => {
    const raw = { "temp:k": "x", when: new Date(0), partial: { a: undefined }, keep: 1 };
    let out: JsonValue = null;
    expect(() => (out = scrubStateMap(raw))).not.toThrow();
    expect(out).toEqual({ keep: 1 });
  });

  it("scrubStateMap: a map value that is not an object but holds a credential becomes {}", () => {
    expect(scrubStateMap([credential])).toEqual({});
    expect(scrubStateMap(["plain", 1])).toEqual(["plain", 1]);
  });

  it("carryNodeValue: a value it cannot serialize is omitted (undefined), never thrown on", () => {
    const cyclic: { [k: string]: unknown } = { cred: credential };
    cyclic["self"] = cyclic;
    let carried: ReturnType<typeof carryNodeValue> = { value: null, changed: false };
    expect(() => (carried = carryNodeValue(cyclic))).not.toThrow();
    expect(carried).toBeUndefined();
  });

  it("carryNodeValue: a live value with undefined members is reduced; a value holding nothing to reduce is parsed as before", () => {
    expect(carryNodeValue({ cred: { ...credential, resourceRef: undefined }, note: undefined })).toEqual({
      value: { cred: { authType: "apiKey" } },
      changed: true,
    });
    expect(carryNodeValue({ cart: 3 })).toEqual({ value: { cart: 3 }, changed: false });
  });

  it("holdsAuthCredential fails closed: a value whose keys cannot be read counts as holding one", () => {
    const unreadable = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("keys");
        },
      },
    );
    expect(holdsAuthCredential({ inner: unreadable })).toBe(true);
    expect(holdsAuthCredential({ inner: { a: 1 } })).toBe(false);
  });

  it("changedOutputRendering: only an object output the reduction changed has a rendering to omit", () => {
    expect(changedOutputRendering({ cred: credential })).toBe(JSON.stringify({ cred: credential }));
    expect(changedOutputRendering({ cart: 3 })).toBeUndefined();
    expect(changedOutputRendering("SECRET_bare")).toBeUndefined();
    expect(changedOutputRendering({ cred: { authType: "apiKey", resourceRef: "r" } })).toBeUndefined();
  });
});
