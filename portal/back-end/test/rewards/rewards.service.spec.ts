/**
 * T-032 — `RewardsService` unit tests, against in-memory doubles (`support/rewards-doubles.ts`).
 * Same philosophy as `test/rules/rules.service.spec.ts` — proves the *decisions* this service
 * makes, not that Postgres answers correctly (T-013's own, already-proven job). The critical
 * cross-layer property (a misconfigured permission table cannot override this file's
 * `assertRole`) is proven for real, over HTTP, in `rewards.e2e-spec.ts`.
 */
import { UniqueConstraintError } from 'sequelize';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { NotFoundError } from '@/common/errors/app-error';
import { Country, RewardCountryAssignment, RewardPolicy, RewardSystem } from '@/database/models';
import { PortalUser } from '@/database/portal-models';
import { RewardsService } from '@/modules/rewards/rewards.service';
import {
  RewardHasCountryAssignmentsError,
  RewardInUseByCampaignError,
  RewardPolicyCodeExistsError,
  RewardSystemCodeExistsError,
} from '@/modules/rewards/rewards.errors';
import {
  FakeAuditService,
  FakeRewardConnectorConfigCrypto,
  FakeScopedRepository,
  FakeSequelize,
  actor,
  asAuditService,
  asRewardConnectorConfigCrypto,
  asScopedRepository,
  asSequelize,
  countryRow,
  portalUserRow,
  rewardCountryAssignmentRow,
  rewardPolicyRow,
  rewardSystemRow,
} from './support/rewards-doubles';

function buildService() {
  const scoped = new FakeScopedRepository();
  const sequelize = new FakeSequelize();
  const audit = new FakeAuditService();
  const crypto = new FakeRewardConnectorConfigCrypto();
  scoped.setByPk(PortalUser, portalUserRow());
  const service = new RewardsService(
    asSequelize(sequelize),
    asScopedRepository(scoped),
    asAuditService(audit),
    asRewardConnectorConfigCrypto(crypto),
  );
  return { service, scoped, sequelize, audit, crypto };
}

describe('RewardsService — reads', () => {
  it('list() forces tenantId: null and maps rows through toRewardListItemDto, with no connectorConfig key', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RewardSystem, [rewardSystemRow({ id: 7 })]);
    scoped.setCount(RewardSystem, 1);

    const { rows, meta } = await service.list({});

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(7);
    expect(rows[0]).not.toHaveProperty('connectorConfig');
    expect(meta).toEqual({ page: 1, pageSize: 20, total: 1 });

    const [call] = scoped.callsTo('listAll');
    expect((call.options as { where: Record<string, unknown> }).where).toMatchObject({
      tenantId: null,
    });
  });

  it('list() applies a status filter and caps pageSize at MAX_PAGE_SIZE', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RewardSystem, []);
    scoped.setCount(RewardSystem, 0);

    await service.list({ status: 'inactive', pageSize: 500 });

    const [call] = scoped.callsTo('listAll');
    const options = call.options as { where: Record<string, unknown>; limit: number };
    expect(options.where).toMatchObject({ tenantId: null, status: 'inactive' });
    expect(options.limit).toBe(100);
  });

  it('list() honours an explicit sort field/direction', async () => {
    const { service, scoped } = buildService();
    scoped.setListRows(RewardSystem, []);
    scoped.setCount(RewardSystem, 0);

    await service.list({ sort: 'systemCode:desc' });

    const [call] = scoped.callsTo('listAll');
    const options = call.options as { order: unknown };
    expect(options.order).toEqual([['systemCode', 'DESC']]);
  });

  it('getById() 404s via ScopedRepository when the row is absent or out of scope', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, null);
    await expect(service.getById(999)).rejects.toThrow();
  });

  it('getById() decrypts and masks connectorConfig via the crypto helper (TC-12)', async () => {
    const { service, scoped, crypto } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 5, connectorConfig: { __enc: 'v1.x' } }));
    crypto.decryptResult = { apiKey: 'sk_live_1234' };

    const dto = await service.getById(5);

    expect(crypto.decryptForRowCalls).toEqual([{ id: 5, stored: { __enc: 'v1.x' } }]);
    expect(dto.connectorConfigPreview).toEqual({ apiKey: '••••1234' });
  });

  it('getById() masks a short (<=4 char) or non-string connectorConfig value in full — no partial reveal', async () => {
    const { service, scoped, crypto } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 6, connectorConfig: { __enc: 'v1.x' } }));
    crypto.decryptResult = { pin: '12', timeoutMs: 5000, retry: true };

    const dto = await service.getById(6);

    expect(dto.connectorConfigPreview).toEqual({ pin: '••••', timeoutMs: '••••', retry: '••••' });
  });

  it('getById() returns connectorConfig: null when nothing was ever set', async () => {
    const { service, scoped, crypto } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 5 }));
    crypto.decryptResult = null;

    const dto = await service.getById(5);

    expect(dto.connectorConfigPreview).toBeNull();
  });

  it('listCountryAssignments() maps assignment rows with their country', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setListRows(RewardCountryAssignment, [
      rewardCountryAssignmentRow({
        rewardId: 1,
        countryId: 2,
        country: countryRow({ id: 2, code: 'SG', name: 'Singapore' }),
      }),
    ]);

    const rows = await service.listCountryAssignments(1);

    expect(rows).toHaveLength(1);
    expect(rows[0].countryCode).toBe('SG');
  });
});

