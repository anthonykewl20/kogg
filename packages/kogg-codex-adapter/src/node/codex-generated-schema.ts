import Ajv, { type ValidateFunction } from 'ajv';
import { type AcceptedCodexMethod, type AcceptedCodexMethods, validateCodexSchemaBundle } from './codex-accepted-methods';
import type { CodexFrameSchema, CodexValidatedFrame } from './codex-protocol-core';

// Schema errors and frames are never logged or returned; callers receive only a closed validation miss.
// diagnostic-coverage: codex.release, codex.protocol, codex.source-maps
export function compileCodexFrameSchema(bytes: Buffer, accepted: AcceptedCodexMethods): CodexFrameSchema {
  validateCodexSchemaBundle(bytes, accepted); let hardened: Record<string, unknown>; try { const source = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; hardened = harden(source) as Record<string, unknown>; } catch { // observability-exempt: Release verification normalizes compiler preparation failures without exposing schema content.
    invalid(); }
  const validators = new Map<string, ValidateFunction>(); const names = new Set([accepted.errorDefinition, ...accepted.responses.map(value => value.schemaDefinition), ...accepted.inbound.map(value => value.schemaDefinition)]);
  try { const ajv = new Ajv({ allErrors: false, strict: false, allowUnionTypes: true, validateFormats: false }); ajv.addSchema(hardened, 'codex-v2'); for (const name of names) { const validator = ajv.getSchema(`codex-v2#/definitions/${name}`); if (!validator) invalid(); validators.set(name, validator); } } catch { // observability-exempt: Release verification normalizes compiler details to CODEX_SCHEMA_MISMATCH without exposing schema content.
    invalid(); }
  const inbound = new Map<string, AcceptedCodexMethod>(accepted.inbound.map(value => [value.method, value])); const responses = new Map<string, string>(accepted.responses.map(value => [value.requestMethod, value.schemaDefinition])); const error = validators.get(accepted.errorDefinition)!;
  return Object.freeze({ validate(frame: Readonly<Record<string, unknown>>, expectedRequestMethod?: string): CodexValidatedFrame | undefined {
    if (typeof frame.method === 'string') {
      const entry = inbound.get(frame.method); if (!entry) return undefined; const keys = entry.kind === 'notification' ? ['method', 'params'] : ['id', 'method', 'params']; if (!exact(frame, keys) || !validators.get(entry.schemaDefinition)!(frame.params)) return undefined;
      const content = entry.content === 'routed' ? frame.params : undefined; const contentBytes = content === undefined ? undefined : Buffer.byteLength(JSON.stringify(content));
      return entry.kind === 'notification' ? { kind: 'notification', method: entry.method, lifecycle: entry.lifecycle as 'turn-started' | 'activity' | 'turn-completed', ...(content === undefined ? {} : { content, contentBytes }) } : typeof frame.id === 'number' ? { kind: 'server-request', id: frame.id, method: entry.method, lifecycle: 'authority-request' } : undefined;
    }
    if (typeof frame.id !== 'number' || !expectedRequestMethod || !responses.has(expectedRequestMethod)) return undefined;
    if (exact(frame, ['id', 'result']) && validators.get(responses.get(expectedRequestMethod)!)!(frame.result)) return { kind: 'response', id: frame.id, outcome: 'result', privateResult: frame.result };
    if (exact(frame, ['error', 'id']) && error(frame.error)) return { kind: 'response', id: frame.id, outcome: 'error' }; return undefined;
  } });
}
function harden(value: unknown): unknown { if (Array.isArray(value)) return value.map(harden); if (!value || typeof value !== 'object') return value; const result = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, harden(item)])); if (result.type === 'object' && result.additionalProperties === undefined) result.additionalProperties = false; return result; }
function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...fields].sort().join(','); }
function invalid(): never { throw new Error('CODEX_SCHEMA_COMPILE_FAILED'); }
