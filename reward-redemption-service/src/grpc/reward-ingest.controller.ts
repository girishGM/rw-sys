/**
 * T-RR-011. The gRPC transport adapter for `RewardIngestService.SubmitRewardEntry`
 * (`03-GRPC-CONTRACT.md` §1). Per `AGENT-PROTOCOL.md` R10 ("no business logic in a transport
 * adapter") this controller does exactly three things: validate/deserialize the wire request into
 * a `RewardEntryIngestDto`, call `RewardIngestionService.ingest()` (T-RR-010) — the identical
 * domain method the Kafka `reward.entry.created.v1` consumer (T-RR-012) and the REST controller
 * (T-RR-013) will also call — and map the returned `IngestResult` back onto `SubmitRewardEntryAck`.
 * No mapping/idempotency/persistence logic of its own lives here; that is entirely T-RR-010's.
 *
 * Guarded by `MtlsGuard` at the class level — every RPC on this controller requires an
 * allowlisted client certificate. No cookie or JWT is ever accepted on this transport (a different
 * trust domain from every REST endpoint this plan builds).
 *
 * **A duplicate `id` is never a gRPC error** (`03-GRPC-CONTRACT.md` §1's idempotency-behavior
 * section, R6) — this handler always returns `SubmitRewardEntryAck` reporting whatever status
 * `RewardIngestionService.ingest()` returns, never branching on "was this fresh or a duplicate".
 * **The one case that does throw a gRPC error is a malformed request**
 * (`INVALID_ARGUMENT` — a missing mandatory field, a non-decimal `activity_value`/`reward_value`,
 * an unparseable/offset-less ISO-8601 date) — validated *before* `ingest()` is ever called.
 *
 * **Never signal "not delivered" via an in-body status string — always throw a gRPC error for
 * that case** (`03-GRPC-CONTRACT.md` §1's own load-bearing correction on RAP's real
 * `outbox-publisher.service.ts` `attemptGrpcFallback`, which treats *any non-throwing response* as
 * tier-2 delivery success and never branches on `SubmitRewardEntryAck.status`'s value). This
 * handler's only two real outcomes are "accepted (fresh or duplicate)" — a normal return — and
 * "malformed, reject the call" — a thrown `INVALID_ARGUMENT`. **A future change to this handler
 * must never introduce a "failed"-flavored status string in an otherwise-successful response** —
 * RAP's existing poller would silently ignore it and mark the row delivered anyway.
 *
 * ### A resolved design-doc contradiction: where does `tenantId` come from?
 *
 * `03-GRPC-CONTRACT.md` §1's own "Transport & auth" section claims `RewardEntry` "has no
 * caller-supplied `tenant_id` field whose trustworthiness would otherwise need separate
 * verification" — copied from RAP's own `ActivityIngestService` guard note without accounting for
 * the fact that, unlike `SubmitActivityRequest`, `RewardEntry` genuinely DOES carry `int32
 * tenant_id = 3` on the wire (the very same document's own proto text, two sections up, and
 * `ARCHITECTURE.md` §6's field-reconciliation table: "RAP's `RewardEntry` carries `tenant_id`
 * (int), never a country"). This is a real self-contradiction (`AGENT-PROTOCOL.md` §3: "if a
 * design doc contradicts itself, stop and escalate"), resolved here — not by picking a preferred
 * half arbitrarily, but by the side that is unambiguously true of the field-for-field-copied wire
 * contract this whole task is built around: `RewardEntryIngestDto.tenantId` is populated straight
 * from `RewardEntry.tenant_id` on the wire, never from the mTLS-resolved identity. `MtlsGuard`
 * still authenticates/authorizes *which callers* may invoke this RPC at all (via the same
 * `identity -> tenantId` allowlist mechanism as every other transport in this plan), but that
 * resolved value is deliberately unused for the DTO's own `tenantId` here — flagged in this task's
 * completion report, and recorded as a correction directly in `03-GRPC-CONTRACT.md` §1 itself, per
 * the same rule's "a contradiction ... must be recorded in the doc before code follows it."
 */
import { Controller, Logger, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { RewardIngestionService } from '@/modules/reward-ingestion/reward-ingestion.service';
import type { RewardEntryIngestDto } from '@/modules/reward-ingestion/reward-entry-ingest.dto';
import { MtlsGuard } from './mtls.guard';
import { ResolvedIdentityContext } from './resolved-identity.context';
import { GRPC_SERVICE_NAME } from './grpc-server.config';
import { isValidDecimalString, parseIsoDateWithOffset } from './reward-ingest.validation';
import type { RewardEntryProto, SubmitRewardEntryAckProto } from './reward-ingest.grpc.types';

function invalidArgument(message: string): never {
  throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message });
}

