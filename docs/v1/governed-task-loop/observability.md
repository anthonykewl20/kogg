# Operational lifecycle contract and supervised process registry

Tracking: [#57](https://github.com/anthonykewl20/kogg/issues/57), research
phase [#60](https://github.com/anthonykewl20/kogg/issues/60), pseudocode phase
[#64](https://github.com/anthonykewl20/kogg/issues/64).

## Status

Research and decision-complete pseudocode are complete as of 2026-08-26. This
packet contains no production code. Production remains gated by the ordered
prototype and implementation issues and by Foundation
[#47](https://github.com/anthonykewl20/kogg/issues/47).

The research recommendation is one backend-owned operation registry with a
durable lifecycle ledger and a live-process supervisor. Every Kogg operation is
registered before its first side effect and every Kogg-created process is
represented by a logical process record before spawn. The registry binds the
logical record to a successfully created child, records bounded activity, and
does not remove terminal records until cleanup is proved. Startup reconciliation
classifies incomplete records before new governed work is enabled.

Theia's `ProcessManager` remains the in-process owner for compatible Node
children, but it is not sufficient as Kogg's authority: it is memory-only,
exposes no enumeration API, has no operation metadata or heartbeat, and loses
all evidence at backend exit. Ranex remains the authority for processes inside
its governed execution and confinement boundary. Kogg records the bridge and the
redacted lifecycle projection; it must not duplicate or rewrite Ranex evidence.

## Scope and non-negotiable constraints

The observability slice must make these questions answerable without reading
source code, prompts, diffs, command lines, environments, or raw provider data:

- which Kogg operation was requested, by which safe project/task/run context,
  and what terminal state it reached;
- which external process or state-changing boundary it owns or delegates;
- whether the operation is active, quiet but within policy, stalled, cancelling,
  incompletely cleaned, recovered, or irrecoverable;
- whether a live child belongs to the current Kogg instance and operation;
- whether a prior instance left a durable incomplete record or a residual child;
- which safe failure code and diagnostic check explain blocked work; and
- whether shutdown joined cleanup for every owned resource.

The registry is operational metadata, not product evidence. It must never store
prompt text, model output, source code, patches, diffs, terminal output, command
arguments, environment values, credentials, cookies, personal data, repository
paths, remote URLs, or raw provider/request/response bodies. The Ranex journal
and later task evidence records remain separate authorities.

Registration before start means logical registration before an external side
effect or `spawn` call. An operating-system PID cannot exist before spawn, so PID
binding is a second atomic transition. A spawn failure therefore remains a
visible registered operation/process pair with `failed` and `cleaned` terminal
facts rather than disappearing as if nothing ran.

## Commit-pinned source ledger

External source is used for patterns only. No copied code is approved by this
research record.

| Source | Exact revision and license | Reviewed paths | Finding |
| --- | --- | --- | --- |
| [Eclipse Theia](https://github.com/eclipse-theia/theia/tree/647dd3c7091b25ef3fc735edb74b949e7a195754) | `v1.74.1`, commit `647dd3c7091b25ef3fc735edb74b949e7a195754` (2026-08-06); EPL-2.0 or GPL-2.0-only with Classpath Exception, with separately identified MIT/VS Code material | `packages/process/src/node/process-manager.ts`, `process.ts`, `raw-process.ts`; task, terminal, plugin-host, backend lifecycle, and logging packages | Keep Theia process ownership and logger integration, but add Kogg lifecycle authority, correlation, activity, durable reconciliation, and safe logging around it. |
| [Node.js](https://github.com/nodejs/node/tree/490a9fef8f8adcda5a95bd6f96035b05cb43fe5b) | `v22.23.2`, commit `490a9fef8f8adcda5a95bd6f96035b05cb43fe5b` (2026-07-21); MIT for Node-originated material with bundled third-party notices | `lib/child_process.js`, `doc/api/child_process.md`, `test/parallel/test-child-process-*` | Distinguish spawn error, exit, and stream close; use bounded output, abort/timeout ownership, and platform-aware process-group cleanup. PID alone is not durable identity. |
| [Visual Studio Code](https://github.com/microsoft/vscode/tree/6f17636121051a53c88d3e605c491d22af2ba755) | tag `1.103.2`, commit `6f17636121051a53c88d3e605c491d22af2ba755` (2025-08-20); MIT | `src/vs/platform/terminal/node/ptyHostService.ts`, `terminalProcess.ts`, `childProcessMonitor.ts`; `src/vs/workbench/services/extensions/common/extensionHostManager.ts` | Separate heartbeat/latency from absolute runtime, expose unresponsive and responsive transitions, and treat host loss/restart as an explicit lifecycle rather than a generic process exit. |
| [PM2](https://github.com/Unitech/pm2/tree/cd6b1b4c592117212d7349d6932288613f336c15) | `7.0.4`, commit `cd6b1b4c592117212d7349d6932288613f336c15` (2026-08-24); AGPL-3.0 | `lib/God.js`, `lib/God/ActionMethods.js`, `lib/God/Methods.js`, `lib/ProcessContainerFork.js` | Typed launching/online/stopping/stopped/errored state, restart counters, kill timeouts, and saved process lists are useful patterns. Reuse is rejected; automatic restarts and environment-rich reports conflict with Kogg authority and data minimization. |
| [OpenTelemetry specification](https://github.com/open-telemetry/opentelemetry-specification/tree/5d015c5d4840754d166386e05ea1d747d1c5b6e0) | commit `5d015c5d4840754d166386e05ea1d747d1c5b6e0` (2026-08-26); Apache-2.0 | `specification/logs/data-model.md`, `specification/trace/api.md`, `specification/common/attribute-naming.md`, `semantic_conventions/README.md` | Correlation identifiers, stable event names, timestamps, severity, and bounded attributes are sound. Exporters and content-bearing general telemetry are not part of V1. |
| [systemd](https://github.com/systemd/systemd/tree/d5e8f63a205ef22cb7e43a5ff2cc79556340ead0) | `v261.2`, commit `d5e8f63a205ef22cb7e43a5ff2cc79556340ead0` (2026-07-23); GPL-2.0-or-later for the service manager, with repository files under declared SPDX licenses | `src/core/service.c`, `src/core/cgroup.c`, `src/core/manager.c`, `man/systemd.service.xml`, `man/systemd.kill.xml`, `man/systemd-system.conf.xml` | Cgroup ownership, watchdog deadlines, explicit kill modes, start-rate bounds, and residual-process classification are the strongest Linux pattern. Direct integration is rejected for cross-platform V1; qualified Ranex confinement may use OS-level containment. |
| [Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | vendored provenance commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25); MIT | `src/ranex/cli/delegation.py`, `src/ranex/cli/host_confinement.py`, `src/ranex/governed_execution/adapters/persistence/sqlite/journal.py`, `src/ranex/observability`; `docs/slices/done/SLICE-012-provider-watchdog.md`, `SLICE-013-reconciler-reorder.md`, `SLICE-047-confinement-hardening.md` | Preserve watchdog, process-group kill/drain, append-only evidence, startup reconciliation, per-session serialization, and residual checks. Do not make the Kogg registry a second Ranex journal or process controller. |

Primary documentation reviewed:

- [Theia architecture](https://theia-ide.org/docs/architecture/) establishes the
  frontend, Node backend, Electron main/renderer, and plugin-host boundaries.
- [Theia logging](https://theia-ide.org/docs/administration/logging/) establishes
  hierarchical loggers, runtime log levels, and the backend logging pipeline.
- [Node child processes](https://nodejs.org/docs/latest-v22.x/api/child_process.html)
  distinguishes `'error'`, `'exit'`, and `'close'`, detached process groups, IPC,
  abort signals, and timeout behavior.
- [OpenTelemetry logs](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
  supplies a useful correlation/event model, not an approval to export data.
- [systemd service management](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
  and [kill behavior](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)
  document watchdog, restart, process-group, and residual-child semantics.

## Source findings

### Theia 1.74.1

`Process` registers itself in its base constructor before `RawProcess` calls
Node `spawn` or `fork`. `RawProcess` normalizes both synchronous throws and
asynchronous spawn errors, publishes start/exit/close separately, and unregisters
on exit. `ProcessManager.unregister` attempts termination before deletion, emits
a deletion event, and `onStop` iterates all currently registered processes.
These are valuable ownership primitives and match Kogg's register-before-spawn
requirement.

The manager's record is only `Map<number, Process>`. Its random numeric ID has no
project, task, run, attempt, session, operation, process kind, deadline, activity,
or cleanup status. There is no public list operation, persistence, heartbeat, or
startup reconciliation. A backend crash erases the registry while descendants
may survive. The default logger can include executable arguments and options,
which Kogg cannot expose for provider, task, or governed children. Kogg-specific
wrappers must emit safe fields and must not pass content-bearing process metadata
to support bundles.

Theia task, terminal, debug, and plugin-host packages already own many IDE
processes. Kogg should not double-kill those children. It should record delegated
ownership and subscribe to their lifecycle where a Kogg action starts them. A
delegated process is still operationally visible, but cleanup authority stays
with the owning Theia service.

Backend `onStop` is useful but not crash recovery. It also cannot prove that a
process tree is gone merely because the direct child was killed or removed from
the map. The production contract needs a joined Kogg shutdown contribution and a
post-cleanup residual check appropriate to the process authority.

### Node.js 22.23.2

Node can throw synchronously during `spawn`, emit `'error'` without a usable PID,
emit `'exit'` while streams still contain data, and emit `'close'` only after the
stdio streams close. A trustworthy supervisor therefore cannot collapse spawn,
exit, drain, and cleanup into one boolean. Completion is not cleanup, and an exit
code alone does not prove descendants or file handles are gone.

On POSIX, `detached: true` makes the child leader of a new process group and
session. Negative-PID signaling can terminate that group, but a descendant can
create a new session and escape. On Windows, `ChildProcess.kill()` does not
provide a durable Job Object contract. Kogg may use process groups for bounded
direct CLI children, but it must rely on the qualified Ranex confinement owner
for adversarial governed descendants and must prove Windows tree cleanup before
qualifying equivalent execution there.

A PID can be reused after exit or restart. Durable reconciliation must never kill
by stale PID alone. A live binding needs an instance nonce plus platform process
identity evidence such as creation/start time and the expected direct-child
relationship. If identity cannot be proved, diagnostics report an unverified
possible residual and block governed work; Kogg must not risk killing an
unrelated user process.

### Visual Studio Code

The pty host maintains a heartbeat/latency channel independent of terminal
process runtime, emits unresponsive and responsive transitions, and recreates the
host connection deliberately. The extension-host manager also exposes responsive
state and separates startup, readiness, exit, and restart. This supports two Kogg
deadlines: an absolute operation bound and an activity/heartbeat bound. A healthy
long operation can continue while a quiet or wedged one becomes stalled.

VS Code's approach is host-specific and memory-oriented. It is not a durable
Kogg operation ledger and it does not provide Ranex evidence. Kogg should reuse
the lifecycle shape, not import terminal or extension-host internals.

### PM2

PM2 records explicit launching, online, stopping, stopped, and errored states;
tracks restart counts and unstable starts; saves process descriptions; escalates
kill after a timeout; and refuses contradictory commands such as starting an
already running process. These are useful warnings against boolean `running`
state and unbounded cleanup.

Its product model is wrong for Kogg. PM2 is an independent daemon with broad
restart authority. It can automatically restart crashed applications and its
report path includes argv, user identity, and the full environment. Governed
agents, checks, and Ranex children must never restart without a new authorized
attempt, and Kogg's support artifacts must never contain those values. The
AGPL-3.0 license also prevents unreviewed reuse. PM2 remains research only.

### OpenTelemetry

The log data model separates observed time from event time and supports severity,
event name, trace/span correlation, and structured attributes. Kogg should mirror
the discipline with stable lifecycle event names and opaque IDs. It should not
adopt open-ended attribute bags: the allowed fields must be closed per event so a
future caller cannot accidentally attach prompts, paths, commands, or provider
bodies.

V1 does not need a collector, exporter, remote trace backend, or vendor SDK. The
Theia logger, durable operation ledger, diagnostics, and redacted local support
artifact are sufficient. Remote telemetry would introduce a new privacy and
security boundary requiring separate consent and retention design.

### systemd

systemd treats a service as a state machine backed by a cgroup, not a remembered
PID. It distinguishes watchdog failure, start/stop timeout, signal/exit outcomes,
automatic restart policy, and processes that remain after the main process exits.
This is the correct conceptual standard for residual detection and cleanup proof.

Kogg cannot require a system service manager inside desktop browser/Electron
development and must support non-Linux UI surfaces. It also must not inherit
systemd's generic restart authority. Linux-qualified governed execution can use
Ranex's existing OS-level confinement, while the Kogg supervisor maintains the
portable logical lifecycle and refuses capabilities it cannot safely contain.

### Ranex

Ranex already owns durable evidence, watchdog classifications, process-group
kill/drain, host-confinement cleanup, and journal verification. Its reconciler
work shows two important rules: startup reconciliation must run even when the
new-work queue is empty, and concurrent reconciliation and execution for the
same session must be serialized. Its watchdog work separates idle from absolute
timeout and makes timeout non-retryable without a new decision.

Kogg must start with an incomplete-operation sweep before accepting governed
work, serialize by the narrowest authoritative resource (session, attempt,
worktree, or operation), and retain stable timeout classes. Kogg observes the
kernel bridge process and projects safe Ranex status. Ranex remains authoritative
for its internal descendants and evidence; duplicating their PIDs or events in a
mutable Kogg table would create conflicting truth.

## Current Kogg boundary inventory

| Boundary | Current owner and behavior | Research finding / required follow-up |
| --- | --- | --- |
| Backend, browser frontend, Electron main/renderer, plugin host | Theia/Electron lifecycle and logging | Record Kogg initialization/readiness/degradation/shutdown at each affected runtime. Preserve source maps and debugger reachability. Do not claim ownership of framework children. |
| Ranex stdio kernel bridge | `kogg-kernel` directly spawns bundled Python, tracks pending requests, applies request timeouts, and kills on handshake failure/shutdown | It is currently outside `ProcessManager`, has no logical process record, no safe lifecycle logs for start/ready/exit/cleanup, no activity timestamp, and no restart reconciliation. This is the highest-risk existing boundary for #67. |
| Project Git repository probe | `kogg-projects` creates a `Process` before spawn, uses a process group on POSIX, bounds output/time, logs terminal classes, unregisters, and exposes an active count | This is the closest existing pattern. Generalize its lifecycle without exposing paths; prove spawn failure, timeout, cancel, close/drain, shutdown, and zero residuals. Its private active map cannot diagnose all Kogg processes. |
| Project registry and workspace projection | Backend SQLite authority with lifecycle logs and restart reconciliation | Register non-process operations before mutation; bind project and operation IDs; preserve degraded/restored terminal facts. Never log workspace/repository URIs. |
| Marketplace registry/download/install/deploy | Kogg client/service plus Theia plugin deployer | External network and state-changing operations need registry records, deadlines, safe HTTP/result classes, and delegated plugin-host lifecycle. Never store registry bodies, artifact bytes, auth headers, or install paths. |
| Provider registry/credential metadata/connection tests | Kogg provider service and OS credential store | Record only adapter/configuration opaque IDs, phase, duration, and safe outcome. Provider requests, prompts, output, headers, and credentials are prohibited. Future provider CLI children use the supervisor. |
| Diagnostics and support artifact | Contributor aggregation and a redacted local JSON artifact | Diagnostics are snapshots, not lifecycle authority. Export is itself a registered filesystem operation. Replace broad recursive redaction as the sole defense with closed safe DTOs; keep defense-in-depth redaction. |
| Future task/worktree/Git/check/build/debug operations | Planned Kogg task, execution, workflow, adapter, verdict, and operations slices | All must create operations through this contract. Exactly one task repository/worktree binding, bounded authority, attempt-scoped children, real cleanup, and Ranex evidence projection are mandatory. |
| Development and E2E harness children | Repository scripts directly use Node child processes | They are test/tooling processes rather than shipped Kogg operations, but harnesses must own, time out, drain, and clean them so E2E cannot leave false product residuals. Artifacts must distinguish harness and product processes. |

## Required process and operation taxonomy

Pseudocode should define a closed `operationKind` union. The minimum V1 inventory
is:

- application initialization, shutdown, recovery sweep, diagnostic run, and
  support-artifact export;
- project registry mutations, repository validation, project switching,
  restoration, and worktree create/validate/remove;
- marketplace search/details/install/update/rollback/remove and delegated plugin
  deployment;
- provider metadata access, connection test, agent session start, provider
  request/stream, cancellation, and adapter shutdown;
- Ranex bridge startup/handshake/request/shutdown and a safe projection of Ranex
  session/run/attempt transitions;
- task create/freeze/queue/cancel, agent dispatch, check/build/test/debug command,
  evidence collection, verdict evaluation, and controlled merge; and
- recovery and cleanup operations created to resolve an earlier incomplete
  operation.

The minimum `processKind` union is `git`, `ranex-kernel`, `provider-cli`,
`governed-command`, `check`, `build`, `test`, `debug-adapter`, and
`delegated-theia`. New kinds require an explicit owner, timeout/activity policy,
cleanup mechanism, diagnostic check, failure test, and visible E2E before use.

Not every operation has a process. SQLite mutations, filesystem publication,
network requests, and workspace projections still need lifecycle records because
they change state or can stall. Conversely, one operation may own several process
attempts, but each process has exactly one owning operation and one cleanup
authority.

## Lifecycle and failure model for pseudocode

Research recommends these distinctions; #64 must freeze exact DTOs, transitions,
and transactions.

### Operation phases

`requested` is durable before authority checks or side effects. It advances to
exactly one of `refused`, `starting`, or `failed`. A started operation may become
`active`, `waiting`, `cancelling`, `timed-out`, `failed`, or `completed`.
Completion/failure/timeout/cancel does not imply resource cleanup. A separate
cleanup phase advances through `cleanup-required`, `cleaning`, and `cleaned`, or
to `cleanup-failed`. On backend restart, any nonterminal record becomes
`recovery-required`, then `recovering`, and finally a normal terminal outcome
with `cleaned` or `cleanup-failed`.

`stalled` is an observation, not success or automatic retry. The supervisor marks
it after an activity deadline, emits a diagnostic event, and applies the frozen
kind-specific policy: cancel, wait until absolute timeout, or block for operator
decision. A retry is always a new attempt with a new operation/process ID linked
to the prior terminal attempt.

### Process phases

A logical process is `registered` before spawn, then `spawning`. Successful PID
and platform identity binding yields `started`; readiness is a separate
`ready` transition where the protocol provides one. Activity updates a monotonic
in-memory deadline and a throttled durable timestamp/counter. Terminal child
states are `spawn-failed`, `exited`, or `signalled`; streams then become `drained`.
Cleanup is `cleanup-requested`, `terminating`, and `cleaned`, or
`cleanup-failed`/`possible-residual`.

An exit event before stream close cannot yield `cleaned`. Removing a Theia
process registration before verifying the direct child/owned group is gone cannot
yield `cleaned`. A missing PID with a durable `spawning` record is a spawn-crash
case, not proof of a residual child. A stale PID identity mismatch is never
killed; it becomes an unverified residual diagnostic.

### Principal failure and recovery classes

| Class | Required evidence and behavior |
| --- | --- |
| Authority refusal | Safe refusal code, no spawn or side effect, operation `refused` and `cleaned`. |
| Synchronous/asynchronous spawn failure | Registered logical process remains visible, error type/safe code recorded, no PID assumption, streams disposed, process and operation cleaned. |
| Protocol/readiness failure | Child identity recorded, bounded termination and drain, no automatic governed retry, principal diagnostic names the process kind. |
| Idle stall | Last safe activity time/count and idle policy recorded; visible warning before cancel/absolute timeout according to the frozen kind policy. |
| Absolute timeout | Timeout class recorded, cancellation/termination begins once, process tree or delegated owner is checked, terminal operation remains distinguishable from failure. |
| User/policy cancellation | Idempotent cancellation, no new work accepted, graceful stop then bounded escalation, drain, cleanup proof, stable cancelled outcome. |
| Nonzero exit/signal | Exit class and numeric code or signal class may be retained; stdout/stderr content is never copied into the registry or support bundle. |
| Backend graceful shutdown | Stop admission, cancel/join owned active work in dependency order, flush lifecycle facts, run residual checks, then close storage. |
| Backend crash/restart | Reconcile durable incomplete records before admission; verify process identity without killing by PID alone; ask delegated/Ranex owner; append recovery outcome idempotently. |
| Cleanup failure or survivor | Block governed work for the affected resource, retain record, fail the process diagnostic, provide safe remediation, and never declare operation success as fully complete. |
| Registry corruption/unavailability | Fail closed for new governed operations, preserve existing OS processes through their current owner when possible, expose a top-level diagnostic, and avoid guessing state. |
| Concurrent recovery/execution | Serialize by affected session/attempt/worktree and make reconciliation idempotent; new execution cannot overtake recovery. |

## Correlation and safe event contract

All operational implementations use an injected Theia `ILogger` named
`kogg:<area>:<component>`, or a Theia-routed console call whose first argument
starts with `[kogg:<area>:<component>]`. Stable event names use
`<noun>.<phase>` such as:

- `operation.requested`, `operation.started`, `operation.activity`,
  `operation.completed`, `operation.refused`, `operation.failed`,
  `operation.timeout`, and `operation.cancelled`;
- `process.registered`, `process.spawn.started`, `process.started`,
  `process.ready`, `process.activity`, `process.exit`, `process.failed`, and
  `process.possible-residual`;
- `cleanup.started`, `cleanup.completed`, `cleanup.failed`;
- `recovery.started`, `recovery.completed`, `recovery.failed`; and
- `supervisor.started`, `supervisor.admission-enabled`,
  `supervisor.shutdown.started`, and `supervisor.shutdown.completed`.

Closed event schemas may contain only applicable opaque `projectId`, `taskId`,
`runId`, `attemptId`, `sessionId`, `operationId`, `processId`, and `worktreeId`,
plus enums, counts, booleans, bounded durations, safe codes, error type, process
kind, exit class, and numeric registration ID. The registry creates IDs; callers
cannot supply arbitrary attribute maps.

PID, absolute timestamps, and platform process fingerprints are local supervisor
data. They are excluded from ordinary frontend DTOs and support artifacts unless
a separately reviewed diagnostic proves a safe need. Paths, executable names
that reveal user configuration, argv, cwd, environment names/values, prompt or
response sizes that can fingerprint content, stdout/stderr, exception messages,
stack contents in support bundles, and network endpoints are prohibited.

Activity is a semantic event, not raw stream content. Examples are a bounded
heartbeat, provider chunk count increment, check phase change, or child IPC
response. High-volume activity is coalesced; lifecycle facts must not generate an
unbounded log or SQLite write per token/byte.

## Diagnostic contract

The current catalog covers components, not the cross-cutting supervisor. #64
should reserve at least these contributor-owned IDs before implementation:

- `operations.registry`: schema, integrity, permissions, and ability to append a
  lifecycle fact;
- `operations.recovery`: no incomplete recovery sweep or contradictory terminal
  transition;
- `operations.processes`: no hidden, stalled, orphaned, unverified, or residual
  Kogg-owned process;
- `operations.cleanup`: no terminal operation with missing/failed cleanup;
- `operations.admission`: governed-work admission matches recovery and diagnostic
  state; and
- a kind-specific check for each new operational capability where the generic
  registry cannot prove its external boundary.

Diagnostics run through a contributor and return closed, redacted DTOs. A
contributor failure becomes a failing check, not absence. The support artifact
contains catalog IDs, status, safe summary, enum/count details, version, and
generation time only. It does not contain operation rows, logs, process output,
paths, PIDs, command metadata, prompts, code, diffs, provider bodies, or personal
data.

The observability audit must require every operational implementation to declare
valid diagnostic coverage or a specific exemption, preserve source/declaration
maps, reject silent catches and unsafe logs, and verify the catalog has a real
runtime contributor. It must not be weakened or baselined to admit this feature.

## Security and authority decisions

1. The Kogg backend operation registry is authoritative for Kogg operation and
   direct/delegated process lifecycle metadata.
2. Theia remains authoritative for framework task, terminal, debug, plugin-host,
   and backend processes it creates. Kogg records delegation, not duplicate kill
   authority.
3. Ranex remains authoritative for governed session evidence and descendants
   inside confinement. Kogg owns the bridge process and a safe status projection.
4. The provider adapter owns provider protocol cancellation; the Kogg supervisor
   owns a direct provider CLI process when one exists.
5. Git and the filesystem are external truth for repository/worktree existence;
   registry metadata cannot prove a path or child still exists.
6. The frontend is a redacted projection and never writes lifecycle authority.

The durable registry is machine-local under the Kogg state root with restrictive
directory/file permissions. It uses a separate SQLite database or a separately
owned schema from mutable project metadata and never shares the Ranex evidence
journal. The backend is the only writer. Transactions enforce monotonic sequence,
valid transitions, unique process ownership, and idempotent recovery.

Durable rows use opaque IDs and bounded enums/counters. Retention is bounded by a
future explicit policy; active, recovery-required, cleanup-failed, and possible-
residual records cannot be pruned. Deleting a task/project must not silently erase
unresolved operational records. Exporting or remotely transmitting the ledger is
out of scope.

## Rejected approaches

| Candidate | Rejection |
| --- | --- |
| Theia `ProcessManager` as the sole registry | Memory-only, no enumeration/correlation/activity/recovery, unsafe default process detail for Kogg support needs, and no descendant proof. Keep as a live owner behind Kogg wrappers. |
| Direct `child_process.spawn` plus logging | A log is not a register-before-spawn state machine, cannot drive cancellation or admission, and cannot reconcile crashes. Existing direct production spawns must migrate. |
| PID files or PID-only SQLite rows | PID reuse can kill unrelated processes; a PID does not describe descendants, readiness, activity, drain, cleanup, or authority. |
| Process-name scanning | Names and argv are ambiguous and content-bearing; scanning cannot prove Kogg ownership and creates a dangerous kill boundary. |
| PM2 or another independent daemon | Broad restart/daemon authority conflicts with governed attempts, embeds a new service lifecycle, can collect argv/env/user data, and PM2 reuse is AGPL-3.0. |
| systemd as the universal supervisor | Strong on qualified Linux but unavailable as a portable desktop contract; would create deployment and privilege requirements. Use its containment concepts through qualified owners only. |
| Automatic restart after failure/stall | A restart is a new governed attempt and requires fresh authority. Silent restart obscures evidence and can repeat unsafe side effects. |
| OpenTelemetry exporter as V1 authority | Remote export adds privacy, consent, retention, network, and credential boundaries; traces are not cleanup authority. Keep local structured lifecycle events. |
| Ranex journal tables for Kogg operations | Couples mutable UI/application state to evidence integrity, ownership, migration, and retention; risks contradictory lifecycle truth. |
| Frontend/local storage registry | Disappears or races across windows, cannot own backend children, and exposes operational metadata to the wrong trust boundary. |
| Raw stdout/stderr or request/response capture | Violates the data-minimization contract and can expose prompts, code, secrets, paths, provider bodies, and personal data. Store semantic activity and safe terminal classes only. |
| Treat direct-child exit as cleanup | Streams or descendants may remain, and delegated/confinement owners may still be cleaning. Exit, drain, termination, and residual proof are separate facts. |
| Kill every stale PID during startup | PID reuse makes this unsafe. Unverified identity blocks admission and requires safe remediation; it is never guessed away. |

## Real human-level E2E requirements

Production acceptance must drive Kogg through visible browser/Electron controls
and cross the real owned boundaries. Service calls may support test setup or
artifact inspection but cannot substitute for the user action or product result.
The observability slice needs at least these scenarios:

1. Start a real operation that launches a bounded child, observe visible running
   state and safe diagnostics, complete it, and prove exit, drain, unregister,
   cleanup, and zero residual processes.
2. Exercise a real synchronous or asynchronous spawn failure and prove a durable
   failed/cleaned record, user-facing safe error, matching logs, and no hidden
   child.
3. Hang a real child without activity, observe stalled then timeout/cancel through
   the UI, prove process-group/delegated cleanup, and show the correct diagnostic
   transition.
4. Cancel an active operation from a visible control, relaunch or switch project,
   and prove cancellation is idempotent and project/task isolation is preserved.
5. Terminate Kogg while a disposable real child is active, restart through the
   normal application entrypoint, prove the startup recovery sweep runs with an
   otherwise empty queue, and verify no new governed work is admitted before the
   record and child are reconciled.
6. Inject a stale PID identity in disposable state, prove Kogg does not signal an
   unrelated calibration process, reports a possible residual, and fails closed.
7. Start the real Ranex bridge, prove start/handshake/activity/shutdown projection,
   debugger access and source maps across Node/Python, while verifying Ranex
   remains the descendant/evidence authority.
8. Export a support artifact through the visible command and scan it for forbidden
   prompt/code/diff/path/PID/argv/environment/credential/provider content.

Artifacts include redacted application logs, operation/diagnostic summaries,
process-identity calibration results, screenshots or UI assertions, debugger
proof, and harness cleanup results. They must distinguish product children from
harness children. A fake process, mocked owned boundary, direct registry call,
pre-generated patch, or assertion on implementation internals does not satisfy
the real-boundary gate.

## Risks and required prototype

The highest-risk existing assumption is that the long-lived Ranex stdio bridge
can be moved under the logical supervisor and Theia live-process ownership
without a registration gap, protocol deadlock, output leak, double-kill, or
conflict with Ranex's descendant authority. #67 should probe the actual bundled
Python bridge on the pinned Node/Electron runtimes and qualified Linux boundary.

The probe must demonstrate:

- logical registration before spawn, then PID/platform identity binding;
- safe start, handshake/readiness, semantic activity, request timeout, unexpected
  exit, cancellation, stream drain, shutdown, and cleanup events;
- a real backend interruption/restart with an empty new-work queue followed by
  idempotent reconciliation;
- no prompt/request/response, argv, environment, path, stderr, or source content
  in logs, the registry, diagnostics, or artifacts;
- no double ownership of Ranex-governed descendants and no residual direct child;
- debugger/source-map reachability for the Node bridge and Python adapter; and
- explicit evidence for what Windows can and cannot safely contain before any
  Windows governed-process claim.

If process identity after restart cannot be proved portably, V1 must fail closed
and qualify governed child execution only on hosts where the responsible owner
can provide containment/identity proof. The pseudocode must not invent a PID-only
fallback.

## Research gate conclusion

The source ledger is commit pinned with licenses and reviewed paths. Rejected
approaches, security boundaries, current and future operations/processes,
lifecycle events, failure/recovery behavior, log safety, correlation IDs,
diagnostic needs, real UI E2E, and the highest-risk prototype are recorded.

The recommendation is sufficiently constrained for #64 to freeze closed DTOs,
SQLite transitions, owner interfaces, event schemas, timeouts, admission rules,
UI states, diagnostics, and exact expected traces without reopening the source
selection.

## Decision-complete production pseudocode

This section is normative for #67 and #69. Names, state transitions, authority,
ordering, time bounds, diagnostics, UI behavior, and expected traces are closed.
The prototype may invalidate a decision with evidence; it may not silently pick
an alternative.

### Package and runtime topology

Create a Theia extension `packages/kogg-operations` with this fixed ownership:

```text
src/common/operations-protocol.ts       redacted JSON-RPC DTOs and callback
src/browser/frontend-module.ts          service proxy and widget binding
src/browser/operations-widget.ts        safe active/recent lifecycle projection
src/node/backend-module.ts              singleton services and lifecycle joins
src/node/operation-registry.ts           SQLite authority and transition checks
src/node/process-supervisor.ts           register/start/activity/exit/cleanup
src/node/process-identity.ts             platform identity verification port
src/node/operation-reconciler.ts         startup recovery and admission gate
src/node/operation-diagnostics.ts        catalog contributor
```

`@kogg/contracts` owns only immutable cross-package DTOs and tokens. The new
package owns operational persistence, transition validation, live supervision,
reconciliation, UI projection, and diagnostics. Existing packages use an
in-process `KoggOperationRegistry` and `KoggProcessSupervisor`; they cannot write
the database. Both applications include the package statically.

The backend is the sole writer. Use pinned Node `node:sqlite` `DatabaseSync`
behind an injected database port. The path is
`${KOGG_STATE_DIR}/operations/registry.sqlite3`, using the standard Kogg state
root fallback. Use rollback journal, `synchronous=FULL`, foreign keys, a 5-second
busy timeout, directory mode `0700`, and file mode `0600` where supported. No
external call, spawn, stream wait, or UI wait occurs inside a transaction.

### Closed public and internal contracts

```ts
type OperationState =
  | 'requested' | 'refused' | 'starting' | 'active' | 'waiting' | 'stalled'
  | 'cancelling' | 'completed' | 'failed' | 'timed-out' | 'cancelled'
  | 'recovery-required' | 'recovering' | 'recovered';
type CleanupState = 'not-required' | 'required' | 'cleaning' | 'cleaned' | 'failed';
type ProcessState =
  | 'registered' | 'spawning' | 'started' | 'ready' | 'spawn-failed'
  | 'exited' | 'signalled' | 'possible-residual';
type ProcessOwner = 'kogg-supervisor' | 'theia-task' | 'theia-terminal'
  | 'theia-debug' | 'theia-plugin-host' | 'ranex';
type OperationKind =
  | 'application-start' | 'application-stop' | 'recovery' | 'diagnostics'
  | 'support-export' | 'project-mutation' | 'repository-probe'
  | 'project-switch' | 'worktree' | 'marketplace' | 'provider-connection'
  | 'provider-session' | 'ranex-bridge' | 'ranex-request' | 'task'
  | 'agent-dispatch' | 'check' | 'build' | 'test' | 'debug'
  | 'evidence' | 'verdict' | 'merge';
type ProcessKind = 'git' | 'ranex-kernel' | 'provider-cli'
  | 'governed-command' | 'check' | 'build' | 'test' | 'debug-adapter'
  | 'delegated-theia';

interface Correlations {
  projectId?: string; taskId?: string; runId?: string; attemptId?: string;
  sessionId?: string; worktreeId?: string;
}
interface OperationSummary {
  id: string; kind: OperationKind; state: OperationState;
  cleanup: CleanupState; safeCode?: OperationSafeCode;
  correlations: Correlations; processCount: number; activityCount: number;
  canCancel: boolean; blocksAdmission: boolean;
}
interface OperationsSnapshot {
  schemaVersion: 1; revision: number;
  admission: 'enabled' | 'recovering' | 'blocked';
  active: readonly OperationSummary[];
  recent: readonly OperationSummary[]; // newest 100 terminal operations
}
interface KoggOperationsService {
  snapshot(): Promise<OperationsSnapshot>;
  cancel(request: { requestId: string; operationId: string }): Promise<OperationsSnapshot>;
  setClient(client?: { changed(snapshot: OperationsSnapshot): void }): void;
}
```

RPC is `/services/kogg-operations`. Validate closed objects, UUID v4 identifiers,
safe integers, known enums, and correlation consistency. The frontend receives
no PID, process fingerprint, timestamps, executable, path, argv, cwd, environment,
output, error message, or arbitrary details map.

Internal callers use:

```ts
interface StartOperation {
  kind: OperationKind; correlations: Correlations;
  absoluteTimeoutMs?: number; idleTimeoutMs?: number;
}
interface OperationLease {
  id: string;
  start(): Promise<void>; active(): Promise<void>; waiting(): Promise<void>;
  activity(): Promise<void>;
  refuse(code: OperationSafeCode): Promise<void>;
  complete(code?: OperationSafeCode): Promise<void>;
  fail(code: OperationSafeCode, errorType: string): Promise<void>;
  cancel(): Promise<void>; timeout(code: OperationSafeCode): Promise<void>;
  cleanup(run: () => Promise<void>): Promise<void>;
}
interface ProcessOwnerAdapter {
  owner: ProcessOwner; kind: ProcessKind;
  start(context: { operationId: string; processId: string }): Promise<LiveProcess>;
  recover(binding: DurableProcessBinding): Promise<RecoveryObservation>;
}
interface LiveProcess {
  identity: PlatformProcessIdentity;
  ready?: Promise<void>; exit: Promise<ProcessExit>;
  onActivity(listener: () => void): Disposable;
  cancel(): Promise<void>; verifyAbsent(): Promise<boolean>;
}
```

`start()` on an adapter is the first method allowed to spawn or delegate. The
supervisor commits the logical process as `registered` before invoking it. Launch
configuration remains inside the adapter in memory and is never passed to the
registry. `PlatformProcessIdentity` is a closed backend-only value containing PID,
platform, and a creation/start fingerprint; it is never logged or exported.

Every operation lease is single-terminal and idempotent. A second conflicting
terminal call throws `OPERATIONS_TRANSITION_INVALID`, records a registry failure,
and blocks the affected scope. Losing a lease reference does not complete it;
shutdown/recovery owns the record.

### SQL schema and invariants

```sql
CREATE TABLE operation_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  instance_id TEXT NOT NULL,
  admission TEXT NOT NULL CHECK (admission IN ('enabled','recovering','blocked'))
);
CREATE TABLE operations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
  cleanup_state TEXT NOT NULL, safe_code TEXT NULL,
  project_id TEXT NULL, task_id TEXT NULL, run_id TEXT NULL,
  attempt_id TEXT NULL, session_id TEXT NULL, worktree_id TEXT NULL,
  owner_instance_id TEXT NOT NULL, requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, last_activity_at TEXT NULL,
  absolute_deadline_at TEXT NULL, idle_deadline_at TEXT NULL,
  activity_count INTEGER NOT NULL DEFAULT 0 CHECK (activity_count >= 0),
  error_type TEXT NULL, revision INTEGER NOT NULL CHECK (revision >= 1)
);
CREATE TABLE processes (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id),
  kind TEXT NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL,
  cleanup_state TEXT NOT NULL, owner_instance_id TEXT NOT NULL,
  theia_registration_id INTEGER NULL, pid INTEGER NULL,
  identity_kind TEXT NULL, identity_fingerprint TEXT NULL,
  started_at TEXT NULL, last_activity_at TEXT NULL,
  exit_class TEXT NULL, exit_code INTEGER NULL, signal_class TEXT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1)
);
CREATE TABLE operation_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES operations(id), process_id TEXT NULL,
  event_name TEXT NOT NULL, safe_code TEXT NULL, event_at TEXT NOT NULL,
  activity_count INTEGER NULL, exit_class TEXT NULL, error_type TEXT NULL
);
CREATE TABLE request_results (
  request_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
  operation_id TEXT NOT NULL, safe_code TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX operation_active_idx ON operations(state, cleanup_state);
CREATE INDEX process_operation_idx ON processes(operation_id);
```

Migration creates tables in foreign-key-valid order, is transactional, numbered,
and hash-tested. Check constraints use the exact closed enum values in production
SQL. `operation_events` accepts only closed event names through application
validation. Process identity is encrypted neither at rest nor exported; it is
machine-local operational state protected by file permissions and bounded
retention.

Every transition uses `BEGIN IMMEDIATE`, checks expected current state and
revision, updates the snapshot row, appends exactly one event, increments row and
global revisions, then commits. Process registration and its event are one
transaction. PID/fingerprint binding and `process.started` are one later
transaction. Terminal state and cleanup are separate transactions.

Retain terminal, fully cleaned records for 30 days or 10,000 operations, whichever
removes more old rows, pruning oldest complete operations after successful startup
reconciliation. Never prune active, recovery-required, cleanup-failed,
possible-residual, or admission-blocking rows. Deleting project/task records does
not cascade operational history.

### Exact state transitions

Allowed operation transitions are:

```text
requested -> refused | starting | failed
starting -> active | failed | timed-out | cancelling
active -> waiting | stalled | completed | failed | timed-out | cancelling
waiting -> active | stalled | completed | failed | timed-out | cancelling
stalled -> active | failed | timed-out | cancelling
cancelling -> cancelled | failed
any nonterminal state found at startup -> recovery-required
recovery-required -> recovering
recovering -> recovered | failed
```

`refused`, `completed`, `failed`, `timed-out`, `cancelled`, and `recovered` are
terminal. Refused operations use `not-required` cleanup only if no resource was
acquired. Every other terminal operation must end `cleaned` or `failed` cleanup.
An operation is release-complete only when both dimensions are terminal.

Process transitions are:

```text
registered -> spawning
spawning -> started | spawn-failed
started -> ready | exited | signalled
ready -> exited | signalled
any nonterminal process found at startup -> possible-residual until recovery proves identity/absence
```

Process cleanup is `required -> cleaning -> cleaned | failed`. `spawn-failed` may
be cleaned without a PID after adapter disposal. `exited`/`signalled` is not
cleaned until streams/listeners are disposed and `verifyAbsent()` succeeds.
Delegated owners prove cleanup through their service lifecycle, not PID probing.

### Time and activity policy

Use monotonic clocks for live deadlines and UTC only for durable ordering.
`repository-probe` has 10-second idle and absolute bounds. Ranex bridge startup
and handshake have a 15-second absolute bound; the ready bridge has a 30-second
health/activity bound, no lifetime bound, and 5-second graceful plus 5-second
forced shutdown bounds. Provider sessions default to 60 seconds idle and 30
minutes absolute. Check/build/test/governed commands default to 5 minutes idle and
60 minutes absolute, with an approved execution profile permitted to select 1
minute through 2 hours absolute. Debug operations use 5 minutes idle and 8 hours
absolute. Cleanup is 10 seconds unless Ranex's stricter authority supplies a
smaller bound.

Activity persistence is coalesced to at most once per second and once per 100
semantic events, while the in-memory monotonic deadline updates immediately.
Bytes, chunks, tokens, output length, and content are not activity fields.

### Start, supervision, cancellation, and shutdown

```text
start operation
  validate kind, correlations, timeout policy, and admission
  transaction: insert requested operation + operation.requested
  run authority checks
  on refusal: transaction refused/not-required; return safe error
  transaction starting + operation.started
  perform state-changing non-process boundary or call supervisor

supervisor start
  transaction: insert process registered/required + process.registered
  transaction: state spawning + process.spawn.started
  call owner.start outside transaction
  spawn error: transaction spawn-failed + process.failed; dispose; cleanup
  success: transaction bind identity + started + process.started
  attach activity/readiness/exit handlers before returning
  readiness success -> process.ready; operation active
  exit -> exited/signalled; drain/dispose; verify absence; cleanup

cancel
  idempotency record by requestId
  if terminal return snapshot
  transition cancelling; disable new child starts
  call each owner cancel in reverse acquisition order
  await bounded exit/drain/absence; cleanup resources
  transition cancelled then cleaned; notify frontend

backend onStop
  set admission blocked; emit supervisor.shutdown.started
  cancel/join operations in reverse dependency order
  reconcile every owned process; flush events; close database last
  emit supervisor.shutdown.completed only after zero unresolved owned processes
```

The supervisor wraps existing `ProcessManager` where Kogg owns a compatible Node
child and records the Theia registration ID. It never uses Theia `RawProcess`,
whose default logs include args/options. Kogg adapters use fixed commands,
argument construction, minimal environment, bounded streams, and no shell.

### Startup reconciliation and admission

```text
backend onStart
  open/migrate/integrity-check database
  replace instance_id; set admission=recovering
  select every nonterminal operation, non-clean cleanup, and nonterminal process
  do this even when no work is queued
  serialize by sessionId, then attemptId, then worktreeId, else operationId
  mark operation recovery-required -> recovering
  for each process in reverse acquisition order:
    delegated/Ranex owner: ask owner recover()
    direct process: compare PID + creation fingerprint + expected parent/instance
    proved absent: append recovery fact and cleaned
    proved same owned child: bounded cancel/drain/absence then cleaned
    mismatch/unprovable: do not signal; mark possible-residual/cleanup failed
  mark operation recovered only when all resources are clean
  if any registry corruption, unverified identity, or cleanup failure:
    admission=blocked
  else admission=enabled
```

Recovery is idempotent: repeated observation of a cleaned process appends no
duplicate terminal fact. A current execution cannot overtake reconciliation for
the same serialization key. UI/diagnostics remain available while admission is
blocked; new governed operations, provider sessions, worktrees, and merges refuse
`OPERATIONS_ADMISSION_BLOCKED`. Safe non-executing inspection may continue.

On Linux, direct identity uses `/proc/<pid>/stat` start time plus boot ID and
parent/group evidence. macOS uses process start time from an injected native
inspection port. Windows requires a process creation time and owned Job Object or
delegated Theia proof. If the #67 probe cannot prove a platform, governed direct
children remain unqualified there; no PID-only fallback exists.

### Safe codes and logger/event schemas

`OperationSafeCode` is the closed union:

```text
OPERATIONS_OK, OPERATIONS_REFUSED, OPERATIONS_ADMISSION_BLOCKED,
OPERATIONS_REGISTRY_UNAVAILABLE, OPERATIONS_SCHEMA_INCOMPATIBLE,
OPERATIONS_INTEGRITY_FAILED, OPERATIONS_TRANSITION_INVALID,
OPERATIONS_REQUEST_REPLAY_MISMATCH, OPERATION_IDLE_TIMEOUT,
OPERATION_ABSOLUTE_TIMEOUT, OPERATION_CANCELLED, PROCESS_SPAWN_FAILED,
PROCESS_READINESS_FAILED, PROCESS_EXIT_NONZERO, PROCESS_SIGNALLED,
PROCESS_IDENTITY_UNVERIFIED, PROCESS_RESIDUAL, CLEANUP_TIMEOUT,
CLEANUP_FAILED, RECOVERY_FAILED, OWNER_UNAVAILABLE
```

Use `kogg:operations:registry`, `kogg:operations:supervisor`,
`kogg:operations:recovery`, `kogg:operations:diagnostics`, and
`kogg:operations:widget`. Exact stable events are:

```text
registry.start.requested|completed|failed
registry.migration.started|completed|failed
registry.integrity.started|completed|failed
operation.requested|started|active|waiting|stalled|cancel.requested|cancelling|completed|refused|failed|timeout|cancelled
process.registered|spawn.started|started|ready|activity|exit|failed|possible-residual
cleanup.started|completed|failed
recovery.started|process.observed|completed|failed
admission.enabled|blocked
supervisor.shutdown.started|completed|failed
diagnostics.started|completed|failed
```

Each event accepts only applicable opaque correlation IDs, operation/process ID,
kind/owner enums, safe code, error type, exit class, activity count, duration
bucket, process count, and Theia registration ID. The logger helper constructs
closed fields and rejects extras in tests. It never accepts arbitrary objects.
`process.activity` is debug-level and coalesced; state changes are info, stalls and
recoverable cleanup degradation warn, and failed operations/cleanup error.

### UI behavior

Add `Kogg: Show Operations`, opening a dockable **Kogg Operations** widget. It
shows admission status, active operations first, and the latest 100 terminal
operations. A row displays operation kind, safe status, opaque short ID, safe
correlation labels, process/activity counts, and safe code. It never displays
commands, paths, prompts, code, output, provider bodies, PID, or environment.

Active cancellable rows have one **Cancel** button with confirmation for build,
test, debug, provider, Ranex, evidence, verdict, and merge kinds. During cancel it
is disabled and reads **Cancelling…**. Terminal rows have no generic retry button;
retry belongs to the owning feature and creates a new authorized attempt. Stalled,
cleanup-failed, possible-residual, recovering, and admission-blocked states use
distinct warning/error text and link to **Kogg: Run Diagnostics**. The UI never
offers “kill PID” for unverified identity.

Frontend disconnect/reconnect reloads the authoritative snapshot. Callback
notifications are hints; revision gaps trigger a full snapshot. Cancel replay is
idempotent. Backend-safe errors are rendered with the safe code and guidance;
raw exceptions never cross RPC.

### Diagnostics and support artifact

Add these exact catalog entries owned by `kogg-operations`:

- `operations.registry`: schema, integrity, permissions, transition append;
- `operations.recovery`: startup sweep finished and no contradictory record;
- `operations.processes`: no hidden, stalled, orphaned, unverified, or residual
  owned process;
- `operations.cleanup`: no terminal operation lacks proved cleanup; and
- `operations.admission`: admission agrees with recovery and failures.

Every operational source declares applicable coverage. Contributor failure yields
a failing check for all checks it could not evaluate. Support output contains only
check IDs, status, safe summary, enum/count details, schema version, and generation
time. Add a denylist scan for paths, PID, argv, environment, prompts, code/diff,
credentials, provider bodies, and operation event rows. Recursive redaction remains
defense in depth, not the primary schema.

### Unit, integration, and visible E2E contract

Unit/contract tests cover every allowed transition and reject every other edge;
single-terminal idempotency; request replay mismatch; logger field allowlists;
DTO unknown fields; retention exclusions; admission; contributor failures; and
support-artifact content denial.

Integration tests use real SQLite and real children for synchronous/asynchronous
spawn failure, readiness failure, healthy activity, idle and absolute timeout,
nonzero/signal exit, cancel, stream drain, reverse cleanup, cleanup timeout,
shutdown, crash/restart, empty-queue recovery, stale PID identity, contention,
corruption, and zero residuals. The Ranex bridge test uses the bundled Python and
real stdio protocol; internal Ranex descendants remain unregistered by Kogg.

Visible browser/Electron E2E must produce these traces in order:

```text
success:
  operation.requested -> operation.started -> process.registered ->
  process.spawn.started -> process.started -> process.ready ->
  operation.active -> process.exit -> cleanup.started ->
  cleanup.completed -> operation.completed

spawn failure:
  operation.requested -> operation.started -> process.registered ->
  process.spawn.started -> process.failed(PROCESS_SPAWN_FAILED) ->
  cleanup.started -> cleanup.completed -> operation.failed

idle timeout:
  ... -> operation.active -> operation.stalled ->
  operation.timeout(OPERATION_IDLE_TIMEOUT) -> cleanup.started ->
  process.exit -> cleanup.completed

cancel:
  ... -> operation.active -> operation.cancel.requested -> operation.cancelling ->
  cleanup.started -> process.exit -> cleanup.completed -> operation.cancelled

restart recovery:
  recovery.started -> process.observed -> cleanup.started ->
  cleanup.completed -> recovery.completed -> admission.enabled

unverified identity:
  recovery.started -> process.possible-residual -> cleanup.failed ->
  recovery.failed -> admission.blocked
```

Drive visible controls to start, inspect, cancel, diagnose, and export support
data. Use real Git/filesystem/subprocess/Ranex boundaries and an unrelated
calibration process for the stale-PID refusal. Kill/restart through normal app
entrypoints. Assert OS-level absence and sanitized artifacts. Direct service
calls, mocked owned boundaries, fake PIDs, hidden controls, and implementation-
only assertions do not satisfy acceptance. Preserve TypeScript and bundle source
maps and pause a debugger in the browser frontend, Node backend, Electron
main/renderer, and Python adapter statements reached by these workflows.

### Pseudocode gate verdict

Research #60 is closed. Every operation/process state, terminal and cleanup edge,
authority, persistence invariant, timeout, correlation, safe code, logger/event,
diagnostic, UI state, recovery/admission decision, test, real-boundary E2E, and
expected trace is fixed. There is no unresolved production choice. The selected
Ranex bridge and process-identity boundary advances to prototype #67.
