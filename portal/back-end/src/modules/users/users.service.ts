/**
 * T-035 — `/users`: delegated user creation across the whole hierarchy (03-API-CONTRACT.md §7),
 * high risk — **privilege escalation surface**.
 *
 * ### The creation matrix, and why it lives here rather than only in `role_entity_permissions`
 *
 * 1. **Permission layer** — `role_entity_permissions` grants `user:create` to `super_admin`,
 *    `country_admin` and `tenant_admin` only (T004_001 seed); `maker`/`checker`/`merchant` hold
 *    nothing for the `user` entity at all, so `@RequirePermission` on the controller already
 *    refuses those three outright.
 * 2. **Service layer** — {@link ALLOWED_CREATION} at the top of `create()`, independent of what
 *    the permission table says, exactly the T-030/T-031/T-034 precedent implementation note 1
 *    asks for: even if the table were edited to grant `maker` → `user:create`, this map still has
 *    no entry admitting it. A caller can never create a user **at or above their own level**
 *    (`super_admin` cannot even create another `super_admin` — T-004's bootstrap CLI is the only
 *    door for that, off the network surface entirely) **or outside their own scope** — the second
 *    half is {@link deriveTargetScope} below, not the matrix, and both are mandatory (TC-2, TC-3,
 *    TC-5, TC-6, TC-8, TC-9, TC-10, TC-12 — the six escalation tests this task's own file names as
 *    mandatory, TC-13 for the scope half).
 * 3. **Data layer** — `ck_portal_users_scope` (01-DATABASE.md §2.1) makes an incorrectly-scoped
 *    row physically unstorable even if both layers above were wrong.
 *
 * ### `deriveTargetScope` — the table AGENT-PROTOCOL R3 requires, made explicit
 *
 * R3: *"`tenantId`, `countryId`, `merchantId` and `role` come from the verified JWT only. If a
 * DTO contains one of these, that is a bug."* That sentence is about the **actor's own** scope,
 * never about the **target's** — and for `POST /users` those are not the same axis, because the
 * actor is always creating a user one level *below* themselves:
 *
 * | Actor (from JWT)              | Target role     | `countryId`            | `tenantId`             | `merchantId`         |
 * |---|---|---|---|---|
 * | `super_admin`                 | `country_admin`  | **from `dto`**, existence-checked | `null`                 | `null`                |
 * | `country_admin` (`countryId`) | `tenant_admin`   | actor's own            | **from `dto`**, scope-checked against actor's country | `null` |
 * | `tenant_admin` (`countryId`,`tenantId`) | `maker`/`checker` | actor's own  | actor's own            | `null`                |
 * | `tenant_admin` (`countryId`,`tenantId`) | `merchant`        | actor's own  | actor's own            | **from `dto`**, scope-checked against actor's tenant |
 *
 * The "from `dto`" cells are never trusted at face value: each is re-verified with a *scoped*
 * lookup (`this.scoped.findByPkOrFail(Country|Tenant|Merchant, …)`, run as the actor) before it is
 * used, so a `country_admin` who sends a `tenantId` belonging to another country 404s rather than
 * onboarding a Tenant Admin outside its own country (TC-13's Merchant equivalent for
 * `tenant_admin`/`merchant`). Every other cell is taken from `actor`, never from `dto`, no matter
 * what the body says (TC-11) — `CreateUserDto` declares all three ids purely so
 * `forbidNonWhitelisted` does not itself reject a legitimate caller's body (see that file's own
 * header).
 *
 * ### T-046 folds in expiry, rate limiting and the formal audit event
 *
 * `create()` and `resetPassword()` below now go through `TemporaryPasswordService` (T-046) for
 * generation rather than calling `generateTemporaryPassword` directly: the rate-limit charge
 * (implementation note 7) has to happen before either method starts writing anything, so it runs
 * first and outside the transaction — a throttled admin should leave no partial row behind. The
 * `temporary_password_issued` audit row (implementation note 6) is written after the surrounding
 * transaction commits, mirroring `resetPassword()`'s own pre-existing "session revocation after
 * commit" shape, so a request that rolled back never produces an audit row asserting it succeeded.
 *
 * ### Why `POST /users` returns a temporary password, contradicting this task's own file text
 *
 * `T-035-user-management.md` implementation note 4 and TC-16/TC-24, and 03-API-CONTRACT.md §7's
 * one-line summary, describe a `pending_activation` status plus an activation/reset **link**, and
 * say the API "never returns a generated password". That is superseded, in writing, by three
 * independent, more specific and more recent sources, and AGENT-PROTOCOL §3 is explicit that a
 * design doc wins a conflict with a task file:
 *
 *  1. **BACKLOG.md B-01** — the actual product decision, dated 2026-08-14, titled "no email in
 *     v1", stating outright: *"On user creation the temporary password is shown once on
 *     screen … On reset, the new password is shown once on screen."* It names this task and
 *     T-046 by id as the two that implement it.
 *  2. **07-DATA-PROTECTION.md §5** encodes the same decision as a concrete route override —
 *     `"POST /users": "full", // returns a temporary password` — and `config/data-protection.json`
 *     (T-017, already `done`, already live) ships that exact line today. A route override that
 *     exists specifically because the route returns a temporary password is not compatible with a
 *     reading where it does not.
 *  3. **Precedent already reviewed and `done`** — `POST /countries/:id/admins` (T-030) and
 *     `POST /tenants/:id/admins` (T-034), the two links directly above this one in the same
 *     delegation chain, already ship exactly this shape (`status: 'active'` immediately,
 *     `mustChangePassword: true`, a generated password returned once). There is no activation-link
 *     mechanism anywhere in this codebase (no endpoint consumes a token to flip
 *     `pending_activation` → `active`) for this task to plug into even if it wanted to, and
 *     building one would reach into `back-end/src/modules/auth/**`, outside this task's file
 *     scope (AGENT-PROTOCOL R9).
 *
 * This task therefore creates every new user `status: 'active'` (not `'pending_activation'`,
 * which `CredentialService`'s `ACTIVE_USER_STATUS` check would leave permanently unable to log
 * in — there being no code path anywhere that ever moves a row out of it) with
 * `mustChangePassword: true`, and returns the generated password once, exactly as T-030/T-034
 * already do. TC-16/TC-24 are read as "no password **hash**, no activation token" — genuinely true
 * here — rather than literally "no password field at all", which nothing in this codebase's
 * actually-shipped behaviour satisfies. Flagged for the reviewer per AGENT-PROTOCOL §3 and §7, and
 * restated in the completion report.
 *
 * ### T-088 / finding F-12 — the same role floor, extended to acting on an existing user
 *
 * `create()` has always been floored twice, independent of `role_entity_permissions`: the
 * permission layer, then {@link ALLOWED_CREATION} in the service. `update()`, `deactivate()` and
 * `resetPassword()` had only the first — a scope check (layer 3) but no service-layer *role*
 * check (layer 1) at all. `role_entity_permissions` currently grants `user:update` only to
 * `super_admin`/`country_admin`/`tenant_admin`, each the top of its own scope, so this was not
 * exploitable in the shipped configuration — but 02-SECURITY.md §5's promise is that "a mistake
 * in one [layer] must not become an exploit", and one wrong row (editable at runtime through the
 * Access Control screen, T-033) was enough to hand an over-granted `maker` full control of its
 * own `tenant_admin`: rename it, deactivate it, or reset its password and receive the new
 * password in the response body — a full account takeover, since layer 3 does not separate a
 * `maker` from its own `tenant_admin` (both are scoped by `tenant_id` alone,
 * `scope-strategy.ts`). Measured end to end in
 * `back-end/test/security/layer-two-exposure.e2e-spec.ts`.
 *
 * {@link assertManagementAllowed} closes it by reusing {@link ALLOWED_CREATION} as the floor for
 * *acting on* an existing user, not only for creating a new one: an actor may only mutate a user
 * whose role it could itself have created. This is deliberately the same table, not a second,
 * looser one — a `tenant_admin` cannot create another `tenant_admin` (implementation note 1), so
 * it must not be able to rename, deactivate or reset-password one either, whether that peer is a
 * stranger or itself. Self-targeting `update`/`resetPassword` is therefore refused by the same
 * check (no role is ever adjacent to itself in the matrix) — intentionally: own-profile changes
 * go through `PATCH /me` (T-015), and an admin resetting their *own* password belongs to the
 * self-service change-password flow (T-010), neither of which this route was ever the door for.
 * `deactivate()`'s pre-existing self-check (implementation note 6, TC-23) already covered that one
 * case with a clearer 422; the new check is a second, independent reason self-deactivation would
 * fail even if the first were ever removed.
 *
 * ### A real bug this task's implementation does **not** repeat — flagged, not fixed, elsewhere
 *
 * `PortalUserCredential`'s declared scope strategy (`scope-strategy.ts`) is `deny()` on every
 * axis, deliberately: *"Reached only by `CredentialRepository`'s own parameterised SQL, never
 * through a scoped query."* `ScopedRepository.create()` refuses (`ScopeViolationError`, 404) any
 * write to a denied model for any role but `super_admin`. T-030's `provisionCountryAdmin` and
 * T-034's `provisionTenantAdmin` — both already reviewed and `done` — call
 * `this.scoped.create(PortalUserCredential, …)` directly, from a `country_admin` actor in one
 * case, and would throw at runtime for exactly that reason (confirmed by exercising the real,
 * compiled `isDenied()` against both roles, not inferred from reading the map). Their own unit
 * tests never catch it because `FakeScopedRepository` is a full stand-in that never calls the real
 * `scope-strategy.ts` logic. This task's `insertCredential()` below does **not** use
 * `ScopedRepository` for this table at all — it is raw, parameterised SQL through the injected
 * `Sequelize` instance, the same technique `credential.repository.ts` itself uses for this exact
 * table, and the only technique the model's own scope strategy actually sanctions for it. This is
 * outside this task's file scope to fix in T-030/T-034 (`back-end/src/modules/countries/**` /
 * `back-end/src/modules/tenants/**`, AGENT-PROTOCOL R9) — flagged for the architect per §7 rather
 * than silently patched.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes, UniqueConstraintError, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { Country, Merchant, Tenant } from '@/database/models';
import { PortalUser, type PortalRole } from '@/database/portal-models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { AuditService } from '@/common/audit/audit.service';
import { CredentialService } from '@/modules/auth/services/credential.service';
import { SessionService, type RequestContext } from '@/modules/auth/services/session.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { TemporaryPasswordService } from './services/temporary-password.service';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  USER_ACTIVE_STATUS,
  USER_DEACTIVATION_AUDIT_EVENT,
  USER_DEACTIVATION_SESSION_REVOCATION_REASON,
  USER_INACTIVE_STATUS,
  USER_PASSWORD_RESET_AUDIT_EVENT,
  USER_PASSWORD_RESET_SESSION_REVOCATION_REASON,
} from './users.constants';
import {
  CannotDeactivateSelfError,
  RoleChangeNotPermittedError,
  RoleCreationNotPermittedError,
  RoleManagementNotPermittedError,
  UserEmailExistsError,
  targetScopeIdRequiredError,
} from './users.errors';
import type { CreateUserDto } from './dto/create-user.dto';
import type { UserSortField, ListUsersQueryDto } from './dto/list-users-query.dto';
import type { UpdateUserDto } from './dto/update-user.dto';
import { toUserDto, type ListMeta, type UserDto } from './dto/user-response.dto';
import {
  toUserCreatedResponseDto,
  type UserCreatedResponseDto,
} from './dto/user-created-response.dto';

const SORT_COLUMN: Readonly<Record<UserSortField, string>> = Object.freeze({
  displayName: 'displayName',
  email: 'email',
  role: 'role',
  status: 'status',
  createdAt: 'createdAt',
});

/**
 * The role-creation matrix (03-API-CONTRACT.md §7, this task's implementation note 1). The one
 * table every escalation test in this file checks against. `super_admin` cannot create another
 * `super_admin` — the bootstrap CLI (T-004) is the only door for that, off the API surface.
 */
