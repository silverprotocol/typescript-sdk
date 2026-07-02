# @silverprotocol/openai-agents

AgJSON normalizer for the OpenAI Agents SDK (`RunItemStreamEvent` / Responses
streaming → `AgEvent[]`) — fixture-tested.

## Install

```sh
npm install @silverprotocol/openai-agents
```

`@silverprotocol/core` is a required peer (installed automatically as a
dependency). `@openai/agents` is an OPTIONAL peer — only needed if you want
its native stream-event types; it is not required at import time.

## Usage

```ts
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";

const n = createOpenaiNormalizer();
const events = [];
for (const native of stream) events.push(...n.push(native));
events.push(...n.flush());
```

`stream` is whatever async/sync iterable of native OpenAI Agents SDK stream
events your run yields (`RunItemStreamEvent`s or raw Responses-API streaming
events, both are handled). `push()` returns the `AgEvent[]` synthesized from
that native event; `flush()` drains any buffered end-of-stream state.

Spec: `SPEC.md` in the SilverProtocol workspace (published with the first
release); wire version `1.0.0-draft.1`.