describe('RewardsService.create — layers 2 and 3', () => {
  it('refuses a non-super_admin before any query runs (layer 2)', async () => {
    const { service, scoped } = buildService();
    await expect(
      service.create(actor({ role: 'maker' }), {
        systemCode: 'X',
        name: 'x',
        rewardType: 'monetary',
        connectorType: 'internal_api',
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);

    expect(scoped.calls).toHaveLength(0);
  });

  it('writes tenant_id = NULL explicitly (layer 3), never inferred from the actor', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1000 }));

    await service.create(actor(), {
      systemCode: 'CASHBACK',
      name: ' Padded ',
      rewardType: 'monetary',
      connectorType: 'internal_api',
    });

    const [call] = scoped.callsTo('create');
    expect((call.values as { tenantId: unknown }).tenantId).toBeNull();
    expect((call.values as { name: string }).name).toBe('Padded');
    expect((call.values as { status: string }).status).toBe('active');
    expect((call.values as { deliveryMode: string }).deliveryMode).toBe('realtime');
  });

  it('refuses a systemCode already used by another global reward, checked before the insert (TC-16)', async () => {
    const { service, scoped } = buildService();
    scoped.setCount(RewardSystem, 1);

    await expect(
      service.create(actor(), {
        systemCode: 'DUP',
        name: 'x',
        rewardType: 'monetary',
        connectorType: 'internal_api',
      }),
    ).rejects.toBeInstanceOf(RewardSystemCodeExistsError);
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('maps a unique-constraint violation to RewardSystemCodeExistsError (TC-16)', async () => {
    const { service, scoped } = buildService();
    scoped.failNextCreate(RewardSystem, new UniqueConstraintError({}));

    await expect(
      service.create(actor(), {
        systemCode: 'DUP',
        name: 'x',
        rewardType: 'monetary',
        connectorType: 'internal_api',
      }),
    ).rejects.toBeInstanceOf(RewardSystemCodeExistsError);
  });

  it('re-throws any other error from the insert untouched', async () => {
    const { service, scoped } = buildService();
    const boom = new Error('boom');
    scoped.failNextCreate(RewardSystem, boom);

    await expect(
      service.create(actor(), {
        systemCode: 'X',
        name: 'x',
        rewardType: 'monetary',
        connectorType: 'internal_api',
      }),
    ).rejects.toBe(boom);
  });

  it('encrypts connectorConfig via a provisional envelope, then rebinds it to the real id, inside one transaction (TC-10)', async () => {
    const { service, scoped, sequelize, crypto } = buildService();
    // `FakeScopedRepository.create()` mints its own id (1000, its documented default) — the same
    // fixture shape `rules.service.spec.ts` uses for the identical reason: the row this create
    // actually returns is what `rebindToRow` must be called with, not a value asserted in
    // advance by `setByPk`.
    scoped.setByPk(
      RewardSystem,
      rewardSystemRow({ id: 1000, connectorConfig: { __enc: 'bound:1000:rebound' } }),
    );

    await service.create(actor(), {
      systemCode: 'X',
      name: 'x',
      rewardType: 'monetary',
      connectorType: 'internal_api',
      connectorConfig: { apiKey: 'sk_live_1234' },
    });

    expect(sequelize.transactionCalls).toBe(1);
    expect(crypto.encryptForNewRowCalls).toEqual([{ apiKey: 'sk_live_1234' }]);
    expect(crypto.rebindToRowCalls).toHaveLength(1);
    expect(crypto.rebindToRowCalls[0]?.id).toBe(1000);

    const updateCall = scoped.callsTo('update')[0];
    expect((updateCall.values as { connectorConfig: unknown }).connectorConfig).toEqual({
      __enc: 'bound:1000:rebound',
    });
  });

  it('never touches the crypto helper when connectorConfig is omitted', async () => {
    const { service, scoped, crypto } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 42 }));

    await service.create(actor(), {
      systemCode: 'X',
      name: 'x',
      rewardType: 'monetary',
      connectorType: 'internal_api',
    });

    expect(crypto.encryptForNewRowCalls).toHaveLength(0);
    expect(crypto.rebindToRowCalls).toHaveLength(0);
    expect(scoped.callsTo('update')).toHaveLength(0);
  });

  it('annotates the audit draft with the new reward id, never the connector config', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 42 }));

    await service.create(actor(), {
      systemCode: 'X',
      name: 'x',
      rewardType: 'monetary',
      connectorType: 'internal_api',
      connectorConfig: { apiKey: 'secret' },
    });

    expect(audit.annotations[0]).toMatchObject({ targetId: 1000 });
    expect(JSON.stringify(audit.annotations[0])).not.toContain('secret');
  });
});

