# Evidence, verdict, and controlled-merge normative pseudocode

Tracking: [#109](https://github.com/anthonykewl20/kogg/issues/109), parent
[#107](https://github.com/anthonykewl20/kogg/issues/107), prototype
[#110](https://github.com/anthonykewl20/kogg/issues/110), and production
[#111](https://github.com/anthonykewl20/kogg/issues/111).

## Contract status

This document is normative for #110 and #111. `MUST` and `MUST NOT` are release
gates. It specifies one local V1 path: explain an exact Ranex verdict and, only
after a fresh authenticated human gesture, create one deterministic two-parent
merge commit and atomically update one local destination ref. Remote push,
fast-forward, squash, rebase, octopus merge, signing, auto-merge, and rollback are
not V1 operations.

Ranex owns evidence, gate evaluation, verdict, provenance, and journal integrity.
Kogg owns currentness comparison, interactive authorization, local Git
construction, expected-old ref update, recovery, and safe presentation. No UI,
agent, provider, Git exit, signature, or Kogg record can synthesize Ranex PASS.

## Canonical profile and identifiers

All Kogg records use UTF-8 NFC canonical JSON with lexicographically sorted keys,
lowercase UUIDs and SHA-256 hex, RFC3339 UTC timestamps, signed 64-bit integers,
no floats, duplicate keys, unknown keys, implicit defaults, or nullable fields
unless the schema says so. Digest:

```text
sha256(utf8("kogg:verdict-merge:<domain>:v1\n") || canonicalJson(record))
```

Domains are `query`, `explanation`, `currentness`, `challenge`, `authorization`,
`merge-intent`, `merge-result`, and `event`. Golden TypeScript/Python fixtures
MUST include Unicode normalization, line endings, unknown/duplicate fields,
integer bounds, and one-byte mutation. Native Git object fixtures MUST include
SHA-1 and SHA-256 repositories only when both are separately qualified; an
unqualified object format or ref backend refuses.

Every request has a UUID `requestId`; every explanation, challenge,
authorization, merge operation, process, and recovery pass has its own UUID.
Idempotency is exact request bytes plus authenticated session and task revision.
Same id/different digest returns `REQUEST_CONFLICT`; no state is changed.

## Closed records

```text
VerdictQueryV1 {
  queryId, requestId, taskId, taskRevisionId, approvalDigest,
  projectId, repositoryId, repositoryIdentityDigest,
  destinationRef, expectedBaseOid, subjectOid, subjectTreeOid,
  evidenceSetDigest, gateCatalogDigest,
  ranexArtifactDigest, ranexProtocolVersion, ranexJournalRoot, ranexJournalSeq
}

GateExplanationV1 {
  gateId, gateVersion, required: boolean,
  result: pass|fail|blocked,
  safeReasonCode,
  producerRoleDigest, verifierRoleDigest,
  evidenceDigest, subjectDigest, journalSeq
}

VerdictExplanationV1 {
  explanationId, queryDigest,
  ranexDecision: pass|fail|blocked,
  currentness: current|stale|unknown,
  currentnessCode,
  gateRows: GateExplanationV1[],
  requiredCount, passCount, failCount, blockedCount,
  verifiedAt, expiresAt,
  ranexProvenanceDigest, journalRoot, journalSeq,
  explanationDigest
}

MergeChallengeV1 {
  challengeId, explanationDigest, taskRevisionId,
  repositoryIdentityDigest, destinationRef,
  expectedBaseOid, subjectOid, subjectTreeOid,
  mergePolicyId: local-two-parent-no-ff-v1,
  authorizerRoleDigest, sessionId, nonceDigest,
  issuedAt, expiresAt, challengeDigest
}

MergeAuthorizationV1 {
  authorizationId, challengeDigest, explanationDigest,
  actorAuthorityDigest, authorizerRoleDigest, sessionId,
  exactBindingsDigest, state,
  recordedAt, expiresAt, consumedAt?, consumedByMergeId?, eventChainDigest
}

MergeIntentV1 {
  mergeId, requestId, authorizationId, authorizationDigest,
  exactBindingsDigest, repositoryIdentityDigest,
  destinationRef, expectedOldOid, subjectOid, expectedTreeOid,
  mergePolicyId, gitArtifactDigest, state, generation,
  constructionOperationId?, constructionProcessId?,
  expectedMergeOid?, cancelRequested: boolean,
  createdAt, updatedAt, eventChainDigest
}
```

`destinationRef` MUST match one exact policy-selected `refs/heads/<name>` and is
never client-free-form. Object IDs use the repository-qualified algorithm and
length. Explanation rows are sorted by `(gateId, gateVersion)`, have exactly one
row per required catalog gate, and contain no raw evidence.

## Interfaces and authority

```text
VerdictService.explain(query, authenticatedContext) -> VerdictExplanationV1
MergeService.createChallenge(explanationId, authenticatedContext) -> MergeChallengeV1
MergeService.authorize(challengeId, displayedChallengeDigest,
                       explicitHumanGesture, authenticatedContext) -> safe status
MergeService.execute(authorizationId, requestId, authenticatedContext) -> MergeProjectionV1
MergeService.cancel(mergeId, requestId, authenticatedContext) -> MergeProjectionV1
MergeService.get(mergeId, authenticatedContext) -> MergeProjectionV1
```

`explain` is read-only except its immutable safe projection/audit event.
`createChallenge` and `authorize` are accepted only from the first-party
authenticated browser/Electron session with CSRF/origin proof. Provider, agent,
extension-host, automation, tool, and background-service roles are categorically
denied even if they possess a task id or session cookie. The challenge nonce and
consumable authorization secret stay in the backend store and are never returned
to agents or logged.

The authorization dialog shows destination ref, abbreviated base and subject,
merge method, current Ranex PASS, expiry, and the short challenge digest. The
destructive button is not default-focused and has no shortcut. The human MUST
activate it after the current explanation is rendered. Window/session loss,
expiry, navigation to another task, repository change, or any binding drift
revokes the challenge.

Producer, deterministic verifier, evidence producer, Ranex authority, human
authorizer, and merge executor role digests MUST be pairwise compatible with the
closed separation matrix. Producer/verifier/agent roles cannot satisfy the human
authorizer role. The merge executor grant contains only `construct objects` and
`CAS one exact ref`; it has no evidence, verdict, credential, remote, force,
delete, additional-ref, or authorization-minting capability.

## Explanation and currentness state machine

```text
REQUESTED -> VERIFYING_RANEX -> COMPARING_BINDINGS -> CURRENT|STALE|REFUSED
VERIFYING_RANEX|COMPARING_BINDINGS -> FAILED
CURRENT -> STALE|EXPIRED
```

```text
explain(query):
  validate schema, session read grant, task/project/repository identity
  persist safe REQUESTED event
  obtain one operation lease; call pinned Ranex bridge with exact query digest
  require artifact/protocol/schema, journal root/sequence, gate catalog,
    evidence set, subject and task bindings to equal the query
  require one closed row for every catalog gate and verify Ranex journal
  map Ranex rows to safe GateExplanationV1 without re-evaluation
  independently read current task revision/approval, repository identity,
    destination ref, base/subject/tree, authority matrix, catalog and provenance
  compare every exact binding in a fixed order
  if any source unavailable or ambiguous: result unknown, refuse authorization
  if any binding differs or projection expires: state STALE with one safe code
  else state CURRENT; preserve Ranex pass|fail|blocked exactly
  atomically append immutable explanation and terminal event
```

Only `ranexDecision=pass AND currentness=current` enables challenge creation.
FAIL is a verified failed requirement. BLOCKED is missing/invalid/conflicting or
infrastructure-unsafe evidence. STALE is a historical verdict whose exact current
bindings differ. UNKNOWN is never displayed as FAIL or PASS. The frontend cannot
choose evidence, omit rows, recalculate results, or extend expiry.

## Challenge and authorization state machine

```text
CHALLENGE_CREATED -> AUTHORIZED|REFUSED|EXPIRED|REVOKED
AUTHORIZED -> CONSUMING -> CONSUMED
AUTHORIZED|CONSUMING -> REVOKED|EXPIRED (only before merge intent transaction)
CONSUMING -> CONSUMED (same transaction that creates MergeIntentV1)
```

Challenge lifetime is at most 120 seconds; authorization lifetime is at most 60
seconds and both are policy constants. `authorize` re-reads the authenticated
session, authorizer role, task, repository/ref/objects, explanation expiry and
currentness. It compares the human-returned digest with the backend record using
constant-time equality, writes `AUTHORIZED` in one SQLite immediate transaction,
and invalidates every older unused challenge for the task.

`execute` transactionally verifies unused/current authorization and every exact
binding, inserts `MergeIntentV1(PREFLIGHT_PENDING)`, and changes authorization to
`CONSUMED` with that merge id. A unique constraint on authorization id and
exact-bindings digest prevents reuse. Transaction failure consumes nothing.
Once an intent exists, no second authorization or merge intent may be created for
the same task revision/destination/subject tuple until the first is terminal and
reconciled.

## Repository qualification and isolated Git contract

V1 accepts a local non-bare repository owned by the project registry, one normal
`refs/heads/*` destination, two commit objects, no replace/graft/shallow state,
no submodules in the resulting tree, no sparse/object promisor dependency, no
alternate object directory, and a qualified files/ref backend. Repository local
config and attributes are parsed before construction; executable hooks, custom
merge drivers, filters, signing, credential/remote helpers, fsmonitor, pager,
editor, aliases, include/includeIf, worktree config, or unknown extension refuse.
`.git/info/attributes` and tree `.gitattributes` entries that select custom merge
or filter behavior refuse. The user worktree/index MUST remain untouched.

Every Git invocation is an argument-array spawn through the operation supervisor,
registered before start, with stdin/stdout/stderr byte caps, first-progress/idle/
absolute/cleanup deadlines, TERM then KILL escalation, and external descendant
inventory. No shell is used. The executable path and digest/version come from
the qualified runtime.

The child environment is empty except an allowlist containing qualified `PATH`,
locale/timezone, temporary owned directories, and these controls:

```text
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_SYSTEM=<owned empty file>
GIT_CONFIG_GLOBAL=<owned empty file>
GIT_TERMINAL_PROMPT=0
GIT_ASKPASS=<owned always-fail helper>
SSH_ASKPASS=<owned always-fail helper>
GIT_PAGER=cat
GIT_EDITOR=<owned always-fail helper>
GIT_SEQUENCE_EDITOR=<owned always-fail helper>
GIT_OPTIONAL_LOCKS=0
```

Each command also supplies closed `-c` overrides for hooks path, signing,
credential helper, pager/editor, advice, and protocol/file transport. The owned
temporary directory is mode 0700 and contains only empty config, failing helpers,
temporary index, and bounded state. Its cleanup and descendant absence are
verified externally before terminal success.

## Deterministic merge and exact command sequence

Policy `local-two-parent-no-ff-v1` constructs a merge commit with parents
`expectedOldOid` then `subjectOid`, the tree calculated by qualified native Git,
fixed message bytes `Kogg controlled merge\n`, fixed author/committer name
`Kogg`, fixed non-personal address `kogg@localhost.invalid`, and a policy-owned
UTC timestamp captured in the intent. It never reads subject commit messages or
personal metadata into Kogg records/logs.

```text
preflight:
  assert destination ref == expectedOldOid by native rev-parse/read-ref
  cat-file -e <base>^{commit}; cat-file -e <subject>^{commit}
  read exact base/subject tree and parents; verify requested subjectTreeOid
  merge-base --all <base> <subject>; require exactly one qualified merge base
  revalidate task/approval/authority/explanation/Ranex/journal/repository/policy
  verify repository config/attributes/object/ref qualification and no writer

construct:
  register operation and Git process before spawn
  merge-tree --write-tree --messages --merge-base <mergeBase> <base> <subject>
  require qualified output grammar, one tree oid, no conflict or extra record
  independently cat-file the tree and enforce no prohibited entry/submodule
  commit-tree <tree> -p <base> -p <subject>
  send fixed message on bounded stdin; supply fixed identity/time in child env
  require one commit oid and independently verify raw object type, tree, exact
    ordered parents, fixed message/identity/time under native Git semantics
  persist expectedMergeOid and state CAS_READY before any ref mutation

compare-and-swap:
  revalidate every mutable binding and current Ranex PASS one final time
  persist CAS_STARTED and fsync
  run: update-ref <destinationRef> <expectedMergeOid> <expectedOldOid>
  never retry this command after start or ambiguous acknowledgement
  persist observed result when available

post-verify:
  read destination ref independently
  require it equals expectedMergeOid
  repeat commit/tree/ordered-parent verification
  require task/project/repository and Ranex exact bindings remain valid
  persist COMMITTED, then clean temporary state/processes and persist CLEANED
```

A merge conflict, unexpected merge-base cardinality, malformed/oversized output,
object mismatch, or qualification issue refuses before CAS. Objects written
during failed construction may remain unreachable; their exact ids are recorded
only in the private intent store for bounded maintenance and never treated as a
ref mutation or success.

## Merge, cancellation, failure, and recovery states

```text
PREFLIGHT_PENDING -> PREFLIGHTING -> CONSTRUCTING -> CAS_READY -> CAS_STARTED
CAS_STARTED -> POST_VERIFYING -> COMMITTED -> CLEANING -> COMPLETED
before CAS_STARTED: -> CANCELLING -> CLEANING -> CANCELLED
any pre-CAS state: -> REFUSED|FAILED -> CLEANING -> terminal
CAS_STARTED|POST_VERIFYING: -> RECOVERY_REQUIRED
any cleanup uncertainty: -> QUARANTINED
```

Cancellation before `CAS_STARTED` revokes unconsumed authority where applicable,
terminates registered children, proves zero descendants, deletes only owned
temporary state, verifies the destination still equals `expectedOldOid`, and
ends CANCELLED. At or after `CAS_STARTED`, cancellation only records intent; it
cannot kill/retry/update/revert until exact ref reconciliation completes. A
verified committed ref finishes post-verification and reports committed despite
the late cancellation.

Startup recovery runs before merge admission even when no queue is visible:

```text
recover(intent):
  acquire one fenced recovery lease
  verify stores/event chain/repository identity/Git artifact and process inventory
  terminate and externally clean owned registered descendants
  read destination ref and verify expected old/new objects independently
  if ref == expectedOldOid:
    classify NOT_COMMITTED; never repeat CAS; cancel/expire the consumed intent
  else if ref == expectedMergeOid and merge object/tree/parents are exact:
    classify COMMITTED; finish post-verification and cleanup
  else:
    classify AMBIGUOUS_DRIFT; quarantine repository/task; permit diagnose only
  persist one recovery result under generation CAS; release lease
```

Recovery never creates a commit, updates a ref, reuses authorization, chooses the
latest favorable verdict, or deletes an unowned lock. Ref absence, symbolic-ref
change, invalid object, unexpected third oid, store corruption, unresolved child,
or inventory unavailability quarantines. Quarantine is cleared only by a
separately authorized human remediation that proves exact facts; it is not an
automatic retry.

Stable safe failures include `VERDICT_FAIL`, `VERDICT_BLOCKED`,
`VERDICT_STALE`, `VERDICT_UNKNOWN`, `RANEX_PROVENANCE_INVALID`,
`JOURNAL_INVALID`, `BINDING_MISMATCH`, `IDENTITY_SEPARATION_INVALID`,
`AUTHORIZATION_REQUIRED`, `AUTHORIZATION_EXPIRED`, `AUTHORIZATION_REPLAY`,
`PREFLIGHT_REF_DRIFT`, `GIT_REPOSITORY_UNQUALIFIED`, `GIT_CONFLICT`,
`GIT_PROCESS_FAILED`, `GIT_OUTPUT_INVALID`, `GIT_OBJECT_INVALID`,
`REF_CAS_CONFLICT`, `MERGE_OUTCOME_UNKNOWN`, `PROCESS_RESIDUAL`,
`CLEANUP_FAILED`, `STORE_INTEGRITY_FAILED`, and `MERGE_QUARANTINED`.

## Persistence, locks, and retention

Verdict projections, challenges, authorizations, intents, results, and safe
events live in separate SQLite WAL stores or tables with foreign keys, strict
tables, integrity-bound event chains, schema version, full synchronous writes,
busy timeout, and single-writer transactions. Authoritative Ranex evidence is
never copied into them. Merge intent is committed before external work and every
state transition is generation-CAS plus append-only event in one transaction.

One repository/destination lock is acquired by exact repository identity and ref.
Its durable owner, process identity, lease generation, and expiry are reconciled;
age alone cannot delete it. Challenges expire after 120 seconds, unused
authorizations after 60 seconds, and safe projections follow task retention.
Committed/quarantined intent records, authorization consumption, and event-chain
roots are retained with the task and any incident/legal hold. Raw Git/Ranex
streams are bounded in memory for classification and discarded immediately.
Support bundles contain only safe codes, closed states/counts, diagnostic status,
opaque correlations, and non-content digests.

## Observable lifecycle contract

Required loggers and events are exact:

```text
kogg:verdict:service       explanation.requested|verification.started|completed|refused|failed
kogg:verdict:currentness   comparison.started|current|stale|unknown|expired
kogg:merge:authorization   challenge.created|refused|expired|revoked;
                           authorization.requested|recorded|refused|consumed|replay-refused
kogg:merge:preflight       preflight.started|completed|refused|failed
kogg:merge:process         process.registered|spawn.started|started|exit|timeout|
                           cancel.started|cleanup.started|completed|failed
kogg:merge:atomicity       construction.completed|cas.started|cas.observed|
                           postverify.started|completed|failed
kogg:merge:recovery        recovery.started|process.reconciled|not-committed|
                           committed|quarantined|failed|completed
kogg:merge:service         merge.requested|intent.recorded|cancel.requested|
                           completed|cancelled|refused|failed|quarantined
```

Every event carries timestamp, logger/event, request/explanation/authorization/
merge/operation/process correlations as applicable, closed lifecycle state,
safe code, bounded duration/count, boolean result, and only operationally needed
non-content binding digests. Commit ids may appear only in the authenticated UI
safe projection, not general logs or metric labels. Events MUST NOT contain
prompts, code, source, diffs, paths, commands/arguments, environment, credentials,
cookies, session proof, personal identity, commit messages, raw Git streams,
evidence/journal/verdict bodies, or provider/request/response bodies.

Required catalog ids are final:

- `verdict.provenance`
- `verdict.bindings`
- `verdict.currentness`
- `verdict.explanation`
- `merge.authorization`
- `merge.preflight`
- `merge.processes`
- `merge.atomicity`
- `merge.recovery`
- `merge.source-maps`

Every operational implementation file declares the matching
`diagnostic-coverage`. Missing, throwing, stale, or incomplete contributors fail
combined status. The source-map contributor verifies browser, backend, Electron,
and Ranex bridge breakpoint mapping. Process diagnostics compare durable intent,
operation registry, and external inventory; any disagreement is abnormal.

## #110 real-boundary fault matrix

The prototype uses the real pinned Ranex bridge/journal, native qualified Git,
SQLite WAL stores, operation supervisor, task/project bindings, and disposable
repositories. The success run obtains exact PASS, records a test-human
authorization through the real UI boundary, creates the deterministic merge,
kills the backend after `CAS_STARTED`, restarts, and proves exactly one commit/ref
update, one consumed authorization, and zero descendants.

Fault injection is table-driven immediately before and after: Ranex request,
journal verification, explanation commit, challenge creation, authorization
commit, authorization consume/intent commit, each preflight read, process
registration/spawn/exit, tree construction, commit construction, `CAS_STARTED`
fsync, update-ref syscall/acknowledgement, post-verification, process cleanup, and
terminal commit. Each seam asserts exact old/new/third-ref recovery behavior and
that CAS is never blindly retried.

Mutations independently cover task/spec/approval/role/session/expiry, repository
identity, base/subject/tree, evidence/catalog/journal/provenance, destination ref,
merge policy, object type/reachability, config/attribute/hook/helper execution,
process crash/hang/output flood, lock contention, concurrent writer, malformed
commit/tree, residual descendant, SQLite corruption, and duplicate/conflicting
request ids. Canary values traverse every input/failure path and remain absent
from logs, errors, diagnostics, metrics, and support output.

## #111 visible browser/Electron E2E

The automated human-level path drives roles, names, buttons, dialogs, focus, and
visible status in both real browser and Electron applications; service-only calls
or screenshots do not qualify.

```text
success trace:
  open governed task -> open Evidence -> request explanation
  observe every required gate and exact current PASS summary
  choose Controlled merge -> inspect destination/base/subject/method/digest
  explicitly confirm -> observe preflight/construction/CAS/postverify/cleanup
  observe Merged and authorization consumed
  independently assert destination commit tree/parents, Ranex current verdict,
    task/project bindings, diagnostics all pass, and process inventory zero

negative traces:
  show FAIL, BLOCKED, STALE, and UNKNOWN with distinct safe remediation
  agent/provider/direct-RPC authorization and self-merge are refused
  replayed/expired/wrong-session authorization is refused
  stale verdict, task/authority/repository/subject/base/ref drift is refused
  conflict, malformed object, hook/helper/config attempt is refused pre-CAS
  cancellation before CAS leaves old ref and zero processes
  restart around CAS resolves old as not committed or exact new as committed,
    never double-merges and never requests/reuses a second authorization
  unexpected third ref, residual child, or corrupt store visibly quarantines
```

Keyboard-only operation, dialog focus/cancel restoration, 200% zoom, high
contrast, reduced motion, screen-reader gate relationships/live announcements,
offline restart, and browser reconnect are mandatory. Tests attach debugger
breakpoints at explanation, authorization, Git spawn/CAS, and recovery source-map
locations. Expected safe trace sequences are asserted, and the complete browser,
backend, Electron, Python/Ranex, and Git-adjacent capture is scanned for prohibited
canaries. Missing events, hidden processes, mocked owned boundaries, ambiguous
ref outcome, or a UI label implying merge before post-verification fails release.
