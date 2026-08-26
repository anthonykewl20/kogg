# Workflow graph and scheduler real-boundary probe

Disposable prototype for Kogg issue #100. It validates
`docs/v1/governed-task-loop/workflow.md`; this directory and the
`@kogg/workflow-prototype` extension are experimental and must not merge as
production implementation.

Run after repository setup:

```sh
volta run --node 22.23.2 node prototypes/workflow-boundary/probe.mjs
```

The probe bundles and launches the real Theia browser/backend, drives a visible
workflow widget through Playwright, persists one immutable template/run in SQLite
WAL, and registers real Node children with Kogg's production operation supervisor
before spawn. It exercises serial and parallel/condition nodes, a bounded retry,
cancellation, forced backend restart recovery, and closed cycle, trust-anchor
bypass, and authority-expansion refusals. It verifies debugger/source-map reach,
safe lifecycle traces, and zero residual prototype/operation processes.
