# Role-oriented agent adapter protocol

Tracking: [#72](https://github.com/anthonykewl20/kogg/issues/72), research
phase [#75](https://github.com/anthonykewl20/kogg/issues/75).

## Status

Research is complete as of 2026-08-27. This packet contains no production code
and deliberately stops before decision-complete schemas and pseudocode. Those
belong to [#78](https://github.com/anthonykewl20/kogg/issues/78), followed by a
real-boundary prototype in #81 and production implementation in #84.

The research recommendation is a backend-owned agent-attempt state machine that
binds one immutable Kogg role snapshot to one explicitly resolved provider adapter
and model for the lifetime of an attempt. Provider protocols supply transport
events and usage observations; they never define Kogg role identity, authority,
completion, cleanup, recovery, evidence, or verdicts. Kogg owns the outer attempt,
cancellation deadline, process inventory, durable lifecycle projection, and safe
failure taxonomy. The qualified adapter owns its provider session and reports
bounded, normalized observations into that outer lifecycle.

## Scope and non-negotiable constraints

This slice must support later execution code that can:

- separate a governed role and its authority snapshot from provider, model, SDK,
  transport, and provider-native agent identity;
- resolve an adapter explicitly for each attempt, without ambient mutable default
  providers or fallback that silently changes policy;
- normalize request, start, activity, usage, completion, failure, timeout,
  cancellation, cleanup, and recovery across unlike provider protocols;
- supervise adapter hosts and every Kogg-created child while preserving the
  ownership boundary of Theia, Ranex, and qualified provider runtimes;
- represent child attempts and handoffs without allowing a parent or provider to
  widen authority;
- distinguish provider completion from Kogg attempt completion and from proved
  process cleanup; and
- make every refusal and failure diagnosable using safe identifiers and closed
  codes, without content-bearing telemetry.

The protocol must never log or place in diagnostics, durable lifecycle rows,
metrics, support artifacts, error messages, URLs, or correlation IDs: prompts,
model output, reasoning, source code, patches, diffs, tool arguments or results,
terminal output, command arguments, working directories, environments,
credentials, authorization material, cookies, personal data, or raw provider
request/response bodies. A digest derived from prohibited content is also
prohibited unless a later decision names a necessary local authority record and
proves that its disclosure and correlation risk is acceptable.

Agent execution is not task approval, evidence qualification, a Ranex verdict, or
merge permission. Workspace trust, frozen task authority, operation supervision,
credentials, worktrees, checks, evidence, and merge retain their existing owners.

## Commit-pinned source ledger

External source is used for patterns only. No copied code is approved by this
research record.

| Source | Exact revision and license | Reviewed paths | Finding |
| --- | --- | --- | --- |
| [Eclipse Theia](https://github.com/eclipse-theia/theia/tree/647dd3c7091b25ef3fc735edb74b949e7a195754) | `v1.74.1`, commit `647dd3c7091b25ef3fc735edb74b949e7a195754` (2026-08-06); EPL-2.0 or GPL-2.0-only with Classpath Exception, with separately identified MIT/VS Code material | `packages/ai-core/src/common/agent-service.ts`, `language-model.ts`; `packages/ai-chat/src/common/chat-agents.ts`, `chat-agent-service.ts`; `packages/ai-chat/src/browser/agent-delegation-tool.ts` | Keep the separation between an agent registry and provider-neutral language models, streaming, cancellation propagation, tool correlation, usage parts, and parent/child sessions. The browser delegation path is not durable authority or safe observability and can log prompt/error content, so it cannot be adopted as the governed boundary. |
| [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol/tree/b2731d52792d9c51fe49dcdb61f71c6908060e3e) | commit `b2731d52792d9c51fe49dcdb61f71c6908060e3e` (2026-08-26); Apache-2.0 | `docs/protocol/v1/overview.mdx`, `initialization.mdx`, `session-setup.mdx`, `prompt-turn.mdx`, `cancellation.mdx`, `tool-calls.mdx`, `terminals.mdx`; `docs/rfds/end-turn-token-usage.mdx`; `agent-client-protocol-schema/src/v1` | Capability negotiation, session/turn/update shape, typed tool states, permission requests, cancellation propagation, and bounded terminal operations are useful adapter patterns. Cancellation is optional and token usage remains partly draft, so ACP alone cannot prove cleanup or supply Kogg authority. |
| [OpenAI Codex](https://github.com/openai/codex/tree/bde9db1375667c50dcc0c2b52532a4e2672571c2) | commit `bde9db1375667c50dcc0c2b52532a4e2672571c2` (2026-08-26); Apache-2.0 | `codex-rs/app-server/README.md`; `app-server-protocol/src/protocol/common.rs`, `v2/turn.rs`, `v2/thread.rs`, `v2/notification.rs`; `app-server/tests/suite/v2/turn_interrupt.rs` | The initialize/thread/turn/item lifecycle and explicit interrupted terminal event are strong transport observations. Turn interruption resolves pending requests but does not terminate background terminals; Kogg needs separate process cleanup and residual proof. |
| [OpenAI Agents JS](https://github.com/openai/openai-agents-js/tree/eb690a4044470c322e2aac3c5b055ee11e2e0952) | commit `eb690a4044470c322e2aac3c5b055ee11e2e0952` (2026-08-26); MIT | `packages/agents-core/src/providers.ts`, `model.ts`, `agent.ts`, `run.ts`, `lifecycle.ts`, `usage.ts`; `runner/siblingCancellation.ts`, `runner/tracing.ts` | Model-provider separation, explicit model resolution, hooks, abort signals, turn/time bounds, handoffs, usage aggregation, and cancel-all-then-await cleanup are useful patterns. Global defaults, in-memory hooks, SDK run state, and content-rich tracing are rejected for governed authority and observability. |
| [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/tree/56d6b11a02129319bf371083fa134b7ce989c976) | commit `56d6b11a02129319bf371083fa134b7ce989c976` (2026-08-22); Apache-2.0 | `docs/gen-ai/gen-ai-agent-spans.md`, `gen-ai-spans.md`, `gen-ai-events.md`; `model/gen-ai/registry.yaml` | Distinguish operation, provider, model, and provider-native agent identity; use low-cardinality failure types and honest optional token observations. Content capture is opt-in upstream but remains forbidden in Kogg, and development-status telemetry semantics cannot define lifecycle authority. |
| [Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | vendored provenance commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25); MIT | `src/ranex/cli/delegation.py`; `src/ranex/observability/schema.py`, `redaction.py`; `docs/adr/ADR-010-first-delegation.md`, `ADR-015-durable-execution-watchdog-first.md`, `ADR-033-kernel-owned-delegated-provider-credential-broker.md`; `docs/slices/done/SLICE-012-provider-watchdog.md` | Preserve empty-by-default child environments, process-group ownership, bounded deadlines, startup reconciliation, distinct idle/absolute watchdogs, closed allowlisted events, kernel-owned credentials, and evidence authority separation. Kogg must not copy Ranex's journal or expose content through output tails. |

Primary protocol documentation was read at the same pinned revisions. The ACP
repository's V1 documentation is used because its V2 documentation is still
presented alongside draft material; any later V2 adoption requires a new pin and
compatibility decision. OpenTelemetry GenAI conventions are explicitly marked
development status and are used only as naming/privacy input.

## Source findings

### Eclipse Theia

Theia separates `AgentService`, which registers named agents, from
`LanguageModel`, which provides model-neutral request and streaming behavior.
Chat agents can select models by requirements rather than embedding one provider
implementation. Response parts preserve tool-call correlation and usage, and
delegation represents root and parent session relationships. These are the right
conceptual seams for a role-oriented Kogg UI and adapter registry.

The reviewed delegation tool creates child chat sessions in the browser and can
include the raw delegated prompt and caught error messages in logging. An enabled
agent is also treated as available, not as an immutable governed role assignment.
There is no durable attempt owner, startup reconciliation, cleanup proof, or
terminal evidence boundary. Kogg may integrate with Theia contribution points and
widgets, but the backend must own the governed attempt and expose only safe
projections to the frontend.

### Agent Client Protocol

ACP supplies a coherent adapter conversation: initialize and negotiate
capabilities, create or load a session, submit a prompt turn, receive ordered
session updates, observe tool and permission transitions, and receive a terminal
stop reason. Terminal handles expose create, bounded output, wait, kill, and
release operations. Cancellation cascades across nested protocol requests and a
well-behaved peer waits for a terminal response.

Those properties are protocol cooperation, not cleanup proof. The cancellation
notification is allowed to be ignored, and a peer can disappear without a final
response. Terminal methods expose commands, arguments, environments, directories,
and output that Kogg must never log. The adapter may use them internally only when
the Kogg supervisor or qualified delegated owner has registered the process before
start and can prove cleanup. Provider-reported usage is optional; an absent value
means unknown, never zero. The end-turn token proposal is not stable enough to be
the sole normalized contract.

### OpenAI Codex app server

The app server has an explicit initialization handshake, stable thread/turn/item
correlations, a `turn/started` boundary, ordered item start/delta/completion
notifications, and one `turn/completed` status of completed, interrupted, or
failed. Its interrupt test proves an active approval request is resolved and the
turn reaches interrupted. This is stronger than treating a closed stream or
cancel acknowledgement as completion.

The same interface deliberately keeps background terminals independent: turn
interrupt does not terminate them, and list/terminate/clean are separate methods.
That negative result is central to Kogg. An adapter completion event cannot move
the outer attempt to cleaned until its owned process inventory is empty or every
remaining process is explicitly delegated to another qualified owner. The app
server also transports prompt text, diffs, command metadata, output, and detailed
errors; these fields may be used for the user-visible feature but cannot cross the
safe lifecycle and diagnostics boundary.

### OpenAI Agents JS

The SDK makes `ModelProvider` separate from `Agent`, supports explicit model
resolution, run and agent lifecycle hooks, `AbortSignal`, turn and model time
bounds, handoffs, and usage aggregation. Its sibling-cancellation helper cancels
all siblings and waits for settlement, which is the correct cleanup shape for
parallel children: first failure or parent cancellation triggers every sibling,
then the parent joins all cleanup outcomes before becoming terminal.

The global default provider is ambient mutable state and is unsuitable for a
governed attempt. Kogg must freeze provider, adapter version, model, role, policy,
and authority references before start. Hooks are in-memory notifications, not a
durable lifecycle. Abort signals do not prove provider-host or terminal cleanup.
The tracing implementation may capture inputs, outputs, and tool data; Kogg must
emit only its closed safe event vocabulary even if a provider SDK offers richer
traces.

### OpenTelemetry GenAI conventions

The conventions use distinct operation, provider, requested model, response model,
and provider-native agent attributes; record input/output token totals and useful
subsets only when observed; and recommend low-cardinality `error.type`. They also
warn that session/context identifiers must be actual protocol identifiers rather
than values derived from content.

Kogg adopts the separation and naming discipline but not an open attribute bag,
content events, exporters, or provider-native identity as Kogg role identity.
Prompts, instructions, tool arguments/results, and outputs remain forbidden even
where the convention permits opt-in capture. The semantic convention cannot decide
whether work was authorized, cleaned, recovered, evidenced, or safe to merge.

### Ranex

Ranex delegation constructs a child environment from an allowlist, excludes
signing authority, creates a real process group, applies a wall-clock bound, kills
the group on timeout, waits for termination, and cross-checks worktree/task/commit
bindings before qualification. Its watchdog work separates stream-idle and
absolute deadlines, requires non-retryable timeout outcomes, reconciles stranded
work at startup even when no new input exists, and fences concurrent session
owners. These are stronger patterns than a provider SDK's abort callback.

Ranex observability uses a closed event and field vocabulary with positive
allowlist redaction and bounded hostile values. Its credential-broker decision
keeps the raw provider key in the kernel, gives the child a short-lived bounded
capability, refuses old credentialed clients, fixes the upstream and model grant,
records no prompt/output, performs no retry, and reconciles incomplete reservations
after restart. It explicitly does not claim protection from a same-UID adversary.

Kogg should preserve these invariants at the bridge without becoming a second
Ranex controller or evidence journal. Ranex owns governed descendants and
qualification inside its boundary; Kogg owns the registered bridge operation and
its safe projection. Raw bounded output tails are still content-bearing and must
not enter Kogg logs or diagnostics.

## Pattern comparison and decision

| Candidate | Lifecycle and authority result | Decision |
| --- | --- | --- |
| Treat a provider SDK `Agent` as the Kogg role | Couples role identity and authority to mutable provider configuration; SDK state is process-local | Reject. |
| Use a global/default provider with fallback | A restart, plugin, or configuration race can silently change provider/model and policy | Reject; resolve and freeze per attempt. |
| Make ACP the complete Kogg protocol | Strong transport vocabulary, but optional cancellation, incomplete usage standardization, and no durable process/evidence authority | Use behind an adapter only. |
| Treat provider stream close or stop reason as completion | Cannot distinguish provider completion from lost transport or residual children | Reject. |
| Let each adapter invent lifecycle/error/log fields | Prevents cross-provider diagnosis and encourages content leakage | Reject. |
| Backend-owned attempt state machine plus versioned provider adapters | Keeps role/authority stable, normalizes observations, and joins cleanup/recovery under one owner | Select for #78. |
| Persist full provider events for replay/debugging | Captures prompts, outputs, diffs, tool data, and provider-specific secrets | Reject. Persist safe lifecycle facts only. |
| Automatically retry/fail over after failure | A retry or provider change is a new side effect and may widen cost or authority | Reject by default; later policy may authorize a new child attempt explicitly. |

## Authority and identity model for #78

The pseudocode must keep these identities distinct:

1. **Role identity** is a Kogg-owned immutable role definition and authority
   snapshot. It states what work may be requested, which tools/capabilities are
   allowed, which provider/model constraints apply, and which parent granted it.
2. **Attempt identity** is one authorized execution of that snapshot. It owns the
   outer lifecycle, deadlines, child relationships, adapter binding, usage
   observations, terminal reason, cleanup, and recovery state.
3. **Adapter identity** is a versioned Kogg implementation qualified for one
   provider protocol and capability set. It is code/configuration provenance, not
   a role.
4. **Provider and model identity** are the explicitly requested and actually
   observed provider/model values. A mismatch is visible and fails according to
   policy; it never rewrites the role identity.
5. **Provider session/turn/item identities** are opaque adapter correlations. They
   may be stored only when non-content-bearing and required for cancellation or
   recovery. They are never synthesized from prompt or output.
6. **Operation and process identities** come from the Kogg operation supervisor.
   A process record is registered before spawn and bound after successful creation.
7. **Ranex task/run/evidence identities** retain their kernel meaning. Kogg may
   correlate them safely but cannot mint, rewrite, or interpret them as role state.

A child attempt receives an explicit subset of its parent's current grant, its own
attempt ID and deadlines, and a parent link. It cannot inherit ambient defaults,
credentials, mutable SDK objects, or open tool lists. Parent cancellation cascades
to all active descendants; parent completion joins every child cleanup result.

## Process inventory and ownership

| Boundary | Process owner | Required normalized behavior |
| --- | --- | --- |
| Role resolution and attempt admission | Kogg agent-protocol backend; no child | Validate frozen role/task/policy/trust references, resolve one adapter/model snapshot, register the operation before side effects, and refuse stale or unsupported capability sets. |
| In-process provider SDK adapter | Kogg agent-protocol backend | No hidden process. Register network/provider activity on the attempt, apply deadlines/cancellation, and emit only safe observations. SDK hooks are not durable authority. |
| Out-of-process ACP/Codex/other adapter host | Kogg supervisor unless a qualified owner is named | Register logical process before spawn; bind PID/platform identity after spawn; negotiate capability/version; observe readiness/activity/exit/close; cancel, kill, drain, and prove no residuals. |
| Provider-created terminal/tool process | Kogg supervisor or a specifically qualified terminal/Ranex owner | Provider protocol handles are not ownership proof. Bind each handle to a registered logical process or refuse execution; cancellation includes explicit terminal cleanup and residual enumeration. |
| Child agent/handoff | Parent Kogg attempt plus child attempt owner | Create a separately admitted child with intersected authority; cascade cancellation; await all child terminal and cleanup states. |
| Ranex governed execution | Ranex | Kogg registers and supervises the bridge only, consumes safe qualified status, and does not duplicate Ranex descendants or evidence records. |
| Theia task/terminal/plugin host | Existing Theia service | Record delegated lifecycle when Kogg initiated it; do not double-kill or claim framework-owned children. Require an owner-specific cleanup API and visibility. |
| Browser/Electron frontend | Theia/Electron | Display backend projections only. Disconnect must not transfer authority or make an active attempt terminal. |

No adapter may spawn a child behind an opaque SDK if Kogg cannot either enumerate
and clean it or delegate that proof to a qualified owner. Unsupported hidden-child
behavior is a release-blocking capability refusal, not an observability exemption.

## Lifecycle requirements for #78

The pseudocode must define closed states and legal transitions for at least:

`requested -> admitted -> adapter_resolved -> registered -> starting -> ready ->
active -> {completed_observed | failed_observed | cancelling | timed_out} ->
cleaning -> {cleaned | cleanup_failed}`.

It must also represent startup findings such as `recovery_required`, `reconciling`,
`recovered_terminal`, and `unverified_residual`. Names may change in #78, but these
semantic distinctions cannot collapse:

- **Requested is not admitted.** Admission rechecks the exact frozen role, task,
  project/repository binding, trust, policy, and adapter capability snapshot.
- **Registered is before starting.** Spawn or provider network activity cannot be
  the first visible fact.
- **Ready is not active.** Handshake/capability negotiation completes before a
  prompt or provider request may be submitted.
- **Activity is bounded observation.** Deltas may advance a safe activity timestamp
  and counts without persisting content. Activity does not reset the absolute
  deadline.
- **Provider completion is only observed completion.** It is provisional until
  usage accounting is finalized as known/unknown, children settle, process cleanup
  is proved, and the terminal lifecycle row commits.
- **Cancellation is a request plus deadline.** Cooperative adapter cancellation is
  attempted first; at the deadline, the owner escalates, drains, enumerates, and
  records whether cleanup succeeded. Cancellation can race completion, but the
  reducer must produce one deterministic terminal outcome.
- **Timeout classes stay distinct.** Handshake, first activity, idle, absolute,
  provider request, cancellation grace, and cleanup deadlines diagnose different
  failures. A timeout is non-retryable within the same attempt.
- **Recovery runs before new governed work.** Startup reconciles registered but
  non-terminal attempts and processes even when no new queue item exists. PID or
  provider session ID alone is insufficient identity. Unverifiable residuals block
  affected execution rather than killing an unrelated process or assuming cleanup.
- **Retries and failover are new attempts.** They require explicit remaining
  authority/budget/policy, immutable parent linkage, and a new idempotency key.

Usage must preserve provenance and uncertainty. The record distinguishes absent,
provider-reported, and Kogg-derived observations; input, output, cached, reasoning,
and total token fields remain optional; zero is recorded only when actually
reported or provably computed. Cost is optional and binds currency/unit/source.
Conflicting cumulative and per-turn values produce a typed diagnostic rather than
silent normalization.

## Failure and recovery matrix

| Failure | Required behavior | Safe diagnostic evidence |
| --- | --- | --- |
| Role/task/policy snapshot stale or revoked | Refuse before adapter/network/process activity | Attempt/request IDs, safe snapshot revisions, refusal code |
| Adapter absent, disabled, incompatible, or capability mismatch | Refuse; no fallback | Adapter ID/version, requested capability names from a closed vocabulary |
| Provider/model differs from frozen selection | Fail closed unless the frozen policy explicitly accepts the observed alias | Provider/model registry IDs, mismatch code; no raw response |
| Handshake never completes or protocol version is unsupported | Cancel/terminate host within handshake deadline; clean and retain failed record | Protocol family/version, deadline class, process cleanup status |
| Provider rejects/auth fails/rate limits | Typed provider failure; never include body/header/message; no automatic retry | Closed provider failure class, status class where safe, attempt/provider IDs |
| Stream quiet before first activity, idle mid-turn, or exceeds absolute budget | Distinct timeout; cancel then escalate cleanup | Timeout class, configured bound, last safe activity time/count |
| Transport closes without terminal event | Fail as lost/incomplete, not completed; cleanup and reconcile | Last normalized lifecycle state, transport class |
| Cancel acknowledgement missing | Escalate at grace deadline; enumerate/kill/drain owned children | Cancel requested/acknowledged timestamps, escalation class, residual count |
| Turn interrupts while terminal/tool/child remains | Explicitly cancel and join each remaining resource; terminal parent state waits | Safe child/process IDs and terminal cleanup states |
| Adapter host crashes | Mark observed failure, close/drain, reconcile external handles if possible; never replay blindly | Exit/close class, process identity proof, recovery result |
| Backend crashes with active attempts | Startup reconciliation before admission; recover only from durable safe facts | Prior instance/attempt/process IDs, reconciliation classification |
| Duplicate request after restart | Return same result only for matching idempotency digest; otherwise refuse collision | Request ID and safe canonical operation digest only |
| Usage absent, malformed, decreasing, or contradictory | Preserve unknown/last valid observation and emit typed usage diagnostic | Usage source, field name from closed set, count bounds; no content |
| Cleanup cannot prove zero residuals | `cleanup_failed`/`unverified_residual`; block affected capability | Owner, safe process IDs, residual count and check ID |
| Logging caller supplies prohibited/open fields | Drop/refuse event and emit a schema violation without echoing the value | Logger/event/schema ID and violation code |

## Logging and diagnostic contract

Use Theia `ILogger` names under `kogg:agents:*`, with at least
`kogg:agents:protocol`, `kogg:agents:adapter`, and `kogg:agents:supervision`.
The exact event schemas belong to #78, but the closed lifecycle vocabulary must
cover request, admission/refusal, adapter resolution, process registration,
start/ready, provider attempt, bounded activity, usage observation, completion,
failure, timeout, cancellation request/acknowledgement/escalation, child cleanup,
process close/residual, terminal commit, and startup recovery.

Allowed fields are safe opaque IDs, finite enum codes, bounded counts and
durations, timestamps, adapter/protocol versions, and registry-owned provider/model
identifiers. Even these fields must be declared per event, not accepted through an
open metadata bag. Provider exception text, HTTP bodies, tool payloads, commands,
paths, and SDK trace objects are never forwarded. Failure messages shown to users
are Kogg-authored safe summaries keyed by closed codes.

The diagnostic catalog must gain checks that can run without a live provider and
without exposing content:

- `agent-protocol-registration`: adapter IDs/versions are unique, enabled adapters
  declare supported protocol/capability versions, and no ambient default is active;
- `agent-protocol-supervision`: every adapter/terminal/child process has one owner,
  registration precedes spawn, and no hidden or residual process exists;
- `agent-protocol-recovery`: no unreconciled non-terminal attempt or stale process
  binding exists before governed admission;
- `agent-protocol-logging`: logger/event schemas are registered, safe, bounded, and
  reject prohibited/open fields;
- `agent-protocol-source-maps`: backend, frontend, Electron, extension, and adapter
  bundles preserve source maps and debugger reachability where applicable; and
- adapter-specific readiness checks for protocol negotiation, cancellation,
  terminal enumeration/cleanup, usage semantics, and provider credential isolation.

Operational implementation files must carry the appropriate
`diagnostic-coverage` catalog ID. A declaration-only adapter type may use a specific
exemption, but spawning, networking, lifecycle reduction, cancellation, recovery,
and logging code may not.

## E2E and fault-injection requirements

The production phase cannot close with mocked reducer tests alone. The #81 probe
and #84 E2E must use at least one real out-of-process adapter boundary and one real
provider turn under a safe test task, while keeping secrets and content out of
captured artifacts. Required scenarios are:

1. explicit role -> adapter -> provider/model resolution is visible and stable for
   the attempt, including a negative no-fallback case;
2. initialize/ready/activity/completion reaches `cleaned` with an empty registered
   process inventory and honest optional usage;
3. provider refusal and transport loss reach distinct safe failures;
4. first-activity, idle, and absolute timeouts are independently forced and do not
   cut a healthy bounded turn;
5. cancellation during streaming and during a pending tool/terminal/child request
   terminates the turn, resolves pending requests, explicitly cleans background
   terminals, joins siblings, and leaves zero residuals;
6. forced adapter-host death and forced Kogg-backend death exercise startup
   reconciliation without blind replay or stale-PID killing;
7. duplicate request/idempotency collision, model mismatch, unsupported protocol,
   capability mismatch, and hidden-child refusal fail before unsafe activity;
8. logger and support-artifact capture is scanned with seeded canary secrets,
   prompts, paths, commands, and provider payloads and contains none of them;
9. diagnostic reports identify the deliberately broken adapter/process/recovery
   invariant using stable check and failure codes; and
10. generated frontend/backend/Electron/extension/adapter source maps reach the
    exercised lifecycle and failure branches in a debugger.

All Kogg-created processes must be enumerated before and after each scenario. A
green provider response with a residual process, missing lifecycle transition,
unsafe log field, unknown cleanup status, or absent diagnostic coverage is a
failed E2E.

## Rejected approaches

- **Provider-native agent equals Kogg role.** Rejected because provider identity,
  configuration, and authority are mutable and provider-specific.
- **Browser-owned delegation.** Rejected because disconnect/reload loses ownership,
  durable recovery, and cleanup authority.
- **Global provider/model defaults or silent fallback.** Rejected because an
  attempt can change behavior and cost without a new authorization decision.
- **ACP, Codex, or one SDK as the outer Kogg contract.** Rejected because each is a
  provider/transport boundary with different cancellation, usage, terminal, and
  process semantics.
- **Abort signal or cancel acknowledgement proves cleanup.** Rejected because
  background terminals, tool fibers, child agents, and adapter hosts may survive.
- **Stream EOF or provider stop reason proves completion.** Rejected because lost
  transport and unclean descendants can produce the same local observation.
- **Automatic retry, failover, or sibling replacement.** Rejected unless a later
  explicit policy authorizes a separately identified attempt and budget.
- **Content-rich SDK/OpenTelemetry tracing for debugging.** Rejected because the
  useful debugging contract can be met with closed lifecycle facts and content
  capture violates Kogg policy.
- **Raw provider error text in user messages or logs.** Rejected because it may
  contain request bodies, prompt fragments, tool data, identifiers, or secrets.
- **Persist provider event streams for recovery.** Rejected because they are
  content-bearing and are not a trustworthy process/evidence authority.
- **PID/session ID alone as recovery identity.** Rejected because identifiers can
  be reused, disappear, or refer to a provider resource Kogg cannot clean.
- **Duplicate all Ranex descendants in Kogg.** Rejected because it creates two
  process/evidence authorities. Kogg observes the bridge; Ranex proves its scope.

## Risks and questions #78 must close

1. Define exact versioned request/response/event schemas, canonical encodings,
   bounds, idempotency semantics, and reducer transition table.
2. Decide which safe role, adapter, provider, model, session, turn, operation, and
   process identifiers are durable and which remain ephemeral.
3. Define capability negotiation and compatibility: mandatory features,
   version-skew refusal, adapter upgrade while attempts exist, and no-fallback proof.
4. Define credential ownership for in-process and out-of-process adapters without
   moving raw secrets into logs, argv, environments, frontend state, or provider
   protocol payloads. Coordinate with the kernel/Ranex authority rather than
   inventing an unqualified broker.
5. Define process containment and residual proof on macOS, Linux, and Windows,
   including adapters that create terminals or grandchildren outside the direct
   process tree. Unsupported platforms/capabilities must fail closed.
6. Define deterministic cancellation/completion race precedence, escalation
   deadlines, sibling joining, terminal handle release, and cleanup-failed state.
7. Define restart reconciliation without storing prohibited provider content and
   without replaying a non-idempotent turn. Decide when a provider session can be
   safely reattached versus only abandoned and cleaned.
8. Define usage source/provenance, cumulative-versus-delta arithmetic, overflow and
   monotonicity checks, unknown-versus-zero, currencies, and provider corrections.
9. Define child authority intersection, depth/fan-out/cost/time limits, handoff
   semantics, parent terminal rules, and cycle prevention.
10. Define safe error/status mappings for HTTP, SDK, protocol, host, process,
    timeout, cancel, cleanup, and recovery failures without leaking raw messages.
11. Define the durable lifecycle store boundary relative to the operational
    registry so there is one source of truth and no partial terminal/cleanup commit.
12. Define exact diagnostic catalog entries, source-map/debugger proof, fault
    injection, and real-human E2E artifacts needed for #84 and #70.

## Prototype recommendation for #81

Build a disposable adapter-host probe after #78 freezes the contract. Use one
small fake protocol peer for deterministic malformed/timeout/crash cases and one
real Codex or ACP-compatible out-of-process peer for handshake, streaming,
cancellation, pending request resolution, terminal enumeration, and usage
observations. Route all process creation through the existing Kogg operation
supervisor and seed prohibited-data canaries before capture.

The probe should answer the uncertain boundary questions, not become production:
whether interruption leaves background terminals, whether cleanup can be proved on
all supported platforms, whether provider sessions can be reattached safely after
backend death, how usage arrives and changes, and whether event normalization
remains complete without retaining raw messages. Preserve the probe branch and CI
evidence, merge only findings and contract changes, and record explicit negative
results. A happy-path chat UI demo is insufficient.

## Research gate conclusion

The source ledger is commit-pinned and licensed, selected and rejected approaches
are explicit, and the process, lifecycle, failure, recovery, logging, diagnostic,
security, and E2E requirements are enumerated. The findings are sufficient for
#78 to write decision-complete pseudocode without another broad code search.

The central invariant for the remaining lifecycle is: **a Kogg role authorizes an
outer attempt; a provider adapter reports observations; only the Kogg supervisor
may declare the attempt cleaned, and neither provider completion nor cleanup is a
Ranex verdict.**
