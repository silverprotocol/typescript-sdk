# The cassette corpus — consumer contract

`packages/e2e/corpus/` is a corpus of **real captured agent-framework wire**: for
each `<scenario>/<framework>` pair, a cassette of native events
(`<framework>.native.json`), the golden normalized AgJSON stream produced from it
(`<framework>.agjson.json`), a coverage sidecar (`<framework>.coverage.json`,
harness-internal), and a provenance sidecar (`<framework>.provenance.json` —
which SDK version, model, and date produced the capture). A scenario that
scripts framework shared state also carries a session-state sidecar
(`<framework>.session-state.json`): the framework's own state, read back after
the run. It is ground truth for the `reduce()` state fold and is never
replayed; the replay gate checks that the fold of the golden equals it. A scenario that also asks for a cross-session read carries a
cross-session-state sidecar (`<framework>.cross-session-state.json`): the
initial state of two fresh sessions opened after the run, one for the
capture's user (`sameUser`) and one for another user (`otherUser`). It shows
which of the run's writes the framework carries into a later session (ADK
keeps `user:` keys per user and `app:` keys per app) and is never replayed.

Downstream projects may consume these cassettes for testing. This document is
the contract for doing that.

## Non-normative

**Conformance to AgJSON is defined by [`SPEC.md`](https://github.com/silverprotocol/AgJSON/blob/main/SPEC.md)
and the normative `reduce()` in `@silverprotocol/core` — never by these
cassettes.** The corpus is evidence: samples of what real frameworks emitted on
particular days, under this repository's verification ritual. If a cassette and
the spec ever appear to disagree, the spec wins and the cassette is a bug
report.

Consumers building clients should test **contract-first**: against
`@silverprotocol/core`'s typed `AgEvent` union, `ingestAgEvents()`, and
`reduce()`, plus synthetic spec-valid streams for cases live captures cannot
produce on demand (error arms, aborts, forward-compat unknowns). Use cassettes
as a realism tier on top — not as the test base.

## Stability contract

Cassettes are **re-captured** whenever the ritual demands it (peer SDK bumps,
new model validation, facet changes). Across refreshes:

- **Stable** (safe to assert on): event *types* and their ordering, tool names,
  scenario intent (which tools get called, roughly how many turns), the
  structural shape of the folded `reduce()` result.
- **Incidental** (never assert on): model prose, message/tool-call/response ids,
  token counts and usage numbers, timestamps, per-run metadata.

If your test asserts on the incidental tier, it will break on every refresh for
reasons that have nothing to do with your code.

Usage *numbers* are incidental, but their *meaning* follows the spec version
the goldens were regenerated under. From draft.5 (SDK 0.8.0), every Claude
usage bag's `inputTokens` is cache-inclusive (input + cache read + cache
creation, as on the other frameworks). Claude turn terminals are per-turn
(`cumulative: false`) and carry `costScope: "query"` beside `costUsd`, and
`byModel` entries stay running totals (`cumulative: true`). The 0.8.0 regen
moved every Claude golden inside `usage` only.

### Measuring a stability window

`packages/e2e/src/stability-window.test.ts` measures whether the corpus's
serialized replay held still across a window. It never runs in the gate. With
`STABILITY=record` it writes a baseline: the git ref, and for every native
cassette the hash of its natives and of its replay (the AgEvent stream, the
reference fold, its `toPersistable` storage projection and `needsResync`), on
the recorded path and, for a cassette that records the host-completion marker,
on the marker-less path too. With `STABILITY=check` it replays each baseline
stream's natives, read at the baseline ref, through the current code and fails
on any change, naming the first differing event, and on any stream that parks
on either path. A re-captured cassette is judged by its old natives, and
cassettes added since the baseline are listed, not judged. Record the baseline
at a commit every checkout has (a release commit), since the check reads the
natives there. Inputs (`AgInput`) are out of scope: they have no corpus, and
check-spec-drift gates their kinds.

## Read-only, refreshed only here

Consumers treat cassettes as **read-only**. Refresh happens exclusively through
this repository's capture ritual (live keys, census gates, provenance,
append-only evidence logs). Do not hand-edit a cassette, and do not capture
"compatible" cassettes elsewhere and present them as corpus-equivalent — one
capture discipline is the point.

