/**
 * T-PC-021. TC-18: the full round trip — bind (T-PC-012's `CampaignBindingService`) → generate →
 * idempotent re-generate → verify snapshot immutability after a config update — against the real,
 * already-migrated `promo_code` schema, booting the full `AppModule` (so `PromoCodeGenerationModule`
 * is wired exactly as it is at runtime, DI graph included), per `AGENT-PROTOCOL.md` §3.
 *
 * `PromoCodeGenerationService` has no REST controller of its own (T-PC-021's scope is the domain
 * service only, R10 — the real callers are the not-yet-built Kafka consumer/gRPC server, T-PC-030/
 * T-PC-031), so this resolves the service straight off the compiled `TestingModule` rather than
 * driving it over HTTP via `supertest`, unlike the sibling `*.e2e-spec.ts` files in this project.
 *
 * Deviation from the task file's literal Verification step 2 command (`npm run test:e2e --
 * generation`): no `test:e2e` script exists in `package.json`; `npm test`'s own `testRegex`
 * already matches `.e2e-spec.ts` files under `test/` — same precedent already accepted on
 * T-PC-011/T-PC-012's own review.
 *
 * **T-PC-060 adaptation.** Seeding here no longer goes through `PromoCodeConfigRepository.create()`
 * (broken by migration `T-PC-058_001_split_promo_code_config_version.ts`, a landed dependency —
 * see `promo-code-generation-version.spec.ts`'s own header for the full defect chain) or
 * `CampaignBindingService.bind()`'s repository (broken by `T-PC-058_003`'s new `NOT NULL`
 * `campaign_promo_config.promo_code_config_version_id`) — both `agent-promo-config`'s exclusive
 * scope (R8). Adapted to raw SQL, same bypass pattern `promo-code-generation.service.spec.ts`
 * already established. Step 4 ("snapshot immutability after a config update") is adapted the same
 * way that file's own TC-14 was: a config edit is now a brand-new `promo_code_config_version` row,
 * not an in-place `PATCH` — simulated via a direct insert, binding deliberately left un-repinned.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { AppModule } from '@/app.module';
import { PromoCodeGenerationService } from '@/modules/generation/promo-code-generation.service';
import type { GenerationResult } from '@/modules/generation/generation-result.types';
import { createAppTestConnection } from '../../config/support/app-connection';

describe('T-PC-021 — PromoCodeGenerationService full round trip (e2e)', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let generationService: PromoCodeGenerationService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    generationService = moduleRef.get(PromoCodeGenerationService);

    sequelize = createAppTestConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    // T-PC-060 adaptation: does not delete `promo_code_config`/`promo_code_config_version` rows —
    // see `promo-code-generation-version.spec.ts`'s own `afterAll` for the identical reasoning
    // (`trg_promo_code_config_version_undeletable` rejects a `DELETE` on a non-`draft` version).
    for (const tenantId of tenantIds) {
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_outbox
           WHERE promo_code_id IN (SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId)`,
        { replacements: { tenantId } },
      );
      await sequelize.query('DELETE FROM promo_code.promo_code WHERE tenant_id = :tenantId', {
        replacements: { tenantId },
      });
      await sequelize.query(
        'DELETE FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
      );
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_config_audit
           WHERE promo_code_config_id IN (
             SELECT id FROM promo_code.promo_code_config WHERE tenant_id = :tenantId
           )`,
        { replacements: { tenantId } },
      );
    }
    await sequelize.close();
    await app.close();
  });

  /** T-PC-060 adaptation — see this file's own header. */
  async function insertIdentity(tenantId: string): Promise<string> {
    const id = randomUUID();
    const actor = randomUUID();
    await sequelize.query(
      `INSERT INTO promo_code.promo_code_config
         (id, tenant_id, merchant_id, name, status, created_by, updated_by)
       VALUES (:id, :tenantId, NULL, :name, 'ACTIVE', :actor, :actor)`,
      {
        type: QueryTypes.INSERT,
        replacements: { id, tenantId, name: `t-pc-021 e2e config ${randomUUID()}`, actor },
      },
    );
    return id;
  }

  async function insertVersion(
    promoCodeConfigId: string,
    overrides: Partial<{
      rewardValue: number;
      codePrefix: string | null;
      codeExpiryDays: number | null;
      versionNo: number;
    }> = {},
  ): Promise<string> {
    const id = randomUUID();
    const actor = randomUUID();
    await sequelize.query(
      `INSERT INTO promo_code.promo_code_config_version
         (id, promo_code_config_id, version_no, code_prefix, code_postfix, code_length,
          character_set, exclude_ambiguous_chars, reward_value_type, reward_value, reward_unit,
          max_redemptions_per_code, code_expiry_days, status, created_by, published_by, published_at)
       VALUES (:id, :promoCodeConfigId, :versionNo, :codePrefix, NULL, 10, 'ALPHANUMERIC', true,
               'PERCENTAGE', :rewardValue, '%', 1, :codeExpiryDays, 'published', :actor, :actor,
               now())`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          id,
          promoCodeConfigId,
          versionNo: overrides.versionNo ?? 1,
          codePrefix: overrides.codePrefix ?? null,
          rewardValue: overrides.rewardValue ?? 15,
          codeExpiryDays: overrides.codeExpiryDays ?? null,
          actor,
        },
      },
    );
    return id;
  }

  async function insertBinding(
    tenantId: string,
    promoCodeConfigId: string,
    promoCodeConfigVersionId: string,
    bindRefId: string,
  ): Promise<void> {
    await sequelize.query(
      `INSERT INTO promo_code.campaign_promo_config
         (promo_code_config_id, promo_code_config_version_id, tenant_id, bind_level, bind_ref_id,
          bound_by, status)
       VALUES (:promoCodeConfigId, :promoCodeConfigVersionId, :tenantId, 'CAMPAIGN', :bindRefId,
               :boundBy, 'ACTIVE')`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          promoCodeConfigId,
          promoCodeConfigVersionId,
          tenantId,
          bindRefId,
          boundBy: randomUUID(),
        },
      },
    );
  }

  it('TC-18: bind -> generate -> idempotent re-generate -> reward-value snapshot survives a later config version being created', async () => {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);

    // 1. bind (T-PC-012) — T-PC-060 adaptation, raw SQL (see this file's own header)
    const configId = await insertIdentity(tenantId);
    const v1Id = await insertVersion(configId, {
      codePrefix: 'SAVE-',
      rewardValue: 15,
      codeExpiryDays: 30,
    });
    const bindRefId = randomUUID();
    await insertBinding(tenantId, configId, v1Id, bindRefId);

    // 2. generate
    const correlationId = randomUUID();
    const firstResult = await generationService.generateCode({
      correlationId,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust_e2e_18',
      merchantId: null,
      transport: 'GRPC',
      activityContext: null,
    });
    expect(firstResult.status).toBe('SUCCESS');
    const firstSuccess = firstResult as Extract<GenerationResult, { status: 'SUCCESS' }>;
    expect(firstSuccess.code.startsWith('SAVE-')).toBe(true);
    expect(firstSuccess.rewardValueType).toBe('PERCENTAGE');
    expect(firstSuccess.rewardValue).toBe('15.0000');
    expect(firstSuccess.rewardUnit).toBe('%');
    expect(firstSuccess.expiresAt).not.toBeNull();

    // 3. idempotent re-generate
    const secondResult = await generationService.generateCode({
      correlationId,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust_e2e_18',
      merchantId: null,
      transport: 'GRPC',
      activityContext: null,
    });
    expect(secondResult).toEqual(firstResult);

    // 4. snapshot immutability after a new config version is created (T-PC-060 adaptation — a
    // config edit is now a brand-new version row, not an in-place PATCH; binding deliberately left
    // un-repinned, same reasoning as `promo-code-generation.service.spec.ts`'s own TC-14)
    await insertVersion(configId, { rewardValue: 50, versionNo: 2 });
    const thirdResult = await generationService.generateCode({
      correlationId,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust_e2e_18',
      merchantId: null,
      transport: 'GRPC',
      activityContext: null,
    });
    expect(thirdResult.status).toBe('SUCCESS');
    const thirdSuccess = thirdResult as Extract<GenerationResult, { status: 'SUCCESS' }>;
    expect(thirdSuccess.promoCodeId).toBe(firstSuccess.promoCodeId);
    expect(thirdSuccess.rewardValue).toBe('15.0000');
  });
});
