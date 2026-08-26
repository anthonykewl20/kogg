# Operations read model normative pseudocode

Tracking: [#114](https://github.com/anthonykewl20/kogg/issues/114), parent
[#112](https://github.com/anthonykewl20/kogg/issues/112), prototype
[#115](https://github.com/anthonykewl20/kogg/issues/115), and production
[#116](https://github.com/anthonykewl20/kogg/issues/116).

## Contract status and ownership

This document is normative for #115 and #116. `MUST` and `MUST NOT` are release
gates. Operations is a disposable safe read model over owner-provided immutable
facts. It never becomes task, queue, scheduler, workflow, provider, process,
repository, check, Ranex, verdict, merge, diagnostic, or retention authority.

An owner fact is accepted only from a compiled-in owner adapter with a closed
schema. Every projected field names its owner and freshness. Missing, conflicting,
unknown, corrupt, or unavailable input produces an explicit degraded projection;
it is never repaired by timestamp ordering or inferred success. A clean terminal
run requires the process owner to prove zero registered descendants.

## Canonical owner envelope and cursor

```text
OwnerKind = task|workflow|adapter|execution|operation|project|check|ranex|
            verdict|merge|diagnostic

OwnerEventV1 {
  ownerKind, ownerInstanceId, ownerSchemaVersion,
  epochId, sequence: uint64, eventId,
  eventKind: closed per owner,
  factId, factDigest, previousEventDigest,
  causalParents: CausalRefV1[0..16],
  correlations: SafeCorrelationsV1,
  observedAt, safePayload: closed tagged record
}

CausalRefV1 { ownerInstanceId, epochId, sequence, eventDigest }
OwnerCursorV1 { ownerInstanceId, epochId, sequence, eventDigest, schemaVersion }
```

Envelopes use the repository canonical JSON profile and digest domain
`kogg:operations:owner-event:v1`. Correlations may contain opaque task/run/node/
attempt/operation/process/check/evidence/verdict/merge ids; no id or digest is a
metric label. Payloads contain closed states, safe codes, bounded counts/durations,
enums, booleans, units, and non-content digests. They MUST NOT contain prompts,
code, diffs, paths, commands/arguments/results, environment, credentials,
personal data, raw provider/evidence/verdict bodies, URLs, or error messages.

Owner sequence is strictly increasing within `(ownerInstanceId, epochId)`.
Duplicate sequence/same digest is idempotent. Same sequence/different digest,
previous-digest mismatch, rewind, unknown epoch/schema, missing causal parent, or
cycle is persisted as a safe projection fault and stops that owner's cursor.
Timestamp is display metadata only.

Each adapter supplies:

```text
verifyOwner() -> OwnerHealthV1
readAfter(cursor, limit <= 500) -> ordered OwnerEventV1[]
snapshot(snapshotCursor) -> signed SafeOwnerSnapshotV1
routeAction(OwnerActionV1) -> OwnerActionReceiptV1
```

Snapshots contain the same safe closed facts and an exact cursor. They rebuild a
projection but cannot overwrite owner history or authorize an action.

## Projection records

```text
OperationsRunV1 {
  runId, taskId, projectId, ownerKind, ownerCursor,
  lifecycle: queued|active|waiting|retrying|blocked|failed|cancelling|
             cleaning|recovered|completed|unknown,
  lifecycleCode, priorityClass, queueObservation?,
  queuedAgeBucket, activeDurationBucket, nextActionClass,
  nodeCount, attemptCount, retryCount,
  liveProcessCount, abnormalProcessCount,
  checkSummary, evidenceSummary, verdictSummary, mergeSummary,
  diagnosticSeverity, freshness, degradedOwners[]
}

TimelineEntryV1 {
  entryId, runId, ownerKind, ownerSequence, eventKind,
  causalParents[], lifecycleClass, safeCode,
  durationBucket?, count?, attemptId?, processId?,
  displayTime, clockUncertaintyClass, freshness
}

ProcessProjectionV1 {
  processId, operationId, runId?, nodeId?, attemptId?, ownerKind, processKind,
  state: reserved|spawning|started|ready|exited|cancelling|cleaning|cleaned|
         spawn-failed|timed-out|residual|lost|quarantined|inventory-unknown,
  deadlineClass, activityAgeBucket, descendantCountClass,
  cleanupState, safeCode, freshness
}
```

File projections contain repository/worktree identity digests, exact base/subject
object digests in authenticated detail views, safe change counts, and state class
only. Paths/diffs stay in the SCM owner. Check projections contain definition,
version, exact-subject digest, verifier role, attempt, lifecycle/result, duration,
cleanup, and evidence applicability. Ranex projections contain provenance/journal
sequence, claim/gate ids, bounded counts, subject/evidence/catalog digests,
decision and currentness; never raw evidence.

Retry projections retain every attempt with terminal cause, authority class,
cleanup result, and next-attempt link. Usage observations contain unit, bounded
integer value, and `known|partial|unknown`; cost is labeled estimate, never invoice
or evidence. Merge projections distinguish explanation, authorization, preflight,
construction, CAS, post-verification, recovery, committed/refused/quarantined.

## Deterministic projection algorithm

```text
startup:
  state STOPPED -> VERIFYING
  verify SQLite integrity/schema/event chain and every configured owner
  compare durable cursors with owner epochs/schema/snapshots
  if projection absent/corrupt: state REBUILDING; drop only derived tables
  replay each verified owner snapshot then events after its cursor
  build causal index; mark gaps/conflicts without inventing parents
  reconcile process facts against operation registry and external inventory
  commit projection+cursors in one transaction per bounded batch
  state CURRENT when all owners verified, otherwise DEGRADED with exact owners

ingest(event):
  validate closed schema, size, owner identity, chain, sequence, correlations
  insert event digest idempotently
  update owner-specific safe fact table
  recompute affected run rows, causal entries, counts and diagnostics
  append projection change sequence
  advance owner cursor in the same SQLite transaction
```

Timeline order is a deterministic topological sort: causal parents first, then
owner-local sequence, then `(displayTime, ownerInstanceId, eventId)` only as a
stable presentation tie-break. A cycle or missing parent is not sorted away; it
creates a visible gap/fault row and degrades the affected run.

Activity events may be coalesced only when owner, event kind, safe code, attempt,
and time bucket match. The aggregate keeps exact count and first/last display
times. Request, admission, approval, retry, timeout, cancellation, process
registration/exit/cleanup, failure, recovery, evidence, verdict, merge, and every
terminal event are never coalesced or dropped.

Projection state machine:

```text
STOPPED -> VERIFYING -> REPLAYING -> CURRENT|DEGRADED
CURRENT|DEGRADED -> REBUILDING -> REPLAYING
any state -> FAILED on projection-store integrity failure
FAILED permits diagnose/export only; owner state remains untouched
```

## Query and visible behavior

```text
listRuns(filter, sort, pageCursor, pageSize <= 100) -> RunPageV1
getRun(runId) -> OperationsDetailV1
getTimeline(runId, cursor, limit <= 200) -> TimelinePageV1
getProcesses(runId, cursor, limit <= 200) -> ProcessPageV1
subscribe(resumeCursor) -> authenticated bounded stream
requestAction(action) -> ActionProjectionV1
exportSupport(scope) -> local private file receipt
```

Filters and sort fields are closed enums. Pagination cursors bind query digest,
projection epoch, last stable key, and expiry; modification or cross-query reuse
refuses. Empty UI distinguishes no runs, filter-empty, loading, stale, degraded,
owner unavailable, and projection failed.

The run list shows task-safe label, lifecycle, owner, target availability,
priority, safe age/duration, next action, live/abnormal process count, retry count,
diagnostic severity, and evidence/verdict/merge badges. Details provide tabs for
timeline, nodes/attempts, processes, files, checks, evidence/verdict, merge, usage,
diagnostics, and safe metrics. Clicking content-sensitive data opens the owning
authorized view after backend revalidation; operations never embeds it.

The timeline and structured table are equivalent. Keyboard users can filter,
sort, paginate, select, expand, route actions, and return focus. Live updates
preserve selection/scroll and use bounded polite announcements; failure,
quarantine, or residual processes are assertive and deduplicated. State is not
color-only. 200% zoom, high contrast, reduced motion, and virtualization of at
least 10,000 entries retain semantic order and accessible relationships.

## Authenticated stream and backpressure

The backend exposes one authenticated same-origin stream per window with CSRF/
session validation. A `StreamCursorV1` binds projection epoch and monotonically
increasing change sequence. Client acknowledgements are advisory for buffer
release, never owner cursors.

Per-client buffer is 1,000 changes or 1 MiB, whichever comes first. Current-row
updates and activity aggregates may replace an older unsent update for the same
projection key. Terminal, failure, cancel, cleanup, recovery, process-abnormal,
cursor-gap, and resync-required records cannot be coalesced. When a protected
record would overflow the buffer, emit `resync-required`, close the stream, and
require a snapshot query with the last verified cursor.

Reconnect with a current cursor resumes. Expired/unknown epoch, cursor ahead,
history retention gap, authentication change, or filter change requires resync.
Polling fallback uses exponential bounded intervals from 2 to 30 seconds and
shows freshness. Neither reconnect nor resync invokes owner actions.

## Action routing and authority

Operations supports only closed actions `cancel`, `pause`, `resume`, `retry`,
`diagnose`, and `open-owner-view`. The request binds user session/role, exact
owner/run/attempt, current projection sequence, action kind, and UUID idempotency
key. Bulk cancel expands in the backend to at most 50 exact run ids and requires
explicit confirmation; each result remains independent.

```text
requestAction(action):
  authenticate and validate closed schema
  resolve fact owner; read current owner state directly
  revalidate task/role/authority and action preconditions at owner
  persist operations action-requested safe event
  forward exact owner action; do not mutate projection optimistically
  persist receipt/refusal; wait for owner lifecycle event
  show requested/pending until owner event reaches projection
  show completed only when owner reports terminal result and required cleanup
```

Frontend enablement is informational. Direct RPC follows the same backend path.
Operations never cancels a PID, starts a process, modifies a queue row, admits
evidence, changes verdict, or merges. Unknown outcome stays pending/unknown until
owner reconciliation; it is never automatically retried.

## Process abnormality and completion rule

Expected process sequence is `reserved -> spawning -> started -> ready/activity
-> exited -> cleaning -> cleaned`. Spawn failure still requires cleanup. Timeout
or cancellation remains active until external descendant inventory is zero.

Abnormal codes are `PROCESS_RESERVATION_STALLED`, `PROCESS_SPAWN_STALLED`,
`PROCESS_IDENTITY_MISMATCH`, `PROCESS_UNREGISTERED_CHILD`, `PROCESS_IDLE_TIMEOUT`,
`PROCESS_ABSOLUTE_TIMEOUT`, `PROCESS_EXIT_WITHOUT_CLEANUP`,
`PROCESS_CLEANUP_ESCALATED`, `PROCESS_RESIDUAL`, `PROCESS_OWNER_LOST`,
`PROCESS_RECOVERY_ACTIVE`, `PROCESS_QUARANTINED`, and
`PROCESS_INVENTORY_UNKNOWN`. A terminal workflow/provider fact with any live,
abnormal, or unknown process projects `cleaning|degraded`, never completed.

Operations joins only operation-owner identity/process-group inventory. PID,
command, args, cwd, environment, and streams never enter the read model, UI,
logs, metrics, or support export.

## Closed metrics

Metrics are derived from accepted safe lifecycle facts and stored locally. Exact
names and units:

```text
kogg_operations_total{owner_kind,operation_kind,terminal_class}
kogg_attempts_total{owner_kind,node_kind,terminal_class}
kogg_retries_total{node_kind,safe_code_class}
kogg_refusals_total{owner_kind,safe_code_class}
kogg_recoveries_total{owner_kind,terminal_class}
kogg_quarantines_total{owner_kind,safe_code_class}
kogg_runs_active{lifecycle_class}
kogg_processes_active{process_kind,abnormal_class}
kogg_queue_wait_ms{owner_kind} histogram
kogg_run_duration_ms{owner_kind,terminal_class} histogram
kogg_process_cleanup_ms{process_kind,terminal_class} histogram
kogg_recovery_duration_ms{owner_kind,terminal_class} histogram
```

Labels are closed enums capped by catalog tests; no ids, digests, paths, names,
provider/model free text, error text, or dynamic values. Histograms use fixed
buckets `[10,50,100,250,500,1000,2500,5000,15000,60000,300000]` milliseconds.
Counters are monotonic within a projection epoch; restart/reset emits a new epoch
and UI break, never silently adds incompatible epochs. Usage is a table projection
and not exported as labels. No automatic instrumentation or network exporter is
enabled in V1.

## Persistence, rebuild, and retention

The projection uses SQLite WAL, full synchronous writes, foreign keys, strict
tables, bounded busy timeout, schema version, event-chain integrity, and a random
projection epoch. Tables separate owner cursors, accepted event digests, current
facts, run rows, causal edges, timeline rows, metric epochs, stream changes, and
safe faults. Owner payloads and raw content are never copied.

Rebuild acquires one lease, disables actions, verifies owners, drops only derived
tables, replays safe snapshots/events, checks deterministic row/metric digests,
atomically publishes a new projection epoch, then resumes streams. Crash leaves
the last verified epoch readable but visibly stale or causes another rebuild; it
cannot partially replace it.

Safe detailed projections retain 30 days by default, activity aggregates 90
days, and local metric epochs 90 days, unless task/incident/evidence/verdict/merge/
quarantine hold requires longer. Deletion affects only projection data. Owner
facts remain governed by their owners. Support export is explicit, local, private
mode 0600, checksummed, bounded to 10 MiB, expires after 24 hours, and is never
uploaded automatically.

## Observable lifecycle and diagnostics

Required exact logger/event families:

```text
kogg:operations:projection  start.requested|verify.started|replay.started|
                            current|degraded|rebuild.started|completed|failed
kogg:operations:owners      owner.verify.started|available|unavailable|
                            cursor.advanced|gap|rewind|conflict
kogg:operations:timeline    projection.updated|causal-gap|cycle|coalesced
kogg:operations:stream      connected|resumed|backpressure|resync-required|closed
kogg:operations:actions     requested|forwarded|owner-result|refused|failed
kogg:operations:metrics     update.completed|epoch-reset|validation.failed
kogg:operations:support     export.requested|completed|refused|failed|expired
```

Safe fields are logger/event, owner/schema, opaque correlation ids, closed state/
kind/safe code, bounded sequence/count/duration, boolean outcome, and required
non-content digest. Prohibited content listed in the owner-envelope contract is
also prohibited from exceptions, diagnostics, metrics, support, and frontend
console output. Raw exceptions map to `errorType` and safe code.

Final diagnostic ids are:

- `operations.projection`
- `operations.owners`
- `operations.correlations`
- `operations.timeline`
- `operations.processes`
- `operations.stream`
- `operations.metrics`
- `operations.support`
- `operations.actions`
- `operations.source-maps`

Every implementation file declares matching `diagnostic-coverage`. A missing,
throwing, stale, or incomplete contributor fails combined status. Source-map
checks prove browser/backend/Electron/projection breakpoints. Process diagnostics
compare owner facts, operation registry, and external inventory; disagreement
fails. Canary tests cover all prohibited classes and failure paths.

## #115 probe matrix and #116 visible E2E

#115 uses real task/workflow/adapter/operation/project/check/Ranex/verdict/merge
safe sources, SQLite projection, authenticated stream, real Git/check/provider
processes, and external inventory. Its primary scenario creates parallel attempts,
one failed retry, a hung child, check/evidence/verdict facts, cancellation
escalation, backend crash, recovery, projection deletion, and rebuild. Exact
attempt lineage and abnormal process visibility must survive with zero duplicate
terminal facts and zero residual children.

Table-driven faults cover duplicate/same and duplicate/conflicting events,
out-of-order delivery, gap/rewind/cycle, owner outage/schema/epoch change,
snapshot mismatch, projection corruption, concurrent refresh, stream overflow/
resume/resync, pagination cursor misuse, high-cardinality input, metric restart,
action duplicate/unknown result, support canaries/size failure, and 10,000-entry
virtualization. Each fault asserts a safe trace and independent owner oracle.

#116 drives the real browser and Electron UI by accessible roles:

```text
create several tasks -> queue serial and parallel runs -> open Operations
filter/sort/page runs -> inspect one causal timeline and every detail tab
observe a real process reserved through cleaned and one hung/recovered path
request cancel and diagnose -> wait for owner-confirmed projected results
restart backend -> resume stream -> delete/rebuild projection -> preserve owners
verify files/checks/evidence/verdict/retry/usage/merge/metrics/diagnostics
assert keyboard/table parity, focus, announcements, contrast/motion/zoom/scale
break at browser/backend/Electron projection source-map locations
scan logs/metrics/diagnostics/support for every prohibited canary
independently assert owner stores, Git/Ranex facts, and zero process inventory
```

Expected traces assert owner fact -> cursor advance -> projection transaction ->
stream delivery -> visible render. Action traces add backend request -> owner
revalidation -> owner lifecycle/cleanup -> new fact -> refresh. Gap/resync,
failure, cancel, recovery, rebuild, and degraded-owner traces are distinct.
Direct database insertion, mocked owned boundaries, service-only assertions,
screenshot-only checks, hidden abnormal processes, or missing lifecycle events
fail release. Required macOS, Ubuntu, and Windows application CI, `yarn test`,
observability audit, current Ranex evidence/verdict, and zero residual processes
remain mandatory.
