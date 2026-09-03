/**
 * T-RAP-021. The mapping algorithm (`05-PROCESSING-PIPELINE.md` §1, step 4) — direct `activityCode`
 * lookup, or `transactionType` resolved via `activity_external_code_map` first — both against
 * `CampaignConfigCacheService`'s in-memory index **exclusively** (task implementation note 2: never
 * queries `campaign_config_snapshot`/`activity_external_code_map` directly per activity). "Active"
 * filtering (component + tracker + campaign, all three) is already enforced by that cache's own
 * `indexCampaign`/`indexComponentIfMatchable` — a component that fails any of the three simply never
 * appears in `activityIndex`, so this class has nothing extra to check on that front (task
 * implementation note 2's own "at the moment of mapping" — the cache's `activityIndex` is exactly
 * that live snapshot).
 *
 * Deliberately thin and side-effect free — no logging, no DB access of its own. Pure enough to unit
 * test with a stub cache and no Nest test module at all.
 */
import { Injectable } from '@nestjs/common';
import {
  CampaignConfigCacheService,
  type MatchedTrackerComponent,
} from '@/modules/campaign-cache/campaign-config-cache.service';
import type { InboundActivity } from '@/modules/idempotency/inbound-activity.types';

@Injectable()
export class ActivityMapper {
  constructor(private readonly cache: CampaignConfigCacheService) {}

  /**
   * `activityCode` present → direct lookup (`05-PROCESSING-PIPELINE.md` §1's first branch).
   * Otherwise, `transactionType` → resolved via `activity_external_code_map`, then matched exactly
   * as the direct-lookup branch (second branch). Returns `[]`, never throws, for "no active
   * component matches" (TC-5) and for "no external-code mapping exists" (second branch's own
   * documented no-op) — both are normal outcomes the caller logs, not errors
   * (`02-KAFKA-CONTRACTS.md` §2).
   *
   * Neither branch fires when `activity` carries neither field — request validation upstream of
   * this module, and `IdempotencyService.deriveDedupKey`'s own throw, are what actually prevent
   * that from ever reaching this method (`inbound-activity.types.ts`'s own header); this method
   * still degrades to `[]` rather than throwing a second time, since raising the *same* validation
   * error twice, from two different modules, is not this module's job.
   */
  mapToComponents(activity: InboundActivity): MatchedTrackerComponent[] {
    if (activity.activityCode) {
      return this.cache.lookupByActivityCode(activity.tenantId, activity.activityCode);
    }
    if (activity.transactionType) {
      return this.cache.lookupByTransactionType(activity.tenantId, activity.transactionType);
    }
    return [];
  }
}
