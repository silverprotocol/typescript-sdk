import { describe, it, expect } from "vitest";
import { AgEvent, fromJsonata } from "@silverprotocol/core";
import normalize, {
  mapFinishReason,
  ruleJsonata,
  type OpenAIStreamEvent,
} from "./index.js";

// ─── fixture builders (the verified @openai/agents stream-event shapes) ───────
// See index.ts `OpenAIStreamEvent` for the primary-source citations. Each builder
// constructs one event of the discriminated union the normalizer consumes.

function messageOutputCreated(text: string, id = "msg_fixture_1"): OpenAIStreamEvent {
  return {
    type: "run_item_stream_event",
    name: "message_output_created",
    item: {
      type: "message_output_item",
      rawItem: {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
        id,
      },
    },
  };
}

function toolCalled(
  name: string,
  argumentsJson: string,
  callId = "call_fixture_1",
  fcId = "fc_fixture_1",
): OpenAIStreamEvent {
  return {
    type: "run_item_stream_event",
    name: "tool_called",
    item: {
      type: "tool_call_item",
      rawItem: {
        type: "function_call",
        name,
        callId,
        arguments: argumentsJson,
        status: "completed",
        id: fcId,
      },
    },
  };
}

function toolOutput(callId = "call_fixture_1", output = "42"): OpenAIStreamEvent {
  return {
    type: "run_item_stream_event",
    name: "tool_output",
    item: {
      type: "tool_call_output_item",
      rawItem: {
        type: "function_call_result",
        name: "get_weather",
        callId,
        status: "completed",
        output: { type: "text", text: output },
      },
    },
  };
}

function reasoningItemCreated(
  rsId = "rs_fixture_1",
  encrypted = "gAAAAAB-cipher",
): OpenAIStreamEvent {
  return {
    type: "run_item_stream_event",
    name: "reasoning_item_created",
    item: {
      type: "reasoning_item",
      rawItem: {
        type: "reasoning",
        id: rsId,
        content: [{ type: "input_text", text: "let me think" }],
        providerData: { encrypted_content: encrypted },
      },
    },
  };
}

