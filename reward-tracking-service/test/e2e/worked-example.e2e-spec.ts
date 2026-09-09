/**
 * T-RTS-041 — Full-pipeline e2e test proving `brain-storm/03-ACCUMULATION-EXAMPLES.md`'s own worked
 * example produces exactly the numbers that document claims, against a booted Nest app + real local
 * Postgres. Ingests via the real REST channel (`createRewardTrackingIngestHttpServer`,
 * T-RTS-013/R8's own thin adapter over `RewardTrackingIngestionService.applyRewardTrackingEvent()`
 * — the same one method gRPC/Kafka also call, so which channel ingests is not itself the property
 * under test here, `T-RTS-014`/`T-RTS-048` already cover cross-channel parity) and reads back through
 * the real, already-`done` production query services (`CustomerRewardLedgerQueryService` T-RTS-030,
 * `CampaignSummaryQueryService`/`CountedLevelQueryService` T-RTS-031, `CustomerRewardBalanceRepository`
 * T-RTS-030) rather than hand-rolled SQL, so this suite asserts the actual observable API-layer
 * behaviour (R4's `shapeRewardGroup` included) doc 03 was validated against by hand, not a
 * reimplementation of it.
 *
 * ## Design notes
 *
 * 1. **Six events ingested, not five — doc 03 §1's five plus its own §2 "Q4" extension.** TC-1's own
 *    "Ingest doc 03's five events" and "match doc 03 §2 exactly" appear to be in tension: §2's own
 *    prose, in the same numbered section, walks through a sixth event ("if `cust-hash-A` later earns
 *    a CASHBACK reward ... under a *different* campaign") specifically to produce the fifth ledger
 *    row shown right there in §2, and §5's own tenant/country totals explicitly says it "includes the
 *    Q4-campaign event too" (`10.50`/`4`, not `7.50`/`3`) — numbers that are only reproducible with
 *    that sixth event actually ingested. Read strictly, "match doc 03 §2 exactly" (the literal
 *    instruction, count-checked against the whole of what §2 shows) requires it; the alternative
 *    reading ("only the five-row §1 table") would make TC-2's own tracker-level 8.00/3 total and TC-4's
 *    own tenant total both unreproducible from data this suite ingests, silently failing the very
 *    "byte-for-byte" claim this task exists to prove. Per `AGENT-PROTOCOL.md` §3 ("the design doc
 *    wins" when it conflicts with the task file's own shorthand), this suite ingests all six —
 *    flagged here and in the completion report, not silently picked.
 * 2. **One real documentation inconsistency found, not silently resolved past.** Doc 03 §3's own
 *    prose says the `TRK-ONBOARD` tracker-level query returns "three separate rows, never blended",
 *    but the table immediately below it shows only two (`CASHBACK`/`FIXED_AMOUNT`, `VOUCHER`/
 *    `PERCENTAGE`) — correct, since `TRK-LOYALTY` (the only tracker carrying a third,
 *    `POINTS`/`POINTS` row) is a different tracker code entirely and is correctly excluded by the
 *    query's own `WHERE tracker_code = 'TRK-ONBOARD'`. This suite asserts against the concrete table
 *    (two rows) — the unambiguous ground truth — not the prose count, and flags the "three" as a
 *    likely editing artifact for the architect to fix in doc 03 §3.
 * 3. **Business codes are randomized per run, `country_code` is the one deliberate exception.**
 *    `findMerchantTotals`/`findCountryTotals` (`counted-level-query.service.ts`) scan
 *    `reward_tracking.reward_fact` **without a `tenant_id` filter** (doc 04 §§2.2/2.4, confirmed by
 *    direct read) — unlike every other query this suite exercises, a collision with another test's or
 *    another concurrent run's rows would silently corrupt this suite's own totals rather than fail
 *    loudly. `merchantCode` is trivially made collision-safe (a `varchar(50)` UUID-suffixed value);
 *    `country_code` is `char(2)` (`003_create_reward_fact.ts`), so it cannot carry a UUID suffix —
 *    `'ZZ'` (confirmed unused by grepping every other `test/**` file before picking it) stands in for
 *    doc 03's own `'MY'` for that one reason.
 * 4. **The Q4 event's `merchantCode` is deliberately omitted (`null`), not invented.** Doc 03 never
 *    names a merchant for it, and its own §5 merchant-level total for `MCH-GRAB` (`7.50`/`3`/`2`) is
 *    unaffected by the Q4 event's presence — only reproducible if the Q4 event's `merchant_code` is
 *    something other than `MCH-GRAB` (`findMerchantTotals` filters by exact equality, and Postgres
 *    `NULL` never satisfies `merchant_code = :merchantCode`), so `null` is the one choice that matches
 *    the doc's own numbers without inventing a merchant identity doc 03 itself never specifies.
 * 5. **`expires_at` values are computed once, up front, and sent verbatim on each fixture (R5)** —
 *    never recomputed by this service; this suite proves the "90-day"/"60-day" arithmetic doc 03 §1
 *    describes by doing it itself, in the fixture builder, then asserting the stored/returned
 *    `expires_at` matches exactly, the same "taken verbatim from the inbound payload" property R5
 *    states.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Sequelize, QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { AppModule } from '@/app.module';
import {
  createRewardTrackingIngestHttpServer,
  type RewardTrackingIngestHttpServerHandle,
} from '@/modules/ingestion/reward-tracking-ingest-http.main';
import {
  CustomerIdCryptoService,
  loadCustomerIdCryptoKeyMaterial,
} from '@/modules/ingestion/customer-id-crypto.service';
import { CustomerRewardLedgerQueryService } from '@/modules/api/customer-reward-ledger-query.service';
import { CampaignSummaryQueryService } from '@/modules/api/campaign-summary-query.service';
import { CountedLevelQueryService } from '@/modules/api/counted-level-query.service';
import { CustomerRewardBalanceRepository } from '@/modules/api/customer-reward-balance.repository';

jest.setTimeout(60_000);

const TENANT_ID = 950_000 + Math.floor(Math.random() * 9_999);
const TENANT_CODE = 'T1';
// Design note 3 above — the one business code this suite does NOT randomize.
const COUNTRY_CODE = 'ZZ';
const REST_TOKEN_ENV_KEY = 'REWARD_TRACKING_INGEST_TOKEN';
const REST_TOKEN = 'e2e-worked-example-token';

const RUN_SUFFIX = randomUUID().slice(0, 8);

interface Fixture {
  rewardEntryId: string;
  correlationId: string;
  tenantId: number;
  tenantCode: string;
  countryCode: string;
  customerId: string;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  merchantCode: string | null;
  rewardCode: string;
  rewardCategory: string;
  rewardKind: string;
  unitType: string;
  unitCode: string;
  rewardValue: string;
  rewardValueUnit: string;
  redeemedAt: string;
  expiresAt: string | null;
}

function toWireBody(f: Fixture): Record<string, unknown> {
  return { ...f };
}

describe('T-RTS-041 — full pipeline e2e: brain-storm/03-ACCUMULATION-EXAMPLES.md worked example (real REST ingest, real Postgres, real query services)', () => {
  let db: Sequelize;
  let crypto: CustomerIdCryptoService;
  let restHandle: RewardTrackingIngestHttpServerHandle;
  let queryAppContext: INestApplicationContext;
  let savedRestToken: string | undefined;

  let ledgerQuery: CustomerRewardLedgerQueryService;
  let campaignSummaryQuery: CampaignSummaryQueryService;
  let countedLevelQuery: CountedLevelQueryService;
  let balanceRepository: CustomerRewardBalanceRepository;

  // --- doc 03 §1's business identities, randomized per run (design note 3) ---
  const customerIdA = `customer-A-${randomUUID()}`;
  const customerIdB = `customer-B-${randomUUID()}`;
  const campaignQ3 = `CAMP-Q3001-${RUN_SUFFIX}`;
  const campaignQ4 = `CAMP-Q4002-${RUN_SUFFIX}`;
  const trackerOnboard = `TRK-ONBRD-${RUN_SUFFIX}`;
  const componentFirstTxn = `CMP-FTXN-${RUN_SUFFIX}`;
  const trackerLoyalty = `TRK-LOYAL-${RUN_SUFFIX}`;
  const componentRepeat = `CMP-RPT-${RUN_SUFFIX}`;
  const merchantGrab = `MCH-GRAB-${RUN_SUFFIX}`;
  const merchantShopee = `MCH-SHPE-${RUN_SUFFIX}`;

  // --- doc 03 §1's unit fields — consistent per (reward_category, reward_kind) so every rollup's
  // own `GROUP BY reward_category, reward_kind, unit_type, unit_code` collapses exactly the way doc
  // 03's own (category, kind)-only grouping shows.
  const UNIT_CASHBACK = { unitType: 'CURRENCY', unitCode: 'MYR' };
  const UNIT_POINTS = { unitType: 'POINTS', unitCode: 'PTS' };
  const UNIT_VOUCHER = { unitType: 'PERCENT', unitCode: 'PCT' };

  const t0 = new Date('2026-09-06T09:12:00.000Z');
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;

  // doc 03 §1's own five raw facts, plus the §2 "Q4" sixth event (design note 1 above).
  const redeemedAt1 = t0;
  const redeemedAt2 = new Date(t0.getTime() + 5 * hour + 35 * 60 * 1000); // 14:47
  const redeemedAt3 = new Date(t0.getTime() + 12 * hour + 51 * 60 * 1000); // 22:03
  const redeemedAt4 = new Date(t0.getTime() + day + 23 * 60 * 1000 - 18 * 60 * 1000); // ~08:30 next day
  const redeemedAt5 = new Date(t0.getTime() + day + 1 * hour + 48 * 60 * 1000); // ~11:00 next day
  const redeemedAtQ4 = new Date(t0.getTime() + 2 * day);

  const expiresAt3 = new Date(redeemedAt3.getTime() + 90 * day); // "90-day expiry config"
  const expiresAt5 = new Date(redeemedAt5.getTime() + 60 * day); // "60-day expiry"

  function iso(d: Date): string {
    return d.toISOString();
  }

  const fixtures: Record<'e1' | 'e2' | 'e3' | 'e4' | 'e5' | 'eQ4', Fixture> = {
    e1: {
      rewardEntryId: randomUUID(),
      correlationId: randomUUID(),
      tenantId: TENANT_ID,
      tenantCode: TENANT_CODE,
      countryCode: COUNTRY_CODE,
      customerId: customerIdA,
      campaignCode: campaignQ3,
      trackerCode: trackerOnboard,
      trackerComponentCode: componentFirstTxn,
      merchantCode: merchantGrab,
      rewardCode: 'RWD-CASHBACK',
      rewardCategory: 'CASHBACK',
      rewardKind: 'FIXED_AMOUNT',
      ...UNIT_CASHBACK,
      rewardValue: '2.50',
      rewardValueUnit: 'MYR',
      redeemedAt: iso(redeemedAt1),
      expiresAt: null,
    },
    e2: {
      rewardEntryId: randomUUID(),
      correlationId: randomUUID(),
      tenantId: TENANT_ID,
      tenantCode: TENANT_CODE,
      countryCode: COUNTRY_CODE,
      customerId: customerIdB,
      campaignCode: campaignQ3,
      trackerCode: trackerOnboard,
      trackerComponentCode: componentFirstTxn,
      merchantCode: merchantGrab,
      rewardCode: 'RWD-CASHBACK',
      rewardCategory: 'CASHBACK',
      rewardKind: 'FIXED_AMOUNT',
      ...UNIT_CASHBACK,
      rewardValue: '2.50',
      rewardValueUnit: 'MYR',
      redeemedAt: iso(redeemedAt2),
      expiresAt: null,
    },
    e3: {
      rewardEntryId: randomUUID(),
      correlationId: randomUUID(),
      tenantId: TENANT_ID,
      tenantCode: TENANT_CODE,
      countryCode: COUNTRY_CODE,
      customerId: customerIdA,
      campaignCode: campaignQ3,
      trackerCode: trackerLoyalty,
      trackerComponentCode: componentRepeat,
      merchantCode: merchantShopee,
      rewardCode: 'RWD-POINTS',
      rewardCategory: 'POINTS',
      rewardKind: 'POINTS',
      ...UNIT_POINTS,
      rewardValue: '100',
      rewardValueUnit: 'PTS',
      redeemedAt: iso(redeemedAt3),
      expiresAt: iso(expiresAt3),
    },
    e4: {
      rewardEntryId: randomUUID(),
      correlationId: randomUUID(),
      tenantId: TENANT_ID,
      tenantCode: TENANT_CODE,
      countryCode: COUNTRY_CODE,
      customerId: customerIdA,
      campaignCode: campaignQ3,
      trackerCode: trackerOnboard,
      trackerComponentCode: componentFirstTxn,
      merchantCode: merchantGrab,
      rewardCode: 'RWD-CASHBACK',
      rewardCategory: 'CASHBACK',
      rewardKind: 'FIXED_AMOUNT',
      ...UNIT_CASHBACK,
      rewardValue: '2.50',
      rewardValueUnit: 'MYR',
      redeemedAt: iso(redeemedAt4),
      expiresAt: null,
    },
    e5: {
      rewardEntryId: randomUUID(),
      correlationId: randomUUID(),
      tenantId: TENANT_ID,
      tenantCode: TENANT_CODE,
      countryCode: COUNTRY_CODE,
      customerId: customerIdA,
      campaignCode: campaignQ3,
      trackerCode: trackerOnboard,
      trackerComponentCode: componentFirstTxn,
      merchantCode: merchantGrab,
      rewardCode: 'RWD-VOUCHER',
      rewardCategory: 'VOUCHER',
      rewardKind: 'PERCENTAGE',
      ...UNIT_VOUCHER,
      rewardValue: '10',
      rewardValueUnit: 'PCT',
      redeemedAt: iso(redeemedAt5),
      expiresAt: iso(expiresAt5),
    },
    // doc 03 §2's own "Q4" extension (design note 1) — same tracker/component as e1/e4, a
    // *different* campaign, no merchant (design note 4).
    eQ4: {
      rewardEntryId: randomUUID(),
      correlationId: randomUUID(),
      tenantId: TENANT_ID,
      tenantCode: TENANT_CODE,
      countryCode: COUNTRY_CODE,
      customerId: customerIdA,
      campaignCode: campaignQ4,
      trackerCode: trackerOnboard,
      trackerComponentCode: componentFirstTxn,
      merchantCode: null,
      rewardCode: 'RWD-CASHBACK',
      rewardCategory: 'CASHBACK',
      rewardKind: 'FIXED_AMOUNT',
      ...UNIT_CASHBACK,
      rewardValue: '3.00',
      rewardValueUnit: 'MYR',
      redeemedAt: iso(redeemedAtQ4),
      expiresAt: null,
    },
  };

  async function ingest(fixture: Fixture): Promise<{ status: string }> {
    const response = await request(restHandle.app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .set('Authorization', `Bearer ${REST_TOKEN}`)
      .send(toWireBody(fixture));
    if (response.status !== 200) {
      throw new Error(`REST ingest failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body as { status: string };
  }

  beforeAll(async () => {
    db = createMigrationConnection();
    await db.authenticate();
    crypto = new CustomerIdCryptoService(loadCustomerIdCryptoKeyMaterial());

    savedRestToken = process.env[REST_TOKEN_ENV_KEY];
    process.env[REST_TOKEN_ENV_KEY] = REST_TOKEN;
    restHandle = await createRewardTrackingIngestHttpServer(0);

    // Real production DI graph (`AppModule`) for the read side — the same
    // `CustomerRewardLedgerQueryService`/`CampaignSummaryQueryService`/`CountedLevelQueryService`/
    // `CustomerRewardBalanceRepository` instances the real HTTP app would use, never hand-rolled SQL.
    queryAppContext = await NestFactory.createApplicationContext(AppModule, { logger: false });
    ledgerQuery = queryAppContext.get(CustomerRewardLedgerQueryService);
    campaignSummaryQuery = queryAppContext.get(CampaignSummaryQueryService);
    countedLevelQuery = queryAppContext.get(CountedLevelQueryService);
    balanceRepository = queryAppContext.get(CustomerRewardBalanceRepository);

    // Ingest all six events (design note 1) via the real REST channel, in doc order. Each one must
    // be a first-time `applied` — this suite owns exclusively-random identities, so no fixture here
    // can legitimately collide with another already-ingested `reward_entry_id`.
    for (const key of ['e1', 'e2', 'e3', 'e4', 'e5', 'eQ4'] as const) {
      const outcome = await ingest(fixtures[key]);
      expect(outcome.status).toBe('applied');
    }
  });

  afterAll(async () => {
    // Each delete's own `Promise<[unknown[], unknown]>` (the `QueryTypes.RAW` overload) is
    // deliberately discarded via `async () => { await ...; }` rather than returned directly — the
    // one shape that is unconditionally assignable to `Array<() => Promise<void>>` regardless of
    // which `Sequelize#query` overload TS resolves for a given call site.
    const steps: Array<() => Promise<void>> = [
      async () => {
        await db?.query(
          'DELETE FROM reward_tracking.customer_reward_balance WHERE tenant_id = :tenantId',
          { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
        );
      },
      async () => {
        await db?.query(
          'DELETE FROM reward_tracking.campaign_reward_counter_shard WHERE tenant_id = :tenantId',
          { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
        );
      },
      async () => {
        await db?.query(
          'DELETE FROM reward_tracking.customer_reward_ledger WHERE tenant_id = :tenantId',
          { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
        );
      },
      async () => {
        await db?.query('DELETE FROM reward_tracking.reward_fact WHERE tenant_id = :tenantId', {
          type: QueryTypes.RAW,
          replacements: { tenantId: TENANT_ID },
        });
      },
      async () => {
        await db?.query(
          `DELETE FROM reward_tracking.inbound_event_log WHERE payload->>'tenantId' = :tenantIdStr`,
          { type: QueryTypes.RAW, replacements: { tenantIdStr: String(TENANT_ID) } },
        );
      },
      async () => {
        await restHandle?.close();
      },
      async () => {
        await queryAppContext?.close();
      },
      async () => {
        await db?.close();
      },
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        // Best-effort — swallow so every remaining teardown step still runs.
        console.warn('T-RTS-041 worked-example teardown step failed:', error);
      }
    }
    if (savedRestToken === undefined) delete process.env[REST_TOKEN_ENV_KEY];
    else process.env[REST_TOKEN_ENV_KEY] = savedRestToken;
  });

  // TC-1 — doc 03 §2, customer_reward_ledger rows (both tables in that section combined, design
  // note 1: five raw+one-extension events collapse into five ledger rows, not four).
  it('TC-1: customer_reward_ledger rows match doc 03 §2 exactly (including the Q4-campaign extension)', async () => {
    const hashA = crypto.hash(customerIdA);
    const hashB = crypto.hash(customerIdB);

    const rowsA = await ledgerQuery.findLedgerComponents({
      tenantId: TENANT_ID,
      customerIdHash: hashA,
    });
    const rowsB = await ledgerQuery.findLedgerComponents({
      tenantId: TENANT_ID,
      customerIdHash: hashB,
    });

    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]).toMatchObject({
      campaign_code: campaignQ3,
      tracker_code: trackerOnboard,
      tracker_component_code: componentFirstTxn,
      reward_category: 'CASHBACK',
      reward_kind: 'FIXED_AMOUNT',
      total_reward_value: '2.5000',
      total_reward_count: 1,
    });

    expect(rowsA).toHaveLength(4);
    const byKey = (r: (typeof rowsA)[number]): string =>
      `${r.campaign_code}/${r.tracker_code}/${r.tracker_component_code}/${r.reward_category}/${r.reward_kind}`;
    const rowsAByKey = new Map(rowsA.map((r) => [byKey(r), r]));

    expect(
      rowsAByKey.get(`${campaignQ3}/${trackerOnboard}/${componentFirstTxn}/CASHBACK/FIXED_AMOUNT`),
    ).toMatchObject({ total_reward_value: '5.0000', total_reward_count: 2 });
    expect(
      rowsAByKey.get(`${campaignQ3}/${trackerLoyalty}/${componentRepeat}/POINTS/POINTS`),
    ).toMatchObject({ total_reward_value: '100.0000', total_reward_count: 1 });
    expect(
      rowsAByKey.get(`${campaignQ3}/${trackerOnboard}/${componentFirstTxn}/VOUCHER/PERCENTAGE`),
    ).toMatchObject({ total_reward_value: '10.0000', total_reward_count: 1 });
    expect(
      rowsAByKey.get(`${campaignQ4}/${trackerOnboard}/${componentFirstTxn}/CASHBACK/FIXED_AMOUNT`),
    ).toMatchObject({ total_reward_value: '3.0000', total_reward_count: 1 });
  });

  // TC-2 — doc 03 §3, tracker-level and campaign-level totals (design note 2: two rows for the
  // tracker-level query, matching the table, not the "three" in the doc's own prose).
  it("TC-2: tracker-level and campaign-level totals match doc 03 §3 exactly, including the PERCENTAGE row's count-only shape", async () => {
    const hashA = crypto.hash(customerIdA);

    const trackerTotals = await ledgerQuery.findTrackerTotals({
      tenantId: TENANT_ID,
      customerIdHash: hashA,
      trackerCode: trackerOnboard,
    });
    expect(trackerTotals).toHaveLength(2);
    const trackerByKind = new Map(trackerTotals.map((r) => [r.reward_kind, r]));
    expect(trackerByKind.get('FIXED_AMOUNT')).toMatchObject({
      reward_category: 'CASHBACK',
      total_value: '8.0000',
      total_count: '3',
    });
    expect(trackerByKind.get('PERCENTAGE')).toMatchObject({
      reward_category: 'VOUCHER',
      total_value: '10.0000',
      total_count: '1',
    });

    const campaignTotals = await ledgerQuery.findCampaignTotals({
      tenantId: TENANT_ID,
      customerIdHash: hashA,
      campaignCode: campaignQ3,
    });
    expect(campaignTotals).toHaveLength(3);
    const campaignByKind = new Map(campaignTotals.map((r) => [r.reward_kind, r]));
    expect(campaignByKind.get('FIXED_AMOUNT')).toMatchObject({
      reward_category: 'CASHBACK',
      total_value: '5.0000',
      total_count: '2',
    });
    expect(campaignByKind.get('POINTS')).toMatchObject({
      reward_category: 'POINTS',
      total_value: '100.0000',
      total_count: '1',
    });
    expect(campaignByKind.get('PERCENTAGE')).toMatchObject({
      reward_category: 'VOUCHER',
      total_value: '10.0000',
      total_count: '1',
    });
  });

  // TC-3 — doc 03 §4, campaign_reward_counter_shard sum, read through the real
  // `CampaignSummaryQueryService`/`shapeRewardGroup` API-shaping (R4) — a `PERCENTAGE` row must carry
  // no `totalValue` field at all, only `totalCount` (+ `averageRatePercent`).
  it('TC-3: campaign shard sum matches doc 03 §4, PERCENTAGE row carries no totalValue field (R4)', async () => {
    const groups = await campaignSummaryQuery.computeCampaignSummary(TENANT_ID, campaignQ3);
    expect(groups).toHaveLength(3);
    const byKind = new Map(groups.map((g) => [g.rewardKind, g]));

    const cashback = byKind.get('FIXED_AMOUNT');
    expect(cashback).toMatchObject({
      rewardCategory: 'CASHBACK',
      totalValue: '7.5000',
      totalCount: 3,
    });

    const points = byKind.get('POINTS');
    expect(points).toMatchObject({
      rewardCategory: 'POINTS',
      totalValue: '100.0000',
      totalCount: 1,
    });

    const voucher = byKind.get('PERCENTAGE');
    expect(voucher).toMatchObject({
      rewardCategory: 'VOUCHER',
      totalCount: 1,
      averageRatePercent: '10.00',
    });
    expect(voucher).not.toHaveProperty('totalValue');
  });

  // TC-4 — doc 03 §5, merchant/tenant/country counted queries.
  it('TC-4: merchant/tenant/country counted queries match doc 03 §5', async () => {
    const merchantTotals = await countedLevelQuery.findMerchantTotals(merchantGrab);
    expect(merchantTotals).toHaveLength(2);
    const merchantByKind = new Map(merchantTotals.map((r) => [r.reward_kind, r]));
    expect(merchantByKind.get('FIXED_AMOUNT')).toMatchObject({
      reward_category: 'CASHBACK',
      total_value: '7.5000',
      total_count: '3',
      distinct_customers: '2',
    });
    expect(merchantByKind.get('PERCENTAGE')).toMatchObject({
      reward_category: 'VOUCHER',
      total_value: '10.0000',
      total_count: '1',
      distinct_customers: '1',
    });

    const tenantTotals = await countedLevelQuery.findTenantTotals(TENANT_ID);
    expect(tenantTotals).toHaveLength(3);
    const tenantByKind = new Map(tenantTotals.map((r) => [r.reward_kind, r]));
    expect(tenantByKind.get('FIXED_AMOUNT')).toMatchObject({
      reward_category: 'CASHBACK',
      total_value: '10.5000',
      total_count: '4',
    });
    expect(tenantByKind.get('POINTS')).toMatchObject({
      reward_category: 'POINTS',
      total_value: '100.0000',
      total_count: '1',
    });
    expect(tenantByKind.get('PERCENTAGE')).toMatchObject({
      reward_category: 'VOUCHER',
      total_value: '10.0000',
      total_count: '1',
    });

    // Country total is identical to the tenant total here — this suite's own tenant is the only
    // one using COUNTRY_CODE (design note 3), same as doc 03 §5's own "TEN-MY is the only tenant
    // operating in Malaysia" reasoning.
    const countryTotals = await countedLevelQuery.findCountryTotals(COUNTRY_CODE);
    expect(countryTotals).toHaveLength(3);
    const countryByKind = new Map(countryTotals.map((r) => [r.reward_kind, r]));
    expect(countryByKind.get('FIXED_AMOUNT')).toMatchObject({
      reward_category: 'CASHBACK',
      total_value: '10.5000',
      total_count: '4',
    });
    expect(countryByKind.get('POINTS')).toMatchObject({
      reward_category: 'POINTS',
      total_value: '100.0000',
      total_count: '1',
    });
    expect(countryByKind.get('PERCENTAGE')).toMatchObject({
      reward_category: 'VOUCHER',
      total_value: '10.0000',
      total_count: '1',
    });
  });

  // TC-5 — doc 03 §6, the expiry query — both expiring rows, in `ORDER BY expires_at` order, and
  // never the two non-expiring (`expires_at IS NULL`) events e1/e2/e4/eQ4.
  it('TC-5: expiry query matches doc 03 §6 exactly', async () => {
    const hashA = crypto.hash(customerIdA);
    await balanceRepository.populateMissing({ tenantId: TENANT_ID, customerIdHash: hashA });

    const expiring = await balanceRepository.findExpiring({
      tenantId: TENANT_ID,
      customerIdHash: hashA,
      withinDays: 120,
    });

    expect(expiring).toHaveLength(2);
    // e5 (60-day expiry, ~day 61) sorts before e3 (90-day expiry, ~day 90) — `ORDER BY expires_at`.
    expect(expiring[0]).toMatchObject({
      reward_category: 'VOUCHER',
      reward_kind: 'PERCENTAGE',
      issued_value: '10.0000',
      campaign_code: campaignQ3,
      status: 'ACTIVE',
    });
    expect(new Date(expiring[0].expires_at).toISOString()).toBe(iso(expiresAt5));

    expect(expiring[1]).toMatchObject({
      reward_category: 'POINTS',
      reward_kind: 'POINTS',
      issued_value: '100.0000',
      campaign_code: campaignQ3,
      status: 'ACTIVE',
    });
    expect(new Date(expiring[1].expires_at).toISOString()).toBe(iso(expiresAt3));
  });
});
