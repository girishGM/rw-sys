import type { RewardKind } from '../models/reward-fact.model';

/**
 * T-RTS-047. Fixed, committed fixture data reproducing
 * `brain-storm/03-ACCUMULATION-EXAMPLES.md`'s worked accumulation example **verbatim** — the same
 * five raw events, so `T-RTS-045`'s own TC-2 has real, checkable seed data ready for a Render
 * deploy (prepared, not executed — `AGENT-PROTOCOL.md` R13) without re-deriving that doc's numbers
 * by hand. `src/database/cli/seed.ts` is the only consumer that writes this data; this file is pure
 * data + a couple of small pure helpers, no I/O.
 *
 * **Judgment calls made here, flagged rather than silently invented (`AGENT-PROTOCOL.md` §3 — "if
 * you find a genuine design flaw... flag it").** Doc 03 itself only gives a truncated
 * `reward_entry_id` suffix (`...e1`..`...e5`) and no `reward_code`/`unit_type`/`unit_code` values at
 * all — none of those are literally specified anywhere in the brain-storm docs for this worked
 * example, so this file invents concrete values for them:
 *   - `reward_entry_id` — synthetic `SEED-T-RTS-047-E<n>-<suffix>` ids. The numeric `<suffix>` on
 *     each is NOT arbitrary: it was brute-forced (see the shell transcript in this task's completion
 *     report) so that `abs(hashtext(id)) % 32` — the exact shard-assignment formula
 *     `campaign-reward-counter-shard.repository.ts` (T-RTS-010, in flight) implements, itself a
 *     documented deviation from doc 03/`02-DATA-MODEL.md` §4's own signed-`hashtext`-with-no-`abs()`
 *     example — reproduces doc 03 §4's exact stated shard assignment (events #1/#2/#3/#4/#5 landing
 *     on shards 7/3/11/19/7 respectively). Changing any of these five ids changes the shard each
 *     event lands on and breaks that byte-for-byte match.
 *   - `unit_type`/`unit_code` — not given by doc 03 at all. Modeled on the enum doc 03 doesn't define
 *     but `reward-redemption-service-plan/03-GRPC-CONTRACT.md` §"BoundReward"/"CampaignCap" does
 *     (`unit_type: 'currency' | 'points' | 'voucher'`, `unit_code` a short code budgets match on):
 *     `currency`/`MYR` for the `CASHBACK`/`FIXED_AMOUNT` events, `points`/`PTS` for the
 *     `POINTS`/`POINTS` event, `voucher`/`PCT` for the `VOUCHER`/`PERCENTAGE` event. `PCT` (not
 *     `NULL`) is deliberate: `campaign_reward_counter_shard`'s own live schema forces `unit_type`/
 *     `unit_code` `NOT NULL` (Postgres auto-promotes a `PRIMARY KEY` column to `NOT NULL` regardless
 *     of the column's own declared nullability — the same gap
 *     `campaign-reward-counter-shard.migration.spec.ts`, T-RTS-002, already flagged), so this seed
 *     cannot use `NULL` there even though doc 03's own text never assigns the percentage voucher a
 *     unit code.
 *   - `reward_code` — invented, human-readable identifiers (`RWD-ONBOARD-CASHBACK`,
 *     `RWD-LOYALTY-POINTS`, `RWD-ONBOARD-VOUCHER10`) since `reward_fact.reward_code` is `NOT NULL`
 *     and doc 03 never names one.
 *   - `customer_id_encrypted` — doc 03 gives only the **already-hashed** `cust-hash-A`/`cust-hash-B`
 *     identifiers, never a plaintext `customerId` to actually encrypt, and this task's own file scope
 *     (`src/database/**`) does not include `src/modules/ingestion/customer-id-crypto.service.ts`
 *     (T-RTS-010, a different, in-flight task's own file — R10). `derivePlaceholderEncryptedCustomerId`
 *     below produces a clearly-labeled, non-secret, base64 placeholder string derived only from the
 *     already-public `customer_id_hash` — it is NOT AES-GCM ciphertext, is NOT decryptable, and makes
 *     no confidentiality claim; it exists purely so `reward_fact.customer_id_encrypted`'s `NOT NULL`
 *     constraint has a valid, self-consistent, deterministic value for this fixture. Real ingested
 *     rows (T-RTS-010, once done) always carry genuine `CustomerIdCryptoService.encrypt()` output
 *     instead — never this placeholder.
 *
 * `expires_at` is taken verbatim from doc 03 §1 for events #3/#5 (R5 — never recomputed here
 * either); `NULL` for events #1/#2/#4, exactly as doc 03 states.
 */

