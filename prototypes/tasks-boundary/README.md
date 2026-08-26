# Governed tasks real-boundary probe

Disposable prototype for Kogg issue #80. It validates the decisions in
`docs/v1/governed-task-loop/tasks.md`; none of this directory is production code.

Run after repository setup with the pinned runtime:

```sh
volta run --node 22.23.2 node prototypes/tasks-boundary/probe.mjs
```

The probe uses exact UTF-8/JCS/SHA-256 bytes in Node, Python, and Electron; a real
SQLite WAL registry; two real Chromium clients using visible edit/freeze/review/
approve/revoke controls; competing writers; idempotency replay/mismatch; forced
`SIGKILL` before and after commit; corrupted-copy diagnostics; Node/Electron
inspector reachability; safe lifecycle traces; and process/residual cleanup.
The prototype CI step runs on macOS and qualified Linux; Windows skips this
POSIX-signal probe while retaining the repository's normal verification matrix.

All task content stays in a private temporary directory and explicit UI/service
payloads. Trace fields are allowlisted and scanned for content, paths, digests,
review challenges, and process arguments before the probe succeeds.
