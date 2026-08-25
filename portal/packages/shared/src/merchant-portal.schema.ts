/**
 * T-039 — the wire contract of `/merchant/campaigns`, `/merchant/campaigns/:id` and
 * `/merchant/summary` (03-API-CONTRACT.md §13), shared by the back end that produces it and the
 * SPA that consumes it (00-ARCHITECTURE.md §8). Same discipline every other `*.schema.ts` in this
 * package states in full: bytes on the wire only, no defaults the server never sent, no
 * coercion, `.strict()` everywhere so an unexpected key — another merchant's commission rate, a
 * campaign's internal budget — fails the contract test rather than shipping silently. That is not
 * a formality here: implementation note 2 (*"never another participant's commission_rate, and
 * never the campaign's internal budget"*) is exactly what `.strict()` turns into an automatic,
 * ongoing check rather than a promise a future edit could quietly break.
 *
 * `commissionRate` is a decimal **string**, never `number` — the same "money/precision never
 * crosses a boundary as a float" discipline `merchant.schema.ts`'s own header states, for the
 * same reason: the back end reads `decimal(5,2)` columns back from Postgres as strings and never
 * coerces them (`merchant-activity.model.ts`'s own header).
 */
import { z } from 'zod';

/** Implementation note 4 / `merchant-portal.constants.ts`'s own `MERCHANT_VISIBLE_CAMPAIGN_STATUSES`
 * — the subset of `campaign.schema.ts`'s six-value `CAMPAIGN_STATUSES` a merchant may ever see.
 * Duplicated rather than imported: `packages/shared/src/campaign.schema.ts` is T-037's own file,
 * and this task's file scope is `packages/shared/src/merchant-portal.schema.ts` only (R9). */
export const MERCHANT_VISIBLE_CAMPAIGN_STATUSES = ['active', 'paused', 'completed'] as const;
export const merchantVisibleCampaignStatusSchema = z.enum(MERCHANT_VISIBLE_CAMPAIGN_STATUSES);
export type MerchantVisibleCampaignStatus = z.infer<typeof merchantVisibleCampaignStatusSchema>;

/** One row of `GET /merchant/campaigns` — the campaign header only (TC-1…TC-7). */
export const merchantCampaignListItemSchema = z
  .object({
    id: z.number().int(),
    campaignCode: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    region: z.string().nullable(),
    startDate: z.string(),
    endDate: z.string(),
    status: merchantVisibleCampaignStatusSchema,
  })
  .strict();

export type MerchantCampaignListItem = z.infer<typeof merchantCampaignListItemSchema>;

/** One `merchant_activities` row, projected for the merchant's own eyes only — "its own
 * activities and commission terms" (implementation note 2), never another merchant's. */
export const merchantOwnActivitySchema = z
  .object({
    activityId: z.number().int(),
    activityName: z.string(),
    storeId: z.number().int().nullable(),
    /** `decimal(5,2)`, `null` when no rate was set. Never coerced to `number` — see file header. */
    commissionRate: z.string().nullable(),
  })
  .strict();

export type MerchantOwnActivity = z.infer<typeof merchantOwnActivitySchema>;

/** `GET /merchant/campaigns/:id` — the campaign header plus this merchant's own participation and
 * its own activities. Never another participant's commission rate, never the campaign's internal
 * budget (implementation note 2, TC-8/TC-9). */
export const merchantCampaignDetailSchema = merchantCampaignListItemSchema
  .extend({
    maxParticipants: z.number().int().nullable(),
    participation: z
      .object({
        status: z.string(),
        joinedAt: z.string(),
      })
      .strict(),
    myActivities: z.array(merchantOwnActivitySchema),
  })
  .strict();

export type MerchantCampaignDetail = z.infer<typeof merchantCampaignDetailSchema>;

/** Implementation note 5 / TC-19: an honest "not available" state, never a fabricated `0` or
 * series, when a metric has no source table to aggregate from. */
export const merchantCampaignPerformanceUnavailableSchema = z
  .object({
    available: z.literal(false),
    reason: z.string(),
  })
  .strict();

export const merchantCampaignPerformanceAvailableSchema = z
  .object({
    available: z.literal(true),
    series: z.array(
      z
        .object({
          label: z.string(),
          value: z.number(),
        })
        .strict(),
    ),
  })
  .strict();

export const merchantCampaignPerformanceSchema = z.union([
  merchantCampaignPerformanceUnavailableSchema,
  merchantCampaignPerformanceAvailableSchema,
]);

export type MerchantCampaignPerformance = z.infer<typeof merchantCampaignPerformanceSchema>;

/** `GET /merchant/summary` — the dashboard KPI/chart/list data 01-DATABASE.md §5.3's three
 * `merchant` `role_dashboard_widgets` rows need (TC-13, TC-18). */
export const merchantSummarySchema = z
  .object({
    activeCampaignsCount: z.number().int(),
    myActivitiesCount: z.number().int(),
    campaignPerformance: merchantCampaignPerformanceSchema,
    participatingCampaigns: z.array(merchantCampaignListItemSchema),
  })
  .strict();

export type MerchantSummary = z.infer<typeof merchantSummarySchema>;

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per `trace.schema.ts`'s own
 * precedent: this envelope is an API-wide convention no task owns a shared home for. */
export const merchantCampaignListEnvelopeSchema = z
  .object({ data: z.array(merchantCampaignListItemSchema) })
  .strict();

export const merchantCampaignDetailEnvelopeSchema = z
  .object({ data: merchantCampaignDetailSchema })
  .strict();

export const merchantSummaryEnvelopeSchema = z.object({ data: merchantSummarySchema }).strict();
