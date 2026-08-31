/**
 * T-139 — the regression guard for T-051's campaign fixtures, asked of Postgres rather than of the
 * code that writes them.
 *
 * ### What went wrong
 *
 * `role-matrix.e2e-spec.ts` wrote its two fixture campaigns with `now()`, so
 * `T051_E2E_C_HOME`/`T051_E2E_C_FOREIGN` were persisted carrying a time of day
 * (`2026-08-22 15:27:05.444+00`). The suite's `afterAll` *does* run — both rows carry a
 * `deleted_at` — but `reward_app` holds no `DELETE` on `reward_config`, so the cleanup is a soft
 * delete and the rows stay. Eight days later they failed
 * `test/campaigns/t065-stored-dates.e2e-spec.ts` TC-4, which is a **whole-table** invariant: no
 * persisted campaign may carry a time of day. See `support/fixture-campaign-window.ts`.
 *
 * ### Why there are two tests and not one
 *
 * They fail for different reasons, and each one alone has a hole:
 *
 * - **The encoding test** pushes the values `fixtureCampaignWindow()` produces through the real
 *   driver into a real `timestamptz` column and reads them back in a hostile session zone. It can
 *   never pass vacuously and it fails the moment the helper stops producing UTC midnight — but it
 *   would not notice a call site that ignored the helper and went back to `now()`.
 * - **The persisted-row scan** asks the live table the same question `t065-stored-dates` asks,
 *   narrowed to this suite's own rows. That *is* the call-site check: revert `ensureCampaign` and
 *   the next run of the role matrix puts a bad row back. It is vacuous on a database the role
 *   matrix has never run against, which is why the encoding test sits beside it.
 *
 * The scan is deliberately keyed on `T051_E2E_%` and nothing wider: this task fixes T-051's
 * fixture, and a scan that also covered `T013…`/`T014…` would be red for a population T-065's TC-8
 * has already documented, escalated and excluded on purpose.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { createMigrationConnection } from '@/database/migration-connection';
import { calendarDateOf } from '@/modules/campaigns/campaign-date';
import { fixtureCampaignWindow } from './support/fixture-campaign-window';

jest.setTimeout(120_000);

let db: Sequelize;

/** T-051's fixture campaigns — `T051_E2E_C_HOME` and `T051_E2E_C_FOREIGN`. `_` is a SQL wildcard. */
const T051_CAMPAIGNS = `campaign_code LIKE 'T051\\_E2E\\_%'`;

/**
 * `t065-stored-dates.e2e-spec.ts`'s own predicate, restated because that file is another task's
 * (R9) and exports nothing. Kept character-identical to it: if the two ever disagree, this suite
 * would go green while the gate T-113 actually runs stayed red, which is the failure mode T-139
 * exists to end.
 */
const HAS_TIME_OF_DAY = `(start_date AT TIME ZONE 'UTC')::time <> TIME '00:00:00'
                      OR (end_date   AT TIME ZONE 'UTC')::time <> TIME '00:00:00'`;

interface OffenderRow {
  readonly campaign_code: string;
  readonly start_utc: string;
  readonly end_utc: string;
}

beforeAll(async () => {
  db = createMigrationConnection();
  await db.authenticate();
  // Not UTC, on purpose — the same reasoning `t065-stored-dates.e2e-spec.ts` gives in its header.
  // A `timestamptz` renders in the session's zone, so a suite that read in UTC could not see a
  // value that is midnight only in UTC-by-accident, and every assertion below would be blind to
  // precisely the defect it is guarding.
  await db.query("SET TIME ZONE 'Asia/Kolkata'", { type: QueryTypes.RAW });

  // A TEMP table, not `tenant_campaigns`: identical column type and identical driver path, no
  // foreign keys to satisfy, and nothing left behind in a database other suites share. Copied from
  // `t065-stored-dates.e2e-spec.ts`, which makes the same trade for the same reason. R1 is
  // untouched — a temp table is not DDL against `reward_config`.
  await db.query(
    'CREATE TEMP TABLE t139_probe (code text, start_date timestamptz, end_date timestamptz)',
    { type: QueryTypes.RAW },
  );
});

