/**
 * T-RR-007. `06-CACHING-AND-TENANT-CONFIG.md` §4's periodic reconciliation safety net — a dumb,
 * wholly independent refresh loop that re-fetches all four caches this task owns on its own
 * clock, regardless of whether any individual read has happened since the last cycle. Unlike RAP's
 * own `ReconciliationPollerService`, this one has no push mechanism underneath it (§4's own
 * explicit contrast) — TTL + the invalidation endpoint + this poller are the *entire* freshness
 * mechanism here. Do not add a watch/push mechanism "to match RAP".
 *
 * Lifecycle shape (`OnApplicationBootstrap`/`OnModuleDestroy`, a cancellable `sleep()`) mirrors
 * `ClaimWorkerService` (T-RR-020, `../processing/claim-worker.service.ts`) — the one polling-loop
 * precedent already established in this codebase.
 *
 * **A refresh failure (e.g. `cache.reconciliationPoll.intervalSeconds`/a `cache.ttl.*.seconds` row
 * not yet seeded in a given environment — no task in this plan currently owns seeding
 * `service_config`) is logged and the loop keeps going**, exactly like `ClaimWorkerService`'s own
 * "an infrastructure hiccup is not a reason to crash the whole worker" precedent — never a reason
 * to crash the whole process, since a stale cache is a staleness risk (§4's own accepted
 * trade-off), not a correctness one.
 *
 * **T-RR-054 deliberately still does NOT add `CampaignConfigCache` (the fifth cache,
 * `../processing/campaign-config.cache.ts`, T-RR-022's own) to `this.caches` here**, even though
 * T-RR-055 has since fixed the real-Nest-DI defect that previously blocked this entirely (see this
 * task's own header history / T-RR-054's completion report). The remaining reason is structural,
 * not a leftover blocker: wiring it in would require this module (`tenant-schema-cache.module.ts`)
 * to import `ProcessingModule` — but `ProcessingModule` already imports `TenantSchemaCacheModule`
 * (for `ServiceConfigCache`), so that second import direction is a genuine circular module
 * dependency. Resolving it safely (NestJS `forwardRef()` on both sides) needs a matching edit to
 * `processing.module.ts`, which is `agent-rr-processing`'s file scope, not this task's (R3) — a
 * two-sided edit T-RR-054's own "Files owned" list deliberately excludes `processing.module.ts`
 * from, confirming this was scoped as optional/follow-up work, not part of this defect's fix.
 * `campaignConfig` relies on its own TTL (§2) and the invalidation endpoint's real, active handling
 * (§3, wired by this same task in `cache-invalidation.module.ts`) — not this poller. Revisit as its
 * own small follow-up task if a shorter reconciliation window for `campaignConfig` is ever needed.
 */
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { RECONCILIATION_POLL_INTERVAL_CONFIG_KEY } from './cache-ttl-config-keys';
import { DispatchChannelConfigCache } from './dispatch-channel-config.cache';
import { ExternalRewardSystemConfigCache } from './external-reward-system-config.cache';
import type { InvalidatableCache } from './invalidatable-cache.interface';
import { ServiceConfigCache } from './service-config.cache';
import { TenantSchemaConfigCache } from './tenant-schema-config.cache';

/** §4's own documented default (`300` seconds) — used both as the seeded `GLOBAL` row's intended
 * value and as this service's own in-process fallback when that row can't be resolved yet (see
 * this file's own header). */
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 300_000;

@Injectable()
export class ReconciliationPollerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationPollerService.name);
  private readonly caches: readonly InvalidatableCache[];
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private stopSignal: (() => void) | null = null;

  constructor(
    tenantSchemaConfigCache: TenantSchemaConfigCache,
    externalRewardSystemConfigCache: ExternalRewardSystemConfigCache,
    dispatchChannelConfigCache: DispatchChannelConfigCache,
    private readonly serviceConfigCache: ServiceConfigCache,
  ) {
    this.caches = [
      tenantSchemaConfigCache,
      externalRewardSystemConfigCache,
      dispatchChannelConfigCache,
      this.serviceConfigCache,
    ];
  }

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.loopPromise = this.pollLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.stopSignal?.();
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      await this.refreshOnce();
      if (this.stopped) {
        break;
      }
      const intervalMs = await this.resolveIntervalMs();
      await this.sleep(intervalMs);
    }
  }

  private async refreshOnce(): Promise<void> {
    await Promise.all(
      this.caches.map(async (cache) => {
        try {
          await cache.refreshAll();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Reconciliation refresh failed for ${cache.constructor.name}: ${message}`,
          );
        }
      }),
    );
  }

  private async resolveIntervalMs(): Promise<number> {
    try {
      const seconds = await this.serviceConfigCache.resolve(
        RECONCILIATION_POLL_INTERVAL_CONFIG_KEY,
        'int',
        {},
      );
      return seconds * 1000;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not resolve ${RECONCILIATION_POLL_INTERVAL_CONFIG_KEY} (${message}) — ` +
          `falling back to the ${DEFAULT_RECONCILIATION_INTERVAL_MS}ms default.`,
      );
      return DEFAULT_RECONCILIATION_INTERVAL_MS;
    }
  }

  /** Resolves after `ms`, or immediately if `onModuleDestroy` is called first — same idiom as
   * `ClaimWorkerService.sleep`. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      this.stopSignal = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
