/**
 * T-092 — `/dashboard/widgets/:widgetKey`, the route `front-end/src/features/dashboard/widgets/
 * api.ts` has called since T-023 and nothing has ever served (this module's own header has the
 * full evidence chain).
 *
 * ### Authorisation
 *
 * `@Roles(...ALL_PORTAL_ROLES)` — `04-FRONTEND.md` §4 lists "Dashboard" as `all`, and
 * `RolesGuard` denies a route that declares no authorisation metadata at all (T-013 TC-18), so
 * "everyone may" has to be said explicitly, the same reasoning `me.controller.ts`'s own header
 * gives for its identical annotation. There is deliberately **no** `@RequirePermission`: a
 * dashboard tile is not an entity in `role_entity_permissions`, and which tiles an actor may
 * request is already answered by data — `role_dashboard_widgets` itself, gate 1 of
 * `dashboard.service.ts`'s own header — not by a second, redundant permission row a Super Admin
 * would have to keep in sync with the first.
 *
 * Thin by design, the shape `countries.controller.ts`/`merchant-portal.controller.ts` establish:
 * read the request, call the service, envelope the response.
 */
import { Controller, Get, Param } from '@nestjs/common';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';
import { envelope, type DataEnvelope, type WidgetData } from './dto/dashboard-widget-response.dto';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('widgets/:widgetKey')
  @Roles(...ALL_PORTAL_ROLES)
  async getWidgetData(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('widgetKey') widgetKey: string,
  ): Promise<DataEnvelope<WidgetData>> {
    return envelope(await this.dashboard.getWidgetData(actor, widgetKey));
  }
}
