# Codex adapter real-boundary prototype findings

Tracking: [#91](https://github.com/anthonykewl20/kogg/issues/91), parent
[#86](https://github.com/anthonykewl20/kogg/issues/86), and production
[#92](https://github.com/anthonykewl20/kogg/issues/92).

## Verdict

The bounded prototype validates the selected newline-delimited stdio lifecycle:
a real Codex app-server can be registered before spawn, initialized, asked to
create an ephemeral read-only thread, given a turn, interrupted, reaped, and
cleaned through Kogg's production operation supervisor. A deliberately
unavailable experimental capability failed as a typed protocol refusal without
terminating or widening the session. Provider terminal observation remained
provisional until process exit and cleanup, and the private workspace was
unchanged.

This run does **not** qualify a production Codex release. The available desktop
binary has no reviewed signed Kogg release manifest, the probe used no qualified
scoped credential broker, and macOS cannot prove the normative
`kogg-writable-agent-v1` Linux confinement/cgroup profile. The correct measured
outcome is `CODEX_RELEASE_UNQUALIFIED` with no fallback. #92 must remain blocked
until those three prerequisites exist and the reopened measurements below pass.

The disposable implementation MUST NOT merge as production. It is preserved on
`prototype/issue-91-codex-adapter` at commit
`203ce11ca35a2963eb4328f609c0346853834ac1`. Only these findings and the status
correction are intended for the production branch.

## Reproduction and exact candidate

The probe ran on macOS arm64 with Node 22.23.2. The inspected candidate was the
Codex desktop binary reporting `codex-cli 0.148.0-alpha.9`, SHA-256
`7a26b07855ef91194c8d1bf58d15970878ee11458253df328d38fec0c87ec192`.
Its generated experimental v2 schema accepted `app-server --stdio` as the
documented alias of `--listen stdio://`.

```sh
git switch prototype/issue-91-codex-adapter
yarn setup
volta run --node 22.23.2 node --inspect=0 prototypes/codex-adapter/probe.mjs
volta run --node 22.23.2 yarn test
```

Observed on 2026-08-27:

- Kogg inspected the real executable version and digest before admission;
- the operation and `provider-cli` resource were durable and registered before
  the app-server spawn boundary;
- the real v2 initialize/initialized handshake completed over stdio;
- a thread request that named an experimental capability without negotiating the
  required experimental API capability returned JSON-RPC `-32600`; the probe
  normalized it to `CODEX_CAPABILITY_REFUSED` and did not retry or widen access;
- a subsequent ephemeral thread started with approval policy `never`, legacy
  sandbox class `read-only`, and a private temporary workspace and `CODEX_HOME`;
- a real turn was accepted with `readOnly`, network-disabled sandbox policy and
  then interrupted, producing terminal status `interrupted` while the app-server
  process was still live;
- graceful stdio close produced exit class `zero`, after which process and
  operation cleanup completed with zero residuals and zero cleanup failures;
- the workspace still contained only its unchanged seed file;
- a random prohibited-content canary did not appear in the probe's safe trace,
  which also rejected prompts, paths, command/argument/environment labels, and
  credential labels; and
- `yarn test` passed 41/41, the branding audit passed, and the mandatory
  observability audit passed with 62 production source files inspected.

`--inspect=0` supplied debugger proof for the retained JavaScript probe. The
repository build retained its existing TypeScript source maps. Because this is
not production code, no new operational diagnostic catalog entry was added; the
probe declares a specific diagnostic exemption and exercises the production
operation-registry diagnostics instead.

## Safe lifecycle trace

The asserted successful path was:

```text
release.inspected(unqualified-desktop-control) ->
operation requested/started -> process.registered -> process.spawn.started ->
process.started -> operation.active -> process.ready ->
protocol.initialize.completed -> protocol.failure.observed(capability refused) ->
thread.started(ephemeral/read-only/never) -> turn.started ->
cancel.requested -> turn.terminal.observed(interrupted, processCount=1) ->
process.exit(zero) -> process.cleanup.completed -> operation.cancelled ->
cleanup.completed(processCount=0) ->
qualification.refused(CODEX_RELEASE_UNQUALIFIED, fallback=false)
```

This ordering validates that a turn's terminal event is not cleanup proof. It
also validates closed capability refusal: the rejected experimental request did
not cause an automatic retry, capability grant, sandbox change, or process
replacement. Raw protocol frames, stderr, prompt/input, provider output, paths,
arguments, environments, and credentials were not emitted by the probe trace.

## Decisions validated

- Version/digest inspection, operation/process registration, spawn, protocol
  readiness, turn activity, interruption, process exit, and cleanup are distinct
  observable boundaries.
- The real binary supports the selected versioned JSON-lines stdio handshake and
  one ephemeral thread per attempt.
- `approvalPolicy: never` and a read-only, network-disabled turn are accepted by
  this candidate without exposing an approval path in the tested turn.
- An unnegotiated experimental field fails closed at the protocol boundary and
  can be normalized without retaining the raw server response.
- `turn/completed: interrupted` can arrive while the app-server is live, so the
  outer Kogg process owner must remain authoritative for terminal cleanup.
- A private scratch home, `CODEX_HOME`, and workspace are compatible with
  initialize, thread creation, turn acceptance, interruption, and clean exit in
  this no-output control.
- The protocol can be observed safely using opaque attempt/operation/process IDs,
  bounded counters, safe codes, and coarse terminal/exit classes.

## Qualification refusal and reopened production requirements

The probe deliberately stops short of claiming the high-risk properties that
the macOS desktop candidate cannot prove. These are release blockers, not
optional follow-up improvements:

- **Signed release and schema manifest.** #92 needs a reviewed Kogg manifest
  binding the exact Codex/helper/schema/accepted-method digests, target, adapter
  version, and expiry. The local desktop executable and generated schema are
  evidence for this run only.
- **Scoped credential broker.** The control used a new empty `CODEX_HOME` and did
  not validate provider completion or credential delivery. Production must prove
  an opaque provider/model-scoped, revocable, bounded-use grant without ambient
  user configuration, keyring, argv, inherited environment, or browser access.
- **Qualified Linux confinement.** No Landlock/Bubblewrap result, mount graph,
  network namespace, cgroup identity, resource ceiling, PID-reuse defense, or
  zero-descendant enumeration was measured on macOS. #92 must run the exact
  `kogg-writable-agent-v1` profile and fail rather than weaken it.
- **Real descendant ownership.** The interrupted no-tool turn created no observed
  shell, terminal, MCP, hook, plugin, browser, computer-use, or subagent child.
  Production qualification must create allowed real descendants, prove their
  registration/inheritance, and inject unknown/escaped/residual cases.
- **Backpressure and framing.** The bounded single-turn control did not saturate
  stdin/stdout/stderr, split UTF-8 frames, overflow line/queue limits, reorder or
  duplicate replies, or race EOF with terminal events. The closed parser and
  queue limits from #90 remain mandatory.
- **Backend-death recovery.** The probe exercised ordinary supervisor cleanup,
  not backend crash/restart, durable fencing, stale PID identity, broker
  revocation, cgroup reconciliation, or repository quarantine.
- **Approval and model authority.** One `never` turn and one experimental-field
  refusal do not prove every tool/approval request is denied, the observed model
  equals the frozen exact selection, or provider fallback is impossible.
- **Provider success and content projection.** Immediate interruption validates
  cancellation ordering only. #92 still needs an authorized real provider turn,
  bounded private content channel, usage/model observations, provisional success,
  output qualification, and cleanup before governed completion.

Until all blockers are implemented and tested on the exact qualified candidate,
the adapter registry must expose Codex as unavailable with
`CODEX_RELEASE_UNQUALIFIED`; it must not use the desktop binary, ambient login,
weaker sandbox, alternate adapter, model fallback, or generic stdio fallback.

## Production handoff

#92 should implement the fixed `@kogg/codex-adapter` contracts from #90 only
after the release manifest, credential broker, and Linux execution profile are
available. Its automated and visible E2E matrix must cover success, capability
refusal, unexpected approval, model mismatch/fallback, malformed/oversized
protocol input, stdout/stderr pressure, idle and absolute timeouts, user cancel,
app-server/descendant crash, backend death and recovery, broker revocation,
cleanup escalation, residual detection, and quarantine.

Every production operational file still requires exact diagnostic-catalog
coverage, safe `kogg:agents:codex-*` lifecycle logging, failure tests, source maps,
and debugger proof. A provider response, interrupted turn, zero app-server exit,
or green unit test can never substitute for external confinement and zero-
descendant cleanup proof.
