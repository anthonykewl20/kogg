# Kogg ChatGPT Codex Harness

Date: 2026-07-15
Status: Accepted for implementation on `development`

## Goal

Kogg is an independently branded fork of Qwen Code that uses its mature agent
harness to drive models available through a human ChatGPT Codex subscription.
It authenticates the user directly and does not depend on Codex App Server.

The initial release must preserve Qwen Code's useful local tools, add
Kogg-native tools, and expose supported ChatGPT-hosted tools through one honest
tool catalog. It must also show the user's plan, dynamically discovered models,
and every usage-limit group returned by the account service.

The ChatGPT Codex backend and OAuth client used by the official Codex CLI are
private first-party contracts. They can change or reject Kogg without notice.
All such behavior belongs behind a versioned compatibility adapter and must fail
with an explicit compatibility error. Kogg must not mislabel that condition as
bad credentials or silently fall back to paid Platform API usage.

## Product identity

The public identity is:

- Product, npm package, and executable: `kogg`
- Internal npm scope: `@kogg/*`
- Repository: `anthonykewl20/kogg`
- Container: `ghcr.io/anthonykewl20/kogg`
- Install artifacts: npm, Homebrew, and signed standalone archives
- User and project state: `~/.kogg` and `.kogg/`
- Environment prefix: `KOGG_`
- Context, ignore, and extension files: `KOGG.md`, `.koggignore`, and
  `kogg-extension.json`

The rebrand is public-complete and internally compatible. Stable legacy
protocol fields may be read through explicit compatibility aliases, but new
writes and user-visible surfaces use Kogg names. Apache licensing, copyright
notices, and upstream Qwen Code attribution remain intact.

Development happens on `development`. A `main` branch is created from the exact
verified `development` commit only after the initial release gate passes.

## Architecture

### Account boundary

`ChatGptCodexAccount` is the sole owner of browser and device authorization,
credentials, refresh, account identity, model catalog, limit snapshots, and
Fast-mode preference. Generation code asks this boundary for a valid, bound
session; it never reads tokens directly.

Kogg supports one active account. `kogg auth login`, `kogg auth logout`, and
`kogg auth status` are the explicit public account operations; only login may
start a browser or device flow. Status preserves and exposes any entitled plan
name returned by the service instead of narrowing it to a fixed plan union.
Replacing the account advances identity, clears every account-scoped cache, and
requires an explicit confirmation.

Account state distinguishes:

- `identity_epoch`: advances on login, logout, account replacement, or workspace
  replacement.
- `credential_revision`: advances when credentials for the same identity rotate.

Credentials bind issuer, selected account, selected workspace, and
`identity_epoch`. Refresh and replacement use an inter-process lock, reread the
record after acquiring the lock, and compare-and-swap the expected identity and
revision. This prevents stale writers and account-replacement ABA races.

### Provider integration

`AuthType.CHATGPT_CODEX` selects a dedicated Responses transport. It is a sibling
of the generic OpenAI-compatible provider, not a mode within it. The generic
OpenAI provider remains API-key and Chat-Completions based.

The existing `ContentGenerator` seam continues to serve the harness, but
`ResponsesConversation` is authoritative for ChatGPT Codex continuation.
Gemini-style `Content` is only a UI and harness projection; it cannot be the
source of truth for encrypted reasoning, response phases, compaction records,
unknown items, or provider call identifiers.

### Versioned private compatibility contract

Initial fixtures are pinned to the behavior observed in official `openai/codex`
revision `f90e7deea6a715bbd153044af6f475eefa749177`. A later contract change must
update the adapter version and its exact wire fixtures together.

The initial adapter pins and tests:

- OAuth issuer `https://auth.openai.com`, observed client ID
  `app_EMoamEEZ73f0CkXaXp7hrann`, callback
  `http://localhost:1455/auth/callback` with registered fallback port `1457`,
  scopes `openid`, `profile`, `email`, `offline_access`, `api.connectors.read`,
  and `api.connectors.invoke`, plus the required simplified-flow and
  ID-token-organization authorization parameters.
- Device start `/api/accounts/deviceauth/usercode`, poll
  `/api/accounts/deviceauth/token`, verification `/codex/device`, `403`/`404`
  pending responses, and a 15-minute expiry.
- Backend base `https://chatgpt.com/backend-api/codex`, Responses route
  `/backend-api/codex/responses`, models route
  `/backend-api/codex/models?client_version=<adapter-version>`, and usage route
  `https://chatgpt.com/backend-api/wham/usage`.
