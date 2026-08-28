import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { HarnessProcessRegistry } from './e2e-process-registry.mjs';

class FakeChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    signals = [];
    constructor(privateBehavior = 'term') { super(); this.privateBehavior = privateBehavior; }
    kill(signal) {
        this.signals.push(signal);
        if (this.privateBehavior === 'term' || signal === 'SIGKILL' && this.privateBehavior === 'kill') {
            this.signalCode = signal;
            queueMicrotask(() => this.emit('exit', null, signal));
        }
        return true;
    }
}

test('registers safe lifecycle facts and cleans fixtures in reverse ownership order', async () => {
    const logs = []; const registry = new HarnessProcessRegistry({ logger: line => logs.push(line) });
    const first = registry.adopt('signed-registry', new FakeChild()); const second = registry.adopt('browser-backend', new FakeChild());
    registry.ready(first); registry.ready(second); await registry.cleanup(10);
    const completed = logs.filter(line => line.includes('fixture.cleanup.completed'));
    assert.match(completed[0], /browser-backend/u); assert.match(completed[1], /signed-registry/u);
    assert.deepEqual(registry.manifest().map(record => record.state), ['cleaned','cleaned']);
    assert.doesNotMatch(logs.join('\n'), /command|argument|environment|private/iu);
});

test('classifies forced cleanup and refuses a residual child', async () => {
    const forced = new FakeChild('kill'); const registry = new HarnessProcessRegistry({ logger: () => undefined }); registry.adopt('electron-application', forced); await registry.cleanup(1);
    assert.deepEqual(forced.signals, ['SIGTERM','SIGKILL']); assert.equal(registry.manifest()[0].forced, true);
    const residual = new FakeChild('never'); const refusing = new HarnessProcessRegistry({ logger: () => undefined }); refusing.adopt('browser-backend', residual);
    await assert.rejects(refusing.cleanup(1), /E2E_PROCESS_RESIDUAL/u); assert.equal(refusing.manifest()[0].state, 'residual');
});
