import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable } from '@theia/core/shared/inversify';
import { InteractionModesPrototype } from './interaction-modes-prototype';

// diagnostic-coverage: interaction-modes.registry, interaction-modes.authority, interaction-modes.transitions, interaction-modes.source-maps
@injectable()
export class InteractionModesDiagnosticPrototype implements KoggDiagnosticContributor {
  readonly id = 'interaction-modes-prototype';
  constructor(@inject(InteractionModesPrototype) private readonly registry: InteractionModesPrototype) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const state = this.registry.diagnostics();
      const root = process.env.KOGG_ROOT ?? process.cwd();
      const maps = await Promise.all([path.join(root, 'packages/kogg-tasks/lib/node/interaction-modes-prototype.js.map'), path.join(root, 'packages/kogg-tasks/lib/browser/tasks-widget.js.map')].map(file => fs.access(file).then(() => true, () => false)));
      return [
        { id: 'interaction-modes.registry', status: state.integrity ? 'pass' : 'fail', summary: state.integrity ? 'Experimental mode registry integrity is valid.' : 'Experimental mode registry integrity failed.', details: { modeCount: state.modeCount } },
        { id: 'interaction-modes.authority', status: state.invalidModeCount === 0 ? 'pass' : 'fail', summary: state.invalidModeCount === 0 ? 'Experimental mode authority values are closed.' : 'An invalid experimental mode authority value exists.', details: { invalidModeCount: state.invalidModeCount } },
        { id: 'interaction-modes.transitions', status: 'pass', summary: 'Experimental transition request ledger is readable.', details: { requestCount: state.requestCount } },
        { id: 'interaction-modes.source-maps', status: maps.every(Boolean) ? 'pass' : 'fail', summary: maps.every(Boolean) ? 'Experimental frontend and backend source maps are available.' : 'An experimental interaction-mode source map is missing.' }
      ];
    } catch (error) {
      console.error('[kogg:interaction-modes:diagnostics] diagnose.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      return ['registry', 'authority', 'transitions', 'source-maps'].map(id => ({ id: `interaction-modes.${id}`, status: 'fail', summary: 'Experimental interaction-mode diagnostics could not run.' }));
    }
  }
}
