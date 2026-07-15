# ChatGPT Subscription Bundled-CLI E2E Plan

Date: 2026-07-15

## Purpose and authority

The release authority for the Experimental ChatGPT connection is the actual
bundled `kogg` executable driven through a PTY in a disposable home, runtime,
and workspace. It uses the production ChatGPT compatibility HTTP client against
a strict loopback fake service. The test may inject loopback endpoints and
browser/keychain test dependencies, but it must not replace Account,
Credential Custody, Connection Catalog, conversation orchestration, Responses
Conversation, journal, diagnostics, approval, or tool execution modules.

In-memory protocol adapters are allowed only for focused module tests whose
races or hostile inputs cannot be forced reliably through a process and HTTP
boundary. They never count as the bundled user-level proof.

The first gated tracer is deliberately narrow: catalog, login and custody,
identity and readiness with dynamic models, first native Responses prompt,
incident diagnostics, restart-safe execution of one harmless local tool, and
ordinary and destructive logout.

## Blocking test prerequisites

Before this plan can run, the repository must build a minimal package with a
declared `kogg` bin and the actual bundled `kogg` executable. Every acceptance
scenario invokes that artifact. The upstream `qwen` executable and a source-mode
entry point are forbidden substitutes. Broader public rebranding and release
packaging remain later work.

Before production-client or fake-service implementation, a compatibility
investigation must commit a versioned profile appendix and fixture recording the
observed official source revision and exact OAuth issuer, client, callbacks,
scopes, parameters, device endpoints/statuses/timing, backend
routes/headers/query/payload, Responses SSE grammar, models, limits, and native
compaction contract. The test suite consumes that profile rather than embedding
remembered wire behavior.

## Acceptance Fixture

For each scenario the fixture:

- Creates isolated home, runtime, workspace, credential, keychain-test, and
  artifact locations with known ownership and permissions.
- Starts a strict loopback Compatibility Scenario service and configures the
  production compatibility HTTP client through an explicit test-only seam.
- Runs the bundled executable through a real PTY with controlled stdin,
  terminal size, clock, randomness, browser launcher, and process environment.
- Captures user-visible terminal events, stdout, stderr, exit state, process
  tree, safe filesystem manifest, incident IDs, and the fake service's sanitized
  request transcript.
- Supports process restart, two concurrent Kogg processes, callback-port
  occupation, network interruption, crash injection at durable boundaries, and
  child-process cleanup.
- Sanitizes every artifact while capturing it. Raw secrets are never first
  collected and then redacted later.
- Runs an independent secret scan before retaining a failed-run bundle. If any
  credential, cookie, raw identity, prompt, tool payload, authorization query,
  or unapproved content is detected, it deletes the bundle and reports that
  retention was suppressed.
- Deletes successful-run artifacts unless explicitly requested and proven safe.

Product scenarios and assertions remain explicit in tests. The fixture hides
process and environment mechanics, not user behavior behind a large DSL.

## Strict Compatibility Scenario service

The fake is a versioned semantic HTTP service for:

- Browser PKCE authorization, callback, token exchange, refresh, and revoke.
- Device start, pending, slowdown, success, denial, expiry, cancellation, and
  malformed outcomes.
- Validated issuer, audience, account, workspace, plan, entitlement, and
  identity changes.
- Dynamic model catalogs, defaults, capabilities, ETags, TTLs, unchanged
  results, malformed bodies, removal, delay, and outage.
- Limit snapshots, active exhaustion, reset data, unknown groups, malformed
  values, delay, and outage.
- Responses streaming, reasoning, unknown items, local tool requests, result
  continuation, ambiguous sends, connection resets, malformed event sequences,
  and terminal completion.
- Compatibility drift, timing, cancellation, and deterministic fault injection
  before and after every durable boundary.

Every scenario declares its complete expected request sequence. Unexpected
endpoint, host, method, order, required field, undeclared optional request
field, or extra call fails the test. Required fields and permitted optional
fields come only from the versioned Compatibility Profile. Matchers for
generated IDs, PKCE values, and times are profile-declared and explicit.
Unknown response fields are preserved through production parsing and native
persistence. The service has no catch-all success response, no vague
extra-field policy, and never uses captured private traffic.

## Tracer happy paths

### Catalog and disclosure

- First run displays `ChatGPT / Codex subscription` first with the Experimental
  badge and “Sign in with ChatGPT and use your included Codex plan”.
- `OpenAI API` is second and states “Usage billed separately through OpenAI
  Platform.” Existing API-key providers follow without reordering.
- First run, `/auth`, and direct login use the same descriptor data and actions.
- The private-contract disclosure appears exactly once before the first
  production authorization and is not treated as consent to file fallback.
