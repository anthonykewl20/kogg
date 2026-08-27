import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { EvidenceAdmissionProjectionV1, EvidenceManifestV1, GateEvaluationExpectationV1, GateEvaluationProjectionV1, KernelBridge, KernelResultV2, RepositoryStateV1, TaskBindingProjectionV1, TaskExecutionBindingV1, VerdictReadExpectationV1, VerdictReadProjectionV1 } from '@kogg/contracts';
import { OperationRegistry } from '@kogg/operations/lib/node/operation-registry';
import type { TaskAdmissionSnapshot, TaskKernelBindingAuthority, TaskKernelAuthoritySnapshot } from '@kogg/tasks/lib/common/tasks-protocol';
import type { ILogger } from '@theia/core/lib/common/logger';
import { ProcessManager } from '@theia/process/lib/node/process-manager';
import { KernelTaskBindingService } from './kernel-task-binding-service';
import { KernelRepositoryStateAuthority } from './kernel-repository-state-authority';
import { KernelEvidenceAdmissionService } from './kernel-evidence-admission-service';
import { KernelGateEvaluationService } from './kernel-gate-evaluation-service';
import { KernelVerdictReadService } from './kernel-verdict-read-service';

test('measures a clean repository and binds only an exact live task authority snapshot', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-kernel-binding-test-'));
  const repository = path.join(temporary, 'repository');
  const state = path.join(temporary, 'state');
  const priorState = process.env.KOGG_STATE_DIR;
  process.env.KOGG_STATE_DIR = state;
  await mkdir(repository);
  execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Kogg Test'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'kogg@example.invalid'], { cwd: repository });
  await writeFile(path.join(repository, 'fixture.txt'), 'trusted fixture\n');
  execFileSync('git', ['add', 'fixture.txt'], { cwd: repository });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repository, stdio: 'ignore' });
  const gitDirectory = await realpath(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repository, encoding: 'utf8' }).trim());
  const repositoryIdentityDigest = createHash('sha256').update(`kogg-git-dir-v1\0${pathToFileURL(gitDirectory).href}`, 'utf8').digest('hex');
  const admission = fixtureAdmission();
  const authority = new FixtureTaskAuthority({
    taskId: admission.taskId, taskRevision: Number(admission.taskRevision), specificationDigest: `sha256:${'1'.repeat(64)}`,
    approvalId: admission.approvalId, approvalDigest: `sha256:${'2'.repeat(64)}`, approvalCreatedAt: '2026-08-27T00:00:00.000Z',
    projectId: admission.projectId, repositoryId: admission.repositoryId, bindingRevision: Number(admission.bindingRevision),
    runId: admission.runId, authorizedAt: admission.authorizedAt, expiresAt: admission.expiresAt,
    executionProfileId: 'restricted', rootUri: pathToFileURL(repository).href, repositoryIdentityDigest
  });
  const kernel = new FixtureKernel(); const operations = new OperationRegistry();
  try {
    await operations.onStart();
    const repositories = new KernelRepositoryStateAuthority(new ProcessManager(logger()), logger());
    const service = new KernelTaskBindingService(authority, kernel as unknown as KernelBridge, operations, repositories, logger());
    const result = await service.bind(admission);
    assert.equal(result.status, 'succeeded');
    assert.equal(kernel.binding?.protectedSource.isClean, true);
    assert.equal(kernel.binding?.protectedSource.commitObjectId.length, 40);
    assert.equal(kernel.binding?.repositoryIdentityDigest, `sha256:${repositoryIdentityDigest}`);
    assert.equal((await operations.snapshot()).active.length, 0);

    const evidenceService = new KernelEvidenceAdmissionService(authority, kernel as unknown as KernelBridge, operations, repositories, logger());
    const admitted = await evidenceService.admit(admission, fixtureEvidence());
    assert.equal(admitted.status, 'succeeded'); assert.equal(kernel.evidenceCalls, 1);
    assert.equal(kernel.currentSubject?.commitObjectId, kernel.binding?.protectedSource.commitObjectId);
    const gateService = new KernelGateEvaluationService(authority, kernel as unknown as KernelBridge, operations, repositories, logger());
    const evaluated = await gateService.evaluate(admission, fixtureGateExpectation());
    assert.equal(evaluated.projection?.decision, 'pass'); assert.equal(kernel.gateCalls, 1);
    const verdictService = new KernelVerdictReadService(authority, kernel as unknown as KernelBridge, operations, repositories, logger());
    const read = await verdictService.read(admission, fixtureVerdictRead());
    assert.equal(read.projection?.currentness, 'current'); assert.equal(kernel.verdictReadCalls, 1);

    await writeFile(path.join(repository, 'fixture.txt'), 'changed fixture\n');
    const staleEvidence = await evidenceService.admit(admission, fixtureEvidence());
    assert.equal(staleEvidence.safeCode, 'KERNEL_SUBJECT_STALE'); assert.equal(kernel.evidenceCalls, 1);
    const staleGate = await gateService.evaluate(admission, fixtureGateExpectation());
    assert.equal(staleGate.safeCode, 'KERNEL_VERDICT_STALE'); assert.equal(kernel.gateCalls, 1);
    const staleRead = await verdictService.read(admission, fixtureVerdictRead());
    assert.equal(staleRead.projection?.currentness, 'stale'); assert.equal(staleRead.projection?.currentDecision, null);
    const refused = await service.bind(admission);
    assert.equal(refused.safeCode, 'KERNEL_REPOSITORY_MISMATCH');
    assert.equal(kernel.calls, 1);
  } finally {
    await operations.onStop();
    if (priorState === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = priorState;
    await rm(temporary, { recursive: true, force: true });
  }
});

