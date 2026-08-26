# Operations read-model real-boundary prototype findings

Tracking: [#115](https://github.com/anthonykewl20/kogg/issues/115), parent
[#112](https://github.com/anthonykewl20/kogg/issues/112), and production
[#116](https://github.com/anthonykewl20/kogg/issues/116).

## Verdict and production decision

The prototype validates #114's core ownership and projection rules. Immutable
safe owner events can produce retry/process/timeline state in a disposable
SQLite read model, and deleting every derived table then replaying the owner log
reproduces the exact projection digest. A terminal owner event did not project a
clean terminal run while its real child remained exited-but-unclean; the run
stayed visibly `cleaning` until process cleanup and external absence were proven.

#116 MUST keep operations disposable and derived, preserve every attempt, and
require owner cleanup facts before clean completion. It MUST NOT become a second
scheduler/process/task/evidence/verdict/merge authority, repair conflicts by
timestamp, optimistically apply actions, or infer cleanup from process exit.

Experimental code is preserved off the merge path on
`prototype/issue-115-operations` at
`cf441929ac7fefc6227eb5a7ef624b1c0fae2460`. It MUST NOT ship.

## Reproduction and measured evidence

The run used macOS, Node 22.23.2 and its built-in SQLite, the production Kogg
operation registry, the installed native Git, and a real Node child.

```sh
git switch prototype/issue-115-operations
yarn setup
volta run --node 22.23.2 node --inspect=0 prototypes/operations-read-model/probe.mjs
volta run --node 22.23.2 yarn test
```

Observed on 2026-08-27:

- 15 digest-chained safe owner events represented one run, two distinct
  attempts, one retry, two processes, cancellation, and cleanup;
- the first real Git process exited nonzero and remained as a visible failed
  attempt after the second attempt started;
- the second real child remained live until cancellation, exited by signal, and
  was absent from external process inventory after cleanup;
- a terminal cancelled owner fact projected `cleaning`, with one abnormal
  process, while that process was exited but not cleaned;
- after the cleanup fact, the run projected cancelled with two attempts, one
  retry, and zero abnormal/live processes;
- duplicate sequence/same digest ingestion was idempotent; a different digest at
  that sequence was classified `OWNER_SEQUENCE_CONFLICT` without cursor advance;
- dropping all derived run, attempt, and process tables and replaying the owner
  log yielded the exact prior projection digest and no duplicate terminal fact;
- the closed metric projection preserved one failed attempt, one cancelled
  attempt, one retry, and zero active processes with no dynamic labels;
- both real processes registered before spawn and exposed start, exit class, and
  cleanup; diagnostics ended with zero active operations, residuals, and cleanup
  failures;
- Node debugger reachability was exercised, and the safe trace excluded paths,
  prompts, source, diffs, commands, environments, credentials, authorization,
  and raw bodies; and
- the repository suite passed 41/41, branding passed, and observability passed
  with 62 production operational files inspected immediately before the probe.

This is a bounded owner-log/process/SQLite experiment, not a production schema,
stream, user interface, or platform qualification.

## Design choices validated

The experiment backs these normative decisions:

- authoritative append-only facts and a disposable projection can be separated;
- `(owner, epoch, sequence, digest)` supports idempotent replay and exact
  same-sequence conflict refusal;
- retry lineage must retain failed attempts rather than replacing them with the
  latest attempt state;
- process registration, exit, and cleanup are independently meaningful facts;
- a terminal owner fact plus abnormal process state must derive `cleaning`, not
  a clean success/cancellation state;
- projection deletion/rebuild can be verified by deterministic digest without
  changing owner facts; and
- bounded low-cardinality metrics can derive from the same accepted safe facts
  without identifiers or content as labels.

## Qualification gaps and #116 gates

#116 still must implement the complete contract, including:

- compiled-in adapters and closed schemas for task, workflow, adapter, execution,
  operation, project, check, Ranex, verdict, merge, and diagnostics owners;
- signed/verified snapshots, owner availability, epoch/schema change, cursor
  gap/rewind, previous-digest mismatch, missing causal parent, and cycle handling;
- durable SQLite migrations/integrity/event-chain/cursor transactions, rebuild
  leases, crash atomicity, retention/holds, and projection corruption recovery;
- deterministic causal topological timeline ordering and protected-event
  coalescing rules across owner streams;
- authenticated pagination and streaming, resume/resync/backpressure limits,
  reconnect and stale-cursor behavior;
- backend revalidated action routing and idempotency, bulk limits, unknown result
  reconciliation, and no optimistic projection mutation;
- authoritative external descendant inventory on qualified platforms, all
  abnormal classifications, resource observations, and quarantine;
- safe file/check/evidence/verdict/merge/usage projections without copying raw
  owner content, plus bounded metric epochs and retention;
- private bounded support export, catalog-backed diagnostics, canary/failure
  tests, source maps/debugger proof, and real browser/Electron accessible E2E;
- the 10,000-entry virtualization and complete fault matrix required by #114.

These gaps do not reopen the authority/read-model or terminal-cleanup rule. They
prevent the prototype from being mistaken for the production operations system.
