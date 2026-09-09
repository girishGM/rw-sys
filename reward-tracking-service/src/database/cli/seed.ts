#!/usr/bin/env node
/**
 * T-RTS-047. `npm run db:seed` — inserts `brain-storm/03-ACCUMULATION-EXAMPLES.md`'s worked
 * accumulation example (`../seeds/seed-data.constants.ts`'s five events) into `reward_fact`,
 * `customer_reward_ledger`, `campaign_reward_counter_shard` and `customer_reward_balance`, then
 * re-reads every derived row and asserts it matches that doc byte-for-byte — the exact fixture
 * `T-RTS-045`'s own TC-2 needs, prepared for a Render deploy (not executed there —
 * `AGENT-PROTOCOL.md` R13).
 *
 * **Connects as the least-privilege app role (`reward_tracking_app`, `DB_APP_*`), never the
 * migration role.** This is DML against tables the app role is already fully granted on
 * (`001_create_schema_and_role.ts`'s own `GRANT ... ON ALL TABLES`/`ALTER DEFAULT PRIVILEGES`), not
 * DDL — `migration-connection.ts`'s own header is explicit that its privileged connection is for the
 * migration CLI only. Same convention `schema-and-role.migration.spec.ts`'s own
 * `createAppRoleConnection()` already established for this service.
 *
 * **Direct INSERT/UPSERT, not `RewardTrackingIngestionService.applyRewardTrackingEvent()`**
 * (T-RTS-047's own task file explicitly allows either: "once applyRewardTrackingEvent (or a direct
 * INSERT matching its shape) has processed them"). That domain method lives under
 * `src/modules/ingestion/**` — a different, still in-flight task's own file scope (T-RTS-010,
 * `AGENT-PROTOCOL.md` R10) this task must not depend on to stay independently completable/reviewable
 * regardless of that task's own state. The SQL below is deliberately kept in the same shape as that
 * module's own repositories where one already exists (`campaign-reward-counter-shard.repository.ts`'s
 * `abs(hashtext($seed)) % $shardCount` shard formula, `customer-reward-ledger.repository.ts`'s own
 * `ON CONFLICT ... DO UPDATE` upsert) purely so the two stay consistent if T-RTS-010 lands unchanged —
 * this file does not import from that module.
 *
 * **Idempotent, like every other CLI in this directory (R11).** `inbound_event_log`'s own
 * `uq_iel_reward_entry` unique constraint (`ON CONFLICT (reward_entry_id) DO NOTHING`) is the gate: a
 * second run against an already-seeded database inserts nothing and mutates nothing further for any
 * event whose `reward_entry_id` already exists — never double-applies the ledger/shard/balance writes
 * for an event this script has already processed.
 */
/* eslint-disable no-console -- T-RTS-047: this is a CLI script; printing status IS its job. */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { loadDotenvFilesIntoProcessEnv } from '../../config/load-dotenv-files';
import { validateConfig } from '../../config/config.schema';
import type { RewardFactRow } from '../models/reward-fact.model';
import {
  SEED_REWARD_TRACKING_EVENTS,
  SEED_EXPECTED_SHARD_COUNT,
  SEED_EXPECTED_LEDGER_ROWS,
  SEED_EXPECTED_SHARD_ROWS,
  SEED_EXPECTED_EXPIRING_BALANCE_ROWS,
  derivePlaceholderEncryptedCustomerId,
  type SeedRewardTrackingEvent,
} from '../seeds/seed-data.constants';

const SHARD_COUNT_CONFIG_KEY = 'tracking.campaignCounterShardCount';

/**
 * The app runtime connection (`DB_APP_*`) — mirrors
 * `test/database/schema-and-role.migration.spec.ts`'s own `createAppRoleConnection()`, reusing
 * `validateConfig` (rather than reading `process.env` fields one at a time) so a missing value fails
 * loudly with the same clear message every other bootstrap path in this service already gives (R12).
 */
function createAppConnection(): Sequelize {
  const env = validateConfig(process.env);
  return new Sequelize({
    dialect: 'postgres',
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    username: env.DB_APP_USERNAME,
    password: env.DB_APP_PASSWORD,
    logging: false,
    dialectOptions: env.DB_SSL ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  });
}

