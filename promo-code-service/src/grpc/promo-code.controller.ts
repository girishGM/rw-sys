/**
 * T-PC-031. The gRPC transport adapter — `GenerateCode` and `ListActivePromoCodeConfigs`
 * (`03-GRPC-CONTRACT.md` §1). Per R10/`ARCHITECTURE.md` §6 ("no business logic lives in a
 * transport adapter") and this task's own implementation note 7, this controller does exactly
 * three things for `GenerateCode`: map the proto request to
 * `PromoCodeGenerationService.generateCode()`'s transport-neutral input shape (with
 * `transport: 'GRPC'`), call it, map the transport-neutral `GenerationResult` back onto the proto
 * response shape. No collision retry, no idempotency check, no binding resolution happens here —
 * TC-12 is a grep-based code-inspection check for exactly this.
 *
 * `ListActivePromoCodeConfigs` is a thin read against `PromoCodeConfigRepository.list()`
 * (T-PC-010) — the same method `GET /api/v1/promo-code-configs` (T-PC-011) calls — so the two
 * surfaces can never drift on which configs count as "active" or how tenant/merchant scoping
 * applies (implementation note 8).
 *
 * Guarded by `MtlsGuard` at the class level — every RPC on this controller requires an
 * allowlisted client certificate (implementation note 5); there is no per-method opt-out.
 *
 * **T-PC-047.** `GenerateCode` runs its entire body inside `CorrelationContextService.run(...)`,
 * keyed by this request's own `correlation_id`/`tenant_id` — the same gap-closing fix
 * `generate-requested.consumer.ts` applies on the Kafka side, and the reason `GrpcServerModule` now
 * also imports `LoggingModule` (see that module's own header). `ListActivePromoCodeConfigs` is
 * deliberately left unwrapped: its proto request has no `correlation_id` field at all (§1) — there
 * is nothing this RPC could key a correlation context on that wouldn't be invented, not read from
 * "the envelope/request's own correlationId" as the defect's evidence specifically asks for.
 * `GenerateCode` also emits one entry-point log line of its own, same discipline
 * `correlation-context.middleware.ts` documents for the HTTP transport ("a request that touches no
 * other logger call site still has at least one structured line to grep by correlationId") — the
 * Kafka/gRPC "once wired" follow-up that middleware's own header explicitly flags this task as
 * closing.
 */
