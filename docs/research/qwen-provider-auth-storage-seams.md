# Qwen Code provider, authentication, and secure-storage seams

- **Date:** 2026-07-14
- **Issue:** [#3 — Map Qwen Code’s provider, authentication, and secure-storage seams](https://github.com/anthonykewl20/kogg/issues/3)
- **Scope:** Current terminal/core behavior in this repository; daemon, ACP, MCP,
  and IDE paths are included only where they expose a reusable boundary or a
  coupling risk
- **Method:** Primary repository source, tests, and maintained documentation

## Executive summary

Qwen Code already has good reusable seams for declarative API-key providers,
OpenAI-compatible inference, model resolution, runtime model-provider reload,
OAuth mechanics, and credential storage. They are not one integrated provider
lifecycle.

The current architecture has four distinct layers:

1. A static registry of `ProviderConfig` presets drives setup UI and builds a
   provider-install plan.
2. `modelProviders` and `providerProtocol` populate a model registry that can be
   hot-reloaded independently of the static setup registry.
3. `AuthType` selects one of a fixed set of inference protocols/generators; most
   named providers share the `openai` auth type.
4. Credentials use three separate persistence families: API keys in environment
   sources/settings, Qwen OAuth's dedicated file and token manager, and MCP
   OAuth's token-storage stack.

The smallest existing model-provider path is therefore
`ProviderConfig -> ProviderInstallPlan -> modelProviders -> ModelsConfig ->
ContentGenerator`. It assumes an API key available synchronously through an
environment key. Browser/device login, refresh, logout, account state, and
cross-process token coordination are not part of that contract.

The reusable secure-storage boundary is the `SecretStorage`/`TokenStorage`
interface plus `HybridTokenStorage`, but it is currently an MCP/extension
facility, not the universal provider credential path. Its file backend uses
atomic replacement without cross-process read-modify-write locking, and its
token backends hide expired credentials; both behaviors matter before reusing
it for refreshable provider tokens.

This report maps the seams only. It does not select or design a final provider.

## Seam map

| Concern                      | Current boundary                                                                                                                                                                                                            | Current behavior                                                                                                                       | Reuse constraint                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Provider declaration         | [`ProviderConfig`](../../packages/core/src/providers/types.ts#L35)                                                                                                                                                          | Describes protocol, endpoint choices, env key, models, validation, ownership, headers, and setup UI hints                              | Has no OAuth, refresh, logout, account, or dynamic-catalog hook                                                |
| Provider discovery for setup | [`ALL_PROVIDERS`](../../packages/core/src/providers/all-providers.ts#L49)                                                                                                                                                   | Statically imports every preset and derives UI groups                                                                                  | Adding a setup-visible provider is a source-code registration, not plugin discovery                            |
| Installation                 | [`buildInstallPlan`](../../packages/core/src/providers/provider-config.ts#L242) and [`applyProviderInstallPlan`](../../packages/core/src/providers/install.ts#L130)                                                         | Writes a key to `settings.env`/`process.env`, merges models, selects auth/model, reloads, and calls `refreshAuth` with rollback        | Assumes key-shaped credentials and writes provider models under the protocol/auth type                         |
| Settings persistence         | [`ProviderSettingsAdapter`](../../packages/core/src/providers/types.ts#L185) and the [CLI adapter](../../packages/cli/src/config/loadedSettingsAdapter.ts#L27)                                                              | Abstracts settings writes, backup, restore, and persistence; CLI writes eagerly on each `setValue`                                     | Backup/restore is compensation, not an atomic multi-key transaction                                            |
| Auth/inference selection     | [`AuthType`](../../packages/core/src/core/contentGenerator.ts#L56) and [`createContentGenerator`](../../packages/core/src/core/contentGenerator.ts#L353)                                                                    | Fixed protocol enum dispatches to OpenAI, Qwen OAuth, Anthropic, or Gemini/Vertex generators                                           | Named provider identity and authentication lifecycle are not first-class here                                  |
| Model configuration          | [`ModelProvidersConfig`](../../packages/core/src/models/types.ts#L70), [`ProviderProtocolConfig`](../../packages/core/src/models/types.ts#L82), and [`ModelRegistry`](../../packages/core/src/models/modelRegistry.ts#L103) | Arbitrary provider ids can route to a built-in protocol; models are keyed by id + base URL                                             | Qwen OAuth remains hard-coded; unknown protocols cannot be added from settings                                 |
| Runtime model reload         | [`ModelsConfig.reloadModelProvidersConfig`](../../packages/core/src/models/modelsConfig.ts#L1391)                                                                                                                           | Clears and rebuilds user-configured models while preserving Qwen OAuth models                                                          | Reloads supplied configuration; it does not discover a remote catalog or define cache invalidation             |
| OpenAI-compatible inference  | [`OpenAIContentGenerator`](../../packages/core/src/core/openaiContentGenerator/openaiContentGenerator.ts#L23) and provider adapters                                                                                         | Uses the official OpenAI SDK and converts Qwen's internal request shape to Chat Completions                                            | Endpoint-specific wire behavior may require an adapter; auth refresh is outside the generic provider interface |
| Browser OAuth                | [`MCPOAuthProvider`](../../packages/core/src/mcp/oauth-provider.ts#L151)                                                                                                                                                    | MCP-scoped discovery, dynamic client registration, PKCE, local callback, browser launch, exchange, refresh, and deletion               | Methods are MCP-shaped and mostly private; default storage is not always hybrid/encrypted                      |
| Device OAuth                 | [Qwen OAuth client](../../packages/core/src/qwen/qwenOAuth2.ts#L286) and [serve `DeviceFlowProvider`](../../packages/cli/src/serve/auth/device-flow.ts#L318)                                                                | Qwen-specific RFC 8628 + PKCE; terminal flow can open a browser; daemon registry owns polling and redaction                            | Qwen OAuth is discontinued in the terminal UI, and serve currently supports only `qwen-oauth`                  |
| Hybrid storage               | [`TokenStorage` and `SecretStorage`](../../packages/core/src/mcp/token-storage/types.ts#L30) plus [`HybridTokenStorage`](../../packages/core/src/mcp/token-storage/hybrid-token-storage.ts#L16)                             | Chooses OS keychain when usable, otherwise an encrypted file                                                                           | Not used by model-provider keys or Qwen OAuth; backend choice is cached and no backend migration is performed  |
| Cross-process refresh        | [`SharedTokenManager`](../../packages/core/src/qwen/sharedTokenManager.ts#L202)                                                                                                                                             | Qwen-specific memory cache, mtime polling, in-process promise coalescing, and file lock around refresh                                 | Strong behavior but tightly coupled to Qwen token schema, filenames, singleton, and OAuth client               |
| Startup                      | [`initializeApp`](../../packages/cli/src/core/initializer.ts#L57) and [`validateNonInteractiveAuth`](../../packages/cli/src/validateNonInterActiveAuth.ts#L16)                                                              | Interactive startup tries cached auth before rendering; headless startup requires selected, valid auth and refreshes before the prompt | A provider must support both promptable and non-prompting startup explicitly                                   |

## 1. Provider registration and installation

### Static setup registry

`ProviderConfig` is the declarative setup contract. It covers a provider id and
label, a fixed `AuthType` protocol, fixed/selectable/free-form base URLs, a fixed
or generated environment key, model definitions, model ownership/merge rules,
custom headers, validation, and UI grouping
([source](../../packages/core/src/providers/types.ts#L35)). Presets are imported
manually into `ALL_PROVIDERS`; the Alibaba and third-party groups are filters
over that array
([source](../../packages/core/src/providers/all-providers.ts#L45)). The terminal
dialog reads those groups and resolves selections back through
`findProviderById`
([source](../../packages/cli/src/ui/auth/AuthDialog.tsx#L166)).

This registry is static application code. A user can add models and custom
provider ids in settings, but that does not create a new setup wizard entry.

### Install-plan boundary

`buildInstallPlan` turns a preset plus user inputs into a data object containing
an auth type, one key/value environment entry, model-provider patches, selected
model, and optional metadata
([source](../../packages/core/src/providers/provider-config.ts#L242)). The
custom-provider preset demonstrates the broadest existing form: selectable
OpenAI/Anthropic/Gemini protocol, free-form endpoint, generated private env key,
free-form models, and identity-based merging
([source](../../packages/core/src/providers/presets/custom-provider.ts#L78)).

`applyProviderInstallPlan` then:

- rejects process-altering environment names, writes the credential to both
  `settings.env` and the live process, and warns if a higher-priority shell or
  `.env` value will shadow it on restart
  ([source](../../packages/core/src/providers/install.ts#L162));
- merges models under `patch.authType`, persists
  `security.auth.selectedType`, and updates the selected model
  ([source](../../packages/core/src/providers/install.ts#L197));
- reloads the live model registry, synchronizes model/auth state, and calls
  `refreshAuth`
  ([source](../../packages/core/src/providers/install.ts#L281)); and
- restores settings, process environment, and the prior runtime model map on
  failure
  ([source](../../packages/core/src/providers/install.ts#L305)).

The core plan/applier is shared beyond the TUI: ACP and `qwen serve` call the
same functions
([ACP source](../../packages/cli/src/acp-integration/acpAgent.ts#L5539),
[serve source](../../packages/cli/src/serve/run-qwen-serve.ts#L4275)), and the VS
Code companion supplies another `ProviderSettingsAdapter`
([source](../../packages/vscode-ide-companion/src/services/settingsWriter.ts#L432)).
Changing this core contract can therefore affect surfaces outside terminal V1.

### Important split: provider identity versus protocol

Settings can group models under an arbitrary provider id and map it through
`providerProtocol` to `openai`, `anthropic`, or another built-in protocol
([source](../../packages/core/src/models/types.ts#L70)). `ModelRegistry` merges
all provider ids that resolve to the same protocol and treats `(id, baseUrl)` as
the model identity
([source](../../packages/core/src/models/modelRegistry.ts#L117)).

The install-plan path is narrower: `buildInstallPlan` creates a patch whose key
is the selected protocol, and `applyProviderInstallPlan` writes it as
`modelProviders.${patch.authType}`
([plan source](../../packages/core/src/providers/provider-config.ts#L269),
[apply source](../../packages/core/src/providers/install.ts#L203)). Consequently,
the preset id is setup metadata, while runtime selection generally sees only an
auth protocol plus model/base URL/env key. A lifecycle that must identify a
specific account-bearing provider cannot assume `AuthType.USE_OPENAI` uniquely
identifies it.

## 2. Authentication types and configuration resolution

The supported generator families are a closed enum: `openai`, `qwen-oauth`,
`gemini`, `vertex-ai`, and `anthropic`
([source](../../packages/core/src/core/contentGenerator.ts#L56)).
`createContentGenerator` validates resolved configuration and dispatches on that
enum; unsupported values fail before inference
([source](../../packages/core/src/core/contentGenerator.ts#L353)).

For ordinary providers, authentication is possession of an API key. The model
resolver combines the selected `modelProviders` record, CLI flags, protocol
environment variables, settings credentials, and defaults while recording the
source of every value
([source](../../packages/core/src/models/modelConfigResolver.ts#L139)). Model
provider values are deliberately highest priority for the selected provider;
API keys are read from the model's `envKey`
([source](../../packages/core/src/models/modelConfigResolver.ts#L168)). The CLI
preflight validator mirrors that provider lookup, including custom provider ids
routed through `providerProtocol`
([source](../../packages/cli/src/config/auth.ts#L28)).

Qwen OAuth is a separate special case. Its models are hard-coded and ignore
`modelProviders` overrides
([source](../../packages/core/src/models/modelRegistry.ts#L103)); its resolver
injects a dynamic-token placeholder instead of reading an API-key environment
variable
([source](../../packages/core/src/models/modelConfigResolver.ts#L305)); and its
generator fetches a valid token/endpoint for each operation and retries once
after forced refresh on an auth error
([source](../../packages/core/src/qwen/qwenContentGenerator.ts#L84)). This is the
only current model generator with a refreshable-token lifecycle.

Current product behavior must not be confused with that surviving code: Qwen
OAuth is absent from the setup dialog and `validateAuthMethod` blocks new use
because its free tier was discontinued on 2026-04-15
([source](../../packages/cli/src/config/auth.ts#L262)).

## 3. Browser and device flows

### Browser callback: MCP OAuth

The generic browser-callback implementation lives under MCP, not model
providers. `MCPOAuthProvider` supports OAuth metadata discovery, optional dynamic
client registration, PKCE, a localhost callback server, secure browser launch,
authorization-code exchange, token persistence, refresh, and invalid-token
deletion
([configuration and registration](../../packages/core/src/mcp/oauth-provider.ts#L48),
[authorization flow](../../packages/core/src/mcp/oauth-provider.ts#L695),
[refresh](../../packages/core/src/mcp/oauth-provider.ts#L954)). It exposes auth
URL/display events for UI consumers and uses a module-global callback server so
a second attempt closes the first
([source](../../packages/core/src/mcp/oauth-provider.ts#L23)).

This is useful primary-source evidence for Qwen's loopback/PKCE mechanics, but it
is not a ready model-provider lifecycle interface. Its configuration and stored
credential identity are MCP-server-shaped, and most flow operations are private
methods on one class.

### Device code: Qwen OAuth

`IQwenOAuth2Client` exposes the smaller protocol primitives—request device
authorization, poll with device code and PKCE verifier, and refresh
([source](../../packages/core/src/qwen/qwenOAuth2.ts#L286)). The terminal helper
creates a PKCE pair, emits the verification data, prints a fallback URL for
suppressed/non-interactive browser launch, opens the browser when allowed,
polls, and caches the result
([source](../../packages/core/src/qwen/qwenOAuth2.ts#L807)).

The daemon has a more explicit provider boundary: `DeviceFlowProvider` separates
`start`, `poll`, and abort-aware persistence while keeping device codes and PKCE
verifiers in redacting wrappers
([source](../../packages/cli/src/serve/auth/device-flow.ts#L188)). Its registry
owns polling, concurrency caps, timeout/cancellation, terminal-state retention,
events, and audit behavior
([source](../../packages/cli/src/serve/auth/device-flow.ts#L7)). However, its
supported-provider tuple currently contains only `qwen-oauth`, and the default
registry always installs that implementation
([type source](../../packages/cli/src/serve/auth/device-flow.ts#L121),
[registration source](../../packages/cli/src/serve/server/device-flow-registry.ts#L43)).

No `ProviderConfig` hook connects either OAuth family to the static provider
installer. Reuse would require extracting or adapting a lifecycle boundary;
renaming a preset is insufficient.

## 4. Credential storage

### API-key providers: environment and plaintext settings

Provider installation writes the entered key to `settings.env` and
`process.env`, and models keep only the environment-key name
([source](../../packages/core/src/providers/install.ts#L162)). At startup,
credential priority is CLI flag, existing process environment, discovered
`.env`, then `settings.env`; settings values fill only missing values
([source](../../packages/cli/src/config/environment.ts#L462)). Therefore API keys
entered through `/auth` are persisted in plaintext settings. The maintained auth
documentation warns that `settings.json.env` is plaintext
([source](../users/configuration/auth.md#step-2-set-environment-variables)).

### Qwen OAuth: dedicated plaintext file plus coordination

Qwen OAuth stores `QwenCredentials` in `~/.qwen/oauth_creds.json`. Writes use a
restricted directory, mode `0600`, no-follow atomic replacement, and an
in-process cache invalidation
([source](../../packages/core/src/qwen/sharedTokenManager.ts#L608)); the data is
JSON, not encrypted. `clearQwenCredentials` deletes that file and clears the
singleton's memory cache
([source](../../packages/core/src/qwen/qwenOAuth2.ts#L1202)).

### MCP/extension hybrid storage

The reusable interfaces are deliberately small. `TokenStorage` defines CRUD/list
operations for OAuth credentials; `SecretStorage` defines CRUD/list operations
for named strings
([source](../../packages/core/src/mcp/token-storage/types.ts#L30)).
`HybridTokenStorage` dynamically loads the OS-keychain backend, verifies that it
works, and otherwise chooses an encrypted file; `QWEN_CODE_FORCE_FILE_STORAGE`
forces the file path
([source](../../packages/core/src/mcp/token-storage/hybrid-token-storage.ts#L12)).
It caches the chosen backend for the object lifetime and delegates both
interfaces to it.

The keychain implementation uses `keytar` and tests availability with a
set/get/delete cycle
([source](../../packages/core/src/mcp/token-storage/keychain-token-storage.ts#L221)).
The file implementation encrypts with AES-256-GCM using a key derived from the
hostname, username, and fixed application material, then writes mode `0600` via
atomic replacement
([source](../../packages/core/src/mcp/token-storage/file-token-storage.ts#L20)).
This is encrypted-at-rest fallback, not OS hardware-backed protection.

Hybrid storage is not the universal current OAuth path. `MCPOAuthTokenStorage`
uses its legacy plaintext `mcp-oauth-tokens.json` by default and emits a warning;
only `QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE=true` routes it through
`HybridTokenStorage`
([source](../../packages/core/src/mcp/oauth-token-storage.ts#L24)). Qwen OAuth and
model-provider API keys do not use `HybridTokenStorage` at all.

Two semantics need attention before token reuse:

- Both keychain and encrypted-file `getCredentials` return `null` for an expired
  access token
  ([file source](../../packages/core/src/mcp/token-storage/file-token-storage.ts#L125),
  [keychain source](../../packages/core/src/mcp/token-storage/keychain-token-storage.ts#L54)).
  A refresher that needs the expired record's refresh token cannot use that read
  behavior unchanged.
- File-backed `setCredentials` and `setSecret` perform read-modify-write followed
  by atomic file replacement, but there is no inter-process lock around the
  sequence
  ([token write](../../packages/core/src/mcp/token-storage/file-token-storage.ts#L140),
  [secret write](../../packages/core/src/mcp/token-storage/file-token-storage.ts#L233)).
  Atomic replacement prevents partial files; it does not prevent two processes
  from losing one another's updates.

## 5. OpenAI-compatible inference and dynamic model configuration

For `AuthType.USE_OPENAI`, `createContentGenerator` constructs an
`OpenAIContentGenerator`
([source](../../packages/core/src/core/contentGenerator.ts#L370)). The factory
selects endpoint-specific adapters by resolved configuration and otherwise uses
`DefaultOpenAICompatibleProvider`
([source](../../packages/core/src/core/openaiContentGenerator/index.ts#L40)). The
default adapter creates the official OpenAI SDK client from `apiKey`, `baseUrl`,
timeouts, retries, proxy options, and headers, and builds Chat Completions
requests
([source](../../packages/core/src/core/openaiContentGenerator/provider/default.ts#L47)).
The provider interface is intentionally about wire behavior—headers, client,
request transformation, defaults, and parsing—not credential lifecycle
([source](../../packages/core/src/core/openaiContentGenerator/provider/types.ts#L26)).

Model configuration is dynamic in two local senses:

1. Settings can define arbitrary model records with model id, env key, base URL,
   generation config, and display metadata
   ([source](../../packages/core/src/models/types.ts#L46)).
2. `reloadModelProvidersConfig` rebuilds the live user-configured registry without
   restarting the process
   ([source](../../packages/core/src/models/modelsConfig.ts#L1391)).

It is not dynamic catalog discovery. `ModelRegistry.reloadModels` accepts a
complete supplied map, clears prior non-Qwen entries, and re-registers it
([source](../../packages/core/src/models/modelRegistry.ts#L339)). The install
presets themselves carry static model arrays; for example, OpenRouter ships two
editable defaults rather than fetching a catalog
([source](../../packages/core/src/providers/presets/openrouter.ts#L13)). No shared
contract currently owns remote discovery, entitlement filtering, last-known-good
catalog persistence, TTL/versioning, or invalidation.

## 6. Interactive and non-interactive startup

The CLI chooses an auth type in this order: `--auth-type`, persisted
`security.auth.selectedType`, then environment inference, and resolves the model
configuration before creating `Config`
([source](../../packages/cli/src/config/config.ts#L1836)).

Interactive initialization calls `performInitialAuth` before the React UI is
rendered. That function calls `config.refreshAuth(authType, true)`; initialization
opens the auth dialog when no auth type was explicitly provided or the refresh
failed
([initializer](../../packages/cli/src/core/initializer.ts#L50),
[auth source](../../packages/cli/src/core/auth.ts#L21)). For Qwen OAuth, the
initial flag means cached credentials are required rather than starting device
authorization before the UI is ready
([source](../../packages/core/src/core/contentGenerator.ts#L376)). Provider setup
inside the rendered dialog applies the install plan, reloads models, refreshes
auth, and reports success/failure
([source](../../packages/cli/src/ui/auth/useAuth.ts#L156)).

Non-interactive startup requires an already selected auth type, enforces any
configured auth-type policy, validates credentials unless external auth is
enabled, calls `refreshAuth`, and exits with mode-appropriate error output on
failure
([source](../../packages/cli/src/validateNonInterActiveAuth.ts#L16)). It does not
open `/auth`. The former `qwen auth` command now only prints migration guidance;
interactive configuration belongs to `/auth`, while automation uses flags,
environment, or settings
([source](../../packages/cli/src/commands/auth.ts#L19)).

`Config.refreshAuth` is the common activation seam. It synchronizes selected
model state, resolves/validates the final generator config, creates a new
content generator, and swaps it in only after successful initialization
([source](../../packages/core/src/config/config.ts#L3027)). For API-key providers
this rebuilds a client; it is not a refresh-token callback. Qwen OAuth refresh is
implemented inside its OAuth client/generator instead.

## 7. Refresh, logout, and cross-process coordination

There is no general model-provider lifecycle interface for refresh, logout,
status, or account switching. `ProviderConfig` and `ProviderInstallPlan` contain
no such methods
([config source](../../packages/core/src/providers/types.ts#L35),
[plan source](../../packages/core/src/providers/types.ts#L161)). `/auth` installs
or switches a provider; it does not remove all of that provider's persisted keys
and models. The only model-provider OAuth logout primitive is Qwen-specific
`clearQwenCredentials`; MCP token deletion is scoped to an MCP server.

Qwen's `SharedTokenManager` is the strongest existing concurrency reference. It:

- coalesces refreshes within a process with a shared promise and checks the
  credential file's modification time for changes from other sessions
  ([source](../../packages/core/src/qwen/sharedTokenManager.ts#L202));
- acquires an exclusive lock file, rechecks credentials after acquiring it, and
  lets a process reuse a token refreshed by another process
  ([source](../../packages/core/src/qwen/sharedTokenManager.ts#L458)); and
- handles stale locks with bounded retry/backoff and releases the lock after the
  operation
  ([source](../../packages/core/src/qwen/sharedTokenManager.ts#L695)).

That implementation is coupled to `QwenCredentials`, `QwenOAuth2Client`, fixed
`oauth_creds.json`/`oauth_creds.lock` paths, one singleton, and Qwen-specific
error taxonomy. It is a behavioral reference, not a generic token coordinator.
The hybrid file backend has atomic writes but lacks the equivalent lock, mtime
reload, and refresh coalescing.

## 8. Test inventory

| Behavior                                                                                       | Primary tests                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider plan construction, ownership, merge identity, headers, and setup-step decisions       | [`provider-config.test.ts`](../../packages/core/src/providers/__tests__/provider-config.test.ts#L37) and preset tests under [`providers/__tests__/presets`](../../packages/core/src/providers/__tests__/presets)                                                                                                                     |
| Install persistence, env-key denylist/shadowing, merge behavior, refresh, and rollback         | [`install.test.ts`](../../packages/core/src/providers/__tests__/install.test.ts#L39)                                                                                                                                                                                                                                                 |
| Terminal provider submit, dialog navigation, key masking, and failure presentation             | [`useAuth.test.ts`](../../packages/cli/src/ui/auth/useAuth.test.ts#L74), [`AuthDialog.test.tsx`](../../packages/cli/src/ui/auth/AuthDialog.test.tsx#L241), and [`ProviderSetupSteps.test.tsx`](../../packages/cli/src/ui/auth/ProviderSetupSteps.test.tsx)                                                                           |
| Initial and non-interactive auth activation/error contracts                                    | [`core/auth.test.ts`](../../packages/cli/src/core/auth.test.ts#L22) and [`validateNonInterActiveAuth.test.ts`](../../packages/cli/src/validateNonInterActiveAuth.test.ts#L46)                                                                                                                                                        |
| Model/provider routing, duplicate identities, custom protocols, and hot reload                 | [`modelRegistry.test.ts`](../../packages/core/src/models/modelRegistry.test.ts#L38), [`modelsConfig.test.ts`](../../packages/core/src/models/modelsConfig.test.ts), and [`modelConfigResolver.test.ts`](../../packages/core/src/models/modelConfigResolver.test.ts#L15)                                                              |
| OpenAI-compatible generator/pipeline/adapters                                                  | [`openaiContentGenerator.test.ts`](../../packages/core/src/core/openaiContentGenerator/openaiContentGenerator.test.ts#L39) and provider tests under [`openaiContentGenerator/provider`](../../packages/core/src/core/openaiContentGenerator/provider)                                                                                |
| Qwen PKCE/device flow, refresh, clearing, retries, file synchronization, and lock behavior     | [`qwenOAuth2.test.ts`](../../packages/core/src/qwen/qwenOAuth2.test.ts#L126), [`qwenContentGenerator.test.ts`](../../packages/core/src/qwen/qwenContentGenerator.test.ts), and [`sharedTokenManager.test.ts`](../../packages/core/src/qwen/sharedTokenManager.test.ts#L162)                                                          |
| Keychain/encrypted-file selection and token/secret delegation                                  | [`hybrid-token-storage.test.ts`](../../packages/core/src/mcp/token-storage/hybrid-token-storage.test.ts#L50), [`file-token-storage.test.ts`](../../packages/core/src/mcp/token-storage/file-token-storage.test.ts), and [`keychain-token-storage.test.ts`](../../packages/core/src/mcp/token-storage/keychain-token-storage.test.ts) |
| MCP browser callback/discovery/refresh                                                         | [`oauth-provider.test.ts`](../../packages/core/src/mcp/oauth-provider.test.ts) and [`oauth-utils.test.ts`](../../packages/core/src/mcp/oauth-utils.test.ts)                                                                                                                                                                          |
| Daemon device-flow redaction, polling, timeout, cancellation, persistence, and Qwen adaptation | [`device-flow.test.ts`](../../packages/cli/src/serve/auth/device-flow.test.ts#L240) and [`qwen-device-flow-provider.test.ts`](../../packages/cli/src/serve/auth/qwen-device-flow-provider.test.ts#L56)                                                                                                                               |

The current suite has no end-to-end test for a setup-visible model provider that
combines browser/device OAuth, hybrid secure storage, refreshable
OpenAI-compatible inference, logout, dynamic remote models, and cached headless
reuse; no such integrated path exists. The hybrid file-storage tests are
single-process and therefore do not establish coherent concurrent
read-modify-write behavior.

## 9. Smallest reusable boundaries

These are reuse assessments, not a final architecture:

1. **Keep the declarative model/install core where credentials remain key-like.**
   `ProviderConfig`, `buildInstallPlan`, `ProviderSettingsAdapter`, and
   `applyProviderInstallPlan` already solve model generation, safe settings
   mutation, runtime reload, and rollback. An OAuth lifecycle cannot be encoded
   solely as `env: { key: value }` without extending or surrounding this seam.
2. **Keep model resolution and hot reload.** `ModelProvidersConfig`,
   `ProviderProtocolConfig`, `ModelRegistry`, and `ModelsConfig` are the smallest
   boundaries for exposing an already-known model set. Remote discovery and
   cache policy remain separate missing responsibilities.
3. **Keep the OpenAI-compatible generator when the authorized inference
   transport really is Chat Completions compatible.** The default provider
   handles standard wire behavior; a specialized adapter is warranted only for
   endpoint-specific request/response behavior. Token acquisition is not part
   of `OpenAICompatibleProvider` today.
4. **Reuse the storage interfaces before their MCP wrapper.** `SecretStorage` is
   the smallest general namespace for opaque strings. `TokenStorage` provides a
   useful record shape but its expired-token filtering conflicts with refresh
   unless adapted. `HybridTokenStorage` supplies backend selection, but needs a
   deliberate namespace, migration policy, concurrency policy, and security
   review for the file fallback.
5. **Reuse OAuth protocol mechanics selectively.** MCP OAuth owns generic
   browser callback/PKCE/discovery; `IQwenOAuth2Client` exposes compact device
   primitives; serve's `DeviceFlowProvider` cleanly separates start/poll/persist
   and redacts secrets. Each is coupled to its current product surface, so the
   reusable unit is the behavior/interface, not wholesale reuse of the existing
   class.
6. **Treat `Config.refreshAuth` as activation, not token refresh.** It is the
   existing point for rebuilding the generator after credentials or models
   change. Long-lived token validity must be owned by a separate provider
   lifecycle or dynamic generator, as Qwen OAuth demonstrates.
7. **Use `SharedTokenManager` as the cross-process behavior baseline.** The
   important invariants are single refresh, post-lock recheck, atomic durable
   write, stale-lock recovery, mtime reload, and memory invalidation. The current
   Qwen class itself is too schema/path/client-specific to be a general boundary.

## 10. Coupling and migration risks

1. **Protocol and provider lifecycle are conflated.** All OpenAI-compatible
   providers share `AuthType.USE_OPENAI`; auth selection alone cannot identify
   which provider, account, token namespace, or logout behavior is active.
2. **Setup registration and runtime model registration are different systems.**
   Adding `modelProviders` data enables model routing but does not add a setup
   flow; adding a preset does not add a new generator/auth lifecycle.
3. **The installer is API-key-shaped.** It expects a key at install time and
   persists it to plaintext settings. Browser/device login and refresh cannot be
   added safely by treating an access token as a permanent API key.
4. **Three credential stores can coexist.** API keys, Qwen OAuth, and MCP OAuth
   use different schemas, paths, encryption, cleanup, and refresh semantics. A
   migration must define source-of-truth, one-time import, rollback, old-secret
   deletion, backend changes, and partial-failure recovery without reading or
   overwriting another client's namespace.
5. **Hybrid does not mean universally encrypted or concurrency-safe.** MCP uses
   plaintext by default unless forced to hybrid; the encrypted fallback derives
   a local key rather than using an OS root of trust; and its atomic replacement
   lacks cross-process locking around read-modify-write.
6. **Expired-token reads can erase the refresh path.** The secure token backends
   return `null` for expired credentials even when a refresh token is present.
   A provider token repository must preserve the material required for refresh
   while never serving an expired access token as valid.
7. **Qwen OAuth code is live but product-discontinued.** Reusing it directly can
   inherit hard-coded client/endpoints, model restrictions, file paths, error
   language, telemetry labels, and the discontinued auth gate. Shared behavior
   must be extracted without making the new provider an alias for Qwen OAuth.
8. **Dynamic model catalogs have no owner.** Hot reload accepts a complete map,
   but no existing boundary defines entitlement discovery, capability
   validation, last-valid cache, freshness, offline behavior, or removal of a
   model that is currently selected.
9. **Startup must never unexpectedly prompt in headless mode.** Interactive
   initialization deliberately separates cached activation from prompt UI;
   non-interactive startup validates and exits. Any cached subscription path
   must preserve that split and define behavior for expired/missing credentials.
10. **Core changes have broad consumers.** The provider installer is used by
    terminal, ACP, serve, and VS Code. A terminal-only lifecycle should not
    accidentally expose unfinished daemon/IDE behavior through shared exports.
11. **Logout and account state are missing general contracts.** Switching a
    provider does not necessarily remove its stored key/models, and only the
    Qwen-specific path coordinates disk and memory clearing. Status, account
    identity, and account switching would be new lifecycle responsibilities.
12. **Settings writes are compensating, not transactional.** The CLI adapter
    persists each dotted write immediately. A process crash can leave a partial
    install even though ordinary thrown errors trigger restore; migrations must
    be restart-safe and idempotent.

## Conclusion

Qwen Code's existing seams can support a later constrained redesign without
rewriting model resolution or OpenAI-compatible inference, but the current
provider abstraction is not an OAuth provider abstraction. The work that remains
conceptually outside today's contracts is subscription login ownership, secure
token repository semantics, cross-process refresh, logout/account state, remote
catalog policy, and mode-aware startup behavior.

The decisive implementation constraint is to preserve the boundaries that are
already deep—install planning, model registry/resolution, generator activation,
and secure backend selection—while not pretending their current API-key, MCP, or
Qwen-specific contracts already compose into a refreshable subscription
provider.