class FixtureTaskAuthority implements TaskKernelBindingAuthority {
  constructor(private readonly snapshot: TaskKernelAuthoritySnapshot) {}
  async resolveAdmission(admission: TaskAdmissionSnapshot): Promise<TaskKernelAuthoritySnapshot> {
    if (admission.runId !== this.snapshot.runId) throw new Error('stale');
    return this.snapshot;
  }
}

class FixtureKernel implements Partial<KernelBridge> {
  binding: TaskExecutionBindingV1 | undefined;
  currentSubject: RepositoryStateV1 | undefined;
  calls = 0;
  evidenceCalls = 0;
  gateCalls = 0;
  verdictReadCalls = 0;
  async bindTask(binding: TaskExecutionBindingV1): Promise<KernelResultV2<TaskBindingProjectionV1>> {
    this.binding = binding; this.calls += 1;
    return {
      protocol: 'kogg.ranex/v2', requestId: randomUUID(), operationId: randomUUID(), status: 'succeeded', safeCode: 'KERNEL_OK',
      resultDigest: `sha256:${'3'.repeat(64)}`, journal: { sequence: '1', rootDigest: `sha256:${'4'.repeat(64)}` },
      projection: { taskBindingDigest: `sha256:${'5'.repeat(64)}`, taskId: binding.taskId, taskRevision: binding.taskRevision }
    };
  }
  async admitEvidence(evidence: EvidenceManifestV1, currentSubject: RepositoryStateV1): Promise<KernelResultV2<EvidenceAdmissionProjectionV1>> {
    this.currentSubject = currentSubject; this.evidenceCalls += 1;
    return {
      protocol: 'kogg.ranex/v2', requestId: randomUUID(), operationId: randomUUID(), status: 'succeeded', safeCode: 'KERNEL_OK',
      resultDigest: `sha256:${'6'.repeat(64)}`, journal: { sequence: '5', rootDigest: `sha256:${'7'.repeat(64)}` },
      projection: { evidenceDigest: `sha256:${'8'.repeat(64)}`, evidenceId: evidence.evidenceId, claimType: evidence.claimType }
    };
  }
  async evaluateGate(expectation: GateEvaluationExpectationV1, currentSubject: RepositoryStateV1): Promise<KernelResultV2<GateEvaluationProjectionV1>> {
    this.currentSubject = currentSubject; this.gateCalls += 1;
    return {
      protocol: 'kogg.ranex/v2', requestId: randomUUID(), operationId: randomUUID(), status: 'succeeded', safeCode: 'KERNEL_OK',
      resultDigest: `sha256:${'a'.repeat(64)}`, journal: { sequence: '6', rootDigest: `sha256:${'b'.repeat(64)}` },
      projection: { verdictDigest: `sha256:${'c'.repeat(64)}`, verdictId: expectation.verdictId, decision: 'pass', evidenceCount: 1 }
    };
  }
  async readVerdict(expectation: VerdictReadExpectationV1, currentSubject: RepositoryStateV1): Promise<KernelResultV2<VerdictReadProjectionV1>> {
    this.currentSubject = currentSubject; this.verdictReadCalls += 1;
    const currentness = currentSubject.isClean ? 'current' : 'stale';
    return {
      protocol: 'kogg.ranex/v2', requestId: randomUUID(), operationId: randomUUID(), status: 'succeeded', safeCode: 'KERNEL_OK',
      resultDigest: `sha256:${'d'.repeat(64)}`, journal: null,
      projection: { verdictId: expectation.verdictId, verdictDigest: expectation.verdictDigest, historicalDecision: 'pass', currentness, currentDecision: currentness === 'current' ? 'pass' : null }
    };
  }
}