- `Authorization: Bearer`, `ChatGPT-Account-ID`, Kogg `User-Agent`, response
  `ETag`/`X-Models-Etag`, and no silent `codex_cli_rs` impersonation.
- Responses `include: ["reasoning.encrypted_content"]` and native V2 header
  `x-codex-beta-features: remote_compaction_v2`.
- Usage wire shape: primary `codex`, ordered `additional_rate_limits`, sparse
  dynamic `x-<group>-*` headers, `codex.rate_limits` events, credits, and active
  limit metadata.

The fixtures assert exact outbound URL, method, required headers, and payload.
Unknown response fields remain preserved. An unexpected required change fails
as a compatibility error instead of being guessed at runtime.

### Authoritative conversation journal

Each ChatGPT Codex conversation has an append-only provider-native journal and
an atomically installed committed request window. Both bind issuer, account,
workspace, and `identity_epoch`.

The on-disk contract requires:

- Exclusive single-writer leases with fencing, plus revision compare-and-swap
  for sample, append, compaction, rewind, and clear operations.
- Versioned, framed, checksummed records with monotonic sequence and revision
  numbers and strict size limits.
- The intended request and tool state are flushed before external dispatch.
- Committed windows are written to a temporary file, flushed, atomically
  renamed, and followed by directory `fsync`.
- A truncated final frame may be recovered; checksum failure, invalid ordering,
  unsupported schema, or ambiguous migration refuses to resume.
- No journal or cache may be opened under a different bound identity.

The full human transcript is retained separately from the provider request
window. Native compaction may replace the latter but never rewrites the former.

### Responses protocol

The initial adapter uses the ChatGPT Codex Responses endpoint with streaming,
`store: false`, encrypted reasoning included, and a stable session-specific
prompt-cache key. Standard mode omits `service_tier`; Fast mode sends
`service_tier: "priority"` only when advertised by the selected model.

The adapter preserves complete native response items, including assistant
phase, encrypted reasoning, tool calls and outputs, compaction items, usage,
and unknown fields. It requires `response.completed`. A malformed known event,
missing terminal event, or partial terminal response fails the turn.

The complete terminal output is validated and durably committed before any
local tool is dispatched. If an unsupported hosted or unknown item appears in
that terminal output, the entire turn fails before a later tool can cause a
side effect.

### Tool transaction safety

Provider `call_id` is the authoritative correlation key and is persisted without
rewriting. Each execution follows this durable state machine:

```text
prepared -> dispatched -> result_recorded -> submitted
```

The provider-call-to-local-execution mapping is flushed before dispatch. The
result is flushed before the next sampling request. After a crash in
`dispatched` without a durable result, Kogg blocks and asks for reconciliation,
unless that specific tool exposes a verified idempotency/status query. It never
automatically re-executes an ambiguous call.

The first provider milestone advertises local function tools only. Inherited
Qwen tools, Kogg-native tools, MCP/plugins, and later hosted tools appear in one
catalog with source, availability, requirements, approval class, and degraded
reason. Hosted or unknown items are preserved raw and fail closed until an
individual adapter is implemented. A fallback is used only when declared, and
the actual execution source is always shown.

All sources share one approval system. YOLO mode cannot bypass hard confirmation
for credentials, purchases, publishing, permission changes, or destructive
external actions.

### Models and Fast mode

`GET /backend-api/codex/models` is authoritative for ChatGPT Codex model
availability and capabilities. A successful fetch atomically replaces only the
ChatGPT Codex portion of the model registry. Kogg preserves raw unknown fields,
ETag, compatibility version, TTL, and an account-scoped last-known-good copy.
Malformed refreshes keep that copy and surface staleness.

`/models` renders the authoritative returned catalog, including the raw
reasoning, context, modality, tool, and service-tier capabilities that Kogg can
safely explain. It does not use a bundled allowlist as account entitlement.

A resumed conversation remains bound to its recorded model. If that model is
no longer present, Kogg blocks for an explicit new choice; it never silently
switches. Backend defaults apply only to fresh conversations.

`/fast on`, `/fast off`, and `/fast status` manage a persistent preference that
defaults off. The catalog, not a model-name heuristic, determines support.
Unsupported selection is rejected or automatically disabled with a visible
reason. This behavior is separate from Qwen Code's existing `fastModel` concept.

### Limits and local usage

Account limits and local token statistics are different domains. `/limits`
shows subscription limits; `/stats` shows Kogg's local observations.

