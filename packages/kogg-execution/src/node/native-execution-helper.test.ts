import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, openSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const nativeRoot = path.resolve(__dirname, '..', '..', 'native');
const binary = path.join(nativeRoot, 'bin', 'linux-x64', 'kogg-execution-helper');
const manifestPath = path.join(nativeRoot, 'bin', 'linux-x64', 'manifest.json');

// diagnostic-coverage: execution.worktree-registry, execution.capacity, execution.recovery, execution.process-cleanup
test('builds a pinned Linux helper and refuses malformed or unqualified allocation before effects', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async () => {
  assert.equal(existsSync(binary), true); assert.equal(existsSync(manifestPath), true);
  const [artifact, manifestText] = await Promise.all([readFile(binary), readFile(manifestPath, 'utf8')]);
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  assert.deepEqual(Object.keys(manifest).sort(), ['architecture', 'artifactDigest', 'platform', 'schemaVersion', 'sourceDigest']);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.platform, 'linux'); assert.equal(manifest.architecture, 'x64');
  assert.equal(manifest.artifactDigest, `sha256:${createHash('sha256').update(artifact).digest('hex')}`);

  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-native-helper-')); await chmod(root, 0o700);
  const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const malformed = invoke(rootFd, '{}\n');
    assert.equal(malformed.status, 1); assert.deepEqual(JSON.parse(malformed.stdout), { schemaVersion: 1, ok: false, safeCode: 'ALLOCATION_PROTOCOL_INVALID' });
    assert.equal(malformed.stderr, '');

    const allocationName = 'r-abcdefghijklmnopqrstuvwxyz';
    const request = JSON.stringify({
      schemaVersion: 1, operation: 'allocate', allocationName, allocationNonce: 'a'.repeat(64),
      worktreeId: '10000000-0000-4000-8000-000000000001', ownerInstanceId: '10000000-0000-4000-8000-000000000002',
      createdAt: '2026-08-27T00:00:00.000Z', quotaProjectId: '7', quotaBytes: '1073741824', quotaInodes: '100000'
    });
    const refused = invoke(rootFd, `${request}\n`);
    assert.equal(refused.status, 1); assert.deepEqual(JSON.parse(refused.stdout), { schemaVersion: 1, ok: false, safeCode: 'ALLOCATION_QUALIFICATION_INVALID' });
    assert.equal(refused.stderr, ''); assert.equal(existsSync(path.join(root, allocationName)), false);
  } finally { closeSync(rootFd); await rm(root, { recursive: true, force: true }); }
});

function invoke(rootFd: number, input: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(binary, [], { input, encoding: 'utf8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe', rootFd], env: {} });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
