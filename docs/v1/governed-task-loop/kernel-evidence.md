# Ranex task operations and evidence binding

Tracking: [#102](https://github.com/anthonykewl20/kogg/issues/102), research
phase [#103](https://github.com/anthonykewl20/kogg/issues/103).

## Status

Research is complete as of 2026-08-27. This packet contains no production code.
Decision-complete records and pseudocode belong to #104, the real-boundary
probe to #105, and production behavior plus real human-level E2E to #106.

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

## Inputs required for #104

#104 must close these decisions in schemas and pseudocode:

1. exact operation catalog, capability versions, request/result/refusal schemas,
   payload bounds, and method-to-dispatch/test/diagnostic closure;
2. canonical byte/digest domains and cross-TypeScript/Python/Git fixtures;
3. immutable task, approval, repository, run, producer, check, evidence, verdict,
   and Ranex-provenance binding records;
4. role separation and exact evidence applicability/freshness rules;
5. idempotency, journal/Kogg commit points, unknown-outcome reconciliation, and
   cancellation/cleanup state machines;
6. safe projection, logging event/code catalog, metrics, and diagnostic entries;
7. protocol hardening, environment/confinement, retention, upgrade, and backward-
   compatibility rules; and
8. real E2E fixtures, independent oracles, negative mutations, crash points, and
   debugger/source-map proof.

## Research gate verdict

- Commit-pinned sources and licenses: recorded.
- Rejected approaches: recorded.
- Processes, logs, diagnostics, failure/recovery, security, maintenance, and E2E
  risks: explicit.
- Findings support decision-complete pseudocode: yes, subject to the exact
  canonical schemas and operation closure in #104.

The highest-risk assumption for #105 is that one exact evidence admission can
remain idempotent and correctly bound across a real check process, Git subject
observation, Ranex journal append, lost Kogg acknowledgement, backend restart,
and subsequent gate evaluation without accepting a stale/mismatched claim or
creating a residual process. That boundary—not a mocked evaluator—is the probe.