describe('RewardsService.update — layers 2 and 3, TC-13', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.update(actor({ role: 'country_admin' }), 1, { name: 'x' }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('only writes the fields the caller supplied, never systemCode, and audits a field diff', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1, name: 'Before' }));

    await service.update(actor(), 1, { name: 'After' });

    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({ name: 'After' });
    expect(audit.diffFieldsCalls).toHaveLength(1);
    expect(audit.annotations[0]?.targetId).toBe(1);
  });

  it('writes description alongside name', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));

    await service.update(actor(), 1, { description: 'A new description' });

    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({ description: 'A new description' });
  });

  it('excludes connectorConfig from the audited field diff — records only that it changed (TC-13)', async () => {
    const { service, scoped, audit, crypto } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));

    await service.update(actor(), 1, { connectorConfig: { apiKey: 'sk_live_9999' } });

    expect(crypto.encryptForRowCalls).toEqual([{ id: 1, config: { apiKey: 'sk_live_9999' } }]);
    const [call] = scoped.callsTo('update');
    expect((call.values as { connectorConfig: unknown }).connectorConfig).toEqual({
      __enc: 'bound:1:{"apiKey":"sk_live_9999"}',
    });

    // Every diffFields() call compares snapshots built from `fieldSnapshot()`, which never
    // includes `connectorConfig` — so no diff call, and therefore no audit annotation, can ever
    // carry the plaintext or ciphertext value.
    for (const call of audit.diffFieldsCalls) {
      expect(call.before).not.toHaveProperty('connectorConfig');
      expect(call.after).not.toHaveProperty('connectorConfig');
    }
    expect(audit.annotations[0]?.detail).toMatchObject({ connectorConfigChanged: true });
    expect(JSON.stringify(audit.annotations[0])).not.toContain('sk_live_9999');
  });

  it('connectorConfigChanged is false when connectorConfig was not supplied', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));

    await service.update(actor(), 1, { name: 'After' });

    expect(audit.annotations[0]?.detail).toMatchObject({ connectorConfigChanged: false });
  });

  it('writes every supplied field — rewardType, deliveryMode, connectorType and status alike', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));

    await service.update(actor(), 1, {
      rewardType: 'points',
      deliveryMode: 'batch',
      connectorType: 'webhook',
      status: 'inactive',
    });

    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({
      rewardType: 'points',
      deliveryMode: 'batch',
      connectorType: 'webhook',
      status: 'inactive',
    });
  });

  it('writes every remaining supplied field — maintenanceWindowEnabled, maintenanceSchedule, retryEnabled, retryConfig and merchantId alike', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));

    await service.update(actor(), 1, {
      maintenanceWindowEnabled: true,
      maintenanceSchedule: { start: '02:00' },
      retryEnabled: false,
      retryConfig: { maxAttempts: 5 },
      merchantId: 7,
    });

    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({
      maintenanceWindowEnabled: true,
      maintenanceSchedule: { start: '02:00' },
      retryEnabled: false,
      retryConfig: { maxAttempts: 5 },
      merchantId: 7,
    });
  });

  it('skips the UPDATE entirely when nothing changed', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));

    await service.update(actor(), 1, {});

    expect(scoped.callsTo('update')).toHaveLength(0);
  });
});

