# Projects registry real-boundary probe

Disposable prototype for Kogg issue #66. It tests the design chosen in
`docs/v1/governed-task-loop/projects.md`; it is not production code.

Run with the repository-pinned Node runtime:

```sh
volta run --node 22.23.2 node prototypes/projects-registry/probe.mjs
```

Run the SQLite API in Electron's embedded Node runtime:

```sh
ELECTRON_RUN_AS_NODE=1 /path/to/electron prototypes/projects-registry/electron-runtime.cjs
```

The probe uses a real local Git repository, fixed `git rev-parse` invocation,
SQLite rollback journaling, competing writers, forced `SIGKILL` before and after
commit, bounded subprocess output, timeout/process-group cleanup, and an allowlist
for safe trace fields. Temporary repositories and databases are removed afterward.
