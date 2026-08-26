# Execution boundary probe

Disposable prototype for issue #82. It must not merge as production execution
code. Run on a host with Docker Desktop and the pinned local image:

```sh
docker pull --platform linux/amd64 alpine/git:2.49.1
yarn setup
volta run --node 22.23.2 node prototypes/execution-boundary/probe.mjs
```

The probe first proves that a linked Git worktree can mutate common source
metadata. It then creates a non-shared private clone, executes useful Git mutation
inside a networkless Linux/amd64 container with no source mount, imports one exact
candidate into a quarantine ref, and proves the source checkout and active refs
were not changed. Docker is a measured boundary, not V1 qualification; findings
must record every missing Linux qualification primitive.
