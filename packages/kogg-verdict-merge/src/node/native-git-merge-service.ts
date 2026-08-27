import { spawn } from 'node:child_process';
import { constants as fsConstants, existsSync } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ILogger } from '@theia/core/lib/common/logger';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, named, unmanaged } from '@theia/core/shared/inversify';
import { KoggOperationRegistry, type OperationLease, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { ProjectBindingAuthority, type ProjectBindingAuthority as BindingAuthority } from '@kogg/projects/lib/common/projects-protocol';
import { MergeAuthorizationRegistry, type MergeLifecycleState, type PrivateMergeIntent } from './merge-authorization-registry';

// Native Git owns merge calculation and the single exact ref CAS; Kogg never reads repository content into logs.
// diagnostic-coverage: merge.preflight, merge.processes, merge.atomicity, merge.recovery
@injectable()
export class NativeGitMergeService implements BackendApplicationContribution {
  private readonly active = new Set<string>();

  constructor(
    @inject(MergeAuthorizationRegistry) private readonly registry: MergeAuthorizationRegistry,
    @inject(ProjectBindingAuthority) private readonly projects: BindingAuthority,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
    @inject(ILogger) @named('kogg:merge:git') private readonly logger: ILogger,
    @unmanaged() private readonly timeoutMs = 15_000
  ) {}

  async onStart(): Promise<void> {
    const candidates = this.registry.recoveryCandidates();
    console.info('[kogg:merge:recovery] recovery.started', { candidateCount: candidates.length });
    for (const candidate of candidates) await this.recover(candidate.intent, candidate.state, candidate.expectedMergeOid);
    console.info('[kogg:merge:recovery] recovery.completed', { candidateCount: candidates.length });
  }

  start(mergeId: string): void {
    if (this.active.has(mergeId)) return;
    this.logger.info('merge.scheduled', { mergeId });
    this.active.add(mergeId);
    void this.execute(mergeId).finally(() => this.active.delete(mergeId));
  }

  async execute(mergeId: string): Promise<void> {
    const intent = this.registry.pendingIntent(mergeId);
    if (!intent?.projectId || !intent.repositoryId) return;
    const operation = await this.operations.startOperation({ kind: 'merge', cancellable: false, absoluteTimeoutMs: 120_000, correlations: { projectId: intent.projectId, taskId: intent.taskId } });
    operation.start();
    let state: string = 'preflight-pending';
    try {
      this.registry.transitionMerge(mergeId, 'preflighting', state); state = 'preflighting';
      console.info('[kogg:merge:preflight] preflight.started', { mergeId, operationId: operation.id });
      const binding = await this.projects.resolveBinding(intent.projectId, intent.repositoryId);
      if (!binding?.available || !binding.active || normalizeDigest(binding.repositoryIdentityDigest) !== normalizeDigest(intent.repositoryIdentityDigest)) throw new MergeGitError('GIT_REPOSITORY_UNQUALIFIED');
      const root = await realpath(fileURLToPath(binding.rootUri));
      const git = (args: readonly string[], input?: string) => this.git(root, args, operation, input);
      await this.qualify(root, git);
      await this.requireCurrent(intent);
      const destination = oneLine(await git(['rev-parse', '--verify', intent.destinationRef]));
      if (destination !== intent.expectedOldOid) throw new MergeGitError('PREFLIGHT_REF_DRIFT');
      const [baseType, subjectType, subjectTree, mergeBases] = await Promise.all([
        git(['cat-file', '-t', intent.expectedOldOid]), git(['cat-file', '-t', intent.subjectOid]),
        git(['rev-parse', `${intent.subjectOid}^{tree}`]), git(['merge-base', '--all', intent.expectedOldOid, intent.subjectOid])
      ]);
      if (oneLine(baseType) !== 'commit' || oneLine(subjectType) !== 'commit' || oneLine(subjectTree) !== intent.expectedTreeOid) throw new MergeGitError('GIT_OBJECT_INVALID');
      const bases = lines(mergeBases); if (bases.length !== 1) throw new MergeGitError('GIT_REPOSITORY_UNQUALIFIED');
      this.registry.transitionMerge(mergeId, 'constructing', state); state = 'constructing';
      console.info('[kogg:merge:preflight] preflight.completed', { mergeId, operationId: operation.id });
      const mergeTree = await git(['merge-tree', '--write-tree', '--messages', '--merge-base', bases[0]!, intent.expectedOldOid, intent.subjectOid]);
      const tree = lines(mergeTree)[0]; if (!tree || !oid(tree) || lines(mergeTree).length !== 1) throw new MergeGitError('GIT_CONFLICT');
      const commit = oneLine(await this.git(root, ['commit-tree', tree, '-p', intent.expectedOldOid, '-p', intent.subjectOid], operation, 'Kogg controlled merge\n', intent.createdAt));
      if (!oid(commit)) throw new MergeGitError('GIT_OUTPUT_INVALID');
      await this.verifyCommit(git, commit, tree, intent);
      this.registry.transitionMerge(mergeId, 'cas-ready', state, commit); state = 'cas-ready';
      console.info('[kogg:merge:atomicity] construction.completed', { mergeId, operationId: operation.id });
      await this.requireCurrent(intent);
      if (oneLine(await git(['rev-parse', '--verify', intent.destinationRef])) !== intent.expectedOldOid) throw new MergeGitError('REF_CAS_CONFLICT');
      this.registry.transitionMerge(mergeId, 'cas-started', state, commit); state = 'cas-started';
      console.info('[kogg:merge:atomicity] cas.started', { mergeId, operationId: operation.id });
      await git(['update-ref', intent.destinationRef, commit, intent.expectedOldOid]);
      this.registry.transitionMerge(mergeId, 'post-verifying', state, commit); state = 'post-verifying';
      console.info('[kogg:merge:atomicity] postverify.started', { mergeId, operationId: operation.id });
      if (oneLine(await git(['rev-parse', '--verify', intent.destinationRef])) !== commit) throw new MergeGitError('MERGE_OUTCOME_UNKNOWN');
      await this.verifyCommit(git, commit, tree, intent); await this.requireCurrentAfterCas(intent, commit, git);
      this.registry.transitionMerge(mergeId, 'committed', state, commit); state = 'committed';
      console.info('[kogg:merge:atomicity] postverify.completed', { mergeId, operationId: operation.id });
      this.registry.transitionMerge(mergeId, 'cleaning', state, commit); state = 'cleaning';
      await operation.cleanup();
      this.registry.transitionMerge(mergeId, 'completed', state, commit); operation.complete();
      console.info('[kogg:merge:service] completed', { mergeId, operationId: operation.id, safeCode: 'MERGE_COMPLETED' });
    } catch (error) {
      await operation.cleanup().catch(() => undefined);
      const afterCas = ['cas-started', 'post-verifying', 'committed', 'cleaning'].includes(state);
      const terminal: MergeLifecycleState = afterCas ? 'recovery-required' : 'refused';
      try { this.registry.transitionMerge(mergeId, terminal, state); } catch { /* observability-exempt: the durable prior state remains the recovery authority. */ }
      operation.fail(error instanceof MergeGitError && error.safeCode === 'GIT_PROCESS_FAILED' ? 'PROCESS_EXIT_NONZERO' : 'OPERATIONS_REFUSED', errorName(error));
      const fields = { mergeId, operationId: operation.id, safeCode: error instanceof MergeGitError ? error.safeCode : 'INTERNAL_FAILURE', errorType: errorName(error) };
      if (afterCas) console.warn('[kogg:merge:recovery] recovery.required', fields);
      else console.warn('[kogg:merge:preflight] preflight.refused', fields);
    }
  }

  activeCount(): number { return this.active.size; }
  diagnostics(): { readonly activeCount: number; readonly sourceMapsPresent: boolean } { return { activeCount: this.active.size, sourceMapsPresent: existsSync(`${__filename}.map`) }; }

  private async qualify(root: string, git: (args: readonly string[]) => Promise<string>): Promise<void> {
    const [bare, shallow, replacements, localConfig, gitDirRaw] = await Promise.all([
      git(['rev-parse', '--is-bare-repository']), git(['rev-parse', '--is-shallow-repository']),
      git(['for-each-ref', '--format=%(refname)', 'refs/replace/']), git(['config', '--local', '--name-only', '--list']), git(['rev-parse', '--absolute-git-dir'])
    ]);
    const safeConfig = new Set(['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode']);
    if (oneLine(bare) !== 'false' || oneLine(shallow) !== 'false' || replacements.trim() || lines(localConfig).some(key => !safeConfig.has(key))) throw new MergeGitError('GIT_REPOSITORY_UNQUALIFIED');
    const gitDir = await realpath(oneLine(gitDirRaw));
    if (!gitDir.startsWith(`${root}${path.sep}`) && gitDir !== path.join(root, '.git')) throw new MergeGitError('GIT_REPOSITORY_UNQUALIFIED');
    for (const relative of ['info/grafts', 'objects/info/alternates']) {
      try { await access(path.join(gitDir, relative), fsConstants.F_OK); throw new MergeGitError('GIT_REPOSITORY_UNQUALIFIED'); } catch (error) { if (error instanceof MergeGitError) throw error; }
    }
  }

  private async recover(intent: PrivateMergeIntent, state: string, expectedMergeOid?: string): Promise<void> {
    if (!intent.projectId || !intent.repositoryId) { this.registry.transitionMerge(intent.mergeId, 'quarantined', state); return; }
    const operation = await this.operations.startOperation({ kind: 'recovery', cancellable: false, absoluteTimeoutMs: 60_000, correlations: { projectId: intent.projectId, taskId: intent.taskId } }); operation.start();
    console.info('[kogg:merge:recovery] process.reconciled', { mergeId: intent.mergeId, operationId: operation.id, activeProcessCount: 0 });
    try {
      const binding = await this.projects.resolveBinding(intent.projectId, intent.repositoryId);
      if (!binding?.available || normalizeDigest(binding.repositoryIdentityDigest) !== normalizeDigest(intent.repositoryIdentityDigest)) throw new MergeGitError('MERGE_OUTCOME_UNKNOWN');
      const root = await realpath(fileURLToPath(binding.rootUri)); const git = (args: readonly string[]) => this.git(root, args, operation);
      await this.qualify(root, git);
      const observed = oneLine(await git(['rev-parse', '--verify', intent.destinationRef]));
      if (observed === intent.expectedOldOid) {
        this.registry.transitionMerge(intent.mergeId, 'refused', state);
        await operation.cleanup(); operation.complete();
        console.info('[kogg:merge:recovery] not-committed', { mergeId: intent.mergeId, operationId: operation.id, safeCode: 'MERGE_NOT_COMMITTED' }); return;
      }
      if (expectedMergeOid && observed === expectedMergeOid) {
        await this.verifyRecoveredCommit(git, expectedMergeOid, intent);
        this.registry.transitionMerge(intent.mergeId, 'post-verifying', state, expectedMergeOid);
        this.registry.transitionMerge(intent.mergeId, 'committed', 'post-verifying', expectedMergeOid);
        this.registry.transitionMerge(intent.mergeId, 'cleaning', 'committed', expectedMergeOid);
        await operation.cleanup(); this.registry.transitionMerge(intent.mergeId, 'completed', 'cleaning', expectedMergeOid); operation.complete();
        console.info('[kogg:merge:recovery] committed', { mergeId: intent.mergeId, operationId: operation.id, safeCode: 'MERGE_COMPLETED' }); return;
      }
      throw new MergeGitError('MERGE_OUTCOME_UNKNOWN');
    } catch (error) {
      await operation.cleanup().catch(() => undefined);
      try { this.registry.transitionMerge(intent.mergeId, 'quarantined', this.registry.mergeState(intent.mergeId), expectedMergeOid); } catch { /* observability-exempt: an already terminal durable state remains authoritative. */ }
      operation.fail('RECOVERY_FAILED', errorName(error));
      console.error('[kogg:merge:recovery] quarantined', { mergeId: intent.mergeId, operationId: operation.id, safeCode: 'MERGE_QUARANTINED', errorType: errorName(error) });
    }
  }

  private async requireCurrent(intent: PrivateMergeIntent): Promise<void> { if (!await this.registry.revalidateIntent(intent)) throw new MergeGitError('VERDICT_STALE'); }
  private async requireCurrentAfterCas(intent: PrivateMergeIntent, commit: string, git: (args: readonly string[]) => Promise<string>): Promise<void> {
    const binding = await this.projects.resolveBinding(intent.projectId!, intent.repositoryId!);
    if (!binding?.available || normalizeDigest(binding.repositoryIdentityDigest) !== normalizeDigest(intent.repositoryIdentityDigest)
      || oneLine(await git(['rev-parse', '--verify', intent.destinationRef])) !== commit) throw new MergeGitError('MERGE_OUTCOME_UNKNOWN');
  }
  private async verifyCommit(git: (args: readonly string[]) => Promise<string>, commit: string, tree: string, intent: PrivateMergeIntent): Promise<void> {
    const raw = await git(['cat-file', '-p', commit]); const headers = raw.split('\n\n', 1)[0]!.split('\n');
    if (headers[0] !== `tree ${tree}` || headers[1] !== `parent ${intent.expectedOldOid}` || headers[2] !== `parent ${intent.subjectOid}`
      || !headers[3]?.startsWith('author Kogg <kogg@localhost.invalid> ') || !headers[4]?.startsWith('committer Kogg <kogg@localhost.invalid> ')
      || !raw.endsWith('\n\nKogg controlled merge\n')) throw new MergeGitError('GIT_OBJECT_INVALID');
  }
  private async verifyRecoveredCommit(git: (args: readonly string[]) => Promise<string>, commit: string, intent: PrivateMergeIntent): Promise<void> {
    const raw = await git(['cat-file', '-p', commit]); const tree = raw.split('\n', 1)[0]?.slice(5);
    if (!tree || !oid(tree)) throw new MergeGitError('GIT_OBJECT_INVALID');
    await this.verifyCommit(git, commit, tree, intent);
  }

  private async git(root: string, args: readonly string[], operation: OperationLease, input?: string, timestamp?: string): Promise<string> {
    let child: ReturnType<typeof spawn> | undefined;
    const lease = operation.registerProcess({ kind: 'git', owner: 'kogg-supervisor', cancel: async () => { child?.kill('SIGKILL'); } });
    lease.spawning();
    console.info('[kogg:merge:process] process.registered', { operationId: operation.id, processId: lease.id });
    return new Promise((resolve, reject) => {
      let output = Buffer.alloc(0); let errorBytes = 0; let settled = false; let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); lease.cleanup(); error ? reject(error) : resolve(output.toString('utf8')); };
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C', TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false', GIT_OPTIONAL_LOCKS: '0' };
      if (timestamp) Object.assign(env, { GIT_AUTHOR_NAME: 'Kogg', GIT_AUTHOR_EMAIL: 'kogg@localhost.invalid', GIT_COMMITTER_NAME: 'Kogg', GIT_COMMITTER_EMAIL: 'kogg@localhost.invalid', GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp });
      try {
        child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'credential.helper=', '-c', 'core.fsmonitor=false', ...args], { cwd: root, detached: process.platform !== 'win32', env, stdio: ['pipe', 'pipe', 'pipe'] });
        if (child.pid) lease.started(child.pid); console.info('[kogg:merge:process] started', { operationId: operation.id, processId: lease.id });
        child.stdout!.on('data', chunk => { lease.activity(); output = Buffer.concat([output, Buffer.from(chunk)]); if (output.length > 256 * 1024) child?.kill('SIGKILL'); });
        child.stderr!.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 256 * 1024) child?.kill('SIGKILL'); });
        child.once('error', () => { lease.failed('PROCESS_SPAWN_FAILED', 'GitSpawnError'); finish(new MergeGitError('GIT_PROCESS_FAILED')); });
        child.once('close', (code, signal) => { lease.exited(code === 0 ? 'zero' : signal ? 'signal' : 'nonzero'); console.info('[kogg:merge:process] exit', { operationId: operation.id, processId: lease.id, exitClass: code === 0 ? 'zero' : signal ? 'signal' : 'nonzero' }); if (code === 0 && output.length <= 256 * 1024 && errorBytes <= 256 * 1024) finish(); else finish(new MergeGitError('GIT_PROCESS_FAILED')); });
        child.stdin!.end(input);
      } catch { lease.failed('PROCESS_SPAWN_FAILED', 'GitSpawnError'); console.error('[kogg:merge:process] spawn.failed', { operationId: operation.id, processId: lease.id, errorType: 'GitSpawnError' }); finish(new MergeGitError('GIT_PROCESS_FAILED')); }
      if (!settled) timer = setTimeout(() => { child?.kill('SIGKILL'); console.warn('[kogg:merge:process] timeout', { operationId: operation.id, processId: lease.id }); finish(new MergeGitError('GIT_PROCESS_FAILED')); }, this.timeoutMs);
    });
  }
}

export class MergeGitError extends Error { constructor(readonly safeCode: 'VERDICT_STALE' | 'PREFLIGHT_REF_DRIFT' | 'GIT_REPOSITORY_UNQUALIFIED' | 'GIT_CONFLICT' | 'GIT_PROCESS_FAILED' | 'GIT_OUTPUT_INVALID' | 'GIT_OBJECT_INVALID' | 'REF_CAS_CONFLICT' | 'MERGE_OUTCOME_UNKNOWN') { super(safeCode); this.name = 'MergeGitError'; } }
function oneLine(value: string): string { const result = lines(value); if (result.length !== 1) throw new MergeGitError('GIT_OUTPUT_INVALID'); return result[0]!; }
function lines(value: string): string[] { return value.trim().split(/\r?\n/gu).filter(Boolean); }
function oid(value: string): boolean { return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value); }
function normalizeDigest(value: string): string { return value.startsWith('sha256:') ? value.slice(7) : value; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
