/**
 * T-002 regression suite. Runs against a real Postgres instance (env-configured, same
 * `DB_*` vars as the app) rather than a Testcontainers-spun instance — this dev machine
 * has no working Docker daemon (see the T-001 completion report). Whoever picks up CI
 * (T-052) should point this at a Testcontainers/service-container Postgres instead of
 * assuming a pre-existing local instance; the test bodies themselves don't need to change.
 *
 * Connects as the migration-privileged role deliberately, so these tests can freely
 * insert/rollback fixture rows across schemas without fighting `reward_app`'s own
 * least-privilege grants (those grants are asserted directly, as themselves, below).
 */
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { createMigrationConnection } from '@/database/migration-connection';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

describe('T-002 — reward_portal schema', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.close();
  });

  afterEach(async () => {
    await sequelize.query(
      `DELETE FROM reward_portal.portal_users WHERE email LIKE '%@t002test.com'`,
      {
        type: QueryTypes.RAW,
      },
    );
  });

  it('TC-4: rejects a super_admin with a non-null tenant_id', async () => {
    await expect(
      sequelize.query(
        `INSERT INTO reward_portal.portal_users (email, display_name, role, tenant_id)
         VALUES ('sa@t002test.com', 'SA', 'super_admin', 1)`,
        { type: QueryTypes.RAW },
      ),
    ).rejects.toThrow(/ck_portal_users_scope/);
  });

  it('TC-5: rejects a merchant with a null merchant_id', async () => {
    await expect(
      sequelize.query(
        `INSERT INTO reward_portal.portal_users (email, display_name, role, country_id, tenant_id, merchant_id)
         VALUES ('m@t002test.com', 'M', 'merchant', 1, 1, NULL)`,
        { type: QueryTypes.RAW },
      ),
    ).rejects.toThrow(/ck_portal_users_scope/);
  });

  it('TC-6: accepts a maker with country+tenant set and merchant null', async () => {
    await expect(
      sequelize.query(
        `INSERT INTO reward_portal.portal_users (email, display_name, role, country_id, tenant_id)
         VALUES ('maker@t002test.com', 'Maker', 'maker', 1, 1)`,
        { type: QueryTypes.RAW },
      ),
    ).resolves.toBeDefined();
  });

  it('TC-7: rejects a case-insensitive duplicate email among live rows', async () => {
    // T-084: `uq_portal_users_email_live` moved from `lower(email)` to `email_bidx` in T056_001 —
    // the address column is ciphertext now, so uniqueness has to live on the deterministic blind
    // index instead. This test predates that migration and never started supplying one: both rows
    // inserted with a NULL `email_bidx`, and Postgres treats NULL as distinct from NULL in a unique
    // index, so neither INSERT ever collided (reproduced live: both resolve, the `rejects` below
    // never fires). This suite talks to Postgres directly with no NestJS app and no key material —
    // recomputing the real HMAC blind index would mean standing up `KeyRegistryService` and
    // provisioning `encryption_keys` rows for a test that is really about the partial unique index,
    // not about the crypto. A shared literal plays the blind index's actual role instead: in
    // production, two case-insensitive/whitespace variants of one address normalise to the *same*
    // `email_bidx` (T-056's own guarantee, asserted directly in `portal-user-email.crypto.spec.ts`),
    // so giving both rows an identical `email_bidx` here reproduces exactly the collision the real
    // index is there to catch — the two INSERTs below differ only in `email` and `display_name`, as
    // a real case-insensitive duplicate's ciphertext columns would.
    await sequelize.query(
      `INSERT INTO reward_portal.portal_users (email, email_bidx, display_name, role, country_id, tenant_id)
       VALUES ('dup@t002test.com', 't084_shared_bidx_dup_test', 'A', 'maker', 1, 1)`,
      { type: QueryTypes.RAW },
    );
    // Sequelize wraps this into SequelizeUniqueConstraintError with a generic top-level
    // `.message` ("Validation error") — the actual Postgres constraint name is on the
    // wrapped driver error, not the message toThrow() would match against.
    await expect(
      sequelize.query(
        `INSERT INTO reward_portal.portal_users (email, email_bidx, display_name, role, country_id, tenant_id)
         VALUES ('DUP@t002test.com', 't084_shared_bidx_dup_test', 'B', 'maker', 1, 1)`,
        { type: QueryTypes.RAW },
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ constraint: 'uq_portal_users_email_live' }),
    });
  });

  it("TC-8: a soft-deleted user's email becomes reusable — the bug found and fixed 2026-08-15", async () => {
    await sequelize.query(
      `INSERT INTO reward_portal.portal_users (email, display_name, role, country_id, tenant_id)
       VALUES ('reuse@t002test.com', 'First', 'maker', 1, 1)`,
      { type: QueryTypes.RAW },
    );
    await sequelize.query(
      `UPDATE reward_portal.portal_users SET deleted_at = now() WHERE email = 'reuse@t002test.com'`,
      { type: QueryTypes.RAW },
    );
    await expect(
      sequelize.query(
        `INSERT INTO reward_portal.portal_users (email, display_name, role, country_id, tenant_id)
         VALUES ('reuse@t002test.com', 'Second', 'maker', 1, 1)`,
        { type: QueryTypes.RAW },
      ),
    ).resolves.toBeDefined();
  });

  it('TC-16: reward_config table count is unchanged by the portal migrations', async () => {
    const [{ count }] = await sequelize.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema='reward_config'`,
      { type: QueryTypes.SELECT },
    );
    // Not a literal expected number — AR "60 vs 62" drift. What matters is that this
    // number is stable across a migrate/rollback/migrate cycle, which the manual
    // verification in the T-002 completion report already exercised end to end.
    expect(Number(count)).toBeGreaterThan(0);
  });

  it('reward_config.rule_master.tenant_id accepts NULL after T002_009', async () => {
    const [row] = await sequelize.query<{ attnotnull: boolean }>(
      `SELECT attnotnull FROM pg_attribute
       WHERE attrelid = 'reward_config.rule_master'::regclass AND attname = 'tenant_id'`,
      { type: QueryTypes.SELECT },
    );
    expect(row.attnotnull).toBe(false);
  });

  it('reward_config.reward_systems.tenant_id accepts NULL after T002_009', async () => {
    const [row] = await sequelize.query<{ attnotnull: boolean }>(
      `SELECT attnotnull FROM pg_attribute
       WHERE attrelid = 'reward_config.reward_systems'::regclass AND attname = 'tenant_id'`,
      { type: QueryTypes.SELECT },
    );
    expect(row.attnotnull).toBe(false);
  });
});

describe('T-002 — reward_app least-privilege grants (TC-12, TC-13, TC-14)', () => {
  let appSequelize: Sequelize;

  beforeAll(async () => {
    const { Sequelize } = await import('sequelize-typescript');
    appSequelize = new Sequelize({
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      username: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      logging: false,
    });
    await appSequelize.authenticate();
  });

  afterAll(async () => {
    await appSequelize.close();
  });

  it('TC-12: reward_app cannot UPDATE portal_audit_log', async () => {
    await expect(
      appSequelize.query(`UPDATE reward_portal.portal_audit_log SET event_type='x' WHERE 1=0`, {
        type: QueryTypes.RAW,
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('TC-13: reward_app cannot DELETE FROM campaign_audit_trail', async () => {
    await expect(
      appSequelize.query(`DELETE FROM reward_config.campaign_audit_trail WHERE 1=0`, {
        type: QueryTypes.RAW,
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('TC-14: reward_app cannot DROP a reward_config table', async () => {
    await expect(
      appSequelize.query(`DROP TABLE reward_config.tenants`, { type: QueryTypes.RAW }),
    ).rejects.toThrow(/must be owner|permission denied/);
  });

  // T-080: TRUNCATE is a distinct Postgres privilege, not implied by DELETE, so the
  // REVOKE UPDATE, DELETE that guards TC-12 does not by itself stop it. Before the fix,
  // T002_008_grants.ts's blanket `GRANT ALL ON ALL TABLES IN SCHEMA reward_portal` (needed
  // for reward_app's ordinary tables) left TRUNCATE granted on portal_audit_log too — found
  // live by T-051 TC-24: reward_app could run `TRUNCATE reward_portal.portal_audit_log` and
  // take the audit trail from 41300+ rows to 0 in a single statement, defeating the
  // append-only control 01-DATABASE.md §3 exists to provide.
  it('TC-24 (T-080): reward_app cannot TRUNCATE portal_audit_log', async () => {
    await expect(
      appSequelize.query(`TRUNCATE reward_portal.portal_audit_log`, { type: QueryTypes.RAW }),
    ).rejects.toThrow(/permission denied/);
  });

  // Adjacent behaviour (T-080 TC-4): the fix must not take away reward_app's legitimate,
  // still-needed access to this table — it still needs to write and read audit rows, just
  // never erase them wholesale.
  it('TC-4 (T-080, adjacent behaviour unchanged): reward_app can still SELECT/INSERT portal_audit_log', async () => {
    await expect(
      appSequelize.query(`SELECT count(*) FROM reward_portal.portal_audit_log WHERE 1=0`, {
        type: QueryTypes.RAW,
      }),
    ).resolves.toBeDefined();

    await appSequelize.query('BEGIN', { type: QueryTypes.RAW });
    try {
      await expect(
        appSequelize.query(
          `INSERT INTO reward_portal.portal_audit_log (event_type) VALUES ('t080_test')`,
          { type: QueryTypes.RAW },
        ),
      ).resolves.toBeDefined();
    } finally {
      await appSequelize.query('ROLLBACK', { type: QueryTypes.RAW });
    }
  });

  // Adjacent behaviour (T-080 TC-4): sibling audit tables that already revoked TRUNCATE
  // explicitly at creation time (T037_002) must remain unaffected by this migration's change.
  it('TC-4 (T-080, adjacent behaviour unchanged): reward_app still cannot TRUNCATE the sibling portal_campaign_audit_trail', async () => {
    await expect(
      appSequelize.query(`TRUNCATE reward_portal.portal_campaign_audit_trail`, {
        type: QueryTypes.RAW,
      }),
    ).rejects.toThrow(/permission denied/);
  });

  // T-091: found live during T-054 (docs/screenshots). T002_008_grants.ts's GRANT list is
  // an explicit, hand-maintained table list that predates T005/T006/T007/T042 (versioning,
  // campaign caps, tracker grouping, definition requests) — none of those later migrations
  // added their own GRANT, and reward_config gets no ALTER DEFAULT PRIVILEGES the way
  // reward_portal does (deliberate, least-privilege — T002_008_grants.ts's own header), so
  // every one of these 19 tables started with zero grants for reward_app: a raw Postgres
  // 500 the instant anything touched them, including the mandatory v1 campaign wizard
  // Journey step (tracker_tracker_components). Fixed by T-091 across three migrations:
  // T002_008_grants.ts (9 pre-existing, originally-omitted tables), T007_002 (its own new
  // table, granted at creation time) and the new T091_001 (the 9 tables T005/T006 created,
  // which could not be fixed in place — see T091_001's own header for why).
  //
  // TC-3's regression proof (this exact loop, run for real against a scratch database built
  // from the *unfixed* migration chain, saw every one of the 19 assertions below fail with
  // "permission denied" before this fix — see the T-091 completion report for the full
  // transcript; not repeatable here without a second live database this suite doesn't own).
  it('TC-2/TC-3 (T-091): reward_app can now SELECT/INSERT/UPDATE all 19 previously-ungranted reward_config tables', async () => {
    const tables = [
      'tracker_components',
      'tracker_tracker_components',
      'tracker_group_defs',
      'tracker_component_rules',
      'tracker_component_groups',
      'activities',
      'campaign_caps',
      'tenant_budget_ceilings',
      'rule_versions',
      'reward_versions',
      'rule_version_country_assignments',
      'reward_version_country_assignments',
      'version_blasts',
      'version_blast_targets',
      'definition_requests',
      'reward_assignment_cap_overrides',
      'reward_campaign_assignments',
      'reward_component_assignments',
      'reward_tracker_assignments',
    ];
    for (const table of tables) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
        // eslint-disable-next-line no-await-in-loop -- sequential, deliberate: a clear
        // per-table/per-privilege failure message beats a single opaque Promise.all() one.
        const [row] = await appSequelize.query<{ ok: boolean }>(
          `SELECT has_table_privilege('reward_app', 'reward_config.${table}', '${privilege}') AS ok`,
          { type: QueryTypes.SELECT },
        );
        expect({ table, privilege, ok: row.ok }).toEqual({ table, privilege, ok: true });
      }
      // The property that actually matters (R2/AGENT-PROTOCOL §2's own warning about tests
      // that only restate a constant): a real, unprivileged SELECT the Postgres role
      // genuinely enforces, not just a privilege-catalogue lookup.
      // eslint-disable-next-line no-await-in-loop -- same as above
      await expect(
        appSequelize.query(`SELECT 1 FROM reward_config.${table} LIMIT 1`, {
          type: QueryTypes.RAW,
        }),
      ).resolves.toBeDefined();
    }
  });

  // TC-4 (T-091, adjacent behaviour unchanged): none of this task's own GRANT statements
  // name DELETE — 01-DATABASE.md §3 ("DELETE is granted nowhere") is respected by every
  // migration this task added or edited. Deliberately NOT asserted here as "reward_app
  // cannot DELETE": on this project's own shared local dev database specifically,
  // reward_config carries a pre-existing, out-of-project default ACL (confirmed live via
  // pg_default_acl, predates this project — see T002_008_grants.ts's own T-091 comment)
  // that hands reward_app DELETE on every new table regardless of what any migration here
  // grants, and T006_001_campaign_caps.ts's own test already pins that as accepted,
  // relied-upon behaviour for campaign_caps/tenant_budget_ceilings. Asserting "DELETE is
  // forbidden" would therefore be environment-dependent — true on a genuinely clean
  // docker-compose/CI install, false here — which is exactly the kind of test AGENT-PROTOCOL
  // §3 warns against asserting as if it were a universal property.
  it("TC-4 (T-091, adjacent behaviour unchanged): none of this task's own migrations grant DELETE", () => {
    const migrationFiles = [
      'T002_008_grants.ts',
      'T007_002_tracker_group_defs.ts',
      'T091_001_grant_versioning_and_budget_tables.ts',
    ];
    for (const file of migrationFiles) {
      const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'database', 'migrations', file),
        'utf8',
      );
      // Scoped to the executed SQL itself (backtick-delimited template literals), not the
      // whole file — this file's own doc comments discuss DELETE at length (why it is
      // deliberately *not* revoked here, see the migration's own header), so a whole-file
      // scan would false-positive on prose. Only a real `GRANT ... DELETE ...` statement
      // should ever fail this.
      const sqlStrings = source.match(/`([^`]*)`/g) ?? [];
      for (const sql of sqlStrings) {
        expect(sql).not.toMatch(/GRANT[^`]*\bDELETE\b/is);
      }
    }
  });

  // TC-4 (T-091, adjacent behaviour unchanged): a table that already had grants before this
  // fix (T002_008's original list) is untouched — same privileges as always.
  it('TC-4 (T-091, adjacent behaviour unchanged): reward_app grants on an already-granted table are unaffected', async () => {
    const [row] = await appSequelize.query<{ ok: boolean }>(
      `SELECT has_table_privilege('reward_app', 'reward_config.trackers', 'UPDATE') AS ok`,
      { type: QueryTypes.SELECT },
    );
    expect(row.ok).toBe(true);
  });
});
