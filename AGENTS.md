# Kogg engineering gates

These instructions apply to every file in this repository and to every human or
AI-authored change.

## Mandatory observability gate

A feature, fix, integration, or customization is not complete unless it is
observable and debuggable under the rules in `docs/observability.md`.

Before declaring work complete, agents MUST:

1. Add or update logs for lifecycle boundaries, external calls, state-changing
   operations, and failures. Use Theia's `ILogger` with a `kogg:` logger name,
   or Theia-routed `console.debug/info/warn/error` with a `[kogg:<area>:<component>]`
   prefix.
2. Never log credentials, authorization values, cookies, prompts, source code,
   personal data, or raw provider/request/response bodies.
3. Preserve TypeScript and bundle source maps and verify that relevant frontend,
   backend, Electron, or extension code can be reached by a debugger.
4. Add tests for failure behavior and for any observability contract whose
   absence could prevent incident diagnosis.
5. Run `yarn audit:observability` (normally through `yarn test`) and treat any
   failure as release-blocking. Do not weaken, skip, or baseline the audit to
   make a feature pass.
6. Keep runtime diagnostics current. Every operational implementation file must
   declare `diagnostic-coverage: <catalog-id>` for a check in
   `diagnostics/catalog.json`, or a specific `diagnostic-exempt: <reason>`. New
   capabilities and failure modes require corresponding contributor checks;
   reusing an unrelated check is not valid coverage.

An `observability-exempt: <specific reason>` comment is permitted only for pure
declarations, generated glue, or an intentionally handled condition that is not
an operational failure. Generic reasons such as "not needed" are invalid.
