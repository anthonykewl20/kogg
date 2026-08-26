# Qualified execution targets and isolated Git worktrees

Tracking: [#73](https://github.com/anthonykewl20/kogg/issues/73), research
phase [#76](https://github.com/anthonykewl20/kogg/issues/76).

## Status

Research is complete as of 2026-08-27. This packet contains no production code.
Decision-complete schemas and pseudocode belong to
[#79](https://github.com/anthonykewl20/kogg/issues/79), followed by a disposable
real-boundary probe in #82 and production implementation and E2E in #85.

The research recommendation is one controller-owned, private Git repository and
working tree per governed run, with one opaque run branch, seeded from the exact
approved source commit without shared writable Git metadata. The run never writes
the registered source repository or its checkout. It executes only on a currently
qualified Linux target inside a versioned confinement profile that makes the
source repository absent, exposes only the private run tree and bounded scratch as
writable, owns the complete process tree, and proves cleanup. A candidate returns
through a controller-owned quarantine/import boundary and cannot update a source
ref, worktree, remote, or merge target directly.

Git's linked-worktree feature is useful for trusted developer convenience but is
not a security boundary: linked worktrees share objects, most refs, configuration,
hooks, and administrative state through `$GIT_COMMON_DIR`. An untrusted process
that can use the linked worktree's `.git` pointer can mutate the source repository
even when the main checkout files are elsewhere. For governed V1, “one owned
worktree per run” therefore means one ordinary working tree backed by a private
run repository, not `git worktree add` against the registered source repository.

## Scope and non-negotiable constraints

The execution slice owns:

- admission of a currently qualified Linux target for one authorized run;
- allocation of exactly one private run repository, working tree, and branch from
  one immutable task/repository/base-commit binding;
- controller-only Git materialization, verification, sealing, candidate import,
  retention, cleanup, and startup reconciliation;
- confinement of the agent, adapters, tools, builds, tests, and descendants away
  from the source checkout, Git authority, host data, and unrelated runs;
- bounded writable storage, process, CPU, memory, time, file-descriptor, and
  network authority for the run; and
- safe lifecycle projections and diagnostics for worktree, Git, target,
  confinement, process, cleanup, and recovery boundaries.

It does not own task approval, role/provider selection, provider credentials,
agent-protocol semantics, check definitions, evidence qualification, verdicts, or
merge authorization. It supplies a sealed candidate to those later authorities.
Creating a worktree is not permission to execute; producing a commit is not
evidence; a clean process exit is not cleanup; and a qualified host report is not
a permanent property of a machine.

No log, diagnostic, support artifact, operation summary, URL, or error message may
contain repository/worktree paths, remote URLs, branch or ref names derived from
user content, source code, diffs, file names, command arguments, environments,
terminal output, prompts, provider bodies, credentials, personal data, or raw Git
stderr/stdout. Only opaque registry IDs, closed codes, versions, bounded counts,
durations, and approved object IDs/digests may cross the observability boundary.

## Commit-pinned source ledger

External source is used for patterns only. No copied code is approved by this
research record.

| Source | Exact revision and license | Reviewed paths | Finding |
| --- | --- | --- | --- |
| [Git](https://github.com/git/git/tree/f78ce2f7b6df702f93d40b85d6bda92a3f65da79) | commit `f78ce2f7b6df702f93d40b85d6bda92a3f65da79` (2026-08-25); GPL-2.0-only for Git-originated code, with separately licensed bundled components | `Documentation/git-worktree.adoc`, `gitrepository-layout.adoc`, `git.adoc`; `builtin/worktree.c`, `worktree.c`; `t/t2400-worktree-add.sh` through `t/t2407-worktree-heads.sh` | Use stable `--porcelain -z`, atomic add-and-lock, dirty/locked removal refusal, repair/prune concepts, and exact object/ref verification. Reject linked worktrees as the governed isolation boundary because common objects, refs, config, hooks, and worktree administration remain writable shared authority. |
| [Linux kernel](https://github.com/torvalds/linux/tree/45c13f3f9e3bb15fd89ff2864c6f627a3b4b4229) | commit `45c13f3f9e3bb15fd89ff2864c6f627a3b4b4229` (2026-08-25); GPL-2.0-only generally, syscall-note exceptions where declared, and BSD-3-Clause for `samples/landlock/sandboxer.c` | `Documentation/userspace-api/landlock.rst`, `Documentation/admin-guide/cgroup-v2.rst`, `security/landlock`, `samples/landlock/sandboxer.c` | Landlock can add inherited filesystem/network restrictions, while cgroup v2 supplies recursive population and kill facts. ABI gaps, pre-opened descriptors, namespaces, resources, and host configuration require an exact qualified layered profile; unsupported controls must refuse rather than downgrade. |
| [Bubblewrap](https://github.com/containers/bubblewrap/tree/f589986be3b5b37b91778f1b91b5bbaff62d85b5) | commit `f589986be3b5b37b91778f1b91b5bbaff62d85b5` (2026-08-26); LGPL-2.0-or-later for the reviewed source | `README.md`, `bubblewrap.c`, `bind-mount.c`, `network.c`, `tests/test-run.sh`, `tests/test-sandbox.py` | New mount/PID/network/IPC/user/cgroup namespaces, read-only binds, cleared environment, parent-death handling, seccomp input, and a PID-1 reaper are useful mechanisms. Bubblewrap is a low-level policy tool, not a complete sandbox or cleanup/evidence authority, and optional namespace fallback is unacceptable. |
| [GitHub Actions Runner](https://github.com/actions/runner/tree/1d8e0dd630f0c791ecb5611c50058aceb9a2381b) | commit `1d8e0dd630f0c791ecb5611c50058aceb9a2381b` (2026-08-26); MIT | `src/Runner.Worker/PipelineDirectoryManager.cs`, `TrackingManager.cs`, `TempDirectoryManager.cs`, `JobExtension.cs` | Per-job tracking, explicit workspace-clean modes, pre-existing process snapshots, post-job hooks, and orphan cleanup are useful lifecycle warnings. Path-rich logs, best-effort deletion, environment-marker/PID process discovery, mutable self-hosted workspaces, and ignored cleanup errors are rejected. |
| [Eclipse Theia](https://github.com/eclipse-theia/theia/tree/647dd3c7091b25ef3fc735edb74b949e7a195754) | `v1.74.1`, commit `647dd3c7091b25ef3fc735edb74b949e7a195754` (2026-08-06); EPL-2.0 or GPL-2.0-only with Classpath Exception, with separately identified MIT/VS Code material | `packages/workspace/src/browser/workspace-trust-service.ts`, `workspace-trust-preferences.ts`; `packages/process/src/node/process-manager.ts`, `raw-process.ts`; `packages/task/src/node/process/process-task-runner.ts`; `packages/terminal/src/node/terminal-server.ts` | Keep Restricted Mode and existing UI/process ownership integrations, but workspace trust is user consent to execution, not containment. The frontend, workspace root, Theia process map, and task/terminal services cannot be worktree or cleanup authority. |
| [Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | vendored provenance commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25); MIT | `src/ranex/cli/delegation.py`, `src/ranex/cli/host_confinement.py`; `docs/adr/ADR-006-landlock-confinement-of-the-bound-command.md`, `ADR-010-first-delegation.md`; `docs/slices/done/SLICE-017-confinement-of-the-bound-command.md`, `SLICE-019-host-qualification-as-gate-evidence.md`, `SLICE-047-confinement-hardening.md`, `SLICE-059-real-e2e-task-family.md` | Preserve exact dispatch/worktree/commit binding, empty child environments, helper/host provenance, mandatory layered confinement, cgroup kill-and-drain, startup revalidation, evidence separation, and real residue tests. Current task delegation uses a linked worktree and process group and is not the writable-agent confinement required here; Kogg must not overclaim it. |

Primary documentation reviewed at those revisions includes
[Git worktree](https://git-scm.com/docs/git-worktree),
[Git repository layout](https://git-scm.com/docs/gitrepository-layout),
[Linux Landlock](https://www.kernel.org/doc/html/latest/userspace-api/landlock.html),
[Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html),
[GitHub secure use of self-hosted runners](https://docs.github.com/en/actions/reference/security/secure-use),
and [Theia workspace trust](https://theia-ide.org/docs/workspace_trust/).

## Source findings

### Git

`git worktree add` gives each linked worktree its own `HEAD`, index, and a small
administrative directory. `--lock` can create and lock without the race of a
later lock call. `worktree list --porcelain -z` is stable for machine parsing;
remove refuses dirty or locked worktrees unless force is supplied; prune and
repair expose missing or moved administrative state. These are good controller
UX and recovery patterns.

The repository layout proves why linked worktrees cannot protect Kogg's source.
The linked tree's `.git` file points into `$GIT_COMMON_DIR/worktrees/<id>`, and
its `commondir` leads back to the main repository. Objects, most refs and reflogs,
configuration, hooks, packed refs, shallow state, and worktree registrations are
common. Worktree `lock` only protects the administrative entry from ordinary
move/remove/prune; it does not prevent the worktree process from changing the
common repository. Separate checkout paths and branches are concurrency
conveniences, not least-authority filesystem boundaries.

Governed V1 should therefore create a private repository and its one normal
working tree under the Kogg state root. The controller seeds the exact approved
base with a complete independent object store: no hardlinks, alternates, shared
object directory, source remote retained in config, inherited template hooks, or
host/user Git configuration. The source is absent from the run namespace. The run
may use Git freely inside its private repository without acquiring source refs,
hooks, config, objects, remotes, or checkout authority.

Candidate import is another controller boundary. The agent cannot push. After all
run processes are gone, the controller opens the private repository by recorded
identity, verifies the exact base and candidate object graph under a pinned safe
Git configuration, imports only the named candidate into a quarantine namespace,
and independently validates the resulting tree before any later verdict or merge
may advance a source ref. #79 must freeze the exact seed/import mechanism and its
Git security options; ordinary `clone --shared` is explicitly forbidden.

### Linux Landlock and cgroup v2

Landlock lets an unprivileged process add a ruleset inherited by descendants. It
supports filesystem hierarchy rights and version-dependent network rights, and
layers can only add restrictions. The official documentation also records limits:
rights differ by ABI, descriptors opened before restriction retain access, and
special filesystems and some resource classes need other controls. A green
`landlock_create_ruleset` call is not a complete execution target.

Cgroup v2's `cgroup.events` recursively reports whether a subtree is populated;
`cgroup.kill` can terminate the complete subtree. This is stronger than PID,
process group, or environment-marker cleanup. A run cannot be sealed, inspected,
or removed until the owning cgroup reaches `populated 0` and resource event files
are read successfully. A missing key, unreadable event, residual process, or
failed cgroup removal is a failure, never an empty-success default.

The qualified target must bind kernel release/architecture, boot and machine
identity, LSM state, Landlock ABI, user/mount/PID/IPC/network/cgroup namespaces,
seccomp and no-new-privileges support, cgroup-v2 delegation and controllers,
filesystem/mount identity, helper bytes/provenance, storage quota capability, and
network/provider-broker policy. Admission re-reads the volatile/durable anchors
immediately before each run; a prior report cannot survive boot or policy drift.

### Bubblewrap

Bubblewrap always creates a mount namespace and can construct a minimal filesystem
view with explicit read-only or writable binds. It can unshare PID, network, IPC,
user, UTS, and cgroup namespaces, clear the environment, apply supplied seccomp
filters, request parent-death termination, and run a small PID-1 reaper. Its test
suite exercises read-only binds, namespace creation, symlink cases, status FDs,
and no-network behavior.

Every useful property depends on the caller's complete option/mount policy and
the host's kernel configuration. `--unshare-*-try` deliberately continues after
some unavailable boundaries; Kogg must never use a try/fallback form. Bubblewrap
alone does not provide cgroup resource ownership, Landlock, helper provenance,
credential separation, output collection, candidate binding, or durable cleanup
evidence. Use only a pinned, qualified launcher/profile through its owning
boundary; do not copy LGPL code or assemble ad hoc arguments in an adapter.

### GitHub Actions Runner

The runner writes a pipeline tracking file, supports all/resources/outputs clean
modes, confines repository paths under a pipeline directory, snapshots existing
processes, injects a per-job environment marker, runs post-job steps, and attempts
to delete temporary and orphan resources. These patterns demonstrate that
workspace allocation, process baseline, finalization, and retention must be
explicit phases rather than incidental shell cleanup.

The implementation is intentionally operational rather than adversarial. It logs
paths, PIDs, process names, and exceptions; temp deletion can continue after
content errors; process cleanup enumerates PIDs and environment values, kills the
direct process, catches failures, and does not prove a recursive empty owner. Its
workspace may persist across self-hosted jobs. GitHub's own documentation warns
that a self-hosted runner is not an ephemeral clean VM and can be persistently
compromised by untrusted work. Kogg cannot treat “CI runner” or “clean requested”
as target qualification.

### Eclipse Theia

Theia workspace trust prevents tasks, debugging, MCP autostart, and AI execution
while a workspace is untrusted. This is the correct admission dependency: Kogg
must not create a run from an untrusted registered source, and revoked trust blocks
new execution. Theia task, terminal, Git, and process services can remain owners
of their existing UI and platform children.

Trust means a person accepted code-execution risk; it does not isolate a trusted
project from an autonomous agent or one run from another. The frontend may
disconnect, reload, or hold stale paths. Theia's process manager is in-memory and
cannot prove cgroup emptiness or recover private run repositories after a backend
crash. Kogg's backend execution registry and qualified Linux controller are the
authority; the UI receives safe state projections only.

### Ranex

Ranex dispatch binds task ID, target, worktree, base, and emitted commit and
refuses mismatches or a no-change tree. Delegation constructs the child environment
from an allowlist, uses a scratch home, bounds wall time, and kills a process group.
Its task-family E2E uses real disposable Git worktrees and independently detects
residue. These are valuable binding and negative-test patterns.

The current delegated harness still runs in a linked target worktree under the
caller UID, carries provider access, and relies on `setsid`/process-group cleanup.
It is not routed through `host_confinement.py`. The qualified strict-local bound
command profile instead mounts the measured subject read-only, removes network,
and gives writes only to named output/scratch. That profile is appropriate for
checks and evidence collection but cannot host a networked agent editing its
worktree unchanged. Kogg must not infer that a qualified Ranex kernel makes the
agent write phase qualified.

Ranex's confinement design supplies the standard a writable-agent profile must
meet: verified helper and Bubblewrap bytes, closed descriptor/environment, fresh
namespaces and `/proc`, strict Landlock/seccomp/NNP, cgroup enrollment before gate
release, complete resource limits, `cgroup.kill`, `populated 0`, bounded held-dirfd
collection, host-state revalidation, and no weaker fallback. The new profile must
add one private writable run tree, retain source absence, and expose provider
network only through a bounded credential/capability broker. Whether Kogg extends
Ranex or delegates to a separately qualified owner is a #79 decision; duplicating
Ranex evidence or calling the existing profile “close enough” is rejected.

## Pattern comparison and decision

| Candidate | Source protection and cleanup | Decision |
| --- | --- | --- |
| Agent edits the registered source checkout | Direct mutation, no per-run isolation, rollback ambiguity | Reject. |
| `git worktree add` against the source repository | Separate files/index/HEAD but shared common Git authority | Reject for governed untrusted execution. |
| Linked worktree with its `.git` directory mounted read-only | Breaks normal Git writes yet still exposes source metadata/path and needs an unproven mediation layer | Reject as the V1 baseline; a future read-only tool projection may be researched separately. |
| Filesystem copy with no Git repository | Protects source but loses exact object/branch ancestry and realistic agent Git behavior | Reject. |
| Private full repository plus one worktree and branch per run | Independent refs/config/hooks/objects; source can be absent; cost is storage and controlled import | Select. |
| `git clone --shared`, hardlinks, or alternates | Private refs but object integrity/lifetime remains coupled to source and may expose source paths | Reject. |
| Docker/container name as qualification | Runtime presence says nothing about profile, host drift, source mounts, credentials, or descendant cleanup | Reject. |
| Bubblewrap or Landlock alone | Each covers only part of the boundary | Reject; require a pinned layered profile. |
| PID/process-group cleanup | Descendants can escape sessions and PID reuse breaks recovery | Reject; use qualified cgroup ownership and empty readback. |
| Current Ranex strict-local profile unchanged | Strong read-only check sandbox, but no writable agent tree/provider path | Use for checks only; extend/coordinate for agent execution. |
| Backend registry + private run Git tree + qualified Linux confinement + controller import | Separates authorities and provides recoverable lifecycle/cleanup facts | Select for #79. |

## Required authority and identity invariants

1. A run binds one task ID, frozen task revision/digest, project ID, repository ID
   and binding revision, exact base commit/tree, role/attempt, policy/profile
   digest, host qualification, and operation/worktree IDs. Any stale fact refuses
   before allocation or execution.
2. Each run owns exactly one private repository, one ordinary working tree, and
   one branch whose name derives only from an opaque Kogg run ID. User titles,
   prompts, file names, or issue text never enter paths or refs.
3. The private repository has a complete independent object store. No inode,
   alternates file, object directory, ref store, config, hook, reflog, worktree
   admin, or remote is shared with the registered source.
4. Only the controller opens the source repository. Agent, provider adapter,
   terminal, build, test, and tool processes cannot see its path, file descriptors,
   mounts, remotes, credentials, sockets, or common Git directory.
5. Repository seed and candidate import are registered, bounded Git operations
   under a pinned executable and closed environment. Raw paths, argv, output, and
   errors never enter logs. Git hooks, aliases, pager, editor, credential helpers,
   filters, fsmonitor, templates, and system/global configuration are disabled or
   pinned by the frozen contract.
6. The base commit and tree are verified after seeding and again before sealing.
   Candidate HEAD must be a permitted descendant of the exact base and its object
   graph must be complete and valid. A no-change candidate is typed, not silently
   successful.
7. Agent completion cannot seal the worktree while any owned process, terminal,
   child, open writer, or cgroup member remains. Sealing starts only after
   cancellation/join and `populated 0`.
8. A candidate has no authority to change a source ref. Controller import uses a
   quarantine ref/object namespace, verifies the imported identity/tree/policy,
   and leaves promotion to later verdict/merge authority.
9. Cleanup never follows an untrusted path or calls recursive deletion on an
   unresolved string. It opens the recorded state-root child without symlink
   traversal, verifies directory/mount/device/owner/mode plus an immutable
   allocation nonce, and removes only the exact run resource.
10. Candidate retention and cleanup are explicit lifecycle decisions. A tree
    required by pending checks/evidence/verdict cannot be removed; a rejected or
    completed tree is removed only after durable terminal/retention facts commit.
11. Startup reconciliation runs before new allocation. Unknown, mismatched,
    modified, still-populated, or unprovable resources are quarantined and block
    the affected repository/target rather than force-removed or adopted.
12. macOS and Windows may host Kogg UI, coordination, and non-governed tests, but
    V1 governed execution refuses there. No automatic local fallback exists when
    the qualified Linux target or profile is unavailable.

## Process and resource inventory

| Boundary | Owner | Required behavior |
| --- | --- | --- |
| Source repository identity/base read | Kogg projects + execution controller | Revalidate project/binding/trust and exact Git identity using a registered bounded Git process; never expose path. |
| Private repository/worktree allocation | Kogg execution controller | Persist logical record before filesystem/Git side effects; create beneath the private state root; seed independently; verify; transition ready. |
| Git seed/status/seal/import/cleanup | Kogg operation supervisor | Register each Git process before spawn, use closed env/config and deadline, drain output without retaining content, prove cleanup. |
| Agent/provider adapter | Agent-protocol owner inside qualified execution scope | Receive only opaque correlations, private worktree view, bounded capability, and profile-approved tools/network. |
| Agent tools, terminals, builds, tests, debug children | Qualified confinement owner | Enroll before release in the run cgroup; enumerate safe logical records; cancellation kills/joins the complete subtree. |
| Ranex checks/evidence command | Ranex | Use strict qualified profile and remain evidence authority. Kogg observes bridge lifecycle and safe result only. |
| Source candidate quarantine import | Kogg execution controller | Import exact candidate without updating active/source branch; validate object graph and tree; record imported ID. |
| Verdict and merge | Later Ranex/verdict-merge owners | Consume bound candidate/evidence; execution cannot self-promote. |
| UI/editor/workspace projection | Theia | Display safe state and explicit open/run-tree actions; never own path, lease, cleanup, or promotion. |

Writable resources must be named and bounded: private worktree, private Git object
store, scratch, approved outputs, and explicitly qualified caches. Shared package,
compiler, SDK, extension, credential, HOME, socket, `/tmp`, SSH, Docker, and host
Git caches are absent or read-only qualified inputs. A cache writable by two runs
is cross-run authority and is not permitted in V1.

## Lifecycle requirements for #79

The pseudocode must define durable worktree/resource states and legal transitions
covering at least:

`requested -> admitted -> allocated -> seeding -> verified -> ready -> leased ->
executing -> stopping -> sealed -> candidate_imported -> retained -> cleaning ->
cleaned`, with typed side branches for `refused`, `failed`, `timed_out`,
`cancelled`, `cleanup_failed`, `quarantined`, `recovery_required`, and
`reconciling`.

Semantic boundaries that cannot collapse:

- **Admitted is not allocated.** Host/profile/trust/task/repository/base facts are
  current before the first directory, ref, or process is created.
- **Allocated is not verified.** A durable allocation nonce and exact root identity
  exist before Git materialization; partial seed remains recoverable.
- **Ready is not leased.** Base/object independence, private config, source
  invisibility, quotas, and confinement descriptor are verified before one attempt
  receives the exclusive lease.
- **Executing is not candidate.** Agent/provider completion initiates stopping;
  terminals, children, cgroup members, output writers, and adapter hosts must join.
- **Sealed means immutable to the run.** Network and processes are gone; controller
  reopens by trusted identity, verifies base/HEAD/tree/object graph and mutation
  policy, and records the exact candidate. No agent process may race inspection.
- **Imported is not promoted.** The source receives only a quarantined object/ref
  binding. Checks/evidence/verdict/merge make later decisions.
- **Retained is explicit.** Candidate, rejection, incident, and user-cancel policies
  name deadlines/authority; disk pressure cannot silently delete live evidence.
- **Cleaned is proved.** Process cgroup empty, Git processes closed, worktree and
  private Git directory absent, locks/leases released, quarantine handling
  resolved, and source base/active refs/checkout unchanged.

Repository-scoped mutation and recovery must serialize. Independent runs may
execute concurrently only after their private resources are verified and must not
share writable caches, refs, Git locks, branches, ports, sockets, or cgroups.
Candidate import and merge serialize against source repository identity/revision.

## Failure and recovery matrix

| Failure | Required behavior | Safe evidence |
| --- | --- | --- |
| Untrusted workspace, stale task/binding/base, or unavailable repository | Refuse before allocation | Opaque IDs/revisions and closed refusal code |
| Linux target/profile absent, stale, drifted, or missing one mandatory layer | Refuse; no local/weaker fallback | Target/profile/qualification IDs and failed check ID |
| Allocation root is symlinked, wrong owner/mode/device/mount, reused, or outside state root | Refuse/quarantine without deletion | Worktree ID, allocation phase, identity mismatch class |
| Seed process fails/times out or base/tree mismatch | Stop, clean exact partial allocation if identity is proved; otherwise quarantine | Git operation ID, phase, exit/timeout class |
| Object hardlink/alternate/shared config/hook/remote detected | Refuse ready transition and quarantine | Independence check ID and count only |
| Branch/ref collision | Refuse; never force/reset an existing ref | Run/repository IDs and collision code |
| Agent attempts source/host/cross-run access | Kernel/profile denial; fail attempt; retain safe violation class | Profile rule ID and denied capability class, no path |
| Agent forks, daemonizes, changes session, or leaves terminal | Remains in run cgroup; cancellation/cleanup kills whole subtree | Safe process count, cgroup state, residual code |
| Provider/network path exceeds grant | Broker/profile refusal; no open host-network fallback | Capability/provider IDs and closed network code |
| CPU/memory/PID/storage/inode/output/time bound exceeded | Kill subtree, classify exact limit, do not seal live output | Limit class, configured/observed bounded counts |
| Backend/controller dies during seed or execution | Durable recovery sweep revalidates process/resource identity before action | Prior instance/resource states and recovery code |
| Host reboots | Qualification invalid; reconcile filesystem/Git state with no live-process assumption; requalify before execution | Boot/qualification mismatch and resource outcomes |
| Agent reports commit not at recorded HEAD/base or object graph invalid | Refuse candidate and retain/quarantine for diagnosis | Approved object IDs and Git validation code |
| Candidate import fails or source changed | Leave source refs unchanged, keep private candidate retained, require fresh decision | Expected/observed safe revisions and import phase |
| Cleanup finds dirty/modified identity, mount, open handle, populated cgroup, or deletion error | `cleanup_failed`/quarantine; block affected scope | Residual/resource counts and diagnostic check IDs |
| Disk pressure before retention expiry | Block new allocation and surface capacity diagnostic; do not delete authority records | Capacity class/counts, no paths/file names |
| Startup finds unknown private directory/ref/process | Never adopt or delete automatically; quarantine and require evidence-backed resolution | Unknown-resource count/type and root check ID |

## Logging and diagnostic contract

Use hierarchical Theia loggers such as `kogg:execution:target`,
`kogg:execution:worktree`, `kogg:execution:git`, and
`kogg:execution:confinement`. Stable lifecycle events must cover request,
admission/refusal, allocation, seed start/end, verification, ready/lease, target
start/activity, timeout/cancel, process/cgroup cleanup, seal, candidate import,
retention, removal, failure, quarantine, and startup recovery.

Allowed event fields are declared per event and limited to safe opaque
project/task/run/attempt/operation/worktree/process/target/profile IDs, approved
Git object IDs where operationally necessary, finite phase/outcome/error codes,
bounded counts/durations, and schema/version numbers. Worktree IDs are not paths.
Do not pass Git/provider/OS exception messages through; map them to Kogg-authored
safe codes. A log schema must reject unknown fields without echoing their values.

The diagnostic catalog must add checks for:

- `execution-target-qualification`: current Linux/architecture/boot/LSM/kernel,
  helper/profile, namespace, Landlock/seccomp/NNP, cgroup delegation, quota, and
  broker facts match the accepted qualification;
- `execution-worktree-registry`: every durable worktree/resource record maps to
  exactly one proved private root/branch/state, with no unknown or duplicate
  resources and no stale exclusive lease;
- `execution-git-independence`: no private repository uses source hardlinks,
  alternates, shared common dir, source remote, untrusted hook/config/template, or
  writable external object/cache path;
- `execution-source-integrity`: registered source identity, base, active refs, and
  checkout remain unchanged by active/completed run allocation and execution;
- `execution-process-cleanup`: every active process belongs to the qualified owner
  and every terminal run has `populated 0`, zero residuals, drained handles, and a
  terminal cleanup fact;
- `execution-capacity`: state root bytes/inodes and per-run quotas can satisfy a
  bounded allocation without emergency deletion;
- `execution-recovery`: no incomplete, quarantined, unknown, or cleanup-failed
  resource is hidden before admission; and
- `execution-source-maps`: backend/frontend/Electron/extension/launcher adapter
  bundles preserve maps and exercised failure branches are debugger-reachable.

Every operational implementation file must declare a related
`diagnostic-coverage` ID. Git spawning, directory allocation/deletion, target
admission, profile construction, sealing, import, cleanup, and recovery cannot be
diagnostic-exempt.

## E2E and fault-injection requirements

Production cannot close on mocked Git or source inspection. #82 and #85 must use a
real disposable source repository, real private run repository, real Git
processes, the public execution service, a genuinely qualified Linux target, real
confinement/cgroup processes, and an independent postcondition oracle. Required
journeys include:

1. create two concurrent runs from one exact source base and prove unique private
   repositories, worktrees, branches, cgroups, scratch, and zero writable sharing;
2. prove source checkout files, refs, config, hooks, objects, remotes, and active
   branch remain byte/object-identical while each run edits/commits privately;
3. reproduce the linked-worktree negative control: an unconfined linked run can
   reach/mutate `$GIT_COMMON_DIR`; then prove the selected private/confinement
   design makes the source absent and the same attack impossible;
4. exercise normal Git status/edit/commit inside the private run without source
   remotes, user/system config, hooks, credentials, or host paths;
5. seal and import one exact candidate into quarantine, independently verify base,
   tree and object closure, and prove no active/source ref moves;
6. force seed failure, Git timeout, branch collision, malformed object/candidate,
   source-base race, import failure, quota exhaustion, and cleanup deletion error;
7. attempt path/symlink/hardlink/alternate/config/hook/filter/fsmonitor/remote,
   namespace, network, `/proc`, cross-run, source, and writable-cache escapes;
8. fork/double-fork/`setsid`, leave terminals and background writers, then cancel,
   timeout, kill controller, and reboot/restart the backend; every descendant is
   killed or a release-blocking residual is diagnosed;
9. crash at every durable lifecycle boundary and prove startup recovery neither
   deletes an unproved path nor admits new affected work early;
10. seed canary repository paths, file names, commands, diffs, prompts, credentials,
    environment values, Git errors, and terminal output; captured logs, diagnostics,
    UI errors, and support bundles contain none;
11. corrupt or drift each qualification fact and prove explicit refusal without
    fallback; macOS and Windows prove the same governed-execution refusal; and
12. use debugger/source maps to reach allocation, Git spawn failure, confinement
    refusal, timeout, cancellation, cleanup failure, quarantine, and recovery.

The E2E artifact records only safe IDs, approved object/digest facts, check names,
closed outcomes, bounded counts, and the exact clean-source/zero-residual verdict.
A green candidate with a changed source checkout, shared Git metadata, hidden
process, stale qualification, unsafe log, or unknown cleanup result is a failure.

## Rejected approaches

- Editing, checking out, resetting, cleaning, or stashing the registered source
  checkout for a run. This gives autonomous work direct user-state authority.
- Treating a linked Git worktree and unique branch as security isolation. Shared
  `$GIT_COMMON_DIR` disproves the claim.
- Using `git clone --shared`, hardlinks, alternates, partial object promises, or a
  writable shared cache to save disk without a separate security decision.
- Giving the agent a source remote, credential helper, SSH agent, user HOME,
  system/global Git config, source hook, template directory, pager, editor, or
  arbitrary Git environment variable.
- Letting the agent push/import/update refs or merge its own candidate.
- Parsing user/task text into filesystem paths or branch names.
- `rm -rf`, force worktree removal, or ref deletion against a path/ref that was not
  reopened and proven as the exact Kogg allocation.
- Assuming workspace trust, a container, self-hosted runner, process group,
  `AbortSignal`, PID list, environment marker, or child exit proves containment.
- Bubblewrap, Landlock, seccomp, namespaces, or cgroups used alone or with
  best-effort fallback.
- Treating Ranex host qualification as timeless or claiming the current read-only
  strict-local profile qualifies a writable networked agent.
- Persisting raw Git output, directory listings, diffs, file names, branch names,
  paths, terminal output, or confinement audit payloads for debugging.
- Deleting a candidate before its checks/evidence/verdict/incident retention owner
  records release, or retaining it forever without quota policy.
- Killing a PID discovered after restart without platform identity and qualified
  ownership proof.

## Risks and questions #79 must close

1. Freeze the exact independent seed mechanism and prove no hardlink, alternate,
   shared object/ref/config/hook/admin state, partial-clone promise, or source path
   survives. Decide full-history versus exact-reachable object closure and bounds.
2. Freeze controller Git executable provenance, closed environment/config, allowed
   commands, time/output bounds, hook/filter/fsmonitor/credential/pager/editor
   suppression, safe-directory behavior, hash formats, and object validation.
3. Define the private path/ref grammar, state-root layout, permissions, allocation
   nonce/identity, no-follow/openat2 rules, mount/device checks, leases,
   idempotency, capacity reservations, and safe deletion algorithm.
4. Decide the writable-agent confinement owner and profile. Current Ranex
   strict-local is read-only/no-network, while current delegation is not confined.
   Specify the coordinated profile change or separate qualified owner explicitly.
5. Define provider connectivity through a bounded kernel-owned broker, DNS and
   redirect policy, credential isolation, network namespace rules, and how offline
   tools/checks differ from the agent phase.
6. Define platform/kernel/architecture minimums; mandatory Landlock ABI and rights;
   namespaces, seccomp, NNP, cgroup-v2 delegation/controllers/kill/events; storage
   quota backend; helper provenance; host-state freshness and refusal codes.
7. Define worktree mutation rules: symlinks, hardlinks, executable bits, submodules,
   LFS, sparse checkout, attributes/filters, nested repositories, case collisions,
   special names, large files, generated output, and filesystem boundaries.
8. Freeze sealing/candidate rules, no-change/multiple-commit/history-rewrite policy,
   base ancestry, object graph/tree validation, and the safe controller interface
   that avoids executing untrusted repository config during inspection.
9. Define quarantine import with atomic source-side locking/CAS, object namespace,
   independent tree oracle, source-concurrency conflict, rollback, and proof that
   no active ref changes. Coordinate with verdict/merge rather than preempting it.
10. Define process/resource registration and start gating, complete cgroup
    enrollment, terminal/adapter child ownership, activity/timeout/cancel order,
    kill/drain/readback, and deterministic completion-versus-cancel races.
11. Define crash/reboot reconciliation for every partial state, quarantine/user
    resolution, retention deadlines, evidence dependencies, disk pressure, and
    deletion failure without blind adoption or destructive cleanup.
12. Freeze lifecycle/event/error schemas, diagnostics, source-map/debugger proof,
    real fault injection, canary privacy scan, and #70 artifact fields.

## Prototype recommendation for #82

Build a disposable real-boundary probe around the highest-risk claim: source
checkout protection while an autonomous process has useful Git behavior. First
create a real linked worktree and reproduce mutation of a harmless source ref or
common-config sentinel through its `.git`/`commondir` path. That is the red
negative control. Then seed a private repository/worktree from the same base,
place it inside the proposed qualified Linux confinement, and run an adversarial
worker that edits and commits normally while attempting every source/common-dir,
hardlink/alternate, path, network, process-escape, and residual attack above.

The probe must also seal/import a candidate into quarantine, kill the controller
mid-seed/mid-run/mid-cleanup, reconcile from a fresh backend, and scan all captured
observability for canaries. Preserve the prototype branch and CI evidence; merge
only findings and necessary contract corrections. If ordinary agent Git behavior
requires exposing shared metadata or widening the source mount, record a negative
result and change #79 before production. A second checkout directory with a happy
`git status` is not a security probe.

## Research gate conclusion

The sources and licenses are commit-pinned, selected and rejected approaches are
explicit, and process, lifecycle, failure, recovery, logging, diagnostics,
security, maintenance, and real-E2E requirements are enumerated. The findings are
sufficient for #79 to write decision-complete pseudocode without another broad
source search.

The invariant for the remaining lifecycle is: **the run may own its private Git
tree and complete process scope; it never owns the registered source repository,
and neither a candidate commit nor a clean direct-child exit can cross that
boundary without controller verification, zero-residual cleanup, later evidence,
and verdict/merge authority.**
