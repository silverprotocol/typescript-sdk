/**
 * The google-adk Live (bidi) capture agent: one `Runner.runLive` session with a
 * real barge-in, for the Live-path corpus (the facet has no live coverage).
 *
 * The run:
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
 * Every native event is yielded verbatim (`toJsonValue`, no filtering). Audio
 * arrives as `content.parts[].inlineData` (`mimeType: "audio/pcm;rate=24000"`
 * from Gemini Live); the capture harness's redaction elides it.
 *
 * OPERATOR-GATED: needs `GOOGLE_API_KEY` (or `CaptureRunInput.apiKey`) and a
 * Live-capable model (`CAPTURE_MODEL`, e.g. `gemini-3.8-live`); DEFAULT_MODEL.adk
 * has no `bidiGenerateContent`.
 */
import { InMemoryRunner, LiveRequestQueue, LlmAgent, type BaseLlm, type Event } from "@google/adk";
import { Modality } from "@google/genai";
import type { JsonValue } from "@silverprotocol/core";
import { toJsonValue } from "@silverprotocol/core";
import type { CaptureRunInput } from "../types.js";

/** The `adkLive` scenario knob. */
export interface AdkLiveOptions {
  /** The barge-in: the user content sent while the model's first generation is
   *  still generating. A list sends one barge-in per generation, in order. */
  bargeIn: string | readonly string[];
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
  /** One barge-in, or one per generation in order (see the module doc). */
  bargeIn: string | readonly string[];
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

/**
 * Runs one Live session with a barge-in (see the module doc) and yields every
 * native event as plain JSON. No key handling here: `runAdkLiveCapture` does it.
 */
export async function* runLiveBargeIn(opts: LiveBargeInOptions): AsyncIterable<JsonValue> {
  const agent = new LlmAgent({ name: "spike", model: opts.model, instruction: opts.instruction });
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
  const bargeIns: readonly string[] = typeof opts.bargeIn === "string" ? [opts.bargeIn] : opts.bargeIn;
  if (bargeIns.length === 0) throw new Error("adkLive.bargeIn is an empty list: give at least one barge-in");
  queue.sendContent(userContent(opts.prompt));
  // `sent` barge-ins are out. While more remain, the next one waits for the
  // first model output of the next generation (`armed`); the generation that
  // took the previous barge-in re-arms it with its turnComplete.
  let sent = 0;
  let armed = true;
  let interruptSeen = false;
  let outputAfterInterrupt = false;
  let completesAfterBargeIn = 0;
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
 * native `@google/adk` `Event` stream of one Live session with a barge-in.
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
  yield* runLiveBargeIn({
    model: input.model,
    instruction: input.systemPrompt ?? "You are a helpful assistant. Answer at length.",
    prompt: input.prompt,
    bargeIn: input.adkLive.bargeIn,
    responseModality: input.adkLive.responseModality ?? "TEXT",
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  });
}
