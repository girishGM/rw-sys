/**
 * T-037 step 3 — the journey builder's request bodies (04-FRONTEND.md §5.3).
 *
 * `trackerCode` and `componentCode` appear in **none** of these. Both columns are `NOT NULL` and
 * unique per tenant, but they are plumbing rather than a business decision, and a "code" field in
 * a visual journey builder is exactly the incidental complexity §5.3's two-pane design leaves
 * out. `journey.service.ts#generateCode` produces them; see `campaigns.constants.ts`.
 *
 * `groupCode` is likewise absent — implementation note 7c: the wizard writes
 * `tracker_tracker_components.group_code = NULL` throughout, and grouping is deferred by design
 * (12-CAMPAIGN-STRUCTURE.md §1.5). Exposing it would let a maker build a structure the runtime
 * cannot yet evaluate.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  createComponentRequestSchema,
  createTrackerRequestSchema,
  reorderComponentsRequestSchema,
  updateComponentRequestSchema,
  updateTrackerRequestSchema,
  TRACKER_COMPLETION_LOGICS,
} from '@reward-portal/shared';
import { MatchesSharedContract } from './shared-contract.decorator';

/** `POST /campaigns/:id/trackers`. */
export class CreateTrackerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @MatchesSharedContract(createTrackerRequestSchema)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** `ck_trk_logic`. This is where *"complete any 2 of 3"* is configured (04-FRONTEND.md §5.3). */
  @IsIn([...TRACKER_COMPLETION_LOGICS])
  completionLogic!: 'all' | 'any' | 'n_of';

  /**
   * Required for `n_of` (enforced by the shared contract). Its relationship to the **component
   * count** — ≥ 1 and ≤ count, implementation note 4 — is checked in the service on every write
   * that could break it, because no request carries the count and no CHECK constraint can span
   * two tables (TC-21e/TC-21f/TC-21g).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  completionThreshold?: number;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

/** `PATCH /campaigns/:id/trackers/:trackerId`. */
export class UpdateTrackerDto {
  /** No `@IsOptional()`: this property carries the whole-DTO contract check, which
   * `@IsOptional()` would silently disable whenever `name` is omitted. See
   * `shared-contract.decorator.ts`. */
  @MatchesSharedContract(updateTrackerRequestSchema)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsIn([...TRACKER_COMPLETION_LOGICS])
  completionLogic?: 'all' | 'any' | 'n_of';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  completionThreshold?: number | null;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

/**
 * `POST /campaigns/:id/trackers/:trackerId/components`.
 *
 * `activityId` is the component's **only** targeting dimension in v1 — no product or SKU
 * selector exists or may be added (implementation note 7b, 12-CAMPAIGN-STRUCTURE.md §2, BACKLOG
 * B-14). The service checks it against `merchant_activities` for the campaign's own step-2
 * merchants (note 8, TC-21h); the client-side filter is convenience only.
 */
export class CreateComponentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @MatchesSharedContract(createComponentRequestSchema)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsInt()
  @IsPositive()
  activityId!: number;

  /** Display and intent order — **not an enforced gate** in v1 (implementation note 6). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  sequenceOrder?: number;

  /** Overrides `n_of` (implementation note 5): a mandatory component is always required. */
  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;
}

/** `PATCH /campaigns/:id/components/:componentId`. */
export class UpdateComponentDto {
  /** No `@IsOptional()`, for the reason {@link UpdateTrackerDto.name} gives. */
  @MatchesSharedContract(updateComponentRequestSchema)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsInt()
  @IsPositive()
  activityId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  sequenceOrder?: number;

  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;

  /**
   * T-147 — the component's "rules combine" contract, mirroring `completionLogic`/
   * `completionThreshold` above one level up. Cross-field "n_of needs a threshold, anything else
   * forbids one" is enforced by `updateComponentRequestSchema`'s own refine, run via `name`'s
   * `@MatchesSharedContract` above — see that decorator's header on why it must stay off a
   * property carrying `@IsOptional()`.
   */
  @IsOptional()
  @IsIn([...TRACKER_COMPLETION_LOGICS])
  ruleLogic?: 'all' | 'any' | 'n_of';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  ruleThreshold?: number | null;
}

/** One entry of {@link ReorderComponentsDto}. */
export class ComponentOrderEntryDto {
  @IsInt()
  @IsPositive()
  componentId!: number;

  @IsInt()
  @Min(1)
  @Max(1000)
  sequenceOrder!: number;
}

/**
 * `PATCH /campaigns/:id/trackers/:trackerId/order` — TC-21b, "set 1,2,3 then reorder to 2,1,3".
 *
 * The whole order in one call rather than a `PATCH` per component: a drag-and-drop reorder is
 * one user action, and three round trips would leave the tree in an intermediate order if the
 * second failed.
 */
export class ReorderComponentsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ComponentOrderEntryDto)
  @MatchesSharedContract(reorderComponentsRequestSchema)
  order!: ComponentOrderEntryDto[];
}
