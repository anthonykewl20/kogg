import { existsSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { KernelBridgeToken, KOGG_RANEX_COMMIT, type KernelBridge, type KernelExecutionQualification } from '@kogg/contracts';
import type { ExecutionBindingV1, ExecutionQualificationCode, ExecutionQualificationProjection } from '../common/execution-protocol';
import { executionLog } from './execution-logger';

// Qualification is owned by the pinned Ranex boundary. This registry validates only its closed, fresh result and never infers qualification from Linux alone.
// diagnostic-coverage: execution.target-qualification, execution.recovery, execution.source-maps
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SYMBOLIC = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const REFUSALS = new Set(['QUALIFICATION_PLATFORM_UNSUPPORTED', 'QUALIFICATION_PROFILE_UNAVAILABLE', 'QUALIFICATION_BOOT_CHANGED', 'QUALIFICATION_KERNEL_UNSUPPORTED', 'QUALIFICATION_LANDLOCK_UNAVAILABLE', 'QUALIFICATION_CGROUP_UNAVAILABLE', 'QUALIFICATION_QUOTA_UNAVAILABLE', 'QUALIFICATION_LAUNCHER_MISMATCH', 'QUALIFICATION_BUBBLEWRAP_MISMATCH', 'QUALIFICATION_SECCOMP_MISMATCH', 'QUALIFICATION_BROKER_UNAVAILABLE', 'QUALIFICATION_ATTESTATION_INVALID']);
const FIELDS = ['schemaVersion', 'qualificationId', 'targetId', 'architecture', 'profileId', 'profileDigest', 'bootIdDigest', 'kernelRelease', 'landlockAbi', 'cgroupProfileDigest', 'mountQuotaDigest', 'launcherDigest', 'bubblewrapDigest', 'seccompDigest', 'brokerDigest', 'ranexCommit', 'checkedAt', 'expiresAt', 'status', 'refusalCodes'] as const;

@injectable()
export class ExecutionTargetRegistry implements BackendApplicationContribution {
  private value: ExecutionQualificationProjection;
  private authority: KernelExecutionQualification | undefined;
  constructor(@inject(KernelBridgeToken) private readonly kernel: KernelBridge,
    @unmanaged() private readonly runtime: { readonly platform: NodeJS.Platform; readonly arch: string } = { platform: process.platform, arch: process.arch },
    @unmanaged() private readonly targetId = 'local-qualified-linux') {
    this.value = refused(this.targetId, this.runtime.platform === 'linux' && this.runtime.arch === 'x64' ? 'QUALIFICATION_PROFILE_UNAVAILABLE' : 'QUALIFICATION_PLATFORM_UNSUPPORTED');
  }
  async onStart(): Promise<void> { await this.refresh(); }
  projection(): ExecutionQualificationProjection { return { ...this.value, sourceMapsPresent: existsSync(`${__filename}.map`) }; }
  async authorize(binding: ExecutionBindingV1): Promise<boolean> {
    const current = await this.refresh(); const authority = this.authority;
    const authorized = current.qualified && authority !== undefined && authority.qualificationId === binding.qualificationId
      && authority.targetId === binding.targetId && authority.profileId === binding.profileId
      && equal(authority.profileDigest, binding.profileDigest) && equal(qualificationDigest(authority), binding.qualificationDigest);
    if (authorized) executionLog('qualification.authorization.completed', { targetId: binding.targetId, qualificationId: binding.qualificationId });
    else executionLog('qualification.authorization.refused', { targetId: binding.targetId, qualificationId: binding.qualificationId, safeCode: current.qualified ? 'QUALIFICATION_PROTOCOL_INVALID' : current.safeCode });
    return authorized;
  }
  async authorizePhysicalAllocation(binding: ExecutionBindingV1, helperDigest: string, mountQuotaDigest: string): Promise<boolean> {
    if (!await this.authorize(binding)) return false;
    const authority = this.authority;
    return authority !== undefined && equal(authority.launcherDigest, helperDigest) && equal(authority.mountQuotaDigest, mountQuotaDigest);
  }
  async refresh(): Promise<ExecutionQualificationProjection> {
    executionLog('qualification.started', { targetId: this.targetId });
    if (this.runtime.platform !== 'linux' || this.runtime.arch !== 'x64') return this.invalidate('QUALIFICATION_PLATFORM_UNSUPPORTED');
    try {
      const capabilities = await this.kernel.capabilities();
      if (capabilities.ranexCommit !== KOGG_RANEX_COMMIT || !capabilities.commands.includes('execution.qualify')) return this.invalidate('QUALIFICATION_PROFILE_UNAVAILABLE');
      const result = await this.kernel.qualifyExecution(this.targetId);
      const code = validate(result, this.targetId, Date.now());
      if (code) return this.invalidate(code);
      this.authority = result;
      this.value = { qualified: true, targetId: result.targetId, profileId: result.profileId, safeCode: 'EXECUTION_OK', qualificationId: result.qualificationId, expiresAt: result.expiresAt, sourceMapsPresent: true };
      executionLog('qualification.completed', { targetId: result.targetId, qualificationId: result.qualificationId }); return this.projection();
    } catch (error) { // observability-exempt: The closed failure log intentionally discards raw kernel errors and qualification bodies.
      this.authority = undefined; this.value = refused(this.targetId, 'QUALIFICATION_FAILED'); executionLog('qualification.failed', { targetId: this.targetId, safeCode: 'QUALIFICATION_FAILED', errorType: error instanceof Error ? error.name : 'UnknownError' }); return this.projection();
    }
  }
  private invalidate(code: ExecutionQualificationCode): ExecutionQualificationProjection { this.authority = undefined; this.value = refused(this.targetId, code); executionLog('qualification.invalidated', { targetId: this.targetId, safeCode: code }); return this.projection(); }
}

export function qualificationDigest(value: KernelExecutionQualification): string {
  return `sha256:${createHash('sha256').update(`kogg-execution-qualification-v1\n${canonical(value)}`).digest('hex')}`;
}

function validate(value: KernelExecutionQualification, targetId: string, now: number): ExecutionQualificationCode | undefined {
  if (!value || Object.keys(value).sort().join(',') !== [...FIELDS].sort().join(',')) return 'QUALIFICATION_PROTOCOL_INVALID';
  if (value.schemaVersion !== 1 || !UUID.test(value.qualificationId) || value.targetId !== targetId || !SYMBOLIC.test(value.targetId)
    || value.architecture !== 'amd64' || value.profileId !== 'kogg-writable-agent-v1' || value.ranexCommit !== KOGG_RANEX_COMMIT
    || ![value.profileDigest, value.bootIdDigest, value.cgroupProfileDigest, value.mountQuotaDigest, value.launcherDigest, value.bubblewrapDigest, value.seccompDigest, value.brokerDigest].every(item => DIGEST.test(item))
    || !DECIMAL.test(value.landlockAbi) || Number(value.landlockAbi) < 4 || !supportedKernel(value.kernelRelease)
    || !Array.isArray(value.refusalCodes) || value.refusalCodes.length > REFUSALS.size || new Set(value.refusalCodes).size !== value.refusalCodes.length || value.refusalCodes.some(code => !REFUSALS.has(code))) return 'QUALIFICATION_PROTOCOL_INVALID';
  if (value.status !== 'qualified' || value.refusalCodes.length) return 'QUALIFICATION_PROFILE_UNAVAILABLE';
  const checked = Date.parse(value.checkedAt); const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(checked) || !Number.isFinite(expires) || checked > now || expires <= now || expires - checked > 5 * 60_000) return 'QUALIFICATION_EXPIRED';
  return undefined;
}
function supportedKernel(release: string): boolean { const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(release); if (!match) return false; const major = Number(match[1]); const minor = Number(match[2]); return Number.isSafeInteger(major) && Number.isSafeInteger(minor) && (major > 6 || (major === 6 && minor >= 6)); }
function refused(targetId: string, safeCode: ExecutionQualificationCode): ExecutionQualificationProjection { return { qualified: false, targetId, profileId: 'kogg-writable-agent-v1', safeCode, sourceMapsPresent: true }; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
function equal(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
