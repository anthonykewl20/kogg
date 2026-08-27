import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAcceptedCodexMethods } from './codex-accepted-methods';
import { compileCodexFrameSchema } from './codex-generated-schema';

// diagnostic-coverage: codex.release, codex.protocol, codex.source-maps
const accepted = parseAcceptedCodexMethods(Buffer.from(JSON.stringify({ schemaVersion: '1', protocolId: 'codex.app-server-v2', protocolVersion: '1.0.0', outboundRequests: ['initialize', 'thread/start', 'turn/start', 'turn/interrupt', 'shutdown'], outboundNotifications: ['initialized'], errorDefinition: 'JSONRPCErrorError', responses: [{ requestMethod: 'initialize', schemaDefinition: 'InitializeResponse' }, { requestMethod: 'thread/start', schemaDefinition: 'ThreadStartResponse' }, { requestMethod: 'turn/start', schemaDefinition: 'TurnStartResponse' }, { requestMethod: 'turn/interrupt', schemaDefinition: 'TurnInterruptResponse' }, { requestMethod: 'shutdown', schemaDefinition: 'ShutdownResponse' }], inbound: [{ method: 'item/completed', kind: 'notification', lifecycle: 'activity', content: 'routed', schemaDefinition: 'ItemCompletedNotification' }, { method: 'item/requestApproval', kind: 'server-request', lifecycle: 'authority-request', content: 'none', schemaDefinition: 'RequestApprovalParams' }, { method: 'turn/completed', kind: 'notification', lifecycle: 'turn-completed', content: 'none', schemaDefinition: 'TurnCompletedNotification' }, { method: 'turn/started', kind: 'notification', lifecycle: 'turn-started', content: 'none', schemaDefinition: 'TurnStartedNotification' }] })));
const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: 'object', properties, required });
const schemaBytes = (): Buffer => Buffer.from(JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', title: 'CodexAppServerProtocolV2', type: 'object', definitions: {
  JSONRPCErrorError: object({ code: { type: 'integer' }, message: { type: 'string' } }), InitializeResponse: object({ platformFamily: { type: 'string' } }), ThreadStartResponse: object({ thread: object({ id: { type: 'string' } }) }), TurnStartResponse: object({ turn: object({ id: { type: 'string' } }) }), TurnInterruptResponse: object({}), ShutdownResponse: object({}), ItemCompletedNotification: object({ text: { type: 'string' } }), RequestApprovalParams: object({ reason: { type: 'string' } }), TurnCompletedNotification: object({ status: { type: 'string' } }), TurnStartedNotification: object({ turnId: { type: 'string' } })
} }));

test('compiles only accepted definitions and validates exact response, notification, request, and error envelopes', () => {
  const schema = compileCodexFrameSchema(schemaBytes(), accepted);
  assert.deepEqual(schema.validate({ id: 1, result: { platformFamily: 'unix' } }, 'initialize'), { kind: 'response', id: 1, outcome: 'result' });
  assert.equal(schema.validate({ id: 1, result: { platformFamily: 'unix', extra: true } }, 'initialize'), undefined);
  assert.deepEqual(schema.validate({ method: 'turn/started', params: { turnId: 'opaque' } }), { kind: 'notification', method: 'turn/started', lifecycle: 'turn-started' });
  assert.deepEqual(schema.validate({ id: 8, method: 'item/requestApproval', params: { reason: 'policy' } }), { kind: 'server-request', id: 8, method: 'item/requestApproval', lifecycle: 'authority-request' });
  assert.deepEqual(schema.validate({ id: 2, error: { code: -32600, message: 'refused' } }, 'thread/start'), { kind: 'response', id: 2, outcome: 'error' });
  assert.equal(schema.validate({ method: 'account/updated', params: {} }), undefined);
});

test('routes only accepted content params after schema validation and rejects schema compiler failures', () => {
  const schema = compileCodexFrameSchema(schemaBytes(), accepted); const frame = schema.validate({ method: 'item/completed', params: { text: 'private' } });
  assert.equal(frame?.kind, 'notification'); assert.deepEqual(frame && 'content' in frame ? frame.content : undefined, { text: 'private' }); assert.equal(frame && 'contentBytes' in frame ? frame.contentBytes : 0, 18);
  const invalid = JSON.parse(schemaBytes().toString()) as { definitions: Record<string, unknown> }; invalid.definitions.InitializeResponse = { type: 'not-a-type' };
  assert.throws(() => compileCodexFrameSchema(Buffer.from(JSON.stringify(invalid)), accepted), /CODEX_SCHEMA_COMPILE_FAILED/u);
});
