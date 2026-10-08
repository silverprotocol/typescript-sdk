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
  ingestAgEvent,
  ingestAgEvents,
  readStoredAgMessage,
  readStoredAgMessages,
  readStoredAgMemoryRecords,
  checkAgInput,
} from "@silverprotocol/core";
import type { AgRecordReport } from "@silverprotocol/core";
import * as coreNs from "@silverprotocol/core";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@silverprotocol/core";
import { createAdkNormalizer, ADK_HOST_COMPLETE_TYPE, ADK_HOST_ERROR_TYPE } from "@silverprotocol/google-adk";
import { replayNatives, HOST_COMPLETE_MARKER, splitHostCompleteMarker } from "./replay.js";
import type { AdkEvent, AdkPart } from "@silverprotocol/google-adk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";
import { createVercelNormalizer } from "@silverprotocol/vercel-ai";

// ─────────────────────────────────────────────────────────────────────────────
// §10 Conformance Suite: executable fixtures for §10's items, so conformance is
// tested, not only described.
//
// Home: packages/e2e, not core. This file needs BOTH the core reduce()/AgEvent
// surface (for the framework-neutral items) AND the facet normalizers
// (createAdkNormalizer / createOpenaiNormalizer) for the framework-scoped
// items — e2e is the one package in this workspace that already depends on
// core + all four facets (claude-agent-sdk, google-adk, openai-agents, vercel-ai).
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
//               openai-agents and vercel-ai exist here — no LangChain/LangGraph/
//               Pydantic-AI facet); the citation names the §8 clause, the §10
//               preamble carve-out or the item's own binding sentence.
//
//   evidence    what backs the disposition, separately from it: "corpus" (a
//               committed capture or replay golden), "fixture-only" (a hand-
//               built vector or an engine-built fixture), "none" (every N/A
//               row, by construction — a covered sub-claim stays in the
//               citation or becomes its own COVERED-BY leg).
//
//   A COVERED-BY row cites the covering test by its it()/describe() TITLE,
//   never a line number: the accounting test greps the cited file for the
//   title (it|describe|test, .skip/.only/.each included; a "…" in a fragment
//   is an elision — use one over a title's own inner quotes), so a moved or
//   renamed title fails here — a rename updates the row in the same commit.
//
// The manifest below accounts for every SPEC.md §10 item NUMBER 1–N, each by
// at least one manifest row. Items 4, 17 and 21 expand into lettered/named
// legs because SPEC.md's own item text splits their claims across sub-claims
// with different testability — "no item silently absent" is enforced per LEG,
// and the accounting test below asserts the union of item numbers is exactly
// the set of §10 item numbers SPEC.md declares.
// ─────────────────────────────────────────────────────────────────────────────

type Disposition = "RUNNABLE" | "COVERED-BY" | "N/A";
type Evidence = "corpus" | "fixture-only" | "none";

interface Section10Item {
  n: number; // SPEC.md §10 item number (1-N; N derived from SPEC.md, see the accounting test)
  leg?: string; // sub-leg label when the item's own text splits its claim
  title: string;
  disposition: Disposition;
  evidence: Evidence; // what backs the disposition; "none" for every N/A row
  citation: string;
}

