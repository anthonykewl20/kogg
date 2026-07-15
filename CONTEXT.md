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
An immutable, credential-free value describing a ChatGPT Codex Account as `Disconnected`, `ConnectedBlocked(category, actions)`, or `Ready`. Authentication and readiness are separate: an authenticated account can be committed but blocked by missing entitlement, unavailable or expired models, compatibility, credential, or isolation policy. Callers render its category and allowed recovery actions rather than interpreting expected conditions as exceptions; authorization and switching progress belong to an Account Transition.
_Avoid_: auth error, provider exception, token status

**Account Transition**:
A cancellable attempt to establish or switch to a ChatGPT Codex Account. An initial authenticated login may commit as ConnectedBlocked, but a switch candidate remains separate from an existing Ready snapshot until the candidate itself is Ready, so failure or cancellation cannot displace a working account.
_Avoid_: pending account, temporary login state, active account switch

**Credential Custody Boundary**:
The enforceable security boundary that keeps ChatGPT subscription credentials and credential capabilities outside every path, environment variable, process argument, output stream, inherited file descriptor, broker endpoint, and keychain interface available to model tools or sandboxes. Only the privileged Account module may use the custody interface. If this isolation cannot be proven, Kogg refuses the connection or disables subscription tool execution rather than relying on file permissions.
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

**Bundled-CLI Acceptance Fixture**:
A disposable user environment that runs the actual bundled `kogg` executable through a PTY against a Compatibility Scenario. It owns process, filesystem, restart, concurrency, permission, and cleanup mechanics while tests state user behavior and assertions explicitly; failures retain a sanitized evidence bundle and successful runs remove artifacts unless retention was requested.
_Avoid_: source-mode test rig, mocked CLI, product-flow DSL

**Incident Record**:
A minimal, structured, redacted account or conversation failure record addressed by an incident ID. Its interface accepts only allowlisted operational fields and cannot accept prompts, tool content, credentials, headers, raw bodies, arbitrary objects, or free-form exception dumps.
_Avoid_: debug log entry, raw error dump, telemetry event

**Incident Store**:
The owner-only local repository for Incident Records. It enforces the seven-day and 100 MiB global limits with oldest-first pruning, supports account-scoped destructive deletion and explicit clearing/export, and never replaces a primary product outcome when storage itself fails.
_Avoid_: debug log file, crash dump directory, conversation history
