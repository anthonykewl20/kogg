import assert from 'node:assert/strict';
import test from 'node:test';
import type { CandidateBindingV1, CandidateImportIntentV1, ImportedCandidateV1, RecordSealedCandidateV1 } from '../common/execution-protocol';
import { CandidateLifecycleController, type GovernedImportRequest, type GovernedSealRequest } from './candidate-lifecycle-controller';
import { ImportError } from './candidate-importer';

// diagnostic-coverage: execution.source-integrity, execution.worktree-registry, execution.recovery
test('orders durable seal and import commits around the external candidate boundaries', async () => {
  const calls: string[] = []; const candidate = sealed(); const imported = { ...candidate, quarantineRefDigest: `sha256:${'4'.repeat(64)}`, safeCode: 'IMPORT_OK' as const } as ImportedCandidateV1;
  const controller = new CandidateLifecycleController({
    recordSeal: async (request: RecordSealedCandidateV1) => { calls.push(`seal-record:${request.candidate.candidateId}`); return request.candidate; },
    prepareCandidateImport: async () => { calls.push('intent-record'); return intent(false); },
    completeCandidateImport: async () => { calls.push('import-record'); return imported; }
  } as never, { seal: async () => { calls.push('seal-inspect'); return candidate; } }, { import: async () => { calls.push('import-cas'); return imported; } });
  assert.deepEqual(await controller.seal(sealRequest()), candidate); assert.deepEqual(await controller.import(importRequest(candidate)), imported);
  assert.deepEqual(calls, [`seal-inspect`, `seal-record:${candidate.candidateId}`, 'intent-record', 'import-cas', 'import-record']);
});

test('never repeats an external import for a replayed ambiguous intent', async () => {
  let imports = 0; const candidate = sealed(); const controller = new CandidateLifecycleController({ prepareCandidateImport: async () => intent(true) } as never, {} as never, { import: async () => { imports++; throw new Error('must not run'); } });
  await assert.rejects(() => controller.import(importRequest(candidate)), (error: unknown) => error instanceof ImportError && error.code === 'IMPORT_FAILED'); assert.equal(imports, 0);
});

function sealed(): CandidateBindingV1 { return { schemaVersion: 1, candidateId: '10000000-0000-4000-8000-000000000001', worktreeId: '10000000-0000-4000-8000-000000000002', runId: '10000000-0000-4000-8000-000000000003', attemptId: '10000000-0000-4000-8000-000000000004', baseCommit: 'a'.repeat(40), baseTree: 'b'.repeat(40), candidateCommit: 'c'.repeat(40), candidateTree: 'd'.repeat(40), objectClosureDigest: `sha256:${'1'.repeat(64)}`, mutationPolicyDigest: `sha256:${'2'.repeat(64)}`, sealedAt: '2026-08-27T00:00:00.000Z', retentionClass: 'pending-evidence', retentionUntil: '9999-12-31T23:59:59.999Z', safeCode: 'SEAL_OK' }; }
function intent(replay: boolean): CandidateImportIntentV1 { return { schemaVersion: 1, intentId: '10000000-0000-4000-8000-000000000005', worktreeId: '10000000-0000-4000-8000-000000000002', candidateId: '10000000-0000-4000-8000-000000000001', fencingToken: '3'.repeat(64), phase: 'requested', replay, safeCode: 'IMPORT_OK' }; }
function sealRequest(): GovernedSealRequest { return { requestId: '10000000-0000-4000-8000-000000000006', expectedRevision: '8', bindingDigest: `sha256:${'5'.repeat(64)}`, seal: { projectId: '10000000-0000-4000-8000-000000000007', runId: '10000000-0000-4000-8000-000000000003', attemptId: '10000000-0000-4000-8000-000000000004', worktreeId: '10000000-0000-4000-8000-000000000002', privateRoot: '/private/root', baseCommit: 'a'.repeat(40), baseTree: 'b'.repeat(40), objectFormat: 'sha1', maximumTreeBytes: '1024' } }; }
function importRequest(candidate: CandidateBindingV1): GovernedImportRequest { return { intentRequestId: '10000000-0000-4000-8000-000000000008', completionRequestId: '10000000-0000-4000-8000-000000000009', expectedRevision: '9', bindingDigest: `sha256:${'5'.repeat(64)}`, expectedSourceIdentityDigest: `sha256:${'6'.repeat(64)}`, candidateImport: { projectId: '10000000-0000-4000-8000-000000000007', repositoryId: '10000000-0000-4000-8000-00000000000a', sourceRoot: '/source', sourceGitDirectory: '/source/.git', privateRoot: '/allocation/private', bundlePath: '/allocation/candidate.bundle', expectedSourceHead: 'a'.repeat(40), expectedSourceTree: 'b'.repeat(40), objectFormat: 'sha1', candidate } }; }
