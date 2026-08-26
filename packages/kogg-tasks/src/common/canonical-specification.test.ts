import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalSpecification, SpecificationValidationError } from './canonical-specification';

test('canonical specification preserves exact bytes and distinguishes line endings and normalization', () => {
  const base = { taskId: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', repositoryId: '33333333-3333-4333-8333-333333333333', bindingRevision: '1' };
  const lf = canonicalSpecification({ ...base, content: 'A\né\n' });
  const crlf = canonicalSpecification({ ...base, content: 'A\r\ne\u0301\r\n' });
  assert.equal(lf.bytes.toString('base64'), Buffer.from('A\né\n').toString('base64'));
  assert.equal(lf.lineEnding, 'lf');
  assert.equal(crlf.lineEnding, 'crlf');
  assert.notEqual(lf.digest, crlf.digest);
  assert.match(lf.digest, /^sha256:[0-9a-f]{64}$/u);
});

test('canonical specification rejects empty, oversized, and unpaired surrogate input', () => {
  const base = { taskId: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', repositoryId: '33333333-3333-4333-8333-333333333333', bindingRevision: '1' };
  assert.throws(() => canonicalSpecification({ ...base, content: '' }), (error: unknown) => error instanceof SpecificationValidationError && error.code === 'SPEC_EMPTY');
  assert.throws(() => canonicalSpecification({ ...base, content: 'a'.repeat(1_048_577) }), (error: unknown) => error instanceof SpecificationValidationError && error.code === 'SPEC_TOO_LARGE');
  assert.throws(() => canonicalSpecification({ ...base, content: String.fromCharCode(0xd800) }), (error: unknown) => error instanceof SpecificationValidationError && error.code === 'SPEC_INVALID_UNICODE');
});
