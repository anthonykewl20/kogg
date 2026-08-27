import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdapterDescriptorV1, AgentAdapterFactory } from '../common/agents-protocol';
import { AdapterRegistry, AdapterResolutionError } from './adapter-registry';

// diagnostic-coverage: agents.adapters, agents.logging

test('resolves one exact descriptor without fallback and deduplicates identical contributions', () => {
  const registry = new AdapterRegistry(); const factory = adapter(); registry.register(factory); registry.register(factory);
  assert.equal(registry.descriptors().length, 1); assert.equal(registry.resolveExact(request()), factory);
  assert.throws(() => registry.resolveExact({ ...request(), adapterVersion: '2.0.0' }), error => error instanceof AdapterResolutionError && error.code === 'ADAPTER_UNAVAILABLE');
});

test('classifies disabled, protocol, provider, capability, and ambiguous resolution before creation', () => {
  const cases: readonly [Partial<AdapterDescriptorV1>, Partial<ReturnType<typeof request>>, AdapterResolutionError['code']][] = [
    [{ enabled: false }, {}, 'ADAPTER_DISABLED'],
    [{ protocolVersion: '2.0.0' }, {}, 'PROTOCOL_UNSUPPORTED'],
    [{ providerIds: ['other.provider'] }, {}, 'PROVIDER_MISMATCH'],
    [{ capabilityIds: ['other-capability'] }, {}, 'CAPABILITY_MISMATCH']
  ];
  for (const [descriptor, input, code] of cases) { const registry = new AdapterRegistry(); registry.register(adapter(descriptor)); assert.throws(() => registry.resolveExact({ ...request(), ...input }), error => error instanceof AdapterResolutionError && error.code === code); }
  const ambiguous = new AdapterRegistry(); ambiguous.register(adapter()); ambiguous.register(adapter({ protocolId: 'fixture.peer.alternate' }));
  assert.throws(() => ambiguous.resolveExact(request()), error => error instanceof AdapterResolutionError && error.code === 'ADAPTER_RESOLUTION_AMBIGUOUS'); assert.equal(ambiguous.diagnostics().ambiguousCount, 1);
});

test('rejects open, duplicated, and invalid runtime descriptor fields', () => {
  const invalid: unknown[] = [
    { ...descriptor(), secret: 'must-not-be-accepted' },
    { ...descriptor(), ownerKind: 'unknown' },
    { ...descriptor(), executionKind: 'ambient' },
    { ...descriptor(), usageModes: ['provider-cumulative', 'provider-cumulative'] },
    { ...descriptor(), providerIds: [] }
  ];
  for (const value of invalid) assert.throws(() => new AdapterRegistry().register({ descriptor: value as AdapterDescriptorV1, create: () => { throw new Error('must not create'); } }), /ADAPTER_DESCRIPTOR_INVALID/u);
});

function request() { return { adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', providerId: 'kogg.fixture', modelId: 'fixture.echo', requiredCapabilities: ['provider-turn'] }; }
function descriptor(overrides: Partial<AdapterDescriptorV1> = {}): AdapterDescriptorV1 { return { schemaVersion: '1', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', protocolId: 'fixture.peer', protocolVersion: '1.0.0', providerIds: ['kogg.fixture'], capabilityIds: ['provider-turn'], executionKind: 'supervised-host', cancellation: 'cooperative-and-owned-cleanup', usageModes: ['provider-cumulative'], ownerKind: 'kogg', enabled: true, ...overrides }; }
function adapter(overrides: Partial<AdapterDescriptorV1> = {}): AgentAdapterFactory { return { descriptor: descriptor(overrides), create: () => { throw new Error('creation is outside this registry test'); } }; }
