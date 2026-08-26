// diagnostic-exempt: Disposable issue #110 real Git/CAS probe retained off production branches.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

assert(process.debugPort > 0, 'probe must run with --inspect=0');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-verdict-merge-probe-'));
const repository = path.join(temporary, 'repository');
const controls = path.join(temporary, 'controls');
const gitPath = await realpath(process.env.KOGG_GIT_PATH ?? '/usr/bin/git');
process.env.KOGG_STATE_DIR = path.join(temporary, 'state');
const { OperationRegistry } = await import('../../packages/kogg-operations/lib/node/operation-registry.js');
const registry = new OperationRegistry(5_000);
const trace = [];
let processCount = 0;

try {
  await writeFile(path.join(temporary, 'empty-config'), '', { mode: 0o600 });
  await writeFile(path.join(temporary, 'deny-helper'), '#!/bin/sh\nexit 127\n', { mode: 0o700 });
  await chmod(path.join(temporary, 'deny-helper'), 0o700);
  const artifactDigest = createHash('sha256').update(await readFile(gitPath)).digest('hex');
  await registry.onStart();
  const attemptId = randomUUID();
  const operation = await registry.startOperation({ kind: 'merge', correlations: { attemptId } });
  operation.start();

  const git = async (args, options = {}) => {
    const processLease = operation.registerProcess({ kind: 'git', owner: 'kogg-supervisor' });
    processLease.spawning();
    let child;
    try {
      child = spawn(gitPath, args, {
        cwd: options.cwd ?? temporary,
        env: {
          PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
          HOME: controls, GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_SYSTEM: path.join(temporary, 'empty-config'),
          GIT_CONFIG_GLOBAL: path.join(temporary, 'empty-config'),
          GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: path.join(temporary, 'deny-helper'),
          SSH_ASKPASS: path.join(temporary, 'deny-helper'), GIT_PAGER: 'cat',
          GIT_EDITOR: path.join(temporary, 'deny-helper'),
          GIT_SEQUENCE_EDITOR: path.join(temporary, 'deny-helper'), GIT_OPTIONAL_LOCKS: '0',
          GIT_AUTHOR_NAME: 'Kogg', GIT_AUTHOR_EMAIL: 'kogg@localhost.invalid',
          GIT_COMMITTER_NAME: 'Kogg', GIT_COMMITTER_EMAIL: 'kogg@localhost.invalid',
          GIT_AUTHOR_DATE: '1704067200 +0000', GIT_COMMITTER_DATE: '1704067200 +0000'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      processLease.failed('PROCESS_SPAWN_FAILED', error?.constructor?.name ?? 'Error');
      processLease.cleanup();
      throw error;
    }
    assert(child.pid); processLease.started(child.pid); processLease.ready(); processCount += 1;
    const stdout = []; const stderr = []; let stdoutBytes = 0; let stderrBytes = 0;
    child.stdout.on('data', chunk => { stdoutBytes += chunk.length; assert(stdoutBytes <= 64 * 1024, 'GIT_OUTPUT_LIMIT'); stdout.push(chunk); processLease.activity(); });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; assert(stderrBytes <= 64 * 1024, 'GIT_OUTPUT_LIMIT'); stderr.push(chunk); processLease.activity(); });
    if (options.stdin !== undefined) child.stdin.end(options.stdin); else child.stdin.end();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('GIT_PROCESS_TIMEOUT')); }, 5_000);
      child.once('error', reject);
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    processLease.exited(result.signal ? 'signal' : result.code === 0 ? 'zero' : 'nonzero');
    processLease.cleanup();
    return { ...result, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
  };
  const ok = async (args, options) => { const result = await git(args, options); assert.equal(result.code, 0, 'GIT_PROCESS_FAILED'); return result.stdout.trim(); };
  const repoArgs = args => ['--git-dir', path.join(repository, '.git'), '--work-tree', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'credential.helper=', '-c', 'core.pager=cat', '-c', 'advice.detachedHead=false', '-c', 'protocol.file.allow=never', ...args];

  emit('probe.started', { attemptId, artifactDigest: artifactDigest.slice(0, 16) });
  const version = await ok(['--version']);
  await ok(['init', '--quiet', repository]);
  const before = await worktreeInventory(repository);
  assert.deepEqual(before, []);

  const blob = async content => ok(repoArgs(['hash-object', '-w', '--stdin']), { stdin: content });
  const tree = async entries => ok(repoArgs(['mktree']), { stdin: entries.sort((a, b) => a.name.localeCompare(b.name)).map(entry => `100644 blob ${entry.oid}\t${entry.name}\n`).join('') });
  const commit = async (treeOid, parents = []) => ok(repoArgs(['commit-tree', treeOid, ...parents.flatMap(parent => ['-p', parent])]), { stdin: 'Kogg controlled merge\n' });
  const baseBlob = await blob('base\n'); const baseTree = await tree([{ name: 'base.txt', oid: baseBlob }]); const base = await commit(baseTree);
  const leftBlob = await blob('left\n'); const leftTree = await tree([{ name: 'base.txt', oid: baseBlob }, { name: 'left.txt', oid: leftBlob }]); const left = await commit(leftTree, [base]);
  const rightBlob = await blob('right\n'); const rightTree = await tree([{ name: 'base.txt', oid: baseBlob }, { name: 'right.txt', oid: rightBlob }]); const right = await commit(rightTree, [base]);
  await ok(repoArgs(['update-ref', 'refs/heads/destination', left]));

  const mergeTreeResult = await git(repoArgs(['merge-tree', '--write-tree', '--messages', `--merge-base=${base}`, left, right]));
  assert.equal(mergeTreeResult.code, 0); const mergedTree = mergeTreeResult.stdout.trim(); assert.match(mergedTree, /^[0-9a-f]{40,64}$/u);
  const mergeCommit = await commit(mergedTree, [left, right]);
  const rawCommit = await ok(repoArgs(['cat-file', '-p', mergeCommit]));
  assert(rawCommit.startsWith(`tree ${mergedTree}\nparent ${left}\nparent ${right}\n`));
  assert.match(rawCommit, /author Kogg <kogg@localhost\.invalid>/u); assert.match(rawCommit, /\n\nKogg controlled merge$/u);
  emit('construction.verified', { attemptId, parentCount: 2, deterministicIdentity: true, gitVersion: version.replace(/^git version /u, '') });

  emit('cas.started', { attemptId });
  await ok(repoArgs(['update-ref', 'refs/heads/destination', mergeCommit, left]));
  assert.equal(await ok(repoArgs(['rev-parse', 'refs/heads/destination'])), mergeCommit);
  emit('cas.committed', { attemptId, expectedOldMatched: true });

  const staleAttempt = await git(repoArgs(['update-ref', 'refs/heads/destination', right, left]));
  assert.notEqual(staleAttempt.code, 0); assert.equal(await ok(repoArgs(['rev-parse', 'refs/heads/destination'])), mergeCommit);
  emit('cas.refused', { attemptId, safeCode: 'REF_CAS_CONFLICT', fallback: false, retry: false });

  const conflictBaseBlob = await blob('common\n'); const conflictBaseTree = await tree([{ name: 'conflict.txt', oid: conflictBaseBlob }]); const conflictBase = await commit(conflictBaseTree);
  const conflictLeftBlob = await blob('left change\n'); const conflictLeftTree = await tree([{ name: 'conflict.txt', oid: conflictLeftBlob }]); const conflictLeft = await commit(conflictLeftTree, [conflictBase]);
  const conflictRightBlob = await blob('right change\n'); const conflictRightTree = await tree([{ name: 'conflict.txt', oid: conflictRightBlob }]); const conflictRight = await commit(conflictRightTree, [conflictBase]);
  const conflict = await git(repoArgs(['merge-tree', '--write-tree', '--messages', `--merge-base=${conflictBase}`, conflictLeft, conflictRight]));
  assert.notEqual(conflict.code, 0); assert.equal(await ok(repoArgs(['rev-parse', 'refs/heads/destination'])), mergeCommit);
  emit('conflict.refused', { attemptId, safeCode: 'GIT_CONFLICT', refMutation: false, fallback: false });

  assert.deepEqual(await worktreeInventory(repository), before);
  assert.equal(await fileExists(path.join(repository, '.git', 'index')), false);
  operation.active(); await operation.cleanup(); operation.complete();
  const diagnostics = registry.diagnostics();
  assert.equal(diagnostics.activeCount, 0); assert.equal(diagnostics.residualCount, 0); assert.equal(diagnostics.cleanupFailureCount, 0);
  emit('cleanup.completed', { attemptId, processCount, residualCount: 0, worktreeMutation: false, indexMutation: false });
  const joined = trace.join('\n');
  for (const event of ['probe.started', 'construction.verified', 'cas.started', 'cas.committed', 'cas.refused', 'conflict.refused', 'cleanup.completed']) assert.match(joined, new RegExp(event.replaceAll('.', '\\.')));
  assert.doesNotMatch(joined, /\/Users|prompt|source|diff|credential|authorization|rawBody|commandArgument|environmentValue/iu);
  process.stdout.write('Kogg controlled merge real-Git boundary passed.\n');
} finally {
  await registry.onStop().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}

async function worktreeInventory(root) {
  return (await readdir(root, { withFileTypes: true })).filter(entry => entry.name !== '.git').map(entry => entry.name).sort();
}
async function fileExists(file) { try { await readFile(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
function emit(event, fields) { const line = `[kogg:merge:prototype] ${event} ${JSON.stringify(fields)}`; trace.push(line); console.info(line); }
