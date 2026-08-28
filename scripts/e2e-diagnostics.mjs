import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const INCOMPLETE_DIAGNOSTICS = Object.freeze({ coverage: 'incomplete', checkCount: 0, passCount: 0, warnCount: 0, failCount: 0 });

export async function verifyProductDiagnostics({ root, report, runId, runtime, platform, logger = () => undefined }) {
    if (typeof root !== 'string' || !uuid(runId) || !['browser','electron'].includes(runtime) || !['linux','macos','windows'].includes(platform) || typeof logger !== 'function') throw safeError('E2E_DIAGNOSTICS_INVALID');
    const context = { runId, platform, runtime }; logger(event('diagnostics.started', context));
    try {
        const catalog = JSON.parse(await readFile(path.join(root, 'diagnostics/catalog.json'), 'utf8'));
        if (!catalog || Object.keys(catalog).sort().join(',') !== 'checks,schemaVersion' || catalog.schemaVersion !== 1 || !Array.isArray(catalog.checks) || !report || report.schemaVersion !== 1 || !Array.isArray(report.checks)) throw new Error('invalid shape');
        const expected = catalog.checks.map(check => check?.id); const actual = report.checks.map(check => check?.id);
        if (expected.some(id => typeof id !== 'string') || new Set(expected).size !== expected.length || actual.some(id => typeof id !== 'string') || new Set(actual).size !== actual.length || expected.length !== actual.length || expected.some(id => !actual.includes(id))) throw new Error('coverage mismatch');
        const statuses = report.checks.map(check => check?.status); if (statuses.some(status => !['pass','warn','fail'].includes(status))) throw new Error('status mismatch');
        const passCount = statuses.filter(status => status === 'pass').length; const warnCount = statuses.filter(status => status === 'warn').length; const failCount = statuses.filter(status => status === 'fail').length;
        const expectedOverall = failCount ? 'fail' : warnCount ? 'warn' : 'pass'; if (report.overall !== expectedOverall) throw new Error('overall mismatch');
        const result = Object.freeze({ coverage: 'complete', checkCount: actual.length, passCount, warnCount, failCount }); logger(event('diagnostics.completed', { ...context, ...result })); return result;
    } catch { logger(event('diagnostics.failed', { ...context, safeCode: 'E2E_DIAGNOSTICS_INCOMPLETE' })); throw safeError('E2E_DIAGNOSTICS_INCOMPLETE'); }
}

function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value); }
function safeError(code) { const error = new Error(code); error.stack = error.message; return error; }
function event(name, fields) { return `[kogg:e2e:harness] ${name} ${JSON.stringify(fields)}`; }