function fixtureVerdictRead(): VerdictReadExpectationV1 {
  return {
    verdictId: '88888888-8888-4888-8888-888888888888', verdictDigest: `sha256:${'c'.repeat(64)}`,
    taskBindingDigest: `sha256:${'1'.repeat(64)}`, subjectStateDigest: `sha256:${'3'.repeat(64)}`,
    gateCatalogDigest: `sha256:${'4'.repeat(64)}`, authorityDigest: `sha256:${'5'.repeat(64)}`,
    ranexProvenanceDigest: `sha256:${'6'.repeat(64)}`
  };
}

function fixtureEvidence(): EvidenceManifestV1 {
  return {
    evidenceId: '77777777-7777-4777-8777-777777777777', claimType: 'tests.unit', subjectStateDigest: `sha256:${'1'.repeat(64)}`,
    taskBindingDigest: `sha256:${'2'.repeat(64)}`, producerBindingDigest: `sha256:${'3'.repeat(64)}`, suiteDigest: `sha256:${'4'.repeat(64)}`,
    checkDefinitionDigest: `sha256:${'5'.repeat(64)}`, checkExecutionDigest: `sha256:${'6'.repeat(64)}`,
    resultArtifactDigest: `sha256:${'7'.repeat(64)}`, authorityDigest: `sha256:${'8'.repeat(64)}`,
    ranexProvenanceDigest: `sha256:${'9'.repeat(64)}`, createdAt: '2099-08-27T08:00:00.000Z'
  };
}

function fixtureGateExpectation(): GateEvaluationExpectationV1 {
  return {
    verdictId: '88888888-8888-4888-8888-888888888888', taskBindingDigest: `sha256:${'1'.repeat(64)}`,
    suiteDigest: `sha256:${'2'.repeat(64)}`, subjectStateDigest: `sha256:${'3'.repeat(64)}`, gateCatalogDigest: `sha256:${'4'.repeat(64)}`,
    requirements: [{ claimType: 'tests.unit', checkDefinitionDigest: `sha256:${'5'.repeat(64)}`, requiredOutcome: 'pass' }],
    authorityDigest: `sha256:${'6'.repeat(64)}`, ranexProvenanceDigest: `sha256:${'7'.repeat(64)}`, evaluatedAt: new Date().toISOString()
  };
}

function fixtureAdmission(): TaskAdmissionSnapshot {
  return {
    taskAdmissionId: '10000000-0000-4000-8000-000000000009', taskId: '11111111-1111-4111-8111-111111111111', specificationId: '22222222-2222-4222-8222-222222222222',
    approvalId: '33333333-3333-4333-8333-333333333333', projectId: '44444444-4444-4444-8444-444444444444',
    repositoryId: '55555555-5555-4555-8555-555555555555', bindingRevision: '1', registryRevision: '2', taskRevision: '3',
    runId: '66666666-6666-4666-8666-666666666666', authorizedAt: '2099-08-27T00:00:00.000Z', expiresAt: '2099-08-27T00:15:00.000Z'
  };
}

function logger(): ILogger { return { debug() {}, info() {}, warn() {}, error() {} } as unknown as ILogger; }
