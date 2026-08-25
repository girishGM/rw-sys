/**
 * T-042 — `POST /definition-requests`. `country_admin`/`tenant_admin` only (all three layers —
 * see `definition-requests.service.ts`).
 *
 * `requestingCountryId`/`requestingTenantId` are never accepted here (AGENT-PROTOCOL R3): the
 * service always derives them from the actor's own scope, and `ScopedRepository.create` forces
 * them a second time regardless of what this DTO's shape allows (TC-2). The
 * `entityId`-required-for-`update_*` rule is a business rule about the *value*, not the shape —
 * checked in the service, the same split `create-rule.dto.ts` vs `RulesService` draws.
 */
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  BUSINESS_JUSTIFICATION_MAX_LENGTH,
  DEFINITION_REQUEST_PRIORITIES,
  DEFINITION_REQUEST_TYPES,
  DESCRIPTION_MIN_LENGTH,
  TITLE_MAX_LENGTH,
  type DefinitionRequestPriorityValue,
  type DefinitionRequestTypeValue,
} from '../definition-requests.constants';

export class CreateDefinitionRequestDto {
  @IsIn(DEFINITION_REQUEST_TYPES)
  requestType!: DefinitionRequestTypeValue;

  /** Required for `update_rule`/`update_reward`; must be absent for `new_rule`/`new_reward`
   * (checked in the service, not here). */
  @IsOptional()
  @IsInt()
  entityId?: number;

  @IsString()
  @MinLength(3)
  @MaxLength(TITLE_MAX_LENGTH)
  title!: string;

  @IsString()
  @MinLength(DESCRIPTION_MIN_LENGTH)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(BUSINESS_JUSTIFICATION_MAX_LENGTH)
  businessJustification?: string;

  /** `definition_requests.desired_by` is `date`, not `timestamptz` — `YYYY-MM-DD` only. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  desiredBy?: string;

  @IsOptional()
  @IsIn(DEFINITION_REQUEST_PRIORITIES)
  priority?: DefinitionRequestPriorityValue;
}
