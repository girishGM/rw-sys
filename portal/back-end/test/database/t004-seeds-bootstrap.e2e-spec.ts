/**
 * T-004 regression suite. Runs against a real Postgres instance, same convention as
 * `t005-versioning-schema.e2e-spec.ts` / `tracker-composition.e2e-spec.ts` — this dev
 * machine has no working Docker daemon, so there is no Testcontainers instance to spin up
 * instead. Assumes the T004 migrations are already applied (`npm run db:migrate`), exactly
 * like every other `test/database/*.e2e-spec.ts` in this project assumes its own task's
 * migrations are already applied.
 *
 * TC-1/2/4 (migrate on a clean DB, migrate twice, migrate again is a no-op) are
 * migration-lifecycle checks verified by hand against the live database and recorded in the
 * completion report's Verification steps, same split T-002/T-005/T-006/T-007's own suites
 * use — this file automates everything else, including TC-3 and TC-14 (idempotency and
 * rollback), by calling the migration files' own exported `up()`/`down()` directly rather
 * than going through Umzug (which tracks "already applied" state and would not re-run a
 * migration a second time on request).
 *
 * `bootstrap:superadmin` (TC-10 .. TC-12) is exercised as a real child process
 * (`npm run bootstrap:superadmin`), the same command the task file's own Verification steps
 * name — not a mocked function call — because the whole point of these three cases is the
 * CLI's env/exit-code/stdout contract, which only a real process boundary can prove.
 *
 * A previous test run's fixture row (if the suite was interrupted mid-run) is cleaned up in
 * `beforeAll`, and the same row is cleaned up again in `afterAll` — this suite's own Super
 * Admin is a throwaway test fixture, not the real production bootstrap (an operator runs that
 * once, by hand, per 01-DATABASE.md §5.5). The seed tables themselves are left fully seeded
 * afterwards (`afterAll` re-runs `T004_001`'s `up()`), because unlike other tasks' fixtures,
 * this task's own seed rows are meant to be permanent.
 *
 * **T-071.** The fixture cleanup used to match `portal_users.email = :email` directly. That
 * stopped working the moment T-056 encrypted `email` at rest (the column holds ciphertext with
 * a fresh IV per row; a plaintext `=` comparison can never match it again) — `beforeAll`'s
 * delete silently affected zero rows from then on, and a leftover fixture from any interrupted
 * run (confirmed live: one dated 2026-08-21, from T-069's own reproduction of this exact
 * defect) permanently trips TC-10/TC-12's "no super_admin yet" precondition for every run
 * after it, with a symptom (`A super_admin already exists.`) that reads like a real guard
 * failure rather than stale test data. Matched on `display_name` instead, which T-056 left
 * unencrypted — the same fix `test/auth/bootstrap-superadmin.e2e-spec.ts`'s own
 * `removeProbeUsers` already uses for the identical reason. `ensureEncryptionKeys` is also
 * called before the CLI runs, defensively — T-056's own completion report (item 2) flagged
 * that `bootstrapSuperAdmin` fails closed without an active `field`/`blind_index` key pair and
 * this suite provisioned none; this dev database happens to carry standing `dev_local_*` keys
 * that mask the gap here today, but a clean database (CI, another machine) would not have them.
 *
 * **T-071 retry-1.** Review of the first attempt correctly found a second, independent gap: TC-1
 * and "every row in the migration's own source array made it into the DB" still asserted the
 * `T004_001`-only baseline for `tenant_admin`/`campaign`, never merged with `T047_003`'s later
 * in-place `UPDATE` (`['view','pause','resume']`) — the `PERMISSION_SEED_EXTRAS`/`seedsTable()`
 * machinery this file already had only recognised `INSERT`-based table extensions, not
 * `UPDATE`-based ones. Fixed, concurrently, by T-073 (`PERMISSION_UPDATE_MIGRATIONS`,
 * `applyPermissionUpdateOverrides`, `reapplyPermissionUpdates`, `updatesTable`, both below) —
 * see that task's own report for the full diagnosis; re-verified here as part of this retry
 * (TC-1 and the row-presence test both proven red when the merge is reverted, green when
 * restored — see this task's own completion report). Re-running this suite twice in immediate
 * succession during this retry's own verification also surfaced a *third*, narrower gap:
 * `deleteTestSuperAdmin`'s cleanup covered only `TEST_SUPERADMIN_DISPLAY_NAME`, not TC-11's own
 * `TEST_SUPERADMIN_OTHER_DISPLAY_NAME` fixture — see that function's doc comment for why a
 * concurrent run of this exact suite (this shared dev database has no per-run isolation) can let
 * TC-11's own "guard should block this" attempt actually succeed, leaving a row no prior version
 * of this cleanup removed.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

import {
  up as seedPermissionsUp,
  down as seedPermissionsDown,
  ROLE_ENTITY_PERMISSIONS,
} from '@/database/migrations/T004_001_seed_role_entity_permissions';
import { ROLE_NAV_CONFIGS } from '@/database/migrations/T004_002_seed_role_nav_configs';
import { ROLE_DASHBOARD_WIDGETS } from '@/database/migrations/T004_003_seed_role_dashboard_widgets';
import { SYSTEM_MESSAGES } from '@/database/migrations/T004_004_seed_system_messages';
import { RBAC_CACHE_CONFIG } from '@/database/migrations/T004_005_seed_rbac_cache_config';
// T-071 — `role_entity_permissions` and `role_nav_configs` are each seeded by more than one
// migration now. See PERMISSION_SEED_EXTRAS / NAV_SEED_MIGRATIONS below.
import { DEFINITION_REQUEST_PERMISSIONS } from '@/database/migrations/T042_001_seed_definition_request_permissions';
import { DEFINITION_REQUEST_NAV_CONFIGS } from '@/database/migrations/T042_002_seed_definition_request_nav';
import { GRPC_GRANT_PERMISSIONS } from '@/database/migrations/T047_002_seed_grpc_grant_permissions';
// T-073 — T047_003 UPDATEs (not INSERTs) an existing role_entity_permissions row T004_001
// seeded. See PERMISSION_UPDATE_MIGRATIONS below for why this needs its own registry, distinct
// from PERMISSION_SEED_EXTRAS above.
import { up as pausePermissionsUp } from '@/database/migrations/T047_003_campaign_pause_permissions';
import { AGENT_NAV_CONFIGS } from '@/database/migrations/T049_001_seed_agent_nav';
// Wave 5/6/7 (T-106, T-116, T-121, T-126, T-107, T-117) — same "add a line here" obligation
// PERMISSION_SEED_EXTRAS/NAV_SEED_MIGRATIONS's own doc comments describe; missing until now.
import { RULE_CATEGORY_PERMISSIONS } from '@/database/migrations/T106_001_seed_rule_category_permissions';
import { REWARD_CATEGORY_PERMISSIONS } from '@/database/migrations/T116_002_seed_reward_category_permissions';
import { FIELD_VALUE_SOURCE_PERMISSIONS } from '@/database/migrations/T121_002_seed_field_value_source_registries';
import { TENANT_CURRENCY_PERMISSIONS } from '@/database/migrations/T126_002_seed_tenant_currency_permissions';
import { RULE_CATEGORY_NAV_CONFIGS } from '@/database/migrations/T107_001_seed_rule_category_nav';
import { REWARD_CATEGORY_NAV_CONFIGS } from '@/database/migrations/T117_001_seed_reward_category_nav';
// T-056 — `portal_users.email` is encrypted; keys must exist before the CLI child process runs,
// and the fixture row must be found by something other than a plaintext `email` comparison.
import { ensureEncryptionKeys, removeEncryptionKeys } from '../auth/support/portal-user-fixture';

const BACK_END_DIR = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(BACK_END_DIR, 'src', 'database', 'migrations');
const T004_KEY_SUITE = 't004boot';
const TEST_SUPERADMIN_EMAIL = 't004test-superadmin@example.com';
const TEST_SUPERADMIN_DISPLAY_NAME = 'T004 Test Super Admin';
// T-071 retry-1 — TC-11's own "guard should have blocked this" fixture. Named here (not just
// inline in TC-11) so `deleteTestSuperAdmin` can clean it up too — see that function's doc
// comment for why this row, specifically, needs its own cleanup entry.
const TEST_SUPERADMIN_OTHER_DISPLAY_NAME = 'T004test Someone Else';

interface PermissionRow {
  role: string;
  entity: string;
  actions: string[];
}

/**
 * Every migration that seeds `reward_config.role_entity_permissions` **besides** `T004_001`
 * (whose own §5.1 matrix stays independently transcribed in TC-1 above, unchanged) — T-071.
 * Adding a permissions row in a new migration means adding one line here; the
 * `covers every migration that seeds role_entity_permissions` test below fails if you forget.
 */
