# Kogg ChatGPT Codex Harness E2E Plan

Date: 2026-07-15

## Purpose

Prove through public seams that Kogg can safely drive a human ChatGPT Codex
subscription while retaining and extending the Qwen Code harness. Tests mock
only external identity/backend/keychain/browser boundaries; they do not replace
Kogg account, persistence, conversation, approval, or tool orchestration logic.

All feature slices follow red -> green -> refactor. Each slice must include a
process restart where durable behavior is part of the contract.

## Deterministic external boundary

Build one loopback fake ChatGPT service that scripts:

- Authorization redirect, exact PKCE callback, device start/poll, token exchange,
  refresh, revocation, identity and entitlement claims.
- Dynamic model responses, ETag changes, malformed refreshes, and model removal.
- Streamed Responses text, reasoning, local calls, unknown/hosted items, usage,
  missing terminal events, errors, and retry boundaries.
- Native V2 compaction and legacy compact responses.
- Full dynamic usage snapshots, additional unknown groups, sparse headers/events,
  credits, active-limit errors, and staleness.

Tests inject loopback endpoints through explicit dependencies. Production code
must reject arbitrary insecure endpoints, redirect URIs, or proxy downgrades.

The fake contract is versioned against official `openai/codex` revision
`f90e7deea6a715bbd153044af6f475eefa749177`. Fixtures assert exact outbound URL,
method, required headers, and payload for:

- `https://auth.openai.com`, observed client ID
  `app_EMoamEEZ73f0CkXaXp7hrann`, callback ports `1455`/`1457`, callback path
  `/auth/callback`, scopes `openid`, `profile`, `email`, `offline_access`,
  `api.connectors.read`, and `api.connectors.invoke`, plus exact PKCE,
  simplified-flow, and ID-token-organization parameters.
- Device start `/api/accounts/deviceauth/usercode`, poll
  `/api/accounts/deviceauth/token`, verification `/codex/device`, `403`/`404`
  pending responses, and the 15-minute expiry.
- `https://chatgpt.com/backend-api/codex`,
  `/backend-api/codex/responses`,
  `/backend-api/codex/models?client_version=<adapter-version>`, and
  `https://chatgpt.com/backend-api/wham/usage`.
- Bearer authorization, `ChatGPT-Account-ID`, Kogg user agent, ETag and
  `X-Models-Etag`, encrypted reasoning inclusion, and
  `x-codex-beta-features: remote_compaction_v2`.
- Primary `codex` usage, ordered `additional_rate_limits`, dynamic sparse
  `x-<group>-*` fields, `codex.rate_limits`, credits, and active-limit metadata.

Fixtures reject Codex CLI impersonation and any unapproved paid Platform API
fallback. Contract drift must produce an explicit compatibility failure.

## Tracer slices

### 1. Public identity

- Pack/install the npm tarball and invoke `kogg --version` and `kogg --help`.
- Install the Homebrew formula and signed standalone archive and invoke their
  `kogg` binaries.
- Assert the package/bin/repository/image metadata and `KOGG_`, `~/.kogg`,
  `.kogg/`, `KOGG.md`, `.koggignore`, and `kogg-extension.json` paths.
- Scan release artifacts with an allowlist so upstream attribution remains but
  no accidental public Qwen product identity is exposed.

### 2. Account and text response

- Use `kogg auth login` for browser PKCE and device login; headless startup never
  launches a browser.
- Verify exact callback path/method/state, one-shot consumption, timeout, bounded
  inputs, entitlement validation, redaction, and cancel behavior.
- Exercise keychain-first storage, warned atomic `0600` fallback, strict-mode
  refusal, refresh rotation, logout/revocation, and complete cache cleanup.
- Return an arbitrary entitled plan string and assert `kogg auth status`
  preserves and displays it without a fixed plan-name allowlist.
- Replace the single active account with explicit confirmation. Assert the
  identity epoch advances and all model, limit, and conversation access caches
  for the old identity are cleared.
- Fetch the dynamic model catalog, start a fresh conversation with its default,
  stream text through the public CLI, and persist the completed response.

### 3. Restart-safe local tool turn

- Advertise one harmless local function tool.
- Receive a provider `call_id`, commit the full terminal response and durable
  `prepared` mapping, dispatch once, persist its result, submit that result, and
  finish the assistant response.
- Restart after each transaction state. Prove that completed states resume and
  a crash in ambiguous `dispatched` state blocks reconciliation without
  re-executing the tool.
- Corrupt/truncate journal frames, race two writers, replace the account during
  refresh, and attempt stale compare-and-swap writes. Recover only a valid
  truncated tail; refuse ambiguous state and cross-identity access.

### 4. Protocol validation and unknown tools

- Assert `store: false`, streaming, encrypted reasoning inclusion, stable cache
  key, exact `call_id`, full request-window continuation, and normalized usage.
