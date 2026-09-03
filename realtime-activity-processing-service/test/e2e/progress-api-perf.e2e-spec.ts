/**
 * T-RAP-040. TC-4 + verification step 2: query latency and query plan against a seeded dataset of
 * 10,000+ `customer_tracker_component_progress` rows, all under one tenant (so the index actually
 * has to discriminate, not just "the whole table is one customer's data"). Kept in its own file so
 * a normal `npm test` run isn't slowed by this seed on every invocation of the rest of the suite —
 * `npm test -- progress-api` still picks this file up (it matches the same substring).
 *
 * Exercises `ProgressRepository` directly (no HTTP/Nest layer) so both the latency measurement and
 * the `EXPLAIN ANALYZE` reflect the actual SQL this module issues, not Express/Nest overhead on
 * top of it — the Objective's own "fast to process ... not taking much time to show the progress"
 * claim is about the query design (indexed lookup vs. an `activity_logs` aggregation), which this
 * isolates directly.
 */
import 'reflect-metadata';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ProgressRepository } from '@/modules/progress-api/progress.repository';
import { buildTestSequelize, cleanupTenant } from './progress-api-test-helpers';

const TENANT_ID = 970_000 + Math.floor(Math.random() * 20_000);
const TARGET_CUSTOMER_HASH = 'f'.repeat(64);
const TARGET_CAMPAIGN = 'CAMP_PERF_TARGET';
const NOISE_ROW_COUNT = 10_000;

describe('Customer progress API — query performance (real Postgres, rap_app role)', () => {
  let sequelize: Sequelize;
  let repository: ProgressRepository;

  beforeAll(async () => {
    sequelize = buildTestSequelize();
    repository = new ProgressRepository(sequelize);

    // 10,000+ noise rows spread across many customers/campaigns under the SAME tenant — proves
    // the index discriminates on (tenant_id, customer_id_hash, campaign_code), not merely on a
    // small table. `generate_series` keeps this a single fast round trip instead of 10,000.
    await sequelize.query(
      `INSERT INTO realtime_activity_processing.customer_tracker_component_progress
         (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
          current_count, required_count, completion_cycle, is_completed)
       SELECT :tenantId,
              md5('noise-customer-' || gs),
              'CAMP_NOISE_' || (gs % 50),
              'TRK_' || (gs % 5),
              'COMP_' || (gs % 3),
              1, 5, 1, false
         FROM generate_series(1, :noiseRowCount) AS gs`,
      {
        type: QueryTypes.INSERT,
        replacements: { tenantId: TENANT_ID, noiseRowCount: NOISE_ROW_COUNT },
      },
    );

    // The one customer+campaign this test actually queries for, seeded last so it is not
    // guaranteed to be anywhere favorable (start/middle/end) in physical table order.
    for (let i = 0; i < 5; i += 1) {
      await sequelize.query(
        `INSERT INTO realtime_activity_processing.customer_tracker_component_progress
           (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
            current_count, required_count, completion_cycle, is_completed)
         VALUES (:tenantId, :customerIdHash, :campaignCode, :trackerCode, :componentCode, 1, 3, 1, false)`,
        {
          type: QueryTypes.INSERT,
          replacements: {
            tenantId: TENANT_ID,
            customerIdHash: TARGET_CUSTOMER_HASH,
            campaignCode: TARGET_CAMPAIGN,
            trackerCode: `TRK_TARGET_${i}`,
            componentCode: `COMP_TARGET_${i}`,
          },
        },
      );
    }

    // Fresh planner statistics — a bulk `INSERT` doesn't trigger autovacuum's own analyze
    // immediately, and this test's whole point is the planner's real, cost-based choice, not
    // whatever stale-statistics plan happens to be cached from an earlier test file's smaller
    // dataset.
    await sequelize.query(
      'ANALYZE realtime_activity_processing.customer_tracker_component_progress',
      { type: QueryTypes.RAW },
    );
  }, 60_000);

  afterAll(async () => {
    await cleanupTenant(sequelize, TENANT_ID);
    await sequelize.close();
  });

  it(`TC-4: resolves one customer's progress out of ${NOISE_ROW_COUNT}+ rows in bounded, low time`, async () => {
    const iterations = 5;
    const timingsMs: number[] = [];
    let rows: Awaited<ReturnType<ProgressRepository['findLatestComponentProgress']>> = [];

    for (let i = 0; i < iterations; i += 1) {
      const startedAt = performance.now();
      rows = await repository.findLatestComponentProgress(
        TENANT_ID,
        TARGET_CUSTOMER_HASH,
        TARGET_CAMPAIGN,
      );
      timingsMs.push(performance.now() - startedAt);
    }

    expect(rows).toHaveLength(5);

    const meanMs = timingsMs.reduce((sum, t) => sum + t, 0) / timingsMs.length;
    // TC-4 explicitly requires "document the actual number measured" in the completion report;
    // printing it here is how that number gets captured from a real `npm test` run rather than
    // invented after the fact.
    // eslint-disable-next-line no-console -- see comment above
    console.log(
      `[T-RAP-040 TC-4] findLatestComponentProgress against ${NOISE_ROW_COUNT}+ rows: ` +
        `${timingsMs.map((t) => t.toFixed(2)).join(', ')} ms (mean ${meanMs.toFixed(2)} ms)`,
    );

    // Generous bound for a shared/CI machine — the point this proves is "indexed lookup, not an
    // O(n) scan over the seeded table", not a tight production SLO of its own.
    expect(meanMs).toBeLessThan(200);
  });

  it('verification step 2: EXPLAIN ANALYZE confirms an index scan, never a sequential scan', async () => {
    const explainRows = await sequelize.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN ANALYZE
       SELECT DISTINCT ON (tracker_code, tracker_component_code) *
         FROM realtime_activity_processing.customer_tracker_component_progress
        WHERE tenant_id = :tenantId
          AND customer_id_hash = :customerIdHash
          AND campaign_code = :campaignCode
          AND (:trackerCode::varchar IS NULL OR tracker_code = :trackerCode)
        ORDER BY tracker_code, tracker_component_code, completion_cycle DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: TENANT_ID,
          customerIdHash: TARGET_CUSTOMER_HASH,
          campaignCode: TARGET_CAMPAIGN,
          trackerCode: null,
        },
      },
    );
    const plan = explainRows.map((row) => row['QUERY PLAN']).join('\n');
    // Verification step 2 explicitly requires the actual `EXPLAIN ANALYZE` output in the
    // completion report.
    // eslint-disable-next-line no-console -- see comment above
    console.log(`[T-RAP-040 verification step 2] EXPLAIN ANALYZE:\n${plan}`);

    expect(plan).toMatch(/Index/i);
    expect(plan).not.toMatch(/Seq Scan on customer_tracker_component_progress/i);
  });
});
