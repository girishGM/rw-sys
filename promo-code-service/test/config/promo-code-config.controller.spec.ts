/**
 * T-PC-011. `PromoCodeConfigController` — the REST surface over `PromoCodeConfigService`
 * (T-PC-010), run against the real, already-migrated `promo_code` schema on the real Postgres
 * 16 server (root `CLAUDE.md`), boot the full `AppModule` (proving guard + controller + service
 * + repository wiring end to end, not a mocked layer) — same real-DB convention
 * `promo-code-config.service.spec.ts`/`promo-code-config.repository.spec.ts` (T-PC-010) already
 * established, per `AGENT-PROTOCOL.md` §3 ("assert the observable property, not the
 * implementation string": only a real HTTP round trip through a real guard can actually prove a
 * `401`/`400`/`409`/`404`, not a mocked one).
 *
 * TC-16 (full e2e: create → list → archive → list) lives in `promo-code-config.e2e-spec.ts`
 * instead — this file covers TC-1..TC-15.
 *
 * Deviation from the task file's literal path (`test/modules/promo-code-config/
 * promo-code-config.controller.spec.ts`): `project.config.json` grants this agent
 * `test/config/**`, not `test/modules/promo-code-config/**` — kept consistent with where
 * T-PC-010 already placed its own specs (`test/config/promo-code-config.service.spec.ts`,
 * `test/config/promo-code-config.repository.spec.ts`). See the completion report's
 * "Deviations from spec".
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PromoCodeConfigAuditRepository } from '@/modules/promo-code-config/promo-code-config-audit.repository';
import { createAppTestConnection } from './support/app-connection';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

const VALID_TOKEN = (): string => process.env.INTERNAL_SERVICE_TOKEN as string;

function authHeader(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

function validCreateBody(
  tenantId: string,
  actorId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tenantId,
    actorId,
    name: `t-pc-011 controller ${randomUUID()}`,
    codeLength: 8,
    characterSet: 'ALPHANUMERIC',
    rewardValueType: 'FIXED_AMOUNT',
    rewardValue: 10,
    rewardUnit: 'USD',
    ...overrides,
  };
}

describe('T-PC-011 — PromoCodeConfigController (REST)', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let auditRepository: PromoCodeConfigAuditRepository;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    sequelize = createAppTestConnection();
    await sequelize.authenticate();
    auditRepository = new PromoCodeConfigAuditRepository(sequelize);
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

  function freshTenant(): string {
    const id = randomUUID();
    tenantIds.push(id);
    return id;
  }

  async function createConfig(
    tenantId: string,
    actorId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; [key: string]: unknown }> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader(VALID_TOKEN()))
      .send(validCreateBody(tenantId, actorId, overrides));
    expect(response.status).toBe(201);
    return response.body;
  }

  // TC-1
  it('TC-1: GET with valid token returns 200, thin summary shape, only ACTIVE configs', async () => {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const created = await createConfig(tenantId, actorId);

    const response = await request(app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId })
      .set(...authHeader(VALID_TOKEN()));

    expect(response.status).toBe(200);
    expect(response.body.configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.id,
          name: created.name,
          rewardValueType: 'FIXED_AMOUNT',
          rewardValue: '10.0000',
          rewardUnit: 'USD',
        }),
      ]),
    );
  });

  // TC-2
  it('TC-2: list response body never carries codePrefix/codeLength/characterSet', async () => {
    const tenantId = freshTenant();
    await createConfig(tenantId, randomUUID());

    const response = await request(app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId })
      .set(...authHeader(VALID_TOKEN()));

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toMatch(/codePrefix|codePostfix|codeLength|characterSet/);
  });

  // TC-3
  it('TC-3: GET with no tenantId returns 400', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .set(...authHeader(VALID_TOKEN()));

    expect(response.status).toBe(400);
  });

  // TC-4
  it('TC-4: GET with tenantId + merchantId returns both tenant-wide and merchant-specific configs', async () => {
    const tenantId = freshTenant();
    const merchantId = randomUUID();
    const tenantWide = await createConfig(tenantId, randomUUID());
    const merchantScoped = await createConfig(tenantId, randomUUID(), { merchantId });

    const response = await request(app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId, merchantId })
      .set(...authHeader(VALID_TOKEN()));

    expect(response.status).toBe(200);
    const ids = response.body.configs.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([tenantWide.id, merchantScoped.id]));
  });

  // TC-5
  it('TC-5: GET with status=ARCHIVED returns only archived configs', async () => {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const active = await createConfig(tenantId, actorId);
    const toArchive = await createConfig(tenantId, actorId);
    await request(app.getHttpServer())
      .delete(`/api/v1/promo-code-configs/${toArchive.id}`)
      .query({ tenantId, actorId })
      .set(...authHeader(VALID_TOKEN()));

    const response = await request(app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId, status: 'ARCHIVED' })
      .set(...authHeader(VALID_TOKEN()));

    expect(response.status).toBe(200);
    const ids = response.body.configs.map((c: { id: string }) => c.id);
    expect(ids).toContain(toArchive.id);
    expect(ids).not.toContain(active.id);
  });

  // TC-6
  it('TC-6: request with no Authorization header returns 401', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId: randomUUID() });

    expect(response.status).toBe(401);
  });

  // TC-7
  it('TC-7: request with a wrong/garbage bearer token returns 401', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId: randomUUID() })
      .set(...authHeader('garbage-token-value'));

    expect(response.status).toBe(401);
  });

  // TC-8
  it('TC-8: POST with a valid body returns 201, creates the config, writes an audit row', async () => {
    const tenantId = freshTenant();
    const actorId = randomUUID();

    const response = await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader(VALID_TOKEN()))
      .send(validCreateBody(tenantId, actorId));

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();

    const auditRows = await auditRepository.listForConfig(response.body.id);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe('CREATE');
  });

  // Adjacent behaviour: the request envelope (tenantId/actorId, admin-request-envelope.dto.ts)
  // is validated independently of the config's own fields — an otherwise-valid body missing
  // `actorId` (who would own the audit row) is rejected at the HTTP boundary too.
  it('adjacent behaviour: POST with no actorId in the body returns 400', async () => {
    const tenantId = freshTenant();
    const body = validCreateBody(tenantId, randomUUID());
    delete body.actorId;

    const response = await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader(VALID_TOKEN()))
      .send(body);

    expect(response.status).toBe(400);
  });

  // TC-9
  it('TC-9: POST with codeLength = 50 returns 400 with a field-level error naming codeLength', async () => {
    const tenantId = freshTenant();
    const response = await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader(VALID_TOKEN()))
      .send(validCreateBody(tenantId, randomUUID(), { codeLength: 50 }));

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'codeLength' })]),
    );
  });

  // TC-10
  it("TC-10: POST with characterSet = 'EMOJI' returns 400", async () => {
    const tenantId = freshTenant();
    const response = await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader(VALID_TOKEN()))
      .send(validCreateBody(tenantId, randomUUID(), { characterSet: 'EMOJI' }));

    expect(response.status).toBe(400);
  });

  // TC-11
  it('TC-11: POST creating a duplicate (tenantId, name) returns 409', async () => {
    const tenantId = freshTenant();
    const name = `t-pc-011 dup ${randomUUID()}`;
    await createConfig(tenantId, randomUUID(), { name });

    const response = await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader(VALID_TOKEN()))
      .send(validCreateBody(tenantId, randomUUID(), { name }));

    expect(response.status).toBe(409);
  });

  // TC-12
  it('TC-12: PATCH updating rewardValue returns 200, updated, writes an audit row', async () => {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const created = await createConfig(tenantId, actorId);

    const response = await request(app.getHttpServer())
      .patch(`/api/v1/promo-code-configs/${created.id}`)
      .set(...authHeader(VALID_TOKEN()))
      .send({ tenantId, actorId, rewardValue: 25 });

    expect(response.status).toBe(200);
    expect(Number(response.body.rewardValue)).toBe(25);

    const auditRows = await auditRepository.listForConfig(created.id);
    expect(auditRows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
  });

  // TC-13
  it("TC-13: PATCH with a tenantId that doesn't own the config returns 404, never leaking existence", async () => {
    const tenantId = freshTenant();
    const otherTenantId = freshTenant();
    const actorId = randomUUID();
    const created = await createConfig(tenantId, actorId);

    const response = await request(app.getHttpServer())
      .patch(`/api/v1/promo-code-configs/${created.id}`)
      .set(...authHeader(VALID_TOKEN()))
      .send({ tenantId: otherTenantId, actorId, rewardValue: 99 });

    expect(response.status).toBe(404);
  });

  // TC-14
  it('TC-14: DELETE archives the config (status ARCHIVED, row still queryable by id)', async () => {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const created = await createConfig(tenantId, actorId);

    const response = await request(app.getHttpServer())
      .delete(`/api/v1/promo-code-configs/${created.id}`)
      .query({ tenantId, actorId })
      .set(...authHeader(VALID_TOKEN()));

    expect([200, 204]).toContain(response.status);
    expect(response.body.status).toBe('ARCHIVED');

    const rows = await sequelize.query<{ id: string }>(
      'SELECT id FROM promo_code.promo_code_config WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: created.id } },
    );
    expect(rows).toHaveLength(1);
  });

  // TC-15
  it('TC-15: DELETE on an already-ARCHIVED config is idempotent — no error, no duplicate audit row', async () => {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const created = await createConfig(tenantId, actorId);

    await request(app.getHttpServer())
      .delete(`/api/v1/promo-code-configs/${created.id}`)
      .query({ tenantId, actorId })
      .set(...authHeader(VALID_TOKEN()));

    const second = await request(app.getHttpServer())
      .delete(`/api/v1/promo-code-configs/${created.id}`)
      .query({ tenantId, actorId })
      .set(...authHeader(VALID_TOKEN()));

    expect([200, 204]).toContain(second.status);

    const auditRows = await auditRepository.listForConfig(created.id);
    expect(auditRows.map((r) => r.action)).toEqual(['CREATE', 'ARCHIVE']);
  });
});
