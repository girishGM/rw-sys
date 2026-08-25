/**
 * T-039 — `/merchant/campaigns`, `/merchant/campaigns/:id`, `/merchant/summary`
 * (03-API-CONTRACT.md §13).
 *
 * ### `@Roles('merchant')` at the controller — do not widen this
 *
 * TC-16: `maker` (or any other role) calling this surface must get 403, not scope down to an
 * empty list. `@RequirePermission(CAMPAIGN_ENTITY, 'view')` alone would not do that — every other
 * role also holds `campaign:view` (01-DATABASE.md §5.1's matrix), so a `tenant_admin` would pass
 * that check and only then discover `ScopedRepository`'s `merchant` scope rule does not apply to
 * it. `@Roles('merchant')` is the static, non-configurable statement that this whole controller is
 * merchant-only (`common/rbac/decorators/roles.decorator.ts`'s own header: *"a Super Admin editing
 * `role_entity_permissions` ... cannot put `merchant` on a route annotated `@Roles('super_admin')`"*
 * — the same reasoning in the other direction). `@RequirePermission` stays alongside it as the
 * second, independent, runtime-configurable layer T-013's own two-layer design asks for
 * (`require-permission.decorator.ts`'s own header) — mirroring the shape
 * `audit-viewer.controller.ts`'s header documents for its own `@RequirePermission`+`@Roles` pair.
 *
 * ### No write route at all (implementation note 3, TC-10/TC-11/TC-12)
 *
 * Every handler below is `@Get`. Searching this directory for `@Post`/`@Patch`/`@Put`/`@Delete`
 * (verification step 5) returns nothing — the merchant role has no write endpoint anywhere in this
 * module, and `ScopedRepository`'s own strategy for every table this service reads never grants a
 * write path to it either (`TenantCampaign`/`CampaignMerchant`/`MerchantActivity` all narrow the
 * `merchant` axis to reads the service never calls `.create`/`.update`/`.destroy` with).
 */
import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { CAMPAIGN_ENTITY } from './merchant-portal.constants';
import { MerchantPortalService } from './merchant-portal.service';
import {
  envelope,
  type DataEnvelope,
  type MerchantCampaignDetailDto,
  type MerchantCampaignListItemDto,
  type MerchantSummaryDto,
} from './dto/merchant-campaign-response.dto';

@Controller('merchant')
@Roles('merchant')
export class MerchantPortalController {
  constructor(private readonly merchantPortal: MerchantPortalService) {}

  @Get('campaigns')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async listCampaigns(
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DataEnvelope<readonly MerchantCampaignListItemDto[]>> {
    return envelope(await this.merchantPortal.listCampaigns(actor));
  }

  @Get('campaigns/:id')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async getCampaign(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<MerchantCampaignDetailDto>> {
    return envelope(await this.merchantPortal.getCampaign(actor, id));
  }

  @Get('summary')
  @RequirePermission(CAMPAIGN_ENTITY, 'view')
  async getSummary(
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DataEnvelope<MerchantSummaryDto>> {
    return envelope(await this.merchantPortal.getSummary(actor));
  }
}
