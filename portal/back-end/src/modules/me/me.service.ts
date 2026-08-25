/**
 * T-015 — the caller's own `portal_users` row: reading it, and the three fields of it that the
 * caller may change.
 *
 * ### Why this goes through `ScopedRepository` when "own row" would seem to need no scope
 *
 * AGENT-PROTOCOL R2 admits no exceptions, and this is a case where following it costs nothing and
 * buys a second predicate. Every query below is additionally constrained to
 * `id = <the JWT's userId>`, so the scope clause `ScopedRepository` adds — `country_id = …` for a
 * `country_admin`, `tenant_id = …` for a maker, `tenant_id = … AND merchant_id = …` for a merchant
 * (see `scope-strategy.ts`'s `PortalUser` entry) — is redundant *while the code is correct*. It
 * stops being redundant the moment a future edit passes a different id: `PATCH /me` cannot become
 * `PATCH /users/:id` by accident, because the WHERE clause would still pin the row to the caller's
 * own tenancy.
 *
 * The unscoped alternatives that exist elsewhere in this codebase — `CredentialRepository`,
 * `SessionRepository`, `PermissionRepository` — are all justified by running *before* the scope
 * context exists (guards, positions 5–8 of 00-ARCHITECTURE.md §6). `/me` is a controller at
 * position 10, well inside `TenancyScopeInterceptor`'s context, so none of that reasoning applies
 * and the plain rule does.
 *
 * ### Identity comes from the token, profile data from the row
 *
 * `role` and the scope triple are read from the **verified JWT** (R3), never from the row this
 * service loads. See `bootstrap-response.dto.ts` for the reasoning: the token's claims are what
 * the guards and the repository actually enforce for the life of that access token, so a response
 * that reported the row's newer role would describe a permission set the API would refuse to
 * honour. The row wins again at the next refresh, which re-derives the claims from it (AR-04).
 */
import { Injectable } from '@nestjs/common';
import { AuditService } from '@/common/audit/audit.service';
import { NotFoundError } from '@/common/errors/app-error';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { PortalUser } from '@/database/portal-models';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { BootstrapScopeDto, MeProfileDto } from './dto/bootstrap-response.dto';
import { UPDATE_ME_FIELDS, type UpdateMeDto } from './dto/me-request.dto';

/** The locale reported when the column is null. `portal_users.preferred_locale` defaults to it. */
export const DEFAULT_LOCALE = 'en';

@Injectable()
export class MeService {
  constructor(
    private readonly scoped: ScopedRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * The caller's own row, or a 404.
   *
   * A 404 here means the row vanished between the token being minted and this request — a user
   * hard-deleted, or soft-deleted while a session was live. `SessionValidGuard` already refuses
   * such a session, so reaching this is rare; answering "not found" rather than inventing an empty
   * profile is the only safe reading of it.
   *
   * Returns the model instance, deliberately **internal to this module**: nothing outside
   * {@link toProfile} and `BootstrapService` may hold it, and neither of them lets one reach a
   * response body. `PortalUser`'s default scope already excludes `mfa_secret_enc` (T-003
   * implementation note 5), which is the belt to this braces.
   *
   * `findByPkOrFail` rather than `findByPk` + a hand-written null check: T-013 added it so that
   * *"Wave 3 does not each write its own `if (row === null) throw` and get the status code wrong
   * once"*, and its `ScopeViolationError` is the same 404 `NOT_FOUND` this method would otherwise
   * construct. It is also, incidentally, one of the method names the `no-raw-model-access` rule
   * does not match — see `scoped.repository.ts`'s `listAll` for why that matters here.
   */
  async findSelf(actor: AuthenticatedUser): Promise<PortalUser> {
    return this.scoped.findByPkOrFail(PortalUser, actor.userId);
  }

  /** `GET /me`. */
  async getProfile(actor: AuthenticatedUser): Promise<MeProfileDto> {
    return toProfile(actor, await this.findSelf(actor));
  }

  /**
   * `PATCH /me` — the three whitelisted fields and nothing else.
   *
   * The values object is assembled key by key from {@link UPDATE_ME_FIELDS} rather than spread
   * from the DTO. `{ ...dto }` would be equivalent today and would silently start forwarding any
   * property a future edit added to `UpdateMeDto`; naming the three fields means a fourth has to
   * be added here, deliberately, by someone reading this comment.
   *
   * An empty patch is a legitimate no-op: it issues no UPDATE and returns the unchanged profile.
   * (The audit row is still written — the request happened, and a log that omits "user submitted
   * a profile form that changed nothing" is a log with a gap in it for no benefit.)
   */
  async updateProfile(actor: AuthenticatedUser, dto: UpdateMeDto): Promise<MeProfileDto> {
    const values: Partial<Record<(typeof UPDATE_ME_FIELDS)[number], string>> = {};
    for (const field of UPDATE_ME_FIELDS) {
      const value = dto[field];
      if (value !== undefined) values[field] = value;
    }

    const changed = Object.keys(values);

    // Field **names**, never values. `display_name` is personal data and the audit log is read by
    // support staff; who changed what and when is the question an audit trail exists to answer.
    this.audit.annotate({ targetId: actor.userId, detail: { fields: changed } });

    if (changed.length > 0) {
      const affected = await this.scoped.update(PortalUser, values, {
        where: { id: actor.userId },
      });
      // Zero rows means the caller's own row is gone or out of scope — the same condition
      // `findSelf` answers 404 for, and the same answer, so a `PATCH` cannot report success for a
      // write that did not happen.
      if (affected === 0) {
        throw new NotFoundError({
          logMessage: `PATCH /me updated 0 rows for user ${actor.userId}`,
          logContext: { userId: actor.userId, role: actor.role },
        });
      }
    }

    return this.getProfile(actor);
  }
}

/** The scope triple, always from the verified token (R3). */
export function scopeOf(actor: AuthenticatedUser): BootstrapScopeDto {
  return {
    countryId: actor.countryId,
    tenantId: actor.tenantId,
    merchantId: actor.merchantId,
  };
}

/**
 * Maps the row to the `GET /me` body. A fresh literal, never a spread of the model — see
 * `bootstrap-response.dto.ts`.
 *
 * `mustChangePassword` comes from `actor`, which `SessionValidGuard` refreshes from the database
 * on every request, rather than from `row.mustChangePassword`: the two agree, and taking the one
 * the guard chain is already acting on means the profile can never disagree with the confinement
 * the caller is actually under.
 */
export function toProfile(actor: AuthenticatedUser, row: PortalUser): MeProfileDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: actor.role,
    scope: scopeOf(actor),
    locale: row.preferredLocale ?? DEFAULT_LOCALE,
    timezone: row.preferredTimezone,
    status: row.status,
    mustChangePassword: actor.mustChangePassword,
    lastLoginAt: row.lastLoginAt === null ? null : row.lastLoginAt.toISOString(),
  };
}
