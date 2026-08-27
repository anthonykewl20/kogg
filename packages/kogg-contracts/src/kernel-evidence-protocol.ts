// diagnostic-exempt: pure closed protocol declarations and deterministic canonical serialization have no runtime lifecycle or external failure boundary.

export const KOGG_RANEX_PROTOCOL = 'kogg.ranex/v2' as const;
export const KOGG_RANEX_PROTOCOL_VERSION = 2 as const;
export const KOGG_RANEX_COMMIT = '5586d68b0936f554759022caabe847087f1d03ef' as const;
export const KOGG_RANEX_TREE = '581ce66c54116d4be48b96c3a0359fbdd9d3077f' as const;
export const KERNEL_SCHEMA_SET_DIGEST = 'sha256:b44b4f9fc8c16386e1c5b4f22dcdf6f910b951dce48799689e623f14ef5497f3' as const;
export const KERNEL_MAX_FRAME_BYTES = 1024 * 1024;
export const KERNEL_MAX_DEPTH = 32;
export const KERNEL_MAX_MEMBERS = 4096;
export const KERNEL_MAX_PENDING_REQUESTS = 64;
export const KERNEL_MAX_PENDING_RESPONSE_BYTES = 4 * 1024 * 1024;

export const KERNEL_OPERATIONS = {
  'kernel.handshake': 2,
  'kernel.health': 1,
  'task.bind': 1,
  'producer.dispatch': 1,
  'suite.freeze': 1,
  'suite.execute': 1,
  'evidence.admit': 1,
  'gate.evaluate': 1,
  'verdict.read': 1,
  'operation.reconcile': 1,
  'operation.cancel': 1
} as const;

export type KernelOperationV2 = keyof typeof KERNEL_OPERATIONS;
export type KernelSafeCodeV2 =
  | 'KERNEL_OK' | 'KERNEL_PROTOCOL_MISMATCH' | 'KERNEL_PROTOCOL_INVALID' | 'KERNEL_PROTOCOL_OVERFLOW'
  | 'KERNEL_CAPABILITY_UNAVAILABLE' | 'KERNEL_PROVENANCE_MISMATCH' | 'KERNEL_AUTHORITY_INVALID'
  | 'KERNEL_TASK_BINDING_MISMATCH' | 'KERNEL_REPOSITORY_MISMATCH' | 'KERNEL_SUBJECT_STALE'
  | 'KERNEL_PRODUCER_INVALID' | 'KERNEL_ROLE_SEPARATION_FAILED' | 'KERNEL_SUITE_MISMATCH'
  | 'KERNEL_CHECK_FAILED' | 'KERNEL_CHECK_TIMEOUT' | 'KERNEL_CHECK_INFRASTRUCTURE'
  | 'KERNEL_EVIDENCE_INVALID' | 'KERNEL_EVIDENCE_MISSING' | 'KERNEL_EVIDENCE_DUPLICATE'
  | 'KERNEL_EVIDENCE_CONFLICT' | 'KERNEL_EVIDENCE_STALE' | 'KERNEL_GATE_INCOMPLETE'
  | 'KERNEL_VERDICT_STALE' | 'KERNEL_IDEMPOTENCY_CONFLICT' | 'KERNEL_JOURNAL_INTEGRITY'
  | 'KERNEL_JOURNAL_AMBIGUOUS' | 'KERNEL_OUTCOME_UNKNOWN' | 'KERNEL_CANCELLED'
  | 'KERNEL_CLEANUP_FAILED' | 'KERNEL_RESIDUAL_PROCESS' | 'KERNEL_BACKEND_RESTARTED' | 'KERNEL_INTERNAL';

export type KernelJson = string | number | boolean | null | readonly KernelJson[] | { readonly [key: string]: KernelJson };
export type KoggDigest = `sha256:${string}`;
export type GitObjectFormat = 'sha1' | 'sha256';

export interface KernelOperationCapabilityV2 {
  readonly operation: KernelOperationV2;
  readonly version: number;
  readonly requestSchemaDigest: KoggDigest;
  readonly resultSchemaDigest: KoggDigest;
}

export interface KernelCapabilities {
  readonly protocol: typeof KOGG_RANEX_PROTOCOL;
  readonly protocolVersion: typeof KOGG_RANEX_PROTOCOL_VERSION;
  readonly ranexCommit: typeof KOGG_RANEX_COMMIT;
  readonly ranexTree: typeof KOGG_RANEX_TREE;
  readonly adapterArtifactDigest: KoggDigest;
  readonly schemaSetDigest: KoggDigest;
  readonly operations: readonly KernelOperationCapabilityV2[];
  readonly maxFrameBytes: typeof KERNEL_MAX_FRAME_BYTES;
  readonly maxPendingRequests: typeof KERNEL_MAX_PENDING_REQUESTS;
  readonly maxPendingResponseBytes: typeof KERNEL_MAX_PENDING_RESPONSE_BYTES;
  readonly confinement: 'qualified' | 'degraded' | 'unavailable';
  readonly degradationCodes: readonly ('KERNEL_HOST_UNQUALIFIED' | 'KERNEL_JOURNAL_MISSING')[];
}

