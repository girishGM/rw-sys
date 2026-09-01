/**
 * T-PC-011. TC-16: the full admin lifecycle over real HTTP against the real, already-migrated
 * `promo_code` schema — create → list (appears) → archive → list (no longer appears) — each
 * step's expected state observed against a real Postgres 16 server (root `CLAUDE.md`), not a
 * mocked layer, per `AGENT-PROTOCOL.md` §3.
 *
 * TC-1..TC-15 (individual endpoint behaviour) live in `promo-code-config.controller.spec.ts`
 * instead; this file is the one specifically-named "full e2e" case the task's own Verification
 * step 2 calls out.
 *
 * Deviation from the task file's literal path (`test/modules/promo-code-config/
 * promo-code-config.e2e-spec.ts`) and from Verification step 2's literal command
 * (`npm run test:e2e -- promo-code-config`): see this task's completion report — both are
 * adapted to this agent's actual granted file scope (`test/config/**`) and to `package.json`'s
 * actual `scripts` (no separate `test:e2e` script exists; `npm test`'s own `testRegex` already
 * matches both `.spec.ts` and `.e2e-spec.ts` files under `test/`, and `AGENT-PROTOCOL.md` §4's
 * own DoD gate table only ever runs plain `npm test`).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { createAppTestConnection } from './support/app-connection';

describe('T-PC-011 — PromoCodeConfig admin lifecycle (e2e)', () => {
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

  function freshTenant(): string {
    const id = randomUUID();
    tenantIds.push(id);
    return id;
  }

  function authHeader(): [string, string] {
    return ['Authorization', `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`];
  }

  // TC-16
  it('create → list (appears) → archive → list (no longer appears)', async () => {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const name = `t-pc-011 e2e ${randomUUID()}`;

    const createResponse = await request(app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader())
      .send({
        tenantId,
        actorId,
        name,
        codeLength: 8,
        characterSet: 'ALPHANUMERIC',
        rewardValueType: 'FIXED_AMOUNT',
        rewardValue: 15,
        rewardUnit: 'USD',
      });
    expect(createResponse.status).toBe(201);
    const configId = createResponse.body.id as string;

    const listAfterCreate = await request(app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId })
      .set(...authHeader());
    expect(listAfterCreate.status).toBe(200);
    expect(listAfterCreate.body.configs.map((c: { id: string }) => c.id)).toContain(configId);

    const archiveResponse = await request(app.getHttpServer())
      .delete(`/api/v1/promo-code-configs/${configId}`)
      .query({ tenantId, actorId })
      .set(...authHeader());
    expect([200, 204]).toContain(archiveResponse.status);
    expect(archiveResponse.body.status).toBe('ARCHIVED');

    const listAfterArchive = await request(app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId })
      .set(...authHeader());
    expect(listAfterArchive.status).toBe(200);
    expect(listAfterArchive.body.configs.map((c: { id: string }) => c.id)).not.toContain(configId);
  });
});
