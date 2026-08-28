import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EVENTS = new Set(['fixture.registered','fixture.started','fixture.ready','fixture.failed','fixture.cleanup.started','fixture.cleanup.completed','fixture.cleanup.failed']);
const PAYLOAD_KEYS = new Set(['fixtureId','fixtureKind','safeCode','exitClass','forced']);
const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const UNSAFE = [
    /authorization|bearer|cookie|set-cookie/iu,
    /(?:password|token|secret|api[_-]?key)\s*[:=]/iu,
    /(?:^|[\s"'])(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/u,
    /(?:^|\s)(?:diff --git|@@\s+-\d|git@|https?:\/\/)/iu,
    /(?:prompt|source code|terminal output|provider body)\s*[:=]/iu
];

export async function captureSafeFailureArtifacts({ root, runtime, lifecycleLines, error, logger = () => undefined, runId = randomUUID(), platform = platformName() }) {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(runId) || !['linux','macos','windows'].includes(platform) || !['browser','electron'].includes(runtime)) throw new Error('E2E_ARTIFACT_INVALID');
    const directory = path.join(root, runId, platform, runtime);
    logger(event('artifact.capture.started', { runId, platform, runtime, artifactKind: 'failure-summary' }));
    try {
        const lifecycle = closedLifecycle(lifecycleLines);
        const lifecycleText = lifecycle.length ? `${lifecycle.join('\n')}\n` : '';
        scanArtifactText(lifecycleText);
        const manifest = {
            schemaVersion: 1, runId, platform, runtime, state: 'failed', safeCode: 'E2E_SCENARIO_FAILED', errorType: safeErrorType(error),
            artifacts: [
                { kind: 'failure-summary', status: 'retained', digest: digest(lifecycleText) },
                { kind: 'screenshot', status: 'refused', safeCode: 'E2E_ARTIFACT_SCANNER_UNAVAILABLE' },
                { kind: 'raw-log', status: 'refused', safeCode: 'E2E_ARTIFACT_CONTENT_BEARING' }
            ],
            harnessChecks: [{ id: 'e2e.artifacts', status: 'pass', retainedCount: 1, refusedCount: 2 }]
        };
        const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
        scanArtifactText(manifestText);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await atomicWrite(directory, 'lifecycle.log', lifecycleText);
        await atomicWrite(directory, 'manifest.json', manifestText);
        logger(event('artifact.capture.completed', { runId, platform, runtime, artifactKind: 'failure-summary', artifactDigest: manifest.artifacts[0].digest }));
        return Object.freeze({ directory, manifest: Object.freeze(manifest) });
    } catch {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        logger(event('artifact.capture.refused', { runId, platform, runtime, artifactKind: 'failure-summary', safeCode: 'E2E_ARTIFACT_UNSAFE' }));
        throw new Error('E2E_ARTIFACT_UNSAFE');
    }
}

export function scanArtifactText(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 65_536 || UNSAFE.some(pattern => pattern.test(value))) throw new Error('E2E_ARTIFACT_UNSAFE');
}

function closedLifecycle(lines) {
    const result = [];
    for (const line of lines) {
        const match = /^\[kogg:e2e:harness\] ([a-z.]+) (\{.*\})$/u.exec(String(line).trim());
        if (!match || !EVENTS.has(match[1])) continue;
        let payload; try { payload = JSON.parse(match[2]); } catch { continue; }
        if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !PAYLOAD_KEYS.has(key))) continue;
        if (Object.entries(payload).some(([key, value]) => key === 'forced' ? typeof value !== 'boolean' : typeof value !== 'string' || !SAFE.test(value))) continue;
        result.push(`[kogg:e2e:harness] ${match[1]} ${JSON.stringify(payload)}`);
        if (result.length === 256) break;
    }
    return result;
}

async function atomicWrite(directory, name, value) {
    const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path.join(directory, name));
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function safeErrorType(error) { return error?.name === 'AssertionError' ? 'AssertionError' : error?.name === 'TimeoutError' ? 'TimeoutError' : 'Error'; }
function platformName() { return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'; }
function event(name, fields) { return `[kogg:e2e:artifact] ${name} ${JSON.stringify(fields)}`; }
