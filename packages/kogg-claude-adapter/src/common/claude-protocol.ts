// diagnostic-exempt: Closed Claude adapter declarations contain no operational behavior.
export type ClaudeSafeCode = 'CLAUDE_OK' | 'CLAUDE_LEGAL_APPROVAL_REQUIRED' | 'CLAUDE_ARTIFACT_MISMATCH' | 'CLAUDE_CONFINEMENT_UNAVAILABLE' | 'CLAUDE_CREDENTIAL_BROKER_UNAVAILABLE' | 'CLAUDE_ATTEMPT_INVALID' | 'CLAUDE_INITIALIZATION_MISMATCH' | 'CLAUDE_PROTOCOL_OVERFLOW' | 'CLAUDE_PROTOCOL_INVALID' | 'CLAUDE_MODEL_MISMATCH' | 'CLAUDE_RECOVERY_REQUIRED' | 'CLAUDE_UNVERIFIED_RESIDUAL' | 'CLAUDE_INTERNAL';
export interface ClaudeCommercialUseApprovalV1 {
  readonly schema: 'kogg.claude-commercial-use-approval/v1'; readonly packageName: '@anthropic-ai/claude-agent-sdk'; readonly packageVersion: '0.3.246';
  readonly npmIntegritySha512: 'FtR0HoHHNqeqJWjZN8qLUAzZVFUI9ztXYNPPwv98Ecmv9qq2QTauI8IzkY26CC0mleWAqb9RQEW2C0OtiUliug=='; readonly tarballSha1: '0009206e79ee0ae25f68ebb526584031cb5db048';
  readonly approvedProduct: 'kogg'; readonly approvedUse: 'governed-agent-adapter'; readonly approverRef: string; readonly decidedAt: string; readonly expiresAt: string; readonly signingKeyId: 'kogg-claude-commercial-approval-v1'; readonly signature: string;
}
export interface ClaudeArtifactManifestV1 {
  readonly schema: 'kogg.claude-artifact/v1'; readonly packageName: '@anthropic-ai/claude-agent-sdk'; readonly packageVersion: '0.3.246';
  readonly npmIntegritySha512: ClaudeCommercialUseApprovalV1['npmIntegritySha512']; readonly tarballSha1: ClaudeCommercialUseApprovalV1['tarballSha1']; readonly fileDigests: Readonly<Record<string, string>>;
  readonly bundledCliVersion: string; readonly typeProjectionSha256: string; readonly adapterSchemaSha256: string; readonly createdAt: string; readonly signingKeyId: 'kogg-claude-artifact-v1'; readonly signature: string;
}
export interface GovernedClaudeAttemptV1 {
  readonly schemaVersion: '1'; readonly attemptId: string; readonly taskRevisionDigest: string; readonly repositoryBindingDigest: string; readonly privateRepoObjectId: string; readonly baseCommit: string;
  readonly role: 'implementation'; readonly provider: 'anthropic'; readonly model: string; readonly artifactManifestDigest: string; readonly legalApprovalDigest: string; readonly permissionProfileDigest: string; readonly executionProfileDigest: string;
  readonly budgets: { readonly inputTokens: string; readonly outputTokens: string; readonly toolCalls: string; readonly bytesIn: string; readonly bytesOut: string };
  readonly deadlines: { readonly spawnMs: 10000; readonly initializeMs: 30000; readonly firstProgressMs: 60000; readonly idleMs: 120000; readonly permissionDecisionMs: 60000; readonly interruptReceiptMs: 5000; readonly gracefulExitMs: 10000; readonly terminateMs: 5000; readonly killMs: 5000; readonly closeMs: 5000; readonly cgroupEmptyMs: 10000; readonly absoluteMs: number };
  readonly authorityDigest: string;
}
export interface ClaudeInitializationProjectionV1 { readonly model: string; readonly permissionMode: 'default'; readonly tools: readonly ['Bash','Edit','Glob','Grep','Read','Write']; readonly mcpServers: readonly []; readonly plugins: readonly []; readonly slashCommands: readonly []; readonly agents: readonly []; readonly accountOrganizationPresent: false; readonly cliVersion: string; }
export interface ClaudeReleaseProjection { readonly legalApproved: boolean; readonly artifactVerified: boolean; readonly confinementVerified: boolean; readonly credentialBrokerReady: boolean; readonly sourceMapsPresent: boolean; readonly safeCode: ClaudeSafeCode; }
