import { createHash } from 'node:crypto';
import type { EditableWorkflowEdgeV1, EditableWorkflowGraphV1, EditableWorkflowNodeV1, WorkflowAuthorityEffect, WorkflowNodeConfigurationV1, WorkflowSafeCode } from './workflow-protocol';

// observability-exempt: Pure canonical decoding and hashing performs no I/O and retains no content.
// diagnostic-coverage: workflow.schema, workflow.graph, workflow.anchors, workflow.authority

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const NODE_KINDS = new Set(['research.agent','pseudocode.agent','probe.agent','implementation.agent','tool.git','tool.build','check.deterministic','approval.specification','approval.continue','control.condition','control.parallel','control.join','control.group','control.finally']);
const EFFECTS = new Set<WorkflowAuthorityEffect>(['read-repository','mutate-private-repository','run-tool','invoke-provider','record-approval','record-check']);
const OUTCOMES = new Set(['success','failure','finally','true','false']);
const SYMBOLIC = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;

export class WorkflowValidationError extends Error { constructor(readonly code: WorkflowSafeCode) { super(code); } }

export function decodeGraph(input: unknown): EditableWorkflowGraphV1 {
  const value = record(input, ['schemaVersion','projectId','nodes','edges']);
  if (value.schemaVersion !== '1' || typeof value.projectId !== 'string' || !UUID.test(value.projectId) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) fail('WORKFLOW_SCHEMA_INVALID');
  if (value.nodes.length < 1 || value.nodes.length > 256 || value.edges.length > 1024) fail('WORKFLOW_BOUND_EXCEEDED');
  const nodes = value.nodes.map(decodeNode).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const edges = value.edges.map(decodeEdge).sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  return { schemaVersion: '1', projectId: value.projectId, nodes, edges };
}

export function workflowDigest(domain: 'template' | 'catalog' | 'compiled-plan' | 'trust-spine' | 'run-snapshot' | 'scheduler-event' | 'owner-identity' | 'node-configuration', value: unknown): string {
  return createHash('sha256').update(`kogg:workflow:${domain}:v1\n`).update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail('WORKFLOW_SCHEMA_INVALID'); return String(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') { const item = value as Record<string, unknown>; return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(',')}}`; }
  fail('WORKFLOW_SCHEMA_INVALID');
}

function decodeNode(input: unknown): EditableWorkflowNodeV1 {
  const inputKeys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input as Record<string, unknown>) : [];
  const legacy = inputKeys.length === 6 && inputKeys.includes('configurationDigest');
  const value = record(input, legacy ? ['nodeId','kind','kindVersion','configurationDigest','requestedEffects','retry'] : ['nodeId','kind','kindVersion','configurationDigest','configuration','requestedEffects','retry']);
  if (typeof value.kind === 'string' && value.kind.startsWith('anchor.')) fail('WORKFLOW_ANCHOR_BYPASS');
  if (typeof value.nodeId !== 'string' || !UUID.test(value.nodeId) || typeof value.kind !== 'string' || !NODE_KINDS.has(value.kind) || value.kindVersion !== '1' || typeof value.configurationDigest !== 'string' || !DIGEST.test(value.configurationDigest) || !Array.isArray(value.requestedEffects)) fail('WORKFLOW_SCHEMA_INVALID');
  const requestedEffects = value.requestedEffects.map(effect => { if (typeof effect !== 'string' || !EFFECTS.has(effect as WorkflowAuthorityEffect)) fail('WORKFLOW_AUTHORITY_EXPANSION'); return effect as WorkflowAuthorityEffect; });
  if (new Set(requestedEffects).size !== requestedEffects.length) fail('WORKFLOW_SCHEMA_INVALID');
  const retry = record(value.retry, ['maxAttempts','backoffMs','sideEffectPolicy']);
  if (!Number.isSafeInteger(retry.maxAttempts) || Number(retry.maxAttempts) < 1 || Number(retry.maxAttempts) > 3 || ![0,1000,5000,15000].includes(Number(retry.backoffMs)) || !['none','idempotent-exact-key','fresh-authority'].includes(String(retry.sideEffectPolicy))) fail('WORKFLOW_BOUND_EXCEEDED');
  const configuration = legacy ? undefined : decodeConfiguration(value.configuration, value.kind as EditableWorkflowNodeV1['kind']);
  if (configuration && workflowDigest('node-configuration', configuration) !== value.configurationDigest) fail('WORKFLOW_SCHEMA_INVALID');
  return { nodeId: value.nodeId, kind: value.kind as EditableWorkflowNodeV1['kind'], kindVersion: '1', configurationDigest: value.configurationDigest, ...(configuration ? { configuration } : {}), requestedEffects: [...requestedEffects].sort(), retry: { maxAttempts: Number(retry.maxAttempts), backoffMs: Number(retry.backoffMs) as 0 | 1000 | 5000 | 15000, sideEffectPolicy: retry.sideEffectPolicy as EditableWorkflowNodeV1['retry']['sideEffectPolicy'] } };
}

