# Operations read-model real-boundary probe

Disposable issue #115 probe; it must stay on its prototype branch and must not
merge as production operations code.

```sh
yarn setup
volta run --node 22.23.2 node --inspect=0 prototypes/operations-read-model/probe.mjs
```

The probe combines immutable safe owner events, a disposable SQLite projection,
the production operation registry, a real failing Git process, and a real hung
Node child that is cancelled and externally checked. It proves retry lineage,
the rule that terminal owner state cannot hide an unclean process, idempotent
replay, conflict refusal, deletion/rebuild equality, and bounded metrics without
copying raw process or owner content.

Observed on 2026-08-27 with Node 22.23.2. Fifteen chained owner events
projected two attempts and one retry. The real Git failure and cancelled hung
child both completed registered start/exit/cleanup lifecycles; the child was
absent from external process inventory afterward. Rebuilding after deleting all
derived tables reproduced the exact projection digest, and operation diagnostics
ended with zero active operations, residuals, or cleanup failures. The current
repository suite had passed 41/41 tests plus branding and all 62 observability
checks immediately before this probe.
