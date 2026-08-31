/**
 * T-132 — the campaigns e2e suite's residue purge, against the **real** Postgres instance.
 *
 * ### What is being proved, and why it needs a database
 *
 * The defect this task fixes is a foreign-key violation: `purgeSuiteResidue` deleted every
 * tracker whose code began `TRK-` — a prefix `code-generator.ts` puts on *every* tracker the
 * portal generates, not a marker of this suite — so a row belonging to somebody else's campaign
 * made the delete hit `fk_tct_tracker`, throw inside `beforeAll`, and fail all 84 tests in
 * `campaigns.e2e-spec.ts`. T-124 reproduced that against two stale `QA_SCREENSHOT_*` campaigns.
 *
 * Only Postgres can judge that claim. A unit test over the SQL strings would assert that the
 * statement contains a `tenant_id IN (…)` clause, which is a restatement of the fix rather than
 * a test of it (AGENT-PROTOCOL §3): it would pass just as happily if the subquery selected the
 * wrong tenants. So this suite plants the exact shape of row that broke T-124 — a campaign
 * *outside* the purged suite that still references a `TRK-`/`CMP-` coded journey — runs the real
 * purge against the real database, and asserts both halves of the contract: the purge completes,
 * and the foreign rows are still there afterwards.
 *
 * ### Isolation
 *
 * Every fixture here is prefixed `T132E2E` (the suite being purged) or `T132OTHER` (the innocent
 * bystander), in two tenants this file creates and drops itself. It calls `purgeSuiteResidue`
 * with its **own** prefix, never `T037E2E`, so running it can never disturb a concurrent
 * `campaigns.e2e-spec.ts` run. Fixtures are written through `createMigrationConnection()` — the
 * same privileged role the purge itself uses — because there is no application role that may
 * delete from every table involved (see `campaigns.e2e-spec.ts`'s header).
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { createMigrationConnection } from '@/database/migration-connection';
import { purgeSuiteResidue } from './support/purge-suite-residue';

jest.setTimeout(120_000);

/** Stands in for `T037E2E`: the suite whose residue is being purged. */
const PREFIX = 'T132E2E';
/** Stands in for `QA_SCREENSHOT_*`: another suite's rows, which must survive untouched. */
const FOREIGN_PREFIX = 'T132OTHER';
const DISPLAY_NAME_PREFIX = 'T-132';

let db: Sequelize;
let countryId: number;
let suiteTenant: number;
let foreignTenant: number;

const createdTenants: number[] = [];

async function select<T extends object>(
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(statement, { type: QueryTypes.SELECT, replacements });
}

async function exec(statement: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(statement, { type: QueryTypes.RAW, replacements });
}

async function insertId(
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<number> {
  const [row] = await select<{ id: number }>(statement, replacements);
  return row.id;
}

async function ensureTenant(code: string): Promise<number> {
  const [existing] = await select<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
  const id = await insertId(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code, countryId },
  );
  createdTenants.push(id);
  return id;
}

interface Journey {
  readonly campaignId: number;
  readonly trackerId: number;
  readonly componentId: number;
}

let sequence = 0;

/**
 * A campaign with a tracker and a component linked to it, carrying exactly the generated codes
 * `code-generator.ts` produces (`TRK-<campaignId>-<suffix>` / `CMP-<campaignId>-<suffix>`) — which
 * is what makes a foreign journey indistinguishable from this suite's own by code alone.
 */
async function makeJourney(tenantId: number, campaignCodePrefix: string): Promise<Journey> {
  sequence += 1;
  const suffix = `${String(Date.now())}${String(sequence)}`.slice(-8);
  const campaignId = await insertId(
    `INSERT INTO reward_config.tenant_campaigns
       (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
     VALUES (:tenantId, :code, :code, now(), now() + interval '30 days', 'draft', 'T-132 fixture')
     RETURNING id`,
    { tenantId, code: `${campaignCodePrefix}_${suffix}` },
  );
  const trackerId = await insertId(
    `INSERT INTO reward_config.trackers (tenant_id, tracker_code, name, completion_logic, status)
     VALUES (:tenantId, :code, 'T-132 tracker', 'all', 'active') RETURNING id`,
    { tenantId, code: `TRK-${String(campaignId)}-${suffix}` },
  );
  const componentId = await insertId(
    `INSERT INTO reward_config.tracker_components (tenant_id, component_code, name, status)
     VALUES (:tenantId, :code, 'T-132 component', 'active') RETURNING id`,
    { tenantId, code: `CMP-${String(campaignId)}-${suffix}` },
  );
  await exec(
    `INSERT INTO reward_config.tenant_campaign_trackers (tenant_id, campaign_id, tracker_id, status)
     VALUES (:tenantId, :campaignId, :trackerId, 'active')`,
    { tenantId, campaignId, trackerId },
  );
  await exec(
    `INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id, sequence_order)
     VALUES (:trackerId, :componentId, 1)`,
    { trackerId, componentId },
  );
  return { campaignId, trackerId, componentId };
}

