import { createInterface } from 'node:readline';

// diagnostic-coverage: agents.processes, agents.logging, agents.source-maps
// observability-exempt: The supervised fixture peer writes only its closed protocol to stdout; its parent owns and logs every lifecycle boundary.

const scenario = process.argv[2] ?? 'fixture.echo'; let sequence = 0; let stopped = false;
const emit = (value: Record<string, unknown>): void => { if (!stopped) process.stdout.write(`${JSON.stringify({ sequence: String(++sequence), ...value })}\n`); };
const finish = (code = 0): void => { stopped = true; setTimeout(() => process.exit(code), 5).unref(); };
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => { try { const value = JSON.parse(line) as { kind?: string }; if (value.kind === 'cancel' && scenario !== 'fixture.cancel-grace') { emit({ kind: 'failed', safeCode: 'CANCELLED' }); finish(); } } catch { // observability-exempt: Hostile input is rejected by exit class only; echoing or logging it would leak content.
    finish(2); } });
if (scenario !== 'fixture.handshake') emit({ kind: 'ready', observedModelId: scenario === 'fixture.model-mismatch' ? 'fixture.other' : scenario });
if (scenario === 'fixture.handshake' || scenario === 'fixture.hang' || scenario === 'fixture.cancel-grace') { /* Wait for supervised cancellation. */ }
else if (scenario === 'fixture.provider-request') { emit({ kind: 'activity', activityKind: 'provider' }); emit({ kind: 'provider-request-started' }); }
else if (scenario === 'fixture.idle') setTimeout(() => emit({ kind: 'activity', activityKind: 'provider' }), 25);
else if (scenario === 'fixture.absolute') setInterval(() => emit({ kind: 'activity', activityKind: 'provider' }), 50).unref();
else if (scenario === 'fixture.transport') setTimeout(() => { emit({ kind: 'failed', safeCode: 'TRANSPORT_LOST' }); finish(); }, 25);
else if (scenario === 'fixture.auth') setTimeout(() => { emit({ kind: 'failed', safeCode: 'PROVIDER_AUTH_REFUSED' }); finish(); }, 25);
else if (scenario === 'fixture.rate') setTimeout(() => { emit({ kind: 'failed', safeCode: 'PROVIDER_RATE_LIMITED' }); finish(); }, 25);
else if (scenario === 'fixture.invalid') setTimeout(() => process.stdout.write('{"kind":"activity"}\n'), 25);
else if (scenario === 'fixture.refuse') setTimeout(() => { emit({ kind: 'failed', safeCode: 'PROVIDER_REFUSED' }); finish(); }, 25);
else if (scenario === 'fixture.usage-decrease') setTimeout(() => { emit({ kind: 'activity', activityKind: 'provider' }); emit({ kind: 'usage', usage: { status: 'complete', source: 'provider-cumulative', inputTokens: '2', outputTokens: '2', totalTokens: '4' } }); emit({ kind: 'usage', usage: { status: 'complete', source: 'provider-cumulative', inputTokens: '1', outputTokens: '2', totalTokens: '3' } }); emit({ kind: 'completed' }); finish(); }, 25);
else if (scenario === 'fixture.usage-mode-switch') setTimeout(() => { emit({ kind: 'activity', activityKind: 'provider' }); emit({ kind: 'usage', usage: { status: 'partial', source: 'provider-cumulative', totalTokens: '1' } }); emit({ kind: 'usage', usage: { status: 'complete', source: 'provider-delta', totalTokens: '1' } }); emit({ kind: 'completed' }); finish(); }, 25);
else if (scenario === 'fixture.usage-overflow') setTimeout(() => { emit({ kind: 'activity', activityKind: 'provider' }); emit({ kind: 'usage', usage: { status: 'complete', source: 'provider-cumulative', totalTokens: '9007199254740992' } }); emit({ kind: 'completed' }); finish(); }, 25);
else setTimeout(() => { emit({ kind: 'provider-request-started' }); emit({ kind: 'activity', activityKind: 'provider' }); emit({ kind: 'usage', usage: { status: 'complete', source: 'provider-cumulative', inputTokens: '1', outputTokens: '1', totalTokens: '2' } }); emit({ kind: 'provider-request-settled' }); emit({ kind: 'completed' }); finish(); }, 25);
