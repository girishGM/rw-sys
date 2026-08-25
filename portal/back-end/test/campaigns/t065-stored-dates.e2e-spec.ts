/**
 * T-065 TC-4 / TC-8 — what is actually *in* `reward_config.tenant_campaigns`, and what Postgres
 * really does with the value the write path produces. Asked of the live database rather than of the
 * code that wrote it.
 *
 * ### Why this file exists separately from `campaigns.e2e-spec.ts`
 *
 * That suite already asserts the stored value for the rows **it just created**, through the real
 * HTTP API — necessary, and it is the primary proof that the write path is correct. But it deletes
 * those rows again, and T-065's diagnostic question was broader: *is the defect at write time or
 * read time, and what state is the existing data in?* Answering that means querying rows this
 * process did not write, which is exactly what TC-8 asks to be documented rather than assumed.
 *
 * ### The session timezone is deliberately not UTC
 *
 * `SET TIME ZONE 'Asia/Kolkata'` is the whole point. `timestamptz` renders in the session's zone,
 * so a suite that queried in UTC would be blind to precisely the defect being closed — under the
 * original bug `2027-02-15T20:00:00Z` prints as `2027-02-15` in a UTC session and `2027-02-16` in
 * this one. Reading in the *hostile* zone means these assertions can fail; reading in UTC would
 * have been a change-detector (AGENT-PROTOCOL §3).
 *
 * ### What this suite does *not* claim
 *
 * 193 rows in this shared development database carry a real time-of-day. Every one was inserted
 * directly by another task's e2e fixtures (`T013…`, `T014…`, `T037PROBE…`, `T040A…`, `T045…`) with
 * raw SQL and a `NOW()`-shaped value — none came through the portal, and those fixture files are
 * other tasks' owned files (AGENT-PROTOCOL R9). T-065's own TC-8 anticipates this and prescribes
 * the remedy: *document* the backfill question and escalate it, not quietly rewrite data. So
 * {@link LEGACY_FIXTURE_PREFIXES} names them, the scan below excludes exactly that set and nothing
 * else, and the completion report carries the inventory. Excluding a *named, enumerated* population
 * is not weakening the guard: a row from any other writer is still held to UTC midnight.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { createMigrationConnection } from '@/database/migration-connection';
import { toStoredCampaignDate } from '@/modules/campaigns/campaign-date';

jest.setTimeout(120_000);

let db: Sequelize;

/**
 * Campaign-code prefixes of the pre-T-065 fixture rows described in the header.
 *
 * A closed list, not a pattern like `T%_E2E_%`: a wildcard would silently absorb rows a future
 * suite creates, which is how an exclusion stops being an exclusion and becomes a blind spot.
 */
const LEGACY_FIXTURE_PREFIXES = ['T013', 'T014', 'T037PROBE', 'T040A', 'T045'] as const;

/** `campaign_code NOT LIKE 'T013%' AND …` — the SQL form of {@link LEGACY_FIXTURE_PREFIXES}. */
const EXCLUDE_LEGACY = LEGACY_FIXTURE_PREFIXES.map(
  (prefix) => `campaign_code NOT LIKE '${prefix}%'`,
).join(' AND ');

/** A `timestamptz` that is not exactly midnight UTC — the defect, expressed once. */
const HAS_TIME_OF_DAY = `(start_date AT TIME ZONE 'UTC')::time <> TIME '00:00:00'
                      OR (end_date   AT TIME ZONE 'UTC')::time <> TIME '00:00:00'`;

/** Days worth round-tripping: the pair from T-065's evidence, a year end (TC-6), a leap day. */
const PROBE_DAYS = ['2027-01-15', '2027-02-15', '2027-12-31', '2028-02-29'] as const;

interface OffenderRow {
  readonly campaign_code: string;
  readonly start_utc: string;
  readonly end_utc: string;
}