const PERMISSION_SEED_EXTRAS: { readonly file: string; readonly rows: readonly PermissionRow[] }[] =
  [
    {
      file: 'T042_001_seed_definition_request_permissions.ts',
      rows: DEFINITION_REQUEST_PERMISSIONS,
    },
    { file: 'T047_002_seed_grpc_grant_permissions.ts', rows: GRPC_GRANT_PERMISSIONS },
    { file: 'T106_001_seed_rule_category_permissions.ts', rows: RULE_CATEGORY_PERMISSIONS },
    { file: 'T116_002_seed_reward_category_permissions.ts', rows: REWARD_CATEGORY_PERMISSIONS },
    {
      file: 'T121_002_seed_field_value_source_registries.ts',
      rows: FIELD_VALUE_SOURCE_PERMISSIONS,
    },
    { file: 'T126_002_seed_tenant_currency_permissions.ts', rows: TENANT_CURRENCY_PERMISSIONS },
  ];

/**
 * Migrations that mutate an existing `role_entity_permissions` row **in place** (`UPDATE`, not
 * `INSERT`) on top of a row `T004_001` already seeded — T-073.
 *
 * This needs its own registry, separate from `PERMISSION_SEED_EXTRAS` above, because the two
 * fail differently. `PERMISSION_SEED_EXTRAS`'s rows are new `(role, entity)` pairs T004_001's
 * own `down()` never touches (they are not in its baseline array), so they simply survive a
 * direct `down()`/`up()` cycle untouched. A row here is different: it *is* one of T004_001's own
 * baseline pairs, so `down()` deletes it and `up()` re-inserts T004_001's *original* value —
 * silently discarding the UPDATE. `PERMISSION_SEED_EXTRAS`'s `ON CONFLICT DO NOTHING` merge
 * semantics ("first writer wins, skip if already present") are wrong for these — an UPDATE always
 * overrides, never skips — which is why the merge below (`applyPermissionUpdateOverrides`) always
 * overwrites rather than checking `!merged.has(key)`.
 *
 * `up` is the migration's own exported function (not a copy of its SQL), so reapplying it here
 * can never drift from what the migration itself actually does.
 */
const PERMISSION_UPDATE_MIGRATIONS: {
  readonly file: string;
  readonly row: PermissionRow;
  readonly up: (args: { context: Sequelize }) => Promise<void>;
}[] = [
  {
    file: 'T047_003_campaign_pause_permissions.ts',
    row: { role: 'tenant_admin', entity: 'campaign', actions: ['view', 'pause', 'resume'] },
    up: pausePermissionsUp,
  },
];

/** Overwrites (never merely fills a gap in) `merged` with every `PERMISSION_UPDATE_MIGRATIONS`
 * row's current value — the "expected" side of TC-1's comparison must reflect what these
 * migrations leave in the live database, not T004_001's original baseline for that pair. */
function applyPermissionUpdateOverrides(
  merged: Map<string, { role: string; entity: string; actions: string[] }>,
): void {
  for (const migration of PERMISSION_UPDATE_MIGRATIONS) {
    merged.set(`${migration.row.role}::${migration.row.entity}`, migration.row);
  }
}

