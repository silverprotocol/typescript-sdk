# @silverprotocol/core

AgJSON core — the typed schema (`AgInput` / `AgEvent` / `AgMessage`),
the `Normalizer` interface, and the normative `reduce()`.

## Install

```sh
npm install @silverprotocol/core
```

Every `@silverprotocol/<framework>` normalizer package (e.g.
`@silverprotocol/claude-agent-sdk`) declares this as a required dependency —
you don't need to install it separately when using a facet.

## Usage

```ts
import { ingestAgEvents, Reducer, AGJSON_VERSION } from "@silverprotocol/core";

const raw = [
  { type: "turn.start", seq: 0, threadId: "th1", turnId: "t1" },
  { type: "message.start", seq: 1, id: "m1", role: "assistant", turnId: "t1", threadId: "th1" },
  { type: "message.end", seq: 2, id: "m1" },
];

const events = ingestAgEvents(raw); // parse-known-else-skip (consumer posture)

const reducer = new Reducer();
for (const ev of events) reducer.push(ev);
const result = reducer.result(); // { messages, turns, artifacts, memory }

console.log(AGJSON_VERSION, result.messages);
```

`ingestAgEvents` validates a batch of raw wire objects against `AgEvent` and
drops anything unparseable; `Reducer` folds a validated stream into the
normative state snapshot. `AGJSON_VERSION` is the wire-version string this
build of the SDK implements.

Spec: `SPEC.md` in the SilverProtocol workspace (published with the first
release); wire version `1.0.0-draft.1`.