function decodeConfiguration(input: unknown, kind: EditableWorkflowNodeV1['kind']): WorkflowNodeConfigurationV1 {
  const required = ['schemaVersion','absoluteDeadlineMs','target','condition']; const optional = ['roleRevisionId','providerId','modelId','adapterKey','adapterVersion','deadlinePolicyId'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('WORKFLOW_SCHEMA_INVALID'); const value = input as Record<string, unknown>; const keys = Object.keys(value);
  if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) fail('WORKFLOW_SCHEMA_INVALID');
  if (value.schemaVersion !== '1' || !Number.isSafeInteger(value.absoluteDeadlineMs) || Number(value.absoluteDeadlineMs) < 1_000 || !['project-read-only','private-worktree'].includes(String(value.target)) || !['always','prior-success','prior-failure'].includes(String(value.condition))) fail('WORKFLOW_SCHEMA_INVALID');
  const bindingKeys = optional.filter(key => value[key] !== undefined); if (bindingKeys.length !== 0 && bindingKeys.length !== optional.length) fail('WORKFLOW_SCHEMA_INVALID');
  if (bindingKeys.length) {
    if (!String(kind).endsWith('.agent')) fail('WORKFLOW_ROLE_SEPARATION');
    if (typeof value.roleRevisionId !== 'string' || !UUID.test(value.roleRevisionId) || !['providerId','modelId','adapterKey','deadlinePolicyId'].every(key => typeof value[key] === 'string' && SYMBOLIC.test(String(value[key]))) || typeof value.adapterVersion !== 'string' || !SEMVER.test(value.adapterVersion)) fail('WORKFLOW_SCHEMA_INVALID');
  }
  if (kind === 'control.condition' ? value.condition === 'always' : value.condition !== 'always') fail('WORKFLOW_CONDITION_INVALID');
  return value as unknown as WorkflowNodeConfigurationV1;
}

function decodeEdge(input: unknown): EditableWorkflowEdgeV1 {
  const value = record(input, ['edgeId','sourceNodeId','sourcePort','targetNodeId','targetPort']);
  if (typeof value.edgeId !== 'string' || !UUID.test(value.edgeId) || typeof value.sourceNodeId !== 'string' || !UUID.test(value.sourceNodeId) || typeof value.targetNodeId !== 'string' || !UUID.test(value.targetNodeId) || typeof value.sourcePort !== 'string' || !OUTCOMES.has(value.sourcePort) || value.targetPort !== 'in') fail('WORKFLOW_PORT_INVALID');
  return value as unknown as EditableWorkflowEdgeV1;
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('WORKFLOW_SCHEMA_INVALID');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('WORKFLOW_SCHEMA_INVALID');
  return value;
}
function fail(code: WorkflowSafeCode): never { throw new WorkflowValidationError(code); }
