# Durable projects and repository registry

Tracking: [#56](https://github.com/anthonykewl20/kogg/issues/56), research phase
[#59](https://github.com/anthonykewl20/kogg/issues/59).

## Status

Research is complete as of 2026-08-26. This packet contains no production code.
Production remains gated by the ordered pseudocode, prototype, and implementation
issues and by Foundation [#47](https://github.com/anthonykewl20/kogg/issues/47).

The research recommendation is a backend-owned, machine-local, versioned project
registry with transactional persistence. A project may contain multiple registered
repositories, but every V1 task must bind to exactly one registered repository.
The active project controls the Theia workspace; inactive projects remain registry
records and must not share terminals, runs, worktrees, or mutable workspace state.

## Scope and constraints

The registry must persist:

- project identity, display metadata, and lifecycle state;
- one or more canonical local Git repositories per project;
- the active project and sufficient state to restore it after restart;
- execution-policy references, never arbitrary command lines or environment maps;
- role-to-provider/model references, never credentials or prompt content; and
- repository selection for tasks, with exactly one repository per V1 task.

The registry is not the authority for workspace trust, provider credentials, Git
contents, task evidence, or Ranex verdicts. Those remain with their existing
authorities. A registry record never grants permission to execute repository code.

The backend is the only writer. The frontend receives redacted DTOs over Theia
JSON-RPC and requests mutations using expected revisions. Repository paths are
content-bearing personal data: they may be stored locally because they are required
for operation, but they must not appear in logs, diagnostics, support bundles, or
telemetry.

## Commit-pinned source ledger

External source is used for patterns only. No copied code is approved by this
research record.

| Source | Exact revision and license | Reviewed paths | Finding |
| --- | --- | --- | --- |
| [Eclipse Theia](https://github.com/eclipse-theia/theia/tree/647dd3c7091b25ef3fc735edb74b949e7a195754) | `v1.74.1`, commit `647dd3c7091b25ef3fc735edb74b949e7a195754` (2026-08-06); EPL-2.0 or GPL-2.0-only with Classpath Exception, with separately identified MIT/VS Code material | `packages/workspace/src/browser/workspace-service.ts`, `packages/workspace/src/node/default-workspace-server.ts`, `packages/core/src/browser/storage-service.ts`, `packages/process/src/node/process-manager.ts`, `packages/process/src/node/raw-process.ts` | Reuse Theia services and lifecycle hooks, but not recent-workspace or frontend storage as the Kogg authority. |
| [VS Code](https://github.com/microsoft/vscode/tree/6f17636121051a53c88d3e605c491d22af2ba755) | tag `1.103.2`, commit `6f17636121051a53c88d3e605c491d22af2ba755` (2025-08-20); MIT | `src/vs/platform/workspaces/electron-main/workspacesHistoryMainService.ts`, `src/vs/platform/storage/electron-main/storageMainService.ts`, `src/vs/workbench/services/workspaces/common/workspaceTrust.ts` | Separate application/workspace storage, canonicalize trust URIs, identify machine-local records, and join storage shutdown. |
| [GitButler](https://github.com/gitbutlerapp/gitbutler/tree/6ac7475042a480a8bf83b74c5223a0afd4a29718) | commit `6ac7475042a480a8bf83b74c5223a0afd4a29718` (2026-08-25); FSL-1.1-MIT future license | `crates/gitbutler-project/src/project.rs`, `crates/gitbutler-project/src/storage.rs`, `crates/gitbutler-project/src/controller.rs`, `apps/desktop/src/lib/project/projectsService.ts` | Canonical Git-dir identity, typed add outcomes, missing/corrupt registry recovery, recents, and relocation are useful patterns. The current license is not approved for reuse in a competing product. |
| [Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | vendored provenance commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25); MIT | `src/ranex/governed_execution/adapters/persistence/sqlite/journal.py`, `src/ranex/observability`, `docs/slices/done/SLICE-013-reconciler-reorder.md`, `SLICE-047-confinement-hardening.md`, Kogg's `packages/kogg-kernel/python/kogg_ranex_adapter.py` | Keep the registry separate from the evidence journal; preserve single-writer/recovery discipline and explicit process cleanup. |

Primary documentation reviewed:

- [Theia architecture](https://theia-ide.org/docs/architecture/) confirms the
  browser/Electron frontend and Node backend split and JSON-RPC boundary.
- [Theia preferences](https://theia-ide.org/docs/preferences/) documents that
  backend preferences expose only default and user scopes; repository-controlled
  workspace preferences are not an authoritative backend database.
- [Theia workspace trust](https://theia-ide.org/docs/workspace_trust/) requires
  execution-capable features to remain restricted until every opened root is trusted.
- [VS Code workspace trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust)
  establishes canonical folder decisions and fail-restricted behavior when roots change.
- [SQLite atomic commit](https://sqlite.org/atomiccommit.html) documents transaction,
  locking, flush, crash rollback, and hot-journal recovery behavior.
- [SQLite WAL](https://sqlite.org/wal.html) documents its concurrency and same-host
  filesystem restrictions. Kogg state must remain on a supported local filesystem.
- [Git `rev-parse`](https://git-scm.com/docs/git-rev-parse) provides the real Git
  boundary for resolving top-level worktrees, absolute Git dirs, bare repositories,
  and inside-worktree state.

## Source findings

### Theia 1.74.1

`WorkspaceService.openWorkspace` validates an existing directory or workspace
file and then opens a window, normally preserving the current window according to
`workspace.preserveWindow`. `WorkspaceService` records the current root at stop;
Electron joins the write in `onWillStop`, while browser tab close is fire-and-forget.
This is appropriate for presenting a selected project, but a successful workspace
open is not proof that a Kogg project-registry transaction committed.

`DefaultWorkspaceServer` stores an MRU list in `recentworkspace.json` under the
Theia configuration directory. It rewrites JSON, filters missing entries during
reads, and silently ignores some cleanup failures. It has no project schema,
revision, repository identity, role assignment, transactional relation, or
corruption quarantine contract. It must remain an MRU compatibility mechanism,
not the Kogg source of truth.

`LocalStorageService` uses browser `localStorage`, scopes keys by URL pathname,
falls back to memory, can be cleared wholesale after quota failure, and does not
offer compare-and-swap transactions. It is suitable only for disposable view
state. It must not store registry authority or the only copy of active-project
state.

Theia's `ProcessManager` registers a managed process, unregisters it on error or
termination, kills it before removal, and cleans registered processes at backend
stop. Any Kogg-created Git probe or later execution process must use an equivalent
register-before-spawn contract and Kogg-specific correlation metadata. Calling
Node `spawn` directly and registering afterward leaves an unobservable race and is
not acceptable.

### VS Code

VS Code stores recent workspaces in application-scoped, machine-targeted storage
and treats workspace storage as a separate lifecycle. Storage is warmed at known
phases and close operations join application shutdown. This supports a Kogg split
between global registry rows and project-scoped mutable state.

Workspace trust resolves canonical URIs before calculating trust, stores trust at
application/machine scope, reacts to changes from other windows, and recalculates
when folders change. Kogg must ask Theia's trust authority after each project
switch and before enabling terminals, tasks, debugging, providers, or Ranex. Kogg
must not copy a stale trust boolean into its registry.

### GitButler

GitButler identifies a repository using the resolved Git directory rather than
only the user-selected worktree path. Its add flow canonicalizes the selected path,
distinguishes missing path/not-directory/not-Git/bare/non-main-worktree/duplicate
outcomes, and matches duplicate projects by Git-dir identity. This is a strong
model for typed Kogg refusal outcomes.

Its project file is a full `projects.json` rewrite. On unreadable content the
controller renames the file to a numbered `maybe-broken` backup and refuses the
current startup, allowing a clean next start. That recovery visibility is useful,
but an uncoordinated full-file JSON rewrite is insufficient for Kogg's required
crash consistency and possible browser/Electron concurrency.

The frontend keeps last-opened and recent project IDs separately from backend
project data and removes stale IDs when a project is deleted. Kogg may mirror this
as cache-only UI state, while the backend registry remains authoritative.

### Ranex

Ranex's SQLite journal is evidence authority with its own verification and recovery
rules. Sharing that database with mutable project metadata would couple trust,
migration, retention, and failure domains. The Kogg project registry needs its own
database and diagnostics. It may reference Ranex session/run IDs later but must not
rewrite Ranex records.

Ranex records show that start-time reconciliation, per-session serialization,
timeouts, process-group cleanup, and residual-process checks are required for
credible recovery. The projects slice must adopt those lifecycle shapes even where
the initial registry operation creates no process.

## Pattern comparison and decision

| Candidate | Durability/concurrency | Security boundary | Decision |
| --- | --- | --- | --- |
| Theia `recentworkspace.json` | Full JSON rewrite; MRU only; weak recovery | Theia-wide config and path-bearing data | Reject as authority; interoperate only for workspace presentation. |
| Frontend `StorageService` | Local-storage quota/fallback behavior; no relational transaction | Frontend and URL-path scoped | Reject except cache-only, reconstructable UI preferences. |
| Workspace/folder preferences | Repository-owned files and incomplete backend scope | Untrusted repository can influence values | Reject for registry, execution policy, and roles. |
| Git config or `.kogg` inside repositories | Survives app reset but disappears with repo and is cloned/shared accidentally | Repository-controlled and may expose metadata | Reject for global authority. |
| Full-file project JSON | Simple and inspectable; requires bespoke locking, atomic replacement, migrations, and corruption recovery | Machine-local if carefully permissioned | Reject for production authority; acceptable only as an export format. |
| Dedicated machine-local SQLite registry | Transactions, revisions, integrity checks, locking, and crash recovery | Backend-only file with restrictive permissions | Select, subject to the mandatory real-boundary probe in #66. |
| Ranex journal tables | Transactional but couples unrelated schemas and retention | Violates evidence-authority separation | Reject. |

The production candidate is a dedicated SQLite file at the resolved Kogg state
root, conceptually `projects/registry.sqlite3`, with directory mode `0700` and file
mode `0600` where supported. Use rollback-journal mode initially rather than WAL:
the registry is small, writes are infrequent, and rollback mode avoids WAL's shared
memory/same-host deployment constraints. Synchronous durability must not be turned
off. The probe must validate the actual Node 22.23.2 and Electron 42.3.0 SQLite
runtime before this choice advances.

The database is backend-owned. A schema-version table and monotonic registry
revision support migrations and optimistic mutation requests. Each transaction
must enforce foreign keys, uniqueness of repository identity, and one active
project. Opening the Theia workspace occurs after the selection transaction; if
opening fails, recovery restores or clearly reports the prior active selection.
The UI must never display a switch as complete merely because the database write
or window navigation alone completed.

## Recommended data boundaries for pseudocode

The exact SQL belongs to #63, but the behavioral model should contain:

- `Project`: opaque UUID, display name, lifecycle status, created/updated times,
  and revision. Display names and times are not logged.
- `Repository`: opaque UUID, owning project UUID, canonical root URI, canonical
  Git-dir identity, availability status, and revision. Remote URLs are unnecessary
  and should not be stored; they may contain credentials or personal identifiers.
- `ActiveProject`: singleton project UUID plus registry revision and last successful
  restoration marker.
- `ExecutionProfileAssignment`: project UUID plus an allowlisted profile ID and
  structured policy references. No raw command, arguments, working-directory text,
  environment map, or credential material.
- `RoleAssignment`: project UUID, stable role ID, provider configuration ID, and
  model ID. Credentials remain in `kogg-providers`; prompt content is never stored
  here.
- Future `TaskRepositoryBinding`: task UUID and exactly one repository UUID, enforced
  by schema and service validation rather than frontend convention.

Canonical repository identity must come from a real Git query, not the presence of
a `.git` directory. Resolve and compare filesystem identity without case-folding or
string-prefix assumptions. Revalidate the repository and trust decision at every
execution boundary because paths, symlinks, mounts, and Git worktree metadata can
change after registration.

Removing a registry entry must never delete a repository, Git worktree, source
file, Ranex evidence, credential, or external process. If a project owns an active
run/task/session, removal refuses with typed blockers. Relocation is an explicit
revalidation mutation, not an automatic path search.

## Authority and isolation model

1. The backend registry is authoritative for project/repository membership,
   selection, execution-profile references, and role assignments.
2. Git is authoritative for repository/worktree identity and current availability.
3. Theia is authoritative for the currently presented workspace and workspace trust.
4. The provider package is authoritative for provider configuration and credentials.
5. Ranex is authoritative for governed sessions, evidence, gates, and verdicts.
6. The frontend is a projection. Its caches can be deleted without data loss.

A switch is a coordinated state transition, not a mutation of shared roots. The
target project must be loaded as the workspace for the preserved window; the prior
project's project-specific terminals and later run resources must be stopped,
detached, or refused according to the lifecycle specified in #63. Until trust and
restoration finish, execution-capable controls stay disabled. Inactive projects
must not contribute task configurations, terminals, environment, provider policy,
or AI workspace context to the active project.

## Process inventory and ownership

| Boundary | Creates a process? | Owner and required behavior |
| --- | --- | --- |
| Registry list/create/update/remove/restore | No | Kogg backend; bounded database operation with transaction and timeout/cancel result where applicable. |
| Repository validation/relocation | Yes, if implemented with system Git | Kogg projects backend; allocate operation/process correlation and register before spawn, use a closed constant argv shape, bounded output, timeout, cancel, process-tree cleanup, exit/reap verification. Never log argv, cwd, output, repository path, environment, or remote data. |
| Theia workspace switch/reload | No new Kogg child process | Theia owns frontend/window lifecycle; Kogg logs only coordinated switch state and safe IDs. |
| Existing terminals/tasks/debuggers | Possibly, but not created by registry mutations | Theia owns them. #63 must define refusal or cleanup before switch and prove no cross-project residual process. |
| Ranex kernel | No start required for registry operations | Existing Kogg kernel bridge owns it. Project restore must not implicitly start Ranex. Future governed work passes project/repository correlations through an approved contract. |
| Browser/Electron backend/frontend | Platform processes, not Kogg-created children | Observe disconnect/reconnect and restart, but do not double-register platform processes. |

No registry operation is allowed to shell-expand a path or invoke a user-selected
executable. If the Git CLI is selected, use a fixed executable resolved by an
approved runtime capability, fixed arguments, explicit cwd, minimal allowlisted
environment, bounded stdout/stderr, and no shell.

## Required lifecycle and observability contract

The proposed logger is `kogg:projects:registry` for persistence and project
mutations, `kogg:projects:switch` for coordinated switching/restoration, and
`kogg:projects:git` for a Git process boundary. Stable events must include:

- `registry.start.requested`, `registry.start.completed`, `registry.start.failed`;
- `registry.migration.started`, `.completed`, `.failed`;
- `registry.integrity.started`, `.completed`, `.failed`;
- `project.create|update|remove.requested`, `.started`, `.completed`, `.failed`,
  and `.refused` where policy prevents mutation;
- `repository.validate.requested`, `.started`, `.completed`, `.failed`, `.timeout`,
  `.cancelled`, `repository.process.registered`, `.started`, `.exit`,
  `.cleanup.started`, `.cleanup.completed`, `.cleanup.failed`;
- `project.switch.requested`, `.started`, `.completed`, `.failed`, `.timeout`,
  `.cancelled`, `.cleanup.started`, `.cleanup.completed`, `.cleanup.failed`;
- `project.restore.started`, `.completed`, `.failed`, `.degraded`;
- `registry.recovery.started`, `.completed`, `.failed`; and
- `registry.stop.started`, `.completed`, `.failed`.

Permitted structured fields are the applicable opaque `operationId`, `projectId`,
`repositoryId`, `taskId`, `runId`, `attemptId`, `sessionId`, `worktreeId`, a stable
failure/refusal code, duration bucket, count, process registration ID, and exit or
signal classification. Do not log project names, paths/URIs, Git output, remotes,
command arguments, environment, assignments, provider/model names, prompts, code,
diffs, credentials, cookies, authorization data, or raw database/request/response
bodies.

Every request reaches exactly one terminal event: completed, failed, refused,
timeout, or cancelled. Any acquired lock, transaction, process, listener, or
temporary state also reaches an explicit cleanup result. Restart reconciliation
emits recovery events only when recovery is actually attempted.

## Failure and recovery matrix

| Failure | Required visible behavior | Required recovery/evidence |
| --- | --- | --- |
| Registry absent on first start | Start with an empty registry, not an error | Create schema transactionally; integrity diagnostic passes. |
| Unsupported schema version | Refuse mutation and restoration | Preserve file untouched; report stable incompatible-schema failure. |
| Integrity/corruption failure | Fail closed; do not silently reset | Quarantine only through an explicit recovery flow, preserve evidence, and report recovery result without path. |
| Busy/competing writer | Bounded retry then typed timeout/refusal | No partial mutation; diagnostic reports writer contention without process details. |
| Crash or kill during write | Prior or complete transaction visible after restart | SQLite rollback recovery and integrity check; no mixed revision. |
| Registered path missing | Project remains visible but unavailable | Do not delete automatically; offer explicit relocate/remove actions. |
| Path is not Git, bare, unsupported worktree, or duplicate Git dir | Typed refusal before registry mutation | No row written; Git process exited/reaped and cleanup proved. |
| Symlink/canonical identity changes | Refuse execution and mark revalidation required | Explicit relocation/revalidation; never silently retarget. |
| Workspace open fails after active selection write | Visible switch failure; controls remain disabled | Restore prior active selection if still valid, otherwise enter no-active-project degraded state. |
| Frontend disconnects mid-switch | Backend transition remains authoritative | Reconnect reads operation/registry state; no duplicate switch mutation. |
| Cancel or timeout | User sees cancelled/timed-out state | Roll back transaction, terminate and reap owned process tree, remove temp state. |
| App restarts mid-switch | Do not claim the target was opened successfully | Reconcile active selection and actual workspace, then restore or degrade explicitly. |
| Project removal while work is active | Refuse with stable blocker code | No process is killed and no data is deleted as a side effect of a registry request. |
| Cleanup doubt or residual process | Release-blocking failure | Diagnostic fails until ownership and cleanup are proven. |

## Diagnostics required before implementation can close

Add new catalog entries owned by the eventual projects package or `kogg-core`:

- `projects.registry`: database reachable, supported schema, integrity valid,
  foreign keys enabled, and permissions not broader than supported platform rules;
- `projects.repositories`: registered repository counts and availability states can
  be computed without exposing paths;
- `projects.restoration`: active-project marker and last restoration state are
  internally consistent; and
- `projects.processes`: no hidden, stalled, orphaned, or residual Kogg-owned Git or
  switch-cleanup process exists.

Runtime checks must return safe summaries and stable codes only. Support bundles
must redact path-bearing fields entirely, not merely replace home-directory
prefixes. Each operational implementation file must declare the applicable
`diagnostic-coverage` ID. Tests must cover contributor failure, corruption,
unsupported schema, missing repo, contention/timeout, failed restoration, and
residual-process detection.

## Real UI E2E requirements for #68

Drive visible production browser and Electron controls with clean profiles:

1. Add two real temporary Git repositories as two projects, switch between them,
   and prove only the selected repository is visible and execution-enabled.
2. Give one project multiple repositories, create/select task fixtures through
   production UI, and prove each V1 task binds to exactly one repository.
3. Assign distinct execution profiles and role references, restart the app, and
   prove the active project and assignments restore without leaking across projects.
4. Remove or relocate a registered repository on disk, restart, and prove a visible
   unavailable state plus successful explicit relocation.
5. Attempt non-Git, duplicate, unsupported-worktree, and untrusted-repository paths
   through the UI and prove typed refusal/restricted behavior.
6. Kill the app during the real persistence/switch boundary, restart, and prove one
   complete registry revision, explicit recovery, and no false successful switch.
7. Force the principal Git timeout/cancel/failure and prove start, exit/timeout,
   cleanup, and no residual process using OS-level evidence.
8. Run diagnostics and debugger/source-map checks in browser frontend, Node backend,
   Electron main/renderer, and any affected process adapter. Attach only redacted
   logs, screenshots, diagnostic output, and process evidence.

Direct service calls, mocked owned boundaries, pre-generated registry files, fake
Git success, hidden UI controls, or filesystem assertions without visible workflow
evidence do not satisfy the E2E gate.

## Rejected approaches

- Treating a Theia workspace, folder, or MRU entry as a Kogg project. It cannot
  represent multiple repositories, policy/role assignments, or durable lifecycle.
- Keeping all projects in one multi-root workspace. It violates isolation and lets
  tasks, settings, search, terminals, extensions, and AI context cross project bounds.
- Trusting frontend validation or a stored `trusted` field. Paths and trust can
  change after registration; execution must ask the current backend/Git/Theia
  authorities.
- Detecting Git via `.git` directory existence. Worktrees and submodules may use a
  `.git` file, bare repositories differ, and canonical Git-dir identity is required.
- Automatically deleting missing projects or searching the disk for replacements.
  Both can silently retarget authority and hide operational failure.
- Storing raw commands, argument arrays, environment maps, prompts, or credentials
  as execution settings. Store allowlisted references and resolve them at an
  execution-policy boundary.
- Sharing Ranex's evidence journal or provider credential store. The schemas,
  retention, recovery, and trust authorities are intentionally separate.
- Copying GitButler code under its current FSL license. Pattern observation is the
  only approved use without an explicit provenance, license, and product review.
- Declaring success after unit tests or workspace navigation. Crash recovery,
  process cleanup, real Git, real persistence, visible UI, diagnostics, and debugger
  reachability are release gates.

## Prototype recommendation

After decision-complete pseudocode, #66 should probe the riskiest combined boundary:
the dedicated SQLite registry in both pinned Node and Electron runtimes under
concurrent writer contention and forced process termination. The probe should create
and migrate a real schema, run a fixed real-Git canonicalization query, kill the
writer at controlled commit stages, restart, verify integrity/revision/rollback,
and prove the Git child is registered before start and absent after success,
failure, timeout, and cancel.

If the pinned runtimes cannot provide a supported SQLite API without an unacceptable
native rebuild or packaging gap, the probe must fail and reopen #63. It must not
silently fall back to frontend storage or uncoordinated JSON.

### Prototype findings (issue #66)

The disposable probe is preserved on branch
`prototype/issue-66-projects-registry` at commit `2a4a95359`. It exercised real
SQLite, filesystem, Git, and subprocess boundaries on 2026-08-26.

| Probe | Measured result |
| --- | --- |
| Pinned browser/backend runtime | Node 22.23.2 loaded built-in `node:sqlite`, created the schema, enabled foreign keys, and returned `integrity_check=ok`. Node identifies this API as experimental, so exact runtime pinning and the `projects.registry` runtime diagnostic remain mandatory. |
| Packaged Electron runtime | `ELECTRON_RUN_AS_NODE=1` with Electron 42.3.0 used embedded Node 24.15.0 and SQLite 3.51.3 to create, write, read, and close an in-memory database successfully. No native addon or Electron rebuild was required. |
| Real repository identity | A real temporary `git init` repository and the fixed `git rev-parse` query returned four bounded fields: canonical top level, absolute Git dir, `bare=false`, and `inside-work-tree=true`. The identity digest was derived from the canonical Git-dir file URI. |
| Register-before-start and safe trace | The process registration event preceded the validation-start event. An explicit trace-field allowlist rejected unknown fields, and assertions proved the temporary path, repository path, and `rev-parse` arguments never entered trace output. |
| Kill before commit | A writer was sent `SIGKILL` after `BEGIN IMMEDIATE` and insert but before commit. Restart showed zero marker rows and `integrity_check=ok`. |
| Kill after commit | A writer committed and was then sent `SIGKILL`. Restart showed exactly one marker row and `integrity_check=ok`. |
| Competing writer | One real process held `BEGIN IMMEDIATE`; a second connection reached the bounded SQLite busy error. After killing the holder, restart showed no uncommitted marker and passed integrity. |
| Timeout and cleanup | A real hanging subprocess reached the timeout terminal, its process group was killed and reaped, cleanup completed, and the live-process registry returned to zero. |

The observed event sequence contained registration, start, success/timeout, cleanup
start, and cleanup completion. All temporary repositories and databases were removed
after the run.

Prototype verdict: the selected dedicated SQLite design is validated for the pinned
Node and Electron runtimes. Rollback-journal crash behavior, writer contention, real
Git identity, safe logging, and owned-process cleanup behaved as required. Production
must retain exact runtime pins, must not use Theia `RawProcess`, and must repeat the
kill/contention/cleanup cases in automated integration and visible E2E coverage.

## Decision-complete production pseudocode

This section is the design input for #63. Names, boundaries, terminal states, and
ordering are normative for the prototype and production phases.

### Package and runtime topology

Create `packages/kogg-projects` as a Theia extension with these entry points:

```text
packages/kogg-projects/src/
  common/projects-protocol.ts
  browser/frontend-module.ts
  browser/projects-contribution.ts
  browser/projects-widget.ts
  node/backend-module.ts
  node/project-registry.ts
  node/project-repository-probe.ts
  node/project-workspace-projection.ts
  node/project-diagnostic-contributor.ts
```

`@kogg/contracts` owns only cross-package immutable DTOs and service types. The
new package owns SQL, mutations, process management, workspace projections, UI,
and diagnostics. Both apps depend on `@kogg/projects`; no code path dynamically
enables the extension.

The Node backend is the sole registry writer. Use Node's built-in `node:sqlite`
`DatabaseSync` API behind an injected `ProjectRegistryDatabase` port. Synchronous
calls are allowed only inside short, bounded registry transactions; no Git,
filesystem traversal, network call, or UI wait occurs while a transaction is open.
The packaged Electron backend uses its bundled Node API, not renderer SQLite.

The registry path is `${KOGG_STATE_DIR}/projects/registry.sqlite3`, falling back to
the same resolved Kogg state root used by diagnostics and Ranex. The generated
workspace projection directory is `${stateRoot}/projects/workspaces`. Directory
and file permissions are restricted when supported. Registry paths never enter
frontend DTOs except repository root URIs required to open/browse the selected
workspace; diagnostics and logs never contain them.

### Closed DTO and service contract

```ts
type ProjectId = string;       // UUID v4, validated and opaque
type RepositoryId = string;    // UUID v4, validated and opaque
type OperationId = string;     // UUID v4, validated and opaque
type RegistryRevision = number; // positive safe integer

type ProjectLifecycle = 'available' | 'unavailable';
type RepositoryAvailability = 'available' | 'missing' | 'invalid' | 'revalidation-required';
type BuiltInRole =
  | 'orchestrator' | 'architect' | 'planner' | 'worker' | 'researcher'
  | 'test-writer' | 'test-executor' | 'reviewer' | 'security-reviewer'
  | 'performance-reviewer' | 'documentation-agent' | 'migration-agent'
  | 'release-agent' | 'integrator' | 'verification-agent';

interface RepositorySummary {
  id: RepositoryId;
  displayName: string;
  rootUri: string;
  availability: RepositoryAvailability;
  revision: RegistryRevision;
}

interface ProjectSummary {
  id: ProjectId;
  displayName: string;
  lifecycle: ProjectLifecycle;
  repositories: readonly RepositorySummary[];
  executionProfileId?: string;
  roleAssignments: Readonly<Partial<Record<BuiltInRole, {
    providerConfigurationId: string;
    modelId: string;
  }>>>;
  revision: RegistryRevision;
}

interface ProjectRegistrySnapshot {
  schemaVersion: 1;
  revision: RegistryRevision;
  activeProjectId?: ProjectId;
  pendingSwitch?: { operationId: OperationId; fromProjectId?: ProjectId; toProjectId: ProjectId };
  projects: readonly ProjectSummary[];
}

interface MutationExpectation {
  expectedRegistryRevision: RegistryRevision;
  requestId: OperationId;
}

interface ProjectSwitchTicket {
  operationId: OperationId;
  projectId: ProjectId;
  workspaceUri: string;
  expectedRegistryRevision: RegistryRevision;
}

interface KoggProjectsService {
  snapshot(): Promise<ProjectRegistrySnapshot>;
  createProject(request: MutationExpectation & { displayName: string; repositoryPath: string }): Promise<ProjectRegistrySnapshot>;
  renameProject(request: MutationExpectation & { projectId: ProjectId; displayName: string }): Promise<ProjectRegistrySnapshot>;
  removeProject(request: MutationExpectation & { projectId: ProjectId }): Promise<ProjectRegistrySnapshot>;
  addRepository(request: MutationExpectation & { projectId: ProjectId; displayName: string; repositoryPath: string }): Promise<ProjectRegistrySnapshot>;
  relocateRepository(request: MutationExpectation & { projectId: ProjectId; repositoryId: RepositoryId; repositoryPath: string }): Promise<ProjectRegistrySnapshot>;
  removeRepository(request: MutationExpectation & { projectId: ProjectId; repositoryId: RepositoryId }): Promise<ProjectRegistrySnapshot>;
  setExecutionProfile(request: MutationExpectation & { projectId: ProjectId; executionProfileId?: string }): Promise<ProjectRegistrySnapshot>;
  setRoleAssignment(request: MutationExpectation & { projectId: ProjectId; role: BuiltInRole; assignment?: { providerConfigurationId: string; modelId: string } }): Promise<ProjectRegistrySnapshot>;
  requestSwitch(request: MutationExpectation & { projectId: ProjectId }): Promise<ProjectSwitchTicket>;
  reconcileWorkspace(request: { requestId: OperationId; currentWorkspaceUri?: string }): Promise<{ snapshot: ProjectRegistrySnapshot; action: 'none' | 'open'; workspaceUri?: string }>;
  cancelSwitch(request: { requestId: OperationId; operationId: OperationId }): Promise<ProjectRegistrySnapshot>;
}
```

The JSON-RPC path is `/services/kogg-projects`. All objects are validated as
closed shapes at the backend boundary: unknown properties, malformed UUIDs,
unsupported roles, non-file URIs, invalid display-name length, unsafe profile IDs,
and unexpected revisions refuse. Strings have explicit byte/character bounds.
Errors cross RPC as stable Kogg error codes plus safe user messages; stack traces
remain in the debugger/logger pipeline and are never returned as raw bodies.

`repositoryPath` is accepted only as an input to a user-initiated add/relocate
operation. The backend converts it to a file URI and never echoes a failed path in
an error. Successful `rootUri` values are returned because the file navigator and
workspace open require them; frontend code must not log service payloads.

### SQL schema and invariants

At database open, execute `PRAGMA foreign_keys = ON`, a bounded busy timeout, and
the selected synchronous rollback-journal configuration. Refuse if foreign keys
cannot be proven enabled. Schema version 1 is:

```sql
CREATE TABLE registry_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  active_project_id TEXT NULL,
  pending_operation_id TEXT NULL,
  pending_from_project_id TEXT NULL,
  pending_to_project_id TEXT NULL,
  pending_started_at TEXT NULL,
  CHECK ((pending_operation_id IS NULL AND pending_to_project_id IS NULL AND pending_started_at IS NULL)
      OR (pending_operation_id IS NOT NULL AND pending_to_project_id IS NOT NULL AND pending_started_at IS NOT NULL))
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  execution_profile_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1)
);

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  root_uri TEXT NOT NULL,
  git_dir_uri TEXT NOT NULL UNIQUE,
  identity_digest TEXT NOT NULL UNIQUE,
  availability TEXT NOT NULL CHECK (availability IN ('available','missing','invalid','revalidation-required')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  UNIQUE(project_id, root_uri)
);

CREATE TABLE role_assignments (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  provider_configuration_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  PRIMARY KEY(project_id, role_id)
);

CREATE TABLE request_results (
  request_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  terminal_state TEXT NOT NULL CHECK (terminal_state IN ('completed','failed','refused','timeout','cancelled')),
  resulting_revision INTEGER NULL,
  safe_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

After creating `projects`, rebuild `registry_meta` with foreign keys from active and
pending project IDs to `projects(id)` using `ON DELETE RESTRICT`; the ordering above
is illustrative for readability, while the migration uses valid SQLite creation
order. Production migration SQL is embedded, numbered, transactional, and hashed
in a test. There is exactly one `registry_meta` row.

Every successful mutation increments the global revision once and the mutated row
revision once in the same `BEGIN IMMEDIATE` transaction. The request ID and a digest
of normalized, non-secret request fields make mutations idempotent across reconnect:
same ID/same digest returns the recorded result; same ID/different digest refuses
`PROJECT_REQUEST_REPLAY_MISMATCH`. Retain bounded request-result history by age/count
only after the new result commits.

Project lifecycle is derived: `available` only when at least one repository exists
and all workspace roots required by the project are available. Timestamps are stored
for ordering and recovery but omitted from logs. Role/provider/model IDs are stored
as values, never dereferenced inside a SQL transaction.

### Startup, shutdown, and migration

```text
backend onStart
  emit registry.start.requested
  resolve and permission-check state directories
  open registry with create=false if it exists
  if absent:
    create temporary database in same directory
    apply schema v1 transaction; integrity_check; close
    atomically rename to registry.sqlite3; sync directory where supported
  else:
    read user_version/schema meta without mutating
    if newer than supported -> refuse service startup
    if older -> backup once, run ordered migration in BEGIN IMMEDIATE, integrity_check
  run quick_check and foreign_key_check
  inspect pending switch and request-result bounds
  expose service only after startup reaches completed/degraded/refused state
  emit exactly one registry.start terminal event

backend onStop
  reject new mutations with PROJECTS_SHUTTING_DOWN
  cancel/reap every owned repository probe
  wait for current transaction to finish within shutdown bound
  close database and join BackendApplicationContribution shutdown
  emit registry.stop terminal and cleanup events
```

Corruption never causes automatic empty-registry replacement. Startup marks the
service unavailable, diagnostics fail, and an explicit future support workflow may
copy/quarantine the database. No migration deletes rows or lowers schema version.

### Repository probe

The repository probe is a Kogg-managed process, not Theia `RawProcess`: that class
logs executable arguments/options through the generic `process` logger. Implement
`KoggGitProcess` by extending Theia `Process` so `super(...)` registers it with
`ProcessManager` before the subclass spawns. Override exit/error logging to emit
only the safe Kogg lifecycle contract.

Use one resolved `git` executable capability and no shell. The fixed invocation is
equivalent to:

```text
git rev-parse --path-format=absolute --show-toplevel --absolute-git-dir
               --is-bare-repository --is-inside-work-tree
```

The argument array is constant in code and never logged. `cwd` is the selected path;
the environment is a minimal allowlist (`PATH`, locale forced to `C`, and Git
terminal prompting disabled). Bound each output stream to 16 KiB and the operation
to 10 seconds. Extra output, spawn error, nonzero exit, malformed line count, bare
repository, not-inside-worktree, missing canonical paths, or timeout is a typed
refusal/failure. Kill the process group where supported, await close/reap, unregister,
and only then emit cleanup completed.

Canonicalize returned root and Git-dir paths with real filesystem resolution. Build
`identity_digest = sha256("kogg-git-dir-v1\0" + canonicalGitDirFileUriBytes)` for
uniqueness; the digest is safe to log only if approved, but production logs should
prefer repository ID. Re-stat immediately before commit. A duplicate digest returns
`PROJECT_REPOSITORY_ALREADY_REGISTERED` and the existing project/repository IDs,
without revealing a path.

### Create, add, relocate, update, and remove

```text
createProject(request)
  validate closed request; emit project.create.requested
  deduplicate/replay-check request ID
  emit repository.validate.started and run real Git probe outside transaction
  if probe terminal != completed -> record safe request result; emit matching terminals; return/throw typed result
  BEGIN IMMEDIATE
    assert expected global revision
    assert Git identity not registered
    insert project and first repository with generated IDs
    increment global revision; insert completed request result
  COMMIT
  generate project workspace projection atomically from committed snapshot
  if projection fails -> compensating transaction marks repository revalidation-required and operation failed; never report completed
  emit project.create.completed; return fresh snapshot
```

`addRepository` is the same shape against an existing project. `relocateRepository`
requires the same canonical Git-dir identity as the existing row; if identity
differs, refuse and require remove/add so relocation cannot silently retarget a
project. It updates root URI, availability, revisions, and the workspace projection.

Rename, execution profile, and role mutations validate entirely before `BEGIN
IMMEDIATE`. Execution profile IDs must exist in a Kogg-owned allowlist service.
Provider configuration/model references are checked through metadata-only provider
APIs outside the transaction; missing credentials do not erase assignments but
make later execution unavailable.

Removing a repository refuses if it is the project's last repository, is bound to
any task, or participates in an active/pending run/worktree/session. Removing a
project refuses when active, pending, or referenced by any task/run/worktree/session.
Successful registry removal deletes only Kogg registry/projection rows and the
generated workspace file; it never deletes source, Git metadata, worktrees,
credentials, evidence, terminals, or processes. Projection-file deletion is
recoverable cleanup after the database commit and has explicit failure diagnostics.

### Workspace projection and switching

Each project has a generated `<projectId>.theia-workspace` containing only a
version marker and its committed repository root URIs in deterministic repository-ID
order. It contains no tasks, launch configuration, settings, execution profiles,
roles, prompts, credentials, or provider data. Write a same-directory temporary,
flush, rename, and sync directory. Validate the parsed projection before publishing.

Switching uses a durable two-phase handshake because `WorkspaceService.open` causes
navigation/reload and cannot acknowledge completion in the old frontend:

```text
requestSwitch(target)
  validate revision and target availability
  if target is already active and no pending switch -> return an idempotent ticket
  ask lifecycle participants whether switching is blocked
  if blocked -> emit project.switch.refused with safe blocker code
  BEGIN IMMEDIATE
    recheck revision/availability
    set pending operation/from/to/start time; increment revision
    record request result as completed-for-request (not switch completed)
  COMMIT
  emit project.switch.started
  return target workspace URI and operation ID

frontend
  disable project execution controls
  call WorkspaceService.open(ticket.workspaceUri, { preserveWindow: true })
  if synchronous validation fails, call cancelSwitch and show safe error
  do not emit or display switch completed in the old frontend

new frontend onStart
  call reconcileWorkspace(new request ID, WorkspaceService.workspace?.resource)

reconcileWorkspace(actual)
  if pending target projection canonically equals actual workspace:
    verify every repository availability and projection digest
    BEGIN IMMEDIATE set active=target, clear pending, increment revision COMMIT
    emit project.switch.completed and project.restore.completed
    return action none
  if pending exists but actual equals prior active projection:
    clear pending as cancelled/recovered; emit cleanup/recovery completed
    return action none
  if pending exists and actual matches neither:
    clear pending; retain prior active; emit project.switch.failed and recovery
    return action open with prior projection when valid
  if no pending and actual equals active projection:
    revalidate; emit project.restore.completed; return none
  if no pending and active is valid but actual differs:
    emit project.restore.degraded; return action open with active projection
  if no valid active:
    clear active only by transaction when referenced row is invalid/missing
    emit project.restore.degraded; return no-action empty dashboard
```

The frontend performs at most one recovery navigation per startup token; a repeated
mismatch refuses with `PROJECT_RESTORE_LOOP` and leaves the dashboard execution-
disabled. Workspace trust is awaited after reconciliation. Controls enable only
when registry reconciliation, repository availability, projection validation, and
Theia trust all succeed.

`cancelSwitch` only clears the exact pending operation. A stale/mismatched operation
ID refuses. Timeout is 30 seconds from the durable pending start; startup or a
diagnostic reconciliation may terminalize an expired pending switch. Cancellation
and timeout retain the prior active project.

### Isolation and lifecycle participants

Define backend and frontend `ProjectLifecycleParticipant` contribution points with
stable IDs and bounded `prepare`, `commit`, `rollback`, and `diagnoseResiduals`
methods. Initial contributors cover workspace projection and the Kogg projects UI.
Later worktree/task/terminal/run packages must register before creating resources.

For V1, existing generic Theia terminals/tasks/debuggers are platform-owned. A
project switch uses a full workspace navigation, must not reattach their UI state to
the target project, and does not claim to have killed arbitrary user processes.
Every Kogg-created project terminal/run in later slices is tagged by project and
repository IDs, blocks or cleans up before switch, and is checked for residuals.
The projects diagnostic fails if any Kogg-owned resource reports a different project
than the active project.

No role assignment starts a provider, agent, CLI, terminal, task, debugger, or Ranex
session. It is inert metadata until an independently authorized governed execution.

### UI behavior

Add a Kogg Projects view and `Kogg: Projects` command. The view has a project list,
active/unavailable/pending indicators, create/add/relocate/remove/rename actions,
repository list, execution-profile selector, and fixed-role assignment editor.
File selection uses Theia's directory picker; free-text path entry is not the normal
flow. Destructive registry removal requires a confirmation that explicitly says
source files are not deleted.

Every mutation shows an in-progress state keyed by request ID, disables duplicate
submission, and ends in success, refusal, failure, timeout, or cancellation. On RPC
disconnect it reloads the backend snapshot; it never assumes failure or retries a
mutation with a new request ID automatically. Stale revision returns a visible
refresh-and-retry state. Unavailable projects stay visible with Relocate and Remove.

The active project list is global. Editor, search, source control, workspace tasks,
and navigator remain Theia projections of only the active project's generated
workspace. The UI never renders a raw registry database error or logs DTO payloads.

### Exact safe failure/refusal codes

The closed initial code set is:

```text
PROJECTS_UNAVAILABLE
PROJECTS_SHUTTING_DOWN
PROJECT_REQUEST_INVALID
PROJECT_REQUEST_REPLAY_MISMATCH
PROJECT_REVISION_CONFLICT
PROJECT_NOT_FOUND
PROJECT_ACTIVE_REMOVE_REFUSED
PROJECT_IN_USE
PROJECT_REPOSITORY_NOT_FOUND
PROJECT_REPOSITORY_PATH_MISSING
PROJECT_REPOSITORY_NOT_GIT
PROJECT_REPOSITORY_BARE_UNSUPPORTED
PROJECT_REPOSITORY_WORKTREE_UNSUPPORTED
PROJECT_REPOSITORY_ALREADY_REGISTERED
PROJECT_REPOSITORY_IDENTITY_CHANGED
PROJECT_REPOSITORY_PROBE_FAILED
PROJECT_REPOSITORY_PROBE_TIMEOUT
PROJECT_REPOSITORY_PROBE_CANCELLED
PROJECT_REPOSITORY_OUTPUT_INVALID
PROJECT_LAST_REPOSITORY_REMOVE_REFUSED
PROJECT_EXECUTION_PROFILE_INVALID
PROJECT_ROLE_INVALID
PROJECT_PROVIDER_REFERENCE_INVALID
PROJECT_SWITCH_BLOCKED
PROJECT_SWITCH_STALE
PROJECT_SWITCH_TIMEOUT
PROJECT_SWITCH_CANCELLED
PROJECT_WORKSPACE_PROJECTION_FAILED
PROJECT_WORKSPACE_UNTRUSTED
PROJECT_RESTORE_FAILED
PROJECT_RESTORE_LOOP
PROJECT_REGISTRY_BUSY
PROJECT_REGISTRY_INTEGRITY_FAILED
PROJECT_REGISTRY_SCHEMA_UNSUPPORTED
PROJECT_PROCESS_CLEANUP_FAILED
```

Unknown internal errors map to `PROJECTS_UNAVAILABLE` for the client and retain the
original cause in safe backend error logging/debugger state.

### Test and expected-trace contract

Unit tests use an injected temporary local database and real filesystem fixtures.
Only the Git process port may be substituted in narrow service unit tests; separate
integration/prototype/E2E tests use real Git. Required tests cover every code above,
schema and migration hash, revision races, idempotent replay, replay mismatch,
transaction rollback, corrupt/newer database refusal, generated projection
determinism, failed projection compensation, add/relocate identity, missing repo,
switch two-phase success, stale/cancel/timeout/reconnect/restart recovery, restore
loop prevention, safe logging field allowlists, process register-before-spawn,
bounded streams, and cleanup failure.

A successful switch trace is exactly:

```text
project.switch.requested
project.switch.started
project.restore.started
project.switch.completed
project.restore.completed
```

A Git timeout trace includes:

```text
repository.validate.requested
repository.process.registered
repository.validate.started
repository.validate.timeout
repository.process.cleanup.started
repository.process.cleanup.completed
```

No operation may omit its terminal or cleanup trace. Tests assert event names and
safe field keys without snapshotting paths or content.

## Research gate verdict

- Commit-pinned sources and licenses: recorded.
- Reuse and rejected approaches: recorded.
- Theia, Ranex, security, and observability constraints: compared.
- Processes, lifecycle events, failures, recovery, diagnostics, and E2E: enumerated.
- Recommended authority, persistence, isolation, and prototype boundary: explicit.

This is sufficient input for #63. It does not authorize production implementation.
