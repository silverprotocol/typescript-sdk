/**
 * The OpenAI Agents SDK's built-in (hosted) tools, over the engine fixtures in
 * fixtures/openai-hosted (openai-hosted-fixtures.gen.test.ts). agents-core
 * streams a built-in tool's `tool_called` run item, and a hosted-MCP
 * `tool_approval_requested`, AFTER the raw `response.completed`. These legs
 * hold however the approval request itself is mapped: the calls stay in the
 * round of the response that made them, no turn opens after the response
 * completed, nothing is aborted at flush, and every ask names the call it
 * gates.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import type { AgEvent } from "@silverprotocol/core";
import { Reducer } from "@silverprotocol/core";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";

type Native = { type?: string; name?: string; data?: { type?: string; event?: { type?: string; response?: { id?: string } } } };
type Tagged = { i: number | "flush"; ev: AgEvent & Record<string, unknown> };

const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/openai-hosted/${name}.native.json`, import.meta.url), "utf8")) as Native[];

function drive(name: string, opts: { invokeId?: string; reducer?: Reducer } = {}): { tagged: Tagged[]; completedAt: number; responseId: string; needsResync: boolean } {
  const natives = load(name);
  const n = createOpenaiNormalizer({ invokeId: opts.invokeId ?? "openai" });
  const r = opts.reducer ?? new Reducer();
  const tagged: Tagged[] = [];
  natives.forEach((nat, i) => {
    for (const ev of n.push(nat)) {
      r.push(ev);
      tagged.push({ i, ev: ev as Tagged["ev"] });
    }
  });
  for (const ev of n.flush()) {
    r.push(ev);
    tagged.push({ i: "flush", ev: ev as Tagged["ev"] });
  }
  const completedAt = natives.findIndex((x) => x.data?.type === "model" && x.data.event?.type === "response.completed");
  const created = natives.find((x) => x.data?.type === "model" && x.data.event?.type === "response.created");
  return { tagged, completedAt, responseId: created?.data?.event?.response?.id ?? "", needsResync: r.needsResync };
}

const FIXTURES = ["hosted-mcp-approval", "hosted-websearch-mcp-complete"] as const;

describe("openai built-in tools: the calls stay in their response's round", () => {
  for (const name of FIXTURES) {
    it(`${name}: no turn opens after response.completed, and nothing is aborted at flush`, () => {
      const { tagged, completedAt } = drive(name);
      expect(completedAt).toBeGreaterThan(0);
      const lateStarts = tagged.filter((t) => t.ev.type === "turn.start" && (t.i === "flush" || t.i > completedAt));
      expect(lateStarts.map((t) => t.ev["turnId"])).toEqual([]);
      expect(tagged.filter((t) => t.i === "flush" && t.ev.type === "turn.abort")).toEqual([]);
    });

    it(`${name}: every built-in tool.start and tool.done lands in the round of the response that made the call`, () => {
      const { tagged, responseId } = drive(name);
      const tools = tagged.filter((t) => t.ev.type === "tool.start" || t.ev.type === "tool.done");
      expect(tools.length).toBeGreaterThan(0);
      expect([...new Set(tools.map((t) => t.ev["turnId"]))]).toEqual([`turn_${responseId}`]);
    });
  }

  it("hosted-mcp-approval: each ask names the call it gates, and no ask id is minted from a missing value", () => {
    const { tagged } = drive("hosted-mcp-approval");
    const asks = tagged.filter((t) => t.ev.type === "hitl.ask").map((t) => t.ev);
    expect(asks).toHaveLength(2);
    expect(asks.filter((a) => String(a["askId"]).includes("undefined"))).toEqual([]);
    expect(asks.map((a) => a["toolCallId"]).sort()).toEqual(["mcpr_1", "mcpr_2"]);
  });

  it("hosted-websearch-mcp-complete: the round closes success after its calls", () => {
    const { tagged, responseId, needsResync } = drive("hosted-websearch-mcp-complete");
    const turnId = `turn_${responseId}`;
    const terminals = tagged.filter((t) => ["turn.done", "turn.error", "turn.abort"].includes(t.ev.type) && t.ev["turnId"] === turnId);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.ev.type).toBe("turn.done");
    expect(terminals[0]!.ev["outcome"]).toEqual({ type: "success" });
    const done = tagged.indexOf(terminals[0]!);
    const lastToolDone = Math.max(...tagged.map((t, k) => (t.ev.type === "tool.done" ? k : -1)));
    expect(lastToolDone).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(lastToolDone);
    expect(needsResync).toBe(false);
  });

  it("hosted-websearch-mcp-complete: the hosted MCP call carries its arguments and its server label", () => {
    const { tagged } = drive("hosted-websearch-mcp-complete");
    const start = tagged.find((t) => t.ev.type === "tool.start" && t.ev["toolCallId"] === "mcp_1")?.ev;
    const args = tagged.find((t) => t.ev.type === "tool.args.assembled" && t.ev["toolCallId"] === "mcp_1")?.ev;
    expect(start?.["serverName"]).toBe("deepwiki");
    expect(args?.["input"]).toEqual({ q: "a" });
  });
});

describe("openai client-executed built-in tool, then a second model round", () => {
  it("shell-call-second-round: each response is its own round, the first closing after the shell call, and nothing is aborted", () => {
    const { tagged, needsResync } = drive("shell-call-second-round");
    const starts = tagged.filter((t) => t.ev.type === "turn.start").map((t) => t.ev["turnId"]);
    expect(starts).toEqual(["turn_resp_c1", "turn_resp_c2"]);
    const shellDone = tagged.findIndex((t) => t.ev.type === "tool.done" && t.ev["toolCallId"] === "call_sh_1");
    const firstDone = tagged.findIndex((t) => t.ev.type === "turn.done" && t.ev["turnId"] === "turn_resp_c1");
    expect(shellDone).toBeGreaterThanOrEqual(0);
    expect(firstDone).toBeGreaterThan(shellDone);
    expect(tagged.filter((t) => t.ev.type === "turn.abort")).toEqual([]);
    expect(needsResync).toBe(false);
  });

  it("shell-call-second-round: the second round's message.start carries the model", () => {
    const { tagged } = drive("shell-call-second-round");
    const second = tagged.find((t) => t.ev.type === "message.start" && t.ev["turnId"] === "turn_resp_c2")?.ev;
    expect(second?.["model"]).toBe("fake");
  });
});

describe("openai hosted-MCP approvals answered in the same invoke and on resume", () => {
  it("hosted-mcp-onapproval: each answer is its own call in the first round, which closes before the second round opens", () => {
    const { tagged, needsResync } = drive("hosted-mcp-onapproval");
    const answers = tagged.filter((t) => t.ev.type === "tool.start" && t.ev["name"] === "mcp_approval_response").map((t) => t.ev);
    expect(answers.map((a) => a["toolCallId"])).toEqual(["mcpr_1:approval-response", "mcpr_2:approval-response"]);
    expect(answers.map((a) => a["turnId"])).toEqual(["turn_resp_d1", "turn_resp_d1"]);
    const firstDone = tagged.findIndex((t) => t.ev.type === "turn.done" && t.ev["turnId"] === "turn_resp_d1");
    const secondStart = tagged.findIndex((t) => t.ev.type === "turn.start" && t.ev["turnId"] === "turn_resp_d2");
    const lastAnswerDone = Math.max(...tagged.map((t, k) => (t.ev.type === "tool.done" && String(t.ev["toolCallId"]).endsWith(":approval-response") ? k : -1)));
    expect(firstDone).toBeGreaterThan(lastAnswerDone);
    expect(secondStart).toBeGreaterThan(firstDone);
    const calls = tagged.filter((t) => t.ev.type === "tool.start" && t.ev["name"] === "mcp_call").map((t) => [t.ev["toolCallId"], t.ev["turnId"]]);
    expect(calls).toEqual([["mcp_1", "turn_resp_d2"], ["mcp_2", "turn_resp_d2"]]);
    expect(tagged.filter((t) => t.ev.type === "turn.abort")).toEqual([]);
    expect(needsResync).toBe(false);
  });

  for (const answer of ["approve", "reject"] as const) {
    it(`hosted-mcp-resume (${answer}): the resumed invoke carries the answer once under ids invoke 1 never used, and the two invokes fold clean`, () => {
      const reducer = new Reducer();
      const first = drive("hosted-mcp-resume.invoke1", { invokeId: "openai-1", reducer });
      const second = drive(`hosted-mcp-resume-${answer}.invoke2`, { invokeId: "openai-2", reducer });
      const turnIds = (tagged: Tagged[]) => new Set(tagged.map((t) => t.ev["turnId"]).filter((v) => v !== undefined));
      const messageIds = (tagged: Tagged[]) =>
        new Set(tagged.flatMap((t) => [t.ev.type === "message.start" ? t.ev["id"] : undefined, t.ev["messageId"]]).filter((v) => v !== undefined));
      for (const [key, idsOf] of [["turn id", turnIds], ["message id", messageIds]] as const) {
        expect(idsOf(second.tagged).size, `${key}s in the resumed invoke`).toBeGreaterThan(0);
        const reused = [...idsOf(second.tagged)].filter((id) => idsOf(first.tagged).has(id));
        expect(reused, `${key}s reused across invokes`).toEqual([]);
      }
      expect(second.tagged.filter((t) => t.ev.type === "tool.start" && t.ev["toolCallId"] === "mcpr_1")).toEqual([]);
      const answerDones = second.tagged.filter((t) => t.ev.type === "tool.done" && t.ev["toolCallId"] === "mcpr_1:approval-response");
      expect(answerDones).toHaveLength(1);
      const allIds = [...first.tagged, ...second.tagged].flatMap((t) => [t.ev["toolCallId"], t.ev["askId"]]).filter((v) => v !== undefined);
      expect(allIds.filter((id) => String(id).includes("undefined"))).toEqual([]);
      if (answer === "approve") {
        const call = second.tagged.find((t) => t.ev.type === "tool.start" && t.ev["name"] === "mcp_call")?.ev;
        expect(call?.["toolCallId"]).toBe("mcp_1");
      }
      expect(second.tagged.filter((t) => t.ev.type === "turn.abort")).toEqual([]);
      expect(reducer.needsResync).toBe(false);
    });

    it(`hosted-mcp-resume (${answer}): the resumed response's message.start carries its model`, () => {
      const { tagged } = drive(`hosted-mcp-resume-${answer}.invoke2`, { invokeId: "openai-2" });
      const textMessageId = tagged.find((t) => t.ev.type === "text.start")?.ev["messageId"];
      expect(textMessageId).toBeDefined();
      const start = tagged.find((t) => t.ev.type === "message.start" && t.ev["id"] === textMessageId)?.ev;
      expect(start?.["model"]).toBe("fake");
    });
  }
});
