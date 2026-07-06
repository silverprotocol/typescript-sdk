# @silverprotocol/claude-agent-sdk

AgJSON normalizer for the Claude Agent SDK (`SDKMessage` → `AgEvent[]`) — the
live path.

## Install

```sh
npm install @silverprotocol/claude-agent-sdk
```

`@silverprotocol/core` is a required peer (installed automatically as a
dependency). `@anthropic-ai/claude-agent-sdk` is an optional peer — only
needed if you want its types alongside this package's own `SDKMessage`
guards; it is not required at import time.

## Usage

```ts
import { createClaudeNormalizer } from "@silverprotocol/claude-agent-sdk";

const n = createClaudeNormalizer();
const events = [];
for (const native of stream) events.push(...n.push(native));
events.push(...n.flush());
```

`stream` is whatever async/sync iterable of `SDKMessage` your Claude Agent
SDK run yields. `push()` returns the `AgEvent[]` synthesized from that native
message; `flush()` drains any buffered end-of-stream state. Malformed input
never throws — it routes through the lossless `ext.anthropic.unparsed`
channel instead.

Spec: `SPEC.md` at the repo root of [silverprotocol/typescript-sdk](https://github.com/silverprotocol/typescript-sdk) (published with the first
release); wire version `1.0.0-draft.1`.
