/**
 * The OpenAI Agents SDK's built-in (hosted) tools, over the engine fixtures in
 * fixtures/openai-hosted (openai-hosted-fixtures.gen.test.ts). agents-core
 * streams a built-in tool's `tool_called` run item, and a hosted-MCP
 * `tool_approval_requested`, AFTER the raw `response.completed`. The calls
 * stay in the round of the response that made them, no turn opens after the
 * response completed, and nothing is aborted at flush. A hosted-MCP approval
 * request is a pending call of its round with an ask naming it, and the round
 * closes paused. Its answer closes that call with exactly one tool.done:
 * approved → ok, rejected → denied, with a string reason in providerMetadata.
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

  it("hosted-mcp-approval: each request stays a pending call, and the round closes paused at flush with one ask per request", () => {
    const { tagged, responseId, needsResync } = drive("hosted-mcp-approval");
    const turnId = `turn_${responseId}`;
    for (const id of ["mcpr_1", "mcpr_2"]) {
      const start = tagged.find((t) => t.ev.type === "tool.start" && t.ev["toolCallId"] === id)?.ev;
      expect(start?.["name"]).toBe("ask_question");
      expect(start?.["serverName"]).toBe("deepwiki");
      expect(start?.["providerMetadata"]).toMatchObject({ type: "mcp_approval_request" });
    }
    expect(tagged.filter((t) => t.ev.type === "tool.done")).toEqual([]);
    const terminals = tagged.filter((t) => ["turn.done", "turn.error", "turn.abort"].includes(t.ev.type) && t.ev["turnId"] === turnId);
    expect(terminals.map((t) => [t.i, t.ev.type])).toEqual([["flush", "turn.done"]]);
    const outcome = terminals[0]!.ev["outcome"] as { type: string; asks: Array<{ askId: string; kind: string; toolCallId: string }> };
    expect(outcome.type).toBe("paused");
    expect(outcome.asks.map((a) => [a.askId, a.kind, a.toolCallId])).toEqual([["approval_mcpr_1", "approval", "mcpr_1"], ["approval_mcpr_2", "approval", "mcpr_2"]]);
    expect(needsResync).toBe(false);
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

  it("hosted-websearch-mcp-complete: the hosted MCP call is named for its MCP tool and carries its arguments and its server label", () => {
    const { tagged } = drive("hosted-websearch-mcp-complete");
    const start = tagged.find((t) => t.ev.type === "tool.start" && t.ev["toolCallId"] === "mcp_1")?.ev;
    const args = tagged.find((t) => t.ev.type === "tool.args.assembled" && t.ev["toolCallId"] === "mcp_1")?.ev;
    expect(start?.["name"]).toBe("ask_question");
    expect(start?.["providerMetadata"]).toMatchObject({ type: "mcp_call" });
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
  it("hosted-mcp-onapproval: each answer closes the request it answers with one tool.done in the first round, which closes before the second round opens", () => {
    const { tagged, needsResync } = drive("hosted-mcp-onapproval");
    expect(tagged.filter((t) => String(t.ev["toolCallId"] ?? "").includes(":approval-response"))).toEqual([]);
    const answers = tagged.filter((t) => t.ev.type === "tool.done" && ["mcpr_1", "mcpr_2"].includes(String(t.ev["toolCallId"]))).map((t) => t.ev);
    expect(answers.map((a) => [a["toolCallId"], a["outcome"], a["turnId"]])).toEqual([["mcpr_1", "ok", "turn_resp_d1"], ["mcpr_2", "ok", "turn_resp_d1"]]);
    const firstDone = tagged.findIndex((t) => t.ev.type === "turn.done" && t.ev["turnId"] === "turn_resp_d1");
    const secondStart = tagged.findIndex((t) => t.ev.type === "turn.start" && t.ev["turnId"] === "turn_resp_d2");
    const lastAnswerDone = Math.max(...tagged.map((t, k) => (t.ev.type === "tool.done" && ["mcpr_1", "mcpr_2"].includes(String(t.ev["toolCallId"])) ? k : -1)));
    expect(firstDone).toBeGreaterThan(lastAnswerDone);
    expect(secondStart).toBeGreaterThan(firstDone);
    const calls = tagged.filter((t) => t.ev.type === "tool.start" && (t.ev["providerMetadata"] as { type?: string } | undefined)?.type === "mcp_call").map((t) => [t.ev["toolCallId"], t.ev["turnId"]]);
    expect(calls).toEqual([["mcp_1", "turn_resp_d2"], ["mcp_2", "turn_resp_d2"]]);
    expect(tagged.filter((t) => t.ev.type === "turn.abort")).toEqual([]);
    expect(needsResync).toBe(false);
  });

  it("hosted-mcp-onapproval-reject: a rejection closes the request denied with its reason in providerMetadata, in the first round, which closes before the second round opens", () => {
    const { tagged, needsResync } = drive("hosted-mcp-onapproval-reject");
    const done = tagged.filter((t) => t.ev.type === "tool.done" && t.ev["toolCallId"] === "mcpr_1").map((t) => t.ev);
    expect(done.map((d) => [d["outcome"], d["turnId"]])).toEqual([["denied", "turn_resp_f1"]]);
    expect(done[0]!["providerMetadata"]).toMatchObject({ reason: "not this server" });
    const firstDone = tagged.findIndex((t) => t.ev.type === "turn.done" && t.ev["turnId"] === "turn_resp_f1");
    const secondStart = tagged.findIndex((t) => t.ev.type === "turn.start" && t.ev["turnId"] === "turn_resp_f2");
    expect(firstDone).toBeGreaterThan(tagged.findIndex((t) => t.ev.type === "tool.done" && t.ev["toolCallId"] === "mcpr_1"));
    expect(secondStart).toBeGreaterThan(firstDone);
    expect(tagged.filter((t) => t.ev.type === "tool.start" && (t.ev["providerMetadata"] as { type?: string } | undefined)?.type === "mcp_call")).toEqual([]);
    expect(tagged.filter((t) => t.ev.type === "turn.abort")).toEqual([]);
    expect(needsResync).toBe(false);
  });

  it("hosted-mcp-partial-resume: a resume that answers one of two requests closes that invoke's resume turn as turn.abort stream-truncated (a stated limit), and a later invoke closes the other request", () => {
    const reducer = new Reducer();
    const invokes = [1, 2, 3].map((k) => drive(`hosted-mcp-partial-resume.invoke${k}`, { invokeId: `openai-${k}`, reducer }));
    const [first, second, third] = invokes as [ReturnType<typeof drive>, ReturnType<typeof drive>, ReturnType<typeof drive>];
    const paused = first.tagged.find((t) => t.ev.type === "turn.done")?.ev["outcome"] as { type: string; asks: Array<{ askId: string }> };
    expect([paused.type, paused.asks.map((a) => a.askId)]).toEqual(["paused", ["approval_mcpr_1", "approval_mcpr_2"]]);
    const closes = (tagged: Tagged[], id: string) => tagged.filter((t) => t.ev.type === "tool.done" && t.ev["toolCallId"] === id).map((t) => [t.ev["outcome"], t.ev["turnId"]]);
    expect(closes(second.tagged, "mcpr_1")).toEqual([["ok", "turn_resume_mcpr_1"]]);
    expect(closes(second.tagged, "mcpr_2")).toEqual([]);
    expect(second.tagged.filter((t) => t.ev.type === "hitl.ask")).toEqual([]);
    const secondTerminals = second.tagged.filter((t) => ["turn.done", "turn.error", "turn.abort"].includes(t.ev.type));
    expect(secondTerminals.map((t) => [t.ev.type, t.ev["turnId"], t.ev["reason"]])).toEqual([["turn.abort", "turn_resume_mcpr_1", "stream-truncated"]]);
    expect(closes(third.tagged, "mcpr_2")).toEqual([["denied", "turn_resume_mcpr_2"]]);
    const thirdDone = third.tagged.filter((t) => t.ev.type === "turn.done").map((t) => [t.ev["turnId"], (t.ev["outcome"] as { type: string }).type]);
    expect(thirdDone).toEqual([["turn_resume_mcpr_2", "success"]]);
    expect(invokes.flatMap((x) => x.tagged).filter((t) => String(t.ev["toolCallId"] ?? "").includes(":approval-response"))).toEqual([]);
    const alone = [1, 2, 3].map((k) => drive(`hosted-mcp-partial-resume.invoke${k}`, { invokeId: `openai-${k}` }).needsResync);
    expect(alone, "each invoke folded alone").toEqual([false, false, false]);
    expect(reducer.needsResync, "the three invokes through one reducer").toBe(false);
  });

  for (const answer of ["approve", "reject"] as const) {
    it(`hosted-mcp-resume (${answer}): the resumed invoke closes the request once (${answer === "approve" ? "ok" : "denied"}) under ids invoke 1 never used, and the two invokes fold clean`, () => {
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
      const answerDones = second.tagged.filter((t) => t.ev.type === "tool.done" && t.ev["toolCallId"] === "mcpr_1");
      expect(answerDones.map((t) => t.ev["outcome"])).toEqual([answer === "approve" ? "ok" : "denied"]);
      expect([...first.tagged, ...second.tagged].filter((t) => String(t.ev["toolCallId"] ?? "").includes(":approval-response"))).toEqual([]);
      const allIds = [...first.tagged, ...second.tagged].flatMap((t) => [t.ev["toolCallId"], t.ev["askId"]]).filter((v) => v !== undefined);
      expect(allIds.filter((id) => String(id).includes("undefined"))).toEqual([]);
      if (answer === "approve") {
        const call = second.tagged.find((t) => t.ev.type === "tool.start" && (t.ev["providerMetadata"] as { type?: string } | undefined)?.type === "mcp_call")?.ev;
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
