# `src/agents/claude-agent-sdk` — Standalone Claude Capture Agent

Minimal standalone agent for the E2E conformance harness. Runs a real Claude
Agent SDK `query()` and yields the **RAW native `SDKMessage` stream** as
`JsonValue` items — unnormalized. The harness captures this stream and pipes it
through the normalizer under test in a separate step.

This is also the de-ggui'd replacement for the silverprotocol example agent.

## Files

| File | Purpose |
|---|---|
| `run.ts` | Agent implementation + `CaptureRunInput` interface |
| `run.smoke.test.ts` | Import-doesn't-throw + AsyncIterable shape smoke tests |

## Key design decisions

### No module-load CLI resolution

SDK `@anthropic-ai/claude-agent-sdk@0.2.141` ships a **native binary** and
self-resolves it at run time. The `resolveClaudeCliPath` / `spawnClaudeCli`
pattern from the `../ggui` sample agent is deliberately absent — it would
throw at module-load on this SDK version.

`query()` is called **without** `pathToClaudeCodeExecutable` and **without**
`spawnClaudeCodeProcess`.

### Zero `@ggui-ai/*` imports

No `GGUI_AGENT_SYSTEM_PROMPT`, no `DEFAULT_ALLOWED_TOOLS`, no
`sdkMessageToNormalized`. `JsonValue` comes from `@silverprotocol/core`.

### JSON round-trip tap

```ts
yield JSON.parse(JSON.stringify(msg)) as JsonValue;
```

This materializes the whole raw message (including fields typed `unknown` by
the SDK, e.g. the `tool_use_result` sibling on `SDKUserMessage`) into plain
`JsonValue` with no per-field cast.

### AbortSignal → AbortController bridge

The SDK takes an `AbortController`; the harness interface exposes an
`AbortSignal`. The bridge forwards the signal's abort event onto a fresh
controller.

## Usage (operator / Task 7)

```ts
import { runClaudeCapture } from "./run.js";

for await (const msg of runClaudeCapture({
  prompt: "What time is it?",
  mcpServers: {
    "my-server": { url: "https://...", bearer: "token" },
  },
  allowedTools: ["mcp__my-server__get_time"],
  apiKey: process.env.ANTHROPIC_API_KEY,
})) {
  console.log(JSON.stringify(msg));
}
```

`ANTHROPIC_API_KEY` must be set (via `input.apiKey` or the env var) before
the **first `next()` call** on the iterator. Omitting it throws a clear error
at that point, not at import time.
