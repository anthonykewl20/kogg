import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TRANSITIONS = { requested: ['starting'], starting: ['active','cleaning'], active: ['cleaning'], cleaning: ['completed','failed'], completed: [], failed: [] };
const PLATFORMS = ['linux','macos','windows']; const RUNTIMES = ['browser','electron'];
const FIXTURE_KINDS = ['browser-backend','electron-application','signed-registry']; const FIXTURE_STATES = ['started','ready','exited','cleaned','residual'];
const CAPABILITY_NAMES = ['governed-generation','terminal-debug']; const CAPABILITY_STATUSES = ['available','pending-qualification','refusal-required','runtime-delegated'];
const SCENARIOS = ['portable-surface','execution-refusal','projects','tasks','operations','workflow','verdict-merge'];
const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u; const SHA256 = /^[0-9a-f]{64}$/u;

export class HarnessRunManifest {
    constructor(root, value, logger) { this.root = root; this.value = value; this.logger = logger; this.directory = path.join(root, value.runId, value.platform, value.runtime); }

    static async create({ root, runtime, capabilities, platform = platformName(), runId = randomUUID(), logger = () => undefined }) {
        if (typeof root !== 'string' || !uuid(runId) || !PLATFORMS.includes(platform) || !RUNTIMES.includes(runtime)) throw new Error('E2E_MANIFEST_INVALID');
        const manifest = new HarnessRunManifest(root, { schemaVersion: 1, runId, platform, runtime, state: 'requested', capabilities: validateCapabilities(capabilities, platform, runtime), fixtures: [], artifacts: [], harnessChecks: [], residualCount: 0, environment: { platform, runtime } }, logger);
        await mkdir(manifest.directory, { recursive: true, mode: 0o700 }); await manifest.#write(); manifest.#log('run.requested'); return manifest;
    }

