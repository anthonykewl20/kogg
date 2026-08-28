import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentDiagnosticContributor } from './agent-diagnostic-contributor';
import { inspectSourceMaps } from './source-map-diagnostics';

// diagnostic-coverage: agents.source-maps

test('reports every expected debugger source map without exposing paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-source-maps-'));
  try {
    await writeFile(path.join(directory, 'adapter.js.map'), '{}');
    assert.deepEqual(inspectSourceMaps(directory, ['adapter', 'registry', 'adapter']), { expectedCount: 2, presentCount: 1, missingCount: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses open or relative source-map diagnostic targets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-source-map-target-'));
  try {
    await mkdir(path.join(directory, 'nested'));
    assert.throws(() => inspectSourceMaps('relative', ['adapter']), /Invalid source-map diagnostic target/u);
    assert.throws(() => inspectSourceMaps(directory, ['../adapter']), /Invalid source-map diagnostic target/u);
    assert.throws(() => inspectSourceMaps(directory, []), /Invalid source-map diagnostic target/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('accepts bundle sources and externally emitted host maps in one debugger proof', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-source-map-bundle-')); const external = path.join(directory, 'external');
  try {
    await mkdir(external); await writeFile(path.join(directory, 'main.js.map'), JSON.stringify({ sources: ['file:///app/packages/kogg-agents/src/node/adapter.ts'] })); await writeFile(path.join(external, 'fixture-host.js.map'), '{}');
    assert.deepEqual(inspectSourceMaps(directory, ['adapter', 'fixture-host', 'registry'], { packageFolder: 'kogg-agents', moduleDirectories: [external] }), { expectedCount: 3, presentCount: 2, missingCount: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('agent runtime diagnostics prove every production debugger boundary map', async () => {
  const registry = { diagnostics: () => ({ integrity: true, foreignKeys: true, eventChain: true, activeCount: 0, residualCount: 0, recoveryComplete: true, admission: 'enabled', requestConflictCount: 0 }) };
  const adapters = { diagnostics: () => ({ descriptorCount: 1, ambiguousCount: 0, invalidCount: 0, fallbackCount: 0 }) };
  const checks = await new AgentDiagnosticContributor(registry as never, adapters as never).diagnose(); const sourceMaps = checks.find(check => check.id === 'agents.source-maps');
  assert.equal(sourceMaps?.status, 'pass'); assert.deepEqual(sourceMaps?.details, { expectedCount: 10, presentCount: 10, missingCount: 0 });
});
