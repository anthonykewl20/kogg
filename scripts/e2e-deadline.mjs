export const ABSOLUTE_DEADLINES_MS = Object.freeze({ portable: 15 * 60_000, qualified: 30 * 60_000 });

export class HarnessAbsoluteDeadline {
    constructor({ runId, runtime, platform, qualified = false, onTimeout, logger = () => undefined, schedule = setTimeout, cancel = clearTimeout }) {
        if (!uuid(runId) || !['browser','electron'].includes(runtime) || !['linux','macos','windows'].includes(platform) || typeof qualified !== 'boolean' || typeof onTimeout !== 'function' || typeof logger !== 'function' || typeof schedule !== 'function' || typeof cancel !== 'function') throw safeError('E2E_DEADLINE_INVALID');
        this.context = { runId, platform, runtime }; this.timeoutMs = ABSOLUTE_DEADLINES_MS[qualified ? 'qualified' : 'portable']; this.onTimeout = onTimeout; this.logger = logger; this.schedule = schedule; this.cancel = cancel; this.timer = undefined; this.terminal = false;
    }
    start() {
        if (this.timer !== undefined || this.terminal) throw safeError('E2E_DEADLINE_TRANSITION_INVALID');
        this.logger(event('deadline.started', { ...this.context, deadlineClass: this.timeoutMs === ABSOLUTE_DEADLINES_MS.qualified ? 'qualified' : 'portable' }));
        this.timer = this.schedule(() => {
            if (this.terminal) return;
            this.timer = undefined; this.terminal = true;
            this.logger(event('deadline.timed-out', { ...this.context, safeCode: 'E2E_ABSOLUTE_TIMEOUT' }));
            void Promise.resolve(this.onTimeout(safeError('E2E_ABSOLUTE_TIMEOUT'))).catch(() => undefined);
        }, this.timeoutMs);
    }
    complete() {
        if (this.terminal) return;
        if (this.timer !== undefined) this.cancel(this.timer);
        this.timer = undefined; this.terminal = true;
        this.logger(event('deadline.completed', this.context));
    }
}

function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value); }
function safeError(code) { const error = new Error(code); error.stack = error.message; return error; }
function event(name, fields) { return `[kogg:e2e:harness] ${name} ${JSON.stringify(fields)}`; }
