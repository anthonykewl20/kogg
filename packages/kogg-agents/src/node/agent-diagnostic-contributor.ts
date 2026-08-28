import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import path from 'node:path';
import { inject, injectable } from '@theia/core/shared/inversify';
import { agentLog, agentLoggingDiagnostics } from '../common/agent-logger';
import { AdapterRegistry } from './adapter-registry';
import { AgentRegistry } from './agent-registry';
import { inspectSourceMaps } from './source-map-diagnostics';

// Logs through the closed [kogg:agents:registry] agentLog schema.
// diagnostic-coverage: agents.adapters, agents.attempts, agents.processes, agents.recovery, agents.logging, agents.source-maps

@injectable()
export class AgentDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'agents';
  constructor(@inject(AgentRegistry) private readonly registry: AgentRegistry,
    @inject(AdapterRegistry) private readonly adapters: AdapterRegistry) {}

  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const registry = this.registry.diagnostics(); const adapters = this.adapters.diagnostics(); const logging = agentLoggingDiagnostics(); const roots = [...new Set([process.env.KOGG_ROOT, process.cwd()].filter((root): root is string => Boolean(root)).map(root => path.resolve(root)))]; const sourceMaps = inspectSourceMaps(__dirname, ['adapter-registry', 'agent-diagnostic-contributor', 'agent-operations-owner-wiring', 'agent-registry', 'backend-module', 'credential-lease-authority', 'fixture-adapter', 'fixture-host', 'interaction-mode-transition-owner', 'source-map-diagnostics'], { packageFolder: 'kogg-agents', moduleDirectories: roots.flatMap(root => [path.join(root, 'packages/kogg-agents/lib/node'), path.join(root, 'node_modules/@kogg/agents/lib/node')]) });
      const adaptersPass = adapters.descriptorCount > 0 && adapters.ambiguousCount === 0 && adapters.invalidCount === 0 && adapters.fallbackCount === 0;
      const attemptsPass = registry.integrity && registry.foreignKeys && registry.eventChain && registry.requestConflictCount === 0;
      const processesPass = registry.residualCount === 0; const recoveryPass = registry.recoveryComplete && registry.admission !== 'recovering' && registry.residualCount === 0;
      return [
        { id: 'agents.adapters', status: adaptersPass ? 'pass' : 'fail', summary: adaptersPass ? 'Agent adapter registration is exact and has no fallback.' : 'Agent adapter registration is missing, ambiguous, invalid, or uses fallback.', details: { descriptorCount: adapters.descriptorCount, ambiguousCount: adapters.ambiguousCount } },
        { id: 'agents.attempts', status: attemptsPass ? 'pass' : 'fail', summary: attemptsPass ? 'Agent attempt projections and safe event chains are valid.' : 'Agent attempt projections or safe event chains failed validation.', details: { activeCount: registry.activeCount, requestConflictCount: registry.requestConflictCount } },
        { id: 'agents.processes', status: processesPass ? 'pass' : 'fail', summary: processesPass ? 'Agent process inventory has no hidden or residual resources.' : 'Agent process inventory contains an unverified or residual resource.', details: { activeCount: registry.activeCount, residualCount: registry.residualCount } },
        { id: 'agents.recovery', status: recoveryPass ? 'pass' : 'fail', summary: recoveryPass ? 'Agent recovery and admission state agree.' : 'Agent recovery is incomplete or disagrees with admission.', details: { residualCount: registry.residualCount } },
        { id: 'agents.logging', status: registry.eventChain && logging.schemaCount > 0 && logging.violationCount === 0 ? 'pass' : 'fail', summary: registry.eventChain && logging.schemaCount > 0 && logging.violationCount === 0 ? 'Agent logs and events use closed safe schemas.' : 'The agent log schema or safe lifecycle event chain is invalid.', details: { eventChainValid: registry.eventChain, schemaCount: logging.schemaCount, violationCount: logging.violationCount } },
        { id: 'agents.source-maps', status: sourceMaps.missingCount === 0 ? 'pass' : 'fail', summary: sourceMaps.missingCount === 0 ? 'Every agent supervisor and adapter-host failure boundary has a debugger source map.' : 'An agent supervisor or adapter-host failure boundary is missing its debugger source map.', details: { ...sourceMaps } }
      ];
    } catch (error) { // observability-exempt: closed agentLog emits the sanitized diagnostic failure before fail-closed results are returned.
      agentLog('diagnostics.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      return ['agents.adapters', 'agents.attempts', 'agents.processes', 'agents.recovery', 'agents.logging', 'agents.source-maps']
        .map(id => ({ id, status: 'fail' as const, summary: 'Agent protocol diagnostics could not run.' }));
    }
  }
}