- The option is absent when the feature compatibility/security gate is not
  satisfied.
- Status preserves arbitrary plan and workspace display strings and shows a
  stable masked identifier. It contains no raw account/workspace ID, email,
  subject claim, token, or reversible identity value.
- Selecting ChatGPT while already connected renders status plus Continue,
  Switch account, and Logout. The fake transcript records zero authorization
  requests, and the controlled browser launcher records zero launches.

### Browser and device login

- Selecting ChatGPT offers browser, device, and cancel before either flow
  starts. Browser is recommended and does not launch until selected.
- Browser login validates PKCE, issuer, audience, callback method/path/state,
  one-shot consumption, bounded inputs, identity, workspace, and entitlement.
- Device login handles the displayed code and verification URL, bounded polling,
  slowdown, and successful exchange.
- Browser and device flows each produce the same stable Account Identity Key,
  a fresh Identity Epoch, immutable first Credential Revision, and safe masked
  status for the same service identity.

### Custody, readiness, and first prompt

- A real platform-keychain integration test installs and retrieves the secret
  through the custody module without making it visible to the Kogg home,
  workspace, process environment, output, tool process, or fake transcript.
- Where a platform keychain is deliberately unavailable, the user must
  explicitly accept a symlink-safe owner-only fallback; strict mode refuses it.
- Successful identity, entitlement, and authoritative unexpired model catalog
  produce Ready and an opaque host-pinned Account Session.
- Failure to isolate credential storage or authorized transport produces
  ConnectedBlocked and no inference. Failure limited to tool-process isolation
  leaves chat Ready but reports Tool Availability Disabled with a reason and
  advertises no subscription tools.
- A fresh conversation selects only the returned default or a model explicitly
  selected from the Entitled Model Catalog.
- The first prompt streams transient text, receives a complete valid terminal
  response, commits provider-native state, then creates the durable generic
  read-only projection.
- A restart silently refreshes only when identity remains the same, reacquires
  readiness, and resumes under the original Account Identity Key and model.
- Same-identity restart atomically rebinds the writer lease to the new epoch;
  immutable journal ownership remains issuer, workspace, Account Identity Key,
  and model.

### Restart-safe harmless tool

- The model requests one harmless fixture tool. Kogg persists tool preparation
  and approval, dispatch intent, dispatch outcome, result, continuation Sampling
  Attempt, and resulting terminal response.
- The complete terminal response containing the tool request is validated and
  durably committed before approval can lead to local dispatch.
- A successful turn dispatches the tool once, records the result before sending
  it, and marks the Tool Transaction submitted only after the next terminal
  response is validated and committed.
- Restart from every unambiguous phase resumes without duplicate execution or
  duplicate provider continuation.
- The release gate runs this path in at least one supported execution mode with
  Tool Availability Enabled and proven tool-process isolation. A build that
  disables subscription tools in every mode fails the harmless-tool gate.

### Diagnostics and logout

- Every injected account or Responses failure shows an incident ID.
- `kogg diagnostics <id>` displays only the redacted summary and owner-only
  record location; debug detail adds only allowlisted safe protocol state.
- Confirmed export produces a secret-scanned redacted bundle. Cancelled export
  produces none. Clear removes all incident records.
- Ordinary logout first fences the identity and removes local active access,
  credentials, models, and limits, then attempts bounded revocation. It retains
  history and permitted incidents.
- Logging back into the same validated identity restores its histories for
  continuation under a new epoch. Another identity sees them read-only.
- Confirmed destructive logout removes all histories, journals, projections,
  caches, and incidents for the Account Identity Key.

## User and protocol sad paths

### Authorization

- Browser launch failure offers Retry browser, Use device code, and Cancel and
  never switches automatically.
- Occupy the preferred and fallback callback ports independently and together.
  The attended flow offers the permitted recovery; unattended startup neither
  launches a browser nor hangs.
- Reject wrong callback method, path, state, duplicate/replayed state, missing
  code, oversized inputs, malformed encoding, unsolicited callback, timeout,
  and callback after cancellation.
- Reject token exchange failure, invalid issuer or audience, missing identity,
  workspace mismatch, identity disagreement on refresh, malformed success,
  and private-contract drift with an explicit compatibility result.
- Exercise device pending, slowdown, denial, expiry, malformed success,
  cancellation, timeout, and process termination while polling.
- A pre-byte unauthorized response refreshes and retries at most once. Any
  response byte or uncertain send prevents automatic replay.
- Startup refresh failure or identity change requires reconnect and never opens
  a browser automatically.

### Authentication and readiness

- Initial authenticated login without entitlement commits ConnectedBlocked
  with Switch account and Logout, not Ready and not API fallback.
