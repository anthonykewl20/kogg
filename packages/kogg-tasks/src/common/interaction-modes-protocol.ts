// observability-exempt: Pure experimental RPC declarations contain no operational behavior.
// diagnostic-exempt: Pure experimental issue #121 declarations have no runtime state.
export const InteractionModesServicePath = '/services/kogg-interaction-modes-prototype';
export const InteractionModesService = Symbol('InteractionModesService');

export type InteractionMode = 'plan' | 'build' | 'kogg';
export type ModeOperation = 'production-mutation' | 'evidence-admit' | 'verdict-read' | 'merge' | 'governed-entry';
export interface ModeProjection { readonly taskId: string; readonly selected: InteractionMode; readonly effective: InteractionMode; readonly sequence: number; readonly stage: string; }
export interface ModeResult { readonly kind: 'completed' | 'refused' | 'conflict'; readonly code: string; readonly projection: ModeProjection; readonly allowed?: boolean; }
export interface InteractionModesService {
  get(taskId: string): Promise<ModeProjection>;
  transition(input: { readonly requestId: string; readonly taskId: string; readonly expectedSequence: number; readonly requested: InteractionMode; readonly confirmed: boolean }): Promise<ModeResult>;
  authorize(input: { readonly requestId: string; readonly taskId: string; readonly operation: ModeOperation }): Promise<ModeResult>;
}
