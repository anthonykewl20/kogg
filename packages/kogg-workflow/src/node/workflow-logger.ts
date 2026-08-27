import type { WorkflowSafeCode } from '../common/workflow-protocol';

// diagnostic-coverage: workflow.schema, workflow.catalog, workflow.graph, workflow.anchors, workflow.authority, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.recovery

type Fields = {
  'draft.command.requested': { operation: 'validate' };
  'draft.command.completed': { operation: 'validate'; nodeCount: number; edgeCount: number };
  'draft.command.refused': { operation: 'validate'; safeCode: WorkflowSafeCode };
  'template.version.requested': { requestId: string; templateId: string };
  'template.version.created': { requestId: string; templateId: string; versionId: string; versionNumber: number };
  'template.version.refused': { requestId: string; templateId: string; safeCode: WorkflowSafeCode };
  'template.list.requested': { projectId: string };
  'template.list.completed': { projectId: string; versionCount: number };
  'template.list.refused': { projectId: string; safeCode: WorkflowSafeCode };
  'compile.started': { requestId: string; versionId: string };
  'compile.completed': { requestId: string; versionId: string; planId: string };
  'compile.refused': { requestId: string; versionId: string; safeCode: WorkflowSafeCode };
  'run.admission.requested': { requestId: string; planId: string };
  'run.admission.refused': { requestId: string; planId: string; safeCode: WorkflowSafeCode; unavailableExecutorCount: number };
  'run.recovery.quarantined': { runId: string; safeCode: 'WORKFLOW_OUTCOME_UNKNOWN' };
  'owner.publish.failed': { safeCode: 'WORKFLOW_STORE_INTEGRITY'; errorType: string };
  'recovery.started': { versionCount: number; activeRunCount: number; pendingOutboxCount: number };
  'recovery.completed': { versionCount: number; activeProcessCount: number; quarantinedRunCount: number };
  'registry.stop.started': Record<string, never>;
  'registry.stop.completed': Record<string, never>;
  'registry.stop.failed': { errorType: string };
  'diagnostics.failed': { errorType: string };
};

export function workflowLog<K extends keyof Fields>(event: K, fields: Fields[K]): void {
  if (event === 'draft.command.requested') console.info('[kogg:workflow:editor] draft.command.requested', fields);
  else if (event === 'draft.command.completed') console.info('[kogg:workflow:editor] draft.command.completed', fields);
  else if (event === 'draft.command.refused') console.warn('[kogg:workflow:editor] draft.command.refused', fields);
  else if (event === 'template.version.requested') console.info('[kogg:workflow:editor] template.version.requested', fields);
  else if (event === 'template.version.created') console.info('[kogg:workflow:editor] template.version.created', fields);
  else if (event === 'template.version.refused') console.warn('[kogg:workflow:editor] template.version.refused', fields);
  else if (event === 'template.list.requested') console.info('[kogg:workflow:editor] template.list.requested', fields);
  else if (event === 'template.list.completed') console.info('[kogg:workflow:editor] template.list.completed', fields);
  else if (event === 'template.list.refused') console.warn('[kogg:workflow:editor] template.list.refused', fields);
  else if (event === 'compile.started') console.info('[kogg:workflow:compiler] compile.started', fields);
  else if (event === 'compile.completed') console.info('[kogg:workflow:compiler] compile.completed', fields);
  else if (event === 'compile.refused') console.warn('[kogg:workflow:compiler] compile.refused', fields);
  else if (event === 'run.admission.requested') console.info('[kogg:workflow:engine] run.admission.requested', fields);
  else if (event === 'run.admission.refused') console.warn('[kogg:workflow:engine] run.admission.refused', fields);
  else if (event === 'run.recovery.quarantined') console.warn('[kogg:workflow:recovery] run.recovery.quarantined', fields);
  else if (event === 'owner.publish.failed') console.error('[kogg:workflow:owners] owner.publish.failed', fields);
  else if (event === 'recovery.started') console.info('[kogg:workflow:recovery] recovery.started', fields);
  else if (event === 'recovery.completed') console.info('[kogg:workflow:recovery] recovery.completed', fields);
  else if (event === 'registry.stop.started') console.info('[kogg:workflow:engine] registry.stop.started', fields);
  else if (event === 'registry.stop.completed') console.info('[kogg:workflow:engine] registry.stop.completed', fields);
  else if (event === 'registry.stop.failed') console.error('[kogg:workflow:engine] registry.stop.failed', fields);
  else console.error('[kogg:workflow:recovery] diagnostics.failed', fields);
}
