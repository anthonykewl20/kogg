# Supported OpenAI Codex authentication contract

- **Date:** 2026-07-14
- **Issue:** [#4 — Define the supported OpenAI browser and device authentication contract](https://github.com/anthonykewl20/kogg/issues/4)
- **Related decision:** [OpenAI Codex subscription integration boundary](./openai-codex-subscription-integration-boundary.md)
- **Source policy:** First-party OpenAI documentation and the public `openai/codex` repository only
- **Source snapshot:** `openai/codex` commit [`4aa950d456c6c90174d3269d7eaab4a2823e5889`](https://github.com/openai/codex/tree/4aa950d456c6c90174d3269d7eaab4a2823e5889)

## Decision

**No-go for a Qwen-owned OAuth client or a direct ChatGPT subscription-token model provider. Constrained-go for a product client that drives the official Codex App Server's managed ChatGPT authentication API and lets Codex own the complete credential and inference lifecycle.**

The [App Server authentication contract](https://learn.chatgpt.com/docs/app-server#auth-endpoints) explicitly says managed ChatGPT mode owns OAuth, token persistence, and automatic refresh. Its stable client surface is a small JSON-RPC state machine: inspect account state, start a browser or device-code login, wait for correlated notifications, cancel a pending login, and log out. The product receives no managed access, refresh, or ID tokens.

This is narrower than the provider in issue #1. The public sources still do not publish third-party ChatGPT OAuth client registration or a direct subscription-inference service contract. Source-visible client IDs, endpoints, scopes, PKCE details, and token payloads explain the official runtime; they do not authorize another product to reproduce it. The earlier [boundary report](./openai-codex-subscription-integration-boundary.md) remains controlling on that point.

## Required architecture

The supported product boundary is:

```text
Qwen UI -> local Codex App Server (stable stdio JSON-RPC) -> OpenAI auth and Codex services
```

Qwen may own presentation and process supervision. Codex must own authorization requests, callback handling, PKCE and state verification, device polling, token exchange, credential storage, refresh and rotation, revocation attempts, workspace enforcement, and authenticated inference.

That boundary conflicts with the current ADR and issue #1 constraints that prohibit invoking Codex and require independent authentication. Unless those constraints are changed or OpenAI gives written authorization for a separate contract, there is nothing supportable to implement as a native Qwen model provider.

## Stable App Server client contract

Use a released, pinned Codex runtime, stable stdio transport, version-matched generated schemas, and `experimentalApi: false` or no experimental capability. App Server schemas are runtime-version-specific, so the examples below define the integration shape, not permission to ignore schema changes.

### 1. Read account state

After the normal App Server initialization handshake, send:

```json
{ "method": "account/read", "id": 1, "params": { "refreshToken": false } }
```

Treat `account: null` as signed out. For managed ChatGPT auth, the documented account object exposes only `type: "chatgpt"`, nullable `email`, and `planType`; `requiresOpenaiAuth` says whether the selected provider requires OpenAI authentication. The `account/updated` notification exposes only `authMode` and nullable `planType`. Do not expect tokens, token expiry, a workspace ID, or a workspace list.

The client may set `refreshToken: true` to request a managed refresh before reading. This is a trigger, not a token API or a reliable refresh-result signal; the response does not expose refreshed credentials or a refresh error taxonomy.

### 2. Browser-callback login

Start the documented managed flow:

```json
{
  "method": "account/login/start",
  "id": 2,
  "params": { "type": "chatgpt" }
}
```

The response has this shape:

```json
{
  "id": 2,
  "result": {
    "type": "chatgpt",
    "loginId": "<uuid>",
    "authUrl": "<opaque URL>"
  }
}
```

The client must:

1. retain `loginId` only for the pending attempt;
2. open `authUrl` verbatim in the user's browser without parsing, rebuilding, or logging it;
3. leave the localhost callback listener to App Server; and
4. wait for `account/login/completed` with the same `loginId`, then consume `account/updated` or re-read `account/read`.

On success, the expected notifications are:

```json
{
  "method": "account/login/completed",
  "params": { "loginId": "<uuid>", "success": true, "error": null }
}
{
  "method": "account/updated",
  "params": { "authMode": "chatgpt", "planType": "plus" }
}
```

`useHostedLoginSuccessPage` and `appBrand` are documented optional presentation controls. They do not transfer callback or token ownership to the client. Default to the smallest request above unless the product specifically needs the hosted completion page.

### 3. Device-code login

Start the documented App Server method:

```json
{
  "method": "account/login/start",
  "id": 3,
  "params": { "type": "chatgptDeviceCode" }
}
```

The response has this shape:

```json
{
  "id": 3,
  "result": {
    "type": "chatgptDeviceCode",
    "loginId": "<uuid>",
    "verificationUrl": "<opaque URL>",
    "userCode": "<one-time code>"
  }
}
```

Show the URL and one-time code, warn the user to continue only if they initiated the login, retain `loginId`, and wait for the same completion and account-update notifications as browser login. The frontend owns this ceremony, but App Server owns requesting the device code, polling, exchanging the resulting authorization code, checking workspace policy, and persisting tokens. There is no client polling RPC.

The method is not marked experimental in the App Server protocol, but [device-code authentication is beta and enablement-dependent](https://learn.chatgpt.com/docs/auth#preferred-device-code-authentication-beta). A personal user must enable it in ChatGPT security settings; a workspace admin must enable it in workspace permissions. A client must offer browser login as the default/fallback and explain when device login is unavailable.

### 4. Cancellation

Cancel either pending managed flow with its `loginId`:

```json
{
  "method": "account/login/cancel",
  "id": 4,
  "params": { "loginId": "<uuid>" }
}
```

The pinned protocol returns `status: "canceled"` or `status: "notFound"`, and the active attempt completes unsuccessfully. Treat `notFound` as an idempotent terminal result: the attempt may already have completed, timed out, been replaced, or been canceled. Correlate all completion notifications by `loginId`; do not assume response/notification ordering.

Cancel explicitly when the user closes the login UI or when the product shuts down App Server. Do not leave a device poll or callback listener running invisibly.

### 5. Logout

Send:

```json
{ "method": "account/logout", "id": 5 }
```

After the empty success response, expect:

```json
{
  "method": "account/updated",
  "params": { "authMode": null, "planType": null }
}
```

Logout also cancels an active login. Treat the successful method response plus the signed-out account state as the contract. Do not call source-observed revocation endpoints directly and do not promise that logout ended every browser session: the current implementation attempts OAuth token revocation on a best-effort basis and removes local credentials even if remote revocation fails.

## Lifecycle requirements

| Concern              | Supported client behavior                                                                                                                                                | What remains inside Codex                                                                                                                                | Stability                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Authorization        | Open the returned browser `authUrl`, or show the returned device verification URL and code.                                                                              | Construct authorization requests and choose registered redirect URIs/scopes/client identity.                                                             | App Server methods stable; URL contents opaque.                                                            |
| PKCE and state       | Never generate, persist, parse, or validate them. Treat `authUrl` as sensitive.                                                                                          | Generate S256 PKCE and random state, retain the verifier, and reject mismatched callbacks.                                                               | Implementation detail, not a Qwen contract.                                                                |
| Token exchange       | Never call the authorization-code, device, refresh, or token-exchange endpoints.                                                                                         | Exchange codes, validate results, and persist credentials.                                                                                               | Implementation detail.                                                                                     |
| Workspace selection  | Let the browser/account flow select the workspace. If administrators provide a known workspace ID, honor Codex's documented `forced_chatgpt_workspace_id` configuration. | Include organizations in login, enforce allowed workspace IDs against token claims, and apply workspace policy.                                          | Forced-workspace setting stable; enumeration/switching is not exposed by stable auth RPCs.                 |
| Account metadata     | Display nullable `email`, `planType`, and `authMode`; tolerate unknown future plan values.                                                                               | Derive metadata from managed credentials and provider state.                                                                                             | Stable fields; no stable workspace/account ID field.                                                       |
| Refresh and rotation | Normally do nothing. Optionally request `account/read` with `refreshToken: true`; on permanent auth failure, offer a new managed login.                                  | Refresh automatically before expiry, serialize refreshes, rotate returned access/ID/refresh tokens, and persist through the configured credential store. | Ownership stable; timing/error codes are implementation details.                                           |
| Expiry               | Do not schedule from JWTs or expose a guessed expiry timer.                                                                                                              | Inspect token expiry and decide when refresh is needed.                                                                                                  | No App Server expiry field.                                                                                |
| Revocation           | Call `account/logout`; verify signed-out state.                                                                                                                          | Attempt remote revoke and clear every configured local auth store.                                                                                       | Logout stable; exact revoke endpoint and best-effort policy are implementation details.                    |
| Cancellation         | Call `account/login/cancel` with the active `loginId`; make dismissal idempotent.                                                                                        | Stop callback handling or device polling and emit terminal completion.                                                                                   | Stable method; exact timeout values are implementation details.                                            |
| Polling              | Wait for notifications; never poll OpenAI device endpoints.                                                                                                              | Poll at the server-provided interval and enforce its deadline.                                                                                           | Device auth beta; interval/deadline implementation details.                                                |
| Proxy                | Give the Codex process the host's approved network environment; do not add a Qwen-specific proxy field to the auth RPC.                                                  | Build the auth HTTP client and route its requests.                                                                                                       | No documented App Server login proxy field; current environment/system-proxy behavior is runtime-specific. |
| Custom CA            | Set `CODEX_CA_CERTIFICATE` to a PEM bundle before starting App Server; `SSL_CERT_FILE` is the documented fallback.                                                       | Apply that trust bundle to login, normal HTTPS, and secure WebSocket clients.                                                                            | Documented Codex contract.                                                                                 |
| Errors               | Map operation and terminal state to safe product messages; retain only a redacted diagnostic for support.                                                                | Produce JSON-RPC errors and a nullable completion `error` string.                                                                                        | No stable structured login-error taxonomy.                                                                 |

### Workspace limitations

The browser controls ordinary workspace choice. Codex then applies ChatGPT membership, provisioning, roles, RBAC, entitlements, and any managed login restrictions. [`forced_chatgpt_workspace_id`](https://learn.chatgpt.com/docs/auth#enforce-a-login-method-or-workspace) can restrict login to a known workspace; mismatched credentials cause Codex to log out and exit.

Stable `account/read` does not return the selected workspace ID or enumerate available workspaces. Types visible in the source tree for richer account-session metadata do not establish a documented, implemented App Server method in the pinned snapshot. Therefore a Qwen UI must not promise an in-app workspace picker or parse managed JWTs to invent one. If that capability becomes required, it needs a separately documented stable App Server API or written OpenAI contract.

### Refresh, expiry, rotation, and revocation

The public [login-caching contract](https://learn.chatgpt.com/docs/auth#login-caching) says Codex refreshes managed ChatGPT tokens automatically before they expire. The pinned implementation currently refreshes near the access-token expiry, serializes refresh attempts, accepts rotated ID/access/refresh tokens, and classifies expired, reused, or invalidated refresh tokens. Its five-minute refresh window, eight-day fallback, backend codes, endpoints, and request bodies are not stable client API and must not be copied.

The client receives no refresh token, expiry, or rotation event. It should model only `signedOut`, `loginPending(loginId)`, and `signedIn(account)` plus a terminal error. An authenticated request that ultimately fails authorization should lead to safe reauthentication guidance, not direct token repair.

On logout, the pinned runtime prefers revoking the refresh token, falls back to an access token if necessary, limits the revoke attempt, and removes local state even when revocation fails. This is useful implementation evidence, not a promise that Qwen may call `/oauth/revoke` or a guarantee that a remote session was invalidated.

### Proxy and custom-CA behavior

OpenAI explicitly documents [`CODEX_CA_CERTIFICATE`](https://learn.chatgpt.com/docs/auth#custom-ca-bundles), with `SSL_CERT_FILE` as fallback, for corporate TLS interception or private roots. Set the variable on the App Server process before login and do not read or transmit the PEM contents through JSON-RPC.

The App Server auth API has no proxy parameter. The pinned implementation's default HTTP stack preserves its transport's proxy behavior, while a richer system/PAC resolver is marked under development. Consequently, proxy variables, PAC/WPAD resolution, platform discovery, retry behavior, and proxy-auth errors must be validated against the pinned Codex release and treated as runtime deployment behavior, not a Qwen-owned OAuth contract. Never log proxy URLs because they may embed credentials.

### Sanitized error contract

The documented terminal notification is only:

```json
{
  "method": "account/login/completed",
  "params": {
    "loginId": "<uuid>",
    "success": false,
    "error": "<unstable text or null>"
  }
}
```

There is no documented stable enum for cancellation, timeout, entitlement, workspace denial, transport, TLS, proxy, token-exchange, persistence, or refresh failure. Do not branch on exact English text. Classify only from the operation and documented structured fields, then show a generic action such as retry, use browser login, check workspace permission, check network/CA settings, or sign in again.

Before display, logging, telemetry, or issue attachment, redact:

- access, refresh, ID, API, and device tokens;
- authorization codes, PKCE verifiers/challenges, state, and one-time user codes;
- `authUrl` and every URL query, fragment, username, password, or embedded proxy credential;
- raw request/response bodies and credential-store contents; and
- account/workspace identifiers unless the user explicitly opts into a support bundle that requires them.

Cap diagnostic length and render it as plain text. The pinned browser implementation redacts sensitive URL components in structured logs and HTML-escapes browser error pages, but intentionally preserves some backend text in user-facing errors; App Server can forward those strings in its completion notification. Qwen therefore needs its own final-boundary redaction even when Codex also sanitizes internal logs.

## Public source evidence, not client API

The pinned source confirms why App Server must remain the owner:

- Browser login [generates PKCE and random state and builds a localhost callback](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/server.rs#L150-L175); the callback [rejects a state mismatch before exchanging a code](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/server.rs#L309-L405). PKCE itself uses a random verifier and S256 challenge ([`pkce.rs`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/pkce.rs#L12-L26)).
- The authorization URL currently contains source-defined scopes and workspace hints ([`server.rs`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/server.rs#L553-L595)); the code exchange posts the verifier and stores returned credentials ([`server.rs`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/server.rs#L778-L903)).
- Device login [requests a server-defined code and interval and polls internally](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/device_code_auth.rs#L62-L147), then [performs PKCE-backed exchange, workspace enforcement, and persistence](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/device_code_auth.rs#L165-L232).
- Managed refresh [persists each returned rotation and maps authority failures](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/auth/manager.rs#L1306-L1443); its proactive timing is explicitly visible in source ([`manager.rs`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/auth/manager.rs#L2506-L2528)) but is not a public protocol field.
- Logout [attempts best-effort token revocation while preserving local removal](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/auth/revoke.rs#L1-L75).
- App Server owns browser and device tasks, correlation, timeout/cancellation, completion notifications, and logout ([`account_processor.rs`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server/src/request_processors/account_processor.rs#L424-L608), [`account_processor.rs`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server/src/request_processors/account_processor.rs#L685-L810)).
- The login implementation [redacts sensitive URL keys and credentials from structured logs](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/server.rs#L694-L775), while preserving selected backend detail for its user-facing path.

Exact endpoints, client IDs, redirect ports, scopes, claims, polling intervals, timeout values, token bodies, and error strings in these files are deliberately **not** part of the Qwen contract. Pinning the snapshot makes the research reproducible; it does not make those internals stable.

## Experimental external-token mode

`chatgptAuthTokens` is not a shortcut around managed authentication. The [App Server documentation](https://learn.chatgpt.com/docs/app-server#auth-endpoints) marks it experimental and requires `experimentalApi`. The pinned protocol is stronger: it labels the method unstable, for OpenAI internal use only, and requires a host that already owns a correctly scoped ChatGPT access-token lifecycle ([`account.rs`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L64-L107)).

Its server-initiated refresh request after a `401` does not provide OAuth registration, authorization, refresh-token rotation, revocation, or a subscription-inference service contract. It merely bridges tokens already managed by an authorized host. Qwen must not enable it, copy tokens from Codex files, parse browser sessions, or use it to justify an independent provider.

## Acceptance boundary for implementation

An implementation may proceed only if issue #1 is redrawn to allow the official Codex runtime and all of these conditions hold:

1. Qwen talks only to a pinned App Server over stable stdio JSON-RPC.
2. Browser and device UIs use only returned opaque values and correlated notifications.
3. Qwen never receives, stores, logs, refreshes, revokes, or forwards managed ChatGPT tokens.
4. Codex remains the inference owner; Qwen does not replay source-observed ChatGPT backend requests.
5. Workspace enforcement and entitlements remain authoritative, with no workspace-picker claim beyond the stable API.
6. Device login is labeled beta, enablement-dependent, cancelable, and secondary to browser login.
7. Custom CA configuration is passed to the Codex process, and proxy behavior is release-tested rather than invented at the RPC layer.
8. All errors cross a Qwen redaction boundary before display or persistence.
9. Experimental methods and fields, including `chatgptAuthTokens`, remain disabled.

If invoking Codex remains out of scope, or if Qwen must own OAuth or call a model endpoint directly with subscription tokens, the result is **no-go** until OpenAI supplies written authorization, third-party client registration, approved redirects/scopes, a documented token lifecycle, and a supported subscription-inference API.

## Sources reviewed

- [Codex App Server — auth endpoints](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
- [Authentication](https://learn.chatgpt.com/docs/auth)
- [Authentication — login caching](https://learn.chatgpt.com/docs/auth#login-caching)
- [Authentication — enforce a login method or workspace](https://learn.chatgpt.com/docs/auth#enforce-a-login-method-or-workspace)
- [Authentication — device code authentication (beta)](https://learn.chatgpt.com/docs/auth#preferred-device-code-authentication-beta)
- [Authentication — custom CA bundles](https://learn.chatgpt.com/docs/auth#custom-ca-bundles)
- [`openai/codex` source snapshot](https://github.com/openai/codex/tree/4aa950d456c6c90174d3269d7eaab4a2823e5889)

No credentials, browser sessions, account identifiers, private workspace data, or live authenticated traffic were inspected.
