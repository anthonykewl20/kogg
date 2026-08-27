import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { injectable } from '@theia/core/shared/inversify';

// Contexts are identity-checked backend objects. JSON-RPC serialization cannot forge one.
// The future first-party HTTP controller must mint them only after authentication, origin, CSRF, and role checks.
// diagnostic-coverage: interaction-modes.transitions
export interface VerifiedModeActorV1 {
  readonly sessionId: string;
  readonly actorAuthorityDigest: string;
  readonly role: 'owner';
  readonly originVerified: true;
  readonly csrfVerified: true;
}

export interface ModeTransitionContextV1 {
  readonly scopeDigest: string;
}
interface IssuedModeActorV1 { readonly sessionId: string; readonly actorAuthorityDigest: string; readonly role: 'owner'; }

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

@injectable()
export class ModeTransitionAuthority {
  private readonly issued = new WeakMap<object, IssuedModeActorV1 & { readonly scopeDigest: string }>();

  mint(actor: VerifiedModeActorV1, scopeDigest: string): ModeTransitionContextV1 {
    if (!SESSION.test(actor.sessionId) || !DIGEST.test(actor.actorAuthorityDigest) || !DIGEST.test(scopeDigest)
      || actor.role !== 'owner' || actor.originVerified !== true || actor.csrfVerified !== true) {
      console.warn('[kogg:interaction-modes:transition-authority] authority.mint.refused', { safeCode: 'MODE_AUTHORITY_REFUSED' });
      throw new Error('MODE_AUTHORITY_REFUSED');
    }
    return this.issue(actor, scopeDigest, 'browser');
  }

  mintDesktop(scopeDigest: string): ModeTransitionContextV1 {
    if (!DIGEST.test(scopeDigest)) {
      console.warn('[kogg:interaction-modes:transition-authority] authority.mint.refused', { channel: 'electron', safeCode: 'MODE_AUTHORITY_REFUSED' });
      throw new Error('MODE_AUTHORITY_REFUSED');
    }
    return this.issue({ sessionId: `electron:${randomUUID()}`, actorAuthorityDigest: `sha256:${randomBytes(32).toString('hex')}`, role: 'owner' }, scopeDigest, 'electron');
  }

  verify(context: ModeTransitionContextV1, scopeDigest: string): IssuedModeActorV1 | undefined {
    if (!context || typeof context !== 'object') return undefined;
    const issued = this.issued.get(context as object);
    if (!issued || issued.scopeDigest !== scopeDigest) return undefined;
    return issued;
  }

  private issue(actor: IssuedModeActorV1, scopeDigest: string, channel: 'browser' | 'electron'): ModeTransitionContextV1 {
    const context = Object.freeze({ scopeDigest }); this.issued.set(context, { ...actor, scopeDigest });
    console.info('[kogg:interaction-modes:transition-authority] authority.mint.completed', { channel, role: actor.role }); return context;
  }
}

export function transitionScopeDigest(domain: 'request' | 'cancel', value: unknown): string {
  return `sha256:${createHash('sha256').update(`kogg:interaction-modes:transition-${domain}:v1\0${JSON.stringify(value)}`).digest('hex')}`;
}