export const SEED_SOURCE_DOC = 'brain-storm/03-ACCUMULATION-EXAMPLES.md';

export const SEED_TENANT_ID = 1;
export const SEED_TENANT_CODE = 'TEN-MY';
export const SEED_COUNTRY_CODE = 'MY';
export const SEED_CAMPAIGN_CODE = 'CAMP-2026-Q3-001';

/**
 * Must match `reward_tracking.service_config`'s own seeded
 * `tracking.campaignCounterShardCount` value (`008_create_service_config.ts`, doc 03 §4's own "32
 * shards" assumption) — `cli/seed.ts` asserts this before writing anything, rather than silently
 * seeding shard rows that would no longer reproduce doc 03 if an operator ever changes that config
 * value.
 */
export const SEED_EXPECTED_SHARD_COUNT = 32;

export interface SeedRewardTrackingEvent {
  /** Doc 03 §1's own row number (1-5) — carried through purely for traceability in comments/logs. */
  readonly docRowNumber: number;
  readonly rewardEntryId: string;
  readonly correlationId: string;
  readonly tenantId: number;
  readonly tenantCode: string;
  readonly countryCode: string;
  readonly customerIdHash: string;
  readonly campaignCode: string;
  readonly trackerCode: string;
  readonly trackerComponentCode: string;
  readonly merchantCode: string;
  readonly rewardCode: string;
  readonly rewardCategory: string;
  readonly rewardKind: RewardKind;
  readonly unitType: string;
  readonly unitCode: string;
  readonly rewardValue: string;
  readonly rewardValueUnit: string;
  /** ISO-8601 UTC. */
  readonly redeemedAt: string;
  /** ISO-8601 UTC, or `null` — verbatim from doc 03 §1, never recomputed (R5). */
  readonly expiresAt: string | null;
}

/**
 * The five raw events, doc 03 §1's own table, in the same order (event ordering matters: it drives
 * `customer_reward_ledger.first_earned_at`/`last_earned_at` for the two events — #1 and #4 — that
 * merge into one ledger row).
 */
export const SEED_REWARD_TRACKING_EVENTS: readonly SeedRewardTrackingEvent[] = [
  {
    docRowNumber: 1,
    rewardEntryId: 'SEED-T-RTS-047-E1-6',
    correlationId: 'SEED-T-RTS-047-CORR-E1',
    tenantId: SEED_TENANT_ID,
    tenantCode: SEED_TENANT_CODE,
    countryCode: SEED_COUNTRY_CODE,
    customerIdHash: 'cust-hash-A',
    campaignCode: SEED_CAMPAIGN_CODE,
    trackerCode: 'TRK-ONBOARD',
    trackerComponentCode: 'CMP-FIRST-TXN',
    merchantCode: 'MCH-GRAB',
    rewardCode: 'RWD-ONBOARD-CASHBACK',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'currency',
    unitCode: 'MYR',
    rewardValue: '2.50',
    rewardValueUnit: 'MYR',
    redeemedAt: '2026-09-06T09:12:00.000Z',
    expiresAt: null,
  },
  {
    docRowNumber: 2,
    rewardEntryId: 'SEED-T-RTS-047-E2-29',
    correlationId: 'SEED-T-RTS-047-CORR-E2',
    tenantId: SEED_TENANT_ID,
    tenantCode: SEED_TENANT_CODE,
    countryCode: SEED_COUNTRY_CODE,
    customerIdHash: 'cust-hash-B',
    campaignCode: SEED_CAMPAIGN_CODE,
    trackerCode: 'TRK-ONBOARD',
    trackerComponentCode: 'CMP-FIRST-TXN',
    merchantCode: 'MCH-GRAB',
    rewardCode: 'RWD-ONBOARD-CASHBACK',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'currency',
    unitCode: 'MYR',
    rewardValue: '2.50',
    rewardValueUnit: 'MYR',
    redeemedAt: '2026-09-06T14:47:00.000Z',
    expiresAt: null,
  },
  {
    docRowNumber: 3,
    rewardEntryId: 'SEED-T-RTS-047-E3-98',
    correlationId: 'SEED-T-RTS-047-CORR-E3',
    tenantId: SEED_TENANT_ID,
    tenantCode: SEED_TENANT_CODE,
    countryCode: SEED_COUNTRY_CODE,
    customerIdHash: 'cust-hash-A',
    campaignCode: SEED_CAMPAIGN_CODE,
    trackerCode: 'TRK-LOYALTY',
    trackerComponentCode: 'CMP-REPEAT',
    merchantCode: 'MCH-SHOPEE',
    rewardCode: 'RWD-LOYALTY-POINTS',
    rewardCategory: 'POINTS',
    rewardKind: 'POINTS',
    unitType: 'points',
    unitCode: 'PTS',
    rewardValue: '100',
    rewardValueUnit: 'PTS',
    redeemedAt: '2026-09-06T22:03:00.000Z',
    // Verbatim from doc 03 §1 (T-173's 90-day expiry config applied by T-RR-063 at redemption).
    expiresAt: '2026-12-05T22:03:00.000Z',
  },
  {
    docRowNumber: 4,
    rewardEntryId: 'SEED-T-RTS-047-E4-52',
    correlationId: 'SEED-T-RTS-047-CORR-E4',
    tenantId: SEED_TENANT_ID,
    tenantCode: SEED_TENANT_CODE,
    countryCode: SEED_COUNTRY_CODE,
    customerIdHash: 'cust-hash-A',
    campaignCode: SEED_CAMPAIGN_CODE,
    trackerCode: 'TRK-ONBOARD',
    trackerComponentCode: 'CMP-FIRST-TXN',
    merchantCode: 'MCH-GRAB',
    rewardCode: 'RWD-ONBOARD-CASHBACK',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'currency',
    unitCode: 'MYR',
    rewardValue: '2.50',
    rewardValueUnit: 'MYR',
    redeemedAt: '2026-09-07T08:30:00.000Z',
    expiresAt: null,
  },
  {
    docRowNumber: 5,
    rewardEntryId: 'SEED-T-RTS-047-E5-128',
    correlationId: 'SEED-T-RTS-047-CORR-E5',
    tenantId: SEED_TENANT_ID,
    tenantCode: SEED_TENANT_CODE,
    countryCode: SEED_COUNTRY_CODE,
    customerIdHash: 'cust-hash-A',
    campaignCode: SEED_CAMPAIGN_CODE,
    trackerCode: 'TRK-ONBOARD',
    trackerComponentCode: 'CMP-FIRST-TXN',
    merchantCode: 'MCH-GRAB',
    rewardCode: 'RWD-ONBOARD-VOUCHER10',
    rewardCategory: 'VOUCHER',
    // A rate, not an amount (R4/§2.2) — 10 means "10% off", never "10 MYR".
    rewardKind: 'PERCENTAGE',
    unitType: 'voucher',
    unitCode: 'PCT',
    rewardValue: '10',
    rewardValueUnit: 'PCT',
    redeemedAt: '2026-09-07T11:00:00.000Z',
    // Verbatim from doc 03 §1 (60-day expiry config, applied at redemption).
    expiresAt: '2026-11-06T11:00:00.000Z',
  },
];

