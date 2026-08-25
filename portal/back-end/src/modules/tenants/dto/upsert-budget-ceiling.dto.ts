/**
 * T-034 — `PUT /tenants/:id/budget-ceilings` (11-BUDGETS-AND-LIMITS.md §8.2).
 *
 * One unit per call — `uq_tbc unique (tenant_id, unit_type, unit_code)` is "one row per unit"
 * (implementation note 7), and TC-21/TC-22 each independently "set a … ceiling" as their own
 * action, so this is a full-resource **upsert** of exactly one `(unitType, unitCode)` row, not a
 * partial patch: `maxCampaignBudget` is required on every call, the same way a `PUT` replaces
 * the resource it names rather than merging into it.
 *
 * `maxCampaignBudget`/`warnAboveAmount` are decimal **strings**, never `number` — the model's own
 * header states why: *"money never crosses a boundary as a float"*. `WarnAboveNotExceedingCeiling`
 * is `ck_tbc_warn` enforced client-of-the-database-side, as a 400 (TC-27), not a 422: a warning
 * threshold that can never fire is a malformed request, not a business rule this task's own data
 * forbids situationally.
 */
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  TENANT_BUDGET_CEILING_UNIT_CODE_MAX_LENGTH,
  TENANT_BUDGET_CEILING_UNIT_TYPES,
  type TenantBudgetCeilingUnitType,
} from '../tenants.constants';
import {
  IsDecimalString,
  IsPositiveDecimalString,
  WarnAboveNotExceedingCeiling,
} from './tenant-validators.decorators';

export class UpsertBudgetCeilingDto {
  /** `ck_tbc_unit`. */
  @IsIn(TENANT_BUDGET_CEILING_UNIT_TYPES)
  unitType!: TenantBudgetCeilingUnitType;

  @IsString()
  @MaxLength(TENANT_BUDGET_CEILING_UNIT_CODE_MAX_LENGTH)
  unitCode!: string;

  /** `ck_tbc_positive` — strictly greater than zero. */
  @IsPositiveDecimalString()
  maxCampaignBudget!: string;

  @IsOptional()
  @IsDecimalString()
  @WarnAboveNotExceedingCeiling()
  warnAboveAmount?: string;
}