export interface KernelHealth {
  readonly status: 'ready' | 'degraded' | 'failed';
  readonly journal: 'valid' | 'missing' | 'invalid';
  readonly capabilities: KernelCapabilities;
}

export interface KernelEnvelopeV2<TBody extends KernelJson = KernelJson> {
  readonly protocol: typeof KOGG_RANEX_PROTOCOL;
  readonly requestId: string;
  readonly operationId: string;
  readonly idempotencyKey: KoggDigest;
  readonly operation: KernelOperationV2;
  readonly operationVersion: number;
  readonly ranexCommit: typeof KOGG_RANEX_COMMIT;
  readonly schemaSetDigest: KoggDigest;
  readonly bodyDigest: KoggDigest;
  readonly body: TBody;
}

export interface KernelJournalPositionV1 {
  readonly sequence: string;
  readonly rootDigest: KoggDigest;
}

export interface KernelResultV2<TProjection = KernelJson> {
  readonly protocol: typeof KOGG_RANEX_PROTOCOL;
  readonly requestId: string;
  readonly operationId: string;
  readonly status: 'succeeded' | 'refused' | 'unknown';
  readonly safeCode: KernelSafeCodeV2;
  readonly resultDigest: KoggDigest | null;
  readonly journal: KernelJournalPositionV1 | null;
  readonly projection: TProjection | null;
}

export interface RepositoryStateV1 {
  readonly objectFormat: GitObjectFormat;
  readonly commitObjectId: string;
  readonly treeObjectId: string;
  readonly gitCommonDirectoryIdentity: KoggDigest;
  readonly worktreeIdentity: KoggDigest;
  readonly indexDigest: KoggDigest;
  readonly trackedContentDigest: KoggDigest;
  readonly untrackedPolicyDigest: KoggDigest;
  readonly isClean: boolean;
}

export interface TaskExecutionBindingV1 {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly specificationDigest: KoggDigest;
  readonly approvalId: string;
  readonly approvalDigest: KoggDigest;
  readonly authorityDigest: KoggDigest;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly repositoryIdentityDigest: KoggDigest;
  readonly protectedSource: RepositoryStateV1;
  readonly worktreeId: string;
  readonly worktreeIdentityDigest: KoggDigest;
  readonly baseState: RepositoryStateV1;
  readonly executionProfileDigest: KoggDigest;
  readonly expiresAt: string;
}

export interface TaskBindingProjectionV1 {
  readonly taskBindingDigest: KoggDigest;
  readonly taskId: string;
  readonly taskRevision: number;
}

export interface ProducerBindingV1 {
  readonly producerId: string;
  readonly producerRole: 'implementation';
  readonly adapterId: string;
  readonly adapterArtifactDigest: KoggDigest;
  readonly provider: string;
  readonly model: string;
  readonly attemptId: string;
  readonly taskBindingDigest: KoggDigest;
  readonly authorityDigest: KoggDigest;
  readonly executionProfileDigest: KoggDigest;
}

export interface ProducerBindingProjectionV1 {
  readonly producerBindingDigest: KoggDigest;
  readonly producerId: string;
  readonly attemptId: string;
}

export interface CheckDefinitionV1 {
  readonly checkId: string;
  readonly kind: 'build' | 'unit' | 'integration' | 'visible-e2e' | 'observability' | 'diagnostics' | 'source-maps' | 'process-cleanup' | 'ranex-evidence';
  readonly executableArtifactDigest: KoggDigest;
  readonly argvTemplateDigest: KoggDigest;
  readonly environmentProfileDigest: KoggDigest;
  readonly timeoutMs: number;
  readonly outputPolicyDigest: KoggDigest;
  readonly requiredProducerSeparation: boolean;
}

export interface FrozenSuiteV1 {
  readonly suiteId: string;
  readonly suiteRevision: number;
  readonly manifestDigest: KoggDigest;
  readonly taskBindingDigest: KoggDigest;
  readonly subjectPolicy: 'exact-commit';
  readonly checks: readonly CheckDefinitionV1[];
  readonly gateCatalogDigest: KoggDigest;
  readonly verifierAuthorityDigest: KoggDigest;
}

