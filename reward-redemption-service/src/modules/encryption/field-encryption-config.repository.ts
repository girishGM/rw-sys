/**
 * T-RR-005. Repository for `reward_redemption.field_encryption_config` (`01-DATABASE.md` §10) —
 * a single, global on/off switch per `field_name` (this service's own, simpler shape than RAP's
 * scope-leveled table of the same name — see `008_create_field_encryption_config.ts`'s own header
 * for the deviation T-RR-003 already flagged against this task's stale "confirmed identical to
 * RAP" note).
 *
 * Owns its own small `pg.Pool`, connected as the least-privilege `rr_app` role
 * (`DB_APP_USERNAME`/`DB_APP_PASSWORD`, `AGENT-PROTOCOL.md` R5) — matching
 * `RewardRedemptionEntryClaimRepository`'s own precedent (`src/modules/processing/reward-redemption-entry-claim.repository.ts`):
 * no shared runtime DB pool module exists anywhere in this service, so this repository owns one
 * rather than reaching for a module that doesn't exist.
 *
 * **This is the "gates encryption on a live DB flag" half of implementation note 5.** `isEnabled`
 * is the one place that flag is read; any later caller (T-RR-010's `RewardIngestionService`, the
 * only in-scope consumer named by this task's own "Out" section) is documented here as the
 * *contract holder* responsible for checking it before invoking `EncryptionService.encrypt` on a
 * given field — `EncryptionService` itself stays a pure, field-agnostic crypto primitive (see that
 * file's own header) and never reads this table itself. This is deliberately a documented
 * *caller* contract, not a change woven into `EncryptionService`, matching TC-9's own wording
 * ("`EncryptionService` (or its caller, per this module's own documented contract)").
 */
import { Injectable, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type { FieldEncryptionConfigRow } from '@/database/models/field-encryption-config.model';

@Injectable()
export class FieldEncryptionConfigRepository implements OnModuleDestroy {
  private readonly pool: Pool;

  /**
   * The second constructor parameter exists solely so a unit/integration test can substitute a
   * real (but test-owned) `Pool`, mirroring `RewardRedemptionEntryClaimRepository`'s own
   * `@Optional() pool?: Pool` precedent — NestJS's DI simply passes `undefined` in the normal,
   * real-server case.
   */
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
   * Whether `fieldName` is currently configured as encrypted/redact-worthy. **Fails safe to
   * `true` when no row exists for `fieldName`** — R8's "`customerId` is encrypted + hashed at
   * rest, always" means the absence of an explicit row must never be read as "this field is
   * exempt"; only an explicit `enabled = false` row turns the switch off. (No seed/migration in
   * this service currently inserts the `('customerId', true)` row this task's own note 5 assumed
   * already exists — `008_create_field_encryption_config.ts`'s own header already flagged that the
   * table's *shape* diverged from the task file's stale assumption; this is the matching runtime
   * consequence: today, every `field_name` starts unconfigured, and this fail-safe default is what
   * keeps that state equivalent to "encryption enabled" rather than silently equivalent to
   * "disabled".)
   */
  async isEnabled(fieldName: string): Promise<boolean> {
    const result = await this.pool.query<Pick<FieldEncryptionConfigRow, 'enabled'>>(
      'SELECT enabled FROM reward_redemption.field_encryption_config WHERE field_name = $1',
      [fieldName],
    );
    if (result.rowCount === 0) {
      return true;
    }
    return result.rows[0].enabled;
  }

  /** Every configured row — used by tests and any future admin/read surface, not by `isEnabled`
   * itself (which queries directly by `field_name` rather than loading everything into memory). */
  async findAll(): Promise<FieldEncryptionConfigRow[]> {
    const result = await this.pool.query<FieldEncryptionConfigRow>(
      'SELECT * FROM reward_redemption.field_encryption_config ORDER BY field_name',
    );
    return result.rows;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
