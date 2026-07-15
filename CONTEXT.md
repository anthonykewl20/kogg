# Kogg ChatGPT Codex

This context names the account, connection, entitlement, and conversation concepts Kogg uses to provide ChatGPT Codex subscription access without conflating it with separately billed model providers.

## Language

**ChatGPT Codex Account**:
The single active human ChatGPT identity together with the Codex subscription entitlements Kogg may use.
_Avoid_: OpenAI API account, provider configuration, token

**Provider Connection**:
A user-selected way for Kogg to obtain model access, either through a ChatGPT Codex Account or through a separately billed API-key provider.
_Avoid_: auth type, credential

**API-key Provider**:
A Provider Connection configured with independently billed provider credentials. It is never an automatic fallback for a ChatGPT Codex Account.
_Avoid_: ChatGPT subscription, included Codex access

**Account-bound Conversation**:
A conversation durably associated with the ChatGPT Codex Account identity and selected entitled model that created it. It cannot continue under a different account identity.
_Avoid_: portable conversation, cross-account session

**Identity Epoch**:
The generation of the active ChatGPT Codex Account identity. Account replacement or logout advances it so account-bound state from an earlier identity cannot remain active.
_Avoid_: session ID, credential version

**Entitled Model Catalog**:
The authoritative, account-scoped set of Codex models and capabilities currently available to a ChatGPT Codex Account.
_Avoid_: bundled model list, guessed models

**Account Session**:
An identity-bound authorization context available only when a ChatGPT Codex Account has validated identity, usable entitlement, and a ready Entitled Model Catalog. It permits inference without exposing credentials to callers.
_Avoid_: access token, auth configuration, provider credentials

**Account Status Snapshot**:
An immutable, credential-free value describing a ChatGPT Codex Account as `Disconnected`, `ConnectedBlocked(reason)`, or `Ready`. Callers render this value rather than interpreting expected conditions as exceptions; authorization and switching progress belong to an Account Transition.
_Avoid_: auth error, provider exception, token status

**Account Transition**:
A cancellable attempt to establish or switch to a ChatGPT Codex Account. It remains separate from the active Account Status Snapshot until the candidate account is fully ready, so failure or cancellation cannot displace a working account.
_Avoid_: pending account, temporary login state, active account switch

**Credential Custody Boundary**:
The security boundary that keeps ChatGPT subscription credentials outside every path available to model tools, sandboxes, UI surfaces, and ordinary provider code. Only the privileged account credential broker may locate or mutate them; keychain and explicitly accepted file storage are implementation details behind this boundary.
_Avoid_: credentials directory, token file, provider settings
