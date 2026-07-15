/**
 * @license
 * Copyright 2026 Kogg Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const workflowPaths = execFileSync(
  'git',
  ['ls-files', '--', '.github/workflows/*.yml', '.github/workflows/*.yaml'],
  { cwd: repoRoot, encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .filter(Boolean);
const workflows = new Map(
  workflowPaths.map((workflowPath) => [
    path.basename(workflowPath),
    readFileSync(path.join(repoRoot, workflowPath), 'utf8'),
  ]),
);

const dispatchOnlyWorkflows = [
  'e2e.yml',
  'codeql.yml',
  'stale.yml',
  'release.yml',
  'qwen-triage.yml',
  'qwen-automated-issue-triage.yml',
  'qwen-autofix.yml',
  'qwen-issue-followup-bot.yml',
  'qwen-scheduled-issue-triage.yml',
  'gemini-scheduled-pr-triage.yml',
  'qwen-code-pr-review.yml',
  'check-issue-completeness.yml',
  'comment-attachment-guard.yml',
];

const approvedNonDispatchTriggers = new Map([
  ['audio-capture-prebuilds.yml', ['workflow_call']],
  ['build-and-publish-image.yml', ['push']],
  ['cd-cua-driver.yml', ['push']],
  ['cd-mobile-mcp.yml', ['push']],
  ['ci.yml', ['pull_request', 'merge_group']],
  ['docs-page-action.yml', ['push']],
  ['main-ci-failure-issue.yml', ['workflow_run']],
  ['pr-force-push-reminder.yml', ['pull_request_target']],
  ['qwen-pr-safety-precheck.yml', ['workflow_call']],
  ['release-vscode-companion.yml', ['release']],
  ['sdk-python.yml', ['pull_request', 'push']],
  ['sync-cua-driver-to-oss.yml', ['push']],
  ['sync-release-to-oss.yml', ['release']],
  ['terminal-bench.yml', ['push', 'release']],
]);

const canonicalGuardedAutomaticJobs = new Map([
  ['main-ci-failure-issue.yml', 'create_issue'],
  ['pr-force-push-reminder.yml', 'remind-on-force-push'],
  ['sync-cua-driver-to-oss.yml', 'sync'],
  ['sync-release-to-oss.yml', 'sync'],
]);

function topLevelBlock(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      line.length > 0 &&
      !line.startsWith(' ') &&
      line[0] !== '#',
  );
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function workflowTriggers(source) {
  return [...topLevelBlock(source, 'on').matchAll(/^ {2}([a-z_]+):/gm)].map(
    ([, trigger]) => trigger,
  );
}

function workflowJob(source, jobName) {
  const jobs = topLevelBlock(source, 'jobs');
  const marker = `\n  ${jobName}:`;
  const start = jobs.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const remainder = jobs.slice(start + marker.length);
  const next = remainder.search(/\n {2}[a-zA-Z0-9_-]+:\n/);
  return jobs.slice(
    start,
    next === -1 ? undefined : start + marker.length + next,
  );
}

describe('private GitHub Actions cost policy', () => {
  it('scans every tracked workflow and keeps inherited automation manual-only', () => {
    expect(workflowPaths.length).toBeGreaterThan(dispatchOnlyWorkflows.length);
    expect(workflowPaths).toEqual(
      expect.arrayContaining(
        dispatchOnlyWorkflows.map((name) => `.github/workflows/${name}`),
      ),
    );

    for (const name of dispatchOnlyWorkflows) {
      expect(workflowTriggers(workflows.get(name))).toEqual([
        'workflow_dispatch',
      ]);
    }
  });

  it('allows only the reviewed inventory of non-dispatch triggers', () => {
    const actual = new Map();
    for (const [name, workflow] of workflows) {
      const triggers = workflowTriggers(workflow).filter(
        (trigger) => trigger !== 'workflow_dispatch',
      );
      if (triggers.length > 0) {
        actual.set(name, triggers);
      }
    }

    expect(actual).toEqual(approvedNonDispatchTriggers);
  });

  it('guards canonical-only automatic jobs before runner allocation', () => {
    for (const [name, jobName] of canonicalGuardedAutomaticJobs) {
      const workflow = workflows.get(name);
      expect(
        workflowTriggers(workflow).filter(
          (trigger) => trigger !== 'workflow_dispatch',
        ),
      ).not.toHaveLength(0);
      expect(workflow.match(/^ {4}runs-on:/gm) ?? []).toHaveLength(1);
      expect(workflowJob(workflow, jobName)).toContain(
        "github.repository == 'QwenLM/qwen-code'",
      );
    }
  });

  it('keeps manual E2E bounded by profile, gates, and timeouts', () => {
    const workflow = workflows.get('e2e.yml');
    const on = topLevelBlock(workflow, 'on');
    const concurrency = topLevelBlock(workflow, 'concurrency');
    const smoke = workflowJob(workflow, 'smoke');
    const linux = workflowJob(workflow, 'e2e-test-linux');
    const macos = workflowJob(workflow, 'e2e-test-macos');
    const browser = workflowJob(workflow, 'web-shell-browser-regression');

    expect(on).toContain('profile:');
    expect(on).toContain('required: true');
    expect(on).toContain("default: 'smoke'");
    expect(on).toContain("type: 'choice'");
    expect(on).toContain("- 'smoke'");
    expect(on).toContain("- 'full'");
    expect(concurrency).toContain('inputs.profile');
    expect(concurrency).toContain('cancel-in-progress: true');

    expect(smoke).toContain("runs-on: 'ubuntu-latest'");
    expect(smoke).toContain('timeout-minutes: 15');
    expect(smoke).toContain('npm ci');
    expect(smoke).toContain('npm run build');
    expect(smoke).toContain('npm run bundle');
    expect(smoke).toContain('node dist/cli.js --version');

    for (const [job, timeout] of [
      [linux, 30],
      [macos, 20],
      [browser, 15],
    ]) {
      expect(job).toContain("inputs.profile == 'full'");
      expect(job).toContain(`timeout-minutes: ${timeout}`);
    }
  });

  it('bounds Kogg pull requests to one hosted substantive test job', () => {
    const workflow = workflows.get('ci.yml');
    const on = topLevelBlock(workflow, 'on');
    const classifier = workflowJob(workflow, 'classify_pr');
    const test = workflowJob(workflow, 'test');

    expect(on).toContain("- 'development'");
    expect(classifier).toContain("github.repository == ''QwenLM/qwen-code''");
    expect(classifier).toContain(
      'IS_CANONICAL: "${{ github.repository == \'QwenLM/qwen-code\' }}"',
    );
    expect(classifier).toContain('"${IS_CANONICAL}" == "true"');
    expect(classifier).toContain('timeout-minutes: 5');
    expect(test).toContain('timeout-minutes: 30');

    for (const jobName of [
      'web_shell_e2e_smoke',
      'post_coverage_comment',
      'test_macos',
      'test_windows',
      'integration_cli',
    ]) {
      expect(workflowJob(workflow, jobName)).toContain(
        "github.repository == 'QwenLM/qwen-code'",
      );
    }
  });
});
