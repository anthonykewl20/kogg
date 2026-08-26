# Governed Claude Code adapter

Tracking: [#93](https://github.com/anthonykewl20/kogg/issues/93), research
phase [#94](https://github.com/anthonykewl20/kogg/issues/94).

## Status

Research is complete as of 2026-08-27. This packet contains no production code
and stops before decision-complete schemas and pseudocode. Those belong to #95,
followed by a real-boundary probe in #96 and production implementation plus real
E2E in #97.

The recommendation is a pinned `@anthropic-ai/claude-agent-sdk` TypeScript
package whose bundled Claude Code process is spawned through a Kogg-owned
`spawnClaudeCodeProcess` boundary, one process per governed attempt, inside the
same qualified Linux execution scope and private repository required of every
provider adapter. The SDK's streaming query, initialization result, typed
command lifecycle, interrupt receipt, background-task snapshot, permission
callback, and close operation are provider observations. Kogg remains the outer
authority for the frozen role/provider/model grant, process registration,
deadlines, cancellation, descendant cleanup, durable recovery, evidence, safe
observability, and completion.

V1 must fail closed on package-integrity/type-surface mismatch, unexpected
settings or capabilities, model mismatch or fallback, unavailable confinement,
permission requests outside the frozen grant, protocol overflow or ambiguity,
unregistered descendants, or residual processes. SDK completion and `close()`
are not independent proof that the Linux process tree is empty.

## Scope and invariants

The eventual adapter must satisfy all of these invariants:

- Claude receives only a controller-created private Git repository. The user's
  source checkout, Git common directory, home, settings, sessions, credentials,
  plugins, hooks, MCP configuration, and Claude memory are absent.
- One immutable attempt binds exact SDK package integrity, bundled CLI version,
  adapter schema, provider, model, permission profile, execution profile,
  credential grant, budgets, and deadlines before spawn.
- Kogg registers the intended Claude process before calling the SDK spawn
  boundary and accounts for every Bash process, background task, subagent, hook,
  MCP server, plugin helper, language server, browser/computer-use helper, and
  other descendant.
- The child environment is constructed from a positive allowlist. It never
  spreads `process.env`, reads an interactive profile, or reuses user state.
- Prompts, reasoning, model output, source, diffs, tool inputs/results, commands,
  arguments, paths, environments, credentials, session transcripts, raw SDK
  messages, stderr, and provider bodies never enter Kogg logs, diagnostics,
  metrics, durable lifecycle rows, or error strings.
- A query result, interrupt receipt, background-task snapshot, subprocess exit,
  or SDK `close()` call is an observation. Only the outer execution owner can
  prove cleanup from the process/cgroup inventory.
- No retry, resume, fork, model fallback, permission widening, remote control,
  or provider failover is implicit. A new attempt requires explicit authority.
- Provider usage/cost values are observations, not invoices or Kogg evidence.
  Unknown or absent usage stays unknown.
- Ranex evidence, verdict, qualification, and controlled merge retain their
  existing owners. Claude cannot attest its own output.

## Commit- and artifact-pinned source ledger

External material is used for patterns only. No copied code is approved by this
research record. Anthropic's Claude Code and Agent SDK repositories are
source-available distribution/documentation repositories governed by commercial
terms, not open-source licensed implementation repositories.

| Source | Exact revision/artifact and license | Reviewed paths | Security and maintenance result |
| --- | --- | --- | --- |
| [Claude Code](https://github.com/anthropics/claude-code/tree/005c5dade90c2c59c88d819d8723e7b579addb5e) | commit `005c5dade90c2c59c88d819d8723e7b579addb5e` (2026-08-25); Anthropic Commercial Terms, all rights reserved | `README.md`, `LICENSE.md`, `CHANGELOG.md`, `examples/settings`, `.devcontainer` | Establishes product provenance, supported installation surface, sandbox examples, data-use warning, and commercial reuse boundary. The repository does not publish the CLI implementation, so runtime claims require the exact distributed artifact and black-box qualification. |
| [Claude Agent SDK TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript/tree/86e1856fc3f5e404ccfe93a5ec5078754ef4fa8e) | commit `86e1856fc3f5e404ccfe93a5ec5078754ef4fa8e` (2026-08-25); Anthropic Commercial Terms, all rights reserved | `README.md`, `LICENSE.md`, `CHANGELOG.md` | The changelog supplies the versioned lifecycle and failure semantics and shows rapid, sometimes breaking evolution. Pinning a Git commit alone is insufficient because implementation is distributed through npm. |
| npm `@anthropic-ai/claude-agent-sdk` | version `0.3.246`; SHA-512 integrity `FtR0HoHHNqeqJWjZN8qLUAzZVFUI9ztXYNPPwv98Ecmv9qq2QTauI8IzkY26CC0mleWAqb9RQEW2C0OtiUliug==`; tarball SHA-1 `0009206e79ee0ae25f68ebb526584031cb5db048`; Anthropic Commercial Terms | `package.json`, `README.md`, `LICENSE.md`, `sdk.d.ts`, `sdk-tools.d.ts`, `sdk.mjs`, `bridge.d.ts`, `bridge.mjs`, `manifest.json`, `manifest.zst.json` | Select the public typed SDK surface and custom process-spawn seam, subject to explicit legal/reuse review. Generated declarations are the closed compatibility input; minified runtime files are not copied or treated as auditable confinement. Exact tarball integrity and bundled CLI parity are qualification gates. |
| [Eclipse Theia](https://github.com/eclipse-theia/theia/tree/647dd3c7091b25ef3fc735edb74b949e7a195754) | `v1.74.1`, commit `647dd3c7091b25ef3fc735edb74b949e7a195754` (2026-08-06); EPL-2.0 or GPL-2.0-only with Classpath Exception, with separately identified MIT/VS Code material | `packages/ai-claude-code/src/node/claude-code-service-impl.ts`; `src/common/claude-code-service.ts`, `claude-code-preferences.ts`; browser frontend/chat/edit services | Preserve the Theia contribution and streaming presentation seams. Reject the current service as a governed boundary because it loads ambient SDK/settings/state, inherits the full environment, writes hooks to the workspace, transmits raw approvals, logs raw stderr/errors, and uses abort-only cancellation. |
| [Node.js](https://github.com/nodejs/node/tree/490a9fef8f8adcda5a95bd6f96035b05cb43fe5b) | `v22.23.2`, commit `490a9fef8f8adcda5a95bd6f96035b05cb43fe5b` (2026-01-13); MIT | `lib/child_process.js`; `doc/api/child_process.md`; `test/parallel/test-child-process-abortcontroller.js` | Use explicit stdio ownership and spawn/error/exit/close/backpressure distinctions. A Node handle or abort signal cannot prove all Linux descendants stopped. |
| [Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | vendored provenance commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25); MIT | `src/ranex/cli/delegation.py`; `src/ranex/observability/schema.py`, `redaction.py`; `docs/adr/ADR-010-first-delegation.md`, `ADR-015-durable-execution-watchdog-first.md`, `ADR-033-kernel-owned-delegated-provider-credential-broker.md`; `docs/slices/done/SLICE-012-provider-watchdog.md` | Preserve register-before-spawn, empty-by-default environments, process-group ownership, idle/absolute deadlines, bounded cleanup, startup reconciliation, closed events, and kernel-owned credentials. Kogg must not copy content-bearing tails or assume Ranex evidence authority. |

Official Anthropic documentation for headless operation, the TypeScript SDK,
sessions, permissions, sandboxing, hooks, settings, environment variables, data
usage, and monitoring was reviewed on 2026-08-27. Because the hosted pages are
not commit-pinned, they corroborate but do not replace the pinned declarations,
changelog, artifact integrity, and real-boundary probes.

## Source findings

### Agent SDK lifecycle and transport

`query()` launches Claude Code and returns an async generator of typed SDK
messages. Streaming-input mode exposes initialization, interrupt, task-stop,
settings/model controls, input streaming, and close. The exact declaration set
includes a custom `spawnClaudeCodeProcess` callback, allowing Kogg to retain
process registration and stdio ownership instead of letting an opaque default
spawn bypass the operation registry.

The selected V1 shape uses one streaming-input query for one attempt. It does
not use the one-shot string form because an interrupt is only available in
streaming mode and one-shot completion may be held for background work. It does
not use `startup()`/warm queries, because pre-spawning disconnects process and
credential lifetime from an authorized attempt and complicates recovery.

The initialization result reports models, agents, commands, account information,
output styles, and capability details. Kogg must compare a closed, qualified
projection before sending the prompt. Unexpected agents, plugins, MCP servers,
skills, commands, remote controls, or dynamic capability surfaces fail closed;
the raw initialization payload is content-bearing and not logged.

The current SDK reports typed `command_lifecycle` states and a
`background_tasks_changed` full snapshot. Interrupt receipts can report work
still queued, and a capability controls cancellation of queued commands. These
are materially stronger than inferring completion from the async iterator. They
remain version-specific: recent changelog entries added terminal reasons,
background snapshots, queue cancellation, process leak fixes, abort handling,
and task-stop semantics. #95 must vendor a closed compatibility schema derived
from the pinned declarations and reject older or unknown behavior.

### Completion, interruption, and background work

The SDK `interrupt()` is cooperative. Recent versions distinguish interruption
of the current turn from background agents/workflows, and the result depends on
whether the host declares a per-task stop affordance. `stopTask()` targets a
reported background task. `close()` is documented to terminate the underlying
process and clean SDK resources, but that is an SDK contract rather than an
independent process-tree observation.

The CLI can run Bash jobs, background tasks, subagents, async hooks, MCP servers,
language servers, and other helpers. Interactive documentation says background
tasks are cleaned on Claude exit, while hooks may continue asynchronously and
deliver results later. Therefore none of these proves outer cleanup:

- a success/error result message;
- a terminal reason or completed command lifecycle;
- an interrupt receipt;
- an empty SDK background-task snapshot;
- successful `stopTask()`;
- iterator completion;
- `close()` returning; or
- the immediate Claude process exiting.

Kogg must first freeze input, interrupt with queue cancellation when supported,
await matching terminal observations only until a cleanup sub-deadline, stop all
reported background tasks, call `close()`, revoke credentials, terminate and
join the qualified Linux scope, drain bounded pipes, and independently require
zero registered and unregistered descendants. Any residual makes cleanup and the
attempt fail even when Claude reported success.

V1 disables background tasks and subagents (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`
plus a closed tool/capability set) because parent/child authority and detached
lifetime are not yet qualified. The outer inventory still tests for their
appearance; a configuration flag is not proof.

### Settings, sessions, and ambient state

By default Claude Code stores plaintext session transcripts under the user's
Claude home, loads user/project/local settings and memory, and can resume or fork
sessions. The SDK supports `settingSources: []` as isolation mode, but managed
policy sources may still apply. Project content can also carry `.claude`
settings, hooks, skills, agents, commands, and MCP configuration.

Kogg therefore creates a private scratch home and Claude state directory within
the run, passes `settingSources: []`, supplies a closed inline settings object,
and separately verifies effective initialization. The private repository is
scanned or mounted so untrusted `.claude` customization cannot become execution
authority. The selected options set no resume, continue, fork, checkpoint,
plugin, skill, agent, or MCP surfaces. `strictMcpConfig` alone is insufficient;
the effective server set must be empty.

Sessions persist conversation content separately from filesystem state. V1
never resumes after crash or backend restart because prior side effects cannot
be proven absent. Private transcript/state paths are removed only after proved
cleanup and output qualification; otherwise they are quarantined with access
restricted to the owning recovery operation. Their content is never copied into
support diagnostics.

### Permissions and sandboxing

Claude permissions and Bash sandboxing are complementary but not a complete
Kogg boundary. Built-in file tools use permission controls rather than the Bash
sandbox. On Linux the Bash sandbox uses Bubblewrap and a network proxy, but the
documented default can warn and run unsandboxed if dependencies are missing.
Commands may also request an intentional unsandboxed retry unless disabled.

Kogg sets sandbox availability to hard-fail, disables unsandboxed commands,
provides no excluded commands or additional write roots, and uses deny-first
tool rules. It does not select bypass or auto permission modes. The qualified
outer Linux profile remains authoritative for mounts, network, resources,
process ownership, and cleanup, including built-in non-Bash tools.

The `canUseTool` callback receives raw tool input. Kogg may inspect it transiently
inside the authorized control path, but it cannot log, persist, or send it to a
generic frontend approval record. Frozen policy decides allow or deny. An action
that needs new user authority becomes a typed blocked/refused result; no model,
auto classifier, hook, or provider-native reviewer can self-approve it. A
permission callback has a hard deadline and is cancelled with the attempt.

### Credentials, network, and telemetry

The SDK allows a caller-provided environment and Claude Code supports API keys,
interactive login, provider-specific credentials, helpers, and managed settings.
Theia's reference implementation spreads `process.env` and inserts
`ANTHROPIC_API_KEY`; Kogg rejects that pattern. Raw secrets must not appear in
argv, browser preferences, logs, diagnostics, support bundles, or a broadly
inherited environment.

#95 must select a qualified brokered credential mechanism scoped to the frozen
provider/model and run. If the pinned Claude build cannot consume such a grant
without a reusable environment or user credential file, the prototype is
blocked rather than weakened. The private state owner must revoke the grant and
prove deletion/quarantine during cleanup.

Claude can emit optional telemetry, error reports, feedback bundles, surveys,
update checks, WebFetch preflights, and other nonessential traffic. Kogg disables
telemetry, error reporting, feedback, surveys, auto-updates, remote control, and
all nonessential traffic, then constrains the outer network policy to the exact
qualified provider/broker endpoints. Claude's own OpenTelemetry stream is not
Kogg's lifecycle authority and may expose high-cardinality account/session
identifiers or content when configured incorrectly.

### Theia integration review

Theia's `ai-claude-code` service demonstrates useful SDK streaming and a Theia
RPC contribution. Its governed properties are insufficient:

- it resolves a custom or global SDK path without digest attestation;
- selects the requested cwd or backend process cwd rather than a private run;
- writes backup and stop hooks plus local settings into that workspace;
- loads user, project, and local setting sources;
- spreads the full backend environment and adds the API key;
- forwards raw tool name/input to browser approval and has no approval deadline;
- logs raw SDK stderr, paths, tool input, and caught errors;
- aborts on cancellation/result but does not await typed cleanup or reconcile
  descendants; and
- keeps process and approval state only in memory.

Kogg can reuse conceptual presentation seams, not this service implementation.
The backend owns the governed adapter and sends the browser only bounded content
for the authorized view plus a safe lifecycle projection. The browser never
receives credentials, raw provider errors, process handles, or cleanup authority.

### Node and Ranex supervision patterns

Node reports spawn failure, exit, and pipe close separately; pipe close may lag
exit. The custom spawn implementation must bind the pre-registered process,
handle every event order once, bound stdout/stderr and write queues, reject
post-cancel input, drain without waiting indefinitely, and preserve source maps.
An `AbortController` is a cooperative signal, not descendant proof.

Ranex demonstrates the required outer shape: positive environment construction,
process-group ownership, absolute and idle watchdogs, cancel-all-then-join,
startup reconciliation with an empty work queue, and a closed safe event schema.
Kogg preserves those invariants at its boundary without duplicating Ranex's
journal, content tails, evidence qualification, or verdict authority.

## Selected adapter sequence for #95

#95 must specify this sequence with exact types, deadlines, and rollback:

1. Validate the frozen task/role/provider/model grant, exact npm integrity,
   bundled CLI/version/type digest, adapter version, execution profile,
   credential grant, budgets, and deadlines.
2. Allocate the private full Git repository, scratch home, Claude state,
   protocol buffers, quarantine record, and qualified Linux scope. Reject shared
   Git metadata, source mounts, user paths, or untrusted customization.
3. Persist a process-intent record before invoking the SDK. Install a custom
   `spawnClaudeCodeProcess` that uses only the registered scope and fixed
   executable/argv/environment.
4. Create a streaming-input `query()` with a positive environment, isolated
   setting sources, exact model, no fallback/resume/fork, closed tools, no
   agents/skills/plugins/MCP/hooks/background work, hard-fail sandbox settings,
   and bounded stderr sink that never logs content.
5. Await initialization within deadline and compare exact safe capabilities,
   effective model/provider class, empty optional surfaces, and required
   interrupt/queue/task lifecycle support. Reject mismatch before the prompt.
6. Send one correlated user message and map accepted SDK observations into the
   Kogg attempt state. Content streams only through the authorized bounded UI
   channel and bypasses lifecycle persistence.
7. Enforce max turns, provider budget, idle deadline, absolute deadline, output
   bounds, and permission deadline externally. SDK values are defense-in-depth.
8. On result, failure, cancel, timeout, protocol fault, or process exit, close
   input and enter `terminal_observed` then `cleaning`; never jump to completed.
9. Interrupt with queued-command cancellation when qualified, await the receipt
   and matching terminal observations within the cleanup sub-deadline, stop all
   reported tasks, and record only safe counts/codes.
10. Call `close()`, revoke credentials, terminate/escalate the Linux scope, drain
    bounded pipes, and cross-check durable records against zero descendants and
    closed handles.
11. Qualify or quarantine output/state, persist the safe terminal outcome and
    cleanup proof, and release resources through the owning execution lifecycle.

## Process and capability inventory

| Possible process/capability | V1 owner and disposition |
| --- | --- |
| Kogg TypeScript adapter | Backend-owned, source-mapped, covered by `kogg:agents:claude-adapter`. |
| Bundled Claude Code process | Registered before spawn through the SDK callback; exact package/binary provenance; one attempt. |
| Bash/unified command children | Allowed only by the frozen tool policy inside the private repository and external scope; always inventoried. |
| Background Bash/tasks | Disabled; if observed, terminate and fail capability qualification. |
| Claude subagents/agent teams | Disabled until explicit child authority, model accounting, limits, and cleanup are qualified. |
| Hooks/status line/language servers | Disabled; no project/user hook execution. Any process is unexpected. |
| MCP/plugin/skill/command helpers | Disabled with empty configuration and customization lockdown. |
| Browser/computer use/remote control/agent view | Disabled and excluded from the accepted initialization surface. |
| Credential helper/broker | Owned by the qualified credential boundary, not Claude; no secret in argv/logs/browser. |
| Git helpers | Confined to private Git state, registered as descendants, no source-repo authority. |

Every descendant must map to one expected class and owner. Unknown, escaped,
stalled, orphaned, or residual processes block release.

## Failure and recovery contract for #95

The closed taxonomy must distinguish at least: authorization/provenance failure,
package/type/bundled-version mismatch, confinement failure, credential
unavailable or revoked, spawn failure, initialization timeout/rejection,
capability/settings mismatch, model mismatch/fallback, prompt rejection,
unexpected permission request, permission timeout, protocol parse/order/overflow,
SDK queue overflow, API retry exhaustion, provider/rate/budget failure, idle
timeout, absolute timeout, user cancel, interrupt ambiguity, still-queued command,
background/residual task, Claude crash/EOF, child escape, cleanup timeout,
residual process, output-integrity failure, and startup recovery.

Provider-native retries are visible activity but cannot extend the absolute
deadline or change provider/model. Kogg does not add a second automatic retry.

At backend startup, recovery reconciles every nonterminal intent against the
durable lease, PID/cgroup identity, private paths, credential state, and output
quarantine. A live scope without the current owner is fenced and cleaned. A dead
scope with an incomplete attempt becomes failed and enters cleanup/quarantine.
V1 never resumes the Claude session or replays the prompt because prior external
and filesystem side effects cannot be proven absent. Concurrent reconcilers are
fenced by a durable ownership generation.

## Safe observability and diagnostics

Production uses a Theia `ILogger` named `kogg:agents:claude-adapter` with stable
events for request validation, process intent/start, initialization, turn start,
safe activity heartbeat, provider terminal, permission refusal, cancellation,
deadlines, SDK close, process escalation, cleanup, recovery, and final outcome.

The allowed field vocabulary is closed: opaque Kogg operation/attempt and safe
parent IDs, adapter/package/bundled version and digests, schema digest,
requested/observed model identifiers only if classified safe, lifecycle state,
event type, counts, durations, deadline class, exit/signal class, cleanup result,
residual count, and typed error code. Error type is normalized from a positive
allowlist; raw exception names/messages are not automatically safe.

Never log raw SDK messages, stdout/stderr, prompts, reasoning, output, source,
diffs, commands, tool names with user extensions, tool inputs/results, paths,
environments, settings, provider/account/session IDs, credentials, personal
data, URLs, raw exceptions, or content-derived hashes. Sanitization is positive
field construction before logging, not regex scrubbing afterward.

Diagnostics expose only qualified package/schema state, supervisor readiness,
attempt counts by safe state, oldest age bucket, registered/active/residual
process counts, permission-wait count, deadline/cancel/cleanup failures, recovery
backlog, and last safe failure code. Runtime checks cross-check durable attempts
with the external process inventory; SDK snapshots and Claude telemetry are
supplements, never authority.

#97 must add a specific diagnostic catalog/runtime check, failure tests for any
signal whose absence could hide stuck or residual work, and debugger proof
across browser, Node backend, SDK boundary, Claude process, and Linux execution
owner. Source maps stay enabled and `yarn audit:observability` remains blocking.

## Prototype and real E2E evidence

#96 must use the exact tarball, bundled CLI, declarations, and qualified Linux
profile to probe: package/type attestation; custom spawn registration; isolated
settings and private state; initialization mismatch; one real edit/command in the
private repository; fixed model; permission allow/deny/timeout; interrupt while
streaming; queued-command cancellation; background task/subagent attempts;
`close()` during work; Claude crash; malformed/unknown/duplicate/out-of-order and
oversized messages; stdin/stdout backpressure; stderr flood; API retry/idle stall;
credential revocation; sandbox unavailable/escape hatch attempt; child escape;
cgroup escalation; backend restart with an empty queue; and zero residual
processes/state/credentials after every outcome.

#97 real human-level E2E drives the Theia UI through one governed Claude task,
observes safe progress, refuses an out-of-policy action, cancels one run, finishes
another, inspects only the private repo, and verifies diagnostics plus the
external process inventory. Seeded prompt, secret, path, command, output, source,
diff, session, and stderr canaries must be absent from logs and support bundles.
Ranex evidence and verdict remain independently required.

## Rejected alternatives

| Candidate | Decision |
| --- | --- |
| Reuse Theia's current `ClaudeCodeServiceImpl` | Reject as governed boundary: ambient package/settings/environment/state, workspace mutation, raw approvals/logs, and abort-only cleanup. |
| Invoke `claude -p` and parse text | Reject. `stream-json` is stronger but the typed SDK supplies initialization/control/task lifecycle and a custom spawn seam. |
| Use the SDK default opaque spawn | Reject; Kogg must register and bind the process before start. |
| Import a global/latest SDK | Reject; exact npm integrity, declarations, bundled parity, and legal review are mandatory. |
| Copy or modify minified commercial SDK/CLI code | Reject absent explicit legal/reuse approval. Use the supported boundary and black-box probes. |
| Reuse user `~/.claude`, login, settings, sessions, or keyring | Reject; leaks personal state/content and permits mutation outside the run. |
| Load project `.claude` customizations | Reject for V1; untrusted hooks/plugins/skills/agents/MCP can add authority and processes. |
| Spread `process.env` or pass a reusable API key | Reject; use a positive environment and qualified brokered credential mechanism. |
| Select bypass/auto permissions | Reject. Frozen Kogg policy decides; unexpected requests are refused. |
| Rely only on Claude's Bash sandbox | Reject; it excludes built-in tools and can degrade/escape unless locked down. Outer confinement is authoritative. |
| Treat result, interrupt, empty background snapshot, exit, or `close()` as cleanup | Reject; require external zero-descendant proof. |
| Enable background agents, hooks, MCP, plugins, skills, remote control, or browser use | Reject until each owner, authority, visibility, resource limit, and cleanup path is qualified. |
| Automatically resume/replay after crash | Reject; prior side effects may exist. A new attempt requires authority. |
| Persist raw SDK stream for debugging | Reject; it contains prompts, code, tool data, paths, reasoning, output, and personal/provider state. |
| Trust Claude cost/telemetry as evidence | Reject; usage is optional/provider-derived and telemetry is not lifecycle or verdict authority. |

## Decisions required from #95

#95 must resolve exact package/type/bundled attestation; legal/reuse approval;
custom spawn and process binding; accepted initialization projection; effective
settings verification; exact tool/permission/sandbox policy; provider/model
verification and fallback prohibition; brokered credentials; content-channel
bounds; command/background lifecycle handling; idle/absolute/permission/cleanup
deadlines; queue cancellation; signal escalation; durable recovery lease;
quarantine/deletion ownership; closed lifecycle/failure/log schemas; diagnostic
catalog contract; and every #96 fault-injection seam.

The largest open risk is credential delivery compatible with the commercial
runtime without a reusable environment or user credential store. The second is
whether the custom SDK spawn seam exposes enough process identity and stdio
control to meet register-before-spawn and cleanup proof without unsupported
runtime modification. #95 must name exact mechanisms or explicitly block #96;
it may not hide either gap behind the SDK's convenience API.

## Research gate conclusion

- Sources and the distributed SDK artifact are pinned with revisions/integrity,
  terms, reviewed paths, and security/maintenance implications.
- Selected patterns and rejections are explicit, including Theia reuse, global
  SDK discovery, ambient state/environment, bypass permissions, sandbox fallback,
  provider-owned cleanup, automatic resume, and raw event persistence.
- Process, capability, logging, diagnostics, credentials, failure, recovery,
  confinement, observability, and E2E risks are enumerated.
- The selected boundary and required decisions are specific enough for #95 to
  write decision-complete pseudocode without reopening the adapter topology.

Production remains blocked until #95, #96, and #97 complete in order and all
observability, diagnostics, debugger, real E2E, Ranex evidence, verdict,
commercial-terms review, and zero-residual-process gates pass.
