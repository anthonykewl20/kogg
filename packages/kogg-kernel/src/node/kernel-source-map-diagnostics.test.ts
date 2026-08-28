import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { kernelSourceMapDiagnostics } from './kernel-source-map-diagnostics';

// diagnostic-coverage: kernel.source-maps

test('requires every kernel TypeScript map and the Python adapter source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-kernel-maps-')); const modules = path.join(root, 'modules'); const adapter = path.join(root, 'adapter.py'); await mkdir(modules);
  try {
    const real = kernelSourceMapDiagnostics(); assert.deepEqual(real, { expectedCount: 13, presentCount: 13, missingCount: 0 });
    await writeFile(adapter, '# debugger source\n'); await writeFile(path.join(modules, 'kernel-bridge.js.map'), '{}');
    assert.deepEqual(kernelSourceMapDiagnostics([modules], [adapter]), { expectedCount: 13, presentCount: 2, missingCount: 11 });
    await rm(path.join(modules, 'kernel-bridge.js.map'));
    await writeFile(path.join(modules, 'main.js.map'), JSON.stringify({ sources: ['webpack:///packages/kogg-kernel/src/node/kernel-bridge.ts'] }));
    assert.deepEqual(kernelSourceMapDiagnostics([modules], [adapter]), { expectedCount: 13, presentCount: 2, missingCount: 11 });
    await writeFile(adapter, '');
    assert.deepEqual(kernelSourceMapDiagnostics([modules], [adapter]), { expectedCount: 13, presentCount: 1, missingCount: 12 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects relative or empty debugger-artifact targets', () => {
  assert.throws(() => kernelSourceMapDiagnostics([], ['/absolute/adapter.py']), /Invalid kernel debugger-artifact roots/u);
  assert.throws(() => kernelSourceMapDiagnostics(['/absolute/modules'], ['relative.py']), /Invalid kernel debugger-artifact roots/u);
});