- Preserve reasoning, phase, compaction, and unknown raw items across restart.
- Reject malformed known events and missing `response.completed`.
- Return a terminal response containing an unsupported hosted/unknown item and
  a later local call. Prove the turn fails before the local side effect.
- Verify `/tools` reports source, availability, approval class, requirements,
  fallback, and degraded reason and never claims an unimplemented hosted tool.

### 5. Native compaction

- Trigger V2 through a final `compaction_trigger`; require one terminal event and
  exactly one completed compaction item.
- Atomically install the provider-native replacement window and resume after a
  process restart while retaining the immutable human transcript.
- Fall back to legacy native compact only on an explicit unsupported response.
- Treat malformed, partial, duplicate, or missing compaction items as fatal.
- Assert no Qwen/local semantic summary request is made by `/compress`, auto
  compression, or context rescue for `CHATGPT_CODEX`.
- With both native protocols unavailable, apply deterministic structural savings
  and block before overflow.

### 6. Models, Fast mode, and limits

- Atomically replace only ChatGPT Codex models and retain raw unknown capability
  fields, ETag, TTL, and account-scoped last-known-good data.
- Assert `/models` renders every authoritative model and its returned reasoning,
  context, modality, tool, and service-tier capabilities.
- Keep an active conversation on its recorded model. If it disappears, block
  for an explicit selection instead of silently switching.
- Verify `/fast on|off|status`: off by default, `priority` only when advertised,
  omitted when off, persisted across restart, and visibly disabled when support
  disappears.
- Return a primary limit plus multiple known and unknown additional groups.
  Assert `/limits` renders every group in returned order and preserves raw
  fields; SDK, ACP, and Serve return the same ordered groups and raw fields.
- Assert the compact footer selects the most constrained returned group without
  hard-coded group names.
- Test sparse header/event merges, dynamic group names, authoritative full-fetch
  replacement, stale/partial/unavailable/no-groups states, and a cancellable
  poller that does not hold the process open.
- Prove `/stats`, prompt-cache efficiency, context occupancy, and account quota
  remain distinct values.

### 7. Tool and approval expansion

- Run inherited Qwen tools, Kogg-native tools, and MCP/plugin tools through the
  unified catalog and approval path.
- Add hosted tool adapters one at a time with contract fixtures and explicit
  availability. Exercise only declared fallbacks and show the actual source.
- Verify YOLO still asks hard confirmation for credentials, purchases,
  publishing, permissions, and destructive external operations.
- Verify no silent paid Platform API fallback is possible.

### 8. Surface and packaging parity

- Exercise interactive CLI, headless JSON/NDJSON, TypeScript/Python SDKs, ACP,
  and Serve against the same fake service and durable account/conversation data.
- Cover stdout/stderr separation, exit codes, Serve REST/SSE reconnect, ACP
  authentication and permissions, SDK typed account/model/limit/Fast/tool-source
  results, and Docker device login.
- Run install/smoke coverage for Linux x64/arm64, macOS Intel/Apple Silicon, and
  WSL2. Mark native Windows experimental rather than claiming parity.
- Confirm telemetry is off by default and its opt-in payload excludes prompts,
  code, paths, tool inputs/results, credentials, and account identifiers.
- Inspect owner-only local state and a redacted doctor bundle.

## Adversarial matrix

| Case | Required outcome |
| --- | --- |
| Refresh races account replacement | Stale writer loses CAS; no token crosses identity |
| Pre-stream 401 | Refresh once and retry once |
| 401/error after stream bytes | No automatic replay |
| Crash after tool dispatch | Block reconciliation; never auto re-execute |
| Concurrent conversation writers | Lease/fence and revision reject one writer |
| Truncated final journal frame | Recover valid prior frames only |
| Checksum/order/schema failure | Refuse resume with actionable corruption error |
| Unknown/hosted output before local call | Persist raw terminal output; no local dispatch |
| Model removed from catalog | Existing conversation blocks explicit choice |
| Malformed catalog refresh | Keep account-scoped LKG and show stale state |
| New unknown limit group | Preserve and display dynamically |
| Partial/malformed compaction | Fatal; no semantic-summary fallback |
| Keychain unavailable in strict mode | Refuse login/storage |
| Logout revocation fails | Still delete all Kogg-owned local account state |

## Verification commands

Focused commands are added beside each implementation slice. The release gate
also runs from the exact candidate commit:

- `npm run format`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test:ci`
- `npm run test:release`
- package/install and platform smoke workflows
- `git diff --check`

## Protected live probe

A manual, opt-in release check uses a real entitled ChatGPT account to verify
browser/device login, refresh, model discovery, all returned limit groups, Fast
mode, streaming, local tool continuation, native compaction, restart, and logout.
It runs with fresh disposable Kogg state, reports only redacted assertions, and
never exports credentials or transcripts. Failure blocks release and is reported
as a private-contract compatibility problem, not repaired with API-key billing.
