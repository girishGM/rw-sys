/**
 * T-011 — the response bodies `/auth/*` returns, and the only shapes it may return.
 *
 * ### The property T-011 TC-26 asserts, and how this file guarantees it
 *
 * *No auth response contains a hash, a secret, a token or a password at any depth.*
 * 02-SECURITY.md §6 requires a snapshot test proving it; `auth.e2e-spec.ts` walks every response
 * body recursively and fails on any key matching `/hash|secret|token|password/i`.
 *
 * The guarantee comes from construction, not from filtering: every field of every type below is
 * declared here by hand, and the mapping functions build a fresh literal rather than spreading a
 * database row. No entity, model instance or repository row is ever returned directly — which is
 * how `password_hash`, `token_hash` and `mfa_secret_enc` escape systems that return entities and
 * then remember to exclude things.
 *
 * ### The one allowed exception, and why it is not a hole
 *
 * `mustChangePassword` matches that regex. It is required by T-011 TC-5 ("only
 * `mustChangePassword` and `role`") and by 02-SECURITY.md §2's own description of the login
 * response, so TC-5 and TC-26 as literally written cannot both hold. The resolution — recorded
 * as a spec conflict in the completion report — is that TC-26's intent is *secret material*, and
 * a boolean flag is not secret material: it tells the SPA which screen to render and is already
 * knowable to the user it describes. The e2e assertion therefore allows exactly this one key,
 * by name, **and additionally asserts its value is a boolean**, so a future refactor cannot
 * smuggle a string through the exemption.
 */
import type { PortalRole } from '@/database/portal-models';
import type { SessionSummary } from '../services/session.service';

/**
 * The success envelope from 03-API-CONTRACT.md §1: `{ "data": … }`.
 *
 * Applied explicitly by the controller rather than by a global interceptor, because no task in
 * the plan owns such an interceptor. Flagged in the completion report: if one is ever added, it
 * must skip these routes or it will double-wrap them.
 */
export interface DataEnvelope<T> {
  readonly data: T;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

/**
 * `POST /auth/login` and `POST /auth/refresh`.
 *
 * **Carries no token of any kind.** All three tokens travel in `Set-Cookie` headers and none of
 * them is readable by JavaScript except the CSRF value, which is why the body has nothing to
 * say (T-011 TC-5). A body that echoed the access token would defeat the entire httpOnly design
 * in one line.
 */
export class LoginResponseDto {
  readonly role!: PortalRole;
  readonly mustChangePassword!: boolean;
  /**
   * `true` when a second factor is still outstanding, in which case **no session was created**
   * and no cookie was set (02-SECURITY.md §2a). Always `false` in T-011, which ships the
   * extension point rather than the factor — see `step-up.hook.ts`. Present from the start so
   * the SPA's contract does not change when T-055 lands.
   */
  readonly mfaRequired!: boolean;
}

export function toLoginResponse(input: {
  role: PortalRole;
  mustChangePassword: boolean;
  mfaRequired: boolean;
}): LoginResponseDto {
  return {
    role: input.role,
    mustChangePassword: input.mustChangePassword,
    mfaRequired: input.mfaRequired,
  };
}

/**
 * One row of `GET /auth/sessions` (T-011 TC-24).
 *
 * Note what is *not* here: `token_hash` (never selected by the repository in the first place),
 * `user_id` (the caller knows who they are, and echoing it invites a client to start sending it
 * back), `revoked_reason` and `status` (every row returned is active by construction).
 *
 * `current` is what lets the UI say "this device" without the client having to know its own
 * session id — which it cannot, because the id lives in an httpOnly cookie.
 */
export class SessionResponseDto {
  readonly id!: string;
  readonly ipAddress!: string | null;
  readonly userAgent!: string | null;
  readonly issuedAt!: string;
  readonly lastSeenAt!: string;
  readonly expiresAt!: string;
  readonly current!: boolean;
}

export function toSessionResponse(session: SessionSummary): SessionResponseDto {
  return {
    id: session.id,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    issuedAt: session.issuedAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    current: session.current,
  };
}
