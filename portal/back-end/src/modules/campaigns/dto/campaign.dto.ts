/**
 * T-037 — the request bodies of `/campaigns` itself (steps 1, 2 and 7).
 *
 * ### Two layers, deliberately
 *
 * Each DTO carries per-field `class-validator` decorators **and** one
 * `@MatchesSharedContract(...)` against the Zod schema the SPA validates with. The first layer
 * gives precise, per-field `details` entries; the second enforces every cross-field rule from
 * exactly one definition. See `shared-contract.decorator.ts` for why both.
 *
 * ### What is *not* here is the load-bearing part
 *
 * **No `tenantId`. No `status`. No `createdBy`. No `countryId`.** AGENT-PROTOCOL R3: those come
 * from the verified JWT only, and *"if a DTO contains one of these, that is a bug"*. TC-1's
 * `created_by` and TC-4/TC-5's tenant isolation are both consequences of their absence here plus
 * `ScopedRepository`'s forced write values — two independent controls, neither of which relies
 * on a reviewer noticing a field.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  createCampaignRequestSchema,
  setCampaignMerchantsRequestSchema,
  updateCampaignRequestSchema,
} from '@reward-portal/shared';
import { MatchesSharedContract } from './shared-contract.decorator';

/** `POST /campaigns` — step 1. Creates `status='draft'` (03-API-CONTRACT.md §11). */
export class CreateCampaignDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/, {
    message: 'campaignCode must be 2-50 alphanumeric characters, dashes or underscores',
  })
  @MatchesSharedContract(createCampaignRequestSchema)
  campaignCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  /**
   * A **calendar date**, `YYYY-MM-DD` — see `campaign.schema.ts#campaignDateSchema` and T-065.
   *
   * `@IsISO8601` accepts a date-only form as well as a full instant, which is exactly the pair
   * the shared contract accepts, so this per-field decorator stays as it is; the union itself
   * (and the reduction of an instant to the day it names) is enforced once, by
   * `@MatchesSharedContract` above.
   */
  @IsISO8601({ strict: true })
  startDate!: string;

  /** The campaign's last active day, **inclusive**. See {@link CreateCampaignDto.startDate}. */
  @IsISO8601({ strict: true })
  endDate!: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maxParticipants?: number;

  /** Decimal **string** — `tenant_campaigns.budget_amount` is `decimal(18,2)` and money never
   * crosses this boundary as a float. Paired with `budgetCurrency` by the shared contract
   * (TC-11). */
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,16}(\.\d{1,2})?$/, { message: 'budgetAmount must be a decimal amount' })
  budgetAmount?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'budgetCurrency must be a 3-letter code' })
  budgetCurrency?: string;
}

/** `PATCH /campaigns/:id`. `campaignCode` is absent on purpose: it is the tenant-unique business
 * key other systems already hold, and renaming it after creation would silently orphan them. */
export class UpdateCampaignDto {
  /** Carries the contract check for the **whole** DTO and therefore no `@IsOptional()` — see
   * `shared-contract.decorator.ts`'s "one rule for attaching this". `name`'s own length bounds
   * come from `updateCampaignRequestSchema` instead, which already states them. */
  @MatchesSharedContract(updateCampaignRequestSchema)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  startDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  endDate?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maxParticipants?: number | null;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,16}(\.\d{1,2})?$/, { message: 'budgetAmount must be a decimal amount' })
  budgetAmount?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'budgetCurrency must be a 3-letter code' })
  budgetCurrency?: string | null;
}

/**
 * `POST /campaigns/:id/merchants` — step 2, replacing the participating set wholesale.
 *
 * Replace rather than append: a maker deselecting a merchant in the wizard expects it gone, and
 * an append-only endpoint would need a matching delete endpoint plus a client that keeps the two
 * in step. One idempotent call is both simpler and re-sendable after a lost response.
 */
export class SetCampaignMerchantsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Type(() => Number)
  @MatchesSharedContract(setCampaignMerchantsRequestSchema)
  merchantIds!: number[];
}

/** `GET /campaigns` — 03-API-CONTRACT.md §1's pagination and whitelisted filters. No generic
 * query DSL: every filter below is an explicit, enumerated parameter. */
export class ListCampaignsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsString()
  @Matches(/^(campaignCode|name|createdAt|status|startDate):(asc|desc)$/, {
    message: 'sort must be <field>:<asc|desc> over a supported field',
  })
  sort?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(draft|pending_approval|active|paused|completed|archived)$/, {
    message: 'status must be one of the six campaign statuses',
  })
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
