---
status: accepted
---

# Do not implement a Codex subscription provider

- **Date:** 2026-07-14
- **Issue:** [#6 — Choose the OpenAI Codex Provider architecture](https://github.com/anthonykewl20/kogg/issues/6)
- **Related boundary:** [ADR 0001 — Treat Codex as a model provider, not an agent runtime](./0001-codex-is-a-model-provider.md)

## Context

The project investigated whether ChatGPT subscription access can back an
independent Qwen Code Model Provider while Qwen remains the Agent Runtime. The
research found no public contract for third-party ChatGPT OAuth client
registration, direct subscription inference, or capability metadata sufficient
to identify Core-compatible Models:

- [OpenAI Codex subscription integration boundary](../research/openai-codex-subscription-integration-boundary.md)
- [Qwen Code provider, authentication, and secure-storage seams](../research/qwen-provider-auth-storage-seams.md)
- [Supported OpenAI Codex authentication contract](../research/openai-codex-authentication-contract.md)
- [OpenAI Codex subscription inference and entitlement contract](../research/openai-codex-subscription-inference-entitlements.md)

OpenAI documents App Server, the Codex SDK, and Codex MCP as agent-runtime
integration seams. They assign authentication, prompts, state, tool operation,
and inference to Codex, which conflicts with ADR 0001.

## Decision

Preserve Qwen Code as the Agent Runtime and do not implement the proposed
OpenAI Codex subscription provider. This is a current supportability no-go, not
a claim that such an integration is permanently technically impossible.

The selected architecture is intentionally the existing architecture, with no
Codex-specific additions:

| Issue #6 dimension                   | Decision                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------- |
| Core/CLI ownership seam or component | Add none. Qwen's existing ownership boundary remains unchanged.            |
| Provider identity and configuration  | Define no provider id, auth type, settings, or setup entry.                |
| Inference adapter                    | Add no subscription transport or content-generator adapter.                |
| Entitlement catalog and cache        | Add no catalog client, cache, or Core Compatibility classifier.            |
| Credential namespace                 | Add no Codex credential store, token lifecycle, or shared credential path. |
| Capability representation            | Add no Codex capability fields or model metadata.                          |
| Migration and backward compatibility | Add no migration, compatibility shim, or persisted state.                  |
| Dependency direction                 | Add no Codex CLI, App Server, SDK, MCP, protocol, or source dependency.    |

ADR 0001 remains accepted as the boundary for a possible future provider. It
does not authorize implementation without a supported contract.

## Rejected alternatives

- **Redraw Qwen around App Server, the Codex SDK, or Codex MCP.** These are
  agent-runtime seams in which Codex owns behavior that ADR 0001 assigns to
  Qwen. App Server also remains an experimental command.
- **Copy source-observed OAuth or subscription-inference behavior.** Public
  source explains the official runtime but does not provide third-party client
  registration, authorization, or a stable service contract.
- **Treat the OpenAI Platform API as ChatGPT subscription access.** Platform
  API keys and usage billing describe a separate provider, not inference
  included with a ChatGPT subscription.

## Consequences

- Issues #7–#11 are invalidated discovery and specification work: there is no
  supported Provider Session, terminal flow, threat model, release gate, or
  implementation-ready architecture to define under the preserved boundary.
- Issues #12–#20 are invalidated specification, implementation, validation, and
  release work. Their planned provider does not have a supportable foundation.
- Those downstream issues should be closed as **not planned**, not described as
  resolved or implemented. The Wayfinder map can close after it records this
  decision and the invalidation.
- Existing generic provider, authentication, model, and secure-storage code is
  unchanged.

## Reconsideration criteria

Open a fresh architecture effort only if OpenAI supplies a complete public and
distributable contract, or an equivalent written contract, that covers:

1. authorized third-party authentication and client registration;
2. direct ChatGPT subscription inference while Qwen retains orchestration;
3. authoritative entitlement and capability discovery sufficient to identify
   Core-compatible Models; and
4. applicable terms, distribution rights, and a supportability commitment.

Reconsideration must still preserve ADR 0001's Qwen-owned Agent Runtime
boundary. A new Codex agent-runtime seam would require a separate product and
architecture decision rather than reopening this provider plan unchanged.
