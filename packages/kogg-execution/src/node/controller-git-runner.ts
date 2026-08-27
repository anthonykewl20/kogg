import { spawn, type ChildProcessByStdio } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { OperationLease } from '@kogg/operations/lib/common/operations-protocol';
import type { ExecutionGitCode } from '../common/execution-protocol';

// Every controller Git call is registered before spawn, bounded, drained, and logged without argv, paths, output, or errors.
// diagnostic-coverage: execution.git-independence, execution.source-integrity, execution.process-cleanup
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export type ControllerGitPhase = 'source-head' | 'source-tree' | 'bundle-create' | 'private-init' | 'private-fetch' | 'private-ref' | 'private-checkout' | 'private-verify'
  | 'seal-head' | 'seal-tree' | 'seal-status' | 'seal-history' | 'seal-tree-scan' | 'seal-object' | 'seal-fsck';
export interface ControllerGitEnvironment { readonly home: string; readonly globalConfig: string; readonly templateDirectory: string; }
type ControllerChild = ChildProcessByStdio<null, Readable, Readable>;

export class ControllerGitRunner {
  constructor(private readonly binary: string, private readonly environment: ControllerGitEnvironment,
    private readonly idleTimeoutMs = 30_000, private readonly absoluteTimeoutMs = 120_000,
    private readonly maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES) {
    if (!path.isAbsolute(binary) || ![idleTimeoutMs, absoluteTimeoutMs, maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0)
      || idleTimeoutMs > absoluteTimeoutMs) throw new Error('Controller Git configuration is invalid');
  }

  templateDirectory(): string { return this.environment.templateDirectory; }

  protectedArguments(args: readonly string[]): readonly string[] {
    return [
      '-c', `core.hooksPath=${this.environment.templateDirectory}`,
      '-c', 'credential.helper=', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
      '-c', 'diff.external=', '-c', `core.attributesFile=${path.join(this.environment.home, 'empty-attributes')}`,
      ...args
    ];
  }

  async run(operation: OperationLease, phase: ControllerGitPhase, cwd: string, args: readonly string[]): Promise<Buffer> {
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
