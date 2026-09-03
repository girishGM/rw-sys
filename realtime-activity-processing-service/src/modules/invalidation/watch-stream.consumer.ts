/**
 * T-RAP-011. The `WatchCampaignConfig` client (`03-GRPC-CONTRACT.md` §2,
 * `04-CACHE-INVALIDATION.md` §1-§3): one server-streaming gRPC stream per configured tenant
 * (`PORTAL_CONFIG_TENANT_IDS`, `campaign-config-cache.service.ts`), opened at startup and held for
 * the process's lifetime — "every open stream gets every event pushed to it directly" (§1), so
 * there is no consumer-group concept to configure here, unlike the ingestion Kafka topics
 * elsewhere in this plan (implementation note 1). Purely transport + orchestration: no business
 * logic beyond what §2/§3 already prescribe (R5's spirit, even though R5 itself targets the
 * ingestion transports).
 *
 * **On `ConfigChangeEvent` receipt** (§2, implementation notes 2/5): fetch just that one campaign
 * via `CampaignConfigClient.getCampaignConfig` (passing the previously-held etag so an unrelated
 * change elsewhere doesn't force a full re-transfer), then hand the response to
 * `CampaignConfigCacheService.applyCampaignConfig` — which does the atomic swap (persists +
 * reindexes in one synchronous block, no `await` in between) so in-flight readers never observe a
 * half-updated entry (§2.3, TC-6). `change_type` is logged/tagged only; every event triggers the
 * same single-campaign re-fetch regardless of `UPDATED`/`PAUSED`/`ENDED` (implementation note 5).
 *
 * **On stream disconnect** (§3, TC-5): reconnect with exponential backoff (per tenant,
 * independently), and treat reconnection as "assume state may have changed" — call
 * `CampaignConfigCacheService.warmTenant` (the exact same full re-warm T-RAP-010's own cold start
 * already uses) rather than just resuming the stream and hoping nothing happened while
 * disconnected.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type * as grpc from '@grpc/grpc-js';
import {
  ALL_CONFIG_SECTIONS,
  CampaignConfigClient,
  type ConfigChangeEventProto,
} from '../campaign-cache/campaign-config.client';
import {
  CampaignConfigCacheService,
  resolveConfiguredTenantIds,
} from '../campaign-cache/campaign-config-cache.service';
import {
  DEFAULT_WATCH_STREAM_BACKOFF_BASE_MS,
  DEFAULT_WATCH_STREAM_BACKOFF_MAX_MS,
  WATCH_STREAM_AUTOSTART,
  WATCH_STREAM_BACKOFF_BASE_MS,
  WATCH_STREAM_BACKOFF_MAX_MS,
} from './invalidation.config';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class WatchStreamConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatchStreamConsumer.name);

  /** One entry per configured tenant while its stream is open — absent while reconnecting. */
  private readonly streamsByTenant = new Map<
    number,
    grpc.ClientReadableStream<ConfigChangeEventProto>
  >();
  private readonly reconnectTimers = new Map<number, NodeJS.Timeout>();
  private readonly reconnectAttempts = new Map<number, number>();
  private stopped = true;

  constructor(
    private readonly client: CampaignConfigClient,
    private readonly cache: CampaignConfigCacheService,
    @Inject(WATCH_STREAM_BACKOFF_BASE_MS)
    private readonly backoffBaseMs: number = DEFAULT_WATCH_STREAM_BACKOFF_BASE_MS,
    @Inject(WATCH_STREAM_BACKOFF_MAX_MS)
    private readonly backoffMaxMs: number = DEFAULT_WATCH_STREAM_BACKOFF_MAX_MS,
    @Inject(WATCH_STREAM_AUTOSTART) private readonly autostart: boolean = true,
  ) {}

  onModuleInit(): void {
    if (!this.autostart) {
      return;
    }
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /**
   * Opens one `WatchCampaignConfig` stream per configured tenant — exposed directly (not just
   * `onModuleInit`) so tests drive the exact same code path deterministically, same discipline as
   * `OutboxPublisherWorker.runOnce()`.
   */
  start(): void {
    this.stopped = false;
    for (const tenantId of resolveConfiguredTenantIds()) {
      this.openStream(tenantId);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    for (const stream of this.streamsByTenant.values()) {
      stream.cancel();
    }
    this.streamsByTenant.clear();
  }

  private openStream(tenantId: number): void {
    if (this.stopped) {
      return;
    }
    const stream = this.client.watchCampaignConfig(tenantId);
    this.streamsByTenant.set(tenantId, stream);

    stream.on('data', (event: ConfigChangeEventProto) => {
      // A successful delivery proves the stream is healthy again — reset this tenant's own
      // backoff counter so a later, unrelated disconnect starts from the base delay again.
      this.reconnectAttempts.set(tenantId, 0);
      this.handleEvent(tenantId, event).catch((error: unknown) => {
        this.logger.error(
          `Failed handling ConfigChangeEvent for campaign ${event.campaignCode} ` +
            `(tenant ${tenantId}): ${describeError(error)}`,
        );
      });
    });

    const onClosed = (error: unknown): void => {
      // A stale close from a stream already superseded by a later reconnect attempt (e.g. a
      // straggling 'end' arriving after 'error' already triggered a reconnect) must never
      // re-schedule on top of the newer, still-open stream.
      if (this.streamsByTenant.get(tenantId) !== stream) {
        return;
      }
      this.streamsByTenant.delete(tenantId);
      if (this.stopped) {
        return;
      }
      this.scheduleReconnect(tenantId, error);
    };

    stream.on('error', (error: Error) => onClosed(error));
    stream.on('end', () => onClosed(new Error('WatchCampaignConfig stream ended by server')));
  }

  private scheduleReconnect(tenantId: number, error: unknown): void {
    this.logger.warn(
      `WatchCampaignConfig stream for tenant ${tenantId} disconnected (${describeError(error)}); ` +
        `reconnecting with backoff`,
    );
    const existingTimer = this.reconnectTimers.get(tenantId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const attempt = (this.reconnectAttempts.get(tenantId) ?? 0) + 1;
    this.reconnectAttempts.set(tenantId, attempt);
    const delayMs = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.backoffMaxMs);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(tenantId);
      this.reconnect(tenantId);
    }, delayMs);
    timer.unref?.();
    this.reconnectTimers.set(tenantId, timer);
  }

  /** §3 / TC-5: reconnection assumes state may have changed while disconnected — a fresh
   * `ListActiveCampaigns` full re-warm via `CampaignConfigCacheService.warmTenant`, not just
   * resuming the stream and hoping nothing happened. */
  private reconnect(tenantId: number): void {
    this.openStream(tenantId);
    this.cache.warmTenant(tenantId).catch((error: unknown) => {
      // `warmTenant` itself never throws (logs and returns `false` on failure) — this catch is
      // defensive only, in case a future change to that contract reintroduces a throw.
      this.logger.warn(
        `Post-reconnect full re-warm failed for tenant ${tenantId}: ${describeError(error)}`,
      );
    });
  }

  /** §2, implementation notes 2/5 — exposed (not `private`) so tests can drive one event through
   * the exact same handling `stream.on('data', ...)` uses, without depending on a real/mock gRPC
   * stream's own event timing. */
  async handleEvent(tenantId: number, event: ConfigChangeEventProto): Promise<void> {
    this.logger.log(
      `ConfigChangeEvent: campaign=${event.campaignCode} tenant=${tenantId} ` +
        `changeType=${event.changeType} etag=${event.etag}`,
    );

    const previous = this.cache.getCampaignConfig(tenantId, event.campaignCode);

    let updated;
    try {
      updated = await this.client.getCampaignConfig(
        tenantId,
        event.campaignCode,
        ALL_CONFIG_SECTIONS,
        previous?.etag ?? '',
      );
    } catch (error) {
      this.logger.warn(
        `GetCampaignConfig failed for campaign ${event.campaignCode} (tenant ${tenantId}) after a ` +
          `ConfigChangeEvent: ${describeError(error)}`,
      );
      return;
    }

    if (updated.notModified) {
      // The etag we already held turned out to still be current (e.g. the event was for a
      // section this service doesn't track) — nothing to apply.
      this.logger.log(
        `GetCampaignConfig reported not_modified for campaign ${event.campaignCode} ` +
          `(tenant ${tenantId}) despite a ConfigChangeEvent — no-op`,
      );
      return;
    }

    await this.cache.applyCampaignConfig(updated);
  }
}
