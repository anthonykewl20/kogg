# Governed Codex CLI adapter

Tracking: [#86](https://github.com/anthonykewl20/kogg/issues/86), research
phase [#89](https://github.com/anthonykewl20/kogg/issues/89).

## Status

Research is complete as of 2026-08-27. This packet contains no production code.
It records the boundary and evidence needed by pseudocode issue #90, the real
boundary probe in #91, and production implementation plus real E2E in #92.

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
