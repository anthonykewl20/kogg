import { spawn } from 'node:child_process';

const KINDS = new Set(['browser-backend', 'electron-application', 'signed-registry']);

export class HarnessProcessRegistry {
    #records = [];
    #sequence = 0;

    constructor({ logger = line => process.stderr.write(`${line}\n`), spawnProcess = spawn } = {}) {
        this.logger = logger;
        this.spawnProcess = spawnProcess;
    }

    launch(kind, command, args, options) {
        const child = this.spawnProcess(command, args, options);
        return this.adopt(kind, child);
    }

    adopt(kind, child) {
        if (!KINDS.has(kind) || !child || typeof child.kill !== 'function') throw new Error('E2E_PROCESS_REGISTRATION_FAILED');
        if (this.#records.some(record => record.child === child)) throw new Error('E2E_PROCESS_REGISTRATION_FAILED');
        const record = { id: `fixture-${++this.#sequence}`, kind, child, state: 'started', forced: false, exitClass: undefined };
        this.#records.push(record);
        child.once?.('exit', (code, signal) => {
            record.exitClass = signal ? 'signal' : code === 0 ? 'zero' : 'nonzero';
            if (record.state !== 'cleaned') record.state = 'exited';
        });
        this.#log('fixture.registered', record);
        this.#log('fixture.started', record);
        return child;
    }

    ready(child) {
        const record = this.#record(child);
        if (record.state !== 'started') throw new Error('E2E_PROCESS_STATE_INVALID');
        record.state = 'ready';
        this.#log('fixture.ready', record);
    }

    async stop(child, timeoutMs = 5_000) {
        if (!child) return;
        const record = this.#record(child);
        if (record.state === 'cleaned') return;
        this.#log('fixture.cleanup.started', record);
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            if (!await exited(child, timeoutMs)) {
                record.forced = true;
                child.kill('SIGKILL');
                if (!await exited(child, timeoutMs)) {
                    record.state = 'residual';
                    this.#log('fixture.cleanup.failed', record, 'E2E_PROCESS_RESIDUAL');
                    throw new Error('E2E_PROCESS_RESIDUAL');
                }
            }
        }
        record.exitClass ??= child.signalCode ? 'signal' : child.exitCode === 0 ? 'zero' : 'nonzero';
        record.state = 'cleaned';
        this.#log('fixture.cleanup.completed', record);
    }

    async cleanup(timeoutMs = 5_000) {
        let failure;
        for (const record of [...this.#records].reverse()) {
            try { await this.stop(record.child, timeoutMs); } catch (error) { failure ??= error; }
        }
        if (failure) throw failure;
    }

    manifest() {
        return Object.freeze(this.#records.map(({ id, kind, state, forced, exitClass }) => Object.freeze({ id, kind, state, forced, exitClass: exitClass ?? 'unknown' })));
    }

    #record(child) {
        const record = this.#records.find(candidate => candidate.child === child);
        if (!record) throw new Error('E2E_PROCESS_UNREGISTERED');
        return record;
    }

    #log(event, record, safeCode) {
        this.logger(`[kogg:e2e:harness] ${event} ${JSON.stringify({ fixtureId: record.id, fixtureKind: record.kind, ...(safeCode ? { safeCode } : {}), ...(event === 'fixture.cleanup.completed' ? { exitClass: record.exitClass, forced: record.forced } : {}) })}`);
    }
}

function exited(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
        let settled = false;
        const finish = value => { if (settled) return; settled = true; clearTimeout(timer); child.off?.('exit', onExit); resolve(value); };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once?.('exit', onExit);
    });
}
