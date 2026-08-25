# Observability and debugging standard

Kogg customizations use Eclipse Theia's logging pipeline and source-map based
debugging. Observability is a mandatory engineering and release gate, not a
follow-up task.

## Logging contract

Operational code must emit logs at the points needed to reconstruct an
operation without exposing its contents:

- component initialization and shutdown;
- external process, network, registry, provider, and filesystem boundaries;
- security and policy decisions;
- state-changing operations; and
- failures, retries, degradation, and recovery.

Prefer an injected Theia `ILogger` named `kogg:<area>:<component>`. Root-level
code may use `console.debug`, `console.info`, `console.warn`, or `console.error`;
Theia routes these calls through its logger. The first argument must begin with
`[kogg:<area>:<component>]` and a stable, searchable event name should follow.

Examples:

```ts
console.info('[kogg:marketplace:resolver] install.completed', { packageId });
console.error('[kogg:kernel:bridge] request.failed', safeError(error));
```

Use `debug` for diagnostic detail, `info` for meaningful lifecycle/state
changes, `warn` for recoverable degradation, and `error` for failed operations.
Logs must not be the only user-facing error handling.

Never log secrets or content-bearing data: credentials, tokens, authorization
headers, cookies, environment dumps, prompts, source code, personal data, or raw
request/response bodies. Log stable identifiers, counts, durations, status codes,
and sanitized error type/message instead.

Expected conditions may be deliberately unlogged only with an adjacent
`observability-exempt: <specific reason>` comment. The audit rejects silent catch
blocks and vague exemptions.

## Debugging contract

- `tsconfig.base.json` must keep `sourceMap` and `declarationMap` enabled.
- Generated Theia esbuild options and source-map path rewriting must be
  preserved in browser and Electron applications.
- A change spanning process boundaries must be debugged in every affected
  runtime: browser frontend, Node backend, Electron main/renderer, or plugin host.
- Async errors must retain their original cause where practical.
- Tests must cover the principal failure path, not only the happy path.

Run a product with `--log-level=debug` for global diagnostics. Use
`--log-config <file>` for component-specific levels such as `kogg:kernel:*` or
`kogg:marketplace:*`.

## Gate

`yarn audit:observability` performs the repository audit. It verifies source-map
settings, rejects unsafe or nonstandard logging, rejects silent catch blocks,
validates exemption comments, and enforces diagnostic freshness. Every
operational implementation declares `diagnostic-coverage` for one or more IDs in
`diagnostics/catalog.json`, or a specific `diagnostic-exempt` reason. Catalogued
checks must have runtime implementations. `yarn test` includes this audit, so CI
blocks merges when the contract is violated.
