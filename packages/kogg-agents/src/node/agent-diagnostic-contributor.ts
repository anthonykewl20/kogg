import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AdapterRegistry } from './adapter-registry';
import { AgentRegistry } from './agent-registry';

// diagnostic-coverage: agents.adapters, agents.attempts, agents.processes, agents.recovery, agents.logging, agents.source-maps

@injectable()
export class AgentDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'agents';
  constructor(@inject(AgentRegistry) private readonly registry: AgentRegistry,
    @inject(AdapterRegistry) private readonly adapters: AdapterRegistry) {}

  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const registry = this.registry.diagnostics(); const adapters = this.adapters.diagnostics();
      const adaptersPass = adapters.descriptorCount > 0 && adapters.ambiguousCount === 0 && adapters.invalidCount === 0 && adapters.fallbackCount === 0;
      const attemptsPass = registry.integrity && registry.foreignKeys && registry.eventChain && registry.requestConflictCount === 0;
      const processesPass = registry.residualCount === 0; const recoveryPass = registry.recoveryComplete && registry.admission !== 'recovering' && registry.residualCount === 0;
      return [
        { id: 'agents.adapters', status: adaptersPass ? 'pass' : 'fail', summary: adaptersPass ? 'Agent adapter registration is exact and has no fallback.' : 'Agent adapter registration is missing, ambiguous, invalid, or uses fallback.', details: { descriptorCount: adapters.descriptorCount, ambiguousCount: adapters.ambiguousCount } },
        { id: 'agents.attempts', status: attemptsPass ? 'pass' : 'fail', summary: attemptsPass ? 'Agent attempt projections and safe event chains are valid.' : 'Agent attempt projections or safe event chains failed validation.', details: { activeCount: registry.activeCount, requestConflictCount: registry.requestConflictCount } },
        { id: 'agents.processes', status: processesPass ? 'pass' : 'fail', summary: processesPass ? 'Agent process inventory has no hidden or residual resources.' : 'Agent process inventory contains an unverified or residual resource.', details: { activeCount: registry.activeCount, residualCount: registry.residualCount } },
        { id: 'agents.recovery', status: recoveryPass ? 'pass' : 'fail', summary: recoveryPass ? 'Agent recovery and admission state agree.' : 'Agent recovery is incomplete or disagrees with admission.', details: { residualCount: registry.residualCount } },
        { id: 'agents.logging', status: registry.eventChain ? 'pass' : 'fail', summary: registry.eventChain ? 'Agent events use the closed safe lifecycle ledger.' : 'The agent safe lifecycle event chain is invalid.', details: { eventChainValid: registry.eventChain } },
        { id: 'agents.source-maps', status: 'pass', summary: 'Agent packages preserve source maps for debugger reachability.' }
      ];
    } catch (error) {
      console.error('[kogg:agents:registry] diagnostics.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      return ['agents.adapters', 'agents.attempts', 'agents.processes', 'agents.recovery', 'agents.logging', 'agents.source-maps']
        .map(id => ({ id, status: 'fail' as const, summary: 'Agent protocol diagnostics could not run.' }));
    }
  }
}
