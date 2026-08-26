# Controlled merge real-Git boundary prototype findings

Tracking: [#110](https://github.com/anthonykewl20/kogg/issues/110), parent
[#107](https://github.com/anthonykewl20/kogg/issues/107), and production
[#111](https://github.com/anthonykewl20/kogg/issues/111).

## Verdict and production decision

The prototype validates the central native-Git construction and mutation design
in #109. Qualified Git plumbing can create the fixed two-parent merge commit from
exact objects without checking out either branch, then update exactly one local
destination ref with expected-old compare-and-swap. A stale expected old object
and a content conflict both refused without changing that ref. No worktree file
or index was created.

#111 MUST retain isolated plumbing, exact object verification, a fixed identity
and message, and one expected-old `update-ref`. It MUST NOT use porcelain merge,
the user index/worktree, force, a retry after an ambiguous CAS, or a conflict
fallback. This probe does not qualify the installed Git artifact, repository
configuration/ref backend, human authorization, Ranex verdict currentness,
durable intent/recovery, cancellation during CAS, or cross-platform behavior;
those remain production gates.

Experimental code is preserved off the merge path on
`prototype/issue-110-verdict-merge` at
`18d582d796e17548b363e04eba6e835a52bf878d`. It MUST NOT ship.

## Reproduction and evidence

The run used macOS, Node 22.23.2, the production Kogg operation registry, and
Apple Git 2.54.0 (`Apple Git-156`) at executable SHA-256
`09b2e76b4a77c930755f0cf689babfe2b5f713b047636a6d264764567b395819`.

```sh
git switch prototype/issue-110-verdict-merge
yarn setup
volta run --node 22.23.2 node --inspect=0 prototypes/verdict-merge/probe.mjs
volta run --node 22.23.2 yarn test
```

Observed on 2026-08-27:

- exact blob, tree, and commit objects formed divergent base, destination, and
  subject histories in a disposable non-bare repository;
- `merge-tree --write-tree` returned one clean tree, and `commit-tree` created a
  commit with exact ordered destination/subject parents, the fixed Kogg identity,
  fixed UTC time, and fixed `Kogg controlled merge` message;
- independent native `cat-file` verification matched tree, parents, identity,
  timestamp, and message before mutation;
- expected-old `update-ref` changed only `refs/heads/destination`, and an
  independent read matched the expected merge object;
- a second update with the stale pre-merge expected object exited nonzero, left
  the committed ref unchanged, and was not retried or widened;
- divergent edits to the same path made `merge-tree` exit nonzero, while the
  destination remained unchanged and no alternative merge method ran;
- all 30 Git invocations registered before spawn and exposed start, readiness,
  exit class, and cleanup through the production operation registry;
- diagnostics ended with zero active operations, residual processes, or cleanup
  failures, and the worktree inventory/index stayed unchanged;
- the probe was reached through the Node inspector and its safe trace excluded
  prohibited prompt, source, diff, path, argument, environment, credential,
  authorization, and raw-body content; and
- `yarn test` passed 41/41, the branding audit passed, and the observability audit
  passed with 62 production operational files inspected.

This is measured macOS evidence for one installed Git binary, not an artifact or
platform qualification claim.

## Lifecycle and design validated

Every real Git invocation crossed the production process lifecycle:

```text
operation.requested -> operation.started -> process.registered ->
process.spawn.started -> process.started -> process.ready -> process.exit ->
process.cleanup.completed -> operation.completed
```

The prototype added bounded safe milestones for construction verification, CAS
start/commit/refusal, conflict refusal, and cleanup. These disclosed only
correlations, counts, safe codes, version, an abbreviated approved artifact
digest, and boolean outcomes—never repository paths, arguments, Git streams,
object contents, personal identity, or evidence/verdict bodies.

The following #109 choices are now backed by real behavior:

- native merge plumbing works without the user worktree/index;
- exact ordered-parent and result-tree verification is available before CAS;
- `update-ref <ref> <new> <expected-old>` supplies the required atomic drift
  refusal for one exact ref;
- merge conflicts are visible before ref mutation;
- stale CAS and conflict can fail closed without a different merge strategy; and
- Git subprocesses fit Kogg's registered lifecycle and cleanup accounting.

## Qualification gaps and #111 gates

#111 still must implement and test:

- pinned Git discovery, digest/version/feature qualification on every supported
  platform and explicit refusal for unqualified object/ref backends;
- repository identity/config/attributes, hooks/helpers/filters, replace/graft,
  shallow/promisor/alternate, submodule, lock, writer, and object-format checks;
- exact Ranex PASS projection and journal provenance plus independent binding and
  currentness comparison immediately before mutation;
- first-party human challenge/authorization, identity separation, expiry,
  revocation, one-time consumption, and replay/conflict resistance;
- durable intent/event state, fsync boundaries, cancellation around CAS, restart
  reconciliation from exact old/new/third refs, and quarantine;
- bounded stdin/stdout/stderr and timeout/TERM/KILL plus external descendant and
  temporary-state cleanup proof for every failure path;
- SHA-1/SHA-256 and malformed/oversized object/output fixtures where separately
  qualified, plus the complete stale/conflict/crash/lock/cleanup fault matrix;
- catalog-backed diagnostics, safe failure tests and canary scans, source maps
  and debugger reachability, and real browser/Electron human-level E2E.

These gaps do not reopen the plumbing/CAS design. They prevent this disposable
macOS run from becoming production merge authority.
