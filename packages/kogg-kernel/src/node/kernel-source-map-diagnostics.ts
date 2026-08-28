import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// diagnostic-coverage: kernel.source-maps
// observability-exempt: Pure debugger-artifact classifier; the kernel diagnostic contributor reports the aggregate failure.

export interface KernelSourceMapDiagnostics {
  readonly expectedCount: number;
  readonly presentCount: number;
  readonly missingCount: number;
}

const TYPESCRIPT_MODULES = ['backend-module', 'check-operations-owner', 'kernel-backend-contribution', 'kernel-bridge', 'kernel-diagnostic-contributor', 'kernel-evidence-admission-service', 'kernel-gate-evaluation-service', 'kernel-repository-state-authority', 'kernel-source-map-diagnostics', 'kernel-task-binding-service', 'kernel-verdict-read-service', 'ranex-operations-owner'] as const;

export function kernelSourceMapDiagnostics(moduleDirectories = defaultModuleDirectories(), adapterPaths = defaultAdapterPaths()): KernelSourceMapDiagnostics {
  if (!moduleDirectories.length || !adapterPaths.length || [...moduleDirectories, ...adapterPaths].some(candidate => !path.isAbsolute(candidate))) throw new Error('Invalid kernel debugger-artifact roots');
  const bundledSources = moduleDirectories.flatMap(directory => sourceMapSources(path.join(directory, 'main.js.map')));
  const typescriptPresent = TYPESCRIPT_MODULES.filter(stem => moduleDirectories.some(directory => existsSync(path.join(directory, `${stem}.js.map`))) || bundledSources.some(source => source.endsWith(`/kogg-kernel/src/node/${stem}.ts`))).length;
  const adapterPresent = adapterPaths.some(isDebuggableSource) ? 1 : 0;
  const expectedCount = TYPESCRIPT_MODULES.length + 1; const presentCount = typescriptPresent + adapterPresent;
  return { expectedCount, presentCount, missingCount: expectedCount - presentCount };
}

function roots(): readonly string[] { return [...new Set([process.env.KOGG_ROOT, process.cwd()].filter((root): root is string => Boolean(root)).map(root => path.resolve(root)))]; }
function defaultModuleDirectories(): readonly string[] { return [...new Set([__dirname, ...roots().flatMap(root => [path.join(root, 'packages/kogg-kernel/lib/node'), path.join(root, 'node_modules/@kogg/kernel/lib/node')])])]; }
function defaultAdapterPaths(): readonly string[] {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return [...new Set([
    process.env.KOGG_PACKAGED_RUNTIME ? path.join(process.env.KOGG_PACKAGED_RUNTIME, 'adapter', 'kogg_ranex_adapter.py') : undefined,
    resources ? path.join(resources, 'kogg-runtime', 'adapter', 'kogg_ranex_adapter.py') : undefined,
    ...roots().flatMap(root => [path.join(root, 'packages/kogg-kernel/python/kogg_ranex_adapter.py'), path.join(root, 'node_modules/@kogg/kernel/python/kogg_ranex_adapter.py')])
  ].filter((candidate): candidate is string => Boolean(candidate)).map(candidate => path.resolve(candidate)))];
}
function isDebuggableSource(file: string): boolean { try { const stat = statSync(file); return stat.isFile() && stat.size > 0 && stat.size <= 4 * 1024 * 1024; } catch { /* observability-exempt: An unreadable adapter becomes a missing-source count reported by the contributor. */ return false; } }
function sourceMapSources(file: string): readonly string[] { try { const stat = statSync(file); if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024 * 1024) return []; const value = JSON.parse(readFileSync(file, 'utf8')) as { sources?: unknown }; return Array.isArray(value.sources) && value.sources.every(source => typeof source === 'string') ? value.sources.map(source => source.replaceAll('\\', '/')) : []; } catch { /* observability-exempt: A missing or invalid bundle map becomes a missing-map count reported by the contributor. */ return []; } }
