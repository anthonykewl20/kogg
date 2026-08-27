import { spawn, type ChildProcessByStdio } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { OperationLease } from '@kogg/operations/lib/common/operations-protocol';
import type { ExecutionGitCode } from '../common/execution-protocol';

// Every controller Git call is registered before spawn, bounded, drained, and logged without argv, paths, output, or errors.
// diagnostic-coverage: execution.git-independence, execution.source-integrity, execution.process-cleanup
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u; const RUN_REF = /^refs\/heads\/kogg-run\/[0-9a-f]{32}$/u;
const QUARANTINE_REF = /^refs\/kogg\/quarantine\/[a-z2-7]{26}$/u;
export type ControllerGitPhase = 'source-head' | 'source-tree' | 'bundle-create' | 'private-init' | 'private-fetch' | 'private-ref' | 'private-checkout' | 'private-verify'
  | 'seal-head' | 'seal-tree' | 'seal-status' | 'seal-history' | 'seal-tree-scan' | 'seal-object' | 'seal-fsck'
  | 'import-source-snapshot' | 'import-bundle' | 'import-fetch' | 'import-object' | 'import-ref' | 'import-fsck';
export interface ControllerGitEnvironment { readonly home: string; readonly globalConfig: string; readonly templateDirectory: string; }
type ControllerChild = ChildProcessByStdio<null, Readable, Readable>;

export class ControllerGitRunner {
  constructor(private readonly binary: string, private readonly environment: ControllerGitEnvironment,
    private readonly idleTimeoutMs = 30_000, private readonly absoluteTimeoutMs = 120_000,
    private readonly maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES) {
    if (![binary, environment.home, environment.globalConfig, environment.templateDirectory].every(value => safeAbsolute(value))
      || ![idleTimeoutMs, absoluteTimeoutMs, maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0)
      || idleTimeoutMs > absoluteTimeoutMs) throw new Error('Controller Git configuration is invalid');
  }

  templateDirectory(): string { return this.environment.templateDirectory; }

  protectedArguments(args: readonly string[]): readonly string[] {
    return [
      '--no-optional-locks',
      '-c', `core.hooksPath=${this.environment.templateDirectory}`,
      '-c', 'credential.helper=', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
      '-c', 'diff.external=', '-c', `core.attributesFile=${path.join(this.environment.home, 'empty-attributes')}`,
      ...args
    ];
  }