/**
 * A clearly-labeled, non-secret placeholder for `reward_fact.customer_id_encrypted` — see this
 * file's own header for why a real `CustomerIdCryptoService.encrypt()` call is not available/used
 * here. Deterministic (same hash, same placeholder) purely so re-running the seed script against an
 * already-seeded row is trivially comparable, never so it can be "decrypted" — there is no
 * corresponding decrypt path for this format and none should ever be written.
 */
export function derivePlaceholderEncryptedCustomerId(customerIdHash: string): string {
  return Buffer.from(`SEED-PLACEHOLDER-NOT-REAL-CIPHERTEXT::${customerIdHash}`, 'utf8').toString(
    'base64',
  );
}

// -------------------------------------------------------------------------------------------
// Expected derived-table rows — doc 03 §2 (customer_reward_ledger), §4
// (campaign_reward_counter_shard) and §6 (customer_reward_balance expiry watch), reproduced
// byte-for-byte. `cli/seed.ts` re-reads the actual rows after seeding and compares them against
// these constants before reporting success; `test/database/seed-data.spec.ts` asserts the same
// shape statically (TC-3's regression coverage) without needing a live DB.
// -------------------------------------------------------------------------------------------

export interface ExpectedLedgerRow {
  readonly customerIdHash: string;
  readonly campaignCode: string;
  readonly trackerCode: string;
  readonly trackerComponentCode: string;
  readonly rewardCategory: string;
  readonly rewardKind: RewardKind;
  readonly unitType: string;
  readonly unitCode: string;
  /** `decimal(18,4)` — compared numerically, not by exact string formatting. */
  readonly totalRewardValue: string;
  readonly totalRewardCount: number;
}

