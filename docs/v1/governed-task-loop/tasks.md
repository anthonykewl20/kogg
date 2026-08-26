# Governed tasks and frozen specification revisions

Tracking: [#71](https://github.com/anthonykewl20/kogg/issues/71), research phase
[#74](https://github.com/anthonykewl20/kogg/issues/74), and pseudocode phase
[#77](https://github.com/anthonykewl20/kogg/issues/77), and prototype phase
[#80](https://github.com/anthonykewl20/kogg/issues/80).

## Status

Research, decision-complete pseudocode, and the real-boundary prototype are
complete as of 2026-08-26. This packet contains no production code. Production
remains gated by the ordered implementation issue and by Foundation
[#47](https://github.com/anthonykewl20/kogg/issues/47).

The research recommendation is a backend-owned, machine-local task registry with
append-only specification revisions and lifecycle events. Editing changes a draft;
freezing creates an immutable, content-digested revision; approval names that exact
revision and its current authority context; revocation is a new durable event and
never deletion. A later edit creates a successor draft and cannot inherit approval.

## Scope and constraints

The task slice owns:

- requirement intake and editing for one task in one registered project;
- exactly one repository binding per V1 task, using the existing projects authority;
- immutable specification revision history, freeze, explicit approval, revocation,
  and safe refusal;
- the current task/revision projection reconstructed from durable records; and
- visible history sufficient to explain which exact revision is draft, frozen,
  approved, superseded, or revoked.

It does not own project/repository identity, workspace trust, credentials, provider
or agent selection, worktrees, execution, checks, evidence, verdicts, or merge.
Creating, editing, freezing, approving, or revoking a task must not start an agent,
provider, Git command, terminal, Ranex request, or other subprocess.

Specifications and requirement text are content-bearing source material. Kogg may
store them locally because the feature requires it, but must never place them in
logs, diagnostics, support bundles, metrics, operation summaries, URLs, or error
messages. Frontend DTOs may carry specification content only over the authenticated
local Theia service boundary for the active user's explicit edit/view operation.

## Commit-pinned source ledger

External source is used for patterns only. No copied code is approved by this
research record.

| Source | Exact revision and license | Reviewed paths | Finding |
| --- | --- | --- | --- |
| [GitHub Spec Kit](https://github.com/github/spec-kit/tree/c58a8487461052b4fa65e626df167521d297b184) | commit `c58a8487461052b4fa65e626df167521d297b184` (2026-08-25); MIT | `templates/spec-template.md`, `templates/tasks-template.md`, `src/specify_cli/workflows/engine.py`, `src/specify_cli/workflows/steps/gate/__init__.py`, `docs/reference/workflows.md` | Durable specification/plan/task artifacts, explicit review gates, non-interactive pause/resume, bounded review rendering, and fail-loud invalid gate options are useful UX patterns. Its own code states workflow requirements are advisory and shell steps run with user privileges, so neither the workflow nor gate is a Kogg security authority. |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec/tree/6926ccb18afa4ff621112813e9968334576ee11a) | commit `6926ccb18afa4ff621112813e9968334576ee11a` (2026-08-24); MIT | `src/core/archive.ts`, `src/core/artifact-graph/state.ts`, `src/core/change-status-policy.ts`, `src/core/specs-apply.ts`, `src/commands/validate.ts`, `docs/cli.md` | Separate active changes from current specifications; validate before archive; claim destinations; restore partial spec mutations; retain recoverable state on cleanup failure. File existence and task checkboxes are workflow progress signals, not approval or evidence, and `--yes` is unsuitable for a mandatory human authority boundary. |
| [TUF specification](https://github.com/theupdateframework/specification/tree/59e601ed29c0d2e497264ae8b31c11b8ef07df1e) | commit `59e601ed29c0d2e497264ae8b31c11b8ef07df1e` (2026-08-10); Community Specification License 1.0 for the specification, Apache-2.0 for included source unless marked | `tuf-spec.md`, `governance/04-license.md` | Monotonic versions, expiration, hash/length binding, consistent snapshots, and explicit rollback/freeze/mix-and-match refusal show that a trusted old object must never replace a newer known one. Kogg should adopt the invariants, not TUF's update roles or wire format. |
| [in-toto](https://github.com/in-toto/in-toto/tree/a8ce9ee2125ae5a4b041a4e37cc1cf10eed0da6b) | commit `a8ce9ee2125ae5a4b041a4e37cc1cf10eed0da6b` (2026-05-19); Apache-2.0 | `in_toto/models/layout.py`, `in_toto/models/metadata.py`, `in_toto/in_toto_verify.py`, `in_toto/verifylib.py`, `doc/source/model.rst` | Signed layouts bind authorized functionaries, ordered steps, materials, products, thresholds, and expiration. Kogg should preserve intent/producer/evidence role separation; a task approval is not execution evidence or a verdict. |
| [Kubernetes](https://github.com/kubernetes/kubernetes/tree/fbb9a10c7a0469a6f076873289e18bd680402c80) | commit `fbb9a10c7a0469a6f076873289e18bd680402c80` (2026-08-25); Apache-2.0 | `staging/src/k8s.io/apiserver/pkg/storage/interfaces.go`, `staging/src/k8s.io/apiserver/pkg/registry/rest/update.go` | Opaque resource versions, UID/version preconditions, conflict results, and update retries against freshly read state are strong stale-write patterns. Kogg needs a smaller local transactional form and must not silently replay a human approval against changed content. |
| [Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript/tree/2453adf91b5287bbd81fb24e04ebd43f1b4cf42f) | commit `2453adf91b5287bbd81fb24e04ebd43f1b4cf42f` (2026-08-26); MIT | `packages/worker/src/workflow/interface.ts`, `packages/workflow/src/cancellation-scope.ts`, workflow history replay tests | One activation at a time, durable replay, cancellation propagation, and non-cancellable cleanup are useful lifecycle patterns. Kogg task authoring itself owns no activity process and does not need a workflow engine; later execution may project task IDs into one. |
| [Eclipse Theia](https://github.com/eclipse-theia/theia/tree/647dd3c7091b25ef3fc735edb74b949e7a195754) | `v1.74.1`, commit `647dd3c7091b25ef3fc735edb74b949e7a195754` (2026-08-06); EPL-2.0 or GPL-2.0-only with Classpath Exception, with separately identified MIT/VS Code material | `packages/core/src/common/messaging`, `packages/core/src/browser/saveable.ts`, `packages/workspace`, `packages/core/src/browser/widgets` | Use Theia widgets, dirty-state affordances, commands, and JSON-RPC separation, but keep task authority in the backend. Editor save state and frontend storage are not freeze or approval records. |
| [Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | vendored provenance commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25); MIT | `src/ranex/foundation/specification_abc.py`, `governed_execution/domain/specification_approval.py`, `specification_events.py`, `application/specification_approval.py`, `docs/adr/ADR-030-approval-and-intersected-grants.md`, `docs/slices/done/SLICE-032-approval-and-intersected-grants.md` | Closed canonical records bind an exact specification digest, policy digest, role snapshot, nonce, predecessor, and validity window. Ordered approval/revocation events and least-authority grants are the downstream authority model Kogg must feed without duplicating Ranex's journal or pretending a Kogg UI click is a Ranex grant. |

Primary documentation reviewed:

- [Theia architecture](https://theia-ide.org/docs/architecture/) defines the
  frontend/Node backend split and JSON-RPC boundary.
- [Theia workspace trust](https://theia-ide.org/docs/workspace_trust/) requires
  execution-capable features to remain restricted for untrusted roots.
- [SQLite atomic commit](https://sqlite.org/atomiccommit.html) documents transaction,
  locking, flush, crash rollback, and hot-journal recovery.
- [SQLite isolation](https://sqlite.org/isolation.html) documents serializable writes
  and snapshot isolation; Kogg still needs explicit expected-revision checks.
- [Kubernetes API concurrency control](https://kubernetes.io/docs/reference/using-api/api-concepts/#resource-versions)
  documents opaque resource versions and conflict handling.
- [TUF specification](https://theupdateframework.github.io/specification/latest/)
  documents version, expiry, rollback, freeze, and mix-and-match defenses.
- [in-toto model](https://in-toto.readthedocs.io/en/latest/model.html) documents
  signed layouts, authorized functionaries, links, and verification.
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) documents deterministic JSON
  canonicalization. Kogg should use an explicit versioned encoding and published
  digest vectors rather than relying on ordinary `JSON.stringify` behavior.

## Source findings

### Spec Kit

Spec Kit persists named workflow runs and can pause a non-interactive review gate
for later resume. Its gate validates option shapes, fails loudly on unknown reject
behavior, bounds displayed file lines, strips terminal controls, and defaults an
interrupted prompt toward rejection. These are good presentation and recovery
patterns.

They are not an approval security model. The reviewed engine explicitly calls
workflow `requires` advisory and states that shell steps retain user privileges.
The gate stores a choice in workflow output but does not bind that choice to a
canonical specification digest, current repository binding, principal, nonce, or
revocation chain. Kogg may borrow the visible pause/review shape, never its
authority claim.

### OpenSpec

OpenSpec keeps proposed changes separate from current specs, derives dependency
status from an artifact graph, validates before applying changes, claims archive
destinations, and attempts to restore specs when finalization fails. Its archive
flow treats unavailable interactive input as a blocked decision and provides an
explicit rerun rather than guessing. These are strong failure-visibility patterns.

Completion can still be inferred from file presence or checked task boxes, and
non-interactive `--yes` intentionally bypasses confirmation. Those are appropriate
developer workflow conveniences but insufficient for governed approval. Kogg must
record an authenticated, digest-bound approval event and cannot equate an archive,
checkbox, generated file, or directory move with human authorization.

### TUF and in-toto

TUF separates an object's version, expiry, hashes, and length, and refuses rollback,
freeze, and combinations of metadata that never existed together. For Kogg, every
client mutation must present the current opaque registry revision; every approval
must bind the exact frozen revision digest; and a superseded or revoked approval
must never become current again after restart, cache replay, or stale frontend use.

in-toto separates signed intent (layout) from functionary-produced evidence (links)
and verifies authorization, order, materials, and products. Kogg must preserve the
same category separation: specification approval grants bounded authority to begin
later work, but does not claim that work ran, passed, produced a particular Git
tree, or may merge.

### Kubernetes and Temporal

Kubernetes `ResourceVersion` preconditions demonstrate that identity and expected
version are checked together and that an update callback may observe different
current content on retry. Kogg should not auto-retry non-idempotent freeze,
approval, or revocation decisions. A stale request returns a typed conflict and the
user must review current state. Idempotent replay is allowed only for the same
request ID and the same canonical request digest.

Temporal serializes activations and reconstructs state through recorded history.
Its cancellation tree also separates cancellable work from cleanup that must run
after cancellation. The task slice needs the append-only/reduction concept, not a
Temporal dependency: task mutations are short backend transactions with no owned
child process. Later workflow/execution packages consume immutable task facts.

### Ranex

Ranex is the downstream authority for executable approval/grant facts. Its C record
binds specification, policy, roles, nonce, predecessor, and a position window;
approval events form a digest-linked ordered chain; revocation and expiry are new
facts reduced against an observed prefix. A grant cannot widen parent or policy
authority, and incompatible roles are refused.

Kogg must therefore expose enough immutable, canonical task data for the later
kernel-evidence slice to construct and verify Ranex records. Kogg must not sign on
behalf of a person, store private signing keys in the task database, mint a Ranex
grant from a frontend click, rewrite Ranex events, or treat its own task history as
evidence-journal authority.

## Pattern comparison and decision

| Candidate | Integrity and recovery | Authority boundary | Decision |
| --- | --- | --- | --- |
| Mutable Markdown/file in the repository | Git history may exist, but working-tree state is mutable and repository-controlled | Untrusted code can alter the supposed authority record | Reject as task authority; allow explicit export only. |
| Frontend/editor state | Dirty-state UX, but refresh/cache loss and concurrent windows can diverge | Frontend can be stale or compromised | Reject as authority; projection only. |
| Spec Kit/OpenSpec files and gates | Durable developer artifacts with useful validation and resume | Approval is not digest/principal/revocation bound | Reuse patterns only. |
| Overwrite one `current_specification` row | Transactional but destroys history and makes stale approval easy to misapply | Current content and approval are coupled ambiguously | Reject. |
| Append-only revision and event tables plus derived current projection | Exact history, transactional CAS, deterministic replay, explicit supersession/revocation | Backend owns task facts; Ranex owns executable approval/evidence | Select, subject to the real crash/concurrency probe in #80. |
| Store task lifecycle in the Ranex journal | Strong evidence store but wrong owner and premature coupling | Kogg would duplicate or mutate kernel authority | Reject. |
| Git commits as the only immutable revision IDs | Strong repository content identity but fails for intake before execution and can expose content/remotes | Repository writer can move refs; task history needs independent identity | Reject as sole authority; later execution binds both task digest and Git objects. |

Use a dedicated backend database at the resolved Kogg state root, conceptually
`tasks/registry.sqlite3`, with restrictive platform permissions, foreign keys,
integrity checks, synchronous transactions, a versioned schema, and a singleton
monotonic registry revision. Keep it separate from projects, operation supervision,
credentials, and the Ranex journal so migrations, retention, corruption, and trust
failures do not silently cross authorities.

The production shape should be append-only for semantic history:

- a stable task row contains opaque identity and the owning project ID;
- each draft/frozen specification revision has its own opaque ID, monotonic
  per-task sequence, parent revision, encoding version, content digest, lifecycle,
  and locally stored content;
- lifecycle events record create/edit/freeze/approve/revoke/supersede/archive facts
  with a monotonic event sequence and previous-event digest;
- approval records bind task ID, frozen revision ID and digest, project/repository
  binding revision, current policy/profile reference digests, approver principal
  reference, nonce, and the exact event/registry predecessor observed; and
- idempotency records bind request ID to a canonical request digest and result.

The exact schema, canonical payload, and state reducer belong to #77. Pseudocode
must include independent digest vectors shared by TypeScript and the later Python/
Ranex adapter. It must explicitly decide UTF-8 validation, line-ending treatment,
size limits, and canonical JSON versioning. It must not normalize Unicode or trim
meaningful specification text silently.

## Required state and authority invariants

1. A task belongs to exactly one project and binds exactly one repository before
   freeze. The repository relation is checked through `kogg-projects`; the task
   database stores opaque IDs and the observed binding revision, not a path.
2. Only a draft may be edited. Every accepted edit advances both the task revision
   and registry revision. Concurrent stale edits conflict; they are never merged
   by last-writer-wins.
3. Freeze is a transaction over the exact draft content and current binding/policy
   context. It creates a new immutable frozen revision/digest or transitions an
   immutable snapshot according to #77; it never leaves partially frozen content.
4. Frozen content cannot be edited or deleted. “Edit” creates a successor draft
   with a parent pointer. The prior frozen/approved record remains visible history.
5. Approval requires an explicit human action over the rendered exact frozen
   revision. It is never inherited, inferred from a checkbox, produced by an agent,
   or accepted from an old browser view.
6. Approval is useful only while every bound fact remains current. A new successor,
   repository rebind, applicable policy change, explicit revoke, or project removal
   makes it non-current and blocks new downstream use.
7. Revocation appends one idempotent event. It never deletes the approval or prior
   work. Downstream admission checks revocation at use time; cancellation of already
   active work is decided by later execution pseudocode and must be visible.
8. An approval permits later work to request bounded authority. It is not Ranex
   evidence, a PASS verdict, or merge permission.
9. Every mutation presents expected task and registry revisions plus a UUID request
   ID. A replay with the same canonical request is idempotent; a different request
   under the same ID fails closed.
10. The frontend is a projection. Reconnect/reload always reads authoritative state
    and visibly reports conflicts, supersession, revocation, and blocked actions.

## Process inventory and ownership

| Boundary | Creates a process? | Owner and required behavior |
| --- | --- | --- |
| Task create/list/view/edit | No | Kogg tasks backend; bounded validated transaction and redacted lifecycle events. |
| Freeze/canonical digest | No | Kogg tasks backend; in-process bounded canonicalization with size limits and published vectors. |
| Human approval/revocation | No | Kogg tasks backend records the authenticated local decision; it does not invoke an agent, provider, signer CLI, Git, or Ranex. |
| Repository binding validation | No new task-owned process | Read the existing projects service projection. A real Git revalidation remains owned and supervised by `kogg-projects`. |
| Later agent/worktree/check/evidence work | Yes, outside this slice | Later workflow, execution, adapters, operation registry, and Ranex own their processes. They consume immutable task correlations and must register before spawn. |
| Browser/Electron application | Platform lifecycle, not task child | Observe disconnect/restart; never double-register application processes as task children. |

If task authoring unexpectedly requires a subprocess, #77 must stop and reopen the
research decision. Production must not add a hidden Markdown parser, editor helper,
signer, Git, or shell process without ownership, register-before-spawn, timeout,
cleanup, residual checks, diagnostics, and a new process-aware probe.

## Required lifecycle and observability contract

Use `kogg:tasks:registry` for storage/startup, `kogg:tasks:specification` for
revision mutations, and `kogg:tasks:approval` for approval/revocation projection.
Stable events must include:

- `registry.start.requested|completed|failed`,
  `registry.migration.started|completed|failed`,
  `registry.integrity.started|completed|failed`, and
  `registry.recovery.started|completed|failed`;
- `task.create.requested|started|completed|failed|refused` and
  `task.archive.requested|started|completed|failed|refused`;
- `specification.edit.requested|started|completed|failed|refused|conflict`;
- `specification.freeze.requested|started|completed|failed|refused|conflict`;
- `approval.requested|started|completed|failed|refused|conflict`;
- `approval.revoke.requested|started|completed|failed|refused|conflict`; and
- `registry.stop.started|completed|failed`.

Permitted fields are opaque `requestId`, `operationId`, `projectId`, `repositoryId`,
`taskId`, `specificationRevisionId`, registry/task revision numbers, lifecycle enum,
safe code, boolean currentness, and bounded counts/duration buckets. A content
digest may be stored and passed to the kernel boundary but should not be emitted in
ordinary logs or support bundles because stable cross-system identifiers can aid
correlation and provide little incident value there.

Never log or export task titles, requirement/specification text, rendered approval
content, repository paths/remotes, Git objects, policy contents, identities beyond
opaque local IDs, prompts, code, diffs, credentials, cookies, authorization values,
raw database rows, request bodies, or exception messages. Every request reaches one
terminal event and every transaction reaches commit or rollback.

## Failure and recovery matrix

| Failure | Required visible behavior | Required recovery/evidence |
| --- | --- | --- |
| First start, no database | Empty Tasks view is usable | Schema created transactionally; diagnostics pass. |
| Unsupported schema or integrity failure | Task mutations and downstream admission disabled | Preserve data; fail closed with a stable code; never silently reset. |
| Busy/competing writer | Bounded conflict/timeout, current revision offered | No partial write and no automatic replay of a human decision. |
| Frontend submits stale edit | Visible conflict and refresh/review action | Existing draft unchanged; new authoritative revision returned. |
| Freeze races with edit | Exactly one wins; loser sees conflict | No mixed content/context and at most one new immutable revision. |
| Crash during edit/freeze/approval/revoke | No partial semantic fact after restart | Prior or complete transaction only; integrity and event-chain reduction rerun. |
| Missing, changed, or cross-project repository binding | Freeze/approval refused | No approval fact; user returns to explicit binding flow. |
| Empty, oversized, invalidly encoded, or structurally invalid specification | Typed refusal before freeze | Draft remains editable; no content appears in logs/errors. |
| Frozen revision edit attempt | Refuse and offer successor-draft action | Frozen bytes/digest remain unchanged. |
| Approval from stale UI or wrong revision | Typed conflict/refusal | No approval fact; exact current revision must be reviewed again. |
| Duplicate request delivery | Same request returns same result | Request ID and canonical request digest prove idempotency. |
| Request ID reused for different content/action | Fail closed | No mutation; diagnostic counter may increase without content. |
| Revoke races with downstream admission | Ordered currentness decision at an authoritative predecessor | Later integration must prove use-before-revoke or revoke-before-use, never wall-clock guesswork. |
| Frontend disconnect/reload | No inferred completion | Reconnect reads authoritative history; no duplicate mutation. |
| Project/repository becomes unavailable | Task/history remain visible; new freeze/use restricted | No task deletion and no silent rebind. |
| Diagnostic contributor throws | All task checks fail closed | Stable safe summaries only. |

## Diagnostics required before implementation can close

Add catalog entries owned by the eventual tasks package:

- `tasks.registry`: supported schema, integrity, foreign keys, restrictive storage
  permissions, and one authoritative writer;
- `tasks.revisions`: revision/event sequences, parent links, canonical digests, and
  current projections are internally consistent;
- `tasks.bindings`: every active/frozen task has exactly one valid project/repository
  binding at the recorded revision, without exposing paths; and
- `tasks.approvals`: every current approval names an existing immutable frozen
  revision and has no later supersession/revocation/invalidation fact.

Checks report only status, safe summary, and bounded counts. Each operational
implementation file declares applicable `diagnostic-coverage`. Tests must cover
contributor failure, schema incompatibility, corruption, permission failure, broken
parent/event chain, digest mismatch, invalid binding, stale current projection,
superseded approval, revocation, and idempotency mismatch.

## Real UI E2E requirements for #83

Drive production browser and Electron controls with clean profiles and real project
records. Direct service calls may prepare no authoritative task state.

1. Create a task through visible controls, bind exactly one of two real registered
   repositories, enter deterministic requirements, and prove draft restoration
   after reload and application restart.
2. Open the same task in two windows/clients, submit competing edits, and prove one
   explicit conflict rather than silent last-writer-wins loss.
3. Freeze through the visible review action, record the displayed short revision
   identity, restart, and prove the exact content is immutable and current.
4. Attempt empty, oversized, invalid binding, untrusted project, stale revision,
   duplicate request, and conflicting request-ID cases; prove typed refusal and no
   downstream process start.
5. Approve the exact frozen revision as the human user, prove an agent cannot invoke
   or forge that action, and prove the record is only authority input—not PASS,
   evidence, or merge permission.
6. Create a successor draft and prove approval does not transfer. Explicitly revoke
   the prior approval and prove both history and current blocked state survive restart.
7. Kill browser/backend and Electron at controlled transaction points during freeze,
   approval, and revocation; restart and prove prior-or-complete state, valid event
   chain, one idempotent result, and no false current approval.
8. Independently inspect the local database in the disposable fixture to verify
   immutable rows/digests and no secret/content leakage into logs or support output.
   This is an oracle after visible actions, not a way to cause behavior.
9. Run diagnostics and export a support artifact through visible commands; verify all
   task check IDs, safe counts, artifact scanning, source maps, and frontend/backend
   debugger pauses.
10. Use an OS process oracle to prove every task-authoring scenario creates zero task-
    owned children and leaves zero hidden/residual processes.

## Rejected approaches

- Keeping only the latest specification text. It destroys provenance and permits
  approval to drift onto changed content.
- Editing a frozen row in place, even to fix formatting. Any change is a successor
  revision requiring review and approval.
- Treating Git history, an issue edit history, a checked task box, a saved editor, or
  an OpenSpec archive as approval. None binds the complete Kogg authority context.
- Auto-approving in headless mode or offering an agent-visible `--yes` equivalent.
  Missing human input means paused/refused, never approved.
- Letting the same agent/producer act as the human approver. Role separation is
  structural and later Ranex checks it again.
- Logging specification hashes as a substitute for logging content. Stable digests
  still correlate sensitive work and do not help most incidents; use opaque revision
  IDs in routine telemetry.
- Storing task authority in repository files or workspace preferences. Both are
  repository-controlled and can cross trust/project boundaries.
- Sharing the projects database or Ranex evidence journal. Cross-authority tables
  couple migrations, recovery, deletion, and trust.
- Retrying approval/revocation automatically after a conflict. The user authorized
  the state they reviewed, not whatever state exists after a retry.
- Deleting approval/history on revocation or task archive. Revocation is evidence of
  removed authority and must remain inspectable.
- Starting Git, provider, agent, signing, or Ranex processes during task authoring.
  Freeze and approval establish intent only.
- Declaring completion from unit tests. Real concurrent clients, crashes, restart,
  visible review/refusal, diagnostics, debugger access, content-leak scanning, and
  the zero-process oracle are release gates.

## Research risks resolved by pseudocode

| Risk | Resolution fixed by #77 |
| --- | --- |
| Cross-runtime digest drift | Freeze one canonical encoding version and publish TypeScript/Python positive and negative vectors. |
| Unicode/line-ending ambiguity | Define valid UTF-8 and exact line-ending rules; do not silently normalize Unicode or whitespace. |
| Large content denial of service | Bound per-revision bytes, history/query page sizes, and rendered review size before allocation. |
| Approval authentication | Name the trusted local identity/session boundary and how later Ranex authenticates it; a display name is insufficient. |
| Repository/policy changes after approval | Define exact invalidation facts and ordered currentness checks without rewriting history. |
| Edit/freeze/approve races | Define transaction/CAS ordering and typed conflicts; no automatic human-decision retry. |
| Revocation versus active execution | Define the handoff fact consumed by #85/#101/#106 and whether active work cancels or only new admission blocks. |
| Retention/deletion | Preserve frozen/approved/revoked history referenced by runs/evidence; archive must not create dangling authority. |
| Search and support output | Define metadata-only indexes and safe projections; no full-text telemetry or content-bearing bundles. |
| Multi-window frontend caches | Define authoritative revision refresh and dirty-edit conflict UX. |

## Decision-complete production pseudocode

This section closes #77. The implementation issue may translate these contracts
mechanically, but must reopen pseudocode if any named authority, state, byte
encoding, transaction boundary, terminal result, UI action, diagnostic, or owned
process would change.

### Package and authority boundaries

Create `packages/kogg-tasks` with `common`, `browser`, and `node` entry points.
`kogg-tasks/common` owns branded identifiers, DTOs, enums, error codes, RPC method
names, canonical test vectors, and no mutable state. `kogg-tasks/browser` owns the
Tasks view, commands, review interaction, dirty/conflict presentation, and safe
notifications. `kogg-tasks/node` is the sole writer and owns schema migration,
transactions, reduction, lifecycle logging, diagnostics, and RPC validation.

The package depends on `kogg-projects` only through a read-only
`ProjectBindingAuthority` contract. It does not open the projects database. The
browser never opens either database. No task API is exported to provider, agent,
terminal, plugin, workspace, or extension command surfaces. Later execution code
receives only an immutable admission snapshot from the Node service.

The V1 human principal is an opaque installation-local ID bound to the logged-in OS
account and the authenticated Kogg frontend session. The backend creates it once in
the protected Kogg state root. It is not a display name, email address, OS username,
or signing identity. An approval also requires a single-use review challenge issued
only after the trusted Tasks widget renders the complete frozen revision. The
challenge stays in widget memory, is bound to frontend session, task, revision,
digest, registry revision, and expiry, and is consumed atomically. It is never
placed in logs, URLs, workspace state, extension APIs, or agent-visible commands.

This boundary proves an intentional action by the active local Kogg user; it does
not resist compromise of that user's OS account or Kogg process. Ranex separately
authenticates any later executable grant. A Kogg approval is only intent input and
cannot itself start work, constitute evidence, produce a verdict, or permit merge.

### Stable common contracts

All IDs are lower-case RFC 4122 UUID strings generated by the backend. Revision
counters are positive safe integers serialized as decimal strings over JSON-RPC to
avoid cross-runtime precision drift. Timestamps are RFC 3339 UTC display metadata
and never determine ordering or authority.

```ts
type TaskLifecycle = 'active' | 'archived';
type SpecificationLifecycle = 'draft' | 'frozen' | 'superseded';
type ApprovalLifecycle = 'current' | 'superseded' | 'revoked' | 'invalidated';

interface MutationPrecondition {
  requestId: UUID;
  expectedRegistryRevision: DecimalRevision;
  expectedTaskRevision: DecimalRevision;
}

interface TaskProjection {
  taskId: UUID;
  projectId: UUID;
  repositoryId: UUID;
  bindingRevision: DecimalRevision;
  taskRevision: DecimalRevision;
  registryRevision: DecimalRevision;
  lifecycle: TaskLifecycle;
  currentSpecification: SpecificationProjection;
  currentApproval?: ApprovalProjection;
  historyCursor: DecimalRevision;
}

interface TaskService {
  create(input: CreateTaskInput): Promise<MutationResult>;
  get(taskId: UUID): Promise<TaskProjection>;
  list(input: MetadataPageRequest): Promise<MetadataPage<TaskSummary>>;
  edit(input: EditDraftInput & MutationPrecondition): Promise<MutationResult>;
  createSuccessorDraft(input: SuccessorInput & MutationPrecondition): Promise<MutationResult>;
  freeze(input: FreezeInput & MutationPrecondition): Promise<MutationResult>;
  beginApprovalReview(input: ReviewInput): Promise<ReviewProjection>;
  approve(input: ApproveInput & MutationPrecondition): Promise<MutationResult>;
  revoke(input: RevokeInput & MutationPrecondition): Promise<MutationResult>;
  archive(input: ArchiveInput & MutationPrecondition): Promise<MutationResult>;
  history(input: HistoryPageRequest): Promise<MetadataPage<HistoryItem>>;
  readSpecification(input: ReadSpecificationInput): Promise<SpecificationContent>;
  authorizeAdmission(input: AdmissionInput): Promise<TaskAdmissionSnapshot>;
}
```

`create`, `edit`, and `createSuccessorDraft` are the only content-bearing request
types. `get` returns current content only for an explicit task view; list and
history endpoints are metadata-only. `readSpecification` requires an active task
view session and returns exactly one requested revision. Pages contain at most 100
items and cursors are opaque, signed installation-local values. Search is limited
to opaque task ID and non-content lifecycle metadata; V1 has no full-text index.

Every mutation returns exactly one of `completed`, `refused`, `conflict`, or
`failed`. It includes safe IDs/revisions and a stable code, never submitted content,
digest, path, raw database text, or exception message. Stable codes are:

- refusal: `TASK_ARCHIVED`, `TASK_NOT_DRAFT`, `TASK_ALREADY_ARCHIVED`,
  `SPEC_EMPTY`, `SPEC_TOO_LARGE`, `SPEC_INVALID_UNICODE`, `BINDING_MISSING`,
  `BINDING_CHANGED`, `PROJECT_UNTRUSTED`, `REVIEW_REQUIRED`,
  `REVIEW_EXPIRED`, `REVIEW_SESSION_CHANGED`, `APPROVAL_NOT_CURRENT`, and
  `ADMISSION_NOT_AUTHORIZED`;
- conflict: `REGISTRY_REVISION_CONFLICT`, `TASK_REVISION_CONFLICT`,
  `REQUEST_ID_REUSED`, and `CURRENT_REVISION_CHANGED`; and
- failure: `REGISTRY_UNAVAILABLE`, `SCHEMA_UNSUPPORTED`, `INTEGRITY_FAILED`,
  `STORAGE_PERMISSION_FAILED`, `TRANSACTION_BUSY`, and `INTERNAL_FAILURE`.

Not-found and unauthorized reads both return `TASK_NOT_AVAILABLE` so RPC callers
cannot enumerate tasks across active-user/project boundaries.

### Exact content and canonical digest rules

V1 accepts a specification as a JavaScript string only after these checks, in this
order:

1. reject any unpaired UTF-16 surrogate as `SPEC_INVALID_UNICODE`;
2. encode the string as strict UTF-8 with no BOM;
3. reject zero bytes as `SPEC_EMPTY` and more than 1,048,576 bytes as
   `SPEC_TOO_LARGE`; and
4. preserve every byte, including CR, LF, CRLF, Unicode normalization form,
   leading/trailing whitespace, and a final newline. No normalization or trimming
   occurs.

The immutable digest payload uses canonicalization version
`kogg.task-specification.v1`. Construct this fixed-key object:

```ts
{
  bindingRevision: DecimalRevision,
  encoding: 'utf-8-exact-v1',
  projectId: UUID,
  repositoryId: UUID,
  specificationBase64: base64OfExactUtf8Bytes,
  taskId: UUID,
  version: 'kogg.task-specification.v1'
}
```

Serialize it with RFC 8785 JSON Canonicalization Scheme implemented by one audited
utility, UTF-8 encode the canonical JSON, and compute SHA-256. The implementation
must not call ordinary `JSON.stringify` as the canonicalizer. Fixed ASCII keys,
UUIDs, decimal strings, and base64 deliberately avoid runtime-dependent numbers or
non-ASCII key ordering. Store `sha256:<64 lowercase hex>` in the database, but do
not log or export it in support artifacts.

`common/canonical-specification-vectors.json` is normative and is consumed by both
TypeScript tests and the later Python/Ranex adapter. It includes: empty rejection;
ASCII; LF/CRLF distinction; composed/decomposed Unicode distinction; emoji;
embedded NUL; leading/trailing whitespace; maximum-size boundary; one unpaired
surrogate negative vector; one key-order negative vector; and one byte-changed
digest mismatch. #80 must populate the exact expected canonical bytes and hashes
from two independent implementations before production starts.

Approval canonicalization version `kogg.task-approval.v1` applies the same JCS and
SHA-256 rules to fixed ASCII fields: approval ID, task ID, frozen revision ID,
specification digest, project/repository/binding revision, policy/profile reference
digests supplied by their authorities, approver principal ID, review nonce,
predecessor event digest, and observed registry revision. Approval canonical bytes
are retained for downstream Ranex translation but never returned to ordinary UI or
logs.

### Durable schema and reducer

Use SQLite in WAL mode at `<state-root>/tasks/registry.sqlite3`, restrictive owner
permissions, `foreign_keys=ON`, `trusted_schema=OFF`, `busy_timeout=5000`,
`synchronous=FULL`, and an application ID. One backend connection manager is the
sole writer; readers use bounded snapshots. Schema version 1 contains:

```text
registry_meta(singleton, schema_version, registry_revision, installation_principal_id)
tasks(task_id PK, project_id, repository_id, binding_revision,
      task_revision, lifecycle, current_specification_id, created_event_sequence)
specification_revisions(specification_id PK, task_id FK, sequence,
      parent_specification_id FK NULL, lifecycle, encoding_version,
      content BLOB, byte_length, specification_digest, created_event_sequence,
      UNIQUE(task_id, sequence))
task_events(event_sequence PK, event_id UNIQUE, task_id FK, task_revision,
      registry_revision UNIQUE, event_type, subject_id, safe_reason_code NULL,
      canonical_event BLOB, previous_event_digest, event_digest UNIQUE)
approvals(approval_id PK, task_id FK, specification_id FK,
      specification_digest, project_id, repository_id, binding_revision,
      policy_reference_digest, profile_reference_digest, principal_id,
      review_nonce UNIQUE, lifecycle, created_event_sequence,
      ended_event_sequence NULL, canonical_approval BLOB, approval_digest UNIQUE)
idempotency(request_id PK, request_digest, operation_type, task_id NULL,
      terminal_kind, safe_code, result_projection BLOB, registry_revision)
```

Database triggers refuse `UPDATE` or `DELETE` on `specification_revisions`,
`task_events`, and `approvals`. Their lifecycle columns are initial immutable facts;
current lifecycle is reduced from later events rather than updated in place.
`tasks` and `registry_meta` are the only mutable projections. Archive never deletes
history. No V1 purge exists. A future retention change requires a new packet and
must preserve every revision referenced by approval, admission, run, or evidence.

On startup, migrate in one exclusive transaction, run `quick_check`, foreign-key
check, permission check, event/digest-chain verification, and deterministic replay
into an in-memory projection. Compare replay with every mutable task projection.
Any unsupported schema, corruption, permission failure, chain break, or projection
mismatch leaves the service read-only for safe metadata/history export and refuses
all mutations and admissions. It never deletes, resets, repairs, or silently adopts
the mutable projection. There is no task-owned cleanup process; transaction rollback
and SQLite recovery are the cleanup boundary.

Events are `task.created`, `specification.edited`, `specification.frozen`,
`specification.successor-created`, `approval.recorded`, `approval.revoked`,
`approval.invalidated`, `task.archived`, and `admission.authorized`. Each canonical
event binds event sequence, registry revision, task revision, event type, subject
ID, safe reason code, and previous event digest. Content and titles are never event
fields. `approval.invalidated` is appended in the same transaction that first
observes a repository binding, policy/profile, or project availability change.

Reducer rules are exhaustive:

- create -> active task plus draft sequence 1;
- edit -> append a new draft whose parent is the prior draft, supersede the prior
  draft by event reduction, and advance current specification;
- freeze -> append a frozen revision copied byte-for-byte from current draft,
  parented to it, and supersede that draft;
- successor -> append a draft copied from the selected frozen revision and make any
  current approval non-current by a superseding event in the same transaction;
- approve -> append one approval for the exact current frozen revision;
- revoke -> append one revocation for the exact current approval;
- binding/policy/project invalidation -> append one invalidation before returning a
  non-current projection or refusing admission;
- archive -> append archive, retain all history, invalidate current approval, and
  refuse later mutations/admissions; and
- admission -> append the exact approval and authority predecessor observed. It
  does not start a process.

No state transition is inferred from wall time. Review challenge expiry is only a
request-validity rule and does not alter task history.

### Transaction and idempotency algorithm

Every mutation computes a canonical request digest before opening the write
transaction. Content-bearing request digests include base64 of the exact validated
UTF-8 bytes. Request digests are stored but not logged.

```text
mutate(request):
  log <operation>.requested with permitted correlations
  validate shape, UUIDs, counters, content limits
    on rejection -> log <operation>.refused; return refused
  BEGIN IMMEDIATE with five-second bounded busy timeout
    on busy -> log <operation>.failed code=TRANSACTION_BUSY; return failed
  log <operation>.started
  existing = idempotency[request.requestId]
  if existing exists:
    if constantTimeEqual(existing.requestDigest, requestDigest):
      ROLLBACK read transaction; log <operation>.completed replay=true
      return stored terminal result
    ROLLBACK; log <operation>.conflict code=REQUEST_ID_REUSED; return conflict
  load registry, task, current reduced state, and live project binding authority
  if expected registry/task revisions differ:
    ROLLBACK; log <operation>.conflict with current safe revisions; return conflict
  evaluate operation-specific state and authority preconditions
    on refusal -> persist idempotent refused result without content; COMMIT;
                  log <operation>.refused; return refused
  append immutable rows and events; advance task and registry projections once
  insert idempotency completed result in the same transaction
  COMMIT
  log <operation>.completed
  return completed projection
catch:
  ROLLBACK if active
  log <operation>.failed with safe error category and cause chain retained
  return failed INTERNAL_FAILURE
```

Conflict and failure results caused before an authoritative decision are not stored
for replay; completed and deterministic refusal results are. Freeze, approve,
revoke, archive, and admission are never automatically retried. A caller may replay
the identical request ID only to learn its stored terminal result. Any new decision
requires a fresh projection, visible review, and fresh request ID.

Freeze reads the live project/repository binding and policy/profile references
inside the transaction, then appends its frozen revision. Approval repeats those
reads, requires an unchanged frozen digest and unconsumed 10-minute review
challenge, and consumes the challenge in the approval transaction. The backend
invalidates all outstanding challenges on frontend disconnect, backend restart,
task/revision change, or session change.

`authorizeAdmission` receives exact task, frozen revision, approval, project,
repository, binding, policy/profile, run, and expected registry/task revisions. It
revalidates all authorities in one serialized transaction and either appends
`admission.authorized` with an immutable snapshot or refuses. If admission commits
before revocation, that already-admitted run may continue; revocation blocks every
later admission but does not itself cancel active work in V1. The execution owner
must visibly record whether its own separate policy cancels a running operation.
This registry ordering, never wall-clock comparison, resolves the race.

### Operation state and cleanup table

| Operation | Success | Refusal/conflict | Failure/timeout | Cancel/disconnect | Restart/recovery |
| --- | --- | --- | --- | --- | --- |
| Startup/migration | writable projection after verified replay | unsupported schema is read-only | integrity/permission/migration failure is read-only | shutdown waits for current transaction then closes | SQLite yields prior-or-complete transaction; full replay repeats |
| Create/edit/successor | one new revision/event and one counter advance | no semantic row; deterministic refusals may store idempotency | rollback, safe failure | RPC loss does not infer result; replay same request ID | return stored result or authoritative projection |
| Freeze | one new immutable frozen revision | stale/binding/content refusal leaves draft current | rollback; no partial frozen row | no UI completion; retry same request ID only | prior draft or complete frozen result |
| Begin review | bounded content plus in-memory challenge | non-current/untrusted state refused | no durable state | challenge discarded | all challenges discarded |
| Approve | exact approval/event plus consumed challenge | stale/expired/changed challenge leaves no approval | rollback | no inferred approval | prior state or complete stored approval; challenge never survives |
| Revoke | one revocation/event; history retained | already non-current returns typed idempotent refusal | rollback | no inferred revocation | prior approval or complete revocation |
| Archive | archive and invalidation events; history retained | already archived is safe refusal | rollback | no inferred archive | prior active or complete archive |
| Admission | one immutable admission event/snapshot | any non-current fact refuses and starts nothing | rollback and start nothing | caller must query stored request before spawn | stored authorization is valid only for named run and predecessor |

There is no task mutation cancellation after `BEGIN IMMEDIATE`: these transactions
are bounded and finish commit or rollback. Frontend cancellation merely stops
waiting and then refreshes. Backend shutdown stops accepting requests, waits at
most five seconds for the current transaction, closes SQLite, and reports
`registry.stop.failed` if closure cannot be proved. Task diagnostics fail while a
write is stuck, a connection is leaked, or startup recovery is incomplete.

### Visible Tasks experience

The activity bar exposes **Tasks** only for an active registered project. The list
shows opaque short task ID, lifecycle, revision number, binding availability, and
approval status; it never leaks specification excerpts into labels, notifications,
recent-item storage, command history, telemetry, or accessibility descriptions not
already visible inside the open editor.

Create opens an editor bound to one currently registered repository. Save uses a
fresh request ID and the last observed revisions. A successful save refreshes the
authoritative projection. A conflict preserves the user's dirty buffer, displays
“The task changed elsewhere,” and offers **Compare with current**, **Copy my
draft**, and **Reload current**. It never auto-merges or resubmits.

Freeze opens a full-content review with byte count, exact line-ending badge, short
revision ID, repository display label supplied by Projects, and the warning that
freeze is immutable. Confirm invokes one freeze request. Frozen editors are
read-only; **Create successor draft** makes the only editable descendant.

Approve first calls `beginApprovalReview`, renders the entire frozen content in the
trusted Tasks widget, shows exact short revision and current binding/policy status,
and enables **Approve this exact revision** only after rendering completes. Confirm
uses the memory-only challenge. Closing, navigating away, disconnecting, expiring,
or changing state disables the button and requires a new review. Revocation has a
separate confirmation naming the short approval/revision IDs and never deletes
history.

Typed refusal/conflict text is mapped locally from stable codes. Raw backend
messages are never displayed. Every terminal action refreshes authoritative state.
On startup or reconnect, a banner explains read-only diagnostic failure, pending
unknown result, supersession, revocation, or invalidation and offers only valid
recovery actions. No action silently falls back to a repository file, browser
storage, or last known approval.

### Exact logging and diagnostic design

Operational files use injected `ILogger` names `kogg:tasks:registry`,
`kogg:tasks:specification`, and `kogg:tasks:approval`. Each request emits exactly
one requested event, at most one started event, and exactly one terminal
`completed`, `refused`, `conflict`, or `failed` event. Startup/shutdown events use
the research names. Add `admission.requested|started|completed|refused|conflict|failed`
and `review.requested|completed|refused|failed`; review has no started mutation
because it writes no durable state.

Levels are debug for requested/started/replay detail, info for completed durable
changes and recovery, warn for refusal/conflict/read-only degradation, and error for
failed operations or diagnostics. Permitted structured fields are only request,
operation, project, repository, task, specification revision, approval, run, and
session opaque IDs; decimal registry/task/event revisions; operation/state enums;
safe code; replay/current booleans; bounded counts; and duration buckets. Exception
classification preserves `cause` in memory but logs only a safe error type/code.

Forbidden fields include task/specification content, title, excerpts, canonical
bytes, digests, challenge/nonce, principal, paths/remotes, Git data, policy/profile
contents, prompts, code, diffs, credentials, cookies, authorization, raw rows,
request/response bodies, stack text containing inputs, and exception messages.

Production adds these exact catalog contributors and coverage comments:

- `tasks.registry`: schema/application ID, quick/foreign-key checks, owner
  permissions, sole writer, startup replay, open transaction/connection counts;
- `tasks.revisions`: sequence/parent/event chains, canonical digest verification,
  immutable-trigger presence, and projection equality;
- `tasks.bindings`: active/frozen task bindings resolve to exactly one current
  project repository at the recorded revision;
- `tasks.approvals`: current approvals resolve to an immutable frozen revision and
  have no later successor, revocation, invalidation, archive, or admission mismatch.

All contributors catch their own failures and return fail status with stable safe
summary and bounded counts. Support export includes IDs, status, codes, revisions,
counts, and duration buckets only. A canary scanner fails tests if specification
text, digest, review challenge, path, or principal appears in logs/support output.
Browser, Node, Electron renderer, and Electron main source maps stay enabled; the
production E2E must pause a debugger in the Tasks widget and Node transaction path.
Electron main needs no task implementation; its debugger proof covers application
restart only.

### Required implementation and E2E proofs

Unit/contract tests must cover every reducer transition, invalid transition, stable
code, size/Unicode boundary, canonical vector in TypeScript and Python, stale CAS,
same/different idempotency replay, event-chain tamper, immutable triggers, crash at
every write boundary, busy timeout, unsupported schema, corrupt database, bad
permissions, contributor throw, safe error mapping, review expiry/disconnect,
binding/policy invalidation, admission/revoke ordering, and zero content leakage.

The #83 browser and Electron suites implement the ten research scenarios through
visible production controls. Direct RPC/database setup may create only disposable
OS/profile preconditions, never task, revision, approval, revocation, or admission
facts. The suites use two real registered repositories and two real app clients;
restart the actual backend/Electron process; kill at instrumented transaction
barriers compiled only into the E2E harness; inspect the database only after UI
actions as an oracle; and scan OS process tables before/after every case.

Expected trace assertions are exact event-name sequences with safe correlations:

```text
edit success:     requested -> started -> completed
stale edit:       requested -> started -> conflict
freeze crash:     requested -> started -> failed, then recovery started -> completed
approval refusal: requested -> started -> refused
revoke success:   requested -> started -> completed
admission blocked: requested -> started -> refused
shutdown:         registry.stop.started -> registry.stop.completed
```

An agent-adapter test attempts every exported agent/extension command and confirms
there is no approval or review method. A forged/missing/expired/cross-session
challenge sent directly to RPC is refused and creates no approval. The visible
human action then succeeds. Process-oracle assertions prove create/edit/freeze/
review/approve/revoke/archive create zero task-owned child processes and leave zero
residual processes. Diagnostics and support export must remain useful after each
injected failure while containing none of the content canaries.

## Pseudocode gate conclusion

Research #74 is closed. The schema, bytes, digests, identity/session boundary,
state reducer, authority owners, concurrency/idempotency transactions, terminal and
cleanup behavior, restart recovery, revocation/admission ordering, UI interactions,
RPC results, loggers/events/fields, diagnostic IDs, test matrix, debugger proof, and
real visible-UI E2E boundaries are fixed above. No implementation choice remains
open for #80 or #83; a discovered need to diverge reopens #77 rather than being
decided silently in code.

## Prototype recommendation

After decision-complete pseudocode, #80 should probe the highest-risk combined
boundary: canonical freeze plus human approval/revocation under two concurrent real
clients and forced termination in the pinned Node and Electron runtimes.

The disposable probe should:

- create a real project/task/repository binding through production UI;
- edit deterministic content from two visible clients and prove stale-write conflict;
- freeze at controlled transaction stages, kill the process, restart, and prove one
  immutable revision whose TypeScript digest matches the real Python/Ranex
  canonicalization boundary;
- approve only the exact rendered revision, then create a successor/revoke and prove
  currentness fails closed across restart;
- replay the same request and a mismatched request under one request ID;
- corrupt a copied disposable registry/event link and prove diagnostics refuse it;
- scan logs/support artifacts for content canaries and prove zero task-owned process;
  and
- pause frontend and backend debuggers at the real visible edit/freeze/approval path.

If canonical bytes, transaction ordering, approval identity, or restart currentness
cannot be proved, the probe must fail and reopen #77. It must not weaken digests,
replace approval with a checkbox, or move authority into Git/frontend/Ranex storage.

## Prototype findings and production decision

The disposable #80 probe is preserved, deliberately unmerged, on branch
`prototype/issue-80-tasks-boundary`. Commit
`2eb19b58f0b65491212f22171c920328f68a1bf4` contains the measured probe and its
prototype-only CI step; follow-up `2bf60fcec2866e5c1e6b6e7e199e281642f8c927`
only clarifies platform scope. Prototype PR #134 is evidence, not a merge vehicle.
The probe passed locally on macOS 26.6 and in CI on macOS 15 and qualified Ubuntu
24.04 using the pinned setup.

| Boundary | Measured result |
| --- | --- |
| Canonical bytes across runtimes | Pinned Node 22.23.2, independent Python 3.12.14, and Electron 42.3.0's embedded Node 24.15.0 produced identical canonical base64 and SHA-256 for the fixed ASCII-key/base64 payload. Electron reported SQLite 3.51.3. LF/CRLF, composed/decomposed Unicode, paired emoji, lone-surrogate rejection, and 1,048,576/1,048,577-byte boundaries behaved as specified. |
| Two visible clients | Two isolated real Chromium contexts drove visible Save, Reload, Freeze, Review, Approve, Revoke, and Create successor controls. One stale edit completed and the other returned `TASK_REVISION_CONFLICT`; the losing buffer was not committed. |
| Review authority | A challenge bound to one browser session approved the exact frozen revision. A forged challenge from the second session returned `REVIEW_REQUIRED` and created no approval. Revocation removed currentness, a successor stayed unapproved, and draft content/history/current blocked state survived a real database close/reopen. |
| Line-ending UI boundary | A plain HTML `textarea` normalized CRLF to LF during a visible edit. This does not change the backend's exact-byte/no-normalization contract: the accepted bytes begin at the value submitted by the editor. Production cannot use an unqualified textarea or claim that pasted line endings survived. The Theia/Monaco model must expose the actual selected EOL mode before freeze, and #83 must assert the exact submitted and canonical bytes after visible LF and CRLF configurations; mixed-EOL service-contract vectors remain byte-exact. |
| Kill before commit | A real writer inserted under `BEGIN IMMEDIATE` and received `SIGKILL` before commit. Restart exposed zero marker rows and `integrity_check=ok`. |
| Kill after commit | A real writer committed and then received `SIGKILL`. Restart exposed exactly one marker row and `integrity_check=ok`. |
| Competing writer | A separate process held the WAL write transaction; the contender reached the bounded SQLite busy result. Killing the holder left no uncommitted marker or residual writer. |
| Idempotency | The same request ID/digest replayed the stored terminal result. A different digest under that ID produced `REQUEST_ID_REUSED` and no semantic mutation. |
| Diagnostic corruption | A copied registry with a modified predecessor link failed deterministic event-chain verification while the authoritative registry remained intact. |
| Debugger and lifecycle | Real Node and Electron inspectors reached listening endpoints. Every Python/Electron/helper/browser process was registered before start and emitted exit plus cleanup; the safe-field scanner found no content, path, digest, challenge, request payload, or command argument, and the live registry ended at zero. A successful run contained 68 safe lifecycle records and no task-owned process event. |

### Production decision

The combined canonicalization, SQLite WAL transaction, session-bound approval,
restart-currentness, and multi-client design is validated without reopening #77.
Implement `packages/kogg-tasks` exactly as specified in #83. Preserve the pinned
runtime checks because `node:sqlite` remains experimental in Node 22.23.2, and
retain the four fail-closed task diagnostics.

The prototype's Python, Electron-as-Node, crash-writer, inspector, HTTP server, and
Chromium children are harness-owned measurement processes only. Production task
authoring still owns zero subprocesses. The real #83 browser and Electron suites
must drive the production Theia widget and backend service rather than reuse this
prototype UI or database code; must prove the Monaco EOL selection; and must repeat
the conflict, forged challenge, crash, restart, idempotency, corruption, safe-trace,
debugger, and zero-process cases at the owned production boundaries.

## Research gate conclusion

Commit-pinned sources and their licenses, maintenance dates, reviewed paths, useful
patterns, security limits, and rejected approaches are recorded. The task/revision
authority model, content boundary, process inventory, lifecycle events, safe fields,
failure/recovery behavior, diagnostics, real E2E, risks, and prototype target are
explicit. These findings supplied #77 with the constraints used by the
decision-complete pseudocode above; no source, persistence authority, approval
model, or process boundary was chosen implicitly.