describe('RewardsService.remove — layers 2 and 3, TC-20', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(service.remove(actor({ role: 'maker' }), 1)).rejects.toBeInstanceOf(
      PermissionDeniedHttpException,
    );
  });

  it('refuses when the reward still holds a country assignment, listing the country ids', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setListRows(RewardCountryAssignment, [
      rewardCountryAssignmentRow({ countryId: 2 }),
      rewardCountryAssignmentRow({ countryId: 3 }),
    ]);

    const error: unknown = await service.remove(actor(), 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RewardHasCountryAssignmentsError);
    expect((error as RewardHasCountryAssignmentsError).details).toEqual([
      { field: 'countryId', code: 'COUNTRY_2' },
      { field: 'countryId', code: 'COUNTRY_3' },
    ]);
    expect(scoped.callsTo('destroy')).toHaveLength(0);
  });

  it('destroys the row when no assignment remains', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setListRows(RewardCountryAssignment, []);

    await service.remove(actor(), 1);

    expect(scoped.callsTo('destroy')).toHaveLength(1);
    expect(audit.annotations[0]?.targetId).toBe(1);
  });
});

describe('RewardsService.assignToCountry — layers 2 and 3, TC-7/TC-8', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.assignToCountry(actor({ role: 'country_admin' }), 1, { countryId: 1 }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('writes assignedBy from the actor’s admin_users bridge, never the body/never the raw portal user id (R3)', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(Country, countryRow({ id: 2 }));
    scoped.setByPk(PortalUser, portalUserRow({ id: 77, adminUserId: 501 }));
    scoped.setCount(RewardCountryAssignment, 0);
    scoped.setFindOneResult(
      RewardCountryAssignment,
      rewardCountryAssignmentRow({ id: 900, rewardId: 1, countryId: 2 }),
    );

    await service.assignToCountry(actor({ userId: 77 }), 1, { countryId: 2 });

    const [call] = scoped.callsTo('create');
    expect((call.values as { assignedBy: number }).assignedBy).toBe(501);
  });

  it('falls back to assignedBy: null when the actor has no admin_users bridge', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(Country, countryRow({ id: 2 }));
    scoped.setByPk(PortalUser, portalUserRow({ id: 77, adminUserId: null }));
    scoped.setCount(RewardCountryAssignment, 0);
    scoped.setFindOneResult(
      RewardCountryAssignment,
      rewardCountryAssignmentRow({ id: 900, rewardId: 1, countryId: 2 }),
    );

    await service.assignToCountry(actor({ userId: 77 }), 1, { countryId: 2 });

    const [call] = scoped.callsTo('create');
    expect((call.values as { assignedBy: number | null }).assignedBy).toBeNull();
  });

  it('is idempotent — an existing assignment is returned rather than duplicated', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(Country, countryRow({ id: 2 }));
    scoped.setCount(RewardCountryAssignment, 1);
    scoped.setFindOneResult(
      RewardCountryAssignment,
      rewardCountryAssignmentRow({ id: 900, rewardId: 1, countryId: 2 }),
    );

    const result = await service.assignToCountry(actor(), 1, { countryId: 2 });

    expect(result.id).toBe(900);
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('a concurrent insert (uq_rewa_country_assignments) is treated as a successful assign, not a 409', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(Country, countryRow({ id: 2 }));
    scoped.setCount(RewardCountryAssignment, 0);
    scoped.setFindOneResult(
      RewardCountryAssignment,
      rewardCountryAssignmentRow({ id: 901, rewardId: 1, countryId: 2 }),
    );
    scoped.failNextCreate(RewardCountryAssignment, new UniqueConstraintError({}));

    const result = await service.assignToCountry(actor(), 1, { countryId: 2 });

    expect(result.id).toBe(901);
    expect(audit.annotations[0]?.targetId).toBe(901);
  });

  it('re-throws any other error from the assignment insert untouched', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(Country, countryRow({ id: 2 }));
    scoped.setCount(RewardCountryAssignment, 0);
    const boom = new Error('boom');
    scoped.failNextCreate(RewardCountryAssignment, boom);

    await expect(service.assignToCountry(actor(), 1, { countryId: 2 })).rejects.toBe(boom);
  });
});