const ALLOWED_CREATION: Readonly<Record<PortalRole, readonly PortalRole[]>> = Object.freeze({
  super_admin: ['country_admin'],
  country_admin: ['tenant_admin'],
  tenant_admin: ['maker', 'checker', 'merchant'],
  maker: [],
  checker: [],
  merchant: [],
});

/** The scope triple a new `portal_users` row must carry, matching `ck_portal_users_scope`
 * exactly for the target role. */
interface TargetScope {
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly credentials: CredentialService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly temporaryPasswords: TemporaryPasswordService,
  ) {}

  // --- reads -----------------------------------------------------------------------------

  /**
   * Scope alone decides visibility (`PortalUser`'s declared strategy in `scope-strategy.ts`):
   * `super_admin` sees every user, `country_admin` its own country's (TC-18), `tenant_admin`/
   * `maker`/`checker` its own tenant's (TC-17), and a `merchant` user only its own merchant's —
   * no branch here tells the roles apart.
   */
  async list(query: ListUsersQueryDto): Promise<{ rows: UserDto[]; meta: ListMeta }> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const [field, direction] = parseSort(query.sort);

    const rows = await this.scoped.listAll(PortalUser, {
      order: [[SORT_COLUMN[field], direction.toUpperCase()]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const total = await this.scoped.count(PortalUser, {});

    return { rows: rows.map(toUserDto), meta: { page, pageSize, total } };
  }

  /** `findByPkOrFail` 404s for a row out of the actor's scope — indistinguishable from "does not
   * exist" (TC-19, 02-SECURITY.md §5.1). */
  async getById(id: number): Promise<UserDto> {
    const user = await this.scoped.findByPkOrFail(PortalUser, id);
    return toUserDto(user);
  }

  // --- writes ------------------------------------------------------------------------------

  /**
   * `POST /users`. See this file's own header for the full escalation-matrix argument and for
   * why a temporary password is returned once.
   */
  async create(actor: AuthenticatedUser, dto: CreateUserDto): Promise<UserCreatedResponseDto> {
    assertCreationAllowed(actor.role, dto.role);

    // Charged before the transaction opens (T-046 implementation note 7): a throttled admin
    // should leave no partial `portal_users` row behind.
    const issued = await this.temporaryPasswords.generate(actor);

    const user = await this.sequelize.transaction(async (transaction) => {
      const targetScope = await this.deriveTargetScope(actor, dto, transaction);

      const passwordHash = await this.credentials.hash(issued.password);

      let created: PortalUser;
      try {
        // `as never` — the same `sequelize-typescript`/`CreationAttributes<M>` escape hatch
        // `tenants.service.ts#insertTenant`'s comment documents at length.
        created = await this.scoped.create(
          PortalUser,
          {
            email: dto.email.trim(),
            displayName: dto.displayName.trim(),
            role: dto.role,
            countryId: targetScope.countryId,
            tenantId: targetScope.tenantId,
            merchantId: targetScope.merchantId,
            // `active`, not the model's `pending_activation` default — see this file's own
            // header for why. `mustChangePassword` is what actually confines the account.
            status: USER_ACTIVE_STATUS,
            mustChangePassword: true,
            createdBy: actor.userId,
          } as never,
          { transaction },
        );
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          throw new UserEmailExistsError({ cause: error });
        }
        throw error;
      }

      await this.insertCredential(created.id, passwordHash, issued.expiresAt, transaction);

      // T-101: `created` is `scoped.create()`'s raw post-INSERT return value. `afterFind` is the
      // only hook that decrypts `email` (`model-encryption.hooks.ts`'s own header) and INSERT
      // never fires it — `afterCreate` only re-binds the AAD, it does not decrypt — so returning
      // `created` as-is hands the caller `portal_users.email`'s raw ciphertext envelope instead of
      // the typed address. Reload through the scoped repository, the same fix `resetPassword()`
      // below (and `update()`/`deactivate()`) already apply for exactly this reason, so the
      // instance handed to `toUserCreatedResponseDto` has been through `afterFind` at least once.
      const reloaded = await this.scoped.findByPkOrFail(PortalUser, created.id, { transaction });

      this.audit.annotate({ targetId: created.id });
      return reloaded;
    });

    // After commit (T-046 implementation note 6) — see this file's own header.
    await this.temporaryPasswords.recordIssued(actor, user.id);

    return toUserCreatedResponseDto(user, issued.password);
  }

  /**
   * `PATCH /users/:id`. `displayName` is the only field this route ever writes. A `role` field
   * on the body is refused outright — every value, not only an escalating one (TC-28 is the
   * mandatory case; this task's own risk flag is why no role transition is permitted through
   * this route in v1 at all, rather than trying to re-derive and re-validate the whole scope
   * triple for an arbitrary reassignment, which is a materially bigger design surface than "add
   * a user" and is not in this task's stated scope).
   *
   * T-088/F-12: `assertManagementAllowed` runs once the target row is in hand (it needs the
   * target's actual role, which the body never carries) and before any write — see this file's
   * own header for why it uses the same table `create()` does.
   */
  async update(actor: AuthenticatedUser, id: number, dto: UpdateUserDto): Promise<UserDto> {
    if (dto.role !== undefined) throw new RoleChangeNotPermittedError();

    return this.sequelize.transaction(async (transaction) => {
      const user = await this.scoped.findByPkOrFail(PortalUser, id, { transaction });
      assertManagementAllowed(actor.role, user.role);

      const changes: Record<string, unknown> = {};
      if (dto.displayName !== undefined) changes['displayName'] = dto.displayName.trim();

      if (Object.keys(changes).length > 0) {
        await this.scoped.update(PortalUser, changes, { where: { id }, transaction });
      }

      const updated = await this.scoped.findByPkOrFail(PortalUser, id, { transaction });
      this.audit.annotate({ targetId: id, detail: { fields: Object.keys(changes) } });
      return toUserDto(updated);
    });
  }

  /**
   * `POST /users/:id/deactivate`. Implementation note 5/6: blocks the account and revokes every
   * live session immediately (TC-21), and refuses outright when the target is the caller
   * themselves (TC-23) — "an admin cannot accidentally orphan a tenant."
   *
   * Session revocation runs **after** the status-change transaction commits, the same
   * `tenants.service.ts#update`/`revokeSessionsForTenant` shape: `SessionService.revokeAllForUser`
   * opens its own transaction and `back-end/src/modules/auth/**` is outside this task's file
   * scope to change, so it cannot literally share this one.
   *
   * T-088/F-12: `assertManagementAllowed` runs immediately after the target row is fetched and
   * before the status write — see this file's own header.
   */
  async deactivate(
    actor: AuthenticatedUser,
    id: number,
    context: RequestContext,
  ): Promise<UserDto> {
    if (actor.userId === id) throw new CannotDeactivateSelfError();

    const updated = await this.sequelize.transaction(async (transaction) => {
      const user = await this.scoped.findByPkOrFail(PortalUser, id, { transaction });
      assertManagementAllowed(actor.role, user.role);
      await this.scoped.update(PortalUser, { status: USER_INACTIVE_STATUS } as never, {
        where: { id },
        transaction,
      });

      const reloaded = await this.scoped.findByPkOrFail(PortalUser, id, { transaction });
      this.audit.annotate({ targetId: id, detail: { status: USER_INACTIVE_STATUS } });
      return toUserDto(reloaded);
    });

    await this.sessions.revokeAllForUser(
      id,
      USER_DEACTIVATION_SESSION_REVOCATION_REASON,
      null,
      { userId: actor.userId, role: actor.role },
      context,
      USER_DEACTIVATION_AUDIT_EVENT,
    );

    return updated;
  }

  /**
   * `POST /users/:id/reset-password`. Implementation note 7, as revised by this file's own
   * header: issues a **new generated password**, shown once, exactly like `create()` — never an
   * admin-chosen one (an admin-chosen password is guessable and reused across users) — and
   * revokes every one of the target's live sessions, so a credential reset actually invalidates
   * whatever an attacker was holding rather than leaving it valid alongside the new one.
   *
   * Reuses `CredentialService.changePassword()` (T-010) rather than writing a second
   * hash-and-replace path: that method's own `ChangePasswordInput.currentPassword` doc comment
   * names this exact case — *"an admin-driven or reset-token-driven change legitimately has no
   * current password to offer"* — so `currentPassword` is omitted here and the policy/history
   * checks T-010 already built run unchanged.
   *
   * T-088/F-12, the most severe of the three (finding F-12's own headline case): the temporary-
   * password quota is still charged before the target's role is known (implementation note 7's
   * "no partial row" reasoning is about a throttled admin, not about this check), the same order
   * the pre-existing scope 404 already followed — `assertManagementAllowed` runs immediately
   * after the target row is fetched and before `changePassword()` ever touches the credential.
   */
  async resetPassword(
    actor: AuthenticatedUser,
    id: number,
    context: RequestContext,
  ): Promise<UserCreatedResponseDto> {
    // Charged before the transaction opens — same reasoning as `create()`.
    const issued = await this.temporaryPasswords.generate(actor);

    const updated = await this.sequelize.transaction(async (transaction) => {
      const user = await this.scoped.findByPkOrFail(PortalUser, id, { transaction });
      assertManagementAllowed(actor.role, user.role);

      await this.credentials.changePassword(
        { userId: user.id, newPassword: issued.password, email: user.email },
        transaction,
      );
      // `changePassword()` (T-010) never touches `password_expires_at` — see
      // `temporary-password.service.ts#setCredentialExpiry`'s own header for why this is a
      // second, explicit statement rather than a gap in that method.
      await this.temporaryPasswords.setCredentialExpiry(user.id, issued.expiresAt, transaction);
      await this.scoped.update(PortalUser, { mustChangePassword: true } as never, {
        where: { id },
        transaction,
      });

      const reloaded = await this.scoped.findByPkOrFail(PortalUser, id, { transaction });
      this.audit.annotate({ targetId: id });
      return reloaded;
    });

    // After commit, same order `create()` now follows: the disclosure audit row first, then the
    // pre-existing session-revocation call this method already made.
    await this.temporaryPasswords.recordIssued(actor, id);

    await this.sessions.revokeAllForUser(
      id,
      USER_PASSWORD_RESET_SESSION_REVOCATION_REASON,
      null,
      { userId: actor.userId, role: actor.role },
      context,
      USER_PASSWORD_RESET_AUDIT_EVENT,
    );

    return toUserCreatedResponseDto(updated, issued.password);
  }

  // --- private helpers -----------------------------------------------------------------------

  /**
   * The table in this file's own header, made executable. Every "from `dto`" cell is
   * re-verified with a scoped lookup, run as `actor`, before it is trusted — that is what turns
   * TC-13 (a cross-tenant `merchantId`) into a 404 rather than a mis-scoped insert.
   */
  private async deriveTargetScope(
    actor: AuthenticatedUser,
    dto: CreateUserDto,
    transaction: Transaction,
  ): Promise<TargetScope> {
    switch (actor.role) {
      case 'super_admin': {
        if (dto.countryId === undefined) throw targetScopeIdRequiredError('countryId');
        await this.scoped.findByPkOrFail(Country, dto.countryId, { transaction });
        return { countryId: dto.countryId, tenantId: null, merchantId: null };
      }

      case 'country_admin': {
        if (dto.tenantId === undefined) throw targetScopeIdRequiredError('tenantId');
        // Scoped as `country_admin`: `Tenant`'s strategy restricts this to tenants in the
        // actor's own country, so a cross-country id 404s here (TC-13's equivalent one link up).
        await this.scoped.findByPkOrFail(Tenant, dto.tenantId, { transaction });
        return { countryId: actor.countryId, tenantId: dto.tenantId, merchantId: null };
      }

      case 'tenant_admin': {
        if (dto.role !== 'merchant') {
          return { countryId: actor.countryId, tenantId: actor.tenantId, merchantId: null };
        }
        if (dto.merchantId === undefined) throw targetScopeIdRequiredError('merchantId');
        // Scoped as `tenant_admin`: `Merchant`'s strategy restricts this to merchants in the
        // actor's own tenant, so a cross-tenant id 404s here (TC-13).
        await this.scoped.findByPkOrFail(Merchant, dto.merchantId, { transaction });
        return { countryId: actor.countryId, tenantId: actor.tenantId, merchantId: dto.merchantId };
      }

      // `maker`/`checker`/`merchant` never reach here — `ALLOWED_CREATION` for all three is
      // empty, so `assertCreationAllowed` has already thrown by the time this method runs. This
      // branch exists only so the switch is exhaustive over `PortalRole` rather than relying on
      // that staying true forever.
      default:
        throw new RoleCreationNotPermittedError();
    }
  }

  /**
   * Raw, parameterised SQL — deliberately **not** `ScopedRepository`. See this file's own header
   * ("A real bug this task's implementation does not repeat") for why: `PortalUserCredential`'s
   * declared scope strategy denies every role, and `ScopedRepository.create()` would throw for
   * any actor but `super_admin`. This mirrors `credential.repository.ts`'s own technique for the
   * same table — the one door its scope strategy's own comment names.
   */
  private async insertCredential(
    userId: number,
    passwordHash: string,
    passwordExpiresAt: Date,
    transaction: Transaction,
  ): Promise<void> {
    await this.sequelize.query(
      `
      INSERT INTO reward_portal.portal_user_credentials
             (user_id, password_hash, password_algo, password_expires_at,
              password_updated_at, created_at, updated_at)
      VALUES (:userId, :passwordHash, 'argon2id', :passwordExpiresAt, now(), now(), now())
      `,
      {
        type: QueryTypes.INSERT,
        transaction,
        replacements: { userId, passwordHash, passwordExpiresAt },
      },
    );
  }
}

// --- module-private helpers --------------------------------------------------------------------

/** {@link ALLOWED_CREATION}, thrown rather than returned — see the file header. */
function assertCreationAllowed(actorRole: PortalRole, targetRole: PortalRole): void {
  if (!ALLOWED_CREATION[actorRole].includes(targetRole)) {
    throw new RoleCreationNotPermittedError();
  }
}

/**
 * T-088/F-12 — the same {@link ALLOWED_CREATION} table, reused as the floor for *acting on* an
 * already-existing user (`update`, `deactivate`, `resetPassword`) rather than only for creating
 * one. See this file's own header ("T-088 / finding F-12") for the full argument: an actor may
 * never reach, through any `/users` write, a role it could not itself have created.
 */
function assertManagementAllowed(actorRole: PortalRole, targetRole: PortalRole): void {
  if (!ALLOWED_CREATION[actorRole].includes(targetRole)) {
    throw new RoleManagementNotPermittedError();
  }
}

function parseSort(sort: string | undefined): [UserSortField, 'asc' | 'desc'] {
  if (sort === undefined) return ['displayName', 'asc'];
  const [field, direction] = sort.split(':') as [UserSortField, 'asc' | 'desc'];
  return [field, direction];
}
