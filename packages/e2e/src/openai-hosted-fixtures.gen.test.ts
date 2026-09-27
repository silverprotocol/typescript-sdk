/**
 * Engine fixtures for the OpenAI Agents SDK's built-in (hosted) tool shape.
 * The recorded corpus has no run that calls a non-function tool, so these
 * two runs are generated here instead: the REAL @openai/agents `run()` (the
 * version packages/e2e pins) streamed over a structural fake Model, with no
 * key, no network and tracing off.
 *
 * Provenance: the run items, their order and their shapes are agents-core's
 * own (a streamed run emits the step's items after the raw model loop, and a
 * hosted-MCP approval item comes from its model-output processing). The raw
 * Responses events are the fake model's, modelled on the recorded
 * function_call order. They are synthetic natives, not captures.
 *
 *  - hosted-mcp-approval: two hosted-MCP approval requests
 *    (requireApproval "always"); the run is interrupted.
 *  - hosted-websearch-mcp-complete: a web_search_call, a hosted mcp_call that
 *    needs no approval, then final text; the run completes.
 *  - shell-call-second-round: a client-executed shell_call round (agents-core
 *    runs it through a stub shell executor; nothing executes), then a second
 *    model round with text.
 *  - hosted-mcp-onapproval: two hosted-MCP approval requests answered in the
 *    same invoke by an onApproval callback (both approved), then a second
 *    response with the two mcp_calls and text.
 *  - hosted-mcp-resume.invoke1: one hosted-MCP approval request; the run is
 *    interrupted. hosted-mcp-resume-approve.invoke2 and
 *    hosted-mcp-resume-reject.invoke2 resume that run from its RunState with
 *    the request approved (the model then returns the mcp_call and text) or
 *    rejected (text only).
 *
 * Regenerate (never part of the gate):
 *   GEN_OPENAI_HOSTED=1 npx vitest run --config ../../vitest.config.ts src/openai-hosted-fixtures.gen.test.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { Agent, run, hostedMcpTool, webSearchTool, shellTool, setTracingDisabled } from "@openai/agents";
import type { JsonValue } from "@silverprotocol/core";

const OUT_DIR = join(import.meta.dirname, "..", "fixtures", "openai-hosted");
type Obj = { [k: string]: unknown };

/** A structural streamed Model: raw Responses events for `wire`, then
 *  response_done with the protocol items agents-openai's converter builds. */
function fakeModel(rid: string, wire: Obj[], protocolItems: Obj[], text?: string) {
  return {
    async getResponse(): Promise<never> {
      throw new Error("stream only");
    },
    async *getStreamedResponse() {
      let seq = 0;
      yield { type: "response_started" };
      yield { type: "model", event: { type: "response.created", response: { id: rid, model: "fake" }, sequence_number: seq++ } };
      for (const [i, item] of wire.entries()) {
        yield { type: "model", event: { type: "response.output_item.added", item: { ...item, ...(item.type === "message" ? { content: [] } : {}) }, output_index: i, sequence_number: seq++ } };
        if (item.type === "message" && text !== undefined) {
          yield { type: "output_text_delta", delta: text };
          yield { type: "model", event: { type: "response.output_text.delta", item_id: item.id, delta: text, output_index: i, content_index: 0, sequence_number: seq++ } };
        }
        yield { type: "model", event: { type: "response.output_item.done", item, output_index: i, sequence_number: seq++ } };
      }
      yield { type: "model", event: { type: "response.completed", response: { id: rid, status: "completed", output: wire, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }, sequence_number: seq++ } };
      yield { type: "response_done", response: { id: rid, usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 }, output: protocolItems } };
    },
  };
}

/** A structural streamed Model that serves one scripted response per call. */
function scriptedModel(calls: ReturnType<typeof fakeModel>[]) {
  let i = 0;
  return {
    async getResponse(): Promise<never> {
      throw new Error("stream only");
    },
    getStreamedResponse() {
      const m = calls[Math.min(i, calls.length - 1)]!;
      i += 1;
      return m.getStreamedResponse();
    },
  };
}

/** Drains one streamed run into JSON-safe natives. */
async function drain(stream: AsyncIterable<unknown> & { completed: Promise<void> }): Promise<JsonValue[]> {
  const out: JsonValue[] = [];
  for await (const ev of stream) out.push(JSON.parse(JSON.stringify(ev)) as JsonValue);
  await stream.completed;
  return out;
}

/** Streams one run and returns every stream event as a JSON-safe native. */
async function natives(agent: Agent): Promise<JsonValue[]> {
  return drain(await run(agent, "hi", { stream: true }));
}

/** Runs to its approval interruption, answers every pending approval, and resumes
 *  from the RunState: the natives of both invokes. */
async function resumed(agent: Agent, approve: boolean): Promise<[JsonValue[], JsonValue[]]> {
  const first = await run(agent, "hi", { stream: true });
  const invoke1 = await drain(first);
  const state = first.state;
  for (const item of first.interruptions) {
    if (approve) state.approve(item);
    else state.reject(item);
  }
  const invoke2 = await drain(await run(agent, state, { stream: true }));
  return [invoke1, invoke2];
}

const write = (name: string, events: JsonValue[]) => writeFileSync(join(OUT_DIR, `${name}.native.json`), JSON.stringify(events, null, 2) + "\n");

