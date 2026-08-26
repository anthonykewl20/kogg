# Controlled merge real-Git boundary probe

Disposable issue #110 probe; it must remain on its prototype branch and must
not merge as production merge code.

```sh
yarn setup
volta run --node 22.23.2 node --inspect=0 prototypes/verdict-merge/probe.mjs
```

The probe uses the production operation registry to supervise every invocation
of the installed native Git executable. In a disposable non-bare repository it
constructs divergent commits with plumbing commands, obtains a clean merge tree,
creates the fixed two-parent commit, and updates one destination ref through an
expected-old compare-and-swap. It independently verifies the result and proves
that the worktree and index remain untouched. It also exercises conflict and
stale-ref refusal without fallback or a second mutation attempt.

Observed on 2026-08-27 with Apple Git 2.54.0 (`Apple Git-156`), executable
SHA-256 `09b2e76b4a77c930755f0cf689babfe2b5f713b047636a6d264764567b395819`.
The successful run registered and cleaned 30 Git processes, reached the Node
debugger, and ended with zero active operations, residuals, or cleanup failures.
The repository suite then passed 41/41 tests, the branding audit, and all 62
observability checks.
