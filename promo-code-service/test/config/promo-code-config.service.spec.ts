/**
 * T-PC-010. `PromoCodeConfigService` — cross-field validation, structural (DTO-level)
 * rejection, and the create/update/archive → audit-row behaviour (implementation note 5), run
 * against the real Postgres 16 server as the real `promo_code_app` role — same real-DB
 * convention as `promo-code-config.repository.spec.ts` and `test/database/migrations.spec.ts`
 * (T-PC-002), rather than mocking the repository layer, per `AGENT-PROTOCOL.md` §3's "assert
 * the observable property, not the implementation string": a mocked repository could never
 * actually prove a rejected create "never reached the DB" (TC-5), only a real DB absence-check
 * can.
 *
 * TC-6, TC-9..TC-13 (pure repository scoping/conflict behaviour) live in
 * `promo-code-config.repository.spec.ts` instead.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createAppTestConnection } from './support/app-connection';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { PromoCodeConfigAuditRepository } from '@/modules/promo-code-config/promo-code-config-audit.repository';
import { PromoCodeConfigService } from '@/modules/promo-code-config/promo-code-config.service';
import { PromoCodeConfigValidationError } from '@/modules/promo-code-config/promo-code-config.errors';
import {
  isValidRewardUnit,
  parseCreatePromoCodeConfigDto,
} from '@/modules/promo-code-config/dto/create-promo-code-config.dto';

const ACTOR_ID = randomUUID();

function validCreateInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `t-pc-010 service ${randomUUID()}`,
    codeLength: 8,
    characterSet: 'ALPHANUMERIC',
    rewardValueType: 'FIXED_AMOUNT',
    rewardValue: 10,
    rewardUnit: 'USD',
    ...overrides,
  };
}

describe('T-PC-010 — PromoCodeConfigService', () => {
  let sequelize: Sequelize;
  let repository: PromoCodeConfigRepository;
  let auditRepository: PromoCodeConfigAuditRepository;
  let service: PromoCodeConfigService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    sequelize = createAppTestConnection();
    await sequelize.authenticate();
    repository = new PromoCodeConfigRepository(sequelize);
    auditRepository = new PromoCodeConfigAuditRepository(sequelize);
    service = new PromoCodeConfigService(repository, auditRepository, sequelize);
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

  async function countRowsNamed(tenantId: string, name: string): Promise<number> {
    const rows = await sequelize.query<{ count: string }>(
      'SELECT count(*) FROM promo_code.promo_code_config WHERE tenant_id = :tenantId AND name = :name',
      { type: QueryTypes.SELECT, replacements: { tenantId, name } },
    );
    return Number(rows[0].count);
  }

  // TC-1
  it('TC-1: creates a valid FIXED_AMOUNT config with rewardUnit USD, writes a CREATE audit row', async () => {
    const tenantId = freshTenant();
    const input = validCreateInput({ rewardValueType: 'FIXED_AMOUNT', rewardUnit: 'USD' });

    const created = await service.create(tenantId, input, ACTOR_ID);

    expect(created.id).toBeDefined();
    expect(created.rewardValueType).toBe('FIXED_AMOUNT');

    const auditRows = await auditRepository.listForConfig(created.id);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe('CREATE');
  });

  // Adjacent behaviour: a root-level (non-object) invalid input produces a `(root)`-labelled
  // issue in the error message, not a blank/undefined path segment.
  it('adjacent behaviour: a non-object create input surfaces a root-level validation issue', () => {
    expect(() => parseCreatePromoCodeConfigDto('not-an-object')).toThrow(
      PromoCodeConfigValidationError,
    );
    try {
      parseCreatePromoCodeConfigDto(42);
      throw new Error('expected parseCreatePromoCodeConfigDto to throw');
    } catch (error) {
      expect((error as PromoCodeConfigValidationError).message).toContain('(root)');
    }
  });

  // Adjacent behaviour: `isValidRewardUnit`'s defensive default (an unrecognised
  // rewardValueType, unreachable through the zod-validated `create`/`update` paths themselves
  // since the enum already rejects it first) is still exercised directly as a pure function.
  it('adjacent behaviour: isValidRewardUnit rejects an unrecognised rewardValueType', () => {
    expect(isValidRewardUnit('SOMETHING_ELSE', 'USD')).toBe(false);
  });

  // TC-2
  it('TC-2: rejects a PERCENTAGE config with rewardUnit USD (wrong unit for type)', async () => {
    const tenantId = freshTenant();
    const name = `t-pc-010 tc2 ${randomUUID()}`;
    const input = validCreateInput({ name, rewardValueType: 'PERCENTAGE', rewardUnit: 'USD' });

    await expect(service.create(tenantId, input, ACTOR_ID)).rejects.toBeInstanceOf(
      PromoCodeConfigValidationError,
    );
    expect(await countRowsNamed(tenantId, name)).toBe(0);
  });

  // TC-3
  it('TC-3: creates a PERCENTAGE config with rewardUnit %', async () => {
    const tenantId = freshTenant();
    const input = validCreateInput({
      rewardValueType: 'PERCENTAGE',
      rewardUnit: '%',
      rewardValue: 10,
    });

    const created = await service.create(tenantId, input, ACTOR_ID);
    expect(created.rewardValueType).toBe('PERCENTAGE');
    expect(created.rewardUnit).toBe('%');
  });

  // TC-4
  it('TC-4: rejects a POINTS config with an empty rewardUnit', async () => {
    const tenantId = freshTenant();
    const name = `t-pc-010 tc4 ${randomUUID()}`;
    const input = validCreateInput({ name, rewardValueType: 'POINTS', rewardUnit: '' });

    await expect(service.create(tenantId, input, ACTOR_ID)).rejects.toBeInstanceOf(
      PromoCodeConfigValidationError,
    );
    expect(await countRowsNamed(tenantId, name)).toBe(0);
  });

  // TC-5
  it('TC-5: rejects codeLength = 3 before it ever reaches the database', async () => {
    const tenantId = freshTenant();
    const name = `t-pc-010 tc5 ${randomUUID()}`;
    const input = validCreateInput({ name, codeLength: 3 });

    await expect(service.create(tenantId, input, ACTOR_ID)).rejects.toBeInstanceOf(
      PromoCodeConfigValidationError,
    );
    expect(await countRowsNamed(tenantId, name)).toBe(0);
  });

  // TC-7
  it('TC-7: updating rewardValue updates the row and writes a diff-only UPDATE audit row', async () => {
    const tenantId = freshTenant();
    const created = await service.create(
      tenantId,
      validCreateInput({ rewardValueType: 'FIXED_AMOUNT', rewardUnit: 'USD', rewardValue: 10 }),
      ACTOR_ID,
    );

    const updated = await service.update(tenantId, created.id, { rewardValue: 25 }, ACTOR_ID);

    expect(updated).not.toBeNull();
    expect(Number(updated?.rewardValue)).toBe(25);

    const auditRows = await auditRepository.listForConfig(created.id);
    expect(auditRows).toHaveLength(2);
    const updateRow = auditRows[1];
    expect(updateRow.action).toBe('UPDATE');
    expect(Object.keys(updateRow.changedFields)).toEqual(['rewardValue']);
    expect(Number(updateRow.changedFields.rewardValue.new)).toBe(25);
  });

  // TC-8
  it('TC-8: archiving an active config sets status ARCHIVED, writes an ARCHIVE audit row, and keeps the row present', async () => {
    const tenantId = freshTenant();
    const created = await service.create(tenantId, validCreateInput(), ACTOR_ID);

    const archived = await service.archive(tenantId, created.id, ACTOR_ID);
    expect(archived?.status).toBe('ARCHIVED');

    // Still present, not deleted (implementation note 4) — a direct, unscoped-by-status SQL
    // read against the real table, not just the service's own return value.
    const rows = await sequelize.query<{ id: string; deleted_at: Date | null }>(
      'SELECT id, deleted_at FROM promo_code.promo_code_config WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: created.id } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).toBeNull();

    const auditRows = await auditRepository.listForConfig(created.id);
    expect(auditRows.map((r) => r.action)).toEqual(['CREATE', 'ARCHIVE']);
  });

  // Adjacent behaviour: findById/list passthroughs (used by T-PC-011/T-PC-012 directly).
  it('adjacent behaviour: findById/list resolve through to the repository', async () => {
    const tenantId = freshTenant();
    const created = await service.create(tenantId, validCreateInput(), ACTOR_ID);

    await expect(service.findById(tenantId, created.id)).resolves.toMatchObject({
      id: created.id,
    });
    await expect(service.list(tenantId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })]),
    );
  });

  // Adjacent behaviour: a resubmitted, unchanged update is a no-op — no audit row, no DB write.
  it('adjacent behaviour: an update with no actual field changes is a no-op and writes no audit row', async () => {
    const tenantId = freshTenant();
    const created = await service.create(
      tenantId,
      validCreateInput({ name: 'no-op subject' }),
      ACTOR_ID,
    );

    const result = await service.update(tenantId, created.id, { name: 'no-op subject' }, ACTOR_ID);
    expect(result?.id).toBe(created.id);

    const auditRows = await auditRepository.listForConfig(created.id);
    expect(auditRows).toHaveLength(1); // CREATE only
  });

  // Adjacent behaviour: buildDiff's string-comparison branch (a changed non-numeric field).
  it('adjacent behaviour: updating a string field (name) produces a diff with the real old/new strings', async () => {
    const tenantId = freshTenant();
    const created = await service.create(
      tenantId,
      validCreateInput({ name: 'before name' }),
      ACTOR_ID,
    );

    await service.update(tenantId, created.id, { name: 'after name' }, ACTOR_ID);

    const auditRows = await auditRepository.listForConfig(created.id);
    const updateRow = auditRows[1];
    expect(updateRow.changedFields.name).toEqual({ old: 'before name', new: 'after name' });
  });

  // Adjacent behaviour: the rewardUnit-vs-rewardValueType cross-check re-runs on update too,
  // using the existing row's value for whichever of the pair the caller didn't touch.
  it('adjacent behaviour: an update that would make rewardUnit illegal for the existing rewardValueType is rejected', async () => {
    const tenantId = freshTenant();
    const created = await service.create(
      tenantId,
      validCreateInput({ rewardValueType: 'FIXED_AMOUNT', rewardUnit: 'USD' }),
      ACTOR_ID,
    );

    await expect(
      // 4 letters: passes the DTO's own structural check (<=10 chars) but fails the
      // cross-field ISO-4217-shaped rule (exactly 3 uppercase letters) — isolates
      // `assertRewardUnitStillLegal`'s own rejection from a plain structural one (TC-5-style).
      service.update(tenantId, created.id, { rewardUnit: 'USDX' }, ACTOR_ID),
    ).rejects.toBeInstanceOf(PromoCodeConfigValidationError);

    const auditRows = await auditRepository.listForConfig(created.id);
    expect(auditRows).toHaveLength(1); // CREATE only — the rejected update wrote nothing
  });

  // Adjacent behaviour: update-time structural (DTO-level) rejection, mirroring TC-5 for create.
  it('adjacent behaviour: update rejects an out-of-range codeLength before it reaches the database', async () => {
    const tenantId = freshTenant();
    const created = await service.create(tenantId, validCreateInput(), ACTOR_ID);

    await expect(
      service.update(tenantId, created.id, { codeLength: 33 }, ACTOR_ID),
    ).rejects.toBeInstanceOf(PromoCodeConfigValidationError);
  });

  // Adjacent behaviour: updating a numeric non-money field (both old and new values are plain
  // JS numbers, not the string-shaped `rewardValue`) exercises `valuesEqual`'s all-number path.
  it('adjacent behaviour: updating codeLength diffs two plain numbers correctly', async () => {
    const tenantId = freshTenant();
    const created = await service.create(tenantId, validCreateInput({ codeLength: 8 }), ACTOR_ID);

    await service.update(tenantId, created.id, { codeLength: 12 }, ACTOR_ID);

    const auditRows = await auditRepository.listForConfig(created.id);
    expect(auditRows[1].changedFields.codeLength).toEqual({ old: 8, new: 12 });
  });

  // Adjacent behaviour: moving a tenant-wide config (`merchantId: null`) to a merchant-scoped
  // one exercises `valuesEqual`'s null-short-circuit branch (old value `null`, new value a uuid).
  it('adjacent behaviour: updating merchantId from null to a real id is diffed, not treated as unchanged', async () => {
    const tenantId = freshTenant();
    const created = await service.create(tenantId, validCreateInput(), ACTOR_ID);
    const merchantId = randomUUID();

    const updated = await service.update(tenantId, created.id, { merchantId }, ACTOR_ID);
    expect(updated?.merchantId).toBe(merchantId);

    const auditRows = await auditRepository.listForConfig(created.id);
    expect(auditRows[1].changedFields.merchantId).toEqual({ old: null, new: merchantId });
  });

  // Adjacent behaviour: `update`/`archive` on an id that never resolves for the given tenant
  // (never created, or owned by someone else) is a clean not-found — no throw, no audit row.
  it('adjacent behaviour: update/archive on a non-existent id both resolve to null', async () => {
    const tenantId = freshTenant();
    const missingId = randomUUID();

    await expect(service.update(tenantId, missingId, { name: 'x' }, ACTOR_ID)).resolves.toBeNull();
    await expect(service.archive(tenantId, missingId, ACTOR_ID)).resolves.toBeNull();
  });

  // Adjacent behaviour: archiving an already-ARCHIVED config is idempotent — no second audit
  // row, no error.
  it('adjacent behaviour: archiving an already-archived config twice is idempotent', async () => {
    const tenantId = freshTenant();
    const created = await service.create(tenantId, validCreateInput(), ACTOR_ID);
    await service.archive(tenantId, created.id, ACTOR_ID);

    const secondArchive = await service.archive(tenantId, created.id, ACTOR_ID);
    expect(secondArchive?.status).toBe('ARCHIVED');

    const auditRows = await auditRepository.listForConfig(created.id);
    expect(auditRows.map((r) => r.action)).toEqual(['CREATE', 'ARCHIVE']); // not ARCHIVE twice
  });

  // Adjacent behaviour: changing only rewardValueType (leaving rewardUnit untouched) re-checks
  // legality against the *existing* rewardUnit — exercises the `dto.rewardUnit ?? existing...`
  // fallback side of `assertRewardUnitStillLegal`.
  it('adjacent behaviour: changing only rewardValueType is validated against the existing rewardUnit', async () => {
    const tenantId = freshTenant();
    const created = await service.create(
      tenantId,
      validCreateInput({ rewardValueType: 'FIXED_AMOUNT', rewardUnit: 'USD' }),
      ACTOR_ID,
    );

    // 'USD' is not a legal rewardUnit for PERCENTAGE (must be '%') — and this update never
    // supplies rewardUnit itself, so the check must fall back to the existing row's value.
    await expect(
      service.update(tenantId, created.id, { rewardValueType: 'PERCENTAGE' }, ACTOR_ID),
    ).rejects.toBeInstanceOf(PromoCodeConfigValidationError);
  });

  // TC-14
  it('TC-14: create, update and archive each write exactly one audit row — no duplicate/missing rows', async () => {
    const tenantId = freshTenant();
    const created = await service.create(tenantId, validCreateInput(), ACTOR_ID);
    await service.update(tenantId, created.id, { rewardValue: 42 }, ACTOR_ID);
    await service.archive(tenantId, created.id, ACTOR_ID);

    const auditRows = await auditRepository.listForConfig(created.id);
    expect(auditRows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE', 'ARCHIVE']);
  });
});
