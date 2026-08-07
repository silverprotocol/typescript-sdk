# The cassette corpus — consumer contract

`packages/e2e/corpus/` is a corpus of **real captured agent-framework wire**: for
each `<scenario>/<framework>` pair, a cassette of native events
(`<framework>.native.json`), the golden normalized AgJSON stream produced from it
(`<framework>.agjson.json`), a coverage sidecar (`<framework>.coverage.json`,
harness-internal), and a provenance sidecar (`<framework>.provenance.json` —
which SDK version, model, and date produced the capture).

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
