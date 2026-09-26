/**
 * The google-adk Live (bidi) capture agent: one `Runner.runLive` session with a
 * real barge-in, or a prompt answered through a tool call, for the Live-path
 * corpus (the facet has no live coverage).
 *
 * Tools: the agent binds the capture's MCP toolsets (`CaptureRunInput.mcpServers`,
 * built as `runAdkCapture` builds them), and none when the scenario declares no
 * server. ADK's live loop runs a model's function call, yields the call event
 * and then the function-response event, and sends the response back over the
 * connection (agents/llm_agent.js postprocessLive / runReceiveLoop,
 * @google/adk 2.1.0).
 *
 * The run with a barge-in:
 * 1. `input.prompt` goes in as the first user content of a `LiveRequestQueue`.
 * 2. At the first model output of that turn (a text or audio chunk, or an
 *    output transcription, while the model is still generating), the agent
 *    sends `adkLive.bargeIn` as a second user content: the barge-in. The server
 *    is expected to answer with `interrupted: true`. With a list of barge-ins,
 *    barge-in k goes out at the first model output of generation k: generation
 *    1 answers the prompt, and each later generation starts at the first
 *    output after the previous generation's `turnComplete`.
 * 3. The queue closes when the LAST barge-in's reply completes: the first
 *    `turnComplete` after an `interrupted` event and after model output that
 *    follows it. If the server never interrupts, the second `turnComplete`
 *    after the last barge-in closes it instead (that generation completed on
 *    its own).
 *    Closing the queue makes ADK close the live connection, which ends the
 *    stream (agents/llm_agent.js runSendLoop, @google/adk 2.1.0).
 * 4. A cap (default 60 s) closes the queue regardless, so a stuck session still
 *    ends and the normalizer's flush tells the truth about it. A second, short
 *    grace after the cap aborts the run if the stream still hasn't ended.
 *
 * The run with no barge-in (`adkLive.bargeIn` absent): `input.prompt` goes in
 * and nothing else is sent. The queue closes at the first `turnComplete` that
 * follows model output after the last function response (the reply), so a
 * `turnComplete` between a response and its reply does not close it; a run in
 * which the model calls no tool closes at the first `turnComplete` after its
 * output. The cap applies as above. The rule relies on ADK's serialization: a
 * `turnComplete` ADK yields right after a buffered call (utils/
 * live_connection_utils.js:155-165, on a model whose name has no
 * `-flash-live`) is consumed only after the tool ran and its response event was
 * yielded (agents/llm_agent.js:728-736, :823). A long-running tool (a null
 * result) would break this, and the capture binds none.
 *
 * Every native event is yielded verbatim (`toJsonValue`, no filtering). Audio
 * arrives as `content.parts[].inlineData` (`mimeType: "audio/pcm;rate=24000"`
 * from Gemini Live); the capture harness's redaction elides it.
 *
 * OPERATOR-GATED: needs `GOOGLE_API_KEY` (or `CaptureRunInput.apiKey`) and a
 * Live-capable model (`CAPTURE_MODEL`, e.g. `gemini-3.8-live`); DEFAULT_MODEL.adk
 * has no `bidiGenerateContent`.
 */
import { InMemoryRunner, LiveRequestQueue, LlmAgent, type BaseLlm, type Event, type ToolUnion } from "@google/adk";
import { Modality } from "@google/genai";
import type { JsonValue } from "@silverprotocol/core";
import { toJsonValue } from "@silverprotocol/core";
import type { CaptureRunInput } from "../types.js";
import { adkMcpToolsets } from "./run.js";

/** Where the Live agent's tools come from, and the harness's proof that the
 *  Live agent binds the capture's tools (its knob guard, KNOB_SUPPORT). */
export const ADK_LIVE_TOOLS = "mcpServers";

/** The `adkLive` scenario knob. */
export interface AdkLiveOptions {
  /** The barge-in: the user content sent while the model's first generation is
   *  still generating. A list sends one barge-in per generation, in order.
   *  Absent: no barge-in, for a prompt answered through a tool call. */
  bargeIn?: string | readonly string[];
  /** The response modality to request. Default "TEXT"; a Live model that serves only
   *  audio rejects it, and then "AUDIO" (with output transcription on) is the knob to set. */
  responseModality?: "TEXT" | "AUDIO";
}

export interface AdkLiveCaptureInput extends CaptureRunInput {
  adkLive: AdkLiveOptions;
}

/** The core run, with its model injectable (a model id, or the offline test's stub). */
export interface LiveBargeInOptions {
  model: string | BaseLlm;
  instruction: string;
  prompt: string;
  /** One barge-in, or one per generation in order; absent for none (see the module doc). */
  bargeIn?: string | readonly string[];
  /** The tools the agent binds. Absent or empty: none. */
  tools?: readonly ToolUnion[];
  responseModality: "TEXT" | "AUDIO";
  /** The cap after which the queue closes regardless. Default 60 000 ms. */
  capMs?: number;
  /** How long after the cap to wait for the stream to end before aborting. Default 10 000 ms. */
  graceMs?: number;
  abortSignal?: AbortSignal;
}

/** Model output of the current turn: a text or audio chunk, or an output transcription. */
function isModelOutput(e: Event): boolean {
  if (e.author === "user") return false;
  const parts = e.content?.parts ?? [];
  const hasPart = parts.some((p) => (typeof p.text === "string" && p.text.length > 0) || p.inlineData !== undefined);
  const hasTranscription = typeof e.outputTranscription?.text === "string" && e.outputTranscription.text.length > 0;
  return hasPart || hasTranscription;
}

