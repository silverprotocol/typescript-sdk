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
 *  - hosted-mcp-onapproval-reject: one hosted-MCP approval request rejected in
 *    the same invoke by an onApproval callback with a reason, then a second
 *    response with text only.
 *  - hosted-mcp-resume.invoke1: one hosted-MCP approval request; the run is
 *    interrupted. hosted-mcp-resume-approve.invoke2 and
 *    hosted-mcp-resume-reject.invoke2 resume that run from its RunState with
 *    the request approved (the model then returns the mcp_call and text) or
 *    rejected (text only).
 *  - hosted-mcp-sticky-approve.invoke1/2 and hosted-mcp-sticky-reject.invoke1/2:
 *    one hosted-MCP approval request answered on resume with a decision kept
 *    for the tool (alwaysApprove, or alwaysReject with a message); the resumed
 *    model then asks again for the same server tool, which the kept decision
 *    answers in the same invoke, then a text response.
 *  - function-partial-resume.invoke1/2: two function calls that need approval;
 *    invoke 2 approves only the first (the run interrupts again for the
 *    second).
 *  - hosted-mcp-partial-resume.invoke1..3: two hosted-MCP approval requests;
 *    invoke 2 resumes with only the first approved (the run interrupts again
 *    for the second), and invoke 3 resumes with the second rejected, then a
 *    response with the approved mcp_call and text.
 *  - computer-safety-ack, computer-safety-reject: a computer_call carrying a
 *    pending safety check, answered by computerTool's onSafetyCheck: true (the
 *    action runs and the result acknowledges the check) or false (the SDK
 *    refuses the action), then a second response with text.
 *  - computer-approval-reject.invoke1/2: a computer_call behind needsApproval;
 *    the run is interrupted, and invoke 2 resumes it with the call rejected.
 *  - computer-abort: SYNTHETIC. The ack run's first round, then the tool output
 *    agents-core writes for a computer call that cancellation cut short (its
 *    fallback-screenshot abort result). A cancelled streamed run ends after
 *    tool_called and streams no output item, so this shape is assembled from
 *    the SDK's own constant and its public RunToolCallOutputItem.
 *
 * Regenerate (never part of the gate):
 *   GEN_OPENAI_HOSTED=1 npx vitest run --config ../../vitest.config.ts src/openai-hosted-fixtures.gen.test.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, run, computerTool, hostedMcpTool, webSearchTool, shellTool, setTracingDisabled, tool, RunToolCallOutputItem } from "@openai/agents";
import { z } from "zod";
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
const sha16 = (events: JsonValue[]) => createHash("sha256").update(JSON.stringify(events, null, 2) + "\n").digest("hex").slice(0, 16);

/** agents-core's computer abort result, read from the installed SDK: the
 *  COMPUTER_FALLBACK_SCREENSHOT_DATA_URL constant and buildComputerAbortResult
 *  (dist/runner/streamReconciliation.mjs :4 and :18-28 at 0.20.0), which
 *  toolExecution.mjs :1783-1786 wraps as RunToolCallOutputItem(raw, agent, "aborted").
 *  Neither is exported, so the constant is read from the file, and generation fails
 *  if the builder's shape is not the one copied here. */
