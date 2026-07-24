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
