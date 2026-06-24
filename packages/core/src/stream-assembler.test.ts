import { describe, it, expect } from "vitest";
import { StreamAssembler } from "./stream-assembler.js";

it("synthesizes turn.start when a message opens before any turn (I1)", () => {
  const a = new StreamAssembler();
  a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
  expect(a.drain().map((e) => e.type)).toEqual(["turn.start", "message.start"]);
});
it("subagentStart seeds the turn so openMessage does NOT add a turn.start", () => {
  const a = new StreamAssembler();
  a.subagentStart("t2", "t1");
  a.openMessage({ id: "m1", role: "assistant", turnId: "t2", threadId: "th1" });
  expect(a.drain().map((e) => e.type)).toEqual(["subagent.start", "message.start"]); // NO turn.start
});
it("assigns turn-scoped monotonic seq across primitive calls (I5)", () => {
  const a = new StreamAssembler();
  a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
  a.closeMessage("m1");
  expect(a.drain().map((e) => e.seq)).toEqual([0, 1, 2]);
});
it("flush() emits message.end for a dangling open message (I7)", () => {
  const a = new StreamAssembler();
  a.openMessage({ id: "m1", role: "assistant", turnId: "t1", threadId: "th1" });
  a.drain();
  expect(a.flush().some((e) => e.type === "message.end")).toBe(true);
});
