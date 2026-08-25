/**
 * T-036 — `/merchants`: the merchant directory a Tenant Admin owns — merchants, their stores,
 * and the activities they participate in.
 *
 * ### The three independent layers behind every write here
 *
 * Mirroring `tenants.service.ts`'s own header, one link further down the delegation chain:
 *
 *  1. **Permission layer** — `role_entity_permissions` grants `merchant:create`/`update` to
 *     `tenant_admin` only (T004_001 seed); `super_admin`/`country_admin`/`maker`/`checker`/
 *     `merchant` all hold `view` only (TC-6, TC-7).
 *  2. **Service layer** — `assertRole(actor, 'tenant_admin')` at the top of every mutating
 *     method, independent of what the permission table says.
 *  3. **Data layer** — `ScopedRepository`'s declared strategy for `Merchant`/`MerchantStore`/
 *     `MerchantActivity` (`scope-strategy.ts`) makes a `tenant_admin` unable to reach any row
 *     outside its own tenant even if the two layers above were both wrong (TC-8/TC-9/TC-13), and
 *     forces `tenant_id` onto every INSERT from the actor's own scope regardless of what the
 *     request body said — `CreateMerchantDto` has no `tenantId` field at all (TC-2). A
 *     `merchant`-role actor's own scope additionally restricts it to exactly its own merchant row
 *     (`every(column('tenantId','tenant'), column('id','merchant'))`), which is what makes
 *     TC-10/TC-11 hold with no branch in this file telling `tenant_admin` and `merchant` apart.
 *
 * ### `countryCode` — validated, not derived (implementation note 3)
 *
 * `merchants.country_code` is a plain column with no FK to `reward_config.countries`, so it
 * cannot be forced from scope the way `tenantId` is. `create()` instead loads the actor's own
 * tenant and that tenant's own country (both scoped lookups — a `tenant_admin` can only ever
 * reach its own tenant, and `Country`'s own scope strategy restricts a `tenant_admin` to exactly
 * that tenant's country too) and rejects a mismatch with 400, before any row is written (TC-5).
 *
 * ### Session revocation on deactivation (implementation note 8)
 *
 * `SessionValidGuard`'s parent-status check (T-013, `modules/auth/**`) already refuses any
 * session belonging to a `merchant`-role user whose merchant is not `active`, on the *next*
 * request — the backstop for the window before the bulk revoke below completes, or for the case
 * where it fails partway (the same shape `tenants.service.ts`'s own header documents for tenant
 * suspension, AR-10). `revokeSessionsForMerchant` is the bulk-revoke half, run immediately after
 * the status-change transaction commits — it cannot literally share that transaction for the
 * same reason `tenants.service.ts#update` gives: `SessionService.revokeAllForUser` opens its own
 * transaction per user, and `back-end/src/modules/auth/**` is outside this task's file scope to
 * change (AGENT-PROTOCOL R9).
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  Op,
  UniqueConstraintError,
  type Attributes,
  type Transaction,
  type WhereOptions,
} from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import {
  Activity,
  CampaignMerchant,
  Country,
  Merchant,
  MerchantActivity,
  MerchantStore,
  Tenant,
  TenantCampaign,
} from '@/database/models';
import { PortalUser } from '@/database/portal-models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { assertRole } from '@/common/rbac/assert-role';
import { NotFoundError } from '@/common/errors/app-error';
import { AuditService } from '@/common/audit/audit.service';
import { SessionService, type RequestContext } from '@/modules/auth/services/session.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import {
  ACTIVE_CAMPAIGN_STATUSES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MERCHANT_ACTIVE_STATUS,
  MERCHANT_SESSION_REVOCATION_AUDIT_EVENT,
  MERCHANT_SESSION_REVOCATION_REASON,
} from './merchants.constants';
import {
  MerchantActivityAlreadyLinkedError,
  MerchantCodeExistsError,
  MerchantDeactivationRequiresConfirmationError,
  MerchantStoreCodeExistsError,
  merchantCountryMismatchError,
} from './merchants.errors';
import { commissionRateToColumnString } from './merchants.validators';
import type { CreateMerchantActivityDto } from './dto/create-merchant-activity.dto';
import type { CreateMerchantStoreDto } from './dto/create-merchant-store.dto';
import type { CreateMerchantDto } from './dto/create-merchant.dto';
import type { MerchantSortField, ListMerchantsQueryDto } from './dto/list-merchants-query.dto';
import type { UpdateMerchantDto } from './dto/update-merchant.dto';
import {
  toActiveCampaignDto,
  toMerchantActivityDto,
  toMerchantDto,
  toMerchantStoreDto,
  type ActiveCampaignDto,
  type ListMeta,
  type MerchantActivityDto,
  type MerchantDto,
  type MerchantStoreDto,
} from './dto/merchant-response.dto';

const SORT_COLUMN: Readonly<Record<MerchantSortField, string>> = Object.freeze({
  merchantCode: 'merchantCode',
  name: 'name',
  createdAt: 'createdAt',
  status: 'status',
});

@Injectable()
export class MerchantsService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  // --- reads -----------------------------------------------------------------------------

  /**
   * Scope alone decides visibility (`Merchant`'s declared strategy in `scope-strategy.ts`):
   * `tenant_admin`/`maker`/`checker` see their own tenant's merchants (TC-8), a `merchant` user
   * sees exactly one row — its own (TC-10) — no branch here tells the roles apart. `search`
   * (TC-21) narrows further, inside the same scoped query, so `LIMIT`/`OFFSET`/`COUNT` are still
   * computed over the actor's own rows only.
   */
  async list(query: ListMerchantsQueryDto): Promise<{ rows: MerchantDto[]; meta: ListMeta }> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const [field, direction] = parseSort(query.sort);
    const where = buildSearchWhere(query.search);

    const rows = await this.scoped.listAll(Merchant, {
      where,
      order: [[SORT_COLUMN[field], direction.toUpperCase()]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const total = await this.scoped.count(Merchant, { where });

    return { rows: rows.map(toMerchantDto), meta: { page, pageSize, total } };
  }

  /** `findByPkOrFail` 404s for a row out of the actor's scope — indistinguishable from "does not
   * exist" (TC-9/TC-11, 02-SECURITY.md §5.1). */
  async getById(id: number): Promise<MerchantDto> {
    const merchant = await this.scoped.findByPkOrFail(Merchant, id);
    return toMerchantDto(merchant);
  }

  /**
   * `GET /merchants/:id/active-campaigns` — the deactivation-warning data source (implementation
   * note 7, TC-20). The scoped lookup on `Merchant` first is what makes an out-of-scope id a 404
   * rather than an empty list.
   */
  async listActiveCampaigns(id: number): Promise<ActiveCampaignDto[]> {
    await this.scoped.findByPkOrFail(Merchant, id);
    return this.findActiveCampaigns(id);
  }

  async listStores(id: number): Promise<MerchantStoreDto[]> {
    await this.scoped.findByPkOrFail(Merchant, id);
    const rows = await this.scoped.listAll(MerchantStore, {
      where: { merchantId: id },
      order: [['name', 'ASC']],
    });
    return rows.map(toMerchantStoreDto);
  }

  async listActivities(id: number): Promise<MerchantActivityDto[]> {
    await this.scoped.findByPkOrFail(Merchant, id);
    const rows = await this.scoped.listAll(MerchantActivity, {
      where: { merchantId: id },
      order: [['createdAt', 'ASC']],
    });
    return rows.map(toMerchantActivityDto);
  }

  // --- writes ------------------------------------------------------------------------------

  /** `POST /merchants`. See this file's own header for the `countryCode` validation and the
   * three-layer authority story. */
  async create(actor: AuthenticatedUser, dto: CreateMerchantDto): Promise<MerchantDto> {
    assertRole(actor, 'tenant_admin');

    return this.sequelize.transaction(async (transaction) => {
      await this.assertCountryMatchesTenant(actor, dto.countryCode, transaction);

      try {
        // `as never` — the same `sequelize-typescript`/`CreationAttributes<M>` escape hatch
        // `tenants.service.ts#insertTenant`'s comment documents at length.
        const merchant = await this.scoped.create(
          Merchant,
          {
            merchantCode: dto.merchantCode,
            name: dto.name.trim(),
            description: dto.description ?? null,
            contactEmail: dto.contactEmail ?? null,
            contactPhone: dto.contactPhone ?? null,
            website: dto.website ?? null,
            countryCode: dto.countryCode,
            status: MERCHANT_ACTIVE_STATUS,
          } as never,
          { transaction },
        );

        this.audit.annotate({ targetId: merchant.id });
        return toMerchantDto(merchant);
      } catch (error) {
        if (error instanceof UniqueConstraintError)
          throw new MerchantCodeExistsError({ cause: error });
        throw error;
      }
    });
  }

  /**
   * `PATCH /merchants/:id`. Implementation note 7/8: a `status` change away from `active` on a
   * merchant with active campaigns requires `confirm: true` (TC-20), and — whether or not a
   * campaign forced that confirmation — triggers implementation note 8's bulk session revocation
   * for every `merchant`-role user scoped to this merchant (TC-20a).
   */
  async update(
    actor: AuthenticatedUser,
    id: number,
    dto: UpdateMerchantDto,
    context: RequestContext,
  ): Promise<MerchantDto> {
    assertRole(actor, 'tenant_admin');

    const { dto: updated, revoke } = await this.sequelize.transaction(async (transaction) => {
      const merchant = await this.scoped.findByPkOrFail(Merchant, id, { transaction });
      // Captured **before** the write below — `ScopedRepository.update` issues a fresh UPDATE
      // and never mutates `merchant` in place, but nothing here should depend on that.
      const previousStatus = merchant.status;
      const deactivating =
        dto.status !== undefined &&
        dto.status !== MERCHANT_ACTIVE_STATUS &&
        dto.status !== previousStatus;

      if (deactivating && dto.confirm !== true) {
        const activeCampaigns = await this.findActiveCampaigns(id, transaction);
        if (activeCampaigns.length > 0) {
          throw new MerchantDeactivationRequiresConfirmationError();
        }
      }

      const changes = collectMerchantChanges(dto);
      if (Object.keys(changes).length > 0) {
        try {
          await this.scoped.update(Merchant, changes, { where: { id }, transaction });
        } catch (error) {
          if (error instanceof UniqueConstraintError) {
            throw new MerchantCodeExistsError({ cause: error });
          }
          throw error;
        }
      }

      const reloaded = await this.scoped.findByPkOrFail(Merchant, id, { transaction });
      this.audit.annotate({ targetId: id, detail: { fields: Object.keys(changes) } });

      return { dto: toMerchantDto(reloaded), revoke: deactivating };
    });

    if (revoke) {
      await this.revokeSessionsForMerchant(id, actor, context);
    }

    return updated;
  }

  /** `POST /merchants/:id/stores` (TC-12/TC-13). */
  async createStore(
    actor: AuthenticatedUser,
    merchantId: number,
    dto: CreateMerchantStoreDto,
  ): Promise<MerchantStoreDto> {
    assertRole(actor, 'tenant_admin');

    return this.sequelize.transaction(async (transaction) => {
      // Scoped: a merchant id out of the actor's tenant 404s here, before any store is written
      // (TC-13) — the tenant/merchant equivalent of `tenants.service.ts#createAdmin`'s own lookup.
      const merchant = await this.scoped.findByPkOrFail(Merchant, merchantId, { transaction });

      try {
        const store = await this.scoped.create(
          MerchantStore,
          {
            merchantId: merchant.id,
            storeCode: dto.storeCode,
            name: dto.name.trim(),
            address: dto.address ?? null,
            city: dto.city ?? null,
            state: dto.state ?? null,
            postalCode: dto.postalCode ?? null,
            region: dto.region ?? null,
            latitude: dto.latitude === undefined ? null : String(dto.latitude),
            longitude: dto.longitude === undefined ? null : String(dto.longitude),
            status: MERCHANT_ACTIVE_STATUS,
          } as never,
          { transaction },
        );

        this.audit.annotate({ targetId: merchant.id, detail: { storeId: store.id } });
        return toMerchantStoreDto(store);
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          throw new MerchantStoreCodeExistsError({ cause: error });
        }
        throw error;
      }
    });
  }

  /**
   * `POST /merchants/:id/activities` (TC-14…TC-19). Implementation note 4: the "one tenant-wide
   * activity link" rule (`storeId` omitted) is enforced here, inside the transaction, because the
   * live `uq_ma_merchant_activity_store` constraint does not treat two `NULL store_id` rows as
   * equal (TC-15). A `storeId`-scoped link is a different key entirely and is never blocked by
   * this check (TC-16) — the database's own constraint is what protects *that* combination
   * against a literal duplicate, caught below via `UniqueConstraintError`.
   */
  async createActivity(
    actor: AuthenticatedUser,
    merchantId: number,
    dto: CreateMerchantActivityDto,
  ): Promise<MerchantActivityDto> {
    assertRole(actor, 'tenant_admin');

    return this.sequelize.transaction(async (transaction) => {
      const merchant = await this.scoped.findByPkOrFail(Merchant, merchantId, { transaction });
      // Scoped to the actor's own tenant — an activity id from another tenant 404s here.
      await this.scoped.findByPkOrFail(Activity, dto.activityId, { transaction });

      if (dto.storeId !== undefined) {
        // Scoped to the actor's own tenant, but *not* to this merchant — `MerchantStore`'s scope
        // strategy only forces `tenantId`, so a store belonging to a different merchant in the
        // same tenant would otherwise pass this lookup. Checked explicitly below.
        const store = await this.scoped.findByPkOrFail(MerchantStore, dto.storeId, { transaction });
        // Not found *for this merchant* — the same "not found or out of scope, indistinguishable"
        // shape `findByPkOrFail` itself gives (02-SECURITY.md §5.1), for the one relationship
        // `Merchant`'s own scope strategy does not already narrow.
        if (store.merchantId !== merchant.id) throw new NotFoundError();
      } else {
        const existing = await this.scoped.count(MerchantActivity, {
          where: { merchantId: merchant.id, activityId: dto.activityId, storeId: null },
          transaction,
        });
        if (existing > 0) throw new MerchantActivityAlreadyLinkedError();
      }

      try {
        const link = await this.scoped.create(
          MerchantActivity,
          {
            merchantId: merchant.id,
            activityId: dto.activityId,
            storeId: dto.storeId ?? null,
            commissionRate:
              dto.commissionRate === undefined
                ? null
                : commissionRateToColumnString(dto.commissionRate),
            status: MERCHANT_ACTIVE_STATUS,
          } as never,
          { transaction },
        );

        this.audit.annotate({ targetId: merchant.id, detail: { activityLinkId: link.id } });
        return toMerchantActivityDto(link);
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          throw new MerchantActivityAlreadyLinkedError({ cause: error });
        }
        throw error;
      }
    });
  }

  // --- private helpers -----------------------------------------------------------------------

  /**
   * Implementation note 3. Both lookups are scoped as `actor` (a `tenant_admin`): `Tenant`'s own
   * strategy restricts it to exactly `actor.tenantId`, and `Country`'s restricts it to exactly
   * that tenant's own country — so neither can be tricked into comparing against another
   * tenant's country regardless of what `dto.countryCode` says.
   */
  private async assertCountryMatchesTenant(
    actor: AuthenticatedUser,
    countryCode: string,
    transaction: Transaction,
  ): Promise<void> {
    const tenantId = actor.tenantId;
    if (tenantId === null) throw merchantCountryMismatchError();

    const tenant = await this.scoped.findByPkOrFail(Tenant, tenantId, { transaction });
    const country = await this.scoped.findByPkOrFail(Country, tenant.countryId, { transaction });

    if (country.code !== countryCode) throw merchantCountryMismatchError();
  }

  /** The active campaigns (implementation note 7) this merchant participates in — via
   * `campaign_merchants`, itself scoped the same way `Merchant` is. */
  private async findActiveCampaigns(
    merchantId: number,
    transaction?: Transaction,
  ): Promise<ActiveCampaignDto[]> {
    const links = await this.scoped.listAll(CampaignMerchant, {
      where: { merchantId, status: MERCHANT_ACTIVE_STATUS },
      transaction,
    });
    if (links.length === 0) return [];

    const campaignIds = links.map((link) => link.campaignId);
    const campaigns = await this.scoped.listAll(TenantCampaign, {
      where: {
        id: { [Op.in]: campaignIds },
        status: { [Op.in]: [...ACTIVE_CAMPAIGN_STATUSES] },
      },
      order: [['id', 'ASC']],
      transaction,
    });
    return campaigns.map(toActiveCampaignDto);
  }

  /** Implementation note 8 — every `merchant`-role user scoped to `merchantId`, revoked
   * immediately after the status-change transaction commits. See this file's own header for
   * what "immediately" means here. */
  private async revokeSessionsForMerchant(
    merchantId: number,
    actor: AuthenticatedUser,
    context: RequestContext,
  ): Promise<number> {
    const users = await this.scoped.listAll(PortalUser, {
      where: { merchantId, role: 'merchant' },
      attributes: ['id'],
    });

    let total = 0;
    for (const user of users) {
      total += await this.sessions.revokeAllForUser(
        user.id,
        MERCHANT_SESSION_REVOCATION_REASON,
        null,
        { userId: actor.userId, role: actor.role },
        context,
        MERCHANT_SESSION_REVOCATION_AUDIT_EVENT,
      );
    }
    return total;
  }
}

