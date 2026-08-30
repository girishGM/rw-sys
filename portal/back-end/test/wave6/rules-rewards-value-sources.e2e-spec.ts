/**
 * T-130 — Wave 6 verification, cross-task flow 1: a rule authored with a resolver-inferred role
 * (T-114) and a `SIBLING_COMPONENTS`-sourced field (T-121/T-122), applied to a component
 * mid-journey in a real campaign (T-037), where the dropdown-filtering endpoint (T-123) and the
 * independent save-time circular-dependency guard (T-124) both hold — against the **real**
 * Postgres instance, through the real `AppModule`, over real HTTP, as real actors.
 *
 * ### Why this file exists
 *
 * `13-REWARD-MASTER-VALUE-SOURCES.md` §3's whole feature is a chain: a Super Admin authors a
 * field that says "pick an earlier sibling component"; a Maker sees only legal choices in the
 * dropdown; the server refuses an illegal choice even if the dropdown is bypassed. Every link in
 * that chain already has its own real-HTTP e2e coverage in isolation —
 * `rule-parameter-roles.e2e-spec.ts` (T-114's role annotation), `rule-value-source.e2e-spec.ts`
 * (T-122's schema/validation), `field-value-source-lookup.e2e-spec.ts` (T-123's filtering, against
 * hand-inserted tracker/component rows) — but none of them drives the actual
 * `POST /campaigns/:id/rules` binding path a Maker's browser calls, so none of them can catch a
 * defect in how the pieces are wired *together* (e.g. the field's `role`/`valueSource` failing to
 * survive the round trip from rule authoring into the binding save path, or the dropdown filter
 * and the save-time guard silently disagreeing about what "earlier" means). T-124's own guard is
 * proven today only against a faked repository (`t141-sibling-circular-dependency.spec.ts`) for
 * good reason (its own header explains exactly why), which makes this file the one place the
 * guard is exercised against real `tracker_tracker_components` rows written by a real journey.
 *
 * ### Isolation
 *
 * Every fixture is prefixed `T130E2E` / `T-130 …`, cleaned up via the **shared, tenant-scoped**
 * `purgeSuiteResidue` (T-132) — not a local, unscoped copy (see T-144, filed by this same task,
 * for what happens when a suite keeps its own).
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

const SUITE = 't130';
const PASSWORD = 'correct horse battery staple 130!';
const PREFIX = 'T130E2E';
const COUNTRY_CODE = 'S9';
const USER_DISPLAY_PREFIX = 'T-130';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let borrowedKeyVars: string[] = [];

let adminUserId: number;
let countryId: number;
let tenantId: number;
let merchantId: number;
let activityId: number;
let siblingSubCategoryId: number;
let trackerStateLookupResolverId: number;

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
    // See `purge-suite-residue.ts` / `t127-promo-code-attach.e2e-spec.ts` for why this is worth
    // wrapping: a Sequelize error thrown inside `beforeAll` otherwise reaches Jest's reporter with
    // an empty `message` and no SQL attached.
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
  const email = `t130-e2e-${key}@example.invalid`;
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
     VALUES (:code, 'T-130 e2e country', 'Asia/Kuala_Lumpur', 'MYR', '+060', 'active') RETURNING id`,
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
  // created afterwards (as this fixture just did, the same way T-143's fix made `POST /tenants`
  // do) needs its own default row, or `tenant-currencies-schema.e2e-spec.ts`'s TC-1 ("every
  // existing, live tenant has exactly one is_default row") goes red for every suite that runs
  // after this one — not a defect in that test, a gap in this fixture skipping the real
  // tenant-creation path it asserts on.
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

/** `COMPONENT` / `COMP_STATUS_CHECK` — the same seeded (T-105) sub-category the real
 * `RULE_COMP_COMPLETED_001` sample rule uses. Read-only reference, never written to. */
async function ensureSiblingSubCategoryId(): Promise<number> {
  const [row] = await sql<{ id: number }>(
    `SELECT rsc.id FROM reward_config.rule_sub_categories rsc
       JOIN reward_config.rule_categories rc ON rc.id = rsc.category_id
      WHERE rc.category_code = 'COMPONENT' AND rsc.sub_category_code = 'COMP_STATUS_CHECK'
      LIMIT 1`,
  );
  if (row === undefined) {
    throw new Error(
      't130 e2e: seeded rule_sub_categories COMPONENT/COMP_STATUS_CHECK not found — did T105_001 run?',
    );
  }
  return row.id;
}

