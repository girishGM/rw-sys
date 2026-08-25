/**
 * T-041 — `/rules/:id/versions` (and the reward mirror) against the **real** Postgres
 * instance, through the real `AppModule`, over real HTTP, as every role. Follows the harness
 * `test/rules/rules.e2e-spec.ts` (T-031) establishes: real login (through MFA for
 * `super_admin`, T-055), real cookies, real guards.
 *
 * Verification step 8 ("Publish, then `UPDATE … SET expression='x'` in psql — trigger rejects
 * it") is proven for real here, not simulated — the T-005 immutability trigger this module
 * relies on as its "layer 3" (see `rule-versions.service.ts`'s own header) is exercised
 * directly with a raw `UPDATE`.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { createMigrationConnection } from '@/database/migration-connection';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import type { PortalRole } from '@/database/portal-models';
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
import { expectErrorEnvelope } from '../common/support/error-envelope';

jest.setTimeout(300_000);

const SUITE = 't041v';
const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_CODE = 'V1';
const RULE_CODE_PREFIX = 'T041VE2E';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryId: number;
let subCategoryId: number;
const createdRuleIds = new Set<number>();

interface Actor {
  readonly key: string;
  readonly email: string;
  readonly userId: number;
  readonly jar: string;
  readonly csrf: string;
}
const actors = new Map<string, Actor>();

function http() {
  return request(app.getHttpServer());
}

async function sql<T extends object>(
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(statement, { type: QueryTypes.SELECT, replacements });
}

async function exec(statement: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(statement, { type: QueryTypes.RAW, replacements });
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

async function makeActor(
  key: string,
  role: PortalRole,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null },
): Promise<Actor> {
  const email = `${SUITE}-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-041 ${key}`,
    role,
    ...scope,
    mustChangePassword: false,
  });

  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );

  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`login for ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const actor: Actor = {
    key,
    email,
    userId,
    jar: jarFrom(response),
    csrf: cookieValue(response, CSRF_COOKIE_NAME),
  };
  actors.set(key, actor);
  return actor;
}

function as(key: string): Actor {
  const actor = actors.get(key);
  if (actor === undefined) throw new Error(`no actor "${key}"`);
  return actor;
}

function get(key: string, path: string) {
  return http().get(`/api/v1${path}`).set('Cookie', as(key).jar);
}

function post(key: string, path: string, body: unknown = {}) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

function patch(key: string, path: string, body: unknown) {
  return http()
    .patch(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

async function ensureCountry(code: string, name: string): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    { code },
  );
  if (existing !== undefined) {
    await exec(`UPDATE reward_config.countries SET status = 'active' WHERE id = :id`, {
      id: existing.id,
    });
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, :name, 'UTC', 'USD', '+001', 'active') RETURNING id`,
    { code, name },
  );
  return created.id;
}

async function ensureSubCategory(): Promise<number> {
  const [row] = await sql<{ id: number }>(
    `SELECT rsc.id
       FROM reward_config.rule_sub_categories rsc
       JOIN reward_config.rule_categories rc ON rc.id = rsc.category_id
      WHERE rc.category_code = 'TRANSACTION' AND rsc.sub_category_code = 'GENERAL'
      LIMIT 1`,
  );
  if (row === undefined)
    throw new Error('seeded rule_sub_categories row not found — is T-004 applied?');
  return row.id;
}

let ruleCodeCounter = 0;
function ruleCode(suffix: string): string {
  ruleCodeCounter += 1;
  return `${RULE_CODE_PREFIX}_${Date.now()}_${ruleCodeCounter}_${suffix}`
    .slice(0, 80)
    .toUpperCase();
}

async function createRule(): Promise<number> {
  const response = await post('super', '/rules', {
    ruleCode: ruleCode('R'),
    name: 'T-041 e2e rule',
    subCategoryId,
    expression: 'amount >= :minSpend',
    parameters: {
      fields: [{ key: 'minSpend', label: 'Minimum spend', type: 'number', required: true }],
    },
  });
  expect(response.status).toBe(201);
  const id = response.body.data.id as number;
  createdRuleIds.add(id);
  return id;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  await app.listen(0);

  db = app.get<Sequelize>(SEQUELIZE);
  emailCrypto = emailCryptoOf(app);

  countryId = await ensureCountry(COUNTRY_CODE, 'T-041 e2e country');
  subCategoryId = await ensureSubCategory();

  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
  await makeActor('adminV', 'country_admin', { countryId, tenantId: null, merchantId: null });
});

afterAll(async () => {
  if (db !== undefined) {
    if (createdRuleIds.size > 0) {
      await exec(
        `DELETE FROM reward_config.rule_version_country_assignments WHERE rule_id IN (:ids)`,
        { ids: [...createdRuleIds] },
      );
      await exec(
        `DELETE FROM reward_config.version_blast_targets WHERE blast_id IN (
        SELECT id FROM reward_config.version_blasts WHERE entity_type = 'rule' AND entity_id IN (:ids)
      )`,
        { ids: [...createdRuleIds] },
      );
      await exec(
        `DELETE FROM reward_config.version_blasts WHERE entity_type = 'rule' AND entity_id IN (:ids)`,
        { ids: [...createdRuleIds] },
      );
      await exec(`DELETE FROM reward_config.rule_country_assignments WHERE rule_id IN (:ids)`, {
        ids: [...createdRuleIds],
      });
      // Undeletable published rows — the T-005 undeletability trigger — must go through the
      // same superuser escape hatch `t005-versioning-schema.e2e-spec.ts` documents in full.
      // `db` (the app's own `reward_app`-authenticated connection) has no privilege to alter a
      // trigger — confirmed live (a `reward_app`-scoped attempt fails) — so this one step uses
      // a dedicated migration/superuser connection, exactly like that suite's own teardown.
      const migration = createMigrationConnection();
      await migration.authenticate();
      await migration.query(
        `ALTER TABLE reward_config.rule_versions DISABLE TRIGGER trg_rule_versions_undeletable`,
        { type: QueryTypes.RAW },
      );
      await exec(`DELETE FROM reward_config.rule_versions WHERE rule_id IN (:ids)`, {
        ids: [...createdRuleIds],
      });
      await migration.query(
        `ALTER TABLE reward_config.rule_versions ENABLE TRIGGER trg_rule_versions_undeletable`,
        { type: QueryTypes.RAW },
      );
      await migration.close();
      await exec(`DELETE FROM reward_config.rule_master WHERE id IN (:ids)`, {
        ids: [...createdRuleIds],
      });
    }
    for (const actor of actors.values()) {
      await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: actor.userId });
    }
    await removeEncryptionKeys(db, SUITE);
  }
  if (app !== undefined) await app.close();
});

describe('T-041 — POST /rules/:id/versions — draft lifecycle', () => {
  it('TC-1: creates v1 bootstrapped from rule_master (no prior version)', async () => {
    const ruleId = await createRule();
    const response = await post('super', `/rules/${String(ruleId)}/versions`, {});
    expect(response.status).toBe(201);
    expect(response.body.data.versionNo).toBe(1);
    expect(response.body.data.status).toBe('draft');
    expect(response.body.data.supersedesVersionId).toBeNull();
  });

  it('TC-2: a second concurrent draft → 409', async () => {
    const ruleId = await createRule();
    const first = await post('super', `/rules/${String(ruleId)}/versions`, {});
    expect(first.status).toBe(201);

    const second = await post('super', `/rules/${String(ruleId)}/versions`, {});
    expect(second.status).toBe(409);
    expectErrorEnvelope(second.body, 'VERSION_DRAFT_ALREADY_EXISTS');
  });

  it('country_admin POST /rules/:id/versions → 403', async () => {
    const ruleId = await createRule();
    const response = await post('adminV', `/rules/${String(ruleId)}/versions`, {});
    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PERM_DENIED');
  });

  it('unauthenticated → 401', async () => {
    const ruleId = await createRule();
    const response = await http()
      .post(`/api/v1/rules/${String(ruleId)}/versions`)
      .send({});
    expect(response.status).toBe(401);
  });

  it('TC-3: edits a draft — 200', async () => {
    const ruleId = await createRule();
    const created = await post('super', `/rules/${String(ruleId)}/versions`, {});
    const versionId = created.body.data.id as number;

    const response = await patch(
      'super',
      `/rules/${String(ruleId)}/versions/${String(versionId)}`,
      {
        expression: 'amount >= 100',
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.data.expression).toBe('amount >= 100');
  });

  it('TC-5/TC-6: publish a draft, then publishing again → 409', async () => {
    const ruleId = await createRule();
    const created = await post('super', `/rules/${String(ruleId)}/versions`, {});
    const versionId = created.body.data.id as number;

    const published = await post(
      'super',
      `/rules/${String(ruleId)}/versions/${String(versionId)}/publish`,
    );
    expect(published.status).toBe(201);
    expect(published.body.data.status).toBe('published');
    expect(published.body.data.publishedBy).not.toBeNull();

    const again = await post(
      'super',
      `/rules/${String(ruleId)}/versions/${String(versionId)}/publish`,
    );
    expect(again.status).toBe(409);
    expectErrorEnvelope(again.body, 'VERSION_INVALID_TRANSITION');
  });

  it('TC-4: editing a published version → 409, and the DB trigger independently rejects a direct UPDATE (verification step 8)', async () => {
    const ruleId = await createRule();
    const created = await post('super', `/rules/${String(ruleId)}/versions`, {});
    const versionId = created.body.data.id as number;
    await post('super', `/rules/${String(ruleId)}/versions/${String(versionId)}/publish`);

    const apiAttempt = await patch(
      'super',
      `/rules/${String(ruleId)}/versions/${String(versionId)}`,
      { expression: 'tampered' },
    );
    expect(apiAttempt.status).toBe(409);
    expectErrorEnvelope(apiAttempt.body, 'VERSION_INVALID_TRANSITION');

    // Verification step 8 — the app-level check above is not the only guard. A raw SQL UPDATE,
    // bypassing this portal's own API entirely, is independently rejected by `T005_007`'s
    // `trg_rule_versions_immutable` trigger.
    await expect(
      db.query(`UPDATE reward_config.rule_versions SET expression = 'x' WHERE id = :id`, {
        type: QueryTypes.RAW,
        replacements: { id: versionId },
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it('deprecate requires published; retire requires deprecated (06-VERSIONING.md §4.3)', async () => {
    const ruleId = await createRule();
    const created = await post('super', `/rules/${String(ruleId)}/versions`, {});
    const versionId = created.body.data.id as number;

    const deprecateBeforePublish = await post(
      'super',
      `/rules/${String(ruleId)}/versions/${String(versionId)}/deprecate`,
    );
    expect(deprecateBeforePublish.status).toBe(409);

    await post('super', `/rules/${String(ruleId)}/versions/${String(versionId)}/publish`);
    const retireBeforeDeprecate = await post(
      'super',
      `/rules/${String(ruleId)}/versions/${String(versionId)}/retire`,
    );
    expect(retireBeforeDeprecate.status).toBe(409);

    const deprecated = await post(
      'super',
      `/rules/${String(ruleId)}/versions/${String(versionId)}/deprecate`,
    );
    expect(deprecated.status).toBe(201);
    expect(deprecated.body.data.status).toBe('deprecated');

    const retired = await post(
      'super',
      `/rules/${String(ruleId)}/versions/${String(versionId)}/retire`,
    );
    expect(retired.status).toBe(201);
    expect(retired.body.data.status).toBe('retired');

    // TC-24: the retired version still resolves — retirement never deletes the row.
    const stillResolves = await get(
      'super',
      `/rules/${String(ruleId)}/versions/${String(versionId)}`,
    );
    expect(stillResolves.status).toBe(200);
    expect(stillResolves.body.data.status).toBe('retired');
  });

  it('TC-25/TC-26: diff highlights a removed parameter and suggests is_breaking', async () => {
    const ruleId = await createRule();
    const v1 = await post('super', `/rules/${String(ruleId)}/versions`, {});
    const v1Id = v1.body.data.id as number;
    await patch('super', `/rules/${String(ruleId)}/versions/${String(v1Id)}`, {
      parameters: { fields: [{ key: 'minSpend', label: 'Min', type: 'number', required: true }] },
    });
    await post('super', `/rules/${String(ruleId)}/versions/${String(v1Id)}/publish`);

    const v2 = await post('super', `/rules/${String(ruleId)}/versions`, {});
    const v2Id = v2.body.data.id as number;
    expect(v2.body.data.supersedesVersionId).toBe(v1Id);

    await patch('super', `/rules/${String(ruleId)}/versions/${String(v2Id)}`, {
      parameters: { fields: [] },
    });

    const diff = await get(
      'super',
      `/rules/${String(ruleId)}/versions/${String(v1Id)}/diff/${String(v2Id)}`,
    );
    expect(diff.status).toBe(200);
    expect(diff.body.data.parametersRemoved).toEqual(['minSpend']);
    expect(diff.body.data.suggestedIsBreaking).toBe(true);

    // Confirming isBreaking: false without an override is refused (implementation note 9).
    const refused = await patch('super', `/rules/${String(ruleId)}/versions/${String(v2Id)}`, {
      isBreaking: false,
    });
    expect(refused.status).toBe(422);
    expectErrorEnvelope(refused.body, 'VERSION_BREAKING_CONFIRMATION_REQUIRED');

    const confirmed = await patch('super', `/rules/${String(ruleId)}/versions/${String(v2Id)}`, {
      isBreaking: true,
      confirmBreakingOverride: true,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.isBreaking).toBe(true);
  });
});
