import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import {
  reduce,
  Reducer,
  AgEvent,
  AgClosedEvent,
  AgReduceResult,
  AgInput,
  AgA2uiFunctionResponse,
  AgA2uiError,
  toWire,
  toJsonValue,
  AGJSON_VERSION,
  ingestAgEvents,
  readStoredAgMessage,
  readStoredAgMessages,
  readStoredAgMemoryRecords,
  checkAgInput,
} from "@silverprotocol/core";
import type { AgRecordReport } from "@silverprotocol/core";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@silverprotocol/core";
import { createAdkNormalizer, ADK_HOST_COMPLETE_TYPE } from "@silverprotocol/google-adk";
import { replayNatives, HOST_COMPLETE_MARKER } from "./replay.js";
import type { AdkEvent, AdkPart } from "@silverprotocol/google-adk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { createVercelNormalizer } from "@silverprotocol/vercel-ai";

// ─────────────────────────────────────────────────────────────────────────────
// §10 Conformance Suite (audit M55 — "§10 items are prose, zero executable
// fixtures — folklore-grade conformance").
//
// Home: packages/e2e, not core. This file needs BOTH the core reduce()/AgEvent
// surface (for the framework-neutral items) AND the facet normalizers
// (createAdkNormalizer / createOpenaiNormalizer) for the framework-scoped
// items — e2e is the one package in this workspace that already depends on
// core + all three facets (claude-agent-sdk, google-adk, openai-agents).
//
// Every SPEC.md §10 item gets exactly one disposition per leg. The item count
// is NOT hardcoded: the accounting test below reads the SDK's SPEC.md (the
// follower of protocol/SPEC.md, kept in lockstep by sync-spec.mjs --check) and
// derives N from §10's numbered items, so a new §10 item with no manifest row
// fails here instead of going silently unaccounted (item 21, draft.3, went
// unaccounted for three weeks while the count was pinned at 20).
//
//   RUNNABLE    a self-contained fixture below IS the proof of the claim.
//               Reduce-level event vectors for framework-neutral items;
//               facet-driven (createXNormalizer over a minimal native event
//               vector) for framework-scoped items.
//   COVERED-BY  the proof already lives in a named EXISTING test elsewhere
//               in this workspace; this file carries a thin confirming
//               re-assertion of the same claim + the file:line citation
//               (never a re-import or a duplicate of a big suite).
//   N/A         it.skip with the §8/§10 scoping citation: either the claim
//               needs an AgJSON→native emit/re-input surface this ingest-only
//               SDK does not ship (§10 preamble: "ingest-only normalizers
//               record them N/A"), or the claim is scoped to a framework
//               with no in-repo emitter (only claude-agent-sdk, google-adk,
//               openai-agents exist here — no LangChain/LangGraph/Pydantic-AI
//               facet).
//
// The manifest below accounts for every SPEC.md §10 item NUMBER 1–N, each by
// at least one manifest row. Items 4, 17 and 21 expand into lettered/named
// legs because SPEC.md's own item text splits their claims across sub-claims
// with different testability — "no item silently absent" is enforced per LEG,
// and the accounting test below asserts the union of item numbers is exactly
// the set of §10 item numbers SPEC.md declares.
// ─────────────────────────────────────────────────────────────────────────────

type Disposition = "RUNNABLE" | "COVERED-BY" | "N/A";

interface Section10Item {
  n: number; // SPEC.md §10 item number (1-N; N derived from SPEC.md, see the accounting test)
  leg?: string; // sub-leg label when the item's own text splits its claim
  title: string;
  disposition: Disposition;
  citation: string;
}

