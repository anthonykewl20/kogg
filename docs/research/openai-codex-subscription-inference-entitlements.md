# OpenAI Codex subscription inference and entitlement contract

- **Date:** 2026-07-14
- **Issue:** [#5 — Define subscription inference and entitlement-discovery contracts](https://github.com/anthonykewl20/kogg/issues/5)
- **Related map:** [#1 — First-class OpenAI Codex subscription provider](https://github.com/anthonykewl20/kogg/issues/1)
- **Source policy:** First-party OpenAI documentation and the public
  `openai/codex` repository only
- **Source snapshot:** `openai/codex` commit
  [`4aa950d456c6c90174d3269d7eaab4a2823e5889`](https://github.com/openai/codex/tree/4aa950d456c6c90174d3269d7eaab4a2823e5889)

## Decision

**No-go for a Qwen-owned subscription model provider. Constrained-go for a
version-pinned App Server integration that accepts Codex as the agent runtime
and accepts App Server's experimental product maturity.**

The earlier
[integration-boundary report](./openai-codex-subscription-integration-boundary.md)
found no public third-party transport contract for sending model requests with
ChatGPT subscription credentials. The
[authentication-contract report](./openai-codex-authentication-contract.md)
therefore assigns OAuth, token persistence, refresh, and inference to the
official Codex App Server. Nothing in the sources reviewed for this report
creates the missing direct inference contract.

App Server does provide a documented integration contract: an authenticated
client can discover the current model catalog, start or resume Codex threads,
stream turns and items, observe usage and rate limits, and handle structured
errors. That is an **agent-runtime** contract. Codex owns the upstream request,
conversation history, prompt construction, tool loop, and inference transport
([App Server overview](https://learn.chatgpt.com/docs/app-server)). It conflicts
with [ADR 0001](../adr/0001-codex-is-a-model-provider.md), which requires Qwen's
Agent Runtime to retain those responsibilities.

Consequently, the current OpenAI Codex Provider has **zero provably
Core-compatible Models**. `model/list` discovers currently available App Server
catalog entries, but its documented per-model metadata does not say whether a
model supports streaming text output, multi-turn context, or tool calling. It
also provides no entitlement provenance or execution guarantee. A listed entry
is an App Server model candidate, not evidence of a supported Qwen-owned
provider transport.

## Stability boundary

| Surface                                                                                                                                          | Status                                                                   | Client rule                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Server stdio JSONL, initialization, `model/list`, threads, turns, item events, usage events, account rate limits, and structured turn errors | **Documented, non-gated protocol subset inside an experimental command** | Pin a released Codex runtime, generate its matching schema, and use only fields accepted without `experimentalApi`; do not promise stable product maturity. |
| Device-code authentication                                                                                                                       | **Documented beta product feature**                                      | Covered by the authentication report; it does not change inference ownership.                                                                               |
| WebSocket transport, `dynamicTools`, raw response events, supplied thread history, and paginated thread creation/history                         | **Experimental, unsupported, or not yet implemented**                    | Do not use for a production integration.                                                                                                                    |
| Upstream `/models` and Responses requests, headers, ETags, cache TTLs, prompt-cache keys, retry timing, and internal model fields                | **Pinned-source implementation detail**                                  | Useful only to explain behavior in the pinned snapshot; never reproduce or depend on it.                                                                    |
| Direct ChatGPT subscription inference from a third-party provider                                                                                | **No public contract found**                                             | Do not implement without written OpenAI authorization and a documented service API.                                                                         |

App Server schemas are explicitly specific to the Codex version that generated
them, and its WebSocket transport is experimental and unsupported
([protocol](https://learn.chatgpt.com/docs/app-server#protocol),
[message schema](https://learn.chatgpt.com/docs/app-server#message-schema)).
The official CLI command reference also labels `codex app-server` itself
**experimental**, even though App Server distinguishes documented non-gated
methods from fields explicitly gated by `experimentalApi`
([command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-app-server),
[experimental API opt-in](https://learn.chatgpt.com/docs/app-server#experimental-api-opt-in)).
The conservative pilot boundary is therefore a pinned runtime over the default
stdio transport with `experimentalApi` omitted. It is not a promise of a stable
production surface.

## Contract matrix

| Concern                | Supported App Server contract                                                                                               | Missing direct-provider contract                                                              | Required client behavior                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Catalog authority      | Paginated `model/list` is the supported discovery surface for the active runtime and authentication context.                | No public subscription `/models` API or durable per-model entitlement grant.                  | Replace only from a complete traversal; validate actual use with a completed turn. |
| Capability metadata    | Reasoning efforts, input modalities, personality, picker/default, upgrade, and service-tier metadata.                       | No per-model streaming-text, multi-turn, tool-call, context-window, or output-modality flags. | Gate only optional UI; never infer Core Compatibility.                             |
| Cache                  | App Server owns refresh and caching.                                                                                        | No exposed ETag, age, TTL, revision, or invalidation event.                                   | Scope snapshots to the process/session and refetch conservatively.                 |
| Request transport      | Documented default stdio JSONL with initialization and version-matched schemas; the enclosing command remains experimental. | No public direct ChatGPT subscription inference wire protocol.                                | Send App Server thread/turn RPCs only.                                             |
| Instructions and state | Threads own history; start/resume accept documented non-gated instruction fields; turns append input.                       | No raw provider request that leaves Qwen in sole control of prompt/history composition.       | Reuse the thread id and let Codex own state.                                       |
| Streaming              | Turn/item lifecycle notifications, text deltas, and authoritative completed items.                                          | No direct model SSE/WebSocket subscription contract.                                          | Correlate identifiers, append deltas, and finish on `turn/completed`.              |
| Tool calls             | Codex-owned built-in and MCP tool work is observable; approvals are bidirectional.                                          | Arbitrary host tools use experimental `dynamicTools`.                                         | Do not promise stable Qwen-tool translation.                                       |
| Usage/context          | Per-thread token updates with nullable model context window; separate account activity endpoint.                            | No catalog context limit or direct-provider usage schema.                                     | Treat missing context as unknown and keep account activity separate.               |
| Reasoning/multimodal   | Advertised effort choices, optional reasoning events, and text/image inputs.                                                | No reasoning-output guarantee or multimodal-output metadata.                                  | Treat both as optional and gate image input from catalog metadata.                 |
| Rate limits            | Account snapshot plus sparse rolling updates.                                                                               | No model-specific quota or entitlement inference.                                             | Merge/refetch by bucket; do not classify models from quota state.                  |
| Errors                 | JSON-RPC request errors and typed turn errors with retry state.                                                             | No dedicated stable invalid-entitlement error or direct-provider taxonomy.                    | Branch on structured categories, sanitize text, and refetch after model rejection. |

## Exact supported client contract

### 1. Model catalog and entitlement authority

After App Server-managed ChatGPT authentication, call `model/list` and follow its opaque
`nextCursor` until it is `null`. Use `includeHidden: false`, the default, for a
user-facing picker. The documented entry contains:

- `id`, `model`, `displayName`, and a description;
- `hidden`, `isDefault`, and optional upgrade metadata;
- `supportedReasoningEfforts` and `defaultReasoningEffort`;
- `inputModalities`;
- `supportsPersonality`; and
- service-tier metadata in version-matched schemas.

OpenAI documents `model/list` as the way to discover available models and
their picker capabilities. Hidden entries are excluded by default; setting
`includeHidden: true` asks for the full catalog rather than making those entries
picker-supported
([models](https://learn.chatgpt.com/docs/app-server#list-models-modellist)).
Treat `model` as the returned model selector and retain `id` as catalog
identity; do not derive either from display text.

The pinned implementation obtains a catalog, sorts and filters it for the
current authentication mode, marks a default, then separately removes models
hidden from the picker
([manager](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/models-manager/src/manager.rs#L80-L135),
[App Server conversion](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server/src/models.rs#L13-L60)).
This supports treating a completed `model/list` traversal as the current
supported **discovery snapshot** for the active App Server and Provider
Session. It is not proof of a durable entitlement. The pinned manager can
return cached or bundled in-memory models after a remote refresh failure
([fallback behavior](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/models-manager/src/manager.rs#L230-L266),
[refresh failure behavior](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/models-manager/src/manager.rs#L321-L335)).
Actual turn execution through terminal `turn/completed` remains the operational
authorization check. The catalog does **not** expose a workspace identifier,
entitlement reason, purchase state, or guarantee that a hidden model should be
selectable.

Pagination cursors must remain opaque. The current source happens to implement
them as offsets into a newly built list, with no snapshot token
([pagination](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server/src/request_processors/catalog_processor.rs#L252-L303)).
That is not a stable promise. Do not persist a cursor, combine pages from
different login states, or assume a multi-page traversal is isolated from a
catalog change.

### 2. Capability metadata and filtering

The documented non-gated `Model` schema exposes reasoning choices, input
modalities, personality support, visibility, defaults, upgrades, and service
tiers
([schema source](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/protocol/v2/model.rs#L40-L135)).
It does **not** expose per-model flags for:

- streamed text output;
- multi-turn or stateful operation;
- function, tool, or parallel-tool calling;
- reasoning-summary support;
- output modalities; or
- context-window size.

`modelProvider/capabilities/read` does not fill this gap. It returns only three
provider-level booleans: `namespaceTools`, `imageGeneration`, and `webSearch`
([protocol](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/protocol/v2/model.rs#L26-L38),
[implementation](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server/src/request_processors/config_processor.rs#L159-L169)).
Those describe the active provider's Codex tool facilities, not a selected
model's ability to participate in Qwen's tool loop.

The backend's internal `ModelInfo` currently has additional fields such as
parallel-tool support, context window, and tool configuration, but App Server
deliberately projects only a subset into its public model entry
([internal model](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/protocol/src/openai_models.rs#L366-L450),
[public projection](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/protocol/src/openai_models.rs#L600-L624)).
Reading or reconstructing the omitted fields would depend on private transport
and source internals rather than the integration contract.

### 3. Catalog cache semantics

App Server exposes no catalog ETag, fetch timestamp, freshness duration,
revision, or `model/list` invalidation notification. Therefore:

1. Scope a catalog to one App Server process and active Provider Session.
2. Replace the catalog only after a complete successful pagination traversal.
3. Clear it on login, logout, or `account/updated`; refetch when opening the
   model picker and after a model-selection rejection.
4. Do not assign a durable client TTL or promise immediate entitlement-change
   visibility. Preserve the last complete snapshot only as visibly stale UI if
   a refresh fails.

The pinned runtime currently keeps a five-minute disk cache, refreshes in the
background on a three-minute loop, and uses an upstream ETag to renew or replace
the cache
([cache manager](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/models-manager/src/manager.rs#L213-L243),
[refresh behavior](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/models-manager/src/manager.rs#L321-L480),
[worker](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server/src/models_refresh_worker.rs#L10-L60)).
Those timings and the ETag are source-only details, not a client cache contract.

### 4. Request transport and ownership

The documented default host transport is App Server's bidirectional
JSON-RPC-like protocol over newline-delimited JSON on stdio. Messages omit the
`"jsonrpc":"2.0"` member. A client must send `initialize`, then `initialized`,
before any other request
([protocol](https://learn.chatgpt.com/docs/app-server#protocol),
[initialization](https://learn.chatgpt.com/docs/app-server#initialization)).

The host sends `thread/start`, `thread/resume`, and `turn/start`; it does not
send a Chat Completions or Responses request. In the pinned runtime, Codex
internally constructs streamed Responses requests containing model input,
instructions, tools, reasoning settings, and a prompt-cache key
([request construction](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/core/src/client.rs#L823-L907))
and selects its own HTTP or WebSocket upstream behavior
([HTTP stream](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/core/src/client.rs#L1378-L1465)).
Those upstream URLs, request bodies, headers, compression, fallbacks, and cache
keys are not an App Server client API and must not be copied into Qwen.

### 5. Instructions and multi-turn state

Use one App Server `Thread` as the conversation boundary. `thread/start`
creates it, `turn/start` appends a user request, and `thread/resume` continues
stored history. Do not replay the transcript on every turn. The server owns
history and returns `instructionSources` for instruction files it loaded
([threads](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread),
[turns](https://learn.chatgpt.com/docs/app-server#start-a-turn)).

The documented non-gated protocol accepts optional `baseInstructions` and
`developerInstructions` on thread start and resume
([start schema](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L49-L148),
[resume schema](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L320-L398)).
Normal `turn/start` accepts input and sticky overrides such as model, effort,
personality, working directory, and sandbox policy, but not an ordinary
turn-scoped developer-instructions field
([turn schema](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L66-L161)).

`thread/inject_items` can append raw Responses items to model-visible history,
but it is not needed for normal multi-turn use
([inject items](https://learn.chatgpt.com/docs/app-server#inject-items-into-a-thread)).
It should not be used to imitate a Qwen-owned prompt loop. Codex may combine
host instructions with its own base instructions, repository guidance, tool
instructions, and compaction. App Server therefore cannot preserve ADR 0001's
requirement that Qwen alone own prompts and sessions.

### 6. Streaming and finality

After `turn/start`, keep reading the transport until `turn/completed`.
Correlate every event by thread, turn, and item identifiers. The documented
non-gated event contract includes:

- `turn/started` and terminal `turn/completed` statuses;
- `item/started` and authoritative `item/completed` records;
- `item/agentMessage/delta` for text;
- optional plan and reasoning deltas;
- command and tool progress; and
- `thread/tokenUsage/updated`.

Append deltas in arrival order for presentation, but use `item/completed` as
the final item state. The documentation explicitly warns that a final plan may
not equal its concatenated deltas
([events](https://learn.chatgpt.com/docs/app-server#events),
[items](https://learn.chatgpt.com/docs/app-server#items),
[item deltas](https://learn.chatgpt.com/docs/app-server#item-deltas)).
An interrupted or failed turn is terminal even if partial agent text was
already displayed.

### 7. Tool calls

Documented non-gated App Server items can report Codex-owned command execution,
file changes, MCP tool calls, web search, and other agent work. The host must
answer approval and elicitation requests when its policy requires them, but
Codex chooses and drives the tool loop
([items](https://learn.chatgpt.com/docs/app-server#items),
[approvals](https://learn.chatgpt.com/docs/app-server#approvals)).

The only documented per-thread mechanism for injecting arbitrary
client-executed tools is `dynamicTools`, and both its thread field and
`item/tool/call` flow are **experimental**
([dynamic tools](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental),
[gated field](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L127-L147)).
It cannot be the production seam for Qwen's existing tools. Configuring MCP
servers can give Codex access to tools, but Codex still owns model invocation,
tool selection, history, and continuation.

### 8. Usage and context reporting

`thread/tokenUsage/updated` is the documented non-gated per-thread inference
signal. Its version-matched schema contains `total` and `last` breakdowns with
total, input, cached-input, output, and reasoning-output tokens, plus nullable
`modelContextWindow`
([usage schema](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1369-L1435)).

Treat a missing context window as unknown. Even when present, do not present
`window - totalTokens` as an exact remaining budget: Codex reserves prompt/tool
headroom and can compact history. `model/list` has no context-window field, so
there is no stable pre-turn context-limit catalog.

`account/usage/read` is a separate ChatGPT account activity summary with
nullable lifetime, peak, duration, streak, and daily-bucket values. It is not
per-turn usage and must not be substituted for `thread/tokenUsage/updated`
([account token usage](https://learn.chatgpt.com/docs/app-server#7-token-usage-chatgpt)).

### 9. Optional reasoning and multimodal features

Reasoning is optional. Populate an effort selector only from
`supportedReasoningEfforts`, default it from `defaultReasoningEffort`, and pass
a returned value as `turn/start.effort`. Treat reasoning items and summary/raw
reasoning deltas as optional, because the model catalog does not advertise
summary or raw-reasoning support
([models](https://learn.chatgpt.com/docs/app-server#list-models-modellist),
[reasoning events](https://learn.chatgpt.com/docs/app-server#item-deltas)).

For multimodal input, `turn/start.input` accepts `text`, URL `image`, and local
`localImage` items
([turns](https://learn.chatgpt.com/docs/app-server#turns)). Gate image
attachments on `inputModalities`. Official compatibility guidance says a
missing `inputModalities` field from an older catalog should be treated as
`["text", "image"]`
([models](https://learn.chatgpt.com/docs/app-server#list-models-modellist)).
This metadata covers input only; it does not promise image, audio, or other
multimodal output.

### 10. Rate limits

For ChatGPT-authenticated sessions, `account/rateLimits/read` returns the
current snapshot. Prefer `rateLimitsByLimitId` when present and retain the
backward-compatible `rateLimits` view otherwise. Each bucket can include
primary and secondary windows with `usedPercent`, `windowDurationMins`, and
`resetsAt`, plus plan, credit, and server-classified reached-state metadata
([rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)).

`account/rateLimits/updated` is a sparse rolling notification. Merge available
values into the last read snapshot or refetch; nullable metadata in a sparse
update does not clear a previously observed value
([notification schema](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L513-L536)).
Rate-limit buckets are account/workspace service state. They do not certify a
model capability or reveal per-model entitlement.

### 11. Error shapes and recovery

There are two documented non-gated error layers:

1. A request can return a JSON-RPC error with numeric `code`, textual `message`,
   and optional arbitrary `data` instead of `result`
   ([message schema](https://learn.chatgpt.com/docs/app-server#message-schema),
   [pinned error envelope](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/rpc.rs#L74-L88)).
2. A running turn can emit `error` with `threadId`, `turnId`, `willRetry`, and
   `{ message, codexErrorInfo?, additionalDetails? }`, then finish as failed if
   recovery does not succeed
   ([errors](https://learn.chatgpt.com/docs/app-server#errors),
   [protocol](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/protocol/v2/notification.rs#L38-L48)).

The structured `codexErrorInfo` variants include context-window and usage-limit
failures, authorization, bad request, sandbox and internal failures, upstream
HTTP/stream failures, overload, retry exhaustion, and `other`. Some transport
variants carry a nullable HTTP status
([error enum](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-protocol/src/protocol/v2/shared.rs#L64-L113)).

If `willRetry` is true, keep the turn open and show transient status. Otherwise
use the structured variant for broad recovery, retain the message only as
sanitized diagnostic text, and wait for terminal `turn/completed`. Do not parse
English messages or assume a dedicated invalid-entitlement error: none is
documented. On a model-related bad request, refetch `model/list`, preserve the
user's prompt, and require a new selection if the model is no longer returned.
Apply the redaction boundary defined by the authentication report before
logging `message` or `additionalDetails`.

## Core-compatible Model rule

The repository defines a **Core-compatible Model** as an Entitled Model with
streaming text, multi-turn context, and tool calling. The only supportable
algorithm today is fail closed:

1. **Direct Qwen provider:** return no models. There is no public subscription
   inference transport, so no catalog row can become a supported provider
   model.
2. **Constrained App Server client:** fetch all pages with
   `includeHidden: false`; offer entries whose effective `inputModalities`
   contains `text` as **App Server models**, gate optional
   image/reasoning/personality UI from advertised metadata, and let
   a terminal `turn/completed` outcome validate operation. Do not relabel them
   Core-compatible. Exclude a future image-only entry from a text terminal even
   though its presence still means App Server discovered it.
3. **Future direct provider:** require both a documented subscription inference
   API and authoritative per-model affirmative metadata for streamed text,
   multi-turn state, and tool calls. Missing or unknown capability data means
   filter the model out. Name heuristics, hidden state, reasoning support,
   `namespaceTools`, and a successful App Server turn are insufficient.

This rule may feel stricter than assuming every Codex catalog model works, but
it preserves the domain boundary: App Server discovery and a completed turn
concern the Codex Agent Runtime, while Core Compatibility is a claim about the
Qwen Agent Runtime.

## Acceptance boundary for implementation

Implementation can proceed only along one of these paths:

- **Redesign issue #1 around App Server.** Remove the ADR constraints that
  forbid invoking Codex and require Qwen-owned orchestration. Pin a Codex
  version, use its documented non-gated stdio schemas, treat `model/list` as
  the App Server picker authority, keep all experimental fields disabled, and
  explicitly accept that the `codex app-server` command is still experimental.
- **Keep the current Model Provider architecture.** Pause implementation until
  OpenAI supplies written authorization, a public subscription inference
  endpoint, request/stream/tool/error schemas, cache and entitlement semantics,
  and capability metadata sufficient to evaluate Core Compatibility.
- **Use the OpenAI Platform API instead.** This is a separate API-key,
  usage-billed provider and not ChatGPT subscription inference.

Copying the pinned runtime's upstream `/models` or Responses behavior would not
satisfy the missing contract. The snapshot makes this research reproducible;
it does not turn internal implementation into a supported third-party API.

## Sources reviewed

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [App Server model discovery](https://learn.chatgpt.com/docs/app-server#list-models-modellist)
- [App Server threads and turns](https://learn.chatgpt.com/docs/app-server#threads)
- [App Server events and errors](https://learn.chatgpt.com/docs/app-server#events)
- [App Server rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)
- [`openai/codex` pinned source snapshot](https://github.com/openai/codex/tree/4aa950d456c6c90174d3269d7eaab4a2823e5889)

No credentials, live subscription account, private workspace, undocumented
traffic capture, or non-OpenAI source was used.
