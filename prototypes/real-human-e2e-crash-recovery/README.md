# Issue #65 native crash/recovery prototype

Disposable probe for the highest-risk boundary fixed by
`docs/v1/governed-task-loop/real-human-e2e.md`. It launches the production
Electron entrypoint against an isolated real Git repository, starts the local
deterministic provider fixture, observes the production Ranex process through the
visible Operations panel, kills only the harness-owned Electron top-level, and
relaunches through the normal entrypoint.

On qualified Linux, the probe must see the same short operation correlation
recover in the UI, admission return to enabled, a replacement Ranex bridge become
active, and every pre-crash process identity disappear. The measured prototype
instead found that the registered Ranex child is reconciled while Electron/Theia
backend and plugin-host descendants remain alive outside the registry. It also
requires the visible `kernel.journal` failure to remain explicit: operation
reconciliation currently succeeds while process-tree cleanup and end-to-end
evidence integrity do not. Those findings block production #70 until top-level
child containment and journal recovery are repaired. On
macOS and Windows, the current production registry has no restart-qualified
native fingerprint. If the platform has already contained every product child's
lifetime, enabled admission and zero residuals are valid; otherwise the required
result is visible blocked admission, `PROCESS_IDENTITY_UNVERIFIED`, failing
diagnostics, and an explicit nonzero product-residual count. The branch-only
disposal safety net removes those exact captured identities only after any
failed-closed result is recorded; that cleanup is not an acceptable production
fallback.

The probe also proves that a deliberately mismatched live identity is never
signalled, attaches the Chromium debugger to a branch-only renderer marker,
attaches Node's inspector while loading the mapped production operation registry,
pauses Python `pdb` in the real Ranex adapter, and retains only a denylist-scanned
safe manifest.

Build Electron first, then run with the pinned workspace runtime:

```sh
volta run --node 22.23.2 --yarn 1.22.22 yarn build:electron
volta run --node 22.23.2 --yarn 1.22.22 node prototypes/real-human-e2e-crash-recovery/probe.mjs
```

The probe creates disposable state only under the OS temporary directory. It
prints closed event names, enums, counts, and opaque IDs; paths, argv, environment,
provider bodies, credentials, source, and process output are excluded.

## Production decision under test

Keep the existing boot-ID plus `/proc` process identity and reconciliation path
for qualified Linux, but contain Electron/Theia descendants and repair and prove
Ranex journal integrity across the crash before #70 can claim acceptance. Before the production harness may claim
crash recovery on macOS or Windows, #70 must also add a platform-native creation
identity or a contained lifetime that makes product descendants exit with the
application. PID-only signalling and converting blocked admission or failed
evidence into a passing capability are rejected.