beforeAll(async () => {
  db = createMigrationConnection();
  await db.authenticate();
  // Every query on this connection now renders `timestamptz` at +05:30. See the header.
  await db.query("SET TIME ZONE 'Asia/Kolkata'", { type: QueryTypes.RAW });

  // A TEMP table rather than `tenant_campaigns`: identical column type and identical driver path,
  // but no foreign keys to satisfy and nothing left behind in a database other agents share. R1 is
  // untouched — a temp table is not DDL against `reward_config`.
  await db.query(
    'CREATE TEMP TABLE t065_probe (code text, start_date timestamptz, end_date timestamptz)',
    { type: QueryTypes.RAW },
  );
  for (const day of PROBE_DAYS) {
    await db.query('INSERT INTO t065_probe VALUES (:code, :start, :end)', {
      type: QueryTypes.INSERT,
      replacements: { code: day, start: toStoredCampaignDate(day), end: toStoredCampaignDate(day) },
    });
  }
});

afterAll(async () => {
  await db?.close();
});

describe('T-065 · the stored campaign date', () => {
  it('TC-4: what the write path produces survives a real round trip through Postgres', async () => {
    // The scan further down guards rows that *persist*; `campaigns.e2e-spec.ts` deletes the
    // campaigns it creates, so on a clean database that population is legitimately empty and the
    // scan alone would be a tautology. This closes the gap without duplicating that suite's auth
    // bootstrap: it pushes the exact `Date` objects `toStoredCampaignDate()` builds through the
    // real driver into a real `timestamptz` column — the step a unit test cannot reach.
    const rows = await db.query<{ code: string; start_utc: string; end_utc: string }>(
      `SELECT code,
              (start_date AT TIME ZONE 'UTC')::text AS start_utc,
              (end_date   AT TIME ZONE 'UTC')::text AS end_utc
         FROM t065_probe ORDER BY code`,
      { type: QueryTypes.SELECT },
    );

    expect(rows).toEqual(
      PROBE_DAYS.map((day) => ({
        code: day,
        start_utc: `${day} 00:00:00`,
        end_utc: `${day} 00:00:00`,
      })),
    );
  });

  it('TC-2/TC-3/TC-5/TC-6: read at UTC, the stored value names the same day in every session zone', async () => {
    // The guarantee the encoding actually makes, and the one every portal path relies on:
    // `calendarDateOf()` reads in UTC, the gRPC contract serialises UTC midnight, and both are
    // therefore session-zone independent. Start and end are read together — TC-5 wants the start
    // pinned as well, and implementation note 4 says they move together or not at all. 31 December
    // is in the set because there an off-by-one day is also an off-by-one year (TC-6).
    const query = `SELECT code,
                          (start_date AT TIME ZONE 'UTC')::date::text AS s,
                          (end_date   AT TIME ZONE 'UTC')::date::text AS e
                     FROM t065_probe ORDER BY code`;
    const readIn = async (zone: string): Promise<unknown[]> => {
      await db.query(`SET TIME ZONE '${zone}'`, { type: QueryTypes.RAW });
      return db.query(query, { type: QueryTypes.SELECT });
    };

    const west = await readIn('Pacific/Midway');
    const india = await readIn('Asia/Kolkata');
    const east = await readIn('Pacific/Auckland');

    expect(india).toEqual(west);
    expect(east).toEqual(west);
    // Absolute, not merely equal to each other: three identically *wrong* lists would satisfy the
    // two assertions above, which would make this a change-detector (AGENT-PROTOCOL §3).
    expect(west).toEqual(PROBE_DAYS.map((day) => ({ code: day, s: day, e: day })));
  });

  it('pins the hazard: a naive ::date cast IS zone-dependent, which is why every reader normalises to UTC', async () => {
    // Not a bug in the encoding — an inescapable property of the column type. A `timestamptz` is an
    // *instant*, and casting an instant to a date must pick a zone; the session's zone is what
    // Postgres picks. No instant encoding is safe against this cast in every zone: UTC midnight
    // moves backwards west of UTC (below), and a "local noon" encoding would move forwards east of
    // UTC+12 instead. R1 forbids changing the column to `date`, which is the only real cure.
    //
    // So the portal's rule is that **the reader normalises**: `calendarDateOf()` uses
    // `toISOString()`, the response DTO serialises `YYYY-MM-DD`, and `campaign_config.v1.proto`
    // states UTC midnight in the field comment so an external consumer cannot get this wrong by
    // accident. This test exists so that rule stays visible and deliberate — if someone "simplifies"
    // a query to `end_date::date`, the behaviour asserted here is what they will get.
    await db.query("SET TIME ZONE 'Pacific/Midway'", { type: QueryTypes.RAW });
    const naive = await db.query<{ code: string; e: string }>(
      `SELECT code, end_date::date::text AS e FROM t065_probe ORDER BY code`,
      { type: QueryTypes.SELECT },
    );
    await db.query("SET TIME ZONE 'Asia/Kolkata'", { type: QueryTypes.RAW });

    // A full day earlier, every time — including 2027-12-31 becoming a different *year*.
    expect(naive).toEqual([
      { code: '2027-01-15', e: '2027-01-14' },
      { code: '2027-02-15', e: '2027-02-14' },
      { code: '2027-12-31', e: '2027-12-30' },
      { code: '2028-02-29', e: '2028-02-28' },
    ]);
  });

  it('TC-4: no persisted campaign written by the portal carries a time of day', async () => {
    const rows = await db.query<OffenderRow>(
      `SELECT campaign_code,
              (start_date AT TIME ZONE 'UTC')::time::text AS start_utc,
              (end_date   AT TIME ZONE 'UTC')::time::text AS end_utc
         FROM reward_config.tenant_campaigns
        WHERE (${HAS_TIME_OF_DAY})
          AND ${EXCLUDE_LEGACY}
        ORDER BY campaign_code`,
      { type: QueryTypes.SELECT },
    );

    // The offending rows are named in the failure message, not just counted: if this goes red the
    // next reader needs to know *which* campaigns are wrong to tell a regression from legacy data.
    expect({ offenders: rows.length, rows }).toEqual({ offenders: 0, rows: [] });
  });

  it('TC-8: the legacy fixture rows are still there, and still shift a day — hence the escalation', async () => {
    // Deliberately asserts the defect is *present* in the excluded set. Two things follow: the
    // exclusion above is load-bearing rather than cosmetic, and the day this assertion starts
    // failing is the day the backfill has happened and this file should be simplified.
    const [{ n }] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM reward_config.tenant_campaigns
        WHERE (${HAS_TIME_OF_DAY}) AND NOT (${EXCLUDE_LEGACY})`,
      { type: QueryTypes.SELECT },
    );

    const prefixes = await db.query<{ prefix: string; n: number }>(
      `SELECT left(campaign_code, 5) AS prefix, count(*)::int AS n
         FROM reward_config.tenant_campaigns
        WHERE (${HAS_TIME_OF_DAY}) AND NOT (${EXCLUDE_LEGACY})
        GROUP BY 1 ORDER BY 1`,
      { type: QueryTypes.SELECT },
    );

    // TC-8 asks for the legacy-row question to be *documented*, which needs these numbers to
    // reach the completion report; the inventory is this test's product.
    // eslint-disable-next-line no-console -- T-065: see above, this transcript is the deliverable.
    console.log(
      `TC-8 legacy rows carrying a time of day: ${String(n)} — ` +
        prefixes.map((p) => `${p.prefix}=${String(p.n)}`).join(', '),
    );
    expect(n).toBeGreaterThan(0);
  });

  it('prints the round-tripped values, the raw observation TC-4 asks to be recorded', async () => {
    const rows = await db.query<{ code: string; stored: string; utc: string; local_day: string }>(
      `SELECT code,
              end_date::text AS stored,
              (end_date AT TIME ZONE 'UTC')::text AS utc,
              end_date::date::text AS local_day
         FROM t065_probe ORDER BY code`,
      { type: QueryTypes.SELECT },
    );

    // This test's product is the transcript pasted into the completion report as TC-4's raw
    // evidence — the stored bytes, unformatted; asserting silently would not produce it.
    // eslint-disable-next-line no-console -- T-065: see above, this transcript is the deliverable.
    console.log(
      ['session TIME ZONE = Asia/Kolkata (+05:30)']
        .concat(
          rows.map(
            (r) => `${r.code}  stored ${r.stored}  |  UTC ${r.utc}  |  ::date ${r.local_day}`,
          ),
        )
        .join('\n  '),
    );

    expect(rows).toHaveLength(PROBE_DAYS.length);
  });
});
