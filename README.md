# @silverprotocol/typescript-sdk

The TypeScript SDK for **AgJSON** — the open, neutral, typed transport for
normalized agent-framework I/O. Open source (MIT).

## Install

```bash
npm install @silverprotocol/core @silverprotocol/claude-agent-sdk
# or openai-agents / google-adk for other frameworks
```

## Packages

- **`@silverprotocol/core`** — the AgJSON types (`AgInput`, `AgEvent`,
  `AgMessage`, `AgReduceResult`), the stateful-per-invoke `Normalizer` interface
  (`push(native): AgEvent[]` / `flush(): AgEvent[]`), and the normative `Reducer`
  and `reduce()` (stream → object graph).
- **`@silverprotocol/<framework>`** — per-framework normalizers
  (`claude-agent-sdk`, `openai-agents`, `google-adk`, …) that translate each
  framework's native events ⇄ AgJSON. **Producers** ship a `createXNormalizer()`
  function; **consumers** use `ingestAgEvent()` or `AgEvent.parse()` to validate
  and load AgJSON from the wire.
- **`AGJSON_VERSION`** — the wire schema version (`1.0.0-draft.1`).

The **Normalizer contract**: stateful-per-invoke, lifetime-scoped normalizer
that batches native events into normalized `AgEvent[]` via `push()`, then
finalizes with `flush()` to seal pending turns and close the output stream.

The **AgJSON spec** ships with the SilverProtocol workspace and publishes with
the first release (wire version `1.0.0-draft.1`). This repository is
subtree-vendored from the private SilverProtocol workspace — issues and PRs
are welcome here.
