<p align="center">
  <img src="https://silverprotocol.io/hero.png" width="200" alt="A glass prism splitting a beam of white light into a rainbow" />
</p>

<h1 align="center">@silverprotocol/core</h1>

<p align="center">
  <b>AgJSON</b> — the open, neutral, typed transport for normalized agent-framework I/O.<br/>
  The core package: the typed schema, the <code>Normalizer</code> contract, and the normative <code>reduce()</code>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@silverprotocol/core"><img src="https://img.shields.io/npm/v/%40silverprotocol%2Fcore?color=0a7"></a>
  <a href="https://github.com/silverprotocol/AgJSON/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://silverprotocol.io/AgJSON"><img src="https://img.shields.io/badge/spec-1.0.0--draft.1-6ee7ff"></a>
</p>

---

Every agent framework — Claude Agent SDK, OpenAI Agents SDK, Google ADK, LangGraph,
Vercel AI SDK — streams its own shape of events. Build a client, a UI, or a tool
that works across more than one and you end up writing a bespoke adapter per
framework.

**AgJSON is the wire format that ends that.** It normalizes any framework's native
event stream into one typed, versioned, forward-compatible shape — so a client
written once works with every framework a normalizer exists for.

## What's in `core`

- **The schema** — `AgInput`, `AgEvent`, `AgMessage`, `AgReduceResult`, all as
  discriminated unions (typed, never `any`) with Zod validators.
- **The `Normalizer` contract** — the stateful, per-invoke
  `push(native): AgEvent[]` / `flush(): AgEvent[]` interface every
  `@silverprotocol/<framework>` package implements.
- **`reduce()`** — the normative fold from an `AgEvent` stream into the
  messages / turns / artifacts object graph your client renders.

## Install

```sh
npm install @silverprotocol/core
```

To actually **produce** AgJSON from a framework, add its normalizer:

```sh
npm install @silverprotocol/claude-agent-sdk
# or @silverprotocol/openai-agents / @silverprotocol/google-adk
```

## Consume AgJSON

`core` is the consumer side — validate an incoming event stream and fold it into
the object graph, with the same code regardless of which framework produced it:

```ts
import { ingestAgEvents, Reducer, AGJSON_VERSION } from "@silverprotocol/core";

const events = ingestAgEvents(rawWireObjects); // parse-known-else-skip

const reducer = new Reducer();
for (const ev of events) reducer.push(ev);

const { messages, turns, artifacts, memory } = reducer.result();
console.log(AGJSON_VERSION, messages);
```

`ingestAgEvents` validates raw wire objects against `AgEvent` and drops anything
unparseable (the consumer posture); `Reducer` folds the validated stream into the
normative snapshot; `AGJSON_VERSION` is the wire version this build implements
(`1.0.0-draft.1`).

## Produce AgJSON

Turn a framework's native stream into AgJSON with its normalizer — the output is
framework-neutral, ready to send over the wire, persist, or feed straight to the
`Reducer` above:

```ts
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";

const n = createClaudeNormalizer();
const agEvents = [];
for await (const native of claudeStream) agEvents.push(...n.push(native));
agEvents.push(...n.flush());
```

## Learn more

- **Spec & docs** — [silverprotocol.io/AgJSON](https://silverprotocol.io/AgJSON)
- **Flagship, examples & discussion** — [github.com/silverprotocol/AgJSON](https://github.com/silverprotocol/AgJSON)
- **This SDK** — [github.com/silverprotocol/typescript-sdk](https://github.com/silverprotocol/typescript-sdk)

## License

MIT
