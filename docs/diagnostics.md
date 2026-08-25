# Kogg runtime diagnostics

Kogg combines Theia's logging and debugging facilities with product-specific,
read-only health checks. Open the command palette and run:

- `Kogg: Run Diagnostics` for a pass/warn/fail summary; or
- `Kogg: Export Diagnostic Support Bundle` to generate and open a redacted JSON
  report.

The current catalog covers runtime configuration, browser authentication, Ranex
health and journal integrity, signed marketplace configuration/reachability and
installed state, and provider/credential-metadata availability. The canonical
list is `diagnostics/catalog.json`.

Support bundles are created under the Kogg state directory in `support/` with
owner-only file permissions where the operating system supports them. They do
not contain credential contents, accounts, registry addresses, prompts, source
code, request or response bodies, or raw exception messages. Sensitive keys and
token-shaped values are recursively redacted before serialization.

## Contributor contract

Each backend subsystem contributes independent checks through
`KoggDiagnosticContribution`. A failing contributor becomes a failed diagnostic
check and does not prevent other subsystems from reporting.

Every operational browser or backend implementation must declare either:

```ts
// diagnostic-coverage: marketplace.registry
```

or a precise exemption:

```ts
// diagnostic-exempt: This file contains declarative view wiring only; runtime behavior is covered by the widget service check.
```

Coverage IDs must exist in `diagnostics/catalog.json`, and every catalog entry
must occur in a runtime implementation. `yarn audit:observability` enforces both
directions and runs inside `yarn test`, making stale diagnostics a CI failure.