// Raw Responses streaming events. `RunRawModelStreamEvent.data` is the Agents SDK
// `ResponseStreamEvent` union; the verbatim openai-node Responses events ride in
// the generic `model` carrier's `event` (snake_case `item_id`/`arguments`/`delta`/
// `incomplete_details`). See index.ts for the primary-source citations.
function outputTextDelta(delta: string, itemId = "msg_fixture_1"): OpenAIStreamEvent {
  return {
    type: "raw_model_stream_event",
    data: { type: "model", event: { type: "response.output_text.delta", item_id: itemId, delta } },
  };
}
function argsDelta(delta: string, itemId = "fc_fixture_1"): OpenAIStreamEvent {
  return {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: { type: "response.function_call_arguments.delta", item_id: itemId, delta },
    },
  };
}
function argsDone(args: string, itemId = "fc_fixture_1"): OpenAIStreamEvent {
  return {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: { type: "response.function_call_arguments.done", item_id: itemId, arguments: args },
    },
  };
}
function responseCompleted(): OpenAIStreamEvent {
  return {
    type: "raw_model_stream_event",
    data: {
      type: "model",
      event: { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    },
  };
}
// The SDK-flattened `output_text_delta` literal (StreamEventTextStream).
function sdkTextDelta(delta: string): OpenAIStreamEvent {
  return { type: "raw_model_stream_event", data: { type: "output_text_delta", delta } };
}
// The SDK `response_done` terminator (StreamEventResponseCompleted).
function sdkResponseDone(): OpenAIStreamEvent {
  return { type: "raw_model_stream_event", data: { type: "response_done", response: { id: "resp_sdk" } } };
}

// Every produced event MUST round-trip through the AgEvent schema (spec §4).
function assertAllValid(evs: AgEvent[]): void {
  for (const ev of evs) {
    expect(() => AgEvent.parse(ev)).not.toThrow();
  }
}

describe("openaiNormalizer — message_output_created", () => {
  it("maps a message item to the text lifecycle", async () => {
    const evs = await normalize(messageOutputCreated("hello world"));
    expect(evs.map((e) => e.type)).toEqual(["text.start", "text.delta", "text.end"]);
    const delta = evs.find((e) => e.type === "text.delta");
    expect(delta).toMatchObject({ delta: "hello world" });
    assertAllValid(evs);
  });

  it("allocates a monotonic seq from 0", async () => {
    const evs = await normalize(messageOutputCreated("hi"));
    expect(evs.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("concatenates multiple output_text parts", async () => {
    const evs = await normalize({
      type: "run_item_stream_event",
      name: "message_output_created",
      item: {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "foo" },
            { type: "output_text", text: "bar" },
          ],
          id: "msg_2",
        },
      },
    });
    const delta = evs.find((e) => e.type === "text.delta");
    expect(delta).toMatchObject({ delta: "foobar" });
    assertAllValid(evs);
  });
});

describe("openaiNormalizer — tool_called", () => {
  it("emits tool.start, tool.args.delta and the mandatory tool.args.assembled", async () => {
    const evs = await normalize(toolCalled("get_weather", '{"city":"SF"}'));
    const types = evs.map((e) => e.type);
    expect(types).toEqual(["tool.start", "tool.args.delta", "tool.args.assembled"]);
    assertAllValid(evs);
  });

  it("carries call_id as toolCallId and the fc_ id as itemId (DISTINCT)", async () => {
    const evs = await normalize(toolCalled("get_weather", '{"city":"SF"}', "call_abc", "fc_xyz"));
    const start = evs.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ toolCallId: "call_abc", name: "get_weather", itemId: "fc_xyz" });
  });

  it("parses the JSON-STRING arguments into tool.args.assembled.input", async () => {
    const evs = await normalize(toolCalled("get_weather", '{"city":"SF","units":"c"}'));
    const assembled = evs.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "call_fixture_1", input: { city: "SF", units: "c" } });
    const delta = evs.find((e) => e.type === "tool.args.delta");
    expect(delta).toMatchObject({ delta: '{"city":"SF","units":"c"}' });
    assertAllValid(evs);
  });
});

describe("openaiNormalizer — function_call_arguments accumulation (spec §8.1)", () => {
  it("accumulates delta fragments per item id and assembles on .done", async () => {
    const n = normalize; // single normalizer instance carries the per-item buffer
    // The arg fragments accumulate; only .done assembles.
    expect(await n(argsDelta('{"ci', "fc_acc"))).toEqual([]);
    expect(await n(argsDelta('ty":"', "fc_acc"))).toEqual([]);
    expect(await n(argsDelta('SF"}', "fc_acc"))).toEqual([]);
    const done = await n(argsDone('{"city":"SF"}', "fc_acc"));
    const assembled = done.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ input: { city: "SF" } });
    assertAllValid(done);
  });

  it("falls back to the accumulated buffer when .done omits the full arguments", async () => {
    const n = normalize;
    expect(await n(argsDelta('{"a":', "fc_buf"))).toEqual([]);
    expect(await n(argsDelta("1}", "fc_buf"))).toEqual([]);
    const done = await n(argsDone("", "fc_buf"));
    const assembled = done.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ input: { a: 1 } });
    assertAllValid(done);
  });
});

describe("openaiNormalizer — output_text.delta streaming", () => {
  it("maps a raw output_text delta to text.delta", async () => {
    const evs = await normalize(outputTextDelta("chunk", "msg_x"));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "text.delta", id: "msg_x", delta: "chunk" });
    assertAllValid(evs);
  });
});

describe("openaiNormalizer — tool_output", () => {
  it("maps a tool_output to tool.done with content + ok outcome", async () => {
    const evs = await normalize(toolOutput("call_done_1", "42"));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "tool.done",
      toolCallId: "call_done_1",
      outcome: "ok",
      content: [{ type: "text", text: "42" }],
    });
    assertAllValid(evs);
  });
});

