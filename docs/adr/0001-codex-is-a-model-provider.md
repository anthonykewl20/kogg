---
status: accepted
---

# Treat Codex as a model provider, not an agent runtime

- **Date:** 2026-07-14
- **Related decision:** [ADR 0002 — Do not implement a Codex subscription provider](./0002-do-not-implement-codex-subscription-provider.md)

## Context

If OpenAI provides a supported ChatGPT subscription inference integration that
can fit Qwen Code's architecture, the integration needs a clear ownership
boundary. Qwen Code already owns prompts, orchestration, tools, approvals,
sessions, and user interaction.

## Decision

Any future OpenAI Codex subscription integration must act only as a Model
Provider. Qwen Code remains the Agent Runtime and retains ownership of prompts,
orchestration, tools, approvals, sessions, and UI. The provider must
authenticate independently; it must not invoke the official Codex runtime or
share Codex credential files.

This is a conditional architectural boundary, not a claim that a supported
integration currently exists. [ADR 0002](./0002-do-not-implement-codex-subscription-provider.md)
records the current no-go decision.

## Consequences

- A Codex agent-runtime integration cannot satisfy this boundary.
- Any future provider must use a public, supportable contract that leaves Qwen
  Code in control of agent behavior.
- Feasibility must be established independently before provider implementation
  begins.
