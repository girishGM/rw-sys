/**
 * T-034 — `/tenants`: the second link in the delegation chain (00-ARCHITECTURE.md §5),
 * mirroring `countries.service.ts`'s own three-layer authority story:
 *
 *  1. **Permission layer** — `role_entity_permissions` grants `tenant:create`/`update` to
 *     `country_admin` only (T004_001 seed); `super_admin`/`tenant_admin` hold `view` only.
 *  2. **Service layer** — `assertRole(actor, 'country_admin')` at the top of every mutating
 *     method, independent of what the permission table says (TC-6, TC-9: `tenant_admin` and
 *     `super_admin` are each denied here even if the table were misconfigured).
 *  3. **Data layer** — `ScopedRepository`'s declared strategy for `Tenant`
 *     (`column('countryId', 'country')` for `country_admin`, `column('id', 'tenant')` below it)
 *     makes a `country_admin` unable to reach any row outside its own country even if the two
 *     layers above were both wrong (TC-3/TC-4/TC-5), and forces `country_id` onto every INSERT
 *     from the actor's own scope regardless of what the request body said — implementation note
 *     2 / AGENT-PROTOCOL R3's "two independent layers" made concrete: `CreateTenantDto` has no
 *     `countryId` field at all, and even a hand-crafted body with one would be overwritten by
 *     `ScopedRepository.create`'s `forcedWriteValues` (TC-2).
 *
 * ### Session revocation on suspension (implementation note 8)
 *
 * `SessionService.isUsableSession` (`modules/auth/services/session.service.ts`) already refuses
 * any session whose owner's tenant is not `active`, on the *next request* — that guard is the
 * backstop 00-ARCHITECTURE.md §5.3 and that file's own header describe: *"T-034/T-036 bulk-revoke
 * every session scoped to a suspended tenant in the same transaction as the status change; [the
 * guard's two `LEFT JOIN`s] are the backstop for the window before that completes, and for the
 * case where it fails partway."* `revokeSessionsForTenant` below is the bulk-revoke half of that
 * sentence. It cannot literally share the database transaction the status change runs in —
 * `SessionService.revokeAllForUser` opens its own transaction per user
 * (`modules/auth/services/session.service.ts`, `store.runInTransaction`), and that file is
 * outside this task's file scope (`back-end/src/modules/auth/**`, AGENT-PROTOCOL R9) to change.
 * It runs immediately after the status-change transaction commits instead, which is enough to
 * satisfy TC-18 ("all 3 sessions revoked; next request 401") either way: explicitly, the moment
 * this call completes, or — if it were ever interrupted partway — passively, on each affected
 * user's very next request, via the guard above. Flagged for the reviewer as the one place this
 * task's file-scope boundary keeps it from the literal "same transaction" wording.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UniqueConstraintError, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { Country, Tenant, TenantBudgetCeiling, TenantCurrency } from '@/database/models';
import { PortalUser } from '@/database/portal-models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { assertRole } from '@/common/rbac/assert-role';
import { AuditService } from '@/common/audit/audit.service';
import { CredentialService } from '@/modules/auth/services/credential.service';
import {
  CREDENTIAL_STORE,
  type CredentialProvisioner,
} from '@/modules/auth/services/credential.repository';
import { SessionService, type RequestContext } from '@/modules/auth/services/session.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { generateTemporaryPassword } from './tenant-admin-password';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  TEMPORARY_PASSWORD_LENGTH,
  TENANT_ACTIVE_STATUS,
  TENANT_SESSION_REVOCATION_AUDIT_EVENT,
  TENANT_SESSION_REVOCATION_REASON,
} from './tenants.constants';
import {
  TenantAdminEmailExistsError,
  TenantAlreadyActiveError,
  TenantCodeExistsError,
  TenantSchemaPrefixExistsError,
} from './tenants.errors';
import type { CreateTenantAdminDto } from './dto/create-tenant-admin.dto';
import type { CreateTenantDto } from './dto/create-tenant.dto';
import type { TenantSortField, ListTenantsQueryDto } from './dto/list-tenants-query.dto';
import type { UpdateTenantDto } from './dto/update-tenant.dto';
import type { UpsertBudgetCeilingDto } from './dto/upsert-budget-ceiling.dto';
import {
  toBudgetCeilingDto,
  toTenantDto,
  toTenantWithoutCeilingDto,
  type BudgetCeilingDto,
  type CreateTenantResultDto,
  type ListMeta,
  type TenantAdminCreatedDto,
  type TenantDto,
  type TenantWithoutCeilingDto,
} from './dto/tenant-response.dto';

const SORT_COLUMN: Readonly<Record<TenantSortField, string>> = Object.freeze({
  code: 'code',
  name: 'name',
  createdAt: 'createdAt',
  status: 'status',
});

@Injectable()
export class TenantsService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly credentials: CredentialService,
    // T-059. Same `CREDENTIAL_STORE` DI token `CredentialService` itself depends on
    // (`auth.module.ts`, outside this task's file scope to change and not touched here) — the
    // provider bound to it is `CredentialRepository`, which also implements this narrower
    // `CredentialProvisioner` port. See that port's own doc comment for why it is not folded
    // into `CredentialStore`.
    @Inject(CREDENTIAL_STORE) private readonly credentialStore: CredentialProvisioner,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  // --- reads -----------------------------------------------------------------------------

  /**
   * Scope alone decides visibility (`Tenant`'s declared strategy in `scope-strategy.ts`):
   * `super_admin` sees every row (TC-8), `country_admin` sees its own country's tenants only
   * (TC-3), and everyone below sees exactly its own tenant by primary key (03-API-CONTRACT.md
   * §6's "tenant_admin (own only)") — no branch here tells the roles apart.
   */
  async list(query: ListTenantsQueryDto): Promise<{ rows: TenantDto[]; meta: ListMeta }> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const [field, direction] = parseSort(query.sort);

    const rows = await this.scoped.listAll(Tenant, {
      order: [[SORT_COLUMN[field], direction.toUpperCase()]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const total = await this.scoped.count(Tenant, {});

    return { rows: rows.map(toTenantDto), meta: { page, pageSize, total } };
  }

  /** `findByPkOrFail` 404s for a row out of the actor's scope — indistinguishable from "does not
   * exist" (TC-4, 02-SECURITY.md §5.1). */
  async getById(id: number): Promise<TenantDto> {
    const tenant = await this.scoped.findByPkOrFail(Tenant, id);
    return toTenantDto(tenant);
  }

  /**
   * `GET /tenants/:id/budget-ceilings`. The scoped lookup on `Tenant` first is what makes TC-26
   * a 404 rather than an empty list: a `country_admin` of X asking about a tenant in Y never
   * reaches the `tenant_budget_ceilings` query at all.
   */
  async listBudgetCeilings(id: number): Promise<BudgetCeilingDto[]> {
    await this.scoped.findByPkOrFail(Tenant, id);
    const rows = await this.scoped.listAll(TenantBudgetCeiling, {
      where: { tenantId: id },
      order: [
        ['unitType', 'ASC'],
        ['unitCode', 'ASC'],
      ],
    });
    return rows.map(toBudgetCeilingDto);
  }

  /**
   * Implementation note 7 / TC-28 — the data source behind the "Tenants without a budget
   * ceiling" Country Admin dashboard widget. Scope alone decides which tenants are even
   * candidates (a `country_admin` never sees another country's gap); a tenant with **no**
   * `tenant_budget_ceilings` row at all — of any unit — is "unconfigured" (`TenantBudgetCeiling`
   * model header: "a tenant with no row here is unlimited, not blocked").
   *
   * Flagged for the reviewer per this module's own file-scope boundary: the front-end dashboard
   * tile registry (`front-end/src/features/dashboard/widgetRegistry.ts`, T-023's file scope) and
   * the generic `GET /dashboard/widgets/:widgetKey` route it calls (owned by no task's declared
   * file scope today — `features/dashboard/widgets/api.ts`'s own header already discloses this
   * as a T-023 gap) are both outside `back-end/src/modules/tenants/**`/`front-end/src/features/
   * tenants/**`. This method is the data this task owns; wiring `list_tenants_without_ceiling`'s
   * `/dashboard/widgets/...` route to it is for whichever task adds the missing dashboard-routing
   * module.
   */
  async listTenantsWithoutCeiling(): Promise<TenantWithoutCeilingDto[]> {
    const tenants = await this.scoped.listAll(Tenant, { order: [['name', 'ASC']] });
    if (tenants.length === 0) return [];

    const ceilingRows = await this.scoped.listAll(TenantBudgetCeiling, {
      attributes: ['tenantId'],
    });
    const tenantIdsWithCeiling = new Set(ceilingRows.map((row) => row.tenantId));

    return tenants
      .filter((tenant) => !tenantIdsWithCeiling.has(tenant.id))
      .map(toTenantWithoutCeilingDto);
  }

  // --- writes ------------------------------------------------------------------------------

  /**
   * `POST /tenants`. Implementation note 5: tenant + Tenant Admin in one transaction when
   * `dto.admin` is supplied — mirroring `CountriesService.create`'s own reasoning, "so a tenant
   * never exists without a way to administer it" and a half-created admin never leaves an orphan
   * tenant behind (TC-14).
   */
  async create(actor: AuthenticatedUser, dto: CreateTenantDto): Promise<CreateTenantResultDto> {
    assertRole(actor, 'country_admin');

    return this.sequelize.transaction(async (transaction) => {
      const tenant = await this.insertTenant(dto, transaction);
      this.audit.annotate({ targetId: tenant.id });

      const admin =
        dto.admin === undefined
          ? null
          : await this.provisionTenantAdmin(tenant.id, dto.admin, actor, transaction);

      return { tenant: toTenantDto(tenant), admin };
    });
  }

  /** `POST /tenants/:id/admins` — onboarding the admin for a tenant created earlier without one. */
  async createAdmin(
    actor: AuthenticatedUser,
    tenantId: number,
    dto: CreateTenantAdminDto,
  ): Promise<TenantAdminCreatedDto> {
    assertRole(actor, 'country_admin');

    return this.sequelize.transaction(async (transaction) => {
      const tenant = await this.scoped.findByPkOrFail(Tenant, tenantId, { transaction });
      return this.provisionTenantAdmin(tenant.id, dto, actor, transaction);
    });
  }

  /**
   * `POST /tenants/:id/activate` — implementation note 3's `pending_provisioning` → `active`
   * step. Refuses from any other status (TC-16): reactivating a `suspended` tenant is a
   * different, more deliberate decision than completing onboarding, and goes through `PATCH
   * /tenants/:id` with an explicit `status` instead, the same route that already carries the
   * session-revocation side effect for the reverse direction.
   */
  async activate(actor: AuthenticatedUser, id: number): Promise<TenantDto> {
    assertRole(actor, 'country_admin');

    return this.sequelize.transaction(async (transaction) => {
      const tenant = await this.scoped.findByPkOrFail(Tenant, id, { transaction });

      if (tenant.status !== 'pending_provisioning') {
        throw new TenantAlreadyActiveError({ logContext: { tenantStatus: tenant.status } });
      }

      await this.scoped.update(Tenant, { status: TENANT_ACTIVE_STATUS } as never, {
        where: { id },
        transaction,
      });

      const updated = await this.scoped.findByPkOrFail(Tenant, id, { transaction });
      this.audit.annotate({ targetId: id, detail: { status: TENANT_ACTIVE_STATUS } });
      return toTenantDto(updated);
    });
  }

  /**
   * `PATCH /tenants/:id`. Any field the caller supplied is written; `code` and `countryId` never
   * are (see `update-tenant.dto.ts`'s own header). A `status` change away from `active` triggers
   * implementation note 8's bulk session revocation — see this file's own header for the "same
   * transaction" caveat.
   */
  async update(
    actor: AuthenticatedUser,
    id: number,
    dto: UpdateTenantDto,
    context: RequestContext,
  ): Promise<TenantDto> {
    assertRole(actor, 'country_admin');

    const { dto: updated, revoke } = await this.sequelize.transaction(async (transaction) => {
      const tenant = await this.scoped.findByPkOrFail(Tenant, id, { transaction });
      // Captured **before** the write below: `ScopedRepository.update` issues a fresh SQL
      // UPDATE against the real database and never mutates `tenant` in place, but nothing in
      // this method's own contract should depend on that — reading `tenant.status` after the
      // write would be reading a value that may already reflect it.
      const previousStatus = tenant.status;
      const changes = collectTenantChanges(dto);

      if (Object.keys(changes).length > 0) {
        try {
          await this.scoped.update(Tenant, changes, { where: { id }, transaction });
        } catch (error) {
          if (error instanceof UniqueConstraintError) {
            if (isSchemaPrefixConflict(error)) {
              throw new TenantSchemaPrefixExistsError({ cause: error });
            }
            throw new TenantCodeExistsError({ cause: error });
          }
          throw error;
        }
      }

      const reloaded = await this.scoped.findByPkOrFail(Tenant, id, { transaction });
      this.audit.annotate({ targetId: id, detail: { fields: Object.keys(changes) } });

      const revokeSessions =
        dto.status !== undefined &&
        dto.status !== TENANT_ACTIVE_STATUS &&
        dto.status !== previousStatus;

      return { dto: toTenantDto(reloaded), revoke: revokeSessions };
    });

    if (revoke) {
      await this.revokeSessionsForTenant(id, actor, context);
    }

    return updated;
  }

  /**
   * `PUT /tenants/:id/budget-ceilings` — upserts exactly one `(unitType, unitCode)` row
   * (`upsert-budget-ceiling.dto.ts`'s own header) and returns the tenant's full, current set of
   * ceilings, so the caller never needs a second round trip to see the result next to the ones
   * that did not change (TC-21/TC-22 — both units coexist).
   */
  async upsertBudgetCeiling(
    actor: AuthenticatedUser,
    id: number,
    dto: UpsertBudgetCeilingDto,
  ): Promise<BudgetCeilingDto[]> {
    assertRole(actor, 'country_admin');

    return this.sequelize.transaction(async (transaction) => {
      await this.scoped.findByPkOrFail(Tenant, id, { transaction });

      // `listAll` + `[0]`, not `findOne` — `findOne` is one of the identifiers
      // `no-raw-model-access` (T-013) bans on *any* receiver, `this.scoped` included (the same
      // "unintended consequence" `ScopedRepository.listAll`'s own header documents for
      // `findAll`; there is no `findOne` alias, so this is this module's own workaround).
      const existingRows = await this.scoped.listAll(TenantBudgetCeiling, {
        where: { tenantId: id, unitType: dto.unitType, unitCode: dto.unitCode },
        limit: 1,
        transaction,
      });
      const existing = existingRows[0] ?? null;

      const values = {
        maxCampaignBudget: dto.maxCampaignBudget,
        warnAboveAmount: dto.warnAboveAmount ?? null,
      };

      if (existing === null) {
        await this.scoped.create(
          TenantBudgetCeiling,
          {
            tenantId: id,
            unitType: dto.unitType,
            unitCode: dto.unitCode,
            status: 'active',
            createdBy: actor.userId,
            ...values,
          } as never,
          { transaction },
        );
      } else {
        // TC-29 — lowering a ceiling below an existing campaign's committed budget is allowed
        // outright: this module stores the ceiling only, and has no visibility into campaign
        // budgets (`reward_config.tenant_campaigns` is another task's data). "Existing campaigns
        // unaffected; new submissions blocked" is enforced where campaigns are submitted, not
        // here — see `tenant-active.guard.ts`'s header for the same "this task declares the
        // primitive, a later task enforces it at the write site" shape.
        await this.scoped.update(TenantBudgetCeiling, values as never, {
          where: { id: existing.id },
          transaction,
        });
      }

      this.audit.annotate({
        targetId: id,
        detail: { unitType: dto.unitType, unitCode: dto.unitCode },
      });

      const rows = await this.scoped.listAll(TenantBudgetCeiling, {
        where: { tenantId: id },
        order: [
          ['unitType', 'ASC'],
          ['unitCode', 'ASC'],
        ],
        transaction,
      });
      return rows.map(toBudgetCeilingDto);
    });
  }

  // --- private helpers -----------------------------------------------------------------------

  /**
   * T-143 fix: a tenant never exists without exactly one `tenant_currencies` default row — the
   * same "never exists without X" precedent `countries.service.ts#insertCountry`'s own header
   * cites for admin provisioning, applied here to `TenantCurrency` instead of a `PortalUser`.
   * T126_001's migration backfilled this row once, at migrate time, for every tenant that
   * already existed; nothing inserted it for a tenant created afterward through `POST /tenants`,
   * which silently violated `13-REWARD-MASTER-VALUE-SOURCES.md §4`'s own invariant ("a tenant
   * with no extra rows still has its country's currency available") for every tenant onboarded
   * since. Both inserts share `transaction`, so a tenant is never left without its default
   * currency by a failure between the two (mirroring `provisionTenantAdmin`'s own TC-14
   * atomicity).
   *
   * Deliberately a direct `this.scoped.create(TenantCurrency, …)` here, not a call to
   * `TenantCurrenciesService.create` — that method's own `assertRole(actor, 'super_admin')`
   * would reject the `country_admin` actor this method is actually called under, and the seed
   * row is a system-managed consequence of provisioning, not a user-initiated currency-list
   * change (`TenantCurrenciesService`'s own header note on `super_admin`-only mutation).
   */
  private async insertTenant(dto: CreateTenantDto, transaction: Transaction): Promise<Tenant> {
    let tenant: Tenant;
    try {
      // `as never` — the same `sequelize-typescript`/`CreationAttributes<M>` escape hatch
      // `countries.service.ts#insertCountry`'s comment documents at length.
      tenant = await this.scoped.create(
        Tenant,
        {
          code: dto.code,
          name: dto.name.trim(),
          schemaPrefix: dto.schemaPrefix ?? null,
          contactEmail: dto.contactEmail ?? null,
          contactPhone: dto.contactPhone ?? null,
          status: 'pending_provisioning',
        } as never,
        { transaction },
      );
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        if (isSchemaPrefixConflict(error)) {
          throw new TenantSchemaPrefixExistsError({ cause: error });
        }
        throw new TenantCodeExistsError({ cause: error });
      }
      throw error;
    }

    // The tenant's own country_id was just forced onto it by `ScopedRepository.create` from the
    // actor's own scope (this file's header, implementation note 1) — `country_admin`'s `Country`
    // scope strategy is `column('id', 'country')`, so this lookup always resolves to that same
    // country, never a client-supplied one (R3).
    const country = await this.scoped.findByPkOrFail(Country, tenant.countryId, { transaction });

    await this.scoped.create(
      TenantCurrency,
      {
        tenantId: tenant.id,
        currencyCode: country.currencyCode,
        isDefault: true,
        status: 'active',
      } as never,
      { transaction },
    );

    return tenant;
  }

  /**
   * The credential + user pair for a new Tenant Admin, both in `transaction` — the "rollback
   * proven" half of TC-14. `countryId` is not set explicitly: `ScopedRepository.create` forces it
   * from the actor's own scope (`scope-strategy.ts`'s `PortalUser` entry, `country:
   * column('countryId', 'country')`), which is already the same country the tenant itself was
   * just verified to belong to.
   *
   * ### T-059 — the credential insert does not go through `ScopedRepository`
   *
   * `PortalUserCredential` is `deny()` in `scope-strategy.ts` for every scoped role
   * (`country_admin` included — this method's only caller, `assertRole(actor, 'country_admin')`
   * at the top of `create`/`createAdmin`), so `this.scoped.create(PortalUserCredential, …)` always
   * threw `ScopeViolationError` here — tenant admin onboarding, this module's primary write, could
   * never actually complete. The fix is not to relax the scope strategy (the deny is deliberate:
   * password hashes are reached only through `CredentialRepository`'s own parameterised SQL) but
   * to call that repository directly, through the narrow `CredentialProvisioner` port injected
   * above. `actor` is still passed as `createdBy` on the `portal_users` row above — the new call
   * carries no actor/role of its own, by design, matching every other write in
   * `credential.repository.ts`.
   */
  private async provisionTenantAdmin(
    tenantId: number,
    dto: CreateTenantAdminDto,
    actor: AuthenticatedUser,
    transaction: Transaction,
  ): Promise<TenantAdminCreatedDto> {
    const temporaryPassword = generateTemporaryPassword(TEMPORARY_PASSWORD_LENGTH);
    const passwordHash = await this.credentials.hash(temporaryPassword);

    let user: PortalUser;
    try {
      user = await this.scoped.create(
        PortalUser,
        {
          email: dto.email.trim(),
          displayName: dto.displayName.trim(),
          role: 'tenant_admin',
          tenantId,
          status: 'active',
          mustChangePassword: true,
          createdBy: actor.userId,
        } as never,
        { transaction },
      );
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new TenantAdminEmailExistsError({ cause: error });
      }
      throw error;
    }

    await this.credentialStore.createCredential(user.id, passwordHash, 'argon2id', transaction);

    return {
      id: user.id,
      email: dto.email.trim(),
      displayName: user.displayName,
      role: 'tenant_admin',
      tenantId,
      temporaryPassword,
    };
  }

  /**
   * Implementation note 8 — "Suspending a tenant must immediately revoke every `portal_sessions`
   * row for users in that tenant." See this file's own header for what "immediately" means here.
   */
  private async revokeSessionsForTenant(
    tenantId: number,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<number> {
    const users = await this.scoped.listAll(PortalUser, {
      where: { tenantId },
      attributes: ['id'],
    });

    let total = 0;
    for (const user of users) {
      total += await this.sessions.revokeAllForUser(
        user.id,
        TENANT_SESSION_REVOCATION_REASON,
        null,
        { userId: actor.userId, role: actor.role },
        context,
        TENANT_SESSION_REVOCATION_AUDIT_EVENT,
      );
    }
    return total;
  }
}

