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
import { QueryTypes } from 'sequelize';
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
      await cleanupTenant(sequelize, tenantId);
    }
    await sequelize.close();
    await app.close();
  });

  /**
   * T-PC-065: `seedConfig()` creates every config through the real `POST
   * /api/v1/promo-code-configs` endpoint, which — since T-PC-058 split payout fields onto a
   * versioned `promo_code_config_version` row — always opens at least a `draft` version in the
   * same transaction. `promo_code_config_version.promo_code_config_id` has no `ON DELETE CASCADE`,
   * so an unconditional `DELETE FROM promo_code_config` throws a foreign-key violation that
   * crashes the whole suite (`Test suite failed to run`, not an individual test failure) —
   * reproduced directly on the pre-fix body of this function via `npx jest
   * test/security/rest-negative-auth.spec.ts` before this fix. The final delete is therefore
   * childless-only: a config that still has a version child (every config this file creates) is
   * left in place, same "immutable history, not a leak this test can or should work around"
   * pattern already established by `test/config/promo-code-config-version.spec.ts`'s own
   * `afterAll` and applied identically across every other promo-code-config/campaign-binding spec
   * that hit this same FK shape (`test/binding/campaign-binding.e2e-spec.ts`,
   * `test/e2e/setup/e2e-test-app.ts`, etc). A published/deprecated version row is additionally
   * permanently undeletable by `trg_promo_code_config_version_undeletable`, but the childless-only
   * filter is what actually matters here — it's the FK, not the trigger, that crashed this suite.
   */
  async function cleanupTenant(db: Sequelize, tenantId: string): Promise<void> {
    await db.query('DELETE FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId', {
      replacements: { tenantId },
    });
    await db.query(
      `DELETE FROM promo_code.promo_code_config_audit
         WHERE promo_code_config_id IN (
           SELECT id FROM promo_code.promo_code_config WHERE tenant_id = :tenantId
         )`,
      { replacements: { tenantId } },
    );
    await db.query(
      `DELETE FROM promo_code.promo_code_config c
         WHERE c.tenant_id = :tenantId
           AND NOT EXISTS (
             SELECT 1 FROM promo_code.promo_code_config_version v
              WHERE v.promo_code_config_id = c.id
           )`,
      { replacements: { tenantId } },
    );
  }

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
      throw new Error(
        `seedConfig: create failed (${response.status}): ${JSON.stringify(response.body)}`,
      );
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
          request(server)
            .post('/api/v1/promo-code-configs')
            .send({
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
      const response = await route.request(app.getHttpServer()).set('Authorization', 'Bearer ');
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

  // T-PC-065 regression coverage for `cleanupTenant`'s own childless-only filter.
  describe('T-PC-065 regression — cleanupTenant tolerates a version-child config row', () => {
    it('TC-3: does not throw a foreign-key violation for a config seedConfig() created (which always has a version child), and leaves that row in place', async () => {
      const { tenantId, configId } = await seedConfig();

      // Proves R58's own FK shape didn't change under us: the config really does have a version
      // child before cleanup runs, which is exactly the precondition the unfixed body of
      // `cleanupTenant` (an unconditional `DELETE FROM promo_code_config`) could not tolerate.
      const [{ count: versionCountBefore }] = await sequelize.query<{ count: string }>(
        'SELECT COUNT(*)::int AS count FROM promo_code.promo_code_config_version WHERE promo_code_config_id = :configId',
        { type: QueryTypes.SELECT, replacements: { configId } },
      );
      expect(Number(versionCountBefore)).toBeGreaterThan(0);

      // The assertion that matters: on the pre-fix body (`DELETE FROM promo_code_config WHERE
      // tenant_id = :tenantId`, no childless filter) this rejects with a foreign-key-violation and
      // the `await` below throws, failing this test — confirmed by reverting `cleanupTenant` to
      // that body and re-running this file with `npx jest test/security/rest-negative-auth.spec.ts`.
      await cleanupTenant(sequelize, tenantId);

      const rows = await sequelize.query(
        'SELECT id FROM promo_code.promo_code_config WHERE id = :configId',
        { type: QueryTypes.SELECT, replacements: { configId } },
      );
      expect(rows).toHaveLength(1);
    });

    it('TC-4 (adjacent): a genuinely childless config row is still deleted', async () => {
      const tenantId = freshTenant();
      const actorId = randomUUID();
      // Deliberately bypasses the real `POST` endpoint (unlike `seedConfig()`) so this row never
      // gets a version child — see `promo-code-config-version.migration.spec.ts`'s own
      // `insertIdentity()` for the same "identity row only" pattern this mirrors.
      const [{ id: configId }] = await sequelize.query<{ id: string }>(
        `INSERT INTO promo_code.promo_code_config (tenant_id, merchant_id, name, created_by, updated_by)
         VALUES (:tenantId, :merchantId, :name, :actorId, :actorId)
         RETURNING id`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            tenantId,
            merchantId: null,
            name: `t-pc-065 childless-config ${randomUUID()}`,
            actorId,
          },
        },
      );

      await cleanupTenant(sequelize, tenantId);

      const rows = await sequelize.query(
        'SELECT id FROM promo_code.promo_code_config WHERE id = :configId',
        { type: QueryTypes.SELECT, replacements: { configId } },
      );
      expect(rows).toHaveLength(0);
    });
  });
});
