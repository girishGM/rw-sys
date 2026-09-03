/**
 * T-RAP-013. `ServiceConfigResolver` — the one resolution mechanism every current and future
 * configurable knob in this service reads through (`06-CONFIGURABILITY-AND-OBSERVABILITY.md`
 * §2), backed by `service_config` (`01-DATABASE.md` §11). First-match-wins precedence:
 * campaign-scoped row → tenant-scoped → country-scoped → global (`scope_ref IS NULL`) — the
 * exact same order and the exact same "degrade gracefully when part of the context is
 * unavailable" behaviour `LogRedactorService` (T-RAP-012) already implements, deliberately, so
 * there is exactly one mental model for "how does scoped config work in this service"
 * (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §1-§2).
 *
 * **Out of this task's scope:** wiring the typed wrappers below into their actual call sites
 * (e.g. `ReconciliationPollerService`'s currently-hardcoded `RECONCILIATION_POLL_INTERVAL_MS`) —
 * each later/sibling task reads through this resolver itself, per its own module's needs. This
 * task only builds and tests the resolver and its cache-refresh hook.
 *
 * The in-memory rule map is (re)built by `refresh()`, called once at process start
 * (`onModuleInit`) and re-callable by whatever cache-refresh trigger T-RAP-011 wires up later
 * (same "piggybacks on the same refresh trigger as campaign config" trigger this task's own spec
 * describes, identical to `LogRedactorService`'s own `refresh()` hook).
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigScopeLevel } from '@/database/models/field-encryption-config.model';
import type { ServiceConfigRow } from '@/database/models/service-config.model';
import { ServiceConfigRepository } from './service-config.repository';

export interface ServiceConfigContext {
  campaignCode?: string;
  tenantId?: number;
  countryCode?: string;
}

/** The seeded config keys (`01-DATABASE.md` §11's own examples) this task's typed convenience
 * wrappers read. A future knob is a new `config_key` read via the generic `resolve()`, not a new
 * resolution mechanism (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §2) — this constant object
 * exists purely to avoid repeating the literal string in more than one place. */
export const SERVICE_CONFIG_KEYS = {
  RECONCILIATION_POLL_INTERVAL_SECONDS: 'reconciliation_poll_interval_seconds',
  REWARD_DISPATCH_MAX_RETRY_ATTEMPTS: 'reward_dispatch_max_retry_attempts',
  ADVISORY_LOCK_WAIT_TIMEOUT_MS: 'advisory_lock_wait_timeout_ms',
  DEDUP_COMPOSITE_FALLBACK_ENABLED: 'dedup_composite_fallback_enabled',
} as const;

function ruleKey(scopeLevel: ConfigScopeLevel, scopeRef: string | null, configKey: string): string {
  return `${scopeLevel}::${scopeRef ?? ''}::${configKey}`;
}

function describeRow(row: ServiceConfigRow): string {
  return `service_config row id=${row.id} (config_key="${row.config_key}", scope_level="${row.scope_level}", scope_ref=${row.scope_ref === null ? 'NULL' : `"${row.scope_ref}"`})`;
}

@Injectable()
export class ServiceConfigResolverService implements OnModuleInit {
  private readonly logger = new Logger(ServiceConfigResolverService.name);
  private rules = new Map<string, ServiceConfigRow>();

  constructor(private readonly repository: ServiceConfigRepository) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** Reloads the in-memory config table from `service_config` in full — a small, config-sized
   * table (never per-tenant/per-activity scaled), so a full reload is simpler and cheap enough to
   * not need an incremental diff. Read on nearly every processing-pipeline transaction
   * (T-RAP-033/034), so this must never be a live DB round-trip per lookup — same reasoning as
   * `LogRedactorService.refresh()`. */
  async refresh(): Promise<void> {
    const rows = await this.repository.findAll();
    const next = new Map<string, ServiceConfigRow>();
    for (const row of rows) {
      next.set(ruleKey(row.scope_level, row.scope_ref, row.config_key), row);
    }
    this.rules = next;
    this.logger.log(`service_config reloaded: ${next.size} row(s)`);
  }

  /**
   * First-match-wins precedence, exactly `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §2's order:
   * campaign-scoped → tenant-scoped → country-scoped → global. Degrades gracefully when part of
   * `context` is unavailable — a level with no context value to check is simply skipped, falling
   * through to the next.
   */
  private resolveRow(
    configKey: string,
    context: ServiceConfigContext,
  ): ServiceConfigRow | undefined {
    if (context.campaignCode !== undefined) {
      const match = this.rules.get(ruleKey('campaign', context.campaignCode, configKey));
      if (match !== undefined) {
        return match;
      }
    }
    if (context.tenantId !== undefined) {
      const match = this.rules.get(ruleKey('tenant', String(context.tenantId), configKey));
      if (match !== undefined) {
        return match;
      }
    }
    if (context.countryCode !== undefined) {
      const match = this.rules.get(ruleKey('country', context.countryCode, configKey));
      if (match !== undefined) {
        return match;
      }
    }
    return this.rules.get(ruleKey('global', null, configKey));
  }