export interface FrozenSuiteProjectionV1 {
  readonly suiteDigest: KoggDigest;
  readonly suiteId: string;
  readonly suiteRevision: number;
}

export interface CheckExecutionV1 {
  readonly executionId: string;
  readonly suiteDigest: KoggDigest;
  readonly checkDefinitionDigest: KoggDigest;
  readonly subjectState: RepositoryStateV1;
  readonly verifierId: string;
  readonly verifierRole: 'verification';
  readonly verifierArtifactDigest: KoggDigest;
  readonly processRegistrationId: string;
  readonly executionProfileDigest: KoggDigest;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: 'pass' | 'fail' | 'cancelled' | 'timeout' | 'infrastructure';
  readonly exitClass: 'zero' | 'nonzero' | 'signal' | 'none';
  readonly resultArtifactDigest: KoggDigest;
  readonly cleanupProofDigest: KoggDigest;
}

export interface EvidenceManifestV1 {
  readonly evidenceId: string;
  readonly claimType: string;
  readonly subjectStateDigest: KoggDigest;
  readonly taskBindingDigest: KoggDigest;
  readonly producerBindingDigest: KoggDigest;
  readonly suiteDigest: KoggDigest;
  readonly checkDefinitionDigest: KoggDigest;
  readonly checkExecutionDigest: KoggDigest;
  readonly resultArtifactDigest: KoggDigest;
  readonly authorityDigest: KoggDigest;
  readonly ranexProvenanceDigest: KoggDigest;
  readonly createdAt: string;
}

export interface VerdictBindingV1 {
  readonly verdictId: string;
  readonly taskBindingDigest: KoggDigest;
  readonly subjectStateDigest: KoggDigest;
  readonly gateCatalogDigest: KoggDigest;
  readonly evidenceSetDigest: KoggDigest;
  readonly authorityDigest: KoggDigest;
  readonly ranexProvenanceDigest: KoggDigest;
  readonly journalRootDigest: KoggDigest;
  readonly journalSequence: number;
  readonly decision: 'pass' | 'fail' | 'blocked';
  readonly evaluatedAt: string;
}

export interface KernelBridge {
  start(): Promise<KernelCapabilities>;
  handshake(): Promise<KernelCapabilities>;
  health(): Promise<KernelHealth>;
  capabilities(): Promise<KernelCapabilities>;
  execute<TProjection extends KernelJson>(operation: KernelOperationV2, body: KernelJson): Promise<KernelResultV2<TProjection>>;
  bindTask(binding: TaskExecutionBindingV1): Promise<KernelResultV2<TaskBindingProjectionV1>>;
  dispatchProducer(binding: ProducerBindingV1): Promise<KernelResultV2<ProducerBindingProjectionV1>>;
  freezeSuite(suite: FrozenSuiteV1): Promise<KernelResultV2<FrozenSuiteProjectionV1>>;
  verifyJournal(): Promise<{ readonly valid: boolean; readonly reason?: string }>;
  shutdown(): Promise<void>;
}

export const KernelBridgeToken = Symbol('KernelBridge');

export function canonicalKernelJson(value: KernelJson): string {
  let members = 0;
  const visit = (candidate: KernelJson, depth: number): string => {
    if (depth > KERNEL_MAX_DEPTH) throw new Error('KERNEL_PROTOCOL_OVERFLOW');
    if (candidate === null) return 'null';
    if (typeof candidate === 'boolean') return candidate ? 'true' : 'false';
    if (typeof candidate === 'number') {
      if (!Number.isSafeInteger(candidate)) throw new Error('KERNEL_PROTOCOL_INVALID');
      return String(candidate);
    }
    if (typeof candidate === 'string') {
      if (candidate !== candidate.normalize('NFC') || /[\uD800-\uDFFF]/u.test(candidate)) throw new Error('KERNEL_PROTOCOL_INVALID');
      return JSON.stringify(candidate);
    }
    if (Array.isArray(candidate)) {
      members += candidate.length; if (members > KERNEL_MAX_MEMBERS) throw new Error('KERNEL_PROTOCOL_OVERFLOW');
      return `[${candidate.map(item => visit(item, depth + 1)).join(',')}]`;
    }
    const record = candidate as { readonly [key: string]: KernelJson };
    const keys = Object.keys(record).sort(); members += keys.length;
    if (members > KERNEL_MAX_MEMBERS || keys.some(key => key !== key.normalize('NFC') || /[\uD800-\uDFFF]/u.test(key))) throw new Error('KERNEL_PROTOCOL_OVERFLOW');
    return `{${keys.map(key => `${JSON.stringify(key)}:${visit(record[key]!, depth + 1)}`).join(',')}}`;
  };
  return visit(value, 0);
}
