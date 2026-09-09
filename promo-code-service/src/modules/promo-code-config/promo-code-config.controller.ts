/**
 * T-PC-011. The portal-facing REST surface over `PromoCodeConfigService` (T-PC-010) —
 * `04-API-CONTRACT.md` §1 (list) and §3 (admin CRUD). A thin adapter, per that service's own
 * header: DTO/query parsing, `tenantId`/`actorId` extraction, and typed-error → HTTP-status
 * translation (via `HttpExceptionFilter`) are all this controller does; every actual business
 * rule (structural validation, the `rewardUnit`-vs-`rewardValueType` cross-check, audit-row
 * writing, tenant scoping) lives in the service/repository layer this task never re-implements.
 *
 * Every route is guarded by `InternalServiceTokenGuard` (implementation note 2) — no route in
 * this controller is reachable without the shared internal-service bearer token.
 *
 * Code generation (`GenerateCode`) is deliberately absent from this controller —
 * `04-API-CONTRACT.md` §4: never exposed over REST, Kafka/gRPC only (T-PC-030/T-PC-031).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { PromoCodeConfigService, type PromoCodeConfigDetail } from './promo-code-config.service';
import { InternalServiceTokenGuard } from './guards/internal-service-token.guard';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import {
  parseListPromoCodeConfigsQuery,
  type ListPromoCodeConfigsQueryDto,
} from './dto/list-promo-code-configs.query.dto';
import { toPromoCodeConfigSummary } from './dto/promo-code-config-summary.response.dto';
import { parseAdminRequestEnvelope } from './dto/admin-request-envelope.dto';

@Controller('api/v1/promo-code-configs')
@UseGuards(InternalServiceTokenGuard)
@UseFilters(HttpExceptionFilter)
export class PromoCodeConfigController {
  constructor(private readonly service: PromoCodeConfigService) {}

  // `04-API-CONTRACT.md` §1. `tenantId` required (400 via `parseListPromoCodeConfigsQuery` if
  // missing, TC-3); `status` defaults server-side to `ACTIVE` (implementation note 6, TC-1);
  // `merchantId` optional (TC-4). Response is a bare array of the thin summary shape (TC-2;
  // T-PC-049 — the portal's generic lookup proxy requires a bare array, not a wrapped object).
  @Get()
  async list(
    @Query() query: Record<string, unknown>,
  ): Promise<ReturnType<typeof toPromoCodeConfigSummary>[]> {
    const parsed: ListPromoCodeConfigsQueryDto = parseListPromoCodeConfigsQuery(query);
    const configs = await this.service.listSummaries(parsed.tenantId, {
      merchantId: parsed.merchantId,
      status: parsed.status,
    });
    return configs.map(toPromoCodeConfigSummary);
  }

  // `04-API-CONTRACT.md` §3. `body` carries both the `{ tenantId, actorId }` envelope and the
  // config's own fields — the envelope is validated here, the config fields are validated by
  // `PromoCodeConfigService.create` itself (T-PC-010), which throws
  // `PromoCodeConfigValidationError`/`ConfigNameConflictError` on failure — both mapped to HTTP
  // status codes by `HttpExceptionFilter` (400/409, TC-9/TC-10/TC-11). T-PC-058: creates the
  // identity row plus its first `draft` version — the response's `versionStatus` is `'draft'`
  // until the caller separately calls `publish` below.
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: Record<string, unknown>): Promise<PromoCodeConfigDetail> {
    const envelope = parseAdminRequestEnvelope(body);
    return this.service.create(envelope.tenantId, body, envelope.actorId);
  }

  // T-PC-058. `POST /:id/versions` — opens a new `draft` version once the config's prior draft
  // has already been published and payout needs to change again (implementation note 3: "the
  // caller must first create one"). `DraftAlreadyExistsError` (409) if one is already open.
  @Post(':id/versions')
  @HttpCode(HttpStatus.CREATED)
  async createVersion(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<PromoCodeConfigDetail> {
    const envelope = parseAdminRequestEnvelope(body);
    const result = await this.service.createVersion(envelope.tenantId, id, body, envelope.actorId);
    if (!result) {
      throw new NotFoundException(`No promo code config "${id}" found for this tenant`);
    }
    return result;
  }

  // T-PC-058. `POST /:id/versions/:versionId/publish` — `draft -> published`, demoting whatever
  // was previously `published` (if anything) to `deprecated` in the same transaction.
  @Post(':id/versions/:versionId/publish')
  @HttpCode(HttpStatus.OK)
  async publish(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<PromoCodeConfigDetail> {
    const envelope = parseAdminRequestEnvelope(body);
    const result = await this.service.publish(envelope.tenantId, id, versionId, envelope.actorId);
    if (!result) {
      throw new NotFoundException(`No promo code config "${id}" found for this tenant`);
    }
    return result;
  }

  // TC-12/TC-13: a `tenantId` that doesn't own `id` is indistinguishable from a non-existent
  // `id` — both resolve to `404`, never a `403`/leaked existence (R3). T-PC-058: identity fields
  // (`name`/`merchantId`) are always directly editable; payout fields are only ever applied to
  // the config's own currently-open `draft` version — `NoOpenDraftError` (409) if none is open.
  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<PromoCodeConfigDetail> {
    const envelope = parseAdminRequestEnvelope(body);
    const updated = await this.service.update(envelope.tenantId, id, body, envelope.actorId);
    if (!updated) {
      throw new NotFoundException(`No promo code config "${id}" found for this tenant`);
    }
    return updated;
  }

  // TC-14/TC-15: soft-archive, idempotent — archiving an already-`ARCHIVED` config is a no-op
  // (`PromoCodeConfigService.archive`, T-PC-010), not a second write or an error. `tenantId`/
  // `actorId` travel as query params here (a `DELETE` request body is not universally supported
  // across HTTP intermediaries), validated by the same envelope schema as `create`/`update`.
  @Delete(':id')
  async archive(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PromoCodeConfigDetail> {
    const envelope = parseAdminRequestEnvelope(query);
    const archived = await this.service.archive(envelope.tenantId, id, envelope.actorId);
    if (!archived) {
      throw new NotFoundException(`No promo code config "${id}" found for this tenant`);
    }
    return archived;
  }
}