/** Reapplies every registered in-place `UPDATE` on top of T004_001's own baseline — the T-073
 * fix. `T004_001`'s own `down()` deletes every `(role, entity)` pair in its baseline array
 * (`ROLE_ENTITY_PERMISSIONS`), including ones a later migration like `T047_003` has since
 * overwritten in place, and its matching `up()` only knows T004_001's *original* value for that
 * pair — so a direct `down()`/`up()` cycle (TC-14 below, and this file's own final `afterAll`)
 * would otherwise silently revert the row to that original value, discarding the later UPDATE,
 * every time this suite runs against the shared live database. Call this after every such cycle. */
async function reapplyPermissionUpdates(sequelize: Sequelize): Promise<void> {
  for (const migration of PERMISSION_UPDATE_MIGRATIONS) {
    await migration.up({ context: sequelize });
  }
}

interface NavRow {
  role: string;
  navKey: string;
  label: string;
  path: string;
  sortOrder: number;
}

/**
 * Every migration that seeds `reward_config.role_nav_configs`, paired with the constant it
 * exports (T-071, mirroring `me.e2e-spec.ts`'s `NAV_SEED_MIGRATIONS` after T-069 — see that
 * file's header for the full story of why a hand-copied nav list goes stale). Unlike
 * `PERMISSION_SEED_EXTRAS`, `T004_002`'s own rows are included here too rather than kept
 * separate: SS5.2 below has no independent-transcription history to protect, the same
 * asymmetry `me.e2e-spec.ts` documents.
 */
const NAV_SEED_MIGRATIONS: { readonly file: string; readonly rows: readonly NavRow[] }[] = [
  { file: 'T004_002_seed_role_nav_configs.ts', rows: ROLE_NAV_CONFIGS },
  { file: 'T042_002_seed_definition_request_nav.ts', rows: DEFINITION_REQUEST_NAV_CONFIGS },
  { file: 'T049_001_seed_agent_nav.ts', rows: AGENT_NAV_CONFIGS },
  { file: 'T107_001_seed_rule_category_nav.ts', rows: RULE_CATEGORY_NAV_CONFIGS },
  { file: 'T117_001_seed_reward_category_nav.ts', rows: REWARD_CATEGORY_NAV_CONFIGS },
];
const SEEDED_NAV_ROWS: readonly NavRow[] = NAV_SEED_MIGRATIONS.flatMap((m) => m.rows);

/** True when `file` (a migration source file's contents) inserts into `table`. */
function seedsTable(fileContents: string, table: string): boolean {
  return new RegExp(`INSERT\\s+INTO\\s+reward_config\\.${table}`, 'i').test(fileContents);
}

/** True when `file` (a migration source file's contents) UPDATEs `table` in place — T-073. */
function updatesTable(fileContents: string, table: string): boolean {
  return new RegExp(`UPDATE\\s+reward_config\\.${table}`, 'i').test(fileContents);
}

