// The streaming-input gate behind `CaptureRunInput.followUpPrompts` (a
// multi-result capture: one invoke, several results — the live receipt for the
// claude facet's one-turnId-per-turn fix). Exercised WITHOUT the SDK: the run
// loop calls `resultSeen()` on each `result` frame, and the gate must release
// exactly one follow-up per result, in order, then end.
import type { UUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gatedPromptStream } from "./run.js";

let n = 0;
const mint = (): UUID => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` as const;

async function next<T>(it: AsyncIterator<T>, withinMs = 50): Promise<IteratorResult<T> | "pending"> {
  const timeout = new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), withinMs));
  return Promise.race([it.next(), timeout]);
}

describe("gatedPromptStream — multi-result streaming input", () => {
  it("yields the first prompt at once, each follow-up only after a result, then ends", async () => {
    n = 0;
    const { stream, resultSeen } = gatedPromptStream(["first", "second", "third"], mint);
    const it = stream[Symbol.asyncIterator]();
    const a = await next(it);
    expect(a).toMatchObject({ done: false, value: { type: "user", message: { role: "user", content: "first" }, parent_tool_use_id: null } });
    // No result yet: the second prompt must NOT be released.
    const blocked = it.next();
    expect(await Promise.race([blocked, new Promise((r) => setTimeout(() => r("pending"), 50))])).toBe("pending");
    resultSeen();
    expect(await blocked).toMatchObject({ done: false, value: { message: { content: "second" } } });
    resultSeen();
    expect(await next(it)).toMatchObject({ done: false, value: { message: { content: "third" } } });
    // After the last prompt the input ends (no further result needed).
    expect(await next(it)).toEqual({ done: true, value: undefined });
  });

  it("every prompt carries its own caller-minted uuid (so the SDK stamps user_message_uuid on replies)", async () => {
    n = 0;
    const { stream, resultSeen } = gatedPromptStream(["a", "b"], mint);
    const uuids: unknown[] = [];
    const it = stream[Symbol.asyncIterator]();
    const first = await it.next();
    uuids.push(first.done ? undefined : first.value.uuid);
    resultSeen();
    const second = await it.next();
    uuids.push(second.done ? undefined : second.value.uuid);
    expect(uuids).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
  });

  it("a result seen BEFORE the stream asks for the next prompt is not lost", async () => {
    const { stream, resultSeen } = gatedPromptStream(["a", "b"], mint);
    const it = stream[Symbol.asyncIterator]();
    await it.next();
    resultSeen(); // arrives while the SDK has not yet pulled the next prompt
    expect(await next(it)).toMatchObject({ done: false, value: { message: { content: "b" } } });
    expect(await next(it)).toEqual({ done: true, value: undefined });
  });

  it("a single prompt yields once and ends — no result is awaited", async () => {
    const { stream } = gatedPromptStream(["only"], mint);
    const it = stream[Symbol.asyncIterator]();
    expect(await next(it)).toMatchObject({ done: false, value: { message: { content: "only" } } });
    expect(await next(it)).toEqual({ done: true, value: undefined });
  });
});
