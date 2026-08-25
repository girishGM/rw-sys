/**
 * T-092 — `DashboardController`: thin, and metadata-driven. Same shape
 * `countries.controller.spec.ts`/`merchant-portal.controller.spec.ts` establish — the 403
 * behaviour itself is `RolesGuard`'s (already exhaustively tested, T-013), so this suite proves
 * the controller carries the right `@Roles` metadata (R6) and delegates without adding logic.
 */
import 'reflect-metadata';
import { ROLES_METADATA_KEY } from '@/common/rbac/rbac.constants';
import type { PortalRole } from '@/database/portal-models';
import { DashboardController } from '@/modules/dashboard/dashboard.controller';
import type { DashboardService } from '@/modules/dashboard/dashboard.service';
import { actor } from './support/dashboard-doubles';

const ALL_SIX_ROLES: readonly PortalRole[] = [
  'super_admin',
  'country_admin',
  'tenant_admin',
  'maker',
  'checker',
  'merchant',
];

describe('DashboardController', () => {
  it('GET /dashboard/widgets/:widgetKey carries @Roles for every one of the six portal roles (R6)', () => {
    const roles = Reflect.getMetadata(
      ROLES_METADATA_KEY,
      DashboardController.prototype.getWidgetData,
    ) as readonly PortalRole[];

    expect([...roles].sort()).toEqual([...ALL_SIX_ROLES].sort());
  });

  it('delegates to DashboardService.getWidgetData with the actor and the path param, enveloped', async () => {
    const getWidgetData = jest.fn().mockResolvedValue({ value: 3 });
    const controller = new DashboardController({
      getWidgetData,
    } as unknown as DashboardService);
    const who = actor();

    const result = await controller.getWidgetData(who, 'kpi_countries');

    expect(getWidgetData).toHaveBeenCalledWith(who, 'kpi_countries');
    expect(result).toEqual({ data: { value: 3 } });
  });
});
