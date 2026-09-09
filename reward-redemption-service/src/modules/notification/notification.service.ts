/**
 * T-RR-036. `NotificationService.notifyIfConfigured` — the real (log-only) implementation of
 * `ARCHITECTURE.md` §9's "Notification — logged only, for now" abstraction and
 * `05-PROCESSING-PIPELINE.md` §6 step 4: on a successful external dispatch, check the cached
 * campaign configuration for whether customer notification is enabled for this campaign/reward,
 * and if so write a `notification_log` row (`01-DATABASE.md` §8) shaped like a real
 * push-notification-service call body, instead of calling one (none exists anywhere in this repo).
 *
 * **Read-only consumer of the existing `campaignConfig` cache** (implementation note 1) — this
 * file injects `CampaignConfigCache` (`src/modules/processing/campaign-config.cache.ts`,
 * `agent-rr-processing`'s own file, T-RR-022, done) rather than opening a second gRPC client or a
 * second cache. `findBoundReward()` below is a deliberately small, self-contained duplicate of
 * `RewardSystemResolutionService`'s own private candidate-matching helper
 * (`reward-system-resolution.service.ts`, confirmed by direct read) — not an import of it, because
 * that function is private to a file this task does not own (R3: "do not edit another task's owned
 * files" extends to not reaching into its private internals either); duplicating a ~10-line pure
 * function is cheaper than either widening that file's own exports (an edit outside this task's
 * scope) or coupling this module to `RewardSystemResolutionService`'s own throw-on-miss contract
 * (this task needs a `BoundReward | undefined`, never a thrown error, for the "no reward bound at
 * all" case — TC-3's own sibling case).
 *
 * **A genuine, escalated design gap — read before changing `resolveNotificationEnabled` back to a
 * literal or removing it.** This task's own Scope section says: "if the cached feed genuinely
 * carries no such flag today, escalate ... rather than inventing a workaround." I read
 * `portal/back-end/proto/campaign_config.v1.proto` in full (R0 permits reading) — every message
 * (`CampaignConfig`, `BoundReward`, `Tracker`, `TrackerComponent`, `Merchant`, `Activity`,
 * `CampaignCap`) was checked, not just the ones `03-GRPC-CONTRACT.md` §3 quotes — and there is no
 * notification-related field anywhere on the wire today. `BoundReward.policies_json` is genuine
 * free-form JSON (`project-plan/13-REWARD-MASTER-VALUE-SOURCES.md` §5) with no documented or seeded
 * convention for a notification flag, so parsing an invented key out of it would be exactly the
 * "guessing a field name that doesn't exist" this task explicitly forbids. Rather than fully
 * blocking this task (and `T-RR-040`, which depends on it) on a portal-side proto change this plan
 * has no authority to make (R0), the "is notification enabled" question is answered by the
 * injectable `NOTIFICATION_ENABLED_RESOLVER` below, whose shipped default always returns `false` —
 * i.e. every real redemption today falls into implementation note 5's own already-anticipated,
 * explicitly-normal "the feed carries no flag ... skip silently" case, permanently, until the
 * portal actually adds a field. `TC-1` (the "enabled" case) still exercises this service's real
 * write path end to end by substituting a fake resolver via the same DI token — it just cannot be
 * proven against real portal data today, because no such data exists to prove it against. Swapping
 * in a real field check is a one-binding change in `notification.module.ts`, not a redesign,
 * matching `ARCHITECTURE.md` §9's own "one-file change, not a redesign" framing for this whole
 * feature. See this task's own completion report for the full evidence trail.
 *
 * **Never blocks or rolls back the redemption's own `completed` status** (implementation note 4,
 * TC-6) — a thrown error from `NotificationLogRepository.create()` is caught, logged, and
 * swallowed here; `notifyIfConfigured()` itself never rejects.
 *
 * **`customer_id_hash`, never plaintext or `customer_id_encrypted`, anywhere in this file (R8)** —
 * this service reads `entry.customer_id_hash` only; it never touches `EncryptionService` or any
 * decrypted value, unlike the outbound dispatch to reward-tracking-service (T-RR-034/T-RR-035),
 * which legitimately crosses a trust boundary and does need the plaintext.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CampaignConfigCache } from '@/modules/processing/campaign-config.cache';
import type {
  BoundRewardProto,
  CampaignConfigProto,
} from '@/modules/processing/campaign-config.client';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import { NotificationLogRepository, type NotificationChannel } from './notification-log.repository';
import { NotificationMetricsService } from './notification-metrics.service';

/** The only channel this v1 models (`01-DATABASE.md` §8, TC-5). */
const CHANNEL: NotificationChannel = 'PUSH';

/**
 * Whatever this service still needs about the just-completed external dispatch that isn't
 * necessarily reliable to re-read off `entry` at call time (`RedemptionCompletionSideEffectsPort`'s
 * own header notes the real call site runs `recordCompletionSideEffects` in its own transaction,
 * ahead of the row's final persisted state) — mirrors `reward_redemption_entry.external_system_code`/
 * `external_reference_id` (`01-DATABASE.md` §1), explicitly nullable for the direct
 * no-external-call path (`05-PROCESSING-PIPELINE.md` §2).
 */
export interface RedemptionOutcomeContext {
  externalSystemCode: string | null;
  externalReferenceId: string | null;
}

/**
 * Resolves whether customer notification is enabled for the `BoundReward` this entry's redemption
 * resolved against (`undefined` when no matching `BoundReward` exists in the cached feed at all —
 * TC-3's sibling case). A pure function, not a method, specifically so it is one clean seam to
 * replace once the portal exposes a real field — see this file's own header.
 */
export type NotificationEnabledResolver = (boundReward: BoundRewardProto | undefined) => boolean;

