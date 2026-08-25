/**
 * T-033 — `POST /admin/access-control/preview` (implementation note 6): runs the same bootstrap
 * builder `GET /me/bootstrap` uses against **uncommitted** config and returns what the role would
 * see. Nothing is persisted (TC-17, verification step 7).
 *
 * `role` is the only required field. `nav`/`permissions`/`widgets` are the draft a Super Admin is
 * mid-editing on screen and has not saved yet; whichever of the three is omitted previews the
 * role's current, already-committed rows instead — so a Super Admin can preview "just this nav
 * change" without first having to also resupply the permission matrix and the widget list
 * unchanged.
 */
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, ValidateNested } from 'class-validator';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import type { PortalRole } from '@/database/portal-models';
import { NavConfigItemDto } from './nav-config.dto';
import { WidgetConfigItemDto } from './widget-config.dto';
import { IsPermissionsMatrix } from './access-control-validators.decorators';

export class PreviewDto {
  @IsIn(ALL_PORTAL_ROLES)
  role!: PortalRole;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NavConfigItemDto)
  nav?: NavConfigItemDto[];

  @IsOptional()
  @IsPermissionsMatrix()
  permissions?: Record<string, string[]>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WidgetConfigItemDto)
  widgets?: WidgetConfigItemDto[];
}
