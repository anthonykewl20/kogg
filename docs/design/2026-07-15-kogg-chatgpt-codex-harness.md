# Kogg ChatGPT Subscription Architecture

Date: 2026-07-15
Status: Accepted for specification and ticketing

## Goal and first shippable slice

Kogg will surface a human ChatGPT account with Codex entitlement as its highest
connection option. This connection is distinct from the separately billed
OpenAI Platform API and never falls back to it automatically.

The first shippable slice is one complete vertical path: authoritative
connection catalog, browser and device login, credential custody, identity and
entitlement validation, authoritative model readiness, first provider-native
Responses prompt, safe incident diagnostics, restart-safe execution of one
harmless local tool, and ordinary and destructive logout. The option stays
withheld until that path passes the bundled-CLI acceptance gate.

A repository-wide rebrand, hosted-tool support, general tool-catalog expansion,
SDK and secondary-surface parity, Fast mode, native compaction expansion,
packaging, and release-platform work remain separately sequenced. Their future
interfaces must be compatible with the seams here, but they do not widen this
slice.

The ChatGPT backend and OAuth client are private compatibility contracts. Kogg
must identify drift explicitly, fail closed, and withhold this Experimental
feature without blocking unrelated Kogg releases.

## Module map

The design uses deep modules with narrow, enforceable interfaces:

- The Connection Catalog describes ordered choices and delegates typed actions
  to the module that owns each connection.
- The ChatGPT Codex Account module owns authorization, identity, readiness,
  switching, credential refresh, session acquisition, and logout.
- Credential Custody owns immutable secret entries, atomic active selection,
  fencing, deletion, and storage policy, but no OAuth or HTTP behavior.
- Common conversation and turn orchestration sits above provider adapters.
  Existing `GeminiChat` behavior stays inside a Gemini adapter; ChatGPT
  continuation uses a provider-native Responses Conversation adapter.
- Responses Conversation owns its native journal, Sampling Attempts, Tool
  Transactions, validation, recovery, and generic read-only projection.
- Incident Diagnostics owns typed incident capture, retention, inspection,
  export, and deletion. It is not an extension of the legacy debug logger.
- The Compatibility Scenario service and Bundled-CLI Acceptance Fixture prove
  these production seams through a real process and real loopback HTTP.

## Connection Catalog

One presentation-neutral catalog is authoritative for first run, `/auth`,
direct login commands, and every surface added later. Each descriptor includes
a stable connection ID, order, title, description, badge semantics, billing
disclosure, availability, disabled reason, current safe status, and the typed
actions that its owning module can execute. It contains no React, Ink, terminal,
or IDE rendering behavior.

The first entries and copy are fixed:

1. `ChatGPT / Codex subscription`, badge `Experimental`: “Sign in with ChatGPT
   and use your included Codex plan”.
2. `OpenAI API`: “Usage billed separately through OpenAI Platform.”
3. Existing API-key providers in their defined order.

The API-key registry remains an adapter for API-key choices. The ChatGPT
Account module supplies its own descriptor and actions. The catalog does not
invent a universal action language: it carries typed action handles owned and
executed by the relevant module. Surfaces render descriptors and invoke those
handles without branching on ChatGPT versus API-key behavior.

Before the first production ChatGPT authorization, Kogg presents the
Experimental/private-contract disclosure once and stores only the fact that it
was acknowledged. Selecting the connection first offers browser login, device
code, or cancel; it never launches a browser by surprise. Browser failure
offers retry, device code, or cancel without silently switching methods.
Attended terminals may select device flow when a callback is impossible;
unattended use requires an explicit noninteractive mode and never waits
indefinitely.

When already connected, the descriptor offers continue, switch account, and
logout. Limit exhaustion may offer change provider, but choosing OpenAI API
repeats the separate-billing warning and requires an explicit user action.

## Account identity, authentication, and readiness

The Account module separates four concepts that must not collapse into one
token-valid flag:

- An Account Identity Key is a stable local pseudonym derived from validated
  issuer, account, and workspace identity. It binds account-scoped history
  without exposing raw identifiers.
