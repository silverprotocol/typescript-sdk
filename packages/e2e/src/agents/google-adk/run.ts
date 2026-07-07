/**
 * Standalone Google ADK capture agent for the E2E conformance harness
 * (Task 6 / audit M60 — the design's own promised Slice B capture agent).
 *
 * ★ ADJUDICATION (Task 6 Step 3) — a REAL TypeScript ADK agent, not a python
 * shell-out ★
 *
 * HISTORY: at capture time this agent was wired to `@iqai/adk` ("Agent
 * Development Kit for TypeScript", IQAI — the ORIGINAL peer of
 * `@silverprotocol/google-adk`). The publishable peer has since been retargeted
 * to the OFFICIAL `@google/adk` (google/adk-js, stable since Oct 2025); this
 * capture agent + the fixture-drift ratchet's ground truth should follow in a
 * future task. `@iqai/adk` remains a genuine, independently-maintained TS
 * port whose `Event extends LlmResponse` class is a STRUCTURAL match for the
 * Python `google.adk.events.event.Event` shape our normalizer targets
 * (`invocationId`/`author`/`actions`/`branch`/`id` on `Event`;
 * `content`/`partial`/`turnComplete`/`errorCode`/`finishReason` on
 * `LlmResponse`; `content.parts[]` uses the real `@google/genai` `Content`/
 * `Part` types — the SAME Gemini wire shape `google-adk/src/index.ts`'s
 * header cites as its primary source). `AgentBuilder(...).build()` returns a
 * `runner.runAsync(): AsyncIterable<Event>` — a REAL native TS event stream,
 * not a python shell. This is what this module runs, so "adk shells to
 * python" is NOT what happens here — verified empirically against the
 * installed `@iqai/adk@0.1.22` .d.ts before writing this file.
 *
 * ★ THE ONE GENUINE GAP: MCP transport, not the agent engine ★
 *
 * `@iqai/adk`'s built-in `McpToolset` only speaks `stdio` or classic SSE
 * (`McpTransportType = {mode:"stdio",...} | {mode:"sse",serverUrl,headers}`)
 * — it has NO Streamable-HTTP client. `mcp-mocks/serve.ts` (and the claude +
 * openai capture agents) all speak Streamable HTTP (`POST /mcp`,
 * `StreamableHTTPServerTransport`). Rather than fork the gap into "adk
 * captures use a different mock transport" (which would make adk captures
 * non-comparable to the other two frameworks) or shell out to python (a
 * genuinely different agent engine, undermining the point of a same-corpus
 * capture), this module bridges ONLY the tool-transport boundary: it
 * discovers each mock server's tools via a REAL `tools/list` JSON-RPC call
 * (`mcp-mocks/client.ts#callTool`, the exact HTTP client the harness's own
 * tests use against `serve.ts`), converts each MCP `Tool` schema to a Gemini
 * `Schema` via `@iqai/adk`'s OWN exported `mcpSchemaToParameters()` utility
 * (built for exactly this conversion), and registers one native
 * `BaseTool` subclass per discovered tool whose `runAsync` proxies the call
 * back over the SAME Streamable-HTTP endpoint via `tools/call`. Every other
 * concern — the LLM loop, the turn/event stream, tool-call decisioning — is
 * 100% real `@iqai/adk`.
 *
 * OPERATOR-GATED: requires `GOOGLE_API_KEY` (or `CaptureRunInput.apiKey`) at
 * ITERATION time (the function is an async generator — no work happens, and
 * no key check fires, until the caller starts iterating; `@iqai/adk`'s own
 * `GoogleLlm` reads `process.env.GOOGLE_API_KEY` internally, so this module
 * seeds that var from the resolved key before building the agent). Live
 * capture is operator-run; this module + its smoke test only confirm module
 * load, callable shape, and the key-absent failure — no live SDK run, no
 * mock server booted.
 */

import { AgentBuilder, BaseTool, mcpSchemaToParameters } from "@iqai/adk";
import type { ToolContext } from "@iqai/adk";
import type { FunctionDeclaration } from "@google/genai";
import { ListToolsResultSchema, type Tool as McpToolSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JsonValue } from "@silverprotocol/core";
import { toJsonValue } from "@silverprotocol/core";
import { callTool } from "../../mcp-mocks/client.js";
import type { CaptureRunInput } from "../types.js";

// ─── McpBridgeTool — the tool-transport bridge (see header) ──────────────────

/**
 * A native `@iqai/adk` `BaseTool` whose declaration comes from a REAL MCP
 * `tools/list` schema and whose execution proxies to the SAME mock's
 * `tools/call` over Streamable HTTP — see the file header for why this
 * bridges only the transport, not the agent engine.
 */
class McpBridgeTool extends BaseTool {
  private readonly mcpUrl: string;
  private readonly mcpToolSchema: McpToolSchema;

  constructor(mcpUrl: string, mcpToolSchema: McpToolSchema) {
    super({ name: mcpToolSchema.name, description: mcpToolSchema.description ?? "" });
    this.mcpUrl = mcpUrl;
    this.mcpToolSchema = mcpToolSchema;
  }

  override getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: mcpSchemaToParameters(this.mcpToolSchema),
    };
  }

  // BaseTool's own signature types `args` as `Record<string, any>` (their
  // frozen external surface). TS method-parameter bivariance lets this
  // override declare the HONEST shape instead — tool args from the LLM are a
  // plain JSON object — so no `any` enters our code and no cast is needed.
  override async runAsync(args: { [k: string]: JsonValue }, _context: ToolContext): Promise<JsonValue> {
    return callTool(this.mcpUrl, this.name, args);
  }
}

/** Discovers every tool exposed by each configured mock MCP server via a
 *  real `tools/list` call, and wraps each into an `McpBridgeTool`. */
async function discoverTools(mcpServers: CaptureRunInput["mcpServers"]): Promise<BaseTool[]> {
  const tools: BaseTool[] = [];
  for (const cfg of Object.values(mcpServers)) {
    const result = await callTool(cfg.url, "tools/list", null);
    const { tools: mcpTools } = ListToolsResultSchema.parse(result);
    for (const mcpTool of mcpTools) {
      tools.push(new McpBridgeTool(cfg.url, mcpTool));
    }
  }
  return tools;
}

// ─── runAdkCapture ─────────────────────────────────────────────────────────

/**
 * Yields the RAW native `@iqai/adk` `Event` stream, unnormalized, each item
 * materialized as a plain `JsonValue` via `toJsonValue` (audit D5-a's
 * native-ingestion boundary — the whole event, no per-field cast).
 */
export async function* runAdkCapture(input: CaptureRunInput): AsyncIterable<JsonValue> {
  const apiKey = input.apiKey ?? process.env["GOOGLE_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "GOOGLE_API_KEY is required: set it via CaptureRunInput.apiKey or the GOOGLE_API_KEY environment variable",
    );
  }
  // `@iqai/adk`'s GoogleLlm reads this env var directly (no per-call apiKey
  // param exists on its constructor) — seed it from the resolved key.
  process.env["GOOGLE_API_KEY"] = apiKey;

  const tools = await discoverTools(input.mcpServers);

  const { runner, session } = await AgentBuilder.create("spike")
    .withModel(input.model ?? "gemini-2.5-flash")
    .withInstruction(input.systemPrompt ?? "You are a helpful assistant.")
    .withTools(...tools)
    .build();

  const stream = runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: input.prompt }] },
  });

  for await (const event of stream) {
    yield toJsonValue(event);
  }
}