async function rowExists(table: string, id: number): Promise<boolean> {
  const rows = await select<{ id: number }>(`SELECT id FROM ${table} WHERE id = :id`, { id });
  return rows.length === 1;
}

async function journeyExists(journey: Journey): Promise<Record<string, boolean>> {
  const [links] = await select<{ tct: string; ttc: string }>(
    `SELECT
       (SELECT count(*) FROM reward_config.tenant_campaign_trackers
         WHERE campaign_id = :campaignId AND tracker_id = :trackerId) AS tct,
       (SELECT count(*) FROM reward_config.tracker_tracker_components
         WHERE tracker_id = :trackerId AND component_id = :componentId) AS ttc`,
    { ...journey },
  );
  return {
    campaign: await rowExists('reward_config.tenant_campaigns', journey.campaignId),
    tracker: await rowExists('reward_config.trackers', journey.trackerId),
    component: await rowExists('reward_config.tracker_components', journey.componentId),
    campaignTrackerLink: Number(links.tct) === 1,
    trackerComponentLink: Number(links.ttc) === 1,
  };
}

/** Removes a journey regardless of how far the purge got, so `afterAll` is order-independent. */
async function dropJourney(journey: Journey): Promise<void> {
  await exec('DELETE FROM reward_portal.agent_sessions WHERE campaign_id = :campaignId', {
    campaignId: journey.campaignId,
  });
  await exec('DELETE FROM reward_config.tracker_tracker_components WHERE tracker_id = :trackerId', {
    trackerId: journey.trackerId,
  });
  await exec('DELETE FROM reward_config.tenant_campaign_trackers WHERE tracker_id = :trackerId', {
    trackerId: journey.trackerId,
  });
  await exec('DELETE FROM reward_config.tenant_campaigns WHERE id = :campaignId', {
    campaignId: journey.campaignId,
  });
  await exec('DELETE FROM reward_config.tracker_components WHERE id = :componentId', {
    componentId: journey.componentId,
  });
  await exec('DELETE FROM reward_config.trackers WHERE id = :trackerId', {
    trackerId: journey.trackerId,
  });
}

const plantedJourneys: Journey[] = [];

async function plant(tenantId: number, campaignCodePrefix: string): Promise<Journey> {
  const journey = await makeJourney(tenantId, campaignCodePrefix);
  plantedJourneys.push(journey);
  return journey;
}

async function purge(): Promise<void> {
  await purgeSuiteResidue({ prefix: PREFIX, userDisplayNamePrefix: DISPLAY_NAME_PREFIX });
}

beforeAll(async () => {
  db = createMigrationConnection();
  const [country] = await select<{ id: number }>(
    'SELECT id FROM reward_config.countries ORDER BY id LIMIT 1',
  );
  if (country === undefined) throw new Error('no countries rows — is the schema seeded?');
  countryId = country.id;
  suiteTenant = await ensureTenant(`${PREFIX}_TENANT_A`);
  foreignTenant = await ensureTenant(`${FOREIGN_PREFIX}_TENANT`);
});

afterAll(async () => {
  if (db === undefined) return;
  try {
    for (const journey of plantedJourneys) await dropJourney(journey);
    for (const tenantId of createdTenants) {
      await exec('DELETE FROM reward_config.tenants WHERE id = :tenantId', { tenantId });
    }
  } finally {
    await db.close();
  }
});