function computerAbortResult(callId: string): Obj {
  const core = createRequire(createRequire(import.meta.url).resolve("@openai/agents")).resolve("@openai/agents-core");
  const src = readFileSync(join(dirname(core), "runner", "streamReconciliation.mjs"), "utf8");
  const url = /COMPUTER_FALLBACK_SCREENSHOT_DATA_URL = '([^']+)'/.exec(src)?.[1];
  const builder = /export function buildComputerAbortResult\(toolCall\) \{([\s\S]*?)\n\}/.exec(src)?.[1]?.replace(/\s+/g, " ").trim();
  const expected = "return { type: 'computer_call_result', callId: toolCall.callId, output: { type: 'computer_screenshot', data: COMPUTER_FALLBACK_SCREENSHOT_DATA_URL, }, providerData: { status: 'incomplete' }, };";
  if (!url || builder !== expected) throw new Error(`agents-core's computer abort result moved: ${builder ?? "not found"}`);
  return { type: "computer_call_result", callId, output: { type: "computer_screenshot", data: url }, providerData: { status: "incomplete" } };
}

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
    const gated = (onApproval?: () => Promise<{ approve: boolean; reason?: string }>) =>
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

    write(
      "hosted-mcp-onapproval-reject",
      await natives(
        new Agent({
          name: "F",
          model: scriptedModel([approvalRound("resp_f1", ["mcpr_1"]), answerRound("resp_f2", [], "declined")]) as never,
          tools: [gated(async () => ({ approve: false, reason: "not this server" }))],
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

    {
      const calls = ["call_1", "call_2"].map((callId, k) => ({ type: "function_call", id: `fc_${k + 1}`, call_id: callId, name: "lookup", arguments: "{}", status: "completed" }));
      const fnRound = fakeModel("resp_f1", calls, calls.map((c) => ({ type: "function_call", id: c.id, callId: c.call_id, name: c.name, arguments: c.arguments, status: "completed" })));
      const lookup = tool({ name: "lookup", description: "Look up.", parameters: z.object({}), needsApproval: true, execute: async () => "found" });
      const agent = new Agent({ name: "F", model: scriptedModel([fnRound, answerRound("resp_f2", [], "ok")]) as never, tools: [lookup] });
      const first = await run(agent, "hi", { stream: true });
      const invoke1 = await drain(first);
      first.state.approve(first.interruptions[0]!);
      const invoke2 = await drain(await run(agent, first.state, { stream: true }));
      write("function-partial-resume.invoke1", invoke1);
      write("function-partial-resume.invoke2", invoke2);
    }

    for (const decision of ["approve", "reject"] as const) {
      const agent = new Agent({
        name: decision === "approve" ? "S" : "T",
        model: scriptedModel([approvalRound("resp_s1", ["mcpr_1"]), approvalRound("resp_s2", ["mcpr_2"]), answerRound("resp_s3", [], "done")]) as never,
        tools: [gated()],
      });
      const first = await run(agent, "hi", { stream: true });
      const invoke1 = await drain(first);
      const s1 = first.state;
      if (decision === "approve") s1.approve(first.interruptions[0]!, { alwaysApprove: true });
      else s1.reject(first.interruptions[0]!, { alwaysReject: true, message: "not this server" });
      const invoke2 = await drain(await run(agent, s1, { stream: true }));
      write(`hosted-mcp-sticky-${decision}.invoke1`, invoke1);
      write(`hosted-mcp-sticky-${decision}.invoke2`, invoke2);
    }

    {
      const agent = new Agent({
        name: "G",
        model: scriptedModel([approvalRound("resp_g1", ["mcpr_1", "mcpr_2"]), answerRound("resp_g2", [{ id: "mcp_1", q: "a" }], "done")]) as never,
        tools: [gated()],
      });
      const first = await run(agent, "hi", { stream: true });
      const invoke1 = await drain(first);
      const s1 = first.state;
      s1.approve(first.interruptions[0]!);
      const second = await run(agent, s1, { stream: true });
      const invoke2 = await drain(second);
      const s2 = second.state;
      for (const item of second.interruptions) s2.reject(item);
      const invoke3 = await drain(await run(agent, s2, { stream: true }));
      write("hosted-mcp-partial-resume.invoke1", invoke1);
      write("hosted-mcp-partial-resume.invoke2", invoke2);
      write("hosted-mcp-partial-resume.invoke3", invoke3);
    }
  }, 120_000);

  it("writes the computer-tool fixtures: safety check acknowledged or refused, approval rejected on resume, and the abort result", async () => {
    // One computer_call with a pending safety check, then a text response. The
    // same script was also run at agents-core 0.18.0 and 0.19.0; its natives are
    // pinned below by sha256 (first 16 hex digits).
    const call = { type: "computer_call", id: "cu_1", call_id: "call_cu_1", status: "completed", action: { type: "click", x: 1, y: 2, button: "left" }, pending_safety_checks: [{ id: "sc_1", code: "malicious_instructions", message: "check" }] };
    const callItem = { type: "computer_call", id: "cu_1", callId: "call_cu_1", status: "completed", action: { type: "click", x: 1, y: 2, button: "left" }, providerData: { pending_safety_checks: call.pending_safety_checks } };
    const m2 = { type: "message", id: "msg_r2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
    const computer = { environment: "browser", dimensions: [10, 10], screenshot: async () => "iVBORw0KGgo=", click: async () => {}, doubleClick: async () => {}, scroll: async () => {}, type: async () => {}, wait: async () => {}, move: async () => {}, keypress: async () => {}, drag: async () => {} };
    const model = () => scriptedModel([fakeModel("resp_r1", [call], [callItem]), fakeModel("resp_r2", [m2], [{ type: "message", id: m2.id, role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }], "ok")]) as never;

    // Acknowledged: the action runs. At 0.18.0 the onSafetyCheck-false run
    // below also ran the action (72a6983d762586bf); this run differs from that
    // one only by the result's rawItem.providerData.acknowledgedSafetyChecks.
    const ack = await natives(new Agent({ name: "C", model: model(), tools: [computerTool({ computer: computer as never, onSafetyCheck: async () => true })] }));
    expect(sha16(ack)).toBe("6322550669d66f8e");
    write("computer-safety-ack", ack);

    // Refused: from 0.19.0 on, onSafetyCheck false refuses the action.
    const reject = await natives(new Agent({ name: "C", model: model(), tools: [computerTool({ computer: computer as never, onSafetyCheck: async () => false })] }));
    expect(sha16(reject)).toBe("2bcaf718ed787344"); // the 0.19.0 run, == the 0.20.0 run
    write("computer-safety-reject", reject);

    // Behind needsApproval, rejected on resume. The pinned native is both
    // invokes joined by {sep:"invoke2"}; the fixtures are the two halves.
    {
      const agent = new Agent({ name: "C", model: model(), tools: [computerTool({ computer: computer as never, needsApproval: true } as never)] });
      const first = await run(agent, "hi", { stream: true });
      const invoke1 = await drain(first);
      for (const item of first.interruptions) first.state.reject(item);
      const invoke2 = await drain(await run(agent, first.state, { stream: true }));
      expect(sha16([...invoke1, { sep: "invoke2" }, ...invoke2])).toBe("c0343a7ca196d6b1"); // the 0.18.0 run, == the 0.19.0 run
      write("computer-approval-reject.invoke1", invoke1);
      write("computer-approval-reject.invoke2", invoke2);
    }

    // Synthetic abort: the ack run through tool_called, then agents-core's abort result.
    const cut = ack.findIndex((e) => (e as Obj)["type"] === "run_item_stream_event" && (e as Obj)["name"] === "tool_called");
    const aborted = new RunToolCallOutputItem(computerAbortResult("call_cu_1") as never, new Agent({ name: "C" }), "aborted");
    write("computer-abort", [...ack.slice(0, cut + 1), JSON.parse(JSON.stringify({ name: "tool_output", item: aborted, type: "run_item_stream_event" })) as JsonValue]);
  }, 120_000);
});
