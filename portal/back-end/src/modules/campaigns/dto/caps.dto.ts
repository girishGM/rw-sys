/**
 * T-037 step 6 — budgets and limits (11-BUDGETS-AND-LIMITS.md §6).
 *
 * ### One DTO, one discriminator
 *
 * `cap_class` is the column the schema was missing (§1.2) and the reason this is one shape
 * rather than two: *"budgets and limits share the same enforcement mechanism … the only
 * difference is the counter key — campaign-wide versus per-customer"* (§2). The **UI** separates
 * them visually, because confusing a pooled budget with a per-customer limit is the expensive
 * mistake; the **wire** keeps them together, because splitting them would duplicate the period
 * vocabulary and let the two copies drift.
 *
 * ### Every refinement here mirrors a live CHECK constraint
 *
 * `ck_cc_ref`, `ck_cc_has_ceiling`, `ck_cc_unit`, `ck_cc_customers`, `ck_cc_rolling`,
 * `ck_cc_window` — all six are enforced by `campaignCapInputSchema` (shared, so the SPA enforces
 * them identically) and, authoritatively, by Postgres. This layer exists so a maker sees the
 * problem next to the field instead of receiving a constraint-violation 500; it never *replaces*
 * the database's own check. TC-21w (*"budget amount with no currency → 400 — client and server
 * both reject"*) is the case that names all three layers at once.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CAP_CLASSES,
  CAP_ON_BREACH,
  CAP_PERIOD_TYPES,
  CAP_SCOPE_LEVELS,
  CAP_UNIT_TYPES,
  campaignCapInputSchema,
  putCampaignCapsRequestSchema,
} from '@reward-portal/shared';
import { MatchesSharedContract } from './shared-contract.decorator';

/** One `campaign_caps` row, as the wizard sends it. */
export class CampaignCapDto {
  /** `budget` = pooled across all customers; `limit` = per individual customer (§2). */
  @IsIn([...CAP_CLASSES])
  @MatchesSharedContract(campaignCapInputSchema)
  capClass!: 'budget' | 'limit';

  @IsIn([...CAP_SCOPE_LEVELS])
  scopeLevel!: 'campaign' | 'tracker' | 'component';

  /** `tracker_id` / `component_id`; must be absent at campaign scope (`ck_cc_ref`). Validated
   * against **this campaign's own** trackers and components by the service — a tracker id from
   * another campaign is a 400, not a silently orphaned cap. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  scopeRefId?: number | null;

  @IsIn([...CAP_PERIOD_TYPES])
  periodType!: 'lifetime' | 'daily' | 'monthly' | 'rolling_hours' | 'time_of_day';

  /** N, for `rolling_hours` only. Capped at 87 600 (ten years) so a typo cannot express a
   * window longer than any campaign. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(87_600)
  periodValue?: number | null;

  /** `time_of_day` only — the happy-hour window §3 row 4 describes. */
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, { message: 'must be HH:MM or HH:MM:SS' })
  windowStartTime?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, { message: 'must be HH:MM or HH:MM:SS' })
  windowEndTime?: string | null;

  /** Omitted lets `trg_cc_default_timezone` (T006_001) fill it from the campaign's country —
   * §4.2: *"a Malaysian campaign resets at midnight Kuala Lumpur time"*, not UTC. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  periodTimezone?: string | null;

  /** §3.1 — **there is no conversion rate**. A points grant can never consume an MYR budget. */
  @IsOptional()
  @IsIn([...CAP_UNIT_TYPES])
  unitType?: 'currency' | 'points' | 'voucher' | null;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9_]{1,10}$/, { message: 'unitCode must be up to 10 upper-case characters' })
  unitCode?: string | null;

  /** Optional narrowing; absent means "all reward types in this unit". Deliberately
   * unconstrained — `reward_systems.reward_type` is free text with legacy rows (§3.1). */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  rewardType?: string | null;

  /** Decimal **string**, `decimal(18,4)`. Never a float — §5. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,14}(\.\d{1,4})?$/, { message: 'maxTotalAmount must be a decimal amount' })
  maxTotalAmount?: string | null;

  /** TC-21v — "3 grants per day" needs no amount at all. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxOccurrences?: number | null;

  /** Pooled idea only; `ck_cc_customers` rejects it on a `limit` row. */
  @IsOptional()
  @IsInt()
  @Min(1)
  maxCustomers?: number | null;

  /** §4.5. `pause_campaign` is delivered through the mTLS breach callback (09-INTEGRATION.md
   * §7a, AR-01), not through the read-only gRPC contract — that is T-047's half, not this one's;
   * storing the intent here is. */
  @IsOptional()
  @IsIn([...CAP_ON_BREACH])
  onBreach?: 'reject' | 'pause_campaign' | 'alert_only';

  /** e.g. 80 — *"so someone is told **before** the campaign stops, not after customers start
   * being refused"* (§4.5). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  warnAtPercent?: number | null;
}

/**
 * `PUT /campaigns/:id/caps` (03-API-CONTRACT.md §11) — the whole cap set, replaced atomically.
 *
 * Replace rather than per-row CRUD for the same reason step 2's merchant set is replaced: step 6
 * is one screen the maker edits as a unit, and `uq_cc_unique` makes an incremental protocol a
 * sequence of conflicts to reconcile client-side.
 */
export class PutCampaignCapsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CampaignCapDto)
  @MatchesSharedContract(putCampaignCapsRequestSchema)
  caps!: CampaignCapDto[];

  /** TC-21bb — a cap in a currency other than the campaign's is legitimate but almost always a
   * mistake, so it takes one deliberate acknowledgement rather than a silent accept. */
  @IsOptional()
  @IsBoolean()
  confirmCurrencyMismatch?: boolean;
}
