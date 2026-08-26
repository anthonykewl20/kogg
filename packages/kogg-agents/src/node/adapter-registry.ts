import { injectable } from '@theia/core/shared/inversify';
import type { AdapterRegistryApi, AgentAdapterFactory, AdapterDescriptorV1, AgentSafeCode } from '../common/agents-protocol';

// diagnostic-coverage: agents.adapters
@injectable()
export class AdapterRegistry implements AdapterRegistryApi {
  private readonly factories = new Map<string, AgentAdapterFactory[]>();
  register(factory: AgentAdapterFactory): void {
    validateDescriptor(factory.descriptor);
    const key = descriptorKey(factory.descriptor); const existing = this.factories.get(key) ?? [];
    if (existing.some(item => canonical(item.descriptor) === canonical(factory.descriptor))) return;
    existing.push(factory); this.factories.set(key, existing);
    console.info('[kogg:agents:adapter] adapter.registered', { adapterKey: factory.descriptor.adapterKey, adapterVersion: factory.descriptor.adapterVersion, protocolId: factory.descriptor.protocolId, protocolVersion: factory.descriptor.protocolVersion, ownerKind: factory.descriptor.ownerKind });
  }
  descriptors(): readonly AdapterDescriptorV1[] { return [...this.factories.values()].flat().map(factory => factory.descriptor).sort((a, b) => descriptorKey(a).localeCompare(descriptorKey(b))); }
  resolveExact(input: { adapterKey: string; adapterVersion: string; providerId: string; modelId: string; requiredCapabilities: readonly string[] }): AgentAdapterFactory {
    symbolic(input.adapterKey); semver(input.adapterVersion); symbolic(input.providerId); symbolic(input.modelId); input.requiredCapabilities.forEach(symbolic);
    const exact = this.factories.get(`${input.adapterKey}@${input.adapterVersion}`) ?? [];
    if (!exact.length) throw new AdapterResolutionError('ADAPTER_UNAVAILABLE');
    const enabled = exact.filter(factory => factory.descriptor.enabled); if (!enabled.length) throw new AdapterResolutionError('ADAPTER_DISABLED');
    const compatibleProtocol = enabled.filter(factory => factory.descriptor.protocolVersion.split('.')[0] === '1'); if (!compatibleProtocol.length) throw new AdapterResolutionError('PROTOCOL_UNSUPPORTED');
    const provider = compatibleProtocol.filter(factory => factory.descriptor.providerIds.includes(input.providerId)); if (!provider.length) throw new AdapterResolutionError('PROVIDER_MISMATCH');
    const candidates = provider.filter(factory => input.requiredCapabilities.every(capability => factory.descriptor.capabilityIds.includes(capability))); if (!candidates.length) throw new AdapterResolutionError('CAPABILITY_MISMATCH');
    if (candidates.length !== 1) throw new AdapterResolutionError('ADAPTER_RESOLUTION_AMBIGUOUS');
    return candidates[0]!;
  }
  diagnostics(): { readonly descriptorCount: number; readonly ambiguousCount: number; readonly invalidCount: number; readonly fallbackCount: number } {
    let ambiguousCount = 0; for (const candidates of this.factories.values()) if (candidates.filter(factory => factory.descriptor.enabled).length > 1) ambiguousCount += 1;
    return { descriptorCount: this.descriptors().length, ambiguousCount, invalidCount: 0, fallbackCount: 0 };
  }
}
export class AdapterResolutionError extends Error { constructor(readonly code: Extract<AgentSafeCode, 'ADAPTER_UNAVAILABLE' | 'ADAPTER_RESOLUTION_AMBIGUOUS' | 'ADAPTER_DISABLED' | 'PROTOCOL_UNSUPPORTED' | 'PROVIDER_MISMATCH' | 'CAPABILITY_MISMATCH'>) { super(code); } }
const SYMBOLIC = /^[a-z0-9][a-z0-9._:-]{0,127}$/u; const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
function symbolic(value: string): void { if (!SYMBOLIC.test(value)) throw new Error('ADAPTER_DESCRIPTOR_INVALID'); }
function semver(value: string): void { if (!SEMVER.test(value)) throw new Error('ADAPTER_DESCRIPTOR_INVALID'); }
function descriptorKey(descriptor: AdapterDescriptorV1): string { return `${descriptor.adapterKey}@${descriptor.adapterVersion}`; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
function validateDescriptor(descriptor: AdapterDescriptorV1): void { if (descriptor.schemaVersion !== '1' || descriptor.cancellation !== 'cooperative-and-owned-cleanup') throw new Error('ADAPTER_DESCRIPTOR_INVALID'); [descriptor.adapterKey, descriptor.protocolId, ...descriptor.providerIds, ...descriptor.capabilityIds].forEach(symbolic); semver(descriptor.adapterVersion); semver(descriptor.protocolVersion); if (!descriptor.providerIds.length || descriptor.providerIds.length > 32 || descriptor.capabilityIds.length > 64) throw new Error('ADAPTER_DESCRIPTOR_INVALID'); }
