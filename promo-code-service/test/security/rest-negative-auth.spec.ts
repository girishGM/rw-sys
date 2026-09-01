/**
 * T-PC-041. Cross-cutting negative-authorization sweep for every REST route this service exposes
 * (`04-API-CONTRACT.md` §1-§3) — TC-1/TC-2 applied to *every* admin CRUD + list + bind endpoint,
 * not just the one representative route each owning task (T-PC-011/T-PC-012) already tested.
 *
 * Why this file exists even though `InternalServiceTokenGuard` is applied at the *class* level on
 * both `PromoCodeConfigController` and `CampaignBindingController` (so, architecturally, every
 * method on both controllers is already covered by construction): T-PC-011's own
 * `promo-code-config.controller.spec.ts` only exercises TC-6/TC-7 (401 on missing/garbage token)
 * against the `GET` list route, and T-PC-012's `campaign-binding.e2e-spec.ts` only exercises it
 * against the one `POST` bind route. Neither the `POST`/`PATCH`/`DELETE` routes on
 * `PromoCodeConfigController` were individually driven through a real, listening HTTP server with
 * no/garbage auth. This is exactly R5's own framing, applied as a dedicated pass rather than
 * trusted from architecture alone (`AGENT-PROTOCOL.md` §3: "assert the observable property, not
 * the implementation string" — a guard applied "at the class level" is a claim about the source,
 * this file is the proof against the real, listening server).
 *
 * Boots the real `AppModule` against the real, already-migrated `promo_code` schema (root
 * `CLAUDE.md`), same convention `promo-code-config.e2e-spec.ts`/`campaign-binding.e2e-spec.ts`
 * already established — no guard/controller mock.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { createAppTestConnection } from '../config/support/app-connection';

describe('T-PC-041 — REST negative-authorization sweep, every admin/bind endpoint (e2e)', () => {
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
        `DELETE FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId`,
        { replacements: { tenantId } },
      );
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_config_audit
           WHERE promo_code_config_id IN (
             SELECT id FROM promo_code.promo_code_config WHERE tenant_id = :tenantId
           )`,
        { replacements: { tenantId } },
      );
      await sequelize.query('DELETE FROM promo_code.promo_code_config WHERE tenant_id = :tenantId', {
        replacements: { tenantId },
      });
    }
    await sequelize.close();
    await app.close();
  });

  function freshTenant(): string {
    const id = randomUUID();
    tenantIds.push(id);
    return id;
  }

  function validAuthHeader(): [string, string] {
    return ['Authorization', `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`];
  }

  /** A pre-provisioned config + binding, created through the real, authenticated REST endpoints,
   * so PATCH/DELETE have a real `:id` to target (a 401 on a route that 404s before the guard even
   * runs would prove nothing — `:id` must resolve to a real, existing row for every controller in
   * this suite). */
  async function seedConfig(): Promise<{ tenantId: string; actorId: string; configId: string }> {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const response = await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...validAuthHeader())
      .send({
        tenantId,
        actorId,
        name: `t-pc-041 rest-negative-auth ${randomUUID()}`,
        codeLength: 8,
        characterSet: 'ALPHANUMERIC',
        rewardValueType: 'FIXED_AMOUNT',
        rewardValue: 5,
        rewardUnit: 'USD',
      });
    if (response.status !== 201) {
      throw new Error(`seedConfig: create failed (${response.status}): ${JSON.stringify(response.body)}`);
    }
    return { tenantId, actorId, configId: response.body.id as string };
  }

  interface RouteUnderTest {
    name: string;
    request: (server: Parameters<typeof request>[0]) => request.Test;
  }

  let seeded: { tenantId: string; actorId: string; configId: string };

  beforeAll(async () => {
    seeded = await seedConfig();
  });

  function routes(): RouteUnderTest[] {
    return [
      {
        name: 'GET /api/v1/promo-code-configs',
        request: (server) =>
          request(server).get('/api/v1/promo-code-configs').query({ tenantId: seeded.tenantId }),
      },
      {
        name: 'POST /api/v1/promo-code-configs',
        request: (server) =>
          request(server).post('/api/v1/promo-code-configs').send({
            tenantId: seeded.tenantId,
            actorId: seeded.actorId,
            name: `t-pc-041 route-sweep ${randomUUID()}`,
            codeLength: 8,
            characterSet: 'ALPHANUMERIC',
            rewardValueType: 'FIXED_AMOUNT',
            rewardValue: 5,
            rewardUnit: 'USD',
          }),
      },
      {
        name: 'PATCH /api/v1/promo-code-configs/:id',
        request: (server) =>
          request(server)
            .patch(`/api/v1/promo-code-configs/${seeded.configId}`)
            .send({ tenantId: seeded.tenantId, actorId: seeded.actorId, rewardValue: 7 }),
      },
      {
        name: 'DELETE /api/v1/promo-code-configs/:id',
        request: (server) =>
          request(server)
            .delete(`/api/v1/promo-code-configs/${seeded.configId}`)
            .query({ tenantId: seeded.tenantId, actorId: seeded.actorId }),
      },
      {
        name: 'POST /api/v1/campaign-promo-configs',
        request: (server) =>
          request(server).post('/api/v1/campaign-promo-configs').send({
            promoCodeConfigId: seeded.configId,
            tenantId: seeded.tenantId,
            bindLevel: 'CAMPAIGN',
            bindRefId: randomUUID(),
            boundBy: seeded.actorId,
          }),
      },
    ];
  }

  // TC-1 — "on every admin CRUD + list endpoint... no endpoint missed"
  describe.each(routes().map((r) => [r.name, r] as const))('%s', (_name, route) => {
    it('TC-1: no Authorization header returns 401', async () => {
      const response = await route.request(app.getHttpServer());
      expect(response.status).toBe(401);
    });

    // TC-2
    it('TC-2: a garbage/malformed bearer token returns 401', async () => {
      const response = await route
        .request(app.getHttpServer())
        .set('Authorization', 'Bearer this-is-not-the-real-token');
      expect(response.status).toBe(401);
    });

    it('TC-2 (adjacent): an empty bearer token returns 401', async () => {
      const response = await route
        .request(app.getHttpServer())
        .set('Authorization', 'Bearer ');
      expect(response.status).toBe(401);
    });

    // Control: the same route, with the real token, is never itself a 401 — proves the 401s
    // above are the guard actually gating this specific route, not the route always failing for
    // an unrelated reason (a broken path, a 404 masquerading as "protected").
    it('control: the same route with a valid token never returns 401', async () => {
      const response = await route.request(app.getHttpServer()).set(...validAuthHeader());
      expect(response.status).not.toBe(401);
    });
  });

  // TC-12 (per-file slice): the health endpoint is deliberately unauthenticated (no internal-
  // service-token requirement — nothing in this service treats it as a sensitive surface) and is
  // recorded here, not omitted, so "every endpoint accounted for" in the checklist is a true
  // statement rather than an oversight.
  it('adjacent: GET /health is deliberately unauthenticated (not a missed guard)', async () => {
    const response = await request(app.getHttpServer()).get('/health');
    expect(response.status).not.toBe(401);
  });
});
