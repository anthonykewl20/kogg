# OpenAI Codex subscription integration boundary

- **Date:** 2026-07-14
- **Issue:** [#2 — Establish the supported public ChatGPT subscription integration boundary](https://github.com/anthonykewl20/kogg/issues/2)
- **Related map:** [#1 — First-class OpenAI Codex subscription provider](https://github.com/anthonykewl20/kogg/issues/1)
- **Source policy:** First-party OpenAI documentation, published OpenAI terms and policies, and the public `openai/codex` repository only
- **Source snapshot:** `openai/codex` commit [`4aa950d456c6c90174d3269d7eaab4a2823e5889`](https://github.com/openai/codex/tree/4aa950d456c6c90174d3269d7eaab4a2823e5889)

## Decision

**No-go for the provider currently described by the Wayfinder map and ADR. Constrained-go for a redesigned client that uses the official Codex App Server for product-managed subscription login and agent operation; the Codex SDK and MCP server are additional constrained-go composition seams, not independent subscription-login seams.**

OpenAI now documents a public integration boundary for third-party products: the [Codex App Server is explicitly for embedding Codex into a product](https://learn.chatgpt.com/docs/app-server), the [Codex SDK is explicitly for integrating local Codex agents into an application](https://learn.chatgpt.com/docs/codex-sdk), and [Codex can run as an MCP server for other MCP clients](https://learn.chatgpt.com/docs/mcp-server). App Server is the documented product-managed authentication seam: it exposes a stable browser sign-in method in which **Codex owns OAuth, token persistence, refresh, and inference**. Its device-code method is not marked experimental at the protocol level, but OpenAI labels device-code authentication itself beta and requires personal-account or workspace enablement. The SDK and MCP server are documented agent and inference composition seams that generally consume existing official Codex authentication state; a product that needs to initiate and manage subscription login must pair them with App Server or separately establish authentication through an official Codex surface.

The published sources do **not** establish a public boundary for a third-party CLI to act as an independent ChatGPT OAuth client and then call Codex's ChatGPT-backed inference transport directly. The source tree reveals OpenAI's default OAuth client ID, an implementation override, callback details, scopes, and backend behavior, but no official document grants third parties the right to reuse that client identity or registers a separate client for direct subscription-backed inference.

That distinction conflicts with the project's standing constraints. [ADR 0001](../adr/0001-codex-is-a-model-provider.md) requires Qwen Code to authenticate independently and forbids invoking Codex or sharing its credential files; issue #1 also makes embedding, invoking, or reproducing the official Codex runtime out of scope. Those constraints remove all currently documented agent-runtime subscription-integration seams.

This is a product/supportability assessment, not legal advice. Applicable customer agreements and jurisdiction-specific terms can differ; written OpenAI authorization can change the conclusion.

## Boundary at a glance

| Proposed boundary                                                                                                                       | Result               | Why                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local third-party UI/CLI controlling `codex app-server` over stable stdio JSON-RPC                                                      | **Constrained-go**   | OpenAI documents App Server for deep integration into a product, including authentication and streamed agent events.                                                                            |
| Application using the published Codex SDK and its bundled/pinned runtime                                                                | **Constrained-go**   | OpenAI documents the SDK for application integration and local agent control, but not as an independent embedded subscription-login lifecycle; it generally consumes official Codex auth state. |
| MCP client invoking the documented `codex mcp-server` runtime                                                                           | **Constrained-go**   | OpenAI documents Codex as an MCP server for other clients, but it is an agent-runtime composition seam that generally consumes official Codex auth state, not a subscription-login seam.        |
| Qwen Code implements browser/device OAuth itself, stores its own ChatGPT tokens, and calls the ChatGPT Codex inference backend directly | **No-go**            | No public OAuth client-registration procedure or direct subscription-inference service contract was found. This would depend on implementation details outside the documented integration seam. |
| Hosted or multi-tenant service exposing one person's authenticated ChatGPT account or Codex runtime to others                           | **No-go**            | OpenAI's terms prohibit credential sharing/account availability and resale or lease of account access; another hosted arrangement requires a documented service boundary or written agreement.  |
| Trusted Business/Enterprise automation using a user-created Codex access token through CLI/App Server                                   | **Constrained-go**   | Officially supported only for trusted local/private automation, with workspace permission and identity constraints.                                                                             |
| OpenAI Platform API integration using API keys                                                                                          | **Go, but separate** | The business agreement expressly supports Customer Applications through the API; it is usage-billed API access, not ChatGPT subscription access.                                                |

## Stable public contracts

### 1. Subscription authentication is supported through Codex clients

The official [Authentication documentation](https://learn.chatgpt.com/docs/auth) defines two OpenAI sign-in modes: ChatGPT for subscription access and API keys for usage-based access. It names the ChatGPT desktop app, Codex CLI, and IDE extension as supported local surfaces. ChatGPT-authenticated use inherits workspace permissions, RBAC, retention, and residency policy; API-key use instead follows the API organization.

The App Server contract broadens the supported client boundary. Its [auth/account API](https://learn.chatgpt.com/docs/app-server#auth-endpoints) states that:

- `chatgpt` is a managed mode in which Codex owns OAuth, persistence, and refresh;
- `account/login/start` supports the stable local browser-callback path;
- `chatgptDeviceCode` lets the frontend present the verification URL and one-time code and is not marked as an experimental App Server method;
- account state, plan type, rate limits, logout, and completion notifications are surfaced through documented JSON-RPC messages.

This is enough for a custom terminal UI to present sign-in without receiving a password or implementing the token exchange itself. The product should treat the App Server as the credential and inference owner.

The broader [Authentication documentation](https://learn.chatgpt.com/docs/auth#login-on-headless-devices) nevertheless labels device-code authentication **beta**. Users must enable it in personal ChatGPT security settings, or a workspace admin must enable it in workspace permissions. A client therefore cannot assume device code is available. It needs a browser-callback path and clear fallback guidance for remote/headless use, such as supported callback forwarding. OpenAI also documents copying the auth cache as a sensitive fallback, but that conflicts with this project's decision not to share credential files and should not be built into this integration.

The App Server also documents `chatgptAuthTokens`, where a host supplies its own ChatGPT tokens, but marks it **experimental** and requires `experimentalApi`. It is not a durable basis for this public provider.

### 2. App Server, SDK, and MCP are the documented integration seams

The [App Server page](https://learn.chatgpt.com/docs/app-server) says to use App Server for a deep integration inside a product covering authentication, history, approvals, and streamed events. It distinguishes a stable API from experimental capabilities and provides schema generation tied to the exact Codex version.

The [Codex SDK page](https://learn.chatgpt.com/docs/codex-sdk) says it can integrate Codex into an application. The TypeScript package controls Codex by spawning the CLI; the Python SDK controls local App Server over JSON-RPC, and published Python builds bundle a pinned Codex runtime. As of this report, the Python SDK is beta, which reduces its support guarantee relative to a stable release. The SDK is documented as an agent/inference composition API, not as a self-contained embedded subscription-login lifecycle; it generally uses authentication already established by an official Codex surface.

OpenAI also documents [`codex mcp-server`](https://learn.chatgpt.com/docs/mcp-server), which exposes tools to start and continue Codex sessions and can be connected from other MCP clients. This is another supported composition route, but it explicitly runs Codex CLI as an agent, keeps Codex conversations alive across calls, and generally consumes authentication already established for that Codex runtime. It does not independently provide an embedded subscription-login lifecycle.

A product that must present or own a subscription-login experience should therefore use App Server's documented authentication API alongside its chosen composition seam, or separately establish authentication through another official Codex surface. SDK or MCP documentation alone does not establish the missing login contract.

App Server, SDK, and MCP are agent-level seams, not a model-provider transport contract. Threads, turns, approvals, tool events, sandbox policy, and session persistence remain Codex concepts. A redesign around any of them must revisit the premise that Qwen Code alone owns orchestration, tools, approvals, and sessions. All three invoke or bundle the official Codex runtime, so all three conflict with ADR 0001 and issue #1's current out-of-scope list; adding MCP does not change the no-go for the requested architecture.

### 3. Stable and unsupported transports are explicitly separated

App Server's default stdio protocol is documented. Its WebSocket transport is [explicitly experimental and unsupported](https://learn.chatgpt.com/docs/app-server#protocol), and non-loopback listeners require additional authentication and TLS precautions. A distributable local CLI should therefore use the stable stdio transport and omit `experimentalApi`.

Generated TypeScript and JSON schemas are [specific to the Codex version that generated them](https://learn.chatgpt.com/docs/app-server#message-schema). A client should pin or bundle a compatible Codex version, generate against that version, and negotiate only stable fields. It should not assume `main` branch source is a versioned service contract.

### 4. Workspace policy remains authoritative

ChatGPT sign-in does not bypass organization policy. The [Authentication documentation](https://learn.chatgpt.com/docs/auth) says workspace membership, provisioning, seats, roles, RBAC, and local permission profiles all affect access. Managed configuration can force ChatGPT versus API login or restrict login to named workspace IDs; mismatched credentials cause Codex to log out and exit.

For Business and Enterprise automation, [Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens) are scoped workspace credentials for CLI and App Server local workflows. OpenAI limits them to trusted scripts, schedulers, and private CI runners; public CI, forked pull requests, and shared machines are called out as leak risks. Token creation and Codex Local access are separately controlled by workspace permissions.

A public CLI must preserve these enforcement paths and report denial as workspace policy, not attempt endpoint, account, workspace-ID, or rate-limit workarounds.

## Client registration and identity

Two different identities must not be conflated.

### App Server client attribution

Every App Server connection sends `clientInfo`. The official [initialization contract](https://learn.chatgpt.com/docs/app-server#initialization) requires `clientInfo.name` to identify the integration in the OpenAI Compliance Logs Platform. It also tells developers of enterprise integrations to contact OpenAI to be added to a known-clients list.

This is a public attribution hook, with an additional registration/contact step for enterprise use. A Qwen client must use a truthful, stable identifier rather than impersonating `codex_vscode` or another first-party client. An integration intended for enterprise use should contact OpenAI to be added to the known-clients list.

### OAuth client registration

No primary source reviewed here publishes a general procedure for registering a third-party ChatGPT/Codex OAuth application, approved redirect URIs, scopes, or a direct subscription-inference audience.

The source implementation contains a [default client ID](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/auth/manager.rs#L1445-L1452) and an implementation override named [`CODEX_APP_SERVER_LOGIN_CLIENT_ID`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/auth/manager.rs#L189-L194). [`server.rs`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/server.rs#L553-L589) constructs OpenAI's authorization URL with Codex scopes and an `originator`; the same file describes its [callback ports](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/login/src/server.rs#L58-L62) as synchronized with an OpenAI allow-list. The override shows that the implementation can select another client ID; it neither documents how a third party registers that ID nor grants authorization to use one. These facts explain how official Codex works. They do not create a third-party registration contract.

The safe rule is therefore:

- let official App Server own its OAuth client selection and token lifecycle; or
- obtain written OpenAI authorization, a registered client identity, approved redirects/scopes, and a documented inference endpoint before implementing independent authentication.

Copying the default client ID, setting the implementation override without an approved registration, identifying Qwen as a first-party originator, replaying source-observed headers, or relying on undocumented ChatGPT backend paths is outside the supportable boundary.

## Terms and service-access constraints

The consumer [Terms of Use](https://openai.com/policies/terms-of-use/) apply to individual ChatGPT services. They prohibit sharing account credentials or making an account available to another person, modifying/copying/selling/distributing the Services, automatically or programmatically extracting data or Output, reverse engineering the Services, and bypassing restrictions, safety measures, or rate limits.

The specific App Server, SDK, and MCP documentation clearly contemplates programmatic use through those product surfaces. That is evidence for the narrow supported seams; it is not a blanket authorization to reproduce the service transport, nor does the SDK or MCP documentation independently authorize an embedded subscription-login lifecycle. App Server is the documented product-managed login seam. An independent direct client has no equivalent published permission and creates unresolved tension with the general restrictions.

For businesses, the [OpenAI Services Agreement](https://openai.com/policies/services-agreement/) expressly allows integration into Customer Applications **through the OpenAI API**. It separately prohibits sharing individual credentials, reselling or leasing account access, extracting data other than as permitted through the Services, reverse engineering, and evading usage limits. The agreement's definition of Customer Application is tied to an OpenAI API integration; it does not by itself turn the source-observed ChatGPT Codex backend into a public API.

Accordingly, a product may let each user authenticate their own eligible account through App Server's documented flow. An SDK- or MCP-based product that needs login must pair its composition seam with App Server or separately establish authentication through an official Codex surface. It must not pool credentials, proxy one subscription to other users, sell access to a subscription, or expose one user's authenticated account or runtime to others. Other hosted operation needs a documented OpenAI service boundary or written agreement covering that deployment; product embedding alone should not be restated as a blanket local-only rule.

## Distribution, licensing, and attribution

The public Codex repository is under [Apache License 2.0](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/LICENSE). That license permits reproduction, modification, and distribution of the covered source and object code, subject to its conditions. **If** the product redistributes Codex or SDK source, objects, or derivatives, the distributor must provide the license, mark modified files, retain applicable notices, and carry the repository's [`NOTICE`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/NOTICE) attribution when required. The TypeScript SDK also declares Apache-2.0 in its [package manifest](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/sdk/typescript/package.json#L1-L18). Merely interoperating with a separately installed Codex runtime does not by itself redistribute the covered work and therefore does not alone trigger the repository's NOTICE obligation.

The code license does not license OpenAI's hosted service, user subscriptions, or trademarks. Apache 2.0 section 6 expressly withholds trademark permission except for reasonable identification of origin.

OpenAI's [Brand Guidelines](https://openai.com/brand/) require truthful, subordinate use of OpenAI marks, prohibit implying partnership, and specifically do not permit model names in app titles. That app-title rule is not a blanket ban on accurate, descriptive Codex feature labels. “Connects to Codex through the official Codex App Server” is proposed factual wording, not pre-approved copy; final naming and placement must follow the current guidelines and must not imply endorsement or that Qwen is an official OpenAI client.

App Server's `clientInfo` is operational attribution, not trademark permission and not OAuth registration.

## Supportability implications

Within the documented seam, supportability is still constrained:

1. **Pin the runtime and protocol.** Use a released Codex binary or SDK dependency, stable stdio JSON-RPC or the documented MCP server as appropriate, version-matched generated schemas, and no experimental fields.
2. **Let Codex own credentials.** Prefer App Server's stable managed browser flow. SDK and MCP clients generally consume existing official Codex auth state; if the product must initiate login, pair that composition seam with App Server or separately establish official Codex authentication. Treat device code as a beta, enablement-dependent fallback and handle its absence. Do not parse, import, export, log, or synchronize `~/.codex/auth.json`; OpenAI says it contains access tokens and must be treated like a password. If an operator follows OpenAI's documented headless cache-copy fallback manually, treat it as a credential transfer, not a product integration contract.
3. **Preserve client attribution.** Send a truthful, stable `clientInfo.name`; if the integration is intended for enterprise use, contact OpenAI for inclusion in the known-clients list.
4. **Honor entitlements and controls.** Treat plan/model availability, workspace selection, RBAC, forced login method/workspace, quota, and denial responses as authoritative.
5. **Keep identities isolated.** Do not expose one user's authenticated account/runtime to other users or operate outside the deployment boundary documented by OpenAI or separately agreed in writing.
6. **Ship applicable notices and neutral branding.** If redistributing covered Codex/SDK code, objects, or derivatives, satisfy Apache license/NOTICE obligations. A separately installed runtime does not alone create that redistribution obligation. Avoid names or UI that imply an OpenAI partnership.
7. **Own integration support.** Open source is provided without warranty; the project must test upgrades and support its wrapper. OpenAI's repository is the official place to report App Server, SDK, and MCP bugs, not a guarantee that implementation internals will remain stable.

## Consequence for issue #1

The current model-only design cannot proceed to implementation on public evidence alone. It requires all three unsupported assumptions:

1. a third party may reuse or independently register the Codex ChatGPT OAuth client;
2. subscription bearer tokens may be used against a stable, public inference API outside the official runtime; and
3. Qwen can reproduce the required request protocol while remaining inside terms, workspace policy, and support commitments.

The source tree can help reproduce behavior, but source availability is not a service contract. No official source reviewed here establishes those assumptions.

Issue #1 should therefore choose one of these routes:

- **Redraw to constrained-go:** remove the “model provider only” and “never invoke/embed Codex runtime” constraints; use App Server when Qwen must present or manage subscription login; optionally compose through the SDK or MCP server after official Codex authentication is established; and revisit ownership of prompts, tools, approvals, sessions, sandboxing, and telemetry.
- **Seek authorization:** pause implementation until OpenAI supplies written permission plus third-party OAuth registration, approved client attribution, documented subscription-inference endpoints/schemas, workspace-policy requirements, and distribution/support terms.
- **Use the Platform API:** keep Qwen's existing OpenAI-compatible provider architecture and use API keys/usage billing. This is supported but does not satisfy ChatGPT subscription access.

Absent one of those changes, the exact provider requested by issue #1 is **no-go**.

## Sources reviewed

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Use Codex as an MCP server](https://learn.chatgpt.com/docs/mcp-server)
- [Authentication](https://learn.chatgpt.com/docs/auth)
- [Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)
- [Open-source Codex components](https://learn.chatgpt.com/docs/open-source)
- [OpenAI Terms of Use, effective 2026-01-01](https://openai.com/policies/terms-of-use/)
- [OpenAI Services Agreement, effective 2026-01-01](https://openai.com/policies/services-agreement/)
- [OpenAI Service Terms, updated 2026-06-12](https://openai.com/policies/service-terms/)
- [OpenAI Brand Guidelines](https://openai.com/brand/)
- [`openai/codex` source snapshot](https://github.com/openai/codex/tree/4aa950d456c6c90174d3269d7eaab4a2823e5889)

No credentials, account identifiers, private workspace data, or live authenticated traffic were inspected for this research.
