import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAcceptedCodexMethods, validateCodexSchemaBundle } from './codex-accepted-methods';

// diagnostic-coverage: codex.release, codex.protocol, codex.source-maps
const valid = (): Record<string, unknown> => ({ schemaVersion: '1', protocolId: 'codex.app-server-v2', protocolVersion: '1.0.0', outboundRequests: ['initialize', 'thread/start', 'turn/start', 'turn/interrupt', 'shutdown'], outboundNotifications: ['initialized'], errorDefinition: 'JSONRPCErrorError', responses: [{ requestMethod: 'initialize', schemaDefinition: 'InitializeResponse' }, { requestMethod: 'thread/start', schemaDefinition: 'ThreadStartResponse' }, { requestMethod: 'turn/start', schemaDefinition: 'TurnStartResponse' }, { requestMethod: 'turn/interrupt', schemaDefinition: 'TurnInterruptResponse' }, { requestMethod: 'shutdown', schemaDefinition: 'ShutdownResponse' }], inbound: [{ method: 'item/completed', kind: 'notification', lifecycle: 'activity', content: 'routed', schemaDefinition: 'ItemCompletedNotification' }, { method: 'item/requestApproval', kind: 'server-request', lifecycle: 'authority-request', content: 'none', schemaDefinition: 'RequestApprovalParams' }, { method: 'turn/completed', kind: 'notification', lifecycle: 'turn-completed', content: 'none', schemaDefinition: 'TurnCompletedNotification' }, { method: 'turn/started', kind: 'notification', lifecycle: 'turn-started', content: 'none', schemaDefinition: 'TurnStartedNotification' }] });
const parse = (value: unknown) => parseAcceptedCodexMethods(Buffer.from(JSON.stringify(value)));

test('parses the exact ordered release method/schema binding into a non-mutable lookup', () => { const accepted = parse(valid()); assert.equal(accepted.inboundSet.size, 4); assert.equal(accepted.inboundSet.has('turn/completed'), true); assert.equal('add' in accepted.inboundSet, false); assert.equal(Object.isFrozen(accepted.inbound), true); assert.equal(Object.isFrozen(accepted.responses), true); });

test('rejects unknown fields, reordered or duplicate methods, widened outbound APIs, and invalid authority content', () => {
  const unknown = valid(); unknown.extra = true; assert.throws(() => parse(unknown), /CODEX_ACCEPTED_METHODS_INVALID/u);
  const reordered = valid(); (reordered.inbound as unknown[]).reverse(); assert.throws(() => parse(reordered), /CODEX_ACCEPTED_METHODS_INVALID/u);
  const duplicate = valid(); (duplicate.inbound as unknown[])[1] = (duplicate.inbound as unknown[])[0]; assert.throws(() => parse(duplicate), /CODEX_ACCEPTED_METHODS_INVALID/u);
  const widened = valid(); (widened.outboundRequests as string[])[0] = 'account/login'; assert.throws(() => parse(widened), /CODEX_ACCEPTED_METHODS_INVALID/u);
  const authority = valid(); ((authority.inbound as Array<Record<string, unknown>>)[1]!).content = 'routed'; assert.throws(() => parse(authority), /CODEX_ACCEPTED_METHODS_INVALID/u);
});

test('binds every accepted method and response to the exact closed draft-07 schema bundle', () => {
  const accepted = parse(valid()); const names = [accepted.errorDefinition, ...[...accepted.responses, ...accepted.inbound].map(value => value.schemaDefinition)]; const definitions = Object.fromEntries(names.map(name => [name, { type: 'object' }])); const bundle = (value: unknown) => Buffer.from(JSON.stringify(value));
  assert.doesNotThrow(() => validateCodexSchemaBundle(bundle({ $schema: 'http://json-schema.org/draft-07/schema#', definitions, title: 'CodexAppServerProtocolV2', type: 'object' }), accepted));
  delete definitions.TurnCompletedNotification; assert.throws(() => validateCodexSchemaBundle(bundle({ $schema: 'http://json-schema.org/draft-07/schema#', definitions, title: 'CodexAppServerProtocolV2', type: 'object' }), accepted), /CODEX_ACCEPTED_METHODS_INVALID/u);
  assert.throws(() => validateCodexSchemaBundle(bundle({ $schema: 'http://json-schema.org/draft-07/schema#', definitions, title: 'CodexAppServerProtocolV2', type: 'object', extra: true }), accepted), /CODEX_ACCEPTED_METHODS_INVALID/u);
});
