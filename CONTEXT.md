# Kogg ChatGPT Codex

This context names the account, connection, entitlement, and conversation concepts Kogg uses to provide ChatGPT Codex subscription access without conflating it with separately billed model providers.

## Language

**ChatGPT Codex Account**:
The single active human ChatGPT identity together with the Codex subscription entitlements Kogg may use.
_Avoid_: OpenAI API account, provider configuration, token

**Provider Connection**:
A user-selected way for Kogg to obtain model access, either through a ChatGPT Codex Account or through a separately billed API-key provider.
_Avoid_: auth type, credential

**Connection Catalog**:
The authoritative, ordered set of Provider Connections Kogg may present, including labels, disclosures, availability, and actionable disabled reasons. It places the Experimental ChatGPT subscription connection first and adapts the existing provider registry only for API-key connections.
_Avoid_: provider registry, auth menu, model provider list

**API-key Provider**:
A Provider Connection configured with independently billed provider credentials. It is never an automatic fallback for a ChatGPT Codex Account.
_Avoid_: ChatGPT subscription, included Codex access

**Account-bound Conversation**:
A conversation durably associated with the stable Account Identity Key and selected entitled model that created it. It becomes read-only under another identity, becomes continuable again when its original identity returns, and is removed only by confirmed destructive account deletion.
_Avoid_: portable conversation, cross-account session

**Responses Conversation**:
An Account-bound Conversation whose authoritative state remains in the provider-native Responses protocol through streaming, tool use, retry, compaction, and durable recovery. Generic Kogg history is a replaceable, read-only projection created only from durable completed state and is never used to reconstruct or mutate the conversation.
_Avoid_: Gemini chat, generic transcript, converted response history

**Tool Transaction**:
The durable, Responses-internal lifecycle of one model-requested tool effect. It records preparation, approval, denial or cancellation, dispatch intent, successful or ambiguous local dispatch, the result, and the Sampling Attempt that acknowledges the result. A tool is submitted only when the resulting terminal response is committed.
_Avoid_: tool message, function call pair, generic tool event

**Sampling Attempt**:
The durable lifecycle of one provider sampling request, including a tool-result continuation. It records request intent before sending, distinguishes an uncertain send or interrupted stream from a terminal validated response, and requires reconciliation before retry unless provider idempotency or status proves the outcome.
_Avoid_: retry flag, HTTP attempt, tool submission

**Account Identity Key**:
A stable, local, pseudonymous key derived from the validated issuer, account, and workspace identity. It binds histories and account-scoped data across logout and later return without exposing or persisting a raw identity in user-facing state.
_Avoid_: account ID, email, Identity Epoch

**Identity Epoch**:
The local fencing generation of the active ChatGPT Codex Account. Account activation, replacement, logout, or local invalidation advances it so work authorized under an earlier generation cannot cross another network, tool, submission, or durable-commit boundary.
_Avoid_: session ID, credential version

**Entitled Model Catalog**:
The authoritative, account-scoped set of Codex models and capabilities currently available to a ChatGPT Codex Account. A last-known-good catalog remains ready only within its declared TTL; refresh failure warns while it is valid and blocks readiness after expiry.
_Avoid_: bundled model list, guessed models

**Account Session**:
An identity-bound authorization capability available only when a ChatGPT Codex Account has validated identity, usable entitlement, and a ready Entitled Model Catalog. It exposes an opaque host-pinned authorized transport rather than a bearer credential, and every privileged boundary revalidates its Identity Epoch.
_Avoid_: access token, auth configuration, provider credentials

**Account Status Snapshot**:
An immutable, credential-free value describing a ChatGPT Codex Account as `Disconnected`, `ConnectedBlocked(category, actions)`, or `Ready`. Authentication and readiness are separate: an authenticated account can be committed but blocked by missing entitlement, unavailable or expired models, compatibility, credentials, or failure to isolate credential storage or authorized transport. Tool-process isolation is reported separately as Tool Availability and does not demote an otherwise Ready chat connection. Callers render expected states rather than interpreting them as exceptions; authorization and switching progress belong to an Account Transition.
_Avoid_: auth error, provider exception, token status

**Safe Display Value**:
The single credential-free projection of any untrusted service plan, workspace, model, or status string. The Account/compatibility boundary preserves display semantics rather than raw bytes: it applies consistent Unicode NFC normalization, grapheme- and encoded-byte ceilings, visible escaping or removal of ANSI/C0/C1 controls and newlines, rejection or neutralization of invalid and bidirectional formatting sequences, and suppression or masking of values matching validated raw identity claims. TUI, headless output, incidents, and retained artifacts consume this same projection; raw service display strings never reach them.
_Avoid_: raw service label, sanitized later, terminal-safe string

