/**
 * T-RTS-010. Resolves `tracking.campaignCounterShardCount` (`brain-storm/02-DATA-MODEL.md` §4) —
 * `campaign_reward_counter_shard`'s own shard count `N` — from `reward_tracking.service_config`,
 * `GLOBAL` scope only (this is an infra concern, not a per-campaign business rule, per that section's
 * own note). Resolved once (lazily, on first call) and cached in-process for the lifetime of this
 * instance, never re-read per event (implementation note 3) — same "resolve-with-a-logged-default-
 * on-not-found, cache, don't re-read per operation" discipline every sibling service's own
 * `service_config`-adjacent resolver already follows (e.g.
 * `reward-redemption-service/src/modules/dispatch/dispatch.config.ts`'s `resolveKafkaAttemptsBeforeFallback`).
 *
 * No generic `ServiceConfigResolverService` exists anywhere in this service yet (confirmed by a
 * direct grep across every `reward-tracking-service-plan/tasks/*.md` file — no task builds one), and
 * this task's own "Files owned" list names only this one file for the concern, so this resolver reads
 * `reward_tracking.service_config` directly via its own small `pg.Pool` rather than depending on
 * infrastructure that doesn't exist.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';

/** `brain-storm/02-DATA-MODEL.md` §4's own confirmed default, also T-RTS-002's own seed value. */
export const DEFAULT_SHARD_COUNT = 32;

const SHARD_COUNT_CONFIG_KEY = 'tracking.campaignCounterShardCount';

/** Thrown when `service_config.config_value` for this key exists but isn't a positive integer — a
 * data error worth surfacing loudly (R2), never silently coerced to the default. */
export class InvalidShardCountConfigError extends Error {
  constructor(rawValue: string) {
    super(
      `reward_tracking.service_config row for "${SHARD_COUNT_CONFIG_KEY}" (GLOBAL scope) has ` +
        `config_value=${JSON.stringify(rawValue)}, which is not a positive integer.`,
    );
    this.name = 'InvalidShardCountConfigError';
  }
}

@Injectable()
export class ShardCountResolverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShardCountResolverService.name);
  private readonly pool: Pool;
  private cached: number | null = null;
  private inFlight: Promise<number> | null = null;

  /** Second constructor parameter exists solely so a test can substitute a real (test-owned) or
   * fake `Pool`, same `@Optional()` idiom every repository in this project family already uses. */
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

  /** Pre-warms the cache at real application boot — never required for correctness (`resolve()` is
   * self-initializing), only so the very first real ingestion call doesn't pay the lookup cost. */
  async onModuleInit(): Promise<void> {
    await this.resolve();
  }

  /**
   * Returns the resolved, cached shard count. TC-6: an unseeded key falls back to
   * `DEFAULT_SHARD_COUNT` with a one-time warn log — "one-time" because the fallback value itself is
   * cached exactly like a real resolved value, so a second call never re-queries or re-logs.
   */
  async resolve(): Promise<number> {
    if (this.cached !== null) {
      return this.cached;
    }
    if (!this.inFlight) {
      this.inFlight = this.resolveFromDb();
    }
    const value = await this.inFlight;
    this.cached = value;
    return value;
  }

  private async resolveFromDb(): Promise<number> {
    const result = await this.pool.query<{ config_value: string }>(
      `SELECT config_value FROM reward_tracking.service_config
        WHERE config_key = $1 AND scope_level = 'GLOBAL'
        LIMIT 1`,
      [SHARD_COUNT_CONFIG_KEY],
    );
    if (result.rowCount === 0) {
      this.logger.warn(
        `service_config key "${SHARD_COUNT_CONFIG_KEY}" (GLOBAL scope) is not seeded — using ` +
          `default ${DEFAULT_SHARD_COUNT}.`,
      );
      return DEFAULT_SHARD_COUNT;
    }
    const raw = result.rows[0].config_value;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
      throw new InvalidShardCountConfigError(raw);
    }
    return parsed;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