- Initial authenticated login with catalog unavailable or malformed commits
  ConnectedBlocked with Retry, Switch account, and Logout.
- A Ready account remains authoritative while a switch candidate authenticates.
  Candidate cancellation, no entitlement, catalog failure, storage failure, or
  compatibility failure leaves the old account and session untouched.
- Only a fully Ready switch candidate may atomically replace a Ready account.
- Catalog refresh failure inside the last-known-good TTL warns while Ready.
  At expiry it becomes ConnectedBlocked and no new inference is issued.
- Empty, malformed, cross-identity, wrong-version, or expired catalogs never
  become Ready. Model removal blocks an existing conversation for explicit
  selection and never silently changes it.
- Limit endpoint outage, malformed limits, or no returned groups does not block
  otherwise-ready inference. An authoritative active-exhaustion response blocks
  only the affected operation, shows reset data, and offers an explicit provider
  change with the API billing warning.

### Identity fencing and history

- Replace or logout during preflight, streaming, approval, dispatch,
  tool-result submission, projection, and commit. Every network, tool,
  submission, and durable boundary revalidates the epoch and refuses stale work.
- Run concurrent refresh, switch, ordinary logout, and destructive logout in
  two processes. Stale identity/revision writes lose compare-and-swap and cannot
  resurrect a tombstoned account.
- Verify histories bind the stable Account Identity Key rather than the epoch:
  same-account return restores continuation, another account receives read-only
  access, and destructive deletion removes only the selected identity's data.
- Corrupt or substitute a raw identity and prove it cannot collide with the
  pseudonymous key or make another identity's history writable.
- Crash immediately before and after atomic same-identity epoch rebind. Before
  installation the old epoch stays fenced; after installation the new epoch is
  authoritative. A retained old writer fails lease, Sampling Attempt, Tool
  Transaction, projection, and commit checks.

## Credential adversarial matrix

- Keychain unavailable, locked, denied, corrupt, slow, or returning the wrong
  entry; explicit fallback accepted, rejected, or forbidden by strict mode.
- Real keychain integration on every supported release OS, including create,
  retrieve, rotate, tombstone/logout, delete, and cleanup after test failure.
- Immutable-entry crash before and after active-pointer compare-and-swap;
  partial write; disk full; permission change; symlink/hardlink substitution;
  corrupt pointer; stale lock; lock contention; tombstone race; orphan cleanup.
- Stale refresh after normal or destructive logout, stale switch after another
  switch, and concurrent rotations for the same identity. No last-write-wins and
  no orphan may become active.
- Revocation delay, timeout, and failure after local invalidation. Local access
  remains fenced and credentials remain unavailable.
- Adversarial tools attempt to locate credentials through home, runtime,
  workspace, artifacts, environment, arguments, stdout/stderr, inherited file
  descriptors, process inspection, broker endpoints, sockets, and direct
  keychain commands or APIs.
- If storage or authorized-transport isolation fails, assert ConnectedBlocked.
  If only the tool child cannot deny credential paths or capabilities, assert
  Ready chat plus Tool Availability Disabled, no advertised tool, and no tool
  dispatch. File mode alone must not satisfy either isolation test.
- Scan process tables, child environments, open descriptors, captured output,
  core/crash artifacts where controllable, and retained test evidence for
  credentials and raw identities.

## Responses, sampling, and tool adversarial matrix

- Malformed JSON or SSE, duplicate or missing terminal event, connection reset,
  delay, truncation, invalid event ordering, malformed known item, unknown
  non-actionable item, unsupported actionable item, and partial terminal state.
- Transient text may appear during streaming but never becomes a durable generic
  turn when the terminal response fails validation.
- Unknown actionable or hosted items fail before a later local tool dispatch.
- Journal final-frame truncation recovers only to a valid prior checksum.
  Checksum, sequence, schema, migration, immutable ownership, current
  lease-epoch, model, or request-window ambiguity refuses continuation.
- Concurrent conversation writers exercise leases, fencing, and revision
  compare-and-swap.
- Crash before send, during send, after send before bytes, during streaming, and
  after terminal receipt before commit. Uncertain Sampling Attempts reconcile
  only through declared provider idempotency/status; otherwise they block and
  do not replay.
- Tool approval accepted, denied, cancelled, and process crash while approval is
  pending. Denial and cancellation are durable and dispatch nothing.
- Crash before dispatch intent, after intent but before known dispatch, during
  local execution, after execution before result persistence, after result,
  during result submission, during next stream, and after next terminal before
  commit.
- Ambiguous local dispatch blocks unless that tool's verified status or
  idempotency protocol proves the outcome. Ambiguous result submission or next
  response is owned by the Sampling Attempt and never marked submitted merely
  because request bytes left the process.
