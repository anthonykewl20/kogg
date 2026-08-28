import { inspectSourceMaps, type SourceMapDiagnostics } from '@kogg/agents/lib/node/source-map-diagnostics';
import path from 'node:path';

// diagnostic-coverage: codex.source-maps
// observability-exempt: Pure presence classifier; the Codex diagnostic contributor emits the closed failure event.

const CODEX_DEBUG_MODULES = ['backend-module', 'codex-accepted-methods', 'codex-adapter-factory', 'codex-content-router', 'codex-diagnostic-contributor', 'codex-generated-schema', 'codex-logger', 'codex-protocol-client', 'codex-protocol-core', 'codex-release-registry', 'codex-source-map-diagnostics', 'codex-stdin-writer', 'codex-stdio-drainer'] as const;

export function codexSourceMapDiagnostics(): SourceMapDiagnostics { const roots = [...new Set([process.env.KOGG_ROOT, process.cwd()].filter((root): root is string => Boolean(root)).map(root => path.resolve(root)))]; return inspectSourceMaps(__dirname, CODEX_DEBUG_MODULES, { packageFolder: 'kogg-codex-adapter', moduleDirectories: roots.flatMap(root => [path.join(root, 'packages/kogg-codex-adapter/lib/node'), path.join(root, 'node_modules/@kogg/codex-adapter/lib/node')]) }); }
