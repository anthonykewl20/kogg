import { createHash, randomUUID } from 'node:crypto';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { ModeTransitionConfigurationCandidateV1, ModeTransitionConfigurationContextV1, ModeTransitionOwnerContribution, ModeTransitionOwnerRequestV1, ModeTransitionOwnerResultV1 } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';
import { WorkflowRegistry } from './workflow-registry';

// Compiles the exact selected project workflow and binds its injected trust-spine anchors before Kogg authority can commit.
// diagnostic-coverage: workflow.anchors, workflow.authority, interaction-modes.anchors, interaction-modes.transitions
@injectable()
export class WorkflowModeTransitionOwner implements ModeTransitionOwnerContribution {
  readonly owner = 'workflow-anchors' as const;
  constructor(@inject(WorkflowRegistry) private readonly workflows: WorkflowRegistry) {}
  async configurationCandidates(context: ModeTransitionConfigurationContextV1): Promise<readonly ModeTransitionConfigurationCandidateV1[]> {
    return (await this.workflows.listProjectVersions(context.projectId)).map(version => ({ owner: this.owner, workflowVersionId: version.versionId }));
  }
  async qualifyTransition(request: ModeTransitionOwnerRequestV1): Promise<ModeTransitionOwnerResultV1> {
    if (request.configuration.kind !== 'kogg') return { owner: this.owner, qualified: false, safeCode: 'MODE_WORKFLOW_UNAVAILABLE' };
    const configuration = request.configuration;
    const versions = await this.workflows.listProjectVersions(request.projectId);
    if (!versions.some(version => version.versionId === configuration.workflowVersionId)) return this.refused(request);
    const result = await this.workflows.compile({ requestId: randomUUID(), versionId: configuration.workflowVersionId });
    if (result.kind !== 'completed' || !result.plan || result.plan.injectedAnchorCount < 1) return this.refused(request);
    const proofDigest = `sha256:${createHash('sha256').update(`kogg:interaction-modes:workflow-anchors:v1\0${JSON.stringify({ planDigest: result.plan.planDigest, taskId: request.taskId, transitionId: request.transitionId, trustSpineDigest: result.plan.trustSpineDigest, versionId: result.plan.versionId })}`).digest('hex')}`;
    console.info('[kogg:interaction-modes:workflow-owner] qualification.completed', { transitionId: request.transitionId, taskId: request.taskId, planId: result.plan.planId, injectedAnchorCount: result.plan.injectedAnchorCount });
    return { owner: this.owner, qualified: true, safeCode: 'MODE_OK', proofDigest };
  }
  private refused(request: ModeTransitionOwnerRequestV1): ModeTransitionOwnerResultV1 {
    console.warn('[kogg:interaction-modes:workflow-owner] qualification.refused', { transitionId: request.transitionId, taskId: request.taskId, safeCode: 'MODE_WORKFLOW_UNAVAILABLE' });
    return { owner: this.owner, qualified: false, safeCode: 'MODE_WORKFLOW_UNAVAILABLE' };
  }
}
