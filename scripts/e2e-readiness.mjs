export const DISCOVERY_DELAYS_MS = Object.freeze([100, 250, 500, 1_000, 2_000]);
export const DEADLINES_MS = Object.freeze({
    'fixture-readiness': 60_000,
    'workbench-readiness': 120_000,
    'visible-contribution': 30_000,
    'ordinary-ui': 15_000,
    'application-close': 15_000,
    cleanup: 30_000
});

const REASONS = new Set(['fixture-readiness', 'workbench-readiness', 'visible-contribution']);

export async function discover({ reason, probe, runId, runtime, platform, deadlineMs = DEADLINES_MS[reason], logger = () => undefined, now = Date.now, wait = delay }) {
    if (!REASONS.has(reason) || typeof probe !== 'function' || !uuid(runId) || !['browser','electron'].includes(runtime) || !['linux','macos','windows'].includes(platform) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || typeof logger !== 'function' || typeof now !== 'function' || typeof wait !== 'function') throw new Error('E2E_DISCOVERY_INVALID');
    const correlations = { runId, platform, runtime };
    const deadline = now() + deadlineMs;
    let attempt = 0;
    for (let index = 0; index < DISCOVERY_DELAYS_MS.length; index++) {
        attempt = index + 1;
        logger(event('discovery.attempt', { ...correlations, reason, attempt }));
        try {
            const value = await probe({ attempt, remainingMs: Math.max(0, deadline - now()) });
            if (value) { logger(event('discovery.completed', { ...correlations, reason, attempt })); return value; }
        } catch { /* A discovery probe exposes no exception content and may retry. */ }
        if (attempt === DISCOVERY_DELAYS_MS.length || now() >= deadline) break;
        await wait(Math.min(DISCOVERY_DELAYS_MS[index], Math.max(0, deadline - now())));
    }
    logger(event('discovery.failed', { ...correlations, reason, attempt, safeCode: reason === 'fixture-readiness' ? 'E2E_APPLICATION_NOT_READY' : 'E2E_VISIBLE_CONTROL_MISSING' }));
    const error = new Error('E2E_DISCOVERY_TIMEOUT'); error.stack = error.message; throw error;
}

export function platformCapabilities(runtime, platform = platformName()) {
    if (!['browser','electron'].includes(runtime) || !['linux','macos','windows'].includes(platform)) throw new Error('E2E_CAPABILITY_INVALID');
    return Object.freeze([
        Object.freeze({ name: 'governed-generation', status: platform === 'linux' ? 'pending-qualification' : 'refusal-required', safeCode: platform === 'linux' ? 'E2E_CAPABILITY_PENDING' : 'E2E_CAPABILITY_UNQUALIFIED' }),
        Object.freeze({ name: 'terminal-debug', status: runtime === 'browser' && platform === 'windows' ? 'runtime-delegated' : 'available', safeCode: runtime === 'browser' && platform === 'windows' ? 'E2E_CAPABILITY_RUNTIME_DELEGATED' : 'E2E_CAPABILITY_AVAILABLE' })
    ]);
}

export function selectedScenario(runtime, environment = process.env) {
    if (!['browser','electron'].includes(runtime) || !environment || typeof environment !== 'object') throw new Error('E2E_SCENARIO_INVALID');
    if (runtime === 'browser' && environment.KOGG_E2E_EXECUTION_ONLY === '1') return 'execution-refusal';
    if (runtime === 'browser' && environment.KOGG_E2E_PROJECTS_ONLY === '1') return 'projects';
    if (runtime === 'browser' && environment.KOGG_E2E_TASKS_ONLY === '1') return 'tasks';
    if (environment.KOGG_E2E_OPERATIONS_ONLY === '1') return 'operations';
    if (environment.KOGG_E2E_WORKFLOW_ONLY === '1') return 'workflow';
    if (runtime === 'browser' && environment.KOGG_E2E_VERDICT_MERGE_ONLY === '1') return 'verdict-merge';
    return 'portable-surface';
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function platformName() { return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'; }
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value); }
function event(name, fields) { return `[kogg:e2e:harness] ${name} ${JSON.stringify(fields)}`; }
