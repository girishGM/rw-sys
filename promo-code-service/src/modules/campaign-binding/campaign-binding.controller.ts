/**
 * T-PC-012. `POST /api/v1/campaign-promo-configs` (`04-API-CONTRACT.md` §2) — a thin adapter
 * over `CampaignBindingService`: body parsing, and typed-error → HTTP-status translation (via
 * this module's own `HttpExceptionFilter`) are all this controller does; every actual business
 * rule (config-active check, deactivate-then-create transaction, the retryable race) lives in
 * the service layer.
 *
 * Guarded by `InternalServiceTokenGuard`, imported from the sibling `promo-code-config` module
 * rather than duplicated — both modules are owned by this same agent
 * (`internal-service-token.guard.ts`'s own header already anticipates this).
 *
 * No `unbind`/`DELETE` route — `04-API-CONTRACT.md` §2 defines rebinding via a new `POST` as the
 * only mutation this contract specifies (Scope "Out").
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { InternalServiceTokenGuard } from '../promo-code-config/guards/internal-service-token.guard';
import { CampaignBindingService } from './campaign-binding.service';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import {
  toCampaignPromoConfigResponse,
  type CampaignPromoConfigResponseDto,
} from './dto/campaign-promo-config.response.dto';

@Controller('api/v1/campaign-promo-configs')
@UseGuards(InternalServiceTokenGuard)
@UseFilters(HttpExceptionFilter)
export class CampaignBindingController {
  constructor(private readonly service: CampaignBindingService) {}

  // `04-API-CONTRACT.md` §2. `body` carries `promoCodeConfigId`/`tenantId`/`bindLevel`/
  // `bindRefId`/`boundBy` directly (no separate envelope, unlike the admin CRUD surface —
  // this endpoint's whole body *is* the bind request). `CampaignBindingService.bind` parses and
  // validates it, throwing `CampaignBindingValidationError` (400, TC-9) or `ConfigNotActiveError`
  // (409, TC-2/TC-3/TC-4) — both mapped to HTTP status codes by `HttpExceptionFilter`.
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async bind(@Body() body: Record<string, unknown>): Promise<CampaignPromoConfigResponseDto> {
    const created = await this.service.bind(body);
    return toCampaignPromoConfigResponse(created);
  }
}