describe("openaiNormalizer — reasoning replay (rs_ + encrypted_content, spec §8.2/§10.4)", () => {
  it("emits reasoning.start with the rs_ itemId and reasoning.opaque ciphertext", async () => {
    const evs = await normalize(reasoningItemCreated("rs_abc", "gAAA-cipher"));
    const types = evs.map((e) => e.type);
    expect(types).toContain("reasoning.start");
    expect(types).toContain("reasoning.opaque");
    const start = evs.find((e) => e.type === "reasoning.start");
    expect(start).toMatchObject({ itemId: "rs_abc" });
    const opaque = evs.find((e) => e.type === "reasoning.opaque");
    expect(opaque).toMatchObject({
      kind: "ciphertext",
      value: "gAAA-cipher",
      itemId: "rs_abc",
      provider: "openai",
    });
    assertAllValid(evs);
  });

  it("emits a reasoning.delta carrying the visible reasoning text", async () => {
    const evs = await normalize(reasoningItemCreated());
    const delta = evs.find((e) => e.type === "reasoning.delta");
    expect(delta).toMatchObject({ delta: "let me think" });
    assertAllValid(evs);
  });

  it("omits reasoning.opaque when there is no encrypted_content", async () => {
    const evs = await normalize({
      type: "run_item_stream_event",
      name: "reasoning_item_created",
      item: {
        type: "reasoning_item",
        rawItem: { type: "reasoning", id: "rs_noenc", content: [] },
      },
    });
    expect(evs.map((e) => e.type)).not.toContain("reasoning.opaque");
    assertAllValid(evs);
  });
});

describe("openaiNormalizer — response.completed → turn.done", () => {
  it("synthesizes turn.done with success + finishReason stop", async () => {
    const evs = await normalize(responseCompleted());
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "turn.done",
      outcome: { type: "success" },
      finishReason: "stop",
    });
    assertAllValid(evs);
  });

  it("maps an incomplete max_output_tokens reason to token_limit (snake_case incomplete_details)", async () => {
    const evs = await normalize({
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "response.incomplete",
          response: {
            id: "resp_2",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      },
    });
    expect(evs[0]).toMatchObject({ type: "turn.done", finishReason: "token_limit" });
    assertAllValid(evs);
  });
});

describe("openaiNormalizer — SDK StreamEvent literals (output_text_delta / response_done)", () => {
  it("maps the SDK output_text_delta literal to text.delta", async () => {
    const evs = await normalize(sdkTextDelta("hi"));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "text.delta", delta: "hi" });
    assertAllValid(evs);
  });

  it("maps the SDK response_done terminator to turn.done (stop)", async () => {
    const evs = await normalize(sdkResponseDone());
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "turn.done",
      turnId: "turn_resp_sdk",
      outcome: { type: "success" },
      finishReason: "stop",
    });
    assertAllValid(evs);
  });

  it("emits nothing for the SDK response_started opener", async () => {
    const evs = await normalize({ type: "raw_model_stream_event", data: { type: "response_started" } });
    expect(evs).toEqual([]);
  });
});

describe("openaiNormalizer — call_id↔fc_ correlation on the raw .done path (spec §2)", () => {
  it("recovers the real call_id (buffered by the tool_called run-item) as toolCallId", async () => {
    const n = normalize;
    // The run-item leg fires first, carrying BOTH call_id and the fc_ item id —
    // it records the correlation (and carries the fc_ itemId on tool.start).
    const called = await n(toolCalled("get_weather", '{"city":"SF"}', "call_real", "fc_corr"));
    const start = called.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ toolCallId: "call_real", itemId: "fc_corr" });
    // A later raw .done keyed by the SAME fc_ id must resolve to the real call_id.
    const done = await n(argsDone('{"city":"NYC"}', "fc_corr"));
    const assembled = done.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "call_real", input: { city: "NYC" } });
    assertAllValid(done);
  });

  it("falls back to the fc_ id as toolCallId when no run-item correlated it", async () => {
    // No preceding tool_called for this fc_ id → fc_ id is the fallback toolCallId.
    const done = await normalize(argsDone('{"a":1}', "fc_uncorrelated"));
    const assembled = done.find((e) => e.type === "tool.args.assembled");
    expect(assembled).toMatchObject({ toolCallId: "fc_uncorrelated", input: { a: 1 } });
    assertAllValid(done);
  });
});