  /**
   * TC-4: an unconfigured key throws a clear, named error rather than returning `undefined`
   * silently — a caller that forgets this and does `resolve(...) as unknown as number` would
   * otherwise get `NaN`/`0` behaviour exactly like the malformed-value case this resolver also
   * guards against (implementation note 2).
   */
  resolve(configKey: string, context: ServiceConfigContext = {}): string {
    const row = this.resolveRow(configKey, context);
    if (row === undefined) {
      throw new Error(
        `Unconfigured service_config key "${configKey}": no row at any scope (campaign, tenant, ` +
          'country or global) matched the given context.',
      );
    }
    return row.config_value;
  }

  /**
   * Shared validator behind every typed integer wrapper below. TC-5: a malformed `config_value`
   * fails loudly, naming the offending row, rather than silently coercing to `NaN`/`0` and
   * causing a tight poll loop or an instant-retry-exhaustion bug (implementation note 2's own
   * reasoning for why every seeded integer knob here must be a positive integer).
   */
  private resolvePositiveInt(configKey: string, context: ServiceConfigContext): number {
    const row = this.resolveRow(configKey, context);
    if (row === undefined) {
      throw new Error(
        `Unconfigured service_config key "${configKey}": no row at any scope (campaign, tenant, ` +
          'country or global) matched the given context.',
      );
    }
    const parsed = Number(row.config_value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid service_config value for "${configKey}": expected a positive integer, got ` +
          `${JSON.stringify(row.config_value)} (${describeRow(row)}).`,
      );
    }
    return parsed;
  }

  /** Shared validator behind every typed boolean wrapper below — same "fail loudly, name the
   * offending row" discipline as `resolvePositiveInt`, for a strict `'true'`/`'false'` literal
   * rather than any other truthy/falsy coercion. */
  private resolveBoolean(configKey: string, context: ServiceConfigContext): boolean {
    const row = this.resolveRow(configKey, context);
    if (row === undefined) {
      throw new Error(
        `Unconfigured service_config key "${configKey}": no row at any scope (campaign, tenant, ` +
          'country or global) matched the given context.',
      );
    }
    if (row.config_value === 'true') {
      return true;
    }
    if (row.config_value === 'false') {
      return false;
    }
    throw new Error(
      `Invalid service_config value for "${configKey}": expected "true" or "false", got ` +
        `${JSON.stringify(row.config_value)} (${describeRow(row)}).`,
    );
  }

  /** Seconds between `ReconciliationPollerService` full-tenant `ListActiveCampaigns` sweeps
   * (`04-CACHE-INVALIDATION.md` §3). Default seeded by T-RAP-003: 300 (global). */
  getReconciliationPollIntervalSeconds(context: ServiceConfigContext = {}): number {
    return this.resolvePositiveInt(
      SERVICE_CONFIG_KEYS.RECONCILIATION_POLL_INTERVAL_SECONDS,
      context,
    );
  }

  /** Maximum `reward_dispatch_retry` attempts before a dispatch is considered permanently failed
   * (`ARCHITECTURE.md` §9, `05-PROCESSING-PIPELINE.md` §7). Default seeded by T-RAP-003: 8
   * (global). */
  getRewardDispatchMaxRetryAttempts(context: ServiceConfigContext = {}): number {
    return this.resolvePositiveInt(SERVICE_CONFIG_KEYS.REWARD_DISPATCH_MAX_RETRY_ATTEMPTS, context);
  }

  /** Milliseconds `pg_advisory_xact_lock` waits before giving up (`01-DATABASE.md` §12).
   * Default seeded by T-RAP-003: 5000 (global). */
  getAdvisoryLockWaitTimeoutMs(context: ServiceConfigContext = {}): number {
    return this.resolvePositiveInt(SERVICE_CONFIG_KEYS.ADVISORY_LOCK_WAIT_TIMEOUT_MS, context);
  }

  /** Whether the composite-key dedup fallback (`05-PROCESSING-PIPELINE.md` §2) is enabled.
   * Default seeded by T-RAP-003: `true` (global). */
  getDedupCompositeFallbackEnabled(context: ServiceConfigContext = {}): boolean {
    return this.resolveBoolean(SERVICE_CONFIG_KEYS.DEDUP_COMPOSITE_FALLBACK_ENABLED, context);
  }
}
