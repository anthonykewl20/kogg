import type { OperationLease, ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import type { ClaudeSafeCode, GovernedClaudeAttemptV1 } from '../common/claude-protocol';
import { ClaudeCredentialGrant } from './claude-credential-grant';
import { claudeLog } from './claude-logger';

// The qualified Linux owner retains OS handles. Kogg receives only the registered PID and opaque identity digests needed for logical supervision; never argv, environment, paths, stdio, credentials, or errors.
// diagnostic-coverage: claude.authority, claude.confinement, claude.credentials, claude.processes, claude.cleanup, claude.recovery, claude.source-maps
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u; const SHA256 = /^[0-9a-f]{64}$/u;
export interface ClaudeProcessReservationV1 { readonly schemaVersion: '1'; readonly attemptId: string; readonly authorityDigest: string; readonly artifactManifestDigest: string; readonly executionProfileDigest: string; readonly privateRepoObjectId: string; readonly spawnDeadlineMs: number; }
export interface ClaudeProcessIdentityV1 { readonly reservationId: string; readonly processRegistrationId: string; readonly pid: number; readonly cgroupIdentityDigest: string; readonly startTimeTokenDigest: string; }
export interface ClaudeProcessInventoryV1 { readonly identityVerified: boolean; readonly memberCount: number; }
export interface ClaudeProcessAuthority { reserve(binding: ClaudeProcessReservationV1): Promise<{ readonly reservationId: string }>; register(reservationId: string, processRegistrationId: string): Promise<ClaudeProcessIdentityV1>; release(identity: ClaudeProcessIdentityV1): Promise<void>; signal(identity: ClaudeProcessIdentityV1, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>; inventory(identity: ClaudeProcessIdentityV1): Promise<ClaudeProcessInventoryV1>; }
export type ClaudeProcessPhase = 'unreserved' | 'reserved' | 'registered' | 'running' | 'cleaning' | 'cleaned' | 'faulted';
export class ClaudeProcessFault extends Error { constructor(readonly code: Extract<ClaudeSafeCode, 'CLAUDE_SPAWN_FAILED' | 'CLAUDE_SPAWN_PROTOCOL' | 'CLAUDE_RESIDUAL_PROCESS' | 'CLAUDE_UNREGISTERED_PROCESS'>) { super(code); } }
export class ClaudeProcessHostGate {
  private phaseValue: ClaudeProcessPhase = 'unreserved'; private armed = false; private reservationId: string | undefined; private identity: ClaudeProcessIdentityV1 | undefined; private process: ProcessLease | undefined; private cleaning: Promise<void> | undefined;
  readonly binding: ClaudeProcessReservationV1;
  constructor(private readonly attempt: GovernedClaudeAttemptV1, private readonly operation: OperationLease, private readonly credentials: ClaudeCredentialGrant, private readonly authority: ClaudeProcessAuthority) { this.binding = Object.freeze({ schemaVersion: '1', attemptId: attempt.attemptId, authorityDigest: attempt.authorityDigest, artifactManifestDigest: attempt.artifactManifestDigest, executionProfileDigest: attempt.executionProfileDigest, privateRepoObjectId: attempt.privateRepoObjectId, spawnDeadlineMs: attempt.deadlines.spawnMs }); }
  arm(): void { if (this.armed || this.phaseValue !== 'unreserved' || this.cleaning) this.fault('CLAUDE_SPAWN_PROTOCOL'); this.armed = true; }
  phase(): ClaudeProcessPhase { return this.phaseValue; }
  async reserve(): Promise<void> {
    if (!this.armed || this.phaseValue !== 'unreserved') return this.fault('CLAUDE_SPAWN_PROTOCOL');
    try { this.process = this.operation.registerProcess({ kind: 'provider-cli', owner: 'kogg-supervisor', cancel: () => this.cleanup() }); claudeLog('process.registered', { attemptId: this.attempt.attemptId, processId: this.process.id }); }
    catch { // observability-exempt: The closed registration refusal contains no operation or owner details, and no external reservation was requested.
      this.credentials.abandon(); return this.fault('CLAUDE_UNREGISTERED_PROCESS'); }
    claudeLog('process.reserve.requested', { attemptId: this.attempt.attemptId });
    try { const value = await within(this.authority.reserve(this.binding), this.attempt.deadlines.spawnMs, 'CLAUDE_SPAWN_FAILED'); if (!value || Object.keys(value).join(',') !== 'reservationId' || !ID.test(value.reservationId)) throw new ClaudeProcessFault('CLAUDE_SPAWN_PROTOCOL'); this.reservationId = value.reservationId; this.phaseValue = 'reserved'; claudeLog('process.reserve.completed', { attemptId: this.attempt.attemptId }); }
    catch (error) { // observability-exempt: Owner reservation errors are discarded; the logical record and credential grant are still cleaned below.
      await this.failAndClean(error instanceof ClaudeProcessFault ? error.code : 'CLAUDE_SPAWN_FAILED'); }
  }
  async register(): Promise<void> {
    if (this.phaseValue !== 'reserved' || !this.reservationId || !this.process) return this.fault('CLAUDE_SPAWN_PROTOCOL');
    try { const value = await within(this.authority.register(this.reservationId, this.process.id), this.attempt.deadlines.spawnMs, 'CLAUDE_SPAWN_FAILED'); if (!validIdentity(value, this.reservationId, this.process.id)) throw new ClaudeProcessFault('CLAUDE_UNREGISTERED_PROCESS'); this.identity = Object.freeze({ ...value }); this.phaseValue = 'registered'; claudeLog('process.identity.verified', { attemptId: this.attempt.attemptId, processId: value.processRegistrationId }); }
    catch (error) { // observability-exempt: Owner registration errors are discarded; external inventory and logical cleanup still run below.
      await this.failAndClean(error instanceof ClaudeProcessFault ? error.code : 'CLAUDE_SPAWN_FAILED'); }
  }
  async release(): Promise<void> {
    if (this.phaseValue !== 'registered' || !this.identity || !this.process) return this.fault('CLAUDE_SPAWN_PROTOCOL'); this.process.spawning();
    try { await this.credentials.reserve(); await this.credentials.activate(this.identity.processRegistrationId, this.identity.cgroupIdentityDigest); await within(this.authority.release(this.identity), this.attempt.deadlines.spawnMs, 'CLAUDE_SPAWN_FAILED'); this.process.started(this.identity.pid); this.process.ready(); this.phaseValue = 'running'; claudeLog('process.spawn.completed', { attemptId: this.attempt.attemptId, processId: this.identity.processRegistrationId }); }
    catch { // observability-exempt: Credential and process errors are discarded behind the closed spawn failure; cleanup revokes and inventories.
      await this.failAndClean('CLAUDE_SPAWN_FAILED'); }
  }
  cleanup(): Promise<void> { return this.cleaning ??= this.cleanupOnce(); }
  private async cleanupOnce(): Promise<void> {
    if (this.phaseValue === 'cleaned') return; const wasRunning = this.phaseValue === 'running'; this.phaseValue = 'cleaning'; claudeLog('process.cleanup.requested', { attemptId: this.attempt.attemptId }); let failure: ClaudeProcessFault | undefined;
    try { await this.credentials.revoke(); } catch { // observability-exempt: The credential gate emitted the closed revocation failure; process cleanup continues and ultimately fails closed.
      failure = new ClaudeProcessFault('CLAUDE_RESIDUAL_PROCESS'); }
    if (this.identity) { try { await within(this.authority.signal(this.identity, 'SIGTERM'), this.attempt.deadlines.gracefulExitMs + this.attempt.deadlines.terminateMs, 'CLAUDE_RESIDUAL_PROCESS'); claudeLog('process.signal.completed', { attemptId: this.attempt.attemptId, signalClass: 'terminate' }); let inventory = await this.inventory(); if (inventory.memberCount > 0) { await within(this.authority.signal(this.identity, 'SIGKILL'), this.attempt.deadlines.killMs, 'CLAUDE_RESIDUAL_PROCESS'); claudeLog('process.signal.completed', { attemptId: this.attempt.attemptId, signalClass: 'kill' }); inventory = await this.inventory(); } if (!inventory.identityVerified || inventory.memberCount !== 0) failure = new ClaudeProcessFault('CLAUDE_RESIDUAL_PROCESS'); } catch { // observability-exempt: Owner errors and process identities are discarded behind the aggregate cleanup failure.
        failure = new ClaudeProcessFault('CLAUDE_RESIDUAL_PROCESS'); } }
    if (!failure && this.process) { if (wasRunning) this.process.exited('signal'); this.process.cleanup(); }
    this.phaseValue = failure ? 'faulted' : 'cleaned'; if (failure) { this.process?.failed('PROCESS_SIGNALLED', 'ClaudeProcessFault'); claudeLog('process.cleanup.failed', { attemptId: this.attempt.attemptId, safeCode: failure.code }); throw failure; } claudeLog('process.cleanup.completed', { attemptId: this.attempt.attemptId, residualCount: 0 });
  }
  private async failAndClean(code: ClaudeProcessFault['code']): Promise<never> { this.phaseValue = 'faulted'; this.process?.failed('PROCESS_SPAWN_FAILED', 'ClaudeProcessFault'); claudeLog('process.failure', { attemptId: this.attempt.attemptId, safeCode: code }); try { await this.cleanup(); } catch { // observability-exempt: Cleanup emitted the overriding closed residual failure.
      throw new ClaudeProcessFault('CLAUDE_RESIDUAL_PROCESS'); } throw new ClaudeProcessFault(code); }
  private async inventory(): Promise<ClaudeProcessInventoryV1> { const value = await within(this.authority.inventory(this.identity!), this.attempt.deadlines.cgroupEmptyMs, 'CLAUDE_RESIDUAL_PROCESS'); if (!value || Object.keys(value).sort().join(',') !== ['identityVerified','memberCount'].sort().join(',') || typeof value.identityVerified !== 'boolean' || !Number.isSafeInteger(value.memberCount) || value.memberCount < 0) throw new ClaudeProcessFault('CLAUDE_RESIDUAL_PROCESS'); return value; }
  private fault(code: ClaudeProcessFault['code']): never { this.phaseValue = 'faulted'; this.process?.failed('PROCESS_SPAWN_FAILED', 'ClaudeProcessFault'); claudeLog('process.failure', { attemptId: this.attempt.attemptId, safeCode: code }); throw new ClaudeProcessFault(code); }
}
function validIdentity(value: ClaudeProcessIdentityV1, reservationId: string, processId: string): boolean { return Boolean(value) && Object.keys(value).sort().join(',') === ['reservationId','processRegistrationId','pid','cgroupIdentityDigest','startTimeTokenDigest'].sort().join(',') && value.reservationId === reservationId && value.processRegistrationId === processId && ID.test(value.processRegistrationId) && Number.isSafeInteger(value.pid) && value.pid > 0 && SHA256.test(value.cgroupIdentityDigest) && SHA256.test(value.startTimeTokenDigest); }
function within<T>(promise: Promise<T>, deadlineMs: number, code: ClaudeProcessFault['code']): Promise<T> { let timer: NodeJS.Timeout | undefined; return Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ClaudeProcessFault(code)), deadlineMs); })]).finally(() => { if (timer) clearTimeout(timer); }); }
