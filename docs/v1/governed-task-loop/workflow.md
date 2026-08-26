# Customizable autonomous Kogg Mode workflow

Tracking: [#87](https://github.com/anthonykewl20/kogg/issues/87), research
phase [#98](https://github.com/anthonykewl20/kogg/issues/98).

## Status

Research is complete as of 2026-08-27. This packet contains no production code
and deliberately stops before decision-complete schemas and pseudocode. Those
belong to #99, followed by a real-boundary prototype in #100 and production
implementation plus real human-level E2E in #101.

The recommendation is a versioned declarative workflow template compiled by a
backend authority validator into an immutable run plan. The editable graph owns
only supported customization inside a frozen envelope. A separately versioned,
non-editable trust spine injects and verifies specification approval, producer/
verifier separation, deterministic checks, evidence integrity, current Ranex
PASS, and controlled merge. The UI renders and edits a projection; it is never
the source of truth for authorization or mandatory anchors.

Every run binds the exact template version, trust-spine version, node catalog,
role/provider/model snapshots, project/repository targets, authority grants,
executor versions, and input specification before admission. Editing creates a
new template version and cannot rewrite an active or historical run. Recovery
continues only from durable, idempotent control state; provider or tool side
effects are never replayed merely because a node event was lost.

## Scope and non-negotiable invariants

Kogg Mode must support users who add, remove, configure, connect, reorder, and
group supported agent, research, tool, check, approval, and control-flow nodes;
assign roles/providers/models; select serial or parallel execution; configure
conditions, bounded retries, timeouts, cancellation, failure routes, project and
private-repository targets; save/version templates; and inspect live execution.

Customization never weakens these invariants:

- a frozen specification revision is explicitly approved before production
  mutation;
- a producer cannot approve or deterministically verify its own result;
- required deterministic checks and integrity-bound evidence precede verdict;
- a current Ranex PASS for the exact evidence/commit precedes controlled merge;
- controlled merge is the only merge-capable node and cannot be invoked from an
  arbitrary tool or agent node;
- workflow edits create a new immutable version and never alter a run snapshot;
- invalid, cyclic, unreachable, unsupported, unbounded, ambiguous, or authority-
  expanding graphs are refused before execution;
- each node receives only an explicit subset of the run grant and cannot mint a
  role, credential, process, repository, approval, evidence, verdict, or merge
  authority;
- retries are bounded new attempts with explicit idempotency/side-effect policy,
  never transparent replay of an unknown outcome;
- cancellation propagates to all live descendants and completion waits for
  cleanup proof;
- every Kogg-created process is registered before start and mapped to one run,
  node attempt, owner, deadline, and cleanup result; and
- logs, diagnostics, metrics, templates, and lifecycle records never contain
  prompts, code, diffs, credentials, tool arguments/results, command arguments,
  environments, personal data, or raw provider payloads.

## Commit-pinned source ledger

External source is used for patterns only. No copied code is approved by this
research record; production reuse requires dependency and license review.

| Source | Exact revision and license | Reviewed paths | Security and maintenance result |
| --- | --- | --- | --- |
| [Xyflow / React Flow](https://github.com/xyflow/xyflow/tree/b1b99e9773040e25bd6099762491ab23d8ea6910) | commit `b1b99e9773040e25bd6099762491ab23d8ea6910` (2026-08-25); MIT | `packages/react/src/components/A11yDescriptions`, `NodeWrapper`, `EdgeWrapper`; `container/ReactFlow`, `GraphView`; `types/component-props.ts`, `nodes.ts`, `edges.ts`; connection, keyboard, selection, grouping, viewport hooks | Select as a candidate visual editor primitive: controlled nodes/edges, connection validation hooks, grouping, keyboard focus, ARIA descriptions/live regions, minimap, and viewport virtualization. It is not a schema validator, durable engine, authority boundary, or accessible non-visual editor by itself. |
| [Argo Workflows](https://github.com/argoproj/argo-workflows/tree/8f0d28008aaf288fe73bc380c174a8623d73a786) | commit `8f0d28008aaf288fe73bc380c174a8623d73a786` (2026-08-26); Apache-2.0 | `examples/dag-*`, `retry-*`, `suspend-template.yaml`, `synchronization-*`, `parallelism-*`; `docs/walk-through/dag.md`, `suspending.md`, `retries.md`, `synchronization.md`, `metrics.md`, `tracing.md`; `workflow/controller`, `workflow/sync` | Reuse declarative DAG dependency expressions, explicit retry strategy, suspension, exit/failure routing, parallelism and synchronization concepts. Reject Kubernetes/controller status and pod lifecycle as Kogg authority; Argo permits general executable templates and does not encode Kogg trust anchors. |
| [Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript/tree/55e65eeaafc480b1d23fc2cccb470765264d249a) | commit `55e65eeaafc480b1d23fc2cccb470765264d249a` (2026-08-26); MIT | `packages/workflow/src/workflow.ts`, `cancellation-scope.ts`, `internals.ts`; `packages/common/src/workflow-options.ts`, `retry-policy.ts`; `packages/worker/src/replay`, `workflow`; `packages/testing`; replay and versioning tests | Preserve event-history determinism, explicit activity boundaries, cancellation scopes, timeouts, retry policies, signals, child ownership, replay testing, and version-safe code evolution. Do not adopt a remote Temporal service for V1: it adds an operational/control plane and its activity success/termination still cannot prove local descendant cleanup. |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs/tree/01f61f9adeb0e2ada1c0550a6432c44d5296c8fc) | commit `01f61f9adeb0e2ada1c0550a6432c44d5296c8fc` (2026-08-24); MIT | `libs/langgraph-core/src/graph`, `state`, `pregel`, `interrupt.ts`, `constants.ts`, `func`; checkpoint packages; `docs/docs/concepts`, `how-tos`, `agents/human-in-the-loop.md` | Reuse typed state transitions, conditional edges, fan-out, recursion limits, checkpoints, interrupts, and explicit resume commands as conceptual patterns. Reject model/tool-directed `Command.goto`, arbitrary graph replay/time travel, open state payloads, and checkpointer ownership as authorization or evidence. |
| [Node-RED](https://github.com/node-red/node-red/tree/1f38dc899b1d6d24b05369023ef2d83b808cd55d) | commit `1f38dc899b1d6d24b05369023ef2d83b808cd55d` (2026-08-13); Apache-2.0 | `packages/node_modules/@node-red/editor-client/src/js/ui`, `view`, `nodes`, `history`; `@node-red/runtime/lib/flows`; `@node-red/registry/lib/subflow.js`, `installer.js`; deploy/runtime tests | Keep palette, node configuration, grouping/subflow, validation, undo/history, diff/deploy, runtime status, and keyboard-access patterns. Reject executable npm node installation, mutable live redeploy, arbitrary function nodes, message-payload routing, and editor/runtime flow JSON as the governed execution contract. |
| [Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | vendored provenance commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25); MIT | `src/ranex/cli/delegation.py`; `src/ranex/observability/schema.py`, `redaction.py`; evidence/verdict/credential/watchdog ADRs and slices | Preserve kernel-owned task/evidence/verdict authority, empty-by-default child environments, process-group ownership, bounded deadlines, startup reconciliation, closed observability, and credential brokering. Kogg orchestrates calls but cannot synthesize, rewrite, or bypass Ranex evidence and verdict state. |

All repositories were read at the exact revisions above. Hosted documentation
may change independently and is not the authority for #99. The pinned source
paths and future Kogg schemas must be sufficient to reproduce every decision.

## Source findings

### Xyflow: editor projection, not authority

React Flow supports controlled node and edge collections, custom node/edge
renderers, connection callbacks and validation, parent/group relationships,
selection, dragging, keyboard deletion and multi-selection, viewport controls,
and render-only-visible optimization. Its node and edge wrappers expose focus,
ARIA roles and labels, keyboard movement, descriptive instructions, and an ARIA
live region. These are strong building blocks for a responsive graph canvas.

The library deliberately delegates graph semantics to the host. An
`isValidConnection` callback can improve interaction feedback but cannot be the
only validator: clients are mutable, concurrent edits race, imports bypass UI
gestures, and historical schemas evolve. Kogg must validate the complete graph
on the backend against a pinned node catalog and trust-spine policy before
saving or running it.

Canvas accessibility is not complete accessibility. #99 must require a fully
keyboard-operable node palette and property inspector, deterministic focus after
add/delete/connect, announced validation errors, visible focus and status, no
color-only state, reduced-motion support, zoom-independent text, and an
equivalent structured list/outline editor for users who cannot manipulate a
spatial graph. The accessible outline edits the same draft, not a lossy copy.

The UI never hides mandatory trust anchors as if they were absent. It renders
the injected trust spine as locked, explains why each anchor exists, and shows
which editable nodes feed it. A malicious client that omits those visuals still
cannot alter the compiled plan.

### Argo: declarative DAG and bounded execution patterns

Argo separates templates from workflow instances, represents DAG dependencies
explicitly, supports conditional dependency expressions, parallel roots and
joins, bounded retry strategies, workflow/task timeouts, synchronization,
parallelism, suspend/resume, exit handlers, and node status/metrics. These are
useful vocabulary for Kogg's declarative template and attempt projection.

Kogg cannot adopt Argo's execution semantics wholesale. Argo templates can run
arbitrary containers/scripts, retry policies are operational rather than Kogg
authority decisions, and a suspended node is not an approval record. Kubernetes
object status, pod completion, logs, and archive state do not prove Kogg process
cleanup, evidence integrity, verifier independence, or a current Ranex PASS.

Kogg adopts explicit dependency and failure-route syntax but replaces free-form
expressions with a closed typed condition language over safe lifecycle facts.
No prompt, output, source, error text, environment, or arbitrary JavaScript is
condition input. Parallel branches use structured join policies and always join
cleanup even after fail-fast cancellation.

### Temporal: determinism and code/version discipline

Temporal records workflow events and replays deterministic workflow code while
external side effects live in activities. It supplies cancellation scopes,
timers, signals, child workflows, distinct activity timeout classes, bounded
retry policies, and replay tests. The key lesson is that orchestration decisions
must be reconstructable from durable facts and that code evolution must remain
compatible with histories already in flight.

Kogg will not use event replay to re-execute provider or tool nodes. Each node
attempt is an external side effect with its own durable intent, idempotency key,
process inventory, and terminal/cleanup states. Recovery re-evaluates the next
control transition from committed safe facts. A missing terminal event never
means retry is safe.

Template version, trust-spine version, compiler version, node-catalog digest,
condition-language version, and executor versions are stored on every run. A
runtime may continue a historical run only when its exact semantics remain
available and qualified. Otherwise it freezes the run for safe cancellation or
migration review; it never silently recompiles with current code.

A Temporal service is rejected for V1 because Kogg already requires a local
durable registry and qualified process supervisor. Adding another control plane
would not remove the need for Kogg authority, content redaction, process
registration, or Ranex evidence integration.

### LangGraph: typed state, interrupts, and bounded routing

LangGraph provides graph/state schemas, conditional edges, fan-out, subgraphs,
retry policies, recursion limits, checkpoints, interrupts, and explicit
`Command({resume})`. Its human-in-the-loop pattern demonstrates that a pause
needs durable state and a correlated resume value rather than a transient UI
modal. Its checkpointer and replay/time-travel features also demonstrate why
saved state must have a versioned schema.

Kogg narrows these patterns. A model, tool, or arbitrary node cannot return a
destination such as `Command.goto`; the compiler owns every possible edge, and
runtime conditions inspect only allowlisted safe facts. Resume of an approval
node carries the identifier and digest of an independently stored approval
record, not arbitrary payload. Checkpoints contain lifecycle/control facts, not
prompts, model outputs, tool data, source, diffs, or credentials.

Time travel is rejected for governed execution because branching from a past
checkpoint after external side effects can duplicate work or detach evidence.
Users may clone a historical template/run configuration into a new draft, but a
new run receives new authority and identifiers and starts from an approved
initial state.

### Node-RED: editor ergonomics and mutable-flow risks

Node-RED demonstrates a mature node palette, property dialogs, groups/subflows,
wire validation, undo/history, import/export, diff-based deploy choices, runtime
node status, and stop/start behavior. These patterns inform usability and the
separation between a draft/editor model and running instances.

Its generic message flow and installable npm nodes are intentionally too open
for Kogg. Function nodes, mutable payloads, runtime module installation, and
partial live deploy can introduce code and authority outside a closed catalog.
Kogg does not mutate a running graph. Saving creates a new immutable version;
starting binds that version; editing produces a new draft/version for a future
run. A reusable group is a versioned template reference expanded and validated
by the compiler, never an opaque runtime subflow.

### Ranex: external trust and evidence authority

Ranex remains an independent authority below specific Kogg nodes. Kogg may
request a governed task operation and display its safe projection, but it cannot
manufacture task identity, evidence, a verdict, or signing/merge authority. Raw
Ranex journals and content-bearing tails do not enter the Kogg workflow store.

The trust spine requires exact bindings across frozen specification, repository,
private worktree/run repository, commit, deterministic check results, evidence
manifest, verifier identity, verdict, and merge request. Any stale or mismatched
binding invalidates downstream readiness and routes to a typed refusal/cleanup
state, never around the anchor.

## Template, compiled plan, and run separation

The workflow system needs four distinct immutable identities:

1. **Draft** is mutable user editing state. It has optimistic concurrency and
   may be invalid. It cannot run and is not referenced by evidence.
2. **Template version** is a canonical, content-addressed, backend-validated
   declaration of editable nodes, edges, groups, configuration, and metadata.
   It contains no credentials or prompts.
3. **Compiled plan** combines one template version with the trust-spine version,
   pinned node catalog/compiler, and project policy. It expands groups, injects
   anchors, resolves every edge, computes grants, proves graph properties, and
   is signed or integrity-bound by Kogg.
4. **Run snapshot** binds one compiled plan to a frozen specification revision,
   project/repository target, role/provider/model snapshots, credential grant
   references, executor versions, deadlines, and safe initial inputs. Its node
   attempts and transitions append durable facts; it is never rewritten.

Display layout is separated from semantic identity. Moving a node does not
change execution semantics; changing kind, configuration, edge, group expansion,
role/model, condition, retry, timeout, target, or anchor dependency does. The
canonical digest excludes nondeterministic serialization and UI-only viewport
state but includes every authority-relevant field.

## Closed node and edge model for #99

The initial catalog should define, at minimum, typed node families:

- specification input/freeze and mandatory specification approval;
- research, pseudocode, real-boundary probe, approved implementation, and real
  human-level E2E orchestration;
- provider agent attempt bound to one frozen role/provider/model;
- deterministic check/evidence collection bound to one commit;
- independent verification with producer/verifier separation;
- Ranex task/evidence request and current verdict observation;
- controlled merge request;
- explicit human approval/refusal;
- serial, parallel fork, all/any/threshold join, bounded loop/retry, typed
  condition, timeout, cancellation scope, and failure/finally route; and
- project/private repository target selection under the qualified execution
  policy.

Each port declares its accepted safe artifact/state type, multiplicity, and
authority effect. Edges carry only references to durable typed records. Arbitrary
payload expressions and script nodes are forbidden. Node kinds and schema
versions resolve from a signed/compiled-in catalog, not a marketplace download.

Retries are allowed only for node kinds whose policy names retryable typed
failures and a side-effect strategy. Every retry gets a new attempt ID, bounded
count/backoff, unchanged or explicitly re-approved grant, and its own cleanup.
Timeouts have idle, absolute, approval, and cleanup classes as applicable.

## Independent trust-spine enforcement

Mandatory anchors cannot be ordinary editable nodes. The compiler performs all
of these independent checks:

1. Loads the policy-owned trust-spine definition by exact version.
2. Validates the editable template without trusting client validation.
3. Expands groups and rejects cycles, dangling ports, unsupported kinds,
   unbounded loops/retries, unreachable required work, ambiguous joins, invalid
   targets, and authority escalation.
4. Injects or binds the specification approval, independent verifier,
   deterministic checks/evidence, current Ranex verdict, and controlled merge
   anchors in a fixed partial order.
5. Proves every path to production mutation crosses frozen-spec approval and
   every path to merge crosses verification, evidence, current PASS, and merge
   authorization.
6. Proves producer identities cannot satisfy verifier/approval constraints and
   that failure/cancel paths cannot reach merge.
7. Computes least-authority grants for every node and rejects unknown effects.
8. Emits a canonical plan/digest and a human-readable validation report.

The runtime rechecks anchor preconditions transactionally at each boundary. A
valid compiled plan cannot rely on compile-time truth for mutable facts such as
current verdict or branch head. The controlled-merge node revalidates all exact
bindings immediately before mutation.

## Execution and durable recovery model

The backend scheduler owns a durable state machine. A node attempt passes through
requested, admitted, process-intent (when applicable), started, active,
provider-terminal-observed, cleaning, cleaned or cleanup-failed, then qualified,
completed, failed, cancelled, timed-out, blocked, or refused as allowed by its
kind. Downstream readiness depends on the qualified terminal state, not merely
provider completion.

Transitions use compare-and-swap run generations and an outbox/claim lease so a
restart cannot dispatch the same side effect twice. Admission writes intent
before spawn/external call. Completion commits the typed result reference and
outgoing readiness atomically. A lease expiry triggers reconciliation, not
automatic replay.

On startup—even with no queued work—the scheduler scans every nonterminal run,
node attempt, process intent, approval wait, external operation, and outbox item.
It fences old owners, reconciles process/cgroup and provider/Ranex state, resumes
only pure control evaluation, and routes uncertain side effects to cleanup/
blocked review. A historical executor version must be available before
continuation.

Parallel cancellation is cancel-all-then-join: stop admitting siblings, signal
every active branch, await or escalate cleanup under one deadline, persist every
cleanup result, then evaluate the join/failure route. Fail-fast affects new work,
not cleanup accountability.

## Safe observability and diagnostics

Production uses `kogg:workflow:editor` for draft/save validation boundaries and
`kogg:workflow:engine` for compile, admission, transition, dispatch, cancellation,
cleanup, recovery, and completion. The interaction-mode selector uses
`kogg:ui:mode-selector`; it does not own workflow authority.

Allowed log fields are closed: workflow/template/plan/run/node/attempt/operation
identifiers, safe parent IDs, node kind/schema, transition, attempt count,
compiler/catalog/spine versions and digests, duration, deadline class,
process-count class, safe outcome/failure code, and cleanup result. Never log
node configuration values unless individually classified safe, and never log
prompts, output, source, diffs, tool data, commands, arguments, paths,
environments, credentials, personal data, raw exceptions, or provider payloads.

Diagnostics must validate:

- schema/compiler/catalog/trust-spine availability and digest consistency;
- stored template and compiled-plan canonical integrity;
- graph validity and mandatory-anchor path proofs;
- active run snapshot/version resolvability;
- scheduler lease/outbox health and recovery backlog;
- node-state/process-registry correspondence and residual processes;
- approval waits and age buckets;
- executor/provider/Ranex bridge readiness by safe status;
- evidence/verdict/merge-binding freshness by safe result; and
- stuck, ambiguous, unsupported, cleanup-failed, or unrecoverable runs.

#101 must add exact diagnostic catalog/runtime coverage, failure tests for every
signal whose absence can hide stuck or residual work, and debugger proof across
browser/editor, Node scheduler, provider adapters, execution supervisor, Ranex
bridge, and controlled merge. Source maps and `yarn audit:observability` remain
release-blocking.

## Accessibility requirements for #99 and #101

The canvas and structured outline must support the same operations. Required
E2E coverage includes keyboard-only add/configure/connect/reorder/group/delete,
screen-reader names and relationships, announced validation errors and runtime
transitions, focus restoration, zoom and high-contrast modes, reduced motion,
non-color state indicators, large graphs with virtualization, and locked-anchor
explanations. Drag-and-drop is never the only way to construct or reorder a run.

Live execution must not continuously steal focus. Status updates use bounded
polite announcements except urgent approval/failure states. The timeline and
graph share selection and expose node attempts, deadlines, safe failure codes,
process counts, and cleanup state without revealing prohibited content.

## Required prototype and E2E evidence

#100 must probe the highest-risk boundaries with the real backend compiler/store
and at least one real provider/process node:

- client bypass of validation, forged locked anchors, and unknown node kinds;
- cyclic, dangling, unreachable, authority-expanding, ambiguous-join, and
  unbounded retry/loop graphs;
- every alternate path attempting to bypass specification approval,
  independent verification, evidence, current PASS, or controlled merge;
- immutable version save, concurrent draft conflict, active-run edit, historical
  executor compatibility, and canonical digest stability;
- serial/parallel/failure/finally/condition/approval/cancel/timeout transitions;
- crash before and after intent, dispatch, provider terminal, cleanup, evidence,
  verdict, and merge precondition checks;
- duplicate events, lease expiry, outbox replay, stale approval, stale verdict,
  branch-head drift, and cleanup residuals;
- cancel-all-then-join with one hung child and process escalation;
- logs/diagnostics seeded with prohibited-content canaries; and
- keyboard and structured-outline parity on a representative graph.

#101 real human-level E2E starts from an idea, edits and versions a workflow,
assigns two provider roles, runs research through approved implementation and
real E2E, handles one approval and one failure route, obtains exact evidence and
a current Ranex verdict, performs controlled merge, and proves all processes are
clean. Negative scenarios remove/reorder anchors, self-verify, use stale evidence
or verdict, mutate an active template, and attempt merge after cancellation;
every case must fail closed visibly and diagnostically.

## Rejected alternatives

| Candidate | Decision |
| --- | --- |
| Store the React Flow node/edge array as executable authority | Reject; it is client/UI state without canonical schema, version, grants, or trust-spine proofs. |
| Represent mandatory anchors as deletable or merely locked UI nodes | Reject; malicious/imported clients bypass UI state. Inject and enforce them in the backend compiler/runtime. |
| Allow arbitrary JavaScript/expression/function nodes | Reject; unbounded code can inspect content, widen authority, and evade static path analysis. Use a closed typed condition language. |
| Adopt Argo/Kubernetes as the V1 scheduler | Reject; adds a control plane and general container authority without satisfying Kogg evidence/process semantics. |
| Adopt a Temporal service as the V1 scheduler | Reject; useful durability patterns, but another control plane does not replace Kogg's local authority and process registry. |
| Use LangGraph checkpoint/replay as evidence or authorization | Reject; state can contain model/tool content and replay can duplicate external side effects. |
| Permit model/tool-directed dynamic `goto` | Reject; all possible destinations and grants must be compiler-known. |
| Install Node-RED/npm-style custom executable nodes | Reject; supported node catalog is pinned and reviewed, not runtime marketplace code. |
| Partially redeploy/mutate an active run | Reject; edits create a new version and new runs. Historical snapshots remain immutable. |
| Retry any failed node automatically | Reject; retry needs an allowlisted failure, bound, unchanged authority, new attempt, and side-effect/idempotency decision. |
| Treat provider completion as node completion | Reject; cleanup and result qualification are separate mandatory states. |
| Let producer satisfy verification/approval | Reject through identity/role constraints in compiler and runtime. |
| Cache Ranex PASS without exact freshness binding | Reject; revalidate exact evidence/commit/current verdict immediately before merge. |
| Persist raw node payloads/events for debugging | Reject; durable control store contains safe facts and references only. |
| Offer only a spatial drag-and-drop editor | Reject; require keyboard and structured outline parity. |

## Decisions required from #99

#99 must resolve exact schemas for drafts, template versions, compiled plans,
run snapshots, node kinds/ports/config, typed conditions, grants, attempts,
transitions, approvals, retries/timeouts, group expansion, canonicalization and
digests; the trust-spine injection/path-proof algorithm; catalog/version
compatibility; optimistic editing; durable leases/outbox/recovery; process and
external-call intents; cancel-all-then-join; safe event/log/diagnostic schemas;
accessibility behavior; and every #100 fault-injection seam.

The hardest decision is a static authority analysis expressive enough for useful
parallel/conditional workflows but closed enough to prove every merge path
crosses mandatory anchors. The second is upgrade compatibility for active runs.
#99 must define both algorithms and refusal behavior; it cannot defer them to UI
conventions or production implementation judgment.

## Research gate conclusion

- Public graph editor, durable scheduler, agent orchestration, and workflow
  engine sources are commit-pinned with paths, licenses, maintenance/security
  implications, reusable patterns, and explicit rejections.
- Graph schema, execution, versioning, replay, validation, accessibility,
  failure recovery, cancellation, and process observability are compared.
- Mandatory trust anchors are represented as a policy-owned compiled spine and
  enforced independently of editable UI state at compile and runtime boundaries.
- The selected architecture and unresolved decisions are specific enough for
  #99 to produce decision-complete pseudocode without reopening the topology.

Production remains blocked until #99, #100, and #101 complete in order and all
observability, diagnostics, accessibility, debugger, real E2E, Ranex evidence,
current verdict, controlled-merge, and zero-residual-process gates pass.
