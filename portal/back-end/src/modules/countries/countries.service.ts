/**
 * T-030 — `/countries`: onboarding the first link in the delegation chain
 * (00-ARCHITECTURE.md §5).
 *
 * ### The three independent layers behind every write here
 *
 * Mirroring 00-ARCHITECTURE.md §5.2's structure for rules/rewards, even though this task is not
 * the one flagged "load-bearing" for it:
 *
 *  1. **Permission layer** — `role_entity_permissions` grants `country:create`/`update` to
 *     `super_admin` only (T004_001 seed); `country_admin` holds `view` only.
 *  2. **Service layer** — `assertRole(actor, 'super_admin')` at the top of every mutating
 *     method, independent of what the permission table says (T-013's `assertRole`).
 *  3. **Data layer** — `ScopedRepository`'s declared strategy for `Country`
 *     (`column('id', 'country')` for every non-super-admin role) makes a `country_admin` unable
 *     to reach any row but its own even if the two layers above were both wrong, and
 *     `PermissionsGuard`/`RolesGuard` never let a non-`super_admin` reach this service's write
 *     methods at all (TC-8).
 *
 * ### Why `is_hq` uniqueness is checked here rather than in the database
 *
 * Implementation note 4: *"there is no DB constraint for it and adding one is forbidden by
 * C1"* (`reward_config` is a live schema; AGENT-PROTOCOL R1 forbids new constraints on it
 * outside T-002's two authorised exceptions). The check therefore runs inside the same
 * transaction as the write it guards — see `assertHqAvailable` — which narrows, but does not
 * close, the TOCTOU window between the check and the insert. Flagged for the reviewer: closing
 * it fully would need `SELECT ... FOR UPDATE` on the whole `countries` table, which is a lock
 * this Low-risk task's own scope does not ask for.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { Country, Tenant, TenantCampaign } from '@/database/models';
import { PortalUser, PortalUserCredential } from '@/database/portal-models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { assertRole } from '@/common/rbac/assert-role';
import { AuditService } from '@/common/audit/audit.service';
import { CredentialService } from '@/modules/auth/services/credential.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { generateTemporaryPassword } from './country-admin-password';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, TEMPORARY_PASSWORD_LENGTH } from './countries.constants';
import {
  AdminEmailExistsError,
  CountryCodeExistsError,
  CountryDeactivationRequiresConfirmationError,
  HqAlreadyExistsError,
} from './countries.errors';
import type { CreateCountryAdminDto } from './dto/create-country-admin.dto';
import type { CreateCountryDto } from './dto/create-country.dto';
import type { CountrySortField, ListCountriesQueryDto } from './dto/list-countries-query.dto';
import type { UpdateCountryDto } from './dto/update-country.dto';
import {
  toCountryDto,
  toCountryTenantSummaryDto,
  type CountryAdminCreatedDto,
  type CountryDto,
  type CountrySummaryDto,
  type CreateCountryResultDto,
  type ListMeta,
} from './dto/country-response.dto';

const SORT_COLUMN: Readonly<Record<CountrySortField, string>> = Object.freeze({
  code: 'code',
  name: 'name',
  createdAt: 'createdAt',
  status: 'status',
});

/** `tenants.status` values that count as "active" for the deactivation warning (TC-14). */
const ACTIVE_TENANT_STATUS = 'active';

