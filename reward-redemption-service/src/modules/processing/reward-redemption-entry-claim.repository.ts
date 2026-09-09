import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';

/**
 * T-RR-020. The exact claim SQL from `05-PROCESSING-PIPELINE.md` §3, verbatim (only the trailing
 * semicolon dropped, since `pg` doesn't need it) — do not "improve" this into a batch claim
 * (`LIMIT N > 1`) without an explicit design-doc amendment (that section's own note 1: a batch
 * claim widens the advisory-lock scope and changes the state-machine's exclusivity reasoning).
 */
const CLAIM_SQL = `
  UPDATE reward_redemption.reward_redemption_entry
  SET status = 'processing', updated_at = now()
  WHERE id = (
    SELECT id FROM reward_redemption.reward_redemption_entry
    WHERE status IN ('received', 'retrying')
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *
`;

/**
 * Raw-query repository around `reward_redemption_entry`'s claim path — deliberately not an
 * ORM-generated query (`05-PROCESSING-PIPELINE.md` §3, this task's own implementation note 1).
 *
 * Connects as the least-privilege `rr_app` role (`DB_APP_USERNAME`/`DB_APP_PASSWORD`,
 * AGENT-PROTOCOL.md R5) — never the migration role (`migration-connection.ts`'s own header: that
 * connection is for the migration CLI only, never application runtime code). No shared runtime DB
 * pool module exists anywhere in this service yet (confirmed by direct read of `src/database/**`
 * and every Wave 0 task file before this one) — this repository owns its own small `pg.Pool`
 * rather than reaching into a module that doesn't exist, mirroring how `migration-connection.ts`
 * already does the same thing for its own (different) role.
 *
 * The second constructor parameter exists solely so a unit test can substitute a fake `Pool`
 * (e.g. to prove the `ROLLBACK` path runs on a mid-transaction failure, TC-6) without opening a
 * real network connection — `@Optional()` so NestJS's own DI simply passes `undefined` when no
 * `Pool` provider is registered (the normal, real-server case), never throwing on the missing
 * provider (R2 — no `any`, no unchecked cast needed at either call site).
 */
@Injectable()
export class RewardRedemptionEntryClaimRepository implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService<Config, true>, @Optional() pool?: Pool) {
    this.pool =
      pool ??
      new Pool({
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        database: config.get('DB_NAME', { infer: true }),
        user: config.get('DB_APP_USERNAME', { infer: true }),
        password: config.get('DB_APP_PASSWORD', { infer: true }),
        ssl: config.get('DB_SSL', { infer: true }) ? { rejectUnauthorized: false } : undefined,
      });
  }

  /**
   * Atomically claims one `received`/`retrying` row, or returns `null` if none is eligible right
   * now — an empty result is a normal, expected outcome (implementation note 5), never an error.
   *
   * The advisory lock is acquired immediately after the claim, inside the same short-lived
   * transaction, and is released the instant that transaction commits — never held across
   * anything past this method's own return (`05-PROCESSING-PIPELINE.md` §3's emphatic rule, this
   * task's implementation note 2). Any failure between `BEGIN` and `COMMIT` rolls the whole
   * transaction back, leaving the row exactly as it was (TC-6) — Postgres's own transactional
   * guarantee, not anything this method has to implement itself.
   */
  async claimNext(): Promise<RewardRedemptionEntryRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<RewardRedemptionEntryRow>(CLAIM_SQL);
      if (!result.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const claimed = result.rows[0];
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [claimed.id]);
      await client.query('COMMIT');
      return claimed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
