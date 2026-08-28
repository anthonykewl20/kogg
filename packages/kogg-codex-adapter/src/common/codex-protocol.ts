// observability-exempt: This file contains pure closed declarations with no operational behavior.
// diagnostic-exempt: Pure declarations have no independent runtime state.

export type CodexSafeCode = 'CODEX_OK' | 'CODEX_RELEASE_UNQUALIFIED' | 'CODEX_MANIFEST_INVALID'
  | 'CODEX_BINARY_MISMATCH' | 'CODEX_SCHEMA_MISMATCH' | 'CODEX_VERSION_MISMATCH'
  | 'CODEX_PLATFORM_UNSUPPORTED' | 'CODEX_CONFINEMENT_UNVERIFIED' | 'CODEX_PROCESS_REGISTRATION_FAILED' | 'CODEX_PROCESS_START_FAILED' | 'CODEX_PROTOCOL_VIOLATION'
  | 'CODEX_PROTOCOL_UNSUPPORTED' | 'CODEX_FRAME_TOO_LARGE' | 'CODEX_QUEUE_OVERFLOW'
  | 'CODEX_STDIN_BACKPRESSURE' | 'CODEX_STDERR_LIMIT' | 'CODEX_CONTENT_BACKPRESSURE'
  | 'CODEX_AUTHORITY_REQUESTED'
  | 'CODEX_PROVIDER_MISMATCH' | 'CODEX_MODEL_MISMATCH' | 'CODEX_SANDBOX_MISMATCH' | 'CODEX_CAPABILITY_UNEXPECTED'
  | 'CODEX_CREDENTIAL_LEASE_REFUSED' | 'CODEX_CREDENTIAL_REVOKED'
  | 'CODEX_TRANSPORT_LOST' | 'CODEX_HOST_EXITED' | 'CODEX_PROVIDER_REFUSED' | 'CODEX_CANCELLED'
  | 'CODEX_FIRST_ACTIVITY_TIMEOUT' | 'CODEX_ABSOLUTE_TIMEOUT' | 'CODEX_CLEANUP_TIMEOUT' | 'CODEX_CLEANUP_FAILED' | 'CODEX_INTERNAL_FAILURE';

export interface QualifiedCodexReleaseV1 {
  readonly manifestVersion: '1'; readonly releaseId: string; readonly codexVersion: string; readonly codexCommit: string;
  readonly target: 'x86_64-unknown-linux-musl' | 'aarch64-unknown-linux-musl'; readonly binarySha256: string; readonly binarySize: string;
  readonly appServerSchemaVersion: 'v2'; readonly appServerSchemaSha256: string; readonly acceptedMethodsSha256: string;
  readonly linuxHelperSha256: string; readonly adapterVersion: string; readonly qualificationProfileId: string;
  readonly signedAt: string; readonly signatureKeyId: string; readonly signature: string;
}

export interface CodexReleaseProjection {
  readonly qualified: boolean; readonly safeCode: CodexSafeCode; readonly adapterVersion: string; readonly target?: QualifiedCodexReleaseV1['target'];
  readonly releasePresent: boolean; readonly assetsVerified: boolean; readonly protocolVerified: boolean; readonly confinementVerified: boolean; readonly credentialBrokerReady: boolean; readonly processCount: number;
  readonly residualCount: number; readonly recoveryComplete: boolean; readonly sourceMapsPresent: boolean;
}
