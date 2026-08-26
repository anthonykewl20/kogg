# Governed Codex CLI adapter

Tracking: [#86](https://github.com/anthonykewl20/kogg/issues/86), research
phase [#89](https://github.com/anthonykewl20/kogg/issues/89), pseudocode phase
[#90](https://github.com/anthonykewl20/kogg/issues/90).

## Status

Research, decision-complete pseudocode, and the bounded real-boundary prototype
are complete as of 2026-08-27. This packet contains no production code. The #91
measurements are recorded in `codex-adapter-prototype-findings.md`; they validate
the stdio lifecycle but refuse production qualification. Production implementation
and real E2E in #92 remain blocked on the exact release manifest, scoped credential
broker, and qualified Linux execution profile required below.

The recommendation is one pinned `codex app-server --listen stdio://` process
per Kogg attempt, launched inside a qualified Linux execution scope and a
private per-run Git repository. Kogg owns authorization, the immutable
role/provider/model snapshot, deadlines, process registration, cancellation,
cleanup proof, durable lifecycle, recovery, and safe observability. Codex owns
only its protocol session and descendants while the Kogg supervisor remains the
outer process authority. Provider completion is not Kogg completion, and neither
is cleanup proof.

V1 must fail closed when the Codex binary or generated protocol schema does not
match the qualified digest, the requested model changes or falls back, an
unapproved capability is exposed, the confinement profile is weaker than the
qualified profile, an approval would require new authority, or any process is
unregistered or remains after cleanup.

## Scope and invariants

This slice must eventually run real Codex while preserving these boundaries:

- the source checkout is never mounted into the run; Codex sees only the
  controller-created private repository described by the execution decision;
- one frozen Kogg attempt selects an exact adapter, Codex binary, protocol
  schema, model, permission profile, execution profile, and credential grant;
- Kogg registers the app-server process before spawn and accounts for all of its
  descendants, including shell commands, background terminals, MCP servers,
  hooks, skills, plugins, browser/computer-use helpers, and subagents;
- the child receives a minimal constructed environment, private `CODEX_HOME`,
  private scratch home, bounded writable roots, and no ambient user config;
- prompts, reasoning, model output, source, diffs, command arguments/output,
  paths, environments, credentials, raw protocol frames, and provider bodies
  never enter Kogg logs, diagnostics, metrics, durable lifecycle rows, or error
  strings;
- interruption, protocol EOF, process exit, and provider terminal events are
  observations, not proof that descendants stopped;
- no retry, resume, model fallback, permission widening, or adapter failover is
  implicit; a new attempt needs explicit policy authority; and
- worktree qualification, evidence, verdict, and merge authority retain their
  existing owners. The adapter cannot self-qualify its output.

## Commit-pinned source ledger

External code is used for patterns only. No copied implementation is approved
by this research record.

| Source | Exact revision and license | Reviewed paths | Security and maintenance result |
| --- | --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex/tree/bde9db1375667c50dcc0c2b52532a4e2672571c2) | commit `bde9db1375667c50dcc0c2b52532a4e2672571c2` (2026-08-26); Apache-2.0 | `codex-rs/app-server/README.md`; `app-server/src/lib.rs`, `main.rs`, `message_processor.rs`, `request_processors/thread_processor.rs`; `app-server-protocol/src/protocol`; `app-server/tests/suite/v2/turn_interrupt.rs`; `linux-sandbox/README.md`; `process-hardening/README.md`; `config/src/shell_environment_policy.rs` | Select the versioned stdio app-server lifecycle, generated schema, ephemeral thread, explicit interrupt, and background-terminal inventory patterns. The protocol and experimental surface move quickly, so binary plus schema provenance is a release gate. Codex cooperation does not prove confinement or cleanup. |
| [Eclipse Theia](https://github.com/eclipse-theia/theia/tree/647dd3c7091b25ef3fc735edb74b949e7a195754) | `v1.74.1`, commit `647dd3c7091b25ef3fc735edb74b949e7a195754` (2026-08-06); EPL-2.0 or GPL-2.0-only with Classpath Exception, with separately identified MIT/VS Code material | `packages/ai-codex/README.md`; `src/common/codex-service.ts`; `src/node/codex-service-impl.ts`; `src/browser/codex-frontend-service.ts`, `codex-chat-agent.ts` | Keep Theia contribution and streaming presentation seams only. Reject its current SDK wrapper as the governed boundary: browser-sourced secrets/options, ambient workspace selection, in-memory sessions, abort-only cancellation, full-access mode, and content-bearing error logging do not meet Kogg authority or observability. |
| [Node.js](https://github.com/nodejs/node/tree/490a9fef8f8adcda5a95bd6f96035b05cb43fe5b) | `v22.23.2`, commit `490a9fef8f8adcda5a95bd6f96035b05cb43fe5b` (2026-01-13); MIT | `lib/child_process.js`; `doc/api/child_process.md`; `test/parallel/test-child-process-abortcontroller.js` | Use explicit stdio ownership, spawn/error/exit/close distinctions, backpressure, and bounded drain patterns. A Node child handle or abort signal cannot prove the Linux descendant tree is gone, so cgroup/process reconciliation stays outside the transport wrapper. |
| [Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | vendored provenance commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25); MIT | `src/ranex/cli/delegation.py`; `src/ranex/observability/schema.py`, `redaction.py`; `docs/adr/ADR-010-first-delegation.md`, `ADR-015-durable-execution-watchdog-first.md`, `ADR-033-kernel-owned-delegated-provider-credential-broker.md`; `docs/slices/done/SLICE-012-provider-watchdog.md` | Preserve register-before-spawn, empty-by-default environments, process-group ownership, idle and absolute deadlines, bounded cleanup, startup reconciliation, closed safe events, and kernel-owned credential capabilities. Kogg must not duplicate Ranex authority or emit its content-bearing tails. |

The Codex repository was read at the exact pin above rather than relying on
unversioned hosted documentation. Its app-server README labels several APIs as
experimental or unstable. That status is material: #90 must define a closed
accepted method/event set generated for the qualified binary, and #91 must prove
that an unexpected method, event, or schema shape fails safely.

## Source findings

### Codex app-server transport and lifecycle

The app server defaults to newline-delimited JSON over stdio and requires an
`initialize` request followed by the `initialized` notification before normal
requests. It exposes correlated `thread/start`, `turn/start`, item events, and a
terminal `turn/completed` status. `thread/start` supports `ephemeral: true`, which
keeps the thread in memory and returns no persisted thread path. These are strong
adapter primitives because Kogg can bind protocol identifiers to its own attempt
without parsing human-readable terminal output.

Stdio is selected for V1. Experimental websocket transport adds listening,
authentication, connection, and multiplexing states without improving the
single-attempt boundary. A Unix control socket also lives under `CODEX_HOME` and
is unnecessary. The adapter must parse stdout as protocol only, bound both
directions, reject non-protocol stdout, and treat EOF before an accepted terminal
sequence as failure. Stderr is never forwarded to lifecycle logs because Codex
tracing can contain request or content details.

The app server uses bounded internal queues and can report retryable overload.
Kogg must apply backpressure and a bounded local queue, but cannot automatically
replay a turn: replay may duplicate filesystem, command, network, or provider
side effects. Overload before accepted `turn/start` is still a typed failed
attempt unless a later policy explicitly authorizes a new attempt.

Only one app-server process can hold a paginated stored thread for writing, and
resume can inherit persisted model choices. V1 therefore uses one ephemeral
thread for one attempt and does not resume or fork. This reduces persistence but
does not erase content already present in process memory or provider traffic.
Kogg still supplies a private, short-lived `CODEX_HOME` and destroys or
quarantines it according to the outer cleanup result.

### Cancellation and shutdown are cooperative

`turn/interrupt` leads to `turn/completed` with interrupted status and resolves
pending approval requests. The protocol explicitly leaves background terminals
running. Separate experimental methods list, terminate, and clean those
terminals. Their listing includes command and working-directory data, which may
be used transiently for control but must not be logged or persisted.

On an ordinary stdio disconnect, app-server drains connection RPCs, background
tasks, and threads. Thread shutdown is bounded at ten seconds and warns about
submission failures or timeouts before continuing. A forced shutdown can skip
that graceful work. Therefore none of these events proves cleanup:

- an interrupt response;
- `turn/completed` interrupted, failed, or completed;
- successful terminal-clean request submission;
- protocol EOF;
- app-server exit; or
- the app-server's internal diagnostics reporting zero active turns.

Kogg must independently inspect its qualified Linux process/cgroup inventory and
require zero residual descendants. The experimental terminal APIs are useful as
an early cooperative cleanup step, not as the authority. If their schema is not
qualified for the pinned version, Kogg skips them and proceeds directly to outer
process-tree termination; it never enables the entire experimental API surface
merely to obtain them.

### Sandbox and process hardening

Codex's Linux sandbox selects Bubblewrap from `PATH` before a bundled helper,
contains compatibility fallback behavior, and can fall back to legacy Landlock.
It uses read-only root mounts, writable-root binds, user/PID/network namespaces,
fresh `/proc`, seccomp network filtering, and special Git metadata protection.
The process-hardening crate disables core dumps and same-user ptrace attachment
and removes dangerous preload variables before the main program.

These are valuable defense-in-depth, but ambient helper selection and weaker
fallback are incompatible with a qualified boundary. Kogg must either pin and
attest every Codex/helper byte and exact internal sandbox result or run Codex
under the already-qualified external Linux profile from the execution decision.
When `externalSandbox` is declared, Codex intentionally delegates enforcement;
Kogg may select it only when the outer owner proves mounts, network policy,
resource limits, process ownership, and cleanup. Failure to create the exact
profile is terminal; no unsandboxed or weaker retry is allowed.

The private run repository's `.git` is intentionally writable so Codex can make
commits, but it is not the user's source repository and shares no Git common
directory, objects, refs, alternates, hooks, or configuration with it. Confinement
must exclude the source checkout and user homes altogether.

### Configuration, environment, credentials, and capabilities

Codex configuration is layered and, by default, shell environment policy may
inherit all variables. `thread/start` can also mark a workspace trusted in the
user config when given writable/full permissions. Authentication can persist
tokens to `auth.json` or a keyring. This makes reuse of the user's `~/.codex`,
`HOME`, config, keyring, or inherited environment unacceptable.

The supervisor constructs a private home and `CODEX_HOME` before spawn, fixes
permissions to the run owner, sets shell inheritance to none, and allowlists only
non-secret operational variables. Credentials arrive through the qualified
credential broker or another decision-complete non-argv, non-loggable scoped
mechanism. #90 must not invent a raw environment-token shortcut. Credential
material must be revocable, provider/model scoped, unavailable to the browser,
and absent from diagnostics and support artifacts.

The app server includes APIs for commands, unsandboxed process spawning, direct
filesystem access, MCP, plugins, skills, apps, remote control, browser/computer
use, environments, hooks, memory, authentication changes, and experimental
review. Several can start hidden descendants or access absolute host paths. V1's
closed capability set excludes them unless #90 names the method, owner, policy,
and cleanup proof and #91 qualifies it. In particular:

- reject `process/spawn`, which is explicitly unsandboxed;
- reject direct command/exec and filesystem escape-hatch APIs;
- disable MCP servers, plugins, skills, apps, hooks, memory, remote control,
  realtime, browser/computer use, and environment executors;
- reject model/provider fallback and compare requested with observed model;
- do not expose login, logout, key mutation, or config mutation to the adapter;
- do not allow a provider-native guardian or automatic reviewer to widen the
  frozen grant; and
- treat an unexpected approval request as typed blocked/refused. It cannot hang
  indefinitely or be auto-approved from model output.

### Theia integration review

Theia's current `ai-codex` package dynamically imports `@openai/codex-sdk`,
creates in-memory thread and `AbortController` maps, selects the first workspace
root, and streams events to the frontend. It can pass an API key, working
directory, prompt, and `danger-full-access` option across its service boundary.
Cancellation aborts the stream and removes the controller but does not await a
terminal provider event or prove descendant cleanup. Threads remain in an
in-memory map without durable recovery.

The implementation logs session identifiers and caught errors, and browser code
logs path/error details. Those shapes risk content, path, personal, or provider
data and do not follow Kogg's closed event vocabulary. The package is suitable as
a reference for Theia contribution wiring and user-visible streaming conversion,
not as the governed adapter. Kogg's browser receives a safe lifecycle projection
from the backend and never owns credentials, process handles, cancellation
authority, or raw provider errors.

### Node supervision and Ranex comparison

Node distinguishes spawn failure, exit, and stdio close; close can occur after
exit because pipes drain independently. The wrapper must handle every ordering,
bound stdout/stderr memory, stop writing after cancellation, and join pipe drain
without waiting forever. `AbortController` is a useful request signal only.
Linux cgroup/process-group ownership supplies the descendant truth.

Ranex demonstrates the stronger outer pattern: create an allowlisted environment,
register before spawn, own the process group, apply separate idle and absolute
deadlines, cancel and join every child, and reconcile stranded work at startup.
Its closed observability schema is adopted conceptually, but Kogg does not copy
raw output tails or claim Ranex evidence authority. A Ranex run/verdict remains a
separate qualified record.

## Selected adapter boundary

The pseudocode in #90 must specify this sequence without unresolved choices:

1. Validate frozen task, role, provider, exact model, adapter, Codex binary and
   schema digests, execution profile, credential grant, and deadline policy.
2. Allocate the private repository, scratch home, `CODEX_HOME`, protocol buffers,
   and qualified Linux scope. Reject any shared Git or user-state path.
3. Create a durable process-intent record before spawn with safe opaque IDs and
   expected binary/profile provenance.
4. Spawn `codex app-server --listen stdio://` with fixed argv and a minimal
   constructed environment; bind PID/cgroup identity after successful spawn.
5. Perform the version-specific initialize handshake and compare the closed
   server capabilities. Any unknown required behavior or mismatch fails closed.
6. Start one ephemeral thread with the private repository cwd, explicit model,
   fallback disabled, fixed permission policy, and all optional capability roots
   empty or disabled.
7. Start one turn and map accepted protocol observations to Kogg's durable outer
   state. Content events flow only to the authorized user-visible channel with
   bounded memory; they bypass lifecycle logs and diagnostics.
8. On provider terminal, cancellation, deadline, protocol fault, or process exit,
   stop accepting new work and enter cleanup. A provider success remains
   `provider_terminal_observed` until cleanup and output qualification finish.
9. Cooperatively interrupt if a turn is active; await the matching terminal event
   only until the cleanup sub-deadline. Attempt bounded background-terminal
   cleanup when the qualified schema supports it.
10. Close the protocol, request graceful shutdown, revoke credentials, terminate
    the app-server scope, escalate within the qualified profile, drain pipes, and
    inspect for zero descendants and closed handles.
11. Persist only the safe outcome, cleanup proof status, provenance, durations,
    counts, and typed failures. Quarantine the private repo/home on uncertain
    cleanup or integrity; otherwise remove them through the owning execution
    lifecycle.

No adapter callback may move the attempt directly from running to completed.
The outer state machine must include terminal-observed, cleaning, cleaned or
cleanup-failed, and qualified or rejected states.

## Process and capability inventory

| Possible process/capability | V1 owner and disposition |
| --- | --- |
| Kogg Node adapter wrapper | Kogg backend; source-mapped and covered by `kogg:agents:codex-adapter`. |
| `codex app-server` | Registered before spawn; pinned binary; one attempt; mandatory cgroup membership. |
| Codex shell/unified-exec children | Allowed only inside the frozen execution profile; discovered through the outer process inventory regardless of protocol events. |
| Background terminals | Never inherited beyond the attempt; cooperatively terminate then prove absent externally. |
| MCP/plugin/app/skill/hook children | Disabled in V1; any appearance is a capability mismatch and release-blocking failure. |
| Browser/computer-use/realtime/remote-control helpers | Disabled; not part of the qualified adapter surface. |
| Codex subagents/guardian/reviewer | Disabled unless a later explicit child-authority design qualifies identity, limits, accounting, and cleanup. |
| Credential broker helper | Owned by the qualified credential boundary, not Codex; no secret in argv/environment/logs. |
| Git helper processes | Confined to the private repository and accounted as descendants. |

Every observed descendant must map to one expected class and owner. Unknown,
escaped, stalled, orphaned, or residual processes block release even when the
turn otherwise succeeded.

## Failure and recovery contract for #90

The closed taxonomy must at least distinguish validation/provenance mismatch,
confinement setup failure, credential unavailable/revoked, spawn failure,
initialize timeout/rejection, capability/schema mismatch, thread/turn rejection,
unexpected approval, model mismatch, protocol parse/order/overflow error, idle
timeout, absolute timeout, user cancellation, app-server crash/EOF, child escape,
cleanup timeout, residual process, output integrity failure, and startup recovery.

Recovery never guesses from a missing terminal event. On backend startup Kogg
must reconcile every nonterminal intent against process/cgroup identity,
credential state, private paths, and durable lifecycle ownership. A live process
without the correct owner is fenced and cleaned. A dead process with an
incomplete attempt becomes failed and enters cleanup/quarantine. V1 does not
resume the Codex thread or replay the turn because the prior side effects cannot
be proven absent. Concurrent recovery uses a durable lease/fence so two backends
cannot supervise or kill the same scope independently.

## Safe observability and diagnostics

Production work uses a Theia `ILogger` named `kogg:agents:codex-adapter` and
stable events for validation, process intent/start, protocol handshake, thread
and turn boundaries, activity heartbeat, terminal observation, cancellation,
deadline, cleanup stages, recovery, and final outcome. Allowed fields are closed
and low-cardinality: opaque Kogg attempt/operation IDs, safe parent ID, adapter
and binary version/digest, schema version/digest, requested/observed model IDs
only after policy classifies them safe, lifecycle state, event type, counts,
durations, deadline class, exit/signal class, cleanup result, residual count, and
typed error code.

Never log raw exceptions from Codex/Node, protocol frames, request/response
bodies, stderr, prompts, reasoning, output, diffs, code, commands, arguments,
paths, environments, provider session IDs unless specifically classified,
credentials, cookies, personal data, or content-derived hashes. Sanitization is
positive allowlisting, not regex scrubbing after serialization.

Diagnostics must expose aggregate adapter health without content: qualified
binary/schema state, supervisor readiness, counts by safe lifecycle state,
oldest safe age bucket, active registered process count, residual count,
deadline/cancel/cleanup failure counts, recovery backlog, and last safe typed
failure. The runtime check must cross-check durable attempts with the external
process inventory. `server/diagnostics` from Codex is process-local and may be a
supplement, never the authority.

#92 must add a specific `diagnostic-coverage` catalog entry, failure tests for
every diagnostic signal whose absence would hide a stuck or residual process,
and debugger proof across browser, Node backend, Codex stdio boundary, and Linux
execution owner. Source maps remain enabled and `yarn audit:observability` stays
release-blocking.

## Required prototype and E2E evidence

#91 must use the exact candidate binary/schema and qualified Linux execution
profile, not mocks, to probe: initialize negotiation; one ephemeral thread/turn;
explicit model binding; filesystem changes only in the private repository;
interrupt while streaming; interrupt during approval; background terminal
survival followed by cooperative and forced cleanup; app-server crash; malformed,
oversized, duplicate, unknown, and out-of-order protocol messages; stdout stall;
stderr flood; stdin backpressure; child escape attempt; cgroup kill escalation;
credential revocation; unknown capability; model fallback attempt; restart
reconciliation; and zero residual processes/files/credentials after success and
every failure.

#92 real human-level E2E must drive the Theia UI through a governed task, observe
safe progress, cancel one run, complete another, inspect only the private repo,
and verify the backend diagnostics plus external process inventory. It must also
prove that logs and support diagnostics contain none of the seeded prompt,
secret, path, command, output, code, or diff canaries. Ranex evidence and verdict
remain required independently of Kogg's test result.

## Rejected alternatives

| Candidate | Decision |
| --- | --- |
| Reuse Theia's current `@openai/codex-sdk` wrapper | Reject as the governed boundary; it has browser credential/options flow, ambient workspace selection, in-memory lifecycle, abort-only cancellation, full-access mode, and unsafe logging shapes. |
| Run `codex exec` and parse terminal text | Reject; text is content-bearing and loses typed thread/turn/item, approval, interrupt, and terminal correlations. |
| Embed Codex in the Kogg backend process | Reject; collapses crash, resource, credential, and process ownership boundaries and prevents independent attestation/termination. |
| Reuse the user's `~/.codex` or login/keyring | Reject; leaks personal configuration/history/credentials and permits durable mutation outside the run. |
| Use a linked Git worktree | Reject as a security boundary because it shares repository metadata; use a private full repository under confinement. |
| Enable `danger-full-access` | Reject. Outer qualified confinement is mandatory and no weaker fallback is allowed. |
| Trust Codex's ambient Bubblewrap/helper fallback | Reject as the release boundary; pin exact helpers or use the qualified external profile. |
| Treat `turn/completed` or app-server exit as cleanup | Reject; background terminals and other descendants may remain. |
| Auto-approve provider requests | Reject; frozen Kogg policy, not model output, owns authority. Unexpected approval is blocked/refused. |
| Enable all experimental APIs to obtain terminal cleanup | Reject; use only a version-qualified closed subset and retain external cleanup authority. |
| Automatically retry/resume after overload, EOF, or crash | Reject; side effects may already exist. A new attempt requires explicit authority. |
| Persist raw protocol events for debugging | Reject; they contain prompts, reasoning, code, diffs, commands, output, paths, and errors. |
| Forward Codex stderr/raw errors into Theia logs | Reject; record only allowlisted typed failure classes. |
| Let Codex/provider verdict qualify or merge output | Reject; evidence and merge authority remain external. |

## Risks and decisions required from #90

#90 must resolve, with exact schemas and deadlines: binary/schema attestation and
upgrade policy; the closed initialize capability set; exact permission and
external-sandbox representation; fixed model verification; noninteractive
approval behavior; brokered credential delivery and revocation; bounded protocol
queues and content-channel routing; process/cgroup registration; idle/absolute/
cleanup deadlines; signal escalation; background-terminal cleanup when the API
is experimental; safe lifecycle transitions; durable recovery lease; quarantine
and deletion ownership; closed failure codes/log fields; diagnostic catalog
contract; and E2E fault-injection seams.

The largest unresolved risk is credential delivery compatible with Codex without
placing a reusable secret in the child environment or user state. The second is
the experimental status of background-terminal control. Neither may be hidden by
an implementation shortcut: #90 must name a qualified mechanism or block the
prototype. The external process inventory remains mandatory in both cases.

## Research gate conclusion

- Sources are commit-pinned with licenses, reviewed paths, and security and
  maintenance implications.
- Selected and rejected patterns are explicit, including Theia SDK reuse,
  one-shot CLI parsing, user state, ambient sandbox fallback, auto-approval,
  implicit retry/resume, and provider-owned cleanup.
- Process, capability, logging, diagnostics, failure, recovery, confinement,
  credential, and E2E risks are enumerated.
- The selected boundary and required decisions are specific enough for #90 to
  produce decision-complete pseudocode without reopening the adapter topology.

Production remains blocked until #90, #91, and #92 complete in order and all
observability, diagnostics, debugger, real E2E, Ranex evidence, verdict, and
zero-residual-process gates pass.

## Pseudocode decision record

This section is normative for #91 and #92. It closes every implementation choice
identified by research. The adapter is one versioned implementation of the shared
role-oriented protocol specified by #78; it may translate Codex observations but
may not redefine role authority, attempt success, cleanup, evidence, verdict, or
merge semantics.

### Production components and ownership

`@kogg/codex-adapter` contributes:

| Component | Owner | Responsibility |
| --- | --- | --- |
| `CodexReleaseRegistry` | Kogg backend | Load the signed bundled qualification manifest and resolve one exact platform binary/schema/helper set |
| `CodexAdapterFactory` | Shared agent adapter registry | Advertise the one qualified Codex descriptor and create an attempt-bound adapter instance |
| `CodexProcessHost` | Kogg operation supervisor plus qualified Linux execution owner | Register logical process before spawn, bind cgroup/process identity, own stdio, deadlines, signals, drain, and residual proof |
| `CodexProtocolClient` | Attempt-bound backend object | Enforce initialize ordering, closed method/event schemas, correlation, sequence, frame/queue bounds, and typed observations |
| `CodexCredentialBroker` | Existing credential authority | Exchange a short-lived local lease for provider requests without disclosing the provider credential to Codex |
| `CodexContentRouter` | Existing content-appropriate Theia channel | Route prompt/output/diff/tool content to authorized UI consumers with backpressure; never lifecycle logs/diagnostics/storage |
| `CodexDiagnosticContributor` | Kogg diagnostics | Cross-check release/schema, confinement, lifecycle/process, queue, broker, cleanup, and recovery state |

The shared agent attempt owns admission and final state. The execution slice owns
the private repository, qualified Linux scope, worktree/run binding, quarantine,
and deletion. The operations registry owns Kogg's logical process record. The
Codex adapter owns only its app-server protocol object and stdio handle. Ranex owns
qualification/evidence/verdict. There is no second process, repository, evidence,
or merge authority in this package.

### Exact release and schema attestation

Kogg ships a signed `codex-qualification-v1.json` manifest generated in a reviewed
release job. One entry contains:

```ts
interface QualifiedCodexReleaseV1 {
  manifestVersion: '1';
  releaseId: SymbolicId;
  codexVersion: Semver;
  codexCommit: LowerHex40;
  target: 'x86_64-unknown-linux-musl' | 'aarch64-unknown-linux-musl';
  binarySha256: Sha256;
  binarySize: Decimal;
  appServerSchemaVersion: 'v2';
  appServerSchemaSha256: Sha256;
  acceptedMethodsSha256: Sha256;
  linuxHelperSha256: Sha256;
  adapterVersion: Semver;
  qualificationProfileId: SymbolicId;
  signedAt: IsoInstant;
  signatureKeyId: SymbolicId;
  signature: Base64;
}
```

At startup, `CodexReleaseRegistry` verifies the manifest signature with a bundled
release public key, platform/architecture, canonical manifest encoding, exact file
size and SHA-256 of the binary/helper/schema/accepted-set assets, executable
owner/mode, and that none is a symlink. It then runs `codex --version` inside the
qualified no-network inspection scope and requires the exact declared version.
The version subprocess is registered before start and cleaned like every other
Kogg process. Any mismatch disables the adapter and returns
`CODEX_RELEASE_UNQUALIFIED`; it never downloads, searches `PATH`, uses a user
installation, or falls back.

Upgrade means adding a new signed manifest entry and adapter version after #91's
qualification suite passes. Existing active/recovering attempts retain the exact
old binary/schema digests until cleanup. An entry cannot be removed while a
durable attempt references it. No semver range or newest-version selection exists.

### Accepted app-server protocol

The only accepted outbound methods/notifications are:

- `initialize`, followed by `initialized` exactly once;
- `thread/start` with `ephemeral: true`;
- `turn/start` for the single active turn;
- `turn/interrupt` for cooperative cancellation;
- the qualified stable request replies needed for explicit policy refusal; and
- `shutdown`/stdio close only during cleanup when supported by the exact pin.

The only accepted inbound lifecycle observations are the exact qualified v2
initialize reply, thread-start reply, `turn/started`, declared item start/update/
completion families, usage observations, approval/tool request families,
`turn/completed`, server request replies, and JSON-RPC errors. Each is validated
against the bundled generated schema before correlation or content routing.
Unknown methods, notifications, fields that violate the generated closed shape,
invalid JSON-RPC IDs, duplicate terminal events, out-of-order lifecycle events, or
an unexpected second thread/turn fail the attempt as
`CODEX_PROTOCOL_VIOLATION` and begin cleanup.

The adapter never uses human terminal output, `codex exec`, persisted threads,
thread resume, dynamic configuration mutation, experimental API discovery, or
provider-native completion as outer success. One app-server process owns exactly
one ephemeral thread and one active turn for V1.

### Request, configuration, and authority snapshot

```ts
interface CodexAttemptBindingV1 {
  schemaVersion: '1';
  attemptId: UUID;
  operationId: UUID;
  processId: UUID;
  projectId: UUID;
  taskId: UUID;
  runId: UUID;
  worktreeId: UUID;
  repositoryBindingRevision: Decimal;
  roleRevisionId: UUID;
  adapterKey: 'codex-app-server';
  adapterVersion: Semver;
  releaseId: SymbolicId;
  binarySha256: Sha256;
  schemaSha256: Sha256;
  requestedProviderId: SymbolicId;
  requestedModelId: SymbolicId;
  permissionProfileId: 'codex-v1-workspace-write-never-approve';
  executionProfileId: SymbolicId;
  credentialLeaseId: UUID;
  deadlinePolicyId: SymbolicId;
}
```

The shared admission layer supplies immutable task/role/provider/model/budget and
execution identities. Before spawn, the adapter rechecks that the execution owner
reports the exact current project/task/run/worktree binding, a private full Git
repository, qualified Linux profile, and frozen writable-root identity. Any stale
reference refuses with `CODEX_BINDING_CHANGED` before credentials or process
activity.

The Codex process is configured with a private `CODEX_HOME`, private scratch home,
the private repository as its only writable project root, `workspace-write`
sandbox mode, approval policy `never`, network disabled except the local credential
broker, ephemeral history, no user instructions/config, no MCP servers, no hooks,
no plugins, no skills, no browser/computer-use, no collaboration/subagents, no
shell-environment inheritance, and no experimental features. The exact generated
configuration file is owner-readable, resides inside the private attempt state,
contains symbolic policy plus local broker endpoint only, and is deleted during
cleanup. Its path and contents are never logged.

Codex cannot request expanded sandbox, network, approval, a different model,
additional provider, MCP/tool capability, or external writable root. Any approval
or permission request is answered with the qualified protocol's explicit denial
and the attempt fails `CODEX_AUTHORITY_REQUESTED`; Kogg does not auto-approve.

### Qualified Linux confinement

Production is Linux-only. Admission requires the exact execution profile recorded
in the release manifest:

- user and mount namespaces with a non-root unmapped host identity;
- private full repository mounted read/write at one stable in-sandbox location;
- source checkout, host home, host Git metadata, Docker socket, SSH agent,
  keyrings, device nodes, and arbitrary host paths absent;
- read-only pinned binary/helper/runtime assets;
- private tmpfs home, `CODEX_HOME`, `/tmp`, and bounded scratch;
- cgroup v2 subtree created and owned before spawn with PID, memory, CPU, and
  wall-clock controls, `pids.max`, and `cgroup.kill` support;
- seccomp/capability/no-new-privileges policy matching the qualified digest;
- network namespace with only loopback access to the attempt credential broker;
  no DNS or external route; and
- all descendants forced into the same cgroup and namespace scope.

The adapter does not trust Codex's ambient Bubblewrap/helper selection as the outer
boundary. It passes `externalSandbox: true` only in the exact protocol/config
shape proven by #91 and refuses if Codex reports a weaker or conflicting mode.
Failure to inspect any namespace, mount, cgroup, route, or policy identity returns
`CODEX_CONFINEMENT_UNVERIFIED`; there is no macOS/Windows production fallback.
Browser and Electron clients may initiate/observe a remote qualified Linux run,
but the Codex process never runs on those desktop hosts for V1.

### Credential broker

The credential authority creates one reservation bound to attempt, release,
provider, model, maximum request count, absolute expiry, and local broker instance.
Codex receives no reusable provider key. The child receives a random one-attempt
broker bearer in `OPENAI_API_KEY` and a loopback-only `OPENAI_BASE_URL`; the bearer
is valid only from the attempt network/cgroup identity, is single-attempt and
short-lived, cannot access account APIs, cannot change model, and becomes invalid
on cancel, timeout, process exit, or broker restart. It is still authorization
material and therefore never logged, persisted in lifecycle/diagnostics, returned
to the frontend, placed in argv, or included in support artifacts.

The broker validates the lease and exact model, injects the provider credential
only inside its own request boundary, strips/disallows unsupported endpoints and
headers, applies byte/request/time bounds, performs no automatic retry, and
forwards streaming content only through the authorized content channel. It records
safe counts and status classes, never headers, bodies, URLs with query data, prompt,
output, reasoning, tool data, or provider errors. Revocation closes in-flight
streams, invalidates the bearer, and returns a typed safe observation.

#91 must prove this exact compatibility with the pinned Codex binary. If Codex
cannot operate through the scoped broker without exposing or persisting the bearer,
the prototype is blocked; production must not fall back to the real API key in the
child environment or user `~/.codex`.

### Stdio framing, content routing, and backpressure

Stdio is byte-owned by `CodexProcessHost`: stdin for newline-delimited JSON-RPC,
stdout exclusively for protocol frames, and stderr drained/discarded after safe
byte counting. Bounds are:

- maximum inbound or outbound frame: 8 MiB including newline;
- maximum incomplete line buffer: 8 MiB;
- maximum 256 queued decoded observations or 16 MiB queued bytes, whichever first;
- maximum 64 outstanding Kogg requests and 64 outstanding server requests;
- maximum 4 MiB pending stdin bytes with drain deadline 10 seconds;
- stderr drain counter sampled per second, hard cap 64 MiB total, with content
  never decoded or logged; and
- content router backpressure cap 16 MiB per authorized consumer, after which the
  turn is cancelled as `CODEX_CONTENT_BACKPRESSURE` rather than dropping lifecycle.

The frame decoder rejects invalid UTF-8, oversized/incomplete JSON, non-object
frames, duplicate IDs, unknown correlations, and messages after terminal. It
separates safe lifecycle fields from content before dispatch. Content-bearing
parts go only to `CodexContentRouter` as in-memory bounded objects; they are absent
from the adapter registry, safe event ledger, logs, diagnostics, errors, and
support bundle. Lifecycle reduction waits for content queue acceptance where
ordering matters, so a slow consumer cannot reorder completion ahead of output.

### Lifecycle and transition table

The adapter uses the shared attempt states plus this private projection:

```ts
type CodexPhase =
  | 'release-verified' | 'scope-verified' | 'registered' | 'spawn-requested'
  | 'spawned' | 'initializing' | 'initialized' | 'thread-starting'
  | 'thread-ready' | 'turn-starting' | 'turn-active'
  | 'turn-terminal-observed' | 'interrupting' | 'draining'
  | 'terminating' | 'enumerating' | 'cleaned' | 'cleanup-failed'
  | 'recovery-required' | 'reconciling' | 'quarantined';
```

| From | Observation/action | Preconditions | To / outer observation |
| --- | --- | --- | --- |
| none | release and execution binding verified | exact manifest/schema/profile/binding | `scope-verified` |
| scope-verified | operation/logical process registered | both registries read back binding | `registered` |
| registered | spawn requested | cgroup/namespace/config/broker ready | `spawn-requested` |
| spawn-requested | process bound | PID/start/cgroup identity matches | `spawned` |
| spawned | send initialize | stdio ready, handshake timer active | `initializing` |
| initializing | exact initialize reply then initialized sent | schema/capabilities/model surface allowed | `initialized`; outer adapter ready |
| initialized | send ephemeral thread/start | no prior thread | `thread-starting` |
| thread-starting | exact reply | ephemeral, model/policy/sandbox match | `thread-ready` |
| thread-ready | send turn/start | authorized content handle available | `turn-starting` |
| turn-starting | turn/started | correlation exact | `turn-active`; outer active |
| turn-active | valid item/usage observation | sequence/correlation/bounds valid | remain active, bounded heartbeat |
| turn-active | turn/completed | exact one terminal event | `turn-terminal-observed`; provisional completion/failure |
| active phases | cancel/timeout | first durable cancel generation | `interrupting`; send turn/interrupt once |
| terminal/interrupt/failure | cleanup starts | broker revoked, content input closed | `draining` |
| draining | cooperative shutdown/stdio close settled | descendants may still exist | `terminating` |
| terminating | SIGTERM grace expired or host still live | identity reverified | cgroup kill, then `enumerating` |
| enumerating | cgroup empty and broker/config/stdio released | external inventory agrees | `cleaned`; outer cleanup proof |
| enumerating | residual/unverified identity/deadline | no unsafe signal | `cleanup-failed`; block release/capability |

`turn/completed`, EOF, process `exit`, process `close`, interrupt reply, and Codex
terminal cleanup replies never skip `draining -> terminating -> enumerating`.
Exactly one outer terminal result is committed after cleanup classification.

### Deadlines and cancellation escalation

Fixed adapter deadlines are: scope verification 10 seconds, spawn 20 seconds,
initialize 30 seconds, thread start 30 seconds, turn start/first activity 60
seconds, idle 120 seconds, stdin drain 10 seconds, interrupt acknowledgement 10
seconds, graceful host exit 10 seconds, cgroup-empty proof 10 seconds, configuration
and broker cleanup 10 seconds. The shared absolute deadline is policy-supplied and
capped at 24 hours. Every timer has a durable generation; stale callbacks do
nothing.

Cancellation algorithm:

```text
persist cancel requested and revoke credential lease
stop accepting new content/provider/server requests
if turn correlation exists: send turn/interrupt once
explicitly deny/resolve every pending approval or server request
wait up to 10s for terminal observation and pending request settlement
request app-server shutdown and close stdin
wait up to 10s for process close
reverify platform identity; send SIGTERM to Kogg-owned process group
wait bounded grace; invoke cgroup.kill for the qualified owned scope
drain stdout/stderr without logging content
enumerate cgroup, operation registry, broker leases, stdio handles, and config
commit cleaned only when every inventory is empty/released
```

Cancellation before provider completion wins the final `CODEX_CANCELLED` code.
A terminal event durably reduced first retains its completed/failed class, though a
later user cancel still accelerates cleanup. Deadline expiry wins over later
protocol events. Cleanup failure overrides no provider result; it produces the
terminal cleanup state/code and blocks governed success.

### Background terminals and descendants

V1 does not enable experimental app-server terminal-control methods as an
authority dependency. Foreground command execution required by Codex remains
inside the qualified cgroup. Any background terminal, MCP/helper, hook, plugin,
subagent, shell descendant, or escaped process observation is unexpected because
those capabilities are disabled. The external cgroup/process inventory is the
cleanup authority and must account for every descendant even if Codex omits it.

If the exact qualified stable schema exposes a read-only terminal inventory, #91
may use it only as a cross-check. A mismatch between Codex and external inventory
fails `CODEX_PROCESS_INVENTORY_MISMATCH`; cleanup still uses the external owner.
An observed descendant outside the attempt cgroup is
`CODEX_PROCESS_ESCAPE_DETECTED`, immediately cancels the attempt, blocks the
qualification profile, and prevents release even if the process later exits.

### Durable safe state and idempotency

The shared attempt registry stores the immutable binding above, current Codex
phase, safe protocol request counters/correlations, deadline generations, bounded
activity/usage status, operation/process/cgroup logical IDs, terminal code,
cleanup result, and append-only safe events. It never stores protocol frames,
provider/thread/turn/item IDs in support-visible tables, content, configuration
contents/path, PID/argv/environment, broker bearer, credential, stderr, exception,
or raw response.

Provider correlations needed during one live process remain in memory. Because
stdio ownership cannot survive backend death safely, V1 never reattaches or
replays a turn. Matching duplicate start/cancel request IDs return the committed
safe result; digest collision is refused. Unknown commit outcome is reconciled
from safe events/process inventory, never resolved by resubmitting `turn/start`.

Startup verifies database/event integrity and the qualified release before
admission, then reconciles every nonterminal binding. A live matching cgroup is
cancelled/killed and enumerated without reconnecting to stdio. Missing resources
become `CODEX_RECOVERED_AFTER_BACKEND_LOSS` only after zero-residual proof.
Unmatched/reused/unreadable identity is never signalled and becomes
`CODEX_UNVERIFIED_RESIDUAL`, blocking the adapter/profile. The private repository
is marked quarantined through the execution owner; deletion is owned by the
execution retention policy and never happens merely because the adapter failed.

### Closed failure and refusal codes

The adapter-specific closed enum is:

`CODEX_OK`, `CODEX_BINDING_CHANGED`, `CODEX_RELEASE_UNQUALIFIED`,
`CODEX_MANIFEST_INVALID`, `CODEX_BINARY_MISMATCH`, `CODEX_SCHEMA_MISMATCH`,
`CODEX_VERSION_MISMATCH`, `CODEX_PLATFORM_UNSUPPORTED`,
`CODEX_CONFINEMENT_UNVERIFIED`, `CODEX_PROCESS_REGISTRATION_FAILED`,
`CODEX_PROCESS_START_FAILED`, `CODEX_PROCESS_ESCAPE_DETECTED`,
`CODEX_PROCESS_INVENTORY_MISMATCH`, `CODEX_PROTOCOL_UNSUPPORTED`,
`CODEX_PROTOCOL_VIOLATION`, `CODEX_FRAME_TOO_LARGE`, `CODEX_QUEUE_OVERFLOW`,
`CODEX_STDIN_BACKPRESSURE`, `CODEX_STDERR_LIMIT`,
`CODEX_CONTENT_BACKPRESSURE`, `CODEX_PROVIDER_MISMATCH`,
`CODEX_MODEL_MISMATCH`, `CODEX_SANDBOX_MISMATCH`,
`CODEX_CAPABILITY_UNEXPECTED`, `CODEX_AUTHORITY_REQUESTED`,
`CODEX_CREDENTIAL_LEASE_REFUSED`, `CODEX_CREDENTIAL_REVOKED`,
`CODEX_PROVIDER_AUTH_REFUSED`, `CODEX_PROVIDER_RATE_LIMITED`,
`CODEX_PROVIDER_REFUSED`, `CODEX_TRANSPORT_LOST`, `CODEX_HOST_EXITED`,
`CODEX_SCOPE_TIMEOUT`, `CODEX_SPAWN_TIMEOUT`, `CODEX_INITIALIZE_TIMEOUT`,
`CODEX_THREAD_START_TIMEOUT`, `CODEX_FIRST_ACTIVITY_TIMEOUT`,
`CODEX_IDLE_TIMEOUT`, `CODEX_ABSOLUTE_TIMEOUT`, `CODEX_CANCELLED`,
`CODEX_INTERRUPT_TIMEOUT`, `CODEX_CLEANUP_TIMEOUT`, `CODEX_CLEANUP_FAILED`,
`CODEX_RECOVERY_REQUIRED`, `CODEX_RECOVERED_AFTER_BACKEND_LOSS`,
`CODEX_UNVERIFIED_RESIDUAL`, `CODEX_REGISTRY_BUSY`,
`CODEX_REGISTRY_INTEGRITY_FAILED`, and `CODEX_INTERNAL_FAILURE`.

Raw JSON-RPC errors, provider bodies/status text, stderr, exception messages, paths,
commands, arguments, output, and content never enter mappings. Reviewed numeric
status classes may map to auth/rate-limit/generic provider categories inside the
broker. Unknown errors become `CODEX_INTERNAL_FAILURE` with only error type logged.

### Exact safe observability

Logger names are `kogg:agents:codex-release`, `kogg:agents:codex-adapter`,
`kogg:agents:codex-protocol`, `kogg:agents:codex-supervision`, and
`kogg:agents:codex-recovery`.

| Event | Level | Allowed fields |
| --- | --- | --- |
| `release.verification.started/completed/failed` | info/info/error | releaseId, target, adapterVersion, safeCode? |
| `scope.verification.started/completed/failed` | info/info/error | attemptId, operationId, executionProfileId, safeCode? |
| `process.registered` | info | attemptId, operationId, processId, ownerKind |
| `process.start.requested/started/failed` | debug/info/error | attemptId, operationId, processId, durationMs?, safeCode? |
| `protocol.initialize.started/completed/failed` | debug/info/error | attemptId, schemaVersion, durationMs?, safeCode? |
| `thread.started` / `turn.started` | info | attemptId, activityCount |
| `protocol.activity` | debug | attemptId, activityKind, activityCount, queuedCount |
| `broker.request.started/completed/failed` | debug/debug/warn | attemptId, providerId, modelId, requestCount, durationMs?, statusClass?, safeCode? |
| `turn.completion.observed` / `turn.failed` | info/error | attemptId, terminalClass, activityCount, safeCode? |
| `cancel.requested/acknowledged/escalated` | info/debug/warn | attemptId, operationId, processId, deadlineClass?, pendingCount |
| `timeout.expired` | warn | attemptId, deadlineClass, generation, configuredMs |
| `cleanup.started/completed/failed` | info/info/error | attemptId, operationId, processId, resourceCount, residualCount, safeCode? |
| `recovery.started/classified/completed/failed` | info/warn/info/error | attemptId?, processId?, recoveryClass?, residualCount?, safeCode? |

All schemas are compile-time closed. They reject raw protocol objects and unknown,
content-bearing, oversized, or authorization fields without echoing values. Safe
correlations are project/task/run/worktree/attempt/operation/process IDs where the
event schema declares them. Binary/schema digests are used for local attestation
but support/log output shows the symbolic release ID, not digests that could become
unreviewed fingerprints. Lifecycle boundaries and each external provider/process
call have requested/start/terminal/failure coverage.

### Diagnostic catalog

Exact runtime IDs are:

- `codex.release`: signed manifest, binary/helper/schema/accepted-set versions and
  platform qualification are exact;
- `codex.confinement`: active/recent attempts match the qualified namespace,
  mount, cgroup, network, seccomp, capability, and writable-root profile;
- `codex.protocol`: initialization ordering, accepted schema, correlation, queue,
  frame, backpressure, and terminal projections are valid;
- `codex.credentials`: broker is scoped, current leases match active attempts and
  model/provider grants, and no stale reservation exists;
- `codex.processes`: every app-server/descendant is registered before start,
  inventories agree, and no hidden/escaped/residual process exists;
- `codex.cleanup`: every terminal attempt has closed stdio/content/broker/config
  resources and proved empty cgroup/process inventory;
- `codex.recovery`: startup reconciliation is complete and admission agrees with
  quarantine/unverified state; and
- `codex.source-maps`: backend, frontend projection, Electron, adapter host, and
  Linux owner source maps exist and exercised failure branches are debugger-ready.

The contributor fails every relevant check if inspection throws; it never omits a
check. Operational files declare one or more IDs. Failure tests cover missing/
tampered manifest assets, unverified scope, invalid frames/order, queue and stderr
overflow, stale broker lease, inventory mismatch/escape/residual, cleanup timeout,
corrupt lifecycle storage, and recovery backlog. `yarn audit:observability` remains
release-blocking.

### Visible browser and Electron behavior

The shared Agents view shows `Codex app-server <qualified version>` only when
release and remote Linux profile diagnostics permit admission. Start confirmation
shows exact role, provider/model registry IDs, private repository binding,
permission profile, adapter/release version, deadlines, and budget using safe
labels. It never displays or transmits the provider key.

During a run the attempt detail shows safe phases (`Preparing qualified scope`,
`Starting Codex`, `Initializing`, `Active`, `Cancelling`, `Cleaning`, `Recovered`,
or typed failure), bounded activity and usage, child/resource counts, and Cancel.
Content appears only in the authorized content view. Cancel stays pending until
backend state changes. Reload/disconnect does not cancel. Quarantine, cleanup
failure, or unverified residual is prominent and prevents another Codex start on
the affected profile; a diagnostic action links to the safe report, not raw logs.

### Real visible-UI E2E and expected traces

#92 drives browser and Electron controls while the backend uses a qualified Linux
target. No direct service mutation, mocked process/provider success, fake patch,
or pre-generated repository result is accepted. Required cases are:

1. select an approved frozen task and exact Codex release/provider/model; start a
   real app-server and real provider turn; observe one private-repository change,
   terminal observation, external cleanup, and zero residuals;
2. verify the source checkout and host/user state are absent, only the private
   repository changes, network reaches only the broker, and model/sandbox/profile
   observations match the frozen binding;
3. cancel while streaming, during a denied approval, and with a real background
   descendant attempt; prove interrupt, pending request resolution, broker revoke,
   SIGTERM/cgroup escalation as applicable, drain, and empty inventory;
4. force binary/schema/helper/accepted-set mismatch, unsupported platform,
   confinement downgrade, capability/model fallback, external writable-root and
   process escape attempts; prove refusal/failure before unsafe activity;
5. inject malformed UTF-8/JSON/schema, oversized/incomplete/duplicate/unknown/
   out-of-order frames, stdout stall/flood, stderr flood, stdin and content
   backpressure, unexpected EOF, and app-server crash;
6. force each scope/spawn/initialize/thread/first-activity/idle/absolute/interrupt/
   cleanup deadline independently and prove correct generation/code;
7. revoke credentials during streaming and force broker auth/rate-limit/provider
   refusals without exposing the bearer/key/body;
8. kill the Kogg backend with an active app-server, restart visibly, reconcile the
   cgroup without turn replay or stdio reattachment, quarantine the repository,
   and block admission until zero-residual proof;
9. corrupt lifecycle storage and create process-inventory disagreement/unverified
   identity; prove fail-closed diagnostics and no unsafe signal;
10. seed prompt, output, reasoning, source, diff, path, command, argv, environment,
    provider body/error, real provider key, and broker bearer canaries; scan all
    frontend/backend/Electron/Linux-owner/broker logs, diagnostics, support and CI
    artifacts for absence;
11. visibly run diagnostics/export support and assert all eight exact checks plus
    deliberate failure classifications; and
12. attach debuggers through source maps to browser projection, Node adapter and
    broker, Electron renderer/main, and Linux process owner at initialize,
    malformed-frame, cancel escalation, cleanup, and recovery branches.

Success trace:

```text
release.verification.started -> release.verification.completed ->
scope.verification.started -> scope.verification.completed ->
process.registered -> process.start.requested -> process.started ->
protocol.initialize.started -> protocol.initialize.completed ->
thread.started -> turn.started -> protocol.activity* ->
turn.completion.observed -> cleanup.started -> cleanup.completed
```

Cancellation trace:

```text
cancel.requested -> credential lease revoked -> interrupt sent ->
cancel.acknowledged? -> cancel.escalated? -> cleanup.started ->
cgroup/process/broker/config inventories empty -> cleanup.completed
```

Recovery trace:

```text
recovery.started -> recovery.classified -> broker revoked ->
owned cgroup terminated/enumerated -> repository quarantined ->
cleanup.completed|cleanup.failed -> recovery.completed|recovery.failed
```

All traces are asserted in the append-only safe ledger and allowlisted logs.
`turn/completed` without cleanup, a green test with a residual, a content leak,
missing diagnostic, missing source map, unqualified confinement, or absent Ranex
evidence/verdict is a failed release.

### Prototype handoff and pseudocode gate

#91 must test the exact pinned binary/schema/profile and decisions above. Its
highest-risk measurements are scoped broker compatibility, external-sandbox
reporting, disabled approval/capability behavior, real descendant inheritance and
cgroup kill, stdio/backpressure bounds, and backend-death recovery. The prototype
branch is preserved; only measured findings and necessary packet corrections
merge. A happy-path chat or fake JSON-RPC peer alone cannot close #91.

Research #89 is closed. Binary/schema attestation, protocol surface, model and
approval authority, credential delivery, confinement, queues, process ownership,
deadlines, escalation, descendants, persistence, recovery/quarantine, safe codes,
logs, diagnostics, source maps/debugger proof, and visible real-boundary E2E now
have exact decisions. No production implementation choice remains unresolved.
