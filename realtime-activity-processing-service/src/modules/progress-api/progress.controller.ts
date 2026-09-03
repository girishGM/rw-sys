/**
 * T-RAP-040. `GET /progress/...` — the customer-facing read surface (`01-DATABASE.md` §4-§5,
 * `03-GRPC-CONTRACT.md` §1's own "a caller that needs to know the outcome ... polls the customer
 * progress API"). Every route is guarded by `ProgressApiAuthGuard` — no route here is ever public.
 *
 * `tenantId` always comes from the verified token (`request.progressAuth`), never from a query
 * parameter or the URL — an unauthenticated `tenantId` would let a caller read a different
 * tenant's data merely by changing a query string, which the guard's own `customerId` check alone
 * would not catch.
 */
import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ProgressApiAuthGuard, type RequestWithProgressAuth } from './progress-api-auth.guard';
import { ProgressService } from './progress.service';
import type { CampaignProgressResponse, TrackerProgressResponse } from './progress.types';

@Controller('progress')
@UseGuards(ProgressApiAuthGuard)
export class ProgressController {
  constructor(private readonly progressService: ProgressService) {}

  /** All trackers/components this customer has any materialized progress on, for one campaign. */
  @Get('customers/:customerId/campaigns/:campaignCode')
  async getCampaignProgress(
    @Param('customerId') customerId: string,
    @Param('campaignCode') campaignCode: string,
    @Req() request: RequestWithProgressAuth,
  ): Promise<CampaignProgressResponse> {
    return this.progressService.getCampaignProgress(
      request.progressAuth.tenantId,
      customerId,
      campaignCode,
    );
  }

  /** One tracker's own progress — the same per-tracker shape the "all trackers" call returns,
   * unwrapped, for a caller that only needs to render one progress bar. */
  @Get('customers/:customerId/campaigns/:campaignCode/trackers/:trackerCode')
  async getTrackerProgress(
    @Param('customerId') customerId: string,
    @Param('campaignCode') campaignCode: string,
    @Param('trackerCode') trackerCode: string,
    @Req() request: RequestWithProgressAuth,
  ): Promise<TrackerProgressResponse> {
    return this.progressService.getTrackerProgress(
      request.progressAuth.tenantId,
      customerId,
      campaignCode,
      trackerCode,
    );
  }
}
