/**
 * T-114 — resolver-driven parameter-field `role`, against the real Postgres instance, through
 * the real `AppModule`, over real HTTP. Exercises the T-105-seeded global rules directly
 * (`RULE_COMP_COMPLETED_001`, wired to `TRACKER_STATE_LOOKUP`; `RULE_TXN_TYPE_001`, wired to
 * `JSONPATH_PAYLOAD`) rather than authoring new resolver-wired fixtures — those seeds already
 * cover a real "resolver_input" case and a real "compare_value-only" case
 * (`T105_002_seed_sample_rule_masters.ts`), so this suite proves the wiring end to end instead
 * of re-deriving what `T108`/`T105` already established.
 *
 * `AGENT-PROTOCOL §3`: "assert the observable property … in a client that actually enforces the
 * rules" — the write-side assertion below (TC-6) goes through the real `ValidationPipe`, not a
 * hand-rolled schema parse, so a regression in the controller wiring would actually fail this.
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
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
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

const SUITE = 't114';
const PASSWORD = 'correct horse battery staple 14!';
const SUPER_ADMIN_EMAIL = 't114-e2e-super@example.invalid';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let jar: string;
let csrf: string;

/** `rule_master.id` for the two T-105 seeded fixtures this suite reads. */
let compCompletedRuleId: number;
let txnTypeRuleId: number;
/** Every rule this suite itself creates (TC-4's "unwired" case), deleted in `afterAll`. */
const createdRuleIds: number[] = [];
let subCategoryId: number;

function http() {
  return request(app.getHttpServer());
}

function cookieValue(response: request.Response, name: string): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const match = entries.find((entry) => entry.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return decodeURIComponent(match.split(';')[0].slice(name.length + 1));
}

function jarFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return entries
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

interface FieldWithRole {
  readonly key: string;
  readonly role: string;
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

  const [compCompleted] = await db.query<{ id: number }>(
    `SELECT id FROM reward_config.rule_master WHERE rule_code = 'RULE_COMP_COMPLETED_001'`,
    { type: QueryTypes.SELECT },
  );
  const [txnType] = await db.query<{ id: number }>(
    `SELECT id FROM reward_config.rule_master WHERE rule_code = 'RULE_TXN_TYPE_001'`,
    { type: QueryTypes.SELECT },
  );
  if (compCompleted === undefined || txnType === undefined) {
    throw new Error(
      't114 e2e: T-105 seed rules not found — did T105_002_seed_sample_rule_masters run?',
    );
  }
  compCompletedRuleId = compCompleted.id;
  txnTypeRuleId = txnType.id;

  const [subCategory] = await db.query<{ id: number }>(
    `SELECT sub_category_id AS id FROM reward_config.rule_master WHERE id = :id`,
    { type: QueryTypes.SELECT, replacements: { id: compCompletedRuleId } },
  );
  subCategoryId = subCategory.id;

  await deletePortalUsersByEmail(db, emailCrypto, [SUPER_ADMIN_EMAIL]);
  const userId = await insertPortalUser(db, emailCrypto, {
    email: SUPER_ADMIN_EMAIL,
    displayName: 'T-114 super_admin',
    role: 'super_admin',
    countryId: null,
    tenantId: null,
    merchantId: null,
    mustChangePassword: false,
  });
  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) } },
  );

  const response = await loginCompletingMfa(
    app,
    { email: SUPER_ADMIN_EMAIL, password: PASSWORD },
    db,
  );
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  jar = jarFrom(response);
  csrf = cookieValue(response, CSRF_COOKIE_NAME);
});

afterAll(async () => {
  for (const id of createdRuleIds) {
    await db.query(`DELETE FROM reward_config.rule_master WHERE id = :id`, {
      type: QueryTypes.RAW,
      replacements: { id },
    });
  }
  await deletePortalUsersByEmail(db, emailCrypto, [SUPER_ADMIN_EMAIL]);
  await removeEncryptionKeys(db, SUITE);
  await app.close();
});