- Account replacement or logout at every phase proves no old-epoch request,
  dispatch, submission, projection, or commit proceeds.
- Prove immutable journal ownership excludes epoch. Writer leases, Sampling
  Attempts, Tool Transactions, projections, and commits carry the current epoch
  and reject an old writer after an atomic same-identity rebind.

## First-gate context behavior

- `/compress` is unavailable for a Responses Conversation before native
  compaction ships.
- Automatic compression, hard-rescue compression, and summary side queries are
  disabled on every ordinary, overflow, restart, and recovery path.
- The strict fake fails the scenario if any semantic-summary request occurs.
- Deterministic structural savings may reduce request structure without
  rewriting provider state. If still over budget, Kogg blocks before sending,
  displays an actionable incident ID, and preserves the native conversation.
- Native compaction is tested in its later required slice, not simulated by a
  local semantic summary in the first gate.

## Diagnostics and artifact adversarial matrix

- Attempt to inject access and refresh tokens, cookies, authorization headers,
  callback query values, raw identities, emails, prompts, responses, tool
  arguments/results, source paths, URLs, ANSI/control/bidirectional text,
  binary, oversized values, cyclic objects, and throwing accessors into every
  incident input and product error.
- Verify the Incident Diagnostics interface rejects non-allowlisted shapes
  before persistence, and account pseudonyms remain stable without revealing
  raw identity.
- Exercise concurrent record and prune, seven-day expiry, 100 MiB global cap,
  oldest-first removal, unknown/pruned IDs, corrupt record/index, index rebuild,
  permission loss, disk full, export cancellation/failure, clear, ordinary
  logout retention, and destructive account deletion.
- Incident Store failure preserves the original product outcome and adds
  diagnostics unavailable without recursion or a legacy-log fallback.
- Static dependency tests prohibit subscription Account, compatibility,
  Responses, journal, and diagnostics code from importing or calling the legacy
  arbitrary debug logger. Runtime tests make the legacy logger throw and prove
  subscription error handling is unchanged.
- Seed unique canary secrets into every source before a failing run. Assert they
  never reach capture buffers. Run a second independent scan before artifact
  retention and suppress retention on any match or scanner failure.

## Focused lower-level proof

Focused tests complement, but do not replace, bundled E2E for:

- Inter-process active-pointer compare-and-swap, tombstones, fencing, and orphan
  cleanup at schedules too fine-grained for PTY control.
- Platform keychain adapters against a real isolated keychain plus explicit
  unavailable/locked test adapters.
- Host pinning and proof that the opaque Account Session cannot expose bearer
  material or authorize an arbitrary host.
- Framing, checksums, corrupt indexes, retention concurrency, hostile redaction
  values, and pseudonymous Account Identity Key collision/domain separation.
- Static dependency boundaries around legacy logging, generic content
  generation, and provider refresh paths.

## Protected live compatibility probes and bootstrap

In probe-stage builds, ordinary first run, `/auth`, direct login, headless
output, and restart never render or persist the ChatGPT descriptor. A dedicated
protected probe command alone may invoke the hidden Probe-stage Candidate, and
it always creates disposable state. Environment variables, user configuration,
and general feature flags cannot expose or persist it. Tests attempt every such
bypass and assert the catalog remains unchanged.

Browser and device modes are separate opt-in commands and separate release
results. Each uses the bundled executable and production adapter with fresh
disposable Kogg state, requires explicit confirmation, performs login,
identity/entitlement and model readiness, one harmless prompt, the harmless
local tool, restart, redacted diagnostics check, logout, and state deletion.

The probes never run in ordinary CI and never retain tokens, raw identity,
prompts, responses, tool payloads, headers, or protocol bodies. Both must pass
for an Experimental feature release candidate. A failure disables or withholds
only the ChatGPT connection and reports private compatibility drift; it does
not block unrelated Kogg releases.

After both protected live modes pass, a release build manifest—not mutable user
state—enables the normal top catalog descriptor. Tests compare probe-stage and
enabled manifests and prove that ordinary catalog visibility changes only with
the release artifact.

## Gate result

The top option may be surfaced only when the minimal bundled `kogg` prerequisite
and Compatibility Profile exist; the full tracer passes with both auth modes
against the strict fake; all secret scans pass; storage and transport isolation
pass; at least one supported tool-enabled mode proves tool-process isolation;
the focused security tests pass; and both protected live probes pass for the
release candidate. Broad dynamic limits and native compaction retain their own
later required gates. Broader rebrand, hosted tools, and secondary-surface
parity are separately sequenced rather than being implied by this gate.
