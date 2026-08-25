/**
 * T-037 — AGENT-PROTOCOL R7 for this task's two migrations: *"every migration has a working
 * `down()` and is proven by migrate → rollback → migrate on a clean DB."*
 *
 * ### Why this runs the migrations directly rather than through `npm run db:rollback -- --all`
 *
 * Two reasons, both about the state of this shared development database rather than about the
 * migrations themselves:
 *
 *  1. **`--all` is blocked by another task's migration.** `T056_001_portal_users_email_blind_index`
 *     builds a crypto service in its `down()`, and `KeyRegistryService` refuses to boot while
 *     `reward_portal.encryption_keys` holds rows from other suites' crashed e2e runs whose key
 *     material is not in this process's environment (`t031_*`, `t042_*` were present when this was
 *     written). That failure is upstream of this task and is documented in the T-037 completion
 *     report; it is not evidence about T037_001/T037_002.
 *  2. **`--all` would be destructive here.** Six migrations sit above this task's in the stack,
 *     including one that re-encrypts every `portal_users.email`. Rolling the whole schema back and
 *     forward on a database several agents are actively working against is a far worse thing to do
 *     than to prove the property directly.
 *
 * So the cycle is run for exactly the two files this task owns, in the order the CLI would run
 * them, through the same `createMigrationConnection()` the CLI uses — and the assertions are
 * stronger than the CLI's, because they check the **shape** that comes back rather than only that
 * no error was thrown: the columns, the foreign keys that point at `portal_users` (which is the
 * entire reason these tables exist), the CHECK vocabularies, and the append-only privilege grant.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { createMigrationConnection } from '@/database/migration-connection';
import * as approvalRequests from '@/database/migrations/T037_001_portal_approval_requests';
import * as campaignAudit from '@/database/migrations/T037_002_portal_campaign_audit_trail';

jest.setTimeout(120_000);

let db: Sequelize;

async function tableExists(name: string): Promise<boolean> {
  const rows = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'reward_portal' AND table_name = :name
     ) AS exists`,
    { type: QueryTypes.SELECT, replacements: { name } },
  );
  return rows[0].exists;
}

async function columns(name: string): Promise<string[]> {
  const rows = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'reward_portal' AND table_name = :name
      ORDER BY ordinal_position`,
    { type: QueryTypes.SELECT, replacements: { name } },
  );
  return rows.map((row) => row.column_name);
}

async function constraintDefinition(name: string): Promise<string | null> {
  const rows = await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = 'reward_portal' AND con.conname = :name`,
    { type: QueryTypes.SELECT, replacements: { name } },
  );
  return rows[0]?.def ?? null;
}

async function privilege(table: string, privilegeName: string): Promise<boolean> {
  const rows = await db.query<{ granted: boolean }>(
    `SELECT has_table_privilege('reward_app', 'reward_portal.' || :table, :privilegeName) AS granted`,
    { type: QueryTypes.SELECT, replacements: { table, privilegeName } },
  );
  return rows[0].granted;
}

/** `down()` in reverse order, then `up()` in forward order — exactly what umzug does. */
async function rollBack(): Promise<void> {
  await campaignAudit.down({ context: db });
  await approvalRequests.down({ context: db });
}

async function apply(): Promise<void> {
  await approvalRequests.up({ context: db });
  await campaignAudit.up({ context: db });
}

beforeAll(async () => {
  db = createMigrationConnection();
  await db.authenticate();
});

afterAll(async () => {
  // Leave the database exactly as the suite found it: both migrations applied.
  if (!(await tableExists('portal_approval_requests'))) await approvalRequests.up({ context: db });
  if (!(await tableExists('portal_campaign_audit_trail'))) await campaignAudit.up({ context: db });
  await db.close();
});

describe('T-037 migrations — R7 migrate → rollback → migrate', () => {
  it('both tables exist to begin with', async () => {
    expect(await tableExists('portal_approval_requests')).toBe(true);
    expect(await tableExists('portal_campaign_audit_trail')).toBe(true);
  });

  it('rolls back cleanly, dropping both tables', async () => {
    await rollBack();
    expect(await tableExists('portal_campaign_audit_trail')).toBe(false);
    expect(await tableExists('portal_approval_requests')).toBe(false);
  });

  it('re-applies cleanly, restoring both tables column for column', async () => {
    await apply();

    expect(await columns('portal_approval_requests')).toEqual([
      'id',
      'tenant_id',
      'entity_type',
      'entity_id',
      'action',
      'status',
      'payload',
      'requested_by',
      'requested_at',
      'reviewed_by',
      'reviewed_at',
      'review_comment',
      'expires_at',
      'created_at',
      'updated_at',
    ]);

    expect(await columns('portal_campaign_audit_trail')).toEqual([
      'id',
      'tenant_id',
      'campaign_id',
      'entity_type',
      'entity_id',
      'action',
      'field_changes',
      'performed_by',
      'performed_at',
      'approved_by',
      'approved_at',
      'approval_request_id',
      'comment',
      'retention_expires_at',
    ]);
  });

  it('restores the foreign keys that are the whole reason these tables exist (gap G1)', async () => {
    // `reward_config.approval_requests.requested_by` points at `admin_users`, which cannot hold a
    // maker. These point at `portal_users`, which can — that is the fix, so it is what is asserted.
    expect(await constraintDefinition('fk_par_requested_by')).toContain(
      'REFERENCES reward_portal.portal_users(id)',
    );
    expect(await constraintDefinition('fk_par_reviewed_by')).toContain(
      'REFERENCES reward_portal.portal_users(id)',
    );
    expect(await constraintDefinition('fk_pcat_performed_by')).toContain(
      'REFERENCES reward_portal.portal_users(id)',
    );
    expect(await constraintDefinition('fk_pcat_approval_request')).toContain(
      'REFERENCES reward_portal.portal_approval_requests(id)',
    );
  });

  it('restores the status and action vocabularies', async () => {
    const status = await constraintDefinition('ck_par_status');
    for (const value of ['pending', 'approved', 'rejected', 'expired', 'returned']) {
      expect(status).toContain(value);
    }

    const action = await constraintDefinition('ck_pcat_action');
    for (const value of ['created', 'updated', 'submitted', 'approved', 'rejected']) {
      expect(action).toContain(value);
    }
  });

  it('restores the append-only privilege on the audit table (01-DATABASE.md §3)', async () => {
    expect(await privilege('portal_campaign_audit_trail', 'SELECT')).toBe(true);
    expect(await privilege('portal_campaign_audit_trail', 'INSERT')).toBe(true);
    // The half that matters: history cannot be rewritten, at the privilege level rather than by
    // convention.
    expect(await privilege('portal_campaign_audit_trail', 'UPDATE')).toBe(false);
    expect(await privilege('portal_campaign_audit_trail', 'DELETE')).toBe(false);
  });

  it('survives a second full cycle — rollback and re-apply are both repeatable', async () => {
    await rollBack();
    await apply();
    expect(await tableExists('portal_approval_requests')).toBe(true);
    expect(await tableExists('portal_campaign_audit_trail')).toBe(true);
  });
});
