// diagnostic-exempt: Disposable issue #82 Git/Linux boundary probe retained off production branches.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp(path.join(root, '.kogg-execution-probe-'));
process.env.KOGG_STATE_DIR = path.join(temporary, 'state');
const { OperationRegistry } = await import('../../packages/kogg-operations/lib/node/operation-registry.js');
const registry = new OperationRegistry(3_000);
const trace = [];
const source = path.join(temporary, 'source');
const linked = path.join(temporary, 'linked');
const bundle = path.join(temporary, 'seed.bundle');
const privateRepo = path.join(temporary, 'private');
const candidateBundle = path.join(temporary, 'candidate.bundle');
const quarantine = `refs/kogg/quarantine/${randomUUID().replaceAll('-', '')}`;
const canary = 'EXECUTION-BOUNDARY-CONTENT-CANARY';

try {
  await writeFile(path.join(temporary, 'empty-gitconfig'), '');
  await registry.onStart();
  await git(['init', source]);
  await git(['-C', source, 'config', 'user.name', 'Kogg Probe']);
  await git(['-C', source, 'config', 'user.email', 'kogg@localhost.invalid']);
  await writeFile(path.join(source, 'seed.txt'), 'base\n');
  await git(['-C', source, 'add', 'seed.txt']); await git(['-C', source, 'commit', '-m', 'base']);
  const base = (await git(['-C', source, 'rev-parse', 'HEAD'])).trim();
  const baseTree = (await git(['-C', source, 'rev-parse', 'HEAD^{tree}'])).trim();
  const sourceStatus = await git(['-C', source, 'status', '--porcelain=v1']);

  await git(['-C', source, 'worktree', 'add', '--detach', linked, base]);
  await git(['-C', linked, 'config', '--local', 'kogg.red-control', 'mutated']);
  await git(['-C', linked, 'update-ref', 'refs/kogg/red-control', base]);
  assert.equal((await git(['-C', source, 'config', '--local', '--get', 'kogg.red-control'])).trim(), 'mutated');
  assert.equal((await git(['-C', source, 'rev-parse', 'refs/kogg/red-control'])).trim(), base);
  emit('linked-worktree.boundary.disproved', { safeCode: 'SHARED_GIT_COMMON_DIR', mutationCount: 2 });
  await git(['-C', source, 'config', '--local', '--unset', 'kogg.red-control']);
  await git(['-C', source, 'update-ref', '-d', 'refs/kogg/red-control']);
  await git(['-C', source, 'worktree', 'remove', linked]);

  await git(['-C', source, 'bundle', 'create', bundle, 'HEAD']);
  await git(['clone', '--no-local', '--no-hardlinks', bundle, privateRepo]);
  await git(['-C', privateRepo, 'remote', 'remove', 'origin']);
  assert.equal(await exists(path.join(privateRepo, '.git', 'objects', 'info', 'alternates')), false);
  assert.equal((await stat(path.join(source, '.git', 'objects'))).ino === (await stat(path.join(privateRepo, '.git', 'objects'))).ino, false);
  assert.doesNotMatch(await git(['-C', privateRepo, 'config', '--local', '--list']), new RegExp(escapeRegex(source)));
  emit('private-seed.verified', { baseObject: base.slice(0, 12), treeObject: baseTree.slice(0, 12), alternateCount: 0 });

  const containerName = `kogg-exec-${randomUUID().slice(0, 8)}`;
  const script = [
    'set -eu',
    'test "$(uname -m)" = x86_64',
    'test ! -e /source',
    'test ! -e /Users',
    'git -c safe.directory=/run config user.name "Kogg Probe"',
    'git -c safe.directory=/run config user.email "kogg@localhost.invalid"',
    'printf "candidate\\n" > candidate.txt',
    'git -c safe.directory=/run add candidate.txt',
    'git -c safe.directory=/run commit -m candidate',
    'wget -q -T 2 https://example.com -O /tmp/network-result && exit 91 || true',
    'sleep 30 >/dev/null 2>&1 & child=$!',
    'printf "%s\\n" "$child" > .probe-child-pid'
  ].join('; ');
  await runRegistered('governed-command', 'execution-linux', 'docker', [
    'run', '--platform', 'linux/amd64', '--name', containerName, '--network', 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64',
    '--memory', '256m', '--cpus', '1', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m',
    '--mount', `type=bind,src=${privateRepo},dst=/run`, '--workdir', '/run',
    '--entrypoint', 'sh', 'alpine/git:2.49.1', '-c', script
  ], 20_000);
  assert.equal((await docker(['ps', '-aq', '--filter', `name=^/${containerName}$`])).trim() !== '', true);
  await docker(['rm', containerName]);
  assert.equal((await docker(['ps', '-aq', '--filter', `name=^/${containerName}$`])).trim(), '');
  assert.equal(await exists(path.join(privateRepo, '.probe-child-pid')), true);
  const candidate = (await git(['-C', privateRepo, 'rev-parse', 'HEAD'])).trim();
  const candidateTree = (await git(['-C', privateRepo, 'rev-parse', 'HEAD^{tree}'])).trim();
  assert.notEqual(candidateTree, baseTree);
  assert.equal((await git(['-C', privateRepo, 'merge-base', '--is-ancestor', base, candidate], true)).code, 0);
  assert.equal((await git(['-C', privateRepo, 'status', '--porcelain=v1'])).trim(), '?? .probe-child-pid');
  await rm(path.join(privateRepo, '.probe-child-pid'));
  emit('linux-attempt.cleaned', { architecture: 'amd64', network: 'none', residualCount: 0 });

  await git(['-C', privateRepo, 'bundle', 'create', candidateBundle, 'HEAD', `^${base}`]);
  await git(['-C', source, 'fetch', candidateBundle, `HEAD:${quarantine}`]);
  assert.equal((await git(['-C', source, 'rev-parse', quarantine])).trim(), candidate);
  assert.equal((await git(['-C', source, 'rev-parse', `${quarantine}^{tree}`])).trim(), candidateTree);
  assert.equal((await git(['-C', source, 'rev-parse', 'HEAD'])).trim(), base);
  assert.equal((await git(['-C', source, 'status', '--porcelain=v1'])), sourceStatus);
  emit('candidate.import.verified', { activeRefMutationCount: 0, quarantineRefCount: 1, objectCountClass: 'bounded' });

  const diagnostics = registry.diagnostics();
  assert.equal(diagnostics.residualCount, 0); assert.equal(diagnostics.cleanupFailureCount, 0);
  const joined = trace.join('\n');
  for (const event of ['process.registered', 'process.started', 'process.exit', 'process.cleanup.completed', 'linked-worktree.boundary.disproved', 'private-seed.verified', 'linux-attempt.cleaned', 'candidate.import.verified']) assert.match(joined, new RegExp(event.replaceAll('.', '\\.')));
  assert.doesNotMatch(joined, new RegExp(canary));
  assert.doesNotMatch(joined, /\/Users|candidate\.txt|seed\.txt|command|argument|environment/iu);
  process.stdout.write('Kogg execution real-boundary prototype passed with qualification gaps recorded.\n');
} finally {
  await registry.onStop().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}