  async run(operation: OperationLease, phase: ControllerGitPhase, cwd: string, args: readonly string[]): Promise<Buffer> {
    if (!safeAbsolute(cwd) || !catalogued(phase, args, this.protectedArguments([]), this.environment.templateDirectory)) {
      console.error('[kogg:execution:git] command.refused', { operationId: operation.id, phase, safeCode: 'GIT_SEED_FAILED' });
      throw new GitRunError('GIT_SEED_FAILED');
    }
    let child: ControllerChild | undefined;
    let settled: Promise<void> | undefined;
    let terminal: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let spawnError = false;
    let idle: NodeJS.Timeout | undefined;
    let absolute: NodeJS.Timeout | undefined;
    const processLease = operation.registerProcess({
      kind: 'git', owner: 'kogg-supervisor', cancel: async () => { kill(child); await settled?.catch(() => undefined); }
    });
    console.info('[kogg:execution:git] process.registered', { operationId: operation.id, processId: processLease.id, phase });
    processLease.spawning();
    try {
      const spawned = spawn(this.binary, [...args], { cwd, detached: true, env: this.childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
      child = spawned;
      settled = new Promise<void>(resolve => {
        spawned.once('error', () => { spawnError = true; });
        spawned.once('close', (code, signal) => { terminal = { code, signal }; resolve(); });
      });
      if (!spawned.pid) { await settled; throw new GitRunError('GIT_SEED_FAILED'); }
      processLease.started(spawned.pid); processLease.ready();
      console.info('[kogg:execution:git] process.started', { operationId: operation.id, processId: processLease.id, phase });
      const stdout: Buffer[] = [];
      let bytes = 0;
      let timedOut = false;
      let outputLimited = false;
      const resetIdle = (): void => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => { timedOut = true; kill(child); }, this.idleTimeoutMs);
      };
      resetIdle(); absolute = setTimeout(() => { timedOut = true; kill(child); }, this.absoluteTimeoutMs);
      spawned.stdout.on('data', chunk => {
        const value = Buffer.from(chunk); bytes += value.length;
        if (bytes > this.maxOutputBytes) { outputLimited = true; kill(child); } else stdout.push(value);
        resetIdle(); processLease.activity();
      });
      spawned.stderr.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > this.maxOutputBytes) { outputLimited = true; kill(child); }
        resetIdle(); processLease.activity();
      });
      await settled;
      if (spawnError) throw new GitRunError('GIT_SEED_FAILED');
      if (outputLimited) throw new GitRunError('GIT_SEED_OUTPUT_LIMIT');
      if (timedOut) throw new GitRunError('GIT_SEED_TIMEOUT');
      if (terminal?.code !== 0) throw new GitRunError('GIT_SEED_FAILED');
      return Buffer.concat(stdout);
    } catch (error) {
      kill(child); await settled?.catch(() => undefined);
      const safeCode = error instanceof GitRunError ? error.code : 'GIT_SEED_FAILED';
      console.error('[kogg:execution:git] process.failed', {
        operationId: operation.id, processId: processLease.id, phase, safeCode,
        errorType: error instanceof Error ? error.name : 'UnknownError'
      });
      throw new GitRunError(safeCode);
    } finally {
      if (idle) clearTimeout(idle); if (absolute) clearTimeout(absolute);
      if (child?.pid) processLease.exited(terminal?.signal ? 'signal' : terminal?.code === 0 ? 'zero' : 'nonzero');
      else processLease.failed('PROCESS_SPAWN_FAILED', 'Error');
      processLease.cleanup();
      console.info('[kogg:execution:git] process.exited', {
        operationId: operation.id, processId: processLease.id, phase,
        exitClass: terminal?.signal ? 'signal' : terminal?.code === 0 ? 'zero' : child?.pid ? 'nonzero' : 'spawn-failed'
      });
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    return {
      PATH: path.dirname(this.binary), HOME: this.environment.home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: this.environment.globalConfig, GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/false', SSH_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/false',
      GIT_PAGER: 'cat', GIT_EDITOR: process.platform === 'win32' ? 'exit 1' : '/bin/false'
    };
  }
}

export class GitRunError extends Error { constructor(readonly code: ExecutionGitCode) { super(code); this.name = 'GitRunError'; } }

function kill(child: ControllerChild | undefined): void {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { // observability-exempt: Direct-child termination is the fallback; the registered owner still waits for close.
    child.kill('SIGKILL');
  }
}

