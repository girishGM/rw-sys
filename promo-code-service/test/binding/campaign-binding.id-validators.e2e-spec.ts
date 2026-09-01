/**
 * T-PC-053. Proves `POST /api/v1/campaign-promo-configs` accepts plain, non-UUID-shaped
 * portal ids for `tenantId`/`bindRefId`/`boundBy` (T-PC-052 widened the underlying columns to
 * `varchar(64)`; this task relaxed the zod validators sitting in front of them to match) — full
 * HTTP round trip against the real, already-migrated `promo_code` schema, same real-DB
 * convention `campaign-binding.e2e-spec.ts` (T-PC-012) already established, per
 * `AGENT-PROTOCOL.md` §3.
 *
 * `promoCodeConfigId` is this service's **own** generated key and is deliberately left a genuine
 * UUID throughout (TC-4) — out of this task's scope, unchanged.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { createAppTestConnection } from '../config/support/app-connection';

describe('T-PC-053 — campaign-promo-config bind accepts plain portal-shaped ids', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let promoCodeConfigRepository: PromoCodeConfigRepository;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    sequelize = createAppTestConnection();
    await sequelize.authenticate();
    promoCodeConfigRepository = new PromoCodeConfigRepository(sequelize);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
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
        {
          replacements: { tenantId },
        },
      );
    }
    await sequelize.close();
    await app.close();
  });

  /** A plain, non-UUID-shaped portal id — numeric-looking, unique per call, well under 64 chars. */
  function freshPortalTenant(): string {
    const id = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    tenantIds.push(id);
    return id;
  }

  function authHeader(): [string, string] {
    return ['Authorization', `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`];
  }

  async function seedActiveConfig(tenantId: string): Promise<string> {
    const config = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-053 e2e config ${randomUUID()}`,
      codePrefix: null,
      codePostfix: null,
      codeLength: 8,
      characterSet: 'ALPHANUMERIC',
      excludeAmbiguousChars: true,
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: 5,
      rewardUnit: 'USD',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: null,
      createdBy: randomUUID(),
    });
    return config.id;
  }

  // TC-1
  it('TC-1: plain-string tenantId/bindRefId/boundBy against a matching ACTIVE config returns 201, never 400', async () => {
    const tenantId = freshPortalTenant();
    const configId = await seedActiveConfig(tenantId);

    const response = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader())
      .send({
        promoCodeConfigId: configId,
        tenantId,
        bindLevel: 'CAMPAIGN',
        bindRefId: '42',
        boundBy: '3',
      });

    expect(response.status).toBe(201);
    expect(response.body.tenantId).toBe(tenantId);
    expect(response.body.bindRefId).toBe('42');
    expect(response.body.boundBy).toBe('3');
  });

  // TC-1 (no matching config)
  it('TC-1b: plain-string tenantId with no matching ACTIVE config returns 409, never 400', async () => {
    const tenantId = freshPortalTenant();

    const response = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader())
      .send({
        promoCodeConfigId: randomUUID(),
        tenantId,
        bindLevel: 'CAMPAIGN',
        bindRefId: '42',
        boundBy: '3',
      });

    expect(response.status).toBe(409);
  });

  // TC-2
  it('TC-2: a full-UUID tenantId is still accepted — widening, not narrowing', async () => {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    const configId = await seedActiveConfig(tenantId);

    const response = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader())
      .send({
        promoCodeConfigId: configId,
        tenantId,
        bindLevel: 'CAMPAIGN',
        bindRefId: randomUUID(),
        boundBy: randomUUID(),
      });

    expect(response.status).toBe(201);
  });

  // TC-3
  it('TC-3: a tenantId over 64 characters returns 400, matching the DB column bound', async () => {
    const tenantId = 'x'.repeat(65);

    const response = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader())
      .send({
        promoCodeConfigId: randomUUID(),
        tenantId,
        bindLevel: 'CAMPAIGN',
        bindRefId: '42',
        boundBy: '3',
      });

    expect(response.status).toBe(400);
  });

  // TC-4
  it("TC-4: promoCodeConfigId (this service's own key) with a non-UUID value is still rejected", async () => {
    const tenantId = freshPortalTenant();

    const response = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader())
      .send({
        promoCodeConfigId: 'not-a-uuid',
        tenantId,
        bindLevel: 'CAMPAIGN',
        bindRefId: '42',
        boundBy: '3',
      });

    expect(response.status).toBe(400);
  });
});
