// observability-exempt: Pure prototype RPC declarations contain no operational behavior.
// diagnostic-exempt: Disposable prototype declarations are not production runtime state.
export const WorkflowPrototypeServicePath = '/services/kogg-workflow-prototype';
export const WorkflowPrototypeService = Symbol('WorkflowPrototypeService');

export type PrototypeNodeState = 'blocked' | 'ready' | 'active' | 'retrying' | 'completed' | 'cancelled' | 'failed';
export interface PrototypeNode { readonly id: string; readonly kind: string; readonly state: PrototypeNodeState; readonly attempt: number; }
export interface PrototypeSnapshot {
  readonly runId: string; readonly templateVersion: string; readonly templateDigest: string;
  readonly state: 'idle' | 'active' | 'cancelled' | 'completed' | 'recovered' | 'refused';
  readonly safeCode: string; readonly nodes: readonly PrototypeNode[]; readonly eventCount: number;
  readonly processCount: number; readonly immutable: boolean; readonly debuggerReachable: boolean;
}
export interface WorkflowPrototypeService {
  snapshot(): Promise<PrototypeSnapshot>;
  runScenario(request: { readonly requestId: string; readonly scenario: 'success' | 'retry' | 'cancel' }): Promise<PrototypeSnapshot>;
  refuseGraph(request: { readonly requestId: string; readonly mutation: 'cycle' | 'anchor-bypass' | 'authority-expansion' }): Promise<PrototypeSnapshot>;
  recover(request: { readonly requestId: string }): Promise<PrototypeSnapshot>;
}
