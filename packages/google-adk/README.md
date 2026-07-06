# @silverprotocol/google-adk

AgJSON normalizer for the Google Agent Development Kit (ADK `Event` / Gemini
`Content.parts[]` → `AgEvent[]`) — fixture-tested.

## Install

```sh
npm install @silverprotocol/google-adk
```

`@silverprotocol/core` is a required peer (installed automatically as a
dependency). `@iqai/adk` is an OPTIONAL peer — only needed if you want its
native ADK `Event` types; it is not required at import time.

## Usage

```ts
import { createAdkNormalizer } from "@silverprotocol/google-adk";

const n = createAdkNormalizer();
const events = [];
for (const native of stream) events.push(...n.push(native));
events.push(...n.flush());
```

`stream` is whatever async/sync iterable of native ADK `Event`s your agent
run yields. `push()` returns the `AgEvent[]` synthesized from that native
event; `flush()` drains any buffered end-of-stream state.

Spec: `SPEC.md` at the repo root of [silverprotocol/typescript-sdk](https://github.com/silverprotocol/typescript-sdk) (published with the first
release); wire version `1.0.0-draft.1`.