**Consumption pattern:** pin this repository by commit SHA and fetch the corpus
paths you need (a lockfile-style pin plus a small sync script). Git SHAs are
content-addressed and immutable; refreshing your pin is an explicit, reviewable
change on your side.

## Scenario acceptance filter

A scenario joins the corpus only if it is both:

1. **real framework wire** — captured from an actual framework SDK run under
   this repository's ritual (never synthesized, never hand-authored), and
2. **spec-relevant to any AgJSON consumer** — it exercises a flow the wire
   format itself defines (tool loops, MCP-Apps carries, errors, multi-turn…),
   not a convenience specific to one downstream product.

Requests that pass the filter are welcome —
[open an issue](https://github.com/silverprotocol/typescript-sdk/issues).

## Layer B: authored transcripts (narrow exception)

The filter above governs **framework cassettes** (Layer A) and its
never-hand-authored clause stays intact for them. A second, deliberately
narrow tier exists for scenarios that are **structurally uncapturable by any
framework SDK** — flows that originate outside the agent stream (e.g. a
client-iframe gesture re-entering through the MCP-Apps host plane), where the
producing runtime is itself the only honest wire producer.

A Layer-B transcript is **authored from real shapes**, never invented, and is
admitted only under ALL of:

1. **Uncapturable by construction** — the scenario provably cannot appear in
   any framework SDK's server-side stream; if a capture path exists, Layer A
   is the only route.
2. **Per-frame source-map provenance** — the provenance sidecar uses
   `kind: "authored"` and maps EVERY frame to the shipping code path that
   emits that byte shape in production. No source map, no enrollment.
3. **Producer-side refresh ritual** — the authoring project re-authors and
   re-files when its runtime's shapes change; the transcript is read-only
   here, exactly like a cassette. The stable/incidental contract above applies
   unchanged.
4. **Transcript-contract gate** — Layer-B transcripts do NOT ride the
   replay/census/fold machinery (they are host-plane wire, not normalizer
   input). Each enrolls with a dedicated CI gate asserting its declared
   stable set: frame ordering, tool/method names, structural shape, and
   cross-frame correlation *equalities* (the literal values stay incidental).

Precedent: `corpus/text-tool-turn/adk.native.json` shipped hand-authored
(`kind: "fixture"` provenance, openly documented) when no ADK runtime existed
to capture from — this tier formalizes that practice instead of leaving it
exceptional.

## Host-completion marker (optional last line)

Some frameworks write no in-band "the run finished" event (adk-js: "the
workflow's output is the last output on the stream"), so only the host knows a
run ended normally. A capture MAY therefore end with ONE recorded line:

```json
{ "type": "__host_complete__" }
```

- It is written only after the framework run returned normally, never after
  a cancel, an abort signal or a thrown error. The capture harness writes it on
  every `adk` capture (`capture-cli.ts` sets `CaptureDeps.hostCompletion`),
  because adk-js has no in-band run terminal.
- It is harness data, not framework wire. `replay.ts` (`splitHostCompleteMarker`)
  splits it off before the census runs, and reports `hostCompleted`. Only the
  LAST element counts, and only with no other key.
- Feeding it to a normalizer is that facet's own opt-in (AgJSON draft.4 §8.0
  host obligation 4: a host SHOULD feed a clean-completion event after a normal
  return). The google-adk facet opts in with `createAdkNormalizer({
  hostCompletion: true })`; replay and capture both feed it the marker after the
  natives. Every ADK golden replays byte-identically with or without the marker,
  because the facet's stashed close lands at the same seq
  (`adk-pause.test.ts`). A completed Workflow run is the case that differs:
  without the marker it flushes `turn.abort`, with it it closes success from
  `push()` (`corpus/workflow-complete-gemini38`).

If you replay cassettes yourself, strip a trailing marker line the same way
unless your normalizer is constructed to consume it.

## Engine-built fixtures (not corpus)

`packages/e2e/fixtures/adk-error/` holds ADK runs that meet in-band errors,
built by the REAL `@google/adk` engine: its runners (LoopAgent, ParallelAgent,
SequentialAgent, a Workflow with parallel nodes or a node retry, NodeTool) and
its own Gemini model class with the genai transport replaced (no key, no
network). A streaming call's chunks go through ADK's real SSE aggregator, so
the error events, and the aggregate that repeats one as a stream closes, are
the engine's own. The runs cover:
- a response-level block that carries a finish message, with usage on the
  finish chunk, with usage on a later chunk, after streamed text with no
  usage, and in progressive SSE;
- a first call blocked with no usage and no text, then a second call that
  streams text and ends on the same block;
- the same block met twice, by a LoopAgent and by a retried Workflow node;
- a ParallelAgent with one or two erroring branches, and a Workflow with two
  parallel nodes of which one is blocked, each in both arrival orders (the
  sibling completes in both);
- a rate-limit error, then a sub-agent that pauses on a credential request or
  on a request-input call;
- a node tool whose node meets a rate-limit error, then succeeds on retry;
- a SequentialAgent whose first sub-agent meets a rate-limit error while the
  second, or the second and third, answer; and a lone rate-limit error that
  ends the run;
- a Workflow node whose blocked call is not recovered, so the run throws;
- a credential pause whose step ends on a content-less usage report, so the
  model runs again and meets a rate-limit error (SSE);
- a confirmation pause in a non-last sub-agent, then a failed status on the
  next sub-agent's Interactions-route call;
- a signalled credential pause, then a rate-limit error that the same step's
  model stream yields, then a further model round; the pause stands (SSE);
- a credential call followed, in the same step, by a call whose before-tool
  callback throws: ADK never emits the credential request, so no ask reaches
  the wire and no pause is signalled, and the model runs again;
- a credential pause in a first sub-agent, then a rate-limit error in the
  second;
- a request-input call whose pause is never signalled (a later call's
  before-tool callback throws before the skip-summarization event), then a
  rate-limit error in the further model round. The first error does not end
  the invocation, since the model runs again; the rate-limit error does. No
  other engine path was found in which an error precedes the pause end.
- relays: ADK's `RemoteA2AAgent` relaying a remote ADK app served through
  ADK's own `A2AAgentExecutor` (the remote runs in the local run's streaming
  mode). A LoopAgent of two iterations whose sub-agents are the relay
  followed by an agent that replies in each iteration (the relay's second
  send forwards that reply), each remote run ending on the same
  response-level block with no streamed text, once with usage and once
  without; a remote call that streams text and then ends on a block; and one
  whose finish rides its text chunk. Without the replying agent the loop's
  second send carries no parts, and the remote fails before its model runs,
  so that tree cannot yield two blocked remote runs.

