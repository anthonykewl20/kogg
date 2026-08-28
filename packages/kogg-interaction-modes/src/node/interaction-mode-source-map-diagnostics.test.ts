import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { interactionModeSourceMapDiagnostics, type InteractionModeSourceMapTargets } from './interaction-mode-source-map-diagnostics';

// diagnostic-coverage: interaction-modes.source-maps

test('requires every interaction-mode browser, common, and backend source map', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-maps-')); const node = path.join(root, 'node'); const common = path.join(root, 'common'); const browser = path.join(root, 'browser'); const bundle = path.join(root, 'main.js.map'); await Promise.all([mkdir(node), mkdir(common), mkdir(browser)]);
  const targets: InteractionModeSourceMapTargets = { nodeDirectories: [node], commonDirectories: [common], browserDirectories: [browser], bundleMaps: [bundle] };
  try {
    assert.deepEqual(interactionModeSourceMapDiagnostics(), { expectedCount: 14, presentCount: 14, missingCount: 0 });
    await writeFile(path.join(node, 'interaction-modes-diagnostic-contributor.js.map'), '{}');
    await writeFile(bundle, JSON.stringify({ sources: ['webpack:///packages/kogg-interaction-modes/src/browser/frontend-module.ts'] }));
    assert.deepEqual(interactionModeSourceMapDiagnostics(targets), { expectedCount: 14, presentCount: 2, missingCount: 12 });
    await writeFile(bundle, '{');
    assert.deepEqual(interactionModeSourceMapDiagnostics(targets), { expectedCount: 14, presentCount: 1, missingCount: 13 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects incomplete or relative source-map targets', () => {
  const absolute = '/absolute';
  assert.throws(() => interactionModeSourceMapDiagnostics({ nodeDirectories: [], commonDirectories: [absolute], browserDirectories: [absolute], bundleMaps: [absolute] }), /Invalid interaction-mode source-map targets/u);
  assert.throws(() => interactionModeSourceMapDiagnostics({ nodeDirectories: [absolute], commonDirectories: [absolute], browserDirectories: ['relative'], bundleMaps: [absolute] }), /Invalid interaction-mode source-map targets/u);
});