// --- module-private helpers --------------------------------------------------------------------

function parseSort(sort: string | undefined): [MerchantSortField, 'asc' | 'desc'] {
  if (sort === undefined) return ['name', 'asc'];
  const [field, direction] = sort.split(':') as [MerchantSortField, 'asc' | 'desc'];
  return [field, direction];
}

/** TC-21 — `merchantCode`/`name`, case-insensitively. `undefined` when `search` is absent or
 * blank, so the scoped query's `where` is exactly the scope clause, unchanged from before this
 * parameter existed. */
function buildSearchWhere(
  search: string | undefined,
): WhereOptions<Attributes<Merchant>> | undefined {
  if (search === undefined || search.trim() === '') return undefined;
  const term = `%${search.trim()}%`;
  return {
    [Op.or]: [{ merchantCode: { [Op.iLike]: term } }, { name: { [Op.iLike]: term } }],
  } as WhereOptions<Attributes<Merchant>>;
}

/** Only the columns the caller actually supplied — never `merchantCode`/`tenantId`/
 * `countryCode`, and never `confirm` (not a column). */
function collectMerchantChanges(dto: UpdateMerchantDto): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (dto.name !== undefined) changes['name'] = dto.name.trim();
  if (dto.description !== undefined) changes['description'] = dto.description;
  if (dto.contactEmail !== undefined) changes['contactEmail'] = dto.contactEmail;
  if (dto.contactPhone !== undefined) changes['contactPhone'] = dto.contactPhone;
  if (dto.website !== undefined) changes['website'] = dto.website;
  if (dto.status !== undefined) changes['status'] = dto.status;
  return changes;
}
