# @silverprotocol/google-adk

AgJSON normalizer for the Google Agent Development Kit (ADK `Event` / Gemini
`Content.parts[]` → `AgEvent[]`) — fixture-tested. It **sits on top of your ADK
runner** and translates the events it yields into framework-neutral AgJSON; it
doesn't replace the SDK you already use.

## Install

```sh
npm install @silverprotocol/google-adk @iqai/adk
```

`@silverprotocol/core` is a required peer (pulled in automatically). `@iqai/adk`
is the ADK-TS runtime itself — you need it to *produce* the events. (The
normalizer handles ADK `Event`s structurally, so if you only feed it
already-captured events it's just a type-level peer.)

## Usage

```ts
import { AgentBuilder } from "@iqai/adk";
import { createAdkNormalizer } from "@silverprotocol/google-adk";

// Build your ADK agent as usual — this package normalizes what it emits.
const { runner, session } = await AgentBuilder.create("assistant")
  .withModel("gemini-2.5-flash")
  .withInstruction("Use the echo tool.")
  .build();

const n = createAdkNormalizer();
const agEvents = [];

for await (const native of runner.runAsync({
  userId: session.userId, // the session build() created — must match, or "Session not found"
  sessionId: session.id,
  newMessage: { parts: [{ text: "call the echo tool" }] },
})) {
  agEvents.push(...n.push(native)); // one ADK Event → 0+ AgEvents
}
agEvents.push(...n.flush());        // seal anything still open
```

`push()` returns the `AgEvent[]` synthesized from each native ADK `Event`;
`flush()` drains buffered end-of-stream state. Any async/sync iterable of ADK
`Event`s works — a live `runAsync()` run, or events you captured earlier.

Then fold the resulting `AgEvent`s into messages and turns with
`@silverprotocol/core`'s `reduce()` — the same client code regardless of which
framework produced the stream.

Spec: [silverprotocol.io/AgJSON](https://silverprotocol.io/AgJSON) — canonical
in [silverprotocol/AgJSON](https://github.com/silverprotocol/AgJSON); wire
version `1.0.0-draft.1`.