async function assertShardCountConfigured(sequelize: Sequelize): Promise<void> {
  const rows = await sequelize.query<{ config_value: string }>(
    `SELECT config_value FROM reward_tracking.service_config
      WHERE config_key = :key AND scope_level = 'GLOBAL'`,
    { type: QueryTypes.SELECT, replacements: { key: SHARD_COUNT_CONFIG_KEY } },
  );
  const configured = rows[0] ? Number.parseInt(rows[0].config_value, 10) : undefined;
  if (configured !== SEED_EXPECTED_SHARD_COUNT) {
    throw new Error(
      `reward_tracking.service_config's "${SHARD_COUNT_CONFIG_KEY}" is ` +
        `${configured ?? 'unseeded'}, not the ${SEED_EXPECTED_SHARD_COUNT} this seed's own ` +
        `pre-computed reward_entry_id values (and doc 03 §4's own worked shard assignment) assume — ` +
        `refusing to seed data that would silently no longer reproduce that doc. See ` +
        `seed-data.constants.ts's own header.`,
    );
  }
}

/** One event's writes — `inbound_event_log` + `reward_fact` insert, `customer_reward_ledger` +
 * `campaign_reward_counter_shard` upsert, `customer_reward_balance` insert — all in one transaction
 * (mirrors `applyRewardTrackingEvent`'s own "one transaction, N writes" shape, extended here with the
 * balance insert that domain method doesn't itself perform). Returns `false` (nothing written) when
 * `reward_entry_id` already exists — the idempotency short-circuit. */
