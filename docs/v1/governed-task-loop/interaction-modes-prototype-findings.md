# Interaction modes real-Theia boundary prototype findings

Tracking: [#121](https://github.com/anthonykewl20/kogg/issues/121), parent
[#118](https://github.com/anthonykewl20/kogg/issues/118), and production
[#122](https://github.com/anthonykewl20/kogg/issues/122).

## Verdict and production decision

The prototype validates the most important #120 enforcement decision: the mode
selector can remain an ordinary Theia projection while a task-scoped backend
registry independently decides authority for every operation. UI requests made
in Plan and Build were refused by the real backend, and a backend restart restored
the exact persisted Kogg mode rather than a frontend/global preference.

#122 MUST retain backend-owned task mode, optimistic sequence, closed operation
capabilities, durable restoration, and mode-specific result ceilings. It MUST
NOT trust selector state, context keys, hidden buttons, prompts, provider tool
availability, or a prior Build result as mutation/evidence/verdict/merge authority.

Experimental production-package changes are preserved only on
`prototype/issue-121-interaction-modes` at
`2a7707740ef0b9984c0ccc031dbbda7396eaeac0`. They MUST NOT ship.

## Reproduction and measured evidence

The run used the authenticated Kogg browser application, the development Theia
bundle, real WebSocket JSON-RPC, SQLite mode storage, Playwright/Chromium, Node
22.23.2, and the production task/project services.

```sh
git switch prototype/issue-121-interaction-modes
yarn setup
yarn build:browser
KOGG_E2E_TASKS_ONLY=1 yarn test:e2e:browser
yarn test
```

Observed on 2026-08-27:

- the real Tasks widget displayed one always-visible Plan/Build/Kogg selector,
  effective authority, and stage for the selected durable task;
- Plan was the default task mode and a UI-issued production-mutation request
  returned `PLAN_MUTATION_REFUSED` from the backend;
- after an explicit Plan-to-Build transition, separate UI requests for evidence
  admission, verdict read, and merge returned backend refusals; none was relabeled
  as a Build success or governed result;
- after Build-to-Kogg, only the closed governed-entry operation was allowed; this
  did not synthesize evidence, PASS, merge authority, or completion;
- the backend stopped and restarted, the browser reconnected, and the same task
  restored Kogg with `governed-entry-ready` from SQLite;
- frontend manipulation was non-authoritative because every request re-read the
  persisted task mode and closed backend ceiling over JSON-RPC;
- request, transition, allowed/refused operation, stop, start, and restoration
  logs were visible with safe request/task correlations, selected mode, operation
  kind, sequence, and safe code, without task content;
- runtime diagnostics reported pass for registry integrity, closed authority,
  readable transition ledger, and frontend/backend source maps; the private
  support bundle contained those statuses;
- Playwright used Chromium's debugging connection, the backend exposed a random
  Node inspector endpoint, and version-3 maps existed for the frontend widget,
  backend mode registry, and browser bundle;
- the focused real-browser E2E passed after the backend restart in 88.51 seconds;
  the repository suite passed 41/41, branding passed, and observability passed
  with 65 experimental/production operational files inspected.

The experiment used the existing real task/project flow to create and restore a
task. It is not a production mode schema, authorization system, worktree owner,
workflow engine, or Ranex authority.

## Lifecycle and design validated

The measured sequence was:

```text
registry start/restoration -> task projection -> Plan operation refusal ->
Plan-to-Build transition -> Build evidence/verdict/merge refusals ->
Build-to-Kogg transition -> governed-entry admission -> backend stop ->
backend start/restoration -> exact Kogg projection -> diagnostics/support
```

This backs the following #120 decisions:

- task mode can be durable and separate from browser state;
- the selector and visible effective authority can be driven by a real backend
  projection without becoming authority themselves;
- backend capability ceilings can prevent Plan mutation and Build semantic
  laundering even when the client invokes the operation directly;
- a restart can restore one task-scoped mode without a global last-used grant;
- mode-specific result vocabulary can distinguish refusal from governed entry;
- safe transition logs and catalog diagnostics can correlate the visible state
  without prompts, specifications, source, paths, or provider bodies.

## Qualification gaps and #122 gates

The prototype intentionally narrows #121 to its real UI/backend enforcement and
restoration risk. #122 still must implement and qualify:

- all six cross-mode transitions, same-mode idempotency, explicit consequence
  dialogs for authority expansion, downward-transition cleanup, and cancellation;
- immutable active-attempt grants and a real Build child/private worktree where a
  Build-to-Kogg request waits for zero descendants and freezes only an untrusted
  candidate reference;
- crash/restart at transition intent, cleanup, and commit boundaries, lost
  acknowledgement replay, concurrent-window CAS conflict, and quarantine;
- exact task/repository/approval/provider/model/host drift and store corruption
  refusal/recovery cases;
- Plan filesystem/Git/process/network non-mutation oracles and Build isolation,
  agent selection, test lifecycle, cancellation, and unverified handoff;
- compiled Kogg workflow anchors, fresh approval/check/evidence bindings, current
  Ranex verdict, human controlled merge, and zero-residual governed completion;
- first-party authentication/CSRF/origin/role enforcement for transition RPCs;
- full diagnostics (`operations`, `restoration`, `worktrees`, `anchors`, and
  accessibility), failure tests, canary coverage, and retained source maps;
- browser and Electron visible E2E for keyboard/screen reader, narrow/zoom/high-
  contrast/reduced-motion behavior, races, disconnects, failures, and recovery;
- three-OS artifact/host qualification and the complete #120 fault matrix.

These gaps do not reopen the backend-authority decision. They prevent the
experimental selector and minimal mode ledger from being mistaken for production
Plan, Build, or governed Kogg execution.
