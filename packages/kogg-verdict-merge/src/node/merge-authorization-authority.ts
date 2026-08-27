import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BrowserMutationActorV1 } from '@kogg/core/lib/node/browser-auth-contribution';
import { injectable } from '@theia/core/shared/inversify';
import { canonicalJson } from '../common/verdict-merge-canonical';

// Identity-checked backend contexts cannot be forged through JSON-RPC serialization.
// diagnostic-coverage: merge.authorization
export interface MergeAuthorizationContextV1 { readonly scopeDigest: string; }
interface IssuedMergeActorV1 { readonly sessionId: string; readonly actorAuthorityDigest: string; readonly authorizerRoleDigest: string; }
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

@injectable()
export class MergeAuthorizationAuthority {
  private readonly issued = new WeakMap<object, IssuedMergeActorV1 & { readonly scopeDigest: string }>();

  mint(actor: BrowserMutationActorV1, scopeDigest: string): MergeAuthorizationContextV1 {
    if (!SESSION.test(actor.sessionId) || !DIGEST.test(actor.actorAuthorityDigest) || !DIGEST.test(scopeDigest)
      || actor.role !== 'owner' || actor.originVerified !== true || actor.csrfVerified !== true) {
      console.warn('[kogg:merge:authorization] authority.mint.refused', { safeCode: 'AUTHORIZATION_REQUIRED' });
      throw new Error('AUTHORIZATION_REQUIRED');
    }
    const context = Object.freeze({ scopeDigest });
    this.issued.set(context, { sessionId: actor.sessionId, actorAuthorityDigest: actor.actorAuthorityDigest, authorizerRoleDigest: roleDigest(actor.actorAuthorityDigest), scopeDigest });
    console.info('[kogg:merge:authorization] authority.mint.completed', { channel: 'browser', role: actor.role });
    return context;
  }

  verify(context: MergeAuthorizationContextV1, scopeDigest: string): IssuedMergeActorV1 | undefined {
    if (!context || typeof context !== 'object') return undefined;
    const issued = this.issued.get(context as object);
    return issued?.scopeDigest === scopeDigest ? issued : undefined;
  }
}

export function mergeAuthorizationScopeDigest(domain: 'challenge' | 'authorize' | 'execute', value: unknown): string {
  return `sha256:${createHash('sha256').update(`kogg:merge-authorization:${domain}:v1\0${canonicalJson(value)}`).digest('hex')}`;
}
export function mergeNonceDigest(): string { return `sha256:${createHash('sha256').update(randomBytes(32)).digest('hex')}`; }
export function mergeOpaqueId(): string { return randomUUID(); }
function roleDigest(actorAuthorityDigest: string): string { return `sha256:${createHash('sha256').update(`kogg:merge-authorizer-role:v1\0${actorAuthorityDigest}`).digest('hex')}`; }