async function ensureTrackerStateLookupResolverId(): Promise<number> {
  const [row] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.rule_resolvers WHERE resolver_code = 'TRACKER_STATE_LOOKUP'`,
  );
  if (row === undefined) {
    throw new Error('t130 e2e: seeded TRACKER_STATE_LOOKUP resolver not found — did T102 run?');
  }
  return row.id;
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
    name: 'T-130 e2e campaign',
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
  siblingSubCategoryId = await ensureSiblingSubCategoryId();
  trackerStateLookupResolverId = await ensureTrackerStateLookupResolverId();
  void adminUserId; // read for completeness/consistency with the established fixture pattern

  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
  await makeActor('maker', 'maker', { countryId, tenantId, merchantId: null });
});

afterAll(async () => {
  // Everything that touches the app's own `db` (Sequelize) — including `removeEncryptionKeys`,
  // which also queries through it — must run **before** `app.close()` tears that connection
  // down; `db.query` throws ("ConnectionManager … was closed") once it has, and this suite's own
  // `encryption_keys` row (kid `t130_t056_fld`/`t130_t056_bidx`) would otherwise survive to break
  // the next suite that boots `KeyRegistryService` before its own sweep gets a chance to run —
  // observed directly while building this suite. `trg_rule_versions_undeletable` (T005_007)
  // refuses to delete a published version by design — the same superuser escape hatch
  // `reward-version-kind.e2e-spec.ts` documents in full is used here for teardown only, via the
  // migration role, never the application role.
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

// --- the flow ----------------------------------------------------------------------------------

describe('T-130 · cross-task flow 1 — SIBLING_COMPONENTS rule, authored, applied, and guarded live', () => {
  let ruleId: number;
  let versionId: number;
  let campaignId: number;
  let trackerId: number;
  let earlierComponentId: number;
  let laterComponentId: number;

  it('step 1 (T-121/T-122): super_admin authors a rule whose targetComponentCode field is sourced from SIBLING_COMPONENTS', async () => {
    const response = await post('super', '/rules', {
      ruleCode: `${PREFIX}_SIB_${String(Date.now())}`,
      name: 'T-130 e2e sibling completed',
      subCategoryId: siblingSubCategoryId,
      parameters: {
        fields: [
          {
            key: 'targetComponentCode',
            label: 'Sibling component',
            type: 'select',
            required: true,
            valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
          },
          {
            key: 'value',
            label: 'Expected status',
            type: 'select',
            required: true,
            options: ['COMPLETED', 'IN_PROGRESS', 'NOT_STARTED', 'FAILED'],
          },
        ],
      },
    });
    expect(response.status).toBe(201);
    ruleId = response.body.data.id as number;
    createdRuleIds.push(ruleId);

    const fields = response.body.data.parameters.fields as { key: string; valueSource?: unknown }[];
    expect(fields.find((f) => f.key === 'targetComponentCode')?.valueSource).toEqual({
      kind: 'CONTEXT_LOOKUP',
      contextProvider: 'SIBLING_COMPONENTS',
    });
  });

  it('step 2 (T-109/T-114): a draft version wired to TRACKER_STATE_LOOKUP makes targetComponentCode a resolver_input, not just a CONTEXT_LOOKUP field', async () => {
    const created = await post('super', `/rules/${String(ruleId)}/versions`, {});
    expect(created.status).toBe(201);
    versionId = created.body.data.id as number;

    const wired = await patch('super', `/rules/${String(ruleId)}/versions/${String(versionId)}`, {
      resolverId: trackerStateLookupResolverId,
      resolverConfig: { statusKey: 'status' },
      evaluationContext: 'tracker_state',
      defaultOperators: ['equals', 'not_equals'],
    });
    expect(wired.status).toBe(200);

    // T-114's role is computed off the rule's *latest version's* resolver — GET /rules/:id must
    // now show targetComponentCode as resolver_input and the plain select field as compare_value.
    const read = await get('super', `/rules/${String(ruleId)}`);
    expect(read.status).toBe(200);
    const fields = read.body.data.parameters.fields as { key: string; role: string }[];
    expect(fields.find((f) => f.key === 'targetComponentCode')?.role).toBe('resolver_input');
    expect(fields.find((f) => f.key === 'value')?.role).toBe('compare_value');
  });

  it('step 3 (T-041/T-041 blast): the version is published and blasted to this suite’s country, so the maker can see and bind it', async () => {
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
  });

  it('step 4 (T-037): a maker builds a two-component journey — component 1 (earlier), component 2 (later)', async () => {
    const draft = await createDraftWithTracker();
    campaignId = draft.id;
    trackerId = draft.trackerId;

    earlierComponentId = await addComponent(campaignId, trackerId, 'Step 1 — earlier');
    laterComponentId = await addComponent(campaignId, trackerId, 'Step 2 — later');
    expect(earlierComponentId).not.toBe(laterComponentId);
  });

  it('step 5 (T-123): the context-lookup dropdown for the later component offers only the earlier one', async () => {
    const response = await get(
      'maker',
      `/field-value-sources/context/SIBLING_COMPONENTS?trackerId=${String(trackerId)}&excludeComponentId=${String(laterComponentId)}`,
    );
    expect(response.status).toBe(200);
    const options = response.body.data as { value: number; label: string }[];
    expect(options.map((o) => o.value)).toEqual([earlierComponentId]);
  });

  it('step 5b (T-123): the same dropdown for the earlier component (nothing precedes it) is empty', async () => {
    const response = await get(
      'maker',
      `/field-value-sources/context/SIBLING_COMPONENTS?trackerId=${String(trackerId)}&excludeComponentId=${String(earlierComponentId)}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  it('step 6 (T-124, legal): binding the later component to the earlier one is accepted', async () => {
    const response = await post('maker', `/campaigns/${String(campaignId)}/rules`, {
      componentId: laterComponentId,
      ruleId,
      values: { targetComponentCode: String(earlierComponentId), value: 'COMPLETED' },
    });
    expect(response.status).toBe(201);
  });

  it('step 7 (T-124, forward reference): binding the earlier component to the later one is refused — a stale UI or a curl gets the same answer', async () => {
    const response = await post('maker', `/campaigns/${String(campaignId)}/rules`, {
      componentId: earlierComponentId,
      ruleId,
      values: { targetComponentCode: String(laterComponentId), value: 'COMPLETED' },
    });
    expect(response.status).toBe(400);
  });

  it('step 8 (T-124, self-reference): binding a component to itself is refused', async () => {
    const response = await post('maker', `/campaigns/${String(campaignId)}/rules`, {
      componentId: earlierComponentId,
      ruleId,
      values: { targetComponentCode: String(earlierComponentId), value: 'COMPLETED' },
    });
    expect(response.status).toBe(400);
  });
});
