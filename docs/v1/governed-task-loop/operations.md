# Task queue, execution timeline, diagnostics, and basic metrics

Tracking: [#112](https://github.com/anthonykewl20/kogg/issues/112), research
phase [#113](https://github.com/anthonykewl20/kogg/issues/113).

## Status

Research is complete as of 2026-08-27. This packet contains no production code
and stops before decision-complete schemas and pseudocode. Those belong to #114,
followed by a real-boundary probe in #115 and production behavior plus real
human-level E2E in #116.

The recommendation is a read-model operations experience assembled from
authority-owned immutable facts and safe lifecycle projections. The queue,
timeline, process tree, file/check/evidence/verdict/merge summaries, retries,
usage, diagnostics, and metrics are views; none becomes a second scheduler,
process registry, task store, evidence journal, verdict authority, or merge log.

Every row must identify its fact owner and currentness. Correlation joins use
opaque IDs and exact non-content digests. Missing, delayed, duplicated,
out-of-order, conflicting, corrupt, or owner-unavailable input renders a visible
degraded/unknown state rather than inferred success. Abnormal live or residual
process state is always prominent and blocks a clean completion projection.

## Scope and invariants

V1 must let a human answer: what is queued, active, waiting, retrying, blocked,
failed, cancelling, cleaning, recovered, or complete; what task/run/node/attempt
owns it; which safe files/repository states and deterministic checks changed;
what evidence/verdict/merge facts exist and remain current; what processes are
live or residual; what bounded usage was observed; and which diagnostic explains
a refusal or stall.

- Task, workflow, adapter, execution, operation, project, Ranex, verdict, and
  merge components retain their existing authority and retention ownership.
- The operations UI consumes safe projections and never mutates source records.
- A queue position is advisory unless supplied by the owning scheduler. It is
  never interpreted as authority or a completion promise.
- Timeline ordering is per-owner sequence plus explicit causal links. Wall-clock
  timestamps alone never establish causality across processes/stores.
- A process is visible from reservation/registration through externally proven
  cleanup. Exit, terminal provider output, or an empty UI list is not cleanup.
- File presentation uses repository/object/worktree identity and bounded safe
  change classifications. Source, diffs, paths, and commit personal data do not
  enter operations telemetry or support bundles.
- Evidence and verdict views are verified projections from Ranex. Kogg never
  fabricates, edits, imports-as-trusted, or re-evaluates raw evidence.
- Usage and cost are bounded provider/executor observations, not invoices,
  evidence, quota authority, or success criteria. Unknown stays unknown.
- Retry rows are distinct attempts with exact cause, authority, and cleanup;
  histories are never collapsed into one misleading status.
- Logs, metrics, diagnostics, exports, and durable views exclude prompts, code,
  diffs, credentials, command/tool arguments or results, environments, paths,
  personal data, and raw provider/evidence/request/response bodies.

## Commit-pinned source ledger

Sources provide patterns only. No dependency or copied code is approved without
separate license, provenance, maintenance, and security review.

| Source | Exact revision and license | Reviewed paths | Finding and boundary |
| --- | --- | --- | --- |
| [Kogg/Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | Ranex commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25), MIT; Kogg pinned foundation tree | Ranex governed-execution journal/watchdog/recovery/observability; Kogg `packages/kogg-operations`, core diagnostics, task/project/provider/kernel packages, browser/Electron E2E | Select owner-tagged append-only lifecycle, register-before-spawn, safe failure codes, recovery reconciliation, diagnostic catalog, support bundle, and exact evidence projection. Kogg operations read models must not duplicate Ranex journal or become process/scheduler authority. |
| [Eclipse Theia](https://github.com/eclipse-theia/theia/tree/647dd3c7091b25ef3fc735edb74b949e7a195754) | v1.74.1 commit `647dd3c7091b25ef3fc735edb74b949e7a195754` (2026-08-06); EPL-2.0 or GPL-2.0-only with Classpath Exception, plus identified MIT/VS Code material | task, terminal, process, debug, SCM, testing, output, tree/timeline, status-bar, problem, progress, frontend contribution and source-map tests | Preserve contribution/view/widget seams, tree virtualization, progress/status, command routing, cancellation UI, debug/process presentation, accessibility, and source maps. Reject terminal/output text, frontend command state, SCM labels, and process handles as governed truth. |
| [Temporal UI](https://github.com/temporalio/ui/tree/4b43f7f92b086003a38363c18d1faa397bc5e6c4) | commit `4b43f7f92b086003a38363c18d1faa397bc5e6c4` (2026-08-26); MIT | workflow list/detail/history/timeline/event-grouping, pending activities, child workflows, retries, search/filter, accessibility and tests | Preserve separation between summarized workflow state and append-only event history, explicit retries/children/pending work, pagination, filters, and event grouping. Reject Temporal service/runtime dependency, arbitrary payload rendering, and replay semantics for Kogg side effects. |
| [Argo Workflows](https://github.com/argoproj/argo-workflows/tree/8f0d28008aaf288fe73bc380c174a8623d73a786) | commit `8f0d28008aaf288fe73bc380c174a8623d73a786` (2026-08-26); Apache-2.0 | `pkg/apis/workflow/v1alpha1/workflow_types.go`, controller node/status/progress logic, UI workflow graph/timeline/log/artifact views and tests | Preserve explicit node phases, parent/child graph, progress, retry lineage, resource/condition status, archived-versus-live distinction, and large-graph rendering. Reject Kubernetes as V1 control plane and reject human-readable status message/log/artifact content as safe operations data. |
| [OpenTelemetry JavaScript](https://github.com/open-telemetry/opentelemetry-js/tree/d0ce7532b058631ec9eec111c04fefe7fd873e1f) | commit `d0ce7532b058631ec9eec111c04fefe7fd873e1f` (2026-08-26); Apache-2.0 | API/SDK metrics, `doc/metrics.md`, views/exporters, resource and semantic-convention packages/tests | Preserve monotonic counters, up/down active counts, histograms, explicit units, bounded attributes, reader/export lifecycle, and semantic naming. Reject automatic instrumentation/exporters in V1: they can capture URLs, process/env, provider data, high-cardinality IDs, and add network/process dependencies. Implement a closed local metric projection first. |

Mutable project documentation corroborates the pinned code but is not a
reproducible decision source. Hosted dashboards and remote collectors are outside
local V1. Theia, Temporal, and Argo UI patterns are presentation references, not
authority or dependency selections.

## Existing foundation and ownership map

Kogg already has a durable operations registry/supervisor with operation and
process lifecycle, register-before-spawn, bounded bridge processes, shutdown and
restart recovery, safe log events, diagnostics, a private support bundle, and
browser/Electron production surfaces. Tasks add immutable specifications and
approvals; projects own repository identity; adapters and future workflow own
attempt semantics; Ranex owns evidence and verdicts.

The operations experience must join, not absorb, these facts:

| Fact | Authority | Operations projection |
| --- | --- | --- |
| task/revision/approval | task registry | safe identity, phase, current/refused |
| project/repository/worktree | project/execution owner | opaque identity, availability, safe state class |
| workflow queue/run/node | workflow scheduler | owner sequence, attempt state, dependencies |
| provider attempt/usage | adapter protocol | normalized state, bounded counters, unknown flags |
| process/cleanup | operation supervisor/execution owner | reservation through cleanup, live/residual counts |
| checks | kernel/check executor | kind, subject digest, terminal class, duration |
| evidence/verdict | Ranex | verified safe binding/result/currentness projection |
| merge | controlled merge owner | authorization/preflight/CAS/recovery safe state |
| diagnostic | catalog contributor | id, status, safe code, remediation id |

No cross-store transaction is implied. Each owner publishes an immutable safe
event or current snapshot with owner id, schema/version, sequence, correlation,
fact digest, and observed-at time. The read-model builder records its source
cursor and idempotently derives a projection. Conflicting owner facts degrade the
join and identify the unavailable/invalid owner; they are not resolved by latest
timestamp.

## Queue and run-list findings

Queue/list rows should remain dense and scannable: safe task label supplied by
the task UI, run/phase, owner, target availability, priority class, queued age,
active duration, next required action, live/abnormal process count, retry count,
diagnostic severity, and current evidence/verdict/merge badge. Free-form task
text never becomes a log/metric field.

Filters should cover project, safe lifecycle, owner/node kind, needs-attention,
abnormal process, diagnostic severity, evidence/verdict state, and bounded age.
Sorting is stable with owner sequence/id tie-breaks. Pagination/virtualization is
mandatory; live updates preserve selection and scroll position. Empty state must
distinguish genuinely empty, filter-empty, loading, owner unavailable, stale
cursor, and corrupted projection.

Actions are routed to the owning backend and revalidated there. Operations UI
may request pause/resume/cancel/retry/diagnose/open-owner-view where authorized,
but it never changes its own row to imply success before the owner event arrives.
Bulk cancel expands to exact run IDs, requires confirmation, and reports each
independent result/cleanup.

Queue estimates and positions are optional safe observations. Parallel resource
constraints make exact future ordering unstable. The UI should show `queued` and
blocking reason rather than false countdowns when the scheduler cannot guarantee
position/start time.

## Correlated timeline findings

Timeline entries require three order concepts:

1. owner-local monotonic sequence, authoritative within one event stream;
2. causal parent/event references across task/run/node/attempt/process/check/
   evidence/verdict/merge boundaries; and
3. wall-clock time for display only, with uncertainty/skew metadata.

A deterministic topological ordering uses causal edges first, owner sequence
second, timestamp/owner/id only as a display tie-breaker. Missing parents produce
a visible gap. Cycles, duplicate sequence with different digests, cursor rewind,
unknown schema, or owner reset degrade the timeline and diagnostic status.

The default timeline shows lifecycle boundaries, not noisy streams: request,
admission, wait, start, bounded activity summary, approval, retry, timeout,
cancel, process registration/exit/cleanup, check, evidence admission, verdict,
merge preflight/CAS, recovery, and terminal. Repeated activity is coalesced into
time buckets with exact counts and first/last times; original safe events remain
owner-retained. Coalescing never hides failure, cancellation, cleanup, recovery,
authority change, or abnormal process transitions.

Detail panels display safe correlation and binding summaries and link to the
owner's specialized view. They do not expose raw logs or protocol payloads.
Keyboard navigation, list/table alternative, focus stability, polite live-region
updates, and non-color state are required. Timeline animation respects reduced
motion.

## Process visibility findings

Process rows begin at `reserved/registered`, before spawn, and include safe
process kind/owner, operation/run/node/attempt correlations, lifecycle state,
start/last-activity age, deadline state, bounded CPU/memory/IO observations where
the qualified owner supplies them, descendant count, cancellation/cleanup phase,
and safe failure. PID, command, args, cwd, environment, and streams are not UI or
support data; backend diagnostics may use identity tokens internally.

Required abnormal classifications include reservation without process, spawn
pending too long, registered identity mismatch, unexpected/unregistered child,
idle/absolute timeout, exit without cleanup, cleanup escalation, residual child,
lost owner, recovery in progress, quarantine, and inventory unavailable. A
terminal run with a live/unknown process remains abnormal and cannot appear as a
clean completion.

Process tree joins come from the process/cgroup owner, not provider messages or
OS name matching. If descendant relationships cannot be proven, display
`inventory unknown` and block release-relevant success. Cancel requests remain
pending until external zero-descendant proof or quarantine.

## Files, checks, evidence, verdict, retry, and merge findings

File activity should show repository/worktree, base/subject commit/tree digests,
safe counts by `added/modified/deleted/renamed/type-changed/untracked-policy`, and
clean/dirty/conflicted/unknown. Paths and diffs stay in an explicitly authorized
SCM view, not durable operations records, logs, metrics, diagnostics, or exports.
Click-through revalidates current repository binding and access.

Checks show stable definition id/kind/version, exact subject digest, verifier
role, attempt, state, duration, result class, cleanup, and evidence applicability.
They do not display command/streams. A green process exit without admitted exact
evidence is `check passed; evidence pending`, not governed PASS.

Evidence and verdict rows show Ranex provenance, journal sequence/root digest,
claim/gate ids, bounded counts, subject/evidence-set/catalog digests, decision,
current/stale/blocked state, and safe explanation/remediation. Kogg cannot reorder
or suppress required failures to improve presentation. Raw evidence remains with
Ranex and is absent from support bundles.

Retries appear as a lineage: original attempt, safe terminal cause, cleanup,
authority/idempotency class, explicit/new authorization where required, and next
attempt. Aggregate run status never erases failed attempts. An unknown outcome is
not called retrying until the owner has reconciled or authorized a fresh attempt.

Merge rows must distinguish explanation current, human authorization pending/
recorded/expired/consumed, preflight, construction, ref CAS, post-verification,
recovery, committed, refused, and quarantined. Operations UI cannot expose an
agent-callable merge action or infer commit from process exit.

## Usage and basic metrics findings

V1 metrics are local, bounded, and derived only from safe lifecycle facts:

- counters: operations/attempts/checks by kind and terminal class; retries,
  refusals, timeouts, cancellations, recoveries, quarantines;
- up/down gauges: queued/active/waiting/cancelling/cleaning runs and live/abnormal
  registered processes;
- histograms: queue wait, run/node/check/process duration, first activity,
  cancellation, cleanup, recovery, diagnostic duration; and
- usage observations: input/output/total tokens, tool calls, and provider cost
  only when supplied and validated, each with known/unknown/partial status.

Metric attributes are closed low-cardinality enums: component/owner kind,
operation/node/check kind, terminal class, safe code category, runtime, and
qualification state. Never use task/project/run/node/attempt/process/session IDs,
digests, provider model free text, paths, user data, or error messages as labels.
Units and monotonicity are explicit. Counter resets/restart epochs are visible;
the UI does not sum incompatible provider usage or present cost as billing truth.

Automatic OpenTelemetry instrumentation is rejected for V1 because default HTTP,
process, runtime, database, and GenAI attributes may capture endpoints, paths,
environment, queries, prompts, models, or high-cardinality data. A future exporter
requires a separate threat/license/retention review and allowlisted views.

## Failure, recovery, retention, and refresh findings

Read-model lifecycle is `STOPPED -> VERIFYING -> REPLAYING -> CURRENT|DEGRADED`,
with `REBUILDING` and `FAILED` maintenance states. Admission of action requests
is disabled until owner stores/cursors and projection integrity verify. Projection
rows store source owner/version/sequence/digest, not raw payloads.

On startup the builder verifies schema, SQLite integrity, projection event chain,
owner cursor monotonicity, and referential constraints; then replays idempotently
from owner safe events or rebuilds from owner snapshots. The projection can be
dropped/rebuilt because it has no authority. Owner facts cannot be changed to fit
the projection.

Failure cases include unavailable owner, schema mismatch, cursor gap/rewind,
duplicate sequence with different digest, causal cycle, missing parent, stale
snapshot, projection corruption, outbox delay, browser disconnect, concurrent
refresh, diagnostic failure, clock skew, metric reset, support export failure,
and live/residual process disagreement. Each has a stable degraded classification
and keeps the last verified projection clearly marked with age, or hides it when
unsafe.

Retention follows owners. The operations projection retains safe lifecycle rows
for a bounded local period and then aggregates/deletes only projections not on an
incident/evidence/verdict/merge/quarantine hold. Deleting a projection never
deletes task, repository, workflow, evidence, verdict, or merge authority.
Support bundles are explicit, private, bounded, redacted, checksummed, and not
uploaded automatically.

Live refresh uses one bounded authenticated stream plus cursor-based resumption.
Backpressure coalesces activity and current-snapshot updates but never drops
terminal/failure/cancel/cleanup/recovery/process-abnormal events. Overflow closes
the stream with a safe resync requirement. Polling fallback is bounded and shows
freshness; client reconnect cannot mutate owner state.

## Observability and diagnostic risks

Candidate loggers are `kogg:operations:projection`, `kogg:operations:timeline`,
`kogg:operations:stream`, `kogg:operations:metrics`,
`kogg:operations:support`, and the existing registry/process/recovery loggers.
Required events include projection start/verify/replay/current/degraded/rebuild/
failure; owner cursor advance/gap; stream connect/resume/backpressure/resync/close;
action request/forward/result; metrics update/reset/failure; support export start/
complete/failure; and every existing operation/process lifecycle boundary.

Safe fields are timestamp, logger/event, opaque correlation ids, owner/schema,
bounded sequence/count/duration, lifecycle/terminal class, safe code, boolean
outcome, and non-content digest where operationally needed. Prohibited data is
never used to make debugging convenient. Raw owner exceptions map to safe codes
and error type only.

Candidate diagnostics for #114 to finalize:

- `operations.projection`: store/event-chain/rebuild/read-model integrity;
- `operations.owners`: owner availability, schema, cursor, freshness;
- `operations.correlations`: causal links, gaps, cycles, duplicates;
- `operations.timeline`: ordering/coalescing/pagination/accessibility;
- `operations.processes`: registration-to-cleanup and abnormal inventory;
- `operations.stream`: authentication, resume, bounds, backpressure, resync;
- `operations.metrics`: closed definitions, monotonicity, cardinality, reset;
- `operations.support`: bounded redacted private export and canary scan;
- `operations.actions`: owner routing, authority revalidation, result sync;
- `operations.source-maps`: browser/backend/Electron/projection breakpoints.

Missing or throwing contributors fail the combined diagnostic view. Every new
operational file must declare corresponding `diagnostic-coverage`. Failure tests
must prove diagnostics themselves cannot hide owner/process/projection failure.

## Prototype and real human-level E2E requirements

#115 must use real owner stores/events, SQLite projection, authenticated stream,
process supervisor, Git/check fixture, Ranex projection, and at least one real
provider attempt. It must probe causal ordering under duplicate/out-of-order/gap/
rewind events, projection loss/rebuild, owner outage/schema mismatch, concurrent
refresh, stream overflow/resume, high-cardinality attempts, metric restart,
support export canaries, and large timeline virtualization.

The highest-risk scenario creates parallel node attempts, a failed retry, a hung
child, independent check/evidence/verdict, cancellation escalation, backend crash,
and recovery. The UI projection must preserve exact attempt lineage and causal
boundaries, show the abnormal process until external cleanup proof, rebuild from
owners without duplicate/missing terminal facts, and contain no prohibited data.

#116 real browser/Electron E2E must visibly:

1. create multiple governed tasks and queue serial/parallel workflow runs;
2. inspect queue filters, one complete correlated timeline, files/checks,
   evidence/verdict, retry, usage, diagnostics, and metrics;
3. follow real processes from reservation through cleanup and expose one hung/
   residual/recovered path;
4. invoke an authorized cancel/diagnose action and wait for owner-confirmed result;
5. restart backend, resume the stream, and rebuild a deliberately removed safe
   projection without changing owner facts;
6. independently verify task/workflow/process/Git/Ranex/verdict/merge sources;
7. exercise keyboard/table alternatives, focus, screen-reader updates, high
   contrast, reduced motion, large-data pagination/virtualization;
8. validate browser/backend/Electron source maps and debugger breakpoints;
9. scan logs, metrics, diagnostics, and support export for prompt/code/diff/path/
   command/environment/credential/personal/provider/evidence canaries; and
10. pass `yarn test`, `yarn audit:observability`, three-OS application CI,
    qualified real execution, Ranex evidence/verdict, and zero-residual gates.

Expected safe traces include owner fact, projection cursor, stream delivery, UI
render, action routing, owner lifecycle/cleanup, and projection refresh. Failure,
cancel, recovery, gap/resync, and degraded-owner traces must remain separately
diagnosable. Direct database inserts, mocked owned boundaries, raw service-only
tests, or screenshots without independent oracles do not pass.

## Rejected approaches

| Candidate | Decision |
| --- | --- |
| Make one global operations table the source of truth | Reject; duplicates task/workflow/process/Ranex/verdict/merge authority and creates contradictory lifecycle. |
| Order all events by timestamp | Reject; clock skew and concurrency require owner sequence and causal links. |
| Treat terminal provider/run state as proof processes stopped | Reject; require external registered inventory and cleanup proof. |
| Render raw terminal/log/provider/evidence payloads | Reject; leaks content and makes support/telemetry unsafe. |
| Use paths/diffs/commit messages as timeline details | Reject; link to authorized owner views and retain safe classifications only. |
| Collapse retries into the latest result | Reject; hides failure, authority, side effects, and cleanup history. |
| Infer queue position/start time | Reject unless scheduler provides a guaranteed bounded observation. |
| Trust frontend action enablement | Reject; owning backend revalidates authority and current state. |
| Let operations UI cancel process by PID | Reject; route exact operation/attempt to process owner with identity-safe cleanup. |
| Automatically instrument/export OpenTelemetry | Reject in V1; uncontrolled attributes, network, retention, and process surface. |
| Put correlation IDs/digests in metric labels | Reject; high cardinality and linkability. |
| Treat provider token/cost as invoice or evidence | Reject; observations can be absent, partial, revised, or provider-defined. |
| Drop/coalesce cleanup/failure/recovery under load | Reject; these boundaries are mandatory for incident diagnosis. |
| Upload support bundles automatically | Reject; explicit local private export only. |
| Delete owner history when projection retention expires | Reject; projection has no authority over source retention. |
| Add Kubernetes/Temporal as the local V1 scheduler/operations service | Reject; control-plane dependency is disproportionate and does not satisfy Kogg ownership. |

## Decisions required from #114

#114 must fix source-event envelopes/cursors and projection schemas; queue/list/
timeline/process/check/evidence/verdict/retry/usage/merge safe fields; deterministic
causal ordering and coalescing; authenticated streaming/backpressure/resume;
action routing; projection persistence/rebuild/retention; metrics definitions and
cardinality; closed failure/log/event schemas; exact diagnostic ids; accessibility
behavior; debugger/source-map proof; and every #115/#116 fault/E2E seam.

The largest implementation risk is keeping a live multi-owner projection complete
and causally comprehensible across out-of-order delivery and restart without
turning it into authority or hiding abnormal processes. The second is proving
that every UI/support/metric route stays useful while excluding content and
high-cardinality secrets. #114 must close both with exact schemas and algorithms.

## Research gate conclusion

- Public source revisions, paths, dates, licenses, maintenance/security findings,
  selected patterns, and reuse boundaries are recorded.
- Queue, timeline, process, file/check/evidence/verdict/retry/usage/merge,
  failure/recovery, retention, stream, accessibility, observability, diagnostic,
  debugger, and real-E2E risks are explicit.
- Rejections preserve source authority, causal truth, process cleanup visibility,
  safe data, bounded cardinality, local-first operation, and owner retention.
- Findings are sufficient for #114 to write decision-complete pseudocode without
  reopening the read-model/owner boundary.

Production remains blocked until #114, #115, and #116 complete in order and all
observability, diagnostics, accessibility, debugger/source maps, real human-level
E2E, Ranex evidence/verdict, and zero-residual-process gates pass.