@Injectable()
export class CountriesService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly credentials: CredentialService,
    private readonly audit: AuditService,
  ) {}

  // --- reads -----------------------------------------------------------------------------

  /**
   * Scope alone decides visibility here: `Country`'s declared strategy
   * (`common/scope/scope-strategy.ts`) already restricts every non-`super_admin` role to
   * `id = <their own countryId>`, so `super_admin` sees every row (TC-9) and a `country_admin`
   * sees exactly one (TC-9/TC-10) with no branch in this method telling the two apart.
   */
  async list(query: ListCountriesQueryDto): Promise<{ rows: CountryDto[]; meta: ListMeta }> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const [field, direction] = parseSort(query.sort);

    const rows = await this.scoped.listAll(Country, {
      order: [[SORT_COLUMN[field], direction.toUpperCase()]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const total = await this.scoped.count(Country, {});

    return { rows: rows.map(toCountryDto), meta: { page, pageSize, total } };
  }

  /**
   * `getById`, not `findOne` — the latter is one of the identifiers
   * `no-raw-model-access.spec.ts` (T-013) bans on *any* receiver, precisely so that a name like
   * this one cannot be mistaken for a raw Sequelize call at a glance. `findByPkOrFail` throws
   * {@link ScopeViolationError} (404) for a row out of the actor's scope — indistinguishable
   * from "does not exist" (TC-10, 02-SECURITY.md §5.1).
   */
  async getById(id: number): Promise<CountryDto> {
    const country = await this.scoped.findByPkOrFail(Country, id);
    return toCountryDto(country);
  }

  async summary(id: number): Promise<CountrySummaryDto> {
    // Scoped lookup first: a country_admin asking for another country's summary 404s here,
    // before any tenant/campaign query runs.
    await this.scoped.findByPkOrFail(Country, id);

    const tenants = await this.scoped.listAll(Tenant, {
      where: { countryId: id },
      order: [['name', 'ASC']],
    });
    const activeTenantCount = tenants.filter(
      (tenant) => tenant.status === ACTIVE_TENANT_STATUS,
    ).length;

    const tenantIds = tenants.map((tenant) => tenant.id);
    const campaignCount =
      tenantIds.length === 0
        ? 0
        : await this.scoped.count(TenantCampaign, { where: { tenantId: { [Op.in]: tenantIds } } });

    return {
      countryId: id,
      tenantCount: tenants.length,
      activeTenantCount,
      campaignCount,
      tenants: tenants.map(toCountryTenantSummaryDto),
    };
  }

  // --- writes ------------------------------------------------------------------------------

  /**
   * `POST /countries`. Implementation note 5: country + Country Admin in one transaction when
   * `dto.admin` is supplied, "so a country never exists without a way to administer it" — and,
   * symmetrically, so a half-created admin never leaves an orphan country behind (TC-7).
   */
  async create(actor: AuthenticatedUser, dto: CreateCountryDto): Promise<CreateCountryResultDto> {
    assertRole(actor, 'super_admin');

    return this.sequelize.transaction(async (transaction) => {
      if (dto.isHq === true) {
        await this.assertHqAvailable(null, transaction);
      }

      const country = await this.insertCountry(dto, transaction);
      this.audit.annotate({ targetId: country.id });

      const admin =
        dto.admin === undefined
          ? null
          : await this.provisionCountryAdmin(country.id, dto.admin, actor, transaction);

      return { country: toCountryDto(country), admin };
    });
  }

  /** `POST /countries/:id/admins` — onboarding the admin for a country created earlier without one. */
  async createAdmin(
    actor: AuthenticatedUser,
    countryId: number,
    dto: CreateCountryAdminDto,
  ): Promise<CountryAdminCreatedDto> {
    assertRole(actor, 'super_admin');

    return this.sequelize.transaction(async (transaction) => {
      // Scoped, but `super_admin` is the only role that can reach `create`/`createAdmin` at
      // all (layer 1/2 above) — this call's job here is the 404-on-absent-id, not scoping.
      const country = await this.scoped.findByPkOrFail(Country, countryId, { transaction });
      return this.provisionCountryAdmin(country.id, dto, actor, transaction);
    });
  }

  /**
   * `PATCH /countries/:id`. Deactivation never cascades (implementation note 7): the tenants
   * beneath an `inactive` country are left exactly as they were, and the only thing this method
   * refuses is doing that *silently* when tenants are still active.
   */
  async update(actor: AuthenticatedUser, id: number, dto: UpdateCountryDto): Promise<CountryDto> {
    assertRole(actor, 'super_admin');

    return this.sequelize.transaction(async (transaction) => {
      const country = await this.scoped.findByPkOrFail(Country, id, { transaction });

      if (dto.isHq === true && !country.isHq) {
        await this.assertHqAvailable(id, transaction);
      }

      if (dto.status === 'inactive' && country.status !== 'inactive' && dto.confirm !== true) {
        const activeTenants = await this.scoped.count(Tenant, {
          where: { countryId: id, status: ACTIVE_TENANT_STATUS },
          transaction,
        });
        if (activeTenants > 0) throw new CountryDeactivationRequiresConfirmationError();
      }

      const changes = collectCountryChanges(dto);
      if (Object.keys(changes).length > 0) {
        await this.scoped.update(Country, changes, { where: { id }, transaction });
      }

      const updated = await this.scoped.findByPkOrFail(Country, id, { transaction });
      this.audit.annotate({ targetId: id, detail: { fields: Object.keys(changes) } });
      return toCountryDto(updated);
    });
  }

  // --- private helpers -----------------------------------------------------------------------

  /** `excludeId` is the row being updated (it may keep its own `is_hq = true`); `null` on create. */
  private async assertHqAvailable(
    excludeId: number | null,
    transaction: Transaction,
  ): Promise<void> {
    const where: Record<string, unknown> = { isHq: true };
    if (excludeId !== null) where['id'] = { [Op.ne]: excludeId };

    const existing = await this.scoped.count(Country, { where, transaction });
    if (existing > 0) throw new HqAlreadyExistsError();
  }

  private async insertCountry(dto: CreateCountryDto, transaction: Transaction): Promise<Country> {
    try {
      // `as never` — the same escape hatch `scoped.repository.spec.ts` itself establishes
      // (T-013) for this exact gap: these `sequelize-typescript` model classes declare a single
      // `Model<Country>` type parameter rather than `InferAttributes`/`InferCreationAttributes`,
      // so `CreationAttributes<M>` resolves to the *whole* instance shape (every method,
      // `id`, `createdAt`, `updatedAt` included) instead of just the writable columns. `never`
      // is assignable to any parameter type, which is what makes the object literal below
      // type-check while every field name is still checked structurally by nothing else — a
      // typo here would still be caught at runtime by the `NOT NULL` columns it omits.
      return await this.scoped.create(
        Country,
        {
          code: dto.code,
          name: dto.name.trim(),
          timezone: dto.timezone,
          currencyCode: dto.currencyCode,
          dialingCode: dto.dialingCode,
          isHq: dto.isHq ?? false,
          status: 'active',
        } as never,
        { transaction },
      );
    } catch (error) {
      if (error instanceof UniqueConstraintError)
        throw new CountryCodeExistsError({ cause: error });
      throw error;
    }
  }

  /**
   * The credential + user pair for a new Country Admin, both in `transaction` — the "rollback
   * proven" half of TC-7. Encryption of `email` and its blind index are transparent: they are
   * applied by the `beforeCreate`/`afterCreate` hooks `installEncryptionHooks` attaches to
   * `PortalUser` at boot (`model-encryption.hooks.ts`), from the plaintext `email` set below.
   */
  private async provisionCountryAdmin(
    countryId: number,
    dto: CreateCountryAdminDto,
    actor: AuthenticatedUser,
    transaction: Transaction,
  ): Promise<CountryAdminCreatedDto> {
    const temporaryPassword = generateTemporaryPassword(TEMPORARY_PASSWORD_LENGTH);
    const passwordHash = await this.credentials.hash(temporaryPassword);

    let user: PortalUser;
    try {
      // `as never` — see `insertCountry`'s comment for why.
      user = await this.scoped.create(
        PortalUser,
        {
          email: dto.email.trim(),
          displayName: dto.displayName.trim(),
          role: 'country_admin',
          countryId,
          // `active`, not the model's `pending_activation` default: this account must be able
          // to authenticate on its very first attempt, confined to the change-password screen
          // by `mustChangePassword` — not blocked outright by `CredentialService`'s
          // `ACTIVE_USER_STATUS` check.
          status: 'active',
          mustChangePassword: true,
          createdBy: actor.userId,
        } as never,
        { transaction },
      );
    } catch (error) {
      if (error instanceof UniqueConstraintError) throw new AdminEmailExistsError({ cause: error });
      throw error;
    }

    await this.scoped.create(
      PortalUserCredential,
      {
        userId: user.id,
        passwordHash,
        passwordAlgo: 'argon2id',
        passwordUpdatedAt: new Date(),
      } as never,
      { transaction },
    );

    return {
      id: user.id,
      email: dto.email.trim(),
      displayName: user.displayName,
      role: 'country_admin',
      countryId,
      temporaryPassword,
    };
  }
}

// --- module-private helpers --------------------------------------------------------------------

function parseSort(sort: string | undefined): [CountrySortField, 'asc' | 'desc'] {
  if (sort === undefined) return ['name', 'asc'];
  const [field, direction] = sort.split(':') as [CountrySortField, 'asc' | 'desc'];
  return [field, direction];
}

/** Only the columns the caller actually supplied — never `code` (immutable business key). */
function collectCountryChanges(dto: UpdateCountryDto): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (dto.name !== undefined) changes['name'] = dto.name.trim();
  if (dto.timezone !== undefined) changes['timezone'] = dto.timezone;
  if (dto.currencyCode !== undefined) changes['currencyCode'] = dto.currencyCode;
  if (dto.dialingCode !== undefined) changes['dialingCode'] = dto.dialingCode;
  if (dto.isHq !== undefined) changes['isHq'] = dto.isHq;
  if (dto.status !== undefined) changes['status'] = dto.status;
  return changes;
}
