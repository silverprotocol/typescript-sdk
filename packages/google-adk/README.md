# @silverprotocol/google-adk

AgJSON normalizer for the **official Google Agent Development Kit** —
[`@google/adk`](https://github.com/google/adk-js) (ADK `Event` / Gemini
`Content.parts[]` → `AgEvent[]`). It **sits on top of your ADK runner** and
translates the events it yields into framework-neutral AgJSON; it doesn't
replace the SDK you already use.

## Install

```sh
npm install @silverprotocol/google-adk @google/adk
```

`@silverprotocol/core` is a required peer (pulled in automatically). `@google/adk`
is the Google ADK itself — you need it to *produce* the events. (The normalizer
guards ADK `Event`s structurally, so if you only feed it already-captured events
it's just a type-level peer.)

## Usage

```ts
import { LlmAgent, InMemoryRunner } from "@google/adk";
import { createAdkNormalizer } from "@silverprotocol/google-adk";

// Build your ADK agent + runner as usual — this package normalizes what it emits.
const agent = new LlmAgent({
  name: "assistant",
  model: "gemini-3.5-flash",
  instruction: "Use the echo tool.",
});
const runner = new InMemoryRunner({ agent });
const session = await runner.sessionService.createSession({
  appName: runner.appName,
  userId: "user-1",
});

const n = createAdkNormalizer();
const agEvents = [];
for await (const native of runner.runAsync({
  userId: session.userId, // must match the session you created
  sessionId: session.id,
  newMessage: { role: "user", parts: [{ text: "call the echo tool" }] }, // role is REQUIRED: adk-js drops role-less turns from tool-loop replays (400)
}))
  agEvents.push(...n.push(native)); // one ADK Event → 0+ AgEvents
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
