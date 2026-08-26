# Plan, Build, and Kogg interaction modes

Tracking: [#118](https://github.com/anthonykewl20/kogg/issues/118), research
phase [#119](https://github.com/anthonykewl20/kogg/issues/119), and pseudocode
phase [#120](https://github.com/anthonykewl20/kogg/issues/120). The normative
contract is in [`interaction-modes-pseudocode.md`](interaction-modes-pseudocode.md).

## Status

Research and decision-complete pseudocode are complete as of 2026-08-27. These
packets contain no production code. #121 must probe the fixed mode/transition
contract at real task/worktree/process boundaries, followed by production
behavior plus real human-level E2E in #122.

The recommendation is an always-visible three-mode selector backed by a durable,
task-scoped authority state machine. Plan, Build, and Kogg are not prompt personas
or tool-menu presets. Each selects a closed maximum authority envelope that the
backend intersects with the task, role, provider/model, project/repository,
execution target, approval, and lifecycle grants before every operation.

Plan is non-mutating research and approval-ready design. Build permits scoped
mutation/testing in one isolated private worktree with an explicitly chosen
agent, but its strongest outcome is `build work ready for governed verification`.
Only Kogg enters the complete trust spine and can reach evidence, a current Ranex
verdict, explicit controlled merge, and governed completion. Switching mode never
retroactively upgrades prior work or evidence.

## Scope and invariants

- Current mode, effective authority, active stage, target, and important blocked
  actions remain visible in every relevant task/chat/workflow view.
- The selector is a projection. Only the backend transition service persists and
  enforces mode state and grants.
- Every mode change is an explicit user request with old/new mode, task binding,
  safe consequences, challenge where authority grows, durable result, and log.
- A transition may preserve or reduce current authority. Any expansion requires
  fresh backend validation and, where specified, explicit confirmation/approval.
- Active operations keep their frozen attempt grant. Switching cannot widen a
  running process; the backend must pause/cancel/clean or wait for a safe boundary.
- Restoring a window/task reads the durable task-scoped mode and revalidates it.
  Global/last-used UI preference may suggest an initial mode but never grants it.
- Plan cannot write production/private worktrees, execute implementation tools,
  start mutation agents, produce evidence, request verdict, or merge.
- Build cannot claim governed PASS/completion, admit evidence, issue/reinterpret a
  verdict, or merge. Tests passing and an agent finishing remain Build results.
- Kogg cannot bypass frozen specification approval, producer separation,
  deterministic verification, evidence integrity, current Ranex PASS, human merge
  authorization, controlled merge, or cleanup.
- Prior Plan/Build artifacts may be referenced as untrusted inputs to Kogg, but
  Kogg re-runs required phases/bindings and never imports them as verified facts.
- Logs/diagnostics/metrics never contain prompts, plans, code, diffs, paths,
  credentials, tool/command arguments/results, environments, personal data, or
  raw provider/evidence/request/response bodies.

## Commit-pinned source ledger

Sources supply patterns only. Reuse requires separate license, provenance,
security, and maintenance approval.

| Source | Exact revision and license | Reviewed paths | Security and maintenance result |
| --- | --- | --- | --- |
| [Visual Studio Code](https://github.com/microsoft/vscode/tree/09dbe74f31a242bb204097b10416c8223593cec2) | commit `09dbe74f31a242bb204097b10416c8223593cec2` (2026-08-26); MIT for the repository, with product/service components separately governed | workbench chat/agent session input and mode/model/permission pickers, agent-host planning captures, chat editing/session persistence, context keys, command enablement, accessibility and integration tests | Preserve a compact selector beside input, persistent session configuration, discoverable descriptions, disabled-with-reason affordances, keyboard control, and visible permission/model state. Reject client context keys, prompt modes, auto-approval, session UI state, and editable workspace state as backend authority. |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code/tree/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16) | commit `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16` (2026-05-15); Apache-2.0 | `src/shared/modes.ts`, schemas/roomodes, prompts/mode sections, `webview-ui/.../ModeSelector.tsx`, mode views/tests, VS Code E2E | Preserve concise name/description/icon, sticky provider/model presentation, mode-specific tool/file ceilings, selector tests, import validation, and project/global precedence as usability references. Reject user/project overrides of built-in trust modes, instructions as safety enforcement, auto-approval, MCP/command widening, and a mode switching itself. |
| [Continue](https://github.com/continuedev/continue/tree/5522c6f44ca0ac3528b37244818fbfa39b5af470) | commit `5522c6f44ca0ac3528b37244818fbfa39b5af470` (2026-07-21); Apache-2.0 | IDE extension mode selector, Chat/Plan/Agent definitions, model capability checks, tool policy and CLI fixtures/docs | Preserve simple three-way mental model, Plan as read-only tools, Agent/Build as mutation, capability-disabled explanation, same input continuity, and keyboard cycling. Reject calling Build `Agent completion`, provider tool support as authority, or silently changing model/tools when switching. |
| [OpenHands](https://github.com/OpenHands/OpenHands/tree/59981caf7fd92971681b0ab5354c37e9f1cab406) | commit `59981caf7fd92971681b0ab5354c37e9f1cab406` (2026-08-26); MIT | security analyzer/action confirmation, confirmation mode UI/components/hooks, runtime event/action/security levels, integration tests | Preserve pre-action interception, explicit confirmation states, risk explanation, event-driven backend decision, and refusal paths. Reject optional analyzer/confirmation toggles as enforcement, model-generated risk scores as grants, and frontend confirmation response without exact backend binding. |
| [Eclipse Theia](https://github.com/eclipse-theia/theia/tree/647dd3c7091b25ef3fc735edb74b949e7a195754) | v1.74.1 commit `647dd3c7091b25ef3fc735edb74b949e7a195754` (2026-08-06); EPL-2.0 or GPL-2.0-only with Classpath Exception, plus identified MIT/VS Code material | status bar, toolbar/select components, command/context-key framework, preferences/workspace persistence, dialogs, accessibility, frontend state, source-map tests | Reuse contribution/widget/status/persistence/accessibility seams. Reject preferences, context keys, hidden/disabled commands, labels, or client restoration as authority; the backend owns transitions and refuses direct calls. |
| [Ranex](https://github.com/anthonykewl20/ranex/tree/5586d68b0936f554759022caabe847087f1d03ef) | commit `5586d68b0936f554759022caabe847087f1d03ef`, tree `581ce66c54116d4be48b96c3a0359fbdd9d3077f` (2026-08-25); MIT | approval/grants, governed execution, evidence/verdict, merge, journal, watchdog, recovery and observability | Preserve immutable grant intersection, explicit approval, role separation, evidence/verdict authority, controlled merge, process ownership, and recovery. Interaction mode is never a substitute for a Ranex grant or fact. |

Mutable documentation corroborates, but does not replace, these exact revisions.
No external mode framework is selected as a production dependency. Kogg's closed
three-mode semantics must not inherit a third-party marketplace/custom-mode
override surface.

## Comparison of mode semantics

| Concern | Common IDE/agent pattern | Kogg requirement |
| --- | --- | --- |
| Meaning | persona/prompt plus tool menu | backend-enforced maximum authority envelope |
| Scope | global/workspace/session preference | durable task state plus immutable attempt grants |
| Switching | dropdown/shortcut, often immediate | explicit transition with consequence and safe-boundary validation |
| Persistence | last selected/sticky model | task-owned mode/version; UI preference grants nothing |
| Planning | read/search tools, sometimes hidden writes | provably non-mutating owned boundaries |
| Building | edit/command/MCP, sometimes auto-approved | isolated worktree, closed agent/tools, no evidence/verdict/merge authority |
| Autonomous mode | orchestrator can delegate freely | compiled governed workflow inside non-removable trust spine |
| Completion | agent/session says done | only Kogg after current evidence/verdict, controlled merge, cleanup |
| Customization | custom modes/instructions/tool groups | Kogg workflow customization only inside fixed anchors; modes not overridable |
| Enforcement | frontend/context/prompt/tool availability | backend revalidation for every operation and direct RPC |

The strongest reusable UX pattern is a selector at the point of intent paired
with concise capability descriptions and visible model/permission configuration.
The central rejection is equating that visible choice with authority. Kogg must
show both `selected mode` and `effective authority`, including when task state,
host qualification, approval, provider capability, or active work makes the
effective authority narrower than the selected envelope.

## Mode affordances and language

### Plan

Primary label: `Plan`. Description: `Research and design without changing
production files.` Status line examples: `Read-only`, `Planning`, `Awaiting plan
review`, `Plan saved`. Permitted outcomes are `draft plan`, `decision packet
ready`, and `approval requested`. Never use `implemented`, `fixed`, `tests pass`,
`verified`, `complete`, or `ready to merge` as Plan terminal labels.

Plan may browse explicitly authorized repositories/docs, inspect safe project
state, reason, produce pseudocode/decision artifacts in a planning-owned store or
branch specified by #120, and request approval. The non-mutation boundary must
cover filesystem, Git refs/index/worktrees, processes with write/network effects,
provider tools, MCP, and external systems—not just hiding edit buttons.

### Build

Primary label: `Build`. Description: `Implement and test in an isolated worktree;
governed verification and merge remain required.` The selector and result banner
must always retain the qualifier. Suitable statuses: `Building in private
worktree`, `Tests running`, `Build checks passed`, `Build work ready for Kogg
verification`, `Build cancelled`, and `Build cleanup incomplete`.

Never show bare `PASS`, `Verified`, `Governed`, `Complete`, `Approved`, `Safe to
merge`, or `Merge`. A successful Build result banner must say: `Build work is
unverified. Continue in Kogg mode to run the required governed lifecycle.` This
is not merely copy; backend Build responses cannot emit governed-verdict or merge
result types.

Build requires an explicitly selected agent/provider/model, exact task and
repository binding, a fresh private worktree, closed mutation/test grants,
deadlines, process supervision, and cleanup. It may create a subject commit or
safe handoff reference, but it cannot admit evidence or convert check output into
a Ranex verdict. Switching to Kogg treats it as an untrusted candidate input and
creates fresh required attempts/bindings.

### Kogg

Primary label: `Kogg`. Description: `Run the complete governed lifecycle with
required approvals, independent checks, evidence, verdict, and controlled merge.`
It should display the active stage (research, pseudocode, probe, approval,
implementation, E2E, evidence, verdict, merge, cleanup) and trust-anchor status.

Kogg is autonomous only between required authority boundaries. It cannot remove,
skip, reorder, auto-satisfy, or relabel anchors. `Governed PASS` appears only as a
current Ranex projection for the exact subject. `Complete` appears only after
controlled merge/post-verification and zero-residual cleanup, or a separately
defined non-merge terminal policy.

## Always-visible UI findings

The compact selector belongs adjacent to the primary input and also projects to
task header/status bar so scrolling or alternate views cannot hide it. Its closed
button shows icon, mode, effective-authority badge, and active stage. The menu
shows all three modes in fixed order with description, capability summary,
current task compatibility, transition consequence, and disabled/refused reason.

Always-visible does not mean visually dominant. At 200% zoom/narrow panels it may
collapse text while retaining accessible name such as `Mode: Build; authority:
private worktree edit and test; governed completion unavailable`. Color is never
the only signal. Icons and terms are consistent across browser/Electron, command
palette, status bar, task list, timeline, and dialogs.

Blocked actions explain the owner and remedy: `Build cannot merge—continue through
Kogg verification`, `Plan cannot modify files—switch to Build or Kogg`, `Kogg
implementation waits for specification approval`, `Build unavailable—qualified
worktree target missing`. Tooltips alone are insufficient; status/menus and
screen readers expose the same reason.

The selector supports mouse, keyboard menu navigation, direct commands with
confirmation, and announced transitions. A rapid cycle shortcut is risky for
authority expansion and should either be absent or stop for confirmation when
crossing upward. Focus returns to the selector after cancel/refusal and to the
primary input after success. Live stage updates are polite; approval/refusal and
cleanup abnormalities are assertive and deduplicated. Reduced motion, high
contrast, non-color state, and screen-reader relationships are required.

## Persistence and transition-safety findings

The durable state needs selected mode, mode-schema version, task revision,
project/repository binding, effective-authority digest, transition sequence,
actor/session correlation, active operation/run references, and restoration/
degraded state. It must not store prompts/content in the mode record.

Research supports these transition rules:

| From -> To | Safety requirement |
| --- | --- |
| Plan -> Build | confirm mutation scope, select exact agent/provider/model and private worktree target, validate approval if production mutation needs it |
| Plan -> Kogg | compile/validate governed workflow and authority; start at first unsatisfied valid stage, never assume Plan output is evidence |
| Build -> Plan | stop new mutations, cancel or reach safe boundary, revoke write grants, prove cleanup; candidate work remains unverified |
| Build -> Kogg | freeze candidate reference as untrusted input, clean Build attempt, compile fresh governed run, redo required approval/check/evidence bindings |
| Kogg -> Plan | request pause/cancel at workflow safe boundary, revoke active grants, cleanup all descendants; no downgrade escape from mandatory recovery |
| Kogg -> Build | same cleanup plus explicit abandonment of governed run; prior partial evidence/verdict cannot authorize Build or later merge |
| same mode | idempotent no-op unless configuration change creates a separately validated transition |

The backend records transition intent before cancellation or external work. A
mode is committed only after required active-operation cleanup and new envelope
validation. During transition the UI shows `Switching: cleanup in progress` and
refuses operations from both envelopes except cancel/diagnose. Timeout or residual
process leaves `transition blocked/quarantined`, not the requested mode.

Mode changes never alter immutable active attempt grants. The owning engine first
pauses/cancels and externally proves cleanup. Approval/session expiry or task/
repository/host/provider drift may restore a persisted selected mode with reduced
effective authority and visible remediation. Restoration never silently chooses
a more powerful mode because it was last used globally.

Concurrent windows use optimistic sequence compare-and-swap and broadcast the
committed transition. A stale client is updated/refused; it cannot overwrite.
Browser disconnect after request requires exact idempotent read-back. Backend
restart reconciles transition intent, active operations, grants, worktrees, and
process inventory before enabling mode actions.

## Backend enforcement and direct-call risks

Every operation declares `requiredModeCapability`, immutable task binding, and
attempt grant. The backend computes:

```text
effective = selectedModeCeiling
  intersect taskAuthority
  intersect roleGrant
  intersect projectRepositoryBinding
  intersect providerModelCapability
  intersect executionTargetQualification
  intersect approvalAndLifecycleState
  intersect operationCatalogCeiling
```

The operation is allowed only if the closed capability is present and every
binding is current. The frontend-provided mode, visible stage, enabled state,
prompt instruction, tool list, or prior response is ignored as authority. Direct
RPC, replay, alternate window, extension, command palette, or manipulated storage
receives the same fail-closed decision.

Mode-specific result schemas prevent semantic laundering. Plan cannot return a
mutation result. Build cannot return evidence/verdict/merge/governed-completion.
Kogg result types are emitted only by their owning trust-spine stages with exact
Ranex and merge bindings. Unknown future modes/capabilities/schema versions fail.

## Failure, cancellation, and recovery findings

Failure cases include invalid mode/schema, missing task/repository, stale task
revision, incompatible provider/model, unqualified host, missing approval,
authority expansion, active-operation conflict, cleanup timeout, residual process,
worktree mismatch, concurrent transition, duplicate/late request, persistence
corruption, restoration mismatch, UI/backend desynchronization, workflow/anchor
unavailable, and prohibited operation direct-call.

Each uses a stable safe category and visible remedy. Raw errors or provider data
are discarded. Cancellation of a transition is valid before new authority is
committed; it restores the proven old state only after any partial cleanup. Once
the new mode is committed, reversal is a new transition.

On restart a single recovery owner verifies mode event chain/current projection,
task/project stores, active attempt grants, scheduler/adapter/process state, and
worktree ownership. It revokes orphan grants, cleans owned processes, reconciles
idempotency keys, and chooses the unique safe old/new/blocked state. It never
reissues provider work or assumes a selector click succeeded.

Mode archival follows task retention. Historical events retain safe old/new mode,
effective-authority digest, result, and correlations but no content. Deleting UI
preferences cannot delete task mode history; archiving a task prevents new mode
operations and does not delete evidence/verdict/process incident holds.

## Observability and diagnostics risks

Required logger is `kogg:ui:mode-selector` for UI requests/projections and a
backend `kogg:interaction-modes:service` (name for #120 to finalize) for authority
and persistence. Required event candidates:

```text
mode.selected
mode.transition-requested
mode.transition-validation-started
mode.transition-cleanup-started|completed|failed
mode.transition-approved|refused|cancelled
mode.restored|restore-degraded
mode.operation-requested|approved|refused
mode.recovery-started|completed|quarantined|failed
```

Safe fields are event/logger, project/task/run/attempt/operation/transition/
session correlation IDs, old/new/effective mode, capability category, active
stage, safe code, bounded duration/count, boolean outcome, and non-content grant
digest. Never log selector descriptions/user text, prompts/plans, code/diffs,
paths, credentials, model/provider bodies, tool/command data, environments, or
personal identity. Metrics use selected/effective mode, transition direction,
safe result category, and bounded duration only; IDs/digests are not labels.

Candidate diagnostics for #120:

- `interaction-modes.registry`: schema/event-chain/current projection integrity;
- `interaction-modes.authority`: selected ceiling versus effective grant;
- `interaction-modes.transitions`: intent/CAS/cleanup/idempotency consistency;
- `interaction-modes.operations`: mode capability versus active owner operation;
- `interaction-modes.restoration`: task/UI/window state and degraded recovery;
- `interaction-modes.worktrees`: Build/Kogg target and cleanup ownership;
- `interaction-modes.anchors`: Kogg workflow/trust-spine availability;
- `interaction-modes.accessibility`: selector/status/blocked-reason semantics;
- `interaction-modes.source-maps`: browser/backend/Electron breakpoint mapping.

Missing or throwing contributors fail combined status. Every operational file
needs matching `diagnostic-coverage`. Canary tests cover prompts, plans, code,
diffs, paths, credentials, commands/tools, environments, personal/provider data,
and raw errors across frontend/backend/Electron logs, metrics, diagnostics, and
support bundles.

## Prototype and real human-level E2E requirements

#121 must use the real task/project registries, private worktrees, workflow/agent
owners, operation/process supervisor, authenticated browser state, SQLite mode
store, and at least one real adapter attempt. It must probe every transition,
concurrent windows, direct RPC bypass, lost acknowledgement, task/repository/
approval/provider/host drift, backend restart around intent/cleanup/commit,
corrupt history, and a hung/residual child.

Principal evidence starts Build mutation, requests Kogg while the process is
active, crashes during cancel/cleanup, restarts, externally proves zero children,
commits Kogg only after fresh workflow validation, and proves Build results were
not imported as evidence/PASS. A second run loses transition acknowledgement and
returns the same unique state without duplicate work or broadened grant.

#122 visible browser/Electron E2E must:

1. show the selector, effective authority, stage, and blocked actions everywhere;
2. use Plan for research/pseudocode and prove production files/refs unchanged;
3. explicitly switch to Build, select an agent/provider/model/target, implement
   and test in a private worktree, and show `unverified` handoff language;
4. refuse Build evidence, PASS, completion, and merge through UI and direct call;
5. switch to Kogg, perform fresh required lifecycle/approval/check/evidence/
   verdict/controlled merge, and show governed completion only afterward;
6. switch downward during active work, cancel/cleanup, and expose one residual/
   recovery refusal path;
7. open two windows, create a transition conflict, disconnect/restart, and restore
   the one durable task-scoped state with no global privilege carryover;
8. exercise keyboard/screen-reader/narrow/zoom/high-contrast/reduced-motion states;
9. inspect diagnostics/support export and browser/backend/Electron source-map/
   debugger points; and
10. independently verify filesystem/Git/worktrees, processes, task/workflow,
    Ranex evidence/verdict, merge, canary absence, and all repository gates.

Expected safe trace crosses selection, transition request, validation, active
work cleanup, approval/refusal, durable commit, projection/restoration, operation
authorization, and owner lifecycle. Failure/recovery/blocked traces must remain
complete. Component mocks, direct service-only tests, pre-generated work, or UI
labels without independent authority/process/Git oracles do not pass.

## Rejected approaches

| Candidate | Decision |
| --- | --- |
| Implement modes as system prompts/personas | Reject; prompts cannot enforce mutation, evidence, verdict, or merge authority. |
| Trust the selector/context key/disabled command | Reject; client state is bypassable and stale. |
| Persist only the last global mode | Reject; mode is task-scoped authority state; global preference grants nothing. |
| Allow project/global custom overrides of Plan/Build/Kogg | Reject; fixed trust semantics cannot be replaced by workspace YAML/instructions. |
| Let the model suggest and auto-switch mode | Reject; it may recommend, but a user/backend transition owns authority. |
| Keyboard-cycle upward without confirmation | Reject; rapid navigation must not silently broaden authority. |
| Call Build success PASS/complete/ready to merge | Reject; use explicit unverified governed-handoff language. |
| Import Build tests/results as Ranex evidence | Reject; Kogg reruns exact independently bound verification/admission. |
| Widen an active attempt when mode changes | Reject; attempts retain frozen grants and must reach safe cleanup. |
| Downgrade from Kogg to escape cleanup/recovery | Reject; required cleanup post-dominates every mode transition. |
| Infer current mode from active tool/provider | Reject; durable backend mode and exact grants are authoritative. |
| Use provider tool support as permission | Reject; capability availability is not task authority. |
| Store prompt/plan/content in mode events | Reject; mode history contains safe facts only. |
| Show hidden tooltip as the only blocked-action explanation | Reject; visible and accessible status/menu reason is mandatory. |

## Decisions fixed by #120

The normative pseudocode packet fixes exact mode/capability/transition/persistence
schemas, the action matrix, authority intersection, Plan storage/non-mutation
boundary, Build worktree/handoff contract, Kogg stage integration, active-operation
transition state machine, concurrent CAS/idempotency/restart recovery, result
vocabulary, always-visible accessible UI behavior, safe failures/log/events,
diagnostic ids, source-map/debugger proof, and every #121/#122 fault/E2E seam.

The largest risk is proving Plan truly non-mutating and Build unable to launder a
successful test/agent result into governed evidence or completion across every
backend entry point. The second is switching while work is active without grant
widening, orphan processes, or ambiguous restored state. #120 must resolve exact
mechanisms and #121 must probe them with real boundaries.

## Research gate conclusion

- Comparable repositories are pinned by commit with paths, dates, licenses,
  maintenance/security implications, patterns, and explicit reuse boundaries.
- Mode affordances, persistence, transition safety, accessibility, authority,
  active work, cancellation/recovery, observability, diagnostics, debugger, and
  real-E2E strategies are compared.
- Build language explicitly prevents an implication of governed PASS/completion.
- Rejections prevent persona/UI/custom-mode/provider state from becoming
  authority or prior ungoverned work from becoming verified.
- Findings are sufficient for #120 to produce decision-complete pseudocode
  without reopening the three-mode/backend-authority topology.

Production remains blocked until #120, #121, and #122 complete in order and all
observability, diagnostics, accessibility, debugger/source maps, real human-level
E2E, Ranex evidence/verdict, controlled merge, and zero-residual-process gates
pass.
