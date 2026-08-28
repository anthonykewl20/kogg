import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// diagnostic-coverage: agents.source-maps
// observability-exempt: Pure presence classifier; the owning diagnostic contributor emits the closed failure event.

export interface SourceMapDiagnostics {
  readonly expectedCount: number;
  readonly presentCount: number;
  readonly missingCount: number;
}

export function inspectSourceMaps(directory: string, moduleStems: readonly string[], options: { readonly packageFolder?: string; readonly moduleDirectories?: readonly string[] } = {}): SourceMapDiagnostics {
  const stems = [...new Set(moduleStems)]; const moduleDirectories = [...new Set([directory, ...(options.moduleDirectories ?? [])])];
  if (moduleDirectories.some(candidate => !path.isAbsolute(candidate)) || stems.length === 0 || stems.some(stem => !/^[a-z0-9][a-z0-9-]*$/u.test(stem)) || options.packageFolder !== undefined && !/^kogg-[a-z0-9-]+$/u.test(options.packageFolder)) throw new Error('Invalid source-map diagnostic target');
  const bundledSources = options.packageFolder ? sourceMapSources(path.join(directory, 'main.js.map')) : [];
  const presentCount = stems.filter(stem => moduleDirectories.some(candidate => existsSync(path.join(candidate, `${stem}.js.map`))) || bundledSources.some(source => source.endsWith(`/${options.packageFolder}/src/node/${stem}.ts`))).length;
  return { expectedCount: stems.length, presentCount, missingCount: stems.length - presentCount };
}

function sourceMapSources(file: string): readonly string[] { try { const stat = statSync(file); if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024 * 1024) return []; const value = JSON.parse(readFileSync(file, 'utf8')) as { sources?: unknown }; return Array.isArray(value.sources) && value.sources.every(source => typeof source === 'string') ? value.sources.map(source => source.replaceAll('\\', '/')) : []; } catch { /* observability-exempt: An unreadable bundle map becomes a missing-map count reported by the owning diagnostic contributor. */ return []; } }