// --- module-private helpers --------------------------------------------------------------------

function parseSort(sort: string | undefined): [TenantSortField, 'asc' | 'desc'] {
  if (sort === undefined) return ['name', 'asc'];
  const [field, direction] = sort.split(':') as [TenantSortField, 'asc' | 'desc'];
  return [field, direction];
}

/** Only the columns the caller actually supplied — never `code`/`countryId`. */
function collectTenantChanges(dto: UpdateTenantDto): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (dto.name !== undefined) changes['name'] = dto.name.trim();
  if (dto.schemaPrefix !== undefined) changes['schemaPrefix'] = dto.schemaPrefix;
  if (dto.contactEmail !== undefined) changes['contactEmail'] = dto.contactEmail;
  if (dto.contactPhone !== undefined) changes['contactPhone'] = dto.contactPhone;
  if (dto.status !== undefined) changes['status'] = dto.status;
  return changes;
}

/**
 * `tenants` carries two unique constraints (`uq_tenants_code`, `uq_tenants_schema_prefix`) —
 * unlike `countries`' single `uq_countries_code`, a caught `UniqueConstraintError` here must be
 * discriminated before it can be mapped to the right 409. Checks `error.fields` first (populated
 * by Sequelize's Postgres dialect from the live constraint), then falls back to `error.message`
 * for the hand-built errors this module's own tests construct — the same
 * `new UniqueConstraintError({ message: 'uq_countries_code' })` shape `countries.service.spec.ts`
 * already establishes as this codebase's test-double convention for this class.
 */
function isSchemaPrefixConflict(error: UniqueConstraintError): boolean {
  // `.fields` is always at least `{}` — Sequelize's own constructor defaults it
  // (`unique-constraint-error.js`), and the type declares it as `Record<string, unknown>`, never
  // optional — so there is no defensive `?? {}` branch here to leave untested.
  const fieldKeys = Object.keys(error.fields);
  if (fieldKeys.some((key) => key === 'schema_prefix' || key === 'schemaPrefix')) return true;
  if (fieldKeys.some((key) => key === 'code')) return false;
  return typeof error.message === 'string' && error.message.includes('schema_prefix');
}
