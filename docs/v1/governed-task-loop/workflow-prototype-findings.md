# Workflow scheduler real-boundary prototype findings

Tracking: [#100](https://github.com/anthonykewl20/kogg/issues/100), parent
[#87](https://github.com/anthonykewl20/kogg/issues/87), and production phase
[#101](https://github.com/anthonykewl20/kogg/issues/101).

## Verdict

The bounded prototype validates the core decisions in
[`workflow.md`](workflow.md): an immutable workflow version can be projected in a
real Theia widget, executed through a backend-owned durable state machine, and
correlated with real child processes registered in Kogg's production operation
supervisor before spawn. Serial, parallel, typed-condition, bounded-retry,
cancellation, and restart-recovery paths were exercised. Cyclic, mandatory-anchor
bypass, and authority-expanding graphs failed closed before execution.

The prototype is experimental evidence, not production implementation. Its code
is preserved only on branch `prototype/issue-100-workflow-boundary` at commit
`48e82e79f840552651a2cd5184cbbcfaa79dc2b8`. It must not be merged or shipped.
Production issue #101 remains responsible for the complete compiler, schemas,
stores, diagnostics, provider/Ranex/merge integration, accessibility, platform
qualification, and human-level E2E fixed by the pseudocode.

## Reproduction and qualification

The probe was run on macOS with Node 22.23.2 against the repository state after
#99 merged. It used an ephemeral workspace, application state, workflow store,
loopback port, browser session, and authentication value, and deleted them after
the run.

```sh
git switch prototype/issue-100-workflow-boundary
yarn setup
yarn browser bundle
volta run --node 22.23.2 node prototypes/workflow-boundary/probe.mjs
volta run --node 22.23.2 yarn test
```

Observed results on 2026-08-27:

- the headless Chromium client authenticated to and drove the real bundled Theia
  browser/backend through the command palette and visible workflow widget;
- the probe printed `Kogg workflow real-boundary prototype passed.`;
- all 41 repository unit tests passed;
- the branding audit passed;
- `yarn audit:observability` passed with 69 operational source files inspected;
- frontend bundle source maps existed and the Node backend emitted an inspector
  endpoint, proving both prototype boundaries are debugger-reachable; and
- the final visible and logged process count was zero with no residual-process
  classification.

This is a macOS prototype qualification only. Cross-platform production support
is not inferred from it. #101 must run the repository-required macOS, Ubuntu, and
Windows CI plus real browser and Electron E2E on each qualified execution model.

## Boundary evidence

The prototype installed a disposable Theia frontend contribution and JSON-RPC
service. The widget rendered the immutable template version and 64-character
digest, safe run status, event count, process count, node kind/state, and attempt
number. Reload after a forced backend termination showed the same digest.

The backend persisted one immutable template/run projection in SQLite with WAL
and full synchronous writes. Each real Node child was reserved in the production
`@kogg/operations` registry before `spawn`, then advanced through spawn, ready,
exit, and cleanup. The probe required both workflow and operation-registry
registration events and workflow cleanup events before accepting success.

The visible scenarios established:

| Scenario | Observed result |
| --- | --- |
| cyclic graph | refused with `WORKFLOW_CYCLE` |
| trust-anchor bypass | refused with `WORKFLOW_ANCHOR_BYPASS` |
| requested authority expansion | refused with `WORKFLOW_AUTHORITY_EXPANSION` |
| serial then parallel/condition execution | terminal `WORKFLOW_OK`; producer and condition nodes completed |
| bounded retry | condition node reached attempt 2 and the run completed |
| cancellation | child terminated and cleaned; terminal `WORKFLOW_CANCELLED`; process count zero |
| backend killed after process registration | startup reconciled the durable active run, killed the persisted child PID, cleared it, and projected `WORKFLOW_BACKEND_RESTARTED` with process count zero |

The forced-restart path waited for a new register-before-spawn event before
sending `SIGKILL` to the backend. Recovery used durable active state and the
recorded child identity rather than UI state or provider completion. The test
then reloaded the original browser page and read the recovered state through the
real backend boundary.

## Observability and debugger evidence

Lifecycle assertions required safe, standardized events for compile refusal,
workflow process registration, production operation process registration,
workflow cleanup, and recovery completion. Events used opaque run/node/operation/
process correlations, bounded counts, and safe codes; they did not include
prompts, code, diffs, commands, arguments, paths, credentials, environments, or
raw request/response bodies.

The probe seeded a prohibited-content canary and rejected its appearance in
captured browser/backend logs. It also rejected residual-process safe codes.
Failure paths dump the bounded captured lifecycle so a failed probe remains
diagnosable. The complete production implementation still needs catalog-backed
workflow diagnostics; the disposable prototype files carry specific diagnostic
exemptions because #101 owns those contributors.

## Decisions validated

- Template identity must be immutable and displayed as a safe projection; an
  active or recovered run continues to bind the original digest.
- Backend graph validation must independently reject cycles, trust-spine bypass,
  and grant expansion even when the request originates in a real client.
- Provider/process completion is insufficient. Downstream state advances only
  after registered-process exit and cleanup.
- Parallel and retry behavior must retain distinct node attempts and safe state;
  a retry is visible as attempt 2 rather than overwriting its existence.
- Cancellation and restart are durable scheduler states. They end only after the
  owned process is absent and the visible process count is zero.
- Workflow and production operation-supervisor events are both necessary to
  diagnose a cross-boundary attempt.
- Browser and backend source maps/debugger endpoints can remain available in the
  bundled real application path.

## Production requirements reopened or sharpened

The small prototype deliberately used one run, fixed nodes, one backend process,
and synthetic child workers. It exposed constraints that #101 must not copy as
implementation shortcuts:

- Per-attempt child and operation handles are mandatory. A service-wide mutable
  child/lease slot is unsafe for real parallelism, cancellation, and recovery.
- Persisting only a PID is insufficient production process identity. #101 must
  use the qualified operation supervisor's identity/process-group or equivalent
  external inventory, protect against PID reuse, enumerate descendants, and
  quarantine when absence cannot be proven.
- The full canonical compiler still must cover unknown kinds, dangling and
  unreachable ports, ambiguous joins, unbounded retry/loop behavior, every
  alternate trust-spine path, least-authority grants, and stable proof witnesses.
- Production persistence needs append-only run/attempt/events, generations,
  leases/outbox, integrity checks, migration, concurrency conflicts, historical
  executor compatibility, and crash probes at every intent/terminal boundary.
- Real provider adapters, private worktrees, credentials, task approvals,
  deterministic checks, Ranex evidence/current verdict, and controlled merge
  were outside this prototype. They require exact integration and freshness
  tests in #101; synthetic worker success cannot stand in for them.
- Cancel-all-then-join must cover multiple concurrent children, one hung branch,
  escalation, descendant inventory, and cleanup failure/quarantine. The bounded
  one-child cancellation here proves only the core registration path.
- The visible prototype is not the graph editor. #101 still needs spatial and
  structured-outline parity, keyboard-only editing, accessibility announcements,
  locked-anchor explanation, focus recovery, high contrast, zoom, reduced
  motion, virtualization, and browser/Electron E2E.
- Prohibited-content canaries must be injected through every real provider,
  tool, store, diagnostic, support, and failure path, not merely checked against
  this closed synthetic protocol.

These findings validate the pseudocode's authority and lifecycle model while
keeping its complete production gates open. No finding authorizes weakening the
trust spine, process-cleanup proof, observability audit, diagnostics catalog, or
human-controlled merge boundary.
