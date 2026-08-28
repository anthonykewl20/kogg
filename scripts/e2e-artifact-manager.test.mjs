import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureSafeFailureArtifacts, scanArtifactText } from './e2e-artifact-manager.mjs';

test('retains only closed harness lifecycle facts and a safe atomic failure manifest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-safe-artifact-')); const logs = [];
    try {
        const value = await captureSafeFailureArtifacts({ root, runtime: 'browser', platform: 'linux', runId: '10000000-0000-4000-8000-000000000001', error: new Error('private bearer token=canary'), logger: line => logs.push(line), lifecycleLines: [
            '[backend] source code: private canary',
            '[kogg:e2e:harness] run.started {"runId":"10000000-0000-4000-8000-000000000001","platform":"linux","runtime":"browser"}',
            '[kogg:e2e:harness] deadline.started {"runId":"10000000-0000-4000-8000-000000000001","platform":"linux","runtime":"browser","deadlineClass":"portable"}',
            '[kogg:e2e:harness] discovery.attempt {"reason":"fixture-readiness","attempt":2}',
            '[kogg:e2e:harness] scenario.failed {"runId":"10000000-0000-4000-8000-000000000001","platform":"linux","runtime":"browser","scenarioId":"portable-surface","safeCode":"E2E_STEP_FAILED"}',
            '[kogg:e2e:harness] source-map.completed {"runId":"10000000-0000-4000-8000-000000000001","platform":"linux","runtime":"browser","mappedCount":11}',
            '[kogg:e2e:harness] diagnostics.completed {"runId":"10000000-0000-4000-8000-000000000001","platform":"linux","runtime":"browser","coverage":"complete","checkCount":107,"passCount":60,"warnCount":1,"failCount":46}',
            '[kogg:e2e:harness] fixture.registered {"fixtureId":"fixture-1","fixtureKind":"signed-registry"}',
            '[kogg:e2e:harness] fixture.cleanup.completed {"fixtureId":"fixture-1","fixtureKind":"signed-registry","exitClass":"signal","forced":false}'
        ] });
        const lifecycle = await readFile(path.join(value.directory, 'lifecycle.log'), 'utf8'); const failure = await readFile(path.join(value.directory, 'failure.json'), 'utf8');
        assert.match(lifecycle, /run\.started/u); assert.match(lifecycle, /deadline\.started.*"deadlineClass":"portable"/u); assert.match(lifecycle, /discovery\.attempt.*"attempt":2/u); assert.match(lifecycle, /scenario\.failed/u); assert.match(lifecycle, /source-map\.completed.*"mappedCount":11/u); assert.match(lifecycle, /diagnostics\.completed.*"checkCount":107.*"failCount":46/u); assert.match(lifecycle, /fixture\.cleanup\.completed/u); assert.doesNotMatch(`${lifecycle}\n${failure}`, /private|bearer|token=|source code/iu);
        assert.match(failure, /E2E_ARTIFACT_CONTENT_BEARING/u); assert.deepEqual(logs.map(line => line.match(/artifact\.[a-z.]+/u)?.[0]), ['artifact.capture.started','artifact.capture.completed']);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('scanner refuses credentials, paths, remote URLs, diffs, and oversized candidates', () => {
    for (const value of ['Authorization: Bearer hidden','secret=value','/Users/person/project','https://example.invalid/repo','diff --git a/a b/a','x'.repeat(65_537)]) assert.throws(() => scanArtifactText(value), /E2E_ARTIFACT_UNSAFE/u);
});
