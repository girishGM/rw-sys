/**
 * T-108 — `/rule-resolvers` and `/rule-operators` against the real Postgres instance, through the
 * real `AppModule`, over real HTTP. A single non-`super_admin` actor is enough here (unlike
 * `rules.e2e-spec.ts`'s multi-role/multi-country matrix) — these two endpoints are global
 * reference data reachable by every role with no scoping decision to exercise, mirroring
 * `rule-categories.controller.ts`'s own "GET /rule-categories, /rule-sub-categories — reachable
 * by every role" test.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';

jest.setTimeout(300_000);

const SUITE = 't108';
const PASSWORD = 'correct horse battery staple 9!';
const EMAIL = 't108-e2e-maker@example.invalid';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let jar: string;

function http() {
  return request(app.getHttpServer());
}

function jarFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return entries
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  await app.init();

  db = app.get<Sequelize>(SEQUELIZE);
  await ensureEncryptionKeys(db, SUITE);
  emailCrypto = emailCryptoOf(app);

  // `maker` requires a non-null country_id + tenant_id (`ck_portal_users_scope`) — pick any
  // real, already-linked pair rather than hardcoding ids that may not exist in every environment.
  const [{ id: tenantId, countryId }] = await db.query<{ id: number; countryId: number }>(
    `SELECT id, country_id AS "countryId" FROM reward_config.tenants LIMIT 1`,
    { type: QueryTypes.SELECT },
  );

  await deletePortalUsersByEmail(db, emailCrypto, [EMAIL]);
  const userId = await insertPortalUser(db, emailCrypto, {
    email: EMAIL,
    displayName: 'T-108 maker',
    role: 'maker',
    countryId,
    tenantId,
    mustChangePassword: false,
  });
  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) } },
  );

  const response = await loginCompletingMfa(app, { email: EMAIL, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  jar = jarFrom(response);
});

afterAll(async () => {
  await deletePortalUsersByEmail(db, emailCrypto, [EMAIL]);
  await removeEncryptionKeys(db, SUITE);
  await app.close();
});

describe('T-108 — GET /rule-resolvers, /rule-operators', () => {
  it('TC-1: returns the 5 day-1 seeded resolvers', async () => {
    const res = await http().get('/api/v1/rule-resolvers').set('Cookie', jar);
    expect(res.status).toBe(200);
    const codes = (res.body.data as Array<{ resolverCode: string }>).map((r) => r.resolverCode);
    expect(codes.sort()).toEqual(
      [
        'AGGREGATE_SQL',
        'CUSTOMER_PROFILE_API',
        'JSONPATH_PAYLOAD',
        'SCHEDULE_CONTEXT',
        'TRACKER_STATE_LOOKUP',
      ].sort(),
    );
  });

  it('TC-2: returns the 13 day-1 seeded operators', async () => {
    const res = await http().get('/api/v1/rule-operators').set('Cookie', jar);
    expect(res.status).toBe(200);
    expect((res.body.data as unknown[]).length).toBe(13);
  });

  it('TC-3: unauthenticated is rejected', async () => {
    const res = await http().get('/api/v1/rule-resolvers');
    expect(res.status).toBe(401);
  });

  it('TC-4: response shape omits handlerClass/inputSchema/applicableDataTypes', async () => {
    const res = await http().get('/api/v1/rule-resolvers').set('Cookie', jar);
    const row = (res.body.data as Array<Record<string, unknown>>)[0];
    expect(row).not.toHaveProperty('handlerClass');
    expect(row).not.toHaveProperty('inputSchema');

    const opRes = await http().get('/api/v1/rule-operators').set('Cookie', jar);
    const opRow = (opRes.body.data as Array<Record<string, unknown>>)[0];
    expect(opRow).not.toHaveProperty('handlerClass');
    expect(opRow).not.toHaveProperty('applicableDataTypes');
  });
});
