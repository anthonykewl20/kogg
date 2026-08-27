import { inject, injectable } from '@theia/core/shared/inversify';
import type { EditableNodeKind, WorkflowAuthorityEffect } from '../common/workflow-protocol';
import { workflowDigest } from '../common/workflow-canonical';
import { WorkflowExecutorRegistry, type WorkflowExecutorBindingV1 } from './workflow-executor-registry';

// The catalog is compiled in, canonical, and closed. Process-free control artifacts are exact-attested; external executors remain explicitly unavailable.
// observability-exempt: Pure immutable catalog declarations perform no operational I/O.
// diagnostic-coverage: workflow.catalog, workflow.graph, workflow.authority, workflow.source-maps
export interface WorkflowCatalogEntryV1 {
  readonly kind: EditableNodeKind; readonly kindVersion: '1'; readonly inputPorts: readonly ['in'];
  readonly outputPorts: readonly ('success' | 'failure' | 'finally' | 'true' | 'false')[];
  readonly grantCeiling: readonly WorkflowAuthorityEffect[]; readonly retryClass: 'none' | 'read-only' | 'idempotent-exact-key' | 'fresh-authority';
  readonly sideEffectClass: 'none' | 'private-mutation' | 'external-call' | 'approval' | 'verification';
  readonly absoluteDeadlineMs: number; readonly diagnosticId: string;
  readonly executor: ({ readonly status: 'available' } & WorkflowExecutorBindingV1) | { readonly status: 'unavailable'; readonly safeCode: 'WORKFLOW_EXECUTOR_INCOMPATIBLE' };
}

const DEFINITIONS: Readonly<Record<EditableNodeKind, Omit<WorkflowCatalogEntryV1, 'kind' | 'kindVersion' | 'inputPorts' | 'executor'>>> = {
  'research.agent': definition(['read-repository','invoke-provider'], 'fresh-authority', 'external-call', 900_000),
  'pseudocode.agent': definition(['read-repository','mutate-private-repository','invoke-provider'], 'fresh-authority', 'private-mutation', 900_000),
  'probe.agent': definition(['read-repository','mutate-private-repository','invoke-provider','run-tool'], 'fresh-authority', 'private-mutation', 900_000),
  'implementation.agent': definition(['read-repository','mutate-private-repository','invoke-provider','run-tool'], 'fresh-authority', 'private-mutation', 1_800_000),
  'tool.git': definition(['read-repository','mutate-private-repository','run-tool'], 'idempotent-exact-key', 'private-mutation', 120_000),
  'tool.build': definition(['read-repository','run-tool'], 'read-only', 'external-call', 900_000),
  'check.deterministic': definition(['read-repository','run-tool','record-check'], 'read-only', 'verification', 900_000),
  'approval.specification': definition(['record-approval'], 'none', 'approval', 86_400_000),
  'approval.continue': definition(['record-approval'], 'none', 'approval', 86_400_000),
  'control.condition': definition([], 'none', 'none', 1_000, ['true','false','failure','finally']),
  'control.parallel': definition([], 'none', 'none', 1_000), 'control.join': definition([], 'none', 'none', 1_000),
  'control.group': definition([], 'none', 'none', 1_000), 'control.finally': definition([], 'none', 'none', 1_000)
};

@injectable()
export class WorkflowNodeCatalog {
  readonly entries: readonly WorkflowCatalogEntryV1[];
  readonly digest: string;
  constructor(@inject(WorkflowExecutorRegistry) private readonly executors: WorkflowExecutorRegistry) {
    this.entries = (Object.keys(DEFINITIONS) as EditableNodeKind[]).sort().map(kind => {
      const binding = executors.binding(kind); if (binding) executors.resolveExact(kind, binding); return { kind, kindVersion: '1', inputPorts: ['in'], ...DEFINITIONS[kind], executor: binding ? { status: 'available', ...binding } : { status: 'unavailable', safeCode: 'WORKFLOW_EXECUTOR_INCOMPATIBLE' } };
    });
    this.digest = workflowDigest('catalog', { schemaVersion: '1', entries: this.entries });
  }
  entry(kind: EditableNodeKind): WorkflowCatalogEntryV1 { const value = this.entries.find(item => item.kind === kind); if (!value) throw new Error('Closed workflow catalog is incomplete'); return value; }
  executeControl(request: Parameters<WorkflowExecutorRegistry['execute']>[0]) { const binding = this.executors.binding(request.node.kind); if (!binding) return { kind: 'refused', code: 'WORKFLOW_EXECUTOR_INCOMPATIBLE', processCount: 0, residualProcessCount: 0 } as const; return this.executors.execute(request, binding); }
  diagnostics(): { readonly valid: boolean; readonly entryCount: number; readonly availableExecutorCount: number; readonly unavailableExecutorCount: number } {
    return { valid: this.entries.length === 14 && new Set(this.entries.map(entry => `${entry.kind}@${entry.kindVersion}`)).size === 14, entryCount: this.entries.length, availableExecutorCount: this.entries.filter(entry => entry.executor.status === 'available').length, unavailableExecutorCount: this.entries.filter(entry => entry.executor.status === 'unavailable').length };
  }
}

function definition(grantCeiling: readonly WorkflowAuthorityEffect[], retryClass: WorkflowCatalogEntryV1['retryClass'], sideEffectClass: WorkflowCatalogEntryV1['sideEffectClass'], absoluteDeadlineMs: number,
  outputPorts: WorkflowCatalogEntryV1['outputPorts'] = ['success','failure','finally']): Omit<WorkflowCatalogEntryV1, 'kind' | 'kindVersion' | 'inputPorts' | 'executor'> {
  return { outputPorts, grantCeiling: [...grantCeiling].sort(), retryClass, sideEffectClass, absoluteDeadlineMs, diagnosticId: 'workflow.scheduler' };
}