A host-terminal event after a credential pause needs no run of its own: feed
it after `adk-pause/plain-credential` (default mode) or
`adk-pause/after-pause-sse-credential` (SSE).

Each run is written in the default mode (`<leg>.none`) and in SSE
(`<leg>.sse`), except legs that exist in one mode only. A missing `.none` is
the default mode's behaviour, not an omission:
- `block-usage-on-finish`, `block-usage-later`, `text-then-block-no-usage` and
  `bare-block-then-streamed-block` pin the aggregate that repeats an error as a
  stream closes, which the default mode never yields;
- in `credential-pause-usage-report-then-429` and
  `credential-pause-stream-throw-then-rerun`, the pausing step ends on a
  content-less usage report, or its stream throws after the pause, only in
  SSE, so only there does ADK run the model again;
- in `parallel-workflow-one-block-a-first`, the failing node's only
  default-mode event also ends it, so no sibling can finish after it;
- `block-usage-on-finish.progressive` is SSE with ADK's progressive streaming
  on.

In the default mode a
blocked candidate is returned without its content, as the API withholds
blocked content. A run that throws from `runAsync` (a Workflow node that
fails for good) has a `<leg>.<mode>.sidecar.json` next to its natives, holding
the thrown error's `name` and `message`, which a host feeds as the
host-terminal event. They are regenerated only by
`GEN_ADK_ERROR=1 … adk-error-fixtures.gen.test.ts`, which checks each run's
error events, pauses and arrival order before it writes;
`GEN_ADK_ERROR_LEGS=<name,…>` (exact leg names) writes only those legs and
keeps every other fixture's bytes. A relay run's natives pass the same relay
reduction as the oracle set (`adk-relay-reduce.ts`: `a2a:request` keeps no
member; the task and context ids stay) before they are written.

