import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflowPath = new URL(
  '../../workflows/development-ci.yml',
  import.meta.url,
);

function readWorkflow() {
  return readFileSync(workflowPath, 'utf8');
}

test('runs only for development branch changes and manual dispatches', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /push:\n\s+branches:\n\s+- 'development'/);
  assert.match(workflow, /pull_request:\n\s+branches:\n\s+- 'development'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /branches:\n\s+- 'main'/);
});

test('keeps the development gate lean and read-only', () => {
  const workflow = readWorkflow();
  const jobsSection = workflow.slice(workflow.indexOf('\njobs:\n'));
  const jobs = jobsSection.match(/^ {2}[a-zA-Z0-9_-]+:$/gm) ?? [];

  assert.equal(jobs.length, 1);
  assert.match(workflow, /permissions:\n {2}contents: 'read'/);
  assert.match(workflow, /runs-on: 'ubuntu-latest'/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.doesNotMatch(workflow, /matrix:/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /publish|deploy|release/i);
});

test('checks quality and the core terminal runtime without heavy CI jobs', () => {
  const workflow = readWorkflow();

  for (const command of [
    'npm run check:lockfile',
    'npm run lint:ci',
    'npm run build -- --cli-only',
    'npm run typecheck --workspace=@qwen-code/qwen-code-core --workspace=@qwen-code/qwen-code',
    'npm run test:ci --workspace=@qwen-code/qwen-code-core --workspace=@qwen-code/qwen-code -- --coverage.enabled=false',
    'npm run test:scripts',
  ]) {
    assert.ok(workflow.includes(command), `missing workflow command: ${command}`);
  }

  assert.match(workflow, /node-version: '22\.x'/);
  assert.match(workflow, /QWEN_SKIP_PREPARE: '1'/);
  assert.match(workflow, /npm ci --prefer-offline --no-audit --progress=false/);
  assert.match(workflow, /HOME: '\$\{\{ runner\.temp \}\}\/kogg-ci-home'/);
  for (const variable of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'DASHSCOPE_API_KEY',
    'QWEN_API_KEY',
    'GEMINI_API_KEY',
    'QWEN_DEFAULT_AUTH_TYPE',
  ]) {
    assert.equal(
      workflow.match(new RegExp(`${variable}: ''`, 'g'))?.length,
      2,
      `${variable} must be cleared for both test steps`,
    );
  }
  assert.doesNotMatch(workflow, /test:e2e|docker|podman|audit:runtime/);
});
