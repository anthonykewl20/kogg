// diagnostic-exempt: Closed Claude adapter declarations contain no operational behavior.
export type ClaudeSafeCode = 'CLAUDE_OK' | 'CLAUDE_LEGAL_APPROVAL_REQUIRED' | 'CLAUDE_ARTIFACT_MISMATCH' | 'CLAUDE_INTERNAL';
export interface ClaudeCommercialUseApprovalV1 {
  readonly schema: 'kogg.claude-commercial-use-approval/v1'; readonly packageName: '@anthropic-ai/claude-agent-sdk'; readonly packageVersion: '0.3.246';
  readonly npmIntegritySha512: 'FtR0HoHHNqeqJWjZN8qLUAzZVFUI9ztXYNPPwv98Ecmv9qq2QTauI8IzkY26CC0mleWAqb9RQEW2C0OtiUliug=='; readonly tarballSha1: '0009206e79ee0ae25f68ebb526584031cb5db048';
  readonly approvedProduct: 'kogg'; readonly approvedUse: 'governed-agent-adapter'; readonly approverRef: string; readonly decidedAt: string; readonly expiresAt: string; readonly signingKeyId: 'kogg-claude-commercial-approval-v1'; readonly signature: string;
}
export interface ClaudeReleaseProjection { readonly legalApproved: boolean; readonly artifactVerified: boolean; readonly confinementVerified: boolean; readonly credentialBrokerReady: boolean; readonly processCount: number; readonly residualCount: number; readonly recoveryComplete: boolean; readonly sourceMapsPresent: boolean; readonly safeCode: ClaudeSafeCode; }
