/**
 * T-040 — query params for `/audit/campaigns` and `/audit/portal`, plus their `/export`
 * siblings.
 *
 * Implementation note 7: *"Filters: date range, actor, action, entity type. All whitelisted
 * server-side — never an arbitrary column name from the client."* The whitelist is this class
 * itself: the global `ValidationPipe` (`main.ts`) runs with `whitelist: true,
 * forbidNonWhitelisted: true`, so a query key that is not one of the properties below is a 400
 * before a handler ever runs (TC-16) — the same mechanism `list-countries-query.dto.ts` (T-030)
 * already relies on for the identical requirement. There is deliberately no "sort by any column"
 * escape hatch: every list here has exactly one order (newest first), so there is nothing to
 * whitelist a sort column *for*.
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, Matches, Min } from 'class-validator';
import { CAMPAIGN_AUDIT_ACTION, CAMPAIGN_AUDIT_ENTITY_TYPE } from '@/common/audit/audit.constants';
import { AUDIT_TOKEN_PATTERN } from '../audit.constants';

const CAMPAIGN_AUDIT_ACTIONS = Object.values(CAMPAIGN_AUDIT_ACTION);
const CAMPAIGN_AUDIT_ENTITY_TYPES = Object.values(CAMPAIGN_AUDIT_ENTITY_TYPE);

export class ListCampaignAuditQueryDto {
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  /** `campaign_audit_trail.performed_by` — a `reward_config.admin_users` id (see T-014). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  actorId?: number;

  @IsOptional()
  @IsIn(CAMPAIGN_AUDIT_ACTIONS)
  action?: (typeof CAMPAIGN_AUDIT_ACTIONS)[number];

  @IsOptional()
  @IsIn(CAMPAIGN_AUDIT_ENTITY_TYPES)
  entityType?: (typeof CAMPAIGN_AUDIT_ENTITY_TYPES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  campaignId?: number;

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
}

export class ListPortalAuditQueryDto {
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  /** `portal_audit_log.actor_id` — a `reward_portal.portal_users` id. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  actorId?: number;

  @IsOptional()
  @Matches(AUDIT_TOKEN_PATTERN)
  eventType?: string;

  @IsOptional()
  @Matches(AUDIT_TOKEN_PATTERN)
  targetType?: string;

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
}