**Tool Availability**:
A credential-free capability value reported independently from Account Status as `Enabled` or `Disabled(reason)`. Failure to prove tool-process isolation disables subscription tools while chat may remain Ready; it does not excuse unsafe storage or authorized transport.
_Avoid_: account blocked, tool permission prompt, provider readiness

**Account Transition**:
A cancellable attempt to establish or switch to a ChatGPT Codex Account. An initial authenticated login may commit as ConnectedBlocked, but a switch candidate remains separate from an existing Ready snapshot until the candidate itself is Ready, so failure or cancellation cannot displace a working account.
_Avoid_: pending account, temporary login state, active account switch

**Credential Custody Boundary**:
The enforceable security boundary that keeps ChatGPT subscription credentials and authorized transport within the privileged Account module and keeps credential capabilities outside every path, environment variable, process argument, output stream, inherited file descriptor, broker endpoint, and keychain interface available to model tools or sandboxes. Failure to isolate storage or authorized transport makes the account ConnectedBlocked; failure limited to a tool process makes Tool Availability disabled. File permissions alone do not prove either boundary.
_Avoid_: credentials directory, token file, provider settings

**Credential Revision**:
A monotonic version paired with account identity for compare-and-swap credential mutations. Refresh, switch, logout, and deletion reject a stale identity or revision instead of overwriting newer authoritative state.
_Avoid_: modification time, last write wins, token timestamp

**Credential Secret Entry**:
An immutable, revisioned secret record installed before an atomic compare-and-swap of the active credential pointer. Logout first fences locally and writes a tombstone, preventing stale writers from resurrecting access; bounded best-effort remote revocation and orphan cleanup follow without weakening the local result.
_Avoid_: mutable token file, active token blob, best-effort delete

**Compatibility Scenario**:
A versioned, deterministic description of ChatGPT auth, identity, entitlement, model, limit, Responses, tool, compaction, and fault behavior used by the fake compatibility service. It rejects unexpected calls, ordering, and fields except for explicit nondeterministic matchers, and produces a sanitized request transcript without replaying captured private traffic.
_Avoid_: mock response, recorded session, golden private payload

**Compatibility Profile**:
A versioned, evidence-backed appendix and fixture that pins the observed official source revision and exact required and declared-optional OAuth, device, backend, streaming, model, limit, and compaction wire contract. It declares per-endpoint pre-parse response ceilings for headers, bodies, structured fields and nesting, SSE events, and stream duration. Production and fake adapters implement this profile; undocumented required-field guesses are prohibited and unknown response fields are preserved within those ceilings.
_Avoid_: loose OpenAI compatibility, best-effort wire shape, captured account traffic

**Probe-stage Candidate**:
The hidden ChatGPT connection descriptor available only to the dedicated protected probe command in disposable state before release enablement. It cannot appear in the ordinary catalog or be enabled or persisted by an environment or user flag; both live modes must pass before a release-build manifest may surface the normal descriptor.
_Avoid_: feature flag, hidden menu option, developer bypass

**Probe Attestation**:
A protected live-probe result bound to the cryptographic digest of the exact bundled release artifact and the digest of its Compatibility Profile. A release manifest may enable the descriptor only when current browser and device attestations match both current digests; stale, mismatched, or rebuilt inputs remain withheld.
_Avoid_: latest probe result, branch-level approval, mutable enable flag

**Bundled-CLI Acceptance Fixture**:
A disposable user environment that runs the actual bundled `kogg` executable through a PTY against a Compatibility Scenario. It owns process, filesystem, restart, concurrency, permission, and cleanup mechanics while tests state user behavior and assertions explicitly; failures retain a sanitized evidence bundle and successful runs remove artifacts unless retention was requested.
_Avoid_: source-mode test rig, mocked CLI, product-flow DSL

**Incident Record**:
A minimal, structured, redacted account or conversation failure record addressed by an incident ID. Its interface accepts only allowlisted operational fields and cannot accept prompts, tool content, credentials, headers, raw bodies, arbitrary objects, or free-form exception dumps.
_Avoid_: debug log entry, raw error dump, telemetry event

**Incident Store**:
The owner-only local repository for Incident Records. It enforces the seven-day and 100 MiB global limits with oldest-first pruning, supports account-scoped destructive deletion and explicit clearing/export, and never replaces a primary product outcome when storage itself fails.
_Avoid_: debug log file, crash dump directory, conversation history