describe("mapFinishReason", () => {
  it("maps the OpenAI finish/incomplete reasons to the AgFinishReason superset", () => {
    expect(mapFinishReason(undefined)).toBe("stop");
    expect(mapFinishReason("max_output_tokens")).toBe("token_limit");
    expect(mapFinishReason("content_filter")).toBe("safety_blocked");
    expect(mapFinishReason("max_tokens")).toBe("token_limit");
    expect(mapFinishReason("something_else")).toBe("unknown");
  });
});

// ─── EXTENDED B2 tests ───────────────────────────────────────────────────────

// (a) Usage mapping: response.completed.usage → turn.done.usage
describe("openaiNormalizer — usage (response.completed.usage → turn.done.usage)", () => {
  it("maps response.completed with usage to turn.done.usage (cumulative:false)", async () => {
    const evs = await normalize({
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "response.completed",
          response: {
            id: "resp_usage_1",
            status: "completed",
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              total_tokens: 150,
              input_tokens_details: { cached_tokens: 20 },
              output_tokens_details: { reasoning_tokens: 10 },
            },
          },
        },
      },
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "turn.done",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 20,
        reasoningTokens: 10,
        cumulative: false,
      },
    });
    assertAllValid(evs);
  });

  it("maps SDK response_done with usage to turn.done.usage (cumulative:false)", async () => {
    const evs = await normalize({
      type: "raw_model_stream_event",
      data: {
        type: "response_done",
        response: {
          id: "resp_sdk_usage",
          usage: {
            input_tokens: 80,
            output_tokens: 40,
            total_tokens: 120,
          },
        },
      },
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "turn.done",
      usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120, cumulative: false },
    });
    assertAllValid(evs);
  });
});

// (b) response.failed + top-level error → turn.error
describe("openaiNormalizer — response.failed / top-level error → turn.error", () => {
  it("maps run_item response.failed to turn.error", async () => {
    const evs = await normalize({
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "response.failed",
          response: {
            id: "resp_fail_1",
            error: { message: "Rate limit exceeded", code: "rate_limit_exceeded" },
          },
        },
      },
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "turn.error",
      message: "Rate limit exceeded",
      code: "rate_limit_exceeded",
    });
    assertAllValid(evs);
  });

  it("maps a top-level error stream event to a non-terminal error event", async () => {
    const evs = await normalize({
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "error",
          message: "Server error",
          code: "server_error",
        },
      },
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "error",
      message: "Server error",
      code: "server_error",
    });
    assertAllValid(evs);
  });
});

// (c) incomplete_details.reason==="content_filter" → safety + non-success outcome
describe("openaiNormalizer — content_filter → safety + non-success outcome", () => {
  it("maps content_filter incomplete to safety_blocked finishReason + safety[] + error outcome", async () => {
    const evs = await normalize({
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "response.incomplete",
          response: {
            id: "resp_cf_1",
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
          },
        },
      },
    });
    expect(evs).toHaveLength(1);
    const done = evs[0];
    expect(done).toMatchObject({
      type: "turn.done",
      finishReason: "safety_blocked",
    });
    expect(done).toMatchObject({
      outcome: { type: "error" },
    });
    expect(done).toMatchObject({
      safety: [{ category: "content_filter", blocked: true }],
    });
    assertAllValid(evs);
  });
});

// (d) url_citation annotations → AgCitation on text block
describe("openaiNormalizer — url_citation annotations → AgCitation on text block", () => {
  it("maps url_citation annotations to citations[] on the content.block text block", async () => {
    const evs = await normalize({
      type: "run_item_stream_event",
      name: "message_output_created",
      item: {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Paris is the capital of France.",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.com/france",
                  title: "France Wikipedia",
                  start_index: 0,
                  end_index: 30,
                },
              ],
            },
          ],
          id: "msg_cit_1",
        },
      },
    });
    // Should emit content.block with citations (not just text.start/delta/end)
    const block = evs.find((e) => e.type === "content.block");
    expect(block).toBeDefined();
    expect(block).toMatchObject({
      type: "content.block",
      block: {
        type: "text",
        text: "Paris is the capital of France.",
        citations: [
          {
            kind: "url",
            url: "https://example.com/france",
            title: "France Wikipedia",
            // citedText extracted via text.slice(0, 30) = "Paris is the capital of France" (Fix 3)
            citedText: "Paris is the capital of France",
            startIndex: 0,
            endIndex: 30,
            indexFrame: "response",
          },
        ],
      },
    });
    assertAllValid(evs);
  });

  it("does NOT emit content.block when there are no annotations (preserves existing text lifecycle)", async () => {
    const evs = await normalize(messageOutputCreated("hello"));
    expect(evs.find((e) => e.type === "content.block")).toBeUndefined();
    expect(evs.map((e) => e.type)).toEqual(["text.start", "text.delta", "text.end"]);
    assertAllValid(evs);
  });
});

