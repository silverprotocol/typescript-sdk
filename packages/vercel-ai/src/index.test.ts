import { describe, expect, it } from "vitest";
import { AgEvent } from "@silverprotocol/core";
import { createVercelNormalizer } from "./index.js";

describe("createVercelNormalizer — v0 scaffold contract", () => {
  it("satisfies the Normalizer shape", () => {
    const n = createVercelNormalizer();
    expect(typeof n.push).toBe("function");
    expect(typeof n.flush).toBe("function");
  });

  it("routes a guard-failing payload to ext.vercel.unparsed, nested under `native` (Tenet 6 — never throws)", () => {
    const n = createVercelNormalizer();
    const out = n.push(42);
    expect(out).toHaveLength(1);
    const ev = out[0] as unknown as { type: string; [k: string]: unknown };
    expect(ev.type).toBe("ext.vercel.unparsed");
    expect(JSON.stringify(ev)).toContain('"native":42');
    for (const e of out) expect(() => AgEvent.parse(e)).not.toThrow();
  });

  it("carries an unknown-typed part losslessly via ext.vercel.frame{kind,frame} (tolerant default arm, R2)", () => {
    const n = createVercelNormalizer();
    const part = { type: "future-part", payload: { x: 1 } };
    const out = n.push(part);
    expect(out).toHaveLength(1);
    const ev = out[0] as unknown as { type: string; [k: string]: unknown };
    expect(ev.type).toBe("ext.vercel.frame");
    const s = JSON.stringify(ev);
    expect(s).toContain('"kind":"future-part"');
    expect(s).toContain('"x":1');
    for (const e of out) expect(() => AgEvent.parse(e)).not.toThrow();
  });

  it("flush() with no lifecycle state emits nothing (no fabricated closes)", () => {
    const n = createVercelNormalizer();
    n.push({ type: "text-delta", id: "t1", delta: "hi" });
    expect(n.flush()).toHaveLength(0);
  });

  it("push() never throws on hostile inputs", () => {
    const n = createVercelNormalizer();
    for (const hostile of [null, undefined, [], "text", { noType: true }, { type: 7 }]) {
      expect(() => n.push(hostile)).not.toThrow();
    }
  });
});