describe('T-114 — resolver-driven parameter-field role', () => {
  it('TC-5: GET /rule-resolvers shows the seeded resolverInputFieldKeys per resolver', async () => {
    const res = await http().get('/api/v1/rule-resolvers').set('Cookie', jar);
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ resolverCode: string; resolverInputFieldKeys: string[] }>;

    const trackerStateLookup = rows.find((r) => r.resolverCode === 'TRACKER_STATE_LOOKUP');
    expect(trackerStateLookup?.resolverInputFieldKeys).toEqual(['targetComponentCode']);

    const jsonPathPayload = rows.find((r) => r.resolverCode === 'JSONPATH_PAYLOAD');
    expect(jsonPathPayload?.resolverInputFieldKeys).toEqual([]);
  });

  it('TC-1/TC-2: GET /rules/:id for a rule wired to TRACKER_STATE_LOOKUP — targetComponentCode is resolver_input, value is compare_value', async () => {
    const res = await http().get(`/api/v1/rules/${compCompletedRuleId}`).set('Cookie', jar);
    expect(res.status).toBe(200);

    const fields = (res.body.data.parameters.fields as FieldWithRole[]) ?? [];
    expect(fields.find((f) => f.key === 'targetComponentCode')?.role).toBe('resolver_input');
    expect(fields.find((f) => f.key === 'value')?.role).toBe('compare_value');
  });

  it('TC-3: GET /rules/:id for a rule wired to JSONPATH_PAYLOAD — every field is compare_value', async () => {
    const res = await http().get(`/api/v1/rules/${txnTypeRuleId}`).set('Cookie', jar);
    expect(res.status).toBe(200);

    const fields = (res.body.data.parameters.fields as FieldWithRole[]) ?? [];
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((f) => f.role === 'compare_value')).toBe(true);
  });

  it('GET /rules/:id/parameters carries the same role annotation as GET /rules/:id (TC-15 parity)', async () => {
    const res = await http()
      .get(`/api/v1/rules/${compCompletedRuleId}/parameters`)
      .set('Cookie', jar);
    expect(res.status).toBe(200);

    const fields = (res.body.data.fields as FieldWithRole[]) ?? [];
    expect(fields.find((f) => f.key === 'targetComponentCode')?.role).toBe('resolver_input');
  });

  it('TC-4: a freshly created rule (no version yet) — every field is compare_value, no error', async () => {
    const res = await http()
      .post('/api/v1/rules')
      .set('Cookie', jar)
      .set('X-CSRF-Token', csrf)
      .send({
        ruleCode: `T114_E2E_${Date.now()}`,
        name: 'T-114 e2e unwired rule',
        subCategoryId,
        parameters: {
          fields: [{ key: 'value', label: 'Value', type: 'string', required: true }],
        },
      });
    expect(res.status).toBe(201);
    createdRuleIds.push(res.body.data.id as number);

    const fields = (res.body.data.parameters.fields as FieldWithRole[]) ?? [];
    expect(fields[0]?.role).toBe('compare_value');
  });

  it('TC-6: POST /rules with a client-supplied parameters.fields[].role — 400, unknown key rejected', async () => {
    const res = await http()
      .post('/api/v1/rules')
      .set('Cookie', jar)
      .set('X-CSRF-Token', csrf)
      .send({
        ruleCode: `T114_E2E_ROLE_${Date.now()}`,
        name: 'T-114 e2e client-supplied role',
        subCategoryId,
        parameters: {
          fields: [
            {
              key: 'value',
              label: 'Value',
              type: 'string',
              required: true,
              role: 'resolver_input',
            },
          ],
        },
      });
    expect(res.status).toBe(400);
  });

  it('unauthenticated — 401', async () => {
    const res = await http().get(`/api/v1/rules/${compCompletedRuleId}`);
    expect(res.status).toBe(401);
  });
});
