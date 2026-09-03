/**
 * T-RAP-010. The in-memory hot cache — `activityCode → [active tracker components in active
 * trackers in active campaigns]` plus the `transactionType → activityCode` index
 * (`ARCHITECTURE.md` §10, `05-PROCESSING-PIPELINE.md` §1) — and the startup bootstrap that builds
 * it from the local durable snapshot (`01-DATABASE.md` §1-§2), refreshed from the portal where
 * reachable (`03-GRPC-CONTRACT.md` §2).
 *
 * This is the one read surface Wave 2/3 tasks touch for config lookups (T-RAP-021 implementation
 * note 2: "never queries `campaign_config_snapshot` or `activity_external_code_map` directly per
 * activity"). T-RAP-011 (same file-scope owner, `agent-rap-cache`) extends this service's write
 * path (`applyCampaignConfig`/`warmTenant`, both public for exactly that reuse) with live
 * `WatchCampaignConfig` events and the 5-minute reconciliation poll — this task only builds and
 * populates the cache once, at process start (Scope "Out").
 *
 * **Only `active` campaigns/trackers/components are ever indexed for matching** (implementation
 * note 2, `05-PROCESSING-PIPELINE.md` §1): a `paused` campaign is stored (so its history/audit
 * trail still resolves, `01-DATABASE.md` §1's own note) but never appears in `activityIndex`.
 *
 * **In-memory mutation is synchronous and DB writes are awaited first** (`applyCampaignConfig`) —
 * every `Map` mutation for one campaign happens in a single synchronous block with no `await` in
 * between, which is what makes the "atomic swap, no half-updated reader" property
 * (`04-CACHE-INVALIDATION.md` §2.3) hold on Node's single-threaded event loop without needing an
 * explicit immutable-copy-and-swap of the whole structure.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ALL_CONFIG_SECTIONS,
  CampaignConfigClient,
  type CampaignConfigProto,
  type TrackerComponentProto,
} from './campaign-config.client';
import {
  ActivityExternalCodeMapRepository,
  CampaignConfigSnapshotRepository,
} from './campaign-config-snapshot.repository';
import type { CampaignConfigSnapshotRow } from '@/database/models/campaign-config-snapshot.model';
import type { ActivityExternalCodeMapRow } from '@/database/models/activity-external-code-map.model';

export interface MatchedTrackerComponent {
  tenantId: number;
  campaignCode: string;
  campaignId: number;
  trackerCode: string;
  trackerId: number;
  componentCode: string;
  componentId: number;
  activityId: number;
  activityCode: string;
}

export interface CachedCampaign {
  tenantId: number;
  campaignId: number;
  campaignCode: string;
  status: string;
  /** `status === 'active'` at the moment this was last indexed — the only status this service
   * ever matches new activity against (implementation note 2). */
  isActive: boolean;
  etag: string;
  configHash: string;
  /** The full, portal-shaped payload — Wave 3 reads trackers/rules/rewards/caps off this. */
  raw: CampaignConfigProto;
}

function cacheKey(tenantId: number, campaignCode: string): string {
  return `${tenantId}::${campaignCode}`;
}

function activityIndexKey(tenantId: number, activityCode: string): string {
  return `${tenantId}::${activityCode}`;
}