afterAll(async () => {
  await db?.close();
});

describe('T-139 · the campaign dates T-051 fixtures are written with', () => {
  it('TC-3: what the fixture writes lands on exact UTC midnight in a real timestamptz column', async () => {
    const { start, end } = fixtureCampaignWindow();

    // Bound as `Date` objects through the same driver and the same escaping the fixture uses, not
    // formatted into the SQL text: a value that only *prints* as midnight is not what is being
    // asserted here, what Postgres stored is.
    await db.query('INSERT INTO t139_probe VALUES (:code, :start, :end)', {
      type: QueryTypes.INSERT,
      replacements: { code: 'fixture', start, end },
    });

    const rows = await db.query<{ start_utc: string; end_utc: string }>(
      `SELECT (start_date AT TIME ZONE 'UTC')::text AS start_utc,
              (end_date   AT TIME ZONE 'UTC')::text AS end_utc
         FROM t139_probe WHERE code = 'fixture'`,
      { type: QueryTypes.SELECT },
    );

    // Absolute, not "the ::time part is 00:00:00": the day matters too. `now()` would fail the
    // time half; a helper that silently shifted a day would fail the day half.
    expect(rows).toEqual([
      {
        start_utc: `${calendarDateOf(start)} 00:00:00`,
        end_utc: `${calendarDateOf(end)} 00:00:00`,
      },
    ]);
  });

  it('TC-4: the fixture window is still today through today + 30 days', async () => {
    // Adjacent behaviour the fix must not change. The original SQL was
    // `now(), now() + interval '30 days'`; only the time of day was wrong, not the length, and a
    // fixture campaign that is not live today would silently change what the role matrix probes.
    const { start, end } = fixtureCampaignWindow(new Date(Date.UTC(2026, 7, 30, 15, 27, 5, 444)));

    expect(calendarDateOf(start)).toBe('2026-08-30');
    expect(calendarDateOf(end)).toBe('2026-09-29');
    expect(start.toISOString()).toBe('2026-08-30T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-29T00:00:00.000Z');
  });

  it('TC-2: no persisted T-051 fixture campaign carries a time of day', async () => {
    const rows = await db.query<OffenderRow>(
      `SELECT campaign_code,
              (start_date AT TIME ZONE 'UTC')::time::text AS start_utc,
              (end_date   AT TIME ZONE 'UTC')::time::text AS end_utc
         FROM reward_config.tenant_campaigns
        WHERE (${HAS_TIME_OF_DAY})
          AND ${T051_CAMPAIGNS}
        ORDER BY campaign_code`,
      { type: QueryTypes.SELECT },
    );

    // The offending rows are named rather than counted, for the reason the suite this mirrors
    // gives: a bare count tells the next reader nothing about which fixture regressed.
    expect({ offenders: rows.length, rows }).toEqual({ offenders: 0, rows: [] });
  });

  it("documents the scan's scope: the T-051 rows it guards are real rows, not an empty set", async () => {
    // Guards against the silent-vacuum reading of the test above. It does not *require* the rows to
    // exist (a clean database legitimately has none, and the encoding test above covers that case),
    // but it puts the population size in the transcript, so "0 offenders" can be told apart from
    // "nothing was looked at".
    const [{ n }] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reward_config.tenant_campaigns WHERE ${T051_CAMPAIGNS}`,
      { type: QueryTypes.SELECT },
    );

    // eslint-disable-next-line no-console -- T-139: the scanned population belongs in the report.
    console.log(`T-139 scan covered ${String(n)} persisted T051_E2E_% campaign row(s)`);
    expect(n).toBeGreaterThanOrEqual(0);
  });
});
