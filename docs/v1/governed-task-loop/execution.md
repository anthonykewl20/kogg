# Qualified execution targets and isolated Git worktrees

Tracking: [#73](https://github.com/anthonykewl20/kogg/issues/73), research
phase [#76](https://github.com/anthonykewl20/kogg/issues/76), pseudocode phase
[#79](https://github.com/anthonykewl20/kogg/issues/79).

## Status

Research and decision-complete pseudocode are complete as of 2026-08-27. This
packet contains no production code. A disposable real-boundary probe follows in
#82 and production implementation plus real human-level E2E follows in #85.

The selected design is one controller-owned, private Git repository and
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

## Decision-complete production contract for #79

The remaining implementation choices are closed below. Names are normative for
the production slice unless the #82 probe disproves a boundary and this packet is
reopened with measured evidence.

### Platform and confinement decision

Governed V1 execution is admitted only on `linux/amd64` with all of these facts
fresh for the current boot and helper/profile digests:

- Linux kernel 6.6 or newer with user, mount, PID, IPC, UTS, and network
  namespaces enabled;
- Landlock ABI 4 or newer with every filesystem right supported by that ABI plus
  TCP bind/connect mediation; unsupported requested rights refuse admission;
- unified cgroup v2 with a delegated Kogg subtree supporting `pids`, `cpu`,
  `memory`, `io`, `cgroup.freeze`, `cgroup.kill`, and reliable `populated` readback;
- unprivileged Bubblewrap at the packet-pinned digest, no-new-privileges, a pinned
  seccomp program, and a Kogg-owned PID-1 reaper;
- a dedicated XFS state filesystem mounted with project quotas; each allocation
  receives an exclusive project ID and byte/inode limits before materialization;
- the pinned Kogg native launcher/helper opened and verified by descriptor, with
  root ownership and non-writable parent chain; and
- an authenticated kernel-owned Unix-socket capability broker when provider
  network is required. The sandbox has no general host network interface, DNS
  configuration, credential file, SSH agent, or host socket.

There is no partial profile and no Docker-as-qualification shortcut. A check-only
attempt uses Ranex's existing strict-local read-only profile. A writable producer
uses a new Ranex-owned `kogg-writable-agent-v1` confinement profile. Ranex owns
construction, descendant confinement, watchdog, cgroup kill/drain, and the
profile attestation; Kogg owns the private Git tree and registers one logical
parent process. This extends the existing Ranex authority instead of creating a
second sandbox/evidence implementation in Kogg.

The provider broker accepts a preauthorized opaque capability over its inherited
descriptor, resolves only the provider endpoint set frozen in the run plan,
enforces HTTPS, DNS response/address allowlists, redirect count and target policy,
request/response/time/connection bounds, and injects credentials outside the
sandbox. It exposes no generic CONNECT, arbitrary URL, proxy environment, raw
credential, or response body to Kogg logs. Offline tools and deterministic checks
receive no broker descriptor.

Qualification is valid for at most five minutes and is invalidated immediately
by boot ID, kernel, mount, cgroup delegation, helper, Bubblewrap, seccomp,
Landlock, quota, broker, or profile change. Admission recomputes it immediately
before allocation and again before process release. An existing run is stopped
and marked `qualification-lost` when monitored facts drift.

### Git seed, repository, and candidate decision

The controller resolves one approved base commit using the registered source
repository with the pinned Git executable. It creates a temporary Git bundle
containing the exact base and all reachable ancestors, then initializes the
private repository from that bundle using `git clone --no-local --no-hardlinks`
semantics. The bundle is controller-only, quota-counted scratch and is removed
after independent-object verification. V1 intentionally includes complete
history reachable from the base; shallow and partial histories, promisor objects,
submodule recursion, LFS smudge, alternates, and shared object caches are refused.

All controller Git invocations use the verified Git binary descriptor and this
closed environment/config policy:

- empty environment followed by only `PATH` to the verified tool directory,
  fixed `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `TZ=UTC`, and an empty private HOME;
- `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` pointing to an empty controller
  file, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` and `SSH_ASKPASS` to a refusing
  helper, and no inherited `GIT_*`, proxy, SSH, credential, pager, editor, or
  locale variables;
- per-command `-c` settings disabling hooks path, credential helpers, pager,
  editor, fsmonitor, optional locks where unsafe, replace refs, and external
  diff/textconv; filters and attributes are not evaluated during controller
  object/tree inspection;
- argument vectors selected from a closed command catalog, no shell, aliases,
  `-C`, arbitrary config, URL, refspec, revision expression, or user string; and
- 30-second idle, 120-second absolute, 8 MiB drained-output and 1,000-record
  porcelain bounds unless a narrower command definition applies. Bound breach
  kills the registered process group and returns a closed code.

The private repository has no remote, hooks, alternates, replace refs, grafts,
promisor configuration, sparse checkout, fsmonitor, worktree extensions, or
submodules initialized. It uses the source object format and refuses unknown
extensions. `git fsck --strict --full --no-reflogs` and independent inode/link,
config, ref, object-root, and filesystem-boundary checks precede `ready`.

The run branch is `refs/heads/kogg-run/<base32(run-id)>`; its only initial value
is the exact base. The filesystem allocation name is `r-<base32(worktree-id)>`.
Both IDs are 128-bit random values recorded before use; no task/user/repository
text enters a path or ref. Branch creation uses compare-and-swap from absence.

Producer mutation policy allows ordinary files, directories, symlinks that remain
relative within the worktree, and executable-bit changes. It rejects absolute or
escaping symlinks, hardlinks to an inode outside the allocation, device/FIFO/socket
nodes, nested Git repositories, submodule/gitlink entries, case-fold or Unicode-
normalization collisions, reserved platform names, `.git` file/directory changes,
objects over 100 MiB, trees over 100,000 entries, and total candidate growth over
the run quota. Repository `.gitattributes` may be edited as content but controller
inspection never invokes its filters or external drivers.

One attempt may create any finite commit history rooted at the exact base. Seal
requires HEAD to be a descendant of base, no merge commit, every parent reachable
within the private store, a clean index/worktree, valid strict object graph, and
at least one tree change. History rewrite inside the private branch is permitted
before seal because no other authority consumes it; after seal all run writes are
removed. The exact sealed HEAD and tree are the candidate. `no-change`, detached
HEAD, multiple heads, merge commit, missing object, dirty state, or base mismatch
is a typed refusal.

Candidate transfer creates a controller-only bundle from `base..candidate` plus
the candidate ref, imports it into the registered repository under
`refs/kogg/quarantine/<base32(candidate-id)>`, and verifies the base, candidate,
tree, object closure, mutation policy, and source identity again. Import holds the
repository mutation lease and uses compare-and-swap from an absent quarantine
ref. Active branches, HEAD, index, worktree, config, remotes, hooks, and existing
refs cannot change. Failure deletes only a newly created, exact-CAS quarantine ref
when its identity is proved; otherwise it retains and quarantines the result.
Promotion is outside this slice.

### Safe state-root and deletion decision

The state root is a configured absolute directory on the qualified XFS project-
quota filesystem, owned by the Kogg service identity, mode `0700`, and opened once
with a held directory descriptor. All traversal uses a pinned native helper with
`openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|
RESOLVE_NO_XDEV)` relative to that descriptor. The helper accepts only validated
opaque allocation names, fixed child names, and closed operation codes.

Allocation creates a directory with `mkdirat`, mode `0700`, assigns an unused XFS
project ID and limits, writes an `allocation.json` containing only schema version,
worktree ID, random 256-bit allocation nonce, owner instance, and creation time,
fsyncs file and directory, and commits the same identity in SQLite. A resource is
usable only when the open descriptor's device/inode/owner/mode/mount/project ID
and nonce exactly match the durable record.

Cleanup freezes/kills/drains the cgroup, closes every controller handle, reopens
the exact allocation by descriptor, revalidates every identity, removes entries
without following links using descriptor-relative enumeration/unlink, fsyncs each
directory boundary, verifies the allocation is absent, releases the project ID,
and only then commits `cleaned`. No recursive pathname API, glob, `$HOME`, temp
root, user string, force worktree removal, or unverified mount crossing is used.
Any mismatch becomes `quarantined`; it is not deleted automatically.

### Closed data contracts

All records use canonical RFC 8785-style JSON restricted to strings, booleans,
bounded integers, arrays, and closed objects; no floats, null/absent ambiguity, or
unknown keys. Digests are domain-separated SHA-256 strings. Times are UTC RFC3339
with millisecond precision for display/deadlines but never identity. Revisions are
monotonic 64-bit integers represented as decimal strings across JSON.

```ts
type ExecutionState =
  | 'requested' | 'refused' | 'admitted' | 'allocated' | 'seeding'
  | 'verified' | 'ready' | 'leased' | 'executing' | 'stopping'
  | 'sealed' | 'candidate-imported' | 'retained' | 'cleaning' | 'cleaned'
  | 'failed' | 'timed-out' | 'cancelled' | 'cleanup-failed'
  | 'quarantined' | 'recovery-required' | 'reconciling';

interface ExecutionBindingV1 {
  schemaVersion: 1;
  projectId: string;
  projectRevision: string;
  repositoryId: string;
  repositoryBindingRevision: string;
  taskId: string;
  taskRevisionId: string;
  taskRevisionDigest: string;
  approvalDigest: string;
  runId: string;
  attemptId: string;
  workflowPlanDigest: string;
  baseCommit: string;
  baseTree: string;
  gitObjectFormat: 'sha1' | 'sha256';
  targetId: string;
  qualificationId: string;
  qualificationDigest: string;
  profileId: 'kogg-writable-agent-v1';
  profileDigest: string;
}

interface ExecutionAllocationV1 {
  schemaVersion: 1;
  worktreeId: string;
  allocationName: string;
  allocationNonceDigest: string;
  filesystemIdentityDigest: string;
  quotaProjectId: string;
  quotaBytes: string;
  quotaInodes: string;
  branchRefDigest: string;
  ownerInstanceId: string;
  state: ExecutionState;
  revision: string;
  cleanupState: 'required' | 'cleaning' | 'cleaned' | 'failed';
}

interface ExecutionLeaseV1 {
  schemaVersion: 1;
  leaseId: string;
  worktreeId: string;
  attemptId: string;
  ownerInstanceId: string;
  fencingToken: string;
  issuedAt: string;
  expiresAt: string;
  revision: string;
}

interface CandidateBindingV1 {
  schemaVersion: 1;
  candidateId: string;
  worktreeId: string;
  runId: string;
  attemptId: string;
  baseCommit: string;
  baseTree: string;
  candidateCommit: string;
  candidateTree: string;
  objectClosureDigest: string;
  mutationPolicyDigest: string;
  quarantineRefDigest?: string;
  sealedAt: string;
  retentionClass: 'pending-evidence' | 'rejected' | 'incident' | 'completed';
  retentionUntil: string;
}

interface TargetQualificationV1 {
  schemaVersion: 1;
  qualificationId: string;
  targetId: string;
  bootIdDigest: string;
  kernelRelease: string;
  architecture: 'amd64';
  landlockAbi: string;
  cgroupProfileDigest: string;
  mountQuotaDigest: string;
  launcherDigest: string;
  bubblewrapDigest: string;
  seccompDigest: string;
  brokerDigest: string;
  ranexCommit: string;
  profileDigest: string;
  checkedAt: string;
  expiresAt: string;
  status: 'qualified' | 'refused';
  refusalCodes: readonly ExecutionCode[];
}
```

`allocationName` and approved Git object IDs may cross the backend/controller
boundary but are not returned to the browser. The browser receives opaque IDs,
finite states, progress counts, safe codes, and candidate commit/tree only where
the product explicitly needs them. Filesystem paths, ref text, qualification host
facts, and raw policy records remain backend-private.

### Command and persistence contract

The backend exposes these closed commands; every mutating request includes a
UUIDv4 `requestId`, expected record revision, exact binding digest, and optional
user cancellation token:

```ts
interface ExecutionServiceV1 {
  qualify(request: QualifyRequestV1): Promise<TargetQualificationSummaryV1>;
  allocate(request: AllocateRequestV1): Promise<ExecutionSummaryV1>;
  start(request: StartAttemptRequestV1): Promise<ExecutionSummaryV1>;
  cancel(request: CancelExecutionRequestV1): Promise<ExecutionSummaryV1>;
  seal(request: SealCandidateRequestV1): Promise<CandidateSummaryV1>;
  importCandidate(request: ImportCandidateRequestV1): Promise<CandidateSummaryV1>;
  release(request: ReleaseExecutionRequestV1): Promise<ExecutionSummaryV1>;
  get(runId: string): Promise<ExecutionSummaryV1>;
  list(projectId: string): Promise<readonly ExecutionSummaryV1[]>;
}
```

The frontend cannot supply paths, refs, Git commands, profile settings, resource
limits outside a named policy, environment, executable, network endpoint, or
cleanup override. `start` consumes a previously compiled workflow node grant and
an exclusive ready allocation; it does not accept a provider credential.

SQLite is the lifecycle/control authority. Mutations use `BEGIN IMMEDIATE`,
compare expected revision and request-id ledger, append one lifecycle event,
update the projection, and commit. Filesystem/Git/Ranex operations use durable
intent rows with this protocol:

```text
transaction:
  validate immutable bindings, revision, admission and idempotency
  append intent(operationId, type, resourceId, expectedIdentity, phase=requested)
  reserve quota/project/ref/lease identity
  commit

perform external step through registered bounded operation

transaction:
  reopen intent and compare fencing token + expected resource identity
  record closed outcome and observed identity digest
  advance exactly one legal state, append event, commit
```

No transaction is held across a process or filesystem call. A repeated request ID
with the same canonical request returns its committed result. The same ID with a
different digest refuses. A lost response resumes from intent/outcome identity;
it never repeats an unknown seed/import/delete/start side effect.

Repository mutation leases use SQLite fencing tokens and a source-side lock file
opened by descriptor in the Kogg-private repository metadata namespace. Seed
source reads share a read lease; candidate import is exclusive. A source project
revision/base change invalidates pending admission but does not delete a private
candidate. Lease expiry alone never authorizes a second owner; startup recovery
must prove the first operation/process is terminal.

### Legal state machine

Only these forward transitions are legal:

```text
requested -> refused | admitted
admitted -> allocated | failed
allocated -> seeding | cleaning | quarantined
seeding -> verified | failed | timed-out | recovery-required
verified -> ready | cleaning | quarantined
ready -> leased | cleaning | quarantined
leased -> executing | cancelled | recovery-required
executing -> stopping | timed-out | failed | recovery-required
stopping -> sealed | cancelled | timed-out | failed | cleanup-failed
sealed -> candidate-imported | retained | cleaning | recovery-required
candidate-imported -> retained | cleaning | recovery-required
retained -> cleaning
cleaning -> cleaned | cleanup-failed | quarantined
cleanup-failed -> cleaning | quarantined
recovery-required -> reconciling
reconciling -> one proved prior/forward terminal state | quarantined
```

`refused` creates no allocation and is terminal. `failed`, `timed-out`, and
`cancelled` describe the attempt result but remain nonterminal while cleanup is
required; their projection carries `cleanupState` and transitions through
`cleaning` to `cleaned` without erasing the outcome. `sealed`, `candidate-imported`,
and `retained` have zero live processes. `cleaned` is terminal only after the
allocation is absent and all leases/quota/process facts are closed. `quarantined`
is terminal for automatic action and requires an authenticated operator recovery
flow outside normal execution.

Completion and cancellation race on the durable state revision. If producer exit
was observed first, `stopping` still closes network and joins all descendants;
cancellation may change the user-visible requested outcome but cannot interrupt
seal inspection once no run process remains. If cancel commits first, candidate
seal is not started. A timeout commits stop intent, closes broker capability,
freezes then kills the cgroup, waits for `populated 0`, drains handles, and records
`timed-out`; it cannot be converted to success by a late exit.

### Startup and crash recovery pseudocode

Before any qualification is reused or allocation/start admitted:

```text
recover(instance):
  set global executionAdmission = blocked
  verify SQLite integrity and state-root descriptor identity
  acquire single recovery lease with fencing token
  load every non-cleaned allocation, incomplete intent and active lease
  enumerate state-root children, quota project IDs, quarantine refs,
            operation processes and Ranex-owned run scopes as safe identities
  if an enumerated resource lacks exactly one durable owner:
      quarantine affected target/repository; never adopt/delete
  for each owned record in stable ID order:
      requalify current boot/profile before process action
      compare allocation descriptor identity + nonce + quota + ref/object facts
      ask operation/Ranex owner for complete process-scope status
      classify by last committed intent:
        allocate/seed: verify exact output; advance if uniquely complete,
                       else clean only exact proved partial resource
        start/execute: never restart; cancel/join proved owned scope,
                       mark interrupted or quarantine unknown ownership
        seal/import: recompute immutable candidate/quarantine CAS result;
                     record unique result, never repeat ambiguous import
        cleanup: continue descriptor-relative removal only after full reproof
      append recovery event and terminal/blocked outcome idempotently
  run all execution diagnostics
  enable admission only for scopes with no fail/quarantine/unknown/recovery item
```

After reboot, every qualification and process lease is stale. An empty cgroup path
is not enough; recovery correlates boot ID, durable intent, filesystem identities,
and source/quarantine state, then cleans or retains. A possible process residual,
open mount, changed allocation identity, unknown ref, or failed journal/database
integrity blocks automatic action.

Retention defaults are: pending evidence/verdict until the owning authority
releases it; rejected/cancelled 24 hours; completed 24 hours after controlled
merge; incident 30 days or explicit operator release. Limits are policy values,
not user inputs. Disk pressure blocks new allocation and requests explicit
release; it never shortens a live retention fact. Product evidence records retain
candidate object/digest bindings even after private filesystem cleanup.

### Safe codes, logging, and expected traces

`ExecutionCode` is a closed catalog. Required groups are `ADMISSION_*`,
`QUALIFICATION_*`, `ALLOCATION_*`, `GIT_SEED_*`, `GIT_INDEPENDENCE_*`,
`CONFINEMENT_*`, `PROCESS_*`, `LIMIT_*`, `SEAL_*`, `IMPORT_*`, `RETENTION_*`,
`CLEANUP_*`, `RECOVERY_*`, and `INTERNAL_*`. One concrete code exists for every
row in the failure matrix; unknown external errors map to the phase-specific
`*_FAILED` without their message.

Normative loggers are `kogg:execution:service`, `:target`, `:allocation`, `:git`,
`:confinement`, `:candidate`, `:cleanup`, and `:recovery`. Event names are:

```text
request.received | request.refused | request.completed | request.failed
qualification.started | qualification.completed | qualification.invalidated
allocation.requested | allocation.created | allocation.failed
seed.started | seed.completed | independence.verified | ready
lease.acquired | lease.released | attempt.starting | attempt.started
attempt.activity | attempt.stopping | attempt.timed-out | attempt.cancelled
process.registered | process.started | process.exited
cgroup.kill.started | cgroup.empty | process.cleanup.failed
seal.started | seal.completed | seal.refused
import.started | import.completed | import.refused
retention.started | retention.released
cleanup.started | cleanup.completed | cleanup.failed
recovery.started | recovery.resource.classified | recovery.completed
resource.quarantined
```

Every event has `eventVersion`, opaque operation/run/attempt/worktree/process/
target IDs as applicable, finite phase/state/code, bounded count/duration, and
record revision. Only `seal.completed` and `import.completed` may include approved
candidate commit/tree. Unknown fields are rejected at the logger adapter. Activity
is rate-limited and contains only monotonic count and elapsed bucket.

Expected successful trace:

```text
request.received -> qualification.started -> qualification.completed
-> allocation.requested -> allocation.created -> seed.started -> seed.completed
-> independence.verified -> ready -> lease.acquired -> attempt.starting
-> process.registered -> process.started -> attempt.started -> attempt.activity*
-> process.exited -> attempt.stopping -> cgroup.empty -> seal.started
-> seal.completed -> import.started -> import.completed -> retention.started
```

Expected timeout trace:

```text
attempt.activity -> attempt.timed-out -> attempt.stopping
-> cgroup.kill.started -> process.exited* -> cgroup.empty
-> lease.released -> cleanup.started -> cleanup.completed
```

Expected crash trace begins with `recovery.started`, emits exactly one
`recovery.resource.classified` per durable/unknown identity, then either advances
to a proved state or `resource.quarantined`; `recovery.completed` includes only
bounded recovered/quarantined/blocked counts.

### Diagnostic catalog and debugger proof

The exact catalog IDs are:

- `execution.target-qualification`
- `execution.worktree-registry`
- `execution.git-independence`
- `execution.source-integrity`
- `execution.process-cleanup`
- `execution.capacity`
- `execution.recovery`
- `execution.source-maps`

Each ID is added to `diagnostics/catalog.json` in #85 and gets one contributor
whose fail-closed exception path returns that same check as `fail`. Contributors
are read-only, bounded to five seconds individually and 20 seconds collectively,
return only finite codes/counts/digests, and cannot start Git, a producer, or a
cleanup mutation. Operational files declare the closest ID; files spanning two
authorities declare the release-blocking one and tests cover the companion check.

Debugger proof uses the production browser and Electron source maps and the real
TypeScript backend/native-launcher/Ranex Python source. The E2E sets breakpoints at
allocation intent, pre-spawn registration, target refusal, timeout kill, seal
validation, import CAS, cleanup identity refusal, and recovery classification.
It verifies original source locations and safe local variables without capturing
content-bearing values in retained artifacts.

### UI and real E2E pseudocode

The run panel shows safe target qualification, allocation, execution, stopping,
candidate, retention, cleanup, and recovery states. Start is disabled with a
specific safe reason until task approval, repository/base binding, compiled run
plan, and current Linux qualification agree. Cancel remains available while a
live attempt can stop. “Open run worktree” is offered only through a backend-issued
one-use opaque handle and only to an explicitly trusted local operator; the raw
path is never placed in application state, URL, logs, telemetry, or support data.

Cleanup/recovery failure is prominent, keyboard reachable, announced through an
ARIA live region, and never represented by color alone. The UI cannot force
delete, bypass qualification, retry an unknown side effect, change resource
limits/profile, or promote a quarantine ref. Focus moves predictably after start,
cancel, terminal result, and recovery. Reduced motion and screen-reader state
labels cover the live timeline.

Production E2E follows this public path:

```text
launch packaged Kogg -> create/open disposable project -> approve frozen task
-> choose qualified Linux target -> start governed run -> observe allocated/active
-> producer edits and commits in private tree -> stop/join -> seal candidate
-> import quarantine -> show retained candidate -> cancel/release cleanup
-> run diagnostics -> close app -> independent Git/filesystem/cgroup oracle
```

The independent oracle compares a pre-run snapshot of source HEAD/index/worktree,
every ref/config/hook/object inode, and mount identity; proves the private store
has no alternate/hardlink/common-dir/remote; verifies candidate ancestry/tree and
quarantine-only import; and proves zero cgroup/process/descriptor/allocation/quota
residue after release. Captured console/log/support artifacts are scanned for
seeded canary path, ref, file name, prompt, code, diff, command, environment,
credential, provider body, and Git error values.

Fault injection executes once at every external-intent boundary: after durable
allocation intent, after directory creation, mid-bundle, after seed before
acknowledgement, after cgroup creation, after child spawn, after child exit,
during kill/drain, after seal, after quarantine ref creation, and mid-cleanup.
Each restart uses a new backend instance and must produce the expected recovery
trace with no duplicate allocation/process/import, blind retry, source mutation,
unproved deletion, hidden residual, or leaked canary.

The linked-worktree red control must successfully mutate a disposable source
common ref/config through `.git/commondir`. The selected private-profile green
control repeats the attack set and proves source absence, kernel denials, useful
private Git editing/commit, exact candidate import, and complete cleanup. #82 is
invalid if it tests only happy-path `git status` or mocks the confinement owner.

## Pseudocode gate verdict

- Research #76: closed and merged.
- Every success/refusal/failure/timeout/cancel/cleanup/restart/recovery state:
  closed above with legal transitions and external commit points.
- Interfaces, persistence, Git, confinement, process, and authority decisions:
  closed; no production choice is delegated to #82 or #85.
- Loggers, events, correlations, safe codes, metrics boundaries, diagnostic IDs,
  source maps, and debugger proof: normative.
- Visible-UI E2E: uses packaged Kogg plus real Git/filesystem/Ranex/Linux/process
  boundaries and independent negative controls.

The packet advances to prototype #82. The prototype may invalidate the selected
boundary with evidence; it may not silently widen authority or choose a fallback.

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
