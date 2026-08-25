/**
 * T-035 — constants shared by the DTOs, the service and the tests.
 *
 * Column widths are transcribed from `reward_portal.portal_users` (01-DATABASE.md §2.1):
 * `email varchar(200)` (the DTO-level input bound; the stored column is wider to hold the
 * ciphertext envelope — see `portal-user.model.ts`'s own comment), `display_name varchar(100)`,
 * `status varchar(20) check (status in ('pending_activation','active','inactive','locked',
 * 'suspended'))`.
 */

/** `role_entity_permissions.entity` for user rows (01-DATABASE.md §5.1, T004_001 seed). */
export const USER_ENTITY = 'user';

export const USER_EMAIL_MAX_LENGTH = 200;
export const USER_DISPLAY_NAME_MAX_LENGTH = 100;

/** `ck_portal_users_status`. */
export const USER_STATUSES = [
  'pending_activation',
  'active',
  'inactive',
  'locked',
  'suspended',
] as const;
export type UserStatusValue = (typeof USER_STATUSES)[number];

/** The one status `SessionValidGuard`/`CredentialService` treat as usable
 * (`credential.service.ts`'s own `ACTIVE_USER_STATUS`, outside this task's file scope to
 * import — `back-end/src/modules/auth/**`, AGENT-PROTOCOL R9 — so this is this module's own
 * literal copy of the same value). */
export const USER_ACTIVE_STATUS = 'active';
export const USER_INACTIVE_STATUS = 'inactive';

export const DEFAULT_PAGE_SIZE = 20;
/** 03-API-CONTRACT.md §1 — "`pageSize` capped at 100". */
export const MAX_PAGE_SIZE = 100;

/** BACKLOG.md B-01 / T-030's own precedent, restated for `/users` (see this module's own
 * `users.service.ts` header for why `POST /users` returns one at all): 24 characters from a
 * CSPRNG. */
export const TEMPORARY_PASSWORD_LENGTH = 24;

/** T-046 implementation note 5 / BACKLOG.md B-01: "time-boxed — if unchanged within 72 hours the
 * credential expires and must be reissued." Written to `portal_user_credentials.password_expires_at`
 * by `TemporaryPasswordService` on every issuance (create and reset alike). */
export const TEMPORARY_PASSWORD_TTL_HOURS = 72;
export const TEMPORARY_PASSWORD_TTL_MS = TEMPORARY_PASSWORD_TTL_HOURS * 60 * 60 * 1000;

/** T-046 implementation note 7: "20 generations per admin per hour. A compromised admin account
 * should not be able to mint credentials for an entire tenant unnoticed." Keyed per actor, shared
 * across `create()` and `resetPassword()` — both mint a credential, so both draw from the one
 * budget (`temporary-password.service.ts`). */
export const TEMPORARY_PASSWORD_RATE_LIMIT_PER_HOUR = 20;
export const TEMPORARY_PASSWORD_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** T-046 implementation note 6: "audit `temporary_password_issued` with actor, target user and
 * time — never the value." Written once per issuance by `TemporaryPasswordService`, in addition
 * to (not instead of) the request-level `user_created`/`user_password_reset` events the
 * `@Audit()` decorator already records for those two routes — the same "request row plus
 * disclosure row" split `reveal.controller.ts`/`reveal.service.ts` (T-017) establish for
 * `pii_reveal_request`/`pii_revealed`. */
export const TEMPORARY_PASSWORD_ISSUED_AUDIT_EVENT = 'temporary_password_issued';

/** `session.constants.ts`'s `REVOCATION_REASON`/audit-event vocabulary has no user-deactivation
 * or password-reset entries of its own (that file is `back-end/src/modules/auth/**`, outside
 * this task's file scope — AGENT-PROTOCOL R9) — these are this module's own literals, passed
 * through as plain strings to `SessionService.revokeAllForUser`, which accepts any string
 * reason/event, the same pattern `tenants.constants.ts` establishes for tenant suspension. */
export const USER_DEACTIVATION_SESSION_REVOCATION_REASON = 'user_deactivated';
export const USER_DEACTIVATION_AUDIT_EVENT = 'user_deactivated';
export const USER_PASSWORD_RESET_SESSION_REVOCATION_REASON = 'user_password_reset';
export const USER_PASSWORD_RESET_AUDIT_EVENT = 'user_password_reset';
