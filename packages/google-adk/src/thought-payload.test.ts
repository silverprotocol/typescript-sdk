/**
 * A part marked as thought that carries no text but a call, a result or media.
 * ADK-Python's A2A relay marks every part it converts from a remote agent's
 * in-progress status as thought, so a remote agent's tool call and
 * tool result can arrive that way. Such a part maps as it would unmarked, plus
 * one provider-raw block that carries its `thought` flag; a part marked as
 * thought that holds text, or nothing, stays a reasoning block.
 */
import { describe, expect, it } from "vitest";
import { AgEvent, JsonValue, Reducer, toJsonValue } from "@silverprotocol/core";
import { createAdkNormalizer } from "./index.js";

type Obj = { [k: string]: JsonValue };

function drive(natives: Obj[]): AgEvent[] {
  const n = createAdkNormalizer({ invokeId: "adk" });
  return [...natives.flatMap((e) => n.push(toJsonValue(e))), ...n.flush()];
}
const isThoughtCarry = (e: AgEvent): boolean =>
  e.type === "content.block" && JSON.stringify(Reflect.get(e, "block")) === JSON.stringify({ type: "provider-raw", vendor: "google", raw: { thought: true } });
/** A stream without its thought-flag carries, seqs renumbered, serialized. */
const withoutCarry = (out: AgEvent[]): string => JSON.stringify(out.filter((e) => !isThoughtCarry(e)).map((e, i) => ({ ...e, seq: i })));
function expectCleanFold(out: AgEvent[], label: string): void {
  for (const e of out) expect(() => AgEvent.parse(e), label).not.toThrow();
  const r = new Reducer();
  for (const e of out) r.push(e);
  expect(r.needsResync, label).toBe(false);
  const done = new Set(out.flatMap((e) => (e.type === "tool.done" ? [e.toolCallId] : [])));
  for (const e of out) if (e.type === "tool.start") expect(done.has(e.toolCallId), `${label}: ${e.toolCallId} has no result`).toBe(true);
}
const event = (tag: string, parts: Obj[], extra: Obj = {}): Obj => ({ invocationId: `inv-${tag}`, author: "remote", content: { role: "model", parts }, ...extra });
const call = (tag: string, id: string): Obj => ({ functionCall: { name: "lookup", args: { city: `City ${tag}` }, id } });
const result = (tag: string, id: string): Obj => ({ functionResponse: { name: "lookup", id, response: { forecast: `Sunny in ${tag}` } } });

/** Each payload leg as [label, the events before it, the payload part]. */
const legs = (i: number): Array<[string, Obj[], Obj]> => {
  const t = `p${i}`;
  return [
    ["a function call", [], call(t, `fc-${t}`)],
    ["a function call with a thought signature", [], { ...call(`${t}-signed`, `fc-${t}-signed`), thoughtSignature: `c2lnbmF0dXJl${i}` }],
    ["a function response, after its call", [event(`${t}-r`, [call(`${t}-r`, `fr-${t}`)])], result(t, `fr-${t}`)],
    ["inline data", [], { inlineData: { mimeType: "image/png", data: `aW1hZ2U${i}` } }],
    ["file data", [], { fileData: { mimeType: "application/pdf", fileUri: `gs://bucket/report-${t}.pdf` } }],
    ["executable code", [], { executableCode: { language: "PYTHON", code: `print(${i})` } }],
    ["a code execution result", [], { codeExecutionResult: { outcome: "OUTCOME_OK", output: `${i}\n` } }],
  ];
};

