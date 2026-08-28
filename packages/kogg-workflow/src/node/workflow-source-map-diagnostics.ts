import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// diagnostic-coverage: workflow.source-maps
// observability-exempt: Pure debugger-artifact classifier; the workflow diagnostic contributor reports the aggregate failure.

export interface WorkflowSourceMapDiagnostics { readonly expectedCount: number; readonly presentCount: number; readonly missingCount: number; }
export interface WorkflowSourceMapTargets { readonly nodeDirectories: readonly string[]; readonly commonDirectories: readonly string[]; readonly browserDirectories: readonly string[]; readonly bundleMaps: readonly string[]; }

const MODULES = {
  node: ['backend-module', 'interaction-mode-transition-owner', 'workflow-compiler', 'workflow-diagnostic-contributor', 'workflow-executor-registry', 'workflow-logger', 'workflow-node-catalog', 'workflow-operations-owner-wiring', 'workflow-registry', 'workflow-source-map-diagnostics'],
  common: ['workflow-canonical', 'workflow-graph-edit', 'workflow-group-edit', 'workflow-outline', 'workflow-protocol'],
  browser: ['frontend-module', 'workflow-editor-contribution', 'workflow-editor-widget']
} as const;

export function workflowSourceMapDiagnostics(targets = defaultTargets()): WorkflowSourceMapDiagnostics {
  const directories = [...targets.nodeDirectories, ...targets.commonDirectories, ...targets.browserDirectories];
  if (!targets.nodeDirectories.length || !targets.commonDirectories.length || !targets.browserDirectories.length || !targets.bundleMaps.length || [...directories, ...targets.bundleMaps].some(candidate => !path.isAbsolute(candidate))) throw new Error('Invalid workflow source-map targets');
  const bundledSources = targets.bundleMaps.flatMap(sourceMapSources);
  const presentCount = (Object.keys(MODULES) as Array<keyof typeof MODULES>).reduce((count, area) => count + MODULES[area].filter(stem => {
    const areaDirectories = area === 'node' ? targets.nodeDirectories : area === 'common' ? targets.commonDirectories : targets.browserDirectories;
    return areaDirectories.some(directory => existsSync(path.join(directory, `${stem}.js.map`))) || bundledSources.some(source => source.endsWith(`/kogg-workflow/src/${area}/${stem}.ts`));
  }).length, 0);
  const expectedCount = MODULES.node.length + MODULES.common.length + MODULES.browser.length;
  return { expectedCount, presentCount, missingCount: expectedCount - presentCount };
}

function roots(): readonly string[] { return [...new Set([process.env.KOGG_ROOT, process.cwd()].filter((root): root is string => Boolean(root)).map(root => path.resolve(root)))]; }
function defaultTargets(): WorkflowSourceMapTargets {
  const packageRoots = roots().flatMap(root => [path.join(root, 'packages/kogg-workflow/lib'), path.join(root, 'node_modules/@kogg/workflow/lib')]);
  return {
    nodeDirectories: [...new Set([__dirname, ...packageRoots.map(root => path.join(root, 'node'))])],
    commonDirectories: [...new Set([path.join(__dirname, '../common'), ...packageRoots.map(root => path.join(root, 'common'))])],
    browserDirectories: [...new Set([path.join(__dirname, '../browser'), ...packageRoots.map(root => path.join(root, 'browser'))])],
    bundleMaps: [...new Set([path.join(__dirname, 'main.js.map'), path.join(__dirname, '../frontend/bundle.js.map')])]
  };
}
function sourceMapSources(file: string): readonly string[] { try { const stat = statSync(file); if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024 * 1024) return []; const value = JSON.parse(readFileSync(file, 'utf8')) as { sources?: unknown }; return Array.isArray(value.sources) && value.sources.every(source => typeof source === 'string') ? value.sources.map(source => source.replaceAll('\\', '/')) : []; } catch { /* observability-exempt: A missing or invalid bundle map becomes a missing-map count reported by the contributor. */ return []; } }