const SPEC_10_MANIFEST: Section10Item[] = [
  { n: 1, title: "reduce() invariant (full fold table + block insertion order)", disposition: "COVERED-BY", evidence: "fixture-only", citation: "reduce.test.ts describe \"reduce — R10 capstone: byte-identity + live-SSE↔history invariant\" › \"byte-identity: reduce(CAPSTONE_EVENTS) deep-equals the hand-spelled EXPECTED_RESULT (toEqual, order-sensitive)\"" },
  { n: 1, leg: "turn-done-safety", title: "reduce() invariant (§5 turn.done row, rc.1): safety, when present, REPLACES the turn's safety[] as a whole value; the last prompt.blocked's own ratings stay on promptBlocked.safety", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.1 \"turn.done row: prompt.blocked{safety:[A]} then turn.done{safety:[B]} on one turn lands turn.safety deep-equal [B] and promptBlocked.safety deep-equal [A]\"" },
  { n: 1, leg: "prompt-blocked-safety", title: "reduce() invariant (§5 prompt.blocked row, rc.1): each record merges safety[] into the turn's safety and records promptBlocked whole", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.1 \"prompt.blocked row: prompt.blocked{safety:[A]} then prompt.blocked{safety:[B]} on one turn lands promptBlocked equal to the second record and turn.safety deep-equal [A, B]; a third record without safety records promptBlocked with no safety and leaves turn.safety [A, B]\"" },
  { n: 1, leg: "tool-args-provider-metadata", title: "reduce() invariant (§5 tool.args.assembled row, rc.1): providerMetadata merges onto the tool-call block (REPLACE-by-key)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.1 \"tool.args.assembled row: tool.start{providerMetadata:{a:1}} then tool.args.assembled{providerMetadata:{b:2}} lands the tool-call block's providerMetadata deep-equal {a:1, b:2}, and a repeated key takes the later value\"" },
  { n: 1, leg: "nested-turn-thread", title: "reduce() invariant (§5 subagent.start row + INV-OWNER, rc.1 fold rules): a nested turn's threadId is its parent's known thread (a parent known through a message.start's threadId included), else the fold's root thread; a subagent.start with an unopened parentTurnId fabricates no parent record and no record carries a parentTurnId as its threadId (§8.0 item 16); a nested record whose thread is not known is held — result() omits it, no resync — and is released on the first thread known, a terminal folded while held kept; a turns-carrying messages.snapshot discards a held nested record keeping only its held display.required landings, which join the carried record unless an entry with the same provider and html stands for it, stay held for a turn the snapshot omits, and land when that turn is opened again; on every corpus golden carrying a subagent.start the fold needs no resync and no nested record's threadId is its parentTurnId", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.1 (a)–(f) under \"§10.1 — §5 subagent.start row and INV-OWNER (rc.1 fold rules): a nested turn's thread, the held nested record and the snapshot's discard\"; (f) scans every corpus/*/*.agjson.json carrying a subagent.start" },
  { n: 1, leg: "artifact-rows", title: "reduce() invariant (§5 artifact.start/delta/end rows, rc.1 fold rules): name and description land on the record; a second artifact.start for a held artifactId replaces the artifact whole, parts included; append:true concatenates only a text delta onto a last text part, else starts a new part; a delta for an unheld artifactId folds to nothing and occupies its seq slot; a delta after artifact.end still lands", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.1 (v1), (w1), (w2) under \"§10.1 — §5 artifact rows (rc.1 fold rules): name and description on the record, a second artifact.start replaces whole, text-only concatenation, a delta for an unheld artifact folds to nothing\"" },
  { n: 2, title: "Reconnect (forward-gap park + snapshot-resync; backward jump folds normally)", disposition: "COVERED-BY", evidence: "fixture-only", citation: "reduce.test.ts describe \"reduce — R9 new-ops + resync + snapshot + live-only\": the forward-gap / park / snapshot-recovery legs \"(e1) seq-gap sets needsResync; events after gap are ignored until snapshot\", \"(e2) seq-gap → messages.snapshot recovery clears needsResync\", \"(e3) seq-gap → state.snapshot recovery ALSO clears needsResync (both recovery paths)\", \"(e4) parked reducer ignores non-snapshot events; resumes after state.snapshot\", \"(e5) an ext event occupying a seq slot between two closed events does NOT false-park\", \"(e6) a genuine forward gap revealed BY an ext event still parks (gap detection works through ext events)\" and the conditional-replace legs \"(d1) messages.snapshot without turns/artifacts PRESERVES prior artifacts + turns\", \"(d2) full messages.snapshot REPLACEs all three containers + clears transient\", \"(d3) messages.snapshot memory replaces only scope:thread records; non-thread survives\", \"(d4) messages.snapshot clears needsResync (un-parks)\"" },
  { n: 3, title: "Tool-result routing matrix (content/structuredContent/uiData/sideData): channel separation only — structuredContent is model-facing, delivery host-determined, model receipt not asserted (draft.4)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.3" },
  { n: 4, leg: "a", title: "Gemini signature loop — tool-call signature (ingest leg)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.4(a), facet-driven via createAdkNormalizer" },
  { n: 4, leg: "b", title: "Gemini signature loop — thinking-only turn", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.4(b), facet-driven via createAdkNormalizer" },
  { n: 4, leg: "c", title: "Gemini signature loop — Google-Search-grounded turn", disposition: "N/A", evidence: "none", citation: "§10 preamble emit/re-input carve-out; no built-in-tool-step signature carrier in google-adk" },
  { n: 4, leg: "openai", title: "OpenAI stateless reasoning loop (rs_/encrypted_content)", disposition: "N/A", evidence: "none", citation: "§10 preamble emit/re-input carve-out (the ingest-capture sub-claim is COVERED by openai-agents/src/index.test.ts describe \"createOpenaiNormalizer — reasoning_item_created (Task 3, audit M48)\" and describe \"createOpenaiNormalizer — reasoning sourced from the response.completed output\" › \"fold: content[0] is the reasoning block (rs_ itemId + final opaque), content[1] the fc_ tool-call — the §10.4 stateless-replay order\")" },
  { n: 5, title: "Source round-trips (MCP base64 + Anthropic url/file)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.5" },
  { n: 6, title: "Mandatory display (display.required not dropped)", disposition: "COVERED-BY", evidence: "fixture-only", citation: "reduce.test.ts \"(h) display.required appends to AgTurnRecord.displayRequired[]\"" },
  { n: 7, title: "safety_blocked category", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"content_filter incomplete → turn.done error outcome + safety (NOT turn.error)\" (in describe \"createOpenaiNormalizer — response.incomplete error arm (T5c)\"); on @google/adk 2.1.0 no ADK-built event carries safety ratings at either block level (createLlmResponse copies none), so the source provides no category, item 7's SHOULD does not arise there, and safety[] is absent" },
  { n: 8, title: "Cumulative-usage verbatim fold (INV-DELTA)", disposition: "COVERED-BY", evidence: "fixture-only", citation: "reduce.test.ts \"(a) turn.done sets finishReason/usage(verbatim)/safety/outcome; paused → asks[]\" + \"(b2) message.end.usage lands verbatim on AgMessage.usage\"" },
  { n: 8, leg: "turn-terminal", title: "Cumulative-usage verbatim fold (draft.5): a Claude turn terminal's per-turn counters fold with cumulative false and its costUsd, costScope and byModel verbatim; nothing subtracts", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.8(turn-terminal), reduce-level through the consumer ingest" },
  { n: 9, title: "ADK aggregate suppression", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.9, facet-driven via createAdkNormalizer" },
  { n: 10, leg: "content", title: "Index→id re-key (draft.8): the content-block leg — an index-keyed native content stream re-keys to minted stable ids, two same-typed blocks never colliding on one id", disposition: "COVERED-BY", evidence: "fixture-only", citation: "claude-agent-sdk/src/index.test.ts \"continues the content-block index across frames — two same-typed blocks never collide on one id\" (the reference Anthropic normalizer's re-key; §10 item 10 binding sentence, content-block leg)" },
  { n: 10, leg: "tool-call", title: "Index→id re-key (draft.8): the tool-call leg — a tool call whose name or arguments arrive before its stable id", disposition: "N/A", evidence: "none", citation: "§10 item 10 binding sentence (tool-call leg): the reference SDK ships none for that leg" },
  { n: 11, title: "LangGraph positional pause", disposition: "N/A", evidence: "none", citation: "§10 item 11 binding sentence — no positional-resume normalizer in the reference SDK" },
  { n: 12, title: "Interleaved subagent + parent", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.12, reduce-level" },
  { n: 13, title: "Replay-blob round-trips", disposition: "N/A", evidence: "none", citation: "§10 preamble emit/re-input carve-out; the Pydantic CompactionPart and A2A metadata legs: §10 item 13 binding sentence; the ingest-capture sub-claim is COVERED by reduce.test.ts \"(b) reasoning.start + delta + opaque + end → reasoning block; opaque.value round-trips\"" },
  { n: 14, title: "A2UI RPC round-trips (per-arm)", disposition: "COVERED-BY", evidence: "fixture-only", citation: "agjson.test.ts describe \"AgSurfaceInteraction (§3 / §6 / §11.8 un-merge)\"" },
  { n: 15, title: "Gemini parallel ordering", disposition: "N/A", evidence: "none", citation: "§10 preamble emit/re-input carve-out; §8 item 7 scoping" },
  { n: 16, title: "A2A initial-Task (no double-seed on artifact update)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.16, reduce-level" },
  { n: 17, leg: "a", title: "Signature reassembly — reasoning.opaque.delta fragments", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.17(a), reduce-level" },
  { n: 17, leg: "b", title: "Signature reassembly — id-fragmented tool call (Pydantic AI: name and arguments before the id)", disposition: "N/A", evidence: "none", citation: "§10 item 17 binding sentence (id-fragmented leg) — the reference SDK ships none" },
  { n: 18, title: "MCP MRTR requestState round-trip", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.18, wire/schema-level" },
  { n: 19, title: "A2UI component streaming", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.19, wire round-trip" },
  { n: 20, title: "Malformed input at a trust boundary", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.20" },
  { n: 21, leg: "fold", title: "Reasoning-inclusive usage identity — the Gemini fold (thoughts added; absent ⇒ draft.2 bytes; already-inclusive not double-added)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.21(fold), facet-driven via createAdkNormalizer" },
  { n: 21, leg: "replay", title: "Reasoning-inclusive usage identity — input + output (+ toolUseInput) == total on every replay golden with a provider total; a totalTokensRaw beside a totalTokens that differs from it (draft.5)", disposition: "COVERED-BY", evidence: "corpus", citation: "replay.test.ts \"usage obeys the draft.3 inclusion identity (input + output (+ toolUseInput) == total; reasoning <= output)\" (assertUsageIdentity, in each of the four replay CI gates: claude, openai, adk, vercel); the raw-present ⇒ total-present-and-different check rides inside it — a provider's own total rides totalTokensRaw only where it differs from totalTokens" },
  { n: 21, leg: "live-fold", title: "Reasoning-inclusive usage identity (draft.5, Gemini Live): {609, responseTokenCount 25, thoughts 256, total 634} folds to {609, 281, 256, totalTokens 890, totalTokensRaw 634}", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.21(live-fold), facet-driven via createAdkNormalizer" },
  { n: 21, leg: "live-inclusive", title: "Reasoning-inclusive usage identity (draft.5, Gemini Live): a report whose total already counts thoughts {6037, 248, 490, 6775} derives totalTokens 6775 and carries no totalTokensRaw", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.21(live-inclusive), facet-driven via createAdkNormalizer" },
  { n: 21, leg: "live-mixed", title: "Reasoning-inclusive usage identity (draft.5, Gemini Live): the exclusive and inclusive reports summed into one turn fold to {6646, 1019, 746, totalTokens 7665, totalTokensRaw 7409}", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.21(live-mixed), a two-event ADK feed with one turnId" },
  { n: 21, leg: "no-raw-on-candidates", title: "Reasoning-inclusive usage identity (draft.5): none of the draft.3 candidatesTokenCount vectors yields totalTokensRaw", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.21(no-raw-on-candidates)" },
  { n: 22, title: "Forward-compatible ingest (draft.4; draft.8 legs f–g + the built-record clause): an ignored well-formed event occupies its seq slot, is reported in place, and the fold is unchanged; an unknown block type nested in a carrier event and an undefined closed-set value inside a terminal stub the whole event; an unknown top-level member of a record-building event reaches no built record, block or turn while a snapshot-carried member survives", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.22, reference ingest (ingestAgEvents) → reduce" },
  { n: 23, leg: "adk", title: "Unmapped native value (draft.4): an ADK finish reason with no AgJSON target → finishReason other|unknown + finishReasonRaw verbatim; every event AgEvent-valid", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.23(adk) via createAdkNormalizer (e59e976)" },
  { n: 23, leg: "adk-blocked", title: "Unmapped native value (draft.8): an ADK promptFeedback.blockReason with no AgJSON target → prompt.blocked reason other + reasonRaw verbatim; a mapped block reason carries no reasonRaw", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.23(adk-blocked) via createAdkNormalizer over a synthetic promptFeedback native (ADK 2.1.0 builds no promptFeedback event of its own; its prompt block is the errorCode shape §8.0 item 34 recognises, see §10.57; this leg serves other producers of the promptFeedback shape); the facet leg google-adk/src/index.test.ts \"an unmapped promptFeedback.blockReason emits prompt.blocked with reason … and reasonRaw verbatim; a mapped reason carries no reasonRaw\"" },
  { n: 23, leg: "openai", title: "Unmapped native value (draft.4): an OpenAI incomplete_details.reason with no AgJSON target → finishReason unknown + finishReasonRaw verbatim; every event AgEvent-valid", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.23(openai) via createOpenaiNormalizer (the unmapped incomplete_details carry, ff358b6)" },
  { n: 23, leg: "claude", title: "Unmapped native value (draft.4): an unmapped Claude stop_reason → finishReason unknown + finishReasonRaw verbatim; mapped and null stop_reasons carry no finishReasonRaw", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.23(claude) via createClaudeNormalizer (fe87254)" },
  { n: 23, leg: "vercel", title: "Unmapped native value (draft.4): a vercel finish whose unified reason falls back (other/unknown) carries the native rawFinishReason as finishReasonRaw", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.23(vercel) via createVercelNormalizer (f2937f9)" },
  { n: 24, leg: "scan", title: "Tool-result errorText scoping (draft.4): no replay golden carries errorText on a non-error result", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.24(scan), a scan of every corpus/*/*.agjson.json" },
  { n: 24, leg: "adk", title: "ADK failure envelope (draft.4, §8.0 item 25): the error/denied/placeholder/negative vectors", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.24(adk) via createAdkNormalizer (4fa8ba4)" },
  { n: 25, leg: "fold", title: "Framework pause and completion closure (draft.4; the paused close at the invocation's end, draft.7): a pause closes paused as the turn's last event — from push() on the completion signal, else from flush() — an invocation that emits after the pause signal folds without a resync in both modes, completed-without-signal Workflow and cut-short invokes close turn.abort from flush(), never success, no park", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.25(fold) over the engine-built fixtures/adk-pause natives (3c82c3a); step-1 scope mirrored by adk-pause.test.ts" },
  { n: 25, leg: "answer-id", title: "Framework pause and completion closure (draft.4): each ask's toolCallId is the adk_request_* call id (the answering id), one ask per pending request, kind per §8.0 item 26", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.25(answer-id) over fixtures/adk-pause (step 2, 352850a)" },
  { n: 25, leg: "host-completion", title: "Framework pause and completion closure (draft.4): with the §8.0 obligation-4 host-completion event fed, a completed invoke closes turn.done success from push(); a pause closes paused from push() on it, the turn's last event", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.25(host-completion), createAdkNormalizer({ hostCompletion: true }) + ADK_HOST_COMPLETE_TYPE (step 2, 352850a)" },
  { n: 25, leg: "replay", title: "Framework pause and completion closure (draft.4): a golden the normalizer closes on the framework's own events folds unchanged with and without the host-completion event; one it does not closes as obligation 4 directs with it and turn.abort from flush() without it", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.25(replay) over every corpus/*/adk golden, including the live Workflow seeds (371a02c)" },
  { n: 25, leg: "no-pause-signal", title: "Framework pause and completion closure (draft.7): a stream cut after the adk_request_* call with no pause signal closes turn.abort from flush() and never turn.done, bare and with hostCompletion configured but no completion event fed (INV-FLUSH (2)'s truncation rule)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.25(no-pause-signal) over fixtures/adk-pause/after-pause-usage-tail cut after the reserved call" },
  { n: 25, leg: "usage", title: "Framework pause and completion closure (draft.7; stub usage): the paused close carries the invocation's usage — the field-wise sum of every non-partial ADK usageMetadata — and no message.end of the turn carries usage; the SSE-aggregator fixture is asserted only to carry usage on the paused close (its sum is §8.0 item 24's known overcount)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.25(stub usage) over the six after-pause fixtures × 2 modes" },
  { n: 25, leg: "content-after-final", title: "Framework pause and completion closure (draft.4; rc.1): two further ADK fixtures bound by no other criterion of the item: a run that continues after a final response (a SequentialAgent of two answering sub-agents; an agent whose after-agent callback appends content after its final response) folds without a resync with and without the host-completion event, and no message.start or block event names a turn after that turn's terminal; the reference ADK normalizer closes each one's first turn as turn.done success from push() on that final response when it is not configured for the host-completion event", disposition: "COVERED-BY", evidence: "fixture-only", citation: "adk-pause.test.ts \"success-close shape without the opt-in: … closes success from push(), and the content after the close opens the next turn instead of parking\"; \"…: success-close shape — with the sentinel fed it folds clean and closes success from push()\"" },
  { n: 26, leg: "fold", title: "Interim-narration marker (draft.4): phase folds set-if-present on text/reasoning start and end (end REPLACES, absent keeps), undocumented values verbatim, no-phase streams byte-identical to draft.3, INV-FOLD", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.26(fold), reference reduce() + Reducer (2abe30b)" },
  { n: 26, leg: "vercel", title: "Interim-narration marker (draft.4): an OpenAI commentary text part opens phase 'interim'; final_answer / unknown / no bag → no phase; providerMetadata.phase kept verbatim", disposition: "COVERED-BY", evidence: "fixture-only", citation: "vercel-ai/src/index.test.ts describe \"draft.4 phase: an OpenAI commentary text part opens as phase 'interim'\" (commentary → text.start{phase:'interim'}; final_answer/unknown/no bag → no phase key) + describe \"text-start/text-end providerMetadata carry (captured echo-gpt56/gpt6astra/gpt6luna/gpt6sol shape: OpenAI `phase` on both parts)\" (commentary and final answer stay separate blocks, each bag verbatim) (2abe30b)" },
  { n: 26, leg: "openai", title: "Interim-narration marker (draft.4): a commentary + final_answer response yields phase 'interim' on the first item's text.start only; null/\"\" yield neither phase nor providerMetadata.phase", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.26(openai) via createOpenaiNormalizer (the phase carry, 347d550)" },
  { n: 26, leg: "emit", title: "Interim-narration marker (draft.4): no phase in a native re-input payload", disposition: "N/A", evidence: "none", citation: "§10 preamble emit/re-input carve-out: no facet in this repo ships an AgJSON→native emit surface" },
  { n: 27, leg: "fold", title: "Re-delivery never folds twice (draft.4; draft.5 terminals): a second terminal for a closed turn parks whatever its outcome except the paused refresh after a re-sent turn.start (v-g–v-l); re-delivered seq, duplicate *.start id, delta/start into a sealed message or a closed turn, message.start into a closed turn (also across invokes; closure survives a 0-restart and follows the turn records across a messages.snapshot: a carried outcome or an omitted `turns` keeps it, a carried record without an outcome or `turns: []` reopens — draft.5), second final tool.done → resync with the fold unchanged; a later invoke's 0-restart reusing a block id folds; a same-type paused re-close with refreshed asks folds onto the one record (v-g); a forward gap still parks; rc.1 fold rules: a message.start naming an id the fold holds as a message parks with the fold unchanged — open, sealed, snapshot-carried or adopted by a tool.done.messageId, and in a later invoke — while an id a message.remove removed or a snapshot omitted is not held (ix)–(xii); a tool.done with more:true for a call whose final result the invoke landed parks, while a preliminary then the final folds (xiii)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.27(fold) (i)-(xiii), (v-a)-(v-d), (v-f), (v-g), (s-i)-(s-vii), reference Reducer + reduce() (the message.start guard reduce.ts 'a message.start for a turn that already closed parks')" },
  { n: 27, leg: "goldens", title: "Re-delivery never folds twice (draft.4; rc.1 message ids): on every replay golden, block-creating *.start ids are unique within each invoke, and no message.start names an id an earlier message.start or tool.done.messageId of the invoke named", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.27(goldens), a scan of every corpus/*/*.agjson.json" },
  { n: 27, leg: "producers", title: "Re-delivery never folds twice (draft.4): on every replay golden no message.start follows its turn's terminal, or a messages.snapshot carrying the turn with an outcome (draft.5); on every committed resume pair no turn or message id recurs across the two invokes, and the pair folds without a resync; no turnId carries more than one terminal (draft.5)", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.27(producers), a scan of every corpus golden and every <scenario>-resume-<leg> pair" },
  { n: 28, title: "Host-appended events (draft.4): every replay golden plus a host-appended paused hitl.ask turn from lastSeq+1 folds with needsResync false and the turn in turns (§8.0 host obligation 5)", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.28 over every corpus/*/*.agjson.json via ingestAgEvents → reduce" },
  { n: 29, leg: "a", title: "Forward-compatible records: a stored AgMessage/AgMemoryRecord reader omits an unreadable content element or record, reports it with its index and verbatim value, never coerces, and the reports reconstruct the stored value", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.29(a) via core readStoredAgMessage(s)/readStoredAgMemoryRecords (ce5952a; unit legs core/src/record.test.ts)" },
  { n: 29, leg: "b", title: "Forward-compatible inputs: an input that fails the schema other than by an unknown field is rejected whole with one class and one path — protocol first, then version (major-mismatch), then the rest; malformed beats unknown-value; unknown fields pass intact — any same-major prerelease tag accepted, a different major rejected whatever its tag, a missing version malformed (draft.8); a set §12 classes OPEN STRING accepts any string and the checked input carries it unchanged (rc.1)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.29(b) via core checkAgInput (ce5952a; unit legs core/src/input-check.test.ts); the (b8) prerelease vector pins §12's any-prerelease-tag sentence, not item 29's own text; the (b19) vector pins §12's OPEN STRING sentence and item 29's effort clause" },
  { n: 30, leg: "adk", title: "No credential material in authentication requests (draft.4): an ADK-generated OAuth2 request (state + nonce + PKCE in the authorization URI; client secret, tokens, verifier, auth code, standalone state/nonce seeded) emits no seeded secret at any depth, raw or JSON-escaped; state/nonce appear only inside the byte-equal ADK-issued authorization URI", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.30(adk) over fixtures/adk-pause/plain-credential-authuri (engine-built by ADK 2.1.0 generateAuthUri)" },
  { n: 30, leg: "claude", title: "No credential material in authentication requests (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 30, leg: "openai", title: "No credential material in authentication requests (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 30, leg: "vercel", title: "No credential material in authentication requests (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 31, leg: "adk", title: "Credential objects omitted from shared state (draft.4): credential-object entries (any depth, both spellings, whole AuthConfig, resourceRef-only, useDefaultCredential), or a state map that is itself one (the whole map: {}), temp: entries and an own __proto__ are omitted; one state.delta per native change ({} when empty); ordinary entries of a non-credential map byte-identical; push() never throws", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/index.test.ts \"state.delta omits every entry holding an ADK credential …\", \"… snake_case form, a credential nested at any depth …\", \"… a whole ADK AuthConfig stored in state …\", \"… useDefaultCredential …\", \"… resourceRef …\", \"… exactly one event per native state change …\", \"state.delta never throws …\", \"a rebuilt state map carries no reserved key …\", \"negative control: a state delta with no ADK credential …\", \"state.delta: §8.0 item 28(b) holds for every patch shape\"" },
  { n: 31, leg: "claude", title: "Credential objects omitted from shared state (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 31, leg: "openai", title: "Credential objects omitted from shared state (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 31, leg: "vercel", title: "Credential objects omitted from shared state (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 32, leg: "adk", title: "Credential material off provider-raw carries (draft.4): a typed ADK auth configuration as agentState.input, as output with its rendering, at output.result with its rendering and in customMetadata, and an untyped reply inside a response named adk_request_credential, leave no secret leaf raw or JSON-escaped; non-secret members byte-identical to the native; no text block from a rendering part; strict parse, no throw, no resync", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.32(adk) (unit legs google-adk/src/index.test.ts \"node data: …\", \"rendering: …\", \"every provider-raw carry reduces …\"; the full-carry reduction 63eb8c2)" },
  { n: 32, leg: "adk-goldens", title: "Credential material off provider-raw carries (draft.4): on every replay golden the rule changes no byte of the serialized stream", disposition: "COVERED-BY", evidence: "corpus", citation: "replay.test.ts \"agjson deep-equals the committed adk.agjson.json snapshot\" (the committed goldens are the serialized stream; the rule's landing left every byte unchanged — serialized old-vs-new dumps over every corpus native + fixtures/adk-pause, with and without the host-completion marker: 92/92 byte-identical at 63eb8c2)" },
  { n: 32, leg: "claude", title: "Credential material off provider-raw carries (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 32, leg: "openai", title: "Credential material off provider-raw carries (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 32, leg: "vercel", title: "Credential material off provider-raw carries (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 preamble / §8.0 applicability: item 28 defines no framework credential object for this framework" },
  { n: 33, leg: "reference", title: "Ext segment reservation (draft.4): the reference SDK's normalizers (and core) emit only segments on §12's reserved list", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.33(reference): §12's reserved list parsed from SPEC.md vs every ext.<vendor> segment named in the packages' sources and found in every corpus golden" },
  { n: 33, leg: "third-party", title: "Ext segment reservation (draft.4): a normalizer outside the reference SDK emits no reserved segment unless the whole type is one the spec names", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.33(third-party): the collision rule over a table of third-party types, the spec-named carve-out included" },
  { n: 34, leg: "scan", title: "Partial-frame carry (draft.4): no replay golden carries an ext.anthropic.frame whose frame is a result frame, an assistant frame, a permission_denied notice, or a user frame whose every content block is a tool_result", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.34(scan) over every corpus/*/claude.agjson.json" },
  { n: 34, leg: "claude-refusal", title: "Partial-frame carry (draft.4): a Claude model_refusal_fallback frame yields its message.remove events, then exactly one ext.anthropic.frame{kind:\"model_refusal_fallback\"} deep-equal to the native frame", disposition: "COVERED-BY", evidence: "fixture-only", citation: "claude-agent-sdk/src/index.test.ts \"carries the WHOLE fallback frame verbatim as ext.anthropic.frame{kind:model_refusal_fallback}, after its removes\" + \"the CLI's isSynthetic nudge rides ext.anthropic.frame{kind:'user'} verbatim …\"" },
  { n: 34, leg: "openai", title: "Partial-frame carry (draft.4)", disposition: "N/A", evidence: "none", citation: "§8 item 22 applicability: the openai facet has no frame that maps only in part and rides ext.openai.frame" },
  { n: 34, leg: "adk", title: "Partial-frame carry (draft.4)", disposition: "N/A", evidence: "none", citation: "§8 item 22 applicability: the google-adk facet has no frame that maps only in part and rides ext.google.frame" },
  { n: 34, leg: "vercel", title: "Partial-frame carry (draft.4)", disposition: "N/A", evidence: "none", citation: "§8 item 22 applicability: the vercel-ai facet has no frame that maps only in part and rides ext.vercel.frame" },
  { n: 35, title: "Sealed-message finalizers and merges (draft.4; draft.5 whole-bag messageMetadata): text.end / reasoning.end / reasoning.opaque / tool.args.assembled into a sealed message or any message of a closed turn park with the fold equal to the fold before them; the same events fold before the seal / terminal; message.metadata and turn.done{messageId, messageMetadata} naming a sealed message merge without parking", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.35 (reference reducer guard 803ce13; delta and block-creating legs: §10.27)" },
  { n: 36, leg: "claude", title: "Nested-turn closure (draft.4): for every subagent.start, exactly one turn.done|turn.error|turn.abort with that turnId, no usage, immediately before its subagent.done; no nested turnId equals a turn.start turnId; the fold without subagent.done is structurally identical", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.36 over every corpus golden with subagent.start (claude B-strict 7f315e2 + regen 5cdade3)" },
  { n: 36, leg: "openai", title: "Nested-turn closure (draft.4): a handoff's nested turn closes at handoff_occurred with turn.done{success, finishReason unknown, no usage} immediately before its subagent.done; the fold without subagent.done is structurally identical; the handoff event follows the bracket's subagent.done on the source turn and carries kind transfer (draft.5 §8.0 item 29)", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.36 over every corpus golden with subagent.start (openai: handoff-gpt6sol, enrolled 450ece8); unit legs openai-agents/src/index.test.ts \"createOpenaiNormalizer — HO handoff close (the transfer result + the nested terminal)\"" },
  { n: 36, leg: "adk", title: "Nested-turn closure (draft.4; draft.5 escalate): an ADK event with actions.escalate yields exactly one handoff{kind:escalate} with no toAgentName and no subagent.start (§8.0 item 29)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.36(adk-escalate), createAdkNormalizer fixture (no committed escalate capture)" },
  { n: 36, leg: "vercel", title: "Nested-turn closure (draft.4)", disposition: "N/A", evidence: "none", citation: "§8.0 applicability: this facet emits no subagent.* (no nested turns)" },
  { n: 37, title: "Shared-state fold (draft.4): an object patch replaces each top-level key whole ({cfg:{a:1,b:2}} then {cfg:{a:5}} → {cfg:{a:5}}); a null member is stored present; a scalar patch is a no-op without a resync; a JSON Patch array against no working copy sets needsResync; a sibling member survives a key-replace patch and only a state.snapshot removes it (draft.5)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.37, reference reduce() + Reducer (6e69589)" },
  { n: 38, leg: "adk", title: "ADK shared-state fixture (draft.4): the golden whose native stream rewrites part of an object-valued key folds to ADK's own session state, without a resync", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.38(adk): state-fold-gemini38, the committed golden and a fresh createAdkNormalizer replay of its native, vs adk.session-state.json (7f3bce9; every sidecar also gated by replay.test.ts describe \"shared state — the reference fold equals the framework's own session state (session-state sidecars)\")" },
  { n: 38, leg: "claude", title: "ADK shared-state fixture (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 item 38's own scoping binds the google-adk normalizer: the Claude Agent SDK has no key-addressed shared state" },
  { n: 38, leg: "openai", title: "ADK shared-state fixture (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 item 38's own scoping binds the google-adk normalizer: the OpenAI Agents SDK has no key-addressed shared state" },
  { n: 38, leg: "vercel", title: "ADK shared-state fixture (draft.4)", disposition: "N/A", evidence: "none", citation: "§10 item 38's own scoping binds the google-adk normalizer: the Vercel AI SDK has no key-addressed shared state" },
  { n: 39, title: "Kept-open tool-result snapshot fold (draft.4): a later tool.done replaces the payload as a unit (omitted payload fields clear, uiData and structuredContent included), _meta/toolMetadata kept unless re-sent, providerMetadata merged by key, preliminary cleared; an error final clears an earlier structuredContent; a carried uiData:null is stored present", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.39, reference reduce() + Reducer (f2ba05d + uiData flip 22c8084)" },
  { n: 40, leg: "sweep", title: "Flush honesty (draft.4): every prefix of every corpus native, flushed by its reference normalizer, emits only lifecycle closes, message.end, non-success terminals and ext carries (the carries before the terminals), never a success turn.done or content, and every opened turn folds to an outcome", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.40(sweep) over every corpus/*/<fw>.native.json via the four reference normalizers" },
  { n: 40, leg: "claude", title: "Flush honesty (draft.4): a Claude stream cut mid-turn with open text, reasoning and a partial tool call flushes content-free lifecycle closes only", disposition: "COVERED-BY", evidence: "fixture-only", citation: "claude-agent-sdk/src/index.test.ts \"createClaudeNormalizer — C1: flush never mints content\" › \"leg (a): every flush() event is a content-free lifecycle close; …\"" },
  { n: 40, leg: "openai", title: "Flush honesty (draft.4): the approval interruption flushes exactly one turn.done{paused, one approval ask, usage U}; without the approval, turn.abort{stream-truncated} and a message.end carrying U", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"createOpenaiNormalizer — O1 honest flush (fold/flush option 1)\" › the two \"§10.26 leg: …\" cases (the item's pre-landing number)" },
  { n: 40, leg: "adk", title: "Flush honesty (draft.7): an ADK stream cut mid-turn after a pause signal flushes exactly one paused turn.done, the turn's last event, and no turn.abort for that turn — INV-FLUSH (2)'s paused release is the only turn.done a flush emits", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.25 (§10.40 adk) over fixtures/adk-pause/after-pause-callback cut after the pause signal" },
  { n: 40, leg: "adk-error-turn", title: "Flush honesty (rc.1): every prefix of every engine-built ADK error and pause native, flushed bare, emits a turn.start and a message.start only for the one error turn INV-FLUSH (3) admits after a paused release — that turn's turn.start, one message.start and one message.end for a message with no content and no usage, and its turn.error — and some prefix exercises it", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.40(adk fixtures) over every prefix of every fixtures/adk-error and fixtures/adk-pause native" },
  { n: 41, title: "MCP Apps view locator carry (draft.4): every native tool result's MCP Apps _meta.ui reaches its tool.done's _meta.ui deep-equal", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.41: every corpus native carrying _meta.ui, replayed through its reference normalizer (claude, openai, adk)" },
  { n: 42, leg: "vercel", title: "Kept-open results are snapshots (draft.4): yield/yield/return and yield/throw emit full snapshots; the error final carries E's message and no structuredContent", disposition: "COVERED-BY", evidence: "fixture-only", citation: "vercel-ai/src/index.test.ts \"§10 item 42 — kept-open results are snapshots (yield/yield/return, yield/throw)\" (bec1308)" },
  { n: 42, leg: "single-delivery", title: "Kept-open results are snapshots (draft.4): claude, openai and adk never emit more than one tool.done per call, so they satisfy the item trivially", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.42(single-delivery), a scan of every corpus/*/{claude,openai,adk}.agjson.json" },
  { n: 43, title: "Never-opened terminals (draft.4): a terminal for a turn not seen opened folds to no record without a resync; a snapshot carrying turns replaces what is seen, one omitting turns keeps it; a seen turn with no record takes its snapshot message's threadId or gets no record; no created record carries a threadId no event carried; on every replay golden each terminal follows its turn's opener in the invoke", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.43, reference reduce() + Reducer (f3d5256 + the snapshot rework) and a scan of every corpus/*/*.agjson.json" },
  { n: 44, leg: "adk", title: "MCP resource links (draft.5, §8.0 item 31): N resource_link parts → N resource-link blocks in native order, members verbatim and absent where absent; a residual provider-raw only for icons, a mistyped size or a member the schema would alter; a signed uri byte-equal; item 28 reductions inside the link; a uri-less part stays one reduced provider-raw", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/index.test.ts \"createAdkNormalizer — an MCP resource_link part becomes one resource-link block, with a residual-only provider-raw\" (the §10 item 44 case, the residual-verbatim case, the item-28 case, the uri-less case, the signed-uri case)" },
  { n: 44, leg: "golden", title: "MCP resource links (draft.5): resource-link-gemini38/adk's linking-call tool.done holds exactly one resource-link whose members equal the native resource_link part's, and no provider-raw for that link", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.44(golden)" },
  { n: 44, leg: "not-bound", title: "MCP resource links (draft.5): no claude, openai or vercel golden emits a resource-link block into tool.done.content (§8 applicability: none of the three emits an MCP link part into content today)", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.44(not-bound), a scan of every corpus/*/{claude,openai,vercel}.agjson.json" },
  { n: 44, leg: "claude", title: "MCP resource links (draft.5)", disposition: "N/A", evidence: "none", citation: "§8.0 item 31 applicability: the claude-agent-sdk facet delivers an MCP link to the model as rendered text and carries the structured list as a host record (§2.1); it emits no link part into tool.done.content" },
  { n: 44, leg: "openai", title: "MCP resource links (draft.5)", disposition: "N/A", evidence: "none", citation: "§8.0 item 31 applicability: the openai-agents facet receives MCP output stringified and emits no link part into tool.done.content" },
  { n: 44, leg: "vercel", title: "MCP resource links (draft.5)", disposition: "N/A", evidence: "none", citation: "§8.0 item 31 applicability: the vercel-ai facet routes the whole CallToolResult to structuredContent and emits no link part into tool.done.content" },
  { n: 45, leg: "scan", title: "Host records are side metadata (draft.5): on every claude-agent-sdk golden no event's providerMetadata has a top-level member named a host-record key (the wrapper keys, resourceLinks, the denial keys, the notice siblings)", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.45(scan), a scan of every corpus/*/claude.agjson.json" },
  { n: 45, leg: "resourceLinks", title: "Host records are side metadata (draft.5): resource-link-sonnet5's adopted tool.done carries _meta[\"anthropic/resourceLinks\"] deep-equal to the native tool_use_result.resourceLinks and no providerMetadata member", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.45(resourceLinks)" },
  { n: 45, leg: "message-metadata", title: "Host records are side metadata (draft.5): multi-result-sonnet5's native user_message_uuid / user_message_uuids values each appear verbatim in the folded AgMessage.metadata of that frame's message (a tool-first frame lands them on a message.metadata event)", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.45(message-metadata)" },
  { n: 45, leg: "claude-host-record", title: "Host records are side metadata (draft.5, §2.1): subagent-fg-sonnet5's Agent tool.done carries _meta[\"anthropic/agentOutput\"] deep-equal to the native tool_use_result minus content and prompt, and no providerMetadata member agentOutput", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.45(claude-host-record)" },
  { n: 45, leg: "reducer", title: "Host records are side metadata (draft.5): on every corpus golden, a fold with every _meta member and every message.metadata event removed yields turns[*].usage and messages[*].usage deep-equal to the full fold (a reducer never sums a host record's usage)", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.45(reducer), reference reduce() over every corpus/*/*.agjson.json" },
  { n: 45, leg: "synthetic", title: "Host records are side metadata (draft.5): one synthetic leg per key the corpus never shows (usage_report, context_usage, resume_reason, aborted, supersedes, the three denial keys, the three notice siblings), each on its _meta target and on no providerMetadata; the tool-first frame lands on message.metadata; resumed_from_incomplete_thinking stays on providerMetadata", disposition: "COVERED-BY", evidence: "fixture-only", citation: "claude-agent-sdk/src/index.test.ts \"createClaudeNormalizer — §10 item 45: host records ride _meta, never providerMetadata (draft.5)\"" },
  { n: 45, leg: "openai", title: "Host records are side metadata (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: the keys are the claude-agent-sdk facet's; the reducer leg binds every fold" },
  { n: 45, leg: "adk", title: "Host records are side metadata (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: the keys are the claude-agent-sdk facet's; the reducer leg binds every fold" },
  { n: 45, leg: "vercel", title: "Host records are side metadata (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: the keys are the claude-agent-sdk facet's; the reducer leg binds every fold" },
  { n: 46, leg: "openai", title: "OpenAI handoff round release (draft.5, §8.0 item 14): legs a–e (the two-transfer stream releases the source round at handoff_occurred with its deferred outcome and usage; a late c2 output rides ext, never a tool.done; an early c2 output drains the round; a pending program call keeps it deferred), f′ (an acknowledged call keeps the round deferred; flush → message.end{U} then turn.abort), g (f's late output drains to turn.done{success, U}, with and without c2), h (an approval-pending call → turn.done{paused} naming only f's ask) and i (an unmapped run-item counts as a run-item)", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"createOpenaiNormalizer — HO-P handoff round release (§8.0 item 14)\" (its \"§10.44 leg …\" cases carry the item's pre-landing number)" },
  { n: 46, leg: "golden", title: "OpenAI handoff round release (draft.5): handoff-parallel-gpt6sol folds with no resync and no turn.abort; the source turn closes success with usage on its turn.done and none on its message.end; the ignored transfer keeps a tool.start with no tool.done and one ext.openai.dropped-call before the source terminal", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.46(golden)" },
  { n: 46, leg: "claude", title: "OpenAI handoff round release (draft.5)", disposition: "N/A", evidence: "none", citation: "§8.0 item 14 applicability: the release binds OpenAI-Agents-targeting normalizers" },
  { n: 46, leg: "adk", title: "OpenAI handoff round release (draft.5)", disposition: "N/A", evidence: "none", citation: "§8.0 item 14 applicability: the release binds OpenAI-Agents-targeting normalizers" },
  { n: 46, leg: "vercel", title: "OpenAI handoff round release (draft.5)", disposition: "N/A", evidence: "none", citation: "§8.0 item 14 applicability: the release binds OpenAI-Agents-targeting normalizers" },
  { n: 47, leg: "reducer", title: "Cross-invoke tool result (draft.5, §5.0 INV-XINV): a paused invoke then a 0-restart invoke landing tool.done {turnId, messageId:\"x:result\"} and closing its turn folds with no resync, the result in a role:\"tool\" message of the second turn; one tool-call and one tool-result for the id in different turns", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.47(reducer), reference Reducer + reduce()" },
  { n: 47, leg: "reducer-reuse", title: "Cross-invoke tool result (draft.5): four invokes reusing toolCallId x, each landing invoke closing its turn, its turnId unique and its messageId \"<turnId>:x:result\", fold with no resync into two role:\"tool\" messages, each in its landing invoke's turn", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.47(reducer-reuse)" },
  { n: 47, leg: "pair-openai", title: "Cross-invoke tool result (draft.5): approval-tool-gpt6sol with its resume-approve and resume-reject goldens — each invoke and the pair through one Reducer fold with no resync; the resume has no tool.start and exactly one tool.done for the carried callId, in its own turn, on a messageId the earlier invoke never used, as a role:\"tool\" message; the earlier turn record unchanged", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.47(pair-openai) over the enrolled goldens" },
  { n: 47, leg: "pair-claude", title: "Cross-invoke tool result (draft.5): defer-tool-sonnet5 with its resume-allow and resume-deny goldens — the same id and fold assertions; the allowed resume lands outcome ok and the denied resume outcome denied with neither errorText nor isError", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.47(pair-claude) over the committed goldens (the resume legs are enrolled in replay at the cohort's regen)" },
  { n: 47, leg: "pair-claude-paused-close", title: "Claude deferred pause (draft.5, §8.0 item 32): the deferring invoke's last terminal is turn.done{paused, finishReason paused, no finishReasonRaw} from push() with exactly one approval ask naming the deferred id, preceded by a hitl.ask with the same askId", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.47(pair-claude-paused-close) over the defer-tool-sonnet5 golden (red until the cohort's claude-agent-sdk change and its regen land)" },
  { n: 47, leg: "pair-vercel", title: "Cross-invoke tool result (draft.5): a streamText call whose initial pass settles a prior call's approval, as a synthetic pair — the prior-call result lands as a role:\"tool\" message on messageId \"<toolCallId>:result\" with no resync", disposition: "COVERED-BY", evidence: "fixture-only", citation: "vercel-ai/src/index.test.ts \"§10 item 47 leg pair-vercel (c20; flipped from the 0.7.x KNOWN GAP): after a prior invoke that opened the calls, both prior-call results fold into role:'tool' messages of this invoke's turn, through one Reducer, without parking\" (landed as c56f88d)" },
  { n: 47, leg: "adk", title: "Cross-invoke tool result (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: no committed ADK two-invoke pair; ADK's confirmation reply opens a new invocation and is a later leg" },
  { n: 50, leg: "fold", title: "Cache-inclusive inputTokens and per-object usage scope (draft.5): an Anthropic result frame usage {2, 6858, 187, 73}, cost 0.0166347, modelUsage {6, 13716, 4061, 275, 0.0156577} → a turn terminal usage {7047, 6858, 187, 73, costUsd 0.0166347, costScope query}, cumulative not true, byModel {17783, 13716, 4061, 275, 0.0156577, cumulative true}; both cache counters absent → inputTokens 2 and no cache key", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.50(fold), facet-driven via createClaudeNormalizer" },
  { n: 50, leg: "replay", title: "Cache-inclusive inputTokens and per-object usage scope (draft.5): on every replay golden every AgUsage at any depth carrying a cache counter satisfies inputTokens >= cacheRead + cacheWrite; on every Claude golden the exact native equality, no cumulative:true on a turn terminal, costScope query beside costUsd, cumulative:true on every byModel entry, no placeholder message.end outputTokens without stream events, partials-sonnet5 143 + 45 == 188", disposition: "COVERED-BY", evidence: "corpus", citation: "replay.test.ts \"usage obeys the draft.5 inclusion rules (cache-inclusive inputTokens; the claude flags, costScope and exact native sums)\" (assertUsageInclusion, in each of the four replay CI gates) for the corpus scans; the placeholder omission and the streamed twin are pinned in claude-agent-sdk/src/index.test.ts, describe \"createClaudeNormalizer — draft.5 usage accounting\" (\"message level, no partials: … the placeholder outputTokens omitted\", \"message level, streamed: message_delta's real output count is kept …\") and the acceptance-bar test of describe \"createClaudeNormalizer — stream_event partials (workspace#7)\"" },
  { n: 50, leg: "scope", title: "Cache-inclusive inputTokens and per-object usage scope (draft.5): over multi-result-sonnet5's two terminals the top-level outputTokens are 59 and 59, costUsd is non-decreasing, every byModel counter is non-decreasing, and the last byModel outputTokens equals 59 + 59", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.50(scope), the cassette driven through createClaudeNormalizer" },
  { n: 50, leg: "consumer", title: "Cache-inclusive inputTokens and per-object usage scope (draft.5): a turn.done usage carrying costScope, a cumulative:true byModel entry and a totalTokensRaw beside its totalTokens survives ingestAgEvents + reduce() verbatim into turns[0].usage, and AgEvent.parse keeps both keys", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.50(consumer), beside the nested pass-through case" },
  { n: 50, leg: "openai", title: "Cache-inclusive inputTokens and per-object usage scope (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: the exact-equality, flag, costScope and placeholder legs are the claude-agent-sdk facet's; the depth-any >= scan binds this producer's goldens through the replay leg" },
  { n: 50, leg: "adk", title: "Cache-inclusive inputTokens and per-object usage scope (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: the exact-equality, flag, costScope and placeholder legs are the claude-agent-sdk facet's; the depth-any >= scan binds this producer's goldens through the replay leg" },
  { n: 50, leg: "vercel", title: "Cache-inclusive inputTokens and per-object usage scope (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: the exact-equality, flag, costScope and placeholder legs are the claude-agent-sdk facet's; the depth-any >= scan binds this producer's goldens through the replay leg" },
  { n: 48, title: "Record events on unopened turns (draft.5, §5.0 INV-OWNER): for each of the six record events — alone: no record, no resync; before its turn.start: one record with the opener's thread and the landing; after a turns-less snapshot naming the turn by message: one record with that thread; message.start alone gives display.required its record; a tool.done into a held turn parks and creates no message; a turnId-less turn.error after a closed turn parks and leaves usage/outcome; no record or message carries a thread no event carried (vectors + every corpus golden)", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.48 (a)-(h), reference Reducer + reduce(); the hold/adopt/cap unit vectors in core reduce.test.ts describe \"draft.5 §5.0 INV-OWNER: a record event for a turn whose thread is not known is held, and lands on that turn's thread\"" },
  { n: 49, title: "Opener first for record events (draft.5): on every replay golden, each prompt.blocked / guardrail.result / agent.capabilities / source / handoff / display.required names, or resolves by messageId to, a turn a turn.start or subagent.start opened earlier in that invoke (types with no corpus instance pass vacuously and are counted)", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.49(producers), a scan of every corpus/*/*.agjson.json" },
  { n: 51, title: "Persistable projection (draft.5; memory scopes draft.6): toPersistable omits every turn's displayRequired[] and every memory record whose scope is neither thread nor declared (absent = none), toPersistableWithReport reports each omitted record by (scope, key) in fold order, and changes nothing else; the fold is not mutated; on every replay golden the projection equals the fold with displayRequired and every non-thread memory record omitted, and the report is empty", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.51, reduce-level" },
  { n: 52, leg: "claude", title: "No provider credit token (draft.5, §13.10): a complete assistant frame whose stop_details holds fallback_credit_token at the top and at depth, a tool_result_meta remedy holding the same key, and a tool call whose input holds it as user content → no occurrence of the token value in the events or the fold; stop_details carried less every token with recommended_model verbatim; the tool_result block's _meta entry less the key; the tool call's input keeps the user-authored key", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.52(claude), facet-driven via createClaudeNormalizer + Reducer; the remedy leg runs on the landed claude tool_result_meta carry" },
  { n: 52, leg: "vercel", title: "No provider credit token (draft.5): a finish step whose providerMetadata.anthropic.stopDetails holds fallback_credit_token / fallbackCreditToken at the top and at depth → no occurrence in the events or the fold; the step's folded message metadata.stopDetails carries the object less every token with recommendedModel verbatim", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.52(vercel), facet-driven via createVercelNormalizer" },
  { n: 52, leg: "openai", title: "No provider credit token (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: no Anthropic stop_details surface on the openai-agents wire" },
  { n: 52, leg: "adk", title: "No provider credit token (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: no Anthropic stop_details surface on the google-adk wire" },
  { n: 53, leg: "a", title: "Reported-fix carriage and durability (draft.5, §8.0 item): (a) the CLI's tool_result_meta entry rides tool.done._meta[\"anthropic/toolResultMeta\"], merged beside an MCP sibling key, a tool-authored key under the reserved prefix dropped, none of it under providerMetadata", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.53(a), facet-driven via createClaudeNormalizer" },
  { n: 53, leg: "b", title: "Reported-fix carriage and durability (draft.5): (b) the six remedy-shaped host-only wrapper keys (api_error, api_error_params, api_error_code, error_details, advisor_model, attribution_agent) fold by their wire names onto the first block's _meta when the frame opens with text, else onto the message via message.metadata; none under providerMetadata", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.53(b), facet-driven via createClaudeNormalizer" },
  { n: 53, leg: "c", title: "Reported-fix carriage and durability (draft.5): (c) a complete assistant frame's non-null stop_details closes with turn.done{messageId, messageMetadata:{stop_details}} naming that message; the folded messageMetadata deep-equals it", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.53(c), facet-driven via createClaudeNormalizer" },
  { n: 53, leg: "d", title: "Reported-fix carriage and durability (draft.5): (d) an OpenAI response error carrying misalignment yields, before the turn.error, one role:notice noticeSource:adapter message whose text is detailed_explanation and whose block _meta[\"openai/misalignment\"] deep-equals the native object; with none, no notice", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.53(d), facet-driven via createOpenaiNormalizer" },
  { n: 53, leg: "e", title: "Reported-fix carriage and durability (draft.5): (e) an ADK waiting credential request yields one hitl.ask{kind:auth} per pending request in the paused asks[] and no turn.error", disposition: "COVERED-BY", evidence: "fixture-only", citation: "spec-conformance.test.ts describe \"§10.25 — framework pause and completion closure…\" legs (fold)+(answer-id) over fixtures/adk-pause (plain-credential, plain-credential-authuri, wf-functionnode-credential); google-adk/src/index.test.ts item-12 map path; thin re-assertion in §10.53(e)" },
  { n: 53, leg: "f", title: "Reported-fix carriage and durability (draft.5): (f) a tool result whose structuredContent and own _meta carry a remedy-shaped object with a URL, with no CLI entry, yields no key under the reserved anthropic/ prefix and that URL in no harness carrier (reserved-prefix _meta, message.metadata, ext.*); the tool's own _meta rides as tool content", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.53(f), facet-driven via createClaudeNormalizer" },
  { n: 53, leg: "g", title: "Reported-fix carriage and durability (draft.5): (g) for each of (a)–(d), a fresh reducer fed a messages.snapshot built from the first fold's result yields a structurally equal result with no resync (INV-FOLD)", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.53(g), reduce-level" },
  { n: 53, leg: "vercel", title: "Reported-fix carriage and durability (draft.5)", disposition: "N/A", evidence: "none", citation: "no remedy or stopDetails carry at this version; §10 preamble applicability" },
  { n: 54, leg: "reducer", title: "Error-outcome retriable (draft.5): turn.error{retriable:false} folds outcome.retriable false on both reducers; an absent retriable stays absent (never coerced to false); a non-terminal error{retriable:true} before the turn.error never folds", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.54(reducer), reference Reducer + reduce()" },
  { n: 54, leg: "claude", title: "Error-outcome retriable (draft.5): the two committed Claude API-error goldens each fold exactly one errored turn with outcome.retriable false", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.54(claude) over corpus api-error-auth and defer-tool-sonnet5-resume-unavailable" },
  { n: 54, leg: "openai", title: "Error-outcome retriable (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: no committed golden carries turn.error.retriable" },
  { n: 54, leg: "adk", title: "Error-outcome retriable (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: no committed golden carries turn.error.retriable" },
  { n: 54, leg: "vercel", title: "Error-outcome retriable (draft.5)", disposition: "N/A", evidence: "none", citation: "§8 applicability: the facet maps isRetryable onto turn.error.retriable; no committed golden carries it" },
  { n: 55, leg: "claude", title: "Host-supplied partition root (draft.5, §8.0 Partition root): createClaudeNormalizer({ threadId: T }) fed every replay golden's natives stamps T on every threadId-bearing event and on no turnId/parentTurnId; reduce() roots every turn, message and artifact at T with no resync; without the option the output equals the committed golden", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.55(claude) over every replay golden of the facet" },
  { n: 55, leg: "openai", title: "Host-supplied partition root (draft.5, §8.0 Partition root): createOpenaiNormalizer({ threadId: T }) fed every replay golden's natives stamps T on every threadId-bearing event and on no turnId/parentTurnId; reduce() roots every turn, message and artifact at T with no resync; without the option the output equals the committed golden", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.55(openai) over every replay golden of the facet" },
  { n: 55, leg: "adk", title: "Host-supplied partition root (draft.5, §8.0 Partition root): createAdkNormalizer({ threadId: T }) fed every replay golden's natives stamps T on every threadId-bearing event and on no turnId/parentTurnId; reduce() roots every turn, message and artifact at T with no resync; without the option the output equals the committed golden", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.55(adk) over every replay golden of the facet" },
  { n: 55, leg: "vercel", title: "Host-supplied partition root (draft.5, §8.0 Partition root): createVercelNormalizer({ threadId: T }) fed every replay golden's natives stamps T on every threadId-bearing event and on no turnId/parentTurnId; reduce() roots every turn, message and artifact at T with no resync; without the option the output equals the committed golden", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.55(vercel) over every replay golden of the facet" },
  { n: 56, title: "Memory record metadata (draft.8): memory.write._meta lands on the AgMemoryRecord (value replaces whole, patch replaces _meta only when carried); an undeclared top-level member never reaches the record; incremental == batch; the persistable projection and the stored-record reader keep _meta", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.56, reference reduce() + Reducer + toPersistable + readStoredAgMemoryRecords (the core pair: AgMemoryRecord._meta + the memory.write SET/PATCH arms)" },
  { n: 57, title: "ADK prompt block → prompt.blocked (rc.1): each errorCode-only prompt-block event of an open turn records one prompt.blocked before the turn's terminal; response-level blocks, other error codes, events with content, relayed events record none; an event after a bare success close records on the turn it opens, never on the closed one; the reference, not configured for the host-completion event, closes the turn of a bare {errorCode, usageMetadata} event turn.done success from push() after its record — finishReason safety_blocked for SAFETY, other for OTHER, unknown with finishReasonRaw JAILBREAK for JAILBREAK (binding the reference only); reduce() lands promptBlocked per turn a record names", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.57 via createAdkNormalizer over synthetic non-streaming natives shaped as ADK 2.1.0's createLlmResponse builds them (a Gemini API attempt on 2026-09-27 reached only response-level blocks, StreamingMode NONE and SSE; Vertex AI not attempted; the ADK Live and Interactions paths do not carry the shape at 2.1.0); the reference-close legs \"(j) bare, {errorCode:SAFETY, usageMetadata} with no errorMessage, finishReason, content parts, branch or node info, no ask pending and no earlier invocation error → push() on that event closes its turn turn.done{success} after the record: finishReason safety_blocked, no finishReasonRaw\", \"(k) the same bare shape with errorCode OTHER → turn.done{success} from push() after the record: finishReason other, no finishReasonRaw\", \"(l) the same bare shape with errorCode JAILBREAK → turn.done{success} from push() after the record: finishReason unknown, finishReasonRaw JAILBREAK byte for byte\"; facet legs: google-adk/src/index.test.ts \"a prompt-block event records prompt.blocked before the turn's unchanged terminal, with no safety\", \"the same event with an errorMessage records prompt.blocked before its turn.error\", \"an unmapped treated value (OTHER, IMAGE_SAFETY, JAILBREAK, BLOCK_REASON_UNSPECIFIED) records reason …other… with reasonRaw verbatim\", \"a response-level block, a non-block errorCode or content parts is not a prompt block: no record\", \"one record per block event: three block events record three, in one turn with the host-completion event and in three turns without it, each before its turn's terminal\", \"a prompt block while an ask is pending is recorded, and the turn still closes paused\", \"an event carrying promptFeedback and a prompt-block errorCode is recorded once, from its promptFeedback\", \"a prompt block inside a Workflow node is recorded, and the host-fed error closes the turn\", \"two identical block events inside a Workflow node record two prompt.blocked while the turn is open, and the same event after the terminal records none\", \"ADK_PROMPT_BLOCK_REASONS holds genai's eight BlockedReason values and the Gemini API's BLOCK_REASON_UNSPECIFIED\"; the relay leg: spec-conformance.test.ts \"an event relayed from a remote agent (a2a:response in customMetadata) yields no prompt.blocked, and the same event unrelayed yields one\"" },
  { n: 58, leg: "openai-content-filter", title: "Block finish reason whatever the outcome (rc.1): an OpenAI Agents content_filter round, fed in the order the Responses model delivers it (ending at response.incomplete), closes with exactly one turn.done carrying safety_blocked; every event passes producer-strict AgEvent validation, reduce() needs no resync and the turn record carries the mapped finishReason", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"recorded order: a content_filter round closes once, turn.done error with finishReason safety_blocked and the safety signal\"; the parse, fold and record checks re-asserted in spec-conformance.test.ts §10.58(openai-content-filter)" },
  { n: 58, leg: "openai-refusal", title: "Block finish reason whatever the outcome (rc.1): an OpenAI Agents refusal round, fed in the order the Responses model delivers it (response.completed before its message_output_created run-item), closes with exactly one turn.done carrying refusal; every event passes producer-strict AgEvent validation, reduce() needs no resync and the turn record carries the mapped finishReason", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"recorded order: a refusal round closes once, turn.done success with finishReason refusal, read from the response.completed output\"; the parse, fold and record checks re-asserted in spec-conformance.test.ts §10.58(openai-refusal)" },
  { n: 58, leg: "openai-deferred", title: "Block finish reason whatever the outcome (rc.1): an OpenAI Agents refusal round deferred behind a pending call closes after that call's tool.done with exactly one turn.done carrying refusal, and the invoke's next round closes stop; every event passes producer-strict AgEvent validation, reduce() needs no resync and the turn record carries the mapped finishReason", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"recorded order: a refusal round deferred behind a pending call closes after that call's tool.done as turn.done success with finishReason refusal, and the next round closes stop\"; the parse, fold and record checks re-asserted in spec-conformance.test.ts §10.58(openai-deferred)" },
  { n: 58, leg: "adk", title: "Block finish reason whatever the outcome (rc.1): an ADK blocked final (errorCode and finishReason, no content, no errorMessage), for each of the eight values the mapping sends to safety_blocked, closes with exactly one turn.done carrying safety_blocked; every event passes producer-strict AgEvent validation, reduce() needs no resync and the turn record carries the mapped finishReason", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/index.test.ts \"a blocked final as ADK builds it (errorCode and finishReason, no content, no errorMessage), for each of the eight block values, closes exactly one turn.done safety_blocked; every event parses and the fold does not park\"; the parse, fold and record checks re-asserted in spec-conformance.test.ts §10.58(adk)" },
  { n: 58, leg: "adk-host-completion", title: "Block finish reason whatever the outcome (rc.1): with host completion, an ADK stashed blocked final of each block value is released by the host-completion event as exactly one turn.done carrying safety_blocked; every event passes producer-strict AgEvent validation, reduce() needs no resync and the turn record carries the mapped finishReason", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/index.test.ts \"with host completion, the stashed blocked final of each block value is released by the host-completion event as the same one turn.done safety_blocked\"; the parse, fold and record checks re-asserted in spec-conformance.test.ts §10.58(adk-host-completion)" },
  { n: 58, leg: "vercel", title: "Block finish reason whatever the outcome (rc.1): a Vercel AI SDK content-filter finish, in fullStream order, closes with exactly one turn.done carrying safety_blocked; every event passes producer-strict AgEvent validation, reduce() needs no resync and the turn record carries the mapped finishReason", disposition: "COVERED-BY", evidence: "fixture-only", citation: "vercel-ai/src/index.test.ts \"content-filter closes the turn with exactly one turn.done carrying safety_blocked; every event passes producer-strict AgEvent parse; reduce() needs no resync and the turn record's finishReason is safety_blocked\"; the parse, fold and record checks re-asserted in spec-conformance.test.ts §10.58(vercel)" },
  { n: 58, leg: "claude", title: "Block finish reason whatever the outcome (rc.1): a Claude Code CLI refusal the CLI does not retry, in the bundle-read order and on the streaming path, closes with exactly one turn.done carrying refusal; every event passes producer-strict AgEvent validation, reduce() needs no resync and the turn record carries refusal", disposition: "COVERED-BY", evidence: "fixture-only", citation: "claude-agent-sdk/src/index.test.ts \"the bundle-read order (non-streaming) closes exactly one turn.done{error outcome, finishReason refusal, safety}; every event parses producer-strict; the fold records finishReason refusal; a following round without a refusal closes stop\" and \"the streaming path (content, then the refusal): the refused response's stream events, the notice and the synthetic frame close exactly one turn.done refusal; every event parses producer-strict; the fold records finishReason refusal; a following round without a refusal closes stop\"; the parse, fold and record checks re-asserted in spec-conformance.test.ts §10.58(claude)" },
  { n: 59, leg: "openai-round", title: "OpenAI built-in round and hosted-MCP approval (rc.1): a round whose response lists a web_search_call, an mcp_call and a message closes once with turn.done success and its usage, its built-in calls in its own turn, and no turn.abort", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"in the order the SDK streams it, a round's hosted calls attach to their own round: web_search and mcp_call land in turn_resp_*, which closes success after them, and no other turn opens\"; openai-hosted.test.ts \"hosted-websearch-mcp-complete: the round closes success after its calls\"" },
  { n: 59, leg: "openai-naming", title: "OpenAI built-in round and hosted-MCP approval (rc.1): a hosted mcp_call and an mcp_approval_request name the MCP tool (providerData.name) in tool.start with its server_label as serverName, and the mcp_call's tool.args.assembled is its arguments parsed as JSON", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.59, over the engine fixtures hosted-websearch-mcp-complete and hosted-mcp-approval; the facet legs openai-agents/src/index.test.ts \"an MCP call and an MCP approval request name the MCP tool (providerData.name) in tool.start, with the item's type in providerMetadata\" and \"in the order the SDK streams it, a hosted mcp_call carries its arguments as tool.args.assembled and its server_label as tool.start.serverName\"" },
  { n: 59, leg: "openai-error", title: "OpenAI built-in round and hosted-MCP approval (rc.1): a resolved mcp_call with no providerData.status and a non-null providerData.error, an object or an empty string, closes its tool.done with outcome error", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"an mcp_call with a non-null providerData.error closes with outcome error, an object or an empty string, with no status\"" },
  { n: 59, leg: "openai-approval", title: "OpenAI built-in round and hosted-MCP approval (rc.1): two mcp_approval_request items stay pending calls named by the MCP tool, with no tool.done, and the round flushes one turn.done paused whose asks are approval_<request id> with toolCallId the request id, and its usage", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"in the order the SDK streams it, a round's hosted-MCP approval requests stay pending: each tool.start names the MCP tool, no tool.done fires for either, and the round flushes paused naming approval_<request id> for each\"; openai-hosted.test.ts \"hosted-mcp-approval: each request stays a pending call, and the round closes paused at flush with one ask per request\"" },
  { n: 59, leg: "openai-answer", title: "OpenAI built-in round and hosted-MCP approval (rc.1): an approval answered in the same invoke closes its request once (ok or denied) with no hitl.ask of its own, and on the resuming invoke an answer closes it once, ok or denied, per INV-XINV; each invoke folded alone and the pair through one reducer leave needsResync false", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"in the order the SDK streams it, two same-invoke approval answers (onApproval) close their requests ok and denied: round 1 closes at its last answer, before round 2 starts\" and \"in the order the SDK streams it, a resumed invoke's leading approval answers close their requests, ok and denied, in turn_resume_<first request id>, and the resumed response's message.start keeps its model; each invoke and the pair fold clean\"; openai-hosted.test.ts \"hosted-mcp-resume (…): the resumed invoke closes the request once (…) under ids invoke 1 never used, and the two invokes fold clean\"; a kept decision answering a later request after its ask: openai-hosted.test.ts \"hosted-mcp-sticky-…: a kept decision answers a later request of the same server tool in its own round, after its ask, and the round closes success\"" },
  { n: 59, leg: "openai-client", title: "OpenAI built-in round and hosted-MCP approval (rc.1): a client-executed built-in round closes only after its tool_output lands, and the next round's events name a turn derived from the next response's id", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-hosted.test.ts \"shell-call-second-round: each response is its own round, the first closing after the shell call, and nothing is aborted\"" },
  { n: 59, leg: "openai-release", title: "OpenAI built-in round and hosted-MCP approval (rc.1): a round whose terminal response lists a web_search_call for which no run-item streams, followed by the invoke's next model response, emits that round's terminal before the next response's turn.start", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"a listed built-in call whose run-item never streams stops holding its round at the next response.created, which keeps its own turn\"" },
  { n: 59, leg: "claude", title: "OpenAI built-in round and hosted-MCP approval (rc.1)", disposition: "N/A", evidence: "none", citation: "§8.0 items 14 and 20 applicability: the built-in lifecycle and its round release bind OpenAI-Agents-targeting normalizers" },
  { n: 59, leg: "adk", title: "OpenAI built-in round and hosted-MCP approval (rc.1)", disposition: "N/A", evidence: "none", citation: "§8.0 items 14 and 20 applicability: the built-in lifecycle and its round release bind OpenAI-Agents-targeting normalizers" },
  { n: 59, leg: "vercel", title: "OpenAI built-in round and hosted-MCP approval (rc.1)", disposition: "N/A", evidence: "none", citation: "§8.0 items 14 and 20 applicability: the built-in lifecycle and its round release bind OpenAI-Agents-targeting normalizers" },
  { n: 60, leg: "adk-runs", title: "ADK invocation errors (rc.1): every engine-built run of the item's ADK fixtures, in each streaming mode it has, bare and with the host-completion event, folds without a resync; every opened turn has exactly one terminal and no event after it; no turn of an invocation that met an invocation error closes success after the invocation met it", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/in-band-errors.test.ts \"every expected leg has runs in both modes, and every run has an expected leg\"; \"every run folds without a resync, every opened turn has exactly one terminal and nothing after it, and no turn closes as success but, without the host-completion event, the one an answer closes before the first in-band error\"" },
  { n: 60, leg: "adk-errors", title: "ADK invocation errors (rc.1): each in-band invocation error yields exactly one non-terminal error event carrying its errorCode as code, from the push() that received it; an event that item 35 names as repeating one yields none; flush() emits none", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/in-band-errors.test.ts \"each in-band invocation error yields exactly one error event, carrying its errorCode, from the push() that received it; an aggregate that repeats one yields none, and flush() yields none\"; \"is not an invocation error and not a repeat of the relayed block: the relayed block yields the only error event, and the turn closes with one turn.error carrying the block's code and usage\"; google-adk/src/index.test.ts \"an in-band error emits its error event from the push() that receives it and closes no turn; a later sub-agent's answer lands in the same turn; the invocation's end closes it turn.error with the error's code and the turn's usage, never success, bare and with host completion\"; \"a later in-band error is a further error with its own error event, and the turn.error keeps the first error's code; a host-terminal event takes precedence and closes the same turn, with no fresh host-error turn\"; \"an event with errorCode and no errorMessage is not an in-band error: no error event, and it closes the turn as before\"; \"the SSE aggregate that repeats the previous event of its author, branch and node path yields no error event, and the call's usage counts once, from the later report; other sources' events may come between\"; \"an in-band error whose previous same-source event carried partial:false, or which carries another code or message, or comes from another source, is a further error: a loop that meets the same block twice reports it twice and counts both calls, and so does a partial:false error right after another\"; \"the relay's closing event that repeats an earlier in-band error of the same source, with the same code, message and usage report and the same a2a:task_id present on both, yields no error event and adds no usage; without a task id on both, with different ids, with another usage report, or without the a2a:request entry or turnComplete, it is a further error\"" },
  { n: 60, leg: "adk-text", title: "ADK invocation errors (rc.1): the text of each message folds once, as it was streamed", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/in-band-errors.test.ts \"the text of each message folds once, as it was streamed\"" },
  { n: 60, leg: "adk-close", title: "ADK invocation errors (rc.1): with no signalled pause, and for every listed fixture but the two in which a final response that carries no branch and no ADK node info precedes the first invocation error, the invocation's turn closes with exactly one turn.error after every content event, carrying the host-terminal event's code when one was fed and otherwise the first in-band error's, with usage equal to the field-wise sum of the invocation's usage reports, a repeating event counted once", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/in-band-errors.test.ts \"with no signalled pause and no answer closing a turn before the first in-band error, the invocation's turn closes with exactly one turn.error after every content event, carrying the host-terminal event's code when one was fed, else the first in-band error's, and the field-wise sum of the non-partial usage reports with a repeating aggregate counted once\"; \"an invocation that met an in-band error and ends with the host's error carrying usage closes one turn.error with the host's code and the turn's accumulated usage plus the host's, field by field, a total only when both carry one\"; \"a Workflow whose entry runs one agent twice concurrently without a sub-branch, both runs ending on a block: each run's block counts once (twice the block's usage), and the one turn.error carries the first in-band code without the host-terminal event and the thrown error's code with it\"" },
  { n: 60, leg: "adk-early-close-bare", title: "ADK invocation errors (rc.1): for the SequentialAgent whose first sub-agent answers and the LoopAgent whose replying agent precedes its relaying agent, a normalizer not configured for the host-completion event that closed a turn as success on that final response: that turn.done was emitted before the push() that received the first invocation error; every error event and exactly one turn.error, after every content event and carrying the first in-band error's code, name one other top-level turn whose turn.start follows that close; the usage of that turn.done and of that turn.error, an absent usage counting as zero, sum field-wise to the invocation's usage reports", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/in-band-errors.test.ts \"without the host-completion event, when an answer closes a first turn as success before the first in-band error, that turn closes turn.done success with the answer's usage, then the invocation's one turn.error closes a second turn last, carrying the first in-band error's code, and the two terminals' usage sums to the non-partial usage reports, an absent usage counting as zero\"" },
  { n: 60, leg: "adk-early-close-host-completion", title: "ADK invocation errors (rc.1): the same two fixtures with the host-completion event fed: one turn, closing turn.error with that sum", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/in-band-errors.test.ts \"without the host-completion event, when an answer closes a first turn as success before the first in-band error, that turn closes turn.done success with the answer's usage, then the invocation's one turn.error closes a second turn last, carrying the first in-band error's code, and the two terminals' usage sums to the non-partial usage reports, an absent usage counting as zero\"" },
  { n: 60, leg: "adk-orders", title: "ADK invocation errors (rc.1): the two arrival orders of each ParallelAgent and parallel-Workflow fixture yield the same terminal type and usage, and with one erroring branch the same code", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/in-band-errors.test.ts \"the two arrival orders of each ParallelAgent and parallel-Workflow run give the same terminal type and usage, and with one erroring branch the same code\"" },
  { n: 60, leg: "adk-pause", title: "ADK invocation errors (rc.1): when a pause was signalled and the invocation met an invocation error, the asking turn closes turn.done paused with one ask per pending request, and exactly one other top-level turn, opened after that close and carrying one message with no content, closes turn.error; a turn whose pause was not signalled closes with that turn.error and no paused close; in bare mode flush() emits turn.start and message.start only for that error turn", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/in-band-errors.test.ts \"with a signalled pause, the asking turn closes turn.done paused with its asks, then exactly one other top-level turn, opened after that close and carrying one message with no content, closes turn.error; bare, flush() opens no turn or message but that one\"; \"after a signalled pause and an in-band error, a host-terminal event closes the asking turn paused, then the one error turn with the host's code and only the host's usage, on the engine-built runs, bare and with host completion\"; google-adk/src/index.test.ts \"an invocation that met an in-band error and whose pause was signalled closes the asking turn paused with its asks, then one other top-level turn with one message and no content closes turn.error with the first error's code; bare, that error turn's opener is the only one flush() emits\"; \"an ask whose pause was not signalled by the invocation's end closes with the turn.error, never paused\"; \"a host-terminal event after a signalled pause, with or without an in-band error, closes the turn paused, then the error turn with the host's code and only the host's usage\"" },
  { n: 60, leg: "adk-ids", title: "ADK invocation errors (rc.1): two such invokes folded by one reducer yield distinct error-turn ids", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/index.test.ts \"two invokes folded by one reducer give distinct error-turn ids\"" },
  { n: 60, leg: "openai", title: "ADK invocation errors (rc.1): a host-terminal event while an approval round's close is deferred releases that close as a turn.done carrying the deferred round's finishReason, and exactly one other top-level turn closes turn.error", disposition: "COVERED-BY", evidence: "fixture-only", citation: "openai-agents/src/index.test.ts \"a host-terminal event while an approval round's close is deferred releases that round's turn.done paused with its asks and deferred finishReason, then exactly one other top-level turn closes turn.error with the host's code; two invokes in one fold give distinct error-turn ids\"" },
  { n: 60, leg: "claude", title: "ADK invocation errors (rc.1): no fixture of the item is a Claude Agent SDK run", disposition: "N/A", evidence: "none", citation: "§10 item 60 binds each fixture a normalizer's framework has; its list names ADK and OpenAI Agents runs only" },
  { n: 60, leg: "vercel", title: "ADK invocation errors (rc.1): no fixture of the item is a Vercel AI SDK run", disposition: "N/A", evidence: "none", citation: "§10 item 60 binds each fixture a normalizer's framework has; its list names ADK and OpenAI Agents runs only" },
  { n: 61, leg: "adk", title: "ADK relay bookkeeping off carries (rc.1): in one fold of fresh synthetic natives (a relayed event completing a turn, one not completing one, one whose only unmapped value is a customMetadata of the four keys, and an unmappable native under either spelling), no secret leaf of a2a:request, a2a:response, a2a:task_id or a2a:context_id reaches an emitted event or a text block's deltas; other entries ride byte-identical; the stream and its fold deep-equal those from the natives without the four keys", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.61, facet-driven via createAdkNormalizer; the replay goldens: replay.test.ts \"agjson deep-equals the committed adk.agjson.json snapshot\"; the facet legs google-adk/src/index.test.ts \"a relayed event's other customMetadata entries ride in the provider-raw carry, without the four relay entries; the pushed native is not changed\"; \"a relayed event without turnComplete that carries the relay entries (a chained chunk) carries none of them\"; \"a customMetadata that held only the relay entries is not carried at all, and adds no provider-raw block\"; \"a native that is not an ADK event rides ext.google.unparsed without the relay entries: its other customMetadata entries stay, and a customMetadata left empty is dropped; the pushed native is not changed\"; \"an event serialized from Python (snake_case custom_metadata, no content) rides ext.google.unparsed without the relay entries: its other entries stay; the pushed native is not changed\"; \"a relayed event whose a2a:response records a task at completed with no status message carries none of the relay entries; its other entries ride\"" },
  { n: 61, leg: "claude", title: "ADK relay bookkeeping off carries (rc.1)", disposition: "N/A", evidence: "none", citation: "§10 item 61 binds normalizers targeting ADK: no A2A relay surface" },
  { n: 61, leg: "openai", title: "ADK relay bookkeeping off carries (rc.1)", disposition: "N/A", evidence: "none", citation: "§10 item 61 binds normalizers targeting ADK: no A2A relay surface" },
  { n: 61, leg: "vercel", title: "ADK relay bookkeeping off carries (rc.1)", disposition: "N/A", evidence: "none", citation: "§10 item 61 binds normalizers targeting ADK: no A2A relay surface" },
  { n: 62, leg: "adk", title: "Relayed request echo omitted (rc.1): each submitted user-role repeat (a streaming status update, a non-blocking task, a task with artifacts, the a2a-sdk 1.x record) under either member spelling reaches the wire in no form, maps as its event with the content parts after the first k removed, and yields one relay-echo-omitted marker inside its turn; every control maps as the same native with its a2a:response removed", disposition: "COVERED-BY", evidence: "fixture-only", citation: "google-adk/src/relay-echo.test.ts \"each repeat, relayed as a streaming status update, a non-blocking task, a task with artifacts, a task converted as thought, the a2a-sdk 1.x record, or through a converter that maps one part to two, under either spelling of the metadata member, reaches the wire in no form: no planted value, raw or in any block's text\"; \"an event carrying a repeat maps exactly as the same event with its content parts after the first k and their long-running ids removed, its markers aside, with no tool.start, tool.done or hitl.ask from the repeat; that stripped event emits no marker\"; \"each such event yields exactly one ext.google.relay-echo-omitted, after its turn's turn.start and before that turn's terminal, whose only member beyond the envelope is the number of parts it omitted\"; \"a non-blocking task whose only content was the repeat, with only the relay's entries in its metadata, yields the marker alone inside its turn, before the terminal that event or the flush emits, and the fold ends clean\"; \"the long-running ids a repeat's calls contributed go with them: a Workflow node's relayed repeat, after an ask of the run, does not signal that ask's pause, as a node's contentless long-running call would\"; \"a task's artifact parts, the first k content parts, map as the same text blocks as with the repeat absent\"; \"a converter that maps one of a submitted task's artifact parts to two content parts leaves more parts than k: the parts after the first k are omitted, and the marker counts them\"; \"over one fold of every instance, push() never throws, every event validates, and the fold ends with no resync and no tool call without its result\"; \"each control (an agent-role submitted status, a user-role working tool result marked as thought or not, no a2a:response, a task at another state, a submitted task converted from its artifact, and the a2a-sdk 1.x record at another state, in the agent's role, or holding an artifact), under either spelling of the metadata member, maps byte for byte as the same native with its a2a:response removed, with no marker\"; \"the user-role tool results relayed while working, (b) and (f), marked as thought or not, keep their tool.done, which folds against its call; one fold of every control ends with no resync and no tool call without its result\"" },
  { n: 62, leg: "claude", title: "Relayed request echo omitted (rc.1)", disposition: "N/A", evidence: "none", citation: "§10 item 62 binds normalizers targeting ADK: no A2A relay surface" },
  { n: 62, leg: "openai", title: "Relayed request echo omitted (rc.1)", disposition: "N/A", evidence: "none", citation: "§10 item 62 binds normalizers targeting ADK: no A2A relay surface" },
  { n: 62, leg: "vercel", title: "Relayed request echo omitted (rc.1)", disposition: "N/A", evidence: "none", citation: "§10 item 62 binds normalizers targeting ADK: no A2A relay surface" },
  { n: 63, title: "Native-selected prototypes (rc.1): each reference normalizer, fed every corpus native of its framework with an own __proto__ member planted at every object node beside a carried sibling, once per value leg (object, null, array, primitive), and natives built with a null prototype or as class instances, emits events with no such member at any depth, ordinary prototypes, and events equal to the unplanted natives'; the emit funnels, the facet-side native read and a string member built by serialising a native value are proven in their own files; no reference framework carries a native RFC-6902 operation, so item 63's patch leg binds none of the four", disposition: "COVERED-BY", evidence: "corpus", citation: "native-member-copy.test.ts describe \"facet events from natives planted with each value kind beside a carried sibling\" (the four value legs and the runtime check) and describe \"facet events from natives built with a null prototype or as class instances\"; the emit funnels: stream-assembler.test.ts describe \"an emitted event holds no own __proto__ member at any depth (§13.7)\"; the native read: wire.test.ts \"a null-prototype node with an own __proto__ key takes the copy: ordinary prototype, the key an own data member, siblings equal\" and \"an ordinary JSON value still takes the fast path by reference (control)\"; the serialised string member: vercel-ai/src/index.test.ts \"the message text, parsed and less the member, equals the unplanted error's\"" },
  { n: 64, leg: "core", title: "Wire-selected prototypes at the fold (rc.1): a reducer fed, without a decode, a stream whose tool.args, tool.done content[], text.start providerMetadata, both state.delta shapes, memory.write and turn.done carry an own __proto__ member at every object node, once per value leg, yields a result with no such member at any depth and ordinary prototypes, the resync condition false, deep-equal to the unplanted fold and to the fold after a consuming ingest, identical batch and incremental; a state.delta or memory.write operation whose path or from holds that token, or whose required location names a member the working copy or record does not own, leaves it unchanged with the resync condition true and result() returned, while add of such a name creates an own member; an event structuredClone cannot copy folds less the member; Object.prototype gains no member", disposition: "COVERED-BY", evidence: "fixture-only", citation: "reduce.test.ts describe \"reduce — an own __proto__ member is omitted at every depth of every folded event (§13.7)\" (the four value legs, \"batch == incremental and decoded == undecoded for a planted stream\", the state.delta and memory.write path, from and inherited-name legs, the uncloneable-event legs and the runtime check) and describe \"reduce — R8 shared-state snapshot + delta\" › \"an own __proto__ key of a patch is omitted from the fold, never the state's prototype\" and \"copy-isolated and batch == incremental; an own __proto__ key is omitted, never a prototype\"; the applier: json-patch.test.ts describe \"applyPatch — a reference token named __proto__ fails the operation\" and describe \"applyPatch — member resolution reads own members only\"" },
  { n: 64, leg: "planted-set", title: "Wire-selected prototypes at the fold (rc.1): the item's named planted set — turn.done.outcome.asks[].schema, usage with a byModel entry on turn.done, turn.error and message.end, block citations, tool-result content[] and structuredContent, messages.snapshot message and turn records, state.snapshot, both state.delta shapes and memory.write — planted at every object node once per value leg, without a decode, folds with no own __proto__ at any depth, ordinary prototypes, the resync condition false, byte-equal to the unplanted fold and to the fold after a consuming ingest, identical batch and incremental; Object.prototype gains no member", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.64 (planted-set …) over the reference Reducer and reduce(); the prototype assertions run directly (toEqual ignores prototypes)" },
  { n: 65, leg: "core", title: "Wire-selected prototypes at the decode (rc.1): a consuming ingest of a closed event, a reader of a stored AgMessage and of an AgMemoryRecord array, and a receiver of an AgInput each drop an own __proto__ at every depth and return ordinary objects deep-equal to the input less the member, not a rejection or a stub; a bare JSON.parse keeps it", disposition: "COVERED-BY", evidence: "fixture-only", citation: "ingest.test.ts describe \"ingest — decoded events hold no own __proto__ and only ordinary prototypes (§13.7 decode)\"; record.test.ts describe \"stored-record readers — a null-prototype record is still read (§13.7 decode)\" (the dropped member is not an unreadable element, so the readers report nothing; the index reproduction of reported values is item 29's reader leg); input-check.test.ts describe \"checkAgInput — a null-prototype input is still accepted (§13.7 decode)\"" },
  { n: 66, leg: "adk", title: "ADK interrupted close (rc.1): a Live native stream in which interrupted: true precedes the generation's usage-only report and its turnComplete closes that generation's turn with exactly one terminal, a turn.abort{reason: interrupted}, fed whole and fed cut after the usage-only report before turnComplete (by the end of flush()), never a later turn.done; every event producer-strict valid; on the corpus each such abort directly follows a message.end carrying the turn's usage", disposition: "RUNNABLE", evidence: "corpus", citation: "spec-conformance.test.ts §10.66 (adk) and (adk-cut) via replayNatives over corpus/live-bargein-gemini38live and live-bargein2-gemini38live adk.native.json (three interrupted generations; cut points derived from the natives)" },
  { n: 66, leg: "claude", title: "ADK interrupted close (rc.1)", disposition: "N/A", evidence: "none", citation: "§10 item 66 binds normalizers targeting ADK (the Live `interrupted` signal, §8.0 item 17); not an item-66 leg for this framework" },
  { n: 66, leg: "openai", title: "ADK interrupted close (rc.1)", disposition: "N/A", evidence: "none", citation: "§10 item 66 binds normalizers targeting ADK (the Live `interrupted` signal, §8.0 item 17); not an item-66 leg for this framework" },
  { n: 66, leg: "vercel", title: "ADK interrupted close (rc.1)", disposition: "N/A", evidence: "none", citation: "§10 item 66 binds normalizers targeting ADK (the Live `interrupted` signal, §8.0 item 17); not an item-66 leg for this framework" },
  { n: 65, leg: "ext-and-request", title: "Wire-selected prototypes at the decode (rc.1): a consuming ingest of an ext.* event, and the request carriers of an AgClientCapabilities (AgInputEnvelope.capabilities) and an AgHitlAnswer (a resume's answers[]) through the reference's AgInput receiver, drop an own __proto__ planted at the top level and nested, once per value leg, and return the value, not a stub or a rejection, deep-equal to the unplanted one; the bare parse keeps the member; Object.prototype gains no member", disposition: "RUNNABLE", evidence: "fixture-only", citation: "spec-conformance.test.ts §10.65 (ext …) and (request …) via core ingestAgEvent and checkAgInput; the request legs bind implementations that ship such a receiver (item 65), and the reference's is checkAgInput" },
];

// §10 item numbers as SPEC.md declares them: the numbered `N. **Title**` lines
// between the "## 10. Conformance" heading and the next "## " heading, read
// from the SDK's follower SPEC.md (sdks/typescript/SPEC.md — the copy the SDK
// mirror publishes; sync-spec.mjs --check keeps it byte-identical to
// protocol/SPEC.md).
// The test files a manifest citation may name, resolved from this file. A
// COVERED-BY citation quotes the covering it()/describe() title; the
// accounting test greps these files for it.
const CITED_TEST_FILES: Record<string, string> = {
  "reduce.test.ts": "../../core/src/reduce.test.ts",
  "agjson.test.ts": "../../core/src/agjson.test.ts",
  "replay.test.ts": "./replay.test.ts",
  "spec-conformance.test.ts": "./spec-conformance.test.ts",
  "claude-agent-sdk/src/index.test.ts": "../../claude-agent-sdk/src/index.test.ts",
  "openai-agents/src/index.test.ts": "../../openai-agents/src/index.test.ts",
  "openai-hosted.test.ts": "./openai-hosted.test.ts",
  "google-adk/src/index.test.ts": "../../google-adk/src/index.test.ts",
  "google-adk/src/relay-echo.test.ts": "../../google-adk/src/relay-echo.test.ts",
  "google-adk/src/in-band-errors.test.ts": "../../google-adk/src/in-band-errors.test.ts",
  "adk-pause.test.ts": "./adk-pause.test.ts",
  "vercel-ai/src/index.test.ts": "../../vercel-ai/src/index.test.ts",
  "stream-assembler.test.ts": "../../core/src/stream-assembler.test.ts",
  "wire.test.ts": "../../core/src/wire.test.ts",
  "json-patch.test.ts": "../../core/src/json-patch.test.ts",
  "ingest.test.ts": "../../core/src/ingest.test.ts",
  "input-check.test.ts": "../../core/src/input-check.test.ts",
  "record.test.ts": "../../core/src/record.test.ts",
  "native-member-copy.test.ts": "./native-member-copy.test.ts",
};

function specSection10ItemNumbers(): number[] {
  const spec = readFileSync(new URL("../../../SPEC.md", import.meta.url), "utf8");
  const start = spec.indexOf("\n## 10. Conformance");
  if (start < 0) throw new Error("SPEC.md: no '## 10. Conformance' heading");
  const rest = spec.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const section = end < 0 ? rest : rest.slice(0, end);
  return Array.from(section.matchAll(/^(\d+)\. \*\*/gm), (m) => Number(m[1]));
}

describe("§10 conformance accounting", () => {
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

  it("every row states its evidence (corpus | fixture-only | none); an N/A row's evidence is none and its citation names §8, the §10 preamble or a binding sentence", () => {
    for (const item of SPEC_10_MANIFEST) {
      const tag = `§10.${item.n}${item.leg ? `(${item.leg})` : ""}`;
      expect(["corpus", "fixture-only", "none"], tag).toContain(item.evidence);
      if (item.disposition === "N/A") {
        expect(item.evidence, tag).toBe("none");
        expect(item.citation, tag).toMatch(/§8|§10 preamble|binding sentence|binds/);
      } else {
        expect(item.evidence, tag).not.toBe("none");
      }
    }
  });

  it("every cited test title exists in the cited file (it | describe | test, .skip/.only/.each included); a COVERED-BY row names its file", () => {
    const cache = new Map<string, string[]>();
    const titlesIn = (rel: string): string[] => {
      let t = cache.get(rel);
      if (!t) {
        const src = readFileSync(new URL(rel, import.meta.url), "utf8");
        const re = /\b(?:it|describe|test)(?:\.skip|\.only|\.each\([^)]*\))?\(\s*(["'`])/g;
        t = [];
        for (let m = re.exec(src); m; m = re.exec(src)) {
          let end = src.indexOf(m[1]!, re.lastIndex);
          while (end > 0 && src[end - 1] === "\\") end = src.indexOf(m[1]!, end + 1); // an escaped quote inside the title
          if (end > re.lastIndex) t.push(src.slice(re.lastIndex, end).replace(/\\(["'`])/g, "$1"));
        }
        cache.set(rel, t);
      }
      return t;
    };
    // a "…" inside a cited fragment is an elision: the pieces must occur in order inside one title
    const matches = (titles: string[], frag: string): boolean => {
      if (!frag.includes("…")) return titles.includes(frag);
      const parts = frag.split("…").map((x) => x.trim()).filter(Boolean);
      return titles.some((t) => {
        let pos = 0;
        for (const p of parts) {
          const i = t.indexOf(p, pos);
          if (i < 0) return false;
          pos = i + p.length;
        }
        return true;
      });
    };
    for (const item of SPEC_10_MANIFEST) {
      const tag = `§10.${item.n}${item.leg ? `(${item.leg})` : ""}`;
      const files = Object.keys(CITED_TEST_FILES).filter((f) => item.citation.includes(f));
      if (item.disposition === "COVERED-BY") expect(files.length, `${tag}: a COVERED-BY row names the covering test file`).toBeGreaterThan(0);
      if (files.length === 0) continue;
      const titles = files.flatMap((f) => titlesIn(CITED_TEST_FILES[f]!));
      for (const [, frag] of item.citation.matchAll(/"([^"]+)"/g)) {
        expect(matches(titles, frag!), `${tag}: "${frag}" is an it()/describe() title in ${files.join(" | ")}`).toBe(true);
      }
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
  it("COVERED-BY reduce.test.ts \"reduce — R10 capstone: byte-identity + live-SSE↔history invariant\" (byte-identity against a hand-spelled EXPECTED_RESULT + interleaved-block-kind ordering over the FULL folding table); thin confirming re-assertion below", () => {
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

// §10.1 leg rows (rc.1 corrections to §5 rows, each stated as the reducer folds):
// the turn.done row's `safety` REPLACES the turn's safety[] as a whole value; the
// prompt.blocked row merges safety[] into the turn's and records promptBlocked
// whole on every record; the tool.args.assembled row merges providerMetadata
// (REPLACE-by-key) onto the tool-call block.
describe("§10.1 — §5 rows (rc.1 corrections): turn.done safety replaces, prompt.blocked merges safety and records promptBlocked whole, tool.args.assembled merges providerMetadata", () => {
  const A = { category: "HARM_CATEGORY_A", blocked: true };
  const B = { category: "HARM_CATEGORY_B", probability: "LOW" };

  it("turn.done row: prompt.blocked{safety:[A]} then turn.done{safety:[B]} on one turn lands turn.safety deep-equal [B] and promptBlocked.safety deep-equal [A]", () => {
    const r = reduce([
      TURN_START,
      { type: "prompt.blocked", seq: 1, turnId: "t1", reason: "safety", safety: [A] },
      { type: "turn.done", seq: 2, turnId: "t1", outcome: { type: "success" }, finishReason: "safety_blocked", safety: [B] },
    ]);
    expect(r.needsResync).toBe(false);
    expect(r.result.turns[0]?.safety).toEqual([B]);
    expect(r.result.turns[0]?.promptBlocked).toEqual({ reason: "safety", safety: [A] });
  });

  it("prompt.blocked row: prompt.blocked{safety:[A]} then prompt.blocked{safety:[B]} on one turn lands promptBlocked equal to the second record and turn.safety deep-equal [A, B]; a third record without safety records promptBlocked with no safety and leaves turn.safety [A, B]", () => {
    const two = reduce([
      TURN_START,
      { type: "prompt.blocked", seq: 1, turnId: "t1", reason: "safety", safety: [A] },
      { type: "prompt.blocked", seq: 2, turnId: "t1", reason: "other", reasonRaw: "JAILBREAK", safety: [B] },
      { type: "turn.done", seq: 3, turnId: "t1", outcome: { type: "success" }, finishReason: "safety_blocked" },
    ]);
    expect(two.needsResync).toBe(false);
    expect(two.result.turns[0]?.promptBlocked).toEqual({ reason: "other", reasonRaw: "JAILBREAK", safety: [B] });
    expect(two.result.turns[0]?.safety).toEqual([A, B]);
    const three = reduce([
      TURN_START,
      { type: "prompt.blocked", seq: 1, turnId: "t1", reason: "safety", safety: [A] },
      { type: "prompt.blocked", seq: 2, turnId: "t1", reason: "other", reasonRaw: "JAILBREAK", safety: [B] },
      { type: "prompt.blocked", seq: 3, turnId: "t1", reason: "prohibited" },
      { type: "turn.done", seq: 4, turnId: "t1", outcome: { type: "success" }, finishReason: "safety_blocked" },
    ]);
    expect(three.needsResync).toBe(false);
    expect(three.result.turns[0]?.promptBlocked).toEqual({ reason: "prohibited" });
    expect(three.result.turns[0]?.safety).toEqual([A, B]);
  });

  it("tool.args.assembled row: tool.start{providerMetadata:{a:1}} then tool.args.assembled{providerMetadata:{b:2}} lands the tool-call block's providerMetadata deep-equal {a:1, b:2}, and a repeated key takes the later value", () => {
    const vector = (startMeta: Record<string, number>, assembledMeta: Record<string, number>) =>
      reduce([
        TURN_START,
        MSG_START,
        { type: "tool.start", seq: 2, toolCallId: "c1", name: "calc", turnId: "t1", threadId: "th1", providerMetadata: startMeta },
        { type: "tool.args.assembled", seq: 3, toolCallId: "c1", input: {}, providerMetadata: assembledMeta },
        { type: "turn.done", seq: 4, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
      ] as AgEvent[]);
    const toolCall = (r: ReturnType<typeof reduce>) => r.result.messages[0]?.content.find((b) => b.type === "tool-call") as unknown as { providerMetadata?: unknown } | undefined;
    const merged = vector({ a: 1 }, { b: 2 });
    expect(merged.needsResync).toBe(false);
    expect(toolCall(merged)?.providerMetadata).toEqual({ a: 1, b: 2 });
    expect(toolCall(vector({ a: 1, k: 1 }, { k: 2 }))?.providerMetadata).toEqual({ a: 1, k: 2 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.1 — §5 subagent.start row + INV-OWNER (rc.1 fold rules): a nested turn's
// thread is its parent's known thread, else the fold's root thread; a nested
// record whose thread is not known is held and result() omits it; a terminal
// folded while held is kept; a turns-carrying messages.snapshot discards a held
// nested record, keeping only its held display.required landings. §8.0 item
// 16: a reducer tolerates an unopened parentTurnId and fabricates no record
// for it. Batch and incremental folds are compared as JSON text.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.1 — §5 subagent.start row and INV-OWNER (rc.1 fold rules): a nested turn's thread, the held nested record and the snapshot's discard", () => {
  const P = (evs: Array<Record<string, unknown>>) => evs.map((e) => AgEvent.parse(e));
  const both = (evs: AgEvent[]) => {
    const live = new Reducer();
    for (const e of evs) live.push(e);
    const batch = reduce(evs);
    expect(live.needsResync).toBe(batch.needsResync);
    expect(JSON.stringify(live.result())).toBe(JSON.stringify(batch.result));
    return batch;
  };
  const rec = (r: ReturnType<typeof reduce>, id: string) => r.result.turns.find((t) => t.turnId === id);

  it("(a) a lone subagent.start whose parent never opened, after a root turn.start, takes the fold's root thread, records its parentTurnId, and fabricates no record for the parent (§8.0 item 16)", () => {
    const r = both(P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "subagent.start", seq: 1, turnId: "S", parentTurnId: "turn_toolcall_9" },
    ]));
    expect(r.needsResync).toBe(false);
    expect(rec(r, "S")).toMatchObject({ turnId: "S", parentTurnId: "turn_toolcall_9", threadId: "th1" });
    expect(rec(r, "turn_toolcall_9")).toBeUndefined();
    expect(r.result.turns.map((t) => t.threadId)).not.toContain("turn_toolcall_9");
  });
  it("(b) a subagent.start before any thread is known is held — result() omits it, no resync — and appears on the root thread once a turn.start carries one", () => {
    const held = both(P([{ type: "subagent.start", seq: 0, turnId: "S", parentTurnId: "P" }]));
    expect(held.needsResync).toBe(false);
    expect(held.result.turns).toEqual([]);
    const released = both(P([
      { type: "subagent.start", seq: 0, turnId: "S", parentTurnId: "P" },
      { type: "turn.start", seq: 1, threadId: "th1", turnId: "t1" },
    ]));
    expect(released.needsResync).toBe(false);
    expect(rec(released, "S")).toMatchObject({ threadId: "th1", parentTurnId: "P" });
  });
  it("(c) a terminal folded while the nested record is held is kept: the released record carries its outcome", () => {
    const r = both(P([
      { type: "subagent.start", seq: 0, turnId: "S", parentTurnId: "P" },
      { type: "turn.done", seq: 1, turnId: "S", outcome: { type: "success" }, finishReason: "stop" },
      { type: "subagent.done", seq: 2, turnId: "S", parentTurnId: "P" },
      { type: "turn.start", seq: 3, threadId: "th1", turnId: "t1" },
    ]));
    expect(r.needsResync).toBe(false);
    expect(rec(r, "S")).toMatchObject({ threadId: "th1", outcome: { type: "success" } });
  });
  it("(d) a parent known only through a message.start carrying a threadId gives its nested turn that thread, not the root thread", () => {
    const r = both(P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "message.start", seq: 1, id: "mp", role: "assistant", turnId: "P", threadId: "thP" },
      { type: "subagent.start", seq: 2, turnId: "S", parentTurnId: "P" },
    ]));
    expect(r.needsResync).toBe(false);
    expect(rec(r, "S")?.threadId).toBe("thP");
  });
  it("(e) a messages.snapshot carrying turns discards a held nested record, keeping only its held display.required landings: they join the carried record once (matched by provider and html), stay held for a turn the snapshot omits, and land when that turn is opened again", () => {
    const DR = { provider: "p", html: "<b>x</b>" };
    const prefix = P([
      { type: "subagent.start", seq: 0, turnId: "S", parentTurnId: "P" },
      { type: "display.required", seq: 1, turnId: "S", ...DR },
      { type: "turn.done", seq: 2, turnId: "S", outcome: { type: "success" }, finishReason: "stop" },
    ]);
    const carried = both([...prefix, ...P([{ type: "messages.snapshot", seq: 3, messages: [], turns: [{ turnId: "S", threadId: "th1", parentTurnId: "P" }] }])]);
    expect(carried.needsResync).toBe(false);
    expect(rec(carried, "S")).toMatchObject({ turnId: "S", threadId: "th1", parentTurnId: "P" });
    expect(rec(carried, "S")?.outcome).toBeUndefined(); // the held terminal went with the discarded record
    expect(rec(carried, "S")?.displayRequired).toHaveLength(1);
    expect(rec(carried, "S")?.displayRequired?.[0]).toMatchObject(DR);
    const matched = both([...prefix, ...P([{ type: "messages.snapshot", seq: 3, messages: [], turns: [{ turnId: "S", threadId: "th1", displayRequired: [DR] }] }])]);
    expect(rec(matched, "S")?.displayRequired).toHaveLength(1);
    const omitted = both([...prefix, ...P([{ type: "messages.snapshot", seq: 3, messages: [], turns: [{ turnId: "t1", threadId: "th1" }] }])]);
    expect(omitted.needsResync).toBe(false);
    expect(rec(omitted, "S")).toBeUndefined();
    const reopened = both([...prefix, ...P([
      { type: "messages.snapshot", seq: 3, messages: [], turns: [{ turnId: "t1", threadId: "th1" }] },
      { type: "subagent.start", seq: 4, turnId: "S", parentTurnId: "t1" },
    ])]);
    expect(reopened.needsResync).toBe(false);
    expect(rec(reopened, "S")).toMatchObject({ threadId: "th1" });
    expect(rec(reopened, "S")?.displayRequired).toHaveLength(1);
    expect(rec(reopened, "S")?.displayRequired?.[0]).toMatchObject(DR);
  });
  it("(f) on every corpus golden carrying a subagent.start, the fold needs no resync, every nested record's threadId is a thread some event carried, never its parentTurnId, and equals its parent's when the parent has a record", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    let nested = 0;
    for (const dir of readdirSync(corpus).sort()) {
      for (const f of readdirSync(new URL(`${dir}/`, corpus)).filter((x) => x.endsWith(".agjson.json")).sort()) {
        const evs = JSON.parse(readFileSync(new URL(`${dir}/${f}`, corpus), "utf8")) as Array<Record<string, unknown>>;
        if (!evs.some((e) => e["type"] === "subagent.start")) continue;
        const threads = new Set(evs.map((e) => e["threadId"]).filter((x): x is string => typeof x === "string"));
        const r = new Reducer();
        for (const e of evs) r.push(AgEvent.parse(e));
        expect(r.needsResync, `${dir}/${f}`).toBe(false);
        const turns = r.result().turns;
        for (const t of turns) {
          if (t.parentTurnId === undefined) continue;
          nested++;
          expect(threads.has(t.threadId), `${dir}/${f}: ${t.turnId} on ${t.threadId}`).toBe(true);
          expect(t.threadId, `${dir}/${f}: ${t.turnId}`).not.toBe(t.parentTurnId);
          const parent = turns.find((p) => p.turnId === t.parentTurnId);
          if (parent) expect(t.threadId, `${dir}/${f}: ${t.turnId}`).toBe(parent.threadId);
        }
      }
    }
    expect(nested).toBeGreaterThanOrEqual(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.1 — §5 artifact rows (rc.1 fold rules): name and description on the
// record; a second artifact.start replaces whole; append:true concatenates
// only a text delta onto a last text part; a delta for an unheld artifact
// folds to nothing and occupies its seq slot; a delta after artifact.end lands.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.1 — §5 artifact rows (rc.1 fold rules): name and description on the record, a second artifact.start replaces whole, text-only concatenation, a delta for an unheld artifact folds to nothing", () => {
  const P = (evs: Array<Record<string, unknown>>) => evs.map((e) => AgEvent.parse(e));
  const both = (evs: AgEvent[]) => {
    const live = new Reducer();
    for (const e of evs) live.push(e);
    const batch = reduce(evs);
    expect(live.needsResync).toBe(batch.needsResync);
    expect(JSON.stringify(live.result())).toBe(JSON.stringify(batch.result));
    return batch;
  };
  const A = (seq: number, extra: Record<string, unknown> = {}) => ({ type: "artifact.start", seq, artifactId: "a1", turnId: "t1", threadId: "th1", ...extra });
  const D = (seq: number, part: Record<string, unknown>, append: boolean) => ({ type: "artifact.delta", seq, artifactId: "a1", part, append });
  const text = (t: string) => ({ type: "text", text: t });
  const code = (c: string) => ({ type: "code", language: "ts", code: c });

  it("(v1) artifact.start lands name and description on the record; a second artifact.start for the held artifactId replaces it whole, parts included", () => {
    const r = both(P([TURN_START, A(1, { name: "n", description: "d" }), D(2, text("a"), false)]));
    expect(r.needsResync).toBe(false);
    expect(r.result.artifacts).toHaveLength(1);
    expect(r.result.artifacts[0]).toMatchObject({ artifactId: "a1", turnId: "t1", threadId: "th1", name: "n", description: "d", parts: [text("a")] });
    const replaced = both(P([TURN_START, A(1, { name: "n", description: "d" }), D(2, text("a"), false), A(3, { name: "n2" })]));
    expect(replaced.needsResync).toBe(false);
    expect(replaced.result.artifacts).toHaveLength(1);
    expect(replaced.result.artifacts[0]).toMatchObject({ artifactId: "a1", name: "n2", parts: [] });
    expect(replaced.result.artifacts[0]?.description).toBeUndefined();
  });
  it("(w1) append:true concatenates only a text delta onto a last part that is text; a code part after a code part, code after text, and text after code each start a new part", () => {
    const r = both(P([TURN_START, A(1), D(2, text("a"), false), D(3, text("b"), true), D(4, code("x"), true), D(5, code("y"), true), D(6, text("c"), true), D(7, text("d"), true)]));
    expect(r.needsResync).toBe(false);
    expect(r.result.artifacts[0]?.parts).toEqual([text("ab"), code("x"), code("y"), text("cd")]);
  });
  it("(w2) a delta for an artifactId the fold does not hold folds to nothing and occupies its seq slot; after artifact.end a later delta still lands (§10 item 16)", () => {
    const r = both(P([TURN_START, { type: "artifact.delta", seq: 1, artifactId: "a9", part: text("z"), append: false }, A(2), D(3, text("a"), false), { type: "artifact.end", seq: 4, artifactId: "a1", lastChunk: true }, D(5, text("b"), true)]));
    expect(r.needsResync).toBe(false);
    expect(r.result.artifacts.map((a) => a.artifactId)).toEqual(["a1"]);
    expect(r.result.artifacts[0]?.parts).toEqual([text("ab")]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.2 — Reconnect (COVERED-BY)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.2 — Reconnect: stream-with-gap + messages.snapshot → reduce == AgReduceResult", () => {
  it("COVERED-BY reduce.test.ts \"reduce — R9 new-ops + resync + snapshot + live-only\" ((e1)-(e6) forward-gap/park/snapshot-recovery; (d1)-(d4) messages.snapshot conditional-replace); thin confirming re-assertion: forward gap parks, snapshot resyncs, backward jump (new-invoke 0-restart) folds normally", () => {
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
    "(d) OpenAI stateless reasoning loop — N/A: the item's claim is emit→reduce→re-input survival; no facet in this repo ships an AgJSON→native emit/re-input surface (§10 preamble). The ingest-capture sub-claim (rs_ id + summary text + encrypted_content handling; exhaustive: no-summary, no-encrypted-content, late-arrival edge cases) is already COVERED by openai-agents/src/index.test.ts \"createOpenaiNormalizer — reasoning_item_created (Task 3, audit M48)\" + \"createOpenaiNormalizer — reasoning sourced from the response.completed output\" (its fold case is the §10.4 stateless-replay order)",
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
  it("COVERED-BY reduce.test.ts:1065 \"(h) display.required appends to AgTurnRecord.displayRequired[]\"; thin confirming re-assertion", () => {
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
  it("COVERED-BY openai-agents/src/index.test.ts \"content_filter incomplete → turn.done error outcome + safety (NOT turn.error)\" (facet-driven, createOpenaiNormalizer, proves the populated-category leg); thin schema-level confirming re-assertion that turn.done accepts BOTH shapes the spec sanctions", () => {
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

  it("(turn-terminal, draft.5) a Claude turn terminal's per-turn counters fold with cumulative false and its costUsd, costScope and byModel verbatim", () => {
    const usage = {
      inputTokens: 7047, cacheReadTokens: 6858, cacheWriteTokens: 187, outputTokens: 73,
      costUsd: 0.0166347, costScope: "query", cumulative: false,
      byModel: { "claude-sonnet-5": { inputTokens: 17783, cacheReadTokens: 13716, cacheWriteTokens: 4061, outputTokens: 275, costUsd: 0.0156577, cumulative: true } },
    };
    const wire = [TURN_START, { type: "turn.done", seq: 1, turnId: "t1", outcome: { type: "success" }, finishReason: "stop", usage }];
    const r = reduce(ingestAgEvents(wire as unknown as JsonValue[])).result;
    expect(r.turns[0]?.usage).toEqual(usage);
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
    "tool-call leg — N/A: §10 item 10 binding sentence; the reference SDK ships none for that leg (the content-block leg is COVERED-BY the claude-agent-sdk suite: the index-minted ids of a split-frame stream)",
    () => {},
  );
});

describe("§10.11 — LangGraph positional pause (two interrupt()s in one node)", () => {
  it.skip("N/A: §10 item 11 binding sentence — no positional-resume normalizer in the reference SDK (claude-agent-sdk, google-adk, openai-agents, vercel-ai)", () => {});
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
  it("COVERED-BY agjson.test.ts \"AgSurfaceInteraction (§3 / §6 / §11.8 un-merge)\" (exhaustive per-arm schema coverage); thin confirming re-assertion of the specific §10.14 claims", () => {
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
    "(b) an id-fragmented tool call (Pydantic AI: tool_name_delta / args_delta before tool_call_id) assembles to a single stable toolCallId — N/A: §10 item 17 binding sentence (id-fragmented leg); the reference SDK ships none",
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
    // ingest output strictly meets the stub first (second read).
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

  it("unknown fields pass through at EVERY depth, not only the top level (SPEC.md:27 'pass unknown fields through untouched'; core fix 9bd3100, workspace#20 stage 1): nested unknown keys survive ingest into the fold", () => {
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

  it("(replay) COVERED-BY replay.test.ts \"usage obeys the draft.3 inclusion identity (input + output (+ toolUseInput) == total; reasoning <= output)\" (assertUsageIdentity, in each of the four replay CI gates); thin confirming re-assertion of the identity on the folded example", () => {
    const usage = adkUsageTurn({ promptTokenCount: 109, candidatesTokenCount: 22, thoughtsTokenCount: 125, totalTokenCount: 256 });
    const num = (k: string): number => (typeof usage?.[k] === "number" ? (usage[k] as number) : Number.NaN);
    const toolUse = typeof usage?.["toolUseInputTokens"] === "number" ? (usage["toolUseInputTokens"] as number) : 0;
    expect(num("inputTokens") + num("outputTokens") + toolUse).toBe(num("totalTokens"));
  });

  // draft.5 — the Gemini Live API (§4 inclusion note, §8.0 item 24): the output
  // counter is `responseTokenCount` and excludes reasoning, so the sibling
  // always folds; totalTokens is derived and a differing provider total rides
  // totalTokensRaw. Fed at the JSON boundary: the Live counter is not on this
  // tree's AdkEvent type until the google-adk facet's Live commit lands.
  type LiveUsage = { promptTokenCount: number; responseTokenCount: number; thoughtsTokenCount: number; totalTokenCount: number };
  const live = (u: LiveUsage) => adkUsageTurn(u as unknown as NonNullable<AdkEvent["usageMetadata"]>);
  const EXCLUSIVE: LiveUsage = { promptTokenCount: 609, responseTokenCount: 25, thoughtsTokenCount: 256, totalTokenCount: 634 };
  const INCLUSIVE: LiveUsage = { promptTokenCount: 6037, responseTokenCount: 248, thoughtsTokenCount: 490, totalTokenCount: 6775 };

  it("(live-fold) {609, responseTokenCount 25, thoughts 256, total 634} folds the sibling unconditionally and derives the total: {609, 281, 256, totalTokens 890, totalTokensRaw 634}", () => {
    const usage = live(EXCLUSIVE);
    expect(usage).toMatchObject({ inputTokens: 609, outputTokens: 281, reasoningTokens: 256, totalTokens: 890, totalTokensRaw: 634 });
    expect(609 + 281).toBe(890);
    expect(usage?.["cumulative"]).not.toBe(true);
  });

  it("(live-inclusive) a Live report whose total already counts thoughts {6037, 248, 490, 6775} derives to itself and carries no totalTokensRaw", () => {
    const usage = live(INCLUSIVE);
    expect(usage).toMatchObject({ inputTokens: 6037, outputTokens: 738, reasoningTokens: 490, totalTokens: 6775 });
    expect(usage !== undefined && "totalTokensRaw" in usage).toBe(false);
  });

  it("(live-mixed) the exclusive and inclusive reports summed into one turn fold to {6646, 1019, 746, totalTokens 7665, totalTokensRaw 7409}", () => {
    const n = createAdkNormalizer();
    const first = adkEvent([{ text: "a" }], { usageMetadata: EXCLUSIVE as unknown as NonNullable<AdkEvent["usageMetadata"]> });
    const second = adkEvent([{ text: "b" }], { finishReason: "STOP", usageMetadata: INCLUSIVE as unknown as NonNullable<AdkEvent["usageMetadata"]> });
    const out = [...n.push(toJsonValue(first)), ...n.push(toJsonValue(second)), ...n.flush()];
    const dones = out.filter((e) => e.type === "turn.done");
    expect(dones).toHaveLength(1);
    const usage = dones[0]?.type === "turn.done" ? (dones[0].usage as Record<string, unknown> | undefined) : undefined;
    expect(usage).toMatchObject({ inputTokens: 6646, outputTokens: 1019, reasoningTokens: 746, totalTokens: 7665, totalTokensRaw: 7409 });
    expect(634 + 6775).toBe(7409);
  });

  it("(no-raw-on-candidates) none of the draft.3 candidatesTokenCount vectors yields totalTokensRaw", () => {
    for (const u of [
      { promptTokenCount: 109, candidatesTokenCount: 22, thoughtsTokenCount: 125, totalTokenCount: 256 },
      { promptTokenCount: 109, candidatesTokenCount: 22, totalTokenCount: 131 },
      { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 30, totalTokenCount: 150 },
    ]) {
      const usage = adkUsageTurn(u);
      expect(usage !== undefined && "totalTokensRaw" in usage).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.0 INV-MSG — a straggler delta into a sealed message parks (SPEC.md:745)
// Contract case for core 31f7bab (conformance, no bar). Scope is the literal
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

  // (f) an unknown block type nested in a known carrier stubs the whole carrier (§12: a new block type reaches only a
  // client that declares it; a consumer below that stubs the event and keeps its seq slot).
  it("(f) a tool.done whose content holds an unknown block type is stubbed whole: one ext.agjson.ignored at its seq, the call has no outcome, no resync", () => {
    const start = { type: "tool.start", seq: 2, turnId: "t1", toolCallId: "c1", name: "t" };
    const done = { type: "tool.done", seq: 3, turnId: "t1", toolCallId: "c1", content: [{ type: "zz" }], outcome: "ok" };
    const out = ingestAgEvents([...S_HEAD, start, done, ...S_TAIL(4)] as unknown as JsonValue[]);
    const ignored = out.filter((e) => e.type === "ext.agjson.ignored") as unknown as Array<Record<string, unknown>>;
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ seq: 3, ignoredType: "tool.done" });
    expect(ignored[0]?.["raw"]).toEqual(done);
    const r = reduce(out);
    expect(r.needsResync).toBe(false);
    const blocks = r.result.messages.flatMap((m) => m.content as Array<Record<string, unknown>>);
    const call = blocks.find((b) => b["type"] === "tool-call" && b["toolCallId"] === "c1") as Record<string, unknown> | undefined;
    expect(call, "the call opened").toBeDefined();
    expect(blocks.some((b) => b["type"] === "tool-result" && b["toolCallId"] === "c1"), "no result landed").toBe(false);
  });
  // (g) an undefined value in a closed set nested in the terminal stubs the terminal; the turn does not close.
  it("(g) a turn.done whose paused ask carries an undefined kind is stubbed and the turn stays open, no resync", () => {
    const tail = S_TAIL(2);
    const done = tail[tail.length - 1] as Record<string, unknown>;
    expect(done["type"]).toBe("turn.done");
    done["outcome"] = { type: "paused", asks: [{ askId: "a1", kind: "zz", toolCallId: "c9" }] };
    done["finishReason"] = "paused";
    const out = ingestAgEvents([...S_HEAD, ...tail] as unknown as JsonValue[]);
    const ignored = out.filter((e) => e.type === "ext.agjson.ignored") as unknown as Array<Record<string, unknown>>;
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ ignoredType: "turn.done" });
    const r = reduce(out);
    expect(r.needsResync).toBe(false);
    expect(r.result.turns[0]?.outcome, "the turn did not close").toBeUndefined();
  });

  // §5 "What a built record carries": an unknown TOP-LEVEL member of a record-building event reaches no record, block or
  // turn the fold builds; the same member inside a whole-carried messages.snapshot memory record survives.
  it("built-record rule: zzEvt on every event of S reaches no record, block or turn; zzTop inside a snapshot memory record survives", () => {
    const withZz = [...S_HEAD, ...S_TAIL(2)].map((e) => ({ ...(e as Record<string, unknown>), zzEvt: 1 }));
    const r = reduce(ingestAgEvents(withZz as unknown as JsonValue[]));
    expect(r.needsResync).toBe(false);
    const seen: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (k === "zzEvt") seen.push(path); walk(x, `${path}.${k}`); }
    };
    walk(r.result, "result");
    expect(seen, "no built record, block or turn carries zzEvt").toEqual([]);
    const snap = [
      { type: "turn.start", seq: 0, threadId: "th22", turnId: "t1" },
      { type: "messages.snapshot", seq: 1, turnId: "t1", messages: [], memory: [{ scope: "thread", key: "k", value: 1, zzTop: 7 }] },
      { type: "turn.done", seq: 2, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
    ];
    const rs = reduce(ingestAgEvents(snap as unknown as JsonValue[]));
    expect(rs.needsResync).toBe(false);
    expect((rs.result.memory[0] as unknown as Record<string, unknown>)["zzTop"], "a whole-carried snapshot record keeps its unknown member").toBe(7);
  });

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
// the REAL-engine fixtures; the answer-id, host-completion and
// replay legs are N/A-pending the google-adk step 2 (manifest rows above).
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.25 — framework pause and completion closure: a pause closes paused at the invocation's end (from push() on the completion signal, else from flush()), a completed Workflow invoke without the completion signal, or one cut short, closes turn.abort from flush(), never success; no park", () => {
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
    it(`${name}: turn.done {outcome:"paused", finishReason:"paused"} from flush() without the completion signal, one ask per pending request`, () => {
      const tagged = run(name);
      const [term] = assertClosure(tagged);
      expect(term).toMatchObject({ from: "flush", ev: { type: "turn.done", finishReason: "paused", outcome: { type: "paused" } } });
      expect(tagged[tagged.length - 1], "the paused close is the turn's last event").toBe(term);
      const asks = (term!.ev as { outcome: { asks?: unknown[] } }).outcome.asks ?? [];
      expect(asks).toHaveLength(tagged.filter((t) => t.ev.type === "hitl.ask").length);
      expect(asks.length).toBeGreaterThan(0);
    });
  }

  for (const name of [...COMPLETED, "truncated-after-classify", "truncated-after-spike-final"]) {
    it(`${name}: a completed Workflow run without the completion signal (or cut short) closes turn.abort from flush(), never success`, () => {
      // the scope premise, self-checking: every event of these fixtures carries ADK node info (§8.0 item 26)
      expect(natives(name).every((e) => (e as unknown as { nodeInfo?: unknown }).nodeInfo !== undefined)).toBe(true);
      const tagged = run(name);
      const [term] = assertClosure(tagged);
      expect(term).toMatchObject({ from: "flush", ev: { type: "turn.abort" } });
      expect(tagged.some((t) => t.ev.type === "turn.done" && (t.ev as { outcome?: { type?: string } }).outcome?.type === "success")).toBe(false);
    });
  }

  // A pause the invocation outlives: an ADK event follows the pause end in the
  // same invocation and carries state and content. With or without the
  // completion signal, one paused terminal closes the turn as the stream's last
  // event, and the fold does not park.
  const AFTER_PAUSE = ["after-pause-usage-tail", "after-pause-callback", "after-pause-sequential", "after-pause-input-callback", "after-pause-sequential-confirmation", "after-pause-sse-credential"];
  for (const name of AFTER_PAUSE) {
    for (const completed of [false, true]) {
      it(`${name}${completed ? " (host-completion)" : ""}: one paused terminal, the stream's last event, no park`, () => {
        const tagged = completed ? runCompleted(name) : run(name);
        const [term] = assertClosure(tagged);
        expect(term).toMatchObject({ from: completed ? "push" : "flush", ev: { type: "turn.done", outcome: { type: "paused" } } });
        expect(tagged[tagged.length - 1]).toBe(term);
      });
    }
  }

  // The M26 carve-out (§8.0 item 26; INV-FLUSH (2)): a stream cut after the adk_request_* call, before any pause
  // signal, closes turn.abort from flush() and never turn.done — bare, and with hostCompletion configured but no
  // completion event fed (an abnormal end).
  const runNatives = (ns: JsonValue[], hostCompletion: boolean): Tagged[] => {
    const out: Tagged[] = [];
    const n = createAdkNormalizer(hostCompletion ? { hostCompletion: true } : {});
    for (const f of ns) for (const ev of n.push(f as unknown as AdkEvent)) out.push({ ev, from: "push" });
    for (const ev of n.flush()) out.push({ ev, from: "flush" });
    return out;
  };
  const cutAfter = (name: string, pred: (e: JsonValue) => boolean): JsonValue[] => {
    const ns = natives(name);
    const i = ns.findIndex(pred);
    expect(i, `${name}: cut point`).toBeGreaterThan(-1);
    return ns.slice(0, i + 1);
  };
  const isReservedCall = (e: JsonValue) => JSON.stringify(e).includes('"adk_request_');
  const isPauseSignal = (e: JsonValue) => {
    const a = ((e as { actions?: Record<string, unknown> }).actions ?? {}) as Record<string, unknown>;
    const nonEmpty = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" && Object.keys(v as object).length > 0);
    return nonEmpty(a["requestedAuthConfigs"]) || nonEmpty(a["requestedToolConfirmations"]) || a["skipSummarization"] === true;
  };
  for (const hostCompletion of [false, true]) {
    it(`(no-pause-signal) after-pause-usage-tail cut after the adk_request_credential call${hostCompletion ? ", hostCompletion configured and no completion event fed" : ""}: turn.abort from flush(), never turn.done`, () => {
      const tagged = runNatives(cutAfter("after-pause-usage-tail", isReservedCall), hostCompletion);
      expect(tagged.some((t) => t.ev.type === "hitl.ask"), "the ask is on the wire before the cut").toBe(true);
      expect(tagged.some((t) => t.ev.type === "turn.done")).toBe(false);
      const aborts = tagged.filter((t) => t.ev.type === "turn.abort");
      expect(aborts).toHaveLength(1);
      expect(aborts[0]).toMatchObject({ from: "flush", ev: { type: "turn.abort", reason: "stream-truncated" } });
      expect(reduce(tagged.map((t) => t.ev)).needsResync).toBe(false);
    });
  }

  // Stub usage (the engine fixtures run a stub model): the paused close carries the invocation's usage — the
  // field-wise sum of every non-partial ADK event's usageMetadata — and no message.end of that turn carries
  // usage. after-pause-sse-credential is excluded from the equality: ADK's StreamingResponseAggregator
  // re-surfaces the closed stream's usage on its content-less tail (which also carries the finish reason), so
  // the sum double-counts the first model call (§8.0 item 24's pending dedupe, its own bar); it is asserted
  // only to carry usage on the terminal.
  const usageSum = (name: string): { inputTokens: number; outputTokens: number; totalTokens: number } | undefined => {
    let seen = false; const sum = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const e of natives(name) as Array<{ partial?: boolean; usageMetadata?: Record<string, number> }>) {
      const u = e.usageMetadata;
      if (e.partial === true || !u || Object.keys(u).length === 0) continue;
      seen = true;
      sum.inputTokens += u["promptTokenCount"] ?? 0; sum.outputTokens += u["candidatesTokenCount"] ?? 0; sum.totalTokens += u["totalTokenCount"] ?? 0;
    }
    return seen ? sum : undefined;
  };
  for (const name of AFTER_PAUSE) {
    for (const completed of [false, true]) {
      it(`(stub usage) ${name}${completed ? " (host-completion)" : ""}: the paused close carries the invocation's usage; no message.end of the turn carries usage`, () => {
        const tagged = completed ? runCompleted(name) : run(name);
        const [term] = assertClosure(tagged);
        const usage = (term!.ev as { usage?: Record<string, number> }).usage;
        const expected = usageSum(name);
        if (expected === undefined) expect(usage, "a fixture with no usageMetadata closes without usage").toBeUndefined();
        else if (name === "after-pause-sse-credential") expect(usage, "carries usage (the sum is item 24's known overcount)").toBeDefined();
        else expect(usage).toMatchObject(expected);
        const turnId = turnOf(term!.ev);
        for (const t of tagged) if (t.ev.type === "message.end" && turnOf(t.ev) === turnId) expect((t.ev as { usage?: unknown }).usage, "message.end carries no usage").toBeUndefined();
      });
    }
  }

  // §10 item 40 (adk leg): a stream cut mid-turn AFTER a pause signal flushes exactly one paused turn.done and
  // no turn.abort for that turn — INV-FLUSH (2)'s paused release is the only turn.done a flush may emit.
  it("(§10.40 adk) after-pause-callback cut after the pause signal, before the callback: flush() emits exactly one paused turn.done, the turn's last event, and no turn.abort", () => {
    const tagged = runNatives(cutAfter("after-pause-callback", isPauseSignal), false);
    const [term] = assertClosure(tagged);
    expect(term).toMatchObject({ from: "flush", ev: { type: "turn.done", finishReason: "paused", outcome: { type: "paused" } } });
    expect(tagged.filter((t) => t.ev.type === "turn.done")).toHaveLength(1);
    expect(tagged.some((t) => t.ev.type === "turn.abort")).toBe(false);
    expect(tagged[tagged.length - 1]).toBe(term);
  });

  it("the pause and its resume (two invokes, one Normalizer each) fold together without a park; the resume is its own turn", () => {
    const tagged = run("wf-pause-resume.invoke1", "wf-pause-resume.invoke2");
    const terms = assertClosure(tagged);
    expect(terms.map((t) => [t.ev.type, t.from])).toEqual([["turn.done", "flush"], ["turn.abort", "flush"]]);
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
    it(`(host-completion) ${name}: with the completion event fed, a pause closes paused from push() on it, the turn's last event`, () => {
      const tagged = runCompleted(name);
      const [term] = assertClosure(tagged);
      expect(term).toMatchObject({ from: "push", ev: { type: "turn.done", finishReason: "paused", outcome: { type: "paused" } } });
      expect(tagged[tagged.length - 1]).toBe(term);
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
  // the event, the run's close is not the flush abort. The flush abort is INV-TURN's
  // `turn.abort` (reason: stream-truncated). Any other abort closed its turn in band (a Live
  // barge-in's `interrupted`, the live-bargein-gemini38live capture), and only the run's last turn can
  // be left to flush, so the event touches that close alone.
  it("(replay) every corpus/*/adk golden: in-band close → unchanged with and without the event; no in-band terminal → done with it, abort without it", async () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const FLUSH_ABORT = "abort:stream-truncated";
    type Ev = { type: string; outcome?: { type: string }; reason?: string; toolCallId?: string; usage?: unknown };
    const terminals = (agjson: JsonValue[]) =>
      (agjson as Ev[]).map((e, i) => ({ e, i })).filter(({ e }) => TERMINALS.has(e.type));
    const closes = (agjson: JsonValue[]) =>
      terminals(agjson).map(({ e }) => (e.type === "turn.done" ? `done:${e.outcome?.type}` : e.type === "turn.abort" ? `abort:${e.reason}` : e.type));
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
      const plainCloses = closes(plain.agjson);
      if (!plainCloses.includes(FLUSH_ABORT)) {
        inBand++;
        expect(JSON.stringify(marked.agjson), dir).toBe(JSON.stringify(plain.agjson));
      } else {
        markerClosed++;
        // Exactly one flush abort, the run's last close; every earlier close is in band and the same
        // with the event fed.
        expect(plainCloses.filter((c) => c === FLUSH_ABORT), dir).toEqual([FLUSH_ABORT]);
        expect(plainCloses.at(-1), dir).toBe(FLUSH_ABORT);
        const markedTerms = terminals(marked.agjson);
        const markedCloses = closes(marked.agjson);
        expect(markedCloses.slice(0, -1), dir).toEqual(plainCloses.slice(0, -1));
        // Obligation 4's three branches with the event fed: paused (an ask pending) or success (nothing
        // pending) close turn.done from push(); a pending long-running call leaves the turn to flush().
        // The third branch is accepted only when a call of the last turn really is pending: a tool.start
        // after the previous close with no tool.done.
        const markedClose = markedCloses.at(-1);
        if (markedClose === FLUSH_ABORT) {
          const from = markedTerms.length > 1 ? markedTerms[markedTerms.length - 2]!.i + 1 : 0;
          const evs = (marked.agjson as Ev[]).slice(from);
          const done = new Set(evs.filter((e) => e.type === "tool.done").map((e) => e.toolCallId));
          expect(evs.some((e) => e.type === "tool.start" && !done.has(e.toolCallId)), `${dir}: left to flush with no pending call`).toBe(true);
        } else {
          expect(markedClose, dir).toMatch(/^done:/);
        }
        // a marker-closed success keeps the run's usage (live receipt: workflow-complete-gemini38)
        const lastClose = markedTerms.at(-1)?.e;
        if (lastClose?.type === "turn.done" && lastClose.outcome?.type === "success") expect(lastClose.usage, dir).toBeDefined();
      }
    }
    expect(inBand).toBeGreaterThan(0);
    expect(markerClosed).toBeGreaterThan(0); // the live Workflow seeds (371a02c) exercise the no-in-band case
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
// normalizer with the SPEC's own vectors (4fa8ba4 / e59e976).
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

  // §10.23 ADK leg (draft.8, decision 4): a native block reason with no AgJSON target carries reasonRaw; a mapped one does not.
  for (const raw of ["SOME_FUTURE_BLOCK_REASON", "Other\u2014v2 \u2713"]) {
    it(`§10.23(adk-blocked): promptFeedback.blockReason ${JSON.stringify(raw)} → prompt.blocked reason "other" + reasonRaw byte for byte`, () => {
      const out = drive([{ invocationId: "inv1", author: "agent", content: { role: "model", parts: [] }, partial: false, turnComplete: true, promptFeedback: { blockReason: raw } } as unknown as AdkEvent]);
      expect(out.find((e) => e.type === "prompt.blocked")).toMatchObject({ reason: "other", reasonRaw: raw });
    });
  }
  it("§10.23(adk-blocked): a mapped blockReason (SAFETY) folds to reason \"safety\" and carries no reasonRaw", () => {
    const out = drive([{ invocationId: "inv1", author: "agent", content: { role: "model", parts: [] }, partial: false, turnComplete: true, promptFeedback: { blockReason: "SAFETY" } } as unknown as AdkEvent]);
    const blocked = out.find((e) => e.type === "prompt.blocked") as unknown as Record<string, unknown> | undefined;
    expect(blocked).toMatchObject({ reason: "safety" });
    expect(blocked !== undefined && "reasonRaw" in blocked).toBe(false);
  });

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
// OpenAI Agents normalizer (the phase carry, 347d550; §8.0 item 27).
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

describe("§10.23(openai) — an unmapped OpenAI finish reason → fallback + finishReasonRaw byte for byte", () => {
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
// path 1 + 1a). Each offending event leaves needsResync true and the
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

  it("(goldens) on every replay golden, block-creating *.start ids are unique within each invoke, and no message.start names an id an earlier message.start or tool.done.messageId of the invoke named (rc.1)", () => {
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
          const type = e["type"];
          if (type === "tool.done") {
            // rc.1: an adopted message id is named for the invoke; a later message.start naming it is the repeat
            if (typeof e["messageId"] === "string") seen.add(`msg:${e["messageId"]}`);
            continue;
          }
          const id = type === "tool.start" ? e["toolCallId"] : type === "text.start" || type === "reasoning.start" || type === "message.start" ? e["id"] : undefined;
          if (typeof id !== "string") continue;
          const key = `${type === "tool.start" ? "tool" : type === "message.start" ? "msg" : "block"}:${id}`;
          if (seen.has(key)) dups.push(`${dir}/${fw}:${key}`);
          seen.add(key);
        }
      }
    }
    expect(files).toBeGreaterThan(0);
    expect(dups).toEqual([]);
  });

  // draft.4 message.start rule (ruled path 1): a message.start naming a closed turn parks,
  // within an invoke and across invokes; closure survives a 0-restart and, since draft.5, follows the
  // fold's turn records across a messages.snapshot.
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
  // draft.5 (ruled 2026-09-25): closure follows the fold's turn records —
  // a turn is closed while its record carries an `outcome` — so a messages.snapshot changes closure only
  // through the `turns` it leaves in the fold. (s-iv) replaces draft.4's (v-e) control.
  const E = [...S, ...END, ...DONE];
  const E_MSGS = () => reduce(E).result.messages;
  const T1_DONE = { turnId: "t1", threadId: "th1", outcome: { type: "success" } };
  const snap = (seq: number, extra: Record<string, unknown>) => P([{ type: "messages.snapshot", seq, messages: E_MSGS(), ...extra }]);
  const M2 = (seq: number) => P([{ type: "message.start", seq, id: "m2", role: "assistant", turnId: "t1", threadId: "th1" }]);
  it("(s-i) a snapshot carrying a closed turn keeps it closed: a message.start naming it parks with the fold unchanged", () => {
    const prefix = [...E, ...snap(10, { turns: [T1_DONE] })];
    parksUnchanged(prefix, M2(11));
    expect(reduce([...prefix, ...M2(11)]).result.messages.some((m) => m.id === "m2")).toBe(false);
  });
  it("(s-ii) adoption into a snapshot-closed turn parks: a tool.done adopting m1, or naming a new message of t1", () => {
    const prefix = [...E, ...snap(10, { turns: [T1_DONE] })];
    for (const messageId of ["m1", "mZ"]) {
      const td = P([{ type: "tool.done", seq: 11, toolCallId: "c9", messageId, turnId: "t1", content: [{ type: "text", text: "r" }], outcome: "ok" }]);
      parksUnchanged(prefix, td);
      const f = reduce([...prefix, ...td]).result;
      expect(JSON.stringify(f.messages)).not.toContain('"tool-result"');
    }
  });
  it("(s-iii) a messages-only snapshot (no `turns`) keeps closure: the record keeps its outcome and a message.start naming t1 parks", () => {
    const prefix = [...E, ...snap(10, {})];
    parksUnchanged(prefix, M2(11));
    const f = reduce([...prefix, ...M2(11)]).result;
    expect(f.turns.find((t) => t.turnId === "t1")?.outcome?.type).toBe("success");
    expect(f.messages.some((m) => m.id === "m2")).toBe(false);
  });
  it("(s-iv) control: a snapshot carrying t1's record without an outcome, or `turns: []`, reopens t1 and the message.start folds", () => {
    for (const turns of [[{ turnId: "t1", threadId: "th1" }], []]) {
      const f = both([...E, ...snap(10, { turns }), ...M2(11)]);
      expect(f.needsResync).toBe(false);
      expect(f.result.messages.find((m) => m.id === "m2")?.turnId).toBe("t1");
    }
  });
  it("(s-v) a joiner at the snapshot folds like the continuing reducer: both park, with the same result", () => {
    const continuing = both([...E, ...snap(10, { turns: [T1_DONE] }), ...M2(11)]);
    const joiner = both([...snap(0, { turns: [T1_DONE] }), ...M2(1)]);
    expect(continuing.needsResync).toBe(true);
    expect(joiner.needsResync).toBe(true);
    expect(JSON.stringify(joiner.result)).toBe(JSON.stringify(continuing.result));
  });
  it("(s-vi) a completed invoke re-sent from seq 0 after a snapshot of its own fold never folds twice", () => {
    const E2 = P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
      { type: "tool.start", seq: 2, toolCallId: "c1", name: "echo", turnId: "t1", messageId: "m1" },
      { type: "tool.args.assembled", seq: 3, toolCallId: "c1", input: { x: 1 } },
      { type: "tool.done", seq: 4, toolCallId: "c1", messageId: "m1", turnId: "t1", content: [{ type: "text", text: "r" }], outcome: "ok" },
      { type: "message.end", seq: 5, id: "m1" },
      { type: "turn.done", seq: 6, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
    ]);
    const folded = reduce(E2);
    expect(folded.needsResync).toBe(false);
    const snapshot = P([{ type: "messages.snapshot", seq: 7, messages: folded.result.messages, turns: folded.result.turns }]);
    const atSnap = both([...E2, ...snapshot]);
    const f = both([...E2, ...snapshot, ...E2]);
    expect(f.needsResync).toBe(true);
    expect(JSON.stringify(f.result)).toBe(JSON.stringify(atSnap.result));
    const results = JSON.stringify(f.result.messages).match(/"tool-result"/g) ?? [];
    expect(results).toHaveLength(1);
  });
  it("(s-vii) a same-type paused re-close across a snapshot folds: one record for X, carrying the later asks", () => {
    const ask = (state: string) => ({ askId: "a1", kind: "url", toolCallId: "c1", url: `https://idp.example/authorize?state=${state}` });
    const invoke = (state: string) => P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "X" },
      { type: "hitl.ask", seq: 1, turnId: "X", ...ask(state) },
      { type: "turn.done", seq: 2, turnId: "X", outcome: { type: "paused", asks: [ask(state)] }, finishReason: "paused" },
    ]);
    const first = invoke("s1");
    const r1 = reduce(first).result;
    const snapshot = P([{ type: "messages.snapshot", seq: 3, messages: r1.messages, turns: r1.turns }]);
    const second = invoke("s2");
    const f = both([...first, ...snapshot, ...second]);
    expect(f.needsResync).toBe(false);
    const recs = f.result.turns.filter((t) => t.turnId === "X");
    expect(recs).toHaveLength(1);
    expect(JSON.stringify((recs[0]?.outcome as { asks?: unknown } | undefined)?.asks)).toContain("state=s2");
  });
  it("(v-g) a re-sent turn.start plus a second turn.done{paused} for a turn already closed paused, with refreshed asks, does not park; one record, carrying the later asks", () => {
    // A refreshed ask, as a host re-mints an authorization URL (a fresh state) on each unanswered invoke.
    const ask = (state: string) => ({ askId: "a1", kind: "url", toolCallId: "c1", url: `https://idp.example/authorize?state=${state}` });
    const invoke = (state: string) => P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "X" },
      { type: "hitl.ask", seq: 1, turnId: "X", ...ask(state) },
      { type: "turn.done", seq: 2, turnId: "X", outcome: { type: "paused", asks: [ask(state)] }, finishReason: "paused" },
    ]);
    const second = invoke("s2");
    const f = both([...invoke("s1"), ...second]);
    expect(f.needsResync).toBe(false);
    const recs = f.result.turns.filter((t) => t.turnId === "X");
    expect(recs).toHaveLength(1);
    const later = (second[2] as unknown as { outcome: { asks: unknown[] } }).outcome.asks;
    expect((recs[0]?.outcome as { asks?: unknown } | undefined)?.asks).toEqual(later);
    expect(JSON.stringify(later)).toContain("state=s2");
    // draft.5 (#29): the refresh replaces outcome and asks; a field it omits keeps its recorded value.
    const U1 = { inputTokens: 11, outputTokens: 7 };
    const withUsage = P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "X" },
      { type: "hitl.ask", seq: 1, turnId: "X", ...ask("u1") },
      { type: "turn.done", seq: 2, turnId: "X", outcome: { type: "paused", asks: [ask("u1")] }, finishReason: "paused", usage: U1 },
    ]);
    const g = both([...withUsage, ...invoke("u2")]);
    expect(g.needsResync).toBe(false);
    const rec = g.result.turns.filter((t) => t.turnId === "X");
    expect(rec).toHaveLength(1);
    expect(rec[0]?.usage).toEqual(U1);
    expect((rec[0]?.outcome as { asks?: unknown } | undefined)?.asks).toEqual([ask("u2")]);
    expect((rec[0] as { asks?: unknown }).asks).toEqual([ask("u2")]);
    // A refresh split by a reconnect: the re-sent turn.start precedes a messages.snapshot that carries the
    // paused record; the turn.done{paused} after it is still the refresh (no terminal folded in between).
    const paused = both(withUsage).result.turns[0]!;
    const split = both([
      ...withUsage,
      ...P([
        { type: "turn.start", seq: 0, threadId: "th1", turnId: "X" },
        { type: "messages.snapshot", seq: 1, messages: [], turns: [paused] },
        { type: "hitl.ask", seq: 2, turnId: "X", ...ask("u3") },
        { type: "turn.done", seq: 3, turnId: "X", outcome: { type: "paused", asks: [ask("u3")] }, finishReason: "paused" },
      ]),
    ]);
    expect(split.needsResync).toBe(false);
    expect((split.result.turns.find((t) => t.turnId === "X")?.outcome as { asks?: unknown } | undefined)?.asks).toEqual([ask("u3")]);
  });

  // draft.5 (#29, B-strict): a second terminal for a closed turn parks, whatever its outcome,
  // except the paused refresh above. Closure follows the fold's turn records (draft.5), so a
  // snapshot that carries the turn with its outcome keeps it closed and a later terminal parks too.
  const T = "T";
  const open = (seq = 0) => ({ type: "turn.start", seq, threadId: "th1", turnId: T });
  const TERM_ROWS: Array<[string, Record<string, unknown>]> = [
    ["turn.done success", { type: "turn.done", turnId: T, outcome: { type: "success" }, finishReason: "stop" }],
    ["turn.done paused", { type: "turn.done", turnId: T, outcome: { type: "paused", asks: [{ askId: "a", kind: "text" }] }, finishReason: "paused" }],
    ["turn.done error", { type: "turn.done", turnId: T, outcome: { type: "error", message: "e" }, finishReason: "other" }],
    ["turn.done rejected", { type: "turn.done", turnId: T, outcome: { type: "rejected", reason: "r" }, finishReason: "stop" }],
    ["turn.error", { type: "turn.error", turnId: T, message: "boom", code: "x" }],
    ["turn.abort", { type: "turn.abort", turnId: T, reason: "stream-truncated" }],
  ];
  const outcomeType = (t: Record<string, unknown>) => t["type"] === "turn.error" ? "error" : t["type"] === "turn.abort" ? "aborted" : (t["outcome"] as { type: string }).type;
  const parks = (evs: AgEvent[], prefix: AgEvent[], label: string) => {
    const r = both(evs);
    expect(r.needsResync, label).toBe(true);
    expect(r.result, label).toEqual(both(prefix).result);
  };
  it("(v-h) a second terminal of another outcome type for a closed turn parks, table-driven over every (first, second) pair, and leaves the fold at the prefix", () => {
    let rows = 0;
    for (const [nx, X] of TERM_ROWS) for (const [ny, Y] of TERM_ROWS) {
      if (outcomeType(X) === outcomeType(Y)) continue;
      const prefix = P([open(), { ...X, seq: 1 }]);
      parks(P([open(), { ...X, seq: 1 }, { ...Y, seq: 2 }]), prefix, `${nx} then ${ny}`);
      rows++;
    }
    expect(rows).toBeGreaterThan(20);
  });
  it("(v-i) a same-type non-paused re-close parks (success/success, error/error, abort/abort), within one invoke and across a seq-0 restart; usage and the error stay the first terminal's", () => {
    const pairs: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ type: "turn.done", turnId: T, outcome: { type: "success" }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2 } }, { type: "turn.done", turnId: T, outcome: { type: "success" }, finishReason: "stop", usage: { inputTokens: 9, outputTokens: 9 } }],
      [{ type: "turn.error", turnId: T, message: "first", code: "c1" }, { type: "turn.error", turnId: T, message: "second", code: "c2" }],
      [{ type: "turn.abort", turnId: T, reason: "stream-truncated" }, { type: "turn.abort", turnId: T, reason: "cancelled" }],
    ];
    for (const [X, Y] of pairs) {
      const prefix = P([open(), { ...X, seq: 1 }]);
      parks(P([open(), { ...X, seq: 1 }, { ...Y, seq: 2 }]), prefix, `${String(X["type"])} same invoke`);
      parks(P([open(), { ...X, seq: 1 }, { ...Y, seq: 0 }]), prefix, `${String(X["type"])} across a 0-restart`);
    }
  });
  it("(v-j) a paused re-close with no re-sent turn.start parks; the record keeps the first asks", () => {
    const a = { askId: "a", kind: "text" }, b = { askId: "b", kind: "text" };
    const prefix = P([open(), { type: "turn.done", seq: 1, turnId: T, outcome: { type: "paused", asks: [a] }, finishReason: "paused" }]);
    const r = both([...prefix, ...P([{ type: "turn.done", seq: 2, turnId: T, outcome: { type: "paused", asks: [b] }, finishReason: "paused" }])]);
    expect(r.needsResync).toBe(true);
    expect((r.result.turns[0]?.outcome as { asks?: unknown }).asks).toEqual([a]);
  });
  it("(v-k) a turnId-less turn.error or turn.abort with no open turn parks under INV-OWNER (no sole open turn resolves it); the closed turn keeps outcome success", () => {
    const lates: Array<Record<string, unknown>> = [{ type: "turn.error", seq: 2, message: "late", code: "l" }, { type: "turn.abort", seq: 2, reason: "cancelled" }];
    for (const late of lates) {
      const prefix = P([open(), { type: "turn.done", seq: 1, turnId: T, outcome: { type: "success" }, finishReason: "stop" }]);
      const r = both([...prefix, ...P([late])]);
      expect(r.needsResync, String(late["type"])).toBe(true);
      expect(r.result.turns[0]?.outcome).toEqual({ type: "success" });
    }
  });
  it("(v-l) closure follows the records across a messages.snapshot (draft.5): a snapshot carrying T with its paused outcome keeps T closed, so a later turn.done{success} parks; one carrying T without an outcome leaves T open, so it folds", () => {
    const paused = P([open(), { type: "turn.done", seq: 1, turnId: T, outcome: { type: "paused", asks: [{ askId: "a", kind: "text" }] }, finishReason: "paused" }]);
    const rec = both(paused).result.turns[0]!;
    const closedSnap = P([{ type: "messages.snapshot", seq: 2, messages: [], turns: [rec] }]);
    const closed = both([...paused, ...closedSnap, ...P([{ type: "turn.done", seq: 3, turnId: T, outcome: { type: "success" }, finishReason: "stop" }])]);
    expect(closed.needsResync).toBe(true);
    const { outcome: _o, asks: _a, ...openRec } = rec as Record<string, unknown>;
    const openSnap = P([{ type: "messages.snapshot", seq: 2, messages: [], turns: [openRec] }]);
    const reopened = both([...paused, ...openSnap, ...P([{ type: "turn.done", seq: 3, turnId: T, outcome: { type: "success" }, finishReason: "stop" }])]);
    expect(reopened.needsResync).toBe(false);
    expect(reopened.result.turns[0]?.outcome).toEqual({ type: "success" });
  });
  // rc.1 fold rules (§5.0 INV-MSG, INV-BLOCK): a message.start naming an id the fold already holds as
  // a message parks with the fold unchanged — open or sealed, carried by a folded messages.snapshot,
  // adopted by a tool.done, and in a later invoke (the held set spans the fold); an id a folded
  // message.remove removed, or one a snapshot omitted, is not held. A tool.done with more:true for a
  // call whose final result the invoke already landed parks.
  it("(ix) a second message.start naming an open id, or a sealed one, parks with the fold unchanged (rc.1)", () => {
    const again = (seq: number) => P([{ type: "message.start", seq, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" }]);
    parksUnchanged(S, again(8));
    parksUnchanged([...S, ...END], again(9));
  });
  it("(x) a later invoke's message.start naming an id the fold holds parks (the held set spans the fold); a fresh id in that invoke folds", () => {
    const T2 = P([{ type: "turn.start", seq: 0, threadId: "th1", turnId: "t2" }]);
    const m = (id: string) => P([{ type: "message.start", seq: 1, id, role: "assistant", turnId: "t2", threadId: "th1" }]);
    parksUnchanged([...S, ...END, ...DONE, ...T2], m("m1"));
    const fresh = both([...S, ...END, ...DONE, ...T2, ...m("m2")]);
    expect(fresh.needsResync).toBe(false);
    expect(fresh.result.messages.map((x) => x.id)).toEqual(["m1", "m2"]);
  });
  it("(xi) an id carried by a folded messages.snapshot, and one adopted by a tool.done.messageId, park when a message.start names it", () => {
    const snap = P([{ type: "messages.snapshot", seq: 0, messages: [{ id: "ms", role: "assistant", content: [{ type: "text", text: "s" }], turnId: "t1", threadId: "th1" }], turns: [{ turnId: "t1", threadId: "th1" }] }]);
    parksUnchanged(snap, P([{ type: "message.start", seq: 1, id: "ms", role: "assistant", turnId: "t1", threadId: "th1" }]));
    const adopted = P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
      { type: "tool.start", seq: 2, toolCallId: "c1", name: "calc", turnId: "t1", messageId: "m1" },
      { type: "tool.args.assembled", seq: 3, toolCallId: "c1", input: {} },
      { type: "tool.done", seq: 4, toolCallId: "c1", messageId: "mt", turnId: "t1", content: [{ type: "text", text: "r" }], outcome: "ok" },
    ]);
    expect(both(adopted).result.messages.some((m) => m.id === "mt")).toBe(true); // the adoption minted mt (non-vacuity)
    parksUnchanged(adopted, P([{ type: "message.start", seq: 5, id: "mt", role: "assistant", turnId: "t1", threadId: "th1" }]));
  });
  it("(xii) an id a folded message.remove removed, or one a messages.snapshot omitted, is not held — a message.start naming it folds", () => {
    const removed = both([...S, ...END, ...P([{ type: "message.remove", seq: 9, id: "m1" }, { type: "message.start", seq: 10, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" }])]);
    expect(removed.needsResync).toBe(false);
    expect(removed.result.messages.filter((m) => m.id === "m1")).toHaveLength(1);
    expect(removed.result.messages.find((m) => m.id === "m1")?.content).toEqual([]);
    const released = both([...S, ...END, ...P([{ type: "messages.snapshot", seq: 9, messages: [] }, { type: "message.start", seq: 10, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" }])]);
    expect(released.needsResync).toBe(false);
    expect(released.result.messages.map((m) => m.id)).toEqual(["m1"]);
  });
  it("(xiii) a tool.done with more:true for a call whose final result the invoke already landed parks with the fold unchanged (rc.1); a preliminary then the final folds", () => {
    const open = [
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
      { type: "tool.start", seq: 2, toolCallId: "c1", name: "calc", turnId: "t1", threadId: "th1" },
      { type: "tool.args.assembled", seq: 3, toolCallId: "c1", input: { x: 1 } },
    ];
    const prelim = (seq: number) => ({ type: "tool.done", seq, toolCallId: "c1", content: [{ type: "text", text: "p" }], outcome: "ok", more: true });
    const final = (seq: number) => ({ type: "tool.done", seq, toolCallId: "c1", content: [{ type: "text", text: "f" }], outcome: "ok" });
    const results = (r: ReturnType<typeof reduce>) => JSON.stringify(r.result.messages).match(/"tool-result"/g) ?? [];
    parksUnchanged(P([...open, final(4)]), P([prelim(5)]));
    const ordered = both(P([...open, prelim(4), final(5)]));
    expect(ordered.needsResync).toBe(false);
    expect(results(ordered).length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(ordered.result.messages)).toContain('"text":"f"');
    // A cross-invoke more:true is not a reducer case this version defines: INV-XINV binds the
    // normalizer to emit a cross-invoke result without more:true, and the §5 tool.done row lands a
    // later invoke's result only through its own pairing and adoption rules.
  });

  it("(producers) on every replay golden no message.start follows the terminal of the turn it names, or a messages.snapshot carrying that turn with an outcome; on every committed resume pair no turn or message id of one invoke recurs in the other, and the pair folds without a resync", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const TERMINALS = new Set(["turn.done", "turn.error", "turn.abort"]);
    const bad: string[] = [];
    let pairs = 0;
    const load = (dir: string, fw: string) => JSON.parse(readFileSync(new URL(`${dir}/${fw}.agjson.json`, corpus), "utf8")) as Array<Record<string, unknown>>;
    const dirs = readdirSync(corpus).sort();
    for (const dir of dirs) {
      // every framework directory's golden, read from disk (no hardcoded framework list)
      const fws = readdirSync(new URL(`${dir}/`, corpus)).filter((f) => f.endsWith(".agjson.json")).map((f) => f.slice(0, -".agjson.json".length)).sort();
      for (const fw of fws) {
        const evs = load(dir, fw);
        const closed = new Set<unknown>();
        const only = evs.filter((e) => e["type"] === "turn.start").map((e) => e["turnId"]);
        const terminalsPer = new Map<unknown, number>();
        for (const e of evs) {
          if (TERMINALS.has(e["type"] as string)) {
            closed.add(e["turnId"]);
            terminalsPer.set(e["turnId"], (terminalsPer.get(e["turnId"]) ?? 0) + 1);
          }
          // draft.5: a snapshot that carries a turn with an outcome closes it for the producer rule too
          if (e["type"] === "messages.snapshot" && Array.isArray(e["turns"])) {
            for (const t of e["turns"] as Array<Record<string, unknown>>) if (t["outcome"] !== undefined) closed.add(t["turnId"]);
          }
          if (e["type"] === "message.start") {
            const tid = e["turnId"] ?? (only.length === 1 ? only[0] : undefined);
            if (closed.has(tid)) bad.push(`${dir}/${fw}: message.start ${String(e["id"])} after ${String(tid)}'s terminal`);
          }
        }
        for (const [tid, n] of terminalsPer) if (n > 1) bad.push(`${dir}/${fw}: ${String(tid)} carries ${n} terminals`);
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
        const threadId = (golden.find((e) => e["type"] === "turn.start")?.["threadId"] as string | undefined) ?? "th_host"; // a golden's own root is a facet placeholder: the corpus is captured with no host thread (SPEC §1.2)
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
    expect(reject(start({ run: { reasoning: { mode: "zz" } } }))).toEqual({ code: "unknown-value", path: ["run", "reasoning", "mode"] }); // effort is an open string since draft.8
    expect(reject(start({ messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }, { type: "zz" }] }] }))).toEqual({ code: "unknown-value", path: ["messages", 0, "content", 1, "type"] });
  });

  it("(b5-b7) a missing value or a value of the wrong JSON type is malformed", () => {
    expect(reject({ ...ENV, kind: 9 }).code).toBe("malformed");
    expect(reject({ ...ENV, kind: "resume", answers: [{ askId: "a" }] })).toEqual({ code: "malformed", path: ["answers", 0, "status"] });
    expect(reject(start({ capabilities: { hitl: { grantModes: {} } } }))).toEqual({ code: "malformed", path: ["capabilities", "hitl", "grantModes"] });
    // draft.4 §3/§6: viewMessageTurns is a boolean; an MCP-shaped modalities object where it belongs is malformed at the member
    expect(reject(start({ capabilities: { uiResources: { viewMessageTurns: { text: {} } } } }))).toEqual({ code: "malformed", path: ["capabilities", "uiResources", "viewMessageTurns"] });
  });
  it("(b8) any same-major prerelease tag is accepted; a different major is rejected whatever its tag; a missing version is malformed", () => {
    for (const version of ["1.0.0-rc.1", "1.0.0-beta.1", "1.0.0-draft.2", "1.0.0"]) {
      expect(reject(start({ version })), version).toEqual({ ok: true });
      expect(AgInput.safeParse(start({ version })).success, `schema: ${version}`).toBe(true);
    }
    expect(reject(start({ version: "2.0.0-rc.1" }))).toEqual({ code: "major-mismatch", path: ["version"] });
    expect(AgInput.safeParse(start({ version: "2.0.0-rc.1" })).success).toBe(false);
    const noVersion = start({}) as Record<string, unknown>;
    delete noVersion["version"];
    expect(reject(noVersion)).toEqual({ code: "malformed", path: ["version"] });
  });

  it("(b19) a set §12 classes OPEN STRING: an undocumented effort is accepted and the checked input carries it unchanged; a non-string effort is malformed; the closed neighbour (mode) still rejects with unknown-value", () => {
    const passed = checkAgInput(start({ run: { reasoning: { mode: "enabled", effort: "xhigh" } } }));
    expect(passed.ok).toBe(true);
    expect(passed.ok ? (JSON.parse(JSON.stringify(passed.input)) as { run: { reasoning: { effort: string } } }).run.reasoning.effort : undefined).toBe("xhigh");
    expect(reject(start({ run: { reasoning: { mode: "enabled", effort: 3 } } }))).toEqual({ code: "malformed", path: ["run", "reasoning", "effort"] });
    expect(reject(start({ run: { reasoning: { mode: "zz", effort: "xhigh" } } }))).toEqual({ code: "unknown-value", path: ["run", "reasoning", "mode"] });
  });

  it("(b18) an open-string field: case is carried unchanged, a JSON null is malformed, and an absent effort is unset", () => {
    expect(reject(start({ run: { reasoning: { mode: "enabled", effort: null } } }))).toEqual({ code: "malformed", path: ["run", "reasoning", "effort"] });
    const absent = checkAgInput(start({ run: { reasoning: { mode: "enabled" } } }));
    expect(absent.ok).toBe(true);
    expect(absent.ok ? "effort" in (absent.input as unknown as { run: { reasoning: Record<string, unknown> } }).run.reasoning : undefined).toBe(false);
    const upper = checkAgInput(start({ run: { reasoning: { mode: "enabled", effort: "HIGH" } } }));
    expect(upper.ok).toBe(true);
    expect(upper.ok ? (upper.input as unknown as { run: { reasoning: { effort: string } } }).run.reasoning.effort : undefined).toBe("HIGH");
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
  // draft.5 (§5 turn.done row, §13.10): turn.done.messageMetadata replaces the named message's messageMetadata WHOLE;
  // the message.metadata event merges per key into a different field. Both reducers (INV-FOLD).
  const both = (evs: Record<string, unknown>[]) => {
    const parsed = evs.map((e) => AgEvent.parse(e));
    const live = new Reducer();
    for (const e of parsed) live.push(e);
    const batch = reduce(parsed);
    expect(live.needsResync).toBe(batch.needsResync);
    expect(live.result()).toEqual(batch.result);
    return batch;
  };
  it("(whole-bag) a message restored holding messageMetadata {a:1} takes turn.done{messageId, messageMetadata:{b:2}} as {b:2}; its per-key metadata is untouched", () => {
    const r = both([
      { type: "messages.snapshot", seq: 0, messages: [{ id: "m", role: "assistant", content: [], turnId: "T", threadId: "th", messageMetadata: { a: 1 }, metadata: { k: 1 } }], turns: [{ turnId: "T", threadId: "th" }] },
      { type: "message.metadata", seq: 1, messageId: "m", metadata: { j: 2 } },
      { type: "turn.done", seq: 2, turnId: "T", messageId: "m", outcome: { type: "success" }, finishReason: "stop", messageMetadata: { b: 2 } },
    ]);
    expect(r.needsResync).toBe(false);
    const m = r.result.messages.find((x) => x.id === "m")!;
    expect(m.messageMetadata).toEqual({ b: 2 });
    expect(m.metadata).toEqual({ k: 1, j: 2 });
  });
  it("(whole-bag) the paused refresh replaces the bag too: {a:1} then {b:2} folds to {b:2}, while the turn record keeps the usage the refresh omits", () => {
    const U = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const paused = (seq: number, id: string, mm: unknown, usage?: unknown): Record<string, unknown> => ({
      type: "turn.done", seq, turnId: "T", messageId: "m", outcome: { type: "paused", asks: [{ askId: id, kind: "approval" }] }, finishReason: "paused", messageMetadata: mm, ...(usage !== undefined ? { usage } : {}),
    });
    const start = (seq: number) => ({ type: "turn.start", seq, threadId: "th", turnId: "T" });
    const r = both([start(0), { type: "message.start", seq: 1, id: "m", role: "assistant", turnId: "T", threadId: "th" }, { type: "message.end", seq: 2, id: "m" }, paused(3, "a1", { a: 1 }, U), start(0), paused(1, "a2", { b: 2 })]);
    expect(r.needsResync).toBe(false);
    expect(r.result.messages.find((x) => x.id === "m")!.messageMetadata).toEqual({ b: 2 });
    expect(r.result.turns[0]!.usage).toEqual(U);
  });
});

describe("§10.36 — nested-turn closure (draft.4; §5.0 INV-TURN, §8.0 item 29)", () => {
  it("every corpus golden: each subagent.start's turn closes with exactly one terminal carrying its turnId and no usage, immediately before its subagent.done; no nested turnId is a top-level turnId; the fold without subagent.done is structurally identical", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const TERMINALS = new Set(["turn.done", "turn.error", "turn.abort"]);
    const bad: string[] = [];
    let nested = 0;
    const frameworks = new Set<string>();
    for (const d of readdirSync(corpus)) {
      for (const fw of ["claude", "openai", "adk", "vercel"]) {
        const f = new URL(`${d}/${fw}.agjson.json`, corpus);
        if (!existsSync(f)) continue;
        const ev = JSON.parse(readFileSync(f, "utf8")) as Array<Record<string, unknown>>;
        const topLevel = new Set(ev.filter((e) => e["type"] === "turn.start").map((e) => e["turnId"]));
        const subs = ev.filter((e) => e["type"] === "subagent.start");
        if (subs.length === 0) continue;
        frameworks.add(fw);
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
    // Non-vacuity per leg: the claude and openai goldens that emit subagent.* are both swept.
    expect([...frameworks].sort()).toEqual(expect.arrayContaining(["claude", "openai"]));
    expect(bad).toEqual([]);
  });
});

describe("§10.23(claude) — an unmapped Claude stop_reason → fallback + finishReasonRaw byte for byte; only on the fallback (fe87254)", () => {
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

describe("§10.23(vercel) — a vercel finish with no AgJSON target → fallback + finishReasonRaw byte for byte (f2937f9)", () => {
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
  it("(openai) on every golden carrying a handoff: kind is transfer, its turn is top-level, and it follows the bracket's subagent.done on that turn (draft.5 §8.0 item 29)", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    let seen = 0;
    for (const d of readdirSync(corpus)) {
      const f = new URL(`${d}/openai.agjson.json`, corpus);
      if (!existsSync(f)) continue;
      const ev = JSON.parse(readFileSync(f, "utf8")) as Array<Record<string, unknown>>;
      const handoffs = ev.filter((e) => e["type"] === "handoff");
      if (handoffs.length === 0) continue;
      const topLevel = new Set(ev.filter((e) => e["type"] === "turn.start" && e["parentTurnId"] === undefined).map((e) => e["turnId"]));
      for (const h of handoffs) {
        seen++;
        expect(h["kind"], `${d}: kind`).toBe("transfer");
        expect(topLevel.has(h["turnId"]), `${d}: handoff on a top-level turn`).toBe(true);
        const brackets = ev.filter((e) => e["type"] === "subagent.start" && e["parentTurnId"] === h["turnId"] && (e["seq"] as number) < (h["seq"] as number));
        expect(brackets.length, `${d}: a bracket precedes the handoff`).toBeGreaterThan(0);
        for (const b of brackets) {
          const done = ev.find((e) => e["type"] === "subagent.done" && e["turnId"] === b["turnId"]);
          expect(done !== undefined && (done["seq"] as number) < (h["seq"] as number), `${d}: subagent.done ${String(b["turnId"])} before the handoff`).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThan(1); // both openai handoff goldens
  });
  it("(adk-escalate) an ADK event with actions.escalate yields exactly one handoff{kind:escalate} with no toAgentName and no subagent.start (§8.0 item 29)", () => {
    const out = createAdkNormalizer().push(toJsonValue(adkEvent([], { actions: { escalate: true } })));
    const handoffs = out.filter((e) => e.type === "handoff");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ type: "handoff", kind: "escalate" });
    expect((handoffs[0] as Record<string, unknown>)["toAgentName"]).toBeUndefined();
    expect(out.some((e) => e.type === "subagent.start")).toBe(false);
    for (const e of out) expect(() => AgEvent.parse(e)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.37 — Shared-state fold (draft.4; §5 `state.delta`)
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

  it("a key-replace patch never removes a sibling member: {a:1,b:1} then {a:2} fold to {a:2,b:1}; a state.snapshot {c:1} is the removal path", () => {
    const kept = fold([TS, delta(1, { a: 1, b: 1 }), delta(2, { a: 2 })]);
    expect(kept.needsResync).toBe(false);
    expect(kept.result.state).toEqual({ a: 2, b: 1 });
    const snap = fold([TS, delta(1, { a: 1, b: 1 }), delta(2, { a: 2 }), { type: "state.snapshot", seq: 3, snapshot: { c: 1 } } as AgEvent]);
    expect(snap.needsResync).toBe(false);
    expect(snap.result.state).toEqual({ c: 1 });
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
  // INV-FLUSH (3), rc.1: after releasing a paused close, a flush may open the one error turn of an invocation that
  // met an invocation error: that turn's turn.start, one message.start and one message.end for a message with no
  // content and no usage, and its turn.error, as the flush's last four events. Returns the indexes of the turn.start
  // and the message.start it admits (none when the flush does not have that shape).
  const admittedErrorTurn = (flushed: AgEvent[]): Set<number> => {
    const at = flushed.findIndex((e) => e.type === "turn.start");
    if (at < 0 || at !== flushed.length - 4) return new Set();
    const [start, open, end, close] = flushed.slice(at) as [AgEvent, AgEvent, AgEvent, AgEvent];
    const turnId = (start as { turnId?: string }).turnId;
    const pausedBefore = flushed.slice(0, at).some((e) => e.type === "turn.done" && (e as { outcome?: { type?: string } }).outcome?.type === "paused");
    const ok = pausedBefore && turnId !== undefined
      && open.type === "message.start" && (open as { turnId?: string }).turnId === turnId
      && end.type === "message.end" && (end as { id?: string }).id === (open as { id?: string }).id && (end as { usage?: unknown }).usage === undefined
      && close.type === "turn.error" && (close as { turnId?: string }).turnId === turnId;
    return ok ? new Set([at, at + 1]) : new Set();
  };
  // One flush's honesty (item 40): lifecycle closes, message.end, non-success terminals and ext carries before the
  // terminals; never a success turn.done or content; a start only for the admitted error turn. Returns whether the
  // flush opened that turn.
  const honest = (flushed: AgEvent[], at: string, bad: string[]): boolean => {
    const admitted = admittedErrorTurn(flushed);
    let firstTerminal = -1;
    flushed.forEach((e, i) => {
      const ty = e.type as string;
      if (TERMINALS.has(ty) && firstTerminal < 0) firstTerminal = i;
      if (ty.startsWith("ext.")) {
        if (firstTerminal >= 0) bad.push(`${at}: ${ty} after a terminal`);
      } else if (ty === "turn.done") {
        if ((e as { outcome?: { type?: string } }).outcome?.type === "success") bad.push(`${at}: success turn.done at flush`);
      } else if (!CLOSES.has(ty) && !TERMINALS.has(ty) && !admitted.has(i)) {
        bad.push(`${at}: ${ty} at flush`);
      }
      if (ty === "text.end" || ty === "reasoning.end") {
        const extra = Object.keys(e).filter((k) => !END_KEYS.has(k));
        if (extra.length) bad.push(`${at}: ${ty} carries ${extra.join(",")}`);
      }
    });
    return admitted.size > 0;
  };
  const make = (fw: string) =>
    fw === "openai" ? createOpenaiNormalizer({ invokeId: "openai" })
    : fw === "adk" ? createAdkNormalizer({ invokeId: "adk" })
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
          honest(flushed, at, bad);
          const turns = reduce([...pushed, ...flushed]).result.turns;
          for (const t of turns) if (t.outcome === undefined) bad.push(`${at}: turn ${t.turnId} has no outcome`);
        }
      }
    }
    expect(bad.slice(0, 20)).toEqual([]);
    // Non-vacuity: every reference normalizer was cut and flushed.
    expect(Object.keys(cuts).sort()).toEqual(["adk", "claude", "openai", "vercel"]);
  }, 120_000);

  it("(adk fixtures) every prefix of every engine-built ADK error and pause native, flushed bare: the same honesty, a turn.start and a message.start at flush only for the one error turn INV-FLUSH (3) admits after a paused release, every opened turn folds to an outcome, and some prefix opens that error turn", () => {
    const bad: string[] = [];
    let cuts = 0;
    let errorTurns = 0;
    for (const dir of ["adk-error", "adk-pause"]) {
      const base = new URL(`../fixtures/${dir}/`, import.meta.url);
      for (const f of readdirSync(base).filter((x) => x.endsWith(".native.json")).sort()) {
        const native = (JSON.parse(readFileSync(new URL(f, base), "utf8")) as JsonValue[]).filter((e) => (e as { type?: string } | null)?.type !== HOST_COMPLETE_MARKER);
        for (let cut = 1; cut <= native.length; cut++) {
          const n = createAdkNormalizer({ invokeId: "adk" });
          const pushed: AgEvent[] = [];
          for (const e of native.slice(0, cut)) pushed.push(...(n.push(e as never) as AgEvent[]));
          const flushed = n.flush() as AgEvent[];
          cuts++;
          if (honest(flushed, `${dir}/${f}@${cut}`, bad)) errorTurns++;
          for (const t of reduce([...pushed, ...flushed]).result.turns) if (t.outcome === undefined) bad.push(`${dir}/${f}@${cut}: turn ${t.turnId} has no outcome`);
        }
      }
    }
    expect(bad.slice(0, 20)).toEqual([]);
    expect(cuts).toBeGreaterThan(0);
    expect(errorTurns).toBeGreaterThan(0);
  }, 120_000);

  it("(error turn) a turn.start and a message.start at flush are admitted only in INV-FLUSH (3)'s exact shape: after a paused release, one turn.start, one message.start, its message.end with no usage, and that turn's turn.error, as the flush's last four events", () => {
    const paused = { type: "turn.done", seq: 1, turnId: "t1", outcome: { type: "paused", asks: [] }, finishReason: "paused" };
    const start = { type: "turn.start", seq: 2, turnId: "t2", threadId: "th" };
    const open = { type: "message.start", seq: 3, id: "m2", role: "assistant", turnId: "t2", threadId: "th" };
    const end = { type: "message.end", seq: 4, id: "m2" };
    const close = { type: "turn.error", seq: 5, turnId: "t2", message: "x", code: "429" };
    const flag = (flushed: unknown[]): string[] => {
      const bad: string[] = [];
      honest(flushed as AgEvent[], "x", bad);
      return bad;
    };
    expect(flag([paused, start, open, end, close])).toEqual([]);
    const refused: Array<[string, unknown[]]> = [
      ["no paused release before the turn.start", [start, open, end, close]],
      ["a release that is not paused", [{ ...paused, outcome: { type: "rejected" } }, start, open, end, close]],
      ["usage on the message.end", [paused, start, open, { ...end, usage: { inputTokens: 1 } }, close]],
      ["a turn.error naming another turn", [paused, start, open, end, { ...close, turnId: "t1" }]],
      ["a message of another turn", [paused, start, { ...open, turnId: "t1" }, end, close]],
      ["a message.end closing another message", [paused, start, open, { ...end, id: "m9" }, close]],
      ["an event after the turn.error", [paused, start, open, end, close, { type: "step.done", seq: 6, id: "s1" }]],
      ["a second opened turn", [paused, start, open, end, close, { ...start, seq: 6, turnId: "t3" }, { ...open, seq: 7, id: "m3", turnId: "t3" }, { ...end, seq: 8, id: "m3" }, { ...close, seq: 9, turnId: "t3" }]],
    ];
    for (const [name, flushed] of refused) expect(flag(flushed).some((b) => b.includes("turn.start at flush")), name).toBe(true);
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

// ─────────────────────────────────────────────────────────────────────────────
// §10.43 — Never-opened terminals (draft.4; §5.0 INV-OWNER, INV-TURN)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.43 — never-opened terminals (draft.4; §5.0 INV-OWNER)", () => {
  const P = (evs: Array<Record<string, unknown>>) => evs.map((e) => AgEvent.parse(e));
  const fold = (evs: AgEvent[]) => {
    const batch = reduce(evs);
    const acc = new Reducer();
    for (const e of evs) acc.push(e);
    expect(acc.result()).toEqual(batch.result);
    expect(acc.needsResync).toBe(batch.needsResync);
    return batch;
  };
  // Every threadId some event carries (top-level, or on a snapshot's messages and turns).
  const carried = (evs: AgEvent[]) => {
    const out = new Set<unknown>();
    for (const e of evs as unknown as Array<Record<string, unknown>>) {
      if (e["threadId"] !== undefined) out.add(e["threadId"]);
      for (const m of (e["messages"] as Array<Record<string, unknown>> | undefined) ?? []) if (m["threadId"] !== undefined) out.add(m["threadId"]);
      for (const t of (e["turns"] as Array<Record<string, unknown>> | undefined) ?? []) if (t["threadId"] !== undefined) out.add(t["threadId"]);
    }
    return out;
  };
  const recs = (r: ReturnType<typeof reduce>, id: string) => r.result.turns.filter((t) => t.turnId === id);
  const U = { inputTokens: 3, outputTokens: 4, totalTokens: 7 };
  const ask = { askId: "a1", kind: "approval" };
  const msg = (turnId: string, threadId?: string) => ({ id: `m_${turnId}`, role: "assistant", turnId, ...(threadId !== undefined ? { threadId } : {}), content: [{ type: "text", text: "hi" }] });
  // The vectors whose terminals may create records; (h) folds each of them.
  const B = () => P([
    { type: "messages.snapshot", seq: 0, messages: [msg("X", "thX")] },
    { type: "turn.done", seq: 1, turnId: "X", outcome: { type: "paused", asks: [ask] }, finishReason: "paused" },
  ]);
  const E = () => P([
    { type: "messages.snapshot", seq: 0, messages: [msg("tM", "thM")], turns: [] },
    { type: "turn.abort", seq: 1, turnId: "tM", reason: "stream-truncated" },
  ]);
  const F = () => P([
    { type: "turn.start", seq: 0, threadId: "T", turnId: "X" },
    { type: "messages.snapshot", seq: 1, messages: [] },
    { type: "turn.done", seq: 2, turnId: "X", outcome: { type: "success" }, finishReason: "stop" },
  ]);
  const C = () => P([
    { type: "turn.start", seq: 0, threadId: "th1", turnId: "X" },
    { type: "turn.done", seq: 1, turnId: "X", outcome: { type: "success" }, finishReason: "stop", usage: U },
  ]);

  it("(a) a turn.error for a turnId no event opened: no record for it, no resync", () => {
    const r = fold(P([{ type: "turn.error", seq: 0, turnId: "X", message: "boom" }]));
    expect(r.needsResync).toBe(false);
    expect(recs(r, "X")).toHaveLength(0);
  });

  it("(b) a turn seen only in a turns-less snapshot's message takes its paused terminal on a record carrying that message's threadId", () => {
    const r = fold(B());
    expect(r.needsResync).toBe(false);
    expect(recs(r, "X")).toHaveLength(1);
    expect(recs(r, "X")[0]?.threadId).toBe("thX");
    expect((recs(r, "X")[0]?.outcome as { asks?: unknown } | undefined)?.asks).toEqual([ask]);
  });

  it("(b-nothread) when that message carries no threadId, the terminal folds onto no record, with no resync", () => {
    const r = fold(P([
      { type: "messages.snapshot", seq: 0, messages: [msg("X")] },
      { type: "turn.done", seq: 1, turnId: "X", outcome: { type: "paused", asks: [ask] }, finishReason: "paused" },
    ]));
    expect(r.needsResync).toBe(false);
    expect(recs(r, "X")).toHaveLength(0);
    // No other turn's thread is borrowed, even when the fold holds a real turn.
    const withReal = fold(P([
      { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
      { type: "messages.snapshot", seq: 1, messages: [msg("X")] },
      { type: "turn.done", seq: 2, turnId: "X", outcome: { type: "paused", asks: [ask] }, finishReason: "paused" },
    ]));
    expect(withReal.needsResync).toBe(false);
    expect(recs(withReal, "X")).toHaveLength(0);
  });

  it("(d) path 1: a turn dropped by a snapshot carrying turns takes no terminal, and the fold equals a joiner's that never saw its turn.start", () => {
    const tail = [
      { type: "messages.snapshot", seq: 1, messages: [], turns: [] },
      { type: "turn.done", seq: 2, turnId: "X", outcome: { type: "success" }, finishReason: "stop" },
    ];
    const r = fold(P([{ type: "turn.start", seq: 0, threadId: "T", turnId: "X" }, ...tail]));
    expect(r.needsResync).toBe(false);
    expect(recs(r, "X")).toHaveLength(0);
    const joiner = fold(P(tail.map((e) => ({ ...e, seq: (e.seq as number) - 1 }))));
    expect(r.result).toEqual(joiner.result);
  });

  it("(e) path 2: a turn seen only as a message of a snapshot carrying turns folds its terminal onto a record with that message's threadId", () => {
    const r = fold(E());
    expect(r.needsResync).toBe(false);
    expect(recs(r, "tM")).toHaveLength(1);
    expect(recs(r, "tM")[0]?.threadId).toBe("thM");
  });

  it("(f) a snapshot that omits turns keeps them: a turn opened before it takes its terminal on its own record", () => {
    const r = fold(F());
    expect(r.needsResync).toBe(false);
    expect(recs(r, "X")).toHaveLength(1);
    expect(recs(r, "X")[0]?.threadId).toBe("T");
  });

  it("(c) turn.start X then turn.done X with usage U: exactly one record for X, carrying U", () => {
    const r = fold(C());
    expect(r.needsResync).toBe(false);
    expect(recs(r, "X")).toHaveLength(1);
    expect(recs(r, "X")[0]?.usage).toEqual(U);
  });

  it("(g) a record a non-terminal event minted is not 'seen opened': a turns-less snapshot keeps it, and a terminal does not fold onto it", () => {
    const r = fold(P([
      { type: "handoff", seq: 0, turnId: "tq", kind: "transfer" },
      { type: "messages.snapshot", seq: 1, messages: [] },
      { type: "turn.done", seq: 2, turnId: "tq", outcome: { type: "success" }, finishReason: "stop" },
    ]));
    expect(r.needsResync).toBe(false);
    for (const rec of recs(r, "tq")) expect(rec.outcome).toBeUndefined();
  });

  it("(h) no record a terminal created carries a threadId that no event carried — bare, and prefixed with a record event naming the same turn (draft.5)", () => {
    const TERMS = new Set(["turn.done", "turn.error", "turn.abort"]);
    const prefixed = (evs: AgEvent[]): AgEvent[][] => {
      const term = (evs as unknown as Array<Record<string, unknown>>).find((e) => TERMS.has(e["type"] as string)) as Record<string, unknown>;
      const tid = term["turnId"] as string;
      const shift = (evs as unknown as Array<Record<string, unknown>>).map((e) => ({ ...e, seq: (e["seq"] as number) + 1 }));
      return [
        P([{ type: "source", seq: 0, turnId: tid, sourceId: "s-h", source: { url: "https://example.test/h" } }, ...shift]),
        P([{ type: "display.required", seq: 0, turnId: tid, provider: "google", html: "<b>h</b>" }, ...shift]),
      ];
    };
    for (const base of [B(), E(), F(), C()]) {
      for (const evs of [base, ...prefixed(base)]) {
        const ids = carried(evs);
        const r = fold(evs);
        for (const t of r.result.turns) expect({ turnId: t.turnId, threadId: t.threadId, carried: ids.has(t.threadId) }).toEqual({ turnId: t.turnId, threadId: t.threadId, carried: true });
      }
    }
  });

  it("(producers) on every replay golden, each terminal follows a turn.start or subagent.start with its turnId in the same invoke", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const TERMINALS = new Set(["turn.done", "turn.error", "turn.abort"]);
    const bad: string[] = [];
    let terminals = 0;
    for (const dir of readdirSync(corpus).sort()) {
      for (const fw of ["claude", "openai", "adk", "vercel"]) {
        const f = new URL(`${dir}/${fw}.agjson.json`, corpus);
        if (!existsSync(f)) continue;
        let opened = new Set<unknown>();
        let lastSeq = -1;
        for (const e of JSON.parse(readFileSync(f, "utf8")) as Array<Record<string, unknown>>) {
          const seq = e["seq"] as number;
          if (seq === 0 && lastSeq >= 0) opened = new Set(); // a 0-restart opens a new invoke
          lastSeq = seq;
          if (e["type"] === "turn.start" || e["type"] === "subagent.start") opened.add(e["turnId"]);
          if (TERMINALS.has(e["type"] as string)) {
            terminals++;
            if (!opened.has(e["turnId"])) bad.push(`${dir}/${fw}: ${String(e["type"])} for ${String(e["turnId"])} with no opener in its invoke`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
    expect(terminals).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.44 — MCP resource links (draft.5; §8.0 item 31). The synthetic legs live in
// the bound reference normalizer's own suite (COVERED-BY); the golden leg and the
// not-bound scan run here.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.44 — MCP resource links (draft.5; §8.0 item 31)", () => {
  const corpus = new URL("../corpus/", import.meta.url);
  const load = (dir: string, fw: string) => JSON.parse(readFileSync(new URL(`${dir}/${fw}.agjson.json`, corpus), "utf8")) as Array<Record<string, unknown>>;
  const findLinkParts = (v: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> => {
    if (Array.isArray(v)) for (const x of v) findLinkParts(x, out);
    else if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o["type"] === "resource_link") out.push(o);
      for (const x of Object.values(o)) findLinkParts(x, out);
    }
    return out;
  };
  it("(golden) resource-link-gemini38/adk: the linking call's tool.done holds exactly one resource-link whose members equal the native resource_link part's, and no provider-raw for that link", () => {
    // Selected by identity, never by seq: a golden regeneration that renumbers seq keeps this leg on the same event.
    const carriers = load("resource-link-gemini38", "adk").filter(
      (e) => e["type"] === "tool.done" && ((e["content"] as Array<Record<string, unknown>> | undefined) ?? []).some((b) => b["type"] === "resource-link"),
    );
    expect(carriers.map((e) => e["toolCallId"])).toEqual(["call_164587"]);
    const ev = carriers[0] as { type: string; content: Array<Record<string, unknown>> };
    expect(ev.type).toBe("tool.done");
    const links = ev.content.filter((b) => b["type"] === "resource-link");
    expect(links).toHaveLength(1);
    const parts = findLinkParts(JSON.parse(readFileSync(new URL("resource-link-gemini38/adk.native.json", corpus), "utf8")));
    expect(parts).toHaveLength(1);
    const { type: _t, ...members } = parts[0] as Record<string, unknown>;
    expect(links[0]).toEqual({ type: "resource-link", ...members });
    expect(ev.content.filter((b) => b["type"] === "provider-raw").some((b) => JSON.stringify(b).includes("resource_link"))).toBe(false);
  });
  it("(not-bound) no claude, openai or vercel golden emits a resource-link block into tool.done.content", () => {
    const bad: string[] = [];
    let files = 0;
    for (const dir of readdirSync(corpus).sort()) {
      for (const fw of ["claude", "openai", "vercel"]) {
        if (!existsSync(new URL(`${dir}/${fw}.agjson.json`, corpus))) continue;
        files++;
        for (const e of load(dir, fw)) {
          if (e["type"] !== "tool.done") continue;
          if (((e["content"] as Array<Record<string, unknown>> | undefined) ?? []).some((b) => b["type"] === "resource-link")) bad.push(`${dir}/${fw} seq ${String(e["seq"])}`);
        }
      }
    }
    expect(files).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.45 — Host records are side metadata (draft.5; §2.1 host records, §8.0
// items 19/21/29). The producer legs read the claude-agent-sdk goldens; the
// reducer leg folds every corpus golden with every host record removed.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.45 — host records are side metadata (draft.5; §2.1)", () => {
  const corpus = new URL("../corpus/", import.meta.url);
  const load = (dir: string, fw: string) => JSON.parse(readFileSync(new URL(`${dir}/${fw}.agjson.json`, corpus), "utf8")) as Array<Record<string, unknown>>;
  const native = (dir: string, fw: string) => JSON.parse(readFileSync(new URL(`${dir}/${fw}.native.json`, corpus), "utf8")) as unknown[];
  const KEYS = ["context_usage", "usage_report", "user_message_uuid", "user_message_uuids", "resume_reason", "aborted", "supersedes", "resourceLinks", "decisionReasonType", "decisionReasonCode", "decisionReason", "level", "preventContinuation", "toolUseId"];
  const findObjects = (v: unknown, pred: (o: Record<string, unknown>) => boolean, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> => {
    if (Array.isArray(v)) for (const x of v) findObjects(x, pred, out);
    else if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (pred(o)) out.push(o);
      for (const x of Object.values(o)) findObjects(x, pred, out);
    }
    return out;
  };
  it("(scan) on every claude-agent-sdk golden, no event's providerMetadata has a top-level member named a host-record key", () => {
    const bad: string[] = [];
    let files = 0;
    for (const dir of readdirSync(corpus).sort()) {
      if (!existsSync(new URL(`${dir}/claude.agjson.json`, corpus))) continue;
      files++;
      for (const e of load(dir, "claude")) {
        const pm = e["providerMetadata"];
        if (pm === null || typeof pm !== "object") continue;
        for (const k of KEYS) if (Object.prototype.hasOwnProperty.call(pm, k)) bad.push(`${dir} seq ${String(e["seq"])}: providerMetadata.${k}`);
      }
    }
    expect(files).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
  it("(resourceLinks) resource-link-sonnet5: the adopted tool.done carries _meta[\"anthropic/resourceLinks\"] deep-equal to the native tool_use_result.resourceLinks, and no providerMetadata member", () => {
    const nat = findObjects(native("resource-link-sonnet5", "claude"), (o) => Array.isArray(o["resourceLinks"]));
    expect(nat).toHaveLength(1);
    const dones = load("resource-link-sonnet5", "claude").filter((e) => e["type"] === "tool.done" && (e["_meta"] as Record<string, unknown> | undefined)?.["anthropic/resourceLinks"] !== undefined);
    expect(dones).toHaveLength(1);
    const done = dones[0] as Record<string, unknown>;
    expect((done["_meta"] as Record<string, unknown>)["anthropic/resourceLinks"]).toEqual(nat[0]?.["resourceLinks"]);
    expect(Object.keys((done["providerMetadata"] as Record<string, unknown> | undefined) ?? {})).not.toContain("resourceLinks");
  });
  it("(message-metadata) multi-result-sonnet5: each native user_message_uuid / user_message_uuids value appears verbatim in the folded AgMessage.metadata of that frame's message", () => {
    const evs = load("multi-result-sonnet5", "claude");
    const nativeUuids = new Set(findObjects(native("multi-result-sonnet5", "claude"), (o) => typeof o["user_message_uuid"] === "string").map((o) => o["user_message_uuid"] as string));
    expect(nativeUuids.size).toBeGreaterThan(1);
    const metas = evs.filter((e) => e["type"] === "message.metadata");
    expect(metas.length).toBe(nativeUuids.size);
    const folded = reduce(ingestAgEvents(evs as unknown as JsonValue[]));
    expect(folded.needsResync).toBe(false);
    for (const me of metas) {
      const msg = folded.result.messages.find((m) => m.id === me["messageId"]) as { metadata?: Record<string, unknown> } | undefined;
      const md = (me["metadata"] as Record<string, unknown>);
      expect(nativeUuids.has(md["user_message_uuid"] as string)).toBe(true);
      expect(md["user_message_uuids"]).toEqual([md["user_message_uuid"]]);
      expect(msg?.metadata?.["user_message_uuid"]).toBe(md["user_message_uuid"]);
      expect(msg?.metadata?.["user_message_uuids"]).toEqual(md["user_message_uuids"]);
    }
  });
  it("(claude-host-record) subagent-fg-sonnet5: the Agent tool.done carries _meta[\"anthropic/agentOutput\"] deep-equal to the native tool_use_result minus content and prompt, and no providerMetadata member agentOutput", () => {
    const nat = findObjects(native("subagent-fg-sonnet5", "claude"), (o) => typeof o["agentId"] === "string" && "usage" in o && "content" in o);
    expect(nat).toHaveLength(1);
    const { content: _c, prompt: _p, ...expected } = nat[0] as Record<string, unknown>;
    const dones = load("subagent-fg-sonnet5", "claude").filter((e) => e["type"] === "tool.done" && (e["_meta"] as Record<string, unknown> | undefined)?.["anthropic/agentOutput"] !== undefined);
    expect(dones).toHaveLength(1);
    expect((dones[0]?.["_meta"] as Record<string, unknown>)["anthropic/agentOutput"]).toEqual(expected);
    for (const e of load("subagent-fg-sonnet5", "claude")) expect(Object.keys((e["providerMetadata"] as Record<string, unknown> | undefined) ?? {})).not.toContain("agentOutput");
  });
  it("(reducer) on every corpus golden, a fold with every _meta member and every message.metadata event removed yields turns[*].usage and messages[*].usage deep-equal to the full fold", () => {
    let files = 0;
    for (const dir of readdirSync(corpus).sort()) {
      for (const f of readdirSync(new URL(`${dir}/`, corpus)).filter((x) => x.endsWith(".agjson.json")).sort()) {
        files++;
        const evs = JSON.parse(readFileSync(new URL(`${dir}/${f}`, corpus), "utf8")) as Array<Record<string, unknown>>;
        const full = reduce(ingestAgEvents(evs as unknown as JsonValue[]));
        const stripped = evs.filter((e) => e["type"] !== "message.metadata").map(({ _meta: _m, ...rest }, i) => ({ ...rest, seq: i }));
        const bare = reduce(ingestAgEvents(stripped as unknown as JsonValue[]));
        expect(bare.result.turns.map((t) => t.usage), `${dir}/${f} turns`).toEqual(full.result.turns.map((t) => t.usage));
        expect(bare.result.messages.map((m) => m.usage), `${dir}/${f} messages`).toEqual(full.result.messages.map((m) => m.usage));
      }
    }
    expect(files).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.46 — OpenAI handoff round release (draft.5; §8.0 item 14). The synthetic
// legs a–i live in the openai-agents suite (COVERED-BY); the golden leg runs here.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.46 — OpenAI handoff round release (draft.5; §8.0 item 14)", () => {
  it("(golden) handoff-parallel-gpt6sol: no resync, no turn.abort; the source turn closes success with usage on its turn.done and none on its message.end; the ignored transfer keeps a tool.start with no tool.done and one ext.openai.dropped-call before the source terminal", () => {
    const evs = JSON.parse(readFileSync(new URL("../corpus/handoff-parallel-gpt6sol/openai.agjson.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;
    expect(evs.some((e) => e["type"] === "turn.abort")).toBe(false);
    const folded = reduce(ingestAgEvents(evs as unknown as JsonValue[]));
    expect(folded.needsResync).toBe(false);
    const starts = evs.filter((e) => e["type"] === "tool.start");
    const dones = new Set(evs.filter((e) => e["type"] === "tool.done").map((e) => e["toolCallId"]));
    const dropped = starts.filter((e) => !dones.has(e["toolCallId"]));
    expect(dropped).toHaveLength(1);
    const call = dropped[0] as Record<string, unknown>;
    const sourceTurn = call["turnId"] as string;
    const carries = evs.filter((e) => e["type"] === "ext.openai.dropped-call");
    expect(carries).toHaveLength(1);
    expect(carries[0]?.["toolCallId"]).toBe(call["toolCallId"]);
    const terminal = evs.find((e) => e["type"] === "turn.done" && e["turnId"] === sourceTurn) as Record<string, unknown> | undefined;
    expect(terminal).toBeDefined();
    expect((terminal?.["outcome"] as { type?: string })?.type).toBe("success");
    expect(terminal?.["usage"]).toBeDefined();
    expect((carries[0]?.["seq"] as number) < (terminal?.["seq"] as number)).toBe(true);
    const end = evs.filter((e) => e["type"] === "message.end" && (e["seq"] as number) < (terminal?.["seq"] as number)).at(-1) as Record<string, unknown> | undefined;
    expect(end?.["usage"]).toBeUndefined();
    expect(folded.result.turns.find((t) => t.turnId === sourceTurn)?.outcome?.type).toBe("success");
    expect(folded.result.turns.every((t) => t.outcome?.type === "success")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.47 — Cross-invoke tool result and the Claude deferred pause (draft.5;
// §5.0 INV-XINV, §8.0 item 32). Reducer legs on both reducers; producer legs
// over the committed two-invoke goldens.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.47 — cross-invoke tool result and the Claude deferred pause (draft.5; §5.0 INV-XINV)", () => {
  const P = (evs: Array<Record<string, unknown>>) => evs.map((e) => AgEvent.parse(e));
  const both = (evs: AgEvent[]) => {
    const live = new Reducer();
    for (const e of evs) live.push(e);
    const batch = reduce(evs);
    expect(live.needsResync).toBe(batch.needsResync);
    expect(live.result()).toEqual(batch.result);
    return batch;
  };
  const corpus = new URL("../corpus/", import.meta.url);
  const load = (dir: string, fw: string) => JSON.parse(readFileSync(new URL(`${dir}/${fw}.agjson.json`, corpus), "utf8")) as Array<Record<string, unknown>>;
  const ask = { askId: "a1", kind: "approval", toolCallId: "x" };
  const pausedInvoke = (turnId: string) => P([
    { type: "turn.start", seq: 0, threadId: "T", turnId },
    { type: "message.start", seq: 1, id: `m_${turnId}`, role: "assistant", turnId, threadId: "T" },
    { type: "tool.start", seq: 2, toolCallId: "x", name: "lookup", turnId, messageId: `m_${turnId}` },
    { type: "message.end", seq: 3, id: `m_${turnId}` },
    { type: "hitl.ask", seq: 4, turnId, ...ask },
    { type: "turn.done", seq: 5, turnId, outcome: { type: "paused", asks: [ask] }, finishReason: "paused" },
  ]);
  const landingInvoke = (turnId: string, messageId: string) => P([
    { type: "turn.start", seq: 0, threadId: "T", turnId },
    { type: "tool.done", seq: 1, toolCallId: "x", turnId, messageId, content: [{ type: "text", text: "r" }], outcome: "ok" },
    { type: "turn.done", seq: 2, turnId, outcome: { type: "success" }, finishReason: "stop" },
  ]);
  const toolMsgs = (r: ReturnType<typeof reduce>, turnId: string) => r.result.messages.filter((m) => m.role === "tool" && m.turnId === turnId);
  const blocksFor = (r: ReturnType<typeof reduce>, id: string, type: string) => r.result.messages.flatMap((m) => (m.content as Array<Record<string, unknown>>).filter((b) => b["type"] === type && b["toolCallId"] === id).map((b) => ({ turnId: m.turnId })));

  it("(reducer) a paused invoke, then a 0-restart invoke landing tool.done{turnId, messageId:\"x:result\"}: no resync; the result in a role:\"tool\" message of the second turn; one tool-call and one tool-result for x in different turns", () => {
    const r = both([...pausedInvoke("t1"), ...landingInvoke("t2", "x:result")]);
    expect(r.needsResync).toBe(false);
    expect(toolMsgs(r, "t2").map((m) => m.id)).toEqual(["x:result"]);
    expect(blocksFor(r, "x", "tool-call")).toEqual([{ turnId: "t1" }]);
    expect(blocksFor(r, "x", "tool-result")).toEqual([{ turnId: "t2" }]);
  });
  it("(reducer-reuse) four invokes reusing x, each landing on messageId \"<turnId>:x:result\": no resync; two role:\"tool\" messages, each in its landing invoke's turn", () => {
    const r = both([...pausedInvoke("t1"), ...landingInvoke("t2", "t2:x:result"), ...pausedInvoke("t3"), ...landingInvoke("t4", "t4:x:result")]);
    expect(r.needsResync).toBe(false);
    expect(toolMsgs(r, "t2").map((m) => m.id)).toEqual(["t2:x:result"]);
    expect(toolMsgs(r, "t4").map((m) => m.id)).toEqual(["t4:x:result"]);
    expect(blocksFor(r, "x", "tool-result").map((b) => b.turnId).sort()).toEqual(["t2", "t4"]);
  });
  const pairAssertions = (first: Array<Record<string, unknown>>, second: Array<Record<string, unknown>>, label: string) => {
    const carried = new Set(first.filter((e) => e["type"] === "tool.start").map((e) => e["toolCallId"] as string));
    const results = second.filter((e) => e["type"] === "tool.done" && carried.has(e["toolCallId"] as string));
    expect(results.length, `${label}: carried results`).toBeGreaterThan(0);
    const firstTurns = new Set(first.filter((e) => e["type"] === "turn.start").map((e) => e["turnId"]));
    const firstMsgs = new Set(first.filter((e) => e["type"] === "message.start").map((e) => e["id"]));
    const secondTurnStarts = second.filter((e) => e["type"] === "turn.start").map((e) => e["turnId"]);
    for (const td of results) {
      expect(second.some((e) => e["type"] === "tool.start" && e["toolCallId"] === td["toolCallId"]), `${label}: no tool.start for the carried id`).toBe(false);
      expect(second.filter((e) => e["type"] === "tool.done" && e["toolCallId"] === td["toolCallId"]).length, `${label}: exactly one tool.done`).toBe(1);
      expect(td["more"]).not.toBe(true);
      expect(secondTurnStarts.includes(td["turnId"]) && !firstTurns.has(td["turnId"]), `${label}: turn ${String(td["turnId"])} is the resume's own`).toBe(true);
      expect(firstMsgs.has(td["messageId"]), `${label}: messageId reused`).toBe(false);
    }
    const one = reduce(ingestAgEvents(first as unknown as JsonValue[]));
    const two = reduce(ingestAgEvents(second as unknown as JsonValue[]));
    expect(one.needsResync, `${label}: first alone`).toBe(false);
    expect(two.needsResync, `${label}: second alone`).toBe(false);
    const pair = new Reducer();
    for (const e of ingestAgEvents([...first, ...second] as unknown as JsonValue[])) pair.push(e);
    expect(pair.needsResync, `${label}: pair`).toBe(false);
    const folded = pair.result();
    for (const td of results) {
      const id = td["toolCallId"] as string;
      const calls = folded.messages.flatMap((m) => (m.content as Array<Record<string, unknown>>).filter((b) => b["type"] === "tool-call" && b["toolCallId"] === id).map(() => m.turnId));
      const res = folded.messages.flatMap((m) => (m.content as Array<Record<string, unknown>>).filter((b) => b["type"] === "tool-result" && b["toolCallId"] === id).map(() => ({ turnId: m.turnId, role: m.role })));
      expect(calls, `${label}: one tool-call`).toHaveLength(1);
      expect(res, `${label}: one tool-result`).toHaveLength(1);
      expect(res[0]?.role).toBe("tool");
      expect(res[0]?.turnId).not.toBe(calls[0]);
    }
    const firstTurnIds = [...firstTurns];
    for (const tid of firstTurnIds) expect(folded.turns.find((t) => t.turnId === tid), `${label}: earlier turn record`).toEqual(one.result.turns.find((t) => t.turnId === tid));
    return { results, folded };
  };
  it("(pair-openai) approval-tool-gpt6sol → resume-approve and → resume-reject: the id and fold assertions hold", () => {
    const first = load("approval-tool-gpt6sol", "openai");
    for (const leg of ["approve", "reject"]) pairAssertions(first, load(`approval-tool-gpt6sol-resume-${leg}`, "openai"), `openai ${leg}`);
  });
  it("(pair-claude) defer-tool-sonnet5 → resume-allow and → resume-deny: the id and fold assertions hold; allowed lands outcome ok, denied lands outcome denied with neither errorText nor isError", () => {
    const first = load("defer-tool-sonnet5", "claude");
    const allow = pairAssertions(first, load("defer-tool-sonnet5-resume-allow", "claude"), "claude allow");
    expect(allow.results.every((td) => td["outcome"] === "ok")).toBe(true);
    const deny = pairAssertions(first, load("defer-tool-sonnet5-resume-deny", "claude"), "claude deny");
    for (const td of deny.results) {
      expect(td["outcome"]).toBe("denied");
      expect(td["errorText"]).toBeUndefined();
      expect(td["isError"]).toBeUndefined();
    }
  });
  it("(pair-claude-paused-close) defer-tool-sonnet5: the deferring invoke's last terminal is turn.done{paused, finishReason paused, no finishReasonRaw} with exactly one approval ask naming the deferred id, preceded by a hitl.ask with the same askId", () => {
    const first = load("defer-tool-sonnet5", "claude");
    const deferred = first.filter((e) => e["type"] === "tool.start").map((e) => e["toolCallId"] as string);
    const terminals = first.filter((e) => ["turn.done", "turn.error", "turn.abort"].includes(e["type"] as string));
    const last = terminals.at(-1) as Record<string, unknown>;
    expect(last["type"]).toBe("turn.done");
    expect((last["outcome"] as { type?: string })?.type).toBe("paused");
    expect(last["finishReason"]).toBe("paused");
    expect(last["finishReasonRaw"]).toBeUndefined();
    const asks = (last["outcome"] as { asks?: Array<Record<string, unknown>> })?.asks ?? [];
    expect(asks).toHaveLength(1);
    expect(asks[0]?.["kind"]).toBe("approval");
    expect(deferred).toContain(asks[0]?.["toolCallId"]);
    expect(first.some((e) => e["type"] === "hitl.ask" && e["askId"] === asks[0]?.["askId"])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.48 — Record events on unopened turns (draft.5; §5.0 INV-OWNER). Every
// vector runs on the incremental Reducer AND the batch reduce(), which must agree.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.48 — record events on unopened turns (draft.5; §5.0 INV-OWNER)", () => {
  const P = (evs: Array<Record<string, unknown>>) => evs.map((e) => AgEvent.parse(e));
  const fold = (evs: AgEvent[]) => {
    const batch = reduce(evs);
    const acc = new Reducer();
    for (const e of evs) acc.push(e);
    expect(acc.result()).toEqual(batch.result);
    expect(acc.needsResync).toBe(batch.needsResync);
    return batch;
  };
  const recs = (r: ReturnType<typeof reduce>, id: string) => r.result.turns.filter((t) => t.turnId === id);
  // The six record events, each with a marker the folded record must carry.
  const RECORD_EVENTS: Array<{ ev: (turnId: string, seq: number) => Record<string, unknown>; marker: string }> = [
    { ev: (turnId, seq) => ({ type: "source", seq, turnId, sourceId: "s-51", source: { url: "https://example.test/51", title: "src-51" } }), marker: "s-51" },
    { ev: (turnId, seq) => ({ type: "handoff", seq, turnId, kind: "transfer", toAgentName: "agent-51" }), marker: "agent-51" },
    { ev: (turnId, seq) => ({ type: "prompt.blocked", seq, turnId, reason: "prohibited" }), marker: "prohibited" },
    { ev: (turnId, seq) => ({ type: "guardrail.result", seq, turnId, target: "input", passed: true, guardrailName: "g-51" }), marker: "g-51" },
    { ev: (turnId, seq) => ({ type: "display.required", seq, turnId, provider: "google", html: "<b>dr-51</b>" }), marker: "dr-51" },
    { ev: (turnId, seq) => ({ type: "agent.capabilities", seq, turnId, capabilities: { extensions: ["urn:x:cap-51"] } }), marker: "cap-51" },
  ];
  const msg = (turnId: string, threadId: string) => ({ id: `m_${turnId}`, role: "assistant", turnId, threadId, content: [{ type: "text", text: "hi" }] });
  const DONE = (turnId: string, seq: number, extra: Record<string, unknown> = {}) => ({ type: "turn.done", seq, turnId, outcome: { type: "success" }, finishReason: "stop", ...extra });
  const carried = (evs: AgEvent[]) => {
    const out = new Set<unknown>();
    for (const e of evs as unknown as Array<Record<string, unknown>>) {
      if (e["threadId"] !== undefined) out.add(e["threadId"]);
      for (const m of (e["messages"] as Array<Record<string, unknown>> | undefined) ?? []) if (m["threadId"] !== undefined) out.add(m["threadId"]);
      for (const t of (e["turns"] as Array<Record<string, unknown>> | undefined) ?? []) if (t["threadId"] !== undefined) out.add(t["threadId"]);
    }
    return out;
  };

  it("(a) a record event naming a turn no event opened folds to no record for it, with no resync", () => {
    for (const { ev } of RECORD_EVENTS) {
      const r = fold(P([ev("X", 0)]));
      expect(r.needsResync).toBe(false);
      expect(recs(r, "X")).toHaveLength(0);
    }
  });
  it("(b) a record event, then its turn.start{X, T}, then turn.done X: exactly one record for X with threadId T, carrying the landing, outcome success", () => {
    for (const { ev, marker } of RECORD_EVENTS) {
      const r = fold(P([ev("X", 0), { type: "turn.start", seq: 1, threadId: "T", turnId: "X" }, DONE("X", 2)]));
      expect(r.needsResync).toBe(false);
      expect(recs(r, "X")).toHaveLength(1);
      expect(recs(r, "X")[0]?.threadId).toBe("T");
      expect(recs(r, "X")[0]?.outcome?.type).toBe("success");
      expect(JSON.stringify(recs(r, "X")[0]), marker).toContain(marker);
    }
  });
  it("(c) after a turns-less snapshot whose message names X with threadId T, a record event then turn.done X fold onto one record for X with threadId T", () => {
    for (const { ev, marker } of RECORD_EVENTS) {
      const r = fold(P([{ type: "messages.snapshot", seq: 0, messages: [msg("X", "T")] }, ev("X", 1), DONE("X", 2)]));
      expect(r.needsResync).toBe(false);
      expect(recs(r, "X")).toHaveLength(1);
      expect(recs(r, "X")[0]?.threadId).toBe("T");
      expect(JSON.stringify(recs(r, "X")[0]), marker).toContain(marker);
    }
  });
  it("(d) message.start{X, T} with no turn.start, then display.required X: one record for X with threadId T and one displayRequired entry", () => {
    const r = fold(P([
      { type: "message.start", seq: 0, id: "m1", role: "assistant", turnId: "X", threadId: "T" },
      { type: "display.required", seq: 1, turnId: "X", provider: "google", html: "<b>d</b>" },
    ]));
    expect(r.needsResync).toBe(false);
    expect(recs(r, "X")).toHaveLength(1);
    expect(recs(r, "X")[0]?.threadId).toBe("T");
    expect(recs(r, "X")[0]?.displayRequired).toHaveLength(1);
  });
  it("(e) a record event, then a turns-less snapshot with no messages, then a tool.done adopting into the held turn: resync, and no message is created", () => {
    for (const { ev } of RECORD_EVENTS) {
      const r = fold(P([ev("X", 0), { type: "messages.snapshot", seq: 1, messages: [] }, { type: "tool.done", seq: 2, turnId: "X", messageId: "M", toolCallId: "c1", content: [], outcome: "ok" }]));
      expect(r.needsResync).toBe(true);
      expect(r.result.messages.some((m) => m.id === "M")).toBe(false);
    }
  });
  it("(f) after turn.start and turn.done{usage U} of t1, a turnId-less turn.error parks and leaves t1's usage and outcome", () => {
    const U = { inputTokens: 3, outputTokens: 4, totalTokens: 7 };
    const r = fold(P([{ type: "turn.start", seq: 0, threadId: "T", turnId: "t1" }, DONE("t1", 1, { usage: U }), { type: "turn.error", seq: 2, message: "late" }]));
    expect(r.needsResync).toBe(true);
    expect(recs(r, "t1")).toHaveLength(1);
    expect(recs(r, "t1")[0]?.usage).toEqual(U);
    expect(recs(r, "t1")[0]?.outcome?.type).toBe("success");
  });
  it("(g) a handoff naming a nested turn before its subagent.start: the record takes the parent's thread and its parentTurnId once opened", () => {
    const r = fold(P([
      { type: "turn.start", seq: 0, threadId: "T", turnId: "p" },
      { type: "handoff", seq: 1, turnId: "c", kind: "transfer", toAgentName: "agent-g" },
      { type: "subagent.start", seq: 2, turnId: "c", parentTurnId: "p" },
      { type: "turn.done", seq: 3, turnId: "c", outcome: { type: "success" }, finishReason: "unknown" },
      { type: "subagent.done", seq: 4, turnId: "c", parentTurnId: "p" },
    ]));
    expect(r.needsResync).toBe(false);
    expect(recs(r, "c")).toHaveLength(1);
    expect(recs(r, "c")[0]?.parentTurnId).toBe("p");
    expect(recs(r, "c")[0]?.threadId).toBe("T");
    expect(JSON.stringify(recs(r, "c")[0])).toContain("agent-g");
  });
  it("(h) across every vector above and every corpus golden, each turn record's and each message's threadId is one an event carried for that turn", () => {
    const vectors: AgEvent[][] = [];
    for (const { ev } of RECORD_EVENTS) {
      vectors.push(P([ev("X", 0)]));
      vectors.push(P([ev("X", 0), { type: "turn.start", seq: 1, threadId: "T", turnId: "X" }, DONE("X", 2)]));
      vectors.push(P([{ type: "messages.snapshot", seq: 0, messages: [msg("X", "T")] }, ev("X", 1), DONE("X", 2)]));
    }
    const corpus = new URL("../corpus/", import.meta.url);
    for (const dir of readdirSync(corpus).sort()) {
      for (const f of readdirSync(new URL(`${dir}/`, corpus)).filter((x) => x.endsWith(".agjson.json")).sort()) {
        const raw = JSON.parse(readFileSync(new URL(`${dir}/${f}`, corpus), "utf8")) as Array<Record<string, unknown>>;
        vectors.push(ingestAgEvents(raw as unknown as JsonValue[]));
      }
    }
    expect(vectors.length).toBeGreaterThan(18);
    for (const evs of vectors) {
      const ids = carried(evs);
      const r = reduce(evs);
      for (const t of r.result.turns) expect({ turnId: t.turnId, threadId: t.threadId, carried: ids.has(t.threadId) }).toEqual({ turnId: t.turnId, threadId: t.threadId, carried: true });
      for (const m of r.result.messages) if (m.threadId !== undefined) expect({ id: m.id, threadId: m.threadId, carried: ids.has(m.threadId) }).toEqual({ id: m.id, threadId: m.threadId, carried: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.49 — Opener first for record events (draft.5; §5.0 INV-TURN, §8.0).
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.49 — opener first for record events (draft.5)", () => {
  it("(producers) on every replay golden, each of the six record events names, or resolves by messageId to, a turn opened earlier in its invoke; types with no corpus instance pass vacuously", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    const RECORDS = ["prompt.blocked", "guardrail.result", "agent.capabilities", "source", "handoff", "display.required"];
    const bad: string[] = [];
    const seen: Record<string, number> = Object.fromEntries(RECORDS.map((t) => [t, 0]));
    for (const dir of readdirSync(corpus).sort()) {
      for (const f of readdirSync(new URL(`${dir}/`, corpus)).filter((x) => x.endsWith(".agjson.json")).sort()) {
        let opened = new Set<unknown>();
        const msgTurn = new Map<unknown, unknown>();
        let lastSeq = -1;
        for (const e of JSON.parse(readFileSync(new URL(`${dir}/${f}`, corpus), "utf8")) as Array<Record<string, unknown>>) {
          const seq = e["seq"] as number;
          if (seq === 0 && lastSeq >= 0) { opened = new Set(); msgTurn.clear(); }
          lastSeq = seq;
          if (e["type"] === "turn.start" || e["type"] === "subagent.start") opened.add(e["turnId"]);
          if (e["type"] === "message.start") msgTurn.set(e["id"], e["turnId"]);
          if (RECORDS.includes(e["type"] as string)) {
            seen[e["type"] as string] = (seen[e["type"] as string] ?? 0) + 1;
            const tid = e["turnId"] ?? msgTurn.get(e["messageId"]);
            if (!opened.has(tid)) bad.push(`${dir}/${f}: ${String(e["type"])} seq ${String(seq)} names ${String(tid)} with no opener in its invoke`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
    expect(seen["handoff"]).toBeGreaterThan(0); // the corpus carries handoffs (openai); the other five are counted, vacuous when 0
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.50 — cache-inclusive inputTokens and per-object usage scope (draft.5; §4)
// fold + scope legs are facet-driven (createClaudeNormalizer); the consumer leg
// is reduce-level through the consumer ingest; the replay leg is COVERED-BY
// replay.test.ts assertUsageInclusion (pending, manifest row above).
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.50 — cache-inclusive inputTokens and per-object usage scope (draft.5; §4 input side, costUsd scope)", () => {
  const corpus = new URL("../corpus/", import.meta.url);
  const SESSION = "sess_s10_50";
  const assistantFrame = () => ({
    type: "assistant",
    message: {
      id: "msg_s10_50", type: "message", role: "assistant", model: "claude-test",
      content: [{ type: "text", text: "hi", citations: null }],
      stop_reason: "end_turn", stop_sequence: null, container: null, context_management: null, stop_details: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null },
    },
    parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-00000000a500", session_id: SESSION,
  });
  const resultFrame = (usage: Record<string, unknown>) => ({
    type: "result", subtype: "success", result: "done", stop_reason: "end_turn", is_error: false,
    duration_ms: 0, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0.0166347,
    usage: { ...usage, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: "unknown", iterations: [], server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard" },
    modelUsage: { "claude-sonnet-5": { inputTokens: 6, outputTokens: 275, cacheReadInputTokens: 13716, cacheCreationInputTokens: 4061, webSearchRequests: 0, costUSD: 0.0156577, contextWindow: 200000, maxOutputTokens: 8192 } },
    permission_denials: [], uuid: "00000000-0000-0000-0000-00000000a501", session_id: SESSION,
  });
  const drive = (frames: unknown[]): AgEvent[] => {
    const n = createClaudeNormalizer();
    return [...frames.flatMap((f) => n.push(f as JsonValue)), ...n.flush()];
  };
  const terminalUsage = (evs: AgEvent[]): Array<Record<string, unknown>> =>
    evs.filter((e) => e.type === "turn.done" || e.type === "turn.error").map((e) => ((e as { usage?: unknown }).usage ?? {}) as Record<string, unknown>);

  it("(fold) the spec's vector: usage {2, 6858, 187, 73} + cost 0.0166347 + modelUsage {6, 13716, 4061, 275, 0.0156577} → {7047, 6858, 187, 73, costUsd 0.0166347, costScope query}, cumulative not true, byModel {17783, 13716, 4061, 275, 0.0156577, cumulative true}", () => {
    const [usage] = terminalUsage(drive([assistantFrame(), resultFrame({ input_tokens: 2, output_tokens: 73, cache_read_input_tokens: 6858, cache_creation_input_tokens: 187 })]));
    expect(usage).toMatchObject({ inputTokens: 7047, cacheReadTokens: 6858, cacheWriteTokens: 187, outputTokens: 73, costUsd: 0.0166347, costScope: "query" });
    expect(usage?.["cumulative"]).not.toBe(true);
    expect((usage?.["byModel"] as Record<string, unknown>)["claude-sonnet-5"]).toMatchObject({ inputTokens: 17783, cacheReadTokens: 13716, cacheWriteTokens: 4061, outputTokens: 275, costUsd: 0.0156577, cumulative: true });
    expect(2 + 6858 + 187).toBe(7047);
    expect(6 + 13716 + 4061).toBe(17783);
  });

  it("(fold) the same frame with both cache counters absent folds with inputTokens 2 and no cache key", () => {
    const [usage] = terminalUsage(drive([assistantFrame(), resultFrame({ input_tokens: 2, output_tokens: 73 })]));
    expect(usage).toMatchObject({ inputTokens: 2, outputTokens: 73 });
    expect(usage !== undefined && "cacheReadTokens" in usage).toBe(false);
    expect(usage !== undefined && "cacheWriteTokens" in usage).toBe(false);
  });

  it("(scope) multi-result-sonnet5: two terminals with top-level outputTokens 59 and 59, costUsd non-decreasing, every byModel counter non-decreasing, the last byModel outputTokens == 59 + 59", () => {
    const natives = JSON.parse(readFileSync(new URL("multi-result-sonnet5/claude.native.json", corpus), "utf8")) as unknown[];
    const usages = terminalUsage(drive(natives)).filter((u) => Object.keys(u).length > 0);
    expect(usages).toHaveLength(2);
    const [a, b] = usages as [Record<string, unknown>, Record<string, unknown>];
    expect([a["outputTokens"], b["outputTokens"]]).toEqual([59, 59]);
    expect(b["costUsd"] as number).toBeGreaterThanOrEqual(a["costUsd"] as number);
    const ma = a["byModel"] as Record<string, Record<string, unknown>>;
    const mb = b["byModel"] as Record<string, Record<string, unknown>>;
    for (const model of Object.keys(ma)) {
      for (const k of ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "costUsd"]) {
        const x = ma[model]?.[k];
        const y = mb[model]?.[k];
        if (typeof x === "number" && typeof y === "number") expect(y, `${model}.${k}`).toBeGreaterThanOrEqual(x);
      }
    }
    expect(mb["claude-sonnet-5"]?.["outputTokens"]).toBe(59 + 59);
  });

  it("(consumer) a turn.done usage carrying costScope, a cumulative:true byModel entry and a totalTokensRaw beside its totalTokens survives ingestAgEvents + reduce() verbatim, and AgEvent.parse keeps both keys", () => {
    const usage = { inputTokens: 609, outputTokens: 281, reasoningTokens: 256, totalTokens: 890, totalTokensRaw: 634, costUsd: 0.0166347, costScope: "query", cumulative: false, byModel: { m: { inputTokens: 17783, outputTokens: 275, costUsd: 0.0156577, cumulative: true } } };
    const tail = S_TAIL(2);
    (tail[4] as Record<string, unknown>)["usage"] = usage;
    const r = reduce(ingestAgEvents([...S_HEAD, ...tail] as unknown as JsonValue[]));
    expect(r.needsResync).toBe(false);
    expect(r.result.turns[0]?.usage).toEqual(usage);
    const parsed = AgEvent.parse(tail[4]) as { usage?: Record<string, unknown> };
    expect(parsed.usage?.["costScope"]).toBe("query");
    expect(parsed.usage?.["totalTokensRaw"]).toBe(634);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.51 — persistable projection (draft.5; §13.3, §5.0 INV-FOLD carve-out).
// Reduce-level. The helper is core's; until it lands the first assertion is red
// by design (a named window), and tsc stays green through the namespace import.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.51 — persistable projection (draft.5; memory scopes draft.6): toPersistable omits every turn's displayRequired[] and every undeclared non-thread memory record, and nothing else", () => {
  type PersistOpts = { memoryScopes?: Array<"agent" | "user" | "skill"> };
  type Omitted = { scope: string; key?: string };
  const toPersistable = (coreNs as unknown as Record<string, unknown>)["toPersistable"] as ((r: AgReduceResult, o?: PersistOpts) => AgReduceResult) | undefined;
  const toPersistableWithReport = (coreNs as unknown as Record<string, unknown>)["toPersistableWithReport"] as ((r: AgReduceResult, o?: PersistOpts) => { result: AgReduceResult; omitted: Omitted[] }) | undefined;
  const P = (evs: Array<Record<string, unknown>>) => evs.map((e) => AgEvent.parse(e));
  const fold = () => reduce(P([
    { type: "turn.start", seq: 0, threadId: "th51", turnId: "t1" },
    { type: "display.required", seq: 1, turnId: "t1", provider: "google", html: "<p>x</p>" },
    { type: "source", seq: 2, turnId: "t1", sourceId: "s1", source: { url: "https://example.test/51" } },
    { type: "turn.done", seq: 3, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
  ])).result;

  it("(reducer) the projection's turn has no displayRequired key, keeps sources, equals the fold minus that key, and does not mutate the fold", () => {
    expect(typeof toPersistable, "core exports toPersistable").toBe("function");
    const F = fold();
    const Pr = toPersistable!(F);
    expect(Pr.turns[0] !== undefined && "displayRequired" in (Pr.turns[0] as object)).toBe(false);
    expect(Pr.turns[0]?.sources).toEqual(F.turns[0]?.sources);
    const expected = structuredClone(F) as AgReduceResult;
    delete (expected.turns[0] as Record<string, unknown>)["displayRequired"];
    expect(Pr).toEqual(expected);
    expect(F.turns[0]?.displayRequired).toEqual([{ provider: "google", html: "<p>x</p>" }]);
  });

  it("(reducer) a fold with no displayRequired projects to itself", () => {
    expect(typeof toPersistable).toBe("function");
    const F = reduce(P([
      { type: "turn.start", seq: 0, threadId: "th51", turnId: "t1" },
      { type: "turn.done", seq: 1, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
    ])).result;
    expect(toPersistable!(F)).toEqual(F);
  });

  it("(corpus) for every replay golden the projection equals the fold with displayRequired and every non-thread memory record omitted, and the report lists exactly those records (empty for every committed golden)", () => {
    expect(typeof toPersistable).toBe("function");
    const corpus = new URL("../corpus/", import.meta.url);
    let files = 0;
    for (const dir of readdirSync(corpus).sort()) {
      for (const f of readdirSync(new URL(`${dir}/`, corpus)).filter((x) => x.endsWith(".agjson.json")).sort()) {
        files++;
        const evs = JSON.parse(readFileSync(new URL(`${dir}/${f}`, corpus), "utf8")) as unknown as JsonValue[];
        const F = reduce(ingestAgEvents(evs)).result;
        const expected = structuredClone(F) as AgReduceResult;
        for (const t of expected.turns) delete (t as Record<string, unknown>)["displayRequired"];
        expected.memory = expected.memory.filter((m) => m.scope === "thread");
        const nonThread = F.memory.filter((m) => m.scope !== "thread").map(({ scope, key }) => (key === undefined ? { scope } : { scope, key }));
        expect(toPersistable!(F), `${dir}/${f}`).toEqual(expected);
        expect(toPersistableWithReport!(F).omitted, `${dir}/${f}: the report lists exactly the omitted records`).toEqual(nonThread);
        expect(nonThread, `${dir}/${f}: empty for every committed golden`).toEqual([]);
      }
    }
    expect(files).toBeGreaterThan(0);
  });

  // memory scopes (draft.6; §13.11, host obligation 7): the projection omits every memory record whose scope is
  // neither `thread` nor declared — absent = none — and the reporting form lists each omission by (scope, key).
  const memFold = () => reduce(P([
    { type: "turn.start", seq: 0, threadId: "th51", turnId: "t1" },
    { type: "display.required", seq: 1, turnId: "t1", provider: "google", html: "<p>x</p>" },
    { type: "memory.write", seq: 2, turnId: "t1", scope: "agent", key: "ka", value: 1 },
    { type: "memory.write", seq: 3, turnId: "t1", scope: "user", key: "ku", value: 2 },
    { type: "memory.write", seq: 4, turnId: "t1", scope: "skill", key: "ks", value: 3 },
    { type: "memory.write", seq: 5, turnId: "t1", scope: "thread", key: "kt", value: 4 },
    { type: "turn.done", seq: 6, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
  ])).result;
  const scopes = (r: AgReduceResult) => r.memory.map((m) => m.scope);
  it("(reducer) called with no memoryScopes — which declares none — the projection keeps exactly the thread record and the report lists agent, user and skill by (scope, key) in the fold's order", () => {
    expect(typeof toPersistableWithReport, "core exports toPersistableWithReport").toBe("function");
    const F = memFold();
    expect(scopes(F)).toEqual(["agent", "user", "skill", "thread"]);
    const before = structuredClone(F);
    for (const opts of [undefined, { memoryScopes: [] as Array<"agent" | "user" | "skill"> }]) {
      const { result, omitted } = toPersistableWithReport!(F, opts);
      expect(scopes(result)).toEqual(["thread"]);
      expect(result.turns[0] !== undefined && "displayRequired" in (result.turns[0] as object)).toBe(false);
      expect(omitted).toEqual([{ scope: "agent", key: "ka" }, { scope: "user", key: "ku" }, { scope: "skill", key: "ks" }]);
      expect(toPersistable!(F, opts)).toEqual(result); // the plain form is the same projection without the report
    }
    expect(F).toEqual(before); // never mutated
  });
  it("(reducer) memoryScopes [\"user\"] keeps the user and thread records in the fold's order and reports the other two", () => {
    const F = memFold();
    const { result, omitted } = toPersistableWithReport!(F, { memoryScopes: ["user"] });
    expect(scopes(result)).toEqual(["user", "thread"]);
    expect(omitted).toEqual([{ scope: "agent", key: "ka" }, { scope: "skill", key: "ks" }]);
    expect(toPersistable!(F, { memoryScopes: ["user"] })).toEqual(result);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.52–53 — remedy-shaped vendor data (draft.5; §13.10, §8.0 item): no provider
// credit token on the wire; reported-fix carriage and durability, legs (a)–(g).
// Facet-driven (claude, openai, adk) with reduce-level round-trips; minimal
// shapes of each SDK's stream, fed at the JSON boundary.
// ─────────────────────────────────────────────────────────────────────────────

const R_USAGE0 = { input_tokens: 0, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null };
const rAssistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}, msgExtra: Record<string, unknown> = {}) => ({
  type: "assistant",
  message: { id, type: "message", role: "assistant", model: "claude-test", content, stop_reason: "end_turn", stop_sequence: null, container: null, context_management: null, stop_details: null, usage: R_USAGE0, ...msgExtra },
  parent_tool_use_id: null, uuid: `00000000-0000-0000-0000-00000000${id.slice(-4)}`, session_id: "sess_s10_remedy", ...extra,
});
const rResult = (stop_reason: string) => ({
  type: "result", subtype: "success", result: "done", stop_reason, is_error: false, duration_ms: 0, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: "unknown", iterations: [], server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard" },
  modelUsage: {}, permission_denials: [], uuid: "00000000-0000-0000-0000-0000000000r9", session_id: "sess_s10_remedy",
});
const rToolUse = (toolId: string, input: Record<string, unknown> = {}) => rAssistant("msg_r_use_" + toolId.slice(-2), [{ type: "tool_use", id: toolId, name: "mcp__t__echo", input }], {}, { stop_reason: "tool_use" });
const rToolResult = (toolId: string, extra: Record<string, unknown>) => ({
  type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "Blocked by hook", is_error: true }] },
  parent_tool_use_id: null, uuid: "00000000-0000-0000-0000-0000000000r2", session_id: "sess_s10_remedy", ...extra,
});
const rDrive = (frames: unknown[]): AgEvent[] => {
  const n = createClaudeNormalizer();
  return [...frames.flatMap((f) => n.push(f as JsonValue)), ...n.flush()];
};
const rFold = (evs: AgEvent[]): Reducer => { const r = new Reducer(); for (const e of evs) r.push(e); return r; };
const rToolDone = (evs: AgEvent[]) => evs.find((e) => e.type === "tool.done") as unknown as Record<string, unknown> | undefined;
const rRoundTrip = (r: Reducer): void => {
  const res = r.result();
  const snap = AgEvent.parse({ type: "messages.snapshot", seq: 0, messages: res.messages, turns: res.turns });
  const again = new Reducer(); again.push(snap);
  expect(r.needsResync).toBe(false); expect(again.needsResync).toBe(false);
  expect(again.result()).toEqual(res);
};

describe("§10.52 — no provider credit token (draft.5; §13.10)", () => {
  const TOKEN = "TOKEN-SENTINEL";
  it("(claude) the token appears nowhere in the events or the fold at any depth; stop_details is carried less every token with recommended_model verbatim; the tool_result_meta remedy is carried less the key; a tool call's user-authored key of the same name survives", () => {
    const STOP = { type: "refusal", category: "bio", explanation: "p", recommended_model: "m", fallback_credit_token: TOKEN, deep: { fallback_credit_token: TOKEN } };
    const evs = rDrive([
      rAssistant("msg_r_stop", [{ type: "text", text: "declined", citations: null }], {}, { stop_details: STOP, stop_reason: "refusal" }),
      rResult("refusal"),
      rToolUse("toolu_rm"),
      rToolResult("toolu_rm", { tool_result_meta: [{ id: "toolu_rm", remedy: { kind: "zz", fallback_credit_token: TOKEN } }] }),
      rToolUse("toolu_rc", { fallback_credit_token: "user-data" }),
    ]);
    expect(JSON.stringify(evs)).not.toContain(TOKEN);
    const r = rFold(evs); expect(r.needsResync).toBe(false);
    const res = r.result();
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(res.messages.find((m) => m.id === "msg_r_stop")?.messageMetadata).toEqual({ stop_details: { type: "refusal", category: "bio", explanation: "p", recommended_model: "m", deep: {} } });
    const block = res.messages.flatMap((m) => m.content as Array<Record<string, unknown>>).find((b) => b["type"] === "tool-result" && b["toolCallId"] === "toolu_rm");
    expect((block?.["_meta"] as Record<string, unknown> | undefined)?.["anthropic/toolResultMeta"]).toEqual({ id: "toolu_rm", remedy: { kind: "zz" } });
    const call = res.messages.flatMap((m) => m.content as Array<Record<string, unknown>>).find((b) => b["type"] === "tool-call" && b["toolCallId"] === "toolu_rc");
    expect(call?.["input"]).toEqual({ fallback_credit_token: "user-data" });
  });
  it("(vercel) a finish step's providerMetadata.anthropic.stopDetails is carried on the step's message.metadata less every credit token at any depth; recommendedModel verbatim", () => {
    const n = createVercelNormalizer();
    const STOP = { type: "refusal", category: "bio", explanation: "p", recommendedModel: "m", fallback_credit_token: TOKEN, fallbackCreditToken: TOKEN, deep: { fallback_credit_token: TOKEN } };
    const parts: JsonValue[] = [
      { type: "start", messageId: "msg_v_stop" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", text: "declined" }, { type: "text-end", id: "t1" },
      { type: "finish-step", finishReason: "content-filter", rawFinishReason: "refusal", usage: { inputTokens: 1, outputTokens: 1 }, response: { id: "resp_v", modelId: "claude-test" }, providerMetadata: { anthropic: { stopDetails: STOP } } },
      { type: "finish", finishReason: "content-filter", totalUsage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const evs = [...parts.flatMap((p) => n.push(p)), ...n.flush()];
    expect(JSON.stringify(evs)).not.toContain(TOKEN);
    const r = rFold(evs); expect(r.needsResync).toBe(false);
    const res = r.result(); expect(JSON.stringify(res)).not.toContain(TOKEN);
    const meta = res.messages.map((m) => (m as { metadata?: Record<string, unknown> }).metadata).find((md) => md !== undefined && "stopDetails" in md);
    expect(meta?.["stopDetails"]).toEqual({ type: "refusal", category: "bio", explanation: "p", recommendedModel: "m", deep: {} });
  });
});

describe("§10.53 — reported-fix carriage and durability (draft.5; §8.0 item, §13.10)", () => {
  const ENTRY = { id: "toolu_m", remedy: { kind: "zz_future_kind" } };
  const legA = () => rDrive([rToolUse("toolu_m"), rToolResult("toolu_m", { tool_result_meta: [ENTRY], tool_use_result: { _meta: { ui: { resourceUri: "ui://x" }, "anthropic/toolResultMeta": { remedy: "SPOOFED" } } } })]);
  it("(a) claude: the tool_result_meta entry rides tool.done._meta merged beside the MCP sibling, the tool-authored reserved key dropped, nothing under providerMetadata; folds onto the block", () => {
    const evs = legA();
    expect(evs.filter((e) => e.type === "tool.done")).toHaveLength(1);
    const td = rToolDone(evs);
    expect(td?.["_meta"]).toEqual({ ui: { resourceUri: "ui://x" }, "anthropic/toolResultMeta": ENTRY });
    expect(JSON.stringify(evs)).not.toContain("SPOOFED");
    expect((td?.["providerMetadata"] as Record<string, unknown> | undefined)?.["anthropic/toolResultMeta"]).toBeUndefined();
    const r = rFold(evs); expect(r.needsResync).toBe(false);
    const block = r.result().messages.flatMap((m) => m.content as Array<Record<string, unknown>>).find((b) => b["type"] === "tool-result" && b["toolCallId"] === "toolu_m");
    expect(block?.["_meta"]).toEqual({ ui: { resourceUri: "ui://x" }, "anthropic/toolResultMeta": ENTRY });
  });
  const BAG = { api_error: "provider_credentials", api_error_params: { provider: "bedrock", remedy: "refresh_command" }, api_error_code: "credentials_expired", error_details: "d", advisor_model: "claude-opus", attribution_agent: "agent-x" };
  const legB = (content: unknown[]) => rDrive([rAssistant("msg_r_bag", content, { error: "rate_limit", is_api_error_message: true, ...BAG }, { stop_reason: "stop_sequence" })]);
  it("(b) claude: the six host-only wrapper keys fold by their wire names onto the first block's _meta on a text-first frame, else onto the message via message.metadata; none under providerMetadata", () => {
    const text = legB([{ type: "text", text: "API Error", citations: null }]);
    const first = text.find((e) => e.type === "text.start") as unknown as Record<string, unknown> | undefined;
    expect(first?.["_meta"]).toEqual(BAG);
    for (const e of text) for (const k of Object.keys(BAG)) expect(Object.keys((e as unknown as { providerMetadata?: Record<string, unknown> }).providerMetadata ?? {})).not.toContain(k);
    for (const content of [[{ type: "tool_use", id: "toolu_bag", name: "t", input: {} }], []]) {
      const evs = legB(content);
      const types = evs.map((e) => e.type);
      const mm = types.indexOf("message.metadata");
      expect(mm, JSON.stringify(content)).toBeGreaterThan(-1);
      expect(mm).toBeLessThan(types.indexOf("message.end"));
      const r = rFold(evs); expect(r.needsResync).toBe(false);
      expect((r.result().messages.find((m) => m.id === "msg_r_bag") as { metadata?: unknown } | undefined)?.metadata).toEqual(BAG);
    }
  });
  const S = { type: "refusal", category: "cyber", explanation: "This request was declined." };
  const legC = () => rDrive([rAssistant("msg_r_sd", [{ type: "text", text: "no", citations: null }], {}, { stop_details: S, stop_reason: "refusal" }), rResult("refusal")]);
  it("(c) claude: a complete frame's non-null stop_details closes with turn.done{messageId, messageMetadata:{stop_details}} naming that message, and the folded messageMetadata deep-equals it", () => {
    const evs = legC();
    expect(evs.find((e) => e.type === "turn.done")).toMatchObject({ messageId: "msg_r_sd", messageMetadata: { stop_details: S } });
    const r = rFold(evs); expect(r.needsResync).toBe(false);
    expect(r.result().messages.find((m) => m.id === "msg_r_sd")?.messageMetadata).toEqual({ stop_details: S });
  });
  const MIS = { error_type: "potentially_unintended_destructive_activity", detailed_explanation: "x", steer: { message: "y" }, future_key: { nested: true } };
  const raw = (event: JsonValue): JsonValue => ({ type: "raw_model_stream_event", data: { type: "model", event } });
  const legD = (mis: JsonValue | undefined): AgEvent[] => {
    const n = createOpenaiNormalizer();
    const error: { [k: string]: JsonValue } = { message: "Misalignment policy violation", code: "misalignment_policy_violation" };
    if (mis !== undefined) error["misalignment"] = mis;
    const frames: JsonValue[] = [raw({ type: "response.created", response: { id: "resp_r_mis" } }), raw({ type: "response.output_text.delta", item_id: "msg_resp_r_mis", delta: "Deleting…" }), raw({ type: "response.failed", response: { id: "resp_r_mis", error } })];
    return [...frames.flatMap((f) => n.push(f)), ...n.flush()];
  };
  it("(d) openai: a response error carrying misalignment yields one adapter notice before the turn.error (text = detailed_explanation, block _meta deep-equals the object); with none, no notice", () => {
    const evs = legD(MIS);
    const types = evs.map((e) => e.type);
    const errIdx = types.indexOf("turn.error");
    expect(types).not.toContain("ext.openai.misalignment");
    expect(types.slice(errIdx - 5, errIdx + 1)).toEqual(["message.start", "text.start", "text.delta", "text.end", "message.end", "turn.error"]);
    expect(evs[errIdx - 5]).toMatchObject({ type: "message.start", role: "notice", noticeSource: "adapter" });
    expect(evs[errIdx - 4]).toMatchObject({ type: "text.start", _meta: { "openai/misalignment": MIS } });
    const r = rFold(evs); expect(r.needsResync).toBe(false);
    const notice = r.result().messages.find((m) => m.role === "notice");
    expect(notice?.content).toEqual([expect.objectContaining({ type: "text", text: "x", _meta: { "openai/misalignment": MIS } })]);
    expect(legD(undefined).some((e) => e.type === "message.start" && (e as unknown as { role?: string }).role === "notice")).toBe(false);
  });
  it("(e) adk: COVERED-BY §10.25(fold)+(answer-id); thin re-assertion on plain-credential: one hitl.ask{kind:auth} per pending request in the paused asks[], no turn.error", () => {
    const natives = JSON.parse(readFileSync(new URL("../fixtures/adk-pause/plain-credential.native.json", import.meta.url), "utf8")) as JsonValue[];
    const n = createAdkNormalizer(); const evs: AgEvent[] = [];
    for (const f of natives) evs.push(...n.push(f as unknown as AdkEvent));
    evs.push(...n.flush());
    const asks = evs.filter((e) => e.type === "hitl.ask") as unknown as Array<{ kind: string; askId: string }>;
    expect(asks.length).toBeGreaterThan(0);
    for (const a of asks) expect(a.kind).toBe("auth");
    expect(evs.some((e) => e.type === "turn.error")).toBe(false);
    const done = evs.filter((e) => e.type === "turn.done") as unknown as Array<{ outcome: { type: string; asks?: Array<{ askId: string }> } }>;
    expect(done).toHaveLength(1);
    expect((done[0]?.outcome.asks ?? []).map((a) => a.askId).sort()).toEqual(asks.map((a) => a.askId).sort());
  });
  it("(f) claude: a tool result whose structuredContent and own _meta carry a remedy-shaped object with a URL, with no CLI entry, yields no reserved-prefix key and that URL in no host-only carrier", () => {
    const REM = { remedy: { kind: "mcp_needs_auth", url: "https://evil.example" } };
    const evs = rDrive([rToolUse("toolu_f"), rToolResult("toolu_f", { tool_use_result: { structuredContent: REM, _meta: { ...REM, "vendor/keep": 1 } } })]);
    const td = rToolDone(evs);
    for (const k of Object.keys((td?.["_meta"] as Record<string, unknown> | undefined) ?? {})) expect(k.startsWith("anthropic/"), k).toBe(false);
    // harness carriers only: reserved-prefix _meta keys, message.metadata, ext.* events — the tool's own _meta rides as tool content
    const harness = evs.flatMap((e) => {
      const m = (e as unknown as { _meta?: Record<string, unknown> })._meta ?? {};
      const reserved = Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith("anthropic/")));
      return [JSON.stringify({ reserved, md: e.type === "message.metadata" ? (e as unknown as { metadata?: unknown }).metadata : undefined, ext: e.type.startsWith("ext.") ? e : undefined })];
    });
    for (const h of harness) expect(h).not.toContain("evil.example");
    expect(JSON.stringify((td?.["_meta"] as Record<string, unknown> | undefined)?.["remedy"])).toContain("evil.example"); // tool-authored bytes, carried verbatim on the tool.done
  });
  it("(g) for each of (a)–(d), a fresh reducer fed a messages.snapshot built from the first fold's result yields a structurally equal result with no resync", () => {
    for (const evs of [legA(), legB([{ type: "text", text: "API Error", citations: null }]), legC(), legD(MIS)]) rRoundTrip(rFold(evs));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.54 — error-outcome retriable (draft.5; §4 AgOutcome, §5 turn.error row)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.54 — error-outcome retriable (draft.5; §4 AgOutcome, §5 turn.error row)", () => {
  const both = (evs: Record<string, unknown>[]) => {
    const parsed = evs.map((e) => AgEvent.parse(e));
    const live = new Reducer();
    for (const e of parsed) live.push(e);
    const batch = reduce(parsed);
    expect(live.needsResync).toBe(batch.needsResync);
    expect(live.result()).toEqual(batch.result);
    return batch;
  };
  const start = { type: "turn.start", seq: 0, threadId: "th", turnId: "t" };
  it("(reducer) turn.error{retriable:false} folds outcome {type:error, message, code, retriable:false}; without retriable the outcome has no such key; a non-terminal error{retriable:true} before it never folds", () => {
    const r1 = both([start, { type: "turn.error", seq: 1, turnId: "t", message: "m", code: "c", retriable: false }]);
    expect(r1.needsResync).toBe(false);
    expect(r1.result.turns[0]!.outcome).toEqual({ type: "error", message: "m", code: "c", retriable: false });
    const r2 = both([start, { type: "turn.error", seq: 1, turnId: "t", message: "m", code: "c" }]);
    expect(r2.result.turns[0]!.outcome).toEqual({ type: "error", message: "m", code: "c" });
    expect("retriable" in (r2.result.turns[0]!.outcome as Record<string, unknown>)).toBe(false);
    const r3 = both([start, { type: "error", seq: 1, turnId: "t", message: "transient", retriable: true }, { type: "turn.error", seq: 2, turnId: "t", message: "m", code: "c", retriable: false }]);
    expect(r3.needsResync).toBe(false);
    expect((r3.result.turns[0]!.outcome as Record<string, unknown>)["retriable"]).toBe(false);
  });
  it("(claude) the two committed Claude API-error goldens each fold exactly one errored turn with outcome.retriable false", () => {
    const corpus = new URL("../corpus/", import.meta.url);
    for (const d of ["api-error-auth", "defer-tool-sonnet5-resume-unavailable"]) {
      const ev = JSON.parse(readFileSync(new URL(`${d}/claude.agjson.json`, corpus), "utf8")) as Array<Record<string, unknown>>;
      const r = reduce(ingestAgEvents(ev as unknown as JsonValue[]));
      const errored = r.result.turns.filter((t) => t.outcome?.type === "error");
      expect(errored, d).toHaveLength(1);
      expect((errored[0]!.outcome as Record<string, unknown>)["retriable"], d).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.55 — host-supplied partition root (draft.5; §8.0 Partition root, host obligation 6)
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.55 — host-supplied partition root (draft.5; §8.0 Partition root)", () => {
  const corpus = new URL("../corpus/", import.meta.url);
  const FACETS = [
    { fw: "claude", make: (t: string) => createClaudeNormalizer({ invokeId: "claude", threadId: t }) },
    { fw: "openai", make: (t: string) => createOpenaiNormalizer({ invokeId: "openai", threadId: t }) },
    { fw: "adk", make: (t: string, hostCompleted: boolean) => createAdkNormalizer({ invokeId: "adk", threadId: t, ...(hostCompleted ? { hostCompletion: true } : {}) }) },
    { fw: "vercel", make: (t: string) => createVercelNormalizer({ invokeId: "vercel", threadId: t }) },
  ] as const;
  const goldensOf = (fw: string) => readdirSync(corpus).sort().filter((d) => existsSync(new URL(`${d}/${fw}.native.json`, corpus)) && existsSync(new URL(`${d}/${fw}.agjson.json`, corpus)));
  for (const f of FACETS) {
    it(`(${f.fw}) constructed with threadId T: every threadId-bearing event carries T, no turnId/parentTurnId is T, reduce() roots everything at T; without the option the output equals the golden`, async () => {
      const dirs = goldensOf(f.fw);
      expect(dirs.length, `${f.fw}: goldens`).toBeGreaterThan(0);
      for (const d of dirs) {
        const T = `th_host_${d}`;
        const recorded = JSON.parse(readFileSync(new URL(`${d}/${f.fw}.native.json`, corpus), "utf8")) as JsonValue[];
        const { native, hostCompleted } = splitHostCompleteMarker(recorded);
        const n = f.make(T, hostCompleted);
        const out: AgEvent[] = [];
        for (const ev of native) out.push(...n.push(ev));
        if (hostCompleted && f.fw === "adk") out.push(...n.push({ type: ADK_HOST_COMPLETE_TYPE } as unknown as JsonValue));
        out.push(...n.flush());
        const roots = new Set(out.flatMap((e) => (typeof (e as { threadId?: unknown }).threadId === "string" ? [(e as { threadId: string }).threadId] : [])));
        expect([...roots], `${d}/${f.fw}: threadId set`).toEqual([T]);
        expect(out.some((e) => (e as { turnId?: unknown }).turnId === T || (e as { parentTurnId?: unknown }).parentTurnId === T), `${d}/${f.fw}: T in an id slot`).toBe(false);
        const r = reduce(out);
        expect(r.needsResync, `${d}/${f.fw}: resync`).toBe(false);
        expect(r.result.turns.every((t) => t.threadId === T), `${d}/${f.fw}: turns rooted`).toBe(true);
        expect(r.result.messages.every((m) => m.threadId === T), `${d}/${f.fw}: messages rooted`).toBe(true);
        expect(r.result.artifacts.every((a) => a.threadId === T), `${d}/${f.fw}: artifacts rooted`).toBe(true);
        const golden = JSON.parse(readFileSync(new URL(`${d}/${f.fw}.agjson.json`, corpus), "utf8")) as JsonValue[];
        const absent = await replayNatives(recorded, f.fw as "claude" | "openai" | "adk" | "vercel");
        expect(absent.agjson, `${d}/${f.fw}: absent leg equals the golden`).toEqual(golden);
      }
    });
  }
});

describe("§10.56 — memory record metadata (draft.8): memory.write._meta lands on the record — value replaces the record whole (_meta included), patch replaces _meta only when carried; an undeclared top-level member never reaches the record; incremental == batch; the projection and the stored reader keep _meta", () => {
  const P = (evs: Array<Record<string, unknown>>) => evs.map((e) => AgEvent.parse(e));
  const S56 = [
    { type: "turn.start", seq: 0, threadId: "th56", turnId: "t1" },
    { type: "memory.write", seq: 1, turnId: "t1", scope: "thread", key: "k", value: { a: 1 }, _meta: { provenance: { source: "user" } }, zzTop: 1 },
    { type: "memory.write", seq: 2, turnId: "t1", scope: "thread", key: "k", patch: [{ op: "replace", path: "/a", value: 2 }] },
    { type: "memory.write", seq: 3, turnId: "t1", scope: "thread", key: "k", patch: [{ op: "replace", path: "/a", value: 3 }], _meta: { x: 1 } },
    { type: "memory.write", seq: 4, turnId: "t1", scope: "thread", key: "k", value: { a: 4 } },
    { type: "turn.done", seq: 5, turnId: "t1", outcome: { type: "success" }, finishReason: "stop" },
  ];
  const foldTo = (n: number) => reduce(ingestAgEvents(S56.slice(0, n + 1) as unknown as JsonValue[]));
  it("after seq 3 exactly one record {scope,key,value:{a:3},turnId,_meta:{x:1}}: zzTop absent, the seq-1 _meta kept through the seq-2 patch and replaced whole by seq 3", () => {
    const r = foldTo(3);
    expect(r.needsResync).toBe(false);
    expect(r.result.memory).toHaveLength(1);
    expect(r.result.memory[0]).toEqual({ scope: "thread", key: "k", value: { a: 3 }, turnId: "t1", _meta: { x: 1 } });
    const r2 = foldTo(2);
    expect((r2.result.memory[0] as unknown as Record<string, unknown>)["_meta"]).toEqual({ provenance: { source: "user" } });
  });
  it("after seq 4 the record carries no _meta (value replaced the record whole); incremental == batch; toPersistable keeps _meta and readStoredAgMemoryRecords reads it back with no report", () => {
    const r = foldTo(4);
    expect(r.result.memory[0]).toEqual({ scope: "thread", key: "k", value: { a: 4 }, turnId: "t1" });
    const live = new Reducer(); for (const ev of ingestAgEvents(S56.slice(0, 4) as unknown as JsonValue[])) live.push(ev);
    expect(live.result()).toEqual(foldTo(3).result);
    const F = foldTo(3).result;
    const persisted = (coreNs as unknown as Record<string, unknown>)["toPersistable"] as ((r: AgReduceResult) => AgReduceResult);
    expect((persisted(F).memory[0] as unknown as Record<string, unknown>)["_meta"]).toEqual({ x: 1 });
    const read = readStoredAgMemoryRecords(structuredClone(F.memory) as unknown as readonly unknown[]);
    expect(read.reports).toEqual([]);
    expect((read.value[0] as unknown as Record<string, unknown>)["_meta"]).toEqual({ x: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.57 — ADK prompt block → prompt.blocked (rc.1; §8.0 item 34). The
// errorCode shape @google/adk 2.1.0's createLlmResponse builds for a blocked
// prompt, fed through the reference ADK normalizer as non-streaming natives of
// one invocation. Every vector checks producer-strict AgEvent validity.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.57 — ADK prompt block → prompt.blocked (rc.1): one record per prompt-block event of an open turn, before the turn's terminal", () => {
  const inv = { invocationId: "inv_57" };
  const TERMINAL = new Set(["turn.done", "turn.error", "turn.abort"]);
  const drive = (natives: JsonValue[], hostCompletion = false): AgEvent[] => {
    const n = createAdkNormalizer(hostCompletion ? { hostCompletion: true } : {});
    const out = [...natives.flatMap((e) => n.push(e)), ...n.flush()];
    for (const ev of out) expect(AgEvent.safeParse(ev).success, JSON.stringify(ev)).toBe(true);
    return out;
  };
  const blocks = (out: AgEvent[]) => out.filter((e) => e.type === "prompt.blocked") as unknown as Array<Record<string, unknown>>;
  const terminals = (out: AgEvent[]) => out.filter((e) => TERMINAL.has(e.type)) as unknown as Array<Record<string, unknown>>;
  const seq = (e: unknown) => (e as { seq: number }).seq;
  const HOST_COMPLETE = { type: ADK_HOST_COMPLETE_TYPE } as unknown as JsonValue;
  const HOST_ERROR = { type: ADK_HOST_ERROR_TYPE, code: "Error", message: "the node failed" } as unknown as JsonValue;
  // reduce() over a vector that yields a record lands, on each turn a record names, AgTurnRecord.promptBlocked
  // equal to the last record emitted into that turn (every record the normalizer emits names its turn).
  const foldsLast = (out: AgEvent[]) => {
    const r = reduce(out);
    const lastByTurn = new Map<string, Record<string, unknown>>();
    for (const rec of blocks(out)) {
      expect(typeof rec["turnId"], JSON.stringify(rec)).toBe("string");
      lastByTurn.set(rec["turnId"] as string, rec);
    }
    expect(lastByTurn.size).toBeGreaterThan(0);
    for (const [turnId, last] of lastByTurn) {
      const turn = r.result.turns.find((t) => t.turnId === turnId) as unknown as { promptBlocked?: Record<string, unknown> } | undefined;
      expect(turn?.promptBlocked, turnId).toMatchObject({ reason: last["reason"], ...(last["reasonRaw"] !== undefined ? { reasonRaw: last["reasonRaw"] } : {}) });
    }
    return r;
  };
  // The reference's bare close (item 57, binding the reference only): a {errorCode, usageMetadata} event with no
  // errorMessage, finishReason, content parts, branch or node info, arriving with no ask pending and before any
  // invocation error, closes its turn turn.done{success} from push() on that event, after its record.
  const bareClose = (raw: string, finishReason: string, finishReasonRaw?: string) => {
    const n = createAdkNormalizer({});
    const pushed = n.push({ ...inv, errorCode: raw, usageMetadata: { promptTokenCount: 7, totalTokenCount: 7 } } as unknown as JsonValue);
    const flushed = n.flush();
    for (const ev of [...pushed, ...flushed]) expect(AgEvent.safeParse(ev).success, JSON.stringify(ev)).toBe(true);
    const [rec] = blocks(pushed);
    expect(blocks(pushed)).toHaveLength(1);
    expect(terminals(flushed)).toHaveLength(0);
    const ends = terminals(pushed);
    expect(ends).toHaveLength(1);
    const done = ends[0]!;
    expect(done).toMatchObject({ type: "turn.done", outcome: { type: "success" }, finishReason });
    if (finishReasonRaw === undefined) expect("finishReasonRaw" in done).toBe(false);
    else expect(done["finishReasonRaw"]).toBe(finishReasonRaw);
    expect(done["turnId"]).toBe(rec!["turnId"]);
    expect(seq(done)).toBeGreaterThan(seq(rec));
    expect(foldsLast(pushed).needsResync).toBe(false);
  };

  it("(a) {errorCode:SAFETY, usageMetadata} with no finishReason, content or errorMessage → exactly one prompt.blocked{reason:safety} with no reasonRaw or safety, then exactly one terminal with a higher seq", () => {
    const out = drive([{ ...inv, errorCode: "SAFETY", usageMetadata: { promptTokenCount: 7, totalTokenCount: 7 } } as unknown as JsonValue]);
    const [rec] = blocks(out);
    expect(blocks(out)).toHaveLength(1);
    expect(rec).toMatchObject({ reason: "safety" });
    expect("reasonRaw" in rec! || "safety" in rec!).toBe(false);
    expect(terminals(out)).toHaveLength(1);
    expect(seq(terminals(out)[0])).toBeGreaterThan(seq(rec));
    expect(foldsLast(out).needsResync).toBe(false);
  });

  it("(b) the same event with an errorMessage → the same record before exactly one terminal", () => {
    const out = drive([{ ...inv, errorCode: "SAFETY", errorMessage: "The prompt was blocked." } as unknown as JsonValue]);
    expect(blocks(out)).toEqual([expect.objectContaining({ reason: "safety" })]);
    expect(terminals(out)).toHaveLength(1);
    expect(seq(terminals(out)[0])).toBeGreaterThan(seq(blocks(out)[0]));
    expect(foldsLast(out).needsResync).toBe(false);
  });

  for (const raw of ["OTHER", "IMAGE_SAFETY", "JAILBREAK", "BLOCK_REASON_UNSPECIFIED"]) {
    it(`(c) errorCode ${raw} → prompt.blocked{reason:other} with reasonRaw equal to the value byte for byte`, () => {
      const out = drive([{ ...inv, errorCode: raw } as unknown as JsonValue]);
      expect(blocks(out)).toEqual([expect.objectContaining({ reason: "other", reasonRaw: raw })]);
      foldsLast(out);
    });
  }

  it("(d) no prompt.blocked for a response-level block, a non-block errorCode or an event with content parts", () => {
    const negatives: JsonValue[] = [
      { ...inv, errorCode: "SAFETY", finishReason: "SAFETY" },
      { ...inv, errorCode: "OTHER", finishReason: "OTHER" },
      { ...inv, errorCode: "429", errorMessage: "Resource exhausted" },
      { ...inv, errorCode: "UNKNOWN_ERROR", errorMessage: "Unknown error." },
      { ...inv, errorCode: "SAFETY", content: { role: "model", parts: [{ text: "partial answer" }] } },
    ] as unknown as JsonValue[];
    for (const native of negatives) expect(blocks(drive([native])), JSON.stringify(native)).toEqual([]);
  });

  it("(e) with the host-completion event, SAFETY, PROHIBITED_CONTENT, SAFETY (no errorMessage) → three records in that order before the one terminal; without it each record names its own top-level turn (the first, then the turns opened after each close), before that turn's terminal", () => {
    const three = [{ ...inv, errorCode: "SAFETY" }, { ...inv, errorCode: "PROHIBITED_CONTENT" }, { ...inv, errorCode: "SAFETY" }] as unknown as JsonValue[];
    const marked = drive([...three, HOST_COMPLETE], true);
    expect(blocks(marked).map((e) => e["reason"])).toEqual(["safety", "prohibited", "safety"]);
    expect(terminals(marked)).toHaveLength(1);
    expect(Math.max(...blocks(marked).map(seq))).toBeLessThan(seq(terminals(marked)[0]));
    expect(foldsLast(marked).needsResync).toBe(false);
    const bare = drive(three);
    expect(blocks(bare).map((e) => e["reason"])).toEqual(["safety", "prohibited", "safety"]);
    const ends = terminals(bare);
    expect(ends).toHaveLength(3);
    const turnIds = ends.map((e) => (e as { turnId?: string }).turnId);
    expect(turnIds[1]).toBe(`${turnIds[0]}_g1`);
    expect(turnIds[2]).toBe(`${turnIds[0]}_g2`);
    // each later turn opens after a success close (the record never lands on the closed turn)
    for (const end of ends) expect(end).toMatchObject({ type: "turn.done", outcome: { type: "success" } });
    blocks(bare).forEach((rec, k) => {
      expect((rec as { turnId?: string }).turnId).toBe(turnIds[k]);
      expect(seq(rec)).toBeLessThan(seq(ends[k]!));
    });
    expect(foldsLast(bare).needsResync).toBe(false);
  });

  it("(f) a SAFETY event without errorMessage while an ask is pending → its record before the turn's one terminal", () => {
    const authConfig = { authScheme: { type: "apiKey", in: "header", name: "X-Key" }, credentialKey: "k" };
    const out = drive([
      { ...inv, author: "agent", content: { role: "model", parts: [{ functionCall: { name: "read_mail", args: {}, id: "fc-1" } }] }, partial: false },
      { ...inv, author: "agent", content: { role: "model", parts: [{ functionCall: { name: "adk_request_credential", args: { functionCallId: "fc-1", authConfig }, id: "adk-cred-1" } }] }, partial: false, longRunningToolIds: ["adk-cred-1"] },
      { ...inv, author: "agent", content: { role: "user", parts: [{ functionResponse: { name: "read_mail", id: "fc-1", response: { status: "authorization requested" } } }] }, actions: { requestedAuthConfigs: { "fc-1": authConfig } } },
      { ...inv, errorCode: "SAFETY" },
    ] as unknown as JsonValue[]);
    expect(blocks(out)).toHaveLength(1);
    expect(terminals(out)).toHaveLength(1);
    expect(seq(blocks(out)[0])).toBeLessThan(seq(terminals(out)[0]));
    foldsLast(out);
  });

  it("(g) an event carrying both promptFeedback.blockReason and the errorCode shape → exactly one record", () => {
    const out = drive([{ ...inv, errorCode: "OTHER", promptFeedback: { blockReason: "SAFETY" } } as unknown as JsonValue]);
    expect(blocks(out)).toHaveLength(1);
    foldsLast(out);
  });

  it("(h) a SAFETY event without errorMessage carrying ADK node info, then the host-terminal event → one record and then turn.error", () => {
    const out = drive([{ ...inv, errorCode: "SAFETY", nodeInfo: { path: "wf/classify" } }, HOST_ERROR] as unknown as JsonValue[]);
    expect(blocks(out)).toHaveLength(1);
    expect(terminals(out)).toEqual([expect.objectContaining({ type: "turn.error" })]);
    expect(seq(blocks(out)[0])).toBeLessThan(seq(terminals(out)[0]));
    expect(foldsLast(out).needsResync).toBe(false);
  });

  it("(i) a repeated block event while the turn is open records its own prompt.blocked, and the same shape after the turn's error terminal records none", () => {
    const nodeBlock = { ...inv, errorCode: "SAFETY", nodeInfo: { path: "wf/classify" } };
    const out = drive([nodeBlock, nodeBlock, HOST_ERROR, { ...inv, errorCode: "SAFETY" }] as unknown as JsonValue[]);
    expect(blocks(out)).toHaveLength(2);
    expect(terminals(out)).toEqual([expect.objectContaining({ type: "turn.error" })]);
    expect(Math.max(...blocks(out).map(seq))).toBeLessThan(seq(terminals(out)[0]));
    expect(foldsLast(out).needsResync).toBe(false);
  });

  it("(j) bare, {errorCode:SAFETY, usageMetadata} with no errorMessage, finishReason, content parts, branch or node info, no ask pending and no earlier invocation error → push() on that event closes its turn turn.done{success} after the record: finishReason safety_blocked, no finishReasonRaw", () => {
    bareClose("SAFETY", "safety_blocked");
  });

  it("(k) the same bare shape with errorCode OTHER → turn.done{success} from push() after the record: finishReason other, no finishReasonRaw", () => {
    bareClose("OTHER", "other");
  });

  it("(l) the same bare shape with errorCode JAILBREAK → turn.done{success} from push() after the record: finishReason unknown, finishReasonRaw JAILBREAK byte for byte", () => {
    bareClose("JAILBREAK", "unknown", "JAILBREAK");
  });

  it("an event relayed from a remote agent (a2a:response in customMetadata) yields no prompt.blocked, and the same event unrelayed yields one", () => {
    const localMeta = { host_note: "kept" };
    const unrelayed = { ...inv, author: "remote_agent", turnComplete: true, errorCode: "SAFETY", errorMessage: "SAFETY", customMetadata: localMeta };
    const relayed = { ...unrelayed, customMetadata: { ...localMeta, "a2a:response": { kind: "message" } } };
    const a = drive([relayed as unknown as JsonValue]);
    const b = drive([unrelayed as unknown as JsonValue]);
    expect(blocks(a)).toHaveLength(0);
    expect(blocks(b)).toEqual([expect.objectContaining({ reason: "safety" })]);
    expect("reasonRaw" in blocks(b)[0]!).toBe(false);
    expect(terminals(a).map((e) => e["type"])).toEqual(terminals(b).map((e) => e["type"]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.58 — Block finish reason whatever the outcome (rc.1; COVERED-BY, one
// row per leg). Each facet's own test proves its leg in the order its
// framework delivers the frames; this thin re-assertion re-drives the same
// native vectors through the reference normalizers and carries the item's
// parse, fold and record checks: the blocked turn has exactly one turn.done
// with the mapped finishReason, every event passes producer-strict AgEvent
// validation, reduce() needs no resync, and the turn record carries the mapped
// finishReason. Nothing is asserted about outcome.type (§4, "A block is not an
// outcome"). The claude leg feeds a refusal in the order the Claude Code CLI's
// bundle builds it (the notice, an API-error frame whose stop reason is refusal,
// then an erroring result), which the reference normalizer closes with turn.done.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.58 — block finish reason whatever the outcome (rc.1): exactly one turn.done with the mapped finishReason, every event valid, a clean fold and the turn record's finishReason", () => {
  const turnDones = (evs: AgEvent[], turnId: string) =>
    evs.filter((e) => e.type === "turn.done" && (e as { turnId?: string }).turnId === turnId) as unknown as Array<{ finishReason?: string }>;
  const firstTurnId = (evs: AgEvent[]): string => (evs.find((e) => e.type === "turn.start") as unknown as { turnId: string }).turnId;
  const blockChecks = (evs: AgEvent[], turnId: string, mapped: string, label: string): void => {
    for (const e of evs) expect(AgEvent.safeParse(e).success, `${label}: ${JSON.stringify(e)}`).toBe(true);
    const dones = turnDones(evs, turnId);
    expect(dones, label).toHaveLength(1);
    expect(dones[0]!.finishReason, label).toBe(mapped);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync, label).toBe(false);
    expect(r.result().turns.find((t) => t.turnId === turnId)?.finishReason, label).toBe(mapped);
  };

  // OpenAI Agents (Responses model, @openai/agents 0.18.0 order): a message_output_created run-item
  // lands after its response's response.completed; a content_filter ends the stream at response.incomplete.
  const oaRaw = (event: Record<string, unknown>) => ({ type: "raw_model_stream_event", data: { type: "model", event } }) as unknown as JsonValue;
  const oaItem = (name: string, item: Record<string, unknown>) => ({ type: "run_item_stream_event", name, item }) as unknown as JsonValue;
  const OA_USAGE = { input_tokens: 20, output_tokens: 6, total_tokens: 26 };
  const oaRefusal = (id: string) => ({ type: "message", id, role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "I cannot help with that." }] });
  const oaLateRefusal = (id: string) => oaItem("message_output_created", { type: "message_output_item", rawItem: oaRefusal(id) });
  const oaDrive = (natives: JsonValue[]): AgEvent[] => {
    const n = createOpenaiNormalizer({ invokeId: "inv_c10" });
    return [...natives.flatMap((e) => n.push(e)), ...n.flush()];
  };

  it("(openai-content-filter) a content_filter round ending at response.incomplete: one turn.done safety_blocked, every event valid, a clean fold, the record's safety_blocked", () => {
    const evs = oaDrive([
      oaRaw({ type: "response.created", response: { id: "resp_c10_a" } }),
      oaRaw({ type: "response.output_text.delta", item_id: "msg_c10_a", delta: "partial" }),
      oaRaw({ type: "response.incomplete", response: { id: "resp_c10_a", status: "incomplete", incomplete_details: { reason: "content_filter" }, usage: OA_USAGE } }),
    ]);
    blockChecks(evs, "turn_resp_c10_a", "safety_blocked", "openai-content-filter");
  });

  it("(openai-refusal) a refusal round, response.completed before its message_output_created: one turn.done refusal, every event valid, a clean fold, the record's refusal", () => {
    const evs = oaDrive([
      oaRaw({ type: "response.created", response: { id: "resp_c10_b" } }),
      oaRaw({ type: "response.completed", response: { id: "resp_c10_b", status: "completed", output: [oaRefusal("msg_c10_b")], usage: OA_USAGE } }),
      oaLateRefusal("msg_c10_b"),
    ]);
    blockChecks(evs, "turn_resp_c10_b", "refusal", "openai-refusal");
  });

  it("(openai-deferred) a refusal round deferred behind a pending call closes after that call's tool.done with one turn.done refusal, and the invoke's next round closes stop; every event valid, a clean fold", () => {
    const evs = oaDrive([
      oaRaw({ type: "response.created", response: { id: "resp_c10_c" } }),
      oaRaw({ type: "response.output_item.added", item: { id: "fc_c10_c", type: "function_call", call_id: "call_c10_c", name: "echo", arguments: "" } }),
      oaRaw({ type: "response.completed", response: { id: "resp_c10_c", status: "completed", output: [oaRefusal("msg_c10_c")], usage: OA_USAGE } }),
      oaLateRefusal("msg_c10_c"),
      oaItem("tool_output", {
        type: "tool_call_output_item",
        rawItem: { type: "function_call_result", name: "echo", callId: "call_c10_c", status: "completed", output: "ok" },
        output: "ok",
      }),
      oaRaw({ type: "response.created", response: { id: "resp_c10_d" } }),
      oaRaw({ type: "response.output_text.delta", item_id: "msg_c10_d", delta: "fine" }),
      oaRaw({
        type: "response.completed",
        response: {
          id: "resp_c10_d",
          status: "completed",
          output: [{ type: "message", id: "msg_c10_d", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fine", annotations: [] }] }],
        },
      }),
    ]);
    blockChecks(evs, "turn_resp_c10_c", "refusal", "openai-deferred");
    const iTool = evs.findIndex((e) => e.type === "tool.done" && (e as { toolCallId?: string }).toolCallId === "call_c10_c");
    const iDone = evs.findIndex((e) => e.type === "turn.done" && (e as { turnId?: string }).turnId === "turn_resp_c10_c");
    expect(iTool).toBeGreaterThanOrEqual(0);
    expect(iDone).toBeGreaterThan(iTool);
    blockChecks(evs, "turn_resp_c10_d", "stop", "openai-next-round");
  });

  // Google ADK: a blocked final as ADK builds it (errorCode and finishReason, no content, no errorMessage),
  // for each value the mapping sends to "safety_blocked".
  const ADK_BLOCK_VALUES = ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"];
  const adkDrive = (natives: JsonValue[], hostCompletion = false): AgEvent[] => {
    const n = createAdkNormalizer(hostCompletion ? { invokeId: "adk_c10", hostCompletion: true } : { invokeId: "adk_c10" });
    return [...natives.flatMap((e) => n.push(e)), ...n.flush()];
  };

  it("(adk) a blocked final for each of the eight block values: one turn.done safety_blocked, every event valid, a clean fold, the record's safety_blocked", () => {
    for (const raw of ADK_BLOCK_VALUES) {
      const evs = adkDrive([{ invocationId: "inv_c10", errorCode: raw, finishReason: raw } as unknown as JsonValue]);
      blockChecks(evs, firstTurnId(evs), "safety_blocked", `adk ${raw}`);
    }
  });

  it("(adk-host-completion) with host completion, the stashed blocked final of each block value released by the host-completion event: one turn.done safety_blocked, every event valid, a clean fold, the record's safety_blocked", () => {
    for (const raw of ADK_BLOCK_VALUES) {
      const evs = adkDrive([{ invocationId: "inv_c10", errorCode: raw, finishReason: raw } as unknown as JsonValue, { type: ADK_HOST_COMPLETE_TYPE } as unknown as JsonValue], true);
      blockChecks(evs, firstTurnId(evs), "safety_blocked", `adk-host-completion ${raw}`);
    }
  });

  it("(vercel) a content-filter finish in fullStream order: one turn.done safety_blocked, every event valid, a clean fold, the record's safety_blocked", () => {
    const n = createVercelNormalizer();
    const parts: JsonValue[] = [
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", text: "redac" }, { type: "text-end", id: "t1" },
      { type: "finish-step", finishReason: "content-filter", usage: { inputTokens: 1, outputTokens: 1 }, response: { id: "resp_v_c10", timestamp: "1970-01-01T00:00:00.000Z", modelId: "mock-model" } },
      { type: "finish", finishReason: "content-filter", totalUsage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const evs = [...parts.flatMap((p) => n.push(p)), ...n.flush()];
    blockChecks(evs, firstTurnId(evs), "safety_blocked", "vercel");
  });

  it("(claude) a refusal in the Claude Code CLI's bundle-read order (the notice, an API-error frame whose stop reason is refusal, an erroring result): one turn.done refusal, every event valid, a clean fold, the record's refusal", () => {
    const STOP = { type: "refusal", category: "cyber", explanation: "declined", recommended_model: "claude-test-2" };
    const TEXT = "API Error: Claude can't help with this.";
    const evs = rDrive([
      { type: "system", subtype: "model_refusal_no_fallback", original_model: "claude-test", request_id: "req_c10", api_refusal_category: "cyber", api_refusal_explanation: "declined", refused_user_message_uuid: "00000000-0000-0000-0000-00000000c1a1", content: "declined", uuid: "00000000-0000-0000-0000-00000000c1a2", session_id: "sess_s10_remedy" },
      rAssistant("msg_c10_refusal", [{ type: "text", text: TEXT, citations: null }], { error: "invalid_request", is_api_error_message: true }, { stop_reason: "refusal", stop_details: STOP }),
      { ...rResult("refusal"), is_error: true, result: TEXT },
    ]);
    blockChecks(evs, firstTurnId(evs), "refusal", "claude");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.59 — OpenAI built-in round and hosted-MCP approval (rc.1). The facet
// and e2e legs the manifest cites prove the lifecycle in the order
// @openai/agents streams it; this leg re-drives two engine fixtures and checks
// the item's naming clause: a hosted mcp_call and an mcp_approval_request name
// the MCP tool (providerData.name) in tool.start, with its server_label as
// serverName; every event parses producer-strict and the fold does not resync.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.59 — OpenAI built-in round and hosted-MCP approval (rc.1)", () => {
  const drive = (name: string): AgEvent[] => {
    const natives = JSON.parse(readFileSync(new URL(`../fixtures/openai-hosted/${name}.native.json`, import.meta.url), "utf8")) as JsonValue[];
    const n = createOpenaiNormalizer({ invokeId: "c10" });
    const evs = [...natives.flatMap((e) => n.push(e)), ...n.flush()];
    for (const e of evs) expect(AgEvent.safeParse(e).success, `${name}: ${JSON.stringify(e)}`).toBe(true);
    const r = new Reducer();
    for (const e of evs) r.push(e);
    expect(r.needsResync, name).toBe(false);
    return evs;
  };

  it("a hosted mcp_call and an approval request name the MCP tool (providerData.name) in tool.start, with its server_label as serverName", () => {
    for (const [fixture, type] of [["hosted-websearch-mcp-complete", "mcp_call"], ["hosted-mcp-approval", "mcp_approval_request"]] as const) {
      const starts = drive(fixture).filter((e) => e.type === "tool.start" && (e as { providerMetadata?: { type?: string } }).providerMetadata?.type === type) as unknown as Array<{ name: string; serverName?: string }>;
      expect(starts.length, fixture).toBeGreaterThan(0);
      for (const s of starts) expect(s, fixture).toMatchObject({ name: "ask_question", serverName: "deepwiki" });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.61 — ADK relay bookkeeping off carries (rc.1), RUNNABLE, facet-driven
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.61 — ADK relay bookkeeping off carries (rc.1): the four relay entries reach no emitted event, and the stream equals the one from natives without them", () => {
  const RELAY_KEYS = ["a2a:request", "a2a:response", "a2a:task_id", "a2a:context_id"] as const;
  const LEAVES: string[] = [];
  const leaf = (tag: string): string => {
    const v = `S10R-${tag}-${LEAVES.length}`;
    LEAVES.push(v);
    return v;
  };
  const model = (t: string) => ({ role: "model", parts: [{ text: t }] });
  /** The relay's send request as the host issued it, with a distinct leaf at each secret position. */
  const request = (tag: string) => {
    const text = leaf(`${tag}-forwarded`);
    const user = leaf(`${tag}-user`);
    const session = leaf(`${tag}-session`);
    return {
      value: {
        message: { kind: "message", role: "user", parts: [{ kind: "text", text }], metadata: { adk_user_id: user, adk_session_id: session } },
        configuration: { pushNotificationConfig: { url: "https://push.example/cb", token: leaf(`${tag}-token`), authentication: { schemes: ["Bearer"], credentials: leaf(`${tag}-credentials`) } } },
        metadata: { tenantKey: leaf(`${tag}-metadata`) },
      },
      repeated: { text, user, session },
    };
  };
  const fourKeys = (tag: string) => {
    const req = request(tag);
    return {
      "a2a:request": req.value,
      // a Task at completed whose status carries no message and whose history repeats the request's leaves
      "a2a:response": {
        kind: "task",
        id: leaf(`${tag}-task-in-response`),
        status: { state: "completed" },
        history: [{ kind: "message", role: "user", parts: [{ kind: "text", text: req.repeated.text }], metadata: { adk_user_id: req.repeated.user, adk_session_id: req.repeated.session } }],
      },
      "a2a:task_id": leaf(`${tag}-task-id`),
      "a2a:context_id": leaf(`${tag}-context-id`),
    };
  };
  const inv = { invocationId: "inv_s10_relay" };
  // (a) completes a turn, with a member `other`; (b) does not complete a turn; (c) no branch/nodeInfo, the four keys only;
  // (d) cannot be mapped (no content, no invocationId), camelCase and snake_case.
  const shapeA = (i: number) => ({ ...inv, author: `relay-a${i}`, content: model(`Done ${i}.`), turnComplete: true, customMetadata: { ...fourKeys(`a${i}`), other: { note: `kept-${i}`, nested: [i, { deeper: true }] } } });
  const shapeB = (i: number) => ({ ...inv, author: `relay-b${i}`, content: model(`Hel${i}`), partial: true, customMetadata: { "a2a:request": request(`b${i}`).value } });
  const shapeC = (i: number) => ({ ...inv, author: `relay-c${i}`, content: model(`Ok ${i}.`), customMetadata: fourKeys(`c${i}`) });
  const shapeD = (i: number) => ({ author: `relay-d${i}`, turnComplete: true, customMetadata: fourKeys(`d${i}`) });
  const shapeDs = (i: number) => ({ author: `relay-ds${i}`, turn_complete: true, custom_metadata: fourKeys(`ds${i}`) });
  const shapes = { a: [shapeA(1), shapeA(2)], b: [shapeB(1), shapeB(2)], c: [shapeC(1), shapeC(2)], d: [shapeD(1), shapeD(2), shapeDs(1), shapeDs(2)] };
  const all = [...shapes.a, ...shapes.b, ...shapes.c, ...shapes.d];

  /** The same native with the four keys removed, and the metadata member removed where that removal empties it. */
  const stripped = (native: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...native };
    for (const member of ["customMetadata", "custom_metadata"]) {
      const bag = out[member];
      if (bag === null || typeof bag !== "object" || Array.isArray(bag)) continue;
      const kept = Object.fromEntries(Object.entries(bag as Record<string, unknown>).filter(([k]) => !(RELAY_KEYS as readonly string[]).includes(k)));
      if (Object.keys(kept).length === 0) delete out[member];
      else out[member] = kept;
    }
    return out;
  };
  const drive = (natives: Record<string, unknown>[]): AgEvent[] => {
    const n = createAdkNormalizer({ invokeId: "s10-relay" });
    const out: AgEvent[] = [];
    for (const native of natives) expect(() => out.push(...n.push(toJsonValue(native)))).not.toThrow();
    expect(() => out.push(...n.flush())).not.toThrow();
    return out;
  };
  const providerRaws = (out: AgEvent[]): Array<Record<string, unknown>> =>
    out.flatMap((e) => {
      if (e.type !== "content.block") return [];
      const block: unknown = Reflect.get(e, "block");
      if (typeof block !== "object" || block === null || Reflect.get(block, "type") !== "provider-raw") return [];
      const raw: unknown = Reflect.get(block, "raw");
      return typeof raw === "object" && raw !== null ? [raw as Record<string, unknown>] : [];
    });
  const textConcats = (out: AgEvent[]): string[] => {
    const by = new Map<string, string>();
    for (const e of out) {
      if (e.type !== "text.delta") continue;
      const id = String(Reflect.get(e, "blockId") ?? Reflect.get(e, "id") ?? "");
      by.set(id, (by.get(id) ?? "") + String(Reflect.get(e, "delta") ?? ""));
    }
    return [...by.values()];
  };
  const expectNoLeaf = (value: unknown, label: string) => {
    const wire = JSON.stringify(value);
    for (const v of LEAVES) {
      expect(wire.includes(v), `${label}: raw ${v}`).toBe(false);
      expect(wire.includes(JSON.stringify(v).slice(1, -1)), `${label}: escaped ${v}`).toBe(false);
    }
  };

  it("in one fold of every shape (two of each, the unmappable shape once per spelling), no secret leaf reaches an emitted event or any text block's deltas, and no provider-raw block's raw.customMetadata holds a relay entry", () => {
    const out = drive(all);
    expectNoLeaf(out, "the fold's events");
    for (const text of textConcats(out)) for (const v of LEAVES) expect(text.includes(v), `a text block's deltas: ${v}`).toBe(false);
    for (const raw of providerRaws(out)) {
      const bag = raw["customMetadata"];
      if (bag !== null && typeof bag === "object") for (const k of RELAY_KEYS) expect(Object.hasOwn(bag, k), k).toBe(false);
    }
  });

  it("per shape: (a)'s other rides byte-identical to the native's, (c) leaves no provider-raw customMetadata member, and (d)'s ext.google.unparsed native holds no leaf and no emptied metadata member under either spelling", () => {
    for (const native of shapes.a) {
      const carried = providerRaws(drive([native])).map((raw) => raw["customMetadata"]).filter((b) => b !== undefined);
      expect(carried.map((b) => JSON.stringify(Reflect.get(b as object, "other"))), String(native.author)).toEqual([JSON.stringify(native.customMetadata.other)]);
    }
    for (const native of shapes.c) {
      for (const raw of providerRaws(drive([native]))) expect(Object.hasOwn(raw, "customMetadata"), String(native.author)).toBe(false);
    }
    for (const native of shapes.d) {
      const ext = drive([native]).filter((e) => e.type === "ext.google.unparsed");
      expect(ext.length, String(native.author)).toBeGreaterThan(0);
      for (const e of ext) {
        expectNoLeaf(e, String(native.author));
        const carriedNative: unknown = Reflect.get(e, "native");
        for (const member of ["customMetadata", "custom_metadata"]) {
          const bag = carriedNative !== null && typeof carriedNative === "object" ? Reflect.get(carriedNative, member) : undefined;
          expect(bag !== undefined && bag !== null && typeof bag === "object" && Object.keys(bag).length === 0, `${String(native.author)}: emptied ${member}`).toBe(false);
        }
      }
    }
  });

  it("the emitted events, and the fold of them, deep-equal those from the same natives with the four keys removed (and the metadata member removed where that empties it), with the same invoke id", () => {
    const out = drive(all);
    const ref = drive(all.map(stripped));
    expect(isDeepStrictEqual(JSON.parse(JSON.stringify(out)), JSON.parse(JSON.stringify(ref)))).toBe(true);
    expect(isDeepStrictEqual(JSON.parse(JSON.stringify(reduce(out))), JSON.parse(JSON.stringify(reduce(ref))))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.65 — Wire-selected prototypes at the decode (rc.1; §13.7 (2)). The two
// receivers core's own legs leave out: a consuming ingest of an `ext.*` event,
// and the request carriers of an `AgClientCapabilities`
// (`AgInputEnvelope.capabilities`) and an `AgHitlAnswer` (a resume's
// `answers[]`), whose reference receiver is checkAgInput. Each value leg plants
// the member at the top level and nested; the bare parse is the negative
// control. Prototypes are asserted directly (toEqual ignores them).
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.65 — wire-selected prototypes at the decode (rc.1): an ext.* ingest and the request carriers of AgClientCapabilities and AgHitlAnswer drop an own __proto__ at every depth", () => {
  const VALUE_LEGS: Array<[string, string]> = [["object", '{"p":1}'], ["null", "null"], ["array", "[1]"], ["primitive", '"s"']];
  /** Every own `__proto__` and every non-ordinary prototype, by path (core's ingest.test.ts helper, repeated here). */
  const protoOffenders = (v: unknown, path = "$"): string[] => {
    if (v === null || typeof v !== "object") return [];
    const out: string[] = [];
    if (Object.getPrototypeOf(v) !== (Array.isArray(v) ? Array.prototype : Object.prototype)) out.push(`${path} prototype`);
    if (Object.hasOwn(v, "__proto__")) out.push(`${path}.__proto__`);
    for (const k of Object.keys(v)) out.push(...protoOffenders((v as Record<string, unknown>)[k], `${path}.${k}`));
    return out;
  };
  const extPlanted = (v: string) => `{"type":"ext.vendor.x","seq":3,"__proto__":${v},"payload":{"k":{"__proto__":${v},"v":[{"__proto__":${v},"w":"s"}]},"__proto__":${v}}}`;
  const EXT_PLAIN = '{"type":"ext.vendor.x","seq":3,"payload":{"k":{"v":[{"w":"s"}]}}}';
  const requestPlanted = (v: string) =>
    `{"protocol":"agjson","version":"${AGJSON_VERSION}","threadId":"th","turnId":"t","kind":"resume","__proto__":${v},"capabilities":{"__proto__":${v},"hitl":{"ask":true,"__proto__":${v}}},"answers":[{"askId":"a1","status":"resolved","__proto__":${v},"reply":{"__proto__":${v},"q":[{"__proto__":${v},"r":1}]}}]}`;
  const REQUEST_PLAIN = `{"protocol":"agjson","version":"${AGJSON_VERSION}","threadId":"th","turnId":"t","kind":"resume","capabilities":{"hitl":{"ask":true}},"answers":[{"askId":"a1","status":"resolved","reply":{"q":[{"r":1}]}}]}`;

  for (const [leg, v] of VALUE_LEGS) {
    it(`(ext ${leg}) ingestAgEvent on an ext.vendor.x event with the member planted at the top level and at three depths of its payload returns the event, not a stub, with no own __proto__ at any depth, ordinary prototypes and the other members deep-equal the unplanted event's; the bare parse keeps the member`, () => {
      const planted = JSON.parse(extPlanted(v)) as JsonValue;
      expect(protoOffenders(planted)).toEqual(["$.__proto__", "$.payload.__proto__", "$.payload.k.__proto__", "$.payload.k.v.0.__proto__"]);
      const e = ingestAgEvent(planted);
      expect(e).toBeDefined();
      expect(e?.type).toBe("ext.vendor.x");
      expect(protoOffenders(e)).toEqual([]);
      expect(e).toEqual(JSON.parse(EXT_PLAIN));
      expect(ingestAgEvent(JSON.parse(EXT_PLAIN) as JsonValue)).toEqual(e);
    });
    it(`(request ${leg}) checkAgInput on a resume AgInput with the member planted at the top level, inside capabilities and its hitl, and inside an answer and its reply, accepts it with no own __proto__ at any depth, ordinary prototypes and the input deep-equal the unplanted one; the bare parse keeps the member`, () => {
      const planted = JSON.parse(requestPlanted(v)) as unknown;
      expect(protoOffenders(planted)).toEqual(["$.__proto__", "$.capabilities.__proto__", "$.capabilities.hitl.__proto__", "$.answers.0.__proto__", "$.answers.0.reply.__proto__", "$.answers.0.reply.q.0.__proto__"]);
      const r = checkAgInput(planted);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(protoOffenders(r.input)).toEqual([]);
      const plain = checkAgInput(JSON.parse(REQUEST_PLAIN));
      expect(plain.ok).toBe(true);
      if (plain.ok) expect(r.input).toEqual(plain.input);
    });
  }
  it("Object.prototype gains no member from any leg, and the planted object leg's member is not reachable through an ordinary object", () => {
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain("p");
    expect((({}) as Record<string, unknown>)["p"]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.64 — Wire-selected prototypes at the fold (rc.1; §13.7 (3)): the item's
// named planted set, beyond core's own stream (reduce.test.ts plants tool.args,
// tool.done content[], text.start providerMetadata, state.delta, memory.write
// and a turn.done): turn.done.outcome.asks[].schema, usage with a byModel entry
// on turn.done, turn.error and message.end, block citations, tool-result
// content[] and structuredContent, messages.snapshot records, state.snapshot,
// both state.delta shapes and memory.write. The member is DEFINED as an own
// data property at every object node (never assigned: an assignment would run
// Object.prototype's setter). Folds are compared as JSON text (order-sensitive);
// prototypes are asserted directly.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.64 — wire-selected prototypes at the fold (rc.1): the item's named planted set, once per value leg, folds with no own __proto__ at any depth, ordinary prototypes, no resync, byte-equal to the unplanted fold and to the fold after a consuming ingest, and batch == incremental", () => {
  const VALUE_LEGS: Array<[string, JsonValue]> = [["object", { p: 1 }], ["null", null], ["array", [1]], ["primitive", "s"]];
  const protoOffenders = (v: unknown, path = "$"): string[] => {
    if (v === null || typeof v !== "object") return [];
    const out: string[] = [];
    if (Object.getPrototypeOf(v) !== (Array.isArray(v) ? Array.prototype : Object.prototype)) out.push(`${path} prototype`);
    if (Object.hasOwn(v, "__proto__")) out.push(`${path}.__proto__`);
    for (const k of Object.keys(v)) out.push(...protoOffenders((v as Record<string, unknown>)[k], `${path}.${k}`));
    return out;
  };
  /** Every object node below the event root gets an own `__proto__` data member; the event's own members are the carried siblings. */
  const plant = (v: unknown, value: JsonValue, top: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => plant(x, value, false));
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = plant((v as Record<string, unknown>)[k], value, false);
    if (!top) Object.defineProperty(out, "__proto__", { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
    return out;
  };
  const T = "t1", M = "m1", TH = "th1";
  const USAGE = { inputTokens: 3, outputTokens: 4, byModel: { "model-a": { inputTokens: 3, outputTokens: 4 } } };
  const CITE = { kind: "char", citedText: "hi", documentIndex: 0, startCharIndex: 0, endCharIndex: 2 };
  const ASK = { askId: "a1", kind: "text", schema: { type: "object", properties: { x: { type: "string" } } } };
  const stream = (): Array<Record<string, unknown>> => [
    { type: "turn.start", seq: 0, threadId: TH, turnId: T },
    { type: "message.start", seq: 1, id: M, role: "assistant", turnId: T, threadId: TH },
    { type: "content.block", seq: 2, turnId: T, messageId: M, block: { type: "text", text: "hi", citations: [CITE] } },
    { type: "tool.start", seq: 3, toolCallId: "c1", name: "echo", turnId: T, messageId: M },
    { type: "tool.args.assembled", seq: 4, toolCallId: "c1", input: { q: { deep: [{ k: 1 }] } } },
    { type: "tool.done", seq: 5, toolCallId: "c1", turnId: T, content: [{ type: "text", text: "r" }], structuredContent: { a: [{ b: 1 }] }, outcome: "ok" },
    { type: "message.end", seq: 6, id: M, usage: USAGE },
    { type: "state.snapshot", seq: 7, snapshot: { cfg: { a: [{ b: 1 }] } } },
    { type: "state.delta", seq: 8, patch: { cfg: { a: 2, list: [{ x: 1 }] } } },
    { type: "state.delta", seq: 9, patch: [{ op: "add", path: "/cfg/b", value: { c: [{ d: 3 }] } }] },
    { type: "memory.write", seq: 10, scope: "user", key: "k", value: { pref: { tone: ["short"] } } },
    { type: "turn.done", seq: 11, turnId: T, outcome: { type: "paused", asks: [ASK] }, finishReason: "paused", usage: USAGE },
    { type: "turn.start", seq: 12, threadId: TH, turnId: "t2" },
    { type: "turn.error", seq: 13, turnId: "t2", message: "boom", usage: USAGE },
  ];
  // a messages.snapshot replaces the fold's messages, so its records are planted in a fold of their own
  const snapshotStream = (): Array<Record<string, unknown>> => [
    { type: "turn.start", seq: 0, threadId: TH, turnId: T },
    { type: "messages.snapshot", seq: 1, messages: [{ id: M, role: "assistant", content: [{ type: "text", text: "hi", citations: [CITE] }, { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "r" }], structuredContent: { a: [{ b: 1 }] }, outcome: "ok" }], turnId: T, threadId: TH }], turns: [{ turnId: T, threadId: TH, usage: USAGE }] },
    { type: "turn.done", seq: 2, turnId: T, outcome: { type: "success" }, finishReason: "stop", usage: USAGE },
  ];
  const STREAMS: Array<[string, () => Array<Record<string, unknown>>]> = [["live", stream], ["snapshot", snapshotStream]];
  const fold = (evs: AgEvent[]) => {
    const batch = reduce(evs);
    const acc = new Reducer();
    for (const e of evs) acc.push(e);
    expect(JSON.stringify(acc.result())).toBe(JSON.stringify(batch.result));
    expect(acc.needsResync).toBe(batch.needsResync);
    return batch;
  };

  it("the unplanted streams are producer-strict valid and fold without a resync, and every member of the named set reaches a result (the set is a real fold, not a vacuous one)", () => {
    const texts = STREAMS.map(([, s]) => {
      const r = fold(s().map((e) => AgEvent.parse(e)));
      expect(r.needsResync).toBe(false);
      return JSON.stringify(r.result);
    });
    const text = texts.join("\n");
    for (const needle of ['"citations"', '"byModel"', '"schema"', '"state"', '"memory"', '{"a":[{"b":1}]}', '"tool-result"']) expect(text, needle).toContain(needle);
    expect(texts[1]).toContain('"citations"'); // the snapshot's own records carry the planted nodes
  });
  const firstDifference = (a: string, b: string): string => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return `at ${i}: planted …${a.slice(Math.max(0, i - 140), i + 140)}… | control …${b.slice(Math.max(0, i - 140), i + 140)}…`;
  };

  for (const [leg, value] of VALUE_LEGS) {
    it(`(planted-set ${leg}) each planted stream folds with no own __proto__ at any depth and ordinary prototypes, needsResync false, byte-equal to the unplanted fold and to the fold after ingestAgEvents, batch == incremental, and no pushed event is mutated`, () => {
      for (const [name, s] of STREAMS) {
        const valid = s().map((e) => AgEvent.parse(e));
        const planted = valid.map((e) => plant(e, value, true)) as AgEvent[];
        const before = JSON.stringify(planted);
        expect((before.match(/"__proto__":/g) ?? []).length, name).toBeGreaterThanOrEqual(10); // non-vacuity: own data at every object node below the roots
        expect(JSON.stringify(valid), name).not.toContain('"__proto__"');
        const want = fold(valid);
        const got = fold(planted);
        expect(got.needsResync, name).toBe(false);
        expect(protoOffenders(got.result), name).toEqual([]);
        const gotText = JSON.stringify(got.result), wantText = JSON.stringify(want.result);
        expect(gotText === wantText ? "same" : firstDifference(gotText, wantText), name).toBe("same");
        expect(JSON.stringify(planted), name).toBe(before);
        const decoded = ingestAgEvents(JSON.parse(before) as JsonValue[]);
        expect(decoded, name).toHaveLength(planted.length);
        const decodedText = JSON.stringify(fold(decoded).result);
        expect(decodedText === wantText ? "same" : firstDifference(decodedText, wantText), `${name} after ingest`).toBe("same");
      }
      expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain("p");
      expect((({}) as Record<string, unknown>)["p"]).toBeUndefined();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.66 — ADK interrupted close (rc.1; §8.0 item 17). The two Live barge-in
// captures (three interrupted generations) through the reference ADK
// normalizer, whole and cut after each generation's usage-only report before
// its turnComplete; cut points are derived from the natives, never pinned.
// ─────────────────────────────────────────────────────────────────────────────

describe("§10.66 — ADK interrupted close (rc.1): a Live stream whose interrupted event precedes the generation's usage-only report and turnComplete closes that turn with exactly one turn.abort{interrupted}, whole and cut before turnComplete", () => {
  type Ev = { type: string; turnId?: string; reason?: string; usage?: unknown };
  const corpus = new URL("../corpus/", import.meta.url);
  const TERM = new Set(["turn.done", "turn.error", "turn.abort"]);
  const DIRS = ["live-bargein-gemini38live", "live-bargein2-gemini38live"];
  const natives = (dir: string) => splitHostCompleteMarker(JSON.parse(readFileSync(new URL(`${dir}/adk.native.json`, corpus), "utf8")) as JsonValue[]).native;
  const obj = (n: JsonValue): Record<string, unknown> | undefined => (n !== null && typeof n === "object" && !Array.isArray(n) ? (n as Record<string, unknown>) : undefined);
  const partsOf = (n: JsonValue): unknown[] => ((obj(n)?.["content"] as { parts?: unknown[] } | undefined)?.parts ?? []);
  const isUsageOnly = (n: JsonValue) => obj(n) !== undefined && "usageMetadata" in obj(n)! && partsOf(n).length === 0 && obj(n)!["turnComplete"] !== true && obj(n)!["interrupted"] !== true;
  /** Each interrupted event's index, the usage-only report after it and the turnComplete after that. */
  const cuts = (nat: JsonValue[]): Array<{ i: number; u: number; c: number }> => {
    const out: Array<{ i: number; u: number; c: number }> = [];
    nat.forEach((n, i) => {
      if (obj(n)?.["interrupted"] !== true) return;
      const u = nat.findIndex((m, j) => j > i && isUsageOnly(m));
      const c = nat.findIndex((m, j) => j > i && obj(m)?.["turnComplete"] === true);
      expect(u, `interrupted at ${i}: a usage-only report follows`).toBeGreaterThan(i);
      expect(c, `interrupted at ${i}: turnComplete follows the report`).toBeGreaterThan(u);
      out.push({ i, u, c });
    });
    return out;
  };
  const checkCloses = (evs: Ev[], label: string): Ev[] => {
    for (const e of evs) expect(AgEvent.safeParse(e).success, `${label}: ${JSON.stringify(e).slice(0, 160)}`).toBe(true);
    const aborts = evs.filter((e) => e.type === "turn.abort" && e.reason === "interrupted");
    for (const a of aborts) {
      expect(evs.filter((e) => TERM.has(e.type) && e.turnId === a.turnId), `${label}: ${a.turnId} has one terminal`).toHaveLength(1);
      expect(evs.filter((e) => e.type === "turn.done" && e.turnId === a.turnId), `${label}: ${a.turnId} never closes done`).toHaveLength(0);
    }
    return aborts;
  };

  it("(adk) fed whole: one turn.abort{interrupted} per interrupted generation, that turn's only terminal, never a later turn.done, every event producer-strict valid; on the corpus each such abort directly follows a message.end carrying the turn's usage (the item's informative sentence)", async () => {
    let total = 0;
    for (const dir of DIRS) {
      const bare = natives(dir);
      const ks = cuts(bare);
      expect(ks.length, dir).toBeGreaterThan(0);
      const out = (await replayNatives(bare, "adk")).agjson as unknown as Ev[];
      const aborts = checkCloses(out, dir);
      expect(aborts.length, dir).toBe(ks.length);
      for (const a of aborts) {
        const prev = out[out.indexOf(a) - 1];
        expect(prev?.type, `${dir}: the event before ${a.turnId}'s abort`).toBe("message.end");
        expect(prev?.usage, `${dir}: that message.end carries usage`).toBeDefined();
      }
      total += aborts.length;
    }
    expect(total).toBe(3);
  });
  it("(adk-cut) fed cut after the usage-only report, before turnComplete: the interrupted turn's turn.abort{interrupted} is emitted by the end of flush(), that turn's only terminal, never a turn.done", async () => {
    let runs = 0;
    for (const dir of DIRS) {
      const bare = natives(dir);
      const ks = cuts(bare);
      for (const k of ks) {
        const label = `${dir} cut after native ${k.u}`;
        const out = (await replayNatives(bare.slice(0, k.u + 1), "adk")).agjson as unknown as Ev[];
        const aborts = checkCloses(out, label);
        expect(aborts.length, label).toBe(ks.filter((x) => x.u <= k.u).length);
        runs++;
      }
    }
    expect(runs).toBe(3);
  });
});
