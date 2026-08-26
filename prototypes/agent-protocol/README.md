# Agent protocol real-boundary probe

Disposable prototype for Kogg issue #81. It exercises the normative
`docs/v1/governed-task-loop/agent-protocol.md` contract and must not merge as a
production adapter.

```sh
yarn setup
volta run --node 22.23.2 node prototypes/agent-protocol/probe.mjs
```

The probe registers real Codex and deterministic fake adapter-host processes in
Kogg's production operation supervisor before spawn. It verifies the Codex
app-server initialize handshake, normalizes fake activity/usage/completion,
proves provider completion is not process cleanup, cancels the live host, and
exercises malformed, handshake-timeout, and crash failures with safe lifecycle
events and zero residual children.