/** Runs the real `npm run bootstrap:superadmin` command as a child process. */
function runBootstrapCli(env: Record<string, string | undefined>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('npm', ['run', 'bootstrap:superadmin'], {
    cwd: BACK_END_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Matched on `display_name`, not `email` (T-071) — `email` has been ciphertext since T-056, so
 * a plaintext `=` comparison never matches a row this suite itself created, let alone a
 * leftover from an interrupted run. `display_name` is not an encrypted column and is unique
 * enough for a throwaway test fixture nothing else in this database would ever set it to.
 *
 * T-071 retry-1 — deletes **both** of this suite's own fixture display names, not just
 * `TEST_SUPERADMIN_DISPLAY_NAME`. Reproduced live on this shared dev database: this file's own
 * `test:e2e` run was executed twice in immediate succession while `scripts/orchestrator.js
 * --watch` was concurrently running other agents' tasks (confirmed via `ps aux`), and the
 * second run failed TC-12/TC-10/TC-11 with `A super_admin already exists.` against a leftover
 * row — `display_name = 'T004test Someone Else'`, `role = 'super_admin'`, `status = 'active'` —
 * that only TC-11's own literal (see `TEST_SUPERADMIN_OTHER_DISPLAY_NAME`) could have produced,
 * confirmed unique to this file by `grep`. TC-11's own comment already explains why: it exists
 * to prove the "already exists" guard blocks a *second* super_admin, so in a correctly-isolated
 * single run it is normally never actually inserted (`expect(other).toHaveLength(0)` — the
 * `SELECT`, not the `DELETE`). But two concurrent invocations of this exact suite against the
 * same shared, non-Dockerised database can interleave: one run's `afterAll` can delete the
 * *other* concurrent run's just-created `TEST_SUPERADMIN_DISPLAY_NAME` row before that run's own
 * TC-11 executes, which then finds no super_admin, so the guard never fires and TC-11's own
 * bootstrap attempt succeeds for real — creating exactly this row, which no cleanup before this
 * fix ever targeted, so it persisted across every future run once created. Concurrent execution
 * of a suite that mutates a *global* uniqueness constraint (one active `super_admin` for the
 * whole database) against a shared, un-isolated database is an inherent limitation of this
 * project's "no working Docker daemon on this dev machine" convention (see file header), not
 * something one task can fully solve — but cleaning up every fixture name this file itself can
 * produce, not just the primary one, closes the specific "permanent leftover blocks every future
 * run" failure mode, the same defect class T-071's original cause 4 already fixed for the
 * primary fixture.
 */
async function deleteTestSuperAdmin(sequelize: Sequelize): Promise<void> {
  // Sequelize `replacements` (unlike `bind`) are escaped client-side into a parenthesized SQL
  // list, e.g. `('a','b')` — the correct counterpart is `IN (:displayNames)`, not
  // `= ANY(:displayNames)` (which expects a real Postgres array literal, not a list, and fails
  // with a syntax error the first version of this fix did not catch until re-run — see this
  // task's own completion report).
  const displayNames = [TEST_SUPERADMIN_DISPLAY_NAME, TEST_SUPERADMIN_OTHER_DISPLAY_NAME];
  await sequelize.query(
    `DELETE FROM reward_portal.portal_user_credentials
      WHERE user_id IN (SELECT id FROM reward_portal.portal_users WHERE display_name IN (:displayNames))`,
    { type: QueryTypes.RAW, replacements: { displayNames } },
  );
  await sequelize.query(
    `DELETE FROM reward_portal.portal_users WHERE display_name IN (:displayNames)`,
    {
      type: QueryTypes.RAW,
      replacements: { displayNames },
    },
  );
}

describe('T-004 — seed migrations and Super Admin bootstrap', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
    // T-071/T-056 — both keys, before the CLI is ever invoked as a child process.
    await ensureEncryptionKeys(sequelize, T004_KEY_SUITE);
    await deleteTestSuperAdmin(sequelize);
  });

  afterAll(async () => {
    // Restore the fully-seeded end state (see file doc comment) and drop the test fixture.
    await seedPermissionsUp({ context: sequelize });
    // T-073 — also reapply every downstream in-place UPDATE (T047_003 today), otherwise this
    // suite would leave the shared live database's role_entity_permissions permanently reverted
    // to T004_001's original baseline for any row a later migration overwrote.
    await reapplyPermissionUpdates(sequelize);
    await deleteTestSuperAdmin(sequelize);
    await removeEncryptionKeys(sequelize, T004_KEY_SUITE);
    await sequelize.close();
  });

  describe('§5.1 role_entity_permissions content (TC-4 .. TC-7)', () => {
    it('TC-4: maker/campaign — view, create, update, submit', async () => {
      const [row] = await sequelize.query<{ actions: string }>(
        `SELECT actions FROM reward_config.role_entity_permissions
          WHERE role = 'maker' AND entity = 'campaign'`,
        { type: QueryTypes.SELECT },
      );
      expect(JSON.parse(row.actions)).toEqual(['view', 'create', 'update', 'submit']);
    });

    it('TC-5: maker/rule — view only, never create (core product rule)', async () => {
      const [row] = await sequelize.query<{ actions: string }>(
        `SELECT actions FROM reward_config.role_entity_permissions
          WHERE role = 'maker' AND entity = 'rule'`,
        { type: QueryTypes.SELECT },
      );
      expect(JSON.parse(row.actions)).toEqual(['view']);
    });

    it('TC-6: super_admin/rule — includes create, update, delete', async () => {
      const [row] = await sequelize.query<{ actions: string }>(
        `SELECT actions FROM reward_config.role_entity_permissions
          WHERE role = 'super_admin' AND entity = 'rule'`,
        { type: QueryTypes.SELECT },
      );
      expect(JSON.parse(row.actions)).toEqual(
        expect.arrayContaining(['create', 'update', 'delete']),
      );
    });

    it('TC-7: exactly one access_control row, role=super_admin', async () => {
      const rows = await sequelize.query<{ role: string }>(
        `SELECT role FROM reward_config.role_entity_permissions WHERE entity = 'access_control'`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('super_admin');
    });

    it('TC-1: row count and every cell match the 01-DATABASE.md §5.1 matrix exactly (independent transcription, not the migration array under test) plus every later migration that legitimately extends the table', async () => {
      // Transcribed directly from 01-DATABASE.md §5.1 by this test, independently of
      // T004_001's own ROLE_ENTITY_PERMISSIONS export — a prior review (T-004 retry 1)
      // found the migration silently missing a row (tenant_admin/tenant_budget_ceiling)
      // and the old version of this test could not have caught it, because it asserted
      // the DB against the very same array it was meant to be checking. Any future
      // discrepancy between T004_001 and the design doc must fail *this* array, not one
      // imported from the file under test. This block is intentionally left exactly as
      // it read before T-071 — the bug T-071 fixes was never in this array.
      //
      // T-071: `role_entity_permissions` is not seeded by T004_001 alone any more.
      // `T042_001` (`definition_request`) and `T047_002` (`grpc_grant`, a no-op here —
      // T004_001 already carries that exact row post-AR-09) both add to it, each for a
      // reason outside 01-DATABASE.md §5.1 and outside this task's ownership, so — unlike
      // the block above — those rows are taken from each migration's own export rather
      // than re-transcribed, the same "derive from all seeding migrations" fix T-069 used
      // for `role_nav_configs` after the identical staleness class broke eleven assertions
      // in `me.e2e-spec.ts`. `PERMISSION_SEED_EXTRAS` below is guarded by its own test so
      // a future migration that seeds this table cannot go unregistered here again.
      const expected: { role: string; entity: string; actions: string[] }[] = [
        // country
        { role: 'super_admin', entity: 'country', actions: ['view', 'create', 'update'] },
        { role: 'country_admin', entity: 'country', actions: ['view'] },
        // tenant
        { role: 'super_admin', entity: 'tenant', actions: ['view'] },
        { role: 'country_admin', entity: 'tenant', actions: ['view', 'create', 'update'] },
        { role: 'tenant_admin', entity: 'tenant', actions: ['view'] },
        // user
        {
          role: 'super_admin',
          entity: 'user',
          actions: ['view', 'create', 'update', 'delete'],
        },
        { role: 'country_admin', entity: 'user', actions: ['view', 'create', 'update'] },
        { role: 'tenant_admin', entity: 'user', actions: ['view', 'create', 'update'] },
        // merchant
        { role: 'super_admin', entity: 'merchant', actions: ['view'] },
        { role: 'country_admin', entity: 'merchant', actions: ['view'] },
        { role: 'tenant_admin', entity: 'merchant', actions: ['view', 'create', 'update'] },
        { role: 'maker', entity: 'merchant', actions: ['view'] },
        { role: 'checker', entity: 'merchant', actions: ['view'] },
        { role: 'merchant', entity: 'merchant', actions: ['view'] },
        // rule
        {
          role: 'super_admin',
          entity: 'rule',
          actions: ['view', 'create', 'update', 'delete'],
        },
        { role: 'country_admin', entity: 'rule', actions: ['view'] },
        { role: 'tenant_admin', entity: 'rule', actions: ['view'] },
        { role: 'maker', entity: 'rule', actions: ['view'] },
        { role: 'checker', entity: 'rule', actions: ['view'] },
        // reward
        {
          role: 'super_admin',
          entity: 'reward',
          actions: ['view', 'create', 'update', 'delete'],
        },
        { role: 'country_admin', entity: 'reward', actions: ['view'] },
        { role: 'tenant_admin', entity: 'reward', actions: ['view'] },
        { role: 'maker', entity: 'reward', actions: ['view'] },
        { role: 'checker', entity: 'reward', actions: ['view'] },
        // tenant_budget_ceiling — super_admin=view, country_admin=view/create/update,
        // tenant_admin=view (the exact row the retry-1 review found missing).
        { role: 'super_admin', entity: 'tenant_budget_ceiling', actions: ['view'] },
        {
          role: 'country_admin',
          entity: 'tenant_budget_ceiling',
          actions: ['view', 'create', 'update'],
        },
        { role: 'tenant_admin', entity: 'tenant_budget_ceiling', actions: ['view'] },
        // rule_assignment
        {
          role: 'super_admin',
          entity: 'rule_assignment',
          actions: ['view', 'create', 'delete'],
        },
        { role: 'country_admin', entity: 'rule_assignment', actions: ['view'] },
        // reward_assignment
        {
          role: 'super_admin',
          entity: 'reward_assignment',
          actions: ['view', 'create', 'delete'],
        },
        { role: 'country_admin', entity: 'reward_assignment', actions: ['view'] },
        // campaign
        { role: 'super_admin', entity: 'campaign', actions: ['view'] },
        { role: 'country_admin', entity: 'campaign', actions: ['view'] },
        { role: 'tenant_admin', entity: 'campaign', actions: ['view'] },
        {
          role: 'maker',
          entity: 'campaign',
          actions: ['view', 'create', 'update', 'submit'],
        },
        {
          role: 'checker',
          entity: 'campaign',
          actions: ['view', 'approve', 'reject', 'return'],
        },
        { role: 'merchant', entity: 'campaign', actions: ['view'] },
        // approval
        { role: 'super_admin', entity: 'approval', actions: ['view'] },
        { role: 'country_admin', entity: 'approval', actions: ['view'] },
        { role: 'tenant_admin', entity: 'approval', actions: ['view'] },
        { role: 'maker', entity: 'approval', actions: ['view'] },
        { role: 'checker', entity: 'approval', actions: ['view', 'approve', 'reject'] },
        // access_control
        {
          role: 'super_admin',
          entity: 'access_control',
          actions: ['view', 'create', 'update', 'delete'],
        },
        // grpc_grant
        { role: 'super_admin', entity: 'grpc_grant', actions: ['view', 'create', 'update'] },
        // audit
        { role: 'super_admin', entity: 'audit', actions: ['view'] },
        { role: 'country_admin', entity: 'audit', actions: ['view'] },
        { role: 'tenant_admin', entity: 'audit', actions: ['view'] },
        { role: 'checker', entity: 'audit', actions: ['view'] },
        // notification — every role
        { role: 'super_admin', entity: 'notification', actions: ['view', 'update'] },
        { role: 'country_admin', entity: 'notification', actions: ['view', 'update'] },
        { role: 'tenant_admin', entity: 'notification', actions: ['view', 'update'] },
        { role: 'maker', entity: 'notification', actions: ['view', 'update'] },
        { role: 'checker', entity: 'notification', actions: ['view', 'update'] },
        { role: 'merchant', entity: 'notification', actions: ['view', 'update'] },
      ];

      // T-071 — merge in the extra migrations' own rows with the same "first writer wins"
      // semantics their `ON CONFLICT (role, entity) DO NOTHING` gives them live: T042_001's
      // three new rows are added, T047_002's `grpc_grant` row is a no-op because §5.1's own
      // matrix above already claims that (role, entity) pair.
      const merged = new Map<string, { role: string; entity: string; actions: string[] }>();
      for (const row of expected) merged.set(`${row.role}::${row.entity}`, row);
      for (const migration of PERMISSION_SEED_EXTRAS) {
        for (const row of migration.rows) {
          const key = `${row.role}::${row.entity}`;
          if (!merged.has(key)) merged.set(key, row);
        }
      }
      // T-073 — T047_002's tenant_admin/campaign row above (§5.1's own ['view']) is not the
      // final value: T047_003 UPDATEs that exact row in place to add pause/resume. Unlike the
      // PERMISSION_SEED_EXTRAS loop above (new pairs, first-writer-wins), this always overwrites
      // — an UPDATE is never "already present, skip".
      applyPermissionUpdateOverrides(merged);
      const fullExpected = [...merged.values()];

      const rows = await sequelize.query<{ role: string; entity: string; actions: string }>(
        `SELECT role, entity, actions FROM reward_config.role_entity_permissions`,
        { type: QueryTypes.SELECT },
      );
      const seeded = rows.map((r) => ({
        role: r.role,
        entity: r.entity,
        actions: JSON.parse(r.actions) as string[],
      }));

      // Row count must match exactly (catches a missing OR an extra row), then every cell
      // must match exactly in both directions (catches a wrong action list on an
      // otherwise-present role/entity pair).
      expect(seeded).toHaveLength(fullExpected.length);
      const sortKey = (r: { role: string; entity: string }): string => `${r.role}::${r.entity}`;
      const sortedSeeded = [...seeded].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      const sortedExpected = [...fullExpected].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      expect(sortedSeeded).toEqual(sortedExpected);
    });

    it("every row in the migration's own source array made it into the DB (idempotency/insert sanity, not a design-doc check)", async () => {
      const rows = await sequelize.query<{ role: string; entity: string; actions: string }>(
        `SELECT role, entity, actions FROM reward_config.role_entity_permissions`,
        { type: QueryTypes.SELECT },
      );
      const seeded = rows.map((r) => ({
        role: r.role,
        entity: r.entity,
        actions: JSON.parse(r.actions) as string[],
      }));
      // T-073 — a row T047_003 (or any future PERMISSION_UPDATE_MIGRATIONS entry) overwrites in
      // place no longer holds T004_001's original value in the live database, by design; check
      // the current, overridden value for those pairs instead of the baseline this array
      // (correctly, still) records for what T004_001 itself inserted.
      const overridesByKey = new Map(
        PERMISSION_UPDATE_MIGRATIONS.map((m) => [`${m.row.role}::${m.row.entity}`, m.row]),
      );
      for (const expected of ROLE_ENTITY_PERMISSIONS) {
        const override = overridesByKey.get(`${expected.role}::${expected.entity}`);
        expect(seeded).toContainEqual(override ?? expected);
      }
    });
  });

  // --- T-071 — the expectations above must not go stale again ------------------------------
  describe('T-071 — the seeded-permission source TC-1 asserts against', () => {
    /**
     * The regression guard for this task's own defect (cause 1). Scans the migration
     * *sources*, not the database, for the same reason `me.e2e-spec.ts`'s equivalent guard
     * does: a migration is registered here the moment it is written, not once someone
     * remembers to run `db:migrate`.
     */
    it('covers every migration that seeds role_entity_permissions, beyond T004_001', () => {
      const seedingFiles = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter(
          (file) => file.endsWith('.ts') && file !== 'T004_001_seed_role_entity_permissions.ts',
        )
        .filter((file) =>
          seedsTable(
            fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
            'role_entity_permissions',
          ),
        )
        .sort();

      expect(seedingFiles).toEqual(PERMISSION_SEED_EXTRAS.map((m) => m.file).sort());
    });
  });

  // --- T-073 — an in-place UPDATE on a T004_001-seeded row must not go unregistered ----------
  describe('T-073 — the in-place UPDATE migrations TC-1 and TC-14 both account for', () => {
    /**
     * The regression guard for this task's own defect: scans migration *sources*, not the
     * database, for the same "register the moment it's written" reason the INSERT-side guard
     * above does. A migration that UPDATEs an existing role_entity_permissions row and is not
     * added to PERMISSION_UPDATE_MIGRATIONS would otherwise be silently reverted by every direct
     * down()/up() cycle this suite runs (TC-14) and wrongly asserted against by TC-1 above.
     */
    it('covers every migration that UPDATEs an existing role_entity_permissions row, beyond T004_001', () => {
      const updatingFiles = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter(
          (file) => file.endsWith('.ts') && file !== 'T004_001_seed_role_entity_permissions.ts',
        )
        .filter((file) =>
          updatesTable(
            fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
            'role_entity_permissions',
          ),
        )
        .sort();

      expect(updatingFiles).toEqual(PERMISSION_UPDATE_MIGRATIONS.map((m) => m.file).sort());
    });
  });

  const ALL_ROLES = [
    'super_admin',
    'country_admin',
    'tenant_admin',
    'maker',
    'checker',
    'merchant',
  ];

  describe('§5.2 role_nav_configs content (TC-8)', () => {
    it('nav rows per role, ordered by sort_order, match §5.2 exactly for all six roles', async () => {
      for (const role of ALL_ROLES) {
        const rows = await sequelize.query<{
          nav_key: string;
          label: string;
          path: string;
          sort_order: number;
        }>(
          `SELECT nav_key, label, path, sort_order FROM reward_config.role_nav_configs
            WHERE role = :role ORDER BY sort_order`,
          { type: QueryTypes.SELECT, replacements: { role } },
        );
        // T-071 — every seeding migration, not just T004_002 (see SEEDED_NAV_ROWS above);
        // `role_nav_configs` gained rows from T042_002 and T049_001 after this suite was
        // written, and per-role sort orders across the three migrations never collide (no
        // secondary sort key needed — confirmed by inspection, same as `me.e2e-spec.ts`).
        const expected = SEEDED_NAV_ROWS.filter((r) => r.role === role).sort(
          (a, b) => a.sortOrder - b.sortOrder,
        );
        expect(rows.map((r) => r.nav_key)).toEqual(expected.map((r) => r.navKey));
        expect(rows).toEqual(
          expected.map((r) => ({
            nav_key: r.navKey,
            label: r.label,
            path: r.path,
            sort_order: r.sortOrder,
          })),
        );
      }
    });
  });

  // --- T-071 — the expectations above must not go stale again ------------------------------
  describe('T-071 — the seeded-nav source SS5.2 asserts against', () => {
    it('covers every migration that seeds role_nav_configs', () => {
      const seedingFiles = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith('.ts'))
        .filter((file) =>
          seedsTable(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'), 'role_nav_configs'),
        )
        .sort();

      expect(seedingFiles).toEqual(NAV_SEED_MIGRATIONS.map((m) => m.file).sort());
    });
  });

  describe('§5.3 role_dashboard_widgets content (TC-9)', () => {
    it('widget rows per role match §5.3 exactly', async () => {
      for (const role of ALL_ROLES) {
        const rows = await sequelize.query<{
          widget_key: string;
          label: string;
          sort_order: number;
        }>(
          `SELECT widget_key, label, sort_order FROM reward_config.role_dashboard_widgets
            WHERE role = :role ORDER BY sort_order`,
          { type: QueryTypes.SELECT, replacements: { role } },
        );
        const expected = ROLE_DASHBOARD_WIDGETS.filter((r) => r.role === role).sort(
          (a, b) => a.sortOrder - b.sortOrder,
        );
        expect(rows).toEqual(
          expected.map((r) => ({
            widget_key: r.widgetKey,
            label: r.label,
            sort_order: r.sortOrder,
          })),
        );
      }
    });
  });

  describe('system_messages and rbac_cache_config content', () => {
    it('every system_messages key from the migration is present with its exact text', async () => {
      const rows = await sequelize.query<{ message_key: string; message_text: string }>(
        `SELECT message_key, message_text FROM reward_config.system_messages`,
        { type: QueryTypes.SELECT },
      );
      for (const expected of SYSTEM_MESSAGES) {
        expect(rows).toContainEqual({ message_key: expected.key, message_text: expected.text });
      }
    });

    it('rbac_ttl_seconds=300 (static config); rbac_version:<role> present and >= its seeded floor, for all six roles', async () => {
      const rows = await sequelize.query<{ config_key: string; config_value: string }>(
        `SELECT config_key, config_value FROM reward_config.rbac_cache_config`,
        { type: QueryTypes.SELECT },
      );

      // T-071 (cause 3). `rbac_ttl_seconds` is read-only at runtime — nothing in
      // `src/` ever writes it (`permission-cache.service.ts` only reads it) — so the
      // seeded literal is the entire property and stays an exact match.
      const ttlEntry = RBAC_CACHE_CONFIG.find((row) => row.key === 'rbac_ttl_seconds');
      if (ttlEntry === undefined) {
        throw new Error('T004_005_seed_rbac_cache_config.ts has no rbac_ttl_seconds entry');
      }
      expect(rows).toContainEqual({ config_key: ttlEntry.key, config_value: ttlEntry.value });

      // `rbac_version:<role>` is a *live* counter — `access-control.service.ts` bumps it
      // inside the same transaction as every permission/nav/widget write its own header
      // documents ("Every write bumps…"). Asserting the seeded literal `1` was over-strict:
      // any other suite (or a real operator) changing a role's permissions through that
      // screen between two runs of this suite made it fail against a correctly-behaving
      // system — confirmed live (checker=213, maker=122, tenant_admin=3 observed against
      // this same database, none of it this suite's own doing). The seed's real contract is
      // only that the row exists and starts at a positive integer; a later increment is that
      // feature working, not this one regressing, so only presence and monotonic validity are
      // asserted here.
      for (const expected of RBAC_CACHE_CONFIG) {
        if (expected.key === 'rbac_ttl_seconds') continue;
        const row = rows.find((r) => r.config_key === expected.key);
        expect(row).toBeDefined();
        const value = Number(row?.config_value);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(Number(expected.value));
      }
    });
  });

  describe('approval_policies default row (note 5)', () => {
    it('one global row: campaign/maker/checker, requires_approval=true, tenant_id NULL', async () => {
      const rows = await sequelize.query<{
        entity_type: string;
        creator_role: string;
        requires_approval: boolean;
        approver_role: string;
        tenant_id: number | null;
      }>(
        `SELECT entity_type, creator_role, requires_approval, approver_role, tenant_id
           FROM reward_config.approval_policies
          WHERE entity_type = 'campaign' AND creator_role = 'maker' AND tenant_id IS NULL`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entity_type: 'campaign',
        creator_role: 'maker',
        requires_approval: true,
        approver_role: 'checker',
        tenant_id: null,
      });
    });
  });

  describe('idempotency and rollback (TC-3, TC-14)', () => {
    it('TC-3: a hand-edited seeded label survives a second up() — DO NOTHING, not upsert', async () => {
      await sequelize.query(
        `UPDATE reward_config.role_nav_configs SET label = 't004test-hand-edited'
          WHERE role = 'super_admin' AND nav_key = 'dashboard'`,
        { type: QueryTypes.RAW },
      );

      const { up } = await import('@/database/migrations/T004_002_seed_role_nav_configs');
      await up({ context: sequelize });

      const [row] = await sequelize.query<{ label: string }>(
        `SELECT label FROM reward_config.role_nav_configs
          WHERE role = 'super_admin' AND nav_key = 'dashboard'`,
        { type: QueryTypes.SELECT },
      );
      expect(row.label).toBe('t004test-hand-edited');

      // Restore, so §5.2's content assertions above stay meaningful for any later run.
      await sequelize.query(
        `UPDATE reward_config.role_nav_configs SET label = 'Dashboard'
          WHERE role = 'super_admin' AND nav_key = 'dashboard'`,
        { type: QueryTypes.RAW },
      );
    });

    it('TC-2: a second up() inserts zero new rows', async () => {
      const before = await sequelize.query(
        `SELECT count(*)::int AS count FROM reward_config.role_entity_permissions`,
        { type: QueryTypes.SELECT },
      );
      await seedPermissionsUp({ context: sequelize });
      const after = await sequelize.query(
        `SELECT count(*)::int AS count FROM reward_config.role_entity_permissions`,
        { type: QueryTypes.SELECT },
      );
      expect(after).toEqual(before);
    });

    it('TC-14: down() removes only the seeded rows — a later, non-seeded row survives', async () => {
      await sequelize.query(
        `INSERT INTO reward_config.role_entity_permissions (role, entity, actions)
         VALUES ('merchant', 't004test_custom_entity', '["view"]')`,
        { type: QueryTypes.RAW },
      );

      await seedPermissionsDown({ context: sequelize });

      const seededCount = await sequelize.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reward_config.role_entity_permissions
          WHERE (role, entity) IN (${ROLE_ENTITY_PERMISSIONS.map(
            (r) => `('${r.role}','${r.entity}')`,
          ).join(',')})`,
        { type: QueryTypes.SELECT },
      );
      expect(seededCount[0].count).toBe(0);

      const survivor = await sequelize.query<{ role: string }>(
        `SELECT role FROM reward_config.role_entity_permissions
          WHERE entity = 't004test_custom_entity'`,
        { type: QueryTypes.SELECT },
      );
      expect(survivor).toHaveLength(1);

      // Clean up the custom row and restore the seed for every test after this one.
      await sequelize.query(
        `DELETE FROM reward_config.role_entity_permissions WHERE entity = 't004test_custom_entity'`,
        { type: QueryTypes.RAW },
      );
      await seedPermissionsUp({ context: sequelize });
      // T-073 fix. Without this line, the down()/up() cycle above has just reverted every row
      // PERMISSION_UPDATE_MIGRATIONS overrides (T047_003's tenant_admin/campaign today) back to
      // T004_001's original baseline, silently, in the shared live database — reproduced live
      // 2026-08-21 (see completion report) and the root cause of T-072's regression.
      await reapplyPermissionUpdates(sequelize);

      // T-073 regression guard (TC-3): assert the *current*, overridden value survives the
      // cycle, not T004_001's own baseline for that pair. Proven to fail on the unfixed code —
      // deleting the `reapplyPermissionUpdates(sequelize)` call above reverts this to red
      // (`["view"]` instead of `["view","pause","resume"]`).
      for (const migration of PERMISSION_UPDATE_MIGRATIONS) {
        const [row] = await sequelize.query<{ actions: string }>(
          `SELECT actions FROM reward_config.role_entity_permissions
            WHERE role = :role AND entity = :entity`,
          {
            type: QueryTypes.SELECT,
            replacements: { role: migration.row.role, entity: migration.row.entity },
          },
        );
        expect(JSON.parse(row.actions)).toEqual(migration.row.actions);
      }
    });
  });

  describe('bootstrap:superadmin CLI (TC-10 .. TC-12)', () => {
    // TC-12 runs first: it must observe a database with no super_admin yet, otherwise the
    // "already exists" guard (rule 1) would fire before the password policy ever runs.
    //
    // T-071: every row lookup below is keyed on `display_name`, not `email` — the same reason
    // `deleteTestSuperAdmin` changed (see file header). Fixing only the stale-row cleanup and
    // leaving these as `email = :email` would have traded one masked failure for another: with
    // no leftover row, TC-10/TC-12 would reach these queries at last, find zero rows against a
    // ciphertext column no plaintext value can ever equal, and fail on `toHaveLength(1)` (or
    // pass TC-12's `toHaveLength(0)` for the wrong reason — vacuously, whether or not a row was
    // really created). Caught by actually running the suite to completion after the first fix,
    // not by the filed evidence, which never got past the earlier failure to see it.
    it('TC-12: SUPERADMIN_PASSWORD=short is rejected by policy — no user created', async () => {
      const { status, stderr } = runBootstrapCli({
        SUPERADMIN_EMAIL: TEST_SUPERADMIN_EMAIL,
        SUPERADMIN_NAME: TEST_SUPERADMIN_DISPLAY_NAME,
        SUPERADMIN_PASSWORD: 'short',
      });
      expect(status).toBe(1);
      expect(stderr).toMatch(/Password rejected/);

      const rows = await sequelize.query(
        `SELECT id FROM reward_portal.portal_users WHERE display_name = :displayName`,
        { type: QueryTypes.SELECT, replacements: { displayName: TEST_SUPERADMIN_DISPLAY_NAME } },
      );
      expect(rows).toHaveLength(0);
    });

    it('TC-10: creates one active super_admin with must_change_password=true', async () => {
      const { status, stdout } = runBootstrapCli({
        SUPERADMIN_EMAIL: TEST_SUPERADMIN_EMAIL,
        SUPERADMIN_NAME: TEST_SUPERADMIN_DISPLAY_NAME,
        SUPERADMIN_PASSWORD: 'Tr0ub4dor&9xample!',
      });
      expect(status).toBe(0);
      expect(stdout).toMatch(/Super Admin created/);

      const rows = await sequelize.query<{
        status: string;
        must_change_password: boolean;
        role: string;
      }>(
        `SELECT status, must_change_password, role FROM reward_portal.portal_users
          WHERE display_name = :displayName`,
        { type: QueryTypes.SELECT, replacements: { displayName: TEST_SUPERADMIN_DISPLAY_NAME } },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'active',
        must_change_password: true,
        role: 'super_admin',
      });

      const superAdminCount = await sequelize.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reward_portal.portal_users
          WHERE role = 'super_admin' AND deleted_at IS NULL`,
        { type: QueryTypes.SELECT },
      );
      expect(superAdminCount[0].count).toBe(1);

      const [credRow] = await sequelize.query<{ password_hash: string; password_algo: string }>(
        `SELECT c.password_hash, c.password_algo
           FROM reward_portal.portal_user_credentials c
           JOIN reward_portal.portal_users u ON u.id = c.user_id
          WHERE u.display_name = :displayName`,
        { type: QueryTypes.SELECT, replacements: { displayName: TEST_SUPERADMIN_DISPLAY_NAME } },
      );
      expect(credRow.password_algo).toBe('argon2id');
      expect(credRow.password_hash).toMatch(/^\$argon2id\$/);
    });

    it('TC-11: a second run exits 1 with the guard message; count still 1', async () => {
      // T-071 retry-1 — uses the shared, module-level constant (not a local literal) so
      // `deleteTestSuperAdmin` (see its doc comment) can clean this row up too, on the rare
      // occasion a concurrent run of this same suite lets it slip past the guard for real.
      const { status, stderr } = runBootstrapCli({
        SUPERADMIN_EMAIL: 'someone-else@example.com',
        SUPERADMIN_NAME: TEST_SUPERADMIN_OTHER_DISPLAY_NAME,
        SUPERADMIN_PASSWORD: 'Tr0ub4dor&9xample!',
      });
      expect(status).toBe(1);
      expect(stderr).toMatch(/A super_admin already exists/);

      const superAdminCount = await sequelize.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reward_portal.portal_users
          WHERE role = 'super_admin' AND deleted_at IS NULL`,
        { type: QueryTypes.SELECT },
      );
      expect(superAdminCount[0].count).toBe(1);

      const other = await sequelize.query(
        `SELECT id FROM reward_portal.portal_users WHERE display_name = :displayName`,
        {
          type: QueryTypes.SELECT,
          replacements: { displayName: TEST_SUPERADMIN_OTHER_DISPLAY_NAME },
        },
      );
      expect(other).toHaveLength(0);
    });
  });

  describe('TC-13: no literal password value anywhere in the owned source', () => {
    it('grep finds no hardcoded password literal in src/cli or src/database/migrations', () => {
      const result = spawnSync(
        'grep',
        [
          '-rniE',
          'password\\s*[:=]\\s*[\'"][^\'"]+[\'"]',
          path.join(BACK_END_DIR, 'src', 'cli'),
          path.join(BACK_END_DIR, 'src', 'database', 'migrations'),
        ],
        { encoding: 'utf-8' },
      );
      // grep exit code 1 = no matches found, which is the desired outcome here.
      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe('');
    });
  });
});