function catalogued(phase: ControllerGitPhase, args: readonly string[], prefix: readonly string[], templateDirectory: string): boolean {
  if (args.length < prefix.length || prefix.some((value, index) => args[index] !== value)) return false;
  const command = args.slice(prefix.length); const exact = (...value: string[]): boolean => command.length === value.length && command.every((item, index) => item === value[index]);
  const oid = (value: string | undefined): boolean => typeof value === 'string' && OBJECT.test(value);
  const absolute = (value: string | undefined): boolean => typeof value === 'string' && safeAbsolute(value);
  const range = (value: string | undefined): boolean => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\.\.(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
  if (phase === 'source-head') return exact('rev-parse', '--verify', 'HEAD');
  if (phase === 'source-tree') return exact('rev-parse', '--verify', 'HEAD^{tree}');
  if (phase === 'bundle-create') return command.length === 4 && exact('bundle', 'create', command[2]!, 'HEAD') && absolute(command[2]);
  if (phase === 'private-init') return command.length === 3 && exact('init', `--template=${templateDirectory}`, command[2]!) && absolute(command[2]);
  if (phase === 'private-fetch') return command.length === 4 && exact('fetch', '--no-tags', command[2]!, 'HEAD') && absolute(command[2]);
  if (phase === 'private-ref') return (command.length === 4 && command[0] === 'update-ref' && RUN_REF.test(command[1]!) && oid(command[2]) && /^0{40}(?:0{24})?$/u.test(command[3]!))
    || (command.length === 3 && exact('symbolic-ref', 'HEAD', command[2]!) && RUN_REF.test(command[2]!));
  if (phase === 'private-checkout') return command.length === 3 && exact('reset', '--hard', command[2]!) && oid(command[2]);
  if (phase === 'private-verify') return exact('rev-parse', '--verify', 'HEAD') || exact('rev-parse', '--verify', 'HEAD^{tree}') || exact('rev-parse', '--show-object-format')
    || exact('remote') || exact('for-each-ref', '--format=%(refname)', 'refs/heads') || exact('config', '--local', '--null', '--name-only', '--list') || exact('fsck', '--strict', '--full', '--no-reflogs');
  if (phase === 'seal-head') return exact('symbolic-ref', '-q', 'HEAD') || exact('for-each-ref', '--format=%(refname)', 'refs/heads')
    || exact('rev-parse', '--verify', 'HEAD^{commit}');
  if (phase === 'seal-tree') return exact('rev-parse', '--verify', 'HEAD^{tree}');
  if (phase === 'seal-status') return exact('status', '--porcelain=v2', '-z', '--untracked-files=all');
  if (phase === 'seal-history') return (command.length === 3 && command[0] === 'merge-base' && oid(command[1]) && oid(command[2]))
    || (command.length === 4 && command[0] === 'rev-list' && exact('rev-list', '--min-parents=2', '--max-count=1', command[3]!) && range(command[3]));
  if (phase === 'seal-tree-scan') return command.length === 4 && exact('ls-tree', '-rlz', '--full-tree', command[3]!) && oid(command[3]);
  if (phase === 'seal-object') return (command.length === 3 && command[0] === 'cat-file' && command[1] === 'blob' && oid(command[2]))
    || (command.length === 4 && command[0] === 'rev-list' && exact('rev-list', '--objects', '--no-object-names', command[3]!) && range(command[3]));
  if (phase === 'seal-fsck' || phase === 'import-fsck') return exact('fsck', '--strict', '--full', '--no-reflogs');
  if (phase === 'import-source-snapshot') return exact('symbolic-ref', '-q', 'HEAD') || exact('rev-parse', '--verify', 'HEAD^{commit}') || exact('rev-parse', '--verify', 'HEAD^{tree}')
    || exact('status', '--porcelain=v2', '-z', '--untracked-files=all') || exact('config', '--local', '--null', '--list') || exact('for-each-ref', '--format=%(refname) %(objectname)');
  if (phase === 'import-bundle') return command.length === 5 && command[0] === 'bundle' && command[1] === 'create' && absolute(command[2]) && RUN_REF.test(command[3]!) && command[4] === `^${command[4]!.slice(1)}` && oid(command[4]!.slice(1));
  if (phase === 'import-fetch') return command.length === 5 && command[0] === 'fetch' && command[1] === '--no-tags' && command[2] === '--no-write-fetch-head' && absolute(command[3]) && RUN_REF.test(command[4]!);
  if (phase === 'import-object') return (command.length === 3 && command[0] === 'rev-parse' && command[1] === '--verify' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\^\{(?:commit|tree)\}$/u.test(command[2]!))
    || (command.length === 3 && command[0] === 'merge-base' && oid(command[1]) && oid(command[2])) || (command.length === 4 && command[0] === 'rev-list' && command[1] === '--objects' && command[2] === '--no-object-names' && range(command[3]));
  if (phase === 'import-ref') return command.length === 4 && command[0] === 'update-ref' && QUARANTINE_REF.test(command[1]!) && oid(command[2]) && /^0{40}(?:0{24})?$/u.test(command[3]!);
  return false;
}
function safeAbsolute(value: string): boolean { return path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value); }