const userContent = (text: string) => ({ role: "user", parts: [{ text }] });

/** An event that carries a function response. */
const answersTool = (e: Event): boolean => (e.content?.parts ?? []).some((p) => p.functionResponse !== undefined);

/**
 * Runs one Live session with a barge-in (see the module doc) and yields every
 * native event as plain JSON. No key handling here: `runAdkLiveCapture` does it.
 */
export async function* runLiveBargeIn(opts: LiveBargeInOptions): AsyncIterable<JsonValue> {
  const tools = opts.tools ?? [];
  const agent = new LlmAgent({
    name: "spike",
    model: opts.model,
    instruction: opts.instruction,
    ...(tools.length > 0 ? { tools: [...tools] } : {}),
  });
  const runner = new InMemoryRunner({ agent });
  const session = await runner.sessionService.createSession({ appName: runner.appName, userId: "user-1" });
  const queue = new LiveRequestQueue();
  const abort = new AbortController();
  const outerAbort = opts.abortSignal;
  const onOuterAbort = () => abort.abort();
  outerAbort?.addEventListener("abort", onOuterAbort);
  let closed = false;
  const closeQueue = () => {
    if (closed) return;
    closed = true;
    queue.close();
  };
  let grace: ReturnType<typeof setTimeout> | undefined;
  const cap = setTimeout(() => {
    closeQueue();
    grace = setTimeout(() => abort.abort(), opts.graceMs ?? 10_000);
  }, opts.capMs ?? 60_000);

  const audio = opts.responseModality === "AUDIO";
  const bargeIns: readonly string[] = opts.bargeIn === undefined ? [] : typeof opts.bargeIn === "string" ? [opts.bargeIn] : opts.bargeIn;
  if (opts.bargeIn !== undefined && bargeIns.length === 0) {
    throw new Error("adkLive.bargeIn is an empty list: give at least one barge-in, or omit it");
  }
  queue.sendContent(userContent(opts.prompt));
  // `sent` barge-ins are out. While more remain, the next one waits for the
  // first model output of the next generation (`armed`); the generation that
  // took the previous barge-in re-arms it with its turnComplete.
  let sent = 0;
  let armed = true;
  let interruptSeen = false;
  let outputAfterInterrupt = false;
  let completesAfterBargeIn = 0;
  // No barge-in: whether model output followed the last function response.
  let outputSinceResponse = false;
  try {
    const stream = runner.runLive({
      userId: session.userId,
      sessionId: session.id,
      liveRequestQueue: queue,
      runConfig: {
        responseModalities: [audio ? Modality.AUDIO : Modality.TEXT],
        ...(audio ? { outputAudioTranscription: {} } : {}),
      },
      abortSignal: abort.signal,
    });
    for await (const event of stream) {
      yield toJsonValue(event);
      const output = isModelOutput(event);
      if (bargeIns.length === 0) {
        if (answersTool(event)) outputSinceResponse = false;
        else if (output) outputSinceResponse = true;
        if (event.turnComplete === true && outputSinceResponse) closeQueue();
        continue;
      }
      if (sent < bargeIns.length) {
        if (armed && output && event.turnComplete !== true) {
          queue.sendContent(userContent(bargeIns[sent] ?? ""));
          sent++;
          armed = false;
        } else if (!armed && event.turnComplete === true) {
          armed = true;
        }
        continue;
      }
      if (event.interrupted === true) interruptSeen = true;
      else if (interruptSeen && output) outputAfterInterrupt = true;
      if (event.turnComplete === true) {
        completesAfterBargeIn++;
        if ((interruptSeen && outputAfterInterrupt) || (!interruptSeen && completesAfterBargeIn >= 2)) closeQueue();
      }
    }
  } finally {
    clearTimeout(cap);
    if (grace !== undefined) clearTimeout(grace);
    closeQueue();
    outerAbort?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * The capture entry point (KNOB_SUPPORT proof for `adkLive`). Yields the RAW
 * native `@google/adk` `Event` stream of one Live session, with the capture's
 * MCP toolsets bound (closed when the run ends).
 */
export async function* runAdkLiveCapture(input: AdkLiveCaptureInput): AsyncIterable<JsonValue> {
  const apiKey = input.apiKey ?? process.env["GOOGLE_API_KEY"];
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY is required: set it via CaptureRunInput.apiKey or the GOOGLE_API_KEY environment variable");
  }
  // @google/adk's Gemini model reads this env var directly (as runAdkCapture).
  process.env["GOOGLE_API_KEY"] = apiKey;
  if (input.model === undefined) {
    throw new Error("adkLive needs a Live-capable model: set CAPTURE_MODEL (e.g. gemini-3.8-live)");
  }
  const toolsets = adkMcpToolsets(input.mcpServers);
  try {
    yield* runLiveBargeIn({
      model: input.model,
      instruction: input.systemPrompt ?? "You are a helpful assistant. Answer at length.",
      prompt: input.prompt,
      ...(input.adkLive.bargeIn !== undefined ? { bargeIn: input.adkLive.bargeIn } : {}),
      ...(toolsets.length > 0 ? { tools: toolsets } : {}),
      responseModality: input.adkLive.responseModality ?? "TEXT",
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });
  } finally {
    // allSettled: a toolset that fails to close never masks the run's own error.
    await Promise.allSettled(toolsets.map((toolset) => toolset.close()));
  }
}
