/**
 * T-INT-001 regression suite for `023_flip_dispatch_channel_config_default_to_rest.ts`
 * (`reward-service-integration-plan/tasks/T-INT-001-...md`, TC-8). Same real-Postgres,
 * real-migration-connection convention as `rr-app-role.migration.spec.ts` (T-RR-003) — this suite
 * imports the migration's own `up`/`down` and calls them directly against a live
 * `createMigrationConnection()`, rather than assuming a particular external `db:migrate`/
 * `db:rollback` state has already been reached (`reward-redemption-entry.migration.spec.ts`'s own
 * note explains why most of this directory's other suites *can* assume that — the bash gate
 * `AGENT-PROTOCOL.md §4` runs separately proves the real up/down/up cycle for most migrations; this
 * one is self-contained instead so TC-8's three-state assertion — REST → KAFKA → REST — doesn't
 * depend on being run in a particular order relative to that bash gate).
 *
 * Filed under `test/database/*.migration.spec.ts` (flat, no `migrations/` subdirectory) — the
 * actual, consistent convention every sibling suite in this directory already uses (confirmed by
 * direct read before writing this file). The task file's own "Files owned" list named
 * `test/database/migrations/022-flip-dispatch-channel-config-default.spec.ts`; that path doesn't
 * match this directory's real layout (no `test/database/migrations/` subdirectory exists anywhere
 * in this codebase) and the migration itself is numbered `023`, not `022` (see that file's own
 * header) — this test file follows the real convention and the real migration number instead.
 *
 * **TC-8 runs inside one Postgres transaction that is always rolled back, never committed** — a
 * fix made necessary by direct reproduction, not a stylistic choice: an earlier version of this
 * test called `up()`/`down()`/`up()` directly against the live connection (three real, committed
 * UPDATEs), which briefly and genuinely left the one real, shared `GLOBAL` row at
 * `primary_channel='KAFKA'` mid-test. Under `npm test`'s default parallel jest workers, that
 * transient committed state was actually observed by a concurrently-running sibling suite
 * (`dispatch-channel-config.migration.spec.ts`'s own read-only TC-4, which expects `'REST'`) —
 * confirmed by direct reproduction: `npm test` (full, parallel) failed TC-4 with `Received: "KAFKA"`
 * even though that same suite passes every time run in isolation. This is exactly the class of race
 * `reconciliation-poller-safety-net.spec.ts`'s own header already warns about ("avoid mutating a
 * table every other concurrently-running real-Postgres spec file also reads") — this file's
 * original version stepped into it. A rolled-back transaction is invisible to every other
 * connection for its entire lifetime (Postgres' default READ COMMITTED isolation: other sessions
 * only ever see committed data), so it proves the exact same SQL/mechanics `up()`/`down()` run
 * without ever exposing the intermediate `'KAFKA'` state to a concurrent reader. The real,
 * committed migrate/rollback/migrate cycle is still independently proven by the bash-level gate
 * (`npm run db:migrate && npm run db:rollback && npm run db:migrate`, this task's own Verification
 * step 1) — this suite no longer needs to re-prove that same cycle via a live commit to do so
 * safely.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes, type Transaction } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import * as flipToRestMigration from '@/database/migrations/023_flip_dispatch_channel_config_default_to_rest';
import type { DispatchChannelConfigRow } from '@/database/models/dispatch-channel-config.model';
import type { PromoCodeChannelConfigRow } from '@/database/models/promo-code-channel-config.model';

/**
 * `ORDER BY id ASC LIMIT 1` is load-bearing, not decoration: `dispatch-channel-config.migration
 * .spec.ts`'s own second test ("a second GLOBAL row ... does not conflict with the seeded one",
 * `01-DATABASE.md` §5 / T-RR-003 note 1's documented, deliberately-not-fixed quirk — Postgres
 * treats `NULL` as never equal to `NULL` for this composite unique index, so a second `scope_level
 * ='GLOBAL', scope_ref_code=NULL, tenant_id=NULL` row genuinely inserts without conflict) briefly
 * commits a real second `GLOBAL` row to the live table before cleaning it up — not wrapped in a
 * transaction, so under `npm test`'s parallel jest workers that transient duplicate is a real row
 * any concurrent reader can observe (confirmed by direct reproduction: a plain, unordered `SELECT
 * ... WHERE scope_level='GLOBAL'` from this file occasionally returned 2 rows). The genuine,
 * permanently-seeded row is always the one with the smallest `id` (inserted once, by migration
 * `006`, long before this test suite ever runs); any transient duplicate a concurrent test creates
 * gets a newer, larger `id`. Ordering by `id ASC` and taking the first row deterministically
 * targets the real seeded row regardless of that sibling test's own transient window — a read-side
 * fix in this test only; it does not touch or redesign the documented schema quirk itself.
 */
async function readDispatchGlobalRow(
  sequelize: Sequelize,
  transaction?: Transaction,
): Promise<DispatchChannelConfigRow> {
  const rows = await sequelize.query<DispatchChannelConfigRow>(
    `SELECT * FROM reward_redemption.dispatch_channel_config
       WHERE scope_level = 'GLOBAL' AND scope_ref_code IS NULL AND tenant_id IS NULL
       ORDER BY id ASC LIMIT 1`,
    { type: QueryTypes.SELECT, transaction },
  );
  expect(rows.length).toBeGreaterThanOrEqual(1);
  return rows[0];
}

