import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workflowSourceMapDiagnostics, type WorkflowSourceMapTargets } from './workflow-source-map-diagnostics';

// diagnostic-coverage: workflow.source-maps

test('requires every workflow editor, common, compiler, scheduler, and executor source map', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-workflow-maps-')); const node = path.join(root, 'node'); const common = path.join(root, 'common'); const browser = path.join(root, 'browser'); const bundle = path.join(root, 'main.js.map'); await Promise.all([mkdir(node), mkdir(common), mkdir(browser)]);
  const targets: WorkflowSourceMapTargets = { nodeDirectories: [node], commonDirectories: [common], browserDirectories: [browser], bundleMaps: [bundle] };
  try {
    assert.deepEqual(workflowSourceMapDiagnostics(), { expectedCount: 18, presentCount: 18, missingCount: 0 });
    await writeFile(path.join(node, 'workflow-registry.js.map'), '{}');
    await writeFile(bundle, JSON.stringify({ sources: ['webpack:///packages/kogg-workflow/src/browser/workflow-editor-widget.ts'] }));
    assert.deepEqual(workflowSourceMapDiagnostics(targets), { expectedCount: 18, presentCount: 2, missingCount: 16 });
    await writeFile(bundle, '{');
    assert.deepEqual(workflowSourceMapDiagnostics(targets), { expectedCount: 18, presentCount: 1, missingCount: 17 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects incomplete or relative source-map targets', () => {
  const absolute = '/absolute';
  assert.throws(() => workflowSourceMapDiagnostics({ nodeDirectories: [], commonDirectories: [absolute], browserDirectories: [absolute], bundleMaps: [absolute] }), /Invalid workflow source-map targets/u);
  assert.throws(() => workflowSourceMapDiagnostics({ nodeDirectories: [absolute], commonDirectories: [absolute], browserDirectories: ['relative'], bundleMaps: [absolute] }), /Invalid workflow source-map targets/u);
});
