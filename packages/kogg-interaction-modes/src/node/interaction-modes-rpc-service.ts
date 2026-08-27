import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  KoggInteractionModesService, ModeOperationRequestV1, ModeOperationResultV1, ModeProjectionV1, ModeReadRequestV1, ModeTransitionConfigurationOptionsRequestV1, ModeTransitionConfigurationOptionsV1,
  ModeTransitionCancelRequestV1, ModeTransitionConfirmRequestV1, ModeTransitionProjectionV1, ModeTransitionRequestV1
} from '../common/interaction-modes-protocol';
import { InteractionModeError, InteractionModeRegistry } from './interaction-mode-registry';
import { ModeTransitionAuthority, transitionScopeDigest } from './mode-transition-authority';
import { ModeTransitionCoordinator } from './mode-transition-coordinator';

// Desktop mutation authority exists only in the local Electron backend. Browser mutations remain HTTP/CSRF-only.
// diagnostic-coverage: interaction-modes.transitions, interaction-modes.authority
@injectable()
export class InteractionModesRpcService implements KoggInteractionModesService {
  constructor(
    @inject(InteractionModeRegistry) private readonly registry: InteractionModeRegistry,
    @inject(ModeTransitionAuthority) private readonly authority: ModeTransitionAuthority,
    @inject(ModeTransitionCoordinator) private readonly coordinator: ModeTransitionCoordinator
  ) {}

  get(request: ModeReadRequestV1): Promise<ModeProjectionV1> { return this.registry.get(request); }
  getPendingTransition(request: ModeReadRequestV1): Promise<ModeTransitionProjectionV1 | undefined> { return this.registry.getPendingTransition(request); }
  authorizeOperation(request: ModeOperationRequestV1): Promise<ModeOperationResultV1> { return this.registry.authorizeOperation(request); }
  transitionConfigurations(request: ModeTransitionConfigurationOptionsRequestV1): Promise<ModeTransitionConfigurationOptionsV1> { return this.coordinator.configurations(request); }

  requestDesktopTransition(request: ModeTransitionRequestV1): Promise<ModeTransitionProjectionV1> {
    this.requireElectron('transition.request');
    return this.registry.requestTransition(request, this.authority.mintDesktop(transitionScopeDigest('request', request)));
  }

  confirmDesktopTransition(request: ModeTransitionConfirmRequestV1): Promise<ModeTransitionProjectionV1> {
    this.requireElectron('transition.confirm');
    return this.coordinator.confirm(request, this.authority.mintDesktop(transitionScopeDigest('confirm', request)));
  }

  cancelDesktopTransition(request: ModeTransitionCancelRequestV1): Promise<ModeTransitionProjectionV1> {
    this.requireElectron('transition.cancel');
    return this.registry.cancelTransition(request, this.authority.mintDesktop(transitionScopeDigest('cancel', request)));
  }

  private requireElectron(operation: 'transition.request' | 'transition.confirm' | 'transition.cancel'): void {
    if (process.env.KOGG_RUNTIME === 'electron') return;
    console.warn('[kogg:interaction-modes:desktop] mutation.refused', { operation, safeCode: 'MODE_AUTHORITY_REFUSED' });
    throw new InteractionModeError('MODE_AUTHORITY_REFUSED');
  }
}
