/**
 * T-149 — Wave 7 verification, cross-task flow: a rule authored with `defaultOperators` (T-109/
 * T-110), confirmed against the registry read APIs the "Value Sources" screen (T-146) and the
 * rule/operator pickers both draw from, applied to a real two-component campaign journey (T-037)
 * where a Maker picks an operator and a per-component combination logic (T-147/T-148) — against
 * the **real** Postgres instance, through the real `AppModule`, over real HTTP, as real actors.
 *
 * ### Why this file exists on top of `campaigns.e2e-spec.ts`'s own `T-147 ·` describe block
 *
 * That block (T-147's own "Files owned") already proves every individual piece — `defaultOperators`
 * on the rule-options read path, an operator persisting through a `PATCH`, `ruleLogic`/
 * `ruleThreshold` persisting through a `PATCH`, and both surfacing together on one `GET .../journey`
 * call. What none of it does: build a journey with **two** components (T-149's own spec calls for
 * one, matching this wave's mockup, which shows the picker used mid-journey, not on a single-
 * component toy), actually **submit** the campaign (moving it out of `draft`, the only state every
 * other T-147 case leaves it in) and confirm the four values are still exactly what was left after
 * that status transition, and tie the flow to T-146's registries (`GET /rule-operators`,
 * `GET /field-context-providers`, `GET /field-api-lookup-providers`) rather than assuming their
 * data. Per T-149's own task file: *"only [add a new spec] if no existing suite already covers the
 * cross-task flow below"* — it does not, so this file adds exactly that flow and nothing else
 * (no re-authoring of T-146/T-147/T-148 source, per that same task file's Scope/Out).
 *
 * Run twice in direct succession against a fresh campaign each time (two `it` blocks, not a loop
 * inside one) to prove TC-1's idempotency requirement — same discipline `t127-promo-code-attach
 * .e2e-spec.ts` and `wave6/rules-rewards-value-sources.e2e-spec.ts` already established for this
 * suite family: every fixture is either `ensure*` (idempotent) or explicitly cleaned up, so a
 * second pass through the same flow leaves no residue and asserts identically.
 *
 * ### Isolation
 *
 * Every fixture is prefixed `T149E2E` / `T-149 …`, cleaned up via the **shared, tenant-scoped**
 * `purgeSuiteResidue` (T-132/T-144) — never a local, unscoped copy.
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
import {
  clearProvidedKeyMaterial,
  provideMissingKeyMaterial,
} from '../campaigns/support/foreign-key-material';
import { purgeSuiteResidue } from '../campaigns/support/purge-suite-residue';

jest.setTimeout(300_000);

const SUITE = 't149';
const PASSWORD = 'correct horse battery staple 149!';
const PREFIX = 'T149E2E';
const COUNTRY_CODE = 'W7';
const USER_DISPLAY_PREFIX = 'T-149';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let borrowedKeyVars: string[] = [];

let adminUserId: number;
let countryId: number;
let tenantId: number;
let merchantId: number;
let activityId: number;
let transactionGeneralSubCategoryId: number;
let rewardPolicyId: number;

const createdCampaignIds = new Set<number>();
const createdRuleIds: number[] = [];

interface Actor {
  readonly email: string;
  readonly userId: number;
  readonly jar: string;
  readonly csrf: string;
}
const actors = new Map<string, Actor>();

// --- plumbing --------------------------------------------------------------------------------

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
  try {
    await db.query(statement, { type: QueryTypes.RAW, replacements });
  } catch (error) {
    // See `purge-suite-residue.ts` for why this is worth wrapping: a Sequelize error thrown
    // inside `beforeAll` otherwise reaches Jest's reporter with an empty `message` and no SQL.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `fixture statement failed:\n${statement}\n→ ${reason === '' ? String(error) : reason}`,
      { cause: error },
    );
  }
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
  const email = `t149-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `${USER_DISPLAY_PREFIX} ${key}`,
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

// --- fixtures --------------------------------------------------------------------------------

async function ensureAdminUserId(): Promise<number> {
  const [row] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.admin_users ORDER BY id LIMIT 1',
  );
  if (row === undefined) throw new Error('no admin_users rows — cannot author fixture versions');
  return row.id;
}

async function ensureCountry(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    { code: COUNTRY_CODE },
  );
  if (existing !== undefined) {
    await exec(`UPDATE reward_config.countries SET status = 'active' WHERE id = :id`, {
      id: existing.id,
    });
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, 'T-149 e2e country', 'Asia/Kuala_Lumpur', 'MYR', '+060', 'active') RETURNING id`,
    { code: COUNTRY_CODE },
  );
  return created.id;
}

async function ensureTenant(): Promise<number> {
  const code = `${PREFIX}_TENANT`;
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenants SET status = 'active', deleted_at = NULL, country_id = :countryId
        WHERE id = :id`,
      { id: existing.id, countryId },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code, countryId },
  );
  // T-126: `tenant_currencies` only backfills tenants that existed at migration time — a tenant
  // created afterwards needs its own default row, or `tenant-currencies-schema.e2e-spec.ts`'s
  // "every live tenant has exactly one is_default row" invariant goes red for every suite that
  // runs after this one. Same fixture gap `wave6/rules-rewards-value-sources.e2e-spec.ts` already
  // documents and works around.
  await exec(
    `INSERT INTO reward_config.tenant_currencies (tenant_id, currency_code, is_default, status)
     VALUES (:tenantId, 'MYR', true, 'active')`,
    { tenantId: created.id },
  );
  return created.id;
}

async function ensureMerchant(): Promise<number> {
  const code = `${PREFIX}_M`;
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.merchants WHERE merchant_code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, :countryCode, 'active') RETURNING id`,
    { tenantId, code, countryCode: COUNTRY_CODE },
  );
  return created.id;
}

async function ensureActivity(): Promise<number> {
  const [type] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activity_types ORDER BY id LIMIT 1',
  );
  if (type === undefined) throw new Error('no activity_types rows — is the schema seeded?');

  const code = `${PREFIX}_ACT`;
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activities WHERE tenant_id = :tenantId AND activity_code = :code',
    { tenantId, code },
  );
  const id =
    existing?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.activities (tenant_id, type_id, activity_code, name, status)
         VALUES (:tenantId, :typeId, :code, :code, 'active') RETURNING id`,
        { tenantId, typeId: type.id, code },
      )
    )[0].id;

  const [link] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.merchant_activities
      WHERE merchant_id = :merchantId AND activity_id = :activityId AND store_id IS NULL`,
    { merchantId, activityId: id },
  );
  if (link === undefined) {
    await exec(
      `INSERT INTO reward_config.merchant_activities (tenant_id, merchant_id, activity_id, status)
       VALUES (:tenantId, :merchantId, :activityId, 'active')`,
      { tenantId, merchantId, activityId: id },
    );
  }
  return id;
}

async function ensureTransactionGeneralSubCategoryId(): Promise<number> {
  const [row] = await sql<{ id: number }>(
    `SELECT rsc.id FROM reward_config.rule_sub_categories rsc
       JOIN reward_config.rule_categories rc ON rc.id = rsc.category_id
      WHERE rc.category_code = 'TRANSACTION' AND rsc.sub_category_code = 'GENERAL' LIMIT 1`,
  );
  if (row === undefined) {
    throw new Error(
      't149 e2e: seeded rule_sub_categories TRANSACTION/GENERAL not found — did T105_001 run?',
    );
  }
  return row.id;
}

/** A plain, campaign-level attachable reward — nothing Kind-specific (T-127's territory), just
 * enough for `CAMPAIGN_HAS_NO_REWARD` to clear on submission. */