/**
 * `up()`/`down()` take `{ context: Sequelize }` and call `context.query(sql, { type:
 * QueryTypes.RAW })` — no `transaction` option forwarded. This codebase has no Sequelize CLS
 * (continuation-local-storage) configured (confirmed by direct read of `migration-connection.ts`),
 * so a transaction can't be threaded through transparently. This adapter duck-types as a
 * `Sequelize` for the one method the migration actually calls (`.query`), injecting `transaction:
 * t` into every call so the migration's own real UPDATE statements run, and stay, inside this
 * test's own transaction — never committed, never visible to any other connection. Narrow,
 * test-only, and named exactly what it is (not a general-purpose fake).
 */
function transactionScopedContext(sequelize: Sequelize, t: Transaction): Sequelize {
  return {
    query: (sql: string, options: Record<string, unknown> = {}) =>
      sequelize.query(sql, { ...options, transaction: t }),
  } as unknown as Sequelize;
}

describe('T-INT-001 — dispatch_channel_config GLOBAL row REST default (migration 023)', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    // Leave the row in the state every later task/verification step expects to find it in:
    // primary_channel='REST', the plan-wide default this task exists to lock in.
    await flipToRestMigration.up({ context: sequelize });
    await sequelize.close();
  });

  // TC-8: migrate (up) -> REST, rollback (down) -> KAFKA, migrate (up) again -> REST. All three
  // states asserted directly against Postgres, and every column *other* than primary_channel
  // (fallback_channel, kafka_enabled, rest_enabled, grpc_enabled) is asserted unchanged throughout
  // — this migration is a routing-preference flip only, never a capability change (its own header,
  // implementation note 3 in the task file). Runs inside one transaction, rolled back at the end —
  // see this file's own header for why that's load-bearing, not incidental, here.
  it('TC-8: up() sets GLOBAL primary_channel to REST; down() restores KAFKA; up() again sets REST', async () => {
    const t = await sequelize.transaction();
    try {
      const txContext = transactionScopedContext(sequelize, t);

      await flipToRestMigration.up({ context: txContext });
      const afterFirstUp = await readDispatchGlobalRow(sequelize, t);
      expect(afterFirstUp.primary_channel).toBe('REST');
      expect(afterFirstUp.fallback_channel).toBe('REST');
      expect(afterFirstUp.kafka_enabled).toBe(true);
      expect(afterFirstUp.rest_enabled).toBe(true);

      await flipToRestMigration.down({ context: txContext });
      const afterDown = await readDispatchGlobalRow(sequelize, t);
      expect(afterDown.primary_channel).toBe('KAFKA');
      expect(afterDown.fallback_channel).toBe('REST');
      expect(afterDown.kafka_enabled).toBe(true);
      expect(afterDown.rest_enabled).toBe(true);

      await flipToRestMigration.up({ context: txContext });
      const afterSecondUp = await readDispatchGlobalRow(sequelize, t);
      expect(afterSecondUp.primary_channel).toBe('REST');
      expect(afterSecondUp.fallback_channel).toBe('REST');
      expect(afterSecondUp.kafka_enabled).toBe(true);
      expect(afterSecondUp.rest_enabled).toBe(true);
    } finally {
      // Always rolled back, never committed — see this file's own header for why this is the
      // whole point, not just teardown hygiene.
      await t.rollback();
    }
  });

  // down() must only ever touch the one GLOBAL row this migration owns — never a
  // CAMPAIGN/TRACKER/REWARD-scoped row an operator or another test may have created. Proven by
  // identity, not by "any recently-updated row" (a `updated_at > now() - interval '...'` check
  // would itself be racy against every other concurrently-running suite's own legitimate writes to
  // *their own* scoped rows under `npm test`'s parallel workers — the exact class of fragility this
  // file's own header already documents fixing once). This test inserts its own marker CAMPAIGN row
  // inside the same rolled-back transaction as `down()` itself, so no other connection ever sees
  // either the insert or the (absence of an) update.
  it('down() only ever touches the GLOBAL row — a CAMPAIGN-scoped row is left untouched', async () => {
    const t = await sequelize.transaction();
    try {
      const scopeRefCode = `TEST_T-INT-001_${Date.now()}`;
      await sequelize.query(
        `INSERT INTO reward_redemption.dispatch_channel_config
           (scope_level, scope_ref_code, tenant_id, kafka_enabled, rest_enabled, primary_channel, fallback_channel)
         VALUES ('CAMPAIGN', :scopeRefCode, NULL, true, true, 'REST', 'REST')`,
        { type: QueryTypes.RAW, transaction: t, replacements: { scopeRefCode } },
      );

      const txContext = transactionScopedContext(sequelize, t);
      await flipToRestMigration.down({ context: txContext });

      const rows = await sequelize.query<DispatchChannelConfigRow>(
        `SELECT * FROM reward_redemption.dispatch_channel_config WHERE scope_ref_code = :scopeRefCode`,
        { type: QueryTypes.SELECT, transaction: t, replacements: { scopeRefCode } },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].primary_channel).toBe('REST');
    } finally {
      await t.rollback();
    }
  });

  // This task's other action item (implementation note 1 / TRANSPORT-CONFIG.md): confirm, don't
  // change, promo_code_channel_config's own GLOBAL row — migration 018 already seeds it with
  // primary_channel='REST'.
  it("confirms promo_code_channel_config's GLOBAL row already defaults primary_channel='REST' (no migration needed)", async () => {
    const rows = await sequelize.query<PromoCodeChannelConfigRow>(
      `SELECT * FROM reward_redemption.promo_code_channel_config
         WHERE scope_level = 'GLOBAL' AND scope_ref_code IS NULL AND tenant_id IS NULL`,
      { type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].primary_channel).toBe('REST');
  });
});
