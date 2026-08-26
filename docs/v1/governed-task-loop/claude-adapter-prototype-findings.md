# Claude adapter artifact/legal-gate prototype findings

Tracking: [#96](https://github.com/anthonykewl20/kogg/issues/96), parent
[#93](https://github.com/anthonykewl20/kogg/issues/93), and production
[#97](https://github.com/anthonykewl20/kogg/issues/97).

## Verdict

The real pre-execution boundary behaves as designed. The exact cached
`@anthropic-ai/claude-agent-sdk@0.3.246` tarball matched both pinned integrity
values and its closed 15-file archive surface was inspected through a
register-before-spawn external process with visible start, zero exit, and
cleanup. No repository-controlled `ClaudeCommercialUseApprovalV1` was supplied,
so the governed Claude attempt refused with
`CLAUDE_LEGAL_APPROVAL_REQUIRED` before SDK import, credential mint, or Claude
spawn. There was no fallback to the separately installed global CLI.

This is the only authorized #96 outcome under the #95 contract. The packet says
the commercial runtime may execute only after an authorized maintainer supplies
an exact, signed, current commercial-use approval record. That authority is not
implicit in an installed binary, npm cache entry, issue assignment, or test run.
Consequently #97 remains disabled. The missing approval is a production release
blocker and prevents the real provider, settings, permissions, model, broker,
descendant, and Linux confinement measurements from being claimed.

The disposable probe MUST NOT merge as production. It is preserved on
`prototype/issue-96-claude-adapter` at commit
`a19798571d741c6d6fd31264555ff61d84372a47`. Only these findings and the packet
status correction are intended for the production branch.

## Reproduction and exact evidence

The probe ran on macOS arm64 with Node 22.23.2. It did not import the SDK or
execute any Claude binary.

```sh
git switch prototype/issue-96-claude-adapter
yarn setup
volta run --node 22.23.2 node --inspect=0 prototypes/claude-adapter/probe.mjs
volta run --node 22.23.2 yarn test
```

Observed on 2026-08-27:

- the npm cache contained the exact selected tarball at 1,331,363 bytes;
- its SHA-512 was
  `16d4741e81c736a7aa2568d937ca8b500cd9545508f73b5760d3cfc2ff7c11c9aff6aab64136ae23c233918dba082d2695e580a9bf514045b60b43ad894962ba`,
  matching the pinned npm integrity string;
- its SHA-1 was `0009206e79ee0ae25f68ebb526584031cb5db048`,
  matching the pinned tarball digest;
- the archive was a regular non-symlink file and exposed exactly the 15 expected
  package, license, readme, manifest, JavaScript, and declaration entries;
- Kogg registered the real archive-inspection process before spawn, observed
  start and zero exit, cleaned its process and operation records, and retained
  no archive output in the safe trace;
- the subsequent `agent-dispatch` operation was refused from its requested state
  with `CLAUDE_LEGAL_APPROVAL_REQUIRED` and flags proving SDK import, credential
  mint, and Claude spawn were all false;
- final operation diagnostics reported zero active operations, residuals, and
  cleanup failures;
- the safe trace excluded home paths, credential values, authorization/cookie
  fields, raw bodies, prompt handles, and source text; and
- `yarn test` passed 41/41, branding passed, and the observability audit passed
  with 62 production operational files inspected.

`--inspect=0` proved debugger attachment to the retained JavaScript probe, and
the repository build preserved its TypeScript source maps. The disposable probe
declares a specific diagnostic exemption and exercises the production operation
registry rather than adding a misleading production Claude diagnostic before an
adapter exists.

## Safe lifecycle trace

The asserted artifact verification path was:

```text
artifact.verify.started -> check operation requested/started ->
process.registered -> process.spawn.started -> process.started ->
operation.active -> artifact.inspect.started -> process.exit(zero) ->
artifact.inspect.exit(zero) -> process.cleanup.completed ->
operation.cleanup.completed -> operation.completed ->
artifact.verify.completed(integrity matched, fileCount=15)
```

The asserted admission path was:

```text
agent-dispatch requested -> legal.verify.started ->
operation.refused(OPERATIONS_REFUSED) ->
legal.verify.failed(CLAUDE_LEGAL_APPROVAL_REQUIRED, retry=false) ->
adapter.refused(sdkImported=false, credentialMinted=false,
processSpawned=false, fallback=false)
```

This validates both sides of the boundary: external artifact inspection is
supervised and cleaned, while a failed authority gate permits no commercial
runtime side effect. No prompt, source, raw archive data, command arguments,
paths, environment, credentials, or provider data entered the probe trace.

## Decisions validated

- Package integrity and closed archive shape can be verified before importing or
  executing opaque commercial runtime code.
- Artifact possession and legal authorization are separate gates. Matching
  bytes do not authorize their use in Kogg.
- `CLAUDE_LEGAL_APPROVAL_REQUIRED` must be an admission refusal, not a late
  runtime failure after credential mint or process spawn.
- The adapter must not fall back to a global Claude installation, another SDK
  version, ambient login, or a direct CLI invocation when the selected approval
  is absent.
- Preflight helper processes still require register-before-spawn, bounded output,
  exit classification, cleanup, safe correlations, and zero-residual diagnostics.
- The packet's explicit legal gate correctly prevented the probe from exceeding
  the authority available in the repository. No pseudocode weakening is needed.

## Blocked measurements and production handoff

Because the approval gate failed before runtime use, none of the following has
been measured and none may be inferred from this green negative control:

- signed `ClaudeArtifactManifestV1` verification of every extracted file,
  declaration projection, bundled executable, target, adapter schema, and
  release signature;
- SDK `query()` compatibility, custom `spawnClaudeCodeProcess`, initialization
  projection, exact model selection, stream framing, backpressure, usage, result,
  interrupt, background-task snapshot, `close()`, or malformed protocol paths;
- scoped one-attempt broker issuance/revocation and broker-only network egress;
- deny-first tool permissions, unexpected approval behavior, sandbox hard-fail,
  settings/session isolation, and absence of ambient user/project state;
- the qualified Linux uid/cgroup/namespace/mount/network/resource profile,
  descendant inheritance, TERM/KILL escalation, zero-member proof, and residual
  injection; or
- backend-death fencing/recovery, credential revocation, repository quarantine,
  source-mapped production adapter code, diagnostics, and visible Theia E2E.

#97 must remain unavailable with `CLAUDE_LEGAL_APPROVAL_REQUIRED` until an
authorized maintainer supplies the exact signed approval record described in
#95. After that external authority change, qualification must rerun #96's full
real SDK/CLI/Linux/provider matrix on the exact approved artifact. It may validate
the existing topology or reopen the pseudocode, but it may not weaken the legal,
artifact, credential, confinement, process, cleanup, recovery, observability, or
human-E2E requirements merely to obtain a successful provider response.