Each successful account fetch is stored as an immutable, ordered raw snapshot.
It includes the primary `codex` group and every returned additional group,
including unknown fields and values. A derived projection may normalize labels,
deduplicate, and sparsely merge stream events or headers, but it never mutates
or narrows the raw snapshot. Full fetches replace the authoritative group set.

The compact footer shows the most constrained returned group. `/limits` renders
all groups dynamically and distinguishes fresh, stale, partially parsed,
unavailable, and authenticated-with-no-groups states. Polling is cancellable and
does not keep the process alive.

Prompt caching, model context occupancy, local per-response usage, and account
quota are reported separately.

### Native compaction and context economy

For `CHATGPT_CODEX`, every Qwen semantic-summary path is disabled, including
automatic compression, `/compress`, hard-rescue summaries, and summary side
queries. Kogg never substitutes its own semantic summary.

Current native V2 compaction is a normal Responses request ending in a
`compaction_trigger` and using the remote-compaction feature header. It must end
in `response.completed` and exactly one completed compaction item. The legacy
native compact route is a separate versioned adapter. Fallback occurs only when
the server explicitly reports a protocol as unsupported; malformed or partial
responses are fatal. Kogg does not spend quota on capability probes.

Before native compaction, Kogg applies deterministic structural savings:
stable prompt prefixes, deferred/dynamic tool definitions, just-in-time
retrieval, artifact-backed large outputs with typed receipts, and a structured
context ledger. Opaque reasoning and provider continuation items remain intact.
If native compaction is unavailable, Kogg saves what it can structurally and
blocks before overflow.

### Authentication and storage security

Browser login uses loopback PKCE with a cryptographically random verifier and
state, an exact callback path and method, one-shot state consumption, bounded
inputs, and a timeout. Device authorization is also supported. Production
issuer, client identifier, endpoints, redirect allowlist, and TLS/proxy policy
are pinned in the compatibility adapter; test injection occurs only through
explicit dependencies.

Returned tokens must pass issuer, audience, account/workspace, and entitlement
checks. Refresh identity disagreement is fatal. A pre-stream 401 may refresh and
retry once; after any response bytes arrive, Kogg never replays automatically.

Credentials use Kogg-owned OS-keychain entries. An atomic owner-only `0600`
fallback is allowed only with a prominent warning; strict mode refuses the
fallback. Replacement clears account caches. Logout attempts revocation and
then removes credentials, models, limits, and conversation access even if
revocation fails. Secrets, authorization query data, and account identifiers
are redacted from logs and diagnostics.

### Privacy and surfaces

Telemetry is off by default and enabled explicitly by command. It never includes
prompts, code, paths, tool arguments/results, credentials, or account IDs.
Local state and diagnostic bundles are owner-only, and doctor output is
redacted.

CLI is the first-class interface, but the same account and conversation
services must support headless/JSON, TypeScript and Python SDKs, ACP, and Serve.
Desktop is out of scope for the initial release.

Supported release targets are Linux x64/arm64, macOS Intel/Apple Silicon,
Windows WSL2, and Docker headless/device login. Native Windows is experimental.

## Delivery slices

1. Design/E2E contract and public Kogg identity.
2. Atomic mechanical `@kogg/*` workspace-scope rename.
3. Account service, authoritative conversation journal, dynamic catalog, and a
   restart-safe text -> local tool -> output -> final-response tracer.
4. Native V2 and legacy compaction with fail-closed context behavior.
5. Dynamic limits, Fast mode, tool-source reporting, and individually adapted
   hosted tools.
6. Headless, SDK, ACP, Serve, packaging, platform, privacy, and release work.

Each slice is independently tested, reviewed, and committed. Security-sensitive
plans receive two independent reviews; nontrivial diffs receive an independent
final review.

## Initial release gate

`main` and public release remain blocked until all of these pass from one exact
`development` commit:

- Deterministic fake-service tests cover OAuth/device auth, refresh/replacement,
  Responses streaming, tool crash recovery, restart/resume, catalog, every
  limit group, Fast mode, and both native compaction protocols.
- Built CLI, headless JSON/NDJSON, SDK, ACP, and Serve exercise the shared public
  services without a paid API fallback.
- Credential permissions, redaction, logout cleanup, hard confirmations, and
  telemetry opt-in pass adversarial tests.
- Packaging and install probes pass on supported platforms, Kogg public branding
  is complete, and upstream licensing/attribution is present.
- A protected opt-in live Pro-account probe verifies current private-contract
  compatibility without exporting credentials or transcripts.
- Build, lint, typecheck, unit/integration/release suites, independent diff
  review, and a clean worktree all pass.

Only then is `main` created at that verified commit and release automation
allowed to publish.
