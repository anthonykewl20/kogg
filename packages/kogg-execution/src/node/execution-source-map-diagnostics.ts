import { existsSync } from 'node:fs';
import path from 'node:path';
import { inspectSourceMaps, type SourceMapDiagnostics } from '@kogg/agents/lib/node/source-map-diagnostics';

// diagnostic-coverage: execution.source-maps
// observability-exempt: Pure presence classifier; the execution diagnostic contributor reports the aggregate failure.
const NODE_MODULES = ['agent-workspace-controller','backend-module','candidate-importer','candidate-lifecycle-controller','candidate-sealer','controller-git-runner','execution-allocation-registry','execution-diagnostic-contributor','execution-logger','execution-operations-owner-wiring','execution-service','execution-target-registry','interaction-mode-transition-owner','native-allocation-controller','private-git-seeder','production-candidate-lifecycle','production-private-git-seeder'] as const;
const BROWSER_MODULES = ['execution-contribution','execution-widget','frontend-module'] as const;

export function executionSourceMapDiagnostics(nodeDirectories = defaultNodeDirectories(), browserDirectories = defaultBrowserDirectories()): SourceMapDiagnostics {
  if (!nodeDirectories.length || !browserDirectories.length || [...nodeDirectories, ...browserDirectories].some(directory => !path.isAbsolute(directory))) throw new Error('Invalid execution source-map roots');
  const node = inspectSourceMaps(nodeDirectories[0]!, NODE_MODULES, { packageFolder: 'kogg-execution', moduleDirectories: nodeDirectories });
  const browserPresent = BROWSER_MODULES.filter(stem => browserDirectories.some(directory => existsSync(path.join(directory, `${stem}.js.map`)))).length;
  const expectedCount = node.expectedCount + BROWSER_MODULES.length; const presentCount = node.presentCount + browserPresent;
  return { expectedCount, presentCount, missingCount: expectedCount - presentCount };
}
function roots(): readonly string[] { return [...new Set([process.env.KOGG_ROOT, process.cwd()].filter((root): root is string => Boolean(root)).map(root => path.resolve(root)))]; }
function defaultNodeDirectories(): readonly string[] { return [...new Set([__dirname, ...roots().flatMap(root => [path.join(root, 'packages/kogg-execution/lib/node'), path.join(root, 'node_modules/@kogg/execution/lib/node')])])]; }
function defaultBrowserDirectories(): readonly string[] { return [...new Set([path.join(__dirname, '../browser'), ...roots().flatMap(root => [path.join(root, 'packages/kogg-execution/lib/browser'), path.join(root, 'node_modules/@kogg/execution/lib/browser')])])]; }