describe('RewardsService.unassignFromCountry — layers 2 and 3, TC-9', () => {
  it('refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.unassignFromCountry(actor({ role: 'checker' }), 1, 2),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('refuses when an active campaign is bound to the reward in that country (TC-9)', async () => {
    const { service, scoped, sequelize } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setFindOneResult(
      RewardCountryAssignment,
      rewardCountryAssignmentRow({ id: 900, rewardId: 1, countryId: 2 }),
    );
    sequelize.setQueryResult([{ id: 55, name: 'Raya 2026' }]);

    const error: unknown = await service
      .unassignFromCountry(actor(), 1, 2)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RewardInUseByCampaignError);
    expect((error as RewardInUseByCampaignError).details).toEqual([
      { field: 'campaignId', code: 'CAMPAIGN_55' },
    ]);
    expect(scoped.callsTo('destroy')).toHaveLength(0);
  });

  it('destroys the assignment when no campaign is bound', async () => {
    const { service, scoped, sequelize, audit } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setFindOneResult(
      RewardCountryAssignment,
      rewardCountryAssignmentRow({ id: 900, rewardId: 1, countryId: 2 }),
    );
    sequelize.setQueryResult([]);

    await service.unassignFromCountry(actor(), 1, 2);

    expect(scoped.callsTo('destroy')).toHaveLength(1);
    expect(audit.annotations[0]?.targetId).toBe(900);
  });
});