const SPEC_10_MANIFEST: Section10Item[] = [
  { n: 1, title: "reduce() invariant (full fold table + block insertion order)", disposition: "COVERED-BY", citation: "reduce.test.ts:2496-2599 \"R10 capstone\"" },
  { n: 2, title: "Reconnect (forward-gap park + snapshot-resync; backward jump folds normally)", disposition: "COVERED-BY", citation: "reduce.test.ts:1828-1953 (R9 e1-e6) + :1635-1828 (d1-d4)" },
  { n: 3, title: "Tool-result routing matrix (content/structuredContent/uiData/sideData): channel separation only — structuredContent is model-facing, delivery host-determined, model receipt not asserted (draft.4 E6)", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.3" },
  { n: 4, leg: "a", title: "Gemini signature loop — tool-call signature (ingest leg)", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.4(a), facet-driven via createAdkNormalizer" },
  { n: 4, leg: "b", title: "Gemini signature loop — thinking-only turn", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.4(b), facet-driven via createAdkNormalizer" },
  { n: 4, leg: "c", title: "Gemini signature loop — Google-Search-grounded turn", disposition: "N/A", citation: "§10 preamble emit/re-input carve-out; no built-in-tool-step signature carrier in google-adk" },
  { n: 4, leg: "openai", title: "OpenAI stateless reasoning loop (rs_/encrypted_content)", disposition: "N/A", citation: "§10 preamble emit/re-input carve-out (ingest-capture sub-claim already COVERED by openai-agents/src/index.test.ts:1694-1872 (reasoning_item_created) + :1893-2159 (OA-11, reasoning sourced from response.completed; the §10.4 stateless-replay fold order at :2042))" },
  { n: 5, title: "Source round-trips (MCP base64 + Anthropic url/file)", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.5" },
  { n: 6, title: "Mandatory display (display.required not dropped)", disposition: "COVERED-BY", citation: "reduce.test.ts:1049 \"(h) display.required appends…\"" },
  { n: 7, title: "safety_blocked category", disposition: "COVERED-BY", citation: "openai-agents/src/index.test.ts:816 \"content_filter incomplete…\"" },
  { n: 8, title: "Cumulative-usage verbatim fold (INV-DELTA)", disposition: "COVERED-BY", citation: "reduce.test.ts:791-826 (a) + :91 (b2)" },
  { n: 9, title: "ADK aggregate suppression", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.9, facet-driven via createAdkNormalizer" },
  { n: 10, title: "Index→id re-key (LangChain/Pydantic)", disposition: "N/A", citation: "no LangChain/Pydantic-AI facet in this repo" },
  { n: 11, title: "LangGraph positional pause", disposition: "N/A", citation: "no LangGraph facet in this repo" },
  { n: 12, title: "Interleaved subagent + parent", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.12, reduce-level" },
  { n: 13, title: "Replay-blob round-trips", disposition: "N/A", citation: "§10 preamble emit/re-input carve-out (ingest-capture sub-claim already COVERED by reduce.test.ts:280)" },
  { n: 14, title: "A2UI RPC round-trips (per-arm)", disposition: "COVERED-BY", citation: "agjson.test.ts:1003-1253 \"AgSurfaceInteraction\"" },
  { n: 15, title: "Gemini parallel ordering", disposition: "N/A", citation: "§10 preamble emit/re-input carve-out; §8 item 7 scoping" },
  { n: 16, title: "A2A initial-Task (no double-seed on artifact update)", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.16, reduce-level" },
  { n: 17, leg: "a", title: "Signature reassembly — reasoning.opaque.delta fragments", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.17(a), reduce-level" },
  { n: 17, leg: "b", title: "Signature reassembly — id-fragmented tool call (Pydantic)", disposition: "N/A", citation: "no Pydantic-AI facet in this repo" },
  { n: 18, title: "MCP MRTR requestState round-trip", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.18, wire/schema-level" },
  { n: 19, title: "A2UI component streaming", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.19, wire round-trip" },
  { n: 20, title: "Malformed input at a trust boundary", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.20" },
  { n: 21, leg: "fold", title: "Reasoning-inclusive usage identity — the Gemini fold (thoughts added; absent ⇒ draft.2 bytes; already-inclusive not double-added)", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.21(fold), facet-driven via createAdkNormalizer" },
  { n: 21, leg: "replay", title: "Reasoning-inclusive usage identity — input + output (+ toolUseInput) == total on every replay golden with a provider total", disposition: "COVERED-BY", citation: "replay.test.ts:331 assertUsageIdentity, run by all four replay suites (:380 claude, :417 openai, :456 adk, :491 vercel)" },
  { n: 22, title: "Forward-compatible ingest (draft.4): an ignored well-formed event occupies its seq slot, is reported in place, and the fold is unchanged", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.22, reference ingest (ingestAgEvents) → reduce" },
  { n: 23, leg: "adk", title: "Unmapped native value (draft.4): an ADK finish reason with no AgJSON target → finishReason other|unknown + finishReasonRaw verbatim; every event AgEvent-valid", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.23(adk) via createAdkNormalizer (sp-google a0c5dcf)" },
  { n: 23, leg: "openai", title: "Unmapped native value (draft.4): an OpenAI incomplete_details.reason with no AgJSON target → finishReason unknown + finishReasonRaw verbatim; every event AgEvent-valid", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.23(openai) via createOpenaiNormalizer (sp-openai OA-15 abd73cf)" },
  { n: 23, leg: "claude", title: "Unmapped native value (draft.4): an unmapped Claude stop_reason → finishReason unknown + finishReasonRaw verbatim; mapped and null stop_reasons carry no finishReasonRaw", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.23(claude) via createClaudeNormalizer (sp-claude 44938c2 / main's edb4cb5)" },
  { n: 23, leg: "vercel", title: "Unmapped native value (draft.4): a vercel finish whose unified reason falls back (other/unknown) carries the native rawFinishReason as finishReasonRaw", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.23(vercel) via createVercelNormalizer (probe c524ece)" },
  { n: 24, leg: "scan", title: "Tool-result errorText scoping (draft.4): no replay golden carries errorText on a non-error result", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.24(scan), a scan of every corpus/*/*.agjson.json" },
  { n: 24, leg: "adk", title: "ADK failure envelope (draft.4, §8.0 item 25): the error/denied/placeholder/negative vectors", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.24(adk) via createAdkNormalizer (sp-google 877f37f)" },
  { n: 25, leg: "fold", title: "Framework pause and completion closure (draft.4): pauses close paused from push(), completed-without-signal and cut-short invokes close turn.abort from flush(), never success, no park", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.25(fold) over the engine-built fixtures/adk-pause natives (probe P-RED 3c82c3a); step-1 scope mirrored by adk-pause.test.ts" },
  { n: 25, leg: "answer-id", title: "Framework pause and completion closure (draft.4): each ask's toolCallId is the adk_request_* call id (the answering id), one ask per pending request, kind per §8.0 item 26", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.25(answer-id) over fixtures/adk-pause (sp-google step 2 613fd7f)" },
  { n: 25, leg: "host-completion", title: "Framework pause and completion closure (draft.4): with the §8.0 obligation-4 host-completion event fed, a completed invoke closes turn.done success from push(); a pause still closes paused from push()", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.25(host-completion), createAdkNormalizer({ hostCompletion: true }) + ADK_HOST_COMPLETE_TYPE (sp-google step 2 613fd7f)" },
  { n: 25, leg: "replay", title: "Framework pause and completion closure (draft.4): a golden the normalizer closes on the framework's own events folds unchanged with and without the host-completion event; one it does not closes as obligation 4 directs with it and turn.abort from flush() without it", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.25(replay) over every corpus/*/adk golden, including the live Workflow seeds (probe b407060)" },
  { n: 26, leg: "fold", title: "Interim-narration marker (draft.4): phase folds set-if-present on text/reasoning start and end (end REPLACES, absent keeps), undocumented values verbatim, no-phase streams byte-identical to draft.3, INV-FOLD", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.26(fold), reference reduce() + Reducer (probe P-phase b52b8eb)" },
  { n: 26, leg: "vercel", title: "Interim-narration marker (draft.4): an OpenAI commentary text part opens phase 'interim'; final_answer / unknown / no bag → no phase; providerMetadata.phase kept verbatim", disposition: "COVERED-BY", citation: "vercel-ai/src/index.test.ts:1809-1840 'draft.4 phase' (commentary → text.start{phase:'interim'}; final_answer/unknown/no bag → no phase key) + :430-515 (commentary and final answer stay separate blocks, each bag verbatim) (probe b52b8eb)" },
  { n: 26, leg: "openai", title: "Interim-narration marker (draft.4): a commentary + final_answer response yields phase 'interim' on the first item's text.start only; null/\"\" yield neither phase nor providerMetadata.phase", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.26(openai) via createOpenaiNormalizer (sp-openai PH-2 d8d04ca)" },
  { n: 26, leg: "emit", title: "Interim-narration marker (draft.4): no phase in a native re-input payload", disposition: "N/A", citation: "§10 preamble emit/re-input carve-out: no facet in this repo ships an AgJSON→native emit surface" },
  { n: 27, leg: "fold", title: "Re-delivery never folds twice (draft.4): re-delivered seq, duplicate *.start id, delta/start into a sealed message or a closed turn, message.start into a closed turn (also across invokes; closure survives a 0-restart, a messages.snapshot clears it), second final tool.done → resync with the fold unchanged; a later invoke's 0-restart reusing a block id folds; a forward gap still parks", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.27(fold) (i)-(viii), (v-a)-(v-f), reference Reducer + reduce() (probe P14; the message.start guard reduce.ts 'a message.start for a turn that already closed parks')" },
  { n: 27, leg: "goldens", title: "Re-delivery never folds twice (draft.4): on every replay golden, block-creating *.start ids are unique within each invoke", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.27(goldens), a scan of every corpus/*/*.agjson.json" },
  { n: 27, leg: "producers", title: "Re-delivery never folds twice (draft.4): on every replay golden no message.start follows its turn's terminal; on every committed resume pair no turn or message id recurs across the two invokes, and the pair folds without a resync", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.27(producers), a scan of every corpus golden and every <scenario>-resume-<leg> pair" },
  { n: 28, title: "Host-appended events (draft.4): every replay golden plus a host-appended paused hitl.ask turn from lastSeq+1 folds with needsResync false and the turn in turns (§8.0 host obligation 5)", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.28 over every corpus/*/*.agjson.json via ingestAgEvents → reduce" },
  { n: 29, leg: "a", title: "Forward-compatible records: a stored AgMessage/AgMemoryRecord reader omits an unreadable content element or record, reports it with its index and verbatim value, never coerces, and the reports reconstruct the stored value", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.29(a) via core readStoredAgMessage(s)/readStoredAgMemoryRecords (probe P3 2bd1abf; unit legs core/src/record.test.ts)" },
  { n: 29, leg: "b", title: "Forward-compatible inputs: an input that fails the schema other than by an unknown field is rejected whole with one class and one path — protocol first, then version (major-mismatch), then the rest; malformed beats unknown-value; unknown fields pass intact", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.29(b) via core checkAgInput (probe P3 2bd1abf; unit legs core/src/input-check.test.ts)" },
  { n: 30, leg: "adk", title: "No credential material in authentication requests (draft.4): an ADK-generated OAuth2 request (state + nonce + PKCE in the authorization URI; client secret, tokens, verifier, auth code, standalone state/nonce seeded) emits no seeded secret at any depth, raw or JSON-escaped; state/nonce appear only inside the byte-equal ADK-issued authorization URI", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.30(adk) over fixtures/adk-pause/plain-credential-authuri (engine-built by ADK 2.1.0 generateAuthUri; probe)" },
  { n: 30, leg: "claude", title: "No credential material in authentication requests (draft.4)", disposition: "N/A", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 30, leg: "openai", title: "No credential material in authentication requests (draft.4)", disposition: "N/A", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 30, leg: "vercel", title: "No credential material in authentication requests (draft.4)", disposition: "N/A", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 31, leg: "adk", title: "Credential objects omitted from shared state (draft.4): credential-object entries (any depth, both spellings, whole AuthConfig, resourceRef-only, useDefaultCredential), temp: entries and an own __proto__ are omitted; one state.delta per native change ({} when empty); ordinary entries byte-identical; push() never throws", disposition: "COVERED-BY", citation: "google-adk/src/index.test.ts \"state.delta omits every entry holding an ADK credential …\", \"… snake_case form, a credential nested at any depth …\", \"… a whole ADK AuthConfig stored in state …\", \"… useDefaultCredential …\", \"… resourceRef …\", \"… exactly one event per native state change …\", \"state.delta never throws …\", \"a rebuilt state map carries no reserved key …\", \"negative control: a state delta with no ADK credential …\"" },
  { n: 31, leg: "claude", title: "Credential objects omitted from shared state (draft.4)", disposition: "N/A", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 31, leg: "openai", title: "Credential objects omitted from shared state (draft.4)", disposition: "N/A", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 31, leg: "vercel", title: "Credential objects omitted from shared state (draft.4)", disposition: "N/A", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 32, leg: "adk", title: "Credential material off provider-raw carries (draft.4): a typed ADK auth configuration as agentState.input, as output with its rendering, at output.result with its rendering and in customMetadata, and an untyped reply inside a response named adk_request_credential, leave no secret leaf raw or JSON-escaped; non-secret members byte-identical to the native; no text block from a rendering part; strict parse, no throw, no resync", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.32(adk) (unit legs google-adk/src/index.test.ts \"node data: …\", \"rendering: …\", \"every provider-raw carry reduces …\"; the full-carry reduction 46ee052)" },
  { n: 32, leg: "adk-goldens", title: "Credential material off provider-raw carries (draft.4): on every replay golden the rule changes no byte of the serialized stream", disposition: "COVERED-BY", citation: "probe serialized old-vs-new dumps over every corpus native + fixtures/adk-pause, with and without the host-completion marker: 92/92 byte-identical at 46ee052; §10.25(replay) keeps every ADK golden byte-equal" },
  { n: 32, leg: "claude", title: "Credential material off provider-raw carries (draft.4)", disposition: "N/A", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 32, leg: "openai", title: "Credential material off provider-raw carries (draft.4)", disposition: "N/A", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 32, leg: "vercel", title: "Credential material off provider-raw carries (draft.4)", disposition: "N/A", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 33, leg: "reference", title: "Ext segment reservation (draft.4): the reference SDK's normalizers (and core) emit only segments on §12's reserved list", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.33(reference): §12's reserved list parsed from SPEC.md vs every ext.<vendor> segment named in the packages' sources and found in every corpus golden" },
  { n: 33, leg: "third-party", title: "Ext segment reservation (draft.4): a normalizer outside the reference SDK emits no reserved segment unless the whole type is one the spec names", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.33(third-party): the collision rule over a table of third-party types, the spec-named carve-out included" },
  { n: 34, leg: "scan", title: "Partial-frame carry (draft.4): no replay golden carries an ext.anthropic.frame whose frame is a result frame, an assistant frame, a permission_denied notice, or a user frame whose every content block is a tool_result", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.34(scan) over every corpus/*/claude.agjson.json" },
  { n: 34, leg: "claude-refusal", title: "Partial-frame carry (draft.4): a Claude model_refusal_fallback frame yields its message.remove events, then exactly one ext.anthropic.frame{kind:\"model_refusal_fallback\"} deep-equal to the native frame", disposition: "COVERED-BY", citation: "claude-agent-sdk/src/index.test.ts \"carries the WHOLE fallback frame verbatim as ext.anthropic.frame{kind:model_refusal_fallback}, after its removes\" + \"the CLI's isSynthetic nudge rides ext.anthropic.frame{kind:'user'} verbatim …\"" },
  { n: 34, leg: "openai", title: "Partial-frame carry (draft.4)", disposition: "N/A", citation: "§8 item 22 applicability: the openai facet has no frame that maps only in part and rides ext.openai.frame" },
  { n: 34, leg: "adk", title: "Partial-frame carry (draft.4)", disposition: "N/A", citation: "§8 item 22 applicability: the google-adk facet has no frame that maps only in part and rides ext.google.frame" },
  { n: 34, leg: "vercel", title: "Partial-frame carry (draft.4)", disposition: "N/A", citation: "§8 item 22 applicability: the vercel-ai facet has no frame that maps only in part and rides ext.vercel.frame" },
  { n: 35, title: "Sealed-message finalizers and merges (draft.4): text.end / reasoning.end / reasoning.opaque / tool.args.assembled into a sealed message or any message of a closed turn park with the fold equal to the fold before them; the same events fold before the seal / terminal; message.metadata and turn.done{messageId, messageMetadata} naming a sealed message merge without parking", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.35 (reference reducer guard 648cecb; delta and block-creating legs: §10.27)" },
  { n: 36, leg: "claude", title: "Nested-turn closure (draft.4): for every subagent.start, exactly one turn.done|turn.error|turn.abort with that turnId, no usage, immediately before its subagent.done; no nested turnId equals a turn.start turnId; the fold without subagent.done is structurally identical", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.36 over every corpus golden with subagent.start (claude B-strict 7f315e2 + regen 5cdade3)" },
  { n: 36, leg: "openai", title: "Nested-turn closure (draft.4)", disposition: "N/A", citation: "§8.0 applicability: this facet emits no subagent.* (no nested turns)" },
  { n: 36, leg: "adk", title: "Nested-turn closure (draft.4)", disposition: "N/A", citation: "§8.0 applicability: this facet emits no subagent.* (no nested turns)" },
  { n: 36, leg: "vercel", title: "Nested-turn closure (draft.4)", disposition: "N/A", citation: "§8.0 applicability: this facet emits no subagent.* (no nested turns)" },
  { n: 37, title: "Shared-state fold (draft.4): an object patch replaces each top-level key whole ({cfg:{a:1,b:2}} then {cfg:{a:5}} → {cfg:{a:5}}); a null member is stored present; a scalar patch is a no-op without a resync; a JSON Patch array against no working copy sets needsResync", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.37, reference reduce() + Reducer (probe pkg-21 6e69589)" },
  { n: 38, leg: "adk", title: "ADK shared-state fixture (draft.4): the golden whose native stream rewrites part of an object-valued key folds to ADK's own session state, without a resync", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.38(adk): state-fold-gemini38, the committed golden and a fresh createAdkNormalizer replay of its native, vs adk.session-state.json (probe 7f3bce9; every sidecar also gated by replay.test.ts 'session-state sidecars')" },
  { n: 38, leg: "claude", title: "ADK shared-state fixture (draft.4)", disposition: "N/A", citation: "§10 item 38: the Claude Agent SDK has no key-addressed shared state" },
  { n: 38, leg: "openai", title: "ADK shared-state fixture (draft.4)", disposition: "N/A", citation: "§10 item 38: the OpenAI Agents SDK has no key-addressed shared state" },
  { n: 38, leg: "vercel", title: "ADK shared-state fixture (draft.4)", disposition: "N/A", citation: "§10 item 38: the Vercel AI SDK has no key-addressed shared state" },
  { n: 39, title: "Kept-open tool-result snapshot fold (draft.4): a later tool.done replaces the payload as a unit (omitted payload fields clear, uiData and structuredContent included), _meta/toolMetadata kept unless re-sent, providerMetadata merged by key, preliminary cleared; an error final clears an earlier structuredContent; a carried uiData:null is stored present", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.39, reference reduce() + Reducer (probe P1 6debaf1 + uiData flip c2ddfd2)" },
  { n: 40, leg: "sweep", title: "Flush honesty (draft.4): every prefix of every corpus native, flushed by its reference normalizer, emits only lifecycle closes, message.end, non-success terminals and ext carries (the carries before the terminals), never a success turn.done or content, and every opened turn folds to an outcome", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.40(sweep) over every corpus/*/<fw>.native.json via the four reference normalizers" },
  { n: 40, leg: "claude", title: "Flush honesty (draft.4): a Claude stream cut mid-turn with open text, reasoning and a partial tool call flushes content-free lifecycle closes only", disposition: "COVERED-BY", citation: "claude-agent-sdk/src/index.test.ts \"createClaudeNormalizer — C1: flush never mints content\" › \"leg (a): every flush() event is a content-free lifecycle close; …\"" },
  { n: 40, leg: "openai", title: "Flush honesty (draft.4): the approval interruption flushes exactly one turn.done{paused, asks:[approval_<callId>], usage U}; without the approval, turn.abort{stream-truncated} and a message.end carrying U", disposition: "COVERED-BY", citation: "openai-agents/src/index.test.ts \"createOpenaiNormalizer — O1 honest flush (fold/flush option 1)\" › the two \"§10.26 leg: …\" cases (the item's pre-landing number)" },
  { n: 41, title: "MCP Apps view locator carry (draft.4): every native tool result's MCP Apps _meta.ui reaches its tool.done's _meta.ui deep-equal", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.41: every corpus native carrying _meta.ui, replayed through its reference normalizer (claude, openai, adk)" },
  { n: 42, leg: "vercel", title: "Kept-open results are snapshots (draft.4): yield/yield/return and yield/throw emit full snapshots; the error final carries E's message and no structuredContent", disposition: "COVERED-BY", citation: "vercel-ai/src/index.test.ts \"§10 item 42 — kept-open results are snapshots (yield/yield/return, yield/throw)\" (probe a84fd65)" },
  { n: 42, leg: "single-delivery", title: "Kept-open results are snapshots (draft.4): claude, openai and adk never emit more than one tool.done per call, so they satisfy the item trivially", disposition: "RUNNABLE", citation: "spec-conformance.test.ts §10.42(single-delivery), a scan of every corpus/*/{claude,openai,adk}.agjson.json" },
];

// §10 item numbers as SPEC.md declares them: the numbered `N. **Title**` lines
// between the "## 10. Conformance" heading and the next "## " heading, read
// from the SDK's follower SPEC.md (sdks/typescript/SPEC.md — the copy the SDK
// mirror publishes; sync-spec.mjs --check keeps it byte-identical to
// protocol/SPEC.md).
function specSection10ItemNumbers(): number[] {
  const spec = readFileSync(new URL("../../../SPEC.md", import.meta.url), "utf8");
  const start = spec.indexOf("\n## 10. Conformance");
  if (start < 0) throw new Error("SPEC.md: no '## 10. Conformance' heading");
  const rest = spec.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const section = end < 0 ? rest : rest.slice(0, end);
  return Array.from(section.matchAll(/^(\d+)\. \*\*/gm), (m) => Number(m[1]));
}

describe("§10 conformance accounting (audit M55)", () => {
  it("SPEC.md §10 numbers its items 1..N with no gap or repeat (N derived, never pinned)", () => {
    const declared = specSection10ItemNumbers();
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual(Array.from({ length: declared.length }, (_, i) => i + 1));
  });

  it("covers every SPEC.md §10 item 1..N at least once, each row disposed RUNNABLE | COVERED-BY | N/A", () => {
    const declared = specSection10ItemNumbers();
    const nums = new Set(SPEC_10_MANIFEST.map((i) => i.n));
    expect(Array.from(nums).sort((a, b) => a - b)).toEqual(declared);
    for (const item of SPEC_10_MANIFEST) {
      expect(["RUNNABLE", "COVERED-BY", "N/A"]).toContain(item.disposition);
      expect(item.citation.length).toBeGreaterThan(0);
    }
  });
});

// Shared reduce-level event helpers (mirrors core/src/reduce.test.ts's own
// TURN_START/MSG_START convention).
const TURN_START = { type: "turn.start" as const, seq: 0, threadId: "th1", turnId: "t1" };
const MSG_START = {
  type: "message.start" as const,
  seq: 1,
  id: "m1",
  role: "assistant" as const,
  turnId: "t1",
  threadId: "th1",
};

// ─────────────────────────────────────────────────────────────────────────────
// §10.1 — reduce() invariant (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.1 — reduce() invariant: stream → reduce == AgReduceResult (full §5 fold table incl. block insertion order)", () => {
  it("COVERED-BY reduce.test.ts:2496-2599 \"reduce — R10 capstone\" (byte-identity against a hand-spelled EXPECTED_RESULT + interleaved-block-kind ordering over the FULL folding table); thin confirming re-assertion below", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      { type: "text.start", seq: 2, id: "b1", turnId: "t1" },
      { type: "text.delta", seq: 3, id: "b1", delta: "hi" },
      { type: "text.end", seq: 4, id: "b1" },
      { type: "reasoning.start", seq: 5, id: "b2", turnId: "t1" },
      { type: "reasoning.delta", seq: 6, id: "b2", delta: "thinking" },
      { type: "reasoning.end", seq: 7, id: "b2" },
      { type: "tool.start", seq: 8, toolCallId: "tc1", name: "calc", turnId: "t1", threadId: "th1" },
      { type: "tool.args.assembled", seq: 9, toolCallId: "tc1", input: { x: 1 } },
      { type: "turn.done", seq: 10, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
    ]).result;
    const content = r.messages[0]?.content ?? [];
    expect(content.map((b) => b.type)).toEqual(["text", "reasoning", "tool-call"]); // insertion order preserved
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  it("§5 message.start row (draft.4 editorial correction): threadId and every present extensions/candidateIndex/agentId/agentName/agentRole/noticeSource/model fold verbatim onto the AgMessage", () => {
    const r = reduce([
      TURN_START,
      { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1", candidateIndex: 0, extensions: ["urn:x-ext:a"], agentId: "ag1", agentName: "Planner", agentRole: "planner", model: "model-x" },
      { type: "message.end", seq: 2, id: "m1" },
      { type: "message.start", seq: 3, id: "m2", role: "notice", turnId: "t1", threadId: "th1", noticeSource: "host" },
      { type: "message.end", seq: 4, id: "m2" },
      { type: "turn.done", seq: 5, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
    ]);
    expect(r.needsResync).toBe(false);
    expect(r.result.messages[0]).toMatchObject({ id: "m1", threadId: "th1", candidateIndex: 0, extensions: ["urn:x-ext:a"], agentId: "ag1", agentName: "Planner", agentRole: "planner", model: "model-x" });
    expect(r.result.messages[1]).toMatchObject({ id: "m2", role: "notice", threadId: "th1", noticeSource: "host" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.2 — Reconnect (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.2 — Reconnect: stream-with-gap + messages.snapshot → reduce == AgReduceResult", () => {
  it("COVERED-BY reduce.test.ts:1828-1953 (R9 e1-e6 forward-gap/park/snapshot-recovery) + :1635-1828 (d1-d4 messages.snapshot conditional-replace); thin confirming re-assertion: forward gap parks, snapshot resyncs, backward jump (new-invoke 0-restart) folds normally", () => {
    const acc = new Reducer();
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" });
    acc.push({ type: "text.start", seq: 5, id: "b1", turnId: "t1" }); // forward gap (skipped seq 1-4)
    expect(acc.needsResync).toBe(true);
    acc.push({
      type: "messages.snapshot",
      seq: 6,
      messages: [{ id: "recovered", role: "assistant", content: [], turnId: "t1", threadId: "th1" }],
    });
    expect(acc.needsResync).toBe(false); // snapshot-resync clears the park

    // A backward seq jump — a new invoke's 0-restart — folds normally, no park.
    acc.push({ type: "turn.start", seq: 0, threadId: "th1", turnId: "t2" });
    expect(acc.needsResync).toBe(false);
    expect(acc.result().turns.find((t) => t.turnId === "t2")).toBeDefined();
  });

  it("(draft.4 amended item 2) a repeated or backward seq above 0 parks (seq 3 after lastSeq 7); only seq 0 lowers lastSeq", () => {
    const evs = [
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
      { type: "text.start", seq: 2, id: "b1", turnId: "t1" },
      ...[3, 4, 5, 6, 7].map((seq) => ({ type: "text.delta", seq, id: "b1", delta: String(seq) })),
    ].map((e) => AgEvent.parse(e));
    const prefix = reduce(evs);
    expect(prefix.needsResync).toBe(false);
    const back = reduce([...evs, AgEvent.parse({ type: "text.delta", seq: 3, id: "b1", delta: "again" })]);
    expect(back.needsResync).toBe(true);
    expect(back.result).toEqual(prefix.result);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.3 — Tool-result routing matrix (RUNNABLE)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.3 — tool-result routing matrix: content→model, structuredContent→model(structured), uiData→surface(model-hidden), sideData→app-only (SPEC §2.1)", () => {
  it("all four channels survive the fold independently, verbatim, with no cross-channel bleed", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      { type: "tool.start", seq: 2, toolCallId: "tc1", name: "search", turnId: "t1", threadId: "th1" },
      {
        type: "tool.done",
        seq: 3,
        toolCallId: "tc1",
        turnId: "t1",
        threadId: "th1",
        content: [{ type: "text", text: "3 results" }], // → model (content)
        structuredContent: { rows: [1, 2, 3] }, // → model, structured (structuredContent)
        uiData: { view: "table", rows: [1, 2, 3] }, // → surface/view, model-HIDDEN (uiData)
        sideData: { cacheKey: "internal-only" }, // → app-only (sideData)
        outcome: "ok",
      },
    ]).result;
    const block = r.messages[0]?.content[1];
    expect(block?.type).toBe("tool-result");
    if (block?.type === "tool-result") {
      expect(block.content).toEqual([{ type: "text", text: "3 results" }]);
      expect(block.structuredContent).toEqual({ rows: [1, 2, 3] });
      expect(block.uiData).toEqual({ view: "table", rows: [1, 2, 3] });
      expect(block.sideData).toEqual({ cacheKey: "internal-only" });
    }
    // Routing semantics (SPEC §2.1): reduce() has no "audience" flag — the
    // audience is ENCODED by which field a consumer reads. This fixture
    // proves the four channels are independently addressable and never
    // conflated (e.g. sideData never leaks into content/structuredContent).
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.4 — Gemini signature loop + OpenAI stateless reasoning loop (mixed)
// ─────────────────────────────────────────────────────────────────────────────

function adkEvent(parts: AdkPart[], extra: Partial<AdkEvent> = {}): AdkEvent {
  return { content: { role: "model", parts }, invocationId: "inv_s10_4", ...extra };
}

describe("§10.4 — Gemini signature loop + OpenAI stateless reasoning loop", () => {
  it("(a) a tool-call's thoughtSignature survives the ingest leg — functionCall part's thoughtSignature lands on the tool-call block's signature field (facet-driven via createAdkNormalizer)", () => {
    const n = createAdkNormalizer();
    const native = adkEvent([{ functionCall: { name: "echo", args: { x: 1 }, id: "adk-s10-4a" }, thoughtSignature: "SIG_TOOL_CALL" }], {
      partial: true,
    });
    const out = n.push(toJsonValue(native)).concat(n.flush());

    const r = new Reducer();
    for (const ev of out) r.push(ev);
    const block = r.result().messages[0]?.content.find((b) => b.type === "tool-call");
    expect(block?.type === "tool-call" && block.signature).toBe("SIG_TOOL_CALL");
  });

  it.skip(
    "(a-reinput) tool-call signature re-input leg — N/A: no facet in this repo ships an AgJSON→native emit/re-input surface (§10 preamble: \"ingest-only normalizers record them N/A\"; §8 item 7 scoping)",
    () => {},
  );

  it("(b) a thinking-only turn's thoughtSignature lands on the reasoning block's opaque carrier — message/reasoning-targeted, NOT tool-call-targeted (ingest leg; facet-driven via createAdkNormalizer)", () => {
    const n = createAdkNormalizer();
    const native = adkEvent([{ text: "pondering…", thought: true, thoughtSignature: "SIG_THINK_ONLY" }], {
      partial: true,
    });
    const out = n.push(toJsonValue(native)).concat(n.flush());
    const opaque = out.find((e) => e.type === "reasoning.opaque");
    expect(opaque).toMatchObject({ kind: "signature", value: "SIG_THINK_ONLY", provider: "google" });
    expect(out.find((e) => e.type === "tool.args.assembled")).toBeUndefined(); // NOT a tool-call target

    const r = new Reducer();
    for (const ev of out) r.push(ev);
    const block = r.result().messages[0]?.content.find((b) => b.type === "reasoning");
    expect(block?.type === "reasoning" && block.opaque?.value).toBe("SIG_THINK_ONLY");
    // Re-input (echoing this signature back to Gemini on turn N+1 to avoid a
    // 400) is OUT OF SCOPE for this ingest-only SDK — see legs (a)/(c) above.
  });

  it.skip(
    "(c) a Google-Search-grounded turn's signature survives emit→reduce→re-input — N/A: google-adk has no built-in-tool-step (google_search_call/result) signature carrier, and no facet in this repo ships a re-input surface (§10 preamble)",
    () => {},
  );

  it.skip(
    "(d) OpenAI stateless reasoning loop — N/A: the item's claim is emit→reduce→re-input survival; no facet in this repo ships an AgJSON→native emit/re-input surface (§10 preamble). The ingest-capture sub-claim (rs_ id + summary text + encrypted_content handling; exhaustive: no-summary, no-encrypted-content, late-arrival edge cases) is already COVERED by openai-agents/src/index.test.ts:1694-1872 (reasoning_item_created) + :1893-2159 (OA-11, reasoning sourced from response.completed; the §10.4 stateless-replay fold order at :2042)",
    () => {},
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.5 — Source round-trips (RUNNABLE)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.5 — source round-trips: MCP base64 and Anthropic url/file both survive (AgSource merge)", () => {
  it("an MCP base64 source and an Anthropic file source both fold byte-identical onto turn.sources[]", () => {
    const r = reduce([
      TURN_START,
      {
        type: "source",
        seq: 1,
        turnId: "t1",
        sourceId: "src-mcp",
        source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" },
      },
      {
        type: "source",
        seq: 2,
        turnId: "t1",
        sourceId: "src-anthropic",
        source: { type: "file", fileId: "file_abc123", mediaType: "application/pdf" },
      },
    ]).result;
    const turn = r.turns[0];
    expect(turn?.sourceIds).toEqual(["src-mcp", "src-anthropic"]);
    expect(turn?.sources?.[0]).toMatchObject({
      sourceId: "src-mcp",
      source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" },
    });
    expect(turn?.sources?.[1]).toMatchObject({
      sourceId: "src-anthropic",
      source: { type: "file", fileId: "file_abc123", mediaType: "application/pdf" },
    });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.6 — Mandatory display (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.6 — Mandatory display: a display.required event is not dropped (ToS)", () => {
  it("COVERED-BY reduce.test.ts:1049 \"(h) display.required appends to AgTurnRecord.displayRequired[]\"; thin confirming re-assertion", () => {
    const r = reduce([
      TURN_START,
      { type: "display.required", seq: 1, turnId: "t1", provider: "google", html: "<p>Required notice</p>" },
    ]).result;
    expect(r.turns[0]?.displayRequired).toEqual([{ provider: "google", html: "<p>Required notice</p>" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.7 — safety_blocked category (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.7 — safety_blocked category: finishReason:\"safety_blocked\" SHOULD carry populated safety[].category when the source provides it; MAY be empty otherwise", () => {
  it("COVERED-BY openai-agents/src/index.test.ts:816 \"content_filter incomplete → turn.done error outcome + safety (NOT turn.error)\" (facet-driven, createOpenaiNormalizer, proves the populated-category leg); thin schema-level confirming re-assertion that turn.done accepts BOTH shapes the spec sanctions", () => {
    // AgClosedEvent (not AgEvent) — discriminant narrowing on the plain
    // discriminatedUnion, avoiding the AgExtEvent.catchall(JsonValue) field
    // widening AgEvent carries (see agjson.ts's AgClosedEventType doc comment).
    const populated = AgClosedEvent.parse({
      type: "turn.done",
      seq: 1,
      turnId: "t1",
      outcome: { type: "error", message: "blocked" },
      finishReason: "safety_blocked",
      safety: [{ category: "content_filter", blocked: true }],
    });
    const bare = AgClosedEvent.parse({
      type: "turn.done",
      seq: 1,
      turnId: "t1",
      outcome: { type: "error", message: "blocked" },
      finishReason: "safety_blocked",
      safety: [],
    });
    expect(populated.type === "turn.done" && populated.safety?.[0]?.category).toBe("content_filter");
    expect(bare.type === "turn.done" && bare.safety).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.8 — Cumulative-usage verbatim fold (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.8 — cumulative-usage verbatim fold: a cumulative Anthropic usage stream folds with running totals preserved verbatim, cumulative:true intact (INV-DELTA)", () => {
  it("COVERED-BY reduce.test.ts:791-826 \"(a) turn.done sets finishReason/usage(verbatim)/safety/outcome\" + :91 \"(b2) message.end.usage lands verbatim\"; thin confirming re-assertion", () => {
    const r = reduce([
      TURN_START,
      {
        type: "turn.done",
        seq: 1,
        turnId: "t1",
        outcome: { type: "success" },
        finishReason: "stop",
        usage: { inputTokens: 500, outputTokens: 200, cumulative: true },
      },
    ]).result;
    // VERBATIM — nothing in the pipeline subtracts or de-cumulates.
    expect(r.turns[0]?.usage).toEqual({ inputTokens: 500, outputTokens: 200, cumulative: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.9 — ADK aggregate suppression (RUNNABLE, facet-driven)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.9 — ADK aggregate suppression: a partial:false aggregate re-send reduces without double-render", () => {
  it("a partial:true tool call followed by its partial:false aggregate re-send yields exactly ONE tool-call block", () => {
    const n = createAdkNormalizer();
    const fc: AdkPart = { functionCall: { name: "echo", args: { text: "hi" }, id: "adk-s10-9" } };
    const out = n
      .push(toJsonValue(adkEvent([fc], { partial: true, finishReason: "STOP" })))
      .concat(n.push(toJsonValue(adkEvent([fc], { partial: false, finishReason: "STOP" })))) // aggregate re-send
      .concat(n.flush());
    expect(out.filter((e) => e.type === "tool.start")).toHaveLength(1);

    const r = new Reducer();
    for (const ev of out) r.push(ev);
    const toolCalls = r.result().messages[0]?.content.filter((b) => b.type === "tool-call") ?? [];
    expect(toolCalls).toHaveLength(1); // no double-render through the fold
    expect(r.needsResync).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.10 / §10.11 — LangChain/Pydantic index→id re-key; LangGraph positional pause (N/A)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.10 — index→id re-key (LangChain/Pydantic index-keyed delta stream)", () => {
  it.skip(
    "N/A: no LangChain / Pydantic-AI facet exists in this repo (only claude-agent-sdk, google-adk, openai-agents)",
    () => {},
  );
});

describe("§10.11 — LangGraph positional pause (two interrupt()s in one node)", () => {
  it.skip("N/A: no LangGraph facet exists in this repo (only claude-agent-sdk, google-adk, openai-agents)", () => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.12 — Interleaved subagent + parent (RUNNABLE, reduce-level)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.12 — interleaved subagent + parent: an interleaved stream folds to the correct per-turn messages (each block routed by its event turnId)", () => {
  it("content interleaved between a parent turn and a nested subagent turn lands in the right per-turn message, never bleeding across turns", () => {
    const r = reduce([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "parent" },
      { type: "message.start", seq: 1, id: "m-parent", role: "assistant", turnId: "parent", threadId: "th1" },
      { type: "text.start", seq: 2, id: "b-parent-1", turnId: "parent" },
      { type: "text.delta", seq: 3, id: "b-parent-1", delta: "before subagent" },
      { type: "text.end", seq: 4, id: "b-parent-1" },
      { type: "subagent.start", seq: 5, turnId: "child", parentTurnId: "parent", agentName: "helper" },
      { type: "message.start", seq: 6, id: "m-child", role: "assistant", turnId: "child", threadId: "th1" },
      { type: "text.start", seq: 7, id: "b-child-1", turnId: "child" },
      { type: "text.delta", seq: 8, id: "b-child-1", delta: "subagent work" },
      { type: "text.end", seq: 9, id: "b-child-1" },
      { type: "subagent.done", seq: 10, turnId: "child", parentTurnId: "parent" },
      { type: "text.start", seq: 11, id: "b-parent-2", turnId: "parent" },
      { type: "text.delta", seq: 12, id: "b-parent-2", delta: "after subagent" },
      { type: "text.end", seq: 13, id: "b-parent-2" },
    ]).result;

    expect(r.turns).toHaveLength(2);
    const parentMsg = r.messages.find((m) => m.id === "m-parent");
    const childMsg = r.messages.find((m) => m.id === "m-child");
    expect(parentMsg?.content).toHaveLength(2);
    expect(childMsg?.content).toHaveLength(1);
    if (parentMsg?.content[0]?.type === "text") expect(parentMsg.content[0].text).toBe("before subagent");
    if (parentMsg?.content[1]?.type === "text") expect(parentMsg.content[1].text).toBe("after subagent");
    if (childMsg?.content[0]?.type === "text") expect(childMsg.content[0].text).toBe("subagent work");
    const childTurn = r.turns.find((t) => t.turnId === "child");
    expect(childTurn?.parentTurnId).toBe("parent");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.13 — Replay-blob round-trips (N/A)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.13 — replay-blob round-trips (Anthropic reasoning opaque, web-search encrypted_content, Pydantic CompactionPart, bare-key _meta / flat metadata)", () => {
  it.skip(
    "N/A: the item's claim is emit→reduce→re-input survival; no facet in this repo ships an AgJSON→native emit/re-input surface (§10 preamble: \"ingest-only normalizers record them N/A\"). The ingest-capture half of the opaque-value sub-claim (signature/redacted byte-identical through the fold) is already COVERED by reduce.test.ts:280 \"(b) reasoning.start + delta + opaque + end → reasoning block; opaque.value round-trips\"",
    () => {},
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.14 — A2UI RPC round-trips (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.14 — A2UI RPC round-trips (per-arm)", () => {
  it("COVERED-BY agjson.test.ts:1003-1253 \"AgSurfaceInteraction (§3 / §6 / §11.8 un-merge)\" (exhaustive per-arm schema coverage); thin confirming re-assertion of the specific §10.14 claims", () => {
    // callFunction → AgA2uiFunctionResponse round-trips BOTH functionCallId AND call.
    const fr = AgA2uiFunctionResponse.parse({
      surface: "a2ui",
      surfaceId: "s1",
      a2uiMessage: "function-response",
      functionCallId: "fc1",
      call: "getWeather",
      value: { temp: 72 },
    });
    expect(fr.functionCallId).toBe("fc1");
    expect(fr.call).toBe("getWeather");

    // AgA2uiError: both-fields and neither-fields shapes are REJECTED (upstream XOR).
    expect(() =>
      AgA2uiError.parse({
        surface: "a2ui",
        surfaceId: "s1",
        functionCallId: "fc1",
        a2uiMessage: "error",
        code: "SOME_ERROR",
        message: "boom",
      }),
    ).toThrow();
    expect(() =>
      AgA2uiError.parse({ surface: "a2ui", a2uiMessage: "error", code: "SOME_ERROR", message: "boom" }),
    ).toThrow();

    // VALIDATION_FAILED.path (JSON-Pointer) reaches ui.result.error.path (surface-scoped arm).
    const err = AgA2uiError.parse({
      surface: "a2ui",
      surfaceId: "s1",
      a2uiMessage: "error",
      code: "VALIDATION_FAILED",
      message: "bad value",
      path: "/form/field-a",
    });
    expect(err.path).toBe("/form/field-a");

    // The OpenAI callTool reply round-trips as ui.widget.result {surfaceId, callId, result}.
    const reply = AgEvent.parse({ type: "ui.widget.result", seq: 1, surfaceId: "s1", callId: "call1", result: "42" });
    expect(reply).toMatchObject({ type: "ui.widget.result", callId: "call1", result: "42" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.15 — Gemini parallel ordering (N/A)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.15 — Gemini parallel ordering: a 2-call parallel turn's grouped FC1,FC2,FR1,FR2 ordering survives emit→reduce→re-input", () => {
  it.skip(
    "N/A: the claim is specifically about the emit-side re-input ordering rule (§8 item 7 — group ALL tool-calls AHEAD of ALL tool-results when emitting to Gemini contents[]); no facet in this repo implements that re-input direction (§10 preamble)",
    () => {},
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.16 — A2A initial-Task (RUNNABLE, reduce-level)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.16 — A2A initial-Task: an initial Task carrying an artifact + a later artifact-update for the same artifactId yields exactly ONE artifact", () => {
  it("a seeded artifact followed by a LATER same-artifactId update (no second artifact.start) yields ONE artifact record with the seed preserved, not lost or duplicated", () => {
    const r = reduce([
      TURN_START,
      // ── initial Task snapshot: ONE artifact.start + seed parts ──
      { type: "artifact.start", seq: 1, artifactId: "art-a2a-1", turnId: "t1", threadId: "th1", name: "report" },
      {
        type: "artifact.delta",
        seq: 2,
        artifactId: "art-a2a-1",
        part: { type: "text", text: "initial section" },
        append: false,
      },
      { type: "artifact.end", seq: 3, artifactId: "art-a2a-1", lastChunk: true },
      // ── a LATER TaskArtifactUpdateEvent for the SAME artifactId — lands as an
      //    ADDITIONAL delta, never a second artifact.start (which would wipe
      //    parts[] — structurally identical to the ADK-aggregate hazard, §8
      //    item 11) ──
      {
        type: "artifact.delta",
        seq: 4,
        artifactId: "art-a2a-1",
        part: { type: "text", text: "updated section" },
        append: false,
      },
    ]).result;
    expect(r.artifacts).toHaveLength(1); // exactly ONE artifact, never a duplicate record
    const art = r.artifacts[0];
    expect(art?.artifactId).toBe("art-a2a-1");
    expect(art?.parts).toHaveLength(2); // the initial seed is NOT lost by the later update
    if (art?.parts[0]?.type === "text") expect(art.parts[0].text).toBe("initial section");
    if (art?.parts[1]?.type === "text") expect(art.parts[1].text).toBe("updated section");
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.17 — Signature reassembly (mixed)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.17 — signature reassembly", () => {
  it("(a) a 2-fragment reasoning.opaque.delta signature reassembles byte-identically (reduce-level, framework-neutral)", () => {
    const r = reduce([
      TURN_START,
      MSG_START,
      { type: "reasoning.start", seq: 2, id: "r1", turnId: "t1" },
      { type: "reasoning.opaque.delta", seq: 3, id: "r1", delta: "FRAG_ONE_" },
      { type: "reasoning.opaque.delta", seq: 4, id: "r1", delta: "FRAG_TWO" },
      { type: "reasoning.opaque", seq: 5, id: "r1", kind: "signature", value: "IGNORED_FALLBACK", provider: "google" },
    ]).result;
    const block = r.messages[0]?.content.find((b) => b.type === "reasoning");
    expect(block?.type === "reasoning" && block.opaque).toEqual({
      kind: "signature",
      value: "FRAG_ONE_FRAG_TWO", // scratch-buffer concatenation wins over the terminal event's own value
      provider: "google",
    });
    expect(() => AgReduceResult.parse(r)).not.toThrow();
  });

  it.skip(
    "(b) an id-fragmented tool call (Pydantic tool_name_delta/tool_call_id_delta) assembles to a single stable toolCallId — N/A: no Pydantic-AI facet in this repo",
    () => {},
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.18 — MCP MRTR requestState round-trip (RUNNABLE, wire/schema-level)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.18 — MCP MRTR: requestState survives emit→reduce→re-input byte-identical; resume is a fresh AgInput carrying the echoed requestState", () => {
  it("requestState on hitl.ask survives byte-identical into the echoed AgHitlAnswer inside a fresh AgInput{kind:resume} — a wire/schema-level round trip every implementation performs directly (AgInput is a first-party consumer contract, not a framework-specific emit surface, so it is NOT gated by the §10 preamble's emit-surface carve-out)", () => {
    const ask = AgEvent.parse({
      type: "hitl.ask",
      seq: 1,
      askId: "ask-mrtr-1",
      kind: "form",
      turnId: "t1",
      threadId: "th1",
      toolCallId: "tc1",
      requestState: "MRTR_OPAQUE_BLOB_DO_NOT_INSPECT",
      inputKey: "field-a",
    });
    if (ask.type !== "hitl.ask") throw new Error("expected hitl.ask");

    // The app echoes requestState BYTE-IDENTICAL — it MUST NOT inspect/decode it (SPEC §13).
    // The current spec version (never a pinned draft string, which went stale
    // at draft.1 through two bumps); same-major acceptance of an OLDER draft
    // is §12's rule and is not what this item tests.
    const resume = AgInput.parse({
      protocol: "agjson",
      version: AGJSON_VERSION,
      threadId: "th1",
      turnId: "t1",
      kind: "resume",
      answers: [
        {
          askId: ask.askId,
          status: "resolved",
          reply: { value: "user answer" },
          requestState: ask.requestState, // the echo
        },
      ],
    });
    if (resume.kind !== "resume") throw new Error("expected resume");
    expect(resume.answers?.[0]?.requestState).toBe("MRTR_OPAQUE_BLOB_DO_NOT_INSPECT");
    expect(resume.answers?.[0]?.requestState).toBe(ask.requestState); // byte-identical, not re-derived
  });

  it.skip(
    "live MCP re-input (the echoed requestState actually resuming a real MCP server call) is N/A — no facet in this repo consumes AgInput to drive a live MCP session",
    () => {},
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.19 — A2UI component streaming (RUNNABLE, wire round-trip)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.19 — A2UI component streaming: createSurface + updateComponents + updateDataModel + deleteSurface round-trips through ui.surface.* / ui.data-model, Layer-A opaque", () => {
  it("the streamed adjacency-list (incl. id:\"root\") and catalogId survive byte-identical through the JSON wire projection", () => {
    const components = [
      { id: "root", component: "Column", children: ["child-1"] },
      { id: "child-1", component: "Text", text: "hello" },
    ];
    const dataModel = { greeting: "hello" };

    const start = AgEvent.parse({
      type: "ui.surface.start",
      seq: 1,
      surfaceId: "s1",
      catalogId: "cat-a2ui-v1",
      components,
      dataModel,
      sendDataModel: true,
    });
    const update = AgEvent.parse({
      type: "ui.surface.update",
      seq: 2,
      surfaceId: "s1",
      components: [{ id: "child-1", component: "Text", text: "updated" }],
    });
    const dataModelPush = AgEvent.parse({
      type: "ui.data-model",
      seq: 3,
      surfaceId: "s1",
      path: "/greeting",
      value: "updated greeting",
    });
    const end = AgEvent.parse({ type: "ui.surface.end", seq: 4, surfaceId: "s1" });

    for (const ev of [start, update, dataModelPush, end]) {
      const wired = AgEvent.parse(toWire(ev));
      expect(wired).toEqual(ev); // byte-identical through the wire projection
    }
    if (start.type !== "ui.surface.start") throw new Error("expected ui.surface.start");
    expect(start.catalogId).toBe("cat-a2ui-v1"); // catalogId round-trips by reference
    expect(start.components).toEqual(components); // opaque payload verbatim, incl. id:"root"

    // These events are LIVE-ONLY / non-folding (SPEC §5/§9) — COVERED-BY
    // reduce.test.ts:1953 "(f) live-only events (…/ui.surface.start/…) produce
    // NO change" for the no-fold half of this claim (not re-asserted here).
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.20 — Malformed input at a trust boundary (RUNNABLE)
// ─────────────────────────────────────────────────────────────────────────────

// The baseline stream S of §10 items 20 and 22: turn.start(0), message.start(1),
// text.start/delta/end, message.end, turn.done. S_TAIL(n) starts the tail at seq n,
// so a frame inserted at seq 2 shifts the tail by one.
const S_HEAD: Array<Record<string, unknown>> = [
  { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
  { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
];
const S_TAIL = (n: number): Array<Record<string, unknown>> => [
  { type: "text.start", seq: n, id: "b1", turnId: "t1" },
  { type: "text.delta", seq: n + 1, id: "b1", delta: "hello" },
  { type: "text.end", seq: n + 2, id: "b1" },
  { type: "message.end", seq: n + 3, id: "m1" },
  { type: "turn.done", seq: n + 4, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
];

describe("§10.20 — malformed input at a trust boundary (draft.4): a non-envelope input is a typed error and occupies no seq slot; a well-formed envelope that fails validation is reported and not folded, and the stream folds as if it were absent", () => {
  it("(draft.4 amended item 20) a well-formed envelope that fails validation, mid-stream at seq 2, is reported in place and not folded, and the stream folds — resync false — to the same result as the stream with it removed and later seqs renumbered; a non-envelope input is a typed error (onReject) and advances nothing", () => {
    // Malformed per the AgEvent superRefine invariant (message.remove REMOVE_ALL
    // id="*" requires turnId). Schema-shape rejection itself stays COVERED-BY
    // agjson.test.ts ("rejects message.remove REMOVE_ALL ('*') without a turnId").
    const malformed = { type: "message.remove", seq: 2, id: "*" }; // missing turnId
    expect(AgEvent.safeParse(malformed).success).toBe(false);

    const withIt = ingestAgEvents([...S_HEAD, malformed, ...S_TAIL(3)] as unknown as JsonValue[]);
    const without = ingestAgEvents([...S_HEAD, ...S_TAIL(2)] as unknown as JsonValue[]);
    const ignored = withIt.filter((e) => e.type === "ext.agjson.ignored") as unknown as Array<Record<string, unknown>>;
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ seq: 2, ignoredType: "message.remove", raw: malformed });
    // The report is itself a well-formed event: a consumer that re-validates
    // ingest output strictly meets the stub first (sp-cto, P2 second read).
    expect(AgEvent.safeParse(ignored[0]).success).toBe(true);

    const a = reduce(withIt);
    const b = reduce(without);
    expect(a.needsResync).toBe(false);
    expect(a.result).toEqual(b.result);

    const rejects: Array<{ reason: string }> = [];
    const out = ingestAgEvents([[1, 2] as unknown as JsonValue], { onReject: (r) => rejects.push({ reason: r.reason }) });
    expect(out).toHaveLength(0);
    expect(rejects).toEqual([{ reason: "not-object" }]);
  });

  it("a VALID event carrying an own `__proto__` key is not silently skipped: the consumer ingest (ingestAgEvents) returns a plain event whose prototype the wire cannot choose, so no unvalidated field is inherited and the block folds (SPEC.md:759 'never a silent skip', :27 pass-through; core fix 7ede731)", () => {
    // JSON.parse keeps "__proto__" as an OWN data property, which is the shape
    // a wire frame arrives in. An inherited `transient: true` would make
    // reduce() skip the content.block (reduce.ts `if (ev.transient === true)`).
    const wire = JSON.parse(
      "[" +
        '{"type":"turn.start","seq":0,"threadId":"th1","turnId":"t1"},' +
        '{"type":"message.start","seq":1,"id":"m1","role":"assistant","turnId":"t1","threadId":"th1"},' +
        '{"type":"content.block","seq":2,"turnId":"t1","block":{"type":"text","text":"kept"},"__proto__":{"transient":true}},' +
        '{"type":"message.end","seq":3,"id":"m1"}' +
        "]",
    ) as JsonValue[];
    expect(Object.prototype.hasOwnProperty.call(wire[2], "__proto__")).toBe(true); // the hazard is really on the wire

    const events = ingestAgEvents(wire);
    expect(events).toHaveLength(4);
    const block = events[2] as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(block)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(block, "__proto__")).toBe(false);
    expect(block["transient"]).toBeUndefined();

    const { result, needsResync } = reduce(events);
    expect(needsResync).toBe(false);
    expect(result.messages[0]?.content).toEqual([expect.objectContaining({ type: "text", text: "kept" })]);
  });

  it("unknown fields pass through at EVERY depth, not only the top level (SPEC.md:27 'pass unknown fields through untouched'; core fix 4070b81, workspace#20 stage 1): nested unknown keys survive ingest into the fold", () => {
    const wire = JSON.parse(
      "[" +
        '{"type":"turn.start","seq":0,"threadId":"th1","turnId":"t1"},' +
        '{"type":"message.start","seq":1,"id":"m1","role":"assistant","turnId":"t1","threadId":"th1"},' +
        '{"type":"content.block","seq":2,"turnId":"t1","block":{"type":"text","text":"x","zzKey":"k"}},' +
        '{"type":"message.end","seq":3,"id":"m1"},' +
        '{"type":"turn.done","seq":4,"turnId":"t1","outcome":{"type":"success"},"finishReason":"stop",' +
        '"usage":{"inputTokens":1,"outputTokens":2,"zzCounter":7,"byModel":{"m":{"inputTokens":1,"zzPerModel":9}}}}' +
        "]",
    ) as JsonValue[];

    const events = ingestAgEvents(wire);
    expect(events).toHaveLength(5);
    const block = (events[2] as unknown as { block: Record<string, unknown> }).block;
    expect(block["zzKey"]).toBe("k"); // depth 2
    const usage = (events[4] as unknown as { usage: Record<string, unknown> }).usage;
    expect(usage["zzCounter"]).toBe(7); // depth 2
    expect((usage["byModel"] as Record<string, Record<string, unknown>>)["m"]?.["zzPerModel"]).toBe(9); // depth 4

    const { result, needsResync } = reduce(events);
    expect(needsResync).toBe(false);
    expect((result.messages[0]?.content[0] as unknown as Record<string, unknown>)["zzKey"]).toBe("k");
    expect((result.turns[0]?.usage as unknown as Record<string, unknown>)["zzCounter"]).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.21 — Reasoning-inclusive usage identity (draft.3)
// (fold leg RUNNABLE, facet-driven; replay leg COVERED-BY replay.test.ts:331)
// ─────────────────────────────────────────────────────────────────────────────

function adkUsageTurn(usageMetadata: NonNullable<AdkEvent["usageMetadata"]>): Record<string, unknown> | undefined {
  const n = createAdkNormalizer();
  const native = adkEvent([{ text: "x" }], { finishReason: "STOP", usageMetadata });
  const out = n.push(toJsonValue(native)).concat(n.flush());
  const done = out.find((e) => e.type === "turn.done");
  return done?.type === "turn.done" ? (done.usage as Record<string, unknown> | undefined) : undefined;
}

describe("§10.21 — reasoning-inclusive usage identity (draft.3)", () => {
  it("(fold) the spec's literal example folds as written: {109, 22, 125, 256} → inputTokens 109, outputTokens 147, reasoningTokens 125, totalTokens 256", () => {
    const usage = adkUsageTurn({ promptTokenCount: 109, candidatesTokenCount: 22, thoughtsTokenCount: 125, totalTokenCount: 256 });
    expect(usage).toMatchObject({ inputTokens: 109, outputTokens: 147, reasoningTokens: 125, totalTokens: 256 });
  });

  it("(fold) the same object without thoughtsTokenCount folds byte-identically to draft.2: outputTokens = candidatesTokenCount, no reasoningTokens key", () => {
    const usage = adkUsageTurn({ promptTokenCount: 109, candidatesTokenCount: 22, totalTokenCount: 131 });
    expect(usage).toMatchObject({ inputTokens: 109, outputTokens: 22, totalTokens: 131 });
    expect(usage !== undefined && "reasoningTokens" in usage).toBe(false);
  });

  it("(fold) an already-inclusive shape (prompt + candidates == total with thoughtsTokenCount > 0) is NOT double-added", () => {
    const usage = adkUsageTurn({ promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 30, totalTokenCount: 150 });
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 50, reasoningTokens: 30, totalTokens: 150 });
  });

  it("(replay) COVERED-BY replay.test.ts:331 assertUsageIdentity on every replay golden (all four suites: :380, :417, :456, :491); thin confirming re-assertion of the identity on the folded example", () => {
    const usage = adkUsageTurn({ promptTokenCount: 109, candidatesTokenCount: 22, thoughtsTokenCount: 125, totalTokenCount: 256 });
    const num = (k: string): number => (typeof usage?.[k] === "number" ? (usage[k] as number) : Number.NaN);
    const toolUse = typeof usage?.["toolUseInputTokens"] === "number" ? (usage["toolUseInputTokens"] as number) : 0;
    expect(num("inputTokens") + num("outputTokens") + toolUse).toBe(num("totalTokens"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.0 INV-MSG — a straggler delta into a sealed message parks (SPEC.md:745)
// Contract case for core 7853259 (conformance, no bar). Scope is the literal
// text: "a block-creating or delta event targeting a sealed message ... is a
// reduce()-error → snapshot-resync, never a silent attach". The four
// block-finalizing events (text.end, reasoning.end, reasoning.opaque,
// tool.args.assembled) and the closed-turn half are asserted by §10.35 below.
// ─────────────────────────────────────────────────────────────────────────────

describe("§5.0 INV-MSG — a delta event into a sealed message is a reduce()-error → resync, never a silent attach (SPEC.md:745)", () => {
  const open = [
    { type: "turn.start" as const, seq: 0, threadId: "th1", turnId: "t1" },
    { type: "message.start" as const, seq: 1, id: "m1", role: "assistant" as const, turnId: "t1", threadId: "th1" },
  ];
  const cases: Array<{ name: string; opener: Record<string, unknown>; delta: Record<string, unknown> }> = [
    { name: "text.delta", opener: { type: "text.start", id: "b1", turnId: "t1" }, delta: { type: "text.delta", id: "b1", delta: "late" } },
    { name: "reasoning.delta", opener: { type: "reasoning.start", id: "r1", turnId: "t1" }, delta: { type: "reasoning.delta", id: "r1", delta: "late" } },
    { name: "reasoning.opaque.delta", opener: { type: "reasoning.start", id: "r1", turnId: "t1" }, delta: { type: "reasoning.opaque.delta", id: "r1", delta: "late" } },
    { name: "tool.args.delta", opener: { type: "tool.start", toolCallId: "c1", name: "echo", turnId: "t1" }, delta: { type: "tool.args.delta", toolCallId: "c1", delta: "{}" } },
  ];

  for (const c of cases) {
    it(`${c.name} after message.end parks (needsResync true); the same delta before message.end folds cleanly`, () => {
      const sealedFirst = [...open, { ...c.opener, seq: 2 }, { type: "message.end", seq: 3, id: "m1" }, { ...c.delta, seq: 4 }].map((e) => AgEvent.parse(e));
      expect(reduce(sealedFirst).needsResync).toBe(true);

      const openFirst = [...open, { ...c.opener, seq: 2 }, { ...c.delta, seq: 3 }, { type: "message.end", seq: 4, id: "m1" }].map((e) => AgEvent.parse(e));
      expect(reduce(openFirst).needsResync).toBe(false);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.22 — Forward-compatible ingest (draft.4) (RUNNABLE, reference ingest → reduce)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.22 — forward-compatible ingest (draft.4): an ignored well-formed event occupies its seq slot, is reported in place as ext.agjson.ignored, and the fold equals the fold of S", () => {
  const cases: Array<{ name: string; x: Record<string, unknown> }> = [
    { name: "(a) an undefined event type named per §0.3 (zz.start)", x: { type: "zz.start", seq: 2 } },
    { name: "(a') an event whose final segment is outside §0.3's closed set (zz.probe)", x: { type: "zz.probe", seq: 2 } },
    { name: "(b) reasoning.start with an unknown mode", x: { type: "reasoning.start", seq: 2, id: "r1", turnId: "t1", mode: "zz" } },
    { name: "(c) content.block whose block type is unknown", x: { type: "content.block", seq: 2, turnId: "t1", block: { type: "zz" } } },
    { name: "(d) tool.done with an unknown outcome", x: { type: "tool.done", seq: 2, toolCallId: "c1", content: [], outcome: "zz" } },
    { name: "(e) message.remove with id '*' and no turnId", x: { type: "message.remove", seq: 2, id: "*" } },
  ];
  const foldS = reduce(ingestAgEvents([...S_HEAD, ...S_TAIL(2)] as unknown as JsonValue[]));

  for (const c of cases) {
    it(`${c.name}: resync false, fold equals S, exactly one ignored report at seq 2 carrying the frame verbatim`, () => {
      const out = ingestAgEvents([...S_HEAD, c.x, ...S_TAIL(3)] as unknown as JsonValue[]);
      const ignored = out.filter((e) => e.type === "ext.agjson.ignored") as unknown as Array<Record<string, unknown>>;
      expect(ignored).toHaveLength(1);
      expect(ignored[0]).toMatchObject({ seq: 2, ignoredType: c.x["type"] });
      expect(ignored[0]?.["raw"]).toEqual(c.x);
      expect(AgEvent.safeParse(ignored[0]).success).toBe(true);
      const r = reduce(out);
      expect(r.needsResync).toBe(false);
      expect(r.result).toEqual(foldS.result);
    });
  }

  it("nested pass-through: an unknown key inside turn.done.usage survives into the fold", () => {
    const tail = S_TAIL(2);
    (tail[4] as Record<string, unknown>)["usage"] = { inputTokens: 1, outputTokens: 2, zzCounter: 7 };
    const r = reduce(ingestAgEvents([...S_HEAD, ...tail] as unknown as JsonValue[]));
    expect((r.result.turns[0]?.usage as unknown as Record<string, unknown>)["zzCounter"]).toBe(7);
  });

  it("controls: a seq jump of 5 still parks; non-envelope inputs go to onReject and advance nothing; an own __proto__ key does not select the prototype (§13.7)", () => {
    const jumped = [...S_HEAD, ...S_TAIL(7)];
    expect(reduce(ingestAgEvents(jumped as unknown as JsonValue[])).needsResync).toBe(true);

    const reasons: string[] = [];
    const out = ingestAgEvents(["x", { type: 5, seq: 2 }, { type: "zz.start" }] as unknown as JsonValue[], { onReject: (r) => reasons.push(r.reason) });
    expect(out).toHaveLength(0);
    expect(reasons).toEqual(["not-object", "type-not-string", "seq-not-number"]);

    const proto = JSON.parse('{"type":"zz.start","seq":2,"__proto__":{"transient":true}}') as JsonValue;
    const ignored = ingestAgEvents([proto])[0] as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(ignored)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(ignored["raw"] as object, "__proto__")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.24 — Tool-result error scoping (draft.4)
// (scan leg RUNNABLE; ADK leg N/A-pending the google-adk item-25 flip)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.24 — tool-result errorText scoping (draft.4): on every replay golden, no tool.done carries errorText unless its outcome is error", () => {
  it("(scan) every corpus/*/*.agjson.json: count of tool.done events with errorText and outcome !== 'error' is 0", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    let files = 0;
    const violations: string[] = [];
    for (const dir of readdirSync(corpus)) {
      for (const fw of ["claude", "openai", "adk", "vercel"]) {
        const f = new URL(`${dir}/${fw}.agjson.json`, corpus);
        if (!existsSync(f)) continue;
        files++;
        const events = JSON.parse(readFileSync(f, "utf8")) as Array<Record<string, unknown>>;
        events.forEach((e, i) => {
          if (e["type"] === "tool.done" && "errorText" in e && e["outcome"] !== "error") violations.push(`${dir}/${fw}[${i}]`);
        });
      }
    }
    expect(files).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.25 — Framework pause and completion closure (draft.4; §8.0 item 26 +
// host obligation 4). The fold leg is RUNNABLE at google-adk step-1 scope over
// the REAL-engine fixtures (probe P-RED); the answer-id, host-completion and
// replay legs are N/A-pending sp-google's step 2 (manifest rows above).
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.25 — framework pause and completion closure (draft.4): a pause closes paused from push(), an invoke without the completion signal or cut short closes turn.abort from flush(), never success; no park", () => {
  const DIR = new URL("../fixtures/adk-pause/", import.meta.url);
  const TERMINALS = new Set(["turn.done", "turn.error", "turn.abort"]);
  type Tagged = { ev: AgEvent; from: "push" | "flush" };
  const natives = (name: string): JsonValue[] => JSON.parse(readFileSync(new URL(`${name}.native.json`, DIR), "utf8")) as JsonValue[];
  const runOne = (name: string, hostCompletion: boolean, out: Tagged[]): void => {
    const n = createAdkNormalizer(hostCompletion ? { hostCompletion: true } : {}); // one Normalizer per invoke (§8.0 obligation 3)
    for (const f of natives(name)) for (const ev of n.push(f as unknown as AdkEvent)) out.push({ ev, from: "push" });
    // §8.0 obligation 4: the host feeds the completion event after a normal return, before flush().
    if (hostCompletion) for (const ev of n.push({ type: ADK_HOST_COMPLETE_TYPE } as unknown as AdkEvent)) out.push({ ev, from: "push" });
    for (const ev of n.flush()) out.push({ ev, from: "flush" });
  };
  const run = (...names: string[]): Tagged[] => {
    const out: Tagged[] = [];
    for (const name of names) runOne(name, false, out);
    return out;
  };
  const runCompleted = (name: string): Tagged[] => {
    const out: Tagged[] = [];
    runOne(name, true, out);
    return out;
  };
  const turnOf = (ev: AgEvent): string | undefined => (ev as { turnId?: string }).turnId;
  const assertClosure = (tagged: Tagged[]): Tagged[] => {
    expect(reduce(tagged.map((t) => t.ev)).needsResync).toBe(false);
    const opened = new Set(tagged.filter((t) => t.ev.type === "turn.start").map((t) => turnOf(t.ev)));
    const terms = tagged.filter((t) => TERMINALS.has(t.ev.type));
    for (const id of opened) expect(terms.filter((t) => turnOf(t.ev) === id)).toHaveLength(1);
    const closed = new Set<string>();
    for (const t of tagged) {
      const id = turnOf(t.ev);
      if (id !== undefined) expect(closed.has(id), `${t.ev.type} after ${id}'s terminal`).toBe(false);
      if (TERMINALS.has(t.ev.type) && id !== undefined) closed.add(id);
    }
    return terms;
  };

  const PAUSE = ["wf-pause", "plain-confirmation", "plain-credential", "plain-request-input", "wf-functionnode-credential"];
  const COMPLETED = ["wf-complete", "wf-terminal-llm", "wf-functionnode-only"];
  for (const name of PAUSE) {
    it(`${name}: turn.done {outcome:"paused", finishReason:"paused"} from push(), one ask per pending request`, () => {
      const tagged = run(name);
      const [term] = assertClosure(tagged);
      expect(term).toMatchObject({ from: "push", ev: { type: "turn.done", finishReason: "paused", outcome: { type: "paused" } } });
      const asks = (term!.ev as { outcome: { asks?: unknown[] } }).outcome.asks ?? [];
      expect(asks).toHaveLength(tagged.filter((t) => t.ev.type === "hitl.ask").length);
      expect(asks.length).toBeGreaterThan(0);
    });
  }

  for (const name of [...COMPLETED, "truncated-after-classify", "truncated-after-spike-final"]) {
    it(`${name}: without the completion signal (or cut short) closes turn.abort from flush(), never success`, () => {
      const tagged = run(name);
      const [term] = assertClosure(tagged);
      expect(term).toMatchObject({ from: "flush", ev: { type: "turn.abort" } });
      expect(tagged.some((t) => t.ev.type === "turn.done" && (t.ev as { outcome?: { type?: string } }).outcome?.type === "success")).toBe(false);
    });
  }

  it("the pause and its resume (two invokes, one Normalizer each) fold together without a park; the resume is its own turn", () => {
    const tagged = run("wf-pause-resume.invoke1", "wf-pause-resume.invoke2");
    const terms = assertClosure(tagged);
    expect(terms.map((t) => [t.ev.type, t.from])).toEqual([["turn.done", "push"], ["turn.abort", "flush"]]);
    expect(new Set(terms.map((t) => turnOf(t.ev))).size).toBe(2);
  });

  // answer-id leg (§8.0 item 26): one ask per pending adk_request_* call, toolCallId = that call's id, kind per the family.
  const reservedCalls = (v: unknown, acc: Map<string, { name: string; args: Record<string, unknown> }> = new Map()) => {
    if (Array.isArray(v)) v.forEach((x) => reservedCalls(x, acc));
    else if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const fc = o["functionCall"] as { id?: string; name?: string; args?: Record<string, unknown> } | undefined;
      if (fc && typeof fc.name === "string" && fc.name.startsWith("adk_request_") && typeof fc.id === "string") acc.set(fc.id, { name: fc.name, args: fc.args ?? {} });
      Object.values(o).forEach((x) => reservedCalls(x, acc));
    }
    return acc;
  };
  const kindFor = (c: { name: string; args: Record<string, unknown> }): string => {
    if (c.name === "adk_request_credential") return "auth";
    if (c.name === "adk_request_confirmation") return "approval";
    const schema = c.args["response_schema"] ?? c.args["responseSchema"];
    return schema !== null && typeof schema === "object" ? "form" : "text";
  };
  for (const name of PAUSE) {
    it(`(answer-id) ${name}: one hitl.ask per pending adk_request_* call; toolCallId is that call's id; kind per §8.0 item 26; the paused asks[] name the same ids`, () => {
      const reserved = reservedCalls(natives(name));
      expect(reserved.size).toBeGreaterThan(0);
      const tagged = run(name);
      const asks = tagged.filter((t) => t.ev.type === "hitl.ask").map((t) => t.ev as unknown as { toolCallId?: string; kind: string });
      expect(asks.map((a) => a.toolCallId).sort()).toEqual([...reserved.keys()].sort());
      for (const a of asks) expect(a.kind, a.toolCallId).toBe(kindFor(reserved.get(a.toolCallId!)!));
      const [term] = assertClosure(tagged);
      const paused = ((term!.ev as { outcome: { asks?: Array<{ toolCallId?: string }> } }).outcome.asks ?? []).map((a) => a.toolCallId).sort();
      expect(paused).toEqual([...reserved.keys()].sort());
    });
  }

  // host-completion leg (§8.0 host obligation 4): with the completion event fed after the natives and before flush().
  for (const name of PAUSE) {
    it(`(host-completion) ${name}: with the completion event fed, a pause still closes paused from push()`, () => {
      const [term] = assertClosure(runCompleted(name));
      expect(term).toMatchObject({ from: "push", ev: { type: "turn.done", finishReason: "paused", outcome: { type: "paused" } } });
    });
  }
  for (const name of COMPLETED) {
    // The engine-built fixtures come from a stub model with no usageMetadata, so usage is not asserted here;
    // the replay leg below proves a sentinel-fed close equals each golden's close, usage included.
    it(`(host-completion) ${name}: with the completion event fed, the completed invoke closes turn.done success from push()`, () => {
      const [term] = assertClosure(runCompleted(name));
      expect(term).toMatchObject({ from: "push", ev: { type: "turn.done", outcome: { type: "success" } } });
    });
  }

  // replay leg: a golden whose run ends on an in-band terminal folds unchanged with and without the
  // completion event; a golden whose run has none (a live Workflow) closes turn.done from push() with
  // the event and turn.abort from flush() without it. "In-band" is read mechanically: replayed without
  // the event, the run's close is not the flush abort.
  it("(replay) every corpus/*/adk golden: in-band close → unchanged with and without the event; no in-band terminal → done with it, abort without it", async () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const closes = (agjson: JsonValue[]) =>
      (agjson as Array<{ type: string; outcome?: { type: string } }>).filter((e) => TERMINALS.has(e.type)).map((e) => (e.type === "turn.done" ? `done:${e.outcome?.type}` : e.type));
    let inBand = 0;
    let markerClosed = 0;
    for (const dir of readdirSync(corpus)) {
      const nat = new URL(`${dir}/adk.native.json`, corpus);
      if (!existsSync(nat)) continue;
      const recorded = JSON.parse(readFileSync(nat, "utf8")) as JsonValue[];
      const last = recorded[recorded.length - 1] as { type?: string } | undefined;
      const bare = last?.type === HOST_COMPLETE_MARKER ? recorded.slice(0, -1) : recorded;
      const plain = await replayNatives(bare, "adk");
      const marked = await replayNatives([...bare, { type: HOST_COMPLETE_MARKER } as JsonValue], "adk");
      if (!closes(plain.agjson).includes("turn.abort")) {
        inBand++;
        expect(JSON.stringify(marked.agjson), dir).toBe(JSON.stringify(plain.agjson));
      } else {
        markerClosed++;
        expect(closes(plain.agjson), dir).toEqual(["turn.abort"]);
        // Obligation 4's three branches with the event fed: paused (an ask pending) or success (nothing
        // pending) close turn.done from push(); a pending long-running call leaves the turn to flush().
        // The third branch is accepted only when a call really is pending: a tool.start with no tool.done.
        const markedClose = closes(marked.agjson)[0];
        if (markedClose === "turn.abort") {
          const evs = marked.agjson as Array<{ type: string; toolCallId?: string }>;
          const done = new Set(evs.filter((e) => e.type === "tool.done").map((e) => e.toolCallId));
          expect(evs.some((e) => e.type === "tool.start" && !done.has(e.toolCallId)), `${dir}: left to flush with no pending call`).toBe(true);
        } else {
          expect(markedClose, dir).toMatch(/^done:/);
        }
        // a marker-closed success keeps the run's usage (live receipt: workflow-complete-gemini38)
        const done = (marked.agjson as Array<Record<string, unknown>>).find((e) => e["type"] === "turn.done");
        if ((done?.["outcome"] as { type?: string } | undefined)?.type === "success") expect(done?.["usage"], dir).toBeDefined();
      }
    }
    expect(inBand).toBeGreaterThan(0);
    expect(markerClosed).toBeGreaterThan(0); // the live Workflow seeds (probe b407060) exercise the no-in-band case
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.26 — Interim-narration marker `phase` (draft.4; §8.0 item 27). Fold leg
// RUNNABLE against the reference reduce(); producer legs per the manifest.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.26 — interim-narration marker (draft.4): phase folds set-if-present, *.end replaces, absent keeps, unknown values verbatim, no-phase streams unchanged", () => {
  const head = [
    { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
    { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
  ];
  const tail = (seq: number) => [
    { type: "message.end", seq, id: "m1" },
    { type: "turn.done", seq: seq + 1, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
  ];
  const text = (start: Record<string, unknown>, end: Record<string, unknown>) => [
    ...head,
    { type: "text.start", seq: 2, id: "b1", turnId: "t1", ...start },
    { type: "text.delta", seq: 3, id: "b1", delta: "checking the docs" },
    { type: "text.end", seq: 4, id: "b1", ...end },
    ...tail(5),
  ];
  const reasoning = (start: Record<string, unknown>, end: Record<string, unknown>) => [
    ...head,
    { type: "reasoning.start", seq: 2, id: "r1", turnId: "t1", ...start },
    { type: "reasoning.delta", seq: 3, id: "r1", delta: "narration" },
    { type: "reasoning.end", seq: 4, id: "r1", ...end },
    ...tail(5),
  ];
  const fold = (evs: Array<Record<string, unknown>>) => {
    const parsed = evs.map((e) => AgEvent.parse(e));
    const batch = reduce(parsed);
    const live = new Reducer();
    for (const e of parsed) live.push(e);
    expect(batch.needsResync).toBe(false);
    expect(live.result()).toEqual(batch.result); // (f) INV-FOLD: incremental == batch
    return batch.result.messages[0]!.content[0] as Record<string, unknown>;
  };

  it("(a) text.start{phase:'interim'} → text.delta → text.end{} folds phase 'interim'", () => {
    expect(fold(text({ phase: "interim" }, {}))["phase"]).toBe("interim");
  });
  it("(b) reasoning.start{} → reasoning.delta → reasoning.end{phase:'interim'} folds phase 'interim'", () => {
    expect(fold(reasoning({}, { phase: "interim" }))["phase"]).toBe("interim");
  });
  it("(c) a start value survives a phase-less end; a present end value REPLACES it", () => {
    expect(fold(reasoning({ phase: "interim" }, {}))["phase"]).toBe("interim");
    expect(fold(text({ phase: "interim" }, { phase: "x-later" }))["phase"]).toBe("x-later");
  });
  it("(d) a phase value this version does not document folds verbatim", () => {
    expect(fold(text({ phase: "x-future" }, {}))["phase"]).toBe("x-future");
  });
  it("(e) the same streams with no phase fold with no phase key (byte-identical to draft.3)", () => {
    expect("phase" in fold(text({}, {}))).toBe(false);
    expect("phase" in fold(reasoning({}, {}))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.24 leg (b) and §10.23 ADK leg — driven through the reference ADK
// normalizer with the SPEC's own vectors (sp-google 877f37f / a0c5dcf).
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.24(adk) + §10.23(adk) — the ADK failure envelope and the unmapped finish reason (draft.4)", () => {
  const CALL = "adk-call-1";
  const callEv = (): AdkEvent => ({ invocationId: "inv1", author: "agent", content: { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "x" }, id: CALL } }] }, partial: false, finishReason: "STOP" } as unknown as AdkEvent);
  const answerEv = (response: Record<string, unknown>, extra: Record<string, unknown> = {}): AdkEvent =>
    ({ invocationId: "inv1", author: "agent", content: { role: "user", parts: [{ functionResponse: { name: "lookup", response, id: CALL } }] }, ...extra } as unknown as AdkEvent);
  const drive = (evs: AdkEvent[]): AgEvent[] => {
    const n = createAdkNormalizer();
    const out = [...evs.flatMap((e) => n.push(e)), ...n.flush()];
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow(); // every emitted event is AgEvent-valid
    return out;
  };
  const doneFor = (response: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const dones = drive([callEv(), answerEv(response, extra)]).filter((e) => e.type === "tool.done") as unknown as Array<Record<string, unknown>>;
    expect(dones).toHaveLength(1);
    return dones[0]!;
  };

  it("{error:\"Function x is not found in the toolsDict.\"} → outcome error, isError, errorText = that string, content a data block carrying the response verbatim", () => {
    const response = { error: "Function lookup is not found in the toolsDict." };
    const d = doneFor(response);
    expect(d).toMatchObject({ outcome: "error", isError: true, errorText: response.error });
    const content = d["content"] as Array<Record<string, unknown>>;
    expect(content[0]?.["type"]).toBe("data");
    expect(content[0]?.["data"]).toEqual(response);
  });
  it("{error:\"x\", error_code:\"E_X\"} → outcome error, errorText x, errorCode E_X", () => {
    expect(doneFor({ error: "x", error_code: "E_X" })).toMatchObject({ outcome: "error", errorText: "x", errorCode: "E_X" });
  });
  it("{error:{code:\"E\"}} → outcome error with no errorText", () => {
    const d = doneFor({ error: { code: "E" } });
    expect(d["outcome"]).toBe("error");
    expect("errorText" in d).toBe(false);
  });
  it("the confirmation placeholder on an event whose requestedToolConfirmations names the call → one approval hitl.ask and no outcome error for that call", () => {
    const out = drive([
      callEv(),
      answerEv({ error: "This tool call requires confirmation, please approve or reject." }, { actions: { requestedToolConfirmations: { [CALL]: { hint: "approve?", confirmed: false } } } }),
    ]);
    const asks = out.filter((e) => e.type === "hitl.ask") as unknown as Array<{ kind: string }>;
    expect(asks).toHaveLength(1);
    expect(asks[0]!.kind).toBe("approval");
    const errs = out.filter((e) => e.type === "tool.done" && (e as { toolCallId?: string }).toolCallId === CALL && (e as { outcome?: string }).outcome === "error");
    expect(errs).toHaveLength(0);
  });
  it("{error:\"This tool call is rejected.\"} → outcome denied with no errorText", () => {
    const d = doneFor({ error: "This tool call is rejected." });
    expect(d["outcome"]).toBe("denied");
    expect("errorText" in d).toBe(false);
  });
  it("an MCP {content:[…], isError:true} → outcome error with isError true", () => {
    expect(doneFor({ content: [{ type: "text", text: "boom" }], isError: true })).toMatchObject({ outcome: "error", isError: true });
  });
  for (const response of [{ result: null }, { error: "" }, { error: null }, { error: false }, { error: 0 }, { status: "error", error_message: "x" }]) {
    it(`${JSON.stringify(response)} → outcome ok (negative vector)`, () => {
      const d = doneFor(response);
      expect(d["outcome"]).toBe("ok");
      expect("errorText" in d).toBe(false);
    });
  }

  // §10.23 ADK leg: a native finish reason with no AgJSON target.
  for (const [raw, fallback] of [["TOO_MANY_TOOL_CALLS", "other"], ["SOME_FUTURE_REASON", "unknown"]] as const) {
    it(`§10.23(adk): finishReason ${raw} → turn.done finishReason "${fallback}" + finishReasonRaw "${raw}" byte for byte`, () => {
      const out = drive([{ invocationId: "inv1", author: "agent", content: { role: "model", parts: [{ text: "done" }] }, partial: false, turnComplete: true, finishReason: raw } as unknown as AdkEvent]);
      expect(out.find((e) => e.type === "turn.done")).toMatchObject({ finishReason: fallback, finishReasonRaw: raw });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.26 openai leg — the SPEC's own two-item vector through the reference
// OpenAI Agents normalizer (sp-openai PH-2 d8d04ca; §8.0 item 27).
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.26(openai) — commentary → phase 'interim' on text.start only; final_answer / null / \"\" / unknown → no phase", () => {
  const rawModel = (event: Record<string, unknown>) => ({ type: "raw_model_stream_event", data: { type: "model", event } }) as unknown as JsonValue;
  const msgItem = (id: string, phase: unknown) =>
    ({ type: "run_item_stream_event", name: "message_output_created", item: { type: "message_output_item", rawItem: { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `text of ${id}` }], id, ...(phase !== undefined ? { phase } : {}) } } }) as unknown as JsonValue;
  const vector = (a: unknown, b: unknown): JsonValue[] => [
    rawModel({ type: "response.created", response: { id: "resp_c" } }),
    rawModel({ type: "response.output_item.added", item: { id: "msg_A", type: "message", phase: a } }),
    rawModel({ type: "response.output_text.delta", item_id: "msg_A", delta: "text of msg_A" }),
    rawModel({ type: "response.output_item.added", item: { id: "msg_B", type: "message", phase: b } }),
    rawModel({ type: "response.output_text.delta", item_id: "msg_B", delta: "text of msg_B" }),
    rawModel({ type: "response.completed", response: { id: "resp_c", status: "completed" } }),
    msgItem("msg_A", a),
    msgItem("msg_B", b),
  ];
  const drive = (natives: JsonValue[]): AgEvent[] => {
    const n = createOpenaiNormalizer();
    const out = [...natives.flatMap((f) => n.push(f)), ...n.flush()];
    for (const ev of out) expect(AgEvent.safeParse(ev).success).toBe(true);
    return out;
  };
  const ev = (out: AgEvent[], type: string, id: string) => out.find((e) => e.type === type && (e as { id?: string }).id === id) as unknown as Record<string, unknown> | undefined;
  const pm = (e: Record<string, unknown> | undefined) => (e?.["providerMetadata"] as Record<string, unknown> | undefined) ?? {};

  it("commentary then final_answer: phase 'interim' on msg_A's text.start only; both text blocks keep providerMetadata.phase verbatim; the fold agrees", () => {
    const out = drive(vector("commentary", "final_answer"));
    expect(ev(out, "text.start", "msg_A")?.["phase"]).toBe("interim");
    for (const t of ["text.start", "text.end"]) expect(ev(out, t, "msg_B") && "phase" in ev(out, t, "msg_B")!).toBe(false);
    expect(pm(ev(out, "text.start", "msg_A"))["phase"]).toBe("commentary");
    expect(pm(ev(out, "text.start", "msg_B"))["phase"]).toBe("final_answer");
    const r = reduce(out);
    expect(r.needsResync).toBe(false);
    const blocks = r.result.messages.flatMap((m) => m.content).filter((b) => b.type === "text") as unknown as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b["phase"])).toEqual(["interim", undefined]);
  });
  for (const [label, bad] of [["null", null], ["empty string", ""]] as const) {
    it(`a native phase of ${label} yields neither phase nor providerMetadata.phase on any emitted event`, () => {
      const out = drive(vector(bad, "final_answer"));
      const startA = ev(out, "text.start", "msg_A");
      expect(startA && "phase" in startA).toBe(false);
      // no event anywhere (text.start/text.end, a late ext carry, …) may carry the empty marker
      const leaks = out.filter((e) => JSON.stringify(e).match(/"phase":(null|"")/));
      expect(leaks.map((e) => e.type)).toEqual([]);
    });
  }
  it("an undocumented vendor value (\"foo\") yields no phase and keeps providerMetadata.phase \"foo\"", () => {
    const startA = ev(drive(vector("foo", "final_answer")), "text.start", "msg_A");
    expect(startA && "phase" in startA).toBe(false);
    expect(pm(startA)["phase"]).toBe("foo");
  });
});

describe("§10.23(openai) — an unmapped OpenAI finish reason → fallback + finishReasonRaw byte for byte (sp-openai OA-15)", () => {
  const rawModel = (event: Record<string, unknown>) => ({ type: "raw_model_stream_event", data: { type: "model", event } }) as unknown as JsonValue;
  for (const raw of ["zz", "Max_Messages—v2 ✓"]) {
    it(`incomplete_details.reason ${JSON.stringify(raw)} → turn.done finishReason "unknown" + finishReasonRaw ${JSON.stringify(raw)}`, () => {
      const n = createOpenaiNormalizer();
      const out = [
        rawModel({ type: "response.created", response: { id: "resp_u" } }),
        rawModel({ type: "response.output_text.delta", item_id: "msg_u", delta: "hi" }),
        rawModel({ type: "response.completed", response: { id: "resp_u", status: "completed", incomplete_details: { reason: raw } } }),
      ].flatMap((f) => n.push(f)).concat(n.flush());
      for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
      expect(out.find((e) => e.type === "turn.done")).toMatchObject({ finishReason: "unknown", finishReasonRaw: raw });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.27 — Re-delivery never folds twice (draft.4; INV-SEQ/INV-BLOCK/INV-MSG,
// rd-14 path 1 + 1a). Each offending event leaves needsResync true and the
// fold equal to the fold of the events before it, on the incremental Reducer
// AND the batch reduce().
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.27 — re-delivery never folds twice (draft.4)", () => {
  const P = (evs: Array<Record<string, unknown>>) => evs.map((e) => AgEvent.parse(e));
  const S = P([
    { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
    { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
    { type: "text.start", seq: 2, id: "b1", turnId: "t1" },
    { type: "text.delta", seq: 3, id: "b1", delta: "a" },
    { type: "text.delta", seq: 4, id: "b1", delta: "b" },
    { type: "text.delta", seq: 5, id: "b1", delta: "c" },
    { type: "text.delta", seq: 6, id: "b1", delta: "d" },
    { type: "text.delta", seq: 7, id: "b1", delta: "e" },
  ]);
  const both = (evs: AgEvent[]) => {
    const live = new Reducer();
    for (const e of evs) live.push(e);
    const batch = reduce(evs);
    expect(live.needsResync).toBe(batch.needsResync);
    expect(live.result()).toEqual(batch.result);
    return batch;
  };
  const parksUnchanged = (prefix: AgEvent[], offending: AgEvent[]) => {
    const before = both(prefix);
    expect(before.needsResync).toBe(false);
    const after = both([...prefix, ...offending]);
    expect(after.needsResync).toBe(true);
    expect(after.result).toEqual(before.result);
  };
  const END = P([{ type: "message.end", seq: 8, id: "m1" }]);
  const DONE = P([{ type: "turn.done", seq: 9, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" }]);

  it("(i) a text.delta re-delivered at seq == lastSeq", () => parksUnchanged(S, P([{ type: "text.delta", seq: 7, id: "b1", delta: "e" }])));
  it("(ii) an event re-delivered at 0 < seq < lastSeq (seq 3 after seq 7)", () => parksUnchanged(S, P([{ type: "text.delta", seq: 3, id: "b1", delta: "a" }])));
  it("(iii) a second text.start / reasoning.start naming an id already present", () => {
    parksUnchanged(S, P([{ type: "text.start", seq: 8, id: "b1", turnId: "t1" }]));
    const R = P([...S.slice(0, 2).map((e) => e as unknown as Record<string, unknown>), { type: "reasoning.start", seq: 2, id: "r1", turnId: "t1" }, { type: "reasoning.delta", seq: 3, id: "r1", delta: "x" }]);
    parksUnchanged(R, P([{ type: "reasoning.start", seq: 4, id: "r1", turnId: "t1" }]));
  });
  it("(iv) a text.delta into a message after its message.end", () => parksUnchanged([...S, ...END], P([{ type: "text.delta", seq: 9, id: "b1", delta: "late" }])));
  it("(v) a message.start and text.start after the turn's turn.done", () =>
    parksUnchanged([...S, ...END, ...DONE], P([
      { type: "message.start", seq: 10, id: "m2", role: "assistant", turnId: "t1", threadId: "th1" },
      { type: "text.start", seq: 11, id: "b2", turnId: "t1" },
    ])));
  it("(vi) a second more-less tool.done for one toolCallId while the turn is open", () => {
    const T = P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
      { type: "tool.start", seq: 2, toolCallId: "c1", name: "calc", turnId: "t1", threadId: "th1" },
      { type: "tool.args.assembled", seq: 3, toolCallId: "c1", input: { x: 1 } },
      { type: "tool.done", seq: 4, toolCallId: "c1", content: [{ type: "text", text: "1" }], outcome: "ok" },
    ]);
    parksUnchanged(T, P([{ type: "tool.done", seq: 5, toolCallId: "c1", content: [{ type: "text", text: "2" }], outcome: "ok" }]));
  });
  it("(vii) control: a second invoke restarting at seq 0 and reusing block id r0 folds with needsResync false", () => {
    const invoke = (turnId: string, msgId: string) => P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId },
      { type: "message.start", seq: 1, id: msgId, role: "assistant", turnId, threadId: "th1" },
      { type: "reasoning.start", seq: 2, id: "r0", turnId },
      { type: "reasoning.delta", seq: 3, id: "r0", delta: turnId },
      { type: "reasoning.end", seq: 4, id: "r0" },
      { type: "message.end", seq: 5, id: msgId },
      { type: "turn.done", seq: 6, turnId, outcome: { type: "success" }, finishReason: "stop" },
    ]);
    const r = both([...invoke("t1", "m1"), ...invoke("t2", "m2")]);
    expect(r.needsResync).toBe(false);
    expect(r.result.turns).toHaveLength(2);
  });
  it("(viii) control: a forward gap still parks", () => {
    expect(both([...S, ...P([{ type: "text.delta", seq: 9, id: "b1", delta: "gap" }])]).needsResync).toBe(true);
  });

  it("(goldens) on every replay golden, block-creating *.start ids are unique within each invoke", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const dups: string[] = [];
    let files = 0;
    for (const dir of readdirSync(corpus)) {
      for (const fw of ["claude", "openai", "adk", "vercel"]) {
        const f = new URL(`${dir}/${fw}.agjson.json`, corpus);
        if (!existsSync(f)) continue;
        files++;
        const seen = new Set<string>();
        for (const e of JSON.parse(readFileSync(f, "utf8")) as Array<Record<string, unknown>>) {
          if (e["seq"] === 0) seen.clear(); // a 0-restart opens a new invoke (INV-SEQ)
          const id = e["type"] === "tool.start" ? e["toolCallId"] : e["type"] === "text.start" || e["type"] === "reasoning.start" ? e["id"] : undefined;
          if (typeof id !== "string") continue;
          const key = `${e["type"] === "tool.start" ? "tool" : "block"}:${id}`;
          if (seen.has(key)) dups.push(`${dir}/${fw}:${key}`);
          seen.add(key);
        }
      }
    }
    expect(files).toBeGreaterThan(0);
    expect(dups).toEqual([]);
  });

  // draft.4 message.start rule (bar wf_140b3183-767, founder path 1): a message.start naming a closed turn parks,
  // within an invoke and across invokes; closure survives a 0-restart and only a messages.snapshot clears it.
  const TERMS = [
    { type: "turn.done", seq: 9, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
    { type: "turn.error", seq: 9, turnId: "t1", message: "boom" },
    { type: "turn.abort", seq: 9, turnId: "t1", reason: "stream-truncated" },
  ];
  const LATE = P([
    { type: "message.start", seq: 10, id: "m2", role: "assistant", turnId: "t1", threadId: "th1" },
    { type: "message.end", seq: 11, id: "m2" },
  ]);
  it("(v-a) a message.start alone after its turn's turn.done, turn.error or turn.abort parks, and m2 never enters the fold", () => {
    for (const t of TERMS) {
      const prefix = [...S, ...END, ...P([t])];
      parksUnchanged(prefix, LATE);
      expect(reduce([...prefix, ...LATE]).result.messages.some((m) => m.id === "m2")).toBe(false);
    }
  });
  it("(v-b) a later invoke's message.start naming a turn an earlier invoke closed parks; the 0-restart does not reopen it", () => {
    const inv2 = P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t2" },
      { type: "turn.done", seq: 1, turnId: "t2", outcome: { type: "success" }, finishReason: "stop" },
    ]);
    const prefix = [...S, ...END, ...DONE, ...inv2];
    const control = both(prefix);
    expect(control.needsResync).toBe(false);
    expect(control.result.turns.some((t) => t.turnId === "t2")).toBe(true);
    parksUnchanged(prefix, P([{ type: "message.start", seq: 2, id: "m2", role: "assistant", turnId: "t1", threadId: "th1" }]));
  });
  it("(v-c) a message.start into a nested turn after its terminal parks; (v-f) the parent stays open and takes a message", () => {
    const N = P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "P" },
      { type: "subagent.start", seq: 1, turnId: "S", parentTurnId: "P" },
      { type: "message.start", seq: 2, id: "ms", role: "assistant", turnId: "S", threadId: "th1" },
      { type: "text.start", seq: 3, id: "bs", turnId: "S" },
      { type: "text.delta", seq: 4, id: "bs", delta: "n" },
      { type: "text.end", seq: 5, id: "bs" },
      { type: "message.end", seq: 6, id: "ms" },
      { type: "turn.done", seq: 7, turnId: "S", outcome: { type: "success" }, finishReason: "unknown" },
      { type: "subagent.done", seq: 8, turnId: "S", parentTurnId: "P" },
    ]);
    parksUnchanged(N, P([{ type: "message.start", seq: 9, id: "mx", role: "assistant", turnId: "S", threadId: "th1" }]));
    const f = both([...N, ...P([{ type: "message.start", seq: 9, id: "mp", role: "assistant", turnId: "P", threadId: "th1" }])]);
    expect(f.needsResync).toBe(false);
    expect(f.result.messages.find((m) => m.id === "mp")?.turnId).toBe("P");
  });
  it("(v-d) control: message.metadata naming m1 after its turn's terminal merges without parking", () => {
    const f = both([...S, ...END, ...DONE, ...P([{ type: "message.metadata", seq: 10, messageId: "m1", metadata: { k: 1 } }])]);
    expect(f.needsResync).toBe(false);
    expect((f.result.messages.find((m) => m.id === "m1") as { metadata?: Record<string, unknown> } | undefined)?.metadata).toMatchObject({ k: 1 });
  });
  it("(v-e) control: after a messages.snapshot (which clears closure), a message.start naming the snapshot's closed turn folds", () => {
    const f = both([
      ...S, ...END, ...DONE,
      ...P([
        { type: "messages.snapshot", seq: 10, messages: [], turns: [{ turnId: "t1", threadId: "th1", outcome: { type: "success" } }] },
        { type: "message.start", seq: 11, id: "m2", role: "assistant", turnId: "t1", threadId: "th1" },
      ]),
    ]);
    expect(f.needsResync).toBe(false);
    expect(f.result.messages.find((m) => m.id === "m2")?.turnId).toBe("t1");
  });
  it("(producers) on every replay golden no message.start follows the terminal of the turn it names; on every committed resume pair no turn or message id of one invoke recurs in the other, and the pair folds without a resync", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const TERMINALS = new Set(["turn.done", "turn.error", "turn.abort"]);
    const bad: string[] = [];
    let pairs = 0;
    const load = (dir: string, fw: string) => JSON.parse(readFileSync(new URL(`${dir}/${fw}.agjson.json`, corpus), "utf8")) as Array<Record<string, unknown>>;
    const dirs = readdirSync(corpus).sort();
    for (const dir of dirs) {
      for (const fw of ["claude", "openai", "adk", "vercel"]) {
        if (!existsSync(new URL(`${dir}/${fw}.agjson.json`, corpus))) continue;
        const evs = load(dir, fw);
        const closed = new Set<unknown>();
        const only = evs.filter((e) => e["type"] === "turn.start").map((e) => e["turnId"]);
        for (const e of evs) {
          if (TERMINALS.has(e["type"] as string)) closed.add(e["turnId"]);
          if (e["type"] === "message.start") {
            const tid = e["turnId"] ?? (only.length === 1 ? only[0] : undefined);
            if (closed.has(tid)) bad.push(`${dir}/${fw}: message.start ${String(e["id"])} after ${String(tid)}'s terminal`);
          }
        }
        const m = /^(.*)-resume-[^/]+$/.exec(dir);
        if (!m || !existsSync(new URL(`${m[1]}/${fw}.agjson.json`, corpus))) continue;
        pairs++;
        const first = load(m[1] as string, fw), second = evs;
        const ids = (xs: Array<Record<string, unknown>>) => new Set(xs.flatMap((e) => [e["type"] === "turn.start" ? e["turnId"] : undefined, e["type"] === "message.start" ? `m:${String(e["id"])}` : undefined]).filter((x) => x !== undefined));
        const a = ids(first), b = ids(second);
        for (const x of b) if (a.has(x)) bad.push(`${dir}/${fw}: ${String(x)} recurs from ${m[1]}`);
        const r = new Reducer();
        for (const e of [...first, ...second]) r.push(AgEvent.parse(e));
        if (r.needsResync) bad.push(`${dir}/${fw}: the pair parks`);
      }
    }
    expect(bad).toEqual([]);
    expect(pairs).toBeGreaterThanOrEqual(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.28 — Host-appended events (draft.4; §8.0 host obligation 5).
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.28 — host-appended events (draft.4): every replay golden + a host-appended paused hitl.ask turn from lastSeq+1 folds cleanly", () => {
  it("every corpus/*/*.agjson.json golden, followed by turn.start → hitl.ask → turn.done{paused} numbered from its last seq + 1, folds with needsResync false and the appended turn in turns", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const bad: string[] = [];
    let files = 0;
    for (const dir of readdirSync(corpus)) {
      for (const fw of ["claude", "openai", "adk", "vercel"]) {
        const f = new URL(`${dir}/${fw}.agjson.json`, corpus);
        if (!existsSync(f)) continue;
        files++;
        const golden = JSON.parse(readFileSync(f, "utf8")) as Array<Record<string, unknown>>;
        const last = Math.max(...golden.map((e) => (typeof e["seq"] === "number" ? (e["seq"] as number) : -1)));
        const threadId = (golden.find((e) => e["type"] === "turn.start")?.["threadId"] as string | undefined) ?? "th_host";
        const turnId = `turn_host_${dir}`;
        const appended = [
          { type: "turn.start", seq: last + 1, threadId, turnId },
          { type: "hitl.ask", seq: last + 2, askId: "consent_1", kind: "approval", turnId, message: "Allow?" },
          { type: "turn.done", seq: last + 3, turnId, outcome: { type: "paused", asks: [{ askId: "consent_1", kind: "approval" }] }, finishReason: "paused" },
        ];
        const r = reduce(ingestAgEvents([...golden, ...appended] as unknown as JsonValue[]));
        if (r.needsResync || !r.result.turns.some((t) => t.turnId === turnId)) bad.push(`${dir}/${fw}`);
      }
    }
    expect(files).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});

describe("§10.29 — forward-compatible records and inputs (draft.4; §0.2 stored records and inputs)", () => {
  // Splice each report's raw back at its (last) index: the §0.2 reconstruction requirement.
  const reinsert = (value: unknown[], reports: AgRecordReport[]): unknown[] => {
    const out = [...value];
    for (const r of [...reports].sort((x, y) => (x.path.at(-1) as number) - (y.path.at(-1) as number))) out.splice(r.path.at(-1) as number, 0, r.raw);
    return out;
  };
  const T1 = { type: "text", text: "a", zzKey: "k" };
  const U = { type: "zz" };
  const TR = { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "r" }, { type: "zz" }] };
  const T2 = { type: "text", text: "b" };
  const M = { id: "m", role: "assistant", zzTop: 1, usage: { inputTokens: 10, outputTokens: 5, zzCounter: 3 }, content: [T1, U, TR, T2] };

  it("(a1-a4) the stored message reads as content [T1, T2] with unknown fields intact, exactly two reports (U at [content,1], TR at [content,2]), reinsertion reproduces it, and the input is not mutated", () => {
    const input = structuredClone(M);
    const before = structuredClone(M);
    const r = readStoredAgMessage(input);
    const v = r.value as unknown as Record<string, unknown>;
    expect(isDeepStrictEqual(v["content"], [T1, T2])).toBe(true);
    expect(v["zzTop"]).toBe(1);
    expect((v["usage"] as Record<string, unknown>)["zzCounter"]).toBe(3);
    expect(r.reports).toEqual([
      { path: ["content", 1], ignoredType: "zz", raw: U },
      { path: ["content", 2], ignoredType: "tool-result", raw: TR },
    ]);
    expect(isDeepStrictEqual({ ...v, content: reinsert(v["content"] as unknown[], r.reports) }, before)).toBe(true);
    expect(isDeepStrictEqual(input, before)).toBe(true);
  });

  it("(a5) memory records: [R1, R2 scope 'zz', R3] reads as [R1, R3] with unknown fields intact and one report at [1]; reinsertion reproduces the array", () => {
    const R1 = { scope: "thread", key: "k1", value: { a: 1 }, zz: "keep" };
    const R2 = { scope: "zz", key: "k2", value: 2 };
    const R3 = { scope: "user", value: null, zzNested: { q: [1] } };
    const r = readStoredAgMemoryRecords([R1, R2, R3]);
    expect(isDeepStrictEqual(r.value, [R1, R3])).toBe(true);
    expect(r.reports).toEqual([{ path: [1], raw: R2 }]);
    expect(isDeepStrictEqual(reinsert(r.value as unknown[], r.reports), [R1, R2, R3])).toBe(true);
  });

  it("(a6) an object that is not a stored message (no id/role, or role 'zz') is not materialized and is reported whole", () => {
    for (const raw of [{ kind: "text", text: "x" }, { id: "m2", role: "zz", content: [] }]) {
      const r = readStoredAgMessage(raw);
      expect(r.value).toBeUndefined();
      expect(r.reports).toHaveLength(1);
      expect(isDeepStrictEqual(r.reports[0]!.raw, raw)).toBe(true);
    }
  });

  it("(a7) an own __proto__ key at any depth never becomes a prototype of a returned object", () => {
    const raw = JSON.parse('{"__proto__":{"polluted":1},"id":"m3","role":"assistant","content":[{"type":"text","text":"t","__proto__":{"polluted":2}}]}') as unknown;
    const r = readStoredAgMessage(raw);
    const walk = (o: unknown): boolean => {
      if (o === null || typeof o !== "object") return true;
      if (!Array.isArray(o) && Object.getPrototypeOf(o) !== Object.prototype) return false;
      return Object.values(o as Record<string, unknown>).every(walk);
    };
    expect(r.value).toBeDefined();
    expect(walk(r.value)).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("(a8) every message folded from the recorded corpus reads back deep-equal with zero reports", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    let messages = 0;
    const bad: string[] = [];
    for (const dir of readdirSync(corpus)) {
      for (const fw of ["claude", "openai", "adk", "vercel"]) {
        const f = new URL(`${dir}/${fw}.agjson.json`, corpus);
        if (!existsSync(f)) continue;
        const golden = JSON.parse(readFileSync(f, "utf8")) as JsonValue[];
        const folded = JSON.parse(JSON.stringify(reduce(ingestAgEvents(golden)).result.messages)) as unknown[];
        const r = readStoredAgMessages(folded);
        messages += folded.length;
        if (r.reports.length > 0 || !isDeepStrictEqual(r.value, folded)) bad.push(`${dir}/${fw}`);
      }
    }
    expect(messages).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  const ENV = { protocol: "agjson", version: AGJSON_VERSION, threadId: "th", turnId: "t" };
  const start = (extra: Record<string, unknown>) => ({ ...ENV, kind: "start", messages: [], ...extra });
  const reject = (raw: unknown) => {
    const r = checkAgInput(raw);
    return r.ok ? { ok: true } : { code: r.code, path: r.path };
  };

  it("(b1-b4) an undefined closed-set value rejects the whole input with unknown-value at its path", () => {
    expect(reject({ ...ENV, kind: "resume", answers: [{ askId: "a", status: "resolved" }, { askId: "b", status: "zz" }] })).toEqual({ code: "unknown-value", path: ["answers", 1, "status"] });
    expect(reject({ ...ENV, kind: "zz" })).toEqual({ code: "unknown-value", path: ["kind"] });
    expect(reject(start({ run: { reasoning: { mode: "enabled", effort: "xhigh" } } }))).toEqual({ code: "unknown-value", path: ["run", "reasoning", "effort"] });
    expect(reject(start({ messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }, { type: "zz" }] }] }))).toEqual({ code: "unknown-value", path: ["messages", 0, "content", 1, "type"] });
  });

  it("(b5-b7) a missing value or a value of the wrong JSON type is malformed", () => {
    expect(reject({ ...ENV, kind: 9 }).code).toBe("malformed");
    expect(reject({ ...ENV, kind: "resume", answers: [{ askId: "a" }] })).toEqual({ code: "malformed", path: ["answers", 0, "status"] });
    expect(reject(start({ capabilities: { hitl: { grantModes: {} } } }))).toEqual({ code: "malformed", path: ["capabilities", "hitl", "grantModes"] });
    // draft.4 §3/§6: viewMessageTurns is a boolean; an MCP-shaped modalities object where it belongs is malformed at the member
    expect(reject(start({ capabilities: { uiResources: { viewMessageTurns: { text: {} } } } }))).toEqual({ code: "malformed", path: ["capabilities", "uiResources", "viewMessageTurns"] });
  });

  it("(b8) a different major version is major-mismatch", () => {
    expect(reject({ ...ENV, version: "2.0.0", kind: "start", messages: [] })).toEqual({ code: "major-mismatch", path: ["version"] });
  });

  it("(b11-b17) one class and one path per input: protocol first, then version, then the rest; malformed beats unknown-value; envelope members are judged whatever the kind", () => {
    // b11: a protocol other than "agjson" is malformed, judged first
    expect(reject(start({ protocol: "foo" }))).toEqual({ code: "malformed", path: ["protocol"] });
    expect(reject({ ...ENV, protocol: "foo", kind: "zz" })).toEqual({ code: "malformed", path: ["protocol"] });
    expect(reject({ ...ENV, protocol: "foo", version: "2.0.0", kind: "start", messages: [] })).toEqual({ code: "malformed", path: ["protocol"] });
    // b12: a different major is major-mismatch at version
    expect(reject({ ...ENV, version: "2.0.0", kind: "start", messages: [] })).toEqual({ code: "major-mismatch", path: ["version"] });
    // b13/b14: an envelope member is judged whatever the kind; a member only an undefined kind would select is not
    expect(reject({ ...ENV, kind: "zz", threadId: 5 })).toEqual({ code: "malformed", path: ["threadId"] });
    expect(reject({ ...ENV, kind: "zz", messages: 5 })).toEqual({ code: "unknown-value", path: ["kind"] });
    // b15: malformed beats unknown-value, in either element order
    expect(reject(start({ messages: [{ id: "u1", role: "user", content: [{ type: "zz", text: 5 }, { type: "text" }] }] }))).toEqual({ code: "malformed", path: ["messages", 0, "content", 1, "text"] });
    expect(reject(start({ messages: [{ id: "u1", role: "user", content: [{ type: "text" }, { type: "zz", text: 5 }] }] }))).toEqual({ code: "malformed", path: ["messages", 0, "content", 0, "text"] });
    // b16: an undefined value in a frozen closed set is still unknown-value
    expect(reject(start({ messages: [{ id: "u1", role: "zz", content: [] }] }))).toEqual({ code: "unknown-value", path: ["messages", 0, "role"] });
    // b17: a wrong JSON type inside an MCP Apps view interaction is malformed at its own member
    const r17 = checkAgInput({ ...ENV, kind: "resume", uiActions: [{ surfaceId: "s1", surface: "mcp-app", method: "ui/open-link", params: { url: 5 } }] });
    expect(r17.ok).toBe(false);
    if (!r17.ok) {
      expect(r17.code).toBe("malformed");
      expect(r17.path.slice(0, 3)).toEqual(["uiActions", 0, "params"]);
    }
  });

  it("(b9-b10) unknown fields on an answer and in capabilities (top-level and nested) are accepted and returned intact", () => {
    const resume = { ...ENV, kind: "resume", answers: [{ askId: "a", status: "resolved", zzExtra: { k: 1 } }] };
    const r1 = checkAgInput(structuredClone(resume));
    expect(r1.ok && isDeepStrictEqual(r1.input, resume)).toBe(true);
    const caps = start({ capabilities: { zzTop: true, hitl: { ask: true, zzNested: [1] } } });
    const r2 = checkAgInput(structuredClone(caps));
    expect(r2.ok && isDeepStrictEqual(r2.input, caps)).toBe(true);
    // draft.4 §3/§6: the viewMessageTurns flag, a known sibling and an unknown sibling all round-trip intact
    const view = start({ capabilities: { uiResources: { htmlResources: true, viewMessageTurns: true, zzFuture: 1 } } });
    const r3 = checkAgInput(structuredClone(view));
    expect(r3.ok && isDeepStrictEqual(r3.input, view)).toBe(true);
  });
});

describe("§10.30 — no credential material in authentication requests (draft.4; §8.0 item 28(a))", () => {
  it("(adk) the engine-built OAuth2 credential request: no seeded secret reaches any event or the fold, raw or JSON-escaped; state and nonce appear only inside the byte-equal ADK-issued authorization URI", () => {
    const natives = JSON.parse(readFileSync(new URL("../fixtures/adk-pause/plain-credential-authuri.native.json", import.meta.url), "utf8")) as JsonValue[];
    const nativeText = JSON.stringify(natives);
    const authUri = /"authUri":"([^"]+)"/.exec(nativeText)?.[1];
    expect(authUri).toBeDefined();
    // Every seeded value except the non-secret client id; the nonce is allowed only inside the URI.
    const seeds = [...new Set(nativeText.match(/SEED_[A-Za-z0-9_]+/g) ?? [])].filter((s) => s !== "SEED_client_id");
    expect(seeds).toContain("SEED_nonce");
    expect(seeds.length).toBeGreaterThan(4);
    const n = createAdkNormalizer();
    const out: AgEvent[] = [];
    for (const f of natives) out.push(...n.push(f as unknown as AdkEvent));
    out.push(...n.flush());
    for (const e of out) expect(() => AgEvent.parse(e)).not.toThrow();
    const r = reduce(out);
    expect(r.needsResync).toBe(false);
    const leaks: string[] = [];
    for (const x of [...out, r.result] as unknown[]) {
      const outsideUri = JSON.stringify(x).split(authUri as string).join("");
      for (const s of seeds) if (outsideUri.includes(s)) leaks.push(s);
    }
    expect(leaks).toEqual([]);
    // The authorization URI the user must open is carried as the framework issued it.
    expect(out.some((e) => JSON.stringify(e).includes(authUri as string))).toBe(true);
  });
});

describe("§10.32 — credential material off provider-raw carries (draft.4; §8.0 item 28(c))", () => {
  const event = (parts: AdkPart[], extra: Record<string, unknown> = {}): AdkEvent =>
    ({ content: { role: "model", parts }, invocationId: "inv_10_32", turnComplete: true, finishReason: "STOP", ...extra }) as unknown as AdkEvent;
  // A typed ADK auth configuration whose API-key, OAuth2 and service-account credentials, in both spellings, hold distinct secret leaves.
  const typed = {
    authScheme: { type: "apiKey", in: "header", name: "X-Key" },
    rawAuthCredential: { authType: "apiKey", apiKey: "SECRET_api_key" },
    exchangedAuthCredential: { authType: "oauth2", oauth2: { clientId: "client-1", clientSecret: "SECRET_client_secret", accessToken: "SECRET_access", refreshToken: "SECRET_refresh" } },
    serviceAccount: { auth_type: "serviceAccount", service_account: { serviceAccountCredential: { private_key: "SECRET_private_key", client_email: "sa@example.test" } } },
    snake: { auth_type: "apiKey", api_key: "SECRET_snake_key" },
    credentialKey: "fetch-key",
  };
  const untyped = { parts: [{ functionResponse: { id: "fetch-key", name: "adk_request_credential", response: { token: "SECRET_untyped" } } }] };
  const drive = (natives: AdkEvent[]): AgEvent[] => {
    const n = createAdkNormalizer(); // one Normalizer per invoke (§8.0 obligation 3)
    const out: AgEvent[] = [];
    for (const f of natives) expect(() => out.push(...n.push(f))).not.toThrow();
    out.push(...n.flush());
    for (const e of out) expect(() => AgEvent.parse(e), JSON.stringify(e).slice(0, 120)).not.toThrow();
    return out;
  };
  const rawCarry = (out: AgEvent[], member: string): Record<string, unknown> | undefined => {
    for (const e of out) {
      if (e.type !== "content.block") continue;
      const b = (e as unknown as { block: { type: string; raw?: Record<string, unknown> } }).block;
      if (b.type === "provider-raw" && b.raw && Object.hasOwn(b.raw, member)) return b.raw;
    }
    return undefined;
  };
  const noSecret = (label: string, out: AgEvent[]): void => {
    expect(JSON.stringify(out).includes("SECRET_"), `${label}: a secret leaf reached an event`).toBe(false);
    const byBlock = new Map<string, string>();
    for (const e of out) if (e.type === "text.delta") { const k = e.id ?? ""; byBlock.set(k, (byBlock.get(k) ?? "") + (e.delta ?? "")); }
    for (const [id, text] of byBlock) expect(text.includes("SECRET_"), `${label}: text block ${id}`).toBe(false);
    expect(reduce(out).needsResync, label).toBe(false);
  };
  const vectors: [string, AdkEvent, (out: AgEvent[]) => void][] = [
    ["agentState.input", event([{ text: "done" }], { actions: { agentState: { input: typed } } }), (out) => {
      const input = (rawCarry(out, "agentState")?.["agentState"] as { input?: Record<string, unknown> } | undefined)?.input;
      expect(input?.["authScheme"]).toEqual(typed.authScheme);
      expect(input?.["credentialKey"]).toBe("fetch-key");
      expect((input?.["rawAuthCredential"] as Record<string, unknown> | undefined)?.["authType"]).toBe("apiKey");
    }],
    ["output + rendering", event([{ text: JSON.stringify(typed) }], { output: typed }), (out) => {
      expect(out.some((e) => e.type === "text.start")).toBe(false);
      expect((rawCarry(out, "output")?.["output"] as Record<string, unknown> | undefined)?.["credentialKey"]).toBe("fetch-key");
    }],
    ["output.result + rendering", event([{ text: JSON.stringify({ result: typed, step: 2 }) }], { output: { result: typed, step: 2 } }), (out) => {
      expect(out.some((e) => e.type === "text.start")).toBe(false);
      expect((rawCarry(out, "output")?.["output"] as Record<string, unknown> | undefined)?.["step"]).toBe(2);
    }],
    ["customMetadata", event([{ text: "done" }], { customMetadata: { k: typed, other: "kept" } }), (out) => {
      expect((rawCarry(out, "customMetadata")?.["customMetadata"] as Record<string, unknown> | undefined)?.["other"]).toBe("kept");
    }],
    ["named response in agentState.input", event([{ text: "done" }], { actions: { agentState: { input: untyped } } }), (out) => {
      const input = (rawCarry(out, "agentState")?.["agentState"] as { input?: { parts?: { functionResponse?: Record<string, unknown> }[] } } | undefined)?.input;
      const fr = input?.parts?.[0]?.functionResponse;
      expect(fr?.["id"]).toBe("fetch-key");
      expect(fr?.["name"]).toBe("adk_request_credential");
    }],
  ];
  for (const [label, native, check] of vectors) {
    it(`(adk) ${label}: no secret leaf on the wire or in any text block; non-secret members carried; strict parse; no throw; no resync`, () => {
      const out = drive([native]);
      noSecret(label, out);
      check(out);
    });
  }
  it("(adk) a dropped rendering leaves the same event types as the native with that part removed (twin run)", () => {
    for (const output of [typed, { result: typed, step: 2 }]) {
      const withPart = drive([event([{ text: JSON.stringify(output) }], { output })]).map((e) => e.type);
      const without = drive([event([], { output })]).map((e) => e.type);
      expect(withPart).toEqual(without);
    }
  });
});

describe("§10.33 — ext segment reservation (draft.4; §12)", () => {
  const spec = readFileSync(new URL("../../../SPEC.md", import.meta.url), "utf8");
  const reservedLine = /Reserved segments \([^)]*\):([^.]*)\./.exec(spec)?.[1] ?? "";
  const reserved = new Set([...reservedLine.matchAll(/`([a-z0-9_-]+)`/g)].map((m) => m[1] as string));
  // Types this specification names in full under a reserved segment (the item's carve-out).
  const specNamed = new Set([...spec.matchAll(/`(ext\.[a-z0-9_-]+\.[a-z0-9_.-]+)`/g)].map((m) => m[1] as string));
  it("(reference) every ext.<vendor> segment the reference SDK's packages name or emit is on §12's reserved list", () => {
    expect(reserved.has("agjson")).toBe(true);
    const emitted = new Set<string>();
    const pkgs = new URL("../../", import.meta.url);
    for (const p of ["core", "claude-agent-sdk", "openai-agents", "google-adk", "vercel-ai"]) {
      const dir = new URL(`${p}/src/`, pkgs);
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
        const src = readFileSync(new URL(f, dir), "utf8");
        for (const m of src.matchAll(/["`]ext\.([a-z0-9_-]+)\./g)) emitted.add(m[1] as string);
        for (const m of src.matchAll(/emitExt\(\s*"([a-z0-9_-]+)"/g)) emitted.add(m[1] as string);
        for (const m of src.matchAll(/EXT_VENDOR\s*=\s*"([a-z0-9_-]+)"/g)) emitted.add(m[1] as string);
      }
    }
    const corpus = new URL("../corpus/", import.meta.url);
    for (const d of readdirSync(corpus)) {
      for (const fw of ["claude", "openai", "adk", "vercel"]) {
        const f = new URL(`${d}/${fw}.agjson.json`, corpus);
        if (!existsSync(f)) continue;
        for (const e of JSON.parse(readFileSync(f, "utf8")) as Array<{ type?: unknown }>) {
          const m = typeof e.type === "string" ? /^ext\.([^.]+)\./.exec(e.type) : null;
          if (m) emitted.add(m[1] as string);
        }
      }
    }
    expect(emitted.size).toBeGreaterThan(3);
    expect([...emitted].filter((s) => !reserved.has(s))).toEqual([]);
  });
  it("(third-party) a reserved segment collides unless the whole type is one this specification names", () => {
    const collides = (type: string): boolean => {
      const seg = /^ext\.([^.]+)\./.exec(type)?.[1];
      return seg !== undefined && reserved.has(seg) && !specNamed.has(type);
    };
    expect(specNamed.has("ext.anthropic.frame")).toBe(true);
    expect(specNamed.has("ext.langgraph.custom")).toBe(true);
    expect(collides("ext.anthropic.frame")).toBe(false);
    expect(collides("ext.langgraph.custom")).toBe(false);
    expect(collides("ext.anthropic.mything")).toBe(true);
    expect(collides("ext.vercel.foo")).toBe(true);
    expect(collides("ext.agjson.ignored")).toBe(false);
    expect(collides("ext.acme.frame")).toBe(false);
  });
});

describe("§10.34 — partial-frame carry (draft.4; §8 item 22)", () => {
  it("(scan) no replay golden carries an ext.anthropic.frame whose frame is a result frame, an assistant frame, a permission_denied notice, or a user frame whose every content block is a tool_result", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const bad: string[] = [];
    let frames = 0;
    for (const d of readdirSync(corpus)) {
      const f = new URL(`${d}/claude.agjson.json`, corpus);
      if (!existsSync(f)) continue;
      for (const e of JSON.parse(readFileSync(f, "utf8")) as Array<Record<string, unknown>>) {
        if (e["type"] !== "ext.anthropic.frame") continue;
        frames++;
        const fr = (e["frame"] ?? {}) as Record<string, unknown>;
        const content = ((fr["message"] as Record<string, unknown> | undefined)?.["content"] ?? []) as Array<{ type?: unknown }>;
        const homeOnly =
          fr["type"] === "result" ||
          fr["type"] === "assistant" ||
          (fr["type"] === "system" && fr["subtype"] === "permission_denied") ||
          (fr["type"] === "user" && Array.isArray(content) && content.length > 0 && content.every((b) => b.type === "tool_result"));
        if (homeOnly) bad.push(`${d}@${String(e["seq"])}`);
      }
    }
    expect(frames).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});

describe("§10.35 — sealed-message finalizers and merges (draft.4; §5.0 INV-MSG)", () => {
  const head = [
    { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
    { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
  ];
  const cases: Array<{ name: string; opener: Record<string, unknown>; finalizer: Record<string, unknown> }> = [
    { name: "text.end", opener: { type: "text.start", id: "b1", turnId: "t1" }, finalizer: { type: "text.end", id: "b1" } },
    { name: "reasoning.end", opener: { type: "reasoning.start", id: "r1", turnId: "t1" }, finalizer: { type: "reasoning.end", id: "r1" } },
    { name: "reasoning.opaque", opener: { type: "reasoning.start", id: "r1", turnId: "t1" }, finalizer: { type: "reasoning.opaque", id: "r1", kind: "signature", value: "sig" } },
    { name: "tool.args.assembled", opener: { type: "tool.start", toolCallId: "c1", name: "echo", turnId: "t1" }, finalizer: { type: "tool.args.assembled", toolCallId: "c1", input: {} } },
  ];
  const parse = (evs: Record<string, unknown>[]): AgEvent[] => evs.map((e, i) => AgEvent.parse({ ...e, seq: i }));
  const done = { type: "turn.done", turnId: "t1", outcome: { type: "success" }, finishReason: "stop" };
  for (const c of cases) {
    it(`${c.name} into a sealed message parks and leaves the fold equal to the fold before it; before message.end it folds normally`, () => {
      const before = parse([...head, c.opener, { type: "message.end", id: "m1" }]);
      const after = parse([...head, c.opener, { type: "message.end", id: "m1" }, c.finalizer]);
      const r = reduce(after);
      expect(r.needsResync).toBe(true);
      expect(JSON.stringify(r.result)).toBe(JSON.stringify(reduce(before).result));
      expect(reduce(parse([...head, c.opener, c.finalizer, { type: "message.end", id: "m1" }])).needsResync).toBe(false);
    });
    it(`${c.name} into a message of a closed turn parks; before the turn's terminal it folds normally`, () => {
      const before = parse([...head, c.opener, done]);
      const after = parse([...head, c.opener, done, c.finalizer]);
      const r = reduce(after);
      expect(r.needsResync).toBe(true);
      expect(JSON.stringify(r.result)).toBe(JSON.stringify(reduce(before).result));
      expect(reduce(parse([...head, c.opener, c.finalizer, done])).needsResync).toBe(false);
    });
  }
  it("message.metadata and turn.done{messageId, messageMetadata} naming a sealed message merge onto it without parking", () => {
    const sealed = [...head, { type: "text.start", id: "b1", turnId: "t1" }, { type: "text.delta", id: "b1", delta: "hi" }, { type: "text.end", id: "b1" }, { type: "message.end", id: "m1" }];
    const r1 = reduce(parse([...sealed, { type: "message.metadata", messageId: "m1", metadata: { k: "v" } }]));
    expect(r1.needsResync).toBe(false);
    expect(JSON.stringify(r1.result.messages.find((m) => m.id === "m1"))).toContain("\"k\":\"v\"");
    const r2 = reduce(parse([...sealed, { ...done, messageId: "m1", messageMetadata: { usage: 3 } }]));
    expect(r2.needsResync).toBe(false);
    expect(JSON.stringify(r2.result.messages.find((m) => m.id === "m1"))).toContain("\"usage\":3");
  });
});

describe("§10.36 — nested-turn closure (draft.4; §5.0 INV-TURN, §8.0 item 29)", () => {
  it("every corpus golden: each subagent.start's turn closes with exactly one terminal carrying its turnId and no usage, immediately before its subagent.done; no nested turnId is a top-level turnId; the fold without subagent.done is structurally identical", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const TERMINALS = new Set(["turn.done", "turn.error", "turn.abort"]);
    const bad: string[] = [];
    let nested = 0;
    for (const d of readdirSync(corpus)) {
      for (const fw of ["claude", "openai", "adk", "vercel"]) {
        const f = new URL(`${d}/${fw}.agjson.json`, corpus);
        if (!existsSync(f)) continue;
        const ev = JSON.parse(readFileSync(f, "utf8")) as Array<Record<string, unknown>>;
        const topLevel = new Set(ev.filter((e) => e["type"] === "turn.start").map((e) => e["turnId"]));
        const subs = ev.filter((e) => e["type"] === "subagent.start");
        if (subs.length === 0) continue;
        for (const s of subs) {
          nested++;
          const tid = s["turnId"];
          const at = `${d}/${fw}:${String(tid)}`;
          if (topLevel.has(tid)) bad.push(`${at} reuses a top-level turnId`);
          const terms = ev.flatMap((e, i) => (TERMINALS.has(e["type"] as string) && e["turnId"] === tid ? [i] : []));
          if (terms.length !== 1) { bad.push(`${at} has ${terms.length} terminals`); continue; }
          const ti = terms[0] as number;
          if (ev[ti]?.["usage"] !== undefined) bad.push(`${at} terminal carries usage`);
          const done = ev.findIndex((e) => e["type"] === "subagent.done" && e["turnId"] === tid);
          if (done !== -1 && done !== ti + 1) bad.push(`${at} subagent.done is not immediately after the terminal`);
        }
        const withDone = reduce(ingestAgEvents(ev as unknown as JsonValue[]));
        // Remove subagent.done and renumber seq so the stream stays gap-free (INV-SEQ).
        let seq = 0; let prev = -1;
        const without = ev.filter((e) => e["type"] !== "subagent.done").map((e) => {
          const s0 = e["seq"] as number;
          if (s0 === 0 || s0 < prev) seq = 0; // a 0-restart opens a new invoke
          prev = s0;
          return { ...e, seq: seq++ };
        });
        const withoutDone = reduce(ingestAgEvents(without as unknown as JsonValue[]));
        if (withDone.needsResync || withoutDone.needsResync || !isDeepStrictEqual(withDone.result, withoutDone.result)) bad.push(`${d}/${fw}: the fold differs without subagent.done`);
      }
    }
    expect(nested).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});

describe("§10.23(claude) — an unmapped Claude stop_reason → fallback + finishReasonRaw byte for byte; only on the fallback (sp-claude 44938c2)", () => {
  const result = (stop_reason: string | null) => ({
    type: "result", subtype: "success", result: "all done", stop_reason, is_error: false,
    duration_ms: 0, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0.05,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, inference_geo: "unknown", iterations: [], server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard" },
    modelUsage: { "claude-opus": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20, cacheCreationInputTokens: 10, webSearchRequests: 0, costUSD: 0.05, contextWindow: 200000, maxOutputTokens: 8192 } },
    permission_denials: [], uuid: "00000000-0000-0000-0000-000000000002", session_id: "sess_c23",
  });
  const drive = (stop: string | null): AgEvent[] => {
    const n = createClaudeNormalizer();
    const out = [...n.push(result(stop) as never), ...n.flush()];
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    return out;
  };
  it("stop_reason \"zz_future\" → exactly one turn.done with finishReason \"unknown\" + finishReasonRaw \"zz_future\"; the fold carries it", () => {
    const out = drive("zz_future");
    const dones = out.filter((e) => e.type === "turn.done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ finishReason: "unknown", finishReasonRaw: "zz_future" });
    expect(reduce(out).result.turns[0]).toMatchObject({ finishReason: "unknown", finishReasonRaw: "zz_future" });
  });
  for (const stop of ["end_turn", "stop_sequence", "max_tokens", "model_context_window_exceeded", "tool_use", "pause_turn", "refusal", "compaction", null]) {
    it(`negative: a mapped (or null) stop_reason ${JSON.stringify(stop)} carries no finishReasonRaw`, () => {
      const done = drive(stop).find((e) => e.type === "turn.done");
      expect(done).toBeDefined();
      expect("finishReasonRaw" in (done as object)).toBe(false);
    });
  }
});

describe("§10.23(vercel) — a vercel finish with no AgJSON target → fallback + finishReasonRaw byte for byte (probe c524ece)", () => {
  const USAGE = { inputTokens: 5, inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 }, outputTokens: 7, outputTokenDetails: { textTokens: 4, reasoningTokens: 3 }, totalTokens: 12 };
  const stream = (finish: Record<string, unknown>) => [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "hi" },
    { type: "text-end", id: "t1" },
    { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage: USAGE, response: { id: "resp-s1", timestamp: "1970-01-01T00:00:00.000Z", modelId: "mock-model" } },
    { type: "finish", totalUsage: USAGE, ...finish },
  ];
  const drive = (parts: unknown[]): AgEvent[] => {
    const n = createVercelNormalizer({ invokeId: "c23" });
    const out = [...parts.flatMap((p) => n.push(p as never)), ...n.flush()];
    for (const ev of out) expect(() => AgEvent.parse(ev)).not.toThrow();
    return out;
  };
  it("rawFinishReason \"zz\" behind a unified \"other\" → turn.done finishReason \"other\" + finishReasonRaw \"zz\"", () => {
    expect(drive(stream({ finishReason: "other", rawFinishReason: "zz" })).find((e) => e.type === "turn.done")).toMatchObject({ finishReason: "other", finishReasonRaw: "zz" });
  });
  it("an unrecognized unified value with a raw → \"unknown\" + finishReasonRaw equal to the raw", () => {
    expect(drive(stream({ finishReason: "zz-future", rawFinishReason: "provider_zz" })).find((e) => e.type === "turn.done")).toMatchObject({ finishReason: "unknown", finishReasonRaw: "provider_zz" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.37 — Shared-state fold (draft.4; §5 `state.delta`, pkg-21)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.37 — shared-state fold (draft.4; §5 state.delta)", () => {
  const TS = { type: "turn.start" as const, seq: 0, threadId: "th1", turnId: "t1" };
  const delta = (seq: number, patch: JsonValue): AgEvent => ({ type: "state.delta", seq, patch }) as AgEvent;
  // reduce() and the incremental Reducer must agree on every leg (INV-FOLD).
  const fold = (evs: AgEvent[]) => {
    const batch = reduce(evs);
    const acc = new Reducer();
    for (const e of evs) acc.push(e);
    expect({ state: acc.result().state, needsResync: acc.needsResync }).toEqual({ state: batch.result.state, needsResync: batch.needsResync });
    return batch;
  };

  it("an object patch replaces each top-level key whole: {cfg:{a:1,b:2}} then {cfg:{a:5}} fold to {cfg:{a:5}}, from no working copy", () => {
    const r = fold([TS, delta(1, { cfg: { a: 1, b: 2 } }), delta(2, { cfg: { a: 5 } })]);
    expect(r.needsResync).toBe(false);
    expect(r.result.state).toEqual({ cfg: { a: 5 } });
  });

  it("a null member is stored as a present value, never treated as a deletion", () => {
    const r = fold([TS, delta(1, { k: 1, j: 2 }), delta(2, { k: null })]);
    expect(r.needsResync).toBe(false);
    const state = r.result.state as Record<string, JsonValue>;
    expect("k" in state).toBe(true);
    expect(state).toEqual({ k: null, j: 2 });
  });

  it("a scalar patch (string, number, boolean or null) leaves the working copy unchanged without a resync", () => {
    for (const scalar of ["s", 7, true, null] as JsonValue[]) {
      const r = fold([TS, delta(1, { a: 1 }), delta(2, scalar)]);
      expect({ scalar, needsResync: r.needsResync, state: r.result.state }).toEqual({ scalar, needsResync: false, state: { a: 1 } });
    }
  });

  it("a JSON Patch array against no working copy sets needsResync (never silently based on {})", () => {
    const r = fold([TS, delta(1, [{ op: "add", path: "/a", value: 1 }])]);
    expect(r.needsResync).toBe(true);
    expect(r.result.state).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.38 — ADK shared-state fixture (draft.4; §8.0 item 30)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.38 — ADK shared-state fixture (draft.4; §8.0 item 30)", () => {
  it("(adk) state-fold-gemini38: the committed golden and a fresh normalizer replay of its native both fold to ADK's own session state, without a resync", async () => {
    const dir = new URL("../corpus/state-fold-gemini38/", import.meta.url);
    const truth = JSON.parse(readFileSync(new URL("adk.session-state.json", dir), "utf8")) as JsonValue;
    const native = JSON.parse(readFileSync(new URL("adk.native.json", dir), "utf8")) as JsonValue[];
    // The native stream rewrites part of an object-valued key: cfg={a:1,b:2}, then cfg={a:5}.
    const deltas = native.flatMap((e) => {
      const sd = (e as { actions?: { stateDelta?: Record<string, JsonValue> } }).actions?.stateDelta;
      return sd && "cfg" in sd ? [sd["cfg"]] : [];
    });
    expect(deltas).toEqual([{ a: 1, b: 2 }, { a: 5 }]);
    const golden = JSON.parse(readFileSync(new URL("adk.agjson.json", dir), "utf8")) as AgEvent[];
    const replayed = (await replayNatives(native, "adk")).agjson as unknown as AgEvent[];
    for (const [which, evs] of [["golden", golden], ["replay", replayed]] as const) {
      const r = reduce(evs);
      expect({ which, needsResync: r.needsResync, state: r.result.state }).toEqual({ which, needsResync: false, state: truth });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.39 — Kept-open tool-result snapshot fold (draft.4; §5 tool.done)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.39 — kept-open tool-result snapshot fold (draft.4; §5 tool.done)", () => {
  const PRE = [
    { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
    { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
    { type: "tool.start", seq: 2, toolCallId: "c1", name: "calc", turnId: "t1", threadId: "th1" },
  ] as AgEvent[];
  const td = (seq: number, x: Record<string, unknown>) => ({ type: "tool.done", seq, toolCallId: "c1", turnId: "t1", threadId: "th1", ...x }) as unknown as AgEvent;
  const A = { type: "text", text: "a" }, B = { type: "text", text: "b" }, E = { type: "text", text: "boom" };
  const S = { s: 1 }, U = { u: 1 }, M = { m: 1 }, T = { t: 1 };
  // reduce() and the incremental Reducer agree (INV-FOLD); returns the tool-result blocks for c1.
  const fold = (tail: AgEvent[]) => {
    const evs = [...PRE, ...tail];
    const batch = reduce(evs);
    const acc = new Reducer();
    for (const e of evs) acc.push(e);
    expect(acc.result()).toEqual(batch.result);
    expect(acc.needsResync).toBe(batch.needsResync);
    const blocks = batch.result.messages.flatMap((m) => m.content).filter((b) => b.type === "tool-result" && b.toolCallId === "c1") as unknown as Array<Record<string, unknown>>;
    return { blocks, needsResync: batch.needsResync };
  };

  it("(1) an errored preliminary then an ok final: one block, the final's payload, descriptors kept, providerMetadata merged, nothing stale", () => {
    const r = fold([
      td(3, { more: true, content: [A], outcome: "error", isError: true, errorText: "e", structuredContent: S, uiData: U, _meta: M, toolMetadata: T, providerMetadata: { p: 1 } }),
      td(4, { content: [B], outcome: "ok", providerMetadata: { q: 2 } }),
    ]);
    expect(r.needsResync).toBe(false);
    expect(r.blocks).toHaveLength(1);
    const b = r.blocks[0] as Record<string, unknown>;
    expect({ content: b["content"], outcome: b["outcome"], _meta: b["_meta"], toolMetadata: b["toolMetadata"], providerMetadata: b["providerMetadata"] }).toEqual({ content: [B], outcome: "ok", _meta: M, toolMetadata: T, providerMetadata: { p: 1, q: 2 } });
    for (const k of ["isError", "errorText", "structuredContent", "uiData", "preliminary"]) expect({ k, present: k in b }).toEqual({ k, present: false });
  });

  it("(2) a kept-open structuredContent then an error final without it: the error result alone", () => {
    const r = fold([
      td(3, { more: true, content: [A], outcome: "ok", structuredContent: S }),
      td(4, { content: [E], outcome: "error", isError: true, errorText: "boom" }),
    ]);
    expect(r.needsResync).toBe(false);
    expect(r.blocks).toHaveLength(1);
    const b = r.blocks[0] as Record<string, unknown>;
    expect("structuredContent" in b).toBe(false);
    expect({ outcome: b["outcome"], isError: b["isError"], errorText: b["errorText"], content: b["content"] }).toEqual({ outcome: "error", isError: true, errorText: "boom", content: [E] });
  });

  it("(3) a kept-open uiData then a final carrying uiData:null: the member is present with the value null", () => {
    const r = fold([
      td(3, { more: true, content: [A], outcome: "ok", uiData: U }),
      td(4, { content: [B], outcome: "ok", uiData: null }),
    ]);
    expect(r.needsResync).toBe(false);
    const b = r.blocks[0] as Record<string, unknown>;
    expect("uiData" in b && b["uiData"] === null).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.40 — Flush honesty (draft.4; §5.0 INV-TURN / INV-FLUSH)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.40 — flush honesty (draft.4; §5.0 INV-FLUSH)", () => {
  const CLOSES = new Set(["text.end", "reasoning.end", "step.done", "subagent.done", "message.end"]);
  const TERMINALS = new Set(["turn.done", "turn.abort", "turn.error"]);
  // INV-FLUSH (3): a text.end / reasoning.end at flush carries at most citations, phase and providerMetadata.
  const END_KEYS = new Set(["type", "seq", "id", "turnId", "threadId", "messageId", "provider", "citations", "phase", "providerMetadata"]);
  const make = (fw: string) =>
    fw === "openai" ? createOpenaiNormalizer({ invokeId: "openai" })
    : fw === "adk" ? createAdkNormalizer()
    : fw === "vercel" ? createVercelNormalizer({ invokeId: "vercel" })
    : createClaudeNormalizer({ invokeId: "claude" });

  it("(sweep) every prefix of every corpus native, flushed: only lifecycle closes, message.end, non-success terminals and ext carries (before the terminals); never a success turn.done or content; every opened turn folds to an outcome", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const bad: string[] = [];
    const cuts: Record<string, number> = {};
    for (const dir of readdirSync(corpus).sort()) {
      for (const fw of ["claude", "openai", "adk", "vercel"]) {
        const f = new URL(`${dir}/${fw}.native.json`, corpus);
        if (!existsSync(f)) continue;
        const native = (JSON.parse(readFileSync(f, "utf8")) as JsonValue[]).filter((e) => (e as { type?: string } | null)?.type !== HOST_COMPLETE_MARKER);
        for (let cut = 1; cut <= native.length; cut++) {
          const n = make(fw);
          const pushed: AgEvent[] = [];
          for (const e of native.slice(0, cut)) pushed.push(...(n.push(e as never) as AgEvent[]));
          const flushed = n.flush() as AgEvent[];
          cuts[fw] = (cuts[fw] ?? 0) + 1;
          const at = `${dir}/${fw}@${cut}`;
          let firstTerminal = -1;
          flushed.forEach((e, i) => {
            const ty = e.type as string;
            if (TERMINALS.has(ty) && firstTerminal < 0) firstTerminal = i;
            if (ty.startsWith("ext.")) {
              if (firstTerminal >= 0) bad.push(`${at}: ${ty} after a terminal`);
            } else if (ty === "turn.done") {
              if ((e as { outcome?: { type?: string } }).outcome?.type === "success") bad.push(`${at}: success turn.done at flush`);
            } else if (!CLOSES.has(ty) && !TERMINALS.has(ty)) {
              bad.push(`${at}: ${ty} at flush`);
            }
            if (ty === "text.end" || ty === "reasoning.end") {
              const extra = Object.keys(e).filter((k) => !END_KEYS.has(k));
              if (extra.length) bad.push(`${at}: ${ty} carries ${extra.join(",")}`);
            }
          });
          const turns = reduce([...pushed, ...flushed]).result.turns;
          for (const t of turns) if (t.outcome === undefined) bad.push(`${at}: turn ${t.turnId} has no outcome`);
        }
      }
    }
    expect(bad.slice(0, 20)).toEqual([]);
    // Non-vacuity: every reference normalizer was cut and flushed.
    expect(Object.keys(cuts).sort()).toEqual(["adk", "claude", "openai", "vercel"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.41 — MCP Apps view locator carry (draft.4; §2.1 View locator)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.41 — MCP Apps view locator carry (draft.4; §2.1)", () => {
  // Every `_meta.ui` member found in a value (the native stream, or the tool.done events), as sorted-key JSON.
  const uiMembers = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) for (const x of v) uiMembers(x, out);
    else if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const meta = o["_meta"];
      if (meta !== null && typeof meta === "object" && !Array.isArray(meta) && "ui" in meta) out.push(canon((meta as Record<string, unknown>)["ui"]));
      for (const x of Object.values(o)) uiMembers(x, out);
    }
    return out;
  };
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x !== null && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

  it("every corpus native, replayed through its reference normalizer: the native's MCP Apps _meta.ui members and the emitted tool.done _meta.ui members are the same multiset", async () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const bad: string[] = [];
    const carried: string[] = [];
    for (const dir of readdirSync(corpus).sort()) {
      for (const fw of ["claude", "openai", "adk", "vercel"]) {
        const nf = new URL(`${dir}/${fw}.native.json`, corpus);
        if (!existsSync(nf)) continue;
        const recorded = JSON.parse(readFileSync(nf, "utf8")) as JsonValue[];
        const native = uiMembers(recorded).sort();
        if (native.length === 0) continue;
        const done = ((await replayNatives(recorded, fw as "claude" | "openai" | "adk" | "vercel")).agjson as Array<Record<string, unknown>>)
          .filter((e) => e["type"] === "tool.done")
          .flatMap((e) => {
            const m = e["_meta"] as Record<string, unknown> | undefined;
            return m && "ui" in m ? [canon(m["ui"])] : [];
          })
          .sort();
        if (JSON.stringify(native) !== JSON.stringify(done)) bad.push(`${dir}/${fw}: native ${native.length} vs tool.done ${done.length}`);
        else carried.push(`${dir}/${fw}`);
      }
    }
    expect(bad).toEqual([]);
    // Non-vacuity: the corpus's MCP Apps goldens (claude app-spec/app-update, openai app-spec-structured-result, adk app-spec-gemini36-38).
    expect(carried.length).toBeGreaterThanOrEqual(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.42 — Kept-open results are snapshots (draft.4); vercel leg COVERED-BY
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.42 — kept-open results are snapshots (draft.4)", () => {
  it("(single-delivery) claude, openai and adk goldens carry at most one tool.done per toolCallId, so the item holds trivially for them", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const bad: string[] = [];
    let calls = 0;
    for (const dir of readdirSync(corpus).sort()) {
      for (const fw of ["claude", "openai", "adk"]) {
        const f = new URL(`${dir}/${fw}.agjson.json`, corpus);
        if (!existsSync(f)) continue;
        const counts = new Map<string, number>();
        for (const e of JSON.parse(readFileSync(f, "utf8")) as Array<Record<string, unknown>>) {
          if (e["type"] !== "tool.done") continue;
          const id = String(e["toolCallId"]);
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        for (const [id, c] of counts) {
          calls++;
          if (c > 1) bad.push(`${dir}/${fw}:${id} has ${c} tool.done`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(calls).toBeGreaterThan(0);
  });
});

