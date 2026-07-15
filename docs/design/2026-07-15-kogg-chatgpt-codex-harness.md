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

## Blocking prerequisites

The acceptance seam requires a minimal real Kogg distribution foundation before
feature implementation begins: a package whose declared executable is `kogg`,
which builds into the bundled executable that a user actually invokes. The
fixture never substitutes the upstream `qwen` executable or a source entry
point. This prerequisite is intentionally smaller than the separately sequenced
repository-wide rebrand, installer, packaging, and release work.

A compatibility-profile investigation is also blocking before either the
production ChatGPT client or fake service is implemented. It produces the
versioned evidence and fixture described below; implementation cannot start
from remembered or guessed private protocol behavior.

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

Safe status preserves service-provided plan and workspace display semantics
through the Safe Display Value projection and adds a masked identifier derived
from the Account Identity Key. It never exposes raw account or workspace IDs,
subject claims, email addresses, tokens, or a reversible identity value.
Selecting ChatGPT while already connected renders this status plus Continue,
Switch account, and Logout without starting authorization, making an auth
request, or launching a browser.

### Safe service display projection

All service-provided plan, workspace, model, and status strings are untrusted.
The Account/compatibility boundary converts them once into credential-free Safe
Display Values. It decodes strictly, applies Unicode NFC consistently, enforces
both encoded-byte and grapheme ceilings without splitting a grapheme, and marks
truncation visibly. ANSI escape sequences are removed; remaining C0/C1 controls
and newlines are visibly escaped. Invalid sequences and bidirectional
formatting or override characters are rejected or replaced by an explicit safe
placeholder. A value equal to or containing a validated raw account ID,
workspace ID, subject, or email is suppressed or replaced with the approved
masked identifier.

This projection preserves readable service meaning, not raw bytes. The same
projected value object is used by TUI, headless output, Incident Records, and
retained artifacts. Those sinks cannot accept a raw service display string, so
later redaction is not the safety boundary.

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
credentials requiring reconnect, credential-storage isolation unavailable, and
authorized-transport isolation unavailable. Each category carries only valid
recovery actions such as retry catalog, reconnect, switch account, logout, or
review the isolation requirement. Expected states are values; exceptions are
reserved for corrupt persistence or violated invariants.

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

Credential storage and the opaque authorized transport are account-readiness
requirements. If either can be reached outside the privileged Account module,
status is ConnectedBlocked and no inference is issued. Tool-process isolation
is a separate capability: if storage and transport are safe but a tool child
cannot be prevented from reaching credential capabilities, the account remains
Ready for chat while Tool Availability is `Disabled(reason)`. No subscription
tool is advertised or dispatched in that mode. Owner-only file mode is
necessary for a fallback file but does not establish isolation from same-user
tools.

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
unknown fields. User-visible model labels are Safe Display Values; raw labels
remain confined to bounded native protocol state and never reach output or
diagnostic sinks. Kogg does not guess entitlement from bundled model names.

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
single-writer fencing plus revision compare-and-swap. Immutable ownership binds
issuer, workspace, Account Identity Key, and model, but not Identity Epoch. The
current writer lease, each Sampling Attempt, each Tool Transaction, and every
commit carry and revalidate the active epoch. Valid final truncation may recover
to the preceding frame; checksum, ordering, schema, migration, or identity
ambiguity refuses continuation.

When the same validated identity returns under a fresh epoch, continuation
performs an atomic epoch rebind under an exclusive writer lease. It verifies
immutable ownership and that no unresolved old-epoch attempt or tool effect can
be resumed, writes and flushes the new lease generation, then permits new work.
A crash before installation leaves the old epoch fenced; a crash after
installation leaves the new epoch authoritative. An old writer can no longer
append, project, dispatch, submit, or commit.

## First-gate context behavior

Before native compaction is implemented, Responses Conversation disables every
inherited semantic-summary path: the `/compress` command, automatic
compression, hard-rescue compression, and side-query summary generation. It
uses one authoritative Context Budget Contract before every request. The
selected Entitled Model Catalog entry supplies the current context window and
capabilities. The Compatibility Profile pins the exact accounting/tokenization
algorithm and version, the complete serialized provider-native components to
count—including instructions, native request window, encrypted/opaque items,
tool definitions, tool results, and response allowance—and the mandatory safety
margin.

Deterministic structural savings that do not reinterpret provider state use the
same calculator and are followed by a full recalculation. If the model budget,
catalog freshness, accounting version, serialized component rule, or safety
margin is unavailable, stale, changed without reconciliation, or unknown, no
request is sent. If the result exceeds the safe budget, the turn blocks before
overflow with an actionable Incident Record. No semantic-summary or
over-budget request is sent. Provider-native compaction remains a required later
slice of this parent design.

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

## Compatibility Profile investigation

The blocking investigation records a versioned Compatibility Profile backed by
the observed official source revision. Its appendix and machine-readable
fixture pin the exact OAuth issuer, client ID, callback allowlist, scopes, and
authorization parameters; device start and poll endpoints, pending and terminal
statuses, interval changes, and expiry; backend hosts, routes, query fields,
headers, and payloads; Responses SSE event grammar and terminal requirements;
model and limit request/response contracts; and the observed native compaction
contract for its later slice.

For each model-capability shape, the profile pins the Context Budget Contract's
exact accounting/tokenization algorithm and version, canonical serialized
request inputs, output allowance, and safety margin. A model catalog value alone
is insufficient without a matching supported accounting contract.

