/**
 * T-036 — `MerchantsService`: merchant onboarding, stores, activity links, and the deactivation
 * confirmation + session-revocation side effect.
 *
 * The property under test throughout is *"which decision was made, and on what basis"* — the
 * real rows are `ScopedRepository`'s/`scope-strategy.ts`'s to prove (T-013, 100% branch coverage
 * there already). Negative-authorisation (R6, TC-6/TC-7/TC-9/TC-11) is proven directly here at
 * the service layer — the third of this module's own three independent layers — rather than
 * only inferred from controller metadata.
 */
import { UniqueConstraintError } from 'sequelize';
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
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { NotFoundError, ValidationFailedError } from '@/common/errors/app-error';
import { MerchantsService } from '@/modules/merchants/merchants.service';
import {
  MerchantActivityAlreadyLinkedError,
  MerchantCodeExistsError,
  MerchantDeactivationRequiresConfirmationError,
  MerchantStoreCodeExistsError,
} from '@/modules/merchants/merchants.errors';
import type { CreateMerchantActivityDto } from '@/modules/merchants/dto/create-merchant-activity.dto';
import type { CreateMerchantStoreDto } from '@/modules/merchants/dto/create-merchant-store.dto';
import type { CreateMerchantDto } from '@/modules/merchants/dto/create-merchant.dto';
import type { UpdateMerchantDto } from '@/modules/merchants/dto/update-merchant.dto';
import {
  FakeAuditService,
  FakeScopedRepository,
  FakeSequelize,
  FakeSessionService,
  actor,
  asAuditService,
  asScopedRepository,
  asSequelize,
  asSessionService,
  countryRow,
  merchantActivityRow,
  merchantRow,
  merchantStoreRow,
  portalUserRow,
  requestContext,
  tenantRow,
} from './support/merchants-doubles';

function newMerchantDto(overrides: Partial<CreateMerchantDto> = {}): CreateMerchantDto {
  return {
    merchantCode: 'M001',
    name: 'Acme Store',
    countryCode: 'MY',
    ...overrides,
  } as CreateMerchantDto;
}

function newStoreDto(overrides: Partial<CreateMerchantStoreDto> = {}): CreateMerchantStoreDto {
  return { storeCode: 'S001', name: 'Main Store', ...overrides } as CreateMerchantStoreDto;
}

function newActivityDto(
  overrides: Partial<CreateMerchantActivityDto> = {},
): CreateMerchantActivityDto {
  return { activityId: 50, ...overrides } as CreateMerchantActivityDto;
}