`packages/e2e/fixtures/adk-pause/` holds ADK pause/completion streams built by
the REAL `@google/adk` engine with a stub model (no key, no network), plus two
truncations cut from a complete run. They exercise engine-produced shapes a
benign live capture cannot reliably reach (confirmation, credential and
request-input pauses, workflow pause/resume, truncation). They are NOT corpus
cassettes: they fail the acceptance filter's "real framework wire" test
because the model is a stub. They are regenerated only by
`GEN_ADK_PAUSE=1 … adk-pause-fixtures.gen.test.ts` and gated by
`adk-pause.test.ts` against AgJSON draft.4 §10 item 25. One more,
`plain-credential-authuri`, is an OAuth2 credential request whose auth URI
the engine itself generates (carrying `state`, `nonce` and a PKCE challenge),
with every credential member seeded by a `SEED_` placeholder. It has its own
gate, `GEN_ADK_AUTH_URI=1`, so regenerating it never rewrites the others.

`packages/e2e/fixtures/openai-hosted/` holds OpenAI Agents SDK runs that call
built-in (hosted) tools, built by the REAL `@openai/agents` streamed `run()`
over a structural fake Model (no key, no network, tracing off). agents-core
produces the run items, their order and their shapes. The raw Responses events
are the fake model's, modelled on the recorded function_call order. The runs
cover:
- a web_search_call plus a hosted mcp_call, then text;
- two hosted-MCP approval requests that interrupt the run;
- a client-executed shell_call round, then a second round;
- two approvals answered in the same invoke by `onApproval`;
- one approval answered on resume, approved and rejected (a two-invoke pair
  each, sharing its first invoke).

No recorded capture reaches these shapes, and the stub model keeps them out of
the corpus for the same reason as the ADK set. They are regenerated only by
`GEN_OPENAI_HOSTED=1 … openai-hosted-fixtures.gen.test.ts` and gated by
`openai-hosted.test.ts`.

`packages/e2e/fixtures/adk-oracle/` is ground truth for the google-adk
facet's text rendering. It holds streams built by the REAL `@google/adk`
runners (runAsync in SSE, progressive SSE and the default mode, and runLive)
over scripted transports: the Gemini client, the Chrome Prompt API, a Live
socket, and A2A peers (scripted, or the real A2AAgentExecutor over an ADK
app). No key and no network are used. Beside each stream, an oracle sidecar
names the text that each model call, remote window or Live turn was meant to
produce. For Gemini streams that text is what the transport actually
yielded; for the default mode, Chrome and Live it is the scripted reply; for
relays, callbacks and custom agents it is stated by the leg. Each unit names
its source (author, branch, node path, and a relay's window). The legs
cover:
- block and usage tails;
- function calls mid-stream;
- loop, parallel, Workflow and NodeTool roots;
- after-model callbacks that strip or replace a final; after-agent
  callbacks that add text or change state; before-model callbacks that
  answer a pass;
- plugins;
- Chrome streams;
- relay artifacts and status text, including the Python executor's legacy
  wire;
- Live usage, transcription and goAway resumption.

`adk-oracle.test.ts` folds every stream, bare and with host completion, and
checks the fold's text blocks against the intended text as a block partition.
It compares each fold's record (verdict, OVER / UNDER, park, the unit diff,
and whether a non-clean fold is by design, a stated residual or a known
defect) with `expected.json`, exactly in both directions: a fold that moves
either way fails until the expectations are re-stamped with
`ADK_ORACLE_WRITE=1`. The sets are regenerated only by
`GEN_ADK_ORACLE=1 … adk-oracle-fixtures.gen.test.ts`.
`GEN_ADK_ORACLE=check` regenerates into `.tmp/` and compares the records,
not the bytes, because streams carry random ids.

Two fidelity limits apply to these streams, beside the redaction every
committed native gets:
- Relay customMetadata entries are reduced to what the fold needs:
  `a2a:response` keeps `kind` and an artifact's `artifactId` (the relay
  stream a facet window rule keys on), the task and context ids stay, and
  any other relay entry keeps no member.
- A facet that starts reading any other member of those entries needs the
  set regenerated from the engine without the reduction, and its fixtures
  re-captured.