/** Doc 03 §2 — four rows (events #1/#4 merge; #2, #3, #5 each get their own row). */
export const SEED_EXPECTED_LEDGER_ROWS: readonly ExpectedLedgerRow[] = [
  {
    customerIdHash: 'cust-hash-A',
    campaignCode: SEED_CAMPAIGN_CODE,
    trackerCode: 'TRK-ONBOARD',
    trackerComponentCode: 'CMP-FIRST-TXN',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'currency',
    unitCode: 'MYR',
    totalRewardValue: '5.00',
    totalRewardCount: 2,
  },
  {
    customerIdHash: 'cust-hash-B',
    campaignCode: SEED_CAMPAIGN_CODE,
    trackerCode: 'TRK-ONBOARD',
    trackerComponentCode: 'CMP-FIRST-TXN',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'currency',
    unitCode: 'MYR',
    totalRewardValue: '2.50',
    totalRewardCount: 1,
  },
  {
    customerIdHash: 'cust-hash-A',
    campaignCode: SEED_CAMPAIGN_CODE,
    trackerCode: 'TRK-LOYALTY',
    trackerComponentCode: 'CMP-REPEAT',
    rewardCategory: 'POINTS',
    rewardKind: 'POINTS',
    unitType: 'points',
    unitCode: 'PTS',
    totalRewardValue: '100',
    totalRewardCount: 1,
  },
  {
    customerIdHash: 'cust-hash-A',
    campaignCode: SEED_CAMPAIGN_CODE,
    trackerCode: 'TRK-ONBOARD',
    trackerComponentCode: 'CMP-FIRST-TXN',
    rewardCategory: 'VOUCHER',
    rewardKind: 'PERCENTAGE',
    unitType: 'voucher',
    unitCode: 'PCT',
    totalRewardValue: '10',
    totalRewardCount: 1,
  },
];

export interface ExpectedShardRow {
  readonly campaignCode: string;
  readonly rewardCategory: string;
  readonly rewardKind: RewardKind;
  readonly unitType: string;
  readonly unitCode: string;
  readonly shardKey: number;
  readonly totalRewardValue: string;
  readonly totalRewardCount: number;
}

/**
 * Doc 03 §4 — five independent shard rows (events #1/#4/#2 are the same reward_category/kind but
 * land on three different shards, so they do NOT merge; event #5 shares shard 7 with event #1 but
 * is still a separate row because the primary key also includes `reward_category`/`reward_kind`).
 */
export const SEED_EXPECTED_SHARD_ROWS: readonly ExpectedShardRow[] = [
  {
    campaignCode: SEED_CAMPAIGN_CODE,
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'currency',
    unitCode: 'MYR',
    shardKey: 3,
    totalRewardValue: '2.50',
    totalRewardCount: 1,
  },
  {
    campaignCode: SEED_CAMPAIGN_CODE,
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'currency',
    unitCode: 'MYR',
    shardKey: 7,
    totalRewardValue: '2.50',
    totalRewardCount: 1,
  },
  {
    campaignCode: SEED_CAMPAIGN_CODE,
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'currency',
    unitCode: 'MYR',
    shardKey: 19,
    totalRewardValue: '2.50',
    totalRewardCount: 1,
  },
  {
    campaignCode: SEED_CAMPAIGN_CODE,
    rewardCategory: 'POINTS',
    rewardKind: 'POINTS',
    unitType: 'points',
    unitCode: 'PTS',
    shardKey: 11,
    totalRewardValue: '100',
    totalRewardCount: 1,
  },
  {
    campaignCode: SEED_CAMPAIGN_CODE,
    rewardCategory: 'VOUCHER',
    rewardKind: 'PERCENTAGE',
    unitType: 'voucher',
    unitCode: 'PCT',
    shardKey: 7,
    totalRewardValue: '10',
    totalRewardCount: 1,
  },
];

export interface ExpectedExpiringBalanceRow {
  readonly customerIdHash: string;
  readonly rewardCategory: string;
  readonly rewardKind: RewardKind;
  readonly issuedValue: string;
  readonly expiresAt: string;
}

/**
 * Doc 03 §6 — `cust-hash-A`'s balance rows with `expires_at < now() + interval '90 days'`. Only two
 * of the five seeded `customer_reward_balance` rows match (the three `CASHBACK` ones have
 * `expires_at IS NULL` and are correctly excluded).
 */
export const SEED_EXPECTED_EXPIRING_BALANCE_ROWS: readonly ExpectedExpiringBalanceRow[] = [
  {
    customerIdHash: 'cust-hash-A',
    rewardCategory: 'POINTS',
    rewardKind: 'POINTS',
    issuedValue: '100',
    expiresAt: '2026-12-05T22:03:00.000Z',
  },
  {
    customerIdHash: 'cust-hash-A',
    rewardCategory: 'VOUCHER',
    rewardKind: 'PERCENTAGE',
    issuedValue: '10',
    expiresAt: '2026-11-06T11:00:00.000Z',
  },
];
