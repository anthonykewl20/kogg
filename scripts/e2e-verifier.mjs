import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { TraceMap, eachMapping } = require('@jridgewell/trace-mapping');
const SOURCE_MAPS = Object.freeze([
    'packages/kogg-core/lib/browser/kogg-frontend-contribution.js.map',
    'packages/kogg-projects/lib/browser/projects-widget.js.map',
    'packages/kogg-tasks/lib/browser/tasks-widget.js.map',
    'packages/kogg-execution/lib/browser/execution-widget.js.map',
    'packages/kogg-agents/lib/node/agent-registry.js.map',
    'packages/kogg-workflow/lib/node/workflow-registry.js.map',
    'packages/kogg-kernel/lib/node/kernel-bridge.js.map',
    'packages/kogg-verdict-merge/lib/node/verdict-merge-service.js.map',
    'packages/kogg-operations/lib/node/operation-registry.js.map',
    'packages/kogg-interaction-modes/lib/node/interaction-mode-registry.js.map',
    'packages/kogg-providers/lib/browser/provider-widget.js.map'
]);

export const FAILED_VERIFICATION = Object.freeze({ oracle: 'fail', sourceMap: 'fail', mappedCount: 0 });

export async function verifyHarnessEvidence({ root, repository, runId, runtime, platform, profile, logger = () => undefined }) {
    if (typeof root !== 'string' || typeof repository !== 'string' || !uuid(runId) || !['browser','electron'].includes(runtime) || !['linux','macos','windows'].includes(platform) || !['browser-portable','electron-portable','browser-baseline','electron-baseline'].includes(profile) || typeof logger !== 'function') throw safeError('E2E_VERIFIER_INVALID');
    const context = { runId, platform, runtime };
    logger(event('oracle.started', context));
    try { await verifyRepository(repository, profile, platform); logger(event('oracle.completed', context)); }
    catch (error) { logger(event('oracle.failed', { ...context, safeCode: 'E2E_ORACLE_MISMATCH', trackedChangeCount: safeCount(error?.trackedChangeCount), untrackedCount: safeCount(error?.untrackedCount) })); throw safeError('E2E_ORACLE_MISMATCH'); }
    logger(event('source-map.started', context));
    try {
        let mappedCount = 0;
        for (const relative of SOURCE_MAPS) mappedCount += verifySourceMapText(await readFile(path.join(root, relative), 'utf8'));
        if (mappedCount !== SOURCE_MAPS.length) throw new Error('mapping count mismatch');
        logger(event('source-map.completed', { ...context, mappedCount }));
        return Object.freeze({ oracle: 'pass', sourceMap: 'pass', mappedCount });
    } catch { logger(event('source-map.failed', { ...context, safeCode: 'E2E_SOURCE_MAP_MISSING' })); throw safeError('E2E_SOURCE_MAP_MISSING'); }
}

export async function verifyRepository(repository, profile = 'clean', platform = 'linux') {
    if (typeof repository !== 'string' || !['clean','browser-portable','electron-portable','browser-baseline','electron-baseline'].includes(profile) || !['linux','macos','windows'].includes(platform)) throw safeError('E2E_ORACLE_MISMATCH');
    const commands = [
        ['rev-parse', '--verify', 'HEAD'],
        ['ls-files', '--error-unmatch', 'README.md'],
        ['status', '--porcelain']
    ];
    const results = commands.map(args => spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 15_000, windowsHide: true }));
    if (results.some(result => result.status !== 0 || result.error)) throw safeError('E2E_ORACLE_MISMATCH');
    const records = results[2].stdout.split('\n').filter(Boolean); const trackedChangeCount = records.filter(record => !record.startsWith('??')).length; const untrackedCount = records.length - trackedChangeCount;
    let matches = profile === 'clean' ? records.length === 0 : profile === 'electron-portable' ? records.length === 0 : false;
    if (profile.endsWith('-baseline')) {
        const expected = profile === 'browser-baseline' ? '# Kogg E2E\nHuman workflow change.\n' : '# Kogg Electron E2E\nHuman workflow change.\n';
        matches = trackedChangeCount === 1 && untrackedCount === 0 && records[0]?.endsWith(' README.md') && await readFile(path.join(repository, 'README.md'), 'utf8') === expected;
    } else if (profile === 'browser-portable') {
        const proofs = platform === 'windows' ? [['.kogg-task-proof','KOGG_TASK_E2E\n']] : [['.kogg-task-proof','KOGG_TASK_E2E\n'],['.kogg-terminal-proof','KOGG_TERMINAL_E2E\n']];
        matches = trackedChangeCount === 0 && untrackedCount === proofs.length && proofs.every(([name]) => records.includes(`?? ${name}`));
        if (matches) for (const [name, expected] of proofs) if (await readFile(path.join(repository, name), 'utf8') !== expected) matches = false;
    }
    if (!matches) { const error = safeError('E2E_ORACLE_MISMATCH'); error.trackedChangeCount = trackedChangeCount; error.untrackedCount = untrackedCount; throw error; }
    return true;
}

export function verifySourceMapText(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024) throw safeError('E2E_SOURCE_MAP_MISSING');
    let mapped = false;
    try {
        const map = new TraceMap(JSON.parse(text));
        eachMapping(map, value => { if (!mapped && value.generatedLine > 0 && value.originalLine > 0 && typeof value.source === 'string' && /\.tsx?$/u.test(value.source)) mapped = true; });
    } catch { throw safeError('E2E_SOURCE_MAP_MISSING'); }
    if (!mapped) throw safeError('E2E_SOURCE_MAP_MISSING'); return 1;
}

function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value); }
function safeCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function safeError(code) { const error = new Error(code); error.stack = error.message; return error; }
function event(name, fields) { return `[kogg:e2e:harness] ${name} ${JSON.stringify(fields)}`; }
