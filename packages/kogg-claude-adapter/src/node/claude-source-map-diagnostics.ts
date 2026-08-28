import { inspectSourceMaps, type SourceMapDiagnostics } from '@kogg/agents/lib/node/source-map-diagnostics';
import path from 'node:path';

// diagnostic-coverage: claude.source-maps
// observability-exempt: Pure presence classifier; the Claude diagnostic contributor emits the closed failure event.

const CLAUDE_DEBUG_MODULES = ['backend-module', 'claude-adapter-factory', 'claude-artifact-registry', 'claude-attempt-authority', 'claude-diagnostic-contributor', 'claude-logger', 'claude-recovery-registry', 'claude-runtime-authority', 'claude-source-map-diagnostics'] as const;

export function claudeSourceMapDiagnostics(): SourceMapDiagnostics { const roots = [...new Set([process.env.KOGG_ROOT, process.cwd()].filter((root): root is string => Boolean(root)).map(root => path.resolve(root)))]; return inspectSourceMaps(__dirname, CLAUDE_DEBUG_MODULES, { packageFolder: 'kogg-claude-adapter', moduleDirectories: roots.flatMap(root => [path.join(root, 'packages/kogg-claude-adapter/lib/node'), path.join(root, 'node_modules/@kogg/claude-adapter/lib/node')]) }); }
