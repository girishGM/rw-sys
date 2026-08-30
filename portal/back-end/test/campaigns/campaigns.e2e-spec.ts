/**
 * T-037 — `/campaigns` against the **real** Postgres instance, through the real `AppModule`, over
 * real HTTP, as every role.
 *
 * Follows the harness `test/rules/rules.e2e-spec.ts` (T-031) and `test/rbac/rbac.e2e-spec.ts`
 * (T-013) establish: real login (through MFA for `super_admin`, T-055), real cookies, real
 * guards, real `ScopedRepository` scoping, real transactions. Nothing is stubbed.
 *
 * ### Why so much of this task is proved here rather than in unit tests
 *
 * Because most of what T-037 promises is *"the database really refused that"* rather than *"the
 * function returned false"*. TC-4/TC-5 (cross-tenant 404), TC-6/TC-7 (a per-tenant unique
 * constraint), TC-13 (no row written), TC-21a…TC-21m (rows in six different tables) and above all
 * **TC-21kk** (*"submit-time ceiling check bypassed by direct `curl` → still 422"*) are claims
 * about the running system. A unit test with a fake repository would pass whether or not the
 * scope clause reached the SQL.
 *
 * ### Isolation from the live data
 *
 * The database already holds 192 pre-existing `tenant_campaigns` rows written by the
 * `create-campaign` agents, which predate this portal. Every fixture here is prefixed `T037E2E`,
 * every campaign this suite creates is recorded and torn down in `afterAll`, and no assertion
 * counts rows globally — they are all scoped to this suite's own tenants. A failed run leaves
 * rows behind but cannot corrupt anything.
 *
 * That claim was false for the residue purge for a long time, and silently — see
 * `purgeOwnResidue` below and the `T-144` describe that now holds it to it.
 *
 * ### Teardown needs the migration connection, and that is the design working
 *
 * `reward_app` holds `SELECT, INSERT` and **nothing else** on
 * `reward_portal.portal_campaign_audit_trail` (T037_002 revokes the rest), exactly as
 * 01-DATABASE.md §3 does for the table it replaces: *"Audit is append-only. No UPDATE, no DELETE,
 * by anyone, ever."* So the suite's own cleanup cannot delete its audit rows as the application
 * role — and because `fk_pcat_campaign` and `fk_pcat_performed_by` are `ON DELETE RESTRICT`, it
 * cannot delete the campaigns or the users either while those rows exist.
 *
 * That is the control behaving correctly rather than an obstacle to route around: in production
 * nothing ever hard-deletes a campaign or a portal user (both are soft-deleted), and audit rows
 * are retained seven years and are deliberately undeletable (BACKLOG.md). Teardown therefore
 * uses `createMigrationConnection()` — the privileged role the migration CLI runs as — which is
 * the same pattern `test/database/schema-drift.e2e-spec.ts` already established for privileged
 * test operations. The application role's own privileges are never widened to make a test pass.
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
} from './support/foreign-key-material';
import { purgeSuiteResidue } from './support/purge-suite-residue';

jest.setTimeout(600_000);

const SUITE = 't037';
const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_A_CODE = 'S1';
const COUNTRY_B_CODE = 'S2';
const PREFIX = 'T037E2E';
/** The `portal_users.display_name` prefix every actor this suite creates carries. */
const USER_DISPLAY_PREFIX = 'T-037';
/**
 * T-144's regression fixture: a campaign/tracker/component journey that is deliberately **not**
 * this suite's, planted to prove `purgeOwnResidue` leaves other people's rows alone.
 */
const FOREIGN_PREFIX = 'T144OTHER';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryA: number;
let countryB: number;
let tenantA: number;
let tenantB: number;
let merchantA: number;
let merchantA2: number;
let merchantB: number;
let activityA: number;
let activityA2: number;
let activityUnoffered: number;
let ruleAssignedToA: number;
let ruleUnassigned: number;
let ruleVersionA: number;
let rewardPolicyA: number;
let rewardPolicyA2: number;
let rewardPolicyPoints: number;

const createdCampaignIds = new Set<number>();
/** Env vars this run filled in on another suite's behalf — see `support/foreign-key-material.ts`. */
let borrowedKeyVars: string[] = [];

interface Actor {
  readonly email: string;
  readonly userId: number;
  readonly jar: string;
  readonly csrf: string;
}
const actors = new Map<string, Actor>();

// --- plumbing ------------------------------------------------------------------------------------

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
  const email = `t037-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-037 ${key}`,
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
function put(key: string, path: string, body: unknown) {
  return http()
    .put(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}
function del(key: string, path: string) {
  return http()
    .delete(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf);
}

// --- fixtures ------------------------------------------------------------------------------------

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
     VALUES (:code, :name, 'Asia/Kuala_Lumpur', 'MYR', '+060', 'active') RETURNING id`,
    { code, name },
  );
  return created.id;
}

async function ensureTenant(code: string, countryId: number): Promise<number> {
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
  return created.id;
}

async function ensureMerchant(
  code: string,
  tenantId: number,
  countryCode: string,
): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.merchants WHERE merchant_code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, :countryCode, 'active') RETURNING id`,
    { tenantId, code, countryCode },
  );
  return created.id;
}

async function ensureActivityType(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activity_types ORDER BY id LIMIT 1',
  );
  if (existing === undefined) throw new Error('no activity_types rows — is the schema seeded?');
  return existing.id;
}

async function ensureActivity(code: string, tenantId: number, typeId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activities WHERE tenant_id = :tenantId AND activity_code = :code',
    { tenantId, code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.activities (tenant_id, type_id, activity_code, name, status)
     VALUES (:tenantId, :typeId, :code, :code, 'active') RETURNING id`,
    { tenantId, typeId, code },
  );
  return created.id;
}

async function linkMerchantActivity(merchantId: number, activityId: number, tenantId: number) {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.merchant_activities
      WHERE merchant_id = :merchantId AND activity_id = :activityId AND store_id IS NULL`,
    { merchantId, activityId },
  );
  if (existing !== undefined) return;
  await exec(
    `INSERT INTO reward_config.merchant_activities (tenant_id, merchant_id, activity_id, status)
     VALUES (:tenantId, :merchantId, :activityId, 'active')`,
    { tenantId, merchantId, activityId },
  );
}

const RULE_PARAMETERS = JSON.stringify({
  fields: [
    { key: 'minSpend', label: 'Minimum spend', type: 'number', required: true, min: 10, max: 5000 },
    {
      key: 'period',
      label: 'Period',
      type: 'select',
      required: false,
      options: ['daily', 'weekly'],
    },
  ],
});

async function ensureRule(code: string): Promise<number> {
  const [subCategory] = await sql<{ id: number }>(
    `SELECT rsc.id FROM reward_config.rule_sub_categories rsc
       JOIN reward_config.rule_categories rc ON rc.id = rsc.category_id
      WHERE rc.category_code = 'TRANSACTION' AND rsc.sub_category_code = 'GENERAL' LIMIT 1`,
  );
  if (subCategory === undefined) throw new Error('seeded rule_sub_categories row not found');

  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.rule_master WHERE rule_code = :code',
    { code },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.rule_master SET parameters = :parameters, status = 'active' WHERE id = :id`,
      { id: existing.id, parameters: RULE_PARAMETERS },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.rule_master (tenant_id, sub_category_id, rule_code, name, parameters, status)
     VALUES (NULL, :subCategoryId, :code, :code, :parameters, 'active') RETURNING id`,
    { subCategoryId: subCategory.id, code, parameters: RULE_PARAMETERS },
  );
  return created.id;
}

/**
 * A `reward_config.admin_users` id, for the version/assignment tables whose `created_by` /
 * `assigned_by` columns reference it.
 *
 * Those columns are exactly gap G1 in miniature: they cannot hold a portal `maker`, which is why
 * T037_001/T037_002 exist for the two tables the portal itself writes. The **fixture** tables
 * here are Super-Admin-authored data (T-031/T-041's territory), so a real `admin_users` id is the
 * correct value and is read from the database rather than assumed to be `1`.
 */
let adminUserId: number;

async function ensureAdminUserId(): Promise<number> {
  const [row] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.admin_users ORDER BY id LIMIT 1',
  );
  if (row === undefined) throw new Error('no admin_users rows — cannot author fixture versions');
  return row.id;
}

/** `rule_country_assignments` carries **no `status` column** (confirmed against
 * `information_schema.columns`, not assumed from the extracted DDL) — only `assigned_at` and a
 * nullable `assigned_by`. */
async function assignRuleToCountry(ruleId: number, countryId: number): Promise<void> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.rule_country_assignments WHERE rule_id = :ruleId AND country_id = :countryId',
    { ruleId, countryId },
  );
  if (existing !== undefined) return;
  await exec(
    `INSERT INTO reward_config.rule_country_assignments (rule_id, country_id, assigned_by)
     VALUES (:ruleId, :countryId, :adminUserId)`,
    { ruleId, countryId, adminUserId },
  );
}

/** A published rule version assigned to `countryId` — the pin `tracker_component_rules`
 * .rule_version_id records (06-VERSIONING.md §7). */
async function ensureRuleVersion(ruleId: number, countryId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.rule_versions WHERE rule_id = :ruleId AND version_no = 1',
    { ruleId },
  );
  const versionId =
    existing?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.rule_versions
           (rule_id, version_no, parameters, status, created_by, published_by, published_at)
         VALUES (:ruleId, 1, :parameters, 'published', :adminUserId, :adminUserId, now())
         RETURNING id`,
        { ruleId, parameters: RULE_PARAMETERS, adminUserId },
      )
    )[0].id;

  const [assignment] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.rule_version_country_assignments
      WHERE rule_version_id = :versionId AND country_id = :countryId`,
    { versionId, countryId },
  );
  if (assignment === undefined) {
    await exec(
      `INSERT INTO reward_config.rule_version_country_assignments
         (rule_version_id, rule_id, country_id, status, assigned_by)
       VALUES (:versionId, :ruleId, :countryId, 'active', :adminUserId)`,
      { versionId, ruleId, countryId, adminUserId },
    );
  }
  return versionId;
}

/**
 * T-147 — the {@link ensureRuleVersion} mirror for a version that needs `default_operators` set.
 * `default_operators` is one of the columns `T103_002`'s immutability trigger freezes once a
 * version is `published` (same set as `expression`/`parameters`/`version_no`/`is_breaking`), so it
 * must be baked into the **same** `INSERT` that publishes the row — an `UPDATE` after the fact
 * (even idempotent, even from a fixture) is rejected by that trigger, reproduced directly while
 * building this fixture. Idempotent the same way `ensureRuleVersion` is: a second call against the
 * same `ruleId` reuses the version already created, trusting its `default_operators` from the
 * first call rather than re-writing it.
 */
async function ensureRuleVersionWithOperators(
  ruleId: number,
  countryId: number,
  operators: readonly string[],
): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.rule_versions WHERE rule_id = :ruleId AND version_no = 1',
    { ruleId },
  );
  const versionId =
    existing?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.rule_versions
           (rule_id, version_no, parameters, default_operators, status, created_by, published_by, published_at)
         VALUES (:ruleId, 1, :parameters, :defaultOperators, 'published', :adminUserId, :adminUserId, now())
         RETURNING id`,
        {
          ruleId,
          parameters: RULE_PARAMETERS,
          defaultOperators: JSON.stringify(operators),
          adminUserId,
        },
      )
    )[0].id;

  const [assignment] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.rule_version_country_assignments
      WHERE rule_version_id = :versionId AND country_id = :countryId`,
    { versionId, countryId },
  );
  if (assignment === undefined) {
    await exec(
      `INSERT INTO reward_config.rule_version_country_assignments
         (rule_version_id, rule_id, country_id, status, assigned_by)
       VALUES (:versionId, :ruleId, :countryId, 'active', :adminUserId)`,
      { versionId, ruleId, countryId, adminUserId },
    );
  }
  return versionId;
}