function requireNonEmpty(value: string | undefined, fieldName: string): string {
  if (!value || value.trim().length === 0) {
    invalidArgument(`${fieldName} is required`);
  }
  return value;
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

@Controller()
@UseGuards(MtlsGuard)
export class RewardIngestController {
  private readonly logger = new Logger(RewardIngestController.name);

  constructor(
    private readonly ingestionService: RewardIngestionService,
    private readonly identityContext: ResolvedIdentityContext,
  ) {}

  @GrpcMethod(GRPC_SERVICE_NAME, 'SubmitRewardEntry')
  async submitRewardEntry(
    data: RewardEntryProto,
    _metadata: unknown,
    call: unknown,
  ): Promise<SubmitRewardEntryAckProto> {
    // Defensive only — `MtlsGuard` always resolves and records a tenantId for this exact `call`
    // reference before this handler ever runs; an unreachable branch against the real transport,
    // kept only to prove the guard's own invariant rather than silently trusting it.
    if (this.identityContext.get(call as object) === undefined) {
      throw new RpcException({
        code: GrpcStatus.INTERNAL,
        message: 'No resolved caller identity for this call',
      });
    }

    this.logger.log('SubmitRewardEntry');
    const dto = this.toIngestDto(data);
    const result = await this.ingestionService.ingest(dto);

    return {
      rewardEntryId: result.rewardEntryId,
      status: result.status,
    };
  }

  private toIngestDto(data: RewardEntryProto): RewardEntryIngestDto {
    const id = requireNonEmpty(data.id, 'id');
    const correlationId = requireNonEmpty(data.correlationId, 'correlation_id');

    // `tenant_id` is a real wire field on THIS proto (unlike RAP's own `SubmitActivityRequest`) —
    // see this file's own header for the resolved design-doc contradiction on this point. proto3
    // int32 fields have no wire-level "unset" distinct from `0`, and no real tenant is ever `0`.
    if (
      typeof data.tenantId !== 'number' ||
      !Number.isInteger(data.tenantId) ||
      data.tenantId <= 0
    ) {
      invalidArgument('tenant_id is required and must be a positive integer');
    }
    const tenantId = data.tenantId;

    const customerId = requireNonEmpty(data.customerId, 'customer_id');
    const customerIdType = requireNonEmpty(data.customerIdType, 'customer_id_type');

    const rawActivityPerformedDate = requireNonEmpty(
      data.activityPerformedDate,
      'activity_performed_date',
    );
    const activityPerformedDate = parseIsoDateWithOffset(rawActivityPerformedDate);
    if (activityPerformedDate === null) {
      invalidArgument(
        `activity_performed_date "${rawActivityPerformedDate}" must be a valid ISO-8601 timestamp with an explicit UTC offset`,
      );
    }

    const transactionType = emptyToNull(data.transactionType);
    const activityCode = emptyToNull(data.activityCode);
    if (transactionType === null && activityCode === null) {
      invalidArgument('one of transaction_type or activity_code is required');
    }

    const activityType = requireNonEmpty(data.activityType, 'activity_type');
    const activityCategory = requireNonEmpty(data.activityCategory, 'activity_category');

    const activityValue = requireNonEmpty(data.activityValue, 'activity_value');
    if (!isValidDecimalString(activityValue)) {
      invalidArgument(`activity_value "${activityValue}" is not a valid decimal number`);
    }
    const activityValueUnit = requireNonEmpty(data.activityValueUnit, 'activity_value_unit');
    const channel = requireNonEmpty(data.channel, 'channel');
    const activityPerformedEnv = requireNonEmpty(
      data.activityPerformedEnv,
      'activity_performed_env',
    );
    const activityName = requireNonEmpty(data.activityName, 'activity_name');
    const campaignCode = requireNonEmpty(data.campaignCode, 'campaign_code');
    const trackerCode = requireNonEmpty(data.trackerCode, 'tracker_code');
    const trackerComponentCode = requireNonEmpty(
      data.trackerComponentCode,
      'tracker_component_code',
    );
    const merchantCode = emptyToNull(data.merchantCode);
    const rewardCode = requireNonEmpty(data.rewardCode, 'reward_code');
    const rewardCategory = requireNonEmpty(data.rewardCategory, 'reward_category');

    const rewardValue = requireNonEmpty(data.rewardValue, 'reward_value');
    if (!isValidDecimalString(rewardValue)) {
      invalidArgument(`reward_value "${rewardValue}" is not a valid decimal number`);
    }
    const rewardValueUnit = requireNonEmpty(data.rewardValueUnit, 'reward_value_unit');

    const rawRewardEntryDate = requireNonEmpty(data.rewardEntryDate, 'reward_entry_date');
    const rewardEntryDate = parseIsoDateWithOffset(rawRewardEntryDate);
    if (rewardEntryDate === null) {
      invalidArgument(
        `reward_entry_date "${rawRewardEntryDate}" must be a valid ISO-8601 timestamp with an explicit UTC offset`,
      );
    }

    if (typeof data.completionCycle !== 'number' || !Number.isInteger(data.completionCycle)) {
      invalidArgument('completion_cycle is required and must be an integer');
    }
    const completionCycle = data.completionCycle;

    return {
      id,
      correlationId,
      tenantId,
      customerId,
      customerIdType,
      activityPerformedDate,
      transactionType,
      activityCode,
      activityType,
      activityCategory,
      activityValue,
      activityValueUnit,
      channel,
      activityPerformedEnv,
      activityName,
      campaignCode,
      trackerCode,
      trackerComponentCode,
      merchantCode,
      rewardCode,
      rewardCategory,
      rewardValue,
      rewardValueUnit,
      rewardEntryDate,
      completionCycle,
      ingestionChannel: 'GRPC',
    };
  }
}
