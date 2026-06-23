import { describe, it, expect } from "vitest";
import {
  AgEvent,
  AgBlock,
  AgOutcome,
  AgArtifact,
  AgTurnRecord,
  AgReduceResult,
  AgCapabilities,
  AgClientCapabilities,
  AgInput,
  AgInputEnvelope,
  AgMessage,
  AgReasoningConfig,
  AgToolDef,
  AgRunConfig,
  AgSurfaceEnvelope,
  AgSurfaceInteraction,
  AgA2uiSurfaceAction,
  AgA2uiFunctionResponse,
  AgA2uiError,
  AgMcpAppViewMessage,
  AgOpenAiWidgetAction,
  REMOVE_ALL,
  AgMemoryRecord,
  AgUsage,
} from "./agjson.js";

describe("AgEvent (CORE)", () => {
  it("parses each CORE event variant", () => {
    const samples = [
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "turn.done", seq: 9, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
      { type: "turn.error", seq: 1, message: "boom" },
      { type: "turn.abort", seq: 1 },
      { type: "error", seq: 1, message: "advisory" },
      { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
      { type: "text.start", seq: 2, id: "m1" },
      { type: "text.delta", seq: 3, id: "m1", delta: "hi" },
      { type: "text.end", seq: 4, id: "m1" },
      { type: "message.end", seq: 5, id: "m1" },
      { type: "content.block", seq: 6, block: { type: "text", text: "x" } },
      { type: "tool.start", seq: 7, toolCallId: "c1", name: "search" },
      { type: "tool.args.delta", seq: 8, toolCallId: "c1", delta: '{"q":' },
      { type: "tool.args.assembled", seq: 9, toolCallId: "c1", input: { q: "ok" } },
      {
        type: "tool.done",
        seq: 10,
        toolCallId: "c1",
        content: [{ type: "text", text: "ok" }],
        outcome: "ok",
      },
    ];
    for (const s of samples) expect(AgEvent.parse(s).type).toBe(s.type);
  });

  it("rejects an unknown event type", () => {
    expect(() => AgEvent.parse({ type: "nope", seq: 0 })).toThrow();
  });
});

describe("AgBlock (CORE subset)", () => {
  it("parses text / image / tool-call / tool-result", () => {
    expect(AgBlock.parse({ type: "text", text: "x" }).type).toBe("text");
    expect(
      AgBlock.parse({ type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } }).type,
    ).toBe("image");
    expect(AgBlock.parse({ type: "tool-call", toolCallId: "c1", name: "n", input: {} }).type).toBe(
      "tool-call",
    );
    expect(
      AgBlock.parse({ type: "tool-result", toolCallId: "c1", content: [], outcome: "ok" }).type,
    ).toBe("tool-result");
  });

  it("round-trips a nested tool-result (recursive content)", () => {
    const r = AgBlock.parse({
      type: "tool-result",
      toolCallId: "c1",
      content: [{ type: "text", text: "inner" }],
    });
    expect(r.type).toBe("tool-result");
  });

  it("rejects an unknown block type", () => {
    expect(() => AgBlock.parse({ type: "not-a-block", foo: "x" })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EXTENDED profile (spec §9). Adds reasoning.*, step.*, subagent.*, source,
// handoff, prompt.blocked, hitl.ask events; reasoning / compaction /
// search-result / code / code-result / document / file / audio / data /
// provider-raw / resource / resource-link blocks; citations + usage + safety +
// paused outcome.
// ─────────────────────────────────────────────────────────────────────────────

describe("AgEvent (EXTENDED)", () => {
  it("parses each EXTENDED event variant", () => {
    const samples = [
      { type: "reasoning.start", seq: 1, id: "r1", mode: "summarized" },
      { type: "reasoning.delta", seq: 2, id: "r1", delta: "thinking" },
      { type: "reasoning.end", seq: 3, id: "r1", provider: "anthropic" },
      {
        type: "reasoning.opaque",
        seq: 4,
        id: "r1",
        kind: "signature",
        value: "sig-blob",
        provider: "anthropic",
        itemId: "rs_1",
      },
      { type: "reasoning.opaque.delta", seq: 5, id: "r1", delta: "sigfrag" },
      { type: "step.start", seq: 6, id: "s1", stepName: "plan", turnId: "t1" },
      {
        type: "step.done",
        seq: 7,
        id: "s1",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
      { type: "subagent.start", seq: 8, turnId: "t2", parentTurnId: "t1", agentName: "helper" },
      { type: "subagent.done", seq: 9, turnId: "t2", parentTurnId: "t1" },
      {
        type: "source",
        seq: 10,
        sourceId: "src1",
        source: { url: "https://example.com", title: "Ex" },
        chunkIndex: 0,
      },
      { type: "handoff", seq: 11, kind: "transfer", fromAgentId: "a1", toAgentId: "a2" },
      { type: "prompt.blocked", seq: 12, reason: "safety", safety: [{ category: "hate" }] },
    ];
    for (const s of samples) expect(AgEvent.parse(s).type).toBe(s.type);
  });

  it("accepts the reasoning.opaque kind enum + replay target", () => {
    for (const kind of ["signature", "ciphertext", "encrypted", "redacted"]) {
      const ev = AgEvent.parse({ type: "reasoning.opaque", seq: 0, id: "r1", kind, value: "v" });
      expect(ev.type).toBe("reasoning.opaque");
    }
  });

  it("accepts every hitl.ask kind enum value", () => {
    for (const kind of ["approval", "form", "text", "choice", "auth", "url"]) {
      const ev = AgEvent.parse({ type: "hitl.ask", seq: 0, askId: "ask1", kind });
      expect(ev.type).toBe("hitl.ask");
    }
  });

  it("round-trips a fully-populated hitl.ask (choices / authConfig / MRTR)", () => {
    const ev = AgEvent.parse({
      type: "hitl.ask",
      seq: 0,
      askId: "ask1",
      kind: "choice",
      message: "pick one",
      choices: [
        { id: "a", label: "A", value: 1 },
        { id: "b", label: "B" },
      ],
      authConfig: { scheme: "oauth2", scopes: ["read"], authorizationUrl: "https://auth" },
      toolCallId: "c1",
      continuation: "resume",
      reason: "needs input",
      metadata: { foo: "bar" },
      requestState: "blob",
      inputKey: "k1",
      resumeBinding: "positional",
      ordinal: 0,
      token: "tok",
      expiresAt: "2026-01-01",
    });
    expect(ev.type).toBe("hitl.ask");
  });

  it("accepts usage on turn.done and step.done; safety on turn.done", () => {
    const td = AgEvent.parse({
      type: "turn.done",
      seq: 0,
      turnId: "t1",
      outcome: { type: "success" },
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, cumulative: true },
      safety: [{ category: "violence", score: 0.1, blocked: false }],
    });
    expect(td.type).toBe("turn.done");
  });

  it("rejects an unknown hitl.ask kind", () => {
    expect(() => AgEvent.parse({ type: "hitl.ask", seq: 0, askId: "a", kind: "nope" })).toThrow();
  });
});

describe("AgBlock (EXTENDED)", () => {
  it("parses each EXTENDED block variant", () => {
    const samples = [
      {
        type: "reasoning",
        text: "let me think",
        opaque: { kind: "signature", value: "sig" },
        provider: "anthropic",
        itemId: "rs_1",
      },
      { type: "compaction", text: "summary", opaque: { kind: "ciphertext", value: "blob" } },
      {
        type: "search-result",
        url: "https://e.com",
        title: "E",
        opaque: { kind: "ciphertext", value: "enc" },
        pageAge: "1d",
      },
      { type: "code", language: "python", code: "print(1)" },
      { type: "code-result", outcome: "ok", output: "1\n" },
      { type: "document", source: { type: "url", url: "https://e.com/d.pdf" }, title: "Doc" },
      {
        type: "file",
        source: { type: "base64", mediaType: "video/mp4", data: "AAAA" },
        filename: "clip.mp4",
      },
      { type: "audio", source: { type: "base64", mediaType: "audio/mp3", data: "AAAA" } },
      { type: "data", name: "status", id: "d1", data: { progress: 50 }, transient: true },
      { type: "provider-raw", vendor: "openai", raw: { item: "raw" } },
      {
        type: "resource",
        resource: { uri: "ui://surface/1", mimeType: "text/html;profile=mcp-app" },
      },
      { type: "resource-link", uri: "https://e.com/x", mimeType: "application/pdf" },
    ];
    for (const s of samples) {
      const parsed = AgBlock.parse(s);
      expect(parsed.type).toBe(s.type);
    }
  });

  it("accepts citations + annotations + providerMetadata on a text block", () => {
    const b = AgBlock.parse({
      type: "text",
      text: "grounded",
      citations: [
        {
          kind: "char",
          citedText: "hi",
          documentIndex: 0,
          startCharIndex: 0,
          endCharIndex: 2,
          unit: "byte",
        },
        {
          kind: "offset",
          citedText: "yo",
          startIndex: 0,
          endIndex: 2,
          sourceIds: ["src1"],
          unit: "byte",
          bounds: "[start,end)",
        },
        { kind: "url", citedText: "u", url: "https://e.com" },
      ],
      providerMetadata: { anthropic: { signature: "s" } },
      annotations: { audience: ["assistant"], priority: 1, lastModified: "2026-01-01" },
    });
    expect(b.type).toBe("text");
  });

  it("nests EXTENDED blocks inside tool-result content (recursion preserved)", () => {
    const r = AgBlock.parse({
      type: "tool-result",
      toolCallId: "c1",
      content: [
        { type: "reasoning", text: "inner reasoning" },
        { type: "code", language: "ts", code: "x" },
      ],
      outcome: "ok",
    });
    expect(r.type).toBe("tool-result");
  });

  it("accepts the reasoning block opaque kind enum", () => {
    for (const kind of ["signature", "ciphertext", "encrypted", "redacted"]) {
      const b = AgBlock.parse({ type: "reasoning", opaque: { kind, value: "v" } });
      expect(b.type).toBe("reasoning");
    }
  });

  it("accepts the code-result outcome enum", () => {
    for (const outcome of ["ok", "failed", "deadline_exceeded"]) {
      const b = AgBlock.parse({ type: "code-result", outcome, output: "x" });
      expect(b.type).toBe("code-result");
    }
  });
});

describe("AgOutcome (EXTENDED paused arm)", () => {
  it("parses a paused outcome carrying asks[]", () => {
    const o = AgOutcome.parse({
      type: "paused",
      asks: [
        { askId: "ask1", kind: "approval", message: "ok?" },
        { askId: "ask2", kind: "auth", authConfig: { scheme: "oauth2" } },
      ],
      result: { partial: true },
    });
    expect(o.type).toBe("paused");
  });

  it("round-trips a paused turn.done", () => {
    const ev = AgEvent.parse({
      type: "turn.done",
      seq: 0,
      turnId: "t1",
      outcome: { type: "paused", asks: [{ askId: "a1", kind: "form", schema: { x: 1 } }] },
      finishReason: "paused",
    });
    expect(ev.type).toBe("turn.done");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIELD-COVERAGE round-trips (spec §2 / §4). These assert the replay-load-bearing
// spec fields survive .parse() — previously they were silently STRIPPED because
// the field was declared in SPEC.md but absent from the zod arm. `.parse()`
// returning the value verbatim proves the arm now carries the field.
// ─────────────────────────────────────────────────────────────────────────────

describe("AgBlock / AgEvent field coverage (spec §2 / §4)", () => {
  it("tool-call block preserves serverName / signature / itemId / providerCallIndex / providerMetadata + the rest", () => {
    const input = {
      type: "tool-call" as const,
      toolCallId: "call_1",
      name: "search",
      input: { q: "rain" },
      serverName: "web",
      providerExecuted: true,
      signature: "sig-abc",
      provider: "gemini",
      title: "Web Search",
      toolMetadata: { vercel: { x: 1 } },
      itemId: "fc_123",
      providerCallIndex: 2,
      uiVisibility: ["model", "app"] as ("model" | "app")[],
      providerMetadata: { gemini: { thoughtSignature: "ts" } },
    };
    const b = AgBlock.parse(input);
    expect(b).toMatchObject(input);
  });

  it("tool.start event preserves the streaming-tool fields", () => {
    const input = {
      type: "tool.start" as const,
      seq: 0,
      toolCallId: "call_1",
      name: "search",
      index: 1,
      dynamic: true,
      serverName: "web",
      providerExecuted: true,
      requiresApproval: true,
      title: "Web Search",
      toolMetadata: { vercel: { x: 1 } },
      uiVisibility: ["model"] as ("model" | "app")[],
      itemId: "fc_123",
      providerMetadata: { openai: { itemId: "fc_123" } },
    };
    const ev = AgEvent.parse(input);
    expect(ev).toMatchObject(input);
  });

  it("tool.args.assembled event preserves signature / title / toolMetadata / providerMetadata", () => {
    const input = {
      type: "tool.args.assembled" as const,
      seq: 1,
      toolCallId: "call_1",
      input: { q: "ok" },
      signature: "sig-xyz",
      title: "Web Search",
      toolMetadata: { vercel: { y: 2 } },
      providerMetadata: { gemini: { sig: "z" } },
    };
    const ev = AgEvent.parse(input);
    expect(ev).toMatchObject(input);
  });

  it("turn.done event preserves messageId / messageMetadata / taskState", () => {
    const input = {
      type: "turn.done" as const,
      seq: 2,
      turnId: "t1",
      outcome: { type: "success" as const },
      finishReason: "stop" as const,
      messageId: "m1",
      messageMetadata: { totalTokens: 42, model: "claude" },
      taskState: "submitted",
    };
    const ev = AgEvent.parse(input);
    expect(ev).toMatchObject(input);
  });

  it("text.start event preserves index / previousPartKind / providerMetadata", () => {
    const input = {
      type: "text.start" as const,
      seq: 3,
      id: "m1",
      index: 0,
      previousPartKind: "reasoning",
      providerMetadata: { anthropic: { k: "v" } },
    };
    const ev = AgEvent.parse(input);
    expect(ev).toMatchObject(input);
  });

  it("text.delta and text.end events preserve providerMetadata", () => {
    const d = AgEvent.parse({
      type: "text.delta",
      seq: 4,
      id: "m1",
      delta: "hi",
      providerMetadata: { anthropic: { k: "v" } },
    });
    expect(d).toMatchObject({ type: "text.delta", providerMetadata: { anthropic: { k: "v" } } });
    const e = AgEvent.parse({
      type: "text.end",
      seq: 5,
      id: "m1",
      providerMetadata: { anthropic: { k: "v" } },
    });
    expect(e).toMatchObject({ type: "text.end", providerMetadata: { anthropic: { k: "v" } } });
  });

  it("message.start event preserves extensions[]", () => {
    const input = {
      type: "message.start" as const,
      seq: 6,
      id: "m1",
      role: "assistant" as const,
      turnId: "t1",
      threadId: "th1",
      extensions: ["urn:a2a:ext:x", "urn:a2a:ext:y"],
    };
    const ev = AgEvent.parse(input);
    expect(ev).toMatchObject(input);
  });

  it("parses an open ext.<vendor>.<key> vendor-extension event with extra keys", () => {
    const ev = AgEvent.parse({ type: "ext.acme.foo", seq: 0, anything: 1, nested: { a: [1, 2] } });
    expect(ev).toMatchObject({ type: "ext.acme.foo", seq: 0, anything: 1, nested: { a: [1, 2] } });
  });

  it("rejects a bare unknown type that matches neither the closed union nor the ext regex", () => {
    expect(() => AgEvent.parse({ type: "nope", seq: 0 })).toThrow();
    expect(() => AgEvent.parse({ type: "ext.acme", seq: 0 })).toThrow(); // missing the .<key> segment
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVANCED profile (spec §9). Adds state.snapshot/delta, artifact.*,
// messages.snapshot, host.context, message.metadata, display.required,
// agent.capabilities, the agent↔surface RPC events (ui.call / ui.result /
// ui.action-result / ui.widget.result / ui.display-mode), the A2UI surface-stream
// events (ui.surface.start / ui.surface.update / ui.surface.end / ui.data-model);
// the 4-channel tool-result (uiData + sideData + structuredContent) on the
// tool-result block AND the tool.done event; and the AgArtifact /
// AgTurnRecord / AgReduceResult / AgCapabilities /
// AgClientCapabilities types.
// ─────────────────────────────────────────────────────────────────────────────

describe("AgEvent (ADVANCED)", () => {
  it("parses each ADVANCED event variant", () => {
    const samples = [
      // ── OPAQUE STATE PASSTHROUGH (LangGraph values/updates) ──
      { type: "state.snapshot", seq: 1, snapshot: { count: 1, nested: { a: [1, 2] } } },
      { type: "state.delta", seq: 2, patch: { node1: { key: "value" } } },
      // ── STREAMED ARTIFACTS (A2A) ──
      {
        type: "artifact.start",
        seq: 3,
        artifactId: "art1",
        turnId: "t1",
        threadId: "th1",
        name: "report",
        description: "the report",
        extensions: ["urn:a2a:ext:foo"],
      },
      {
        type: "artifact.delta",
        seq: 4,
        artifactId: "art1",
        part: { type: "text", text: "chunk" },
        append: true,
      },
      { type: "artifact.end", seq: 5, artifactId: "art1", lastChunk: true },
      // ── RECONNECT / RESYNC ──
      {
        type: "messages.snapshot",
        seq: 6,
        messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "hi" }] }],
        turns: [{ turnId: "t1", threadId: "th1" }],
        artifacts: [{ artifactId: "art1", turnId: "t1", threadId: "th1", parts: [] }],
      },
      // ── HOST DISPLAY/RUNTIME HINT ──
      {
        type: "host.context",
        seq: 7,
        theme: { mode: "dark" },
        capabilities: { canFullscreen: true },
        container: { width: 800 },
      },
      // ── MESSAGE METADATA ──
      { type: "message.metadata", seq: 8, messageId: "m1", metadata: { totalTokens: 42 } },
      // ── MANDATORY DISPLAY (ToS) ──
      { type: "display.required", seq: 9, provider: "google", html: "<div>grounding</div>" },
      // ── CAPABILITY NEGOTIATION ──
      {
        type: "agent.capabilities",
        seq: 10,
        capabilities: { streaming: { partialMessages: true }, profile: "ADVANCED" },
      },
      // ── AGENT ↔ SURFACE RPC ──
      {
        type: "ui.call",
        seq: 11,
        surfaceId: "s1",
        callId: "call1",
        method: "doThing",
        args: { x: 1 },
        wantResponse: true,
        callableFrom: "clientOnly",
      },
      {
        type: "ui.result",
        seq: 12,
        surfaceId: "s1",
        callId: "call1",
        method: "doThing",
        value: { ok: true },
      },
      {
        type: "ui.action-result",
        seq: 13,
        surfaceId: "s1",
        actionId: "act1",
        value: { done: true },
      },
      { type: "ui.widget.result", seq: 14, surfaceId: "s1", callId: "call1", result: "ok" },
      {
        type: "ui.display-mode",
        seq: 15,
        mode: "fullscreen",
        granted: "fullscreen",
        surfaceId: "s1",
        toolCallId: "tc1",
      },
      // ── A2UI SURFACE LIFECYCLE + DATA-MODEL PUSH ──
      {
        type: "ui.surface.start",
        seq: 16,
        surfaceId: "s1",
        catalogId: "cat1",
        surfaceProperties: { title: "X" },
        sendDataModel: true,
        components: { root: { id: "root" } },
        dataModel: { a: 1 },
        toolCallId: "tc1",
      },
      { type: "ui.surface.update", seq: 17, surfaceId: "s1", components: { root: { id: "root" } } },
      { type: "ui.surface.end", seq: 18, surfaceId: "s1" },
      { type: "ui.data-model", seq: 19, surfaceId: "s1", path: "/a/b", value: 7 },
    ];
    for (const s of samples) expect(AgEvent.parse(s).type).toBe(s.type);
  });

  it("accepts the ui.display-mode enum incl. coerced/granted modal", () => {
    for (const mode of ["inline", "pip", "fullscreen", "modal"]) {
      const ev = AgEvent.parse({ type: "ui.display-mode", seq: 0, mode, granted: mode });
      expect(ev.type).toBe("ui.display-mode");
    }
  });

  it("accepts a ui.result / ui.action-result error with a JSON-Pointer path", () => {
    const r = AgEvent.parse({
      type: "ui.result",
      seq: 0,
      surfaceId: "s1",
      callId: "c1",
      error: { code: "VALIDATION_FAILED", message: "bad", path: "/fields/name" },
    });
    expect(r.type).toBe("ui.result");
    const ar = AgEvent.parse({
      type: "ui.action-result",
      seq: 1,
      surfaceId: "s1",
      actionId: "a1",
      error: { code: "VALIDATION_FAILED", message: "bad", path: "/x" },
    });
    expect(ar.type).toBe("ui.action-result");
  });

  it("accepts state.delta carrying an RFC-6902 JSON Patch array (opaque)", () => {
    const ev = AgEvent.parse({
      type: "state.delta",
      seq: 0,
      patch: [{ op: "add", path: "/a", value: 1 }],
    });
    expect(ev.type).toBe("state.delta");
  });

  it("rejects an unknown ADVANCED-looking event type", () => {
    expect(() => AgEvent.parse({ type: "ui.nope", seq: 0, surfaceId: "s1" })).toThrow();
  });
});

describe("AgEvent — 4-channel tool.done (ADVANCED)", () => {
  it("accepts structuredContent / uiData / sideData + the ADVANCED tool channels on tool.done", () => {
    const ev = AgEvent.parse({
      type: "tool.done",
      seq: 0,
      toolCallId: "c1",
      messageId: "m1",
      content: [{ type: "text", text: "model-facing" }],
      outcome: "ok",
      structuredContent: { result: 42 },
      uiData: { rows: [1, 2, 3] },
      sideData: { internal: true },
      errorText: undefined,
      providerMetadata: { vercel: { x: 1 } },
      toolMetadata: { source: "mcp" },
      dynamic: true,
      isError: false,
      skipSummarization: true,
      more: false,
      preliminary: false,
    });
    expect(ev.type).toBe("tool.done");
  });

  it("accepts a tool.done error carrying errorText / errorCode", () => {
    const ev = AgEvent.parse({
      type: "tool.done",
      seq: 0,
      toolCallId: "c1",
      content: [],
      outcome: "error",
      errorText: "search failed",
      errorCode: "max_uses_exceeded",
    });
    expect(ev.type).toBe("tool.done");
  });

  it("accepts a tool.done input_required carrying pendingInput (MRTR)", () => {
    const ev = AgEvent.parse({
      type: "tool.done",
      seq: 0,
      toolCallId: "c1",
      content: [],
      outcome: "input_required",
      pendingInput: { requestState: "blob", inputKeys: ["k1", "k2"] },
    });
    expect(ev.type).toBe("tool.done");
  });
});

describe("AgBlock — 4-channel tool-result (ADVANCED)", () => {
  it("accepts structuredContent / uiData / sideData on a tool-result block", () => {
    const r = AgBlock.parse({
      type: "tool-result",
      toolCallId: "c1",
      content: [{ type: "text", text: "model" }],
      outcome: "ok",
      structuredContent: { typed: true },
      uiData: { view: "table" },
      sideData: { appOnly: "x" },
    });
    expect(r.type).toBe("tool-result");
  });

  it("accepts the full ADVANCED tool-result channel set", () => {
    const r = AgBlock.parse({
      type: "tool-result",
      toolCallId: "c1",
      content: [],
      outcome: "error",
      structuredContent: { e: 1 },
      uiData: { v: 1 },
      sideData: { a: 1 },
      errorText: "boom",
      errorCode: "code1",
      providerMetadata: { vercel: { y: 2 } },
      toolMetadata: { dyn: true },
      dynamic: true,
      pendingInput: { requestState: "rs", inputKeys: ["k"] },
      isError: true,
    });
    expect(r.type).toBe("tool-result");
  });

  it("keeps CORE tool-result (content+outcome only) valid (additive)", () => {
    const r = AgBlock.parse({ type: "tool-result", toolCallId: "c1", content: [], outcome: "ok" });
    expect(r.type).toBe("tool-result");
  });

  it("nests a 4-channel tool-result inside another tool-result (recursion preserved)", () => {
    const r = AgBlock.parse({
      type: "tool-result",
      toolCallId: "outer",
      content: [
        {
          type: "tool-result",
          toolCallId: "inner",
          content: [{ type: "text", text: "x" }],
          uiData: { nested: true },
        },
      ],
      sideData: { o: 1 },
    });
    expect(r.type).toBe("tool-result");
  });
});

describe("ADVANCED helper types", () => {
  it("AgArtifact parses a streamed-artifact entity", () => {
    const a = AgArtifact.parse({
      artifactId: "art1",
      turnId: "t1",
      threadId: "th1",
      name: "doc",
      description: "a doc",
      parts: [
        { type: "text", text: "part1" },
        { type: "code", language: "ts", code: "x" },
      ],
      extensions: ["urn:a2a:ext:x"],
      _meta: { traceparent: "00-..." },
    });
    expect(a.artifactId).toBe("art1");
    expect(a.parts.length).toBe(2);
  });

  it("AgTurnRecord parses a folded per-turn record", () => {
    const t = AgTurnRecord.parse({
      turnId: "t1",
      parentTurnId: "t0",
      threadId: "th1",
      outcome: { type: "paused", asks: [{ askId: "a1", kind: "approval" }] },
      finishReason: "paused",
      usage: { inputTokens: 1, outputTokens: 2 },
      safety: [{ category: "violence", blocked: false }],
      handoffs: [{ kind: "transfer", fromAgentId: "a1", toAgentId: "a2" }],
      sourceIds: ["src1", "src2"],
      asks: [{ askId: "a1", kind: "approval" }],
      taskState: "submitted",
      displayRequired: [{ provider: "google", html: "<div/>" }],
    });
    expect(t.turnId).toBe("t1");
  });

  it("AgReduceResult parses the reduce() landing container", () => {
    const r = AgReduceResult.parse({
      messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "hi" }] }],
      artifacts: [{ artifactId: "art1", turnId: "t1", threadId: "th1", parts: [] }],
      memory: [],
      turns: [{ turnId: "t1", threadId: "th1" }],
      state: { shared: { k: "v" } },
    });
    expect(r.messages.length).toBe(1);
    expect(r.artifacts.length).toBe(1);
    expect(r.turns.length).toBe(1);
  });

  it("AgCapabilities parses the agent→client negotiation payload + profile enum", () => {
    for (const profile of ["CORE", "EXTENDED", "ADVANCED"]) {
      const c = AgCapabilities.parse({
        streaming: { partialMessages: true },
        pushNotifications: true,
        securitySchemes: [{ scheme: "oauth2", scopes: ["read"] }],
        extensions: ["urn:a2a:ext:x"],
        uiCatalogs: ["cat1"],
        profile,
      });
      expect(c.profile).toBe(profile);
    }
  });

  it("rejects an unknown AgCapabilities profile", () => {
    expect(() => AgCapabilities.parse({ profile: "MEGA" })).toThrow();
  });

  it("AgClientCapabilities parses the client→agent payload", () => {
    const c = AgClientCapabilities.parse({
      frontendTools: [{ name: "calc", description: "adds", inputSchema: { type: "object" } }],
      hitl: { ask: true, approveWithEdits: true, form: true, auth: false },
      streaming: { partialMessages: true },
      uiResources: { catalogs: ["cat1"], htmlResources: true },
      state: { jsonPatch: true },
    });
    expect(c.frontendTools?.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INPUT (spec §3). AgInput = discriminated union on `kind`
// (start | resume | tool-result) over a shared AgInputEnvelope. Plus the
// §3 helper config types AgReasoningConfig / AgToolDef / AgRunConfig.
// ─────────────────────────────────────────────────────────────────────────────

const envelope = { protocol: "agjson" as const, version: "1.0.0", threadId: "th1", turnId: "t1" };

describe("AgInput (§3)", () => {
  it("parses the kind:start variant (messages + run config)", () => {
    const inp = AgInput.parse({
      ...envelope,
      kind: "start",
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }],
      run: {
        model: "claude-opus-4",
        system: "be nice",
        tools: [{ name: "search", inputSchema: { type: "object" } }],
        toolChoice: "auto",
        reasoning: { mode: "enabled", effort: "high", budgetTokens: 2048 },
        maxTokens: 1024,
        temperature: 0.2,
      },
    });
    expect(inp.kind).toBe("start");
  });

  it("parses the kind:resume variant (HITL answers + surface uiActions)", () => {
    const inp = AgInput.parse({
      ...envelope,
      parentTurnId: "t0",
      kind: "resume",
      answers: [{ askId: "ask1", status: "resolved", reply: { approved: true }, requestState: "blob" }],
      uiActions: [
        {
          surface: "a2ui",
          surfaceId: "s1",
          a2uiMessage: "action",
          name: "submit",
          sourceComponentId: "comp1",
          timestamp: "2026-01-01T00:00:00Z",
          context: { field: "value" },
        },
      ],
    });
    expect(inp.kind).toBe("resume");
  });

  it("parses the kind:tool-result variant (client-executed results)", () => {
    const inp = AgInput.parse({
      ...envelope,
      kind: "tool-result",
      results: [
        {
          toolCallId: "c1",
          content: [{ type: "text", text: "done" }],
          outcome: "ok",
          structuredContent: { value: 42 },
          uiData: { view: "table" },
          sideData: { appOnly: true },
          willContinue: false,
          scheduling: "when_idle",
        },
      ],
    });
    expect(inp.kind).toBe("tool-result");
  });

  it("narrows AgInput on the kind discriminant", () => {
    const inp = AgInput.parse({
      ...envelope,
      kind: "start",
      messages: [{ id: "m1", role: "user", content: [] }],
    });
    if (inp.kind === "start") {
      expect(inp.messages.length).toBe(1);
    } else {
      throw new Error("expected start");
    }
  });

  it("carries the LangGraph checkpoint replay handles on envelope.metadata", () => {
    const inp = AgInput.parse({
      ...envelope,
      kind: "resume",
      answers: [{ askId: "a1", status: "resolved" }],
      capabilities: { hitl: { ask: true } },
      state: { shared: { k: "v" } },
      lastSeq: 42,
      metadata: { "langgraph/threadId": "lg-th", "langgraph/checkpointId": "ckpt1" },
    });
    expect(inp.kind).toBe("resume");
  });

  it("rejects an unknown AgInput kind", () => {
    expect(() => AgInput.parse({ ...envelope, kind: "nope" })).toThrow();
  });

  it("rejects a start without messages", () => {
    expect(() => AgInput.parse({ ...envelope, kind: "start" })).toThrow();
  });

  it("AgInputEnvelope parses the shared envelope fields", () => {
    const e = AgInputEnvelope.parse({
      protocol: "agjson",
      version: "1.2.3",
      threadId: "th1",
      turnId: "t1",
      parentTurnId: "t0",
      capabilities: { streaming: { partialMessages: true } },
      state: { x: 1 },
      lastSeq: 7,
      metadata: { foo: "bar" },
    });
    expect(e.protocol).toBe("agjson");
  });

  it("AgInputEnvelope rejects a wrong protocol literal", () => {
    expect(() =>
      AgInputEnvelope.parse({ protocol: "other", version: "1", threadId: "th1", turnId: "t1" }),
    ).toThrow();
  });
});

describe("AgInput §3 config helpers", () => {
  it("AgReasoningConfig parses mode + effort + budgetTokens", () => {
    for (const effort of ["minimal", "low", "medium", "high"]) {
      const r = AgReasoningConfig.parse({ mode: "enabled", effort, budgetTokens: 1000 });
      expect(r.mode).toBe("enabled");
    }
    expect(AgReasoningConfig.parse({ mode: "disabled" }).mode).toBe("disabled");
  });

  it("AgReasoningConfig rejects an unknown mode / effort", () => {
    expect(() => AgReasoningConfig.parse({ mode: "auto" })).toThrow();
    expect(() => AgReasoningConfig.parse({ mode: "enabled", effort: "max" })).toThrow();
  });

  it("AgToolDef parses each source variant + uiVisibility scope", () => {
    const mcp = AgToolDef.parse({
      name: "search",
      description: "web search",
      inputSchema: { type: "object" },
      strict: true,
      providerExecuted: true,
      uiVisibility: ["model", "app"],
      source: { type: "mcp", serverName: "web" },
      _meta: { ui: { visibility: "model" } },
    });
    expect(mcp.name).toBe("search");
    expect(AgToolDef.parse({ name: "f", inputSchema: {}, source: { type: "function" } }).name).toBe("f");
    expect(AgToolDef.parse({ name: "g", inputSchema: {}, source: { type: "frontend" } }).name).toBe("g");
  });

  it("AgToolDef rejects an unknown source type", () => {
    expect(() => AgToolDef.parse({ name: "x", inputSchema: {}, source: { type: "nope" } })).toThrow();
  });

  it("AgRunConfig parses model/system/tools/toolChoice/responseFormat/reasoning/context/pushNotification", () => {
    const rc = AgRunConfig.parse({
      model: "claude-opus-4",
      system: [{ type: "text", text: "sys" }],
      tools: [{ name: "t", inputSchema: {}, source: { type: "function" } }],
      toolChoice: { type: "tool", name: "t" },
      responseFormat: { type: "json_schema", name: "Out", schema: { type: "object" }, strict: true },
      reasoning: { mode: "enabled" },
      maxTokens: 512,
      temperature: 0.7,
      topP: 0.9,
      stopSequences: ["\n\n"],
      context: [{ type: "text", text: "ctx" }],
      pushNotification: { url: "https://hook", token: "tk", auth: { scheme: "bearer", credentials: "c" } },
    });
    expect(rc.model).toBe("claude-opus-4");
  });

  it("AgRunConfig accepts each toolChoice keyword", () => {
    for (const toolChoice of ["auto", "none", "required"]) {
      expect(AgRunConfig.parse({ toolChoice }).toolChoice).toBe(toolChoice);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SURFACE INTERACTION (spec §3 / §6 / §11.8). The un-merge: a shared
// AgSurfaceEnvelope + five per-spec-faithful constructs forming
// AgSurfaceInteraction (the element type of resume.uiActions[]).
// ─────────────────────────────────────────────────────────────────────────────

describe("AgSurfaceInteraction (§3 / §6 / §11.8 un-merge)", () => {
  it("AgSurfaceEnvelope parses the shared correlation fields", () => {
    const e = AgSurfaceEnvelope.parse({
      surface: "a2ui",
      surfaceId: "s1",
      toolCallId: "c1",
      turnId: "t1",
      threadId: "th1",
      _meta: { traceparent: "00-..." },
    });
    expect(e.surface).toBe("a2ui");
  });

  it("AgA2uiSurfaceAction (a2uiMessage:action) parses + the context map is the sanctioned Record", () => {
    const a = AgA2uiSurfaceAction.parse({
      surface: "a2ui",
      surfaceId: "s1",
      a2uiMessage: "action",
      name: "click",
      sourceComponentId: "btn1",
      timestamp: "2026-01-01T00:00:00Z",
      context: { selectedId: "x", count: 3, nested: { a: [1, 2] } },
      wantResponse: true,
      actionId: "act1",
    });
    expect(a.a2uiMessage).toBe("action");
    expect(a.name).toBe("click");
  });

  it("AgA2uiFunctionResponse (a2uiMessage:function-response) parses", () => {
    const f = AgA2uiFunctionResponse.parse({
      surface: "a2ui",
      surfaceId: "s1",
      a2uiMessage: "function-response",
      functionCallId: "fc1",
      call: "getData",
      value: { rows: [1, 2] },
    });
    expect(f.a2uiMessage).toBe("function-response");
  });

  it("AgA2uiError (a2uiMessage:error) parses with a JSON-Pointer path", () => {
    const e = AgA2uiError.parse({
      surface: "a2ui",
      surfaceId: "s1",
      a2uiMessage: "error",
      code: "VALIDATION_FAILED",
      message: "bad input",
      path: "/fields/name",
    });
    expect(e.a2uiMessage).toBe("error");
  });

  it("AgMcpAppViewMessage narrows on the verbatim MCP method", () => {
    const ctx = AgMcpAppViewMessage.parse({
      surface: "mcp-app",
      surfaceId: "s1",
      method: "ui/update-model-context",
      params: { content: [{ type: "text", text: "ctx" }], structuredContent: { x: 1 } },
    });
    expect(ctx.method).toBe("ui/update-model-context");

    const msg = AgMcpAppViewMessage.parse({
      surface: "mcp-app",
      surfaceId: "s1",
      method: "ui/message",
      params: { role: "user", content: { type: "text", text: "hello" } },
    });
    expect(msg.method).toBe("ui/message");

    const dm = AgMcpAppViewMessage.parse({
      surface: "mcp-app",
      surfaceId: "s1",
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    expect(dm.method).toBe("ui/request-display-mode");

    const link = AgMcpAppViewMessage.parse({
      surface: "mcp-app",
      surfaceId: "s1",
      method: "ui/open-link",
      params: { url: "https://example.com" },
    });
    expect(link.method).toBe("ui/open-link");
  });

  it("AgMcpAppViewMessage rejects a non-user role on ui/message and an unknown method", () => {
    expect(() =>
      AgMcpAppViewMessage.parse({
        surface: "mcp-app",
        surfaceId: "s1",
        method: "ui/message",
        params: { role: "assistant", content: { type: "text", text: "x" } },
      }),
    ).toThrow();
    expect(() =>
      AgMcpAppViewMessage.parse({ surface: "mcp-app", surfaceId: "s1", method: "ui/nope", params: {} }),
    ).toThrow();
  });

  it("AgMcpAppViewMessage rejects modal on ui/request-display-mode (OpenAI-only)", () => {
    expect(() =>
      AgMcpAppViewMessage.parse({
        surface: "mcp-app",
        surfaceId: "s1",
        method: "ui/request-display-mode",
        params: { mode: "modal" },
      }),
    ).toThrow();
  });

  it("AgOpenAiWidgetAction narrows on the OpenAI method", () => {
    const sw = AgOpenAiWidgetAction.parse({
      surface: "openai-app",
      surfaceId: "s1",
      method: "setWidgetState",
      widgetState: { count: 1 },
      toolResponseMetadata: { echo: true },
    });
    expect(sw.method).toBe("setWidgetState");

    const ct = AgOpenAiWidgetAction.parse({
      surface: "openai-app",
      surfaceId: "s1",
      method: "callTool",
      name: "lookup",
      args: { q: "x" },
      callId: "call1",
    });
    expect(ct.method).toBe("callTool");

    const fm = AgOpenAiWidgetAction.parse({
      surface: "openai-app",
      surfaceId: "s1",
      method: "sendFollowUpMessage",
      prompt: "continue",
      scrollToBottom: true,
    });
    expect(fm.method).toBe("sendFollowUpMessage");

    const rd = AgOpenAiWidgetAction.parse({
      surface: "openai-app",
      surfaceId: "s1",
      method: "requestDisplayMode",
      mode: "fullscreen",
      requestId: "req1",
    });
    expect(rd.method).toBe("requestDisplayMode");
  });

  it("AgOpenAiWidgetAction rejects modal on requestDisplayMode + an unknown method", () => {
    expect(() =>
      AgOpenAiWidgetAction.parse({
        surface: "openai-app",
        surfaceId: "s1",
        method: "requestDisplayMode",
        mode: "modal",
        requestId: "r1",
      }),
    ).toThrow();
    expect(() =>
      AgOpenAiWidgetAction.parse({ surface: "openai-app", surfaceId: "s1", method: "nope" }),
    ).toThrow();
  });

  it("AgSurfaceInteraction narrows the five arms on surface + inner discriminant", () => {
    const samples = [
      {
        surface: "a2ui",
        surfaceId: "s1",
        a2uiMessage: "action",
        name: "n",
        sourceComponentId: "c",
        timestamp: "2026-01-01T00:00:00Z",
        context: {},
      },
      {
        surface: "a2ui",
        surfaceId: "s1",
        a2uiMessage: "function-response",
        functionCallId: "fc1",
        call: "fn",
        value: 1,
      },
      { surface: "a2ui", surfaceId: "s1", a2uiMessage: "error", code: "E", message: "m" },
      {
        surface: "mcp-app",
        surfaceId: "s1",
        method: "ui/open-link",
        params: { url: "https://e.com" },
      },
      { surface: "openai-app", surfaceId: "s1", method: "setWidgetState", widgetState: {} },
    ];
    for (const s of samples) {
      const parsed = AgSurfaceInteraction.parse(s);
      expect(parsed.surface).toBe(s.surface);
    }
  });

  it("rejects an unknown surface discriminant", () => {
    expect(() =>
      AgSurfaceInteraction.parse({ surface: "nope", surfaceId: "s1" }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2-EXTENDED breaking arms (spec §4 / §5 pre-freeze additions)
// ─────────────────────────────────────────────────────────────────────────────

describe("S2-EXTENDED breaking arms", () => {
  it("parses message.remove (id + REMOVE_ALL sentinel)", () => {
    expect(AgEvent.parse({ type: "message.remove", seq: 0, id: "msg_1" }).type).toBe("message.remove");
    expect(AgEvent.parse({ type: "message.remove", seq: 1, id: "*", turnId: "turn_1" })).toMatchObject({ id: "*" });
  });
  it("parses memory.write with value XOR patch (exactly one)", () => {
    expect(AgEvent.parse({ type: "memory.write", seq: 0, scope: "user", key: "name", value: "Ada" })).toMatchObject({ scope: "user", value: "Ada" });
    expect(AgEvent.parse({ type: "memory.write", seq: 1, scope: "skill", patch: [{ op: "add", path: "/x", value: 1 }], durable: true })).toMatchObject({ durable: true });
  });
  it("rejects memory.write carrying BOTH value and patch, or NEITHER (exactly-one)", () => {
    expect(() => AgEvent.parse({ type: "memory.write", seq: 0, scope: "user", value: {}, patch: [{ op: "add", path: "/x", value: 1 }] })).toThrow();
    expect(() => AgEvent.parse({ type: "memory.write", seq: 1, scope: "user" })).toThrow();  // neither
  });
  it("rejects message.remove REMOVE_ALL ('*') without a turnId", () => {
    expect(() => AgEvent.parse({ type: "message.remove", seq: 0, id: "*" })).toThrow();
    expect(AgEvent.parse({ type: "message.remove", seq: 1, id: "*", turnId: "turn_1" })).toMatchObject({ id: "*" });
  });
  it("carries candidateIndex on every block-creating event", () => {
    expect(AgEvent.parse({ type: "message.start", seq: 0, id: "m", role: "assistant", turnId: "t", threadId: "th", candidateIndex: 1 })).toMatchObject({ candidateIndex: 1 });
    expect(AgEvent.parse({ type: "text.start", seq: 1, id: "x", candidateIndex: 1 })).toMatchObject({ candidateIndex: 1 });
    expect(AgEvent.parse({ type: "reasoning.start", seq: 2, id: "r", candidateIndex: 1 })).toMatchObject({ candidateIndex: 1 });
    expect(AgEvent.parse({ type: "tool.start", seq: 3, toolCallId: "c", name: "f", candidateIndex: 1 })).toMatchObject({ candidateIndex: 1 });
    expect(AgEvent.parse({ type: "tool.done", seq: 4, toolCallId: "c", outcome: "ok", content: [], candidateIndex: 1 })).toMatchObject({ candidateIndex: 1 });
    expect(AgEvent.parse({ type: "content.block", seq: 5, block: { type: "text", text: "x" }, candidateIndex: 1 })).toMatchObject({ candidateIndex: 1 });
  });
  it("AgReduceResult requires memory[] parallel to artifacts[]", () => {
    expect(AgReduceResult.parse({ messages: [], artifacts: [], memory: [], turns: [] }).memory).toEqual([]);
    expect(() => AgReduceResult.parse({ messages: [], artifacts: [], turns: [] })).toThrow();
  });
  it("REMOVE_ALL is exported and equals '*'", () => { expect(REMOVE_ALL).toBe("*"); });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2-EXTENDED additive fields (spec §2 / §4 pre-freeze additions)
// ─────────────────────────────────────────────────────────────────────────────

describe("S2-EXTENDED additive fields", () => {
  it("AgUsage carries byModel (self-recursive) + serverToolRequests", () => {
    const u = { outputTokens: 10, serverToolRequests: 2, byModel: { "claude-opus": { outputTokens: 7 }, "claude-haiku": { outputTokens: 3 } } };
    expect(AgUsage.parse(u)).toMatchObject(u);
  });
  it("message.start carries agent attribution + model + (A1) candidateIndex", () => {
    expect(AgEvent.parse({ type: "message.start", seq: 0, id: "m", role: "assistant", turnId: "t", threadId: "th", agentId: "a1", agentName: "Researcher", agentRole: "analyst", model: "claude-opus" })).toMatchObject({ agentName: "Researcher", model: "claude-opus" });
  });
  it("turn.start carries a trigger", () => {
    expect(AgEvent.parse({ type: "turn.start", seq: 0, threadId: "th", turnId: "t", trigger: { kind: "cron", ref: "0 9 * * *" } })).toMatchObject({ trigger: { kind: "cron" } });
  });
  it("parses guardrail.result", () => {
    expect(AgEvent.parse({ type: "guardrail.result", seq: 0, target: "output", passed: false, action: "rewrite", guardrailName: "pii" })).toMatchObject({ passed: false, action: "rewrite" });
  });
  it("tool.start carries longRunning", () => {
    expect(AgEvent.parse({ type: "tool.start", seq: 0, toolCallId: "c1", name: "deploy", longRunning: true })).toMatchObject({ longRunning: true });
  });
  it("message.end carries per-message usage (review #4 carrier)", () => {
    expect(AgEvent.parse({ type: "message.end", seq: 0, id: "m", usage: { outputTokens: 5, cumulative: true } })).toMatchObject({ usage: { outputTokens: 5 } });
  });
  it("AgMessage.usage round-trips the per-message usage landing field (reduce R1 prereq)", () => {
    const msg = AgMessage.parse({ id: "m", role: "assistant", content: [], usage: { outputTokens: 5 } });
    expect(msg.usage?.outputTokens).toBe(5);
  });
});