async function seedOneEvent(
  sequelize: Sequelize,
  event: SeedRewardTrackingEvent,
): Promise<boolean> {
  return sequelize.transaction(async (transaction) => {
    const inserted = await sequelize.query<{ id: string }>(
      `INSERT INTO reward_tracking.inbound_event_log
         (reward_entry_id, received_channel, payload, processing_status, processed_at)
       VALUES (:rewardEntryId, 'REST', :payload::jsonb, 'applied', now())
       ON CONFLICT (reward_entry_id) DO NOTHING
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          rewardEntryId: event.rewardEntryId,
          payload: JSON.stringify({ source: 'T-RTS-047-seed', docRowNumber: event.docRowNumber }),
        },
      },
    );

    if (inserted.length === 0) {
      // Already seeded on a previous run — leave every derived table untouched (R3/R11).
      return false;
    }

    const customerIdEncrypted = derivePlaceholderEncryptedCustomerId(event.customerIdHash);

    const [rewardFact] = await sequelize.query<RewardFactRow>(
      `INSERT INTO reward_tracking.reward_fact
         (reward_entry_id, correlation_id, tenant_id, tenant_code, country_code,
          customer_id_encrypted, customer_id_hash, campaign_code, tracker_code,
          tracker_component_code, merchant_code, reward_code, reward_category, reward_kind,
          unit_type, unit_code, reward_value, reward_value_unit, redeemed_at, expires_at)
       VALUES (:rewardEntryId, :correlationId, :tenantId, :tenantCode, :countryCode,
               :customerIdEncrypted, :customerIdHash, :campaignCode, :trackerCode,
               :trackerComponentCode, :merchantCode, :rewardCode, :rewardCategory, :rewardKind,
               :unitType, :unitCode, :rewardValue, :rewardValueUnit, :redeemedAt, :expiresAt)
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          rewardEntryId: event.rewardEntryId,
          correlationId: event.correlationId,
          tenantId: event.tenantId,
          tenantCode: event.tenantCode,
          countryCode: event.countryCode,
          customerIdEncrypted,
          customerIdHash: event.customerIdHash,
          campaignCode: event.campaignCode,
          trackerCode: event.trackerCode,
          trackerComponentCode: event.trackerComponentCode,
          merchantCode: event.merchantCode,
          rewardCode: event.rewardCode,
          rewardCategory: event.rewardCategory,
          rewardKind: event.rewardKind,
          unitType: event.unitType,
          unitCode: event.unitCode,
          rewardValue: event.rewardValue,
          rewardValueUnit: event.rewardValueUnit,
          redeemedAt: event.redeemedAt,
          expiresAt: event.expiresAt,
        },
      },
    );

    // customer_reward_ledger upsert — same shape as customer-reward-ledger.repository.ts (T-RTS-010).
    await sequelize.query(
      `INSERT INTO reward_tracking.customer_reward_ledger
         (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
          reward_category, reward_kind, unit_type, unit_code, total_reward_value,
          total_reward_count, first_earned_at, last_earned_at)
       VALUES (:tenantId, :customerIdHash, :campaignCode, :trackerCode, :trackerComponentCode,
               :rewardCategory, :rewardKind, :unitType, :unitCode, :rewardValue, 1, :redeemedAt,
               :redeemedAt)
       ON CONFLICT (tenant_id, customer_id_hash, campaign_code, tracker_code,
                    tracker_component_code, reward_category, reward_kind, unit_type, unit_code)
       DO UPDATE SET
         total_reward_value = customer_reward_ledger.total_reward_value + EXCLUDED.total_reward_value,
         total_reward_count = customer_reward_ledger.total_reward_count + 1,
         last_earned_at     = EXCLUDED.last_earned_at,
         updated_at         = now()`,
      {
        type: QueryTypes.RAW,
        transaction,
        replacements: {
          tenantId: event.tenantId,
          customerIdHash: event.customerIdHash,
          campaignCode: event.campaignCode,
          trackerCode: event.trackerCode,
          trackerComponentCode: event.trackerComponentCode,
          rewardCategory: event.rewardCategory,
          rewardKind: event.rewardKind,
          unitType: event.unitType,
          unitCode: event.unitCode,
          rewardValue: event.rewardValue,
          redeemedAt: event.redeemedAt,
        },
      },
    );

    // campaign_reward_counter_shard upsert (R7 — single atomic INSERT ... ON CONFLICT DO UPDATE,
    // never a read-then-write) — same `abs(hashtext($seed)) % $shardCount` formula
    // campaign-reward-counter-shard.repository.ts (T-RTS-010) implements.
    await sequelize.query(
      `INSERT INTO reward_tracking.campaign_reward_counter_shard
         (tenant_id, campaign_code, reward_category, reward_kind, unit_type, unit_code, shard_key,
          total_reward_value, total_reward_count)
       VALUES (:tenantId, :campaignCode, :rewardCategory, :rewardKind, :unitType, :unitCode,
               abs(hashtext(:rewardEntryId)) % :shardCount, :rewardValue, 1)
       ON CONFLICT (tenant_id, campaign_code, reward_category, reward_kind, unit_type, unit_code,
                    shard_key)
       DO UPDATE SET
         total_reward_value = campaign_reward_counter_shard.total_reward_value + EXCLUDED.total_reward_value,
         total_reward_count = campaign_reward_counter_shard.total_reward_count + 1,
         updated_at         = now()`,
      {
        type: QueryTypes.RAW,
        transaction,
        replacements: {
          tenantId: event.tenantId,
          campaignCode: event.campaignCode,
          rewardCategory: event.rewardCategory,
          rewardKind: event.rewardKind,
          unitType: event.unitType,
          unitCode: event.unitCode,
          rewardEntryId: event.rewardEntryId,
          shardCount: SEED_EXPECTED_SHARD_COUNT,
          rewardValue: event.rewardValue,
        },
      },
    );

    // customer_reward_balance — one wallet-style row per reward_fact row (doc 03 §6). Not written by
    // applyRewardTrackingEvent (T-RTS-010) at all; this seed is the only writer of this table today.
    await sequelize.query(
      `INSERT INTO reward_tracking.customer_reward_balance
         (reward_fact_id, tenant_id, customer_id_hash, campaign_code, reward_category, unit_type,
          unit_code, reward_code, reward_kind, issued_value, status, issued_at, expires_at)
       VALUES (:rewardFactId, :tenantId, :customerIdHash, :campaignCode, :rewardCategory, :unitType,
               :unitCode, :rewardCode, :rewardKind, :rewardValue, 'ACTIVE', :issuedAt, :expiresAt)`,
      {
        type: QueryTypes.RAW,
        transaction,
        replacements: {
          rewardFactId: rewardFact.id,
          tenantId: event.tenantId,
          customerIdHash: event.customerIdHash,
          campaignCode: event.campaignCode,
          rewardCategory: event.rewardCategory,
          unitType: event.unitType,
          unitCode: event.unitCode,
          rewardCode: event.rewardCode,
          rewardKind: event.rewardKind,
          rewardValue: event.rewardValue,
          issuedAt: event.redeemedAt,
          expiresAt: event.expiresAt,
        },
      },
    );

    return true;
  });
}