// (d) Refusal part → refusal text + finishReason:"refusal"
describe("openaiNormalizer — Refusal content part → refusal text + finishReason", () => {
  it("emits text lifecycle with refusal text AND turn.done finishReason:refusal on response.completed", async () => {
    // Step 1: message_output_created with a refusal part — emits text lifecycle.
    const msgEvs = await normalize({
      type: "run_item_stream_event",
      name: "message_output_created",
      item: {
        type: "message_output_item",
        rawItem: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "refusal", refusal: "I cannot help with that." },
          ],
          id: "msg_refusal_2",
        },
      },
    });
    const delta = msgEvs.find((e) => e.type === "text.delta");
    expect(delta).toBeDefined();
    expect(delta).toMatchObject({ delta: "I cannot help with that." });
    assertAllValid(msgEvs);

    // Step 2: response.completed for the same response — turn.done MUST carry finishReason:"refusal".
    const completedEvs = await normalize({
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: { type: "response.completed", response: { id: "resp_refusal_2", status: "completed" } },
      },
    });
    expect(completedEvs).toHaveLength(1);
    expect(completedEvs[0]).toMatchObject({
      type: "turn.done",
      finishReason: "refusal",
    });
    assertAllValid(completedEvs);
  });
});

// (e) tool_output with rawItem.status==="incomplete" → outcome:"error"
describe("openaiNormalizer — tool_output incomplete status → outcome:'error'", () => {
  it("maps a tool_output with status='incomplete' to tool.done outcome:'error'", async () => {
    const evs = await normalize({
      type: "run_item_stream_event",
      name: "tool_output",
      item: {
        type: "tool_call_output_item",
        rawItem: {
          type: "function_call_result",
          name: "get_weather",
          callId: "call_err_1",
          status: "incomplete",
          output: "timeout",
        },
      },
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "tool.done",
      toolCallId: "call_err_1",
      outcome: "error",
    });
    assertAllValid(evs);
  });

  it("maps a tool_output with status='completed' to tool.done outcome:'ok'", async () => {
    const evs = await normalize(toolOutput("call_ok_1", "result"));
    expect(evs[0]).toMatchObject({ type: "tool.done", outcome: "ok" });
    assertAllValid(evs);
  });
});

// (f) handoff_requested → handoff + subagent.start
describe("openaiNormalizer — handoff_requested → handoff + subagent.start", () => {
  it("maps handoff_requested to a handoff{kind:'transfer'} + subagent.start", async () => {
    const evs = await normalize({
      type: "run_item_stream_event",
      name: "handoff_requested",
      item: {
        type: "handoff_call_item",
        rawItem: {
          type: "function_call",
          name: "transfer_to_billing_agent",
          callId: "call_handoff_1",
          arguments: "{}",
          targetAgent: "billing_agent",
        },
      },
    });
    const handoffEv = evs.find((e) => e.type === "handoff");
    expect(handoffEv).toBeDefined();
    expect(handoffEv).toMatchObject({ type: "handoff", kind: "transfer", toAgentName: "billing_agent" });
    const subagentEv = evs.find((e) => e.type === "subagent.start");
    expect(subagentEv).toBeDefined();
    assertAllValid(evs);
  });
});