async function ensureRewardPolicy(): Promise<number> {
  const code = `${PREFIX}_RWD`;
  const [existingSystem] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_systems WHERE system_code = :code',
    { code },
  );
  const rewardId =
    existingSystem?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.reward_systems
           (tenant_id, system_code, name, reward_type, connector_type, status)
         VALUES (NULL, :code, :code, 'cashback', 'internal', 'active') RETURNING id`,
        { code },
      )
    )[0].id;

  const [countryAssignment] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_country_assignments WHERE reward_id = :rewardId AND country_id = :countryId',
    { rewardId, countryId },
  );
  if (countryAssignment === undefined) {
    await exec(
      `INSERT INTO reward_config.reward_country_assignments (reward_id, country_id, assigned_by)
       VALUES (:rewardId, :countryId, :adminUserId)`,
      { rewardId, countryId, adminUserId },
    );
  }

  const [existingVersion] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_versions WHERE reward_id = :rewardId AND version_no = 1',
    { rewardId },
  );
  const versionId =
    existingVersion?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.reward_versions
           (reward_id, version_no, unit_type, unit_code, status, created_by, published_by, published_at)
         VALUES (:rewardId, 1, 'currency', 'MYR', 'published', :adminUserId, :adminUserId, now())
         RETURNING id`,
        { rewardId, adminUserId },
      )
    )[0].id;

  const [versionAssignment] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_version_country_assignments
      WHERE reward_version_id = :versionId AND country_id = :countryId`,
    { versionId, countryId },
  );
  if (versionAssignment === undefined) {
    await exec(
      `INSERT INTO reward_config.reward_version_country_assignments
         (reward_version_id, reward_id, country_id, status, assigned_by)
       VALUES (:versionId, :rewardId, :countryId, 'active', :adminUserId)`,
      { versionId, rewardId, countryId, adminUserId },
    );
  }

  const [existingPolicy] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_policies
      WHERE reward_system_id = :rewardId AND policy_code = :code`,
    { rewardId, code },
  );
  if (existingPolicy !== undefined) return existingPolicy.id;
  const [createdPolicy] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_policies (reward_system_id, policy_code, name, config, status)
     VALUES (:rewardId, :code, :code, :config, 'active') RETURNING id`,
    { rewardId, code, config: JSON.stringify({ amount: '10.00' }) },
  );
  return createdPolicy.id;
}

function inDays(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

let campaignSeq = 0;
async function createDraftWithTracker(): Promise<{ id: number; trackerId: number }> {
  campaignSeq += 1;
  const created = await post('maker', '/campaigns', {
    campaignCode: `${PREFIX}_C${String(Date.now())}_${String(campaignSeq)}`,
    name: 'T-149 e2e campaign',
    startDate: inDays(1),
    endDate: inDays(30),
    budgetAmount: '100000.00',
    budgetCurrency: 'MYR',
  });
  if (created.status !== 201) {
    throw new Error(`createDraft failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const id = created.body.data.id as number;
  createdCampaignIds.add(id);

  await post('maker', `/campaigns/${String(id)}/merchants`, { merchantIds: [merchantId] }).expect(
    201,
  );
  const tracker = await post('maker', `/campaigns/${String(id)}/trackers`, {
    name: 'Onboarding',
    completionLogic: 'all',
  }).expect(201);
  return { id, trackerId: tracker.body.data.trackers[0].id as number };
}