export const NOTIFICATION_ENABLED_RESOLVER = Symbol('NOTIFICATION_ENABLED_RESOLVER');

/**
 * The shipped default — always `false`. See this file's own header for the full reasoning: as of
 * 2026-09-06, `campaign_config.v1.proto` carries no notification-related field on any message, so
 * every real campaign resolves to "not configured" today, which implementation note 5 already
 * documents as the expected, common, non-error case.
 */
export const NO_NOTIFICATION_FLAG_YET_RESOLVER: NotificationEnabledResolver = () => false;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deliberately-small duplicate of `RewardSystemResolutionService`'s own private candidate-matching
 * helper — see this file's own header for why this is a duplicate, not an import. Builds every
 * level/`ref_id` candidate this entry could plausibly resolve a `BoundReward` at (`campaign` @
 * `ref_id=0` always; `tracker`/`component` when the entry's own codes match the feed's own
 * structure) and returns the first `BoundReward` whose `system_code` matches this entry's own
 * `reward_code` at one of those candidates — `undefined` when none does, never a thrown error.
 */
function findBoundReward(
  config: CampaignConfigProto,
  rewardCode: string,
  trackerCode: string,
  trackerComponentCode: string,
): BoundRewardProto | undefined {
  const candidates: Array<{ level: string; refId: number }> = [{ level: 'campaign', refId: 0 }];

  const tracker = config.trackers.find((t) => t.trackerCode === trackerCode);
  if (tracker) {
    candidates.push({ level: 'tracker', refId: tracker.trackerId });
    const component = tracker.components.find((c) => c.componentCode === trackerComponentCode);
    if (component) {
      candidates.push({ level: 'component', refId: component.componentId });
    }
  }

  return config.rewards.find(
    (reward) =>
      reward.systemCode === rewardCode &&
      candidates.some((c) => c.level === reward.level && c.refId === reward.refId),
  );
}

/**
 * Implementation note 2: shaped exactly like a real push-notification-service call body — channel,
 * customer id **hash** (never plaintext, R8), campaign/reward context, a plausible message
 * template reference and a payout summary. Every field here is either already on `entry`
 * (`01-DATABASE.md` §1) or supplied by the caller's own `RedemptionOutcomeContext` — nothing is
 * invented from data this service doesn't actually have.
 */
export function buildWouldBePayload(
  entry: RewardRedemptionEntryRow,
  outcome: RedemptionOutcomeContext,
): Record<string, unknown> {
  return {
    channel: CHANNEL,
    customerIdHash: entry.customer_id_hash,
    campaignCode: entry.campaign_code,
    rewardCode: entry.reward_code,
    rewardCategory: entry.reward_category,
    rewardValue: entry.reward_value,
    rewardValueUnit: entry.reward_value_unit,
    externalSystemCode: outcome.externalSystemCode,
    externalReferenceId: outcome.externalReferenceId,
    messageTemplateRef: 'reward.redemption.completed.v1',
    redeemedAt: (entry.redeemed_at ?? new Date()).toISOString(),
  };
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly campaignConfigCache: CampaignConfigCache,
    private readonly repository: NotificationLogRepository,
    private readonly metrics: NotificationMetricsService,
    @Optional()
    @Inject(NOTIFICATION_ENABLED_RESOLVER)
    private readonly resolveEnabled: NotificationEnabledResolver = NO_NOTIFICATION_FLAG_YET_RESOLVER,
  ) {}

  /**
   * TC-1…TC-8. Never throws — a resolution miss (TC-3), a disabled/unconfigured campaign (TC-2),
   * and a failed `notification_log` insert (TC-6) are all handled internally and never propagate
   * to the caller, so this method is always safe to call from the redemption pipeline's own
   * success path without risking the redemption's own terminal status (implementation note 4).
   */
  async notifyIfConfigured(
    entry: RewardRedemptionEntryRow,
    outcome: RedemptionOutcomeContext,
    client?: PoolClient,
  ): Promise<void> {
    const boundReward = await this.resolveBoundReward(entry);

    if (!this.resolveEnabled(boundReward)) {
      // Implementation note 5: no config resolved, or it resolves to disabled — the expected,
      // common case. No row, no metric, no error.
      return;
    }

    const payload = buildWouldBePayload(entry, outcome);
    try {
      await this.repository.create(
        {
          rewardEntryId: entry.id,
          tenantId: entry.tenant_id,
          customerIdHash: entry.customer_id_hash,
          campaignCode: entry.campaign_code,
          rewardCode: entry.reward_code,
          channel: CHANNEL,
          wouldBePayload: payload,
        },
        client,
      );
      this.metrics.incrementNotificationLogged();
    } catch (error) {
      // TC-6: logged, never propagated — a notification-logging failure must never roll back or
      // block the redemption's own already-completed status.
      this.logger.error(
        `Failed to write notification_log for reward_entry ${entry.id}: ${describeError(error)}`,
      );
    }
  }

  /** TC-3: a resolution miss (no cache entry for this tenant/campaign, or no `BoundReward` at any
   * level this entry could plausibly resolve to) is treated as "not configured", never thrown. */
  private async resolveBoundReward(
    entry: RewardRedemptionEntryRow,
  ): Promise<BoundRewardProto | undefined> {
    try {
      const config = await this.campaignConfigCache.get(entry.tenant_id, entry.campaign_code);
      return findBoundReward(
        config,
        entry.reward_code,
        entry.tracker_code,
        entry.tracker_component_code,
      );
    } catch (error) {
      this.logger.debug(
        `Campaign config resolution miss for reward_entry ${entry.id} ` +
          `(tenant_id=${entry.tenant_id}, campaign_code="${entry.campaign_code}") — ` +
          `treating as "notification not configured": ${describeError(error)}`,
      );
      return undefined;
    }
  }
}
