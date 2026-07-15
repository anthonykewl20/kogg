# Lean GitHub Actions for the private fork

## Evidence

The inherited automation was designed for the much busier upstream repository,
not Kogg's private-fork budget. Opening issues #21-#37 created 85 workflow
records: 17 real Qwen Triage jobs totaling 287 raw runner-seconds and 68 skipped
records. The nightly E2E workflow allocated four jobs: macOS took about 37
minutes, while the Ubuntu jobs took about 7, 75, and 75 minutes. A scheduled
CodeQL scan consumed about 30 minutes. Much of that work either failed because
upstream-only credentials or infrastructure were absent, or repeated checks
that did not protect a Kogg pull request.

## Decision

Pull requests to `development` run one hosted Ubuntu test job after a five-minute
classifier. The test job is capped at 30 minutes. Upstream-only browser, macOS,
Windows, coverage-comment, and live integration jobs retain their upstream
behavior but are guarded by `github.repository == 'QwenLM/qwen-code'`. The
upstream ECS runner can never be selected in Kogg.

E2E, CodeQL, stale processing, releases, and nine inherited Qwen automation
workflows are manual-only. Manual E2E defaults to a 15-minute Ubuntu smoke that
builds, bundles, and invokes `node dist/cli.js --version`. A maintainer can
explicitly select `full` to run the Linux none/docker suites, macOS suite, and
web-shell browser regression with 30/20/15-minute caps. Duplicate runs of the
same E2E profile cancel in progress.

The bounded Kogg pull-request maximum is therefore five classifier minutes plus
30 substantive test minutes. Skipped jobs do not allocate runners. Manual E2E
has a 15-minute smoke default; full remains intentionally expensive and must be
chosen explicitly.

## Tradeoff and manual use

Removing schedules reduces unattended security and regression freshness.
Maintainers should run CodeQL before security-sensitive releases and run E2E
with `smoke` for bundle confidence or `full` for platform, sandbox, and browser
coverage. Releases remain explicit and dry-run by default. A centralized policy
test scans every tracked workflow so inherited automatic triggers or missing
cost guards cannot return unnoticed.