async function addComponent(campaignId: number, trackerId: number, name: string): Promise<number> {
  const response = await post(
    'maker',
    `/campaigns/${String(campaignId)}/trackers/${String(trackerId)}/components`,
    { name, activityId },
  ).expect(201);
  const tracker = (
    response.body.data.trackers as { id: number; components: { id: number; name: string }[] }[]
  ).find((row) => row.id === trackerId);
  const component = tracker?.components.find((row) => row.name === name);
  if (component === undefined) throw new Error(`addComponent: "${name}" not found in journey`);
  return component.id;
}

// --- lifecycle -------------------------------------------------------------------------------

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);
  borrowedKeyVars = await provideMissingKeyMaterial(moduleRef.get<Sequelize>(SEQUELIZE));

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

  await purgeSuiteResidue({ prefix: PREFIX, userDisplayNamePrefix: USER_DISPLAY_PREFIX });

  adminUserId = await ensureAdminUserId();
  countryId = await ensureCountry();
  tenantId = await ensureTenant();
  merchantId = await ensureMerchant();
  activityId = await ensureActivity();
  transactionGeneralSubCategoryId = await ensureTransactionGeneralSubCategoryId();
  rewardPolicyId = await ensureRewardPolicy();

  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
  await makeActor('maker', 'maker', { countryId, tenantId, merchantId: null });
});

