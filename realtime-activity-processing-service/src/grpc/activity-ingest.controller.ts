/**
 * T-RAP-022. The gRPC transport adapter for `ActivityIngestService.SubmitActivity`
 * (`03-GRPC-CONTRACT.md` §1). Per `AGENT-PROTOCOL.md` R5 ("no business logic in a transport
 * adapter") this controller does exactly three things: validate/deserialize the wire request into
 * an `InboundActivity`, call `ActivityIngestionService.ingest()` (T-RAP-021) — the identical domain
 * method the Kafka `activity.ingest.v1` consumer (T-RAP-023) will call — and map the returned
 * `IngestResult` back onto `SubmitActivityResponse`. No mapping/idempotency/persistence logic of
 * its own lives here; that is entirely T-RAP-021's.
 *
 * Guarded by `MtlsGuard` at the class level — every RPC on this controller requires an
 * allowlisted client certificate, resolved to a `tenantId` the guard hands off via
 * `ResolvedIdentityContext` (there is no per-method opt-out, and no cookie/JWT is ever accepted on
 * this transport).
 *
 * `SubmitActivityRequest` has no `tenant_id` field (`activity_ingest.proto`'s own header) — this
 * controller's own `tenantId` comes from `ResolvedIdentityContext.get(call)`, never from the wire
 * payload.
 */
import { Controller, Logger, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { ActivityIngestionService } from '@/modules/activity-mapping/activity-ingestion.service';
import type { InboundActivity } from '@/modules/idempotency/inbound-activity.types';
import { MtlsGuard } from './mtls.guard';
import { ResolvedIdentityContext } from './resolved-identity.context';
import { GRPC_SERVICE_NAME } from './grpc-server.config';
import { isValidDecimalString, parseActivityPerformedDate } from './activity-ingest.validation';
import type {
  SubmitActivityRequestProto,
  SubmitActivityResponseProto,
} from './activity-ingest.grpc.types';

function invalidArgument(message: string): never {
  throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message });
}

function requireNonEmpty(value: string | undefined, fieldName: string): string {
  if (!value || value.trim().length === 0) {
    invalidArgument(`${fieldName} is required`);
  }
  return value;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

@Controller()
@UseGuards(MtlsGuard)
export class ActivityIngestController {
  private readonly logger = new Logger(ActivityIngestController.name);

  constructor(
    private readonly ingestionService: ActivityIngestionService,
    private readonly identityContext: ResolvedIdentityContext,
  ) {}

  @GrpcMethod(GRPC_SERVICE_NAME, 'SubmitActivity')
  async submitActivity(
    data: SubmitActivityRequestProto,
    _metadata: unknown,
    call: unknown,
  ): Promise<SubmitActivityResponseProto> {
    const tenantId = this.identityContext.get(call as object);
    if (tenantId === undefined) {
      // Defensive only — `MtlsGuard` always resolves and records a tenantId for this exact `call`
      // reference before this handler ever runs (it is the only thing that ever allows the
      // request through); an unreachable branch against the real transport, not a case this
      // controller expects to ever actually hit.
      throw new RpcException({
        code: GrpcStatus.INTERNAL,
        message: 'No resolved tenant identity for this call',
      });
    }

    this.logger.log('SubmitActivity');
    const activity = this.toInboundActivity(data, tenantId);
    const result = await this.ingestionService.ingest(activity);

    return {
      correlationId: result.correlationId,
      status: result.status,
      matchedTrackerComponents: result.matchedTrackerComponents,
    };
  }

  private toInboundActivity(data: SubmitActivityRequestProto, tenantId: number): InboundActivity {
    const customerId = requireNonEmpty(data.customerId, 'customer_id');
    const customerIdType = requireNonEmpty(data.customerIdType, 'customer_id_type');
    const activityType = requireNonEmpty(data.activityType, 'activity_type');
    const activityCategory = requireNonEmpty(data.activityCategory, 'activity_category');
    const activityValueUnit = requireNonEmpty(data.activityValueUnit, 'activity_value_unit');
    const channel = requireNonEmpty(data.channel, 'channel');
    const activityPerformedEnv = requireNonEmpty(
      data.activityPerformedEnv,
      'activity_performed_env',
    );
    const activityName = requireNonEmpty(data.activityName, 'activity_name');

    const transactionType = emptyToUndefined(data.transactionType);
    const activityCode = emptyToUndefined(data.activityCode);
    if (!transactionType && !activityCode) {
      invalidArgument('one of transaction_type or activity_code is required');
    }

    const rawActivityValue = requireNonEmpty(data.activityValue, 'activity_value');
    if (!isValidDecimalString(rawActivityValue)) {
      invalidArgument(`activity_value "${rawActivityValue}" is not a valid decimal number`);
    }

    const rawPerformedDate = requireNonEmpty(data.activityPerformedDate, 'activity_performed_date');
    const activityPerformedDate = parseActivityPerformedDate(rawPerformedDate);
    if (activityPerformedDate === null) {
      invalidArgument(
        `activity_performed_date "${rawPerformedDate}" must be a valid ISO-8601 timestamp with an explicit UTC offset`,
      );
    }

    return {
      tenantId,
      customerId,
      customerIdType,
      activityPerformedDate,
      transactionType,
      activityCode,
      activityType,
      activityCategory,
      activityValue: rawActivityValue,
      activityValueUnit,
      channel,
      activityPerformedEnv,
      activityName,
      merchantCode: emptyToUndefined(data.merchantCode),
      activityEventId: emptyToUndefined(data.activityEventId),
      correlationId: emptyToUndefined(data.correlationId),
      sourceTransport: 'GRPC',
    };
  }
}