function externalCodeKey(tenantId: number, externalCode: string): string {
  return `${tenantId}::${externalCode}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `PORTAL_CONFIG_TENANT_IDS` — comma-separated tenant ids this instance manages. Required: with
 * no local snapshot at all (a genuine cold start), this is the only way this service can know
 * which tenant(s) to call `ListActiveCampaigns` for (`03-GRPC-CONTRACT.md` §2's `tenant_id` is
 * mandatory on every call this contract exposes). Read directly from `process.env`, not
 * `ConfigService`/`src/config/config.schema.ts` — same out-of-file-scope reason
 * `campaign-config.client.ts`'s header already explains. */
export function resolveConfiguredTenantIds(): number[] {
  const raw = process.env.PORTAL_CONFIG_TENANT_IDS?.trim();
  if (!raw) {
    throw new Error(
      'PORTAL_CONFIG_TENANT_IDS is required (comma-separated tenant ids this instance manages) — ' +
        'set it before starting the app; without it this service has no way to know which ' +
        'tenant(s) to fetch campaign configuration for.',
    );
  }
  const ids = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parsed = Number.parseInt(entry, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
          `Invalid PORTAL_CONFIG_TENANT_IDS entry "${entry}": must be a positive integer`,
        );
      }
      return parsed;
    });
  if (ids.length === 0) {
    throw new Error('PORTAL_CONFIG_TENANT_IDS must contain at least one tenant id');
  }
  return ids;
}

@Injectable()
export class CampaignConfigCacheService implements OnModuleInit {
  private readonly logger = new Logger(CampaignConfigCacheService.name);

  /** `${tenantId}::${activityCode}` -> every currently-active matched tracker component. */
  private readonly activityIndex = new Map<string, MatchedTrackerComponent[]>();
  /** `${tenantId}::${campaignCode}` -> the full cached campaign, active or not. */
  private readonly campaignIndex = new Map<string, CachedCampaign>();
  /** `${tenantId}::${externalCode}` -> `activityCode` (T-171, `01-DATABASE.md` §2). */
  private readonly externalCodeIndex = new Map<string, string>();

  constructor(
    private readonly client: CampaignConfigClient,
    private readonly snapshotRepo: CampaignConfigSnapshotRepository,
    private readonly externalCodeRepo: ActivityExternalCodeMapRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bootstrap();
  }

  /**
   * Cold start (`ARCHITECTURE.md` §10, task implementation note 1): rebuild the in-memory cache
   * from the local durable snapshot first (never blocks readiness on the portal), then attempt a
   * refresh per configured tenant. Only a cold start with **no** usable local snapshot **and** an
   * unreachable portal for every configured tenant fails startup — every other combination boots,
   * optionally with a "stale snapshot" warning (TC-1/TC-2/TC-3).
   */
  async bootstrap(): Promise<void> {
    const tenantIds = resolveConfiguredTenantIds();

    const [snapshotRows, externalCodeRows] = await Promise.all([
      this.snapshotRepo.findAll(),
      this.externalCodeRepo.findAll(),
    ]);

    this.buildFromLocalSnapshots(snapshotRows);
    this.buildExternalCodeIndexFromLocal(externalCodeRows);
    // Scoped to the tenants THIS instance actually manages — not "does the table have any row for
    // any tenant at all". `campaign_config_snapshot` is a whole-table rebuild target (every row,
    // every tenant, is loaded into the in-memory cache above), but a different, unrelated tenant's
    // leftover/stale row must never make a *this* instance's own cold-start-with-nothing-to-serve
    // case look survivable — that would defeat the entire point of implementation note 1's "no
    // local snapshot and an unreachable portal ... fails startup loudly" guarantee.
    const hadLocalSnapshot = snapshotRows.some((row) => tenantIds.includes(row.tenant_id));

    // Sequential by design: one tenant at a time, small tenant count, no need for the added
    // complexity of a concurrent fetch here.
    let anyRefreshed = false;
    for (const tenantId of tenantIds) {
      const refreshed = await this.warmTenant(tenantId);
      anyRefreshed = anyRefreshed || refreshed;
    }

    if (anyRefreshed) {
      return;
    }

    if (!hadLocalSnapshot) {
      throw new Error(
        `Cold start failed: no local campaign_config_snapshot rows exist and the portal was ` +
          `unreachable for every configured tenant (${tenantIds.join(', ')}). There is nothing ` +
          `to serve from — refusing to start.`,
      );
    }

    this.logger.warn(
      `Portal unreachable at startup for every configured tenant (${tenantIds.join(', ')}); ` +
        `booting from the last known local snapshot instead.`,
    );
  }

  /**
   * Full bulk refresh for one tenant (`ListActiveCampaigns`) — this task's own cold-start path,
   * and reusable as-is by T-RAP-011's reconciliation poller (same file-scope owner). Returns
   * `false` (never throws) on any portal failure, so a caller looping over several tenants can
   * keep going rather than aborting the whole warm cycle for one unreachable tenant.
   */
  async warmTenant(tenantId: number): Promise<boolean> {
    let list;
    try {
      list = await this.client.listActiveCampaigns(tenantId, ALL_CONFIG_SECTIONS);
    } catch (error) {
      this.logger.warn(
        `ListActiveCampaigns failed for tenant ${tenantId}: ${describeError(error)}`,
      );
      return false;
    }

    const previousCodes = this.campaignCodesForTenant(tenantId);
    const seenCodes = new Set<string>();

    // Sequential per campaign — each DB upsert completes before the next one starts, keeping
    // upsert ordering predictable and simple within one tenant's own warm cycle.
    for (const campaign of list.campaigns) {
      await this.applyCampaignConfig(campaign);
      seenCodes.add(campaign.campaignCode);
    }

    for (const code of previousCodes) {
      if (!seenCodes.has(code)) {
        await this.markCampaignVanished(tenantId, code);
      }
    }

    return true;
  }

  /**
   * Persists one campaign's snapshot + external-code rows, then rebuilds exactly that campaign's
   * in-memory entries (remove-then-readd, never a partial state in between since no `await`
   * separates the two `Map` operations). Public so T-RAP-011's `GetCampaignConfig`-triggered
   * single-campaign refresh (`04-CACHE-INVALIDATION.md` §2) reuses this exact logic instead of
   * duplicating it.
   */
  async applyCampaignConfig(campaign: CampaignConfigProto): Promise<void> {
    await this.snapshotRepo.upsert({
      tenantId: campaign.tenantId,
      campaignCode: campaign.campaignCode,
      configVersion: campaign.configHash || campaign.etag,
      isActive: campaign.status === 'active',
      payload: campaign,
    });

    await this.persistExternalCodes(campaign);

    this.removeCampaignFromIndex(campaign.tenantId, campaign.campaignCode);
    this.indexCampaign(campaign);
  }

  /** Direct `activityCode` match (`05-PROCESSING-PIPELINE.md` §1, first branch). Returns a copy —
   * callers must never be able to mutate this service's own internal state. */
  lookupByActivityCode(tenantId: number, activityCode: string): MatchedTrackerComponent[] {
    return [...(this.activityIndex.get(activityIndexKey(tenantId, activityCode)) ?? [])];
  }

  /** `transactionType → activityCode` resolution only (`01-DATABASE.md` §2) — callers that need
   * the matched components too should call `lookupByTransactionType` instead. */
  resolveExternalCode(tenantId: number, externalCode: string): string | undefined {
    return this.externalCodeIndex.get(externalCodeKey(tenantId, externalCode));
  }

  /** `transactionType` match (`05-PROCESSING-PIPELINE.md` §1, second branch): resolve via
   * `activity_external_code_map`, then match exactly as `lookupByActivityCode`. Returns `[]`,
   * never throws, when no mapping exists — "this activity matches nothing" is logged by the
   * caller, not an error here (task implementation note 3 / `02-KAFKA-CONTRACTS.md` §2). */
  lookupByTransactionType(tenantId: number, transactionType: string): MatchedTrackerComponent[] {
    const activityCode = this.resolveExternalCode(tenantId, transactionType);
    if (!activityCode) {
      return [];
    }
    return this.lookupByActivityCode(tenantId, activityCode);
  }

  /** Full cached campaign (active or not) — Wave 3's own read surface for trackers/rules/rewards/
   * caps once a match is found via the two lookups above. */
  getCampaignConfig(tenantId: number, campaignCode: string): CachedCampaign | undefined {
    return this.campaignIndex.get(cacheKey(tenantId, campaignCode));
  }

  private campaignCodesForTenant(tenantId: number): string[] {
    const codes: string[] = [];
    this.campaignIndex.forEach((cached) => {
      if (cached.tenantId === tenantId) {
        codes.push(cached.campaignCode);
      }
    });
    return codes;
  }

  /**
   * A campaign that no longer appears in a fresh `ListActiveCampaigns` response at all (not even
   * `paused`) has moved to `completed`/`archived` — never served over this contract
   * (`03-GRPC-CONTRACT.md` §2's own "only active or paused is ever served"). Stops it matching
   * new activity and flips its local snapshot row to `is_active = false`, without deleting either
   * the row or the in-memory entry — `01-DATABASE.md` §1's own "kept, not deleted, for audit".
   */
  private async markCampaignVanished(tenantId: number, campaignCode: string): Promise<void> {
    const key = cacheKey(tenantId, campaignCode);
    const cached = this.campaignIndex.get(key);
    if (!cached || !cached.isActive) {
      return;
    }

    this.removeCampaignFromIndex(tenantId, campaignCode);
    this.campaignIndex.set(key, { ...cached, isActive: false });

    await this.snapshotRepo.upsert({
      tenantId,
      campaignCode,
      configVersion: cached.configHash || cached.etag,
      isActive: false,
      payload: cached.raw,
    });
  }

  private async persistExternalCodes(campaign: CampaignConfigProto): Promise<void> {
    for (const merchant of campaign.merchants ?? []) {
      for (const activity of merchant.activities ?? []) {
        // Small, bounded config-sized loop (not per-transaction) — sequential upserts keep this
        // straightforward to reason about.
        for (const externalCode of activity.externalCodes ?? []) {
          await this.externalCodeRepo.upsert({
            tenantId: campaign.tenantId,
            externalCode,
            activityCode: activity.activityCode,
          });
          this.externalCodeIndex.set(
            externalCodeKey(campaign.tenantId, externalCode),
            activity.activityCode,
          );
        }
      }
    }
  }

  private removeCampaignFromIndex(tenantId: number, campaignCode: string): void {
    this.activityIndex.forEach((components, indexKey) => {
      const filtered = components.filter(
        (component) =>
          !(component.tenantId === tenantId && component.campaignCode === campaignCode),
      );
      if (filtered.length === 0) {
        this.activityIndex.delete(indexKey);
      } else if (filtered.length !== components.length) {
        this.activityIndex.set(indexKey, filtered);
      }
    });
  }

  /**
   * Adds fresh entries for one campaign — callers must have already removed any stale entries for
   * it (`removeCampaignFromIndex`) first. Only `active` campaigns/trackers/components are indexed
   * for matching (implementation note 2); every campaign, active or not, is still recorded in
   * `campaignIndex` for `getCampaignConfig`'s own historical/audit use.
   */
  private indexCampaign(campaign: CampaignConfigProto): void {
    const key = cacheKey(campaign.tenantId, campaign.campaignCode);
    this.campaignIndex.set(key, {
      tenantId: campaign.tenantId,
      campaignId: campaign.campaignId,
      campaignCode: campaign.campaignCode,
      status: campaign.status,
      isActive: campaign.status === 'active',
      etag: campaign.etag,
      configHash: campaign.configHash,
      raw: campaign,
    });

    if (campaign.status !== 'active') {
      return;
    }

    const activityCodeById = new Map<number, string>();
    for (const merchant of campaign.merchants ?? []) {
      for (const activity of merchant.activities ?? []) {
        activityCodeById.set(activity.activityId, activity.activityCode);
      }
    }

    for (const tracker of campaign.trackers ?? []) {
      if (tracker.status !== 'active') {
        continue;
      }
      for (const component of tracker.components ?? []) {
        this.indexComponentIfMatchable(
          campaign,
          tracker.trackerCode,
          tracker.trackerId,
          component,
          activityCodeById,
        );
      }
    }
  }

  private indexComponentIfMatchable(
    campaign: CampaignConfigProto,
    trackerCode: string,
    trackerId: number,
    component: TrackerComponentProto,
    activityCodeById: Map<number, string>,
  ): void {
    if (component.status !== 'active') {
      return;
    }
    const activityCode = activityCodeById.get(component.activityId);
    if (!activityCode) {
      // The component references an activity id this campaign's own MERCHANTS section didn't
      // return — defensive guard, not expected in a well-formed response; skip rather than crash.
      this.logger.warn(
        `Tracker component ${component.componentCode} (campaign ${campaign.campaignCode}, ` +
          `tenant ${campaign.tenantId}) references activityId ${component.activityId} with no ` +
          `matching Activity in the MERCHANTS section — skipped.`,
      );
      return;
    }

    const matched: MatchedTrackerComponent = {
      tenantId: campaign.tenantId,
      campaignCode: campaign.campaignCode,
      campaignId: campaign.campaignId,
      trackerCode,
      trackerId,
      componentCode: component.componentCode,
      componentId: component.componentId,
      activityId: component.activityId,
      activityCode,
    };

    const indexKey = activityIndexKey(campaign.tenantId, activityCode);
    const existing = this.activityIndex.get(indexKey) ?? [];
    existing.push(matched);
    this.activityIndex.set(indexKey, existing);
  }

  private buildFromLocalSnapshots(rows: CampaignConfigSnapshotRow[]): void {
    for (const row of rows) {
      this.indexCampaign(row.payload as CampaignConfigProto);
    }
  }

  private buildExternalCodeIndexFromLocal(rows: ActivityExternalCodeMapRow[]): void {
    for (const row of rows) {
      this.externalCodeIndex.set(
        externalCodeKey(row.tenant_id, row.external_code),
        row.activity_code,
      );
    }
  }
}
