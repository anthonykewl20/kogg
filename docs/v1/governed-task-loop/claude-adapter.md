# Governed Claude Code adapter

Tracking: [#93](https://github.com/anthonykewl20/kogg/issues/93), research
phase [#94](https://github.com/anthonykewl20/kogg/issues/94), and pseudocode
phase [#95](https://github.com/anthonykewl20/kogg/issues/95).

## Status

Research and decision-complete pseudocode are complete as of 2026-08-27. This
packet contains no production code. It fixes the contract that #96 must probe at
the real Claude boundary and that #97 must implement with real E2E evidence.

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

## Decision-complete adapter contract and pseudocode

The following contract is normative for #96 and #97. `MUST`, `MUST NOT`, and
`FAIL` denote release-blocking behavior. Names are stable schema names, not an
instruction to copy the illustrative TypeScript literally.

### Artifact, types, and legal gate

The only accepted package is `@anthropic-ai/claude-agent-sdk@0.3.246` with npm
SHA-512 integrity
`FtR0HoHHNqeqJWjZN8qLUAzZVFUI9ztXYNPPwv98Ecmv9qq2QTauI8IzkY26CC0mleWAqb9RQEW2C0OtiUliug==`
and tarball SHA-1 `0009206e79ee0ae25f68ebb526584031cb5db048`.
The checked-in lockfile, installed tarball, `package.json`, `sdk.d.ts`,
`sdk-tools.d.ts`, `bridge.d.ts`, bundled Claude executable manifest, and the
adapter's generated compatibility projection MUST hash to a signed manifest.
The manifest key is a Kogg release key, not an Anthropic credential.

```text
record ClaudeArtifactManifestV1 {
  schema = "kogg.claude-artifact/v1"
  packageName = "@anthropic-ai/claude-agent-sdk"
  packageVersion = "0.3.246"
  npmIntegritySha512: exact string
  tarballSha1: exact string
  fileDigests: sorted map<relativePath, sha256>
  bundledCliVersion: exact string
  typeProjectionSha256: sha256
  adapterSchemaSha256: sha256
  createdAt: RFC3339
  signingKeyId: release key id
  signature: detached signature over canonical record
}

verifyArtifact():
  reject symlinks, extra executable candidates, missing files, or path escape
  hash bytes without importing or executing the package
  verify manifest signature and every exact field
  derive the supported declaration projection and compare its digest
  run bundled CLI version probe inside the qualified empty execution scope
  if any mismatch: FAIL CLAUDE_ARTIFACT_MISMATCH before credential mint or spawn
```

Use is additionally gated by a repository-controlled
`ClaudeCommercialUseApprovalV1` containing the exact package integrity,
approved product/use, approver identity reference, decision timestamp, expiry,
and detached signature. It contains no contract text or personal data. Missing,
expired, mismatched, or invalid approval yields `CLAUDE_LEGAL_APPROVAL_REQUIRED`.
Kogg MUST NOT copy, patch, de-minify, redistribute separately, or claim to audit
the commercial runtime. #96 may proceed only after this record is supplied by
an authorized maintainer; otherwise it records the closed blocker and #97 stays
disabled.

### Owned components and trust boundaries

```text
ClaudeArtifactRegistry  owns byte/type/version/legal attestation
ClaudeAdapterFactory    accepts one frozen authorized attempt
ClaudeAttemptStore      owns durable non-content lifecycle and recovery lease
ClaudeProcessHost       owns cgroup, uid, mount, network, stdio, signals, cleanup
ClaudeSdkBridge         owns one query iterator and typed message validation
ClaudeCredentialBroker  owns short-lived local proxy grants and revocation
ClaudeContentRouter     keeps content in bounded volatile UI channels only
ClaudeDiagnostics       exposes safe checks and support projections
ClaudeAdapterFrontend   renders status/permission/cancel without raw logging
```

The task controller is authority for role, provider, model, repository revision,
permission profile, budgets, and admission. `ClaudeAdapterFactory` MUST accept
only an immutable `GovernedClaudeAttemptV1` whose digest is already bound to an
approved task revision. The adapter never edits that record.

```text
record GovernedClaudeAttemptV1 {
  attemptId: uuid
  taskRevisionDigest: sha256
  repositoryBindingDigest: sha256
  privateRepoObjectId: opaque id
  baseCommit: 40-hex object id
  role = "implementation"
  provider = "anthropic"
  model: exact allowlisted Anthropic model id
  artifactManifestDigest: sha256
  legalApprovalDigest: sha256
  permissionProfileDigest: sha256
  executionProfileDigest: sha256
  budgets: { inputTokens, outputTokens, toolCalls, bytesIn, bytesOut }
  deadlines: DeadlineProfileV1
  authorityDigest: sha256
}
```

Unknown fields, duplicate map keys, noncanonical encodings, unsupported schema
versions, mutable references, symbolic model aliases, or a mismatch to current
task authority yield `CLAUDE_ATTEMPT_INVALID` before side effects.

### Isolation and effective settings

V1 runs only on a qualified Linux worker. macOS and Windows may render/control
the task but MUST NOT host Claude. Each attempt receives a new uid, cgroup v2
subtree, mount namespace, PID namespace, private `/tmp`, read-only runtime and
certificate mounts, writable private Git worktree, and no host checkout, Git
common directory, Docker socket, SSH agent, browser socket, keyring, home, or
user configuration. Seccomp/AppArmor/landlock enforcement and cgroup accounting
are release-profile requirements; an unavailable control fails admission with
`CLAUDE_CONFINEMENT_UNAVAILABLE`.

The child environment is constructed exactly from this positive projection:

```text
HOME=/run/kogg/claude/<attempt>/home
TMPDIR=/run/kogg/claude/<attempt>/tmp
PATH=<read-only qualified runtime paths>
LANG=C.UTF-8
LC_ALL=C.UTF-8
NO_COLOR=1
CI=1
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
ANTHROPIC_BASE_URL=http://<private-broker-socket-authority>/v1
ANTHROPIC_API_KEY=<one-attempt opaque bearer>
```

No value is inherited from `process.env`. `settingSources: []` is mandatory.
The private home begins empty and remains attempt-scoped. Project/user/local
settings, `.claude`, `CLAUDE.md`, memory, sessions, hooks, plugins, skills,
agents, MCP, IDE integration, telemetry exporters, and remote control are not
mounted or loaded. The accepted initialization projection is:

```text
record ClaudeInitializationProjectionV1 {
  model: exact requested model
  permissionMode: "default"
  tools: sorted exact V1 tool ids
  mcpServers: []
  plugins: []
  slashCommands: []
  agents: []
  accountOrganization: absent-or-redacted-equality-token
  cliVersion: exact attested version
}
```

Initialization is decoded with a closed schema. Any fallback model, added tool,
setting source, MCP server, plugin, agent, command, hook, or version mismatch
causes immediate cancellation and `CLAUDE_INITIALIZATION_MISMATCH`.

### Tool and permission policy

The closed V1 tool set is `Read`, `Edit`, `Write`, `Glob`, `Grep`, and `Bash`.
Their presence does not grant every invocation. `Task`, subagents, notebooks,
web search/fetch, browser/computer use, MCP, hooks, plugins, skills, remote
control, background commands, and provider-defined future tools are denied.

```text
decidePermission(request, frozenPolicy):
  decode request with closed schema; unknown/duplicate => deny + protocol fail
  require request.attemptId == active attempt
  require toolId in frozenPolicy.toolIds
  canonicalize every path beneath private repository using openat2-style rules
  reject symlink, device, procfs, sysfs, socket, mount, or repository escape
  for Bash:
    parse against frozen command policy
    reject shell indirection, daemonization, network clients, privilege changes,
      namespace changes, backgrounding, process-control escape, and unknown bin
  require remaining tool-call and byte budgets
  present a content-bearing request only through the authorized volatile UI
  wait at most permissionDecisionMs for an explicit decision bound to request id
  revalidate authority, freeze state, request digest, paths, and budgets
  return allow-once or deny; never widen future authority
```

The callback MUST NOT trust SDK path normalization, suggested permission
updates, or provider display text. It MUST NOT log request content. A duplicate,
late, unknown, or already-decided request fails with
`CLAUDE_PERMISSION_PROTOCOL`; timeout is `CLAUDE_PERMISSION_TIMEOUT`; a valid
denial is `CLAUDE_PERMISSION_DENIED` and is visible but not an adapter fault.

Outer Linux confinement remains authoritative even for allowed calls. The
Claude sandbox is enabled as defense in depth with network and escape hatches
disabled. If the runtime reports sandbox degradation or an attempt asks to
bypass it, fail `CLAUDE_SANDBOX_DEGRADED`.

### Credential delivery and network policy

The credential gap is resolved with a loopback/private-namespace broker, not a
reusable provider key. Immediately before spawn, `ClaudeCredentialBroker`
mints a random bearer that authorizes only one attempt, cgroup identity,
provider, exact model, request direction, byte/token ceilings, and expiry. The
bearer appears in the child environment because the supported runtime requires
an API-key-shaped value, but it is useless at Anthropic and outside the private
broker. The broker holds the upstream credential in protected memory, injects
authorization only on the outbound hop, validates response model identity when
available, and never exposes upstream headers or bodies.

```text
mintGrant(attempt):
  require active authority + qualified scope + registered cgroup
  expiresAt = min(now + absoluteDeadline, configured grant maximum)
  persist only sha256(bearer), binding digests, expiry, and revoked flag
  return bearer once through parent-owned anonymous pipe/environment builder

proxy(request):
  authenticate bearer hash and peer/cgroup identity
  require active attempt, exact endpoint family, exact model, and budgets
  stream body without logging or persistence; enforce bounded backpressure
  forward with upstream secret held only by broker
  validate status/content framing and account usage conservatively
  revoke on terminal state, authority loss, budget exhaustion, or anomaly
```

Network policy permits only the private broker endpoint and required name-less
local transport. Direct external DNS/IP traffic is denied. The broker is the
only component allowed Anthropic egress. Startup rotates its in-memory upstream
handle. A leaked child bearer expires and is revoked; it cannot be exchanged
after terminal cleanup. Failures use `CLAUDE_CREDENTIAL_UNAVAILABLE`,
`CLAUDE_CREDENTIAL_REVOKED`, or `CLAUDE_PROVIDER_PROTOCOL`, never secret text.

### Register-before-spawn and SDK bridge

Exactly one SDK `query()` with streaming input is created per attempt. The SDK
receives the private repository path, exact model, `settingSources: []`, closed
tools, permission callback, sandbox enabled, no resume/session id, and the
Kogg-owned `spawnClaudeCodeProcess` implementation.

```text
spawnClaudeCodeProcess(options):
  require state == SPAWN_RESERVED and single-use spawn nonce
  validate executable digest, argv shape, cwd, env keys, and stdio contract
  create durable process reservation with attempt/cgroup/uid/profile digests
  create cgroup and attach stopped bootstrap process before runtime exec
  persist process identity using pidfd + start-time token
  transition SPAWN_RESERVED -> SPAWN_REGISTERED
  release bootstrap to exec exact attested executable
  return SDK-compatible transport over bounded parent-owned pipes
```

Any second spawn request, executable/argument/environment mutation, failed
registration, identity ambiguity, or process outside the cgroup fails closed.
The host never logs argv, environment, cwd, stderr, or raw spawn errors.

The bridge has bounded queues: 256 control messages, 4 MiB aggregate volatile
content, 1 MiB per decoded frame, and 64 KiB safe stderr counter window with no
retained bytes. Backpressure pauses reads before limits. Exceeding a bound yields
`CLAUDE_PROTOCOL_OVERFLOW`. Every SDK message is decoded into either a safe
lifecycle projection or volatile content; unknown type, invalid order, duplicate
terminal, missing correlation, or schema mismatch is `CLAUDE_PROTOCOL_INVALID`.

```text
runBridge(attempt, promptHandle):
  query = sdk.query({ prompt: one bounded AsyncIterable(promptHandle), options })
  for await message of query:
    reset idle deadline only after a valid expected progress message
    project safe lifecycle fields to AttemptStore
    route prompt/output/tool content to volatile ContentRouter
    account conservative usage without persisting provider text
    process permission/control messages through closed handlers
    stop accepting messages after first terminal result
  observe iterator end; do not infer cleanup
```

The initial prompt is consumed once. Kogg does not persist it through this
adapter. Output is rendered to the authorized live client with bounded memory;
disconnect discards it or applies upstream controller policy, never silently
persists it. Provider session ids are held only in volatile memory and are not
accepted for resume, fork, or replay.

### Lifecycle, cancellation, and deadlines

Durable states are closed:

```text
ADMITTED -> SPAWN_RESERVED -> SPAWN_REGISTERED -> INITIALIZING -> RUNNING
RUNNING -> PERMISSION_WAIT -> RUNNING
RUNNING|PERMISSION_WAIT -> CANCELLING
RUNNING -> RESULT_OBSERVED
any nonterminal -> CLEANING
RESULT_OBSERVED -> CLEANING
CLEANING -> SUCCEEDED | CANCELLED | FAILED | QUARANTINED
```

Only `SUCCEEDED`, `CANCELLED`, `FAILED`, and `QUARANTINED` are terminal. A result
cannot transition directly to success. Success requires: expected result,
provider/model match, valid protocol, budgets satisfied, authority still valid,
query iterator ended, `close()` observed, credential revoked, zero live cgroup
members, private Git repository intact, and durable cleanup proof committed.

```text
DeadlineProfileV1 {
  spawnMs = 10_000
  initializeMs = 30_000
  firstProgressMs = 60_000
  idleMs = 120_000
  permissionDecisionMs = 60_000
  interruptReceiptMs = 5_000
  gracefulExitMs = 10_000
  terminateMs = 5_000
  killMs = 5_000
  closeMs = 5_000
  cgroupEmptyMs = 10_000
  absoluteMs = controller-authorized, max 3_600_000
}
```

An operator cancel, authority revocation, deadline, budget failure, client
shutdown, protocol failure, or broker anomaly enters `CANCELLING` exactly once:

```text
cancel(reason):
  stop prompt/control admission and deny pending permissions
  revoke broker grant
  call query.interrupt(); wait interruptReceiptMs
  call query.stopTask for every observed foreground/background task id
  call query.close(); wait closeMs
  send SIGTERM to cgroup; wait gracefulExitMs + terminateMs total bound
  send SIGKILL to remaining cgroup members; wait killMs
  verify cgroup empty externally using pidfd/start-time-safe inventory
  close pipes, discard volatile content, persist safe terminal projection
```

Cancellation operations are idempotent and monotonic. SDK `interrupt()`,
`stopTask`, iterator completion, process exit, `close()`, and an empty SDK task
snapshot are observations only. If the external inventory is nonempty or
identity cannot be proven, terminal state is `QUARANTINED` with
`CLAUDE_RESIDUAL_PROCESS`; never delete or reuse the private repository.

### Crash recovery and repository disposition

The store writes each transition and reservation in one SQLite transaction with
an idempotency key, previous-state digest, monotonic sequence, and non-content
safe code. One backend owns a renewable recovery lease. On startup it scans all
nonterminal Claude attempts before admitting new ones.

```text
recover(attempt):
  acquire lease using compare-and-swap
  validate event chain and process reservation
  revoke any broker grant by stored bearer hash
  inventory matching cgroup + pidfd/start-time identities externally
  perform TERM/KILL escalation; require zero members
  mark FAILED(CLAUDE_BACKEND_RESTARTED) only after cleanup proof
  quarantine repository on any ambiguity, corruption, or residual process
```

No automatic query resume, replay, or retry exists. A process without a valid
reservation is killed and reported as `CLAUDE_UNREGISTERED_PROCESS`. A
reservation without a process still follows cleanup/reconciliation. A new
attempt requires fresh authority and a new private repository. Only the task
controller may later archive/delete a clean terminal repository; quarantined
repositories require explicit incident disposition and remain inaccessible to
Claude.

### Closed safe failure and observability schemas

The adapter exposes only these failure codes in V1:

```text
CLAUDE_ARTIFACT_MISMATCH          CLAUDE_LEGAL_APPROVAL_REQUIRED
CLAUDE_ATTEMPT_INVALID            CLAUDE_CONFINEMENT_UNAVAILABLE
CLAUDE_INITIALIZATION_MISMATCH    CLAUDE_PERMISSION_PROTOCOL
CLAUDE_PERMISSION_TIMEOUT         CLAUDE_PERMISSION_DENIED
CLAUDE_SANDBOX_DEGRADED           CLAUDE_CREDENTIAL_UNAVAILABLE
CLAUDE_CREDENTIAL_REVOKED         CLAUDE_PROVIDER_PROTOCOL
CLAUDE_SPAWN_FAILED               CLAUDE_SPAWN_PROTOCOL
CLAUDE_PROTOCOL_OVERFLOW          CLAUDE_PROTOCOL_INVALID
CLAUDE_MODEL_MISMATCH             CLAUDE_BUDGET_EXCEEDED
CLAUDE_IDLE_TIMEOUT               CLAUDE_ABSOLUTE_TIMEOUT
CLAUDE_INTERRUPTION_FAILED        CLAUDE_CLOSE_FAILED
CLAUDE_RESIDUAL_PROCESS           CLAUDE_UNREGISTERED_PROCESS
CLAUDE_BACKEND_RESTARTED          CLAUDE_STORE_INTEGRITY
CLAUDE_AUTHORITY_REVOKED          CLAUDE_INTERNAL
```

Unknown internal/provider errors map to `CLAUDE_INTERNAL`; their raw messages
are discarded. Logs use Theia `ILogger` names `kogg:claude:artifact`,
`kogg:claude:adapter`, `kogg:claude:process`, `kogg:claude:credentials`, and
`kogg:claude:recovery`. The closed events are:

```text
artifact.verify.start|success|failure
legal.verify.success|failure
attempt.admit.success|failure
process.reserve|spawn|exit|signal|cleanup
protocol.initialize|progress|result|failure
permission.request|decision|timeout
credential.mint|proxy.start|proxy.finish|revoke|failure
attempt.cancel.start|finish
recovery.start|reconciled|quarantine|failure
attempt.terminal
```

Every event contains only timestamp, event name, attempt correlation id,
component, lifecycle state, safe code, bounded duration, bounded counters, and
boolean outcome. It MUST NOT contain credentials, authorization values, bearer
hashes, prompts, reasoning, model output, source, diffs, paths, commands,
arguments, environments, tool inputs/results, session ids, personal/account
data, stderr, SDK messages, provider bodies, or raw errors. Tests seed a unique
canary in every prohibited channel and scan backend/frontend/Electron logs and
support exports for plaintext, encoded, fragmented, and error-wrapped forms.

### Diagnostic catalog and debugger contract

#97 MUST add these exact catalog ids; #96 supplies probe evidence for the same
contracts rather than inventing temporary diagnostic names:

| Catalog id | Safe check and failure meaning |
| --- | --- |
| `claude.artifact` | Signature, exact package/files/types/bundled CLI mismatch. |
| `claude.legal` | Commercial-use approval absent, expired, or mismatched. |
| `claude.settings` | Effective initialization differs from the closed projection. |
| `claude.protocol` | Decoder, ordering, queue, backpressure, or model failure. |
| `claude.credentials` | Broker readiness, grant binding, revocation, or egress failure. |
| `claude.processes` | Reservation, identity, cgroup, or descendant-accounting failure. |
| `claude.cleanup` | Interrupt/close/escalation or zero-member proof failure. |
| `claude.recovery` | Store chain, lease, startup reconciliation, or quarantine failure. |
| `claude.source-maps` | Browser/backend/Electron/adapter mapping or breakpoint failure. |

Diagnostics return status, catalog id, safe code, bounded counts/durations,
artifact/profile digests, and remediation id only. They never return content or
raw provider/runtime data. Every operational implementation file declares the
relevant `diagnostic-coverage` id. Pure declarations use a specific exemption.

Source maps remain enabled for browser, backend, Electron, and adapter bundles.
#97 debugger proof sets breakpoints in UI admission/cancel, backend lifecycle,
permission decision, custom spawn, broker proxy metadata validation, protocol
decoder, cleanup, and recovery. The commercial child is treated as an opaque
boundary; debugger reachability is required up to both sides of that boundary,
not inside minified vendor code.

### #96 probe and #97 visible E2E handoff

#96 MUST use the exact approved artifact and qualified Linux profile. Its
fixture supplies deterministic seams for every deadline, message type, spawn
mutation, settings mismatch, permission outcome, broker revoke, provider model
mismatch, crash, stderr flood, backpressure, descendant escape attempt, and
restart point. It also performs one explicitly authorized real-provider edit
and command in a disposable private repository. Every case asserts the closed
safe code, event sequence, credential revocation, and external zero-process
proof. A legal gate failure is a valid blocker, not permission to substitute an
unattested binary or fake the real-boundary result.

#97 visible browser and Electron E2E MUST:

1. create and approve a governed Claude task through the UI;
2. show the exact fixed provider/model and safe lifecycle status;
3. complete one real edit and allowed command only in the private repository;
4. visibly deny one out-of-policy tool/path request;
5. cancel a streaming attempt and prove it reaches clean terminal state;
6. restart the backend during a separate attempt and show safe reconciliation;
7. inspect diagnostics/support export and external process inventory;
8. verify no source checkout mutation, ambient Claude state, reusable secret,
   residual process, retry/resume, or canary leakage;
9. pass `yarn test`, `yarn audit:observability`, source-map checks, and real Ranex
   evidence/verdict/controlled-merge gates.

The expected safe trace for success is `attempt.admit.success`,
`process.reserve`, `process.spawn`, `protocol.initialize`, zero or more bounded
`protocol.progress`/permission events, `protocol.result`, credential revoke,
process cleanup, and `attempt.terminal`. Cancellation and recovery replace the
result path with their named events and still end in cleanup proof. Any missing
lifecycle boundary is test failure because it would prevent incident diagnosis.

No implementation choice remains for #96: artifact and legal gating, process
ownership, settings, permissions, credentials, lifecycle, deadlines, queues,
failure codes, diagnostics, debugger points, fault seams, and visible E2E are
fixed here. A probe may prove the supported runtime cannot satisfy a contract;
that result blocks production and returns to design rather than weakening the
contract.

## Research gate conclusion

- Sources and the distributed SDK artifact are pinned with revisions/integrity,
  terms, reviewed paths, and security/maintenance implications.
- Selected patterns and rejections are explicit, including Theia reuse, global
  SDK discovery, ambient state/environment, bypass permissions, sandbox fallback,
  provider-owned cleanup, automatic resume, and raw event persistence.
- Process, capability, logging, diagnostics, credentials, failure, recovery,
  confinement, observability, and E2E risks are enumerated.
- The selected boundary and required decisions are specific enough for #95 to
  hand #96 a decision-complete probe contract without reopening topology.

Production remains blocked until #95, #96, and #97 complete in order and all
observability, diagnostics, debugger, real E2E, Ranex evidence, verdict,
commercial-terms review, and zero-residual-process gates pass.