/** Re-reads every derived table and throws with a precise diff-style message on the first mismatch
 * against `seed-data.constants.ts`'s own expected rows — TC-2's own "must match byte-for-byte"
 * requirement, checked by the script itself rather than trusted to have been written correctly. */
async function verifySeedData(sequelize: Sequelize): Promise<void> {
  const ledgerRows = await sequelize.query<{
    customer_id_hash: string;
    campaign_code: string;
    tracker_code: string;
    tracker_component_code: string;
    reward_category: string;
    reward_kind: string;
    unit_type: string;
    unit_code: string;
    total_reward_value: string;
    total_reward_count: number;
  }>(
    `SELECT customer_id_hash, campaign_code, tracker_code, tracker_component_code, reward_category,
            reward_kind, unit_type, unit_code, total_reward_value, total_reward_count
       FROM reward_tracking.customer_reward_ledger
      WHERE campaign_code = :campaignCode
      ORDER BY customer_id_hash, tracker_code, reward_category`,
    { type: QueryTypes.SELECT, replacements: { campaignCode: 'CAMP-2026-Q3-001' } },
  );
  if (ledgerRows.length !== SEED_EXPECTED_LEDGER_ROWS.length) {
    throw new Error(
      `Expected ${SEED_EXPECTED_LEDGER_ROWS.length} customer_reward_ledger rows for ` +
        `CAMP-2026-Q3-001, found ${ledgerRows.length}.`,
    );
  }
  for (const expected of SEED_EXPECTED_LEDGER_ROWS) {
    const actual = ledgerRows.find(
      (row) =>
        row.customer_id_hash === expected.customerIdHash &&
        row.tracker_code === expected.trackerCode &&
        row.tracker_component_code === expected.trackerComponentCode &&
        row.reward_category === expected.rewardCategory &&
        row.reward_kind === expected.rewardKind,
    );
    if (!actual) {
      throw new Error(
        `Missing customer_reward_ledger row for ${expected.customerIdHash}/` +
          `${expected.trackerCode}/${expected.rewardCategory}/${expected.rewardKind}.`,
      );
    }
    if (
      Number(actual.total_reward_value) !== Number(expected.totalRewardValue) ||
      actual.total_reward_count !== expected.totalRewardCount ||
      actual.unit_type !== expected.unitType ||
      actual.unit_code !== expected.unitCode
    ) {
      throw new Error(
        `customer_reward_ledger row for ${expected.customerIdHash}/${expected.trackerCode}/` +
          `${expected.rewardCategory} does not match doc 03 §2: expected ` +
          `value=${expected.totalRewardValue} count=${expected.totalRewardCount}, got ` +
          `value=${actual.total_reward_value} count=${actual.total_reward_count}.`,
      );
    }
  }

  const shardRows = await sequelize.query<{
    reward_category: string;
    reward_kind: string;
    unit_type: string;
    unit_code: string;
    shard_key: number;
    total_reward_value: string;
    total_reward_count: number;
  }>(
    `SELECT reward_category, reward_kind, unit_type, unit_code, shard_key, total_reward_value,
            total_reward_count
       FROM reward_tracking.campaign_reward_counter_shard
      WHERE campaign_code = :campaignCode
      ORDER BY reward_category, shard_key`,
    { type: QueryTypes.SELECT, replacements: { campaignCode: 'CAMP-2026-Q3-001' } },
  );
  if (shardRows.length !== SEED_EXPECTED_SHARD_ROWS.length) {
    throw new Error(
      `Expected ${SEED_EXPECTED_SHARD_ROWS.length} campaign_reward_counter_shard rows for ` +
        `CAMP-2026-Q3-001, found ${shardRows.length}.`,
    );
  }
  for (const expected of SEED_EXPECTED_SHARD_ROWS) {
    const actual = shardRows.find(
      (row) =>
        row.reward_category === expected.rewardCategory &&
        row.reward_kind === expected.rewardKind &&
        row.shard_key === expected.shardKey,
    );
    if (!actual) {
      throw new Error(
        `Missing campaign_reward_counter_shard row for ${expected.rewardCategory}/` +
          `${expected.rewardKind}/shard ${expected.shardKey} (doc 03 §4).`,
      );
    }
    if (
      Number(actual.total_reward_value) !== Number(expected.totalRewardValue) ||
      actual.total_reward_count !== expected.totalRewardCount
    ) {
      throw new Error(
        `campaign_reward_counter_shard row for ${expected.rewardCategory}/shard ` +
          `${expected.shardKey} does not match doc 03 §4: expected ` +
          `value=${expected.totalRewardValue} count=${expected.totalRewardCount}, got ` +
          `value=${actual.total_reward_value} count=${actual.total_reward_count}.`,
      );
    }
  }

  const expiringRows = await sequelize.query<{
    reward_category: string;
    reward_kind: string;
    issued_value: string;
    expires_at: string;
  }>(
    `SELECT reward_category, reward_kind, issued_value, expires_at
       FROM reward_tracking.customer_reward_balance
      WHERE tenant_id = :tenantId AND customer_id_hash = :customerIdHash
        AND status = 'ACTIVE' AND expires_at < now() + interval '90 days'
      ORDER BY expires_at`,
    {
      type: QueryTypes.SELECT,
      replacements: { tenantId: 1, customerIdHash: 'cust-hash-A' },
    },
  );
  if (expiringRows.length !== SEED_EXPECTED_EXPIRING_BALANCE_ROWS.length) {
    throw new Error(
      `Expected ${SEED_EXPECTED_EXPIRING_BALANCE_ROWS.length} expiring customer_reward_balance ` +
        `rows for cust-hash-A, found ${expiringRows.length} (doc 03 §6).`,
    );
  }
  for (const expected of SEED_EXPECTED_EXPIRING_BALANCE_ROWS) {
    const actual = expiringRows.find(
      (row) =>
        row.reward_category === expected.rewardCategory && row.reward_kind === expected.rewardKind,
    );
    if (!actual) {
      throw new Error(
        `Missing expiring customer_reward_balance row for ${expected.rewardCategory} (doc 03 §6).`,
      );
    }
    if (
      Number(actual.issued_value) !== Number(expected.issuedValue) ||
      new Date(actual.expires_at).toISOString() !== expected.expiresAt
    ) {
      throw new Error(
        `customer_reward_balance row for ${expected.rewardCategory} does not match doc 03 §6: ` +
          `expected value=${expected.issuedValue} expiresAt=${expected.expiresAt}, got ` +
          `value=${actual.issued_value} expiresAt=${new Date(actual.expires_at).toISOString()}.`,
      );
    }
  }
}

