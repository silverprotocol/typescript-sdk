<p align="center">
  <img src="https://silverprotocol.io/hero.png" width="200" alt="A glass prism splitting a beam of white light into a rainbow" />
</p>

<h1 align="center">@silverprotocol/core</h1>

<p align="center">
  <b>AgJSON</b> — the open, typed transport for normalized agent-framework I/O, unopinionated about storage and rendering.<br/>
  The core package: the typed schema, the <code>Normalizer</code> contract, and the normative <code>reduce()</code>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@silverprotocol/core"><img src="https://img.shields.io/npm/v/%40silverprotocol%2Fcore?color=0a7"></a>
  <a href="https://github.com/silverprotocol/AgJSON/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://silverprotocol.io/AgJSON"><img src="https://img.shields.io/badge/spec-1.0.0--draft.5-6ee7ff"></a>
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

const events = ingestAgEvents(rawWireObjects, {
  onReject: ({ input, reason }) => console.warn("not an AgJSON event:", reason, input),
});

const reducer = new Reducer();
for (const ev of events) reducer.push(ev);

const { messages, turns, artifacts, memory } = reducer.result();
console.log(AGJSON_VERSION, messages);
```

`ingestAgEvents` validates raw wire objects against `AgEvent` and never throws
(the consumer posture). Unknown fields pass through at every depth. An event it
cannot validate (a newer event type, an unknown enum value, a malformed known
type) is not folded: it rides in place as `{type: "ext.agjson.ignored", seq,
ignoredType, raw}`, which keeps its `seq` slot so the `Reducer` never mistakes it
for a gap. `raw` is for live inspection only; don't persist it. Input that is not
an event at all (not an object, no string `type`, no number `seq`) returns
nothing and goes to the optional `onReject` callback. `Reducer` folds the
validated stream into the normative snapshot; `AGJSON_VERSION` is the wire
version this build implements (`1.0.0-draft.5`).

### Stored records and inputs

Messages and memory records you read back from storage, and inputs a client
sends, follow the same forward-compatible posture (AgJSON draft.4 §0.2):

```ts
import { readStoredAgMessages, readStoredAgMemoryRecords, checkAgInput } from "@silverprotocol/core";

const { value: messages, reports } = readStoredAgMessages(rowsFromYourStore);
for (const r of reports) console.warn("unreadable", r.path, r.ignoredType, r.raw);

const checked = checkAgInput(requestBody);
if (!checked.ok) return reply(400, { code: checked.code, path: checked.path }); // "unknown-value" | "malformed" | "major-mismatch"
```

- `readStoredAgMessage(s)` and `readStoredAgMemoryRecords` omit what they
  cannot read and report it: a `content` element that fails at any depth is
  omitted whole, and a record that fails is omitted from its array. Each report
  carries its `path`, the element's `type` when it has one, and the verbatim
  value, so inserting every report back at its index rebuilds the stored
  record. Unknown fields pass through at every depth; nothing is coerced. What
  they return is a view: keep storing and forwarding the record as received,
  never the view. A record carried inside an event keeps the event rule above:
  a `messages.snapshot` with one unknown block is ignored whole, so it cannot
  resync a parked live fold, while the same message read from storage keeps its
  readable blocks.
- `checkAgInput` rejects the whole input, before you act on any of it, when it
  fails the schema in any way other than an unknown field, and names one path
  and one class. `unknown-value`: a string outside a closed set this version
  defines (a `kind`, an answer `status`, a reasoning `effort`, a block `type` in
  `messages`, `run.system`, `run.context` or `results[].content`, …).
  `major-mismatch`: another major `version`. `malformed`: everything else,
  including a missing value, a wrong JSON type, a non-object input, or a
  `protocol` other than `"agjson"`. It judges `protocol` first, then `version`,
  then the rest; it checks the envelope members whatever the `kind`, and when
  the rest has both kinds of problem the class is `malformed`. An accepted
  input comes back with its unknown fields intact.
- `validateHitlAnswer` rejects an answer whose `status` is not a defined one
  (`unknown-status`), so an unrecognized status is never read as a grant.

### Persisting a fold

A turn record's `displayRequired[]` carries grounding UI that the provider
requires a display to render (for example Google Search Suggestions), and the
provider's terms may not allow storing it. Persist `toPersistable(result)`, the
same fold with every turn record's `displayRequired` omitted and nothing else
changed, unless the grounding provider's terms permit storing
`displayRequired` (SPEC §13.3, "Grounding records and the host"). Those terms
can also limit how long a turn's `sources[]` and grounded content are kept and
who they are re-displayed to; `toPersistable` leaves them in the fold, so apply
the terms to them yourself.

```ts
import { toPersistable } from "@silverprotocol/core";

await store.save(toPersistable(reducer.result()));
```

Memory records follow the same rule. A `memory.write` of scope `agent`, `user`
or `skill` records a write to the producer's own cross-thread store, not a
promise that you keep it. `toPersistable` keeps scope `thread` memory and
omits every other record unless you declare the non-thread scopes you persist
(SPEC §8.0 host obligation 7), and each omission is reported to you by
`toPersistableWithReport`; `toPersistable` returns the projection alone:

```ts
import { toPersistableWithReport } from "@silverprotocol/core";

const { result, omitted } = toPersistableWithReport(reducer.result(), { memoryScopes: ["user"] });
for (const o of omitted) log.info("memory not persisted", o.scope, o.key);
await store.save(result);
```

If you emit `agent.capabilities`, declare the same list there as
`memoryScopes`.

## Produce AgJSON

Turn a framework's native stream into AgJSON with its normalizer — the output is
framework-neutral, ready to send over the wire, persist, or feed straight to the
`Reducer` above:

```ts
// `query` is the Claude Agent SDK's own streaming call — you keep using
// your framework as-is; the normalizer just translates what it emits.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";

const n = createClaudeNormalizer();
const agEvents = [];
for await (const native of query({ prompt: "call the echo tool" }))
  agEvents.push(...n.push(native)); // one native event → 0+ AgEvents
agEvents.push(...n.flush());        // seal anything still open
```

## Learn more

- **Spec & docs** — [silverprotocol.io/AgJSON](https://silverprotocol.io/AgJSON)
- **Flagship, examples & discussion** — [github.com/silverprotocol/AgJSON](https://github.com/silverprotocol/AgJSON)
- **This SDK** — [github.com/silverprotocol/typescript-sdk](https://github.com/silverprotocol/typescript-sdk)

## License

MIT