describe('RewardsService — reward_policies, TC-17/TC-18', () => {
  it('listPolicies() scopes by rewardSystemId', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setListRows(RewardPolicy, [rewardPolicyRow({ rewardSystemId: 1 })]);

    const rows = await service.listPolicies(1);

    expect(rows).toHaveLength(1);
    const [call] = scoped.callsTo('listAll');
    expect((call.options as { where: Record<string, unknown> }).where).toEqual({
      rewardSystemId: 1,
    });
  });

  it('createPolicy() refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.createPolicy(actor({ role: 'maker' }), 1, { policyCode: 'X', name: 'x' }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('createPolicy() refuses a duplicate policyCode on the same reward (TC-18)', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setCount(RewardPolicy, 1);

    await expect(
      service.createPolicy(actor(), 1, { policyCode: 'DUP', name: 'x' }),
    ).rejects.toBeInstanceOf(RewardPolicyCodeExistsError);
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('createPolicy() maps a unique-constraint violation to RewardPolicyCodeExistsError', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.failNextCreate(RewardPolicy, new UniqueConstraintError({}));

    await expect(
      service.createPolicy(actor(), 1, { policyCode: 'DUP', name: 'x' }),
    ).rejects.toBeInstanceOf(RewardPolicyCodeExistsError);
  });

  it('createPolicy() re-throws any other error from the insert untouched', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    const boom = new Error('boom');
    scoped.failNextCreate(RewardPolicy, boom);

    await expect(service.createPolicy(actor(), 1, { policyCode: 'X', name: 'x' })).rejects.toBe(
      boom,
    );
  });

  it('createPolicy() links the policy to the reward system (TC-17)', async () => {
    const { service, scoped, audit } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));

    const dto = await service.createPolicy(actor(), 1, { policyCode: 'STD', name: ' Standard ' });

    const [call] = scoped.callsTo('create');
    expect((call.values as { rewardSystemId: number }).rewardSystemId).toBe(1);
    expect((call.values as { name: string }).name).toBe('Standard');
    expect(dto.rewardSystemId).toBe(1);
    expect(audit.annotations[0]?.detail).toMatchObject({ rewardId: 1, policyCode: 'STD' });
  });

  it('updatePolicy() refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.updatePolicy(actor({ role: 'maker' }), 1, 10, { name: 'x' }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('updatePolicy() writes only the supplied fields, scoped to the reward system', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(RewardPolicy, rewardPolicyRow({ id: 10, rewardSystemId: 1 }));

    await service.updatePolicy(actor(), 1, 10, { status: 'inactive' });

    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({ status: 'inactive' });
    expect((call.options as { where: Record<string, unknown> }).where).toEqual({
      id: 10,
      rewardSystemId: 1,
    });
  });

  it('updatePolicy() writes name, description and config alike', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(RewardPolicy, rewardPolicyRow({ id: 10, rewardSystemId: 1 }));

    await service.updatePolicy(actor(), 1, 10, {
      name: ' Renamed ',
      description: 'New description',
      config: { tierMultiplier: 2 },
    });

    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({
      name: 'Renamed',
      description: 'New description',
      config: { tierMultiplier: 2 },
    });
  });
});

