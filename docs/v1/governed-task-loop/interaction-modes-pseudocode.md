# Plan, Build, and Kogg interaction modes normative pseudocode

Tracking: [#120](https://github.com/anthonykewl20/kogg/issues/120), parent
[#118](https://github.com/anthonykewl20/kogg/issues/118), prototype
[#121](https://github.com/anthonykewl20/kogg/issues/121), and production
[#122](https://github.com/anthonykewl20/kogg/issues/122).

## Contract status

This document is normative for #121 and #122. `MUST` and `MUST NOT` are release
gates. Plan, Build, and Kogg are fixed backend-enforced authority ceilings, not
prompts, personas, preferences, tool lists, context keys, or model capabilities.
The frontend selector is only a projection and request surface.

Every operation is allowed by the intersection of selected mode, task/role,
project/repository, provider/model, execution target, approval/lifecycle, and
closed operation catalog grants. Changing mode cannot mutate an active attempt's
frozen grant. Prior Plan or Build artifacts are untrusted inputs to Kogg and never
become approval, evidence, verdict, or governed completion by transition.

## Closed modes, capabilities, and results

```text
ModeV1 = plan|build|kogg

CapabilityV1 =
  research.read | plan.write | plan.approval-request |
  worktree.create | repository.mutate-private | tool.execute-build |
  provider.invoke-advisory | provider.invoke-mutating | check.run-untrusted |
  workflow.compile-governed | workflow.run-governed |
  approval.consume | check.run-independent | evidence.request |
  verdict.observe | merge.request-controlled

PlanResultV1 = plan-draft|decision-packet-ready|approval-requested|refused
BuildResultV1 = build-active|build-checks-passed|candidate-handoff-ready|
                build-cancelled|cleanup-incomplete|refused
KoggResultV1 = lifecycle-active|governed-pass-current|controlled-merge-complete|
               governed-complete|blocked|failed|cancelled|quarantined
```

Closed maximum matrix:

| Capability | Plan | Build | Kogg |
| --- | --- | --- | --- |
| research.read, provider.invoke-advisory | allow | allow | allow |
| plan.write, plan.approval-request | allow | allow | allow |
| worktree.create, repository.mutate-private | deny | allow | allow through workflow |
| tool.execute-build, provider.invoke-mutating | deny | allow in exact private target | allow through workflow |
| check.run-untrusted | deny | allow | allow but never evidence by itself |
| workflow.compile/run-governed | deny | deny | allow |
| approval.consume, independent check, evidence request | deny | deny | allow only owning stage |
| verdict.observe | historical read only | historical read only | exact current projection |
| merge.request-controlled | deny | deny | allow only controlled-merge stage |

Plan schemas cannot encode filesystem/Git/process/provider mutation results.
Build schemas cannot encode evidence, verdict, merge, PASS, approved, verified,
complete, or safe-to-merge results. Unknown modes/capabilities/result tags fail
closed. Mode customization and marketplace extension are absent in V1.

## Durable records

```text
TaskModeStateV1 {
  taskId, taskRevisionId, projectId, repositoryId,
  selectedMode, effectiveCapabilitiesDigest,
  modeSchemaVersion, sequence, state,
  activeStage, activeOperationRefs[],
  transitionId?, transitionDigest?,
  updatedAt, eventChainDigest
}

ModeTransitionV1 {
  transitionId, requestId, taskId, expectedSequence,
  fromMode, toMode, direction: preserve|reduce|expand,
  requestedConfigurationDigest,
  actorAuthorityDigest, sessionId,
  oldEffectiveDigest, proposedEffectiveDigest,
  activeOperationRefs[], cleanupRequirement,
  state, safeCode, createdAt, expiresAt, eventChainDigest
}

AttemptModeGrantV1 {
  attemptId, taskId, modeAtAdmission,
  exactCapabilities[], taskRevisionId, repositoryIdentityDigest,
  targetIdentityDigest, providerModelDigest?, approvalDigest?,
  issuedAt, expiresAt, grantDigest
}
```

Records use repository canonical JSON and digest domain
`kogg:interaction-modes:<record>:v1`. Safe events contain no prompts/plans/code/
diffs/paths, credentials, tool/command data, environment, personal data, or raw
provider/evidence/request/response bodies. `displayName` and selector copy are
compiled resources, not durable authority fields.

`TaskModeStateV1` is authoritative only for the selected ceiling; every operation
still computes current effective authority. Attempt grants are immutable. A
global/last-used preference may preselect a menu item on a task with no state but
MUST NOT persist, restore, or grant task authority.

## Backend interfaces

```text
ModeService.get(taskId, authenticatedContext) -> ModeProjectionV1
ModeService.requestTransition(request, authenticatedContext) -> ModeProjectionV1
ModeService.confirmExpansion(transitionId, challengeDigest,
                             explicitGesture, authenticatedContext) -> ModeProjectionV1
ModeService.cancelTransition(transitionId, requestId, context) -> ModeProjectionV1
ModeService.authorizeOperation(operationRequest, context) -> AttemptModeGrantV1
ModeService.recover() -> RecoverySummaryV1
```

Transition requests bind task revision, expected sequence, exact current mode,
requested mode/configuration, authenticated session and UUID idempotency key.
Same id/same digest returns the original result; same id/different digest refuses
`MODE_REQUEST_CONFLICT`. Frontend mode, context key, command state, prompt text,
provider claims, and local storage are ignored as authority.

Authority calculation is exact:

```text
effective = modeCeiling(selectedMode)
  intersect taskAuthority(taskRevision)
  intersect roleAuthority(actor)
  intersect projectRepositoryBinding
  intersect providerModelCapabilities
  intersect executionTargetQualification
  intersect approvalAndLifecycleAuthority
  intersect operationCatalogCeiling
```

`authorizeOperation` resolves the required closed capability from the backend
catalog, recomputes the intersection, binds it to one attempt, and refuses unless
present. It never trusts an operation-supplied capability name not in the catalog.

## Plan non-mutation boundary

Plan work is stored in a dedicated planning record or documentation branch owned
by the planning service. It has no production/private worktree handle, Git ref/
index mutation, implementation provider grant, shell/tool mutation, external
write connector, evidence admission, verdict, or merge route.

Every Plan operation catalog entry declares `effects=read-only|planning-store`.
The backend snapshots project repository refs/index/worktree identity and process
inventory before and after qualified Plan E2E. Any production filesystem/Git
change, implementation process, external mutation, or undeclared descendant is
`PLAN_MUTATION_DETECTED`, cancels the attempt, quarantines affected state, and
fails qualification. Hiding edit buttons is not enforcement.

Allowed labels are `Read-only`, `Planning`, `Plan saved`, `Decision packet ready`,
and `Approval requested`. Plan never displays implemented, fixed, tests pass,
verified, PASS, complete, or ready to merge.

## Build worktree and handoff contract

Entering Build requires one exact task/repository, explicitly selected agent/
provider/model, qualified execution target, and a fresh Kogg-owned private
worktree. Its grant contains only scoped edit/build/test operations and supervised
processes in that worktree. It cannot reach production refs/worktrees, evidence,
Ranex verdict, controlled merge, or completion endpoints.

Build handoff is immutable:

```text
BuildCandidateV1 {
  candidateId, taskRevisionId, sourceRepositoryIdentityDigest,
  privateWorktreeIdentityDigest, baseOid, candidateOid, candidateTreeOid,
  agentProviderModelDigest, untrustedCheckSummary,
  state: unverified-candidate, cleanupState, createdAt, candidateDigest
}
```

The success banner is exact: `Build work is unverified. Continue in Kogg mode to
run the required governed lifecycle.` The strongest status is `Build work ready
for Kogg verification`. Build checks are visibly `untrusted build checks`, never
Ranex evidence. Kogg may reference the candidate digest as input, but creates a
fresh governed run, revalidates/freeze-approves the specification, independently
reruns required work/checks, admits new evidence, and obtains a current verdict.

## Kogg integration and stage vocabulary

Kogg selected mode enables only the workflow engine to traverse:

```text
idea -> research -> pseudocode -> prototype/probe -> specification approval ->
production implementation -> real E2E -> independent checks -> evidence ->
current Ranex verdict -> human controlled merge -> cleanup -> governed complete
```

Stages come from the durable workflow owner. The mode service cannot skip,
reorder, mark complete, or synthesize them. `Governed PASS` is shown only for a
current exact Ranex projection. `Governed complete` requires controlled merge/
post-verification and zero-residual cleanup. Kogg autonomy stops at human approval
and controlled-merge authorization boundaries.

## Transition matrix and state machine

| Transition | Mandatory validation |
| --- | --- |
| Plan -> Build | explicit expansion confirmation; agent/provider/model/target and fresh worktree qualification |
| Plan -> Kogg | explicit expansion confirmation; compile exact governed workflow; start first unsatisfied valid stage |
| Build -> Plan | stop admission, cancel/reach safe boundary, revoke grants, clean processes/worktree operation; retain candidate as unverified |
| Build -> Kogg | clean/fence Build attempt, freeze untrusted candidate reference, compile fresh governed workflow and authority |
| Kogg -> Plan | pause/cancel at workflow safe boundary, finish mandatory cleanup/recovery, revoke workflow grants |
| Kogg -> Build | same cleanup plus explicit governed-run abandonment; create fresh Build worktree/grant |
| same mode | idempotent no-op unless configuration changes, then a full transition |

Authority expansion requires a backend challenge displayed with from/to mode,
new capability classes, target, active-work consequence, digest, and 120-second
expiry. The confirm button is not default-focused and has no cycling shortcut.
Reduction remains explicit because cancellation/data consequences require consent.

```text
REQUESTED -> VALIDATING -> AWAITING_CONFIRMATION (expansion)
REQUESTED|AWAITING_CONFIRMATION -> CLEANUP_PENDING
CLEANUP_PENDING -> CLEANING -> NEW_AUTHORITY_VALIDATING
NEW_AUTHORITY_VALIDATING -> COMMITTING -> COMMITTED
before COMMITTING: -> CANCEL_REQUESTED -> OLD_STATE_RESTORING -> CANCELLED
any state -> REFUSED|EXPIRED
cleanup/identity uncertainty -> QUARANTINED
```

Transition intent is committed before cancellation or worktree/process action.
While nonterminal, both old and new mutation capabilities are refused except
cancel/diagnose/cleanup. Active attempts retain frozen old grants, but no new old-
mode attempts start. Cleanup is register-before-spawn and ends only after external
zero-descendant and owned-worktree state proof.

The final SQLite transaction compares expected task mode sequence, revalidates
all authority, writes the new mode/effective digest, appends event, and marks the
transition committed. Concurrent-window stale sequence refuses
`MODE_TRANSITION_CONFLICT` and returns the current safe projection. A disconnected
client reads by request id; acknowledgement loss never repeats cleanup or grants.

## Refusals and direct-call behavior

Stable codes include `MODE_UNKNOWN`, `MODE_SCHEMA_UNSUPPORTED`,
`MODE_TASK_STALE`, `MODE_REPOSITORY_UNAVAILABLE`, `MODE_AUTHORITY_REFUSED`,
`MODE_EXPANSION_CONFIRMATION_REQUIRED`, `MODE_TRANSITION_CONFLICT`,
`MODE_ACTIVE_OPERATION`, `MODE_CLEANUP_FAILED`, `MODE_PROCESS_RESIDUAL`,
`MODE_WORKTREE_INVALID`, `MODE_PROVIDER_UNQUALIFIED`, `MODE_HOST_UNQUALIFIED`,
`PLAN_MUTATION_REFUSED`, `PLAN_MUTATION_DETECTED`, `BUILD_EVIDENCE_REFUSED`,
`BUILD_VERDICT_REFUSED`, `BUILD_COMPLETION_REFUSED`, `BUILD_MERGE_REFUSED`,
`KOGG_CANDIDATE_UNTRUSTED`, `MODE_RESTORE_DEGRADED`, and `MODE_QUARANTINED`.

Plan mutation calls fail before process/worktree intent. Build evidence/verdict/
completion/merge calls fail before Ranex/Git/external activity, regardless of UI,
extension, provider, replay, or direct RPC. Kogg continuation from Build refuses
until old cleanup and fresh workflow compilation succeed. UI cannot relabel a
backend Build result as governed.

## Recovery and persistence

The mode store uses SQLite WAL, full synchronous writes, foreign keys, strict
tables, schema version, immutable event chain, UUID idempotency ledger, and
generation CAS. It stores current task mode, transitions, attempt-grant digests,
safe recovery results, and untrusted candidate references; never prompts/content,
credentials, raw provider data, or Ranex evidence.

Startup recovery runs before mode operation admission:

```text
verify store integrity/event chain and task/project/workflow/operation owners
fence every nonterminal transition and its old attempt grants
inventory processes/worktrees and finish required owned cleanup
compare durable intent, old/new mode record, task sequence, and authority
if exactly old and cleanup safe: cancel/refuse transition, preserve old mode
if exactly new and commit event valid: restore new mode with recomputed authority
otherwise quarantine; never choose a more powerful mode or replay provider work
expire challenges; revoke orphan grants; publish one recovery result by CAS
```

Restoration always recomputes effective authority. A persisted selected Build or
Kogg may restore with narrower authority and visible remediation after task,
approval, repository, host, provider, or workflow drift. Archive prevents new
operations but retains safe history under task/incident holds. UI preferences
cannot delete or change task mode history.

## Always-visible accessible UI

The selector appears beside primary input and projects to task header/status bar.
Its closed control accessible name is `Mode: <mode>; authority: <summary>; stage:
<stage>`. At narrow width/200% zoom visible text may collapse to icon+mode, but
accessible authority/stage and a persistent blocked-action/status region remain.

Fixed menu order is Plan, Build, Kogg. Every option shows label, description,
capability summary, task compatibility, transition consequence, and disabled/
refused reason. Mouse, arrow keys, Home/End, Enter/Space, Escape, and Tab follow
ARIA menu-button behavior. No shortcut cycles upward without expansion dialog.
After cancel/refusal focus returns to selector; after success it returns to input.

States are `loading`, `ready`, `transition awaiting confirmation`, `cleanup in
progress`, `restored`, `restore degraded`, `refused`, `offline`, `error`, and
`quarantined`. Empty/no-task disables selection with visible reason. Color is not
the only signal; high contrast and reduced motion are honored. Stage changes are
polite announcements; approval, refusal, cleanup failure and quarantine are
assertive and deduplicated. Browser and Electron use identical terms.

Exact descriptions:

```text
Plan:  Research and design without changing production files.
Build: Implement and test in an isolated worktree; governed verification and
       merge remain required.
Kogg:  Run the complete governed lifecycle with required approvals, independent
       checks, evidence, verdict, and controlled merge.
```

## Observable lifecycle and diagnostics

Required logger/event families:

```text
kogg:ui:mode-selector          mode.selected|transition-requested|confirmation-shown|
                               projection-updated|restored|restore-degraded|operation-refused
kogg:interaction-modes:service transition.requested|validation.started|confirmation-required|
                               cleanup.started|completed|failed|approved|refused|cancelled|
                               committed|operation.requested|operation.approved|operation.refused
kogg:interaction-modes:recovery recovery.started|grant-revoked|process-reconciled|
                                completed|quarantined|failed
```

Safe fields are event/logger, project/task/run/attempt/operation/transition/session
correlation ids, old/new/effective mode, closed capability, active stage, safe
code, bounded duration/count, boolean outcome, and non-content grant digest. No
prompts/plans/code/diffs/paths, credentials, model/provider bodies, tool/command
data, environments, personal identity, or raw errors enter logs, metrics,
diagnostics, frontend console, or support bundles.

Final diagnostic ids:

- `interaction-modes.registry`
- `interaction-modes.authority`
- `interaction-modes.transitions`
- `interaction-modes.operations`
- `interaction-modes.restoration`
- `interaction-modes.worktrees`
- `interaction-modes.anchors`
- `interaction-modes.accessibility`
- `interaction-modes.source-maps`

Every operational file declares matching `diagnostic-coverage`; missing/throwing
contributors fail combined status. Diagnostics compare mode state, immutable
attempt grants, active owners, process inventory, and worktree identity. Source-
map checks prove browser/backend/Electron breakpoint mapping. Canary tests cover
every prohibited class and refusal/recovery path.

## #121 probe and #122 visible E2E

#121 uses real task/project registries, private Git worktrees, workflow/adapter
owners, operation supervisor/external inventory, authenticated browser session,
SQLite mode store, and a real adapter child. It probes all six cross-mode
transitions, same-mode idempotency, concurrent clients, direct RPC, acknowledgement
loss, task/repository/approval/provider/host drift, store corruption, and backend
restart before/after intent, cleanup and commit.

The principal run starts Build mutation, requests Kogg during the active child,
crashes during cleanup, restarts, proves zero descendants, commits Kogg only after
fresh workflow validation, and proves the Build candidate did not become evidence
or PASS. A second run loses commit acknowledgement and returns the same transition
and unique mode state without repeated cleanup or widened grant.

#122 drives the real browser and Electron UI by roles and visible text:

```text
observe selector/authority/stage/blocked actions in every relevant view
Plan research+pseudocode -> independently prove production files/refs/processes unchanged
Plan -> Build confirmation -> select agent/provider/model/target -> private edit/test
observe exact unverified handoff; refuse Build evidence/PASS/complete/merge via UI+RPC
Build -> Kogg -> fresh approval/check/evidence/current verdict/controlled merge
show governed completion only after post-verification and zero cleanup
switch downward during active work -> show cleanup and one residual quarantine/recovery
race two windows -> conflict one; disconnect/restart -> restore one task-scoped state
exercise keyboard/screen reader/narrow/zoom/contrast/reduced-motion/error states
break at browser/backend/Electron transition/recovery source-map locations
scan logs/diagnostics/support for canaries and verify Git/worktrees/process/Ranex oracles
```

Expected trace is selection -> request -> validation -> optional confirmation ->
active-owner cleanup -> new authority validation -> durable CAS commit -> projection/
restoration -> operation authorization. Refusal, cancellation, lost acknowledgement,
recovery, and quarantine traces are separately asserted. Component mocks,
service-only tests, pre-generated work, labels without backend oracles, hidden
processes, imported Build evidence, or missing lifecycle events fail release.
Required three-OS CI, `yarn test`, observability audit, current Ranex verdict,
controlled merge, and zero residual processes remain mandatory.
