/**
 * T-053 — shared fixture helpers for the performance suite.
 *
 * Two deliberate departures from the fixture style `test/campaigns/campaigns.e2e-spec.ts` and
 * friends use, both for the same reason: this suite needs **row count**, not workflow fidelity.
 *
 *  1. `bulkInsertCampaigns` writes `reward_config.tenant_campaigns` rows directly with a single
 *     `INSERT … SELECT generate_series(...)` statement rather than one `POST /campaigns` call per
 *     row. Ten thousand rows through the wizard's full validation/audit/notification path would
 *     dominate this suite's wall-clock time measuring campaign *authoring*, which is T-037's job,
 *     not this one's — TC-2/TC-6/TC-8 only need the **read** path (`GET /campaigns`) to see a
 *     realistic volume of rows already sitting in the table.
 *  2. `bulkInsertUsers` still goes through {@link insertPortalUser} (T-056's own fixture helper) —
 *     unlike campaigns, `portal_users.email` is ciphertext plus a blind index, both computed by the
 *     application's real `PortalUserEmailCrypto`, and a raw-SQL row would not be findable by
 *     `email_bidx` or decryptable later. It just does so in bounded-concurrency batches rather than
 *     one at a time, so 5,000 rows do not take 5,000 sequential round trips.
 *
 * Every row this file writes is prefixed and cleaned up by the suite that calls it — see each
 * spec's own `afterAll`.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import type { PortalRole } from '@/database/portal-models';
import { createMigrationConnection } from '@/database/migration-connection';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { insertPortalUser, deletePortalUsersByEmail } from '../../auth/support/portal-user-fixture';

/**
 * `ANALYZE` needs table-owner (or superuser) privilege — `reward_app` has neither (verified live:
 * `reward_app` gets `WARNING: permission denied to analyze "…", skipping it`, not a hard error, so
 * running it on the app connection would silently do nothing rather than fail loudly). The
 * migration role owns every table it created, so this borrows it for one statement and closes it
 * immediately — never held open, never used for anything but this.
 */
async function analyzeAsMigrationRole(statement: string): Promise<void> {
  const admin = createMigrationConnection();
  try {
    await admin.query(statement, { type: QueryTypes.RAW });
  } finally {
    await admin.close();
  }
}