async function main(): Promise<void> {
  // Same eager, direct `process.env` loader `main.ts`/`migrate.ts` use (T-RTS-001/002) — this CLI
  // runs standalone, outside Nest's own bootstrap.
  loadDotenvFilesIntoProcessEnv();

  const sequelize = createAppConnection();
  try {
    await sequelize.authenticate();
    await assertShardCountConfigured(sequelize);

    console.log(`\n  Seeding ${SEED_REWARD_TRACKING_EVENTS.length} event(s) from doc 03...`);
    let appliedCount = 0;
    let skippedCount = 0;
    for (const event of SEED_REWARD_TRACKING_EVENTS) {
      const applied = await seedOneEvent(sequelize, event);
      if (applied) {
        appliedCount += 1;
        console.log(`    ✓ applied  ${event.rewardEntryId} (doc row #${event.docRowNumber})`);
      } else {
        skippedCount += 1;
        console.log(
          `    · skipped  ${event.rewardEntryId} (doc row #${event.docRowNumber}) — already seeded`,
        );
      }
    }

    console.log('\n  Verifying derived tables against doc 03 §2/§4/§6...');
    await verifySeedData(sequelize);
    console.log(
      `  ✓ Verified — ${appliedCount} applied, ${skippedCount} already present, all derived ` +
        `rows match doc 03 byte-for-byte.\n`,
    );
  } finally {
    await sequelize.close();
  }
}

main().catch((err) => {
  console.error('\n  ✗ Seed failed:\n');
  console.error(err);
  process.exit(1);
});
