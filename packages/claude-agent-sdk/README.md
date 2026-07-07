# @silverprotocol/claude-agent-sdk

AgJSON normalizer for the Claude Agent SDK (`SDKMessage` → `AgEvent[]`) — the
live path. It **sits on top of your Claude Agent SDK run** and translates its
native event stream into framework-neutral AgJSON; it doesn't replace or wrap
the SDK you already use.

## Install

```sh
npm install @silverprotocol/claude-agent-sdk @anthropic-ai/claude-agent-sdk
```

`@silverprotocol/core` is a required peer (pulled in automatically).
`@anthropic-ai/claude-agent-sdk` is the Claude Agent SDK itself — you need it
to *produce* the stream. (The normalizer guards `SDKMessage` structurally, so
if you only ever feed it already-captured events it's just a type-level peer.)

## Usage

```ts
// `query` is the Claude Agent SDK's own streaming call — you keep using
// your framework as-is; this package only normalizes what it emits.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";

const n = createClaudeNormalizer();
const events = [];

for await (const native of query({ prompt: "call the echo tool" })) {
  events.push(...n.push(native)); // one SDKMessage → 0+ AgEvents
}
events.push(...n.flush());        // seal anything still open at end-of-stream
```

`push()` returns the `AgEvent[]` synthesized from each native `SDKMessage`;
`flush()` drains buffered end-of-stream state. Any async/sync iterable of
`SDKMessage` works — a live `query()` run, or messages you captured earlier.
Malformed input never throws — it routes through the lossless
`ext.anthropic.unparsed` channel instead.

Then fold the resulting `AgEvent`s into messages and turns with
`@silverprotocol/core`'s `reduce()` — the same client code regardless of which
framework produced the stream.

Spec: [silverprotocol.io/AgJSON](https://silverprotocol.io/AgJSON) — canonical
in [silverprotocol/AgJSON](https://github.com/silverprotocol/AgJSON); wire
version `1.0.0-draft.1`.
