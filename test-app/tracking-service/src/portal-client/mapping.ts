/**
 * T-003 — raw `portal/back-end` JSON → this app's own {@link PortalCampaign}/
 * {@link PortalCampaignJourney} shapes. Kept separate from `client.ts` so the mapping itself is
 * directly unit-testable against a captured real response, without a network layer in the way.
 */
import type {
  PortalCampaign,
  PortalCampaignJourney,
  PortalJourneyComponent,
  PortalJourneyTracker,
  PortalRewardAssignment,
  TrackerCompletionLogic,
} from './types';

/** `{ data: T[], meta: {...} }` — 03-API-CONTRACT.md §1's list envelope. */
export interface ListEnvelope<T> {
  readonly data: readonly T[];
}

/** `{ data: T }` — the single-resource envelope. */
export interface DataEnvelope<T> {
  readonly data: T;
}

/** `campaign-response.dto.ts#toCampaignDto`'s actual field set (`GET /api/v1/campaigns`). Only
 * the fields {@link toPortalCampaign} reads are declared; the real response carries more
 * (`tenantId`, `budgetAmount`, `editable`, ...) which this app has no use for. */
export interface RawCampaign {
  readonly id: number;
  readonly campaignCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
}

export interface RawRewardAssignment {
  readonly id: number;
  readonly level: 'campaign' | 'tracker' | 'component';
  readonly refId: number | null;
  readonly rewardPolicyId: number;
  readonly rewardPolicyName: string;
  readonly rewardId: number;
  readonly rewardName: string;
  readonly unitType: string | null;
  readonly unitCode: string | null;
  readonly amount: string | null;
  readonly status: string;
}

export interface RawJourneyComponent {
  readonly id: number;
  readonly componentCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly activityId: number | null;
  readonly activityName: string | null;
  readonly sequenceOrder: number;
  readonly isMandatory: boolean;
  readonly status: string;
}

export interface RawJourneyTracker {
  readonly id: number;
  readonly trackerCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly completionLogic: string;
  readonly completionThreshold: number | null;
  readonly isPrimary: boolean;
  readonly status: string;
  readonly components: readonly RawJourneyComponent[];
  readonly rewards: readonly RawRewardAssignment[];
}

export interface RawJourney {
  readonly campaignId: number;
  readonly trackers: readonly RawJourneyTracker[];
  readonly campaignRewards: readonly RawRewardAssignment[];
}

export function toPortalCampaign(raw: RawCampaign): PortalCampaign {
  return {
    id: raw.id,
    campaignCode: raw.campaignCode,
    name: raw.name,
    description: raw.description,
    startDate: raw.startDate,
    endDate: raw.endDate,
    status: raw.status,
  };
}

function toCompletionLogic(value: string): TrackerCompletionLogic {
  if (value === 'all' || value === 'any' || value === 'n_of') return value;
  // `ck_trk_logic` on `reward_config.trackers` makes any other value impossible in a real
  // response — fail loudly rather than silently coercing an unrecognised value to a guess.
  throw new Error(`portal-client: unrecognised tracker completionLogic "${value}"`);
}

function toRewardAssignment(raw: RawRewardAssignment): PortalRewardAssignment {
  return {
    id: raw.id,
    level: raw.level,
    refId: raw.refId,
    rewardPolicyId: raw.rewardPolicyId,
    rewardPolicyName: raw.rewardPolicyName,
    rewardId: raw.rewardId,
    rewardName: raw.rewardName,
    unitType: raw.unitType,
    unitCode: raw.unitCode,
    amount: raw.amount,
    status: raw.status,
  };
}

function toJourneyComponent(raw: RawJourneyComponent): PortalJourneyComponent {
  return {
    id: raw.id,
    componentCode: raw.componentCode,
    name: raw.name,
    description: raw.description,
    activityId: raw.activityId,
    activityName: raw.activityName,
    sequenceOrder: raw.sequenceOrder,
    isMandatory: raw.isMandatory,
    status: raw.status,
  };
}

function toJourneyTracker(raw: RawJourneyTracker): PortalJourneyTracker {
  return {
    id: raw.id,
    trackerCode: raw.trackerCode,
    name: raw.name,
    description: raw.description,
    completionLogic: toCompletionLogic(raw.completionLogic),
    completionThreshold: raw.completionThreshold,
    isPrimary: raw.isPrimary,
    status: raw.status,
    components: raw.components.map(toJourneyComponent),
    rewards: raw.rewards.map(toRewardAssignment),
  };
}

export function toPortalCampaignJourney(raw: RawJourney): PortalCampaignJourney {
  return {
    campaignId: raw.campaignId,
    trackers: raw.trackers.map(toJourneyTracker),
    campaignRewards: raw.campaignRewards.map(toRewardAssignment),
  };
}
