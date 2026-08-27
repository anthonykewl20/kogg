import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import type { CandidateBindingV1, ExecutionSealCode, SealCandidateV1 } from '../common/execution-protocol';
import { ControllerGitRunner } from './controller-git-runner';
import { executionLog } from './execution-logger';

// Candidate sealing reads only the stopped private repository, validates a closed mutation policy, and emits approved object identities without content-bearing logs.
// diagnostic-coverage: execution.git-independence, execution.source-integrity, execution.process-cleanup
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA1 = /^[0-9a-f]{40}$/u; const SHA256 = /^[0-9a-f]{64}$/u; const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const MAX_ENTRIES = 100_000; const MAX_OBJECT_BYTES = 100 * 1024 * 1024; const MAX_SYMLINKS = 1_000;
const MUTATION_POLICY_DIGEST = `sha256:${createHash('sha256').update('kogg-candidate-mutation-policy-v1').digest('hex')}`;

export class CandidateSealer {
  constructor(private readonly operations: OperationRegistryApi, private readonly git: ControllerGitRunner) {}

  async seal(request: SealCandidateV1): Promise<CandidateBindingV1> {
    validateRequest(request);
    const operation = await this.operations.startOperation({
      kind: 'worktree', correlations: { projectId: request.projectId, runId: request.runId, attemptId: request.attemptId, worktreeId: request.worktreeId }
    });
    operation.start(); operation.active();
    executionLog('seal.started', { eventVersion: 1, operationId: operation.id, runId: request.runId, attemptId: request.attemptId, worktreeId: request.worktreeId });
    try {
      const object = request.objectFormat === 'sha1' ? SHA1 : SHA256; const ref = runRef(request.runId);
      const [symbolicHead, heads, head, tree, status] = await Promise.all([
        this.run(operation, 'seal-head', request.privateRoot, ['symbolic-ref', '-q', 'HEAD']),
        this.run(operation, 'seal-head', request.privateRoot, ['for-each-ref', '--format=%(refname)', 'refs/heads']),
        this.run(operation, 'seal-head', request.privateRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
        this.run(operation, 'seal-tree', request.privateRoot, ['rev-parse', '--verify', 'HEAD^{tree}']),
        this.run(operation, 'seal-status', request.privateRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
      ]);
      const candidateCommit = text(head); const candidateTree = text(tree);
      if (text(symbolicHead) !== ref || text(heads) !== ref || !object.test(candidateCommit) || !object.test(candidateTree)) throw new SealError('SEAL_HEAD_INVALID');
      if (status.length) throw new SealError('SEAL_DIRTY');
      if (candidateCommit === request.baseCommit || candidateTree === request.baseTree) throw new SealError('SEAL_NO_CHANGE');
      const mergeBase = text(await this.run(operation, 'seal-history', request.privateRoot, ['merge-base', request.baseCommit, candidateCommit]));
      if (mergeBase !== request.baseCommit) throw new SealError('SEAL_ANCESTRY_INVALID');
      const merge = await this.run(operation, 'seal-history', request.privateRoot, ['rev-list', '--min-parents=2', '--max-count=1', `${request.baseCommit}..${candidateCommit}`]);
      if (merge.length) throw new SealError('SEAL_MERGE_COMMIT');
      await this.run(operation, 'seal-fsck', request.privateRoot, ['fsck', '--strict', '--full', '--no-reflogs']);
      const treeBytes = await this.run(operation, 'seal-tree-scan', request.privateRoot, ['ls-tree', '-rlz', '--full-tree', candidateCommit]);
      await this.verifyTree(operation, request, treeBytes);
      const closure = await this.run(operation, 'seal-object', request.privateRoot, ['rev-list', '--objects', '--no-object-names', `${request.baseCommit}..${candidateCommit}`]);
      const objectClosureDigest = closureDigest(closure, object);
      const sealedAt = new Date().toISOString(); const retentionUntil = '9999-12-31T23:59:59.999Z';
      await operation.cleanup(); operation.complete();
      executionLog('seal.completed', { eventVersion: 1, operationId: operation.id, runId: request.runId, attemptId: request.attemptId, worktreeId: request.worktreeId, candidateCommit, candidateTree });
      return {
        schemaVersion: 1, candidateId: randomUUID(), worktreeId: request.worktreeId, runId: request.runId,
        attemptId: request.attemptId, baseCommit: request.baseCommit, baseTree: request.baseTree,
        candidateCommit, candidateTree, objectClosureDigest, mutationPolicyDigest: MUTATION_POLICY_DIGEST,
        sealedAt, retentionClass: 'pending-evidence', retentionUntil, safeCode: 'SEAL_OK'
      };
    } catch (error) {
      await operation.cleanup().catch(() => { // observability-exempt: OperationRegistry logs and blocks admission for any cleanup failure.
        /* preserve the closed seal refusal */
      });
      operation.fail('PROCESS_EXIT_NONZERO', error instanceof Error ? error.name : 'UnknownError');
      const code = error instanceof SealError ? error.code : 'SEAL_FAILED';
      executionLog('seal.refused', { eventVersion: 1, operationId: operation.id, runId: request.runId, attemptId: request.attemptId, worktreeId: request.worktreeId, safeCode: code, errorType: error instanceof Error ? error.name : 'UnknownError' });
      throw new SealError(code);
    }
  }

  private run(operation: Parameters<ControllerGitRunner['run']>[0], phase: Parameters<ControllerGitRunner['run']>[1], root: string, args: readonly string[]): Promise<Buffer> {
    return this.git.run(operation, phase, root, this.git.protectedArguments(args));
  }

  private async verifyTree(operation: Parameters<ControllerGitRunner['run']>[0], request: SealCandidateV1, value: Buffer): Promise<void> {
    const records = splitZero(value); if (records.length > MAX_ENTRIES) throw new SealError('SEAL_MUTATION_POLICY');
    const decoder = new TextDecoder('utf-8', { fatal: true }); const collisionKeys = new Set<string>();
    const symlinks: { readonly objectId: string; readonly entryPath: string }[] = []; let totalBytes = 0n;
    for (const record of records) {
      const tab = record.indexOf(0x09); if (tab <= 0) throw new SealError('SEAL_OBJECT_INVALID');
      let header: string; let entryPath: string;
      try { header = decoder.decode(record.subarray(0, tab)); entryPath = decoder.decode(record.subarray(tab + 1)); }
      catch { // observability-exempt: Invalid path bytes are reduced to the closed mutation-policy refusal and never logged.
        throw new SealError('SEAL_MUTATION_POLICY');
      }
      const match = /^(100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+)$/u.exec(header);
      if (!match || entryPath.length === 0) throw new SealError('SEAL_MUTATION_POLICY');
      const mode = match[1]!; const objectId = match[2]!; const size = BigInt(match[3]!);
      if (size > BigInt(MAX_OBJECT_BYTES)) throw new SealError('SEAL_MUTATION_POLICY'); totalBytes += size;
      validateEntryPath(entryPath, collisionKeys);
      if (mode === '120000') { if (symlinks.length >= MAX_SYMLINKS || size > 4_096n) throw new SealError('SEAL_MUTATION_POLICY'); symlinks.push({ objectId, entryPath }); }
    }
    if (totalBytes > BigInt(request.maximumTreeBytes)) throw new SealError('SEAL_MUTATION_POLICY');
    for (const link of symlinks) {
      const targetBytes = await this.run(operation, 'seal-object', request.privateRoot, ['cat-file', 'blob', link.objectId]);
      let target: string; try { target = decoder.decode(targetBytes); }
      catch { // observability-exempt: Invalid symlink bytes are reduced to a closed refusal and never logged.
        throw new SealError('SEAL_MUTATION_POLICY');
      }
      if (!safeSymlink(link.entryPath, target)) throw new SealError('SEAL_MUTATION_POLICY');
    }
  }
}

export class SealError extends Error { constructor(readonly code: ExecutionSealCode) { super(code); this.name = 'SealError'; } }

function validateRequest(value: SealCandidateV1): void {
  const object = value?.objectFormat === 'sha1' ? SHA1 : SHA256;
  if (!value || Object.keys(value).sort().join(',') !== 'attemptId,baseCommit,baseTree,maximumTreeBytes,objectFormat,privateRoot,projectId,runId,worktreeId'
    || ![value.projectId, value.runId, value.attemptId, value.worktreeId].every(id => UUID.test(id)) || !path.isAbsolute(value.privateRoot)
    || !object.test(value.baseCommit) || !object.test(value.baseTree) || !boundedBytes(value.maximumTreeBytes)) throw new SealError('SEAL_FAILED');
}
function boundedBytes(value: string): boolean { if (!DECIMAL.test(value) || value === '0') return false; try { return BigInt(value) <= 10n * 1024n * 1024n * 1024n * 1024n; } catch { // observability-exempt: Invalid untrusted decimal input becomes a closed protocol refusal.
    return false; } }
function splitZero(value: Buffer): readonly Buffer[] { const records: Buffer[] = []; let start = 0; for (let index = 0; index < value.length; index++) if (value[index] === 0) { records.push(value.subarray(start, index)); start = index + 1; } if (start !== value.length) throw new SealError('SEAL_OBJECT_INVALID'); return records.filter(record => record.length > 0); }
function validateEntryPath(value: string, collisions: Set<string>): void {
  if (value !== value.normalize('NFC') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) throw new SealError('SEAL_MUTATION_POLICY');
  const segments = value.split('/'); if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git' || /[ .]$/u.test(segment) || /[:*?"<>|]/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) throw new SealError('SEAL_MUTATION_POLICY');
  const collision = value.normalize('NFC').toLocaleLowerCase('en-US'); if (collisions.has(collision)) throw new SealError('SEAL_MUTATION_POLICY'); collisions.add(collision);
}
function safeSymlink(entryPath: string, target: string): boolean { if (!target || target.includes('\0') || target.includes('\\') || path.posix.isAbsolute(target)) return false; const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target)); return resolved !== '..' && !resolved.startsWith('../') && !path.posix.isAbsolute(resolved); }
function closureDigest(value: Buffer, object: RegExp): string { const ids = value.toString('ascii').split(/\r?\n/u).filter(Boolean); if (!ids.length || ids.length > MAX_ENTRIES || ids.some(id => !object.test(id)) || new Set(ids).size !== ids.length) throw new SealError('SEAL_OBJECT_INVALID'); ids.sort(); return `sha256:${createHash('sha256').update(`kogg-candidate-object-closure-v1\0${ids.join('\n')}`).digest('hex')}`; }
function runRef(runId: string): string { return `refs/heads/kogg-run/${runId.replaceAll('-', '')}`; }
function text(value: Buffer): string { return value.toString('utf8').trim(); }
