import { createHash } from 'node:crypto';
import { injectable, inject, optional } from '@theia/core/shared/inversify';
import type { AgentAdapterFactory } from '@kogg/agents/lib/common/agents-protocol';
import type { GovernedClaudeAttemptV1 } from '../common/claude-protocol';
import type { AttestedClaudeArtifactV1 } from './claude-artifact-registry';
import { claudeLog } from './claude-logger';
import type { ClaudeRuntimeAuthorityProjection } from './claude-runtime-authority';

// The owner resolves task/repository/workspace/policy/budget authority from trusted backend state. Missing facts are never synthesized from the adapter binding.
// diagnostic-coverage: claude.authority, claude.settings, claude.protocol, claude.credentials, claude.confinement, claude.source-maps
export const QualifiedClaudeAttemptAuthority = Symbol('QualifiedClaudeAttemptAuthority');
export interface QualifiedClaudeAttemptAuthority { authorize(input: { readonly binding: Parameters<AgentAdapterFactory['create']>[0]['binding']; readonly artifact: AttestedClaudeArtifactV1; readonly runtime: ClaudeRuntimeAuthorityProjection }): GovernedClaudeAttemptV1; }
export interface ClaudeAttemptAuthorityProjection { readonly ownerReady: boolean; readonly safeCode: 'CLAUDE_OK' | 'CLAUDE_ATTEMPT_INVALID'; }
const FIELDS = ['schemaVersion','attemptId','taskRevisionDigest','repositoryBindingDigest','privateRepoObjectId','baseCommit','role','provider','model','artifactManifestDigest','legalApprovalDigest','permissionProfileDigest','executionProfileDigest','budgets','deadlines','authorityDigest'] as const;
const BUDGET_FIELDS = ['inputTokens','outputTokens','toolCalls','bytesIn','bytesOut'] as const; const DEADLINE_FIELDS = ['spawnMs','initializeMs','firstProgressMs','idleMs','permissionDecisionMs','interruptReceiptMs','gracefulExitMs','terminateMs','killMs','closeMs','cgroupEmptyMs','absoluteMs'] as const;
const SHA256 = /^[0-9a-f]{64}$/u; const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u; const COMMIT = /^[0-9a-f]{40}$/u; const MODEL = /^claude-(?:opus|sonnet|haiku)-[0-9]+(?:-[0-9]+)?-[0-9]{8}$/u; const DECIMAL = /^(?:0|[1-9][0-9]{0,12})$/u;
@injectable()
export class ClaudeAttemptAuthorityRegistry {
  constructor(@inject(QualifiedClaudeAttemptAuthority) @optional() private readonly authority?: QualifiedClaudeAttemptAuthority) {}
  projection(): ClaudeAttemptAuthorityProjection { return this.authority ? { ownerReady: true, safeCode: 'CLAUDE_OK' } : { ownerReady: false, safeCode: 'CLAUDE_ATTEMPT_INVALID' }; }
  authorize(input: { readonly binding: Parameters<AgentAdapterFactory['create']>[0]['binding']; readonly artifact: AttestedClaudeArtifactV1; readonly runtime: ClaudeRuntimeAuthorityProjection }): GovernedClaudeAttemptV1 {
    claudeLog('attempt.authorize.requested', { attemptId: input.binding.attemptId }); if (!this.authority) return this.refuse(input.binding.attemptId);
    try { const value = this.authority.authorize(input); validate(value, input); const frozen = Object.freeze({ ...value, budgets: Object.freeze({ ...value.budgets }), deadlines: Object.freeze({ ...value.deadlines }) }); claudeLog('attempt.authorize.completed', { attemptId: value.attemptId, authorityDigest: value.authorityDigest }); return frozen; }
    catch { /* observability-exempt: the closed refusal discards private authority errors and never logs task, repository, policy, budget, or path data. */ return this.refuse(input.binding.attemptId); }
  }
  private refuse(attemptId: string): never { claudeLog('attempt.authorize.failed', { attemptId, safeCode: 'CLAUDE_ATTEMPT_INVALID' }); throw new ClaudeAttemptAuthorityFault('CLAUDE_ATTEMPT_INVALID'); }
}
export class ClaudeAttemptAuthorityFault extends Error { constructor(readonly code: 'CLAUDE_ATTEMPT_INVALID') { super(code); } }
function validate(value: GovernedClaudeAttemptV1, input: { readonly binding: Parameters<AgentAdapterFactory['create']>[0]['binding']; readonly artifact: AttestedClaudeArtifactV1; readonly runtime: ClaudeRuntimeAuthorityProjection }): void {
  if (!value || Object.keys(value).sort().join(',') !== [...FIELDS].sort().join(',') || Object.keys(value.budgets ?? {}).sort().join(',') !== [...BUDGET_FIELDS].sort().join(',') || Object.keys(value.deadlines ?? {}).sort().join(',') !== [...DEADLINE_FIELDS].sort().join(',')) throw new Error('invalid');
  if (value.schemaVersion !== '1' || value.attemptId !== input.binding.attemptId || !UUID.test(value.attemptId) || value.privateRepoObjectId !== input.binding.worktreeId || !UUID.test(value.privateRepoObjectId) || value.role !== 'implementation' || value.provider !== 'anthropic' || input.binding.providerId !== 'anthropic' || value.model !== input.binding.modelId || !MODEL.test(value.model) || !COMMIT.test(value.baseCommit)) throw new Error('invalid');
  if (![value.taskRevisionDigest,value.repositoryBindingDigest,value.artifactManifestDigest,value.legalApprovalDigest,value.permissionProfileDigest,value.executionProfileDigest,value.authorityDigest].every(item => SHA256.test(item)) || value.artifactManifestDigest !== input.artifact.manifestDigest || value.legalApprovalDigest !== input.artifact.approvalDigest || value.executionProfileDigest !== input.runtime.executionProfileDigest) throw new Error('invalid');
  if (!BUDGET_FIELDS.every(field => DECIMAL.test(value.budgets[field]) && value.budgets[field] !== '0')) throw new Error('invalid'); const deadlines = value.deadlines; if (deadlines.spawnMs !== 10000 || deadlines.initializeMs !== 30000 || deadlines.firstProgressMs !== 60000 || deadlines.idleMs !== 120000 || deadlines.permissionDecisionMs !== 60000 || deadlines.interruptReceiptMs !== 5000 || deadlines.gracefulExitMs !== 10000 || deadlines.terminateMs !== 5000 || deadlines.killMs !== 5000 || deadlines.closeMs !== 5000 || deadlines.cgroupEmptyMs !== 10000 || !Number.isSafeInteger(deadlines.absoluteMs) || deadlines.absoluteMs < 1 || deadlines.absoluteMs > 3600000) throw new Error('invalid');
  const unsigned = Object.fromEntries(FIELDS.filter(field => field !== 'authorityDigest').map(field => [field, value[field]])); if (createHash('sha256').update(canonical(unsigned)).digest('hex') !== value.authorityDigest) throw new Error('invalid');
}
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