describe.runIf(process.env["GEN_OPENAI_HOSTED"] === "1")("openai hosted-tool engine fixtures (real @openai/agents, fake model)", () => {
  setTracingDisabled(true);

  it("writes the hosted-tool, shell-call and approval-answer fixtures", async () => {
    const reqs = [
      { type: "mcp_approval_request", id: "mcpr_1", server_label: "deepwiki", name: "ask_question", arguments: '{"q":"a"}' },
      { type: "mcp_approval_request", id: "mcpr_2", server_label: "deepwiki", name: "ask_question", arguments: '{"q":"b"}' },
    ];
    write(
      "hosted-mcp-approval",
      await natives(
        new Agent({
          name: "A",
          model: fakeModel("resp_a", reqs, reqs.map((q) => ({ type: "hosted_tool_call", id: q.id, name: "mcp_approval_request", status: "completed", providerData: { ...q } }))) as never,
          tools: [hostedMcpTool({ serverLabel: "deepwiki", serverUrl: "https://example.invalid/mcp", requireApproval: "always" })],
        }),
      ),
    );

    const ws = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q" } };
    const mcp = { type: "mcp_call", id: "mcp_1", server_label: "deepwiki", name: "ask_question", arguments: '{"q":"a"}', output: "answer", error: null };
    const msg = { type: "message", id: "msg_b", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] };
    const { status: wsStatus, ...wsRest } = ws;
    const { output: mcpOut, ...mcpRest } = mcp;
    write(
      "hosted-websearch-mcp-complete",
      await natives(
        new Agent({
          name: "B",
          model: fakeModel(
            "resp_b",
            [ws, mcp, msg],
            [
              { type: "hosted_tool_call", id: ws.id, name: "web_search_call", status: wsStatus, providerData: wsRest },
              { type: "hosted_tool_call", id: mcp.id, name: "mcp_call", status: "completed", output: mcpOut, providerData: mcpRest },
              { type: "message", id: msg.id, role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }] },
            ],
            "done",
          ) as never,
          tools: [webSearchTool(), hostedMcpTool({ serverLabel: "deepwiki", serverUrl: "https://example.invalid/mcp", requireApproval: "never" })],
        }),
      ),
    );

    const sh = { type: "shell_call", id: "sh_1", call_id: "call_sh_1", status: "completed", action: { commands: ["echo hi"] } };
    const { call_id: shCallId, status: shStatus, action: shAction, ...shRest } = sh;
    const msgC = { type: "message", id: "msg_c2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "it said hi", annotations: [] }] };
    write(
      "shell-call-second-round",
      await natives(
        new Agent({
          name: "C",
          model: scriptedModel([
            fakeModel("resp_c1", [sh], [{ type: "shell_call", id: sh.id, callId: shCallId, status: shStatus, action: shAction, providerData: shRest }]),
            fakeModel("resp_c2", [msgC], [{ type: "message", id: msgC.id, role: "assistant", status: "completed", content: [{ type: "output_text", text: "it said hi" }] }], "it said hi"),
          ]) as never,
          tools: [shellTool({ shell: { run: async () => ({ output: [{ stdout: "hi\n", stderr: "", outcome: { type: "exit", exitCode: 0 } }] }) } })],
        }),
      ),
    );

    // Hosted-MCP approvals answered by onApproval, then resumed from RunState.
    const approvalRound = (rid: string, ids: string[]) => {
      const items = ids.map((id, k) => ({ type: "mcp_approval_request", id, server_label: "deepwiki", name: "ask_question", arguments: `{"q":"${"ab"[k] ?? "a"}"}` }));
      return fakeModel(rid, items, items.map((q) => ({ type: "hosted_tool_call", id: q.id, name: "mcp_approval_request", status: "completed", providerData: { ...q } })));
    };
    const answerRound = (rid: string, calls: Array<{ id: string; q: string }>, text: string) => {
      const mcps = calls.map((c) => ({ type: "mcp_call", id: c.id, server_label: "deepwiki", name: "ask_question", arguments: `{"q":"${c.q}"}`, output: `answer ${c.q}`, error: null }));
      const m = { type: "message", id: `msg_${rid}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      return fakeModel(
        rid,
        [...mcps, m],
        [
          ...mcps.map(({ output, ...rest }) => ({ type: "hosted_tool_call", id: rest.id, name: "mcp_call", status: "completed", output, providerData: rest })),
          { type: "message", id: m.id, role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
        ],
        text,
      );
    };
    const gated = (onApproval?: () => Promise<{ approve: boolean }>) =>
      hostedMcpTool({ serverLabel: "deepwiki", serverUrl: "https://example.invalid/mcp", requireApproval: "always", ...(onApproval ? { onApproval } : {}) });

    write(
      "hosted-mcp-onapproval",
      await natives(
        new Agent({
          name: "D",
          model: scriptedModel([approvalRound("resp_d1", ["mcpr_1", "mcpr_2"]), answerRound("resp_d2", [{ id: "mcp_1", q: "a" }, { id: "mcp_2", q: "b" }], "done")]) as never,
          tools: [gated(async () => ({ approve: true }))],
        }),
      ),
    );

    for (const approve of [true, false]) {
      const [invoke1, invoke2] = await resumed(
        new Agent({
          name: "E",
          model: scriptedModel([approvalRound("resp_e1", ["mcpr_1"]), approve ? answerRound("resp_e2", [{ id: "mcp_1", q: "a" }], "done") : answerRound("resp_e2", [], "declined")]) as never,
          tools: [gated()],
        }),
        approve,
      );
      if (approve) write("hosted-mcp-resume.invoke1", invoke1);
      write(`hosted-mcp-resume-${approve ? "approve" : "reject"}.invoke2`, invoke2);
    }
  }, 120_000);
});
