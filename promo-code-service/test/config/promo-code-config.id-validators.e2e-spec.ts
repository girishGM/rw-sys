/**
 * T-PC-053. Proves the `promo-code-config` admin CRUD surface and its `GET` list query accept
 * plain, non-UUID-shaped portal ids for `tenantId`/`actorId`/`merchantId` (T-PC-052 widened the
 * underlying columns to `varchar(64)`; this task relaxed the zod validators sitting in front of
 * them to match) — full HTTP round trip against the real, already-migrated `promo_code` schema,
 * same real-DB convention `promo-code-config.controller.spec.ts` (T-PC-011) already established,
 * per `AGENT-PROTOCOL.md` §3.
 *
 * `id` (this service's own generated key, `promoCodeConfigId` elsewhere) is deliberately left a
 * genuine UUID throughout — out of this task's scope, unchanged.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { createAppTestConnection } from './support/app-connection';

function authHeader(): [string, string] {
  return ['Authorization', `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`];
}

function validCreateBody(
  tenantId: string,
  actorId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tenantId,
    actorId,
    name: `t-pc-053 controller ${randomUUID()}`,
    codeLength: 8,
    characterSet: 'ALPHANUMERIC',
    rewardValueType: 'FIXED_AMOUNT',
    rewardValue: 10,
    rewardUnit: 'USD',
    ...overrides,
  };
}

describe('T-PC-053 — promo-code-config accepts plain portal-shaped ids', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    sequelize = createAppTestConnection();
    await sequelize.authenticate();
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
    await app.close();
  });

  /** A plain, non-UUID-shaped portal id — numeric-looking, unique per call, well under 64 chars. */
  function freshPortalTenant(): string {
    const id = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    tenantIds.push(id);
    return id;
  }

  // TC-1
  it('TC-1: POST with plain-string tenantId/actorId/merchantId returns 201, never 400', async () => {
    const tenantId = freshPortalTenant();
    const merchantId = '77';

    const response = await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader())
      .send(validCreateBody(tenantId, '55', { merchantId }));

    expect(response.status).toBe(201);
    expect(response.body.tenantId ?? tenantId).toBe(tenantId);
    expect(response.body.merchantId).toBe(merchantId);
  });

  // TC-2
  it('TC-2: a full-UUID tenantId/actorId/merchantId is still accepted — widening, not narrowing', async () => {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);

    const response = await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader())
      .send(validCreateBody(tenantId, randomUUID(), { merchantId: randomUUID() }));

    expect(response.status).toBe(201);
  });

  // TC-3
  it('TC-3: a tenantId over 64 characters returns 400, matching the DB column bound', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader())
      .send(validCreateBody('x'.repeat(65), '1'));

    expect(response.status).toBe(400);
  });

  // TC-5
  it('TC-5: GET with plain-string tenantId + merchantId query params returns 200', async () => {
    const tenantId = freshPortalTenant();
    const merchantId = '99';
    await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader())
      .send(validCreateBody(tenantId, '1', { merchantId }))
      .expect(201);

    const response = await request(app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId, merchantId })
      .set(...authHeader());

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});
