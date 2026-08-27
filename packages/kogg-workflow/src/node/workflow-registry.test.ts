import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { EditableWorkflowGraphV1, EditableWorkflowNodeV1 } from '../common/workflow-protocol';
import { WorkflowCompiler } from './workflow-compiler';
import { WorkflowDiagnosticContributor, WORKFLOW_CHECKS } from './workflow-diagnostic-contributor';
import { WorkflowRegistry } from './workflow-registry';
import { WorkflowNodeCatalog } from './workflow-node-catalog';

// diagnostic-coverage: workflow.schema, workflow.catalog, workflow.graph, workflow.anchors, workflow.authority, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.recovery, workflow.source-maps

const PROJECT = '10000000-0000-4000-8000-000000000001'; const TEMPLATE = '10000000-0000-4000-8000-000000000002';

test('versions a validated graph immutably and compiles the policy-owned trust spine across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-workflow-registry-')); const database = path.join(root, 'workflow.sqlite3'); const compiler = workflowCompiler();
  try {
    const registry = new WorkflowRegistry(compiler, database); await registry.onStart(); const graph = validGraph();
    const saved = await registry.saveVersion({ requestId: '20000000-0000-4000-8000-000000000001', templateId: TEMPLATE, expectedVersionNumber: 0, graph });
    assert.equal(saved.kind, 'completed'); assert.equal(saved.version?.versionNumber, 1); const firstDigest = saved.version!.graphDigest;
    const compiled = await registry.compile({ requestId: '20000000-0000-4000-8000-000000000002', versionId: saved.version!.versionId });
    assert.equal(compiled.kind, 'completed'); assert.equal(compiled.plan?.injectedAnchorCount, 9); assert.equal(compiled.plan?.graphDigest, firstDigest);
    const next = { ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, configurationDigest: 'b'.repeat(64) } : node) };
    const savedNext = await registry.saveVersion({ requestId: '20000000-0000-4000-8000-000000000003', templateId: TEMPLATE, expectedVersionNumber: 1, graph: next });
    assert.equal(savedNext.kind, 'completed'); assert.equal(savedNext.version?.versionNumber, 2); assert.notEqual(savedNext.version?.graphDigest, firstDigest); assert.equal(compiled.plan?.graphDigest, firstDigest);
    await registry.onStop(); const restarted = new WorkflowRegistry(compiler, database); await restarted.onStart(); const versions = await restarted.listVersions(TEMPLATE); assert.equal(versions.length, 2); assert.equal(versions[0]?.graphDigest, firstDigest);
    const diagnostics = await restarted.diagnostics(); assert.equal(diagnostics.canonicalMismatchCount, 0); assert.equal(diagnostics.catalogMismatchCount, 0); assert.equal(diagnostics.catalogEntryCount, 14); assert.equal(diagnostics.unavailableExecutorCount, 14); assert.equal(diagnostics.planMismatchCount, 0); assert.equal(diagnostics.residualProcessCount, 0);
    const checks = await new WorkflowDiagnosticContributor(restarted).diagnose(); const catalogCheck = checks.find(check => check.id === 'workflow.catalog'); assert.equal(catalogCheck?.status, 'fail'); assert.equal(catalogCheck?.details?.unavailableExecutorCount, 14); assert.equal(checks.find(check => check.id === 'workflow.scheduler')?.status, 'pass'); await restarted.onStop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fails closed on forged anchors, cycles, ambiguous joins, widened authority, retries, and stale version writes', async () => {
  const compiler = workflowCompiler(); const forged = structuredClone(validGraph()) as unknown as { nodes: Array<Record<string, unknown>> }; forged.nodes[0]!.kind = 'anchor.controlled-merge'; assert.equal(compiler.validate(forged).code, 'WORKFLOW_ANCHOR_BYPASS');
  const cyclic = validGraph(); cyclic.edges.push(edge('40000000-0000-4000-8000-000000000003', cyclic.nodes[1]!.nodeId, cyclic.nodes[0]!.nodeId)); assert.equal(compiler.validate(cyclic).code, 'WORKFLOW_CYCLE');
  const base = validGraph(); const widened = { ...base, nodes: base.nodes.map((node, index) => index === 0 ? { ...node, requestedEffects: ['record-approval'] as const } : node) }; assert.equal(compiler.validate(widened).code, 'WORKFLOW_AUTHORITY_EXPANSION');
  const retryBase = validGraph(); const retried = { ...retryBase, nodes: retryBase.nodes.map((node, index) => index === 1 ? { ...node, retry: { maxAttempts: 2, backoffMs: 1000 as const, sideEffectPolicy: 'none' as const } } : node) }; assert.equal(compiler.validate(retried).code, 'WORKFLOW_AUTHORITY_EXPANSION');
  const joinBase = validGraph(); const extra = node('30000000-0000-4000-8000-000000000003', 'tool.build', ['read-repository','run-tool']); const ambiguous = { ...joinBase, nodes: [...joinBase.nodes, extra], edges: [...joinBase.edges, edge('40000000-0000-4000-8000-000000000004', extra.nodeId, joinBase.nodes[1]!.nodeId)] }; assert.equal(compiler.validate(ambiguous).code, 'WORKFLOW_JOIN_AMBIGUOUS');
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-workflow-conflict-')); try { const registry = new WorkflowRegistry(compiler, path.join(root, 'workflow.sqlite3')); await registry.onStart(); await registry.saveVersion({ requestId: '20000000-0000-4000-8000-000000000010', templateId: TEMPLATE, expectedVersionNumber: 0, graph: validGraph() }); const conflict = await registry.saveVersion({ requestId: '20000000-0000-4000-8000-000000000011', templateId: TEMPLATE, expectedVersionNumber: 0, graph: validGraph() }); assert.equal(conflict.kind, 'conflict'); assert.equal(conflict.currentVersionNumber, 1); await registry.onStop(); } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses startup after immutable graph corruption and diagnostics fail as a complete catalog', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-workflow-integrity-')); const database = path.join(root, 'workflow.sqlite3'); const compiler = workflowCompiler();
  try {
    const registry = new WorkflowRegistry(compiler, database); await registry.onStart(); await registry.saveVersion({ requestId: '20000000-0000-4000-8000-000000000020', templateId: TEMPLATE, expectedVersionNumber: 0, graph: validGraph() }); await registry.onStop();
    const corrupt = new DatabaseSync(database); corrupt.exec('DROP TRIGGER workflow_immutable_versions_update'); corrupt.prepare('UPDATE template_versions SET graph_json=?').run('{"schemaVersion":"1"}'); corrupt.close();
    const restarted = new WorkflowRegistry(compiler, database); await assert.rejects(restarted.onStart(), /WORKFLOW_STORE_INTEGRITY/u);
    const contributor = new WorkflowDiagnosticContributor({ diagnostics: async () => { throw new Error('prohibited-content-canary'); } } as unknown as WorkflowRegistry); const checks = await contributor.diagnose(); assert.deepEqual(checks.map(check => check.id), [...WORKFLOW_CHECKS]); assert.equal(checks.every(check => check.status === 'fail'), true); assert.equal(JSON.stringify(checks).includes('prohibited-content-canary'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('binds every closed node kind to one canonical catalog digest while refusing unavailable executors', () => {
  const catalog = new WorkflowNodeCatalog(); const diagnostics = catalog.diagnostics();
  assert.equal(diagnostics.valid, true); assert.equal(diagnostics.entryCount, 14); assert.equal(diagnostics.unavailableExecutorCount, 14);
  assert.match(catalog.digest, /^[0-9a-f]{64}$/u); assert.equal(catalog.entries.every(entry => entry.executor.status === 'unavailable'), true);
  assert.deepEqual(catalog.entry('implementation.agent').grantCeiling, ['invoke-provider','mutate-private-repository','read-repository','run-tool']);
});

test('refuses startup when an immutable template catalog binding is changed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-workflow-catalog-')); const database = path.join(root, 'workflow.sqlite3'); const compiler = workflowCompiler();
  try {
    const registry = new WorkflowRegistry(compiler, database); await registry.onStart(); await registry.saveVersion({ requestId: '20000000-0000-4000-8000-000000000030', templateId: TEMPLATE, expectedVersionNumber: 0, graph: validGraph() }); await registry.onStop();
    const corrupt = new DatabaseSync(database); corrupt.exec('DROP TRIGGER workflow_immutable_versions_update'); corrupt.prepare('UPDATE template_versions SET catalog_digest=?').run('f'.repeat(64)); corrupt.close();
    await assert.rejects(new WorkflowRegistry(compiler, database).onStart(), /WORKFLOW_STORE_INTEGRITY/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('run admission validates the immutable plan and refuses unavailable executors before any run state exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-workflow-admission-')); const database = path.join(root, 'workflow.sqlite3'); const compiler = workflowCompiler();
  try {
    const registry = new WorkflowRegistry(compiler, database); await registry.onStart();
    const saved = await registry.saveVersion({ requestId: '20000000-0000-4000-8000-000000000040', templateId: TEMPLATE, expectedVersionNumber: 0, graph: validGraph() });
    assert.equal(saved.kind, 'completed'); if (saved.kind !== 'completed' || !saved.version) throw new Error('Expected immutable workflow version');
    const compiled = await registry.compile({ requestId: '20000000-0000-4000-8000-000000000041', versionId: saved.version!.versionId });
    assert.equal(compiled.kind, 'completed'); if (compiled.kind !== 'completed' || !compiled.plan) throw new Error('Expected compiled workflow plan');
    const request = { requestId: '20000000-0000-4000-8000-000000000042', planId: compiled.plan!.planId };
    const refused = await registry.admitRun(request); assert.deepEqual(refused, { kind: 'refused', code: 'WORKFLOW_EXECUTOR_INCOMPATIBLE' });
    assert.deepEqual(await registry.admitRun(request), refused);
    const mismatch = await registry.admitRun({ ...request, planId: '20000000-0000-4000-8000-000000000099' }); assert.equal(mismatch.code, 'WORKFLOW_SCHEMA_INVALID');
    const diagnostics = await registry.diagnostics(); assert.equal(diagnostics.versionCount, 1); assert.equal(diagnostics.planCount, 1); assert.equal(diagnostics.activeProcessCount, 0); assert.equal(diagnostics.recoveryBacklogCount, 0);
    await registry.onStop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('run admission rechecks the complete trust-spine plan digest and refuses live store tampering', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-workflow-admission-integrity-')); const database = path.join(root, 'workflow.sqlite3'); const compiler = workflowCompiler();
  try {
    const registry = new WorkflowRegistry(compiler, database); await registry.onStart();
    const saved = await registry.saveVersion({ requestId: '20000000-0000-4000-8000-000000000050', templateId: TEMPLATE, expectedVersionNumber: 0, graph: validGraph() });
    if (saved.kind !== 'completed' || !saved.version) throw new Error('Expected immutable workflow version');
    const compiled = await registry.compile({ requestId: '20000000-0000-4000-8000-000000000051', versionId: saved.version.versionId });
    if (compiled.kind !== 'completed' || !compiled.plan) throw new Error('Expected compiled workflow plan');
    const corrupt = new DatabaseSync(database); corrupt.exec('DROP TRIGGER workflow_immutable_plans_update'); corrupt.prepare('UPDATE compiled_plans SET plan_digest=? WHERE plan_id=?').run('f'.repeat(64), compiled.plan.planId); corrupt.close();
    const refused = await registry.admitRun({ requestId: '20000000-0000-4000-8000-000000000052', planId: compiled.plan.planId });
    assert.deepEqual(refused, { kind: 'refused', code: 'WORKFLOW_STORE_INTEGRITY' }); assert.equal((await registry.diagnostics()).planMismatchCount, 1); await registry.onStop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('restart quarantines durable scheduler and outbox ambiguity without replaying dispatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-workflow-scheduler-recovery-')); const database = path.join(root, 'workflow.sqlite3'); const compiler = workflowCompiler();
  try {
    const first = new WorkflowRegistry(compiler, database); await first.onStart();
    const saved = await first.saveVersion({ requestId: '20000000-0000-4000-8000-000000000060', templateId: TEMPLATE, expectedVersionNumber: 0, graph: validGraph() }); if (saved.kind !== 'completed' || !saved.version) throw new Error('Expected immutable workflow version');
    const compiled = await first.compile({ requestId: '20000000-0000-4000-8000-000000000061', versionId: saved.version.versionId }); if (compiled.kind !== 'completed' || !compiled.plan) throw new Error('Expected compiled workflow plan'); await first.onStop();
    const runId = '50000000-0000-4000-8000-000000000001'; const nodeId = validGraph().nodes[0]!.nodeId; const now = new Date().toISOString(); const store = new DatabaseSync(database);
    store.prepare("INSERT INTO workflow_runs(run_id,plan_id,plan_digest,state,revision,owner_epoch_id,safe_code,created_at,updated_at) VALUES(?,?,?,'running',1,?,'WORKFLOW_OK',?,?)").run(runId, compiled.plan.planId, compiled.plan.planDigest, '50000000-0000-4000-8000-000000000002', now, now);
    store.prepare("INSERT INTO workflow_node_attempts(run_id,node_id,attempt,state,fencing_token,safe_code,updated_at) VALUES(?,?,1,'running',?,'WORKFLOW_OK',?)").run(runId, nodeId, '50000000-0000-4000-8000-000000000003', now);
    store.prepare("INSERT INTO workflow_outbox(outbox_id,run_id,node_id,operation_kind,request_digest,fencing_token,phase,safe_code,created_at,updated_at) VALUES(?,?,?,'implementation.agent',?,?, 'claimed','WORKFLOW_OK',?,?)").run('50000000-0000-4000-8000-000000000004', runId, nodeId, 'a'.repeat(64), '50000000-0000-4000-8000-000000000003', now, now); store.close();
    const recovered = new WorkflowRegistry(compiler, database); await recovered.onStart(); const diagnostics = await recovered.diagnostics();
    assert.equal(diagnostics.schedulerIntegrity, true); assert.equal(diagnostics.schedulerLeaseActive, true); assert.equal(diagnostics.schedulerAdmission, 'blocked'); assert.equal(diagnostics.pendingOutboxCount, 0); assert.equal(diagnostics.quarantinedRunCount, 1); assert.equal(diagnostics.recoveryBacklogCount, 1);
    const checks = await new WorkflowDiagnosticContributor(recovered).diagnose(); assert.equal(checks.find(check => check.id === 'workflow.scheduler')?.status, 'fail'); assert.equal(checks.find(check => check.id === 'workflow.recovery')?.status, 'fail'); await recovered.onStop();
    const verify = new DatabaseSync(database); assert.equal((verify.prepare('SELECT phase FROM workflow_outbox').get() as { phase: string }).phase, 'quarantined'); assert.equal((verify.prepare('SELECT count(*) AS count FROM workflow_scheduler_events').get() as { count: number }).count, 1); verify.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses startup after immutable scheduler recovery fact corruption', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-workflow-scheduler-integrity-')); const database = path.join(root, 'workflow.sqlite3'); const compiler = workflowCompiler();
  try {
    const first = new WorkflowRegistry(compiler, database); await first.onStart(); const saved = await first.saveVersion({ requestId: '20000000-0000-4000-8000-000000000070', templateId: TEMPLATE, expectedVersionNumber: 0, graph: validGraph() }); if (saved.kind !== 'completed' || !saved.version) throw new Error('Expected immutable workflow version'); const compiled = await first.compile({ requestId: '20000000-0000-4000-8000-000000000071', versionId: saved.version.versionId }); if (compiled.kind !== 'completed' || !compiled.plan) throw new Error('Expected compiled workflow plan'); await first.onStop();
    const now = new Date().toISOString(); const runId = '51000000-0000-4000-8000-000000000001'; const store = new DatabaseSync(database); store.prepare("INSERT INTO workflow_runs(run_id,plan_id,plan_digest,state,revision,owner_epoch_id,safe_code,created_at,updated_at) VALUES(?,?,?,'running',1,?,'WORKFLOW_OK',?,?)").run(runId, compiled.plan.planId, compiled.plan.planDigest, '51000000-0000-4000-8000-000000000002', now, now); store.close();
    const recovered = new WorkflowRegistry(compiler, database); await recovered.onStart(); await recovered.onStop(); const corrupt = new DatabaseSync(database); corrupt.exec('DROP TRIGGER workflow_immutable_scheduler_events_update'); corrupt.prepare("UPDATE workflow_scheduler_events SET safe_code='WORKFLOW_OK'").run(); corrupt.close();
    await assert.rejects(new WorkflowRegistry(compiler, database).onStart(), /WORKFLOW_STORE_INTEGRITY/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function validGraph(): EditableWorkflowGraphV1 & { nodes: EditableWorkflowNodeV1[]; edges: ReturnType<typeof edge>[] } { const research = node('30000000-0000-4000-8000-000000000001', 'research.agent', ['read-repository','invoke-provider']); const implementation = node('30000000-0000-4000-8000-000000000002', 'implementation.agent', ['read-repository','mutate-private-repository','invoke-provider','run-tool']); return { schemaVersion: '1', projectId: PROJECT, nodes: [research, implementation], edges: [edge('40000000-0000-4000-8000-000000000001', research.nodeId, implementation.nodeId)] }; }
function node(nodeId: string, kind: EditableWorkflowNodeV1['kind'], requestedEffects: EditableWorkflowNodeV1['requestedEffects']): EditableWorkflowNodeV1 & { requestedEffects: EditableWorkflowNodeV1['requestedEffects']; retry: EditableWorkflowNodeV1['retry']; configurationDigest: string } { return { nodeId, kind, kindVersion: '1', configurationDigest: 'a'.repeat(64), requestedEffects, retry: { maxAttempts: 1, backoffMs: 0, sideEffectPolicy: 'none' } }; }
function edge(edgeId: string, sourceNodeId: string, targetNodeId: string) { return { edgeId, sourceNodeId, sourcePort: 'success' as const, targetNodeId, targetPort: 'in' as const }; }
function workflowCompiler(): WorkflowCompiler { return new WorkflowCompiler(new WorkflowNodeCatalog()); }
