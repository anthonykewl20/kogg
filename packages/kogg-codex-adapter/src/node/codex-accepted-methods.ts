// This parser accepts only the reviewed release-generated method/schema binding. It logs no asset bytes or method values.
// diagnostic-coverage: codex.release, codex.protocol, codex.source-maps
const METHOD = /^[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)+$/u; const DEFINITION = /^[A-Za-z][A-Za-z0-9]{0,127}$/u;
const REQUESTS = ['initialize', 'thread/start', 'turn/start', 'turn/interrupt', 'shutdown'] as const; const NOTIFICATIONS = ['initialized'] as const;
const ROOT_FIELDS = ['schemaVersion', 'protocolId', 'protocolVersion', 'outboundRequests', 'outboundNotifications', 'errorDefinition', 'responses', 'inbound'] as const;
const INBOUND_FIELDS = ['method', 'kind', 'lifecycle', 'content', 'schemaDefinition'] as const; const RESPONSE_FIELDS = ['requestMethod', 'schemaDefinition'] as const;
export interface AcceptedCodexMethod { readonly method: string; readonly kind: 'notification' | 'server-request'; readonly lifecycle: 'turn-started' | 'activity' | 'turn-completed' | 'authority-request'; readonly content: 'none' | 'routed'; readonly schemaDefinition: string; }
export interface AcceptedCodexResponse { readonly requestMethod: typeof REQUESTS[number]; readonly schemaDefinition: string; }
export interface AcceptedCodexMethods { readonly errorDefinition: string; readonly inbound: readonly AcceptedCodexMethod[]; readonly responses: readonly AcceptedCodexResponse[]; readonly inboundSet: { readonly size: number; has(method: string): boolean }; }

export function parseAcceptedCodexMethods(bytes: Buffer): AcceptedCodexMethods {
  let raw: unknown; try { raw = JSON.parse(bytes.toString('utf8')); } catch { // observability-exempt: The caller emits the closed schema mismatch; malformed release bytes are intentionally discarded.
    throw new Error('CODEX_ACCEPTED_METHODS_INVALID'); }
  if (!record(raw) || !exact(raw, ROOT_FIELDS) || raw.schemaVersion !== '1' || raw.protocolId !== 'codex.app-server-v2' || raw.protocolVersion !== '1.0.0' || typeof raw.errorDefinition !== 'string' || !DEFINITION.test(raw.errorDefinition) || !same(raw.outboundRequests, REQUESTS) || !same(raw.outboundNotifications, NOTIFICATIONS) || !Array.isArray(raw.responses) || !Array.isArray(raw.inbound) || raw.responses.length !== REQUESTS.length || raw.inbound.length < 3 || raw.inbound.length > 256) invalid();
  const responses: AcceptedCodexResponse[] = raw.responses.map(value => { if (!record(value) || !exact(value, RESPONSE_FIELDS) || !REQUESTS.includes(value.requestMethod as typeof REQUESTS[number]) || typeof value.schemaDefinition !== 'string' || !DEFINITION.test(value.schemaDefinition)) invalid(); return { requestMethod: value.requestMethod, schemaDefinition: value.schemaDefinition } as AcceptedCodexResponse; });
  if (responses.map(value => value.requestMethod).join(',') !== REQUESTS.join(',')) invalid();
  const inbound: AcceptedCodexMethod[] = raw.inbound.map(value => { if (!record(value) || !exact(value, INBOUND_FIELDS) || typeof value.method !== 'string' || !METHOD.test(value.method) || !['notification', 'server-request'].includes(String(value.kind)) || !['turn-started', 'activity', 'turn-completed', 'authority-request'].includes(String(value.lifecycle)) || !['none', 'routed'].includes(String(value.content)) || typeof value.schemaDefinition !== 'string' || !DEFINITION.test(value.schemaDefinition)) invalid(); if ((value.kind === 'server-request') !== (value.lifecycle === 'authority-request') || (value.lifecycle === 'authority-request' && value.content !== 'none')) invalid(); return value as unknown as AcceptedCodexMethod; });
  const methods = inbound.map(value => value.method); if (new Set(methods).size !== methods.length || methods.join(',') !== [...methods].sort().join(',') || !inbound.some(value => value.lifecycle === 'turn-started') || !inbound.some(value => value.lifecycle === 'turn-completed') || !inbound.some(value => value.lifecycle === 'activity')) invalid();
  const methodSet = new Set(methods); const inboundSet = Object.freeze({ size: methodSet.size, has: (method: string): boolean => methodSet.has(method) });
  return Object.freeze({ errorDefinition: raw.errorDefinition, inbound: Object.freeze(inbound.map(value => Object.freeze(value))), responses: Object.freeze(responses.map(value => Object.freeze(value))), inboundSet });
}
export function validateCodexSchemaBundle(bytes: Buffer, accepted: AcceptedCodexMethods): void {
  let raw: unknown; try { raw = JSON.parse(bytes.toString('utf8')); } catch { // observability-exempt: The caller emits the closed schema mismatch; malformed release bytes are intentionally discarded.
    invalid(); }
  if (!record(raw) || !exact(raw, ['$schema', 'definitions', 'title', 'type']) || raw.$schema !== 'http://json-schema.org/draft-07/schema#' || raw.title !== 'CodexAppServerProtocolV2' || raw.type !== 'object' || !record(raw.definitions)) invalid();
  const required = [accepted.errorDefinition, ...accepted.responses.map(value => value.schemaDefinition), ...accepted.inbound.map(value => value.schemaDefinition)];
  if (required.some(name => !record((raw.definitions as Record<string, unknown>)[name]))) invalid();
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...fields].sort().join(','); }
function same(value: unknown, expected: readonly string[]): boolean { return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]); }
function invalid(): never { throw new Error('CODEX_ACCEPTED_METHODS_INVALID'); }
