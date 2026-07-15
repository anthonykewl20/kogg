# Lean private Actions verification plan

## Static verification

1. Run the centralized workflow policy Vitest and the affected workflow tests.
2. Run actionlint and yamllint through the repository lint helper.
3. Confirm the workflow diff has no automatic trigger for E2E, CodeQL, stale,
   release, or the nine inherited Qwen workflows.
4. Confirm Kogg cannot select `self-hosted`, each auxiliary CI job has the
   canonical-repository guard, and the classifier/test timeouts are 5/30.

## Live verification after landing

1. Open or update a pull request targeting `development`. Expect only the
   classifier and Ubuntu test path to allocate a runner; the upstream-only jobs
   must be skipped.
2. Dispatch E2E without changing inputs. Expect only `Bundled CLI Smoke`, with
   successful output from `node dist/cli.js --version`.
3. Dispatch E2E with `profile=full`. Expect smoke plus Linux none/docker,
   macOS, and web-shell browser jobs. Start a duplicate full run and confirm the
   older run is cancelled.
4. Observe the Actions page across the former schedule windows. Expect no
   automatic E2E, CodeQL, stale, release, or inherited Qwen runs.
5. Manually dispatch CodeQL when a security scan is desired and confirm its
   existing 30-minute timeout still applies.