describe('RewardsService — reward_policy_caps, implementation note 5', () => {
  it('listPolicyCaps() reads through the raw repository, scoped by policy id', async () => {
    const { service, scoped, sequelize } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(RewardPolicy, rewardPolicyRow({ id: 10, rewardSystemId: 1 }));
    sequelize.setQueryResult([
      {
        id: 1,
        reward_policy_id: 10,
        cap_type: 'per_customer',
        frequency_value: 1,
        frequency_unit: 'day',
        max_occurrences: 3,
        max_total_amount: '50.0000',
        status: 'active',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const rows = await service.listPolicyCaps(1, 10);

    expect(rows).toHaveLength(1);
    expect(rows[0].maxTotalAmount).toBe(50);
    expect(sequelize.queryCalls[0]?.statement).toContain('reward_policy_caps');
  });

  it('createPolicyCap() refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.createPolicyCap(actor({ role: 'maker' }), 1, 10, { capType: 'per_customer' }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('createPolicyCap() inserts scoped to the resolved policy id, and audits it', async () => {
    const { service, scoped, sequelize, audit } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(RewardPolicy, rewardPolicyRow({ id: 10, rewardSystemId: 1 }));
    sequelize.setQueryResult([
      {
        id: 5,
        reward_policy_id: 10,
        cap_type: 'per_customer',
        frequency_value: null,
        frequency_unit: null,
        max_occurrences: null,
        max_total_amount: null,
        status: 'active',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const dto = await service.createPolicyCap(actor(), 1, 10, { capType: 'per_customer' });

    expect(dto.rewardPolicyId).toBe(10);
    expect(sequelize.queryCalls[0]?.statement).toContain(
      'INSERT INTO reward_config.reward_policy_caps',
    );
    expect(audit.annotations[0]?.detail).toMatchObject({ rewardId: 1, policyId: 10 });
  });

  it('updatePolicyCap() 404s when the cap does not belong to the resolved policy', async () => {
    const { service, scoped, sequelize } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(RewardPolicy, rewardPolicyRow({ id: 10, rewardSystemId: 1 }));
    sequelize.setQueryResult([]);

    await expect(
      service.updatePolicyCap(actor(), 1, 10, 999, { status: 'inactive' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('updatePolicyCap() refuses a non-super_admin (layer 2)', async () => {
    const { service } = buildService();
    await expect(
      service.updatePolicyCap(actor({ role: 'maker' }), 1, 10, 5, { status: 'inactive' }),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);
  });

  it('updatePolicyCap() 404s when the row disappears between the read and the write (a concurrent delete)', async () => {
    const scoped = new FakeScopedRepository();
    scoped.setByPk(PortalUser, portalUserRow());
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(RewardPolicy, rewardPolicyRow({ id: 10, rewardSystemId: 1 }));

    const capRow = {
      id: 5,
      reward_policy_id: 10,
      cap_type: 'per_customer',
      frequency_value: null,
      frequency_unit: null,
      max_occurrences: null,
      max_total_amount: null,
      status: 'active',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    };
    let queryCount = 0;
    const raceSequelize = {
      // First call is `findRewardPolicyCap` (succeeds); second is `updateRewardPolicyCap`,
      // which finds the row gone — a genuine race this service must answer 404 for, not 500.
      query: jest.fn(() => Promise.resolve(queryCount++ === 0 ? [capRow] : [])),
      transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    };

    const service = new RewardsService(
      asSequelize(raceSequelize as unknown as FakeSequelize),
      asScopedRepository(scoped),
      asAuditService(new FakeAuditService()),
      asRewardConnectorConfigCrypto(new FakeRewardConnectorConfigCrypto()),
    );

    await expect(
      service.updatePolicyCap(actor(), 1, 10, 5, { status: 'inactive' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('updatePolicyCap() writes only the supplied fields and audits it', async () => {
    const { service, scoped, sequelize, audit } = buildService();
    scoped.setByPk(RewardSystem, rewardSystemRow({ id: 1 }));
    scoped.setByPk(RewardPolicy, rewardPolicyRow({ id: 10, rewardSystemId: 1 }));
    sequelize.setQueryResult([
      {
        id: 5,
        reward_policy_id: 10,
        cap_type: 'per_customer',
        frequency_value: 2,
        frequency_unit: 'week',
        max_occurrences: 4,
        max_total_amount: '75.0000',
        status: 'inactive',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const dto = await service.updatePolicyCap(actor(), 1, 10, 5, {
      frequencyValue: 2,
      frequencyUnit: 'week',
      maxOccurrences: 4,
      maxTotalAmount: 75,
      status: 'inactive',
    });

    expect(dto.status).toBe('inactive');
    expect(dto.maxTotalAmount).toBe(75);
    const updateCall = sequelize.queryCalls.find((call) =>
      call.statement.includes('UPDATE reward_config.reward_policy_caps'),
    );
    expect(updateCall).toBeDefined();
    expect(audit.annotations[0]?.detail).toMatchObject({ rewardId: 1, policyId: 10 });
  });
});
