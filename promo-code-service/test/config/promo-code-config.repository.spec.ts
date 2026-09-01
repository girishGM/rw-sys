/**
 * T-PC-010. `PromoCodeConfigRepository` — scoped-query and typed-conflict-error behaviour,
 * run against the real Postgres 16 server (root `CLAUDE.md`), connected as the real
 * `promo_code_app` role (`test/config/support/app-connection.ts`), same real-DB style
 * `test/database/migrations.spec.ts` (T-PC-002) already established.
 *
 * TC-1..TC-5, TC-7, TC-8, TC-14 (business-logic + audit-trail behaviour) live in
 * `promo-code-config.service.spec.ts` instead — this file covers TC-6, TC-9..TC-13 plus
 * `AGENT-PROTOCOL.md`/task verification steps 3 and 4, all of which are properties only a real
 * scoped SQL query (not a mocked repository) can actually prove.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize-typescript';
import { createAppTestConnection } from './support/app-connection';
import {
  PromoCodeConfigRepository,
  type CreatePromoCodeConfigData,
} from '@/modules/promo-code-config/promo-code-config.repository';
import { ConfigNameConflictError } from '@/modules/promo-code-config/promo-code-config.errors';

const ACTOR_ID = randomUUID();

function baseData(overrides: Partial<CreatePromoCodeConfigData> = {}): CreatePromoCodeConfigData {
  return {
    merchantId: null,
    name: `t-pc-010 config ${randomUUID()}`,
    codePrefix: null,
    codePostfix: null,
    codeLength: 8,
    characterSet: 'ALPHANUMERIC',
    excludeAmbiguousChars: true,
    rewardValueType: 'FIXED_AMOUNT',
    rewardValue: 10,
    rewardUnit: 'USD',
    maxRedemptionsPerCode: 1,
    codeExpiryDays: null,
    createdBy: ACTOR_ID,
    ...overrides,
  };
}

describe('T-PC-010 — PromoCodeConfigRepository', () => {
  let sequelize: Sequelize;
  let repository: PromoCodeConfigRepository;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    sequelize = createAppTestConnection();
    await sequelize.authenticate();
    repository = new PromoCodeConfigRepository(sequelize);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_config_audit
           WHERE promo_code_config_id IN (
             SELECT id FROM promo_code.promo_code_config WHERE tenant_id = :tenantId
           )`,
        { replacements: { tenantId } },
      );
      await sequelize.query(
        'DELETE FROM promo_code.promo_code_config WHERE tenant_id = :tenantId',
        {
          replacements: { tenantId },
        },
      );
    }
    await sequelize.close();
  });

  function freshTenant(): string {
    const id = randomUUID();
    tenantIds.push(id);
    return id;
  }

  // TC-6
  it('TC-6: a second create with the same (tenantId, name) rejects with a typed conflict error, not a raw DB exception', async () => {
    const tenantId = freshTenant();
    const name = `t-pc-010 dup ${randomUUID()}`;
    await repository.create(tenantId, baseData({ name }));

    let caught: unknown;
    try {
      await repository.create(tenantId, baseData({ name }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigNameConflictError);
    // Not the raw driver exception (implementation note 6) — the typed error is the only
    // thing that ever crosses this repository's boundary for this failure mode.
    expect((caught as { name?: string }).name).not.toBe('SequelizeUniqueConstraintError');
  });

  // TC-9 / verification step 3
  it("TC-9: findById scoped to a tenant that does not own the row returns null, never the other tenant's row", async () => {
    const ownerTenant = freshTenant();
    const otherTenant = freshTenant();
    const created = await repository.create(ownerTenant, baseData());

    const result = await repository.findById(otherTenant, created.id);
    expect(result).toBeNull();
  });

  // TC-10
  it('TC-10: list scoped to tenantId with merchantId omitted returns tenant-wide configs only', async () => {
    const tenantId = freshTenant();
    const tenantWide = await repository.create(tenantId, baseData({ merchantId: null }));
    await repository.create(tenantId, baseData({ merchantId: randomUUID() }));

    const results = await repository.list(tenantId);
    expect(results.map((r) => r.id)).toEqual([tenantWide.id]);
    expect(results.every((r) => r.merchantId === null)).toBe(true);
  });

  // TC-11
  it("TC-11: list scoped to tenantId + merchantId returns both tenant-wide and that merchant's own configs", async () => {
    const tenantId = freshTenant();
    const merchantId = randomUUID();
    const tenantWide = await repository.create(tenantId, baseData({ merchantId: null }));
    const merchantOwn = await repository.create(tenantId, baseData({ merchantId }));
    await repository.create(tenantId, baseData({ merchantId: randomUUID() })); // a different merchant

    const results = await repository.list(tenantId, { merchantId });
    expect(results.map((r) => r.id).sort()).toEqual([tenantWide.id, merchantOwn.id].sort());
  });

  // TC-12
  it('TC-12: list with status filter defaulted only returns ACTIVE configs', async () => {
    const tenantId = freshTenant();
    const active = await repository.create(tenantId, baseData());
    const toArchive = await repository.create(tenantId, baseData());
    await repository.archive(tenantId, toArchive.id, ACTOR_ID);

    const results = await repository.list(tenantId);
    expect(results.map((r) => r.id)).toEqual([active.id]);
    expect(results.every((r) => r.status === 'ACTIVE')).toBe(true);
  });

  // TC-13
  it('TC-13: update scoped to a different (spoofed) tenantId returns not-found and never applies the update', async () => {
    const ownerTenant = freshTenant();
    const spoofedTenant = freshTenant();
    const created = await repository.create(ownerTenant, baseData({ name: 'original name' }));

    const result = await repository.update(
      spoofedTenant,
      created.id,
      { name: 'attacker-supplied name' },
      ACTOR_ID,
    );
    expect(result).toBeNull();

    const stillOriginal = await repository.findById(ownerTenant, created.id);
    expect(stillOriginal?.name).toBe('original name');
  });

  // Adjacent behaviour: `update` with an empty data object is a safe passthrough (returns the
  // current row rather than issuing a no-op `SET` with zero assignments).
  it('adjacent behaviour: update with no fields returns the current row unchanged', async () => {
    const tenantId = freshTenant();
    const created = await repository.create(tenantId, baseData({ name: 'unchanged name' }));

    const result = await repository.update(tenantId, created.id, {}, ACTOR_ID);
    expect(result?.name).toBe('unchanged name');
  });

  // Adjacent behaviour: `update` also translates a unique-violation into the same typed error
  // `create` does (implementation note 6 applies to both write paths, not just insert).
  it("adjacent behaviour: update that collides with another config's name rejects with ConfigNameConflictError", async () => {
    const tenantId = freshTenant();
    const takenName = `t-pc-010 taken ${randomUUID()}`;
    await repository.create(tenantId, baseData({ name: takenName }));
    const other = await repository.create(tenantId, baseData());

    await expect(
      repository.update(tenantId, other.id, { name: takenName }, ACTOR_ID),
    ).rejects.toBeInstanceOf(ConfigNameConflictError);
  });

  // Adjacent behaviour: a non-uniqueness DB error (e.g. a CHECK-constraint violation) is
  // rethrown as-is, not misclassified as a name conflict — `translateUniqueViolation`'s "no
  // match" fallback.
  it('adjacent behaviour: a non-uniqueness DB error is rethrown unchanged, not misclassified as a conflict', async () => {
    const tenantId = freshTenant();
    let caught: unknown;
    try {
      await repository.create(tenantId, baseData({ codeLength: 3 }));
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(ConfigNameConflictError);
    expect(String((caught as Error).message)).toMatch(/code_length/);
  });

  // Adjacent behaviour: `archive` on an id that doesn't resolve for the given tenant (wrong
  // tenant or nonexistent id) returns null, the same "not found" shape every other scoped
  // write method uses.
  it('adjacent behaviour: archive on a non-resolving (tenantId, id) pair returns null', async () => {
    const tenantId = freshTenant();
    const result = await repository.archive(tenantId, randomUUID(), ACTOR_ID);
    expect(result).toBeNull();
  });

  // Verification step 4
  it('verification step 4: every generated `list` query is tenant_id-scoped, no unscoped query path exists', async () => {
    const capturedQueries: string[] = [];
    const loggingSequelize = createAppTestConnection((sql) => capturedQueries.push(sql));
    const loggingRepository = new PromoCodeConfigRepository(loggingSequelize);
    try {
      const tenantId = freshTenant();
      await loggingRepository.list(tenantId);
      expect(capturedQueries.length).toBeGreaterThan(0);
      expect(capturedQueries.every((sql) => sql.includes('tenant_id'))).toBe(true);
    } finally {
      await loggingSequelize.close();
    }
  });
});