async function git(args, allowFailure = false) { return runRegistered('git', 'git-controller', 'git', args, 15_000, allowFailure); }
async function docker(args) { const result = await command('docker', args, 10_000); if (result.code !== 0) throw new Error('DOCKER_FAILED'); return result.stdout; }

async function runRegistered(kind, owner, executable, args, timeoutMs, allowFailure = false) {
  const lease = await registry.startOperation({ kind: kind === 'git' ? 'repository-probe' : 'agent-dispatch' }); lease.start();
  let child; const processLease = lease.registerProcess({ kind, owner: 'kogg-supervisor', cancel: async () => { if (child?.exitCode === null) child.kill('SIGKILL'); } });
  emit('process.registered', { owner, operationId: lease.id, processId: processLease.id }); processLease.spawning();
  const result = await command(executable, args, timeoutMs, spawned => { child = spawned; processLease.started(spawned.pid); processLease.ready(); lease.active(); emit('process.started', { owner, operationId: lease.id, processId: processLease.id }); });
  processLease.exited(result.code === 0 ? 'zero' : result.signal ? 'signal' : 'nonzero'); emit('process.exit', { owner, exitClass: result.code === 0 ? 'zero' : result.signal ? 'signal' : 'nonzero' });
  processLease.cleanup(); await lease.cleanup(); if (result.code === 0 || allowFailure) lease.complete(); else lease.fail('PROCESS_EXIT_NONZERO', 'Error');
  emit('process.cleanup.completed', { owner, processCount: 0 });
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`${owner.toUpperCase()}_FAILED`);
  }
  return allowFailure ? result : result.stdout;
}

function command(executable, args, timeoutMs, started = () => undefined) {
  return new Promise((resolve, reject) => {
    const dockerEnvironment = executable === 'docker' ? { DOCKER_HOST: process.env.DOCKER_HOST ?? `unix://${process.env.HOME}/.colima/default/docker.sock` } : {};
    const child = spawn(executable, args, { env: { PATH: process.env.PATH ?? '', HOME: temporary, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temporary, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0', ...dockerEnvironment }, stdio: ['ignore', 'pipe', 'pipe'] });
    started(child); const output = []; const errors = []; let size = 0;
    for (const [stream, target] of [[child.stdout, output], [child.stderr, errors]]) stream.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) child.kill('SIGKILL'); else target.push(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? 1, signal, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') }); });
  });
}

async function exists(value) { try { await lstat(value); return true; } catch { return false; } }
function emit(event, fields) { const line = `[kogg:execution:prototype] ${event} ${JSON.stringify(fields)}`; trace.push(line); console.info(line); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