async function ensureRewardSystem(code: string, countryId: number, rewardType: string) {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_systems WHERE system_code = :code',
    { code },
  );
  const rewardId =
    existing?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.reward_systems
           (tenant_id, system_code, name, reward_type, connector_type, status)
         VALUES (NULL, :code, :code, :rewardType, 'internal', 'active') RETURNING id`,
        { code, rewardType },
      )
    )[0].id;

  const [assignment] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_country_assignments WHERE reward_id = :rewardId AND country_id = :countryId',
    { rewardId, countryId },
  );
  if (assignment === undefined) {
    // Mirrors `rule_country_assignments`: no `status` column, nullable `assigned_by`.
    await exec(
      `INSERT INTO reward_config.reward_country_assignments (reward_id, country_id, assigned_by)
       VALUES (:rewardId, :countryId, :adminUserId)`,
      { rewardId, countryId, adminUserId },
    );
  }
  return rewardId;
}

/** A reward version carrying `unit_type`/`unit_code` — 11-BUDGETS-AND-LIMITS.md §3.1's *"the unit
 * lives on the reward version"*, which is what step 6's unbudgeted-reward warning matches on. */
async function ensureRewardVersion(
  rewardId: number,
  countryId: number,
  unitType: string,
  unitCode: string,
): Promise<void> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_versions WHERE reward_id = :rewardId AND version_no = 1',
    { rewardId },
  );
  const versionId =
    existing?.id ??
    (
      await sql<{ id: number }>(
        `INSERT INTO reward_config.reward_versions
           (reward_id, version_no, unit_type, unit_code, status, created_by, published_by, published_at)
         VALUES (:rewardId, 1, :unitType, :unitCode, 'published', :adminUserId, :adminUserId, now())
         RETURNING id`,
        { rewardId, unitType, unitCode, adminUserId },
      )
    )[0].id;

  const [assignment] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_version_country_assignments
      WHERE reward_version_id = :versionId AND country_id = :countryId`,
    { versionId, countryId },
  );
  if (assignment === undefined) {
    await exec(
      `INSERT INTO reward_config.reward_version_country_assignments
         (reward_version_id, reward_id, country_id, status, assigned_by)
       VALUES (:versionId, :rewardId, :countryId, 'active', :adminUserId)`,
      { versionId, rewardId, countryId, adminUserId },
    );
  }
}