The initial investigation starts from the previously observed `openai/codex`
revision `f90e7deea6a715bbd153044af6f475eefa749177` and must either confirm it or
record the newer revision actually used. The profile distinguishes exact
required request fields from explicitly declared optional fields and declares
the matcher for each nondeterministic value. It also declares permitted known
response optionality while preserving every unknown response field. “Extra
fields where strict” is not a policy: any permitted request variation must be
named in the profile.

For every endpoint, the profile also declares pre-parse ceilings for total
header bytes and header count, body bytes, string bytes, array elements, object
field count, JSON nesting depth, SSE event bytes and event count, and total and
idle stream duration. It declares the safe cancellation and connection-close
behavior for each request class. These are compatibility and resource limits,
not post-parse validation hints.

## Versioned compatibility seam

The Account and Responses modules depend on narrow protocol ports implemented
by a production compatibility HTTP client. It pins issuer, OAuth client,
redirect policy, service hosts, TLS policy, request fields, supported event
grammar, and adapter version. Required drift produces a compatibility incident;
there is no heuristic repair, official-client impersonation, credential replay,
or paid API fallback.

The production client enforces the Compatibility Profile's resource ceilings
before allocation where possible and incrementally while reading headers,
bodies, structured fields, and SSE. No oversized or over-deep value is handed
to a general parser or journal writer. Event count, total duration, and idle
duration remain bounded throughout streaming. A violation or never-ending
stream produces a typed Incident Record, safely cancels and closes within the
declared bound, commits no partial terminal state, and permits no later local
tool effect.

The deterministic fake is a real loopback HTTP service implementing versioned
Compatibility Scenarios for browser and device authorization, token exchange,
refresh, revocation, identity, entitlement, models, limits, Responses streams,
tools, compaction, timing, and injected faults. It rejects unexpected endpoints,
ordering, required fields, and extra calls. Request fields must match the exact
required fields plus only the optional fields declared by the Compatibility
Profile; nondeterministic timestamps or IDs use only profile-declared matchers.
Unknown response fields are preserved. Request transcripts are sanitized as
they are captured, and captured private production traffic is never replayed.

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

Any service label included in an incident is the already-created Safe Display
Value used by product output. Incident and artifact code cannot independently
re-project or accept the raw service string.

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

The fake-service and security gate controls only this connection. During the
probe stage the ordinary catalog contains no ChatGPT descriptor. A dedicated
protected probe command may invoke a hidden Probe-stage Candidate only inside
fresh disposable state; it cannot enable or persist that descriptor. There is
no environment variable, user setting, or general feature flag that bypasses
the hidden state. Separate browser and device probes run the same bundled path
and production adapter with explicit user confirmation, a harmless prompt/tool,
redacted reporting, and automatic local logout and deletion.

The release pipeline first builds one immutable content-addressed Candidate
Payload. Its canonical digest covers the executable, code, and assets and
explicitly excludes the Detached Enablement Manifest. Browser and device Probe
Attestations bind that payload digest and the Compatibility Profile digest. Only
after both pass may the trusted release pipeline emit an authenticated or signed
detached manifest referencing the same digest pair and both attestations.
Adding or replacing this detached file does not mutate the Candidate Payload.

At runtime, Kogg verifies manifest provenance or signature, both attestations,
and the current payload and profile digests before surfacing the descriptor.
Missing, invalid, stale, mismatched, or rebuilt inputs keep it hidden. An enabled
distribution therefore executes the exact payload that both modes probed. The
blocking compatibility/release-foundation investigation selects the canonical
digest boundary, digest algorithm, signature scheme, and trusted provenance;
the non-circular boundary above is mandatory.

The harmless-tool gate additionally requires proof of at least one supported
execution mode in which Tool Availability is Enabled and tool-process isolation
passes. Chat-only Ready modes may ship only alongside that proven safe
tool-enabled mode; disabling tools everywhere cannot satisfy the first tracer.

## Later required slices in this parent design

Dynamic presentation of the complete immutable primary and additional limit
groups, including unknown groups and fields, remains required after the first
tracer. Provider-native compaction, its strict terminal contract, restart
behavior, and fail-closed recovery also remain required. They are later blocked
slices, not rejected features or substitutes for the first gate's limits and
context behavior.

Secondary-surface Connection Catalog parity is also a later required slice.
The same authoritative catalog remains the only source of order, copy, actions,
availability, and disabled reasons. Each shipped IDE, Web, or other surface must
pass that contract before claiming ChatGPT connection support. Full surface
parity does not widen or block the first CLI tracer.

## Out of scope for this slice

- Automatic or implicit fallback to any API-key provider.
- Combining subscription and OpenAI Platform credentials.
- Multiple simultaneously active ChatGPT accounts.
- Generic hosted tools or an expanded cross-source tool catalog.
- Repository-wide rebrand and installer or release automation work beyond the
  minimal blocking `kogg` package/bin/executable foundation.
- Full parity across Web Shell, IDE, SDK, ACP, Serve, and native Windows in the
  first tracer; each later shipped surface must pass the catalog contract before
  claiming support.
- Fast mode, broad limits UI, and native compaction implementation in the first
  tracer; dynamic limits and native compaction remain later parent requirements.
- A generic cross-provider transaction framework.
- Dependence on Codex App Server or claims that the private contract is public
  or supported for third-party use.
