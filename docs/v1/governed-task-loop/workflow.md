# Customizable autonomous Kogg Mode workflow

Tracking: [#87](https://github.com/anthonykewl20/kogg/issues/87), research
phase [#98](https://github.com/anthonykewl20/kogg/issues/98), and pseudocode
phase [#99](https://github.com/anthonykewl20/kogg/issues/99). Prototype findings
for [#100](https://github.com/anthonykewl20/kogg/issues/100) are recorded in
[`workflow-prototype-findings.md`](workflow-prototype-findings.md).

## Status

Research, decision-complete pseudocode, and the bounded real-boundary prototype
are complete as of 2026-08-27. This packet contains no production code. The #100
probe validated the core Theia/backend/process/recovery contract and identified
production hardening requirements; #101 must implement the complete contract and
ship with visible human-level E2E.

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
run. In V1, a group is an explicit visual/organizational record whose complete
member graph is stored in that immutable template version and validated by the
compiler. It is never an opaque runtime subflow. Cross-template composition is
outside the V1 schema; adding it later requires a separately specified,
version-bound reference and compile-time expansion contract.

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

The scheduler materializes all nine policy anchors in their fixed order. It
records the workflow-owned frozen-specification, approved-specification,
checks-complete, and cleanup-complete proofs transactionally, and persists each
externally owned producer-separation, evidence-admission, current-PASS,
merge-preflight, and controlled-merge attempt before dispatch. Requests bind the
immutable plan, task admission, repository, exact deterministic-check subject,
and preceding fact. Successful external results must return a closed
subject/fact binding plus a strictly increasing owner sequence; subject drift is
forbidden until the controlled-merge result. Missing or malformed authority,
refusal, sequence replay, deadline cancellation with residual work, and
ambiguous restart state all fail closed and can never produce a completed run.

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

#100 probed the highest-risk core boundaries with a real Theia frontend/backend,
SQLite WAL store, production operation supervisor, and real child processes. Its
exact evidence, validated decisions, reopened production requirements, and
platform limits are in `workflow-prototype-findings.md`.

#101 must extend that evidence across the complete backend compiler/store
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

## Decision-complete workflow contract and pseudocode

This section is normative for #100 and #101. `MUST` and `MUST NOT` are release
gates. The pseudocode fixes ownership and behavior; production naming may follow
repository conventions without weakening it.

### Canonical records and version ownership

All workflow records use the repository canonical JSON profile: UTF-8 NFC,
lexicographically sorted keys, signed 64-bit integers, fixed lowercase digests,
no floats, no duplicate/unknown keys, and explicit schema versions. Digest is
`sha256(utf8("kogg:workflow:<domain>:v1\n") || canonicalJson(record))`.
Domains are `draft`, `template`, `catalog`, `trust-spine`, `compiled-plan`,
`run-snapshot`, `grant`, `condition`, `node-attempt`, and `event`.

```text
record WorkflowDraftV1 {
  draftId: uuid
  baseTemplateVersionId: uuid-or-null
  revision: positive integer
  projectId: uuid
  displayName: bounded user text (not logged)
  nodes: sorted EditableNodeV1[]
  edges: sorted EditableEdgeV1[]
  groups: sorted GroupV1[]
  layout: EditorLayoutV1
  updatedAt: RFC3339
}

record WorkflowTemplateVersionV1 {
  templateId: uuid
  versionId: uuid
  versionNumber: positive integer
  parentVersionDigest: sha256-or-null
  projectId: uuid
  canonicalGraphDigest: sha256
  catalogDigest: sha256
  createdAt: RFC3339
  createdByAuthorityDigest: sha256
  migrationLineage: MigrationRecordV1[]
}
```

Drafts are mutable only by optimistic compare-and-swap on `(draftId, revision,
baseTemplateVersionId)`. Conflict returns the current revision and safe conflict
code, never overwrites dirty client state. Save validates the whole graph and
appends a new immutable template version in one SQLite transaction. Template
versions, compiled plans, run snapshots, attempts, and events are append-only.
Deleting a draft cannot delete a template or run.

Templates import/export only canonical declarative records plus catalog/spine
compatibility requirements. Signatures or repository ownership do not make an
import executable. Import creates a draft, strips layout fields unknown to V1,
rejects unknown executable fields, and requires normal backend compilation.

### Closed catalog, nodes, ports, and configuration

The signed `NodeCatalogV1` binds each node kind/version to exact input/output
ports, configuration schema, executor artifact, grant ceiling, retry class,
side-effect class, deadline limits, diagnostic id, and compatibility range.
Runtime plugin or npm node installation is absent in V1.

Editable node kinds are closed:

```text
research.agent         advisory research, no repository mutation
pseudocode.agent       decision packet update, bounded private worktree
probe.agent            real-boundary probe, qualified target required
implementation.agent   production mutation, approved specification required
tool.git               closed Git operation from catalog
tool.build             closed build operation from catalog
check.deterministic    independently owned exact-subject check
approval.specification explicit human approval boundary
approval.continue      optional human pause boundary
control.condition      closed typed branch
control.parallel       fork into statically declared branches
control.join           all|all-settled join for exact fork
control.group          compile-time visual/organizational expansion only
control.finally        cleanup/failure convergence
```

Policy-owned nodes are not editable and are injected by the compiler:

```text
anchor.spec-frozen
anchor.spec-approved
anchor.producer-separated
anchor.checks-complete
anchor.evidence-admitted
anchor.ranex-pass-current
anchor.merge-preflight
anchor.controlled-merge
anchor.cleanup-complete
```

Each node id is a UUID stable within one template lineage. Ports have stable
catalog ids and cardinality `one`, `optional-one`, or `many`. Edges bind exact
source/output and target/input ports and may carry only safe typed references,
not prompt/code/output bodies. A group has members and nested display order but
no runtime semantics, grant, condition, or hidden edge; compilation expands it
to its visible member graph.

Node configuration is a tagged closed record. Agent nodes bind role id,
provider id, exact model id, adapter artifact/profile digests, input reference
ids, repository target policy, timeout, and bounded retry policy. Tool/check
nodes bind catalog operation/check ids and immutable configuration digests.
Approval nodes bind approver role and expiry. Control nodes bind only the closed
condition/fork/join schemas below. Prompts and source content live in separately
authorized content stores and are referenced opaquely; they are not stored in
workflow records, logs, diagnostics, or metrics.

The production implementation exposes one optional external-executor authority
boundary. It accepts exactly two complete, digest-attested contracts:
`kogg.execution.catalog@1.0.0` owns `tool.git` and `tool.build`, while
`kogg.kernel.checks@1.0.0` owns `check.deterministic`. Each contract lists a
sorted, nonempty closed binding-id set for every kind it owns. A tool node stores
one `operationId`; a deterministic-check node stores one `checkId`; both store
only the immutable external configuration digest. Raw configuration, argv,
paths, command output, and check output never enter the workflow record or log.
Missing, partial, forged, mutable, duplicate, or unknown owner contracts leave
all three node kinds unavailable. Owner readiness additionally requires complete
startup recovery and zero residual processes. Runtime dispatch rechecks the exact immutable
plan, task admission, repository, node configuration digest, owner artifact,
binding id, closed result schema, process count, and zero-residual success before
committing the scheduler outcome. The workflow deadline remains authoritative;
expiry invokes the external owner's cancellation boundary and refuses completion
unless cancellation returns a closed zero-residual proof.

A successful external result is not a generic success bit. The closed result
also carries the exact repository subject-state digest, the owning subsystem's
fact digest, and its positive monotonic owner sequence. All three are committed
with the node attempt in the same scheduler transaction as the outbox outcome.
Missing, open-shaped, malformed, or partially populated fact bindings normalize
to an external failure before persistence; restart integrity checks refuse any
stored partial or malformed binding. These opaque bindings are never logged and
are the only external-node inputs later policy anchors may consume when proving
checks, evidence, verdict currentness, or controlled merge.

### Editor command and template interface

The backend accepts these exact draft commands, all with draft revision CAS:

```text
draft.create
draft.node.add | draft.node.configure | draft.node.remove
draft.edge.connect | draft.edge.disconnect
draft.group.create | draft.group.configure | draft.group.remove
draft.layout.update
draft.validate
template.version.save
template.version.fork
template.import-as-draft | template.export
```

Every structural command performs local schema validation, then whole-graph
validation before commit. A command that would make an invalid intermediate
graph may be stored only in `draft` validation state and cannot be versioned or
run. Remove explains dependent edges/groups and asks explicit confirmation in
the UI; the backend still treats the final requested record as untrusted.

The editor provides spatial canvas and structured outline parity. Keyboard users
can add, configure, connect, disconnect, reorder, group, validate, version, and
start without drag-and-drop. Every node/port/edge has an accessible name and
relationship. Validation focuses the first error and exposes the complete list;
focus returns to the invoking control after dialogs. Runtime updates use polite
announcements except approval, failure, and cancellation, which are assertive
but deduplicated. Reduced motion disables animated edges; zoom, high contrast,
non-color state, and virtualization preserve semantic order.

Starting selects project-scoped metadata projections for one immutable compiled
plan and one durable task admission. The UI never reconstructs either authority
snapshot and never treats presence in a selector as authorization: the backend
revalidates the plan, task admission, current interaction mode, executor health,
and every external grant at admission time, then returns only a closed safe code
on refusal.

### Conditions, parallelism, retries, and deadlines

Conditions are data, not code:

```text
ConditionV1 =
  { op: "and" | "or", terms: ConditionV1[1..16] } |
  { op: "not", term: ConditionV1 } |
  { op: "eq" | "neq", left: SafeRefV1, right: SafeLiteralV1 } |
  { op: "in", left: SafeRefV1, values: SafeLiteralV1[1..32] } |
  { op: "status-is", nodeId: uuid, value: closed terminal status } |
  { op: "safe-code-is", nodeId: uuid, value: closed safe code }
```

Depth is at most 8 and total predicates at most 64. Safe references address only
typed status, safe code, boolean, bounded integer, or catalog enum outputs from
dominating nodes. No strings containing content, time/randomness, filesystem,
environment, network, dynamic property access, regex, arithmetic, functions, or
model output participate. Both possible branch paths are compiled and proven.

`control.parallel` declares 2–8 branch ids. Its matching join names the exact
fork and is either `all` (all must succeed) or `all-settled` (failure router sees
every terminal branch). Nested parallel depth is 4 and maximum expanded nodes
is 256. No free cycle is legal. The only repetition is per-node retry:

```text
RetryPolicyV1 {
  maxAttempts: 1..3
  retryableSafeCodes: subset fixed by node catalog
  backoffMs: one of 0, 1000, 5000, 15000
  sideEffectPolicy: "none" | "idempotent-exact-key" | "fresh-authority"
}
```

An attempt is retried only after terminal cleanup, unchanged plan/authority/
subject preconditions, and catalog approval for the safe failure. Each retry has
a new attempt id and process/credential scope. `fresh-authority` pauses for an
explicit new authorization; unknown outcomes never retry automatically.

Each node has catalog-bounded spawn, first-progress, idle, absolute, cancel,
cleanup, and approval deadlines. Run deadline is no greater than the sum of the
longest statically possible path plus bounded pauses and is frozen in the run
snapshot. Deadline expiry follows the declared failure edge after cleanup; it
cannot skip a required anchor or extend itself.

### Static graph compilation and trust-spine proof

```text
compile(template, requestedRun):
  verify canonical bytes, template lineage, catalog/spine signatures/versions
  expand groups; reject hidden nodes/edges and expansion > 256
  validate closed configs, ports, cardinality, edge types, targets, and grants
  reject cycles, dangling/unreachable nodes, ambiguous forks/joins, dead ends,
    unbounded behavior, missing failure/finally routes, and unsafe conditions
  compute dominators and post-dominators on every possible branch outcome
  inject policy-owned trust-spine nodes and edges
  prove every production-mutation node is dominated by frozen+approved spec
  prove every evidence node is dominated by separated deterministic checks
  prove every merge path is dominated in order by all mandatory anchors
  prove cleanup post-dominates every process/external-call node
  intersect every requested grant with task, role, catalog, project, repository,
    provider/model, execution-target, and trust-spine ceilings
  reject unused/widened/ambiguous grant or identity collision
  emit immutable CompiledPlanV1 with proof witnesses and exact digests
```

The injected spine is semantic, not merely a visual chain. The compiler builds
a product graph across success, refusal, failure, timeout, cancellation, retry,
and recovery edges. `anchor.controlled-merge` has exactly one incoming route
whose dominator sequence is frozen specification, authenticated approval,
producer separation, exact deterministic checks, admitted evidence, current
Ranex PASS, and merge preflight. All other terminal routes go through cleanup
and cannot emit merge authority.

Backend runtime rechecks the relevant proof witness and current external facts
before every authority-bearing transition. Forged UI anchors, manipulated stored
graphs, direct RPC calls, or catalog drift fail. The UI cannot create an anchor
or mark it satisfied.

### Role, provider, model, project, and worktree binding

```text
record NodeGrantV1 {
  runId: uuid
  nodeId: uuid
  attemptId: uuid
  roleId: closed role
  providerId: closed provider
  modelId: exact model
  adapterArtifactDigest: sha256
  projectId: uuid
  repositoryId: uuid
  repositoryBindingDigest: sha256
  worktreePolicy: "read-only-snapshot" | "private-writable" |
                  "independent-verifier"
  baseCommit: native Git object id
  allowedOperations: sorted catalog ids
  credentialGrantDigest: sha256-or-null
  executionProfileDigest: sha256
  expiresAt: RFC3339
}
```

Research defaults read-only. Pseudocode/probe/implementation mutate only a new
private worktree owned by the attempt; production implementation additionally
requires current specification approval. Deterministic verification uses a
separate read-only/execution worktree at the exact subject commit and a verifier
identity distinct from producer, approver, credential, adapter process, and
writable worktree. Project/repository selection comes from the project registry
and must equal the task binding. Model aliases and provider fallback are absent.

The scheduler mints no authority. It requests an attempt grant from the owning
controller, verifies its signed digest, passes only that node's subset to the
executor, and revokes it on any terminal transition. A node cannot delegate,
spawn another graph node, change provider/model/target, or retain credentials.

### Immutable run snapshot and compatibility

```text
record WorkflowRunSnapshotV1 {
  runId: uuid
  templateVersionDigest: sha256
  compiledPlanDigest: sha256
  catalogDigest: sha256
  trustSpineDigest: sha256
  taskRevisionDigest: sha256
  specificationApprovalDigest: sha256
  projectRepositoryBindingDigest: sha256
  roleBindings: sorted map<roleId, bindingDigest>
  providerModelBindings: sorted map<nodeId, bindingDigest>
  executorArtifacts: sorted map<nodeKindVersion, sha256>
  executionProfiles: sorted map<nodeId, sha256>
  createdAt: RFC3339
  absoluteDeadline: RFC3339
}
```

Admission copies no mutable template state; it stores exact immutable digests and
proof witnesses. Editing/versioning afterward cannot affect the run. A backend
upgrade may resume an active run only if it retains exact decoders/executors for
every snapshot version and their artifact digests match. Compatible migration is
allowed only before run admission and appends a new template version with a
signed deterministic migration record. There is no in-place active-run migration
or best-effort interpretation. Missing historical executor yields
`WORKFLOW_EXECUTOR_INCOMPATIBLE` and cleanup/quarantine, not replay.

### Scheduling and lifecycle state machines

One durable scheduler lease owns a run. Ready nodes are selected in canonical
node-id order, limited by the snapshot concurrency ceiling. Parallel branches
may run concurrently only when their worktree/write/resource grants do not
conflict; otherwise admission refuses rather than silently serializing semantics.

```text
RunState =
  ADMITTED | RUNNING | PAUSING | PAUSED | CANCELLING | CLEANING |
  SUCCEEDED | FAILED | CANCELLED | QUARANTINED

AttemptState =
  BLOCKED | READY | INTENT_RECORDED | DISPATCHED | ACTIVE |
  WAITING_APPROVAL | RESULT_OBSERVED | CLEANING |
  SUCCEEDED | FAILED | CANCELLED | UNKNOWN | QUARANTINED
```

```text
schedulerTick(run):
  acquire/renew compare-and-swap lease
  verify event chain, snapshot, spine proof, authority, and process inventory
  derive projection by deterministic replay of safe events
  for each READY node in canonical order within concurrency/resource limits:
    append external/process intent and idempotency key before dispatch
    mint exact NodeGrantV1 and register intended process before start
    dispatch once; append transition in same transaction as outbox record
  publish safe outbox projections after commit
```

Provider completion is `RESULT_OBSERVED`; the attempt succeeds only after result
qualification, credential revocation, process cleanup, and required repository
state capture. External calls and side effects use intent-before-dispatch plus
exact idempotency where supported. Lost acknowledgements enter `UNKNOWN` and a
node-specific reconciler determines the unique outcome. It never guesses or
replays an unknown non-idempotent effect.

Pause stops new scheduling after active attempts reach safe boundaries. Resume
requires the same snapshot, unexpired authority, exact executor compatibility,
and fresh external preconditions. Approval pause persists only request digest,
approver-role requirement, expiry, and safe status; approval is signed and bound
to run/node/attempt/input digest. Duplicate/late approval is refused.

Failure routing begins only after the failed attempt cleans up. One declared
failure edge may lead to bounded remediation or `control.finally`; it cannot
enter the success port of an anchor. Unhandled failure cancels all live siblings,
joins cleanup, and fails the run.

```text
cancelRun(reason):
  atomically set CANCELLING and stop new node admission
  revoke pending approvals, credentials, and unused grants
  signal every active node owner in parallel
  each owner interrupts, TERM/KILL escalates, drains, and proves zero descendants
  wait bounded cancel-all-then-join across every branch
  quarantine any ambiguous/residual attempt and its worktree
  append one terminal run event only after all branches report cleanup
```

### Persistence, outbox, restart recovery, and deletion

SQLite WAL tables contain immutable template versions, compiled plans, snapshots,
attempt/event chains, leases, intents, safe results, approvals, and outbox rows.
Every event has run sequence, previous digest, idempotency key, timestamp,
transition, safe code, and correlation ids. Content is referenced, never copied.
Foreign keys, unique constraints, quick/full integrity, event-chain replay, and
snapshot digest validation run before admission.

Outbox publication is at-least-once with projection idempotency ids. Duplicate
UI events cannot duplicate scheduler state. UI acknowledgement is never a commit
point. On restart:

```text
recoverRun(run):
  acquire recovery lease; validate stores and immutable snapshot
  disable scheduling for run
  reconcile every intent against process registry, executor, Git, provider,
    evidence, verdict, and merge owner using exact ids/digests
  kill and drain residual owned processes before state advancement
  classify unique completed, safe retryable, failed, unknown, or quarantined
  revalidate trust spine and current external anchors
  append recovery transitions; enable only proven READY nodes
```

Recovery after a provider terminal but before durable acknowledgement qualifies
the exact attempt if independently discoverable; otherwise it remains UNKNOWN.
After evidence or verdict, Ranex is queried by exact immutable binding. After
merge intent, only the controlled-merge owner may reconcile repository state;
the scheduler never repeats merge.

Draft deletion is immediate if unreferenced. Template archival hides it from new
runs but preserves versions referenced by history. Run/worktree deletion requires
terminal cleanup, retention expiry, no evidence/verdict/merge hold, and explicit
controller disposition. Quarantined state is never auto-deleted.

### Closed safe failures, events, logs, and metrics

Safe codes are closed:

```text
WORKFLOW_OK                         WORKFLOW_SCHEMA_INVALID
WORKFLOW_VERSION_CONFLICT           WORKFLOW_CATALOG_MISMATCH
WORKFLOW_GRAPH_INVALID              WORKFLOW_CYCLE
WORKFLOW_PORT_INVALID               WORKFLOW_UNREACHABLE
WORKFLOW_JOIN_AMBIGUOUS             WORKFLOW_BOUND_EXCEEDED
WORKFLOW_CONDITION_INVALID          WORKFLOW_ANCHOR_BYPASS
WORKFLOW_AUTHORITY_EXPANSION        WORKFLOW_ROLE_SEPARATION
WORKFLOW_TARGET_MISMATCH            WORKFLOW_EXECUTOR_INCOMPATIBLE
WORKFLOW_APPROVAL_REQUIRED          WORKFLOW_APPROVAL_INVALID
WORKFLOW_DEADLINE                   WORKFLOW_RETRY_REFUSED
WORKFLOW_OUTCOME_UNKNOWN            WORKFLOW_EXTERNAL_FAILURE
WORKFLOW_PROCESS_FAILED             WORKFLOW_CLEANUP_FAILED
WORKFLOW_RESIDUAL_PROCESS           WORKFLOW_RECOVERY_FAILED
WORKFLOW_STALE_EVIDENCE             WORKFLOW_STALE_VERDICT
WORKFLOW_MERGE_REFUSED              WORKFLOW_STORE_INTEGRITY
WORKFLOW_CANCELLED                  WORKFLOW_INTERNAL
```

Loggers are `kogg:workflow:editor`, `kogg:workflow:compiler`,
`kogg:workflow:engine`, `kogg:workflow:executor`,
`kogg:workflow:recovery`, and `kogg:ui:mode-selector`. Closed events are:

```text
draft.command.requested|completed|refused
template.version.requested|created|failed
compile.started|completed|refused
run.admission.started|completed|refused
run.started|paused|resumed|cancel.started|cancel.completed|terminal
node.ready|intent.recorded|dispatch.started|active|activity|result.observed
node.approval.requested|received|expired|refused
node.retry.scheduled|refused
node.cleanup.started|completed|failed|terminal
anchor.validation.started|satisfied|refused
recovery.started|node.reconciled|run.reconciled|quarantined|failed
```

Allowed fields: timestamp, logger/event, workflow/template/version/run/node/
attempt/operation/process correlation ids, node kind/version, transition, attempt
number, safe code, boolean outcome, bounded duration/count, and non-content
digests. Never log names/free text, prompts, source/code/diffs, credentials,
paths, tool/command arguments/results, environments, provider bodies, raw errors,
or event payloads. Metrics use node kind, transition class, safe code, terminal
class, and bounded duration/concurrency buckets only; ids/digests are not labels.

Seeded canary tests cover direct, encoded, fragmented, nested-error, provider,
process, approval, content-reference, and support-bundle paths. Unknown errors map
to `WORKFLOW_INTERNAL` after discarding raw strings.

### Diagnostic and debugger contract

#101 adds these exact runtime diagnostic ids:

| Diagnostic id | Fail-closed check |
| --- | --- |
| `workflow.schema` | canonical records, decoder versions, migration fixtures |
| `workflow.catalog` | signed catalog, executor artifacts, compatibility |
| `workflow.graph` | ports, reachability, bounds, fork/join, conditions |
| `workflow.anchors` | injected spine, dominator proof, runtime freshness |
| `workflow.authority` | grant intersection, role separation, target binding |
| `workflow.scheduler` | lease, ready derivation, outbox, concurrency |
| `workflow.processes` | intent/registration/attempt/process correspondence |
| `workflow.cleanup` | cancel-all-then-join and zero descendants |
| `workflow.recovery` | event chain, unknown outcomes, restart reconciliation |
| `workflow.accessibility` | outline parity and semantic graph relationships |
| `workflow.source-maps` | browser/backend/Electron/executor breakpoints |

Diagnostics return only id, status, safe code, schema/catalog/spine/profile
digests, bounded counts/durations, and remediation id. Every operational file
declares relevant `diagnostic-coverage`. Missing/throwing contributors fail the
entire workflow diagnostic projection.

Source maps remain enabled. Debugger proof reaches editor command, compiler
validation and anchor injection, admission, scheduler selection, intent/outbox,
executor dispatch, approval, cleanup, and restart reconciliation from browser,
backend, Electron, and node executor code. Breakpoint mapping is automated in CI
for deterministic seams and manually evidenced for the real-boundary probe.

### #100 probe and #101 visible E2E handoff

#100 uses the real compiler/store/scheduler, process registry, private Git
worktree, one real provider node, one deterministic check, and real Ranex
evidence/verdict lookup. It checks golden canonical digests and fault-injects
every lifecycle transition. Exact negative fixtures include forged UI anchors,
direct backend requests, deleted/reordered anchors, self-verification, cycles,
dangling/unreachable graphs, ambiguous joins, condition abuse, grant widening,
stale approval/evidence/verdict, branch drift, catalog/executor mismatch, concurrent
draft writes, outbox duplicates, lease theft/expiry, provider terminal loss,
hung/escaped child, cleanup residual, and restart around every intent/commit.

The principal probe runs parallel producer/check preparation with one hung child,
cancels all, TERM/KILL escalates, joins cleanup, restarts, and proves no node or
merge path advances. A second run loses acknowledgement after an idempotent
external boundary and reconciles exactly once. Every outcome asserts the safe
code/event sequence, immutable history, no prohibited canary, and external zero
process proof.

#101 visible browser and Electron E2E MUST:

1. start with an idea and build a graph using both canvas and keyboard outline;
2. configure serial and parallel nodes, a condition, failure/finally route,
   bounded retry, timeout, approval, two roles/providers/models, and target;
3. validate and save two immutable versions while provoking one CAS conflict;
4. run research, pseudocode, real probe, approved production implementation,
   independent deterministic check, evidence, current Ranex verdict, and
   controlled merge through visible controls;
5. visibly handle one approval, retryable failure, cancellation, and restart;
6. independently verify template/snapshot digests, Git/worktree state, Ranex
   evidence/verdict, merged product behavior, diagnostics, and process inventory;
7. attempt anchor removal/reorder, forged completion, self-verification, stale
   evidence/verdict, active-template mutation, and merge after cancel; and
8. pass accessibility, source-map/debugger, canary log/export,
   `yarn test`, `yarn audit:observability`, real E2E, Ranex verdict,
   controlled-merge, and zero-residual-process gates.

The safe success trace is draft/version, compile, admission, node intent/start/
activity/result/cleanup/terminal in dependency order, anchor satisfaction,
current verdict, merge preflight, controlled merge, cleanup, and run terminal.
Failure, cancel, and recovery traces use their named events and cannot omit a
lifecycle boundary whose absence would prevent diagnosis.

No implementation choice remains for #100: schemas, catalog, editor commands,
conditions, parallel/retry/deadline semantics, compiler proof, grants/targets,
snapshots/compatibility, scheduler states, persistence/recovery, safe logs,
diagnostics, accessibility, fault seams, and visible E2E are fixed. A real probe
incompatibility blocks production rather than weakening a trust anchor.

## Research and pseudocode gate conclusion

- Public graph editor, durable scheduler, agent orchestration, and workflow
  engine sources are commit-pinned with paths, licenses, maintenance/security
  implications, reusable patterns, and explicit rejections.
- Graph schema, execution, versioning, replay, validation, accessibility,
  failure recovery, cancellation, and process observability are compared.
- Mandatory trust anchors are represented as a policy-owned compiled spine and
  enforced independently of editable UI state at compile and runtime boundaries.
- The selected architecture and all formerly unresolved decisions now hand #100
  a decision-complete real-boundary probe contract.

Production remains blocked until #99, #100, and #101 complete in order and all
observability, diagnostics, accessibility, debugger, real E2E, Ranex evidence,
current verdict, controlled-merge, and zero-residual-process gates pass.
