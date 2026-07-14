# Context Map

## Contexts

- [Model Providers](./packages/core/CONTEXT.md) — defines provider identity, authenticated sessions, model availability, and runtime compatibility
- [Terminal Client](./packages/cli/CONTEXT.md) — presents authentication, account status, and model selection to terminal users

## Relationships

- **Terminal Client → Model Providers**: The Terminal Client establishes a Provider Session and presents its Entitled Models for selection.
- **Model Providers → Agent Runtime**: A Model Provider supplies compatible inference while the Qwen Code Agent Runtime retains ownership of orchestration and tools.
