import { createHash } from 'node:crypto';

// observability-exempt: Pure deterministic canonicalization performs no I/O and logs no content.
// diagnostic-exempt: Canonicalization is covered by tasks.revisions through stored digest verification.

const MAX_BYTES = 1_048_576;

export class SpecificationValidationError extends Error {
  constructor(readonly code: 'SPEC_EMPTY' | 'SPEC_TOO_LARGE' | 'SPEC_INVALID_UNICODE') { super(code); }
}

export interface CanonicalSpecification {
  readonly bytes: Buffer;
  readonly canonicalBytes: Buffer;
  readonly digest: string;
  readonly lineEnding: 'none' | 'lf' | 'crlf' | 'mixed';
}

export function canonicalSpecification(input: {
  readonly content: string; readonly taskId: string; readonly projectId: string;
  readonly repositoryId: string; readonly bindingRevision: string;
}): CanonicalSpecification {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input.content)) {
    throw new SpecificationValidationError('SPEC_INVALID_UNICODE');
  }
  const bytes = Buffer.from(input.content, 'utf8');
  if (bytes.length === 0) throw new SpecificationValidationError('SPEC_EMPTY');
  if (bytes.length > MAX_BYTES) throw new SpecificationValidationError('SPEC_TOO_LARGE');
  const fields: Readonly<Record<string, string>> = {
    bindingRevision: input.bindingRevision,
    encoding: 'utf-8-exact-v1',
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    specificationBase64: bytes.toString('base64'),
    taskId: input.taskId,
    version: 'kogg.task-specification.v1'
  };
  const canonical = '{' + Object.keys(fields).sort().map(key => quote(key) + ':' + quote(fields[key]!)).join(',') + '}';
  const canonicalBytes = Buffer.from(canonical, 'utf8');
  return {
    bytes,
    canonicalBytes,
    digest: 'sha256:' + createHash('sha256').update(canonicalBytes).digest('hex'),
    lineEnding: lineEnding(input.content)
  };
}

export function canonicalRequestDigest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function stable(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map(key => quote(key) + ':' + stable(record[key])).join(',') + '}';
  }
  return quote(String(value));
}

function quote(value: string): string {
  return '"' + value.replace(/["\\\u0000-\u001f]/gu, character => {
    if (character === '"') return '\\"';
    if (character === '\\') return '\\\\';
    return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
  }) + '"';
}

function lineEnding(content: string): CanonicalSpecification['lineEnding'] {
  const hasCrLf = /\r\n/u.test(content);
  const withoutCrLf = content.replace(/\r\n/gu, '');
  const hasLf = /\n/u.test(withoutCrLf);
  const hasCr = /\r/u.test(withoutCrLf);
  if (!hasCrLf && !hasLf && !hasCr) return 'none';
  if (hasCrLf && !hasLf && !hasCr) return 'crlf';
  if (!hasCrLf && hasLf && !hasCr) return 'lf';
  return 'mixed';
}
