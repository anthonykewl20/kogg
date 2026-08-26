# Ranex kernel/evidence compatibility prototype findings

Tracking: [#105](https://github.com/anthonykewl20/kogg/issues/105), parent
[#102](https://github.com/anthonykewl20/kogg/issues/102), and production
[#106](https://github.com/anthonykewl20/kogg/issues/106).

## Verdict

The real pinned Ranex adapter cannot execute the #104 evidence contract. It
successfully starts, negotiates its legacy `kogg-ranex-stdio` protocol v1, and
shuts down cleanly, but the normative boundary is length-prefixed
`kogg.ranex/v2`. Nine of the 11 required operation names are absent from the
legacy capability list. The two overlapping names, `suite.freeze` and
`gate.evaluate`, are advertised but rejected by the dispatcher, along with nine
other advertised application commands. A direct `task.bind` request also
refuses, and the untouched journal remains missing.

The correct measured outcome is `KERNEL_CAPABILITY_UNAVAILABLE` with no protocol
or command fallback. The primary lost-ack evidence scenario cannot begin because
the adapter has no real task binding, suite execution, evidence admission,
idempotency reconciliation, or v2 gate operation. This validates the packet's
warning against advertised fiction and blocks #106 from reusing the current
bridge as an evidence authority. #106 must implement and qualify the closed v2
surface before any PASS, evidence, or verdict projection is available.

The disposable probe MUST NOT merge as production. It is preserved on
`prototype/issue-105-kernel-evidence` at commit
`b0391529a171caa7deb310f8ebf0cc8032f0687d`. Only these findings and the packet
status correction are intended for the production branch.

## Reproduction and observed evidence

The probe ran on macOS arm64 with Node 22.23.2, the repository's provisioned
Python 3.12 environment, vendored Ranex commit
`5586d68b0936f554759022caabe847087f1d03ef`, and the real
`kogg_ranex_adapter.py` process.

```sh
git switch prototype/issue-105-kernel-evidence
yarn setup
volta run --node 22.23.2 node --inspect=0 prototypes/kernel-evidence/probe.mjs
volta run --node 22.23.2 yarn test
```

Observed on 2026-08-27:

- the Ranex kernel process was registered before spawn as a `ranex-kernel`
  resource owned by Ranex, then visibly started and became ready;
- the real handshake returned protocol version 1, the exact pinned Ranex commit,
  12 advertised command strings, and degraded confinement on macOS;
- literal capability comparison found 9 of the 11 required v2 operation names
  absent, while the protocol/version and result schemas were also incompatible;
- every advertised application command except the implemented journal read—11
  commands total—returned the adapter's bounded `ValueError` refusal;
- `task.bind`, the first required evidence mutation, also returned a bounded
  refusal and did not create the SQLite journal;
- `journal.verify` independently reported `{valid: false, reason: "missing"}`;
- the explicit shutdown response was followed by process exit class `zero`,
  process cleanup, operation cleanup, and a terminal failed/refused projection;
- final diagnostics reported zero active operations, residuals, and cleanup
  failures;
- the safe trace contained only opaque correlations, counts, coarse classes,
  operation names, and safe codes—not protocol frames, errors, paths, arguments,
  environments, prompts, source, diffs, credentials, evidence, or journal rows;
  and
- `yarn test` passed 41/41, branding passed, and the mandatory observability
  audit passed with 62 production operational files inspected.

`--inspect=0` supplied debugger proof for the retained JavaScript probe. The
real Python adapter source was directly reachable, and the repository build
retained TypeScript source maps. The disposable probe declares a specific
diagnostic exemption and uses the production operation-registry diagnostics;
production #106 still owns the exact kernel catalog additions.

## Safe lifecycle trace

The asserted path was:

```text
ranex-request requested/started -> process.registered ->
process.spawn.started -> process.started -> protocol.v1.ready ->
capability.v2.refused(missingCount=9, fallback=false) ->
advertised.commands.refused(refusedCount=11) ->
evidence.operation.refused(task.bind, journalMutation=false) ->
journal.verify(missing) -> shutdown accepted -> process.exit(zero) ->
process.cleanup.completed -> operation.cleanup.completed ->
operation.failed -> cleanup.completed(processCount=0) ->
qualification.refused(KERNEL_CAPABILITY_UNAVAILABLE, protocol=v2)
```

The zero process exit is deliberately not treated as evidence, a successful
kernel operation, or cleanup proof by itself. Qualification remains refused
until process cleanup and zero-residual diagnostics complete.

## Decisions validated

- Capability discovery must describe callable application behavior, not names
  copied from an internal or future command list.
- A compatible Ranex commit does not compensate for a protocol, schema, or
  operation mismatch. Provenance and behavior are independent gates.
- The bridge must refuse before journal mutation when the exact operation is
  absent; translating `task.bind` to a nearby legacy method would invent
  authority and lose binding semantics.
- Legacy `evaluate`, raw evidence construction, `verdict.list`, and generic
  JSON-lines dispatch cannot be adapted into the v2 contract by projection.
- Real process start/readiness/refusal/exit/cleanup can remain fully observable
  without retaining raw frames or Python error messages.
- No false PASS or evidence was created: process readiness, clean exit, and an
  empty/missing journal remain non-evidence states.
- The normative v2 topology does not need weakening. Its implementation gap is
  exactly what production #106 must close.

## Reopened implementation requirements

#106 must first replace the current adapter boundary with the complete closed
v2 contract before attempting the primary evidence scenario:

- length-prefixed canonical JSON frames, exact envelope/result schemas, payload,
  nesting, member, queue, and backpressure limits, duplicate-key rejection, and
  no raw response/error propagation;
- capabilities generated only from implemented handlers for all 11 exact
  operations, with old placeholder names removed;
- cross-language canonical fixtures for every digest domain, Unicode/key/time
  edge, Git SHA-1/SHA-256 repository, maximum record, and one-bit mutation;
- immutable task, authority, repository, producer, suite, check execution,
  evidence, evidence-set, gate, verdict, and Ranex provenance bindings;
- real independently observed Git/check processes with producer/verifier role
  separation, result and cleanup proof, and no content-bearing evidence fields;
- atomic Ranex idempotency and journal commit points, exact read-back
  verification, lost-ack unknown outcome, restart fencing, unique reconciliation,
  and conflict/ambiguity quarantine;
- stale subject, approval revocation, mismatched producer/check/suite, failed or
  partial evidence, duplicate/conflicting rows, and journal corruption refusals;
- qualified Linux process/cgroup ownership, deadlines, TERM/KILL escalation,
  crash/hang/stderr/overflow/residual injection, backend recovery, and zero
  descendants; and
- all 11 diagnostic catalog checks, safe lifecycle loggers, failure tests,
  browser/backend/Electron/Python debugger proof, and real visible E2E.

Only after that surface exists may qualification run the packet's primary
scenario: one real check and evidence append, lost Kogg acknowledgement, backend
restart, reconciliation by the exact idempotency/body/provenance digests, unique
journal fact verification, one gate evaluation, and zero residual processes.
Until then the production capability catalog must omit the unavailable evidence
operations and return `KERNEL_CAPABILITY_UNAVAILABLE`; it must never expose the
legacy advertised command list as implemented Kogg behavior.