async function ensureRewardPolicy(rewardId: number, code: string, amount: string): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.reward_policies WHERE reward_system_id = :rewardId AND policy_code = :code',
    { rewardId, code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_policies (reward_system_id, policy_code, name, config, status)
     VALUES (:rewardId, :code, :code, :config, 'active') RETURNING id`,
    { rewardId, code, config: JSON.stringify({ amount }) },
  );
  return created.id;
}

async function setCeiling(
  tenantId: number,
  unitType: string,
  unitCode: string,
  max: string,
  warnAbove: string | null,
): Promise<void> {
  await exec(
    `INSERT INTO reward_config.tenant_budget_ceilings
       (tenant_id, unit_type, unit_code, max_campaign_budget, warn_above_amount, status, created_by)
     VALUES (:tenantId, :unitType, :unitCode, :max, :warnAbove, 'active', :adminUserId)
     ON CONFLICT (tenant_id, unit_type, unit_code) DO UPDATE
        SET max_campaign_budget = EXCLUDED.max_campaign_budget,
            warn_above_amount = EXCLUDED.warn_above_amount,
            status = 'active'`,
    { tenantId, unitType, unitCode, max, warnAbove, adminUserId },
  );
}

/**
 * Removes anything a previous, failed run of **this** suite left behind. Without it a single
 * crashed run makes every later run fail on `uq_portal_users_email_live`.
 *
 * T-144: this used to be a local copy of the purge, and its last six statements were keyed on
 * `tracker_code LIKE 'TRK-%'` / `component_code LIKE 'CMP-%'` — which is not a marker of this
 * suite at all but the prefix `code-generator.ts` puts on **every** tracker and component the
 * portal generates, for every tenant. So the copy tried to delete rows belonging to other
 * people's campaigns, and the moment one of them was still linked (tenant `DEMO`'s campaign
 * `C001` → tracker `TRK-363411-C736NH`, in the shared dev database) the delete hit
 * `fk_tct_tracker`, threw inside `beforeAll` with an empty `.message`, and failed all 75 tests
 * in this file.
 *
 * T-132 had already extracted and fixed exactly that in `support/purge-suite-residue.ts` — every
 * statement there is scoped by this suite's own tenants, campaign codes or display names — but
 * this file was never migrated onto it. It is now. Keep the delegation: do not re-inline a purge
 * here, and if a new table needs clearing, add it to the shared helper where the scoping rule is
 * documented and tested (`t132-purge-suite-residue.e2e-spec.ts`).
 *
 * The shared helper runs as the migration role, for the reason this file's header gives.
 */
async function purgeOwnResidue(): Promise<void> {
  await purgeSuiteResidue({ prefix: PREFIX, userDisplayNamePrefix: USER_DISPLAY_PREFIX });
}

// --- T-144: evidence that the purge above is scoped to this suite --------------------------------

/**
 * A campaign with a tracker and a component linked to it, carrying the generated codes
 * `code-generator.ts` produces — which is what made a foreign journey indistinguishable from this
 * suite's own by code alone, and what the defect turned on.
 */
interface PlantedJourney {
  readonly tenantId: number;
  readonly campaignId: number;
  readonly trackerId: number;
  readonly componentId: number;
}

interface JourneyState {
  readonly campaign: boolean;
  readonly tracker: boolean;
  readonly component: boolean;
  readonly campaignTrackerLink: boolean;
  readonly trackerComponentLink: boolean;
}

const JOURNEY_INTACT: JourneyState = {
  campaign: true,
  tracker: true,
  component: true,
  campaignTrackerLink: true,
  trackerComponentLink: true,
};
const JOURNEY_REMOVED: JourneyState = {
  campaign: false,
  tracker: false,
  component: false,
  campaignTrackerLink: false,
  trackerComponentLink: false,
};

/** This suite's own residue, planted before the purge — must be gone afterwards. */
let plantedOwn: PlantedJourney | undefined;
/** Another suite's rows, planted before the purge — must survive it untouched. */
let plantedForeign: PlantedJourney | undefined;
let ownAfterPurge: JourneyState | undefined;
let foreignAfterPurge: JourneyState | undefined;

/**
 * Fixture work for the check above runs as the migration role, like the purge it observes: there
 * is no application role permitted to write and delete across every table involved (see this
 * file's header).
 */
async function withAdmin<T>(fn: (admin: Sequelize) => Promise<T>): Promise<T> {
  const admin = createMigrationConnection();
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
}

async function adminSql<T extends object>(
  admin: Sequelize,
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return admin.query<T>(statement, { type: QueryTypes.SELECT, replacements });
}

async function adminExec(
  admin: Sequelize,
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<void> {
  await admin.query(statement, { type: QueryTypes.RAW, replacements });
}

async function adminInsertId(
  admin: Sequelize,
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<number> {
  const [row] = await adminSql<{ id: number }>(admin, statement, replacements);
  if (row === undefined) throw new Error(`no id returned from: ${statement}`);
  return row.id;
}

async function ensureTenantByCode(admin: Sequelize, code: string): Promise<number> {
  const [existing] = await adminSql<{ id: number }>(
    admin,
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
  const [country] = await adminSql<{ id: number }>(
    admin,
    'SELECT id FROM reward_config.countries ORDER BY id LIMIT 1',
  );
  if (country === undefined) throw new Error('no countries rows — is the schema seeded?');
  return adminInsertId(
    admin,
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code, countryId: country.id },
  );
}

let plantedSequence = 0;

async function plantJourney(
  admin: Sequelize,
  tenantCode: string,
  campaignCodePrefix: string,
): Promise<PlantedJourney> {
  plantedSequence += 1;
  const suffix = `${String(Date.now())}${String(plantedSequence)}`.slice(-8);
  const tenantId = await ensureTenantByCode(admin, tenantCode);
  const campaignId = await adminInsertId(
    admin,
    `INSERT INTO reward_config.tenant_campaigns
       (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
     VALUES (:tenantId, :code, :code, now(), now() + interval '30 days', 'draft', 'T-144 fixture')
     RETURNING id`,
    { tenantId, code: `${campaignCodePrefix}_PLANTED_${suffix}` },
  );
  const trackerId = await adminInsertId(
    admin,
    `INSERT INTO reward_config.trackers (tenant_id, tracker_code, name, completion_logic, status)
     VALUES (:tenantId, :code, 'T-144 tracker', 'all', 'active') RETURNING id`,
    { tenantId, code: `TRK-${String(campaignId)}-${suffix}` },
  );
  const componentId = await adminInsertId(
    admin,
    `INSERT INTO reward_config.tracker_components (tenant_id, component_code, name, status)
     VALUES (:tenantId, :code, 'T-144 component', 'active') RETURNING id`,
    { tenantId, code: `CMP-${String(campaignId)}-${suffix}` },
  );
  await adminExec(
    admin,
    `INSERT INTO reward_config.tenant_campaign_trackers (tenant_id, campaign_id, tracker_id, status)
     VALUES (:tenantId, :campaignId, :trackerId, 'active')`,
    { tenantId, campaignId, trackerId },
  );
  await adminExec(
    admin,
    `INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id, sequence_order)
     VALUES (:trackerId, :componentId, 1)`,
    { trackerId, componentId },
  );
  return { tenantId, campaignId, trackerId, componentId };
}

async function journeyState(admin: Sequelize, journey: PlantedJourney): Promise<JourneyState> {
  const [row] = await adminSql<{
    campaign: string;
    tracker: string;
    component: string;
    tct: string;
    ttc: string;
  }>(
    admin,
    `SELECT
       (SELECT count(*) FROM reward_config.tenant_campaigns WHERE id = :campaignId) AS campaign,
       (SELECT count(*) FROM reward_config.trackers WHERE id = :trackerId) AS tracker,
       (SELECT count(*) FROM reward_config.tracker_components WHERE id = :componentId) AS component,
       (SELECT count(*) FROM reward_config.tenant_campaign_trackers
         WHERE campaign_id = :campaignId AND tracker_id = :trackerId) AS tct,
       (SELECT count(*) FROM reward_config.tracker_tracker_components
         WHERE tracker_id = :trackerId AND component_id = :componentId) AS ttc`,
    { ...journey },
  );
  if (row === undefined) throw new Error('journeyState returned no row');
  return {
    campaign: Number(row.campaign) === 1,
    tracker: Number(row.tracker) === 1,
    component: Number(row.component) === 1,
    campaignTrackerLink: Number(row.tct) === 1,
    trackerComponentLink: Number(row.ttc) === 1,
  };
}

/**
 * Removes the foreign-tenant fixture, including anything a crashed earlier run left in it. Scoped
 * to a tenant code no other suite uses, so it obeys the same rule as the purge it exists to test:
 * nothing here matches globally.
 */
async function dropForeignFixture(admin: Sequelize): Promise<void> {
  const tenantCode = `${FOREIGN_PREFIX}_TENANT`;
  const [tenant] = await adminSql<{ id: number }>(
    admin,
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code: tenantCode },
  );
  if (tenant === undefined) return;
  const scope = { tenantId: tenant.id };
  const trackersInTenant = 'SELECT id FROM reward_config.trackers WHERE tenant_id = :tenantId';
  const componentsInTenant =
    'SELECT id FROM reward_config.tracker_components WHERE tenant_id = :tenantId';
  await adminExec(
    admin,
    `DELETE FROM reward_config.tracker_tracker_components
      WHERE tracker_id IN (${trackersInTenant}) OR component_id IN (${componentsInTenant})`,
    scope,
  );
  await adminExec(
    admin,
    'DELETE FROM reward_config.tenant_campaign_trackers WHERE tenant_id = :tenantId',
    scope,
  );
  await adminExec(
    admin,
    'DELETE FROM reward_config.tenant_campaigns WHERE tenant_id = :tenantId',
    scope,
  );
  await adminExec(
    admin,
    'DELETE FROM reward_config.tracker_components WHERE tenant_id = :tenantId',
    scope,
  );
  await adminExec(admin, 'DELETE FROM reward_config.trackers WHERE tenant_id = :tenantId', scope);
  await adminExec(admin, 'DELETE FROM reward_config.tenants WHERE id = :tenantId', scope);
}

function recorded(state: JourneyState | undefined): JourneyState {
  if (state === undefined) throw new Error('beforeAll did not record the purge outcome');
  return state;
}

async function clearCeilings(tenantId: number): Promise<void> {
  await exec('DELETE FROM reward_config.tenant_budget_ceilings WHERE tenant_id = :tenantId', {
    tenantId,
  });
}

// --- campaign-building helpers ------------------------------------------------------------------

let codeCounter = 0;
function campaignCode(suffix = ''): string {
  codeCounter += 1;
  return `${PREFIX}_${String(Date.now())}_${String(codeCounter)}${suffix}`.slice(0, 50);
}

function inDays(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Several maker accounts in tenant A, rotated by {@link nextMaker}.
 *
 * T-012's general throttle is **300 authenticated requests per user per minute**, keyed by user
 * id (`throttler.config.ts#generalRule`). This suite issues well over that in the ~15 seconds it
 * takes to run, and a single `makerA` therefore starts collecting 429s partway through — which
 * is the rate limiter working exactly as designed, not a bug to route around.
 *
 * Spreading the load across accounts is the honest fix: it changes nothing about the control (no
 * limit is raised, no route exempted) and it matches what the limit is *for* — one user cannot
 * monopolise the API. Campaign scope is the **tenant**, not the author, so any of these makers
 * can read and edit what another built, which is what makes the rotation transparent to the
 * assertions. Tests that assert on a specific actor's identity (`created_by`, `requested_by`)
 * pass `'makerA'` explicitly instead of rotating.
 */
const MAKER_POOL = ['makerA', 'makerA2', 'makerA3', 'makerA4', 'makerA5', 'makerA6'] as const;
let makerCursor = 0;

function nextMaker(): string {
  makerCursor += 1;
  return MAKER_POOL[makerCursor % MAKER_POOL.length];
}

interface CreatedCampaign {
  id: number;
  code: string;
}

async function createDraft(
  key: string = nextMaker(),
  overrides: Record<string, unknown> = {},
): Promise<CreatedCampaign> {
  const code = (overrides['campaignCode'] as string | undefined) ?? campaignCode();
  const response = await post(key, '/campaigns', {
    campaignCode: code,
    name: 'T-037 e2e campaign',
    startDate: inDays(1),
    endDate: inDays(30),
    budgetAmount: '100000.00',
    budgetCurrency: 'MYR',
    ...overrides,
  });
  if (response.status !== 201) {
    throw new Error(`createDraft failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const id = response.body.data.id as number;
  createdCampaignIds.add(id);
  return { id, code };
}

/** A complete, submittable campaign: merchants, a tracker, a component with an activity and a
 * rule, and a campaign-level reward. Returns the ids every structural test needs. */
async function buildSubmittableCampaign(
  overrides: Record<string, unknown> = {},
  actorKey: string = nextMaker(),
): Promise<{
  id: number;
  actorKey: string;
  trackerId: number;
  componentId: number;
  bindingId: number;
}> {
  const { id } = await createDraft(actorKey, overrides);
  await post(actorKey, `/campaigns/${String(id)}/merchants`, {
    merchantIds: [merchantA],
  }).expect(201);
  const tracker = await post(actorKey, `/campaigns/${String(id)}/trackers`, {
    name: 'Onboarding',
    completionLogic: 'all',
  }).expect(201);
  const trackerId = tracker.body.data.trackers[0].id as number;

  const withComponent = await post(
    actorKey,
    `/campaigns/${String(id)}/trackers/${String(trackerId)}/components`,
    { name: 'First purchase', activityId: activityA },
  ).expect(201);
  const componentId = withComponent.body.data.trackers[0].components[0].id as number;

  const bound = await post(actorKey, `/campaigns/${String(id)}/rules`, {
    componentId,
    ruleId: ruleAssignedToA,
    values: { minSpend: 50 },
  }).expect(201);
  const bindingId = bound.body.data.trackers[0].components[0].rules[0].id as number;

  await post(actorKey, `/campaigns/${String(id)}/rewards`, {
    level: 'campaign',
    rewardPolicyId: rewardPolicyA,
  }).expect(201);

  return { id, actorKey, trackerId, componentId, bindingId };
}

// --- lifecycle -----------------------------------------------------------------------------------

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);
  // Another suite's leftover key rows would otherwise stop `KeyRegistryService` booting at all —
  // see `support/foreign-key-material.ts` for why this supplies material rather than deleting
  // rows another agent's in-flight task owns.
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

  // T-144. Plant the exact shape of row the purge used to destroy itself on — a campaign that is
  // *not* this suite's, still referencing a `TRK-`/`CMP-` coded journey — alongside a piece of
  // residue that genuinely is this suite's, and record what the purge did to each. The assertions
  // are in the `T-144` describe below.
  //
  // This is set up here, in `beforeAll`, rather than inside that test, and the reason is not
  // convenience: `purgeOwnResidue` deletes every `T037E2E` campaign and every `T-037 ` actor, so
  // the only honest moment to call it is the one it is already called in — before any of them
  // exist. Calling it from a test would delete the suite out from under itself.
  await withAdmin(async (admin) => {
    await dropForeignFixture(admin);
    plantedOwn = await plantJourney(admin, `${PREFIX}_TENANT_A`, PREFIX);
    plantedForeign = await plantJourney(admin, `${FOREIGN_PREFIX}_TENANT`, FOREIGN_PREFIX);
  });

  await purgeOwnResidue();

  await withAdmin(async (admin) => {
    if (plantedOwn === undefined || plantedForeign === undefined) {
      throw new Error('T-144 fixture was not planted');
    }
    ownAfterPurge = await journeyState(admin, plantedOwn);
    foreignAfterPurge = await journeyState(admin, plantedForeign);
  });

  adminUserId = await ensureAdminUserId();
  countryA = await ensureCountry(COUNTRY_A_CODE, 'T-037 e2e country A');
  countryB = await ensureCountry(COUNTRY_B_CODE, 'T-037 e2e country B');
  tenantA = await ensureTenant(`${PREFIX}_TENANT_A`, countryA);
  tenantB = await ensureTenant(`${PREFIX}_TENANT_B`, countryB);
  merchantA = await ensureMerchant(`${PREFIX}_M_A1`, tenantA, COUNTRY_A_CODE);
  merchantA2 = await ensureMerchant(`${PREFIX}_M_A2`, tenantA, COUNTRY_A_CODE);
  merchantB = await ensureMerchant(`${PREFIX}_M_B1`, tenantB, COUNTRY_B_CODE);

  const typeId = await ensureActivityType();
  activityA = await ensureActivity(`${PREFIX}_ACT_1`, tenantA, typeId);
  activityA2 = await ensureActivity(`${PREFIX}_ACT_2`, tenantA, typeId);
  activityUnoffered = await ensureActivity(`${PREFIX}_ACT_X`, tenantA, typeId);
  await linkMerchantActivity(merchantA, activityA, tenantA);
  await linkMerchantActivity(merchantA2, activityA2, tenantA);

  ruleAssignedToA = await ensureRule(`${PREFIX}_RULE_A`);
  ruleUnassigned = await ensureRule(`${PREFIX}_RULE_UNASSIGNED`);
  await assignRuleToCountry(ruleAssignedToA, countryA);
  ruleVersionA = await ensureRuleVersion(ruleAssignedToA, countryA);
  // Deliberately assigned to country B only, so a maker in A cannot see it (TC-15).
  await assignRuleToCountry(ruleUnassigned, countryB);

  const cashReward = await ensureRewardSystem(`${PREFIX}_RWD_CASH`, countryA, 'cashback');
  await ensureRewardVersion(cashReward, countryA, 'currency', 'MYR');
  rewardPolicyA = await ensureRewardPolicy(cashReward, `${PREFIX}_POL_1`, '10.00');
  rewardPolicyA2 = await ensureRewardPolicy(cashReward, `${PREFIX}_POL_2`, '5.00');

  const pointsReward = await ensureRewardSystem(`${PREFIX}_RWD_PTS`, countryA, 'points');
  await ensureRewardVersion(pointsReward, countryA, 'points', 'PTS');
  rewardPolicyPoints = await ensureRewardPolicy(pointsReward, `${PREFIX}_POL_PTS`, '100');

  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
  await makeActor('countryA', 'country_admin', {
    countryId: countryA,
    tenantId: null,
    merchantId: null,
  });
  await makeActor('tenantAdminA', 'tenant_admin', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: null,
  });
  for (const key of MAKER_POOL) {
    await makeActor(key, 'maker', { countryId: countryA, tenantId: tenantA, merchantId: null });
  }
  await makeActor('checkerA', 'checker', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: null,
  });
  await makeActor('merchantA', 'merchant', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: merchantA,
  });
  await makeActor('makerB', 'maker', { countryId: countryB, tenantId: tenantB, merchantId: null });
});

afterAll(async () => {
  if (db !== undefined) {
    // Privileged, because the audit table is append-only to `reward_app` by design — see this
    // file's header.
    const admin = createMigrationConnection();
    const purge = async (statement: string, replacements: Record<string, unknown> = {}) => {
      await admin.query(statement, { type: QueryTypes.RAW, replacements });
    };

    try {
      // T-144's foreign-tenant fixture. Removed first so it goes even if a test failed partway
      // through, and scoped to a tenant code no other suite uses.
      await dropForeignFixture(admin);

      const ids = [...createdCampaignIds];
      if (ids.length > 0) {
        // Children first, then the campaigns. Ordered by foreign key so nothing is left dangling
        // even if a test failed partway through building a journey.
        await purge(
          'DELETE FROM reward_portal.portal_campaign_audit_trail WHERE campaign_id IN (:ids)',
          { ids },
        );
        await purge(
          `DELETE FROM reward_portal.portal_approval_requests
            WHERE entity_type = 'campaign' AND entity_id IN (:ids)`,
          { ids },
        );
        await purge('DELETE FROM reward_config.campaign_caps WHERE campaign_id IN (:ids)', { ids });
        await purge(
          'DELETE FROM reward_config.reward_campaign_assignments WHERE campaign_id IN (:ids)',
          { ids },
        );
        await purge(
          `DELETE FROM reward_config.reward_component_assignments
            WHERE component_id IN (
              SELECT ttc.component_id FROM reward_config.tracker_tracker_components ttc
               WHERE ttc.tracker_id IN (
                 SELECT tracker_id FROM reward_config.tenant_campaign_trackers
                  WHERE campaign_id IN (:ids)))`,
          { ids },
        );
        await purge(
          `DELETE FROM reward_config.reward_tracker_assignments
            WHERE tracker_id IN (
              SELECT tracker_id FROM reward_config.tenant_campaign_trackers
               WHERE campaign_id IN (:ids))`,
          { ids },
        );
        await purge(
          `DELETE FROM reward_config.tracker_component_rules
            WHERE tracker_component_id IN (
              SELECT ttc.component_id FROM reward_config.tracker_tracker_components ttc
               WHERE ttc.tracker_id IN (
                 SELECT tracker_id FROM reward_config.tenant_campaign_trackers
                  WHERE campaign_id IN (:ids)))`,
          { ids },
        );
        await purge(
          `DELETE FROM reward_config.tracker_tracker_components
            WHERE tracker_id IN (
              SELECT tracker_id FROM reward_config.tenant_campaign_trackers
               WHERE campaign_id IN (:ids))`,
          { ids },
        );
        await purge(
          `DELETE FROM reward_config.tenant_campaign_trackers WHERE campaign_id IN (:ids)`,
          { ids },
        );
        await purge('DELETE FROM reward_config.campaign_merchants WHERE campaign_id IN (:ids)', {
          ids,
        });
        await purge('DELETE FROM reward_config.tenant_campaigns WHERE id IN (:ids)', { ids });
        // Generated codes only, so nothing authored outside this suite is touched.
        await purge(
          `DELETE FROM reward_config.tracker_components
            WHERE tenant_id IN (:tenantIds) AND component_code LIKE 'CMP-%'`,
          { tenantIds: [tenantA, tenantB] },
        );
        await purge(
          `DELETE FROM reward_config.trackers
            WHERE tenant_id IN (:tenantIds) AND tracker_code LIKE 'TRK-%'`,
          { tenantIds: [tenantA, tenantB] },
        );
      }
      await clearCeilings(tenantA);
      for (const actor of actors.values()) {
        await purge('DELETE FROM reward_portal.portal_user_notifications WHERE user_id = :id', {
          id: actor.userId,
        });
        await purge('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: actor.userId });
      }
      await removeEncryptionKeys(db, SUITE);
    } finally {
      await admin.close();
    }
  }
  clearProvidedKeyMaterial(borrowedKeyVars);
  if (app !== undefined) await app.close();
});

// --- T-144: the suite's own residue purge --------------------------------------------------------

/**
 * These two assert what `beforeAll`'s `purgeOwnResidue()` actually did to real rows in the real
 * database, not what its SQL says. The defect they guard against was invisible to inspection and
 * to every other test in this file: the purge deleted `trackers WHERE tracker_code LIKE 'TRK-%'`,
 * a prefix every tracker the portal generates carries, and stayed green for as long as no other
 * campaign in the shared database happened to have a live link row at purge time. Planting that
 * link row makes the condition deterministic instead of waiting for someone else's data.
 */
describe('T-144 · the suite residue purge is scoped to this suite', () => {
  it("TC-3: leaves another campaign's TRK-/CMP- journey completely intact", () => {
    expect(recorded(foreignAfterPurge)).toEqual(JOURNEY_INTACT);
  });

  it("TC-4: still removes this suite's own residue", () => {
    expect(recorded(ownAfterPurge)).toEqual(JOURNEY_REMOVED);
  });
});

// --- TC-1…TC-13: the campaign itself -------------------------------------------------------------

describe('T-037 · campaign basics', () => {
  it('TC-1: a maker creates a draft, with created_by as their id in string form', async () => {
    const code = campaignCode();
    const response = await post('makerA', '/campaigns', {
      campaignCode: code,
      name: 'Raya bonus',
      startDate: inDays(1),
      endDate: inDays(30),
    }).expect(201);

    createdCampaignIds.add(response.body.data.id as number);
    expect(response.body.data.status).toBe('draft');
    expect(response.body.data.effectiveStatus).toBe('draft');
    expect(response.body.data.editable).toBe(true);
    // gap G5 — `varchar(100)`, so the id as a string, not the integer.
    expect(response.body.data.createdBy).toBe(String(as('makerA').userId));

    const [row] = await sql<{ created_by: string; tenant_id: number; status: string }>(
      'SELECT created_by, tenant_id, status FROM reward_config.tenant_campaigns WHERE campaign_code = :code',
      { code },
    );
    expect(row.created_by).toBe(String(as('makerA').userId));
    expect(row.status).toBe('draft');
    // R3 — the tenant came from the verified JWT, not from the body, which has no such field.
    expect(row.tenant_id).toBe(tenantA);
  });

  it('TC-2: a checker cannot create a campaign', async () => {
    await post('checkerA', '/campaigns', {
      campaignCode: campaignCode(),
      name: 'Nope',
      startDate: inDays(1),
      endDate: inDays(30),
    }).expect(403);
  });

  it('TC-3: a merchant, a tenant_admin and a country_admin cannot create a campaign', async () => {
    for (const key of ['merchantA', 'tenantAdminA', 'countryA']) {
      await post(key, '/campaigns', {
        campaignCode: campaignCode(),
        name: 'Nope',
        startDate: inDays(1),
        endDate: inDays(30),
      }).expect(403);
    }
  });

  it('TC-4: a maker in tenant A cannot read a campaign in tenant B — 404, not 403', async () => {
    const theirs = await createDraft('makerB');
    await get('makerA', `/campaigns/${String(theirs.id)}`).expect(404);
  });

  it('TC-5: a maker in A patching a campaign in B gets 404 and leaves B’s row unchanged', async () => {
    const theirs = await createDraft('makerB');
    const [before] = await sql<{ name: string }>(
      'SELECT name FROM reward_config.tenant_campaigns WHERE id = :id',
      { id: theirs.id },
    );

    await patch('makerA', `/campaigns/${String(theirs.id)}`, { name: 'hijacked' }).expect(404);

    const [after] = await sql<{ name: string }>(
      'SELECT name FROM reward_config.tenant_campaigns WHERE id = :id',
      { id: theirs.id },
    );
    expect(after.name).toBe(before.name);
  });

  it('TC-6: a duplicate campaign code in the same tenant is a 409', async () => {
    const first = await createDraft();
    const response = await post('makerA', '/campaigns', {
      campaignCode: first.code,
      name: 'Duplicate',
      startDate: inDays(1),
      endDate: inDays(30),
    }).expect(409);
    expect(response.body.error.code).toBe('CAMPAIGN_CODE_EXISTS');
  });

  it('TC-7: the same code in a different tenant is accepted', async () => {
    const first = await createDraft('makerA');
    const response = await post('makerB', '/campaigns', {
      campaignCode: first.code,
      name: 'Same code, other tenant',
      startDate: inDays(1),
      endDate: inDays(30),
    }).expect(201);
    createdCampaignIds.add(response.body.data.id as number);
  });

  it('TC-8: endDate before startDate is a 400', async () => {
    await post('makerA', '/campaigns', {
      campaignCode: campaignCode(),
      name: 'Backwards',
      startDate: inDays(30),
      endDate: inDays(1),
    }).expect(400);
  });

  it('TC-9: a startDate in the past is a 400', async () => {
    await post('makerA', '/campaigns', {
      campaignCode: campaignCode(),
      name: 'Yesterday',
      startDate: inDays(-2),
      endDate: inDays(30),
    }).expect(400);
  });

  /**
   * **Rewritten by T-065, and the rewrite is the point.**
   *
   * This test used to assert *"dates are stored as the same instant the maker sent"*, and it
   * passed — which is exactly why the defect shipped. Storing the instant is what made the same
   * campaign end on the 15th in UTC and the 16th in `Asia/Kolkata`. The observable property a
   * campaign date actually has is the **day**, so that is what is asserted now, at the only two
   * places that can be wrong: the row in Postgres and the bytes on the wire.
   */
  it('TC-10: a date is stored as the calendar day the maker meant, at UTC midnight', async () => {
    const code = campaignCode();
    // Midnight tomorrow in Kuala Lumpur — an instant that is still "today" in UTC, sent in the
    // pre-T-065 wire form a client written against the old contract still uses.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const startKl = `${tomorrow}T00:00:00+08:00`;
    // And the end date in the shape that actually caused the defect: the last second of the day,
    // in an offset five and a half hours east of UTC.
    const endDay = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const endIst = `${endDay}T23:59:59+05:30`;

    const response = await post('makerA', '/campaigns', {
      campaignCode: code,
      name: 'Timezone',
      startDate: startKl,
      endDate: endIst,
    }).expect(201);
    createdCampaignIds.add(response.body.data.id as number);

    // TC-4 — the stored value, read from the database rather than from the response. A campaign
    // date carries no time of day, in any timezone, so `toISOString()` ends in `T00:00:00.000Z`.
    const [row] = await sql<{ start_date: Date; end_date: Date }>(
      'SELECT start_date, end_date FROM reward_config.tenant_campaigns WHERE campaign_code = :code',
      { code },
    );
    expect(row.start_date.toISOString()).toBe(`${tomorrow}T00:00:00.000Z`);
    expect(row.end_date.toISOString()).toBe(`${endDay}T00:00:00.000Z`);

    // TC-2/TC-3 — and it is served as the plain day, which no timezone can shift. Asserting the
    // string, not `new Date(...)` of it: round-tripping through `Date` is what hid the bug.
    expect(response.body.data.startDate).toBe(tomorrow);
    expect(response.body.data.endDate).toBe(endDay);
  });

  it('T-065: a calendar date sent by the wizard survives storage and retrieval unchanged', async () => {
    // The form the SPA sends after T-065 — no conversion at either end, which is the fix.
    const code = campaignCode();
    const start = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

    const created = await post('makerA', '/campaigns', {
      campaignCode: code,
      name: 'Calendar dates',
      startDate: start,
      endDate: end,
    }).expect(201);
    const id = created.body.data.id as number;
    createdCampaignIds.add(id);

    expect(created.body.data.startDate).toBe(start);
    expect(created.body.data.endDate).toBe(end);

    // TC-7 — the list and the detail view serve the same day the create call did. All three are
    // the same mapper, and this is what stops one screen drifting from another.
    const fetched = await get('makerA', `/campaigns/${String(id)}`).expect(200);
    expect(fetched.body.data.startDate).toBe(start);
    expect(fetched.body.data.endDate).toBe(end);

    const listed = await get('makerA', `/campaigns?search=${code}`).expect(200);
    const row = (
      listed.body.data as { campaignCode: string; startDate: string; endDate: string }[]
    ).find((entry) => entry.campaignCode === code);
    expect(row?.startDate).toBe(start);
    expect(row?.endDate).toBe(end);

    const [stored] = await sql<{ start_date: Date; end_date: Date }>(
      'SELECT start_date, end_date FROM reward_config.tenant_campaigns WHERE campaign_code = :code',
      { code },
    );
    expect(stored.start_date.toISOString()).toBe(`${start}T00:00:00.000Z`);
    expect(stored.end_date.toISOString()).toBe(`${end}T00:00:00.000Z`);
  });

  it('T-065: a single-day campaign is accepted — the end date is the last active day', async () => {
    const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const response = await post('makerA', '/campaigns', {
      campaignCode: campaignCode(),
      name: 'One day only',
      startDate: day,
      endDate: day,
    }).expect(201);
    createdCampaignIds.add(response.body.data.id as number);
    expect(response.body.data.startDate).toBe(day);
    expect(response.body.data.endDate).toBe(day);
  });

  it('TC-11: a budget amount with no currency is a 400', async () => {
    await post('makerA', '/campaigns', {
      campaignCode: campaignCode(),
      name: 'Unpriced',
      startDate: inDays(1),
      endDate: inDays(30),
      budgetAmount: '500000.00',
    }).expect(400);
  });

  it('TC-12: merchants from the maker’s own tenant are written to campaign_merchants', async () => {
    const { id } = await createDraft();
    const response = await post('makerA', `/campaigns/${String(id)}/merchants`, {
      merchantIds: [merchantA, merchantA2],
    }).expect(201);
    expect(response.body.data).toHaveLength(2);

    const rows = await sql<{ merchant_id: number }>(
      `SELECT merchant_id FROM reward_config.campaign_merchants
        WHERE campaign_id = :id AND status = 'active' ORDER BY merchant_id`,
      { id },
    );
    expect(rows.map((row) => row.merchant_id).sort()).toEqual([merchantA, merchantA2].sort());
  });

  it('TC-13: a merchant from another tenant is refused and no row is written', async () => {
    const { id } = await createDraft();
    const response = await post('makerA', `/campaigns/${String(id)}/merchants`, {
      merchantIds: [merchantA, merchantB],
    });
    expect([400, 404]).toContain(response.status);

    const rows = await sql<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_config.campaign_merchants WHERE campaign_id = :id',
      { id },
    );
    expect(rows[0].count).toBe('0');
  });

  it('deselecting a merchant deactivates its row rather than leaving it live', async () => {
    const { id } = await createDraft();
    await post('makerA', `/campaigns/${String(id)}/merchants`, {
      merchantIds: [merchantA, merchantA2],
    }).expect(201);
    await post('makerA', `/campaigns/${String(id)}/merchants`, {
      merchantIds: [merchantA],
    }).expect(201);

    const rows = await sql<{ merchant_id: number; status: string }>(
      'SELECT merchant_id, status FROM reward_config.campaign_merchants WHERE campaign_id = :id ORDER BY merchant_id',
      { id },
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.merchant_id === merchantA)?.status).toBe('active');
    expect(rows.find((row) => row.merchant_id === merchantA2)?.status).toBe('inactive');
  });

  it('a campaign is not editable once submitted', async () => {
    const { id } = await buildSubmittableCampaign();
    await post('makerA', `/campaigns/${String(id)}/submit`).expect(200);
    const response = await patch('makerA', `/campaigns/${String(id)}`, { name: 'too late' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CAMPAIGN_NOT_EDITABLE');
  });

  it('re-submitting a campaign already awaiting approval is a 409', async () => {
    const { id } = await buildSubmittableCampaign();
    await post('makerA', `/campaigns/${String(id)}/submit`).expect(200);
    const response = await post('makerA', `/campaigns/${String(id)}/submit`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CAMPAIGN_TRANSITION_NOT_ALLOWED');
  });
});

// --- TC-14…TC-20: rules and dynamic values -------------------------------------------------------

describe('T-037 · rule binding and dynamic values', () => {
  it('TC-14: the rule picker shows only rules assigned to the maker’s country', async () => {
    const { id } = await createDraft();
    const response = await get('makerA', `/campaigns/${String(id)}/rule-options`).expect(200);
    const ids = (response.body.data as { ruleId: number }[]).map((option) => option.ruleId);
    expect(ids).toContain(ruleAssignedToA);
    expect(ids).not.toContain(ruleUnassigned);
  });

  it('the rule picker carries the version pinned for the country and its parameter schema', async () => {
    const { id } = await createDraft();
    const response = await get('makerA', `/campaigns/${String(id)}/rule-options`).expect(200);
    const option = (
      response.body.data as { ruleId: number; ruleVersionId: number; parameters: unknown }[]
    ).find((entry) => entry.ruleId === ruleAssignedToA);
    expect(option?.ruleVersionId).toBe(ruleVersionA);
    expect(option?.parameters).toMatchObject({ fields: expect.any(Array) });
  });

  it('TC-15 / Verification step 5: attaching a rule not assigned to the country is a 400, not a silent skip', async () => {
    const { componentId, id } = await buildSubmittableCampaign();
    const response = await post('makerA', `/campaigns/${String(id)}/rules`, {
      componentId,
      ruleId: ruleUnassigned,
      values: { minSpend: 50 },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('RULE_NOT_ASSIGNED_TO_COUNTRY');

    const rows = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_config.tracker_component_rules
        WHERE tracker_component_id = :componentId AND rule_id = :ruleId`,
      { componentId, ruleId: ruleUnassigned },
    );
    expect(rows[0].count).toBe('0');
  });

  it('TC-16: a rule with valid parameter values is persisted, with its version pin', async () => {
    const { bindingId } = await buildSubmittableCampaign();
    const [row] = await sql<{ config: string; rule_version_id: number; status: string }>(
      'SELECT config, rule_version_id, status FROM reward_config.tracker_component_rules WHERE id = :id',
      { id: bindingId },
    );
    expect(JSON.parse(row.config)).toEqual({ minSpend: 50 });
    expect(row.rule_version_id).toBe(ruleVersionA);
    expect(row.status).toBe('active');
  });

  it('TC-17 / Verification step 6: a value below the rule’s min is refused **by the server**', async () => {
    // The SPA never sends this — it is built by `curl`-equivalent, exactly as the task requires,
    // so the only thing that can refuse it is the server's own re-validation.
    const { componentId, id } = await buildSubmittableCampaign();
    const response = await post('makerA', `/campaigns/${String(id)}/rules`, {
      componentId,
      ruleId: ruleAssignedToA,
      values: { minSpend: 1 },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'values.minSpend' })]),
    );
  });

  it('TC-18: a missing required parameter is a 400', async () => {
    const { componentId, id } = await buildSubmittableCampaign();
    const response = await post('makerA', `/campaigns/${String(id)}/rules`, {
      componentId,
      ruleId: ruleAssignedToA,
      values: {},
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'values.minSpend' })]),
    );
  });

  it('TC-19: a parameter the schema does not declare is a 400', async () => {
    const { componentId, id } = await buildSubmittableCampaign();
    const response = await post('makerA', `/campaigns/${String(id)}/rules`, {
      componentId,
      ruleId: ruleAssignedToA,
      values: { minSpend: 50, sneaky: 'value' },
    });
    expect(response.status).toBe(400);
  });

  it('values can be edited in place, re-validated against the pinned version', async () => {
    const { id, bindingId } = await buildSubmittableCampaign();
    await patch('makerA', `/campaigns/${String(id)}/rules/${String(bindingId)}`, {
      values: { minSpend: 200, period: 'weekly' },
    }).expect(200);

    const [row] = await sql<{ config: string }>(
      'SELECT config FROM reward_config.tracker_component_rules WHERE id = :id',
      { id: bindingId },
    );
    expect(JSON.parse(row.config)).toEqual({ minSpend: 200, period: 'weekly' });

    await patch('makerA', `/campaigns/${String(id)}/rules/${String(bindingId)}`, {
      values: { minSpend: 1 },
    }).expect(400);
  });

  it('binding the same rule to one component twice is a 409', async () => {
    const { id, componentId } = await buildSubmittableCampaign();
    const response = await post('makerA', `/campaigns/${String(id)}/rules`, {
      componentId,
      ruleId: ruleAssignedToA,
      values: { minSpend: 50 },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('RULE_ALREADY_BOUND');
  });

  it('TC-21q: a component from another campaign is a 400 — components are campaign-scoped', async () => {
    const first = await buildSubmittableCampaign();
    const second = await buildSubmittableCampaign();
    const response = await post('makerA', `/campaigns/${String(second.id)}/rules`, {
      componentId: first.componentId,
      ruleId: ruleAssignedToA,
      values: { minSpend: 50 },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('NOT_PART_OF_CAMPAIGN');
  });
});

// --- T-147: rule operator + component combination logic ------------------------------------------

describe('T-147 · rule operator and component combination logic', () => {
  // A rule/version of this block's own, not `ruleAssignedToA`/`ruleVersionA` — `default_operators`
  // is one of the columns `T103_002`'s immutability trigger freezes once a version is `published`
  // (same set as `expression`/`parameters`/`version_no`/`is_breaking`), so it must be baked into
  // the version's own creating `INSERT` ({@link ensureRuleVersionWithOperators}) rather than set
  // by an `UPDATE` on the shared fixture after the fact — reproduced directly while building this
  // fixture the first way.
  let operatorRuleId: number;

  beforeAll(async () => {
    operatorRuleId = await ensureRule(`${PREFIX}_RULE_OP`);
    await assignRuleToCountry(operatorRuleId, countryA);
    await ensureRuleVersionWithOperators(operatorRuleId, countryA, ['at_least', 'equals']);
  });

  /** Binds {@link operatorRuleId} to a fresh submittable campaign's component, alongside its
   * existing `ruleAssignedToA` binding — `bindRule` allows more than one rule per component, so
   * this needs none of `buildSubmittableCampaign`'s own setup duplicated. */
  async function bindOperatorRule(): Promise<{
    id: number;
    componentId: number;
    bindingId: number;
  }> {
    const { id, componentId } = await buildSubmittableCampaign();
    const bound = await post('makerA', `/campaigns/${String(id)}/rules`, {
      componentId,
      ruleId: operatorRuleId,
      values: { minSpend: 50 },
    }).expect(201);
    const component = (
      bound.body.data.trackers[0].components as { id: number; rules: { id: number }[] }[]
    ).find((c) => c.id === componentId);
    const bindingId = component?.rules[component.rules.length - 1]?.id as number;
    return { id, componentId, bindingId };
  }

  it("the rule picker carries the pinned version's defaultOperators", async () => {
    const { id } = await createDraft();
    const response = await get('makerA', `/campaigns/${String(id)}/rule-options`).expect(200);
    const option = (response.body.data as { ruleId: number; defaultOperators: string[] }[]).find(
      (entry) => entry.ruleId === operatorRuleId,
    );
    expect(option?.defaultOperators).toEqual(['at_least', 'equals']);
  });

  it("an operator from the pinned version's defaultOperators is accepted and persisted", async () => {
    const { id, bindingId } = await bindOperatorRule();
    await patch('makerA', `/campaigns/${String(id)}/rules/${String(bindingId)}`, {
      values: { minSpend: 50 },
      operator: 'at_least',
    }).expect(200);

    const [row] = await sql<{ operator: string }>(
      'SELECT operator FROM reward_config.tracker_component_rules WHERE id = :id',
      { id: bindingId },
    );
    expect(row.operator).toBe('at_least');
  });

  it('an operator outside defaultOperators is a 400 OPERATOR_NOT_ALLOWED', async () => {
    const { id, bindingId } = await bindOperatorRule();
    const response = await patch('makerA', `/campaigns/${String(id)}/rules/${String(bindingId)}`, {
      values: { minSpend: 50 },
      operator: 'between',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OPERATOR_NOT_ALLOWED');
  });

  it('an operator is rejected on a binding whose rule has no defaultOperators at all', async () => {
    // `ruleAssignedToA` (via `buildSubmittableCampaign`'s own default binding) has never had
    // `default_operators` set — every operator must be refused, not just ones outside some set.
    const { id, bindingId } = await buildSubmittableCampaign();
    const response = await patch('makerA', `/campaigns/${String(id)}/rules/${String(bindingId)}`, {
      values: { minSpend: 50 },
      operator: 'at_least',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OPERATOR_NOT_ALLOWED');
  });

  it('operator: null clears a previously set operator', async () => {
    const { id, bindingId } = await bindOperatorRule();
    await patch('makerA', `/campaigns/${String(id)}/rules/${String(bindingId)}`, {
      values: { minSpend: 50 },
      operator: 'equals',
    }).expect(200);
    await patch('makerA', `/campaigns/${String(id)}/rules/${String(bindingId)}`, {
      values: { minSpend: 50 },
      operator: null,
    }).expect(200);

    const [row] = await sql<{ operator: string | null }>(
      'SELECT operator FROM reward_config.tracker_component_rules WHERE id = :id',
      { id: bindingId },
    );
    expect(row.operator).toBeNull();
  });

  it('ruleLogic n_of without ruleThreshold is a 400', async () => {
    const { id, componentId } = await buildSubmittableCampaign();
    const response = await patch(
      'makerA',
      `/campaigns/${String(id)}/components/${String(componentId)}`,
      { ruleLogic: 'n_of' },
    );
    expect(response.status).toBe(400);
  });

  it('ruleThreshold without ruleLogic n_of is a 400', async () => {
    const { id, componentId } = await buildSubmittableCampaign();
    const response = await patch(
      'makerA',
      `/campaigns/${String(id)}/components/${String(componentId)}`,
      { ruleLogic: 'any', ruleThreshold: 2 },
    );
    expect(response.status).toBe(400);
  });

  it('ruleLogic n_of with ruleThreshold is accepted and persisted', async () => {
    const { id, componentId } = await buildSubmittableCampaign();
    await patch('makerA', `/campaigns/${String(id)}/components/${String(componentId)}`, {
      ruleLogic: 'n_of',
      ruleThreshold: 1,
    }).expect(200);

    const [row] = await sql<{ rule_logic: string; rule_threshold: number }>(
      'SELECT rule_logic, rule_threshold FROM reward_config.tracker_components WHERE id = :id',
      { id: componentId },
    );
    expect(row.rule_logic).toBe('n_of');
    expect(row.rule_threshold).toBe(1);
  });

  it("ruleLogic defaults to null (reads as 'all') until a Maker sets one", async () => {
    const { id, componentId } = await buildSubmittableCampaign();
    const journey = await get('makerA', `/campaigns/${String(id)}/journey`).expect(200);
    const component = (
      journey.body.data as {
        trackers: { components: { id: number; ruleLogic: string | null }[] }[];
      }
    ).trackers[0]?.components.find((c) => c.id === componentId);
    expect(component?.ruleLogic).toBeNull();
  });

  it('GET journey surfaces operator/value on the rule and ruleLogic/ruleThreshold on the component', async () => {
    const { id, bindingId, componentId } = await bindOperatorRule();
    await patch('makerA', `/campaigns/${String(id)}/rules/${String(bindingId)}`, {
      values: { minSpend: 50 },
      operator: 'at_least',
    }).expect(200);
    await patch('makerA', `/campaigns/${String(id)}/components/${String(componentId)}`, {
      ruleLogic: 'n_of',
      ruleThreshold: 1,
    }).expect(200);

    const journey = await get('makerA', `/campaigns/${String(id)}/journey`).expect(200);
    const component = (
      journey.body.data as {
        trackers: {
          components: {
            id: number;
            ruleLogic: string;
            ruleThreshold: number;
            rules: { id: number; operator: string | null }[];
          }[];
        }[];
      }
    ).trackers[0]?.components.find((c) => c.id === componentId);
    expect(component?.ruleLogic).toBe('n_of');
    expect(component?.ruleThreshold).toBe(1);
    expect(component?.rules.find((rule) => rule.id === bindingId)?.operator).toBe('at_least');
  });
});

// --- TC-21a…TC-21q: the journey ------------------------------------------------------------------

describe('T-037 · journey builder', () => {
  it('TC-21a: a tracker with three components writes all three tables', async () => {
    const { id } = await createDraft();
    await post('makerA', `/campaigns/${String(id)}/merchants`, { merchantIds: [merchantA] }).expect(
      201,
    );
    const tracker = await post('makerA', `/campaigns/${String(id)}/trackers`, {
      name: 'Three parts',
      completionLogic: 'all',
    }).expect(201);
    const trackerId = tracker.body.data.trackers[0].id as number;

    for (const name of ['One', 'Two', 'Three']) {
      await post('makerA', `/campaigns/${String(id)}/trackers/${String(trackerId)}/components`, {
        name,
        activityId: activityA,
      }).expect(201);
    }

    const [trackerRow] = await sql<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_config.trackers WHERE id = :trackerId',
      { trackerId },
    );
    const [linkRow] = await sql<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_config.tracker_tracker_components WHERE tracker_id = :trackerId',
      { trackerId },
    );
    const [componentRow] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_config.tracker_components tc
        JOIN reward_config.tracker_tracker_components ttc ON ttc.component_id = tc.id
       WHERE ttc.tracker_id = :trackerId`,
      { trackerId },
    );
    expect(trackerRow.count).toBe('1');
    expect(linkRow.count).toBe('3');
    expect(componentRow.count).toBe('3');
  });

  it('7c: the wizard writes group_code = NULL throughout', async () => {
    const { trackerId } = await buildSubmittableCampaign();
    const rows = await sql<{ group_code: string | null }>(
      'SELECT group_code FROM reward_config.tracker_tracker_components WHERE tracker_id = :trackerId',
      { trackerId },
    );
    expect(rows.every((row) => row.group_code === null)).toBe(true);
  });

  it('TC-21b: sequence_order 1,2,3 reordered to 2,1,3 is persisted in the new order', async () => {
    const { id } = await createDraft();
    await post('makerA', `/campaigns/${String(id)}/merchants`, { merchantIds: [merchantA] }).expect(
      201,
    );
    const tracker = await post('makerA', `/campaigns/${String(id)}/trackers`, {
      name: 'Ordered',
      completionLogic: 'all',
    }).expect(201);
    const trackerId = tracker.body.data.trackers[0].id as number;

    const componentIds: number[] = [];
    for (const name of ['A', 'B', 'C']) {
      const response = await post(
        'makerA',
        `/campaigns/${String(id)}/trackers/${String(trackerId)}/components`,
        { name, activityId: activityA },
      ).expect(201);
      const components = response.body.data.trackers[0].components as { id: number }[];
      componentIds.push(components[components.length - 1].id);
    }
    expect(componentIds).toHaveLength(3);

    await patch('makerA', `/campaigns/${String(id)}/trackers/${String(trackerId)}/order`, {
      order: [
        { componentId: componentIds[1], sequenceOrder: 1 },
        { componentId: componentIds[0], sequenceOrder: 2 },
        { componentId: componentIds[2], sequenceOrder: 3 },
      ],
    }).expect(200);

    const rows = await sql<{ component_id: number; sequence_order: number }>(
      `SELECT component_id, sequence_order FROM reward_config.tracker_tracker_components
        WHERE tracker_id = :trackerId ORDER BY sequence_order`,
      { trackerId },
    );
    expect(rows.map((row) => row.component_id)).toEqual([
      componentIds[1],
      componentIds[0],
      componentIds[2],
    ]);
  });

  it('TC-21c: a component can be marked optional', async () => {
    const { id, componentId } = await buildSubmittableCampaign();
    await patch('makerA', `/campaigns/${String(id)}/components/${String(componentId)}`, {
      isMandatory: false,
    }).expect(200);

    const [row] = await sql<{ is_mandatory: boolean }>(
      'SELECT is_mandatory FROM reward_config.tracker_tracker_components WHERE component_id = :componentId',
      { componentId },
    );
    expect(row.is_mandatory).toBe(false);
  });

  it('TC-21d: an n_of threshold of 2 of 3 is persisted on trackers', async () => {
    const { id } = await createDraft();
    await post('makerA', `/campaigns/${String(id)}/merchants`, { merchantIds: [merchantA] }).expect(
      201,
    );
    const tracker = await post('makerA', `/campaigns/${String(id)}/trackers`, {
      name: 'Any two',
      completionLogic: 'all',
    }).expect(201);
    const trackerId = tracker.body.data.trackers[0].id as number;
    for (const name of ['A', 'B', 'C']) {
      await post('makerA', `/campaigns/${String(id)}/trackers/${String(trackerId)}/components`, {
        name,
        activityId: activityA,
      }).expect(201);
    }

    await patch('makerA', `/campaigns/${String(id)}/trackers/${String(trackerId)}`, {
      completionLogic: 'n_of',
      completionThreshold: 2,
    }).expect(200);

    const [row] = await sql<{ completion_logic: string; completion_threshold: number }>(
      'SELECT completion_logic, completion_threshold FROM reward_config.trackers WHERE id = :trackerId',
      { trackerId },
    );
    expect(row.completion_logic).toBe('n_of');
    expect(row.completion_threshold).toBe(2);
  });

  it('TC-21e: a threshold of 4 across 3 components is refused', async () => {
    const { id, trackerId } = await buildSubmittableCampaign();
    const response = await patch(
      'makerA',
      `/campaigns/${String(id)}/trackers/${String(trackerId)}`,
      { completionLogic: 'n_of', completionThreshold: 4 },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('UNACHIEVABLE_COMPLETION_THRESHOLD');
  });

  it('TC-21f: a threshold of 0 is refused', async () => {
    const { id, trackerId } = await buildSubmittableCampaign();
    await patch('makerA', `/campaigns/${String(id)}/trackers/${String(trackerId)}`, {
      completionLogic: 'n_of',
      completionThreshold: 0,
    }).expect(400);
  });

  it('TC-21g: deleting a component that would leave the threshold above the count is refused, and rolls back', async () => {
    const { id } = await createDraft();
    await post('makerA', `/campaigns/${String(id)}/merchants`, { merchantIds: [merchantA] }).expect(
      201,
    );
    const tracker = await post('makerA', `/campaigns/${String(id)}/trackers`, {
      name: 'Two of two',
      completionLogic: 'all',
    }).expect(201);
    const trackerId = tracker.body.data.trackers[0].id as number;

    const componentIds: number[] = [];
    for (const name of ['A', 'B']) {
      const response = await post(
        'makerA',
        `/campaigns/${String(id)}/trackers/${String(trackerId)}/components`,
        { name, activityId: activityA },
      ).expect(201);
      const components = response.body.data.trackers[0].components as { id: number }[];
      componentIds.push(components[components.length - 1].id);
    }
    await patch('makerA', `/campaigns/${String(id)}/trackers/${String(trackerId)}`, {
      completionLogic: 'n_of',
      completionThreshold: 2,
    }).expect(200);

    const response = await del(
      'makerA',
      `/campaigns/${String(id)}/components/${String(componentIds[0])}`,
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('UNACHIEVABLE_COMPLETION_THRESHOLD');

    // Never silently unachievable: the delete rolled back, so both links survive.
    const [row] = await sql<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_config.tracker_tracker_components WHERE tracker_id = :trackerId',
      { trackerId },
    );
    expect(row.count).toBe('2');
  });

  it('TC-21h: a component whose activity no selected merchant offers is refused', async () => {
    const { id } = await createDraft();
    await post('makerA', `/campaigns/${String(id)}/merchants`, { merchantIds: [merchantA] }).expect(
      201,
    );
    const tracker = await post('makerA', `/campaigns/${String(id)}/trackers`, {
      name: 'Bad activity',
      completionLogic: 'all',
    }).expect(201);
    const trackerId = tracker.body.data.trackers[0].id as number;

    const response = await post(
      'makerA',
      `/campaigns/${String(id)}/trackers/${String(trackerId)}/components`,
      { name: 'Unoffered', activityId: activityUnoffered },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ACTIVITY_NOT_OFFERED_BY_CAMPAIGN_MERCHANTS');
  });

  it('the activity picker offers exactly what the chosen merchants provide', async () => {
    const { id } = await createDraft();
    await post('makerA', `/campaigns/${String(id)}/merchants`, { merchantIds: [merchantA] }).expect(
      201,
    );
    const response = await get('makerA', `/campaigns/${String(id)}/activities`).expect(200);
    const ids = (response.body.data as { activityId: number }[]).map((entry) => entry.activityId);
    expect(ids).toContain(activityA);
    expect(ids).not.toContain(activityA2);
    expect(ids).not.toContain(activityUnoffered);
  });

  it('TC-21p: two trackers on one campaign both appear in tenant_campaign_trackers', async () => {
    const { id } = await buildSubmittableCampaign();
    await post('makerA', `/campaigns/${String(id)}/trackers`, {
      name: 'Second tracker',
      completionLogic: 'any',
    }).expect(201);

    const [row] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_config.tenant_campaign_trackers
        WHERE campaign_id = :id AND status = 'active'`,
      { id },
    );
    expect(row.count).toBe('2');
  });

  it('TC-21q: a tracker from another campaign cannot be edited through this one', async () => {
    const first = await buildSubmittableCampaign();
    const second = await buildSubmittableCampaign();
    const response = await patch(
      'makerA',
      `/campaigns/${String(second.id)}/trackers/${String(first.trackerId)}`,
      { name: 'hijacked' },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('NOT_PART_OF_CAMPAIGN');
  });
});

// --- TC-21k…TC-21n: the three reward levels ------------------------------------------------------

describe('T-037 · reward attachment', () => {
  it('TC-21: the reward picker shows only rewards assigned to the maker’s country', async () => {
    const { id } = await createDraft();
    const response = await get('makerA', `/campaigns/${String(id)}/reward-options`).expect(200);
    const ids = (response.body.data as { rewardPolicyId: number }[]).map(
      (option) => option.rewardPolicyId,
    );
    expect(ids).toContain(rewardPolicyA);
  });

  it('TC-21k/l/m/n: all three levels write their own table, and the worst case sums them', async () => {
    const { id, trackerId, componentId } = await buildSubmittableCampaign();
    await post('makerA', `/campaigns/${String(id)}/rewards`, {
      level: 'tracker',
      refId: trackerId,
      rewardPolicyId: rewardPolicyA2,
    }).expect(201);
    await post('makerA', `/campaigns/${String(id)}/rewards`, {
      level: 'component',
      refId: componentId,
      rewardPolicyId: rewardPolicyPoints,
    }).expect(201);

    const [campaignRow] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_config.reward_campaign_assignments
        WHERE campaign_id = :id AND status = 'active'`,
      { id },
    );
    const [trackerRow] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_config.reward_tracker_assignments
        WHERE tracker_id = :trackerId AND status = 'active'`,
      { trackerId },
    );
    const [componentRow] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_config.reward_component_assignments
        WHERE component_id = :componentId AND status = 'active'`,
      { componentId },
    );
    expect([campaignRow.count, trackerRow.count, componentRow.count]).toEqual(['1', '1', '1']);

    const caps = await get('makerA', `/campaigns/${String(id)}/caps`).expect(200);
    const payout = caps.body.data.worstCasePayout as {
      unitCode: string | null;
      perCustomerAmount: string;
    }[];
    // MYR 10 (campaign) + MYR 5 (tracker) = 15; PTS 100 (component) stays separate — §3.1.
    expect(payout.find((line) => line.unitCode === 'MYR')?.perCustomerAmount).toBe('15');
    expect(payout.find((line) => line.unitCode === 'PTS')?.perCustomerAmount).toBe('100');
  });

  it('attaching the same policy twice at one level is a 409', async () => {
    const { id } = await buildSubmittableCampaign();
    const response = await post('makerA', `/campaigns/${String(id)}/rewards`, {
      level: 'campaign',
      rewardPolicyId: rewardPolicyA,
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('REWARD_ALREADY_ATTACHED');
  });

  it('a reward can be detached, and disappears from the journey tree', async () => {
    const { id } = await buildSubmittableCampaign();
    const journey = await get('makerA', `/campaigns/${String(id)}/journey`).expect(200);
    const assignmentId = journey.body.data.campaignRewards[0].id as number;

    await del('makerA', `/campaigns/${String(id)}/rewards/campaign/${String(assignmentId)}`).expect(
      200,
    );
    const after = await get('makerA', `/campaigns/${String(id)}/journey`).expect(200);
    expect(after.body.data.campaignRewards).toHaveLength(0);
  });
});

// --- TC-21r…TC-21cc: budgets and limits ----------------------------------------------------------

describe('T-037 · budgets and limits', () => {
  const budget = (overrides: Record<string, unknown> = {}) => ({
    capClass: 'budget',
    scopeLevel: 'campaign',
    periodType: 'lifetime',
    unitType: 'currency',
    unitCode: 'MYR',
    maxTotalAmount: '500000',
    ...overrides,
  });

  it('TC-21r/TC-21z: lifetime, daily and monthly budgets write three rows and sync the legacy pair', async () => {
    const { id } = await buildSubmittableCampaign();
    await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [
        budget({ maxTotalAmount: '500000' }),
        budget({ periodType: 'daily', maxTotalAmount: '20000' }),
        budget({ periodType: 'monthly', maxTotalAmount: '300000' }),
      ],
    }).expect(200);

    const rows = await sql<{ period_type: string; cap_class: string }>(
      `SELECT period_type, cap_class FROM reward_config.campaign_caps
        WHERE campaign_id = :id AND status = 'active' ORDER BY period_type`,
      { id },
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.cap_class === 'budget')).toBe(true);

    // TC-21z — the legacy columns other services still read are kept in step.
    const [campaign] = await sql<{ budget_amount: string; budget_currency: string }>(
      'SELECT budget_amount, budget_currency FROM reward_config.tenant_campaigns WHERE id = :id',
      { id },
    );
    expect(Number(campaign.budget_amount)).toBe(500000);
    expect(campaign.budget_currency.trim()).toBe('MYR');
  });

  it('TC-21s: a time-of-day budget stores its window', async () => {
    const { id } = await buildSubmittableCampaign();
    await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [
        budget({
          periodType: 'time_of_day',
          windowStartTime: '18:00',
          windowEndTime: '22:00',
          maxTotalAmount: '5000',
        }),
      ],
    }).expect(200);

    const [row] = await sql<{ window_start_time: string; window_end_time: string }>(
      `SELECT window_start_time, window_end_time FROM reward_config.campaign_caps
        WHERE campaign_id = :id AND period_type = 'time_of_day' AND status = 'active'`,
      { id },
    );
    expect(row.window_start_time).toBe('18:00:00');
    expect(row.window_end_time).toBe('22:00:00');
  });

  it('TC-21t: a tracker budget stores scope_level=tracker with the tracker’s ref id', async () => {
    const { id, trackerId } = await buildSubmittableCampaign();
    await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [
        budget({
          scopeLevel: 'tracker',
          scopeRefId: trackerId,
          periodType: 'daily',
          maxTotalAmount: '2000',
        }),
      ],
    }).expect(200);

    const [row] = await sql<{ scope_level: string; scope_ref_id: number }>(
      `SELECT scope_level, scope_ref_id FROM reward_config.campaign_caps
        WHERE campaign_id = :id AND status = 'active'`,
      { id },
    );
    expect(row.scope_level).toBe('tracker');
    expect(row.scope_ref_id).toBe(trackerId);
  });

  it('a tracker budget naming another campaign’s tracker is refused', async () => {
    const first = await buildSubmittableCampaign();
    const second = await buildSubmittableCampaign();
    const response = await put('makerA', `/campaigns/${String(second.id)}/caps`, {
      caps: [budget({ scopeLevel: 'tracker', scopeRefId: first.trackerId })],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('NOT_PART_OF_CAMPAIGN');
  });

  it('TC-21u/TC-21v: customer limits, including an occurrence-only limit with no amount', async () => {
    const { id } = await buildSubmittableCampaign();
    await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [
        budget({ capClass: 'limit', periodType: 'daily', maxTotalAmount: '50' }),
        budget({ capClass: 'limit', periodType: 'monthly', maxTotalAmount: '500' }),
        budget({ capClass: 'limit', periodType: 'lifetime', maxTotalAmount: '1000' }),
        {
          capClass: 'limit',
          scopeLevel: 'campaign',
          periodType: 'daily',
          maxOccurrences: 3,
          unitType: 'points',
          unitCode: 'PTS',
        },
      ],
    }).expect(200);

    const rows = await sql<{ cap_class: string; max_occurrences: number | null }>(
      `SELECT cap_class, max_occurrences FROM reward_config.campaign_caps
        WHERE campaign_id = :id AND cap_class = 'limit' AND status = 'active'`,
      { id },
    );
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.max_occurrences === 3)).toHaveLength(1);
  });

  it('TC-21w: an amount with no currency is refused by the server too', async () => {
    const { id } = await buildSubmittableCampaign();
    const response = await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [
        { capClass: 'budget', scopeLevel: 'campaign', periodType: 'lifetime', maxTotalAmount: '1' },
      ],
    });
    expect(response.status).toBe(400);
  });

  it('TC-21x: tracker budgets above the campaign budget warn, and the write still succeeds', async () => {
    const { id, trackerId } = await buildSubmittableCampaign();
    const response = await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [
        budget({ maxTotalAmount: '100000' }),
        budget({ scopeLevel: 'tracker', scopeRefId: trackerId, maxTotalAmount: '150000' }),
      ],
    }).expect(200);

    const codes = (response.body.data.warnings as { code: string }[]).map((w) => w.code);
    expect(codes).toContain('TRACKER_BUDGETS_EXCEED_CAMPAIGN');
    expect(response.body.data.caps).toHaveLength(2);
  });

  it('TC-21y: a per-customer daily limit above the campaign daily budget warns', async () => {
    const { id } = await buildSubmittableCampaign();
    const response = await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [
        budget({ periodType: 'daily', maxTotalAmount: '100' }),
        budget({ capClass: 'limit', periodType: 'daily', maxTotalAmount: '500' }),
      ],
    }).expect(200);

    const codes = (response.body.data.warnings as { code: string }[]).map((w) => w.code);
    expect(codes).toContain('CUSTOMER_LIMIT_EXCEEDS_DAILY_BUDGET');
  });

  it('TC-21aa: on_breach and warn_at_percent are persisted', async () => {
    const { id } = await buildSubmittableCampaign();
    await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [budget({ onBreach: 'pause_campaign', warnAtPercent: 80 })],
    }).expect(200);

    const [row] = await sql<{ on_breach: string; warn_at_percent: number }>(
      `SELECT on_breach, warn_at_percent FROM reward_config.campaign_caps
        WHERE campaign_id = :id AND status = 'active'`,
      { id },
    );
    expect(row.on_breach).toBe('pause_campaign');
    expect(row.warn_at_percent).toBe(80);
  });

  it('TC-21bb: a currency differing from the campaign’s needs explicit confirmation', async () => {
    const { id } = await buildSubmittableCampaign();
    const refused = await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [budget({ unitCode: 'SGD' })],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('CAP_CURRENCY_MISMATCH_UNCONFIRMED');

    // Confirmed, the write succeeds. The campaign keeps its MYR **lifetime** budget (which is
    // what the legacy `budget_currency` pair tracks — TC-21z), so the SGD *daily* cap remains a
    // genuine mismatch and is still surfaced as a warning afterwards. A single SGD lifetime cap
    // would instead *become* the campaign's currency through the legacy sync, at which point
    // there is correctly nothing left to warn about.
    const confirmed = await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [budget(), budget({ periodType: 'daily', unitCode: 'SGD', maxTotalAmount: '1000' })],
      confirmCurrencyMismatch: true,
    }).expect(200);
    const codes = (confirmed.body.data.warnings as { code: string }[]).map((w) => w.code);
    expect(codes).toContain('CAP_CURRENCY_DIFFERS_FROM_CAMPAIGN');

    const [campaign] = await sql<{ budget_currency: string }>(
      'SELECT budget_currency FROM reward_config.tenant_campaigns WHERE id = :id',
      { id },
    );
    expect(campaign.budget_currency.trim()).toBe('MYR');
  });

  it('TC-21cc: an MYR budget and a PTS budget coexist with distinct units', async () => {
    const { id } = await buildSubmittableCampaign();
    await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [
        budget({ maxTotalAmount: '500000' }),
        budget({ unitType: 'points', unitCode: 'PTS', maxTotalAmount: '2000000' }),
      ],
    }).expect(200);

    const rows = await sql<{ unit_type: string; unit_code: string }>(
      `SELECT unit_type, unit_code FROM reward_config.campaign_caps
        WHERE campaign_id = :id AND status = 'active' ORDER BY unit_code`,
      { id },
    );
    expect(rows.map((row) => `${row.unit_type}:${row.unit_code}`)).toEqual([
      'currency:MYR',
      'points:PTS',
    ]);
  });

  it('TC-21dd/TC-21ee: a points reward with no PTS budget warns; a cash reward with an MYR budget does not', async () => {
    const { id, componentId } = await buildSubmittableCampaign();
    await post('makerA', `/campaigns/${String(id)}/rewards`, {
      level: 'component',
      refId: componentId,
      rewardPolicyId: rewardPolicyPoints,
    }).expect(201);

    const response = await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [budget({ maxTotalAmount: '500000' })],
    }).expect(200);

    const warnings = response.body.data.warnings as { code: string; unitCode: string | null }[];
    const unbudgeted = warnings.filter((w) => w.code === 'REWARD_UNIT_HAS_NO_BUDGET');
    expect(unbudgeted.map((w) => w.unitCode)).toEqual(['PTS']);
  });

  it('replacing the cap set deactivates what was removed rather than deleting the history', async () => {
    const { id } = await buildSubmittableCampaign();
    await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [
        budget({ maxTotalAmount: '500000' }),
        budget({ periodType: 'daily', maxTotalAmount: '2000' }),
      ],
    }).expect(200);
    await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [budget({ maxTotalAmount: '400000' })],
    }).expect(200);

    const rows = await sql<{ period_type: string; status: string; max_total_amount: string }>(
      `SELECT period_type, status, max_total_amount FROM reward_config.campaign_caps
        WHERE campaign_id = :id ORDER BY period_type`,
      { id },
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.period_type === 'daily')?.status).toBe('inactive');
    const lifetime = rows.find((row) => row.period_type === 'lifetime');
    expect(lifetime?.status).toBe('active');
    // Reused the existing unique key rather than inserting a duplicate — see caps.service.ts.
    expect(Number(lifetime?.max_total_amount)).toBe(400000);
  });
});

// --- TC-21ff…TC-21kk: the tenant budget ceiling --------------------------------------------------

describe('T-037 · tenant budget ceiling', () => {
  const budget = (amount: string, unit: 'MYR' | 'PTS' = 'MYR') => ({
    capClass: 'budget',
    scopeLevel: 'campaign',
    periodType: 'lifetime',
    unitType: unit === 'MYR' ? 'currency' : 'points',
    unitCode: unit,
    maxTotalAmount: amount,
  });

  afterEach(async () => {
    await clearCeilings(tenantA);
  });

  it('TC-21gg: a draft above the ceiling still saves — the gate is submission, not drafting', async () => {
    await setCeiling(tenantA, 'currency', 'MYR', '500000', '400000');
    const { id } = await buildSubmittableCampaign();

    const response = await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [budget('9000000')],
    }).expect(200);

    const ceiling = (response.body.data.ceilings as { unitCode: string; state: string }[]).find(
      (entry) => entry.unitCode === 'MYR',
    );
    expect(ceiling?.state).toBe('over');
  });

  it('TC-21ff / TC-21kk: submitting above the ceiling is a 422, straight from the service', async () => {
    await setCeiling(tenantA, 'currency', 'MYR', '500000', null);
    const { id } = await buildSubmittableCampaign();
    await put('makerA', `/campaigns/${String(id)}/caps`, { caps: [budget('600000')] }).expect(200);

    // No wizard involved: this is the raw endpoint, exactly as a `curl` would reach it. The only
    // thing standing between this request and an over-budget campaign is `CampaignsService.submit`.
    const response = await post('makerA', `/campaigns/${String(id)}/submit`);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('BUDGET_EXCEEDS_TENANT_CEILING');

    const [row] = await sql<{ status: string }>(
      'SELECT status FROM reward_config.tenant_campaigns WHERE id = :id',
      { id },
    );
    expect(row.status).toBe('draft');
    const [requests] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_approval_requests
        WHERE entity_type = 'campaign' AND entity_id = :id`,
      { id },
    );
    expect(requests.count).toBe('0');
  });

  it('TC-21hh: a budget between the warn threshold and the ceiling submits, and the payload carries the percentage', async () => {
    await setCeiling(tenantA, 'currency', 'MYR', '500000', '400000');
    const { id } = await buildSubmittableCampaign();
    await put('makerA', `/campaigns/${String(id)}/caps`, { caps: [budget('470000')] }).expect(200);

    await post('makerA', `/campaigns/${String(id)}/submit`).expect(200);

    const [request] = await sql<{ payload: { budgets: { percentOfCeiling: number }[] } }>(
      `SELECT payload FROM reward_portal.portal_approval_requests
        WHERE entity_type = 'campaign' AND entity_id = :id`,
      { id },
    );
    expect(request.payload.budgets[0].percentOfCeiling).toBe(94);
  });

  it('TC-21ii: a tenant with no ceiling row submits normally — unlimited, not blocked', async () => {
    const { id } = await buildSubmittableCampaign();
    await put('makerA', `/campaigns/${String(id)}/caps`, { caps: [budget('99000000')] }).expect(
      200,
    );
    await post('makerA', `/campaigns/${String(id)}/submit`).expect(200);
  });

  it('TC-21jj: an MYR ceiling does not constrain a PTS budget', async () => {
    await setCeiling(tenantA, 'currency', 'MYR', '100', null);
    const { id } = await buildSubmittableCampaign();
    await put('makerA', `/campaigns/${String(id)}/caps`, {
      caps: [budget('9000000', 'PTS')],
      confirmCurrencyMismatch: true,
    }).expect(200);

    await post('makerA', `/campaigns/${String(id)}/submit`).expect(200);
  });
});

// --- TC-21i/j/o and submission -------------------------------------------------------------------

describe('T-037 · structural validation and submission', () => {
  it('TC-21i: a component with no rule blocks submission with a 422', async () => {
    const { id, trackerId } = await buildSubmittableCampaign();
    await post('makerA', `/campaigns/${String(id)}/trackers/${String(trackerId)}/components`, {
      name: 'Ruleless',
      activityId: activityA,
    }).expect(201);

    const response = await post('makerA', `/campaigns/${String(id)}/submit`);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('CAMPAIGN_STRUCTURE_INCOMPLETE');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'COMPONENT_HAS_NO_RULE' })]),
    );
  });

  it('TC-21j: a tracker with no components blocks submission with a 422', async () => {
    const { id } = await buildSubmittableCampaign();
    await post('makerA', `/campaigns/${String(id)}/trackers`, {
      name: 'Empty',
      completionLogic: 'all',
    }).expect(201);

    const response = await post('makerA', `/campaigns/${String(id)}/submit`);
    expect(response.status).toBe(422);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'TRACKER_HAS_NO_COMPONENT' })]),
    );
  });

  it('TC-21o: a campaign with no reward at any level blocks submission with a 422', async () => {
    const { id } = await buildSubmittableCampaign();
    const journey = await get('makerA', `/campaigns/${String(id)}/journey`).expect(200);
    const assignmentId = journey.body.data.campaignRewards[0].id as number;
    await del('makerA', `/campaigns/${String(id)}/rewards/campaign/${String(assignmentId)}`).expect(
      200,
    );

    const response = await post('makerA', `/campaigns/${String(id)}/submit`);
    expect(response.status).toBe(422);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'CAMPAIGN_HAS_NO_REWARD' })]),
    );
  });

  it('step 7 reports every problem at once and marks the campaign unsubmittable', async () => {
    const { id } = await createDraft();
    const response = await get('makerA', `/campaigns/${String(id)}/review`).expect(200);
    expect(response.body.data.submittable).toBe(false);
    const codes = (response.body.data.issues as { code: string }[]).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'CAMPAIGN_HAS_NO_MERCHANT',
        'CAMPAIGN_HAS_NO_TRACKER',
        'CAMPAIGN_HAS_NO_REWARD',
      ]),
    );
  });

  it('Verification steps 3 and 4: a complete campaign submits, creating a pending request with an expiry', async () => {
    // Built by `makerA` explicitly: this case asserts on *which* actor is recorded, so the
    // rotating builder would make the assertion meaningless.
    const { id } = await buildSubmittableCampaign({}, 'makerA');
    const review = await get('makerA', `/campaigns/${String(id)}/review`).expect(200);
    expect(review.body.data.submittable).toBe(true);

    const response = await post('makerA', `/campaigns/${String(id)}/submit`).expect(200);
    expect(response.body.data.campaign.status).toBe('pending_approval');

    const [campaign] = await sql<{ status: string; created_by: string }>(
      'SELECT status, created_by FROM reward_config.tenant_campaigns WHERE id = :id',
      { id },
    );
    expect(campaign.status).toBe('pending_approval');
    expect(campaign.created_by).toBe(String(as('makerA').userId));

    const [request] = await sql<{
      status: string;
      expires_at: Date | null;
      requested_by: number;
    }>(
      `SELECT status, expires_at, requested_by FROM reward_portal.portal_approval_requests
        WHERE entity_type = 'campaign' AND entity_id = :id`,
      { id },
    );
    expect(request.status).toBe('pending');
    expect(request.expires_at).not.toBeNull();
    // gap G5 — an `int` column, so the id as a number, and a real FK to portal_users.
    expect(request.requested_by).toBe(as('makerA').userId);
  });

  it('submission writes an audit row naming the maker, and the campaign audit endpoint returns it', async () => {
    const { id } = await buildSubmittableCampaign({}, 'makerA');
    await post('makerA', `/campaigns/${String(id)}/submit`).expect(200);

    const rows = await sql<{ action: string; performed_by: number }>(
      `SELECT action, performed_by FROM reward_portal.portal_campaign_audit_trail
        WHERE campaign_id = :id AND action = 'submitted'`,
      { id },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].performed_by).toBe(as('makerA').userId);

    const response = await get('makerA', `/campaigns/${String(id)}/audit`).expect(200);
    const actions = (response.body.data as { action: string }[]).map((entry) => entry.action);
    expect(actions).toContain('submitted');
    expect(actions).toContain('created');
  });

  it('submission notifies the tenant’s checkers', async () => {
    const { id } = await buildSubmittableCampaign();
    await post('makerA', `/campaigns/${String(id)}/submit`).expect(200);

    const [row] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM reward_portal.portal_user_notifications
        WHERE user_id = :userId AND notification_type = 'campaign_submitted' AND entity_id = :id`,
      { userId: as('checkerA').userId, id },
    );
    expect(Number(row.count)).toBeGreaterThanOrEqual(1);
  });

  it('a checker cannot submit somebody else’s campaign', async () => {
    const { id } = await buildSubmittableCampaign();
    await post('checkerA', `/campaigns/${String(id)}/submit`).expect(403);
  });
});

// --- scope and visibility ------------------------------------------------------------------------

describe('T-037 · scope', () => {
  it('Verification step 8: a maker in tenant B opening tenant A’s campaign gets 404 on every sub-resource', async () => {
    const { id } = await buildSubmittableCampaign();
    for (const path of [
      '',
      '/journey',
      '/caps',
      '/review',
      '/audit',
      '/merchants',
      '/activities',
    ]) {
      await get('makerB', `/campaigns/${String(id)}${path}`).expect(404);
    }
  });

  it('a maker sees only their own tenant’s campaigns in the list', async () => {
    await buildSubmittableCampaign();
    const mine = await get('makerA', '/campaigns?pageSize=100').expect(200);
    const tenantIds = new Set(
      (mine.body.data as { tenantId: number }[]).map((campaign) => campaign.tenantId),
    );
    expect([...tenantIds]).toEqual([tenantA]);
  });

  it('a second maker in the same tenant can read the campaign — scope is the tenant, not the author', async () => {
    const { id } = await buildSubmittableCampaign();
    await get('makerA2', `/campaigns/${String(id)}`).expect(200);
  });

  it('a merchant may read a campaign it participates in and not one it does not', async () => {
    const participating = await buildSubmittableCampaign();
    const other = await createDraft();
    await post('makerA', `/campaigns/${String(other.id)}/merchants`, {
      merchantIds: [merchantA2],
    }).expect(201);

    await get('merchantA', `/campaigns/${String(participating.id)}`).expect(200);
    await get('merchantA', `/campaigns/${String(other.id)}`).expect(404);
  });

  it('a country_admin sees campaigns across their country’s tenants, read-only', async () => {
    const { id } = await buildSubmittableCampaign();
    await get('countryA', `/campaigns/${String(id)}`).expect(200);
    await patch('countryA', `/campaigns/${String(id)}`, { name: 'nope' }).expect(403);
  });
});
