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
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { PromoCodeConfigService } from '@/modules/promo-code-config/promo-code-config.service';
import { CampaignBindingService } from '@/modules/campaign-binding/campaign-binding.service';
import { PromoCodeGenerationService } from '@/modules/generation/promo-code-generation.service';
import type { GenerationResult } from '@/modules/generation/generation-result.types';
import { createAppTestConnection } from '../../config/support/app-connection';

describe('T-PC-021 — PromoCodeGenerationService full round trip (e2e)', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let promoCodeConfigRepository: PromoCodeConfigRepository;
  let promoCodeConfigService: PromoCodeConfigService;
  let bindingService: CampaignBindingService;
  let generationService: PromoCodeGenerationService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    promoCodeConfigService = moduleRef.get(PromoCodeConfigService);
    promoCodeConfigRepository = moduleRef.get(PromoCodeConfigRepository);
    bindingService = moduleRef.get(CampaignBindingService);
    generationService = moduleRef.get(PromoCodeGenerationService);

    sequelize = createAppTestConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
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
      await sequelize.query(
        'DELETE FROM promo_code.promo_code_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
      );
    }
    await sequelize.close();
    await app.close();
  });

  it('TC-18: bind -> generate -> idempotent re-generate -> reward-value snapshot survives a later config update', async () => {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    const actorId = randomUUID();

    // 1. bind (T-PC-012)
    const config = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-021 e2e config ${randomUUID()}`,
      codePrefix: 'SAVE-',
      codePostfix: null,
      codeLength: 10,
      characterSet: 'ALPHANUMERIC',
      excludeAmbiguousChars: true,
      rewardValueType: 'PERCENTAGE',
      rewardValue: 15,
      rewardUnit: '%',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: 30,
      createdBy: actorId,
    });
    const bindRefId = randomUUID();
    await bindingService.bind({
      promoCodeConfigId: config.id,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      boundBy: actorId,
    });

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

    // 4. snapshot immutability after a config update
    await promoCodeConfigService.update(tenantId, config.id, { rewardValue: 50 }, actorId);
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
