# Codex compatibility profile: pinned evidence and fail-closed authority

**Issue:** [#24](https://github.com/anthonykewl20/kogg/issues/24), child of
[#21](https://github.com/anthonykewl20/kogg/issues/21)

**Research date:** 2026-07-16

**Official implementation revision:**
[`openai/codex@cbc83d961e8132bfff4d340ab8342d181b79e95e`](https://github.com/openai/codex/commit/cbc83d961e8132bfff4d340ab8342d181b79e95e)
(committed 2026-07-16T05:38:36Z)

**Profile state:** **blocked**. Every open contract is recorded as
`UNRESOLVED — fail closed` below.

## Scope and evidence rules

This document is the human-readable evidence record for the normative
[machine-readable profile](./chatgpt-codex-compatibility-profile.v1.json)
required by #24. The JSON is authoritative for consumers; this record explains
its observations, policies, and unresolved gaps. Neither document enables the
ChatGPT-subscription path. Observations are pinned to one immutable revision of
the official public Codex repository. The official authentication documentation
was also consulted on 2026-07-16; because that page is mutable, it is
explanatory evidence rather than the source of a machine contract.

The official docs distinguish ChatGPT subscription access from usage-based API
access and describe browser sign-in as the default Codex login method
([official authentication docs](https://learn.chatgpt.com/docs/auth), accessed
2026-07-16). The pinned README likewise says to select **Sign in with ChatGPT**
and lists eligible ChatGPT plans, while API-key use requires separate setup
([README](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/README.md#L58-L62)).

Labels used throughout:

- **Observed Codex** means behavior found at the pinned official revision. It
  is evidence, not permission to impersonate the first-party client.
- **Kogg policy** means a proposed local safety or release rule owned by this
  project. It is not attributed to OpenAI.
- **Machine contract** means data that must be represented in the versioned
  profile and enforced by code and the strict fake.
- Anything not pinned precisely enough to implement safely is
  **UNRESOLVED — fail closed**. The feature remains hidden when any required
  contract is unresolved.

No credentials, private traffic, prompts, identities, tokens, or response
content were inspected. This research used only public source and public
official documentation.

## Compatibility profile

### 1. Browser OAuth

**Observed Codex.** The browser flow uses issuer `https://auth.openai.com`,
loopback callback port 1455 with 1457 as a fallback, PKCE, and a state value
([server constants](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/server.rs#L57-L60),
[startup](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/server.rs#L150-L179)).
The authorization request is `GET /oauth/authorize` with these fields:

- required: `response_type=code`, `client_id`, `redirect_uri`, `scope`,
  `code_challenge`, `code_challenge_method=S256`, `state`, and `originator`;
- fixed scope:
  `openid profile email offline_access api.connectors.read api.connectors.invoke`;
- currently sent compatibility fields:
  `id_token_add_organizations=true` and `codex_cli_simplified_flow=true`;
- optional: `allowed_workspace_id`.

These fields and their construction are visible in the pinned source
([authorization query](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/server.rs#L553-L588)).
The state is 32 random bytes encoded as unpadded base64url
([state generation](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/server.rs#L591-L594));
the PKCE verifier is 64 random bytes encoded the same way and the challenge is
the unpadded base64url SHA-256 digest
([PKCE](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/pkce.rs#L12-L26)).

The callback listener binds only to `127.0.0.1`, accepts
`/auth/callback?code=...&state=...`, rejects a state mismatch, and propagates
OAuth errors
([callback parsing](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/server.rs#L309-L405),
[loopback binding](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/server.rs#L614-L672)).
On local-success configuration, the callback returns a 302 to `/success`; the
same listener then serves `/success` or `/cancel` and exits
([follow-up handling](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/server.rs#L309-L500)).
The code exchange is `POST /oauth/token` with form fields
`grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, and
`code_verifier`; success requires `id_token`, `access_token`, and
`refresh_token`
([token exchange](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/server.rs#L784-L858)).

**Nondeterministic fields.** `state`, PKCE verifier/challenge, authorization
code, all tokens, token expiry, and the selected loopback port are
nondeterministic. Tests and payload digests must compare their structural
contract, never concrete values.

**Kogg policy.** Bind loopback only; require an exact callback path, one request,
matching state, and the same redirect URI at authorization and exchange. Do not
copy Codex's attempt to cancel a process already occupying the preferred port.
Try an explicitly profiled fallback port or report the conflict. Never log
query values, codes, or token bodies.

The observed originator is the first-party value `codex_cli_rs`
([default client](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/default_client.rs#L42-L43)).
The observed first-party OAuth client ID is
`app_EMoamEEZ73f0CkXaXp7hrann`
([client ID](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/manager.rs#L1445-L1452)).
Both values are non-authorizing evidence: Kogg must not claim either identity.
The authorized third-party `client_id`,
`originator`, exact allowed callback ports, and whether the two compatibility
query fields are permitted for Kogg are **UNRESOLVED — fail closed**.

After the normal browser token exchange, the observed first-party client makes
a best-effort second `POST /oauth/token` using the token-exchange grant, the ID
token as `subject_token`, and `requested_token=openai-api-key`
([call site](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/server.rs#L406-L415),
[exchange](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/server.rs#L1110-L1145)).
The machine profile records this observed contract so a strict fake can detect
drift, but Kogg policy forbids sending it, retaining its `access_token`, or
falling back to API-key/API-billed operation.

### 2. Device OAuth

**Observed Codex.** Device login performs:

1. `POST /api/accounts/deviceauth/usercode` with JSON `{ "client_id": ... }`.
   The response must contain `device_auth_id`, a user code under either
   `user_code` or `usercode`. It may contain `interval` as a decimal string;
   omission defaults to zero in the observed decoder
   ([user-code request](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/device_code_auth.rs#L27-L97)).
2. It directs the user to `/codex/device`
   ([verification URL](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/device_code_auth.rs#L165-L179)).
3. It polls `POST /api/accounts/deviceauth/token` with
   `{ "device_auth_id": ..., "user_code": ... }`. A success response contains
   `authorization_code`, `code_challenge`, and `code_verifier`. HTTP 403 and
   404 are treated as pending until a 15-minute deadline; other statuses fail
   ([polling](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/device_code_auth.rs#L99-L147)).
4. It exchanges that code using redirect URI `/deviceauth/callback` and the
   normal token endpoint
   ([exchange](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/device_code_auth.rs#L181-L232)).

**Nondeterministic fields.** Device authorization ID, user code, polling
interval, authorization code, PKCE material, and tokens are nondeterministic.

The public implementation does not pin distinct denial, expiry, or
`slow_down` response semantics, and it accepts the server's polling interval
without a documented bound. Authorized Kogg client identity, typed terminal
errors, and interval limits are **UNRESOLVED — fail closed**.

### 3. Refresh, revoke, and credential storage

**Observed Codex.** Refresh is `POST /oauth/token` with JSON
`{ client_id, grant_type: "refresh_token", refresh_token }`. Returned ID,
access, and refresh tokens are optional replacements. Known server error codes
include expired, reused, and invalidated refresh tokens
([refresh contract](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/manager.rs#L1332-L1458)).
The client refreshes five minutes before a JWT expiry when available and uses
an eight-day fallback age otherwise; endpoints are `/oauth/token` and
`/oauth/revoke`
([refresh constants](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/manager.rs#L176-L193)).

Revoke prefers a refresh token, falls back to an access token, sends JSON
`token`, `token_type_hint`, and `client_id` for refresh tokens, and has a
10-second timeout
([revoke request](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/revoke.rs#L1-L65),
[body](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/revoke.rs#L97-L145)).
Logout clears local storage even if best-effort revocation fails
([logout](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/manager.rs#L2471-L2488)).
Unlike the raw browser/device token clients, refresh and revoke use the default
authentication client, whose observed headers include `originator` and
`User-Agent` and may include `x-openai-internal-codex-residency`
([client selection](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/manager.rs#L310-L330),
[default headers](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/default_client.rs#L328-L349)).

File storage is created with mode 0600, while keyring storage removes the file
fallback
([file storage](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/storage.rs#L191-L224),
[keyring storage](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/storage.rs#L291-L318)).
Codex `auto` storage silently falls back from keyring to file
([auto fallback](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/storage.rs#L427-L451)).

**Kogg policy.** Refresh must be serialized per account, use compare-and-swap
against the credential generation that initiated it, and never overwrite a
newer login/logout. Rotation is atomic. Revoke is attempted before deletion,
but local deletion is unconditional and must be auditable without token data.
Secure-store failure is explicit; there is no silent fallback to plaintext
file storage. Exact secure-store backends and recovery UX are outside this
observed contract and are **UNRESOLVED — fail closed**.

### 4. Identity and entitlement readiness

**Observed Codex.** Decoded claims include email, plan, user ID, account ID,
and FedRAMP status
([claims](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/token_data.rs#L27-L69)).
Account requests attach `Authorization: Bearer`, `ChatGPT-Account-ID`, and,
when applicable, `X-OpenAI-Fedramp`
([bearer headers](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/model-provider/src/bearer_auth_provider.rs#L31-L46)).
The backend client exposes `/wham/profiles/me`, but that endpoint decodes a
token-usage profile whose required top-level field is `stats`; it is not an
identity profile
([profile endpoint](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/backend-client/src/client.rs#L313-L325),
[profile shape](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/backend-client/src/types.rs#L491-L510)).
Likewise `/wham/accounts/check` returns an account list/order/default-selection
shape, accepting the accounts collection as either a list or map; it is not an
affirmative entitlement response
([account shape](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/backend-client/src/types.rs#L99-L131)).

The inspected token path only base64url-decodes JWT payload claims; it does not
verify signature, issuer, audience, or a JWKS chain
([token decoding](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/token_data.rs#L71-L160)).
The only explicit entitlement signal found is a callback denial with
`missing_codex_entitlement`
([callback entitlement error](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/server.rs#L962-L975));
that is negative evidence, not affirmative readiness.

The authoritative identity validation procedure (issuer, audience, signature,
key discovery/rotation, clock skew), affirmative subscription entitlement
check, and the authorization semantics for workspace/account selection are
**UNRESOLVED — fail closed**. A decoded JWT, a plan label, or a successful
account/model response alone must not make the feature ready.

### 5. ChatGPT base URL, models, and limits

**Observed Codex.** ChatGPT-authenticated requests use
`https://chatgpt.com/backend-api/codex`
([provider base](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/model-provider-info/src/lib.rs#L241-L277)).
The shared model transport supplies `originator`, `User-Agent`, and `version`;
may supply configured `OpenAI-Organization`, `OpenAI-Project`, and
`x-openai-internal-codex-residency`; and the bearer layer may supply account
and FedRAMP headers
([provider headers](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/model-provider-info/src/lib.rs#L329-L355),
[default headers](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/auth/default_client.rs#L328-L349),
[bearer headers](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/model-provider/src/bearer_auth_provider.rs#L31-L46)).
The process-scoped transport can also return only allowlisted Cloudflare
infrastructure cookies to ChatGPT hosts; raw cookie values are never profile
evidence
([cookie store](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/http-client/src/chatgpt_cloudflare_cookies.rs#L1-L62)).
The model catalog is `GET /models?client_version=...`, captures `ETag`, and
decodes `{ "models": [...] }`
([models endpoint](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-api/src/endpoint/models.rs#L31-L78),
[response shape](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/protocol/src/openai_models.rs#L596-L600)).
An individual model can supply its slug, supported API, visibility, context
window, maximum context window, auto-compaction limit, reasoning options,
modalities, tools, and effective context percentage
([model fields](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/protocol/src/openai_models.rs#L366-L450)).
Option-valued `description`, `availability_nux`, `upgrade`,
`default_verbosity`, and `apply_patch_tool_type` fields may be omitted and
decode as `None`; the pinned tests explicitly exercise omission of
`availability_nux`
([omission test](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/protocol/src/openai_models.rs#L1078-L1110)).
Catalog refresh has a five-second overall timeout
([models timeout](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/model-provider/src/models_endpoint.rs#L38-L115)).

Codex uses a successful nonempty remote visible-model list as the source of
truth for ChatGPT, but merges bundled models when the remote result is absent
or empty
([merge behavior](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/models-manager/src/manager.rs#L421-L450)).
Its five-minute cache is keyed by client version, not fully by provider/account
identity
([cache selection](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/models-manager/src/manager.rs#L453-L480)).

**Kogg policy.** A fresh, successful, nonempty catalog bound to provider,
account, workspace, client/profile version, and ETag is required. Never merge
bundled guesses, reuse an API-key catalog, or fall back to API billing. Unknown
model fields are preserved in a bounded raw representation. Empty, expired,
wrong-account, or structurally invalid data blocks readiness.

The backend normalizes ChatGPT hosts to `/backend-api`, sends bearer/account
headers, and uses `/wham/usage` for usage/rate limits
([backend URL and headers](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/backend-client/src/client.rs#L150-L231),
[usage endpoint](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/backend-client/src/client/rate_limit_resets.rs#L21-L109)).
The generated payload requires `plan_type` and optionally carries `rate_limit`,
`credits`, `spend_control`, `additional_rate_limits`,
`rate_limit_reached_type`, and `rate_limit_reset_credits`
([limit payload](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs#L15-L54),
[reset-credit wrapper](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/backend-client/src/types.rs#L45-L55));
windows expose used percent, window length, and reset values
([window](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs#L13-L23)).
Response headers can also carry dynamically named primary/secondary limit
families and credits
([rate-limit headers](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-api/src/rate_limits.rs#L22-L101)).

The exact endpoint(s) Kogg is authorized to call, required request headers,
success/error schemas, and the semantic readiness rule for entitlement versus
quota are **UNRESOLVED — fail closed**. Quota exhaustion is not entitlement
loss; both must be represented separately once their contracts are pinned.

### 6. Responses request and SSE

**Observed Codex.** The serialized Responses request has required fields
`model`, `input`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `store`,
`stream`, and `include`; `instructions` is omitted when empty, and tools,
stream options, service tier, prompt-cache key, text settings, and client
metadata are optional
([request structure](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-api/src/common.rs#L215-L239)).
The official client currently requests `reasoning.encrypted_content`, uses
`tool_choice: "auto"`, streams, and conditionally sets the other values
([request builder](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/core/src/client.rs#L823-L907)).
It sends `POST /responses` with `Accept: text/event-stream`
([endpoint](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-api/src/endpoint/responses.rs#L60-L163)).

Recognized SSE wire events include response creation/completion/failure,
output-item add/done, text and tool-input deltas, and reasoning deltas. The
`response.metadata` event is also recognized for model verification, turn
state, and moderation metadata
([metadata projection](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-api/src/sse/responses.rs#L180-L235)).
The
stream wrapper separately projects rate-limit response headers as local
`RateLimits` events
([header projection](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-api/src/sse/responses.rs#L55-L79)).
The current client ignores unknown wire event types and logs/continues past
some malformed event data
([event mapping](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-api/src/sse/responses.rs#L327-L472),
[stream loop](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-api/src/sse/responses.rs#L492-L597)).
Unknown response-item variants collapse to `Other`, losing their original
payload
([response-item enum](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/protocol/src/models.rs#L802-L1033),
[unknown-item test](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/protocol/src/models.rs#L3075-L3090)).

**Kogg policy.** Preserve each bounded raw SSE event and response item before
typed projection. Unknown non-actionable data is retained and round-tripped.
Unknown or malformed data that could authorize a tool, mutate history, signal
completion, or affect accounting is a compatibility incident: cancel, commit
no terminal turn, perform no subsequent effect, and fail closed. Never log raw
event content. Tests must cover required/optional fields, field omission,
ordering-insensitive JSON objects, ordered arrays, unknown-field preservation,
fragmented SSE frames, duplicate/late terminal events, and cancellation.

The exact Kogg-authorized headers (including client/version/originator values),
request compression contract, complete event grammar, ordering/state machine,
retry idempotency semantics, and authoritative terminal/error schemas are
**UNRESOLVED — fail closed**.

### 7. Native compaction

**Observed Codex.** Native compaction is `POST /responses/compact`. Its request
contains `model`, `input`, optional nonempty `instructions`, optional `tools`,
`parallel_tool_calls`, and optional `reasoning`, `service_tier`,
`prompt_cache_key`, and `text`
([compact request](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-api/src/common.rs#L24-L42)).
The response is decoded as `{ "output": [ResponseItem, ...] }`
([compact endpoint](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/codex-api/src/endpoint/compact.rs#L35-L88)).

The later v2 path uses the normal Responses stream. It appends exactly one
`{ "type": "compaction_trigger" }` to the input
([v2 request construction](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/core/src/compact_remote_v2_attempt.rs#L55-L89)).
Success requires `response.completed` and exactly one completed output item of
type `compaction` (the decoder also accepts the wire alias
`compaction_summary`); that item requires `encrypted_content` and may carry
`id` and internal metadata
([item shape](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/protocol/src/models.rs#L1008-L1017)).
Zero or multiple compaction items fail
([v2 collection](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/core/src/compact_remote_v2.rs#L327-L438)).

Because unknown `ResponseItem` variants lose their raw payload in the observed
decoder, exact output validity, preservation, terminal semantics, and Kogg's
authorization to use this endpoint are **UNRESOLVED — fail closed**. Native
compaction must remain unavailable until those contracts, its bounds, and its
history replacement transaction are pinned and tested. There is no local
summarization fallback in this subscription profile.

### 8. Unknown fields and drift

The observed official structs often ignore unknown JSON fields, and some enums
map unknown values to a payload-free `Unknown`/`Other`; for example, the model
tool-call mode maps an unknown string to no recognized mode
([model conversion](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/protocol/src/openai_models.rs#L1137-L1155)).
That behavior is evidence about Codex, not an acceptable Kogg preservation
contract.

**Kogg policy.** Every profiled JSON/SSE response keeps a bounded raw form plus
a typed projection. Unknown keys and unknown non-actionable values survive
decode/encode in their containing object; array order is preserved. JSON object
key order is not semantic. A required field missing, duplicate key, type
mismatch, invalid UTF-8, excess nesting, non-finite number, unexpected
actionable variant, or profile/source revision mismatch is compatibility drift
and fails closed. The incident records endpoint, profile digest, payload digest,
field path, and reason only—never secret or response values.

The set of fields that are safe to classify as non-actionable for each endpoint
is **UNRESOLVED — fail closed**.

## Resource-bound policy

The official revision supplies only scattered operational limits: device login
polls for at most 15 minutes, revoke has a 10-second timeout, model refresh has
a 5-second timeout, the default streaming idle timeout is 300 seconds, and the
default request/stream retry counts are 4/5
([device polling](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/login/src/device_code_auth.rs#L99-L147),
[provider defaults](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/model-provider-info/src/lib.rs#L20-L34)).
It does not pin comprehensive response-size, header, nesting, event-count, or
total-duration ceilings.

The following exact values are **Kogg-owned policy**, not observed OpenAI
requirements. Values are bytes, element/member counts, nesting levels, or
milliseconds as appropriate. Every endpoint names one profile explicitly;
there is no implicit default.

Header inventories cover application-set or application-consumed fields;
standard HTTP framing fields such as `Host` and `Content-Length` remain the
transport implementation's responsibility unless an endpoint names one
explicitly.

| Profile             | Headers bytes/count/value |     Body |  String | Array/object/depth | SSE event/count |      Idle/total |
| ------------------- | ------------------------: | -------: | ------: | -----------------: | --------------: | --------------: |
| `oauth_callback`    |         16384 / 32 / 8192 |        0 |    8192 |          0 / 8 / 1 |           0 / 0 |     5000 / 5000 |
| `oauth_unary`       |        32768 / 64 / 16384 |   131072 |   32768 |     256 / 128 / 16 |           0 / 0 |   10000 / 30000 |
| `identity`          |        32768 / 64 / 16384 |  1048576 |   65536 |    4096 / 512 / 32 |           0 / 0 |   10000 / 30000 |
| `models`            |        32768 / 64 / 16384 |  8388608 |   65536 |    4096 / 512 / 32 |           0 / 0 |   10000 / 30000 |
| `limits`            |        32768 / 64 / 16384 |  4194304 |   65536 |    4096 / 512 / 32 |           0 / 0 |   10000 / 30000 |
| `responses_sse`     |        32768 / 64 / 16384 | 67108864 | 4194304 |  16384 / 4096 / 64 | 4194304 / 65536 | 45000 / 1200000 |
| `native_compaction` |        32768 / 64 / 16384 | 33554432 | 4194304 |  16384 / 4096 / 64 |           0 / 0 |  30000 / 120000 |

Only `Content-Encoding: identity` is accepted, redirects are rejected, and TLS
uses the system trust store with the profiled authorities. Limits are enforced
before general parsing. SSE idle time resets only on a complete valid line or
heartbeat, never on arbitrary bytes. Device authorization has a separate
900000 ms overall lifetime.

On cancellation or any crossed bound, invalidate the attempt generation,
abort the body, make the connection non-reusable within 2000 ms, destroy an
HTTP/1 connection or send HTTP/2 `RST_STREAM`, commit no partial output or tool
state, and never replay a request that may have been sent.

Whether these proposed values are sufficiently compatible with real authorized
responses must be established by protected probes bound to a release candidate.
Until then, production values and per-endpoint exceptions are
**UNRESOLVED — fail closed**.

## Context budgeting and tokenization

**Observed Codex.** The model catalog can provide `context_window`,
`max_context_window`, `auto_compact_token_limit`, and an effective-context
percentage whose default is 95%
([model context fields](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/protocol/src/openai_models.rs#L419-L468)).
The effective window is
`floor(resolved_context_window * effective_context_window_percent / 100)`
([effective-window calculation](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/core/src/session/turn_context.rs#L213-L219));
when a resolved context window exists, auto-compaction uses the lesser of an
explicit catalog limit and `floor(resolved_context_window * 9 / 10)`, defaulting
to that 90% value when the explicit limit is absent. Without a resolved context
window, it uses the explicit limit if present
([formula](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/protocol/src/openai_models.rs#L452-L467)).
Kogg requires a fresh nonempty remote catalog bound to provider, account,
workspace, client, and profile; a bundled fallback may not authorize a send.
However, the local history estimate explicitly describes itself as a coarse
lower bound rather than tokenizer-accurate accounting
([history estimate](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/core/src/context_manager/history.rs#L160-L185)).
It estimates serialized items and encrypted reasoning with adjustments for
images
([item estimation](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/core/src/context_manager/history.rs#L507-L575))
and ultimately uses an approximation of `ceil(UTF-8 bytes / 4)`
([string estimate](https://github.com/openai/codex/blob/cbc83d961e8132bfff4d340ab8342d181b79e95e/codex-rs/utils/string/src/truncate.rs#L71-L84)).
That cannot prove a pre-send upper bound.

A conforming Kogg preflight must account for the exact final serialization of:

- system/developer/user instructions and the complete native conversation
  window, including opaque and encrypted items;
- all tool definitions and schemas, tool calls, and tool results;
- response request wrappers and every field counted by the provider;
- images or other modalities using the provider's exact accounting rule;
- the reserved output allowance; and
- an explicit safety margin applied after exact accounting.

The authoritative tokenizer name and version, encoding of every item/modal
type, whether wrapper/client metadata is counted, catalog-to-model accounting
binding, exact output allowance, safety margin, and proof that the computed
value is a safe upper bound are **UNRESOLVED — fail closed**. The byte/4
estimate must never authorize a send. The machine profile's context-accounting
contract remains `blocked`, so no model is selectable and no request is sent.

## Candidate Payload, profile digest, and release provenance

This entire section is **Kogg-owned policy**. It is not observed Codex behavior.

### Canonical Candidate Payload

The Candidate Payload root is a newly prepared `dist/`. Begin from a clean
checkout where `dist/` is absent, then run the repository's release sequence
in order: `npm run build`, `npm run bundle`, and
`npm run prepare:package`. Preparation must succeed and create
`dist/package.json`; stale or pre-existing output is rejected. Using exactly
npm `11.16.0`, then run
`npm pack --dry-run --json --ignore-scripts` in that directory and require one
pack result. The payload contains exactly the regular paths in that result's
`files` array, excluding the detached names below; `package.json` must be one
of those paths, and every declared `bin` target—including `kogg`—must resolve
to another reported regular file. Unexpected entries are rejected. These
detached files are excluded by exact name:

- `chatgpt-enablement-v1.dsse.json`;
- `chatgpt-browser-probe-v1.dsse.json`; and
- `chatgpt-device-probe-v1.dsse.json`.

Reject absolute paths, `.` or `..` segments, backslashes, NUL, non-UTF-8 names,
symlinks, hardlinks, devices, sockets, duplicate NFC paths, case-folding
collisions, unsafe sizes, and unsupported modes. Normalize relative paths to
slash-separated UTF-8 NFC and sort by unsigned UTF-8 bytes. Each manifest entry
has exactly `{ path, mode, size, sha256 }`; size is a nonnegative JSON-safe
integer, mode is `0755` only for declared package bin targets and `0644`
otherwise, and the file digest is SHA-256 of exact bytes. Reject duplicate JSON
keys before RFC 8785 JCS canonicalization. The entry's `sha256` is exactly 64
lowercase hexadecimal characters with no prefix. Define the domain-separated
digests:

```text
candidate_payload_digest = "sha256:" + lowercase_hex(
  SHA-256(UTF8("kogg-candidate-payload-v1") || NUL || JCS(candidate_manifest))
)
profile_digest = "sha256:" + lowercase_hex(
  SHA-256(UTF8("kogg-chatgpt-compatibility-profile-v1") || NUL || JCS(machine_profile))
)
```

The profile contains no self-digest field. Its digest is calculated externally
over the entire machine profile, so the construction is non-circular.

### Detached manifest and signatures

The enablement-manifest payload and both attestation payloads are closed JCS
JSON objects: reject duplicate keys, undeclared fields, and integers outside
the JSON safe-integer range before RFC 8785 canonicalization. The detached
enablement manifest contains, at minimum:

- schema version, profile ID, package name/version/entrypoint, and monotonically
  increasing feature generation;
- repository identity, source commit, build workflow path pinned to a commit
  SHA, run ID/attempt/URL, and builder identity;
- Candidate Payload digest and profile digest;
- the candidate/profile digest and signature algorithm identifiers;
- browser-probe and device-probe attestation digests, their distinct modes,
  exact subject digests, completion times, and probe workflow identities;
- creation and expiry times; and
- signing key ID.

Each attestation digest is SHA-256 over
`UTF8(mode-specific domain) || NUL || JCS(attestation payload)`, encoded as
`sha256:<lowercase_hex>`. The browser domain is
`kogg-chatgpt-browser-attestation-v1`; the device domain is
`kogg-chatgpt-device-attestation-v1`. The digest boundary is the canonical
payload, not its DSSE envelope. The manifest binds both digests, and runtime
also verifies each envelope and that its decoded payload reproduces the bound
digest.

Sign each canonical payload with a detached DSSE v1 envelope. The payload types
are `application/vnd.kogg.chatgpt-enablement.v1+json`,
`application/vnd.kogg.chatgpt-browser-probe.v1+json`, and
`application/vnd.kogg.chatgpt-device-probe.v1+json`. Use the exact DSSE v1
pre-authentication framing `DSSEv1 SP len(type) SP type SP len(payload) SP
payload`, where lengths count bytes in decimal. Sign with Ed25519 per RFC 8032,
encode both DSSE payloads and signatures as canonical padded base64, and reject
undeclared envelope fields. Require exactly one allowed signature for the
payload's signing role. Identify a key by the lowercase SHA-256 digest of
its DER SubjectPublicKeyInfo. Times are RFC 3339 UTC to seconds, with at most
300 seconds of clock skew and 2592000 seconds of validity. Protected-probe and
release-enablement keys have distinct roles.

The machine profile includes a public verification vector derived from
[RFC 8032 section 7.1](https://www.rfc-editor.org/rfc/rfc8032.html#section-7.1)
so implementations can validate the pinned Ed25519 verification contract
without a private key.

Browser and device attestations are distinct and bind the exact Candidate
Payload and profile digests, a verifier-issued nonce, successful mode, protected
workflow/repository identity, and successful secret-scan, cleanup, and
tool-isolation results. The enablement manifest binds both attestation digests.
Trust roots are distributed through an authenticated base release,
operating-system package, or equivalent external provenance. A key inside the
Candidate Payload or detached envelope is never a trust root.

At startup and immediately before the first subscription request, runtime must
verify signature, allowed key, manifest expiry/generation, repository and
workflow identity, both distinct successful login modes, and exact payload and
profile digests. Missing, stale, swapped, mismatched, untrusted, or rebuilt
artifacts keep the feature hidden. There is no API-key or API-billing fallback.

Signature key custody, rotation/revocation, manifest lifetime, generation
rollback persistence, protected environment names, and authoritative builder
and workflow identities are **UNRESOLVED — fail closed**.

## Machine-profile field mapping

The machine-readable profile is a JCS-compatible closed JSON object with no
self-digest. Official-source fields contain immutable GitHub permalinks and
line ranges; Kogg-only policy gaps may instead refer to their profile path.
Facts are explicitly classified as `source_observation`,
`kogg_normative_policy`, or `unresolved_gap`; every network contract is
currently `blocked`.

| Machine path                           | Required content                                                                               | Current status                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `schemaVersion`                        | Kogg profile schema ID                                                                         | pinned by Kogg policy                                                    |
| `state`                                | `blocked` unless every required contract is pinned and attested                                | pinned by Kogg policy                                                    |
| `observedSource`                       | repository, full commit SHA, commit time, research date                                        | pinned                                                                   |
| `contracts.auth.browser.*`             | authorize, callback, token-exchange fields and bounds                                          | partially pinned; client identity/ports are **UNRESOLVED — fail closed** |
| `contracts.auth.device.*`              | user-code, poll, exchange paths, bodies, states, interval and bounds                           | terminal semantics and identity are **UNRESOLVED — fail closed**         |
| `contracts.auth.refresh`               | body, rotation/CAS rules, error taxonomy and bounds                                            | unknown server-error taxonomy is **UNRESOLVED — fail closed**            |
| `contracts.auth.revoke`                | token preference/body/timeout/local-delete rule                                                | client identity and recovery UX are **UNRESOLVED — fail closed**         |
| `unresolvedContracts.SECURE_STORAGE`   | permitted secure backend and no-fallback policy                                                | backend contract is **UNRESOLVED — fail closed**                         |
| `contracts.identity.jwt_claims`        | observed claim extraction and required cryptographic identity validation                       | **UNRESOLVED — fail closed**                                             |
| `contracts.limits.token_usage_profile` | `/wham/profiles/me` token-usage stats and bounds                                               | authorization and complete schema are **UNRESOLVED — fail closed**       |
| `contracts.entitlement.account_check`  | affirmative subscription entitlement proof distinct from quota                                 | **UNRESOLVED — fail closed**                                             |
| `transportPolicy`                      | base URL, allowed hosts, redirects, auth/account headers, Kogg originator                      | originator/authorized headers are **UNRESOLVED — fail closed**           |
| `contracts.models.catalog`             | endpoint/query/ETag/schema/cache binding/raw preservation/bounds                               | authorization and complete schema are **UNRESOLVED — fail closed**       |
| `contracts.limits.usage`               | endpoint/header families/schema, entitlement distinction, raw preservation/bounds              | authorization and complete schema are **UNRESOLVED — fail closed**       |
| `contracts.responses.sse`              | exact request fields plus event grammar, terminal rules and bounds                             | headers and complete grammar are **UNRESOLVED — fail closed**            |
| `contracts.compaction.*`               | endpoint/request/output transaction/raw preservation/bounds                                    | **UNRESOLVED — fail closed**                                             |
| `unknownResponsePolicy`                | endpoint/path-specific actionable classification and preservation                              | classification is **UNRESOLVED — fail closed**                           |
| `contextBudget`                        | model window, tokenizer/version, full serialized inputs, output allowance, safety margin       | **UNRESOLVED — fail closed**                                             |
| `resourceProfiles`                     | per-endpoint headers/body/depth/count/idle/total ceilings and failure action                   | proposed only; real compatibility is **UNRESOLVED — fail closed**        |
| `releaseIdentity`                      | JCS digest rules, Candidate Payload membership, DSSE/Ed25519 manifest and attestation subjects | operational trust identities are **UNRESOLVED — fail closed**            |
| `unresolvedContracts`                  | stable IDs and the literal disposition `UNRESOLVED — fail closed`                              | required and nonempty in this profile                                    |

## Unresolved-contract register

The machine profile carries this list by stable IDs with
the same literal disposition:

1. `AUTH_CLIENT_REGISTRATION` — third-party client ID, originator, callback
   ports, and query-field authorization: **UNRESOLVED — fail closed**.
2. `DEVICE_TERMINAL_SEMANTICS` — denial, expiry, slowdown, polling bounds, and
   success/error schemas: **UNRESOLVED — fail closed**.
3. `TOKEN_VALIDATION` — issuer, audience, signature/JWKS, rotation, and clock
   policy: **UNRESOLVED — fail closed**.
4. `AFFIRMATIVE_ENTITLEMENT` — authoritative subscription entitlement proof
   distinct from identity and limits: **UNRESOLVED — fail closed**.
5. `SECURE_STORAGE` — approved store, recovery, migration, and rotation
   transaction: **UNRESOLVED — fail closed**.
6. `PRIVATE_ENDPOINT_AUTHORIZATION` — permitted ChatGPT endpoint set and exact
   request headers for Kogg: **UNRESOLVED — fail closed**.
7. `MODELS_SCHEMA` — complete authoritative schema, account binding, expiry,
   and drift rules: **UNRESOLVED — fail closed**.
8. `LIMITS_SCHEMA` — complete usage/limit schema and entitlement-versus-quota
   semantics: **UNRESOLVED — fail closed**.
9. `RESPONSES_PROTOCOL` — request compression, retry/idempotency, complete SSE
   grammar/state machine, and terminal/error behavior:
   **UNRESOLVED — fail closed**.
10. `COMPACTION_PROTOCOL` — authorization, complete item schema, preservation,
    accounting, and atomic history replacement: **UNRESOLVED — fail closed**.
11. `ACTIONABILITY_CLASSIFICATION` — safe unknown fields and variants for every
    endpoint: **UNRESOLVED — fail closed**.
12. `RESOURCE_CEILINGS` — protected-probe validation of all proposed limits and
    endpoint exceptions: **UNRESOLVED — fail closed**.
13. `CONTEXT_ACCOUNTING` — exact tokenizer/version, all serialized inputs,
    output allowance, safety margin, and upper-bound proof:
    **UNRESOLVED — fail closed**.
14. `RELEASE_TRUST` — signing custody/rotation/revocation, trusted workflow and
    builder identities, expiry, and rollback protection:
    **UNRESOLVED — fail closed**.

## Readiness rule

The profile is executable only when its unresolved register is empty, its
machine representation and Candidate Payload match the signed protected-probe
subjects, both browser and device probes pass against the same immutable
digests, and runtime independently verifies the detached manifest. At this
revision the register is not empty. Therefore the only conforming behavior is:

```text
UNRESOLVED — fail closed
```

Completing #24 does not enable downstream issue #25. Downstream work must read
the machine profile's capability state, not infer enablement from issue closure.
