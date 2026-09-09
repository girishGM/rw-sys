/**
 * T-INT-010 implementation note 4 — response shapes, field-for-field against
 * `grpc/wire/campaign-config.messages.ts`, so a client of both transports (T-INT-011/012/013)
 * never needs a transport-specific parsing branch.
 *
 * These are **types**, not `class-validator` DTOs: nothing here is ever the target of
 * `ValidationPipe` — every value originates from `CampaignConfigService`, which this module
 * calls directly and never forks (T-INT-010's own scope note), so there is nothing of this
 * shape for a pipe to validate on the way *out*. Declaring the shape here is what lets the
 * controller's return types be checked against the wire contract at compile time instead of by
 * convention.
 */

export interface MoneyResponse {
  readonly amount: string;
  readonly currency: string;
}

export interface ActivityResponse {
  readonly activityId: number;
  readonly activityCode: string;
  readonly name: string;
  readonly externalCodes: readonly string[];
}

export interface MerchantResponse {
  readonly merchantId: number;
  readonly merchantCode: string;
  readonly name: string;
  readonly status: string;
  readonly activities: readonly ActivityResponse[];
}

export interface TrackerComponentResponse {
  readonly componentId: number;
  readonly componentCode: string;
  readonly name: string;
  readonly activityId: number;
  readonly sequenceOrder: number;
  readonly isMandatory: boolean;
  readonly status: string;
}

export interface TrackerResponse {
  readonly trackerId: number;
  readonly trackerCode: string;
  readonly name: string;
  readonly completionLogic: string;
  readonly completionThreshold: number;
  readonly status: string;
  readonly components: readonly TrackerComponentResponse[];
}

export interface BoundRuleResponse {
  readonly ruleId: number;
  readonly ruleVersionId: number;
  readonly versionNo: number;
  readonly ruleCode: string;
  readonly expression: string;
  readonly parametersJson: string;
  readonly boundValuesJson: string;
  readonly trackerComponentId: number;
  readonly status: string;
}

export interface BoundRewardResponse {
  readonly rewardId: number;
  readonly rewardVersionId: number;
  readonly versionNo: number;
  readonly systemCode: string;
  readonly rewardType: string;
  readonly deliveryMode: string;
  readonly policiesJson: string;
  readonly unitType: string;
  readonly unitCode: string;
  readonly level: string;
  readonly refId: number;
  readonly status: string;
  readonly expiryValue: number;
  readonly expiryUnit: string;
  readonly rewardKind: string;
  readonly promoCodeConfigId: string;
  readonly promoCodeConfigVersionNo: number;
}

export interface CampaignCapResponse {
  readonly capClass: string;
  readonly scopeLevel: string;
  readonly scopeRefId: number;
  readonly periodType: string;
  readonly periodValue: number;
  readonly windowStartTime: string;
  readonly windowEndTime: string;
  readonly periodTimezone: string;
  readonly unitType: string;
  readonly unitCode: string;
  readonly rewardType: string;
  readonly maxTotalAmount: string;
  readonly maxOccurrences: number;
  readonly maxCustomers: number;
  readonly onBreach: string;
  readonly warnAtPercent: number;
}

/** `GetCampaignConfig`'s response. `notModified: true` is the REST 304 case's own body shape
 * when a caller wants it inline; the controller itself answers a genuine 304 with an empty body
 * and this shape only ever appears in the 200 case — see implementation note 3. */
export interface CampaignConfigResponse {
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly tenantId: number;
  readonly countryId: number;
  readonly status: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly budget: MoneyResponse;
  readonly maxParticipants: number;
  readonly merchants: readonly MerchantResponse[];
  readonly trackers: readonly TrackerResponse[];
  readonly rules: readonly BoundRuleResponse[];
  readonly rewards: readonly BoundRewardResponse[];
  readonly etag: string;
  readonly configHash: string;
  readonly notModified: boolean;
  readonly servedAt: string;
  readonly caps: readonly CampaignCapResponse[];
  readonly sectionsReturned: readonly string[];
  readonly sectionsOmitted: readonly string[];
}

export interface CampaignConfigListResponse {
  readonly campaigns: readonly CampaignConfigResponse[];
  readonly servedAt: string;
  readonly sectionsReturned: readonly string[];
  readonly sectionsOmitted: readonly string[];
}

export interface RuleVersionDetailResponse {
  readonly exists: boolean;
  readonly ruleId?: number;
  readonly ruleCode?: string;
  readonly name?: string;
  readonly versionNo?: number;
  readonly expression?: string;
  readonly parametersJson?: string;
  readonly status?: string;
  readonly publishedAt?: string;
  readonly changeSummary?: string;
  readonly ruleVersionId?: number;
}

export interface RewardVersionDetailResponse {
  readonly exists: boolean;
  readonly rewardId?: number;
  readonly systemCode?: string;
  readonly name?: string;
  readonly versionNo?: number;
  readonly rewardType?: string;
  readonly deliveryMode?: string;
  readonly policiesJson?: string;
  readonly unitType?: string;
  readonly unitCode?: string;
  readonly status?: string;
  readonly publishedAt?: string;
  readonly changeSummary?: string;
  readonly rewardVersionId?: number;
}

export interface BudgetStatusEntryResponse {
  readonly capId: number;
  readonly capClass: string;
  readonly scopeLevel: string;
  readonly scopeRefId: number;
  readonly periodType: string;
  readonly unitType: string;
  readonly unitCode: string;
  readonly maxTotalAmount: string;
  readonly maxOccurrences: number;
  readonly onBreach: string;
  readonly warnAtPercent: number;
}

export interface BudgetStatusResponse {
  readonly campaignId: number;
  readonly servedAt: string;
  readonly entries: readonly BudgetStatusEntryResponse[];
}

/** The `{ data }` envelope every other portal REST route returns (03-API-CONTRACT.md §1) — this
 * surface follows the same convention even though its callers are services, not browsers. */
export interface DataEnvelope<T> {
  readonly data: T;
}