describe('T-132 · purgeSuiteResidue is scoped to the suite that calls it', () => {
  it("TC-3: completes, and leaves another suite's TRK-/CMP- journey intact", async () => {
    // Exactly the shape T-124 hit: a campaign whose code does *not* match the purged prefix,
    // still referencing a tracker whose generated code does match `TRK-%`.
    const foreign = await plant(foreignTenant, FOREIGN_PREFIX);
    const own = await plant(suiteTenant, PREFIX);

    // Before the fix this rejects with
    // `update or delete on table "trackers" violates foreign key constraint "fk_tct_tracker"`.
    await expect(purge()).resolves.toBeUndefined();

    expect(await journeyExists(foreign)).toEqual({
      campaign: true,
      tracker: true,
      component: true,
      campaignTrackerLink: true,
      trackerComponentLink: true,
    });
    expect(await journeyExists(own)).toEqual({
      campaign: false,
      tracker: false,
      component: false,
      campaignTrackerLink: false,
      trackerComponentLink: false,
    });
  });

  it('TC-4a: still removes residue in its own tenant whose campaign row is already gone', async () => {
    const foreign = await plant(foreignTenant, FOREIGN_PREFIX);
    const orphan = await plant(suiteTenant, PREFIX);
    // A crashed run can leave the journey behind with no campaign row pointing at it.
    await exec('DELETE FROM reward_config.tenant_campaign_trackers WHERE tracker_id = :trackerId', {
      trackerId: orphan.trackerId,
    });
    await exec('DELETE FROM reward_config.tenant_campaigns WHERE id = :campaignId', {
      campaignId: orphan.campaignId,
    });

    await expect(purge()).resolves.toBeUndefined();

    expect(await rowExists('reward_config.trackers', orphan.trackerId)).toBe(false);
    expect(await rowExists('reward_config.tracker_components', orphan.componentId)).toBe(false);
    expect(await rowExists('reward_config.trackers', foreign.trackerId)).toBe(true);
    expect(await rowExists('reward_config.tracker_components', foreign.componentId)).toBe(true);
  });

  it('TC-4b: is a no-op when there is no residue, however many times it runs', async () => {
    const foreign = await plant(foreignTenant, FOREIGN_PREFIX);
    await expect(purge()).resolves.toBeUndefined();
    await expect(purge()).resolves.toBeUndefined();
    expect(await journeyExists(foreign)).toEqual({
      campaign: true,
      tracker: true,
      component: true,
      campaignTrackerLink: true,
      trackerComponentLink: true,
    });
  });

  it('TC-4d: clears an ON DELETE RESTRICT child of its own campaign (agent_sessions)', async () => {
    // The tracker defect in miniature, on the campaign side: one row in one of the nine tables
    // with a foreign key into `tenant_campaigns` is enough to make the whole purge — and with it
    // the suite's `beforeAll` — throw. `agent_sessions` (T-048) is `ON DELETE RESTRICT`.
    const [user] = await select<{ id: number }>(
      'SELECT id FROM reward_portal.portal_users ORDER BY id LIMIT 1',
    );
    if (user === undefined) throw new Error('no portal_users rows — cannot plant an agent session');
    const own = await plant(suiteTenant, PREFIX);
    await exec(
      `INSERT INTO reward_portal.agent_sessions
         (tenant_id, portal_user_id, state, campaign_id)
       VALUES (:tenantId, :userId, 'created', :campaignId)`,
      { tenantId: suiteTenant, userId: user.id, campaignId: own.campaignId },
    );

    await expect(purge()).resolves.toBeUndefined();

    expect(await rowExists('reward_config.tenant_campaigns', own.campaignId)).toBe(false);
    const [remaining] = await select<{ count: string }>(
      'SELECT count(*) AS count FROM reward_portal.agent_sessions WHERE campaign_id = :campaignId',
      { campaignId: own.campaignId },
    );
    expect(Number(remaining.count)).toBe(0);
  });

  it('TC-4c: refuses an empty prefix rather than matching every row in the database', async () => {
    const foreign = await plant(foreignTenant, FOREIGN_PREFIX);
    await expect(
      purgeSuiteResidue({ prefix: '', userDisplayNamePrefix: DISPLAY_NAME_PREFIX }),
    ).rejects.toThrow(/non-empty/);
    await expect(purgeSuiteResidue({ prefix: PREFIX, userDisplayNamePrefix: '' })).rejects.toThrow(
      /non-empty/,
    );
    expect(await rowExists('reward_config.trackers', foreign.trackerId)).toBe(true);
  });
});