// (f) tool_approval_requested → hitl.ask + paused outcome
describe("openaiNormalizer — tool_approval_requested → hitl.ask + turn.done paused", () => {
  it("maps tool_approval_requested to hitl.ask{kind:'approval'} AND turn.done{outcome:{type:'paused'}}", async () => {
    const evs = await normalize({
      type: "run_item_stream_event",
      name: "tool_approval_requested",
      item: {
        type: "tool_approval_item",
        rawItem: {
          type: "function_call",
          name: "delete_file",
          callId: "call_approval_1",
          arguments: '{"path":"/etc/hosts"}',
        },
      },
    });
    const askEv = evs.find((e) => e.type === "hitl.ask");
    expect(askEv).toBeDefined();
    expect(askEv).toMatchObject({
      type: "hitl.ask",
      kind: "approval",
      toolCallId: "call_approval_1",
    });
    const doneEv = evs.find((e) => e.type === "turn.done");
    expect(doneEv).toBeDefined();
    expect(doneEv).toMatchObject({
      type: "turn.done",
      outcome: { type: "paused" },
      finishReason: "paused",
    });
    assertAllValid(evs);
  });
});

// provider-raw fallback in both defaults
describe("openaiNormalizer — provider-raw fallback (unhandled events are NOT silently lost)", () => {
  it("emits a content.block provider-raw for an unknown run_item_stream_event name", async () => {
    const evs = await normalize({
      type: "run_item_stream_event",
      name: "tool_search_output_created" as "tool_output", // force unknown name through type system
      item: {
        type: "tool_call_output_item" as "tool_call_output_item",
        rawItem: {
          type: "function_call_result" as "function_call_result",
          name: "web_search",
          callId: "call_search_1",
          status: "completed",
          output: "search results",
        },
      },
    });
    const rawBlock = evs.find((e) => e.type === "content.block");
    expect(rawBlock).toBeDefined();
    expect(rawBlock).toMatchObject({
      type: "content.block",
      block: { type: "provider-raw", vendor: "openai" },
    });
    assertAllValid(evs);
  });

  it("emits a content.block provider-raw for an unknown raw_model_stream_event data type", async () => {
    const evs = await normalize({
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "response.output_item.added" as "response.completed",
          response: { id: "resp_unknown", status: "completed" },
        },
      },
    });
    const rawBlock = evs.find((e) => e.type === "content.block");
    expect(rawBlock).toBeDefined();
    expect(rawBlock).toMatchObject({
      type: "content.block",
      block: { type: "provider-raw", vendor: "openai" },
    });
    assertAllValid(evs);
  });
});

// ─── the portable JSONata rule (structural subset) ───────────────────────────
describe("rule.jsonata — portable structural subset", () => {
  it("maps the message-output structural subset the same as the TS normalizer", async () => {
    const run = fromJsonata(ruleJsonata);
    const evs = await run(messageOutputCreated("hello"));
    expect(evs.map((e) => e.type)).toEqual(["text.start", "text.delta", "text.end"]);
    expect(evs.map((e) => e.seq)).toEqual([0, 1, 2]);
    const delta = evs.find((e) => e.type === "text.delta");
    expect(delta).toMatchObject({ delta: "hello" });
    assertAllValid(evs);
  });

  it("maps the tool.start + tool.args.delta structural subset (the JSON-string arg-parse for tool.args.assembled stays in TS)", async () => {
    const run = fromJsonata(ruleJsonata);
    const evs = await run(toolCalled("get_weather", '{"city":"SF"}', "call_j", "fc_j"));
    // JSONata has no JSON parser, so the rule covers ONLY the parse-free structural
    // backbone (tool.start carrying call_id + the fc_ itemId, + the raw-string
    // tool.args.delta). The mandatory parsed tool.args.assembled is authoritative
    // in the TS normalizer (exactly as the Claude sibling leaves tool_use to TS).
    expect(evs.map((e) => e.type)).toEqual(["tool.start", "tool.args.delta"]);
    const start = evs.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ toolCallId: "call_j", name: "get_weather", itemId: "fc_j" });
    const delta = evs.find((e) => e.type === "tool.args.delta");
    expect(delta).toMatchObject({ toolCallId: "call_j", delta: '{"city":"SF"}' });
    assertAllValid(evs);
  });
});
