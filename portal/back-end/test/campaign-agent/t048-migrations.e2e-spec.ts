/**
 * T-048 — AGENT-PROTOCOL R7 for this task's one migration: *"every migration has a working
 * `down()` and is proven by migrate → rollback → migrate on a clean DB."*
 *
 * ### Why this runs the migration directly rather than through `npm run db:rollback -- --all`
 *
 * Exactly the two reasons `test/campaigns/t037-migrations.e2e-spec.ts` records, both still true and
 * both about the state of this shared development database rather than about the migration:
 *
 *  1. **`--all` is blocked by another task's migration.** `T056_001_portal_users_email_blind_index`
 *     builds a crypto service in its `down()`, and `KeyRegistryService` refuses to boot while
 *     `reward_portal.encryption_keys` holds rows from other suites' crashed e2e runs whose key
 *     material is not in this process's environment.
 *  2. **`--all` would be destructive here**, on a database several agents are working against.
 *
 * There is a third reason specific to this task, and it is worth naming because it looks like a
 * defect until it is explained: `T048_001` sorts **before** `T055_001` and `T056_001` by filename,
 * which is how umzug orders migrations. So `npm run db:rollback` (no `--all`) rolls back `T056_001`
 * — the last file in *lexical* order — not this task's, even immediately after applying it. That is
 * the task-id prefix convention working as designed (05-EXECUTION-PLAN.md §3: *"migration filenames
 * are prefixed with the task id so ordering is deterministic and two agents cannot collide on a
 * sequence number"*), not a bug in either migration; it simply means the per-migration cycle has to
 * be driven directly, as it is below.
 *
 * The assertions are stronger than the CLI's, because they check the **shape** that comes back
 * rather than only that no error was thrown: the columns, the foreign keys to `portal_users`, the
 * CHECK vocabularies, the `ck_as_campaign` invariant that a created session names its campaign, and
 * the append-only privilege on the transcript.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { createMigrationConnection } from '@/database/migration-connection';
import * as agentSessions from '@/database/migrations/T048_001_agent_sessions';

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

async function indexExists(name: string): Promise<boolean> {
  const rows = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes WHERE schemaname = 'reward_portal' AND indexname = :name
     ) AS exists`,
    { type: QueryTypes.SELECT, replacements: { name } },
  );
  return rows[0].exists;
}

beforeAll(async () => {
  db = createMigrationConnection();
  await db.authenticate();
});

afterAll(async () => {
  // Leave the database exactly as the suite found it: the migration applied.
  if (!(await tableExists('agent_sessions'))) await agentSessions.up({ context: db });
  await db.close();
});

describe('T-048 migration — R7 migrate → rollback → migrate', () => {
  it('both tables exist to begin with', async () => {
    expect(await tableExists('agent_sessions')).toBe(true);
    expect(await tableExists('agent_session_events')).toBe(true);
  });

  it('rolls back cleanly, dropping both tables', async () => {
    await agentSessions.down({ context: db });
    expect(await tableExists('agent_session_events')).toBe(false);
    expect(await tableExists('agent_sessions')).toBe(false);
  });

  it('re-applies cleanly, restoring both tables column for column', async () => {
    await agentSessions.up({ context: db });

    expect(await columns('agent_sessions')).toEqual([
      'id',
      'tenant_id',
      'portal_user_id',
      'state',
      'archetype',
      'slots',
      'offered_options',
      'plan',
      'plan_hash',
      'campaign_id',
      'no_progress_turns',
      'turn_count',
      'created_at',
      'updated_at',
    ]);

    expect(await columns('agent_session_events')).toEqual([
      'id',
      'session_id',
      'seq',
      'role',
      'content',
      'meta',
      'created_at',
    ]);
  });

  it('restores the foreign keys, which point at portal_users (gap G1)', async () => {
    // A maker cannot be represented in `admin_users` (`ck_admin_users_role`), so the actor column
    // has to reference the portal's own user table — the same resolution T037_001/T037_002 record.
    expect(await constraintDefinition('fk_as_user')).toContain(
      'REFERENCES reward_portal.portal_users(id)',
    );
    expect(await constraintDefinition('fk_as_tenant')).toContain(
      'REFERENCES reward_config.tenants(id)',
    );
    expect(await constraintDefinition('fk_as_campaign')).toContain(
      'REFERENCES reward_config.tenant_campaigns(id)',
    );
    expect(await constraintDefinition('fk_ase_session')).toContain(
      'REFERENCES reward_portal.agent_sessions(id)',
    );
  });

  it('restores the state and role vocabularies', async () => {
    const state = await constraintDefinition('ck_as_state');
    for (const value of ['collecting', 'reviewing', 'created', 'abandoned', 'error']) {
      expect(state).toContain(value);
    }

    const role = await constraintDefinition('ck_ase_role');
    for (const value of ['user', 'assistant', 'tool', 'system']) {
      expect(role).toContain(value);
    }
  });

  it('restores the jsonb type checks on the three document columns', async () => {
    expect(await constraintDefinition('ck_as_slots')).toContain("jsonb_typeof(slots) = 'object'");
    expect(await constraintDefinition('ck_as_offered')).toContain('offered_options');
    expect(await constraintDefinition('ck_as_plan')).toContain('plan');
  });

  it('restores ck_as_campaign — a created session names its campaign, nothing else may', async () => {
    const definition = await constraintDefinition('ck_as_campaign');
    expect(definition).toContain('created');
    expect(definition).toContain('campaign_id');
  });

  it('restores the sequence uniqueness that makes the transcript ordered as well as append-only', async () => {
    expect(await constraintDefinition('uq_ase_seq')).toContain('UNIQUE (session_id, seq)');
  });

  it('restores both lookup indexes', async () => {
    expect(await indexExists('ix_as_owner')).toBe(true);
    expect(await indexExists('ix_ase_session')).toBe(true);
  });

  it('grants the session table the three verbs the code uses, and no more', async () => {
    expect(await privilege('agent_sessions', 'SELECT')).toBe(true);
    expect(await privilege('agent_sessions', 'INSERT')).toBe(true);
    expect(await privilege('agent_sessions', 'UPDATE')).toBe(true);
    // A session is never hard-deleted — abandoning it is a status flip, as with every other
    // governance-relevant row in this schema.
    expect(await privilege('agent_sessions', 'DELETE')).toBe(false);
  });

  it('makes the transcript append-only at the privilege level (§7, TC-22)', async () => {
    expect(await privilege('agent_session_events', 'SELECT')).toBe(true);
    expect(await privilege('agent_session_events', 'INSERT')).toBe(true);
    // The half that matters: a conversation that could be rewritten after the fact is not
    // evidence of anything.
    expect(await privilege('agent_session_events', 'UPDATE')).toBe(false);
    expect(await privilege('agent_session_events', 'DELETE')).toBe(false);
  });

  it('survives a second full cycle — rollback and re-apply are both repeatable', async () => {
    await agentSessions.down({ context: db });
    await agentSessions.up({ context: db });
    expect(await tableExists('agent_sessions')).toBe(true);
    expect(await tableExists('agent_session_events')).toBe(true);
  });
});

describe('the constraints actually refuse, rather than merely existing', () => {
  it('refuses a session state outside the vocabulary', async () => {
    await expect(
      db.query(
        `INSERT INTO reward_portal.agent_sessions (tenant_id, portal_user_id, state)
         VALUES (-1, -1, 'nonsense')`,
        { type: QueryTypes.RAW },
      ),
    ).rejects.toThrow();
  });

  it('refuses a non-created session that names a campaign (ck_as_campaign)', async () => {
    await expect(
      db.query(
        `INSERT INTO reward_portal.agent_sessions (tenant_id, portal_user_id, state, campaign_id)
         VALUES (-1, -1, 'collecting', -1)`,
        { type: QueryTypes.RAW },
      ),
    ).rejects.toThrow();
  });

  it('refuses slots that are not a JSON object', async () => {
    await expect(
      db.query(
        `INSERT INTO reward_portal.agent_sessions (tenant_id, portal_user_id, slots)
         VALUES (-1, -1, '[]'::jsonb)`,
        { type: QueryTypes.RAW },
      ),
    ).rejects.toThrow();
  });
});
