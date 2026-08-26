# Evidence, verdict, and controlled-merge experience

Tracking: [#107](https://github.com/anthonykewl20/kogg/issues/107), research
phase [#108](https://github.com/anthonykewl20/kogg/issues/108), and pseudocode
phase [#109](https://github.com/anthonykewl20/kogg/issues/109). The normative
contract is in [`verdict-merge-pseudocode.md`](verdict-merge-pseudocode.md).

## Status

Research and decision-complete pseudocode are complete as of 2026-08-27. These
packets contain no production code. #110 must probe the fixed contract at real
Ranex/Git/store/process boundaries, followed by production behavior plus real
human-level E2E in #111.

The recommendation is an evidence-first experience that explains a Ranex
PASS/FAIL/BLOCKED projection without re-evaluating it, continuously revalidates
its exact subject and authority, and permits one explicit human-controlled merge
only through a backend-owned compare-and-swap transaction. A displayed PASS,
green check, signed fact, journal entry, provider completion, agent request, or
button click is never merge authority by itself.

The merge owner must bind the human authorization to one immutable task revision,
repository, base commit, subject commit/tree, evidence set, gate catalog, Ranex
verdict and journal position, protected destination ref, merge policy, and short
expiry. Immediately before mutation it independently verifies all bindings and
ref state. It creates the merge result without executing repository hooks, then
updates only the expected destination ref atomically. Any drift, stale verdict,
identity collision, ambiguous outcome, or cleanup failure refuses or quarantines;
agents cannot approve, authorize, enqueue, retry, or reconcile their own merge.

## Scope and non-negotiable invariants

V1 must show what was required, what evidence was admitted, why each gate passed,
failed, or blocked, whether the verdict is current, what changed when it became
stale, and exactly what one human is authorizing. It must not expose raw evidence
bodies or pretend that Kogg is the verdict authority.

- Ranex is the sole authority for admitted evidence, gate evaluation, verdict,
  journal integrity, and verdict provenance.
- Kogg independently computes expected task, repository, Git, policy, and
  authority bindings and compares them to the Ranex projection.
- One current PASS for the exact subject is necessary but not sufficient; an
  explicit authenticated human authorization and final backend preflight are
  separately mandatory.
- Producer, verifier, approver, merge authorizer, merge executor, and evidence/
  verdict authority have distinct identities and grants. An agent is never the
  merge authorizer.
- Authorization is allow-once, short-lived, non-transferable, bound to exact
  bytes, and consumed atomically. It cannot be widened or reused after refusal,
  drift, restart, or success.
- Destination ref changes use expected-old-object compare-and-swap. No force,
  wildcard ref, tag, alternate namespace, additional ref, or remote push is
  permitted in local V1.
- Merge construction is deterministic from exact base/subject/policy and runs no
  hooks, editor, signing helper, credential helper, filters, attributes command,
  or ambient Git configuration.
- A successful Git process exit is an observation. Success additionally requires
  independent destination-ref/object verification, durable lifecycle commit,
  evidence/verdict freshness, and zero residual process proof.
- Unknown outcomes are reconciled from exact repository facts; they are never
  blindly retried.
- Logs, diagnostics, errors, support bundles, and metrics never contain prompts,
  source, diffs, commit messages, author/committer personal data, paths, command
  arguments, environments, credentials, raw evidence/journal/verdict bodies, or
  provider/API responses.

## Commit-pinned source ledger

Sources provide patterns only. Reuse requires separate dependency, license,
security, and maintenance approval. Research inspected exact revisions rather
than mutable default-branch semantics.

| Source | Exact revision and license | Reviewed paths | Security and maintenance result |
| --- | --- | --- | --- |
| [Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25); MIT | governed-execution evidence, gate, verdict, approval, merge/reconciliation, journal, confinement, observability code/tests/ADRs; Kogg `kogg_ranex_adapter.py` | Select Ranex as evidence/verdict authority and preserve exact binding, hash-chain, producer separation, currentness, controlled operation, watchdog, and recovery semantics. Do not let Kogg rewrite facts, synthesize PASS, or query arbitrary journal content. |
| [Git](https://github.com/git/git/tree/f78ce2f7b6df702f93d40b85d6bda92a3f65da79) | commit `f78ce2f7b6df702f93d40b85d6bda92a3f65da79` (2026-08-25); GPL-2.0-only | `builtin/merge-tree.c`, `builtin/merge.c`, `builtin/update-ref.c`, `refs.c`, `t/t4301-merge-tree-write-tree.sh`, refs/merge tests and documentation | Use plumbing behavior as the semantic oracle: exact objects, merge-base/tree calculation, conflict refusal, and expected-old ref transactions. Invoke the installed qualified Git rather than linking/copying GPL implementation. Disable hooks/config/helpers and independently verify resulting objects/ref. |
| [GitHub CLI](https://github.com/cli/cli/tree/606cda4a9b1a703ad7c2e353a77bce0d93d21b0e) | commit `606cda4a9b1a703ad7c2e353a77bce0d93d21b0e` (2026-08-26); MIT | `pkg/cmd/pr/checks`, `pkg/cmd/pr/merge`, `pkg/cmd/attestation/artifact`, `verification`, tests/fixtures | Preserve explicit required-check aggregation, pending/failure display, expected head selection, merge-method policy, digest calculation, trusted-root and identity constraints. Reject GitHub PR state as local evidence authority and reject auto-merge/remote API mutation for V1. |
| [in-toto](https://github.com/in-toto/in-toto/tree/a8ce9ee2125ae5a4b041a4e37cc1cf10eed0da6b) | commit `a8ce9ee2125ae5a4b041a4e37cc1cf10eed0da6b` (2026-05-19); Apache-2.0 | `in_toto/models/layout.py`, `link.py`, `metadata.py`, `verifylib.py`, verification/threshold/artifact-rule tests | Preserve owner policy versus functionary evidence, authorized identity, threshold, expiration, materials/products, ordered verification, and explicit failure explanation. A signature or matching step name alone does not establish applicability or merge authority. |
| [gitsign](https://github.com/sigstore/gitsign/tree/034927d0ea301bd64ae1dad562da164faf979ed1) | commit `034927d0ea301bd64ae1dad562da164faf979ed1` (2026-08-05); Apache-2.0 | `internal/commands/verify`, `verify-tag`, `pkg/git/verify.go`, `internal/cert/verify.go`, Rekor/TUF paths and tests | Preserve caller-supplied expected certificate/issuer/workflow/repository/commit claims and verification against raw Git semantics. The 2026 malformed-object verification advisory demonstrates that cryptographic success can disagree with Git object interpretation; Kogg must use native Git object identity and exact pinned verifier behavior. No Sigstore dependency is selected for local V1. |
| [Eclipse Theia](https://github.com/eclipse-theia/theia/tree/647dd3c7091b25ef3fc735edb74b949e7a195754) | v1.74.1 commit `647dd3c7091b25ef3fc735edb74b949e7a195754` (2026-08-06); EPL-2.0 or GPL-2.0-only with Classpath Exception, with identified MIT/VS Code material | SCM/Git contribution, dirty-diff/change views, command enablement, progress/status bar, dialogs, timeline/tree accessibility and tests | Reuse contribution/presentation seams and native Git status refresh patterns. Reject frontend command enablement, dialog acceptance, visible clean state, or generic SCM provider state as security authority. The backend revalidates everything. |

Hosted GitHub protected-branch/check and Sigstore guidance was reviewed as
corroboration. It is mutable and does not replace the pinned code, Ranex journal,
native Git object checks, or Kogg's local policy. GitHub-hosted rules are outside
the local-first V1 trust boundary.

## Existing Kogg and Ranex boundary

Kogg already owns authenticated browser/Electron sessions, projects and exact
repository binding, immutable task specifications and approvals, supervised
operations/processes, diagnostics/support projection, and a pinned Ranex bridge.
The current Ranex adapter can handshake, report health/capabilities, verify its
journal, evaluate a gate, and list safe records. Research for #103/#104 fixes a
closed future evidence protocol; this slice consumes only its exact verdict
projection and never reaches around it into SQLite.

Missing behavior for this slice includes:

- a typed explanation model joining required gates to exact admitted evidence;
- independent currentness comparison against task, authority, subject, suite,
  catalog, Ranex provenance, and journal state;
- a durable human merge-authorization record and consumption state machine;
- deterministic local merge construction and exact destination-ref CAS;
- preflight/recovery that can distinguish not-started, committed, conflicted,
  stale, and genuinely unknown outcomes;
- visible refusal/explanation, safe logs, diagnostic catalog checks, source-map
  proof, and real browser/Electron E2E; and
- strict identity separation preventing an agent/provider/process from creating
  or using human merge authority.

The generic operations registry can supervise Git/Ranex processes and safe
lifecycle, but it is not a verdict store or merge policy authority. The task and
project databases are inputs, not evidence. The frontend is a projection.

## Evidence and verdict explanation findings

The UI should derive a bounded explanation tree from a backend verification
result, never from raw Ranex records. Each gate row needs stable gate id/version,
required/optional status, result (`pass`, `fail`, `blocked`, `stale`), safe reason,
producer and verifier roles, abbreviated subject/evidence digests, journal
sequence, and currentness timestamp. Expansion may show safe binding comparisons
and remediation identifiers. It must not show source paths, captured streams,
commands, raw evidence, personal identities, or secret/provider content.

PASS means every required gate selected exactly one applicable current evidence
item and the exact Ranex verdict/journal verified. FAIL means a required claim
was validly evaluated and failed. BLOCKED means evaluation cannot establish a
valid result because evidence is missing, conflicting, invalid, infrastructure-
failed, authority-invalid, or journal/provenance state is unsafe. STALE is a UI
currentness state: an immutable historical verdict no longer matches the current
subject or authority. Kogg must not translate BLOCKED/STALE into FAIL or choose
the latest favorable record.

An explanation should answer:

1. What exact task/specification and subject commit/tree were evaluated?
2. Which gate catalog and Ranex provenance/journal root were used?
3. Which exact evidence item satisfied or failed each required claim?
4. Were producer/verifier/approver roles separate and authorized?
5. Is every bound task, approval, authority, repository, subject, suite, evidence,
   catalog, and journal fact still current now?
6. If merge is refused, which closed category changed and what safe remediation
   creates a fresh verdict?

The explanation view is not an evidence export. Support bundles include only
safe codes, bounded counts, non-content digests, diagnostic statuses, and
correlations.

## Human authorization and identity separation findings

The explicit human gesture must occur after the explanation is rendered current
and immediately before final preflight. Authentication alone is insufficient;
authorization binds the authenticated interactive session, approver role,
task/specification, exact base/subject, evidence set, verdict, destination ref,
merge policy, expiry, and a UI challenge digest that summarizes those safe facts.

The person must actively confirm in a modal that names the destination, merge
method, abbreviated exact commits, current verdict, and consequences. No default
focus on the destructive action, keyboard shortcut, provider/tool invocation,
background auto-confirm, stored blanket approval, or API token standing in for
the gesture. Session change, expiry, window loss, task/repository drift, or any
preflight change invalidates the authorization and requires a new one.

Agent/provider roles can propose completion and navigate to the explanation but
cannot invoke the authorization endpoint, synthesize its challenge response,
own its session proof, or receive its consumable token. The merge executor is a
backend service identity limited to one local ref transaction. Producer and
verifier identities cannot be merge authorizer or executor. Ranex remains an
independent evidence/verdict authority and does not consume the human UI token.

## Git merge construction and atomicity findings

V1 should support one repository-local merge method selected by #109 after the
real Git probe: likely a deterministic no-ff merge commit built from exact
parents/tree and Kogg-owned fixed metadata, or a fast-forward-only ref move when
policy explicitly requires it. Squash/rebase rewrite subject identity and add
more content/metadata choices; remote PR merge adds network/auth/host policy.
They should remain out unless separately specified and probed.

Final preflight must use the repository registry identity and an isolated Git
environment. It resolves destination ref and subject using native object ids,
verifies object types/reachability, checks expected old destination/base, checks
worktree/common-dir identity, computes merge base/result tree, refuses conflicts,
revalidates Ranex PASS against exact subject/evidence/journal, and verifies no
active writer or incompatible task authority.

Construction must not run `git merge` in a user's checkout because it can read
ambient config, run hooks, open an editor, update multiple state files, or leave
an in-progress merge. Prefer plumbing in an owned temporary index/repository
view, explicit object ids, disabled optional locks where safe, empty environment,
and `git update-ref` expected-old CAS. The exact commands, input encoding,
metadata policy, locks, and cleanup belong to #109 pseudocode and #110 real probe.

After CAS, Kogg independently reads the destination ref and commit/tree/parents,
verifies the expected result, verifies source/private worktree invariants, and
persists a safe completion correlated to the consumed authorization. It never
force-updates, deletes, creates extra refs, pushes, or falls back to another
method. A CAS conflict is safe refusal, not an automatic retry.

## Lifecycle, failure, and restart findings

Research requires distinct durable boundaries:

```text
verdict request -> Ranex verification -> explanation current/stale/refused
authorization challenge -> human decision -> authorization recorded/expired
merge intent -> final preflight -> process registered -> construction
result observed -> ref CAS -> post-verify -> cleanup -> terminal
```

Failure classes include invalid/missing/conflicting/stale evidence; FAIL/BLOCKED
verdict; Ranex artifact/schema/journal mismatch; task approval or authority
revocation; repository/worktree/object/ref drift; merge conflict; unsupported
object format/policy; authorizer/session/role/expiry mismatch; consumed or
duplicate authorization; process spawn/timeout/crash; malformed Git output;
lock contention; CAS conflict; backend crash; store corruption; and residual
process/temp/index/lock state.

Before the ref transaction, cancellation must revoke authorization, terminate
registered processes, clean owned temporary state, and prove the destination is
unchanged. During the tiny CAS critical section, cancellation records intent but
must reconcile the ref/object result before terminal classification. After a
verified CAS, cancellation cannot undo history; it finishes post-verification
and reports the merge committed.

Restart recovery obtains a single lease, verifies Kogg stores and the Ranex
journal, revokes expired/unused authorizations, inventories processes, and
reconciles every merge intent against exact destination old/new refs and expected
objects. Exact old ref means not committed; exact expected new ref and valid
result means committed; any other ref or ambiguous object state quarantines.
Recovery never repeats construction/CAS without a fresh human authorization.

Merge-related processes must register before start, use bounded stdin/stdout/
stderr, absolute/idle/cleanup deadlines, TERM/KILL escalation, and external
zero-descendant proof. Git hooks, signing programs, credential helpers, filters,
remote helpers, editors, pagers, and arbitrary subprocesses are prohibited; any
unexpected descendant fails qualification.

## Observability and diagnostic risks

Candidate loggers are `kogg:verdict:service`, `kogg:verdict:currentness`,
`kogg:merge:authorization`, `kogg:merge:preflight`, `kogg:merge:process`, and
`kogg:merge:recovery`. Required boundaries are request, verification start/
completion/refusal, explanation projection, challenge created, authorization
recorded/refused/expired/consumed, preflight start/completion/refusal, process
registration/start/exit/cleanup, CAS start/result, post-verification, cancellation,
recovery, quarantine, and terminal completion/failure.

Safe fields are correlation ids, lifecycle state, closed gate/operation kind,
safe code, boolean outcome, bounded counts/durations, journal sequence, and
non-content digests. Commit/object digests can be shown only in bounded safe
projections and must not be metric labels. Personal identities use opaque role/
session correlations, never names/emails. Raw Git/Ranex errors and captured
streams are discarded after safe classification.

Candidate diagnostic catalog ids for #109 to finalize:

- `verdict.provenance`: pinned Ranex artifact/protocol/schema and journal trust;
- `verdict.bindings`: exact task/repository/subject/evidence/catalog bindings;
- `verdict.currentness`: recomputation and safe stale classification;
- `verdict.explanation`: complete closed gate projection without raw evidence;
- `merge.authorization`: session/role/challenge/expiry/consumption integrity;
- `merge.preflight`: Git object/ref/policy/current-verdict checks;
- `merge.processes`: registration, environment, descendants, and deadlines;
- `merge.atomicity`: construction, expected-old CAS, and post-verification;
- `merge.recovery`: intents, leases, exact-ref reconciliation, quarantine;
- `merge.source-maps`: browser/backend/Electron/bridge debugger reachability.

A missing/throwing diagnostic contributor must fail the combined status.
Production files need matching `diagnostic-coverage`. Canary tests must prove
that prompt, source, diff, path, command, environment, credential, commit-message,
personal identity, Git stream, evidence, journal, and provider bodies never reach
logs, diagnostics, support exports, metrics, or error strings.

## Security and maintenance findings

- Native Git is the object/ref semantic authority; parsers that normalize raw
  objects can disagree on malformed commits. Verify object ids/types and enable
  strict fsck/probe fixtures rather than trusting third-party decoded structs.
- Signatures establish key possession over bytes only when trusted roots,
  expected identity/claims, semantics, freshness, and subject are all verified.
- A public transparency log may expose identity/repository metadata and adds
  network/root/availability dependencies. It is not required for local V1.
- Git config is executable policy: hooks, filters, signing, credential helpers,
  aliases, pager/editor, attributes, and remote helpers must be replaced by an
  explicit allowlisted environment/config projection.
- Lock files and ref transactions need crash probing across filesystems. A stale
  lock must not be deleted merely by age; ownership and live process identity
  must be reconciled.
- Hash algorithm, ref backend, and repository extension support must be probed
  and closed. Unknown extensions/object formats refuse rather than degrade.
- Ranex and Git upgrades require explicit provenance changes, golden fixtures,
  negative evidence/currentness/CAS tests, debugger/source maps, three-OS
  degraded application CI, and qualified real merge E2E.
- Historical verdict/authorization/merge records retain their original schema,
  Git, Ranex, policy, and artifact provenance. They are never rewritten as current.

## Real-boundary prototype and visible E2E requirements

#110 must use the real pinned Ranex bridge/journal, native qualified Git, SQLite
stores, process supervisor, task/project bindings, and disposable repositories.
The principal probe obtains one exact current PASS, records a human-test
authorization, constructs a deterministic merge, loses acknowledgement around
the expected-old ref CAS, restarts, and reconciles exactly one committed result
without a second authorization or ref update.

Fault injection must cover every boundary before/after Ranex verification,
challenge, authorization commit/consume, preflight, construction, CAS,
post-verification, cleanup, and terminal record. One-at-a-time mutations cover
task/spec approval, authority, repository/worktree identity, base/subject commit
and tree, evidence set, gate catalog, journal byte/root/sequence, Ranex provenance,
destination ref, merge policy, authorizer/session/expiry, object type/reachability,
config/hook/helper attempt, process crash/hang/stderr flood, lock contention,
concurrent ref writer, malformed object, residual child, and store corruption.

#111 real browser/Electron E2E must visibly:

1. complete a governed task with independent checks and real Ranex evidence;
2. open the explanation and show each required gate plus current PASS bindings;
3. provoke FAIL, BLOCKED, and STALE states with safe explanations;
4. require an authenticated human confirmation of exact destination and commits;
5. perform one controlled local merge through the production backend;
6. independently verify ref, commit tree/parents, task/project state, Ranex
   verdict/journal, authorization consumption, diagnostics, and zero processes;
7. cancel before CAS and restart around CAS without false refusal or double merge;
8. attempt agent self-approval/self-merge, replayed authorization, stale PASS,
   destination drift, conflict, hook/helper execution, and direct RPC bypass;
9. inspect source maps/debugger breakpoints and safe support projection; and
10. scan all browser/backend/Electron/Python/Git-adjacent logs and exports for
    prohibited-content canaries.

Expected success trace crosses verdict verification/currentness, explanation,
human authorization, preflight, registered construction, CAS, post-verification,
cleanup, and terminal boundaries. Refusal, cancellation, and recovery have their
own complete safe traces. Missing events, hidden processes, mocks of owned
boundaries, direct service-only tests, or screenshot-only assertions fail.

## Rejected approaches

| Candidate | Decision |
| --- | --- |
| Let an agent call merge after it reports completion | Reject; provider output is neither evidence, verdict, nor human authorization. |
| Treat a green UI/check badge as authority | Reject; projections can be stale or forged and omit exact bindings. |
| Re-evaluate or edit Ranex evidence in Kogg | Reject; creates contradictory verdict authority. |
| Select the latest PASS by task, branch, timestamp, or repository name | Reject; require exact immutable subject/evidence/catalog/journal bindings. |
| Use one identity for producer, verifier, approver, and merger | Reject; defeats separation and enables self-approval. |
| Store blanket or reusable merge approval | Reject; authorization is allow-once and exact-subject bound. |
| Rely on disabled UI buttons or client-generated challenges | Reject; backend validates and owns authority. |
| Run `git merge` in the user's checkout | Reject; ambient config/hooks/editor and partial merge state escape ownership. |
| Force update, retry CAS, or merge a moving destination | Reject; drift requires fresh verdict and human authorization. |
| Auto-merge when checks become green | Reject in V1; explicit human action must follow current explanation. |
| Delegate local merge to GitHub PR API | Reject; adds remote credential/rules/state authority and violates local-first scope. |
| Accept commit signature/transparency inclusion alone | Reject; identity, semantics, subject, policy, freshness, and current verdict remain necessary. |
| Persist raw evidence, Git output, diff, or commit metadata for debugging | Reject; use safe correlations/codes/digests and independent object verification. |
| Roll back a committed ref on cancellation | Reject; recovery reports the proven result; compensating history mutation needs separate authority. |
| Delete stale locks by timestamp | Reject; reconcile owner/process/repository identity before safe cleanup. |

## Decisions fixed by #109

The normative pseudocode packet fixes the typed explanation/currentness schemas;
human challenge and allow-once authorization; identity/role proof; the supported
merge method and exact Git plumbing/config/environment; merge intent, CAS,
post-verification, cancellation and restart state machines; canonical digests and
fixtures; safe failures/events/log fields; diagnostic ids; retention/quarantine;
and every #110 fault seam and #111 visible E2E trace.

The highest-risk assumption is that a backend crash immediately around the
destination-ref compare-and-swap can be reconciled uniquely without retrying,
reverting, accepting drift, or consuming another human authorization. The second
is completely suppressing ambient Git configuration and executable helpers while
constructing and verifying the intended merge across supported repositories.
#109 must name exact mechanisms and #110 must probe both.

## Research gate conclusion

- Public sources are commit-pinned with exact reviewed paths, dates, licenses,
  security/maintenance implications, patterns, and reuse boundaries.
- Evidence explanation, currentness, human authorization, Git atomicity,
  cancellation, failure, recovery, identity separation, process ownership,
  observability, diagnostics, and real E2E risks are explicit.
- Rejections prevent self-approval/self-merge, UI/provider authority, stale PASS,
  ambient checkout/config, force/retry, remote dependency, and raw-data logging.
- Findings are sufficient for #109 to write decision-complete pseudocode without
  reopening the evidence/Ranex/Git ownership topology.

Production remains blocked until #109, #110, and #111 complete in order and all
observability, diagnostics, debugger/source maps, real human-level E2E, current
Ranex verdict, explicit authorization, atomic merge, recovery, and zero-residual-
process gates pass.
