# Model Providers

The Model Providers context describes external model inference available to the Qwen Code Agent Runtime, including authentication, model availability, and compatibility.

## Language

**Agent Runtime**:
The Qwen Code experience that owns conversation orchestration, tools, approvals, sessions, and user interaction.
_Avoid_: Codex runtime, provider runtime

**Model Provider**:
An external inference service used by the Agent Runtime without taking ownership of agent behavior.
_Avoid_: Agent, runtime

**OpenAI Codex Provider**:
A proposed, currently unsupported public Model Provider concept for using
Codex access granted by a ChatGPT account or workspace. It is not an available
integration.
_Avoid_: GPT Codex Pro provider, Pro provider

**Provider Session**:
The single active account and workspace through which a Model Provider authorizes inference.
_Avoid_: API key, saved account

**Entitled Model**:
A model the provider reports as available to the active Provider Session.
_Avoid_: Pro model, hardcoded model

**Core-compatible Model**:
An Entitled Model that supports streaming text, multi-turn context, and tool calling required by the Agent Runtime.
_Avoid_: supported model

**Optional Model Capability**:
An additional model feature that the Agent Runtime may enable without making it a condition of Core Compatibility.
_Avoid_: required capability