- Identity Epoch is a local fencing generation. Activation, replacement,
  logout, or invalidation advances it.
- Credential Revision versions credentials for the same identity.
- Readiness means validated identity and entitlement plus an authoritative,
  unexpired Entitled Model Catalog.

The immutable credential-free Account Status Snapshot is exactly one of:

- `Disconnected`.
- `ConnectedBlocked(category, actions)` for an authenticated connection that
  cannot currently issue inference.
- `Ready`, from which callers may acquire an Account Session.

Blocked categories are stable and descriptive. They include no entitlement,
catalog unavailable, catalog expired, private-contract incompatibility,
credentials requiring reconnect, and security isolation unavailable. Each
category carries only valid recovery actions such as retry catalog, reconnect,
switch account, logout, or review the isolation requirement. Expected states
are values; exceptions are reserved for corrupt persistence or violated
invariants.

Initial login may durably commit a validated identity and credentials as
ConnectedBlocked when entitlement is absent or the model catalog is not ready.
This lets the user see an honest connected state and choose retry, switch, or
logout. Account switching is stricter: while a Ready account exists, the
candidate remains a separate cancellable Account Transition and cannot replace
the active account until the candidate is itself Ready. Failure or cancellation
leaves the old account untouched.

An Account Session exposes an opaque, host-pinned authorized transport. It
never exposes a bearer token, credential path, generic header callback, or raw
HTTP client. The transport is limited to compatibility-adapter operations and
binds the Account Identity Key, Identity Epoch, model catalog revision, and
selected model.

Every boundary that could create an effect revalidates the epoch immediately
before it proceeds: network request, local tool dispatch, tool-result
submission, terminal projection, and durable commit. Logout or account
replacement first advances the epoch and fences active sessions. Streaming is
interrupted and persisted honestly; no later request or tool effect proceeds
under the old authorization.

## History and logout

Conversations bind the stable Account Identity Key and selected entitled model,
not merely the current epoch. When another account is active, prior histories
remain locally visible but read-only. Returning to the original validated
identity restores continuation under a fresh epoch after readiness succeeds.

Ordinary logout first invalidates local access, advances the epoch, and removes
credentials, active model and limit state, and continuation capability. It
retains account-bound conversation history and permitted incidents. Confirmed
“Log out and delete local account data” additionally deletes histories,
projections, journals, model and limit caches, and incidents associated with
the Account Identity Key.

## Credential Custody Boundary

Credential safety is an enforceable isolation property, not a file-location
convention. Secrets and capabilities that can retrieve them must never enter a
tool or sandbox through readable home, runtime, workspace, or artifact paths;
environment variables; process arguments; stdout or stderr; inherited file
descriptors; broker sockets; IPC handles; or usable keychain interfaces.
Tool-child environments and OS isolation must deny both direct secret storage
and the privileged account broker.

If Kogg cannot prove that boundary on a platform or execution mode, it must
either refuse the ChatGPT connection or disable model-requested tool execution
for subscription conversations with an explicit reason. Owner-only file mode
is necessary for a fallback file but does not establish isolation from
same-user tools.

The custody module exposes only semantic transactions to the Account module:
read the active immutable entry, install a new immutable revision, atomically
compare-and-swap the active pointer for the expected Account Identity Key and
Credential Revision, fence and tombstone an identity, and delete or clean
orphaned entries. It does not authorize, refresh over HTTP, or construct
requests.

OS keychain storage is preferred. An atomic, symlink-safe owner-only fallback
is offered only after explicit confirmation; strict mode refuses it. Updating
credentials writes a complete immutable entry before changing the active
pointer. A crash can leave an unreachable orphan, which bounded cleanup may
remove, but cannot leave a partially mutated active secret.

Logout and destructive deletion are local-first. Under the inter-process lock,
Kogg advances the epoch, installs a tombstone, and removes or clears the active
pointer before attempting remote revocation. Remote revocation is bounded and
best effort. Its failure is reported safely but cannot preserve or resurrect
local access. Stale refresh and switch writers lose compare-and-swap against
the tombstone. Orphan cleanup never promotes an entry.