afterAll(async () => {
  // Everything that touches the app's own `db` (Sequelize) — including `removeEncryptionKeys`,
  // which also queries through it — must run **before** `app.close()` tears that connection down;
  // ordering documented at length in `t127-promo-code-attach.e2e-spec.ts`'s own `afterAll` and
  // `wave6/rules-rewards-value-sources.e2e-spec.ts`'s.
  if (db !== undefined && createdRuleIds.length > 0) {
    const migration = createMigrationConnection();
    await migration.authenticate();
    await migration.query(
      `ALTER TABLE reward_config.rule_versions DISABLE TRIGGER trg_rule_versions_undeletable`,
      { type: QueryTypes.RAW },
    );
    for (const id of createdRuleIds) {
      await exec('DELETE FROM reward_config.tracker_component_rules WHERE rule_id = :id', { id });
      await exec('DELETE FROM reward_config.rule_version_country_assignments WHERE rule_id = :id', {
        id,
      });
      await exec('DELETE FROM reward_config.rule_versions WHERE rule_id = :id', { id });
      await exec('DELETE FROM reward_config.rule_country_assignments WHERE rule_id = :id', { id });
      await exec('DELETE FROM reward_config.rule_master WHERE id = :id', { id });
    }
    await migration.query(
      `ALTER TABLE reward_config.rule_versions ENABLE TRIGGER trg_rule_versions_undeletable`,
      { type: QueryTypes.RAW },
    );
    await migration.close();
  }
  if (db !== undefined) {
    await removeEncryptionKeys(db, SUITE).catch(() => undefined);
  }
  if (app !== undefined) await app.close();
  if (db !== undefined) {
    await purgeSuiteResidue({ prefix: PREFIX, userDisplayNamePrefix: USER_DISPLAY_PREFIX });
    clearProvidedKeyMaterial(borrowedKeyVars);
  }
});

// --- T-146: the Value Sources screen's own two registries are live and non-empty --------------

describe('T-146 · Value Sources screen registries, over HTTP', () => {
  it('GET /field-context-providers returns the seeded SIBLING_COMPONENTS provider', async () => {
    const response = await get('maker', '/field-context-providers').expect(200);
    const codes = (response.body.data as { providerCode: string }[]).map((row) => row.providerCode);
    expect(codes).toContain('SIBLING_COMPONENTS');
  });

  it('GET /field-api-lookup-providers returns at least one seeded provider, with no auth secret on the wire', async () => {
    const response = await get('maker', '/field-api-lookup-providers').expect(200);
    const providers = response.body.data as Record<string, unknown>[];
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(provider).not.toHaveProperty('authConfigEnc');
      expect(provider).not.toHaveProperty('authConfig');
    }
  });
});

// --- the cross-task flow --------------------------------------------------------------------

/** Authors a fresh rule with `defaultOperators` set on its published version, confirms those
 * operator codes are real rows in the same registry `GET /rule-operators` (T-108) serves — the
 * registry this wave's "Value Sources" grouping and the Maker's operator dropdown both draw
 * from — then blasts it to this suite's country so a maker can actually bind it. */
async function authorOperatorRule(): Promise<{ ruleId: number; operatorCodes: string[] }> {
  const operatorCodes = ['at_least', 'equals'];

  const registry = await get('super', '/rule-operators').expect(200);
  const knownCodes = new Set(
    (registry.body.data as { operatorCode: string }[]).map((row) => row.operatorCode),
  );
  for (const code of operatorCodes) {
    expect(knownCodes.has(code)).toBe(true);
  }

  const ruleCode = `${PREFIX}_RULE_${String(Date.now())}_${String(Math.random()).slice(2, 8)}`;
  const created = await post('super', '/rules', {
    ruleCode,
    name: 'T-149 e2e operator rule',
    subCategoryId: transactionGeneralSubCategoryId,
    parameters: {
      fields: [
        {
          key: 'minSpend',
          label: 'Minimum spend',
          type: 'number',
          required: true,
          min: 1,
          max: 5000,
        },
      ],
    },
  });
  expect(created.status).toBe(201);
  const ruleId = created.body.data.id as number;
  createdRuleIds.push(ruleId);

  const version = await post('super', `/rules/${String(ruleId)}/versions`, {});
  expect(version.status).toBe(201);
  const versionId = version.body.data.id as number;

  const wired = await patch('super', `/rules/${String(ruleId)}/versions/${String(versionId)}`, {
    defaultOperators: operatorCodes,
  });
  expect(wired.status).toBe(200);

  const published = await post(
    'super',
    `/rules/${String(ruleId)}/versions/${String(versionId)}/publish`,
  );
  expect(published.status).toBe(201);

  const blasted = await post('super', '/blasts', {
    entityType: 'rule',
    entityId: ruleId,
    versionId,
    scope: 'selected',
    countryIds: [countryId],
  });
  expect(blasted.status).toBe(201);

  return { ruleId, operatorCodes };
}

/**
 * The full flow T-149's own task file specifies: author → registry cross-check → two-component
 * journey → bind + operator + "N of 2" combination logic → submit → reload → round-trip.
 * Called twice (see the two `it`s below), each against its own fresh campaign, to prove nothing
 * about the flow depends on state a first run happened to leave behind.
 */
