# @silverprotocol/typescript-sdk

The TypeScript SDK for **AgJSON** — the open, neutral, typed transport for
normalized agent-framework I/O. Open source (MIT).

- **`@silverprotocol/core`** — the AgJSON types (`AgentInput` / `AgentEvent` /
  `AgentMessage` / `AgentReduceResult`), the `Normalizer` interface, and the
  normative `reduce()` (stream → object).
- **`@silverprotocol/<framework>`** — per-framework normalizers
  (`claude-agent-sdk`, `openai-agents`, `google-adk`, …) that translate each
  framework's wire I/O ⇄ AgJSON, losslessly.

A normalizer is pure: framework I/O ⇄ AgJSON. Structural mappings ship as portable
rules; stateful bits drop to TypeScript (see the spec's §8 normalization points).

Spec: <https://silverprotocol.io/AgJSON>. This repository is subtree-vendored from
the private SilverProtocol workspace — issues and PRs are welcome here.