## Entitled models and limits

The account-scoped model response is authoritative. A successful refresh
atomically installs an immutable Entitled Model Catalog with its compatibility
version, ETag, revision, TTL, returned default, capabilities, and preserved
unknown fields. Kogg does not guess entitlement from bundled model names.

A last-known-good catalog keeps the account Ready only while it is within its
authoritative TTL. A refresh failure during that period produces a visible
warning while inference may continue. At expiry, status becomes
ConnectedBlocked with retry, switch, and logout actions. A resumed conversation
never silently changes its recorded model; a removed model requires an explicit
new selection.

Usage limits are a separate snapshot. An unavailable limits endpoint or an
empty/unknown limit projection does not block otherwise-ready inference. Only
an authoritative service response reporting active exhaustion blocks the
affected operation and shows the group and reset information. Kogg never uses
limit availability as an entitlement proxy and never changes provider
automatically.

## Conversation orchestration and native Responses state

Common conversation and turn orchestration belongs above provider-specific
conversation adapters. It coordinates UI events, approval requests, tool
catalog access, cancellation, and generic completed-turn projection without
owning a provider wire format. Gemini-backed conversations keep the existing
Gemini adapter. ChatGPT-backed conversations use the Responses adapter from the
first request through continuation and recovery.

Provider-native continuation must never route through the existing generic
content generator or its provider refresh path. Responses Conversation owns
request construction, streaming protocol validation, native items, encrypted
reasoning, call identifiers, unknown fields, request windows, retries,
compaction state, and the authoritative journal.

Streaming text may be projected transiently for display. Transient output is
marked non-durable and disappears or is visibly interrupted after failure. Only
a complete, validated terminal response may be committed to the native journal
and then projected as a durable generic turn. The generic transcript is a
replaceable read-only projection and is never used to reconstruct, retry,
compact, or mutate native continuation.

The journal is framed, checksummed, versioned, size-bounded, and protected by
single-writer fencing plus revision compare-and-swap. Its bindings include
issuer, Account Identity Key, Identity Epoch, workspace, and model. Valid final
truncation may recover to the preceding frame; checksum, ordering, schema,
migration, or identity ambiguity refuses continuation.

## Sampling Attempts and Tool Transactions

Every provider request is a durable Sampling Attempt. Request intent and its
epoch are committed before sending. The attempt distinguishes prepared, sent,
streaming, uncertain, failed-before-bytes, and terminal-committed outcomes. A
crash or transport loss after a request may have reached the service is not an
ordinary retry. Kogg reconciles through a provider idempotency or status
facility when the pinned compatibility contract offers one; otherwise it
blocks for explicit recovery rather than risking a duplicate continuation.

A pre-stream unauthorized response may refresh and retry once after epoch and
revision revalidation. No request is automatically replayed after response
bytes or an uncertain send.

Each model-requested local effect has a durable Tool Transaction. It records
preparation, approval pending, approval denied or cancelled, dispatch intent,
dispatch confirmed or locally ambiguous, result recorded, and its continuation
Sampling Attempt. Approval denial and cancellation are terminal recorded
outcomes and cause no dispatch. The complete provider terminal containing the
tool request is validated and committed before dispatch intent; dispatch intent
is then flushed before the tool runs. A crash with ambiguous local dispatch
blocks unless the individual tool offers a verified idempotency or status
protocol.

The tool result is flushed before its continuation Sampling Attempt. The Tool
Transaction is considered submitted only after that attempt's resulting
terminal response is validated and committed, not merely after bytes are sent.
An uncertain submission or next response therefore remains recoverable without
claiming success. Epoch revalidation precedes approval completion, dispatch,
submission, terminal projection, and commit.

The first slice advertises one harmless local tool. Hosted and unknown
actionable items are preserved in native state and fail closed before any later
local effect. A shared cross-provider Tool Transaction abstraction is deferred
until a second implementation demonstrates the same contract.

## Versioned compatibility seam