import { Controller, Logger, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { PromoCodeGenerationService } from '../modules/generation/promo-code-generation.service';
import type { GenerationResult } from '../modules/generation/generation-result.types';
import { PromoCodeConfigRepository } from '../modules/promo-code-config/promo-code-config.repository';
import { toPromoCodeConfigSummary } from '../modules/promo-code-config/dto/promo-code-config-summary.response.dto';
import { CorrelationContextService } from '../observability/logging/correlation-context.service';
import { MtlsGuard } from './mtls.guard';
import { GRPC_SERVICE_NAME } from './grpc-server.config';
import type {
  GenerateCodeRequestProto,
  GenerateCodeResponseProto,
  ListActivePromoCodeConfigsRequestProto,
  PromoCodeConfigListProto,
} from './promo-code.grpc.types';

/** `''` → `undefined`, matching the proto's own "optional — empty string if absent" convention
 * (§1) for `merchant_id`/`activity_context.amount`/`activity_context.currency`. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

/** `null`/`undefined` → `''` — proto3 `string` fields cannot be `null`. */
function nullToEmpty(value: string | null | undefined): string {
  return value ?? '';
}

@Controller()
@UseGuards(MtlsGuard)
export class PromoCodeController {
  private readonly logger = new Logger(PromoCodeController.name);

  constructor(
    private readonly generationService: PromoCodeGenerationService,
    private readonly promoCodeConfigRepository: PromoCodeConfigRepository,
    private readonly correlationContext: CorrelationContextService,
  ) {}

  @GrpcMethod(GRPC_SERVICE_NAME, 'GenerateCode')
  async generateCode(data: GenerateCodeRequestProto): Promise<GenerateCodeResponseProto> {
    return this.correlationContext.run(
      {
        correlationId: data.correlationId ?? '',
        tenantId: data.tenantId ?? '',
        transport: 'GRPC',
        rpc: 'GenerateCode',
      },
      () => {
        this.logger.log('GenerateCode');
        return this.doGenerateCode(data);
      },
    );
  }

  private async doGenerateCode(data: GenerateCodeRequestProto): Promise<GenerateCodeResponseProto> {
    const activityContextInput = data.activityContext;
    let metadata: Record<string, unknown> | undefined;
    const metadataJson = emptyToUndefined(activityContextInput?.metadataJson);
    if (metadataJson !== undefined) {
      try {
        const parsed: unknown = JSON.parse(metadataJson);
        metadata =
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
        if (metadata === undefined) {
          return this.toFailedResponse(
            'INVALID_REQUEST',
            'activity_context.metadata_json must decode to a JSON object',
          );
        }
      } catch {
        return this.toFailedResponse(
          'INVALID_REQUEST',
          'activity_context.metadata_json is not valid JSON',
        );
      }
    }

    const request = {
      correlationId: data.correlationId ?? '',
      tenantId: data.tenantId ?? '',
      bindLevel: data.bindLevel ?? '',
      bindRefId: data.bindRefId ?? '',
      customerId: data.customerId ?? '',
      merchantId: emptyToUndefined(data.merchantId) ?? null,
      transport: 'GRPC',
      activityContext:
        activityContextInput === undefined
          ? null
          : {
              amount: emptyToUndefined(activityContextInput.amount),
              currency: emptyToUndefined(activityContextInput.currency),
              metadata,
            },
    };

    const result = await this.generationService.generateCode(request);
    return this.toResponse(result);
  }

  @GrpcMethod(GRPC_SERVICE_NAME, 'ListActivePromoCodeConfigs')
  async listActivePromoCodeConfigs(
    data: ListActivePromoCodeConfigsRequestProto,
  ): Promise<PromoCodeConfigListProto> {
    const tenantId = data.tenantId ?? '';
    if (tenantId.length === 0) {
      // Not a `GenerateCodeResponse`-style business outcome — this RPC has no `status`/
      // `error_code` fields in its response message (§1), so a malformed request here is a
      // protocol-level fault the caller cannot resolve by inspecting a response body (§5).
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'tenant_id is required',
      });
    }
    const merchantId = emptyToUndefined(data.merchantId);

    const configs = await this.promoCodeConfigRepository.list(tenantId, {
      merchantId,
      status: 'ACTIVE',
    });

    return {
      configs: configs.map((config) => {
        const summary = toPromoCodeConfigSummary(config);
        return {
          id: summary.id,
          name: summary.name,
          rewardValueType: summary.rewardValueType,
          rewardValue: summary.rewardValue,
          rewardUnit: summary.rewardUnit,
        };
      }),
    };
  }

  private toResponse(result: GenerationResult): GenerateCodeResponseProto {
    return {
      status: result.status,
      promoCodeId: nullToEmpty(result.promoCodeId),
      code: nullToEmpty(result.code),
      rewardValueType: nullToEmpty(result.rewardValueType),
      rewardValue: nullToEmpty(result.rewardValue),
      rewardUnit: nullToEmpty(result.rewardUnit),
      expiresAt: result.expiresAt ? result.expiresAt.toISOString() : '',
      errorCode: nullToEmpty(result.errorCode),
      errorMessage: nullToEmpty(result.errorMessage),
    };
  }

  private toFailedResponse(errorCode: string, errorMessage: string): GenerateCodeResponseProto {
    return {
      status: 'FAILED',
      promoCodeId: '',
      code: '',
      rewardValueType: '',
      rewardValue: '',
      rewardUnit: '',
      expiresAt: '',
      errorCode,
      errorMessage,
    };
  }
}
