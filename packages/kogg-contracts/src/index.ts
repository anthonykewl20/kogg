export const KOGG_RANEX_PROTOCOL = 'kogg-ranex-stdio' as const;
export const KOGG_RANEX_PROTOCOL_VERSION = 1 as const;
export const KOGG_RANEX_COMMIT = '5586d68b0936f554759022caabe847087f1d03ef' as const;

export interface KernelCapabilities {
  readonly protocol: typeof KOGG_RANEX_PROTOCOL;
  readonly protocolVersion: typeof KOGG_RANEX_PROTOCOL_VERSION;
  readonly ranexCommit: typeof KOGG_RANEX_COMMIT;
  readonly ranexTree: string;
  readonly schemaFingerprints: Readonly<Record<string, string>>;
  readonly commands: readonly string[];
  readonly qualifiedProviders: readonly string[];
  readonly confinement: 'qualified' | 'degraded' | 'unavailable';
  readonly degradationReasons: readonly string[];
}

export interface KernelHealth {
  readonly status: 'ready' | 'degraded' | 'failed';
  readonly journal: 'valid' | 'missing' | 'invalid';
  readonly capabilities: KernelCapabilities;
}

export interface KernelEvidenceInput {
  readonly claim_id: string;
  readonly subject_digest: string;
  readonly producer_id: string;
  readonly command: string;
  readonly command_digest: string;
  readonly executable_path: string;
  readonly exit_code: number;
  readonly suite_results?: Record<string, unknown>;
}

export interface KernelEvaluationRequest {
  readonly gateCatalog: string;
  readonly gateId: string;
  readonly evidence: readonly KernelEvidenceInput[];
  readonly subjectDigest: string;
  readonly approverId: string;
  readonly suiteManifest?: Record<string, unknown>;
}

export interface KernelBridge {
  start(): Promise<KernelCapabilities>;
  handshake(): Promise<KernelCapabilities>;
  health(): Promise<KernelHealth>;
  capabilities(): Promise<KernelCapabilities>;
  evaluate(request: KernelEvaluationRequest): Promise<Record<string, unknown>>;
  verifyJournal(): Promise<{ readonly valid: boolean; readonly reason?: string }>;
  listVerdicts(): Promise<readonly Record<string, unknown>[]>;
  shutdown(): Promise<void>;
}

export const KernelBridgeToken = Symbol('KernelBridge');

export type KoggPackageType =
  | 'vscode-extension'
  | 'kogg-integration'
  | 'workflow-template'
  | 'provider-adapter'
  | 'verification-adapter';

export interface KoggPackageManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly publisher: string;
  readonly type: KoggPackageType;
  readonly engines: {
    readonly kogg: string;
    readonly vscode?: string;
  };
  readonly artifact: {
    readonly url: string;
    readonly sha256: string;
    readonly size: number;
  };
  readonly permissions: readonly string[];
  readonly networkDomains: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly license: string;
  readonly sbomUrl: string;
  readonly provenanceUrl: string;
  readonly revoked: boolean;
  readonly signature: string;
}

export interface MarketplaceClient {
  search(query: string): Promise<readonly KoggPackageManifest[]>;
  details(id: string, version?: string): Promise<KoggPackageManifest>;
  install(manifest: KoggPackageManifest): Promise<void>;
  update(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  rollback(id: string): Promise<void>;
  refreshRevocations(): Promise<void>;
}

export const MarketplaceClientToken = Symbol('MarketplaceClient');

export interface CredentialMetadata {
  readonly provider: string;
  readonly account: string;
  readonly updatedAt: string;
}

export interface CredentialStore {
  set(provider: string, account: string, secret: string): Promise<void>;
  get(provider: string, account: string): Promise<string | undefined>;
  delete(provider: string, account: string): Promise<boolean>;
  listMetadata(): Promise<readonly CredentialMetadata[]>;
}

export const CredentialStoreToken = Symbol('CredentialStore');

export interface ProviderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly configuration: 'api-key' | 'oauth' | 'local';
  readonly capabilities: {
    readonly streaming: boolean;
    readonly toolCalls: boolean;
    readonly structuredOutput: boolean;
    readonly local: boolean;
  };
  readonly governedQualification: 'qualified' | 'blocked';
}

export interface ModelDescriptor {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

export interface ProviderRegistry {
  listProviders(): readonly ProviderDescriptor[];
  getProvider(id: string): ProviderDescriptor | undefined;
  discoverModels(provider: string, account: string, endpoint?: string): Promise<readonly ModelDescriptor[]>;
  credentialStatus(provider: string, account: string): Promise<'configured' | 'missing'>;
  testConnection(provider: string, account: string, endpoint?: string): Promise<{ readonly ok: boolean; readonly detail: string }>;
  assertGoverned(provider: string): void;
}

export const ProviderRegistryToken = Symbol('ProviderRegistry');

export type DiagnosticStatus = 'pass' | 'warn' | 'fail';

export interface KoggDiagnosticCheck {
  readonly id: string;
  readonly status: DiagnosticStatus;
  readonly summary: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export interface KoggDiagnosticReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly overall: DiagnosticStatus;
  readonly checks: readonly KoggDiagnosticCheck[];
}

export interface KoggSupportBundle {
  readonly uri: string;
  readonly report: KoggDiagnosticReport;
}

export interface KoggDiagnosticsService {
  run(): Promise<KoggDiagnosticReport>;
  createSupportBundle(): Promise<KoggSupportBundle>;
}

export interface KoggDiagnosticContributor {
  readonly id: string;
  diagnose(): Promise<readonly KoggDiagnosticCheck[]>;
}

export const KoggDiagnosticContribution = Symbol('KoggDiagnosticContribution');
export const KoggDiagnosticsServicePath = '/services/kogg-diagnostics';
export const KoggDiagnosticsServiceToken = Symbol('KoggDiagnosticsService');
