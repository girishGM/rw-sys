/**
 * T-033 — `/admin/access-control` (03-API-CONTRACT.md §4). The flagship Super Admin screen.
 *
 * Implementation note 1: "Every one is `@Roles('super_admin')` **and**
 * `@RequirePermission('access_control', …)`." `@Roles('super_admin')` is declared once at the
 * controller level (layer 1, static — 00-ARCHITECTURE.md §5.4); every route additionally carries
 * its own `@RequirePermission` (layer 2, data-driven). Neither substitutes for the other, the same
 * two-layer story `rules.controller.ts`/`rules.service.ts` tell for the `rule`/`reward` product
 * rule — except here layer 1 alone is already enough to keep a non-super-admin out, because
 * `access_control` is not merely "the entity this route touches", it *is* the mechanism that
 * would otherwise let a compromised or misconfigured permission row re-grant itself. `RolesGuard`
 * runs at position 7 of the global chain, before `PermissionsGuard` at position 8, so a request
 * that is not `super_admin` never reaches the permission check at all.
 *
 * The four extra guards duplicated at class level below mirror `mfa-admin.controller.ts`'s own
 * precedent for the *same* `admin/access-control` path prefix (T-055): this is one of the two
 * routes in the whole API where "the global provider list was edited" must not silently reopen
 * the door, because the door this screen guards is the one every other lock-out recovery would
 * have to go through. Two separate `@Controller('admin/access-control')` classes, in two modules
 * (`AuthModule`'s `MfaAdminController` and this one), is deliberate — see that file's own header
 * for why its one route was not declared here instead.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { SessionValidGuard } from '@/modules/auth/guards/session-valid.guard';
import { PasswordChangeRequiredGuard } from '@/modules/auth/guards/password-change-required.guard';
import { MfaRequiredGuard } from '@/modules/auth/guards/mfa-required.guard';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import type { PortalRole } from '@/database/portal-models';
import { AccessControlService } from './access-control.service';
import { ACCESS_CONTROL_ENTITY } from './access-control.constants';
import { PortalRoleParam } from './dto/portal-role.param';
import { PutNavConfigDto } from './dto/nav-config.dto';
import { PutPermissionsDto } from './dto/permission-matrix.dto';
import { PreviewDto } from './dto/preview.dto';
import { ReorderDto } from './dto/reorder.dto';
import { PutWidgetConfigDto } from './dto/widget-config.dto';
import {
  envelope,
  type DataEnvelope,
  type EntityCatalogueEntry,
  type NavConfigResponse,
  type PermissionsResponse,
  type PreviewResponse,
  type RoleSummaryDto,
  type WidgetConfigResponse,
} from './dto/access-control-response.dto';

@Controller('admin/access-control')
@UseGuards(JwtAuthGuard, SessionValidGuard, PasswordChangeRequiredGuard, MfaRequiredGuard)
@Roles('super_admin')
export class AccessControlController {
  constructor(private readonly service: AccessControlService) {}

  @Get('roles')
  @RequirePermission(ACCESS_CONTROL_ENTITY, 'view')
  async listRoles(): Promise<DataEnvelope<readonly RoleSummaryDto[]>> {
    return envelope(await this.service.listRoles());
  }

  @Get('entities')
  @RequirePermission(ACCESS_CONTROL_ENTITY, 'view')
  listEntities(): DataEnvelope<readonly EntityCatalogueEntry[]> {
    return envelope(this.service.listEntities());
  }

  @Get('nav/:role')
  @RequirePermission(ACCESS_CONTROL_ENTITY, 'view')
  async getNav(
    @Param('role', PortalRoleParam) role: PortalRole,
  ): Promise<DataEnvelope<NavConfigResponse>> {
    return envelope(await this.service.getNav(role));
  }

  @Put('nav/:role')
  @RequirePermission(ACCESS_CONTROL_ENTITY, 'update')
  @Audit({ event: 'nav_config_updated', targetType: 'role_nav_config' })
  async putNav(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('role', PortalRoleParam) role: PortalRole,
    @Body() dto: PutNavConfigDto,
  ): Promise<DataEnvelope<NavConfigResponse>> {
    return envelope(await this.service.putNav(actor, role, dto));
  }

  @Patch('nav/:role/reorder')
  @RequirePermission(ACCESS_CONTROL_ENTITY, 'update')
  @Audit({ event: 'nav_config_reordered', targetType: 'role_nav_config' })
  async reorderNav(
    @Param('role', PortalRoleParam) role: PortalRole,
    @Body() dto: ReorderDto,
  ): Promise<DataEnvelope<NavConfigResponse>> {
    return envelope(await this.service.reorderNav(role, dto));
  }

  @Get('permissions/:role')
  @RequirePermission(ACCESS_CONTROL_ENTITY, 'view')
  async getPermissions(
    @Param('role', PortalRoleParam) role: PortalRole,
  ): Promise<DataEnvelope<PermissionsResponse>> {
    return envelope(await this.service.getPermissions(role));
  }

  @Put('permissions/:role')
  @RequirePermission(ACCESS_CONTROL_ENTITY, 'update')
  @Audit({ event: 'permissions_updated', targetType: 'role_entity_permission' })
  async putPermissions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('role', PortalRoleParam) role: PortalRole,
    @Body() dto: PutPermissionsDto,
  ): Promise<DataEnvelope<PermissionsResponse>> {
    return envelope(await this.service.putPermissions(actor, role, dto));
  }

  @Get('widgets/:role')
  @RequirePermission(ACCESS_CONTROL_ENTITY, 'view')
  async getWidgets(
    @Param('role', PortalRoleParam) role: PortalRole,
  ): Promise<DataEnvelope<WidgetConfigResponse>> {
    return envelope(await this.service.getWidgets(role));
  }

  @Put('widgets/:role')
  @RequirePermission(ACCESS_CONTROL_ENTITY, 'update')
  @Audit({ event: 'widgets_updated', targetType: 'role_dashboard_widget' })
  async putWidgets(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('role', PortalRoleParam) role: PortalRole,
    @Body() dto: PutWidgetConfigDto,
  ): Promise<DataEnvelope<WidgetConfigResponse>> {
    return envelope(await this.service.putWidgets(actor, role, dto));
  }

  @Patch('widgets/:role/reorder')
  @RequirePermission(ACCESS_CONTROL_ENTITY, 'update')
  @Audit({ event: 'widgets_reordered', targetType: 'role_dashboard_widget' })
  async reorderWidgets(
    @Param('role', PortalRoleParam) role: PortalRole,
    @Body() dto: ReorderDto,
  ): Promise<DataEnvelope<WidgetConfigResponse>> {
    return envelope(await this.service.reorderWidgets(role, dto));
  }

  /** `POST /admin/access-control/preview` — implementation note 6. `@HttpCode(200)`: this is a
   * read (nothing is created), the same reasoning `campaign-usage.query.ts`-backed endpoints use
   * elsewhere for a `POST` that computes rather than mutates. */
  @Post('preview')
  @HttpCode(200)
  @RequirePermission(ACCESS_CONTROL_ENTITY, 'view')
  async preview(@Body() dto: PreviewDto): Promise<DataEnvelope<PreviewResponse>> {
    return envelope(await this.service.preview(dto));
  }
}