The Account and Responses modules depend on narrow protocol ports implemented
by a production compatibility HTTP client. It pins issuer, OAuth client,
redirect policy, service hosts, TLS policy, request fields, supported event
grammar, and adapter version. Required drift produces a compatibility incident;
there is no heuristic repair, official-client impersonation, credential replay,
or paid API fallback.

The deterministic fake is a real loopback HTTP service implementing versioned
Compatibility Scenarios for browser and device authorization, token exchange,
refresh, revocation, identity, entitlement, models, limits, Responses streams,
tools, compaction, timing, and injected faults. It rejects unexpected endpoints,
ordering, required fields, and extra calls. Only declared matchers permit
nondeterministic timestamps or IDs, and request transcripts are sanitized as
they are captured. Captured private production traffic is never replayed.

Bundled acceptance tests configure the production compatibility HTTP client to
connect to the loopback fake through explicit test-only endpoint injection.
They do not substitute an in-memory adapter. In-memory ports are allowed only
for focused module tests that cannot exercise process or wire behavior.

## Incident Diagnostics

Subscription account and Responses paths report only through a distinct
Incident Diagnostics module. Its input is a typed allowlist of timestamp,
phase, status category, request ID, retry decision, error class, safe protocol
state, adapter version, and account-scoped pseudonym. It cannot accept arbitrary
objects or strings, raw exceptions, credentials, cookies, headers, callback
queries, URLs containing secrets, prompts, tool arguments or results, raw
bodies, or user content.

Each failure displays an incident ID. The diagnostics command shows a redacted
summary and owner-only local record location. Debug detail adds only safe
protocol state. Export requires explicit confirmation, creates a redacted
bundle, and never uploads it. Clear removes all incidents. Ordinary logout
retains permitted incidents; destructive account deletion removes incidents
for that Account Identity Key.

The owner-only Incident Store uses atomic records and enforces a global maximum
age of seven days and maximum size of 100 MiB with oldest-first pruning. Record,
read, export, clear, prune, and account deletion tolerate concurrent processes.
A corrupt index is rebuilt from validated records or reported unavailable.
Disk, permission, or store corruption failure preserves the original product
error and adds a diagnostics-unavailable marker without recursive logging.

Subscription code is prohibited from using the legacy arbitrary debug logger,
including as a fallback when incident storage fails. Static dependency checks
and runtime adversarial tests enforce this boundary.

## Acceptance and release gating

The authoritative user-level seam runs the actual bundled `kogg` executable
through a PTY in a disposable home, runtime, and workspace against the loopback
fake. It asserts rendered choices and disclosures, process output and exit,
durable state, credential isolation, permissions, tool effects, sanitized
requests, restart, concurrency, incidents, and cleanup.

Failure artifacts are sanitized during capture, never copied raw and cleaned
later. Before retention, a separate secret scan must pass across terminal
output, service transcript, incident records, and the state-tree manifest. If
the scan cannot prove safety, artifacts are deleted and the failure reports
that evidence retention was suppressed. Successful-run artifacts are deleted
unless explicit safe retention was requested.

The fake-service and security gate controls only whether the ChatGPT option may
be surfaced. Separate protected live browser and device probes run the same
bundled path and production adapter with disposable state, explicit user
confirmation, a harmless prompt/tool, redacted reporting, and automatic local
logout and deletion. Both modes are required for a feature release candidate.
A live compatibility failure withholds the Experimental connection but does not
block unrelated Kogg release work.

## Out of scope for this slice

- Automatic or implicit fallback to any API-key provider.
- Combining subscription and OpenAI Platform credentials.
- Multiple simultaneously active ChatGPT accounts.
- Generic hosted tools or an expanded cross-source tool catalog.
- Repository-wide rebrand and package, installer, or release automation work.
- Full parity across Web Shell, IDE, SDK, ACP, Serve, and native Windows.
- Fast mode, broad limits UI, and native compaction beyond what the first prompt
  and restart-safe tool tracer require.
- A generic cross-provider transaction framework.
- Dependence on Codex App Server or claims that the private contract is public
  or supported for third-party use.
