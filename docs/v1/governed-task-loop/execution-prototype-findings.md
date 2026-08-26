# Qualified execution and private Git boundary prototype findings

Tracking: [#82](https://github.com/anthonykewl20/kogg/issues/82), parent
[#73](https://github.com/anthonykewl20/kogg/issues/73), and production
[#85](https://github.com/anthonykewl20/kogg/issues/85).

## Verdict and production decision

The prototype validates the Git half of #79's highest-risk decision and directly
disproves linked worktrees as an isolation boundary. A real linked worktree
mutated repository-local configuration and a common ref that were immediately
visible from the source checkout. A bundle-seeded, non-local, non-hardlinked
private repository had no alternates or source path in local Git configuration,
supported ordinary edit/add/commit in a Linux/amd64 container with no source
mount or network, and imported one exact candidate into a quarantine ref without
changing source HEAD, active branch, index, or worktree.

The production decision is explicit: #85 MUST use the independent private
repository plus controller-owned quarantine design and MUST NOT use a linked
worktree or shared Git common directory. The container run is not V1 host
qualification. Docker Desktop/QEMU did not prove Landlock, pinned Bubblewrap/
seccomp/native launcher, delegated cgroup ownership, XFS project quota, Ranex
`kogg-writable-agent-v1`, broker, restart recovery, or qualified external
descendant inventory. #85 remains blocked from execution admission until all
exact Linux/amd64 facts are implemented and independently qualified. There is no
Docker fallback.

Experimental code is preserved off the merge path on
`prototype/issue-82-execution` at
`d503f9ab6636097d5dbe889653d76a3d2d02f8ea`. It MUST NOT ship.

## Reproduction and evidence

The run used macOS as controller host, Docker/Colima 29.5.2, an emulated
Linux/amd64 `alpine/git:2.49.1` image, Node 22.23.2, Git, and production Kogg
operation supervision.

```sh
docker pull --platform linux/amd64 alpine/git:2.49.1
git switch prototype/issue-82-execution
yarn setup
volta run --node 22.23.2 node prototypes/execution-boundary/probe.mjs
volta run --node 22.23.2 yarn test
```

Observed on 2026-08-27:

- linked-worktree config and ref mutations crossed into the source common Git
  directory, providing a measured red control;
- private seed verification found zero alternates, distinct object-directory
  inode identity, no retained source path in local config, and the exact base
  commit/tree;
- the Linux process reported `x86_64`, edited and committed normally, could not
  see `/source` or the host user directory, and could not reach the network;
- the container used network none, all capabilities dropped, no-new-privileges,
  PID/memory/CPU bounds, read-only root, bounded tmpfs, and only the private
  repository mounted read-write;
- a background child was created; container exit/removal left no container in the
  measured Docker inventory;
- controller import created one exact `refs/kogg/quarantine/*` ref matching the
  candidate commit/tree while source HEAD and status stayed unchanged;
- every Git and Docker process registered before spawn and exposed start, exit,
  cleanup; operation diagnostics ended with zero residual/cleanup failures;
- the safe trace excluded prohibited content/path/command/environment canaries;
  and
- `yarn test` passed 41/41, branding passed, and observability passed with 62
  production operational files inspected.

This is measured macOS-controller/Linux-container evidence only. It is not native
cross-platform or V1 qualification.

## Lifecycle and decisions validated

Every real controller command crossed:

```text
operation.requested -> operation.started -> process.registered ->
process.spawn.started -> process.started -> process.ready -> operation.active ->
process.exit -> process.cleanup.completed -> operation.completed|failed
```

Safe milestones were `linked-worktree.boundary.disproved`,
`private-seed.verified`, `linux-attempt.cleaned`, and
`candidate.import.verified`. They carried safe codes/counts and abbreviated
approved object facts, never paths, file names, command data, Git/container
output, credentials, prompts, code, or diffs.

The probe validates these #79 decisions:

- linked worktree uniqueness cannot protect source refs/config because `.git`
  reaches shared common metadata;
- bundle-seeded `--no-local --no-hardlinks` private Git supports useful mutation
  without alternates, shared objects, remote configuration, or a source mount;
- source protection and candidate usability are compatible when a separate
  controller imports an exact object closure under a quarantine namespace;
- candidate import needs exact base/candidate/tree and source-state verification;
  successful Git exit alone is insufficient;
- controller Git/execution processes fit Kogg's observable operation lifecycle;
  and
- cleanup requires an external inventory owner. Container disappearance proves
  only this Docker scope, not native descendants or qualification.

## Qualification gaps and #85 gates

The prototype deliberately does not claim:

- native qualified Linux/amd64 or the selected `kogg-writable-agent-v1` boundary;
- Landlock ABI/right enforcement, namespace construction proof, pinned
  Bubblewrap/seccomp/launcher descriptors, delegated cgroup fencing/kill/readback,
  XFS project byte/inode quota, or boot-bound qualification freshness;
- authenticated kernel-owned provider broker, endpoint/DNS/redirect bounds,
  opaque credential injection, or drift handling;
- production state-root descriptor, `openat2` resolution, allocation nonce,
  mount/device/project-id verification, descriptor-relative deletion and fsync;
- controller-death/reboot/lease recovery or the full malformed object, symlink,
  hardlink, alternate, filter, hook, double-fork, quota and deletion fault matrix;
- native external descendant inventory—Docker inventory is not a substitute; or
- macOS/Windows behavior beyond the required explicit unqualified-host refusal.

#85 must implement and test every missing boundary on qualified infrastructure,
including catalog-backed diagnostics, source maps/debugger proof, safe failure
tests, canary scans, real browser/Electron E2E, Ranex evidence/current verdict,
and zero residual processes. These gaps do not reopen the private-repository
decision; they prevent narrower Docker controls from being treated as production
qualification, evidence, verdict, or merge authority.
