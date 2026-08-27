import { createHash } from 'node:crypto';
import { lstat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { OperationLease, OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import type { CandidateBindingV1, ExecutionImportCode, ImportedCandidateV1, ImportCandidateV1 } from '../common/execution-protocol';
import { CANDIDATE_MUTATION_POLICY_DIGEST } from './candidate-sealer';
import { ControllerGitRunner } from './controller-git-runner';
import { executionLog } from './execution-logger';

// Candidate import transfers one sealed object closure to an absent quarantine ref and proves all pre-existing source state remains byte-identical.
// diagnostic-coverage: execution.source-integrity, execution.git-independence, execution.process-cleanup
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA1 = /^[0-9a-f]{40}$/u; const SHA256 = /^[0-9a-f]{64}$/u; const DIGEST = /^sha256:[0-9a-f]{64}$/u;

interface SourceSnapshot { readonly symbolicHead: Buffer; readonly head: Buffer; readonly tree: Buffer; readonly status: Buffer; readonly config: Buffer; readonly refs: Buffer; readonly metadataDigest: string; }

export class CandidateImporter {
  constructor(private readonly operations: OperationRegistryApi, private readonly git: ControllerGitRunner) {}

  async import(request: ImportCandidateV1): Promise<ImportedCandidateV1> {
    validate(request);
    const candidate = request.candidate; const operation = await this.operations.startOperation({
      kind: 'worktree', correlations: { projectId: request.projectId, runId: candidate.runId, attemptId: candidate.attemptId, worktreeId: candidate.worktreeId }
    });
    operation.start(); operation.active();
    executionLog('import.started', { eventVersion: 1, operationId: operation.id, runId: candidate.runId, attemptId: candidate.attemptId, worktreeId: candidate.worktreeId });
    try {
      await absent(request.bundlePath);
      const before = await this.snapshot(operation, request.sourceRoot, request.sourceGitDirectory);
      if (text(before.head) !== request.expectedSourceHead || text(before.tree) !== request.expectedSourceTree) throw new ImportError('IMPORT_SOURCE_CHANGED');
      const privateRef = runRef(candidate.runId); const quarantineRef = quarantine(candidate.candidateId); const zero = '0'.repeat(request.objectFormat === 'sha1' ? 40 : 64);
      if (hasRef(before.refs, quarantineRef)) throw new ImportError('IMPORT_REF_EXISTS');
      await this.run(operation, 'import-bundle', request.privateRoot, ['bundle', 'create', request.bundlePath, privateRef, `^${candidate.baseCommit}`]);
      await this.run(operation, 'import-fetch', request.sourceRoot, ['fetch', '--no-tags', '--no-write-fetch-head', request.bundlePath, privateRef]);
      await this.verifyObjects(operation, request);
      await this.run(operation, 'import-ref', request.sourceRoot, ['update-ref', quarantineRef, candidate.candidateCommit, zero]);
      const after = await this.snapshot(operation, request.sourceRoot, request.sourceGitDirectory);
      if (!sameSnapshot(before, after, quarantineRef, candidate.candidateCommit)) throw new ImportError('IMPORT_SOURCE_INTEGRITY_FAILED');
      await unlink(request.bundlePath); await operation.cleanup(); operation.complete();
      executionLog('import.completed', { eventVersion: 1, operationId: operation.id, runId: candidate.runId, attemptId: candidate.attemptId, worktreeId: candidate.worktreeId, candidateCommit: candidate.candidateCommit, candidateTree: candidate.candidateTree });
      return { ...candidate, quarantineRefDigest: digestRef(quarantineRef), safeCode: 'IMPORT_OK' };
    } catch (error) {
      await unlink(request.bundlePath).catch(() => { // observability-exempt: A controller-only bundle residual is durably owned by the allocation recovery path.
        /* preserve the closed import refusal */
      });
      await operation.cleanup().catch(() => { // observability-exempt: OperationRegistry records cleanup failure and blocks admission.
        /* preserve the closed import refusal */
      });
      operation.fail('PROCESS_EXIT_NONZERO', error instanceof Error ? error.name : 'UnknownError');
      const code = error instanceof ImportError ? error.code : 'IMPORT_FAILED';
      executionLog('import.refused', { eventVersion: 1, operationId: operation.id, runId: candidate.runId, attemptId: candidate.attemptId, worktreeId: candidate.worktreeId, safeCode: code, errorType: error instanceof Error ? error.name : 'UnknownError' });
      throw new ImportError(code);
    }
  }

  private async snapshot(operation: OperationLease, root: string, gitDirectory: string): Promise<SourceSnapshot> {
    const values = await Promise.all([
      this.run(operation, 'import-source-snapshot', root, ['symbolic-ref', '-q', 'HEAD']),
      this.run(operation, 'import-source-snapshot', root, ['rev-parse', '--verify', 'HEAD^{commit}']),
      this.run(operation, 'import-source-snapshot', root, ['rev-parse', '--verify', 'HEAD^{tree}']),
      this.run(operation, 'import-source-snapshot', root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      this.run(operation, 'import-source-snapshot', root, ['config', '--local', '--null', '--list']),
      this.run(operation, 'import-source-snapshot', root, ['for-each-ref', '--format=%(refname) %(objectname)'])
    ]);
    return { symbolicHead: values[0]!, head: values[1]!, tree: values[2]!, status: values[3]!, config: values[4]!, refs: values[5]!, metadataDigest: await metadataDigest(gitDirectory) };
  }

  private async verifyObjects(operation: OperationLease, request: ImportCandidateV1): Promise<void> {
    const candidate = request.candidate; const object = request.objectFormat === 'sha1' ? SHA1 : SHA256;
    const [commit, tree, base, closure] = await Promise.all([
      this.run(operation, 'import-object', request.sourceRoot, ['rev-parse', '--verify', `${candidate.candidateCommit}^{commit}`]),
      this.run(operation, 'import-object', request.sourceRoot, ['rev-parse', '--verify', `${candidate.candidateCommit}^{tree}`]),
      this.run(operation, 'import-object', request.sourceRoot, ['merge-base', candidate.baseCommit, candidate.candidateCommit]),
      this.run(operation, 'import-object', request.sourceRoot, ['rev-list', '--objects', '--no-object-names', `${candidate.baseCommit}..${candidate.candidateCommit}`])
    ]);
    if (text(commit) !== candidate.candidateCommit || text(tree) !== candidate.candidateTree || text(base) !== candidate.baseCommit
      || closureDigest(closure, object) !== candidate.objectClosureDigest) throw new ImportError('IMPORT_CANDIDATE_INVALID');
    await this.run(operation, 'import-fsck', request.sourceRoot, ['fsck', '--strict', '--full', '--no-reflogs']);
  }

  private run(operation: OperationLease, phase: Parameters<ControllerGitRunner['run']>[1], root: string, args: readonly string[]): Promise<Buffer> {
    return this.git.run(operation, phase, root, this.git.protectedArguments(args));
  }
}

export class ImportError extends Error { constructor(readonly code: ExecutionImportCode) { super(code); this.name = 'ImportError'; } }

function validate(value: ImportCandidateV1): void {
  if (!value || Object.keys(value).sort().join(',') !== 'bundlePath,candidate,expectedSourceHead,expectedSourceTree,objectFormat,privateRoot,projectId,repositoryId,sourceGitDirectory,sourceRoot'
    || !UUID.test(value.projectId) || !UUID.test(value.repositoryId) || ![value.sourceRoot, value.sourceGitDirectory, value.privateRoot, value.bundlePath].every(item => path.isAbsolute(item))
    || value.sourceRoot === value.privateRoot || within(value.sourceRoot, value.privateRoot) || within(value.sourceRoot, value.bundlePath)
    || within(value.sourceGitDirectory, value.bundlePath) || within(value.privateRoot, value.sourceGitDirectory)
    || path.dirname(value.privateRoot) !== path.dirname(value.bundlePath)) throw new ImportError('IMPORT_PROTOCOL_INVALID');
  validateCandidate(value.candidate, value.objectFormat);
  const object = value.objectFormat === 'sha1' ? SHA1 : SHA256;
  if (!object.test(value.expectedSourceHead) || !object.test(value.expectedSourceTree)) throw new ImportError('IMPORT_PROTOCOL_INVALID');
}
function validateCandidate(value: CandidateBindingV1, format: 'sha1' | 'sha256'): void {
  const keys = ['attemptId', 'baseCommit', 'baseTree', 'candidateCommit', 'candidateId', 'candidateTree', 'mutationPolicyDigest', 'objectClosureDigest', 'retentionClass', 'retentionUntil', 'safeCode', 'schemaVersion', 'sealedAt', 'worktreeId', 'runId'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',') || value.schemaVersion !== 1 || value.safeCode !== 'SEAL_OK' || value.retentionClass !== 'pending-evidence'
    || ![value.candidateId, value.worktreeId, value.runId, value.attemptId].every(id => UUID.test(id)) || !DIGEST.test(value.objectClosureDigest)
    || value.mutationPolicyDigest !== CANDIDATE_MUTATION_POLICY_DIGEST) throw new ImportError('IMPORT_PROTOCOL_INVALID');
  const object = format === 'sha1' ? SHA1 : SHA256;
  if (![value.baseCommit, value.baseTree, value.candidateCommit, value.candidateTree].every(item => object.test(item))) throw new ImportError('IMPORT_PROTOCOL_INVALID');
}
function sameSnapshot(before: SourceSnapshot, after: SourceSnapshot, quarantineRef: string, candidateCommit: string): boolean {
  return before.symbolicHead.equals(after.symbolicHead) && before.head.equals(after.head) && before.tree.equals(after.tree)
    && before.status.equals(after.status) && before.config.equals(after.config)
    && before.metadataDigest === after.metadataDigest && expectedRefs(before.refs, quarantineRef, candidateCommit).equals(after.refs);
}
function expectedRefs(value: Buffer, quarantineRef: string, candidateCommit: string): Buffer {
  const records = value.toString('utf8').split('\n').filter(Boolean);
  if (records.some(record => !/^refs\/[A-Za-z0-9._\/-]+ (?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(record))) throw new ImportError('IMPORT_SOURCE_INTEGRITY_FAILED');
  records.push(`${quarantineRef} ${candidateCommit}`); records.sort(); return Buffer.from(`${records.join('\n')}\n`);
}
function hasRef(value: Buffer, ref: string): boolean { return value.toString('utf8').split('\n').some(record => record.startsWith(`${ref} `)); }
function closureDigest(value: Buffer, object: RegExp): string { const ids = value.toString('ascii').split(/\r?\n/u).filter(Boolean); if (!ids.length || ids.length > 100_000 || ids.some(id => !object.test(id)) || new Set(ids).size !== ids.length) throw new ImportError('IMPORT_CANDIDATE_INVALID'); ids.sort(); return `sha256:${createHash('sha256').update(`kogg-candidate-object-closure-v1\0${ids.join('\n')}`).digest('hex')}`; }
function quarantine(candidateId: string): string { return `refs/kogg/quarantine/${base32(candidateId)}`; }
function base32(id: string): string { const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'; const bytes = Buffer.from(id.replaceAll('-', ''), 'hex'); let bits = 0; let accumulator = 0; let output = ''; for (const byte of bytes) { accumulator = (accumulator << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; output += alphabet[(accumulator >>> bits) & 31]; } } if (bits) output += alphabet[(accumulator << (5 - bits)) & 31]; return output; }
function runRef(runId: string): string { return `refs/heads/kogg-run/${runId.replaceAll('-', '')}`; }
function digestRef(ref: string): string { return `sha256:${createHash('sha256').update(`kogg-quarantine-ref-v1\0${ref}`).digest('hex')}`; }
function text(value: Buffer): string { return value.toString('utf8').trim(); }
async function metadataDigest(gitDirectory: string): Promise<string> {
  const hash = createHash('sha256').update('kogg-source-metadata-snapshot-v1\0');
  for (const name of ['HEAD', 'config', 'index', 'packed-refs']) {
    const file = path.join(gitDirectory, name);
    try {
      const metadata = await lstat(file); if (!metadata.isFile() || metadata.size > 128 * 1024 * 1024) throw new ImportError('IMPORT_SOURCE_INTEGRITY_FAILED');
      hash.update(name).update('\0').update(await readFile(file)).update('\0');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update(name).update('\0missing\0');
    }
  }
  return `sha256:${hash.digest('hex')}`;
}
async function absent(value: string): Promise<void> { try { await lstat(value); throw new ImportError('IMPORT_FAILED'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
function within(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }
