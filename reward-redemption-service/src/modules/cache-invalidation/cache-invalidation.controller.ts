/**
 * T-RR-007. `POST /api/v1/cache/invalidate` (`04-REST-CONTRACT.md` §4) — a thin adapter (R10):
 * auth (`CacheAdminAuthGuard`) plus a direct delegation to `CacheInvalidationService`, no business
 * logic of its own.
 */
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { CACHE_ADMIN_INVOKED_BY, CacheAdminAuthGuard } from './cache-admin-auth.guard';
import type {
  CacheInvalidateRequest,
  CacheInvalidateResponse,
} from './cache-invalidate-request.dto';
import { CacheInvalidationService } from './cache-invalidation.service';

@Controller('api/v1/cache')
export class CacheInvalidationController {
  constructor(private readonly service: CacheInvalidationService) {}

  @Post('invalidate')
  @UseGuards(CacheAdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  async invalidate(@Body() body: CacheInvalidateRequest): Promise<CacheInvalidateResponse> {
    return this.service.invalidate(body ?? {}, CACHE_ADMIN_INVOKED_BY);
  }
}