async function runCrossTaskFlow(): Promise<void> {
  const { ruleId, operatorCodes } = await authorOperatorRule();

  const { id: campaignId, trackerId } = await createDraftWithTracker();
  const componentAId = await addComponent(campaignId, trackerId, 'Step A');
  const componentBId = await addComponent(campaignId, trackerId, 'Step B');
  expect(componentAId).not.toBe(componentBId);

  // The rule-picker (T-148's dropdown data source) carries the operators this rule's pinned
  // version was wired with, before anything is bound — exactly what the Maker UI reads to build
  // the operator `<Select>`'s option list.
  const options = await get('maker', `/campaigns/${String(campaignId)}/rule-options`).expect(200);
  const option = (options.body.data as { ruleId: number; defaultOperators: string[] }[]).find(
    (entry) => entry.ruleId === ruleId,
  );
  expect(option?.defaultOperators).toEqual(operatorCodes);

  // Bind the rule to both components — every component needs at least one rule for the campaign
  // to be submittable at all (T-037's structural validation, `COMPONENT_HAS_NO_RULE`).
  const boundA = await post('maker', `/campaigns/${String(campaignId)}/rules`, {
    componentId: componentAId,
    ruleId,
    values: { minSpend: 25 },
  }).expect(201);
  const trackerA = (
    boundA.body.data.trackers as {
      id: number;
      components: { id: number; rules: { id: number }[] }[];
    }[]
  ).find((row) => row.id === trackerId);
  const bindingId = trackerA?.components.find((row) => row.id === componentAId)?.rules[0]?.id;
  if (bindingId === undefined) throw new Error('rule binding on component A not found in journey');

  await post('maker', `/campaigns/${String(campaignId)}/rules`, {
    componentId: componentBId,
    ruleId,
    values: { minSpend: 25 },
  }).expect(201);

  // The Maker picks an operator from exactly the set the picker offered (T-148's control).
  const chosenOperator = operatorCodes[0];
  await patch('maker', `/campaigns/${String(campaignId)}/rules/${String(bindingId)}`, {
    values: { minSpend: 25 },
    operator: chosenOperator,
  }).expect(200);

  // The Maker sets component A's "Rules combine" to N of 2 (T-148's other control).
  await patch('maker', `/campaigns/${String(campaignId)}/components/${String(componentAId)}`, {
    ruleLogic: 'n_of',
    ruleThreshold: 2,
  }).expect(200);

  await post('maker', `/campaigns/${String(campaignId)}/rewards`, {
    level: 'campaign',
    rewardPolicyId,
  }).expect(201);

  const review = await get('maker', `/campaigns/${String(campaignId)}/review`).expect(200);
  expect(review.body.data.submittable).toBe(true);

  const submitted = await post('maker', `/campaigns/${String(campaignId)}/submit`).expect(200);
  expect(submitted.body.data.campaign.status).toBe('pending_approval');

  // Reload — a fresh `GET`, not the submit response — and confirm every one of the four values
  // survived the status transition unchanged.
  const reloaded = await get('maker', `/campaigns/${String(campaignId)}/journey`).expect(200);
  const trackerAfter = (
    reloaded.body.data.trackers as {
      id: number;
      components: {
        id: number;
        ruleLogic: string | null;
        ruleThreshold: number | null;
        rules: { id: number; operator: string | null; values: unknown }[];
      }[];
    }[]
  ).find((row) => row.id === trackerId);
  const componentAfter = trackerAfter?.components.find((row) => row.id === componentAId);
  expect(componentAfter?.ruleLogic).toBe('n_of');
  expect(componentAfter?.ruleThreshold).toBe(2);
  const ruleAfter = componentAfter?.rules.find((row) => row.id === bindingId);
  expect(ruleAfter?.operator).toBe(chosenOperator);
  expect(ruleAfter?.values).toEqual({ minSpend: 25 });
}

describe('T-149 · cross-task flow — Value Sources registries + Maker operator/rule-logic, submitted and reloaded', () => {
  it('run 1: authors, binds, sets operator + N-of-2, submits, and round-trips', async () => {
    await runCrossTaskFlow();
  });

  it('run 2 (idempotency, no residue): the same flow again against its own fresh campaign', async () => {
    await runCrossTaskFlow();
  });
});