export async function ensureCountry(
  sequelize: Sequelize,
  code: string,
  name: string,
): Promise<number> {
  const [existing] = await sequelize.query<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    { type: QueryTypes.SELECT, replacements: { code } },
  );
  if (existing !== undefined) {
    await sequelize.query(`UPDATE reward_config.countries SET status = 'active' WHERE id = :id`, {
      type: QueryTypes.UPDATE,
      replacements: { id: existing.id },
    });
    return existing.id;
  }
  const [created] = await sequelize.query<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, :name, 'Asia/Kuala_Lumpur', 'MYR', '+060', 'active') RETURNING id`,
    { type: QueryTypes.SELECT, replacements: { code, name } },
  );
  return created.id;
}

export async function ensureTenant(
  sequelize: Sequelize,
  code: string,
  countryId: number,
): Promise<number> {
  const [existing] = await sequelize.query<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { type: QueryTypes.SELECT, replacements: { code } },
  );
  if (existing !== undefined) {
    await sequelize.query(
      `UPDATE reward_config.tenants
          SET status = 'active', deleted_at = NULL, country_id = :countryId
        WHERE id = :id`,
      { type: QueryTypes.UPDATE, replacements: { id: existing.id, countryId } },
    );
    return existing.id;
  }
  const [created] = await sequelize.query<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { type: QueryTypes.SELECT, replacements: { code, countryId } },
  );
  return created.id;
}

/**
 * Writes `count` `tenant_campaigns` rows under `tenantId` in one round trip, cycling status
 * through `draft`/`active`/`completed` so a status-filtered query also sees realistic selectivity.
 * `campaign_code` is `<prefix>-<n>`, unique per tenant (`uq_tc_tenant_code`), which is also what
 * makes {@link deleteCampaignsByPrefix} exact.
 */
export async function bulkInsertCampaigns(
  sequelize: Sequelize,
  tenantId: number,
  count: number,
  prefix: string,
): Promise<void> {
  await sequelize.query(
    `INSERT INTO reward_config.tenant_campaigns
            (tenant_id, campaign_code, name, start_date, end_date, status, created_by,
             created_at, updated_at)
     SELECT :tenantId,
            :prefix || '-' || gs::text,
            :prefix || ' campaign ' || gs::text,
            now() - interval '10 days',
            now() + interval '90 days',
            (ARRAY['draft', 'active', 'completed'])[1 + (gs % 3)],
            'perf-seed',
            now(), now()
       FROM generate_series(1, :count) AS gs`,
    { type: QueryTypes.INSERT, replacements: { tenantId, prefix, count } },
  );
  // Postgres's planner works off statistics `ANALYZE` collects, not off the live row count —
  // autovacuum refreshes them eventually, but "eventually" is not "immediately after this bulk
  // insert returns". Without this, TC-2's/TC-7's latency and plan-shape assertions would risk
  // measuring a transient, cold-statistics plan rather than the one a real, long-lived table gets.
  await analyzeAsMigrationRole('ANALYZE reward_config.tenant_campaigns');
}

export async function deleteCampaignsByPrefix(sequelize: Sequelize, prefix: string): Promise<void> {
  await sequelize.query(
    `DELETE FROM reward_config.tenant_campaigns WHERE campaign_code LIKE :pattern`,
    { type: QueryTypes.DELETE, replacements: { pattern: `${prefix}-%` } },
  );
}

/** Simple fixed-concurrency batch runner — no new dependency for what `Promise.all` in chunks does. */
async function inBatches<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      await run(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

/**
 * Writes `count` `portal_users` rows through {@link insertPortalUser} — real ciphertext, real
 * blind index — in batches of `concurrency` at a time. Every row gets `must_change_password:
 * false` and `status: 'active'` so it is immediately usable by a query that filters on either.
 */
export async function bulkInsertUsers(
  sequelize: Sequelize,
  crypto: PortalUserEmailCrypto,
  scope: { countryId: number; tenantId: number },
  count: number,
  prefix: string,
  role: PortalRole = 'maker',
  concurrency = 25,
): Promise<number[]> {
  const ids: number[] = new Array(count);
  const indices = Array.from({ length: count }, (_, i) => i);
  await inBatches(indices, concurrency, async (i) => {
    ids[i] = await insertPortalUser(sequelize, crypto, {
      email: `${prefix}-${i}@example.invalid`,
      displayName: `${prefix} user ${i}`,
      role,
      countryId: scope.countryId,
      tenantId: scope.tenantId,
      merchantId: null,
      status: 'active',
      mustChangePassword: false,
    });
  });
  // See `bulkInsertCampaigns`'s identical call for why.
  await analyzeAsMigrationRole('ANALYZE reward_portal.portal_users');
  return ids;
}

export async function deleteUsersByPrefix(
  sequelize: Sequelize,
  crypto: PortalUserEmailCrypto,
  prefix: string,
  count: number,
): Promise<void> {
  const emails = Array.from({ length: count }, (_, i) => `${prefix}-${i}@example.invalid`);
  // `deletePortalUsersByEmail` batches on `email_bidx IN (...)`, which is fine at these sizes —
  // one statement, `count` bound parameters.
  await deletePortalUsersByEmail(sequelize, crypto, emails);
}

/**
 * Counts every query issued by `sequelize` while `work` runs, by substituting the connection's
 * `logging` hook for the duration of the call and restoring it afterwards (even on throw).
 *
 * This is the same connection the whole application shares (`SEQUELIZE` token), so it sees every
 * query a controller call issues — including ones from services `work`'s caller never touches
 * directly, which is the whole point of an N+1 check: the bug is never in the code you are
 * looking at.
 */
export async function countQueries<T>(
  sequelize: Sequelize,
  work: () => Promise<T>,
): Promise<{ result: T; queryCount: number }> {
  // `options.logging` is typed as `boolean | ((sql: string, timing?: number) => void)` by
  // @types/sequelize, not exposed as a mutable field on the public `Sequelize` type; this is the
  // same private-field reach every other suite in this repo avoids needing because none of them
  // counts queries. T-053 only.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
  const options = (sequelize as any).options;
  const original = options.logging;
  let queryCount = 0;
  options.logging = (...args: unknown[]) => {
    queryCount += 1;
    if (typeof original === 'function') original(...args);
  };
  try {
    const result = await work();
    return { result, queryCount };
  } finally {
    options.logging = original;
  }
}

/**
 * Captures the exact SQL text of every query issued while `work` runs — used to assert `LIMIT`/
 * `OFFSET` appear in the statement Postgres actually receives (TC-8), which a response-shape
 * assertion cannot prove: an endpoint that fetches every row and slices in memory returns an
 * identically-shaped page.
 */
export async function captureQueries<T>(
  sequelize: Sequelize,
  work: () => Promise<T>,
): Promise<{ result: T; statements: string[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see `countQueries` above.
  const options = (sequelize as any).options;
  const original = options.logging;
  const statements: string[] = [];
  options.logging = (sql: string, ...rest: unknown[]) => {
    statements.push(sql);
    if (typeof original === 'function') original(sql, ...rest);
  };
  try {
    const result = await work();
    return { result, statements };
  } finally {
    options.logging = original;
  }
}

/**
 * A hardware-calibrated baseline for TC-5 (`submit-and-login-latency.e2e-spec.ts`) — see that
 * spec's own comment for the full reasoning. Runs `argon2.verify` against the exact
 * `ARGON2_OPTIONS` the login route uses, in-process, isolated from HTTP/Nest/DB overhead, and
 * returns the median of `samples` runs in milliseconds.
 *
 * This exists because a fixed millisecond floor (the task file's own illustrative "> 100ms")
 * assumes a specific class of server hardware. Measured directly on the machine this suite was
 * developed and verified against (Apple M1 Pro, confirmed via `sysctl machdep.cpu.brand_string`):
 * the exact, unweakened OWASP baseline (`memoryCost: 19456, timeCost: 2, parallelism: 1`) verifies
 * in ~20ms, not "typically over 100ms" — Apple Silicon's memory bandwidth is unusually fast at
 * exactly this memory-hard workload size. A hardcoded ">100ms" assertion would therefore fail for
 * a correctly configured, genuinely un-weakened server on this CPU — a false positive, not a real
 * signal that anything was tampered with. See T-053's completion report for the raw benchmark.
 */
export async function benchmarkArgon2Verify(samples = 10): Promise<number> {
  // Not a real credential — a fixed probe string used only to size this one benchmark.
  const probe = 'T-053 argon2 calibration probe — not a real credential';
  const hash = await argon2.hash(probe, ARGON2_OPTIONS);
  const timings: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    await argon2.verify(hash, probe);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return timings[Math.floor(timings.length / 2)];
}

export interface LatencyStats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** Nearest-rank percentile over a copy of `samples` (sorted ascending), in milliseconds. */
export function percentiles(samples: readonly number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => {
    if (sorted.length === 0) return 0;
    const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, rank)];
  };
  return {
    count: sorted.length,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}