describe('MerchantsService', () => {
  let scoped: FakeScopedRepository;
  let sequelize: FakeSequelize;
  let audit: FakeAuditService;
  let sessions: FakeSessionService;
  let service: MerchantsService;

  beforeEach(() => {
    scoped = new FakeScopedRepository();
    sequelize = new FakeSequelize();
    audit = new FakeAuditService();
    sessions = new FakeSessionService();
    service = new MerchantsService(
      asSequelize(sequelize),
      asScopedRepository(scoped),
      asAuditService(audit),
      asSessionService(sessions),
    );

    // The two lookups `create()`/`update()`'s deactivation path always exercises.
    scoped.setByPk(Tenant, tenantRow());
    scoped.setByPk(Country, countryRow());
  });

  // --- list / getById -----------------------------------------------------------------------

  describe('list', () => {
    it('lists through ScopedRepository, so scope applies untouched (TC-8/TC-10)', async () => {
      scoped.setListRows(Merchant, [merchantRow()]);
      scoped.setCount(Merchant, 1);

      const { rows, meta } = await service.list({});

      expect(rows).toHaveLength(1);
      expect(meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    });

    it('defaults to name:asc when no sort is given', async () => {
      await service.list({});
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ order: [['name', 'ASC']] });
    });

    it('parses an explicit sort', async () => {
      await service.list({ sort: 'status:desc' });
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ order: [['status', 'DESC']] });
    });

    it('caps pageSize at 100 rather than rejecting a larger request', async () => {
      await service.list({ pageSize: 500 });
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ limit: 100 });
    });

    it('computes offset from page and pageSize', async () => {
      await service.list({ page: 3, pageSize: 10 });
      const call = scoped.callsTo('listAll')[0];
      expect(call.options).toMatchObject({ limit: 10, offset: 20 });
    });

    it('builds no where clause when search is absent (TC-21 baseline)', async () => {
      await service.list({});
      const call = scoped.callsTo('listAll')[0];
      expect((call.options as { where?: unknown }).where).toBeUndefined();
    });

    it('builds an OR/ILIKE clause on merchantCode and name when search is supplied (TC-21)', async () => {
      await service.list({ search: 'acme' });
      const call = scoped.callsTo('listAll')[0];
      const where = (call.options as { where?: unknown }).where as Record<symbol, unknown>;
      expect(where).toBeDefined();
      const orClause = Object.getOwnPropertySymbols(where).map((sym) => where[sym]);
      expect(orClause[0]).toEqual([
        { merchantCode: expect.anything() },
        { name: expect.anything() },
      ]);
    });

    it('ignores a blank search string, same as omitting it', async () => {
      await service.list({ search: '   ' });
      const call = scoped.callsTo('listAll')[0];
      expect((call.options as { where?: unknown }).where).toBeUndefined();
    });

    it('passes the same where to count as to listAll', async () => {
      await service.list({ search: 'acme' });
      const listWhere = (scoped.callsTo('listAll')[0].options as { where?: unknown }).where;
      const countWhere = (scoped.callsTo('count')[0].options as { where?: unknown }).where;
      expect(countWhere).toBe(listWhere);
    });
  });

  describe('getById', () => {
    it('returns the row scope allowed through', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 7 }));
      const dto = await service.getById(7);
      expect(dto.id).toBe(7);
    });

    it('404s — not found or out of scope, indistinguishable (TC-9/TC-11, 02-SECURITY.md §5.1)', async () => {
      scoped.setByPk(Merchant, null);
      const thrown: unknown = await service.getById(999).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(ScopeViolationError);
      expect((thrown as ScopeViolationError).getStatus()).toBe(404);
    });
  });

  describe('listActiveCampaigns', () => {
    it('404s before touching campaign_merchants when the merchant itself is out of scope', async () => {
      scoped.setByPk(Merchant, null);
      await expect(service.listActiveCampaigns(999)).rejects.toBeInstanceOf(ScopeViolationError);
      expect(scoped.callsTo('listAll').some((c) => c.model === CampaignMerchant.name)).toBe(false);
    });

    it('returns [] when the merchant has no active participation rows', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      scoped.setListRows(CampaignMerchant, []);
      await expect(service.listActiveCampaigns(1)).resolves.toEqual([]);
      expect(scoped.callsTo('listAll').some((c) => c.model === TenantCampaign.name)).toBe(false);
    });

    it('resolves participation rows to the campaigns themselves', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      scoped.setListRows(CampaignMerchant, [
        { id: 1, merchantId: 1, campaignId: 900, status: 'active' },
      ]);
      scoped.setListRows(TenantCampaign, [
        { id: 900, campaignCode: 'C900', name: 'Campaign 900', status: 'active' },
      ]);

      const rows = await service.listActiveCampaigns(1);
      expect(rows).toEqual([
        { id: 900, campaignCode: 'C900', name: 'Campaign 900', status: 'active' },
      ]);
    });
  });

  describe('listStores / listActivities', () => {
    it('listStores 404s for a merchant out of scope', async () => {
      scoped.setByPk(Merchant, null);
      await expect(service.listStores(999)).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it('listStores returns the merchant’s stores', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      scoped.setListRows(MerchantStore, [merchantStoreRow({ merchantId: 1 })]);
      const rows = await service.listStores(1);
      expect(rows).toHaveLength(1);
    });

    it('listActivities 404s for a merchant out of scope', async () => {
      scoped.setByPk(Merchant, null);
      await expect(service.listActivities(999)).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it('listActivities returns the merchant’s activity links', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      scoped.setListRows(MerchantActivity, [merchantActivityRow({ merchantId: 1 })]);
      const rows = await service.listActivities(1);
      expect(rows).toHaveLength(1);
    });
  });

  // --- create --------------------------------------------------------------------------------

  describe('create — negative authorisation (TC-6, TC-7, AGENT-PROTOCOL R6)', () => {
    it.each(['super_admin', 'country_admin', 'maker', 'checker', 'merchant'] as const)(
      '%s is denied — assertRole fires before any query, transaction included',
      async (role) => {
        await expect(
          service.create(
            actor({ role, tenantId: role === 'merchant' ? 10 : null }),
            newMerchantDto(),
          ),
        ).rejects.toBeInstanceOf(PermissionDeniedHttpException);

        expect(sequelize.transactionCalls).toBe(0);
        expect(scoped.calls).toHaveLength(0);
      },
    );
  });

  describe('create', () => {
    it('creates the merchant as tenant_admin (TC-1)', async () => {
      const result = await service.create(actor(), newMerchantDto());

      expect(result).toMatchObject({ merchantCode: 'M001', name: 'Acme Store', status: 'active' });

      const call = scoped.callsTo('create').find((c) => c.model === Merchant.name);
      expect(call?.values).toMatchObject({ status: 'active' });
    });

    it('never reads a tenantId off the dto — CreateMerchantDto has no such field to read (TC-2)', async () => {
      const dto = newMerchantDto();
      expect((dto as unknown as Record<string, unknown>)['tenantId']).toBeUndefined();
      await service.create(actor(), dto);
      const call = scoped.callsTo('create').find((c) => c.model === Merchant.name);
      expect((call?.values as Record<string, unknown> | undefined)?.['tenantId']).toBeUndefined();
      // tenant_id is instead forced by ScopedRepository.create from the actor's own scope —
      // scope-strategy.spec.ts / scoped.repository.spec.ts prove that mechanism already.
    });

    it('audits the created merchant id', async () => {
      await service.create(actor(), newMerchantDto());
      expect(audit.annotations[0]).toMatchObject({ targetId: expect.any(Number) });
    });

    it('validates countryCode against the tenant’s own country before writing (TC-5)', async () => {
      scoped.setByPk(Tenant, tenantRow({ countryId: 1 }));
      scoped.setByPk(Country, countryRow({ id: 1, code: 'MY' }));

      await expect(
        service.create(actor(), newMerchantDto({ countryCode: 'SG' })),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(scoped.callsTo('create').some((c) => c.model === Merchant.name)).toBe(false);
    });

    it('accepts a countryCode that matches the tenant’s own country', async () => {
      scoped.setByPk(Tenant, tenantRow({ countryId: 1 }));
      scoped.setByPk(Country, countryRow({ id: 1, code: 'MY' }));

      await expect(
        service.create(actor(), newMerchantDto({ countryCode: 'MY' })),
      ).resolves.toBeDefined();
    });

    it('rejects outright when the actor carries no tenantId — a defensive guard, ck_portal_users_scope should make this unreachable in practice', async () => {
      await expect(
        service.create(actor({ tenantId: null }), newMerchantDto()),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(scoped.callsTo('findByPkOrFail')).toHaveLength(0);
    });

    it('maps a duplicate merchantCode-in-tenant to 409 MERCHANT_CODE_EXISTS (TC-3)', async () => {
      scoped.failNextCreate(
        Merchant,
        new UniqueConstraintError({ message: 'uq_m_tenant_code' } as never),
      );

      await expect(service.create(actor(), newMerchantDto())).rejects.toBeInstanceOf(
        MerchantCodeExistsError,
      );
    });

    it('propagates any other failure from the merchant insert unchanged', async () => {
      scoped.failNextCreate(Merchant, new Error('unexpected database failure'));

      await expect(service.create(actor(), newMerchantDto())).rejects.toThrow(
        'unexpected database failure',
      );
    });
  });

  // --- update ------------------------------------------------------------------------------------

  describe('update — negative authorisation', () => {
    it('denies a non-tenant_admin before the merchant lookup', async () => {
      await expect(
        service.update(
          actor({ role: 'maker' }),
          1,
          { name: 'x' } as UpdateMerchantDto,
          requestContext(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.calls).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('404s for an id out of scope or absent', async () => {
      scoped.setByPk(Merchant, null);
      await expect(
        service.update(actor(), 999, { name: 'x' } as UpdateMerchantDto, requestContext()),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it('writes only the fields supplied, never merchantCode/tenantId/countryCode', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      await service.update(actor(), 1, { name: 'New Name' } as UpdateMerchantDto, requestContext());

      const call = scoped.callsTo('update')[0];
      expect(call.values).toEqual({ name: 'New Name' });
    });

    it('writes description, contactEmail, contactPhone and website individually when supplied', async () => {
      const fields: (keyof UpdateMerchantDto)[] = [
        'description',
        'contactEmail',
        'contactPhone',
        'website',
      ];
      for (const field of fields) {
        scoped.setByPk(Merchant, merchantRow({ id: 1 }));
        await service.update(
          actor(),
          1,
          { [field]: 'new-value' } as UpdateMerchantDto,
          requestContext(),
        );
        const call = scoped.callsTo('update').at(-1);
        expect(call?.values).toEqual({ [field]: 'new-value' });
      }
    });

    it('is a no-op write for an empty body, and never revokes sessions', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      await service.update(actor(), 1, {} as UpdateMerchantDto, requestContext());
      expect(scoped.callsTo('update')).toHaveLength(0);
      expect(sessions.revocations).toHaveLength(0);
    });

    it('the returned row reflects the write (fake update() mutates the fixture in place)', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1, name: 'Old' }));
      const updated = await service.update(
        actor(),
        1,
        { name: 'New' } as UpdateMerchantDto,
        requestContext(),
      );
      expect(updated.name).toBe('New');
    });

    it('audits the updated fields', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      await service.update(actor(), 1, { name: 'New' } as UpdateMerchantDto, requestContext());
      expect(audit.annotations[0]).toMatchObject({ targetId: 1, detail: { fields: ['name'] } });
    });

    it('maps a duplicate merchantCode conflict on update to 409 MERCHANT_CODE_EXISTS', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      scoped.failNextUpdate(
        Merchant,
        new UniqueConstraintError({ message: 'uq_m_tenant_code' } as never),
      );

      await expect(
        service.update(actor(), 1, { name: 'New' } as UpdateMerchantDto, requestContext()),
      ).rejects.toBeInstanceOf(MerchantCodeExistsError);
    });

    it('propagates a non-unique-constraint failure from the update unchanged', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      scoped.failNextUpdate(Merchant, new Error('unexpected database failure'));

      await expect(
        service.update(actor(), 1, { name: 'New' } as UpdateMerchantDto, requestContext()),
      ).rejects.toThrow('unexpected database failure');
    });

    // --- implementation note 7/8 — deactivation confirmation + session revocation ------------

    it('deactivating a merchant with no active campaigns needs no confirm (TC-20 negative case)', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1, status: 'active' }));
      scoped.setListRows(CampaignMerchant, []);

      await expect(
        service.update(actor(), 1, { status: 'inactive' } as UpdateMerchantDto, requestContext()),
      ).resolves.toMatchObject({ status: 'inactive' });
    });

    it('deactivating a merchant with an active campaign requires confirm (TC-20)', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1, status: 'active' }));
      scoped.setListRows(CampaignMerchant, [
        { id: 1, merchantId: 1, campaignId: 900, status: 'active' },
      ]);
      scoped.setListRows(TenantCampaign, [
        { id: 900, campaignCode: 'C900', name: 'Campaign 900', status: 'active' },
      ]);

      await expect(
        service.update(actor(), 1, { status: 'inactive' } as UpdateMerchantDto, requestContext()),
      ).rejects.toBeInstanceOf(MerchantDeactivationRequiresConfirmationError);
      expect(scoped.callsTo('update').some((c) => c.model === Merchant.name)).toBe(false);
    });

    it('confirm: true bypasses the check and deactivates anyway (TC-20)', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1, status: 'active' }));
      scoped.setListRows(CampaignMerchant, [
        { id: 1, merchantId: 1, campaignId: 900, status: 'active' },
      ]);
      scoped.setListRows(TenantCampaign, [
        { id: 900, campaignCode: 'C900', name: 'Campaign 900', status: 'active' },
      ]);

      await expect(
        service.update(
          actor(),
          1,
          { status: 'inactive', confirm: true } as UpdateMerchantDto,
          requestContext(),
        ),
      ).resolves.toMatchObject({ status: 'inactive' });
    });

    it('revokes every merchant-role session scoped to this merchant on deactivation (TC-20a)', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1, status: 'active' }));
      scoped.setListRows(CampaignMerchant, []);
      scoped.setListRows(PortalUser, [
        portalUserRow({ id: 501, merchantId: 1 }),
        portalUserRow({ id: 502, merchantId: 1 }),
      ]);

      const who = actor({ userId: 9 });
      const ctx = requestContext({ ipAddress: '198.51.100.9' });
      await service.update(who, 1, { status: 'inactive' } as UpdateMerchantDto, ctx);

      expect(sessions.revocations).toHaveLength(2);
      expect(sessions.revocations.map((r) => r.userId).sort()).toEqual([501, 502]);
      for (const revocation of sessions.revocations) {
        expect(revocation.reason).toBe('merchant_deactivated');
        expect(revocation.exceptSessionId).toBeNull();
        expect(revocation.actor).toEqual({ userId: 9, role: 'tenant_admin' });
        expect(revocation.context).toBe(ctx);
        expect(revocation.eventType).toBe('merchant_deactivated');
      }

      const usersCall = scoped.callsTo('listAll').find((c) => c.model === PortalUser.name);
      expect(usersCall?.options).toMatchObject({ where: { merchantId: 1, role: 'merchant' } });
    });

    it('activating (status: active) never revokes sessions', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1, status: 'inactive' }));
      scoped.setListRows(PortalUser, [portalUserRow({ id: 501 })]);

      await service.update(actor(), 1, { status: 'active' } as UpdateMerchantDto, requestContext());

      expect(sessions.revocations).toHaveLength(0);
    });

    it('setting status to the same value it already had does not revoke sessions', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1, status: 'suspended' }));
      scoped.setListRows(PortalUser, [portalUserRow({ id: 501 })]);

      await service.update(
        actor(),
        1,
        { status: 'suspended' } as UpdateMerchantDto,
        requestContext(),
      );

      expect(sessions.revocations).toHaveLength(0);
    });

    it('other fields changing alongside a non-status update never revoke sessions', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1, status: 'active' }));
      scoped.setListRows(PortalUser, [portalUserRow({ id: 501 })]);

      await service.update(actor(), 1, { name: 'Renamed' } as UpdateMerchantDto, requestContext());

      expect(sessions.revocations).toHaveLength(0);
    });
  });

  // --- createStore -----------------------------------------------------------------------------

  describe('createStore — negative authorisation', () => {
    it('denies a non-tenant_admin before the merchant lookup', async () => {
      await expect(
        service.createStore(actor({ role: 'maker' }), 1, newStoreDto()),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.calls).toHaveLength(0);
    });
  });

  describe('createStore', () => {
    it('404s for a merchant id out of scope or absent (TC-13)', async () => {
      scoped.setByPk(Merchant, null);
      await expect(service.createStore(actor(), 999, newStoreDto())).rejects.toBeInstanceOf(
        ScopeViolationError,
      );
    });

    it('creates the store linked to the merchant (TC-12)', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      const result = await service.createStore(actor(), 1, newStoreDto());
      expect(result).toMatchObject({ merchantId: 1, storeCode: 'S001', status: 'active' });
    });

    it('converts a supplied latitude/longitude to a string, and omits to null', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));

      await service.createStore(actor(), 1, newStoreDto({ latitude: 3.139, longitude: 101.6869 }));
      const withCoords = scoped.callsTo('create').find((c) => c.model === MerchantStore.name);
      expect(withCoords?.values).toMatchObject({ latitude: '3.139', longitude: '101.6869' });

      await service.createStore(actor(), 1, newStoreDto());
      const withoutCoords = scoped.callsTo('create')[scoped.callsTo('create').length - 1];
      expect(withoutCoords.values).toMatchObject({ latitude: null, longitude: null });
    });

    it('maps a duplicate storeCode to 409 MERCHANT_STORE_CODE_EXISTS', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      scoped.failNextCreate(
        MerchantStore,
        new UniqueConstraintError({ message: 'uq_ms_tenant_code' } as never),
      );

      await expect(service.createStore(actor(), 1, newStoreDto())).rejects.toBeInstanceOf(
        MerchantStoreCodeExistsError,
      );
    });

    it('propagates any other failure from the store insert unchanged', async () => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      scoped.failNextCreate(MerchantStore, new Error('unexpected database failure'));

      await expect(service.createStore(actor(), 1, newStoreDto())).rejects.toThrow(
        'unexpected database failure',
      );
    });
  });

  // --- createActivity --------------------------------------------------------------------------

  describe('createActivity — negative authorisation', () => {
    it('denies a non-tenant_admin before the merchant lookup', async () => {
      await expect(
        service.createActivity(actor({ role: 'merchant', merchantId: 1 }), 1, newActivityDto()),
      ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
      expect(scoped.calls).toHaveLength(0);
    });
  });

  describe('createActivity', () => {
    beforeEach(() => {
      scoped.setByPk(Merchant, merchantRow({ id: 1 }));
      scoped.setByPk(Activity, { id: 50, tenantId: 10 });
    });

    it('links a tenant-wide activity (storeId omitted) (TC-14)', async () => {
      const result = await service.createActivity(actor(), 1, newActivityDto());
      expect(result).toMatchObject({ merchantId: 1, activityId: 50, storeId: null });
    });

    it('rejects a second tenant-wide link for the same activity — service-level guard (TC-15)', async () => {
      scoped.setCount(MerchantActivity, 1);
      await expect(service.createActivity(actor(), 1, newActivityDto())).rejects.toBeInstanceOf(
        MerchantActivityAlreadyLinkedError,
      );
      expect(scoped.callsTo('create').some((c) => c.model === MerchantActivity.name)).toBe(false);
    });

    it('the service-level guard checks storeId IS NULL specifically', async () => {
      scoped.setCount(MerchantActivity, 0);
      await service.createActivity(actor(), 1, newActivityDto());
      const countCall = scoped.callsTo('count').find((c) => c.model === MerchantActivity.name);
      expect(countCall?.options).toMatchObject({
        where: { merchantId: 1, activityId: 50, storeId: null },
      });
    });

    it('links the same activity to a specific store — a different scope, correctly allowed (TC-16)', async () => {
      scoped.setCount(MerchantActivity, 1); // a tenant-wide link already exists
      scoped.setByPk(MerchantStore, merchantStoreRow({ id: 200, merchantId: 1 }));

      const result = await service.createActivity(actor(), 1, newActivityDto({ storeId: 200 }));
      expect(result).toMatchObject({ storeId: 200 });
      // the service-level NULL-only guard is never even consulted when storeId is supplied
      expect(scoped.callsTo('count').some((c) => c.model === MerchantActivity.name)).toBe(false);
    });

    it('rejects a store that belongs to a different merchant — 404, not found for this merchant', async () => {
      scoped.setByPk(MerchantStore, merchantStoreRow({ id: 200, merchantId: 2 }));

      await expect(
        service.createActivity(actor(), 1, newActivityDto({ storeId: 200 })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('404s for an activity id out of the actor’s tenant scope', async () => {
      scoped.setByPk(Activity, null);
      await expect(service.createActivity(actor(), 1, newActivityDto())).rejects.toBeInstanceOf(
        ScopeViolationError,
      );
    });

    it('maps a database-level duplicate (store-scoped) to 409 MERCHANT_ACTIVITY_ALREADY_LINKED', async () => {
      scoped.setByPk(MerchantStore, merchantStoreRow({ id: 200, merchantId: 1 }));
      scoped.failNextCreate(
        MerchantActivity,
        new UniqueConstraintError({ message: 'uq_ma_merchant_activity_store' } as never),
      );

      await expect(
        service.createActivity(actor(), 1, newActivityDto({ storeId: 200 })),
      ).rejects.toBeInstanceOf(MerchantActivityAlreadyLinkedError);
    });

    it('propagates any other failure from the activity-link insert unchanged', async () => {
      scoped.failNextCreate(MerchantActivity, new Error('unexpected database failure'));

      await expect(service.createActivity(actor(), 1, newActivityDto())).rejects.toThrow(
        'unexpected database failure',
      );
    });

    it('stores commissionRate as an exact two-decimal string (TC-19)', async () => {
      await service.createActivity(actor(), 1, newActivityDto({ commissionRate: 12.34 }));
      const call = scoped.callsTo('create').find((c) => c.model === MerchantActivity.name);
      expect((call?.values as Record<string, unknown> | undefined)?.['commissionRate']).toBe(
        '12.34',
      );
    });

    it('a whole-number commissionRate is stored with two decimals', async () => {
      await service.createActivity(actor(), 1, newActivityDto({ commissionRate: 50 }));
      const call = scoped.callsTo('create').find((c) => c.model === MerchantActivity.name);
      expect((call?.values as Record<string, unknown> | undefined)?.['commissionRate']).toBe(
        '50.00',
      );
    });

    it('omitting commissionRate stores null', async () => {
      await service.createActivity(actor(), 1, newActivityDto());
      const call = scoped.callsTo('create').find((c) => c.model === MerchantActivity.name);
      expect((call?.values as Record<string, unknown> | undefined)?.['commissionRate']).toBeNull();
    });

    it('audits the merchant id and the created link id', async () => {
      await service.createActivity(actor(), 1, newActivityDto());
      expect(audit.annotations[0]).toMatchObject({ targetId: 1 });
    });
  });
});