    get runId() { return this.value.runId; }
    get platform() { return this.value.platform; }
    get runtime() { return this.value.runtime; }
    async starting() { await this.#transition('starting'); this.#log('run.started'); }
    async active(scenarioId) { if (!SCENARIOS.includes(scenarioId)) throw new Error('E2E_MANIFEST_INVALID'); await this.#transition('active', { scenarioId, scenarioState: 'active', steps: [{ id: 'visible-journey', state: 'active' }] }); this.#log('scenario.started', { scenarioId }); this.#log('step.started', { scenarioId, stepId: 'visible-journey' }); }
    async scenarioCompleted() { this.#scenarioTerminal('completed'); await this.#write(); this.#log('step.completed', { scenarioId: this.value.scenarioId, stepId: 'visible-journey' }); this.#log('scenario.completed', { scenarioId: this.value.scenarioId }); }
    async scenarioFailed() { this.#scenarioTerminal('failed'); await this.#write(); this.#log('step.failed', { scenarioId: this.value.scenarioId, stepId: 'visible-journey', safeCode: 'E2E_STEP_FAILED' }); this.#log('scenario.failed', { scenarioId: this.value.scenarioId, safeCode: 'E2E_STEP_FAILED' }); }
    async cleaning(fixtures) { const patch = { fixtures: validateFixtures(fixtures) }; if (this.value.state === 'cleaning') { this.value = { ...this.value, ...patch }; await this.#write(); return; } if (this.value.state === 'active' && !['completed','failed'].includes(this.value.scenarioState)) throw new Error('E2E_MANIFEST_SCENARIO_INCOMPLETE'); await this.#transition('cleaning', patch); this.#log('residual-check.started'); }
    async completed({ fixtures, artifacts = [], residualCount = 0, verification }) {
        const final = finalFields(fixtures, artifacts, residualCount, verification); if (this.value.scenarioState !== 'completed' || this.value.steps?.some(step => step.state !== 'passed') || final.harnessChecks.some(check => check.status !== 'pass')) throw new Error('E2E_MANIFEST_SUCCESS_REFUSED');
        await this.#transition('completed', final); this.#log('residual-check.completed', { residualCount }); this.#log('run.completed');
    }
    async failed({ fixtures, artifacts = [], residualCount = 0, verification = { oracle: 'fail', sourceMap: 'fail', mappedCount: 0 }, safeCode = 'E2E_SCENARIO_FAILED', errorType = 'Error' }) {
        if (!SAFE.test(safeCode) || !['Error','AssertionError','TimeoutError'].includes(errorType)) throw new Error('E2E_MANIFEST_INVALID');
        const final = finalFields(fixtures, artifacts, residualCount, verification); if (safeCode === 'E2E_ARTIFACT_UNSAFE') final.harnessChecks.find(check => check.id === 'e2e.artifacts').status = 'fail'; if (safeCode === 'E2E_PROCESS_RESIDUAL') final.harnessChecks.find(check => check.id === 'e2e.processes').status = 'fail';
        await this.#transition('failed', { ...final, safeCode, errorType }); this.#log('residual-check.failed', { residualCount, safeCode }); this.#log('run.failed', { safeCode, errorType });
    }
    async read() { return JSON.parse(await readFile(path.join(this.directory, 'manifest.json'), 'utf8')); }

    async #transition(next, patch = {}) {
        if (!TRANSITIONS[this.value.state].includes(next)) throw new Error('E2E_MANIFEST_TRANSITION_INVALID');
        this.value = { ...this.value, ...patch, state: next }; await this.#write();
    }
    #scenarioTerminal(state) { if (this.value.state !== 'active' || this.value.scenarioState !== 'active' || this.value.steps?.length !== 1 || this.value.steps[0].state !== 'active') throw new Error('E2E_MANIFEST_SCENARIO_INVALID'); this.value = { ...this.value, scenarioState: state, steps: [{ id: 'visible-journey', state: state === 'completed' ? 'passed' : 'failed', ...(state === 'failed' ? { safeCode: 'E2E_STEP_FAILED' } : {}) }] }; }
    async #write() {
        const text = `${JSON.stringify(this.value, null, 2)}\n`; const temporary = path.join(this.directory, `.manifest.${randomUUID()}.tmp`);
        await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await rename(temporary, path.join(this.directory, 'manifest.json'));
    }
    #log(name, fields = {}) { this.logger(`[kogg:e2e:harness] ${name} ${JSON.stringify({ runId: this.value.runId, platform: this.value.platform, runtime: this.value.runtime, ...fields })}`); }
}

function finalFields(fixtures, artifacts, residualCount, verification) {
    const validatedFixtures = validateFixtures(fixtures); const validatedArtifacts = validateArtifacts(artifacts);
    if (!Number.isSafeInteger(residualCount) || residualCount < 0 || !verification || Object.keys(verification).sort().join(',') !== 'mappedCount,oracle,sourceMap' || !['pass','fail'].includes(verification.oracle) || !['pass','fail'].includes(verification.sourceMap) || !Number.isSafeInteger(verification.mappedCount) || verification.mappedCount < 0 || verification.sourceMap === 'pass' && verification.mappedCount < 1) throw new Error('E2E_MANIFEST_INVALID');
    const fixturePass = validatedFixtures.every(value => value.state === 'cleaned'); const artifactPass = validatedArtifacts.every(value => value.status === 'retained' || value.status === 'refused');
    return { fixtures: validatedFixtures, artifacts: validatedArtifacts, residualCount, harnessChecks: [
        { id: 'e2e.fixtures', status: fixturePass ? 'pass' : 'fail', count: validatedFixtures.length },
        { id: 'e2e.processes', status: residualCount === 0 && fixturePass ? 'pass' : 'fail', residualCount },
        { id: 'e2e.artifacts', status: artifactPass ? 'pass' : 'fail', count: validatedArtifacts.length },
        { id: 'e2e.oracle', status: verification.oracle },
        { id: 'e2e.source-map', status: verification.sourceMap, mappedCount: verification.mappedCount }
    ] };
}
function validateFixtures(values) {
    if (!Array.isArray(values) || values.length > 16) throw new Error('E2E_MANIFEST_INVALID');
    return values.map(value => { if (!value || Object.keys(value).sort().join(',') !== ['exitClass','forced','id','kind','state'].sort().join(',') || !/^fixture-[1-9][0-9]*$/u.test(value.id) || !FIXTURE_KINDS.includes(value.kind) || !FIXTURE_STATES.includes(value.state) || typeof value.forced !== 'boolean' || !['zero','nonzero','signal','unknown'].includes(value.exitClass)) throw new Error('E2E_MANIFEST_INVALID'); return { ...value }; });
}
function validateArtifacts(values) {
    if (!Array.isArray(values) || values.length > 16) throw new Error('E2E_MANIFEST_INVALID');
    return values.map(value => { const keys = Object.keys(value).sort().join(','); if (!value || !['digest,kind,status','kind,safeCode,status'].includes(keys) || !SAFE.test(value.kind) || !['retained','refused'].includes(value.status) || value.status === 'retained' && !SHA256.test(value.digest) || value.status === 'refused' && !SAFE.test(value.safeCode)) throw new Error('E2E_MANIFEST_INVALID'); return { ...value }; });
}
function validateCapabilities(values, platform, runtime) {
    if (!Array.isArray(values) || values.length !== CAPABILITY_NAMES.length) throw new Error('E2E_MANIFEST_INVALID');
    const result = values.map(value => { if (!value || Object.keys(value).sort().join(',') !== 'name,safeCode,status' || !CAPABILITY_NAMES.includes(value.name) || !CAPABILITY_STATUSES.includes(value.status) || !SAFE.test(value.safeCode)) throw new Error('E2E_MANIFEST_INVALID'); return { ...value }; });
    if (new Set(result.map(value => value.name)).size !== CAPABILITY_NAMES.length) throw new Error('E2E_MANIFEST_INVALID');
    const expected = {
        'governed-generation': platform === 'linux' ? ['pending-qualification','E2E_CAPABILITY_PENDING'] : ['refusal-required','E2E_CAPABILITY_UNQUALIFIED'],
        'terminal-debug': runtime === 'browser' && platform === 'windows' ? ['runtime-delegated','E2E_CAPABILITY_RUNTIME_DELEGATED'] : ['available','E2E_CAPABILITY_AVAILABLE']
    };
    if (result.some(value => value.status !== expected[value.name][0] || value.safeCode !== expected[value.name][1])) throw new Error('E2E_MANIFEST_INVALID'); return result;
}
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value); }
function platformName() { return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'; }
