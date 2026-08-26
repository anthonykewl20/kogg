# Issue #67 operation-supervisor prototype

Disposable probe for the decision in
`docs/v1/governed-task-loop/observability.md`. It exercises the real bundled
Ranex stdio adapter, a durable SQLite logical-process record committed before
spawn, Theia `ProcessManager` live ownership, success and spawn-failure lifecycle
traces, a real stalled request followed by bounded cancellation and stream
drain, crash/restart recovery with an empty work queue, stale process-identity
refusal, cleanup/residual checks, and Node/Python source-level debugger access.

Run with the pinned workspace runtime:

```sh
volta run --node 22.23.2 --yarn 1.22.22 node prototypes/operation-supervisor/probe.mjs
```

The probe creates only disposable state under the OS temporary directory. It
prints safe event names, opaque IDs, enums, and counts; paths, argv, environment,
protocol bodies, source, prompts, and process output are asserted absent.

## Measured boundary

The same probe passes on the pinned Node 22.23.2 runtime on macOS 26.6 and in a
Debian Bookworm Linux container. Linux uses boot ID plus `/proc/<pid>/stat`
start time as the durable fingerprint and treats zombie state as exited. macOS
uses the process start timestamp and therefore demonstrates only degraded local
ownership, not qualified governed execution.

Windows is intentionally not claimed by this disposable prototype: the design
has no qualified portable process-group containment and post-restart identity
proof there. Production must fail closed for governed child execution on
Windows until a responsible owner supplies both capabilities; it must not fall
back to PID-only signalling.
