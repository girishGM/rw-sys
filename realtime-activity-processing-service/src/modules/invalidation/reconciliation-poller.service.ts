/**
 * T-RAP-011. Reconciliation poller — `04-CACHE-INVALIDATION.md` §3's safety net for a missed
 * `WatchCampaignConfig` event: independently of the stream, call `ListActiveCampaigns` for every
 * configured tenant on a fixed interval (default 300s / 5 minutes — see `invalidation.config.ts`'s
 * own TODO for why this is a hardcoded default rather than a `service_config` read yet), diff each
 * returned campaign's `etag` against the locally cached one, and refresh (via
 * `CampaignConfigCacheService.applyCampaignConfig`) only the campaigns that actually differ
 * (implementation note 4, TC-3/TC-4). Also runs once, immediately, at startup.
 *
 * **Deliberately calls `CampaignConfigClient.listActiveCampaigns` directly, not
 * `CampaignConfigCacheService.warmTenant`.** `warmTenant` (T-RAP-010) unconditionally re-applies
 * every campaign it's handed — exactly the right behaviour for a cold start or a post-reconnect
 * full re-warm (`WatchStreamConsumer`'s own job), but it would defeat "refresh only what differs"
 * here (TC-4: "that campaign, and only that campaign, is refreshed"). Implementation note 4's "this
 * is the same call T-RAP-010 already makes at boot; reuse it, don't duplicate the fetch logic"
 * refers to reusing `CampaignConfigClient.listActiveCampaigns` itself (already built, exported by
 * T-RAP-010) rather than hand-rolling a second `@grpc/proto-loader` call here — not to routing
 * through `warmTenant`'s own unconditional-apply behaviour.
 *
 * **Known gap, flagged rather than silently fixed** (`AGENT-PROTOCOL.md` §3, "implement to spec,
 * flag the flaw"): a campaign that vanishes entirely from a fresh `ListActiveCampaigns` response
 * (ended/archived, never returned again at all) is not separately detected by *this* poller —
 * that vanish-detection logic (`CampaignConfigCacheService.markCampaignVanished`) is `private`,
 * reserved for `warmTenant`'s own cold-start/post-reconnect full-rewarm path. `WatchStreamConsumer`
 * still catches an ended campaign on every stream reconnect (which calls `warmTenant`), and a live
 * `ENDED` event is handled directly by `WatchStreamConsumer.handleEvent`; the one gap is a
 * campaign whose `ENDED` event is missed *and* whose instance's stream never disconnects for a
 * full interval — this poller alone would not catch that case, only report "no drift" for the
 * campaigns still present. Left for the architect to decide whether `markCampaignVanished`/
 * `campaignCodesForTenant` should be made public for this poller to call too; not done here
 * because both live in `campaign-config-cache.service.ts`, outside this task's own "Files owned"
 * (that file belongs to the already-`done` T-RAP-010), and no test case in this task's own file
 * requires it.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  ALL_CONFIG_SECTIONS,
  CampaignConfigClient,
} from '../campaign-cache/campaign-config.client';
import {
  CampaignConfigCacheService,
  resolveConfiguredTenantIds,
} from '../campaign-cache/campaign-config-cache.service';
import {
  DEFAULT_RECONCILIATION_POLL_INTERVAL_MS,
  RECONCILIATION_POLL_INTERVAL_MS,
  RECONCILIATION_POLLER_AUTOSTART,
} from './invalidation.config';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class ReconciliationPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationPollerService.name);
  private timer: NodeJS.Timeout | null = null;
  /** Guards against a slow cycle overlapping the next `setInterval` tick. */
  private cycleInFlight: Promise<void> | null = null;

  constructor(
    private readonly client: CampaignConfigClient,
    private readonly cache: CampaignConfigCacheService,
    @Inject(RECONCILIATION_POLL_INTERVAL_MS)
    private readonly pollIntervalMs: number = DEFAULT_RECONCILIATION_POLL_INTERVAL_MS,
    @Inject(RECONCILIATION_POLLER_AUTOSTART) private readonly autostart: boolean = true,
  ) {}

  onModuleInit(): void {
    // Implementation note 4: "also once, immediately, at startup."
    this.runOnce().catch((error: unknown) => {
      this.logger.error(`Initial reconciliation poll failed: ${describeError(error)}`);
    });
    if (this.autostart) {
      this.start();
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => {
        this.logger.error(`Reconciliation poll cycle threw unexpectedly: ${describeError(error)}`);
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One poll cycle across every configured tenant — exposed so tests drive it deterministically
   * instead of racing `setInterval`, same discipline as `OutboxPublisherWorker.runOnce()`.
   */
  async runOnce(): Promise<void> {
    if (this.cycleInFlight) {
      return this.cycleInFlight;
    }
    this.cycleInFlight = this.doRunOnce().finally(() => {
      this.cycleInFlight = null;
    });
    return this.cycleInFlight;
  }

  private async doRunOnce(): Promise<void> {
    const tenantIds = resolveConfiguredTenantIds();
    // Sequential by design, matching T-RAP-010's own bootstrap loop — small tenant count, no need
    // for the added complexity of a concurrent fetch here.
    for (const tenantId of tenantIds) {
      await this.reconcileTenant(tenantId);
    }
  }

  private async reconcileTenant(tenantId: number): Promise<void> {
    let list;
    try {
      list = await this.client.listActiveCampaigns(tenantId, ALL_CONFIG_SECTIONS);
    } catch (error) {
      this.logger.warn(
        `Reconciliation ListActiveCampaigns failed for tenant ${tenantId}: ${describeError(error)}`,
      );
      return;
    }

    let refreshedCount = 0;
    for (const campaign of list.campaigns) {
      const cached = this.cache.getCampaignConfig(tenantId, campaign.campaignCode);
      if (cached && cached.etag === campaign.etag) {
        // TC-3: no drift for this campaign — leave the cache untouched, no unnecessary DB write.
        continue;
      }
      await this.cache.applyCampaignConfig(campaign);
      refreshedCount += 1;
      this.logger.log(
        `Reconciliation refreshed campaign ${campaign.campaignCode} (tenant ${tenantId}): etag ` +
          `${cached?.etag ?? '<none>'} -> ${campaign.etag}`,
      );
    }

    if (refreshedCount === 0) {
      this.logger.log(`Reconciliation poll for tenant ${tenantId}: no etag drift, no-op`);
    }
  }
}
