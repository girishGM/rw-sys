/**
 * T-PC-012. `POST /api/v1/campaign-promo-configs` — the full HTTP round trip (guard, controller,
 * filter, service, repository) against the real, already-migrated `promo_code` schema on the
 * real Postgres 16 server (root `CLAUDE.md`), boot the full `AppModule`, same real-DB convention
 * `promo-code-config.controller.spec.ts`/`promo-code-config.e2e-spec.ts` (T-PC-011) already
 * established, per `AGENT-PROTOCOL.md` §3.
 *
 * Covers the HTTP-boundary-specific behaviour (status codes, response shape, auth) that
 * `campaign-binding.service.spec.ts` — which calls `CampaignBindingService` directly — cannot
 * prove: R5's negative-authorisation tests, and Verification step 3's "bind twice, second
 * response/state shows the first deactivated" scenario over a real HTTP round trip.
 *
 * Deviation from the task file's literal path (`test/modules/campaign-promo-config/
 * campaign-promo-config.e2e-spec.ts`) and from Verification step 2's literal command
 * (`npm run test:e2e -- campaign-promo-config`): same reasoning as T-PC-011's deviation note —
 * `project.config.json` grants this agent `test/binding/**`, not `test/modules/**`, and
 * `package.json` has no separate `test:e2e` script; `npm test`'s own `testRegex` already matches
 * `.e2e-spec.ts` files under `test/`, and `AGENT-PROTOCOL.md` §4's own DoD gate table only ever
 * runs plain `npm test`.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { AppModule } from '@/app.module';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { createAppTestConnection } from '../config/support/app-connection';

describe('T-PC-012 — CampaignBindingController (REST, e2e)', () => {
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
        {
          replacements: { tenantId },
        },
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

  function freshTenant(): string {
    const id = randomUUID();
    tenantIds.push(id);
    return id;
  }

  function authHeader(token: string): [string, string] {
    return ['Authorization', `Bearer ${token}`];
  }

  async function seedActiveConfig(tenantId: string): Promise<string> {
    const config = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-012 e2e config ${randomUUID()}`,
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

  function bindBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      promoCodeConfigId: randomUUID(),
      tenantId: randomUUID(),
      bindLevel: 'CAMPAIGN',
      bindRefId: randomUUID(),
      boundBy: randomUUID(),
      ...overrides,
    };
  }

  it('POST with a valid body returns 201 and the created binding, ACTIVE', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);

    const response = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader(process.env.INTERNAL_SERVICE_TOKEN as string))
      .send(bindBody({ promoCodeConfigId: configId, tenantId }));

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      promoCodeConfigId: configId,
      tenantId,
      bindLevel: 'CAMPAIGN',
      status: 'ACTIVE',
    });
    expect(response.body.id).toBeDefined();
    expect(response.body.boundAt).toBeDefined();
  });

  it('POST binding an ARCHIVED promoCodeConfigId returns 409', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    await promoCodeConfigRepository.archive(tenantId, configId, randomUUID());

    const response = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader(process.env.INTERNAL_SERVICE_TOKEN as string))
      .send(bindBody({ promoCodeConfigId: configId, tenantId }));

    expect(response.status).toBe(409);
  });

  it("POST with an invalid bindLevel ('CAMPAIGNX') returns 400", async () => {
    const tenantId = freshTenant();

    const response = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader(process.env.INTERNAL_SERVICE_TOKEN as string))
      .send(bindBody({ tenantId, bindLevel: 'CAMPAIGNX' }));

    expect(response.status).toBe(400);
  });

  // R5: negative-authorisation coverage — missing token.
  it('POST with no Authorization header returns 401', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .send(bindBody());

    expect(response.status).toBe(401);
  });

  // R5: negative-authorisation coverage — wrong token.
  it('POST with a wrong/garbage bearer token returns 401', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader('garbage-token-value'))
      .send(bindBody());

    expect(response.status).toBe(401);
  });

  // Verification step 3: bind twice with different config ids; the second call's response
  // (and the persisted state) shows the first binding deactivated.
  it('binding twice for the same (tenantId, bindLevel, bindRefId) deactivates the first, activates the second', async () => {
    const tenantId = freshTenant();
    const firstConfigId = await seedActiveConfig(tenantId);
    const secondConfigId = await seedActiveConfig(tenantId);
    const bindRefId = randomUUID();
    const token = process.env.INTERNAL_SERVICE_TOKEN as string;

    const firstResponse = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader(token))
      .send(bindBody({ promoCodeConfigId: firstConfigId, tenantId, bindRefId }));
    expect(firstResponse.status).toBe(201);
    expect(firstResponse.body.status).toBe('ACTIVE');

    const secondResponse = await request(app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader(token))
      .send(bindBody({ promoCodeConfigId: secondConfigId, tenantId, bindRefId }));
    expect(secondResponse.status).toBe(201);
    expect(secondResponse.body.status).toBe('ACTIVE');
    expect(secondResponse.body.promoCodeConfigId).toBe(secondConfigId);

    const rows = await sequelize.query<{ id: string; status: string }>(
      'SELECT id, status FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId AND bind_ref_id = :bindRefId',
      { replacements: { tenantId, bindRefId }, type: QueryTypes.SELECT },
    );
    const firstRow = rows.find((r) => r.id === firstResponse.body.id);
    const secondRow = rows.find((r) => r.id === secondResponse.body.id);
    expect(firstRow?.status).toBe('INACTIVE');
    expect(secondRow?.status).toBe('ACTIVE');
  });
});
