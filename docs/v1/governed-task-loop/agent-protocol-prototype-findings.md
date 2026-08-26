# Agent protocol real-boundary prototype findings

Tracking: [#81](https://github.com/anthonykewl20/kogg/issues/81), parent
[#72](https://github.com/anthonykewl20/kogg/issues/72), and production
[#84](https://github.com/anthonykewl20/kogg/issues/84).

## Verdict

The bounded prototype validates the central #78 decision: a provider adapter can
normalize protocol observations, but only the backend-owned Kogg operation
supervisor can make process start, exit, cancellation, and cleanup authoritative.
A real Codex app-server completed its initialize handshake through stdio after
register-before-spawn. A deterministic peer demonstrated that a provider
completion observation can coexist with a live adapter host and terminal handle;
the outer attempt did not become clean until cancellation and process cleanup.

The prototype is experimental and MUST NOT merge as production. It is preserved
on `prototype/issue-81-agent-protocol` at commit
`d4fc26feabab01ba3db64370be52105a5ec840ff`. Only these findings are intended for
the production branch. #84 still owns the real `@kogg/agents` package, durable
attempt registry, adapter interfaces, UI, diagnostics, recovery, platform
qualification, and real human-level E2E.

## Reproduction and observed evidence

The probe ran on macOS with Node 22.23.2 and Codex CLI 0.148.0-alpha.9 supplied by
the local Codex desktop installation.

```sh
git switch prototype/issue-81-agent-protocol
yarn setup
volta run --node 22.23.2 node prototypes/agent-protocol/probe.mjs
volta run --node 22.23.2 yarn test
```

Observed on 2026-08-27:

- the real Codex `app-server --stdio` host returned an initialize result with
  client-correlated user agent, Unix platform family, and Codex home;
- the host process was registered as a production `provider-cli` operation
  resource before spawn, then visibly started, became ready after negotiation,
  exited by signal, and cleaned;
- a deterministic peer produced one bounded activity event, observed usage of
  7 input, 3 output, and 10 total tokens, and `completed-observed` while its host
  remained live;
- cancellation resolved the peer's pending request/terminal inventory to zero,
  after which the supervisor killed/reaped and cleaned the host;
- malformed JSON, handshake timeout, and exit code 9 mapped to
  `ADAPTER_PROTOCOL_INVALID`, `ADAPTER_HANDSHAKE_TIMEOUT`, and
  `ADAPTER_HOST_EXITED`, each with start, failure, exit, and cleanup evidence;
- final operation diagnostics reported zero active operations, residuals, and
  cleanup failures;
- a prohibited-content canary and content-bearing input handle were absent from
  the probe's safe trace; and
- `yarn test` passed 41/41, branding passed, and the observability audit passed
  with 62 production operational files inspected.

This is a macOS protocol/process probe, not cross-platform qualification. #84
must exercise qualified macOS, Ubuntu, and Windows ownership/termination models
and real browser/Electron paths. The Codex version is evidence for this run only;
production must pin and diagnose its qualified adapter artifact/protocol.

## Lifecycle trace

The successful real-host path was:

```text
operation.requested -> operation.started -> process.registered ->
process.spawn.started -> process.started -> operation.active -> process.ready ->
adapter.handshake.completed -> attempt.cancel.requested -> process.exit ->
process.cleanup.completed -> operation.cancelled
```

The normalized peer added:

```text
adapter ready -> activity -> usage observed -> completed_observed(processCount=1)
-> cooperative cancel response(terminalCount=0) -> process exit -> cleanup
```

Each failure path included registered/start, one closed adapter failure, observed
exit class, process cleanup, and a terminal failed operation. Raw stdout/stderr,
protocol messages, input content, commands, paths, environments, and credentials
were neither persisted nor emitted by the safe adapter trace.

## Decisions validated

- Explicit adapter protocol negotiation belongs between process start and ready;
  external input cannot be sent before readiness.
- Codex initialization works over bounded JSON-lines stdio as a real
  out-of-process adapter boundary without treating Codex identity as Kogg role
  identity.
- Provider completion is provisional. A live adapter host or terminal inventory
  keeps the outer attempt unclean and blocks terminal governed success.
- Usage can normalize into optional bounded counters without retaining provider
  payloads. The status must remain `observed`; absent usage is unknown, not zero.
- Malformed protocol, readiness timeout, and host crash need distinct adapter
  safe codes even when the underlying operation registry records a generic
  nonzero/signal process result.
- Register-before-spawn and explicit process exit/cleanup events make all tested
  success and failure boundaries diagnosable without raw transport logging.
- Cancellation requires both protocol cooperation and supervisor cleanup.
  Neither response alone proves zero residual resources.

## Production decisions and reopened requirements

The production decision is to implement the fixed backend-owned attempt state
machine and exact adapter registry in #84. The probe does not justify a generic
stdio wrapper or direct reuse of its compact peer code.

- Production must split adapter-safe codes from operation process codes while
  correlating both; collapsing malformed, timeout, and crash into
  `PROCESS_EXIT_NONZERO` would lose incident diagnosis.
- The prototype used one host at a time and in-memory line parsing. #84 needs
  bounded frame/line sizes, ordering, duplicate/conflict handling, backpressure,
  request cancellation, stdout/stderr flood limits, and durable attempt events.
- Provider-created terminals need real owner registration/enumeration before
  start or an explicit qualified delegation. The fake peer's terminal count is
  only protocol evidence and cannot replace external process inventory.
- The real Codex run proved initialize/negotiation only. Codex-specific turn,
  tool/approval, interruption, background-terminal, session/recovery, model
  mismatch, and usage behavior belongs to #91/#92 and must not be inferred here.
- Process-group/Job Object ownership, descendant enumeration, TERM/KILL
  escalation, backend-death recovery, and identity/PID-reuse protection require
  separate macOS/Linux/Windows qualification.
- #84 must persist exact immutable role/adapter/provider/model/task/grant
  snapshots, idempotency, child authority intersection, deadline generations,
  cancellation races, and recovery; this disposable script persists only the
  production operation registry lifecycle.
- Production credentials must be opaque short-lived leases and never HOME/
  inherited ambient configuration. The real handshake inherited only what the
  local probe required; that is not a production credential policy.
- Full diagnostics remain mandatory: `agent-protocol-registration`,
  `agent-protocol-supervision`, `agent-protocol-recovery`,
  `agent-protocol-logging`, `agent-protocol-source-maps`, plus adapter readiness
  checks. Every operational file needs catalog-backed coverage.
- Real Theia browser/Electron UI must show role versus adapter/provider/model,
  provisional completion versus cleaning, observed/unknown usage, cancellation,
  failures and recovery. It must independently verify source maps, process
  inventory, safe logs, and prohibited-content canaries.

These findings validate #78 without weakening its authority, cleanup, recovery,
credential, diagnostic, or Ranex separation requirements. Provider completion,
host cleanup, evidence, verdict, and controlled merge remain distinct states.
