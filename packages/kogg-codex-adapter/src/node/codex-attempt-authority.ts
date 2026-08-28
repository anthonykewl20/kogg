import { createHash } from 'node:crypto';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import type { AgentAdapterFactory } from '@kogg/agents/lib/common/agents-protocol';
import type { GovernedCodexAttemptV1 } from '../common/codex-protocol';
import type { QualifiedCodexRuntimeV1 } from './codex-release-registry';
import type { CodexRuntimeAuthorityProjection } from './codex-runtime-authority';
import { codexLog } from './codex-logger';

// Trusted backend state is reduced to one immutable authority fact before the qualified runtime owner sees an attempt. Raw task, repository, and adapter bindings never cross the runtime-owner seam.
// diagnostic-coverage: codex.confinement, codex.protocol, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
export const QualifiedCodexAttemptAuthority = Symbol('QualifiedCodexAttemptAuthority');
export interface QualifiedCodexAttemptAuthority {
  authorize(input: { readonly binding: Parameters<AgentAdapterFactory['create']>[0]['binding']; readonly runtime: QualifiedCodexRuntimeV1; readonly authority: CodexRuntimeAuthorityProjection }): GovernedCodexAttemptV1;
}
export interface CodexAttemptAuthorityProjection { readonly ownerReady: boolean; readonly safeCode: 'CODEX_OK' | 'CODEX_ATTEMPT_INVALID'; }
const FIELDS = ['schemaVersion','attemptId','taskRevisionDigest','repositoryBindingDigest','privateRepoObjectId','baseCommit','worktreePolicy','roleRevisionId','provider','model','releaseId','target','qualificationProfileId','deadlinePolicyId','budgets','deadlines','authorityDigest'] as const;
const BUDGET_FIELDS = ['inputTokens','outputTokens','toolCalls','bytesIn','bytesOut'] as const;
const DEADLINE_FIELDS = ['spawnMs','initializeMs','threadStartMs','firstActivityMs','idleMs','providerRequestMs','interruptMs','cleanupMs','absoluteMs'] as const;
const SHA256 = /^[0-9a-f]{64}$/u; const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u; const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u; const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u; const DECIMAL = /^(?:0|[1-9][0-9]{0,12})$/u;

@injectable()
export class CodexAttemptAuthorityRegistry {
  constructor(@inject(QualifiedCodexAttemptAuthority) @optional() private readonly authority?: QualifiedCodexAttemptAuthority) {}
  projection(): CodexAttemptAuthorityProjection { return this.authority ? { ownerReady: true, safeCode: 'CODEX_OK' } : { ownerReady: false, safeCode: 'CODEX_ATTEMPT_INVALID' }; }
  authorize(input: { readonly binding: Parameters<AgentAdapterFactory['create']>[0]['binding']; readonly runtime: QualifiedCodexRuntimeV1; readonly authority: CodexRuntimeAuthorityProjection }): GovernedCodexAttemptV1 {
    codexLog('attempt.authorize.requested', { attemptId: input.binding.attemptId });
    if (!this.authority) return this.refuse(input.binding.attemptId);
    try {
      const value = this.authority.authorize(input); validate(value, input);
      const frozen = Object.freeze({ ...value, budgets: Object.freeze({ ...value.budgets }), deadlines: Object.freeze({ ...value.deadlines }) });
      codexLog('attempt.authorize.completed', { attemptId: value.attemptId, authorityDigest: value.authorityDigest }); return frozen;
    } catch { // observability-exempt: The closed refusal discards private authority errors and never logs task, repository, path, policy, or budget data.
      return this.refuse(input.binding.attemptId);
    }
  }
  private refuse(attemptId: string): never { codexLog('attempt.authorize.failed', { attemptId, safeCode: 'CODEX_ATTEMPT_INVALID' }); throw new CodexAttemptAuthorityFault('CODEX_ATTEMPT_INVALID'); }
}
export class CodexAttemptAuthorityFault extends Error { constructor(readonly code: 'CODEX_ATTEMPT_INVALID') { super(code); } }

function validate(value: GovernedCodexAttemptV1, input: { readonly binding: Parameters<AgentAdapterFactory['create']>[0]['binding']; readonly runtime: QualifiedCodexRuntimeV1; readonly authority: CodexRuntimeAuthorityProjection }): void {
  if (!value || Object.keys(value).sort().join(',') !== [...FIELDS].sort().join(',') || Object.keys(value.budgets ?? {}).sort().join(',') !== [...BUDGET_FIELDS].sort().join(',') || Object.keys(value.deadlines ?? {}).sort().join(',') !== [...DEADLINE_FIELDS].sort().join(',')) throw new Error('invalid');
  const binding = input.binding; const release = input.runtime.release;
  if (value.schemaVersion !== '1' || value.attemptId !== binding.attemptId || !UUID.test(value.attemptId) || value.roleRevisionId !== binding.roleRevisionId || !ID.test(value.roleRevisionId) || value.provider !== 'openai' || binding.providerId !== 'openai' || value.model !== binding.modelId || !ID.test(value.model) || value.deadlinePolicyId !== binding.deadlinePolicyId || !ID.test(value.deadlinePolicyId)) throw new Error('invalid');
  if (value.releaseId !== release.releaseId || value.target !== release.target || value.qualificationProfileId !== release.qualificationProfileId || input.authority.releaseId !== release.releaseId || input.authority.target !== release.target || input.authority.qualificationProfileId !== release.qualificationProfileId) throw new Error('invalid');
  if (!COMMIT.test(value.baseCommit) || ![value.taskRevisionDigest,value.repositoryBindingDigest,value.authorityDigest].every(item => SHA256.test(item))) throw new Error('invalid');
  if (value.worktreePolicy === 'private-writable') { if (!binding.worktreeId || value.privateRepoObjectId !== binding.worktreeId || !UUID.test(value.privateRepoObjectId)) throw new Error('invalid'); }
  else if (value.worktreePolicy !== 'read-only-snapshot' || binding.worktreeId !== undefined || value.privateRepoObjectId !== null) throw new Error('invalid');
  if (!BUDGET_FIELDS.every(field => DECIMAL.test(value.budgets[field]) && value.budgets[field] !== '0')) throw new Error('invalid');
  const deadlines = value.deadlines; if (deadlines.spawnMs !== 20000 || deadlines.initializeMs !== 30000 || deadlines.threadStartMs !== 30000 || deadlines.firstActivityMs !== 60000 || deadlines.idleMs !== 120000 || deadlines.providerRequestMs !== 120000 || deadlines.interruptMs !== 10000 || deadlines.cleanupMs !== 10000 || !Number.isSafeInteger(deadlines.absoluteMs) || deadlines.absoluteMs < 1 || deadlines.absoluteMs > 3600000) throw new Error('invalid');
  const unsigned = Object.fromEntries(FIELDS.filter(field => field !== 'authorityDigest').map(field => [field, value[field]])); if (createHash('sha256').update(canonical(unsigned)).digest('hex') !== value.authorityDigest) throw new Error('invalid');
}
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
