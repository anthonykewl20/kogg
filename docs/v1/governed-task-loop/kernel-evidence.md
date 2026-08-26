# Ranex task operations and evidence binding

Tracking: [#102](https://github.com/anthonykewl20/kogg/issues/102), research
phase [#103](https://github.com/anthonykewl20/kogg/issues/103), and pseudocode
phase [#104](https://github.com/anthonykewl20/kogg/issues/104).

## Status

Research and decision-complete pseudocode are complete as of 2026-08-27. This
packet contains no production code. It fixes the contract that #105 must probe
at the real Ranex/Git/check boundary and #106 must ship with visible E2E.

The recommendation is a closed Kogg-to-Ranex command protocol in which every
request and result is bound to one immutable task revision, approved authority
snapshot, repository/worktree identity, input and output Git states, producer,
check definition, check execution, evidence manifest, and journal position.
Ranex remains the evidence and verdict authority. Kogg owns safe orchestration,
process supervision, and UI projection, but cannot manufacture, edit, import as
trusted, or reinterpret Ranex facts.

A command being advertised, a subprocess exiting zero, a check name matching,
or an evidence row existing is never sufficient. Admission recomputes canonical
digests, verifies every cross-record binding and producer/verifier constraint,
requires the current journal and protocol provenance, and fails closed on any
missing, false, stale, duplicated, ambiguous, unsupported, or mismatched claim.

## Scope and invariants

This slice qualifies and exposes the Ranex operations required by the governed
task loop: create/bind the executable task context, dispatch producer work,
freeze and execute deterministic suites, admit evidence, evaluate gates, read a
verdict, and later request controlled merge. Exact public operation names and
schemas are a #104 decision; the current adapter's advertised-but-unimplemented
commands are not a contract.

The following invariants are non-negotiable:

- only the pinned bundled Ranex revision and closed protocol may answer a
  governed request;
- capabilities describe actually implemented, tested operations, not future
  names or internal CLI functions;
- each request uses a fresh operation ID and an idempotency key scoped to its
  immutable inputs; a retry cannot expand authority or change bindings;
- a frozen task revision and its authenticated approval precede mutation;
- repository identity includes canonical repository ID, protected source state,
  owned worktree, base commit, current subject commit, and object format;
- a producer cannot approve, admit, or deterministically verify its own claim;
- evidence binds claim type, subject digest, producer, command/check definition,
  executable identity, execution attempt, result, suite manifest, timestamps,
  and relevant repository states;
- paths, labels, branch names, UI state, process exit, logs, screenshots, and
  provider statements are never substitutes for content-addressed bindings;
- every required claim has exactly one applicable current result under a closed
  gate catalog; unknown, duplicate, conflicting, superseded, or partial results
  refuse evaluation;
- every verdict binds the exact gate catalog, complete admitted evidence set,
  subject commit, task/specification, authority snapshot, Ranex provenance, and
  journal integrity state;
- any subject, specification, suite, producer, policy, catalog, executable, or
  repository change makes the earlier result stale rather than updating it;
- PASS is immutable evidence about one exact subject, never a floating status;
- Kogg never rewrites the Ranex journal or treats its own operations database as
  product evidence;
- all Kogg-created Ranex bridge and check processes are registered before start,
  bounded, cancellable where safe, drained, and reconciled after restart; and
- logs, diagnostics, support bundles, errors, and UI projections never expose
  prompts, code, diffs, command arguments, environments, credentials, personal
  data, raw evidence bodies, signing material, or provider payloads.

## Commit-pinned source ledger

Sources supply patterns only. No external implementation is approved for copy
or dependency reuse without a separate license, provenance, maintenance, and
security review.

| Source | Exact revision and license | Reviewed paths | Finding |
| --- | --- | --- | --- |
| [Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | vendored commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25); MIT | `src/ranex/governed_execution`, `src/ranex/foundation`, `src/ranex/cli`; evidence, verdict, approval, confinement, journal and observability tests/ADRs; Kogg's `kogg_ranex_adapter.py` | Select Ranex as sole governed evidence/verdict authority. Preserve canonical records, approval/grant intersection, producer binding, gate evaluation, append-only hash-chained journal, confinement, watchdog, and recovery. Close the Kogg protocol around implemented application operations rather than forwarding a CLI or database. |
| [in-toto](https://github.com/in-toto/in-toto/tree/a8ce9ee2125ae5a4b041a4e37cc1cf10eed0da6b) | commit `a8ce9ee2125ae5a4b041a4e37cc1cf10eed0da6b` (2026-05-19); Apache-2.0 | `in_toto/models/layout.py`, `models/link.py`, `models/metadata.py`, `verifylib.py`, `runlib.py`, `resolver`; verification tests | Preserve separation of signed layout/intent from functionary-produced links, thresholds, authorized identities, material/product digests, command and byproduct records, artifact rules, expiration, and ordered verification. Reject path rules, captured streams, and self-reported link metadata as sufficient Kogg evidence. |
| [SLSA verifier](https://github.com/slsa-framework/slsa-verifier/tree/30d0be3bbab553fc51557377baba2f7572dfc212) | commit `30d0be3bbab553fc51557377baba2f7572dfc212` (2026-08-26); Apache-2.0 | `options/options.go`, `verifiers/internal/gha`, `gcb`, `vsa`; `cli/slsa-verifier/verify`; negative tests | Preserve independent expected subject digest, source URI/digest, builder identity, predicate, and signature verification. Reject loose identity matching and provenance existence without caller-supplied expectations for governed local work. |
| [Rekor](https://github.com/sigstore/rekor/tree/ca54a2ce7e2506b9eb4084a14f2d55e1554e3633) | commit `ca54a2ce7e2506b9eb4084a14f2d55e1554e3633` (2026-08-25); Apache-2.0 | `pkg/api/entries.go`, `cmd/rekor-cli/app/verify.go`, `internal/trillianclient`, checkpoint and inclusion-proof tests | Preserve canonical serialization, signed checkpoints, inclusion proofs, immutable indexes, and verification against an independently trusted root. Reject a network transparency service for local V1; a log entry alone does not establish claim semantics or current applicability. |
| [GitHub CLI attestation](https://github.com/cli/cli/tree/606cda4a9b1a703ad7c2e353a77bce0d93d21b0e) | commit `606cda4a9b1a703ad7c2e353a77bce0d93d21b0e` (2026-08-26); MIT | `pkg/cmd/attestation/artifact`, `api`, `verification`, `verify`; policy and integration tests | Preserve local artifact digest calculation, predicate filtering, trusted-root/signature verification, signer workflow/repository/digest constraints, source ref/digest constraints, and explicit offline mode. Do not delegate Kogg evidence authority to GitHub or accept repository-owner identity as adequate producer separation. |

All decisions below are reproducible from these exact revisions plus the pinned
Ranex source already vendored in Kogg. Mutable hosted documentation is advisory.

## Existing Kogg/Ranex boundary

Kogg currently pins protocol version 1 and the Ranex commit in
`packages/kogg-contracts`, spawns a private Python JSONL adapter through the
backend bridge, performs a handshake, exposes health/capabilities, verifies the
journal, evaluates a gate, and lists journal entries. The bridge registers its
process and bounds requests. Source maps, Python source, diagnostic contributors,
and operation-registry support already establish the observability foundation.

The present boundary is intentionally incomplete for this slice:

- `COMMANDS` advertises `run`, suite, dependency, key, dispatch, judge, merge,
  delegate, and fanout names that `_dispatch` does not implement;
- the public TypeScript interface exposes only generic evaluation and untyped
  records for results/verdicts;
- `KernelEvidenceInput` accepts caller-provided executable paths and command
  digests without proving how they were observed or qualified;
- the adapter converts dictionaries into Ranex `Evidence` but does not expose a
  closed evidence-admission result or complete task-operation lifecycle;
- `verdict.list` returns all raw journal entries after chain verification rather
  than a bounded, typed, redacted verdict projection;
- request errors may include bounded exception text, which can still contain
  content or paths and must be replaced by stable safe codes at the boundary;
- there is no explicit request schema fingerprint, maximum message size, field
  count/depth bound, per-operation capability version, or result schema; and
- protocol capability presence is not yet mechanically coupled to dispatch,
  contract tests, diagnostics, and a real invocation.

#104 must eliminate advertised fiction: an operation appears in capabilities
only if the adapter dispatches a versioned closed request to a tested Ranex
application service and can return a closed safe result. Unsupported operations
remain absent and are refused before a process or journal mutation.

## Source findings

### Ranex: authority stays below the Kogg projection

Ranex already models the important trust facts: canonical specification and
approval records, intersected grants, evidence tied to claims/subjects/producers,
suite results, gate verdicts, controlled task merge, append-only journal entries,
and qualified confinement. Kogg should compose these services, not duplicate
their domain types in a mutable UI database or bypass them through a CLI shell.

The Kogg bridge must translate only closed Kogg identifiers and canonical bytes
into a closed Ranex request. It must never pass a prompt, source blob, diff,
credential, arbitrary command line, or UI-supplied evidence JSON. Content needed
by Ranex is referenced through approved task/repository records and recomputed by
the owning backend/Ranex boundary. Ordinary UI callers receive safe status,
binding digests, timestamps, and stable refusal codes, not journal internals.

Journal integrity is necessary but not sufficient. A valid hash chain can hold
a correctly appended FAIL, stale PASS, unrelated task result, or evidence from a
different producer. Every read path must verify chain integrity first and then
select by exact immutable bindings. Kogg must not scan for the newest convenient
PASS or infer current state from list order.

### in-toto: intent, functionary, material, and product separation

in-toto layouts define expected steps, authorized functionaries, thresholds,
material/product rules, commands, and expiration. Functionaries create signed
link metadata recording the actual materials, products, command, and byproducts;
verification checks signatures, thresholds, and artifact rules against layout
intent. This is a useful separation for Kogg's approved task, producer attempt,
deterministic check, evidence admission, and gate evaluation.

Kogg narrows the pattern. File paths are not stable identities across worktrees,
case rules, symlinks, and platforms. Stdout/stderr and arbitrary byproducts may
contain secrets or source and cannot enter the lifecycle store. Command equality
is not string equality: the governed check definition, executable artifact,
resolved toolchain, working repository, environment policy, timeout, and suite
manifest must be canonically bound before execution.

Threshold signatures are not required for local V1, but role independence is.
The authenticated producer identity and deterministic verifier identity must be
different under policy, and neither can stand in for the human task approver or
Ranex verdict authority.

### SLSA verifier: compare against independent expectations

The SLSA verifier does not merely parse provenance. Verification receives an
expected artifact digest, source URI, source version/digest, and builder identity,
then checks signed provenance against those independent values. Its tests refuse
missing subjects, hash mismatches, invalid DSSE payloads, and identity errors.

Kogg adopts the principle but uses stricter exact local bindings. A prefix,
suffix, branch, owner, workflow label, or user-friendly repository name is not
enough. Expected values come from the immutable task/run plan and independently
observed Git/object/process state, never from the evidence being verified. The
same value may be stored twice for auditability, but it must have two distinct
authoritative derivations or it is not a comparison.

### Rekor: append-only integrity does not prove applicability

Rekor canonicalizes entries, signs tree checkpoints, and returns inclusion
proofs that let a verifier prove an entry is present in a specific log state.
This reinforces Ranex journal verification, stable positions, canonical record
encoding, and independently verifiable integrity roots.

Kogg does not need a network transparency log in V1. It would add availability,
privacy, identity, retention, and trust-root operations while still not proving
that an entry applies to the active task. The local Ranex journal remains the
authority; support output may expose safe journal health and an opaque position
or root digest, never raw entries. Absence of network publication is not a
degradation of local evidence validity.

### GitHub attestation: policy is more than signature validity

GitHub CLI calculates the artifact digest locally, fetches or reads attestations,
verifies Sigstore material against a trusted root, then constrains predicate,
repository/owner, signer workflow or certificate identity, signer digest, source
ref, and source digest. It also makes offline verification explicit.

Kogg adopts the order: establish local subject identity, authenticate the record,
then enforce semantic and identity policy. A valid signature without exact
subject and producer bindings is refused. GitHub identity is not Kogg role
independence, and a GitHub attestation cannot replace Ranex evidence. External
attestation can later be an input claim only through an explicit closed adapter
and policy; it is never automatically trusted because it is fetchable.

## Selected authority and binding model

The selected chain has four authorities with no shared mutable truth:

1. Kogg Tasks owns frozen task/revision history and authenticated local approval.
2. Kogg Workflow/Execution owns the immutable run plan, repository/worktree
   lease, process inventory, attempt lifecycle, and safe control projection.
3. Ranex owns executable grants, admitted evidence, gate evaluation, verdicts,
   and the evidence journal.
4. Git owns content-addressed repository states; controlled merge later verifies
   them again rather than trusting cached Kogg labels.

Every governed record must bind, directly or through a canonical parent digest:

- project ID, repository ID, repository object format, and protected source
  checkout identity;
- task ID, frozen revision ID and digest, approval event/digest, and authority
  snapshot/grant digest;
- run ID, attempt ID, workflow/template/plan digest, and qualified Linux target;
- worktree ID, base commit/tree, pre-operation commit/tree/index/worktree state,
  subject commit/tree, and post-operation cleanliness classification;
- operation/claim ID, claim schema/type/version, producer role/adapter/session,
  verifier role, and policy/catalog version;
- check definition and suite-manifest digests, executable/toolchain identity,
  controlled environment-policy digest, deadline, exit classification, and
  structured suite result digest;
- evidence record digest, journal position/root, Ranex commit/tree/protocol and
  schema fingerprints; and
- verdict digest/state, evaluated evidence-set digest, evaluation time, expiry or
  freshness policy, and controlled-merge request binding where applicable.

Canonicalization rules must be singular and versioned. #104 must choose exact
UTF-8, Unicode, line-ending, JSON key/order/number, absent-versus-null, timestamp,
Git SHA-1/SHA-256, and digest-domain rules with cross-language fixtures. Raw file
paths and platform-specific executable paths may be used transiently to inspect
the system but are represented by approved logical identity plus content digest
in evidence.

## Claim and operation closure

The kernel API should expose a small versioned operation catalog rather than an
arbitrary method string. Each operation definition fixes request/result schemas,
required binding fields, required grant, idempotency semantics, timeout class,
cancellation behavior, expected journal mutations, diagnostic check, and safe
refusal codes.

Candidate operation families for #104 are:

- `task.admit`: bind the approved frozen task/run plan to a Ranex grant;
- `producer.dispatch` and `producer.complete`: create and close an authorized
  producer attempt without accepting the producer's claim as evidence;
- `suite.freeze`: canonicalize the deterministic check catalog and exact suite;
- `check.execute` or a Kogg-supervised equivalent: observe a qualified check
  attempt and construct an admission candidate from independent process/Git facts;
- `evidence.admit`: verify and append one closed claim result;
- `gate.evaluate`: evaluate the exact closed evidence set and append a verdict;
- `verdict.read`: return one exact safe verdict projection; and
- `merge.authorize`: later issue a single-use authorization bound to unchanged
  repository states and current PASS, with actual merge owned by #111.

Dispatching an agent, running a command, admitting evidence, evaluating a gate,
and merging are separate operations. A convenience `run` command that combines
them obscures authority and failure boundaries and is rejected. Fanout/delegation
is owned by workflow/adapter slices and cannot be exposed merely because Ranex
has an internal command of that name.

## Lifecycle, processes, and recovery

The bridge is one supervised long-lived `ranex-kernel` process. Each request is
also a durable `ranex-request` operation correlated to task/run/attempt/worktree.
Any Kogg-created Git, check, tool, or provider child is its own registered process
under the owning operation before spawn. Ranex-governed descendants remain Ranex
owned; Kogg projects only the closed parent/result and never duplicates PIDs.

Required bridge events are `start-requested`, `process-registered`, `spawned`,
`handshake-started`, `ready`, `request-started`, bounded `activity`,
`request-completed` or `request-refused`/`request-failed`/`request-timed-out`,
`shutdown-requested`, `drain-started`, `process-exited`, `cleanup-completed`, and
`recovery-completed`. Check/evidence operations add safe `subject-observed`,
`suite-bound`, `check-started`, `check-exited`, `evidence-admission-started`,
`evidence-admitted` or `evidence-refused`, and `verdict-evaluated` events.

Recovery never guesses from a missing response. On backend restart:

1. block new governed admission;
2. verify the operation database and Ranex journal independently;
3. reconcile bridge/check process identity without PID-only signaling;
4. query an exact idempotency key or journal binding through a closed Ranex read;
5. commit the observed terminal result if uniquely proven;
6. otherwise mark `recovery-required`, preserve the worktree/evidence, and refuse
   retry or merge until an explicit safe recovery decision; and
7. prove no residual Kogg-owned process before declaring cleanup.

Cancellation stops future dispatch first, signals owned process groups through
the supervisor, waits for terminal exit, records partial/non-admitted results,
drains pending requests, and preserves the immutable journal. Cancellation does
not delete evidence or turn an unknown result into FAIL/PASS.

## Failure and refusal matrix

| Failure | Required behavior |
| --- | --- |
| Protocol, commit, tree, or schema mismatch | Refuse every governed operation; expose safe diagnostic failure; no downgrade or alternate kernel. |
| Capability advertised but not dispatchable/tested | Release-blocking contract failure; remove capability until implemented. |
| Oversized, unknown, duplicate, or malformed request field | Refuse before domain call or journal mutation using a stable safe code. |
| Missing/invalid journal or unverifiable root | Block admission, verdict reads, and merge; preserve for explicit recovery. |
| Subject/specification/repository/suite/producer mismatch | Refuse evidence as non-applicable; never coerce or select a nearby record. |
| Producer equals approver or deterministic verifier | Refuse under separation policy even if the check passed. |
| Check exit zero but structured result absent/malformed | Record process outcome; refuse evidence admission. |
| Structured PASS but exit/process/repository state conflicts | Refuse as contradictory; preserve safe diagnostic correlation. |
| Evidence duplicate with identical idempotency key | Return the one existing immutable result; do not append twice. |
| Evidence duplicate/conflict with different body | Refuse and flag integrity/policy conflict. |
| Timeout, lost response, bridge crash | Mark outcome unknown, reconcile by exact key; never blind retry. |
| Subject changes after PASS | Earlier verdict remains historical and stale; require new checks/evidence/verdict. |
| Raw provider or imported evidence claim | Treat as untrusted input until independently observed and admitted by a closed adapter. |
| Cleanup incomplete or possible residual | Block next attempt and merge; surface recovery-required diagnostics. |

All external error text is classified locally into a closed code. Exception
messages, stderr, paths, commands, evidence bodies, and journal rows do not cross
the JSONL boundary or enter logs/support bundles.

## Observability and diagnostics

Use Theia `ILogger` with `kogg:kernel:<component>` or Theia-routed messages with a
`[kogg:kernel:<component>]` prefix. Events include only safe codes, lifecycle
state, duration buckets/counts, and opaque project/task/run/attempt/worktree/
operation/process/evidence/verdict correlation IDs. Never log request parameters,
method-specific evidence fields, repository paths, Git refs/remotes, command or
environment details, prompts, source, diffs, personal data, or credentials.

Existing `kernel.health` and `kernel.journal` checks remain. #104 should specify
new catalog entries for protocol/capability closure, schema fingerprints,
operation reconciliation, evidence-binding integrity, and residual processes.
Checks must be bounded, read-only, redacted, independently runnable, and return
actionable stable reason codes. They must not start governed work, repair or
truncate the journal, fetch external attestations, or disclose evidence.

Required metrics are bounded counts/durations by operation family and safe
terminal/refusal code: active requests, timeouts, reconciliation outcomes,
evidence admissions/refusals, gate PASS/FAIL/refusal, cleanup failures, and
possible residuals. Labels never contain identities, paths, claims, branches,
commits, commands, or provider/model values.

TypeScript and Python sources must remain debuggable. Browser/backend/Electron
bundles retain source maps; the adapter and pinned Ranex source are present at
the recorded provenance. Debugger proof must set breakpoints across the TypeScript
bridge and Python dispatch/admission path without logging or retaining content.

## Security and maintenance implications

The JSONL adapter is a privileged local protocol, not a security boundary by
itself. The backend must cap line length, nesting, collections, pending requests,
and response time; validate exact fields and primitive ranges; reject NaN/large
integers/ambiguous Unicode; use an empty-by-default child environment; verify
vendored provenance/manifests before spawn; and never interpolate protocol data
into a shell command.

The journal, operation database, repository, and worktree have different
integrity/retention owners. Cross-store updates use durable intent plus exact
idempotency/reconciliation; they are not a distributed transaction and never
roll back an already appended Ranex fact. Database deletion, project removal, or
task archival cannot delete evidence referenced by a verdict.

Ranex upgrades require an explicit vendor/provenance change, protocol/schema
compatibility review, cross-language fixtures, migration/replay tests, negative
evidence tests, diagnostics, and three-OS application CI plus qualified-Linux
real execution. An older historical verdict stays bound to its original Ranex
provenance. It is not rewritten by an upgrade.

## Real human-level E2E requirements

#106 must prove the full boundary through the real browser/Electron UI and real
backend/Ranex/Git/filesystem/process paths on a disposable repository. Mocks,
component-only assertions, database inserts, raw adapter calls, or screenshots
without independent oracles do not satisfy the gate.

The positive scenario must:

1. create and approve a frozen task revision through the UI;
2. bind it to a disposable repository and qualified Linux execution target;
3. dispatch a real producer that creates a small observable commit;
4. run a real independently owned deterministic suite;
5. admit evidence and evaluate Ranex through the production bridge;
6. show the exact safe bindings and current PASS in the UI;
7. independently verify Git commit/tree/worktree state, process inventory,
   journal integrity, evidence/verdict binding, diagnostics, and source maps; and
8. cancel/close and prove zero residual Kogg-owned processes.

Negative controls mutate exactly one binding at a time: task revision, approval,
base/subject commit, repository/worktree, producer, suite manifest, check result,
executable/toolchain, evidence set, journal byte, Ranex provenance, and verdict
freshness. Each must refuse before merge with a stable safe UI state and
diagnostic/log correlation, while retaining no secret/content artifact.

Crash tests kill the backend or bridge before dispatch, during check execution,
after process exit but before evidence admission, after journal append but before
Kogg acknowledgement, and after verdict before merge authorization. Restart must
either recover the unique immutable result or remain explicitly blocked; it must
never duplicate evidence, rerun an unknown side effect, or reuse a stale PASS.

CI retains three-OS application coverage for protocol/source-map/diagnostic and
degraded-host behavior. Governed execution and confinement success are qualified
on Linux; macOS/Windows must visibly refuse or remain degraded rather than
pretending equivalent containment.

## Rejected approaches

- Treating the current `COMMANDS` array as implemented capability discovery.
- Forwarding arbitrary Ranex CLI methods, flags, JSON, shell commands, or journal
  queries through the application protocol.
- Accepting agent/provider assertions, exit zero, logs, screenshots, UI state,
  branch names, or file existence as evidence.
- Trusting a signature, transparency-log inclusion, or hash-chain validity
  without exact semantic, subject, producer, and freshness policy checks.
- Selecting the latest PASS by task name, branch, repository owner, or timestamp.
- Letting the frontend construct evidence, evaluate policy, or authorize merge.
- Copying Ranex evidence into the operations database or making Ranex store Kogg
  UI/task/workflow lifecycle state.
- Blindly retrying after timeout/lost response or overwriting conflicting
  idempotency results.
- Logging protocol payloads, exception messages, commands, paths, check streams,
  raw journal entries, or evidence bodies for debugging.
- Using a remote transparency/workflow service as a prerequisite for local V1.
- Allowing production merge because tests passed before the subject changed.

## Decision-complete kernel/evidence contract and pseudocode

This section is normative for #105 and #106. `MUST` and `MUST NOT` are release
gates. Illustrative pseudocode fixes behavior and ownership even where production
names later follow repository conventions.

### Closed protocol and operation catalog

The public boundary is length-prefixed canonical JSON over private stdio, not a
shell or generic Ranex RPC. Protocol name is `kogg.ranex/v2`; the pinned Ranex
provenance remains commit `5586d68b0936f554759022caabe847087f1d03ef`, tree
`581ce66c54116d4be48b96c3a0359fbdd9d3077f`. Handshake and every request bind
that provenance, the adapter artifact SHA-256, schema-set SHA-256, and one Kogg
process registration identity.

The only V1 application operations are:

| Operation | Version | Mutation | Required diagnostic |
| --- | --- | --- | --- |
| `kernel.handshake` | 2 | no | `kernel.protocol` |
| `kernel.health` | 1 | no | `kernel.bridge` |
| `task.bind` | 1 | append | `kernel.bindings` |
| `producer.dispatch` | 1 | append/process | `kernel.producers` |
| `suite.freeze` | 1 | append | `kernel.suites` |
| `suite.execute` | 1 | append/process | `kernel.checks` |
| `evidence.admit` | 1 | append | `kernel.evidence` |
| `gate.evaluate` | 1 | append | `kernel.verdicts` |
| `verdict.read` | 1 | no | `kernel.verdicts` |
| `operation.reconcile` | 1 | append-if-needed | `kernel.recovery` |
| `operation.cancel` | 1 | append/process | `kernel.cleanup` |

Controlled merge remains owned by #107–#111 and is intentionally absent. The
adapter MUST delete the old advertised placeholders (`run`, `run-suite`,
`add-dependency`, `add-public-key`, `dispatch-role`, `run-judge`, `merge`,
`delegate`, and `fanout`) unless a listed operation implements their required
behavior. Capability discovery returns only the table above with schema digests,
payload limits, and host qualification. Unknown operations fail before dispatch.

```text
record KernelEnvelopeV2 {
  protocol = "kogg.ranex/v2"
  requestId: uuid
  operationId: uuid
  idempotencyKey: sha256
  operation: closed operation name
  operationVersion: integer
  ranexCommit: exact 40-hex
  schemaSetDigest: sha256
  bodyDigest: sha256
  body: operation-specific closed record
}

record KernelResultV2 {
  protocol = "kogg.ranex/v2"
  requestId: same uuid
  operationId: same uuid
  status: "succeeded" | "refused" | "unknown"
  safeCode: closed code
  resultDigest: sha256-or-null
  journal: JournalPositionV1-or-null
  projection: operation-specific safe projection-or-null
}
```

Frames are UTF-8, canonical JSON, maximum 1 MiB, maximum depth 32, maximum 4,096
members, and have no duplicate keys, floats, non-NFC strings, unknown fields,
unpaired Unicode, or noncanonical integers. At most 64 requests and 4 MiB of
responses may be pending. The bridge pauses reads under backpressure. Raw
requests, responses, stderr, evidence, and exceptions are never logged.

### Canonical bytes and fixture authority

`canonical-v1(value)` is RFC 8785-style JSON constrained further to the types
above: UTF-8 NFC strings, lexicographically sorted keys by Unicode scalar value,
base-10 integers in the signed 64-bit range, lowercase fixed-length hex digests,
RFC 3339 UTC timestamps with millisecond precision, and no null unless the
schema explicitly permits it. Digest domains prevent cross-record substitution:

```text
digest(domain, value) = sha256(
  utf8("kogg:" + domain + ":v1\n") || canonical-v1(value)
)
```

Domains are exactly `task-binding`, `authority`, `repository-state`,
`producer`, `suite`, `check-definition`, `check-execution`, `evidence-manifest`,
`evidence-set`, `gate-catalog`, `verdict`, `ranex-provenance`, and
`idempotency`. Git object ids remain Git's native object ids and include object
format (`sha1` or `sha256`); they are never reinterpreted as Kogg digests.

#105 produces checked-in golden fixtures for empty/minimum/maximum records,
Unicode normalization, key ordering, line endings, timestamp precision, every
digest domain, Git SHA-1 and SHA-256 repositories, and every rejection. The same
bytes and digests MUST be independently produced by TypeScript, Python, and a
third simple fixture verifier. One-bit mutations MUST fail.

### Immutable binding records

```text
record TaskExecutionBindingV1 {
  taskId: uuid
  taskRevision: integer
  specificationDigest: sha256
  approvalId: uuid
  approvalDigest: sha256
  authorityDigest: sha256
  projectId: uuid
  repositoryId: uuid
  repositoryIdentityDigest: sha256
  protectedSource: RepositoryStateV1
  worktreeId: uuid
  worktreeIdentityDigest: sha256
  baseState: RepositoryStateV1
  executionProfileDigest: sha256
  expiresAt: RFC3339
}

record RepositoryStateV1 {
  objectFormat: "sha1" | "sha256"
  commitObjectId: exact native object id
  treeObjectId: exact native object id
  gitCommonDirectoryIdentity: opaque digest
  worktreeIdentity: opaque digest
  indexDigest: sha256
  trackedContentDigest: sha256
  untrackedPolicyDigest: sha256
  isClean: boolean
}

record ProducerBindingV1 {
  producerId: uuid
  producerRole: "implementation"
  adapterId: closed adapter id
  adapterArtifactDigest: sha256
  provider: closed provider id
  model: exact model id
  attemptId: uuid
  taskBindingDigest: sha256
  authorityDigest: sha256
  executionProfileDigest: sha256
}

record FrozenSuiteV1 {
  suiteId: uuid
  suiteRevision: integer
  manifestDigest: sha256
  taskBindingDigest: sha256
  subjectPolicy: "exact-commit"
  checks: sorted nonempty CheckDefinitionV1[]
  gateCatalogDigest: sha256
  verifierAuthorityDigest: sha256
}

record CheckDefinitionV1 {
  checkId: stable closed id
  kind: "build" | "unit" | "integration" | "visible-e2e" |
        "observability" | "diagnostics" | "source-maps" |
        "process-cleanup" | "ranex-evidence"
  executableArtifactDigest: sha256
  argvTemplateDigest: sha256
  environmentProfileDigest: sha256
  timeoutMs: bounded integer
  outputPolicyDigest: sha256
  requiredProducerSeparation: boolean
}
```

Paths and commands may be used by the execution owner but are not fields in
these evidence-facing records. An approval is current only when authenticated,
unrevoked, unexpired, and exact for the task revision/specification/repository/
authority. `task.bind` recomputes all digests and Git facts from owned stores and
the filesystem. It never trusts frontend projections.

```text
record CheckExecutionV1 {
  executionId: uuid
  suiteDigest: sha256
  checkDefinitionDigest: sha256
  subjectState: RepositoryStateV1
  verifierId: uuid
  verifierRole: "verification"
  verifierArtifactDigest: sha256
  processRegistrationId: uuid
  executionProfileDigest: sha256
  startedAt: RFC3339
  finishedAt: RFC3339
  outcome: "pass" | "fail" | "cancelled" | "timeout" | "infrastructure"
  exitClass: "zero" | "nonzero" | "signal" | "none"
  resultArtifactDigest: sha256
  cleanupProofDigest: sha256
}

record EvidenceManifestV1 {
  evidenceId: uuid
  claimType: exact gate claim type
  subjectStateDigest: sha256
  taskBindingDigest: sha256
  producerBindingDigest: sha256
  suiteDigest: sha256
  checkDefinitionDigest: sha256
  checkExecutionDigest: sha256
  resultArtifactDigest: sha256
  authorityDigest: sha256
  ranexProvenanceDigest: sha256
  createdAt: RFC3339
}

record VerdictBindingV1 {
  verdictId: uuid
  taskBindingDigest: sha256
  subjectStateDigest: sha256
  gateCatalogDigest: sha256
  evidenceSetDigest: sha256
  authorityDigest: sha256
  ranexProvenanceDigest: sha256
  journalRootDigest: sha256
  journalSequence: integer
  decision: "pass" | "fail" | "blocked"
  evaluatedAt: RFC3339
}
```

Result artifacts contain bounded structured check facts, not captured source,
stdout, stderr, prompts, or provider output. Raw execution streams are volatile
and discarded after the authorized UI consumer and failure classifier finish.

### Roles, admission, applicability, and freshness

The controller may authorize work but cannot produce evidence. An
`implementation` producer may mutate its private worktree but cannot freeze the
suite, verify its own separated checks, admit evidence, evaluate gates, or issue
a verdict. A `verification` identity cannot share producer attempt, adapter
process, provider session, credential grant, or writable worktree. Ranex alone
admits evidence and evaluates the gate catalog. Kogg only requests and projects.

```text
admitEvidence(expected, candidate):
  verify current Ranex provenance, journal integrity, and schema digest
  load immutable binding/suite/execution by exact digest
  recompute current Git subject state independently
  require candidate fields equal expected fields byte-for-byte
  require execution outcome == pass and cleanup proof == zero residuals
  require verifier separation where definition says true
  require approval and authority current at execution and admission
  require no existing evidence for idempotency key with different digest
  append canonical evidence to Ranex journal
  return journal position + evidence digest; never return raw body to UI
```

Evidence applies only if every bound digest equals the gate's independently
computed expected digest. Each required claim selects exactly one admitted,
nonsuperseded evidence item. Zero, multiple, conflicting, unknown, partially
decoded, future-schema, failed, cancelled, or infrastructure results block.

```text
evaluateGate(expected):
  verify journal from trusted root through current sequence
  recompute task/approval/authority/repository/subject/suite/catalog/provenance
  select the complete evidence set by exact claim and binding
  reject duplicates, conflicts, gaps, producer violations, or stale timestamps
  compute evidenceSetDigest from sorted evidence digests
  evaluate closed policy without frontend/provider input
  append VerdictBindingV1 and return safe projection
```

Any change to task revision, specification, approval, authority, repository
identity, base/subject commit or tree, index/tracked state, worktree, producer,
adapter/provider/model, execution profile, suite/check/toolchain, result,
evidence set, gate catalog, Ranex artifact/schema, or verified journal root makes
the previous evidence/verdict inapplicable. Historical PASS remains immutable
and visible as stale; it is never rewritten or promoted to the new subject.

### Idempotency and cross-store commit points

The idempotency key is `digest("idempotency", {operation, version, immutable
input digests})`. Client-selected UUIDs are correlation only. Repeating the same
key and bytes returns the original safe result/journal position. The same key
with different bytes yields `KERNEL_IDEMPOTENCY_CONFLICT`.

```text
mutatingOperation(request):
  validate protocol, bounds, authority, bindings, and current host state
  create Kogg intent PREPARED with request/body/idempotency digests
  dispatch exact Ranex operation once
  Ranex transaction checks idempotency, appends fact + hash-chain entry, commits
  receive fact digest + journal position
  independently read and verify committed entry
  mark Kogg intent ACKNOWLEDGED with safe projection
```

The Ranex append is the evidence commit point. A lost acknowledgement after it
is an `UNKNOWN` Kogg outcome, never permission to repeat side effects blindly.
`operation.reconcile` queries only by exact idempotency/body/provenance digests,
verifies the returned journal entry, then acknowledges the unique fact. No
entry means the operation may be retried only if it has no external mutation;
producer dispatch and check execution instead require process/repository
reconciliation and usually a fresh authorized attempt. Multiple/conflicting
entries yield `KERNEL_JOURNAL_AMBIGUOUS` and block admission.

Kogg's operations database stores intent, safe lifecycle, correlations, and the
verified Ranex digest/position only. It does not copy evidence/verdict bodies.
SQLite transaction boundaries never claim to roll back Git, processes, or the
Ranex journal.

### Process ownership, cancellation, and recovery

Kogg registers the bridge and every producer/check process before start through
the operations supervisor. Ranex owns governed process/evidence facts; the
qualified execution owner supplies cgroup/pidfd identity and zero-descendant
proof. One operation has one durable state machine:

```text
REQUESTED -> VALIDATING -> PREPARED -> PROCESS_REGISTERED -> RUNNING
RUNNING -> RESULT_OBSERVED -> JOURNAL_COMMITTED -> VERIFYING -> ACKNOWLEDGED
any nonterminal -> CANCELLING -> CLEANING -> CANCELLED | FAILED | QUARANTINED
PREPARED|RUNNING|RESULT_OBSERVED|JOURNAL_COMMITTED -> UNKNOWN -> RECONCILING
RECONCILING -> ACKNOWLEDGED | FAILED | QUARANTINED
```

`RESULT_OBSERVED` and process exit are not evidence. `ACKNOWLEDGED` requires
journal verification and cleanup proof. Absolute, idle, protocol, and cleanup
deadlines are frozen in the request. Cancellation stops admission, revokes
credentials, closes stdin, asks the governed owner to interrupt, sends TERM then
KILL to the registered cgroup, drains bounded pipes, verifies zero descendants,
and records the safe terminal result. Evidence already committed remains in the
journal but may be inapplicable; it is never deleted.

On backend startup, admission is disabled until the operation store and Ranex
journal verify. A single recovery lease scans all nonterminal intents, reconciles
process identities and exact journal idempotency entries, kills residual owned
processes, verifies Git state, and chooses the unique valid state transition.
Unknown process identity, journal corruption, duplicate fact, or residual child
quarantines the operation and repository. Recovery never reruns a producer or
check with uncertain side effects.

### Closed failures, logs, metrics, and safe UI projection

The V1 safe codes are:

```text
KERNEL_OK                       KERNEL_PROTOCOL_MISMATCH
KERNEL_PROTOCOL_INVALID         KERNEL_PROTOCOL_OVERFLOW
KERNEL_CAPABILITY_UNAVAILABLE   KERNEL_PROVENANCE_MISMATCH
KERNEL_AUTHORITY_INVALID        KERNEL_TASK_BINDING_MISMATCH
KERNEL_REPOSITORY_MISMATCH      KERNEL_SUBJECT_STALE
KERNEL_PRODUCER_INVALID         KERNEL_ROLE_SEPARATION_FAILED
KERNEL_SUITE_MISMATCH           KERNEL_CHECK_FAILED
KERNEL_CHECK_TIMEOUT            KERNEL_CHECK_INFRASTRUCTURE
KERNEL_EVIDENCE_INVALID         KERNEL_EVIDENCE_MISSING
KERNEL_EVIDENCE_DUPLICATE       KERNEL_EVIDENCE_CONFLICT
KERNEL_EVIDENCE_STALE           KERNEL_GATE_INCOMPLETE
KERNEL_VERDICT_STALE            KERNEL_IDEMPOTENCY_CONFLICT
KERNEL_JOURNAL_INTEGRITY        KERNEL_JOURNAL_AMBIGUOUS
KERNEL_OUTCOME_UNKNOWN          KERNEL_CANCELLED
KERNEL_CLEANUP_FAILED           KERNEL_RESIDUAL_PROCESS
KERNEL_BACKEND_RESTARTED        KERNEL_INTERNAL
```

Unknown Python/Node/Git/provider errors map to `KERNEL_INTERNAL`; raw strings are
discarded. Loggers are `kogg:kernel:bridge`, `kogg:kernel:binding`,
`kogg:kernel:producer`, `kogg:kernel:checks`, `kogg:kernel:evidence`,
`kogg:kernel:verdict`, and `kogg:kernel:recovery`. Events are closed:

```text
request.received|validated|refused
process.registered|spawn.started|started|exit|cleanup.started|cleanup.completed
binding.started|completed|failed
producer.started|activity|completed|failed
suite.freeze.started|completed|failed
check.started|activity|completed|failed|timeout
evidence.admit.started|committed|verified|failed
gate.evaluate.started|completed|blocked|failed
operation.cancel.started|completed
recovery.started|reconciled|quarantined|completed|failed
```

Fields are restricted to timestamp, logger/event, request/operation/process/task
correlation UUIDs, operation kind/version, lifecycle state, safe code, bounded
duration/counts, boolean outcome, and non-content digests. Never log paths,
commands/arguments, environments, credentials, prompts, code, diffs, captured
streams, raw protocol/evidence/journal/provider bodies, personal data, or raw
errors. Metrics use operation/check kind, terminal class, safe code, and bounded
duration buckets only; UUIDs and digests are not metric labels.

The UI may show task revision number, repository display reference supplied by
the project registry, abbreviated subject id, producer/verifier roles, named
check kinds, safe status/code, journal sequence, evidence count, verdict, and
stale reason category. It cannot render raw evidence or treat a displayed PASS
as merge authority. Every action revalidates backend facts.

### Diagnostic and debugger contract

#106 adds these exact catalog ids:

| Diagnostic id | Fail-closed check |
| --- | --- |
| `kernel.protocol` | handshake, schema set, operation closure, frame fixtures |
| `kernel.bridge` | artifact provenance, process registration, bounded transport |
| `kernel.bindings` | task/approval/authority/repository cross-record integrity |
| `kernel.producers` | producer identity, role, attempt, process ownership |
| `kernel.suites` | frozen manifest/catalog/check-definition integrity |
| `kernel.checks` | execution binding, deadlines, cleanup proof |
| `kernel.evidence` | admission semantics, idempotency, exact applicability |
| `kernel.verdicts` | complete evidence set, freshness, journal/root binding |
| `kernel.cleanup` | cancellation escalation and zero descendants |
| `kernel.recovery` | intent chain, lease, unknown-outcome reconciliation |
| `kernel.source-maps` | browser/backend/Electron bridge debugger reachability |

Diagnostics return only id, status, safe code, provenance/schema/profile
digests, bounded counts/durations, and remediation id. Every operational file
declares the matching `diagnostic-coverage` id. Failure tests cover absent and
throwing contributors so diagnostics cannot report false health.

Source maps remain enabled. Debugger proof sets breakpoints in browser task
action, backend validation, TypeScript bridge send/decode, Python dispatch,
process registration/cleanup, evidence admission, gate evaluation, and startup
reconciliation. The real Python source is mapped and reachable; no generated or
opaque layer may hide a lifecycle boundary.

### #105 probe and #106 visible E2E handoff

#105 uses the real pinned Ranex adapter, SQLite journal, Git repositories,
registered subprocesses, and cross-language canonical fixtures. Its primary
scenario loses the Kogg acknowledgement immediately after one real evidence
append, restarts, reconciles by exact idempotency digest, returns the unique fact,
evaluates the gate once, and proves zero residual processes. It fault-injects
every state transition and independently mutates each binding listed above.

The probe additionally covers partial/oversized/duplicate/out-of-order frames,
stderr flood, backpressure, bridge/check crash, hung and escaped child, TERM/KILL,
journal byte corruption, duplicate/conflicting idempotency rows, Git state races,
approval revocation, producer/verifier collision, stale subject, Ranex provenance
mismatch, store contention, and restart at every commit point. Expected outcome
is a closed safe code, durable lifecycle, no false PASS, no duplicate side
effect, no content leakage, and externally proven cleanup.

#106 visible browser and Electron E2E MUST:

1. create, freeze, approve, and repository-bind a task through production UI;
2. dispatch a real producer in a qualified private worktree;
3. freeze and run a real independent deterministic suite;
4. admit exact evidence and display a current Ranex PASS projection;
5. independently verify Git objects, journal chain, bindings, verdict, and
   external process inventory;
6. mutate each critical binding one at a time and visibly refuse stale/false
   evidence before any merge path;
7. cancel a hanging check and restart after a lost acknowledgement;
8. inspect diagnostics/support export and exercise debugger/source-map points;
9. scan browser/backend/Electron/Python logs and exports for seeded prompt,
   source, diff, path, command, environment, credential, stream, and provider
   canaries; and
10. pass `yarn test`, `yarn audit:observability`, three-OS degraded/application
    CI, qualified-Linux execution, real Ranex evidence, and zero-residual gates.

Expected success trace is request validation, process registration/start,
producer/check activity, process exit/cleanup, evidence committed/verified, gate
completed, and safe acknowledgement. Cancellation and recovery use their named
events and end with cleanup proof. Missing lifecycle events are test failures.

No implementation choice remains for #105: operation names, schemas, digest
domains, bindings, role rules, applicability, idempotency, commit points, process
states, recovery, safe codes/logs, diagnostics, fault seams, and visible E2E are
fixed. A real probe incompatibility blocks production rather than weakening the
evidence contract.

## Research and pseudocode gate verdict

- Commit-pinned sources and licenses: recorded.
- Rejected approaches: recorded.
- Processes, logs, diagnostics, failure/recovery, security, maintenance, and E2E
  risks: explicit.
- Decision-complete schemas and operation closure: fixed above for #105.

The highest-risk assumption for #105 remains that one exact evidence admission can
remain idempotent and correctly bound across a real check process, Git subject
observation, Ranex journal append, lost Kogg acknowledgement, backend restart,
and subsequent gate evaluation without accepting a stale/mismatched claim or
creating a residual process. That boundary—not a mocked evaluator—is the probe.