describe("createAdkNormalizer — a part marked as thought that carries a call, a result or media maps as it would unmarked", () => {
  const all = [0, 1].flatMap((i) => legs(i).map(([label, before, part]): [string, Obj[], Obj] => [`${label} #${i}`, before, part]));

  it("each such part (a call, a signed call, a response after its call, inline data, file data, code, a code result) maps byte for byte as the same part unmarked, plus one provider-raw block carrying thought:true, and opens no reasoning block", () => {
    expect(all).toHaveLength(14);
    for (const [label, before, part] of all) {
      const marked = drive([...before, event(`m-${label}`, [{ ...part, thought: true }])]);
      const plain = drive([...before, event(`m-${label}`, [part])]);
      expect(marked.filter(isThoughtCarry), label).toHaveLength(1);
      expect(plain.filter(isThoughtCarry), label).toHaveLength(0);
      expect(withoutCarry(marked), label).toBe(JSON.stringify(plain));
      expect(marked.some((e) => e.type.startsWith("reasoning.")), label).toBe(false);
    }
  });

  it("a remote agent's call and its result, both marked as thought, emit tool.start with the call's name and arguments and a tool.done that folds against it", () => {
    for (const i of [0, 1]) {
      const t = `pair-${i}`;
      const out = drive([event(t, [{ ...call(t, `fc-${t}`), thought: true }]), event(t, [{ ...result(t, `fc-${t}`), thought: true }])]);
      expect(out.find((e) => e.type === "tool.start"), t).toMatchObject({ toolCallId: `fc-${t}`, name: "lookup" });
      expect(out.find((e) => e.type === "tool.args.assembled"), t).toMatchObject({ toolCallId: `fc-${t}`, input: { city: `City ${t}` } });
      expect(out.filter((e) => e.type === "tool.done").map((e) => (e.type === "tool.done" ? e.toolCallId : "")), t).toEqual([`fc-${t}`]);
      expect(out.filter(isThoughtCarry), t).toHaveLength(2);
      expectCleanFold(out, t);
    }
  });

  it("one fold of every leg, each call followed by its result, ends with no resync and no tool call without its result", () => {
    const answered = (label: string, part: Obj): Obj[] => {
      const fc = part["functionCall"];
      const id = typeof fc === "object" && fc !== null && !Array.isArray(fc) ? fc["id"] : undefined;
      return typeof id === "string" ? [event(`m-${label}`, [result(label, id)])] : [];
    };
    expectCleanFold(drive(all.flatMap(([label, before, part]) => [...before, event(`m-${label}`, [{ ...part, thought: true }]), ...answered(label, part)])), "one fold");
  });
});

describe("createAdkNormalizer — a part marked as thought that holds text, or nothing, stays a reasoning block", () => {
  it("thought text, signed thought text and an empty thought part each open one reasoning block, with no text block and no thought:true carry", () => {
    for (const i of [0, 1]) {
      const cases: Array<[string, Obj, string[]]> = [
        ["text", { text: `Thinking ${i}.`, thought: true }, ["reasoning.start", "reasoning.delta", "reasoning.end"]],
        ["signed text", { text: `Thinking ${i}.`, thought: true, thoughtSignature: `c2ln${i}` }, ["reasoning.start", "reasoning.delta", "reasoning.end", "reasoning.opaque"]],
        ["empty", { thought: true }, ["reasoning.start", "reasoning.end"]],
      ];
      for (const [label, part, types] of cases) {
        const out = drive([event(`r-${label}-${i}`, [part])]);
        expect(out.filter((e) => e.type.startsWith("reasoning.")).map((e) => e.type), label).toEqual(types);
        expect(out.some((e) => e.type.startsWith("text.") || e.type.startsWith("tool.") || isThoughtCarry(e)), label).toBe(false);
        const delta = out.find((e) => e.type === "reasoning.delta");
        if (delta?.type === "reasoning.delta") expect(delta.delta, label).toBe(`Thinking ${i}.`);
      }
    }
  });

  it("thought text never renders as visible text: a part marked as thought that holds text beside a call stays a reasoning block (a known residual, not the intended mapping: the call beside any text, an empty one included, is not mapped yet)", () => {
    for (const i of [0, 1]) {
      const out = drive([event(`r-beside-${i}`, [{ text: `Thinking ${i}.`, thought: true, ...call(`beside-${i}`, `fc-beside-${i}`) }])]);
      expect(out.filter((e) => e.type.startsWith("reasoning.")).map((e) => e.type), `#${i}`).toEqual(["reasoning.start", "reasoning.delta", "reasoning.end"]);
      expect(out.some((e) => e.type.startsWith("text.") || isThoughtCarry(e)), `#${i}`).toBe(false);
    }
  });
});
