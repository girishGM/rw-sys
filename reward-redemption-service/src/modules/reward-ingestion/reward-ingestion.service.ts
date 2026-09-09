/**
 * T-RR-010. The one, transport-agnostic domain method every inbound channel calls
 * (`ARCHITECTURE.md` §6, R10) — the gRPC server (`T-RR-011`), the Kafka consumer (`T-RR-012`) and
 * the REST controller (`T-RR-013`) each parse their own transport envelope into a
 * `RewardEntryIngestDto` and call `ingest()`, nothing more. No channel-specific branch belongs
 * anywhere in this file (a code-review red flag this task's own implementation note 5 names
 * explicitly: `if (dto.ingestionChannel === 'KAFKA') { ... }` inside this service is a direct R10
 * violation).
 *
 * **A duplicate `id` is never an error outcome, on any channel** (implementation note 2,
 * `03-GRPC-CONTRACT.md` §1, `04-REST-CONTRACT.md` §1's "a duplicate `id` also returns `200`, never
 * `409`"). `ingest()`'s return type has no error case at all for a duplicate — the repository's own
 * `insertOrGetExisting` already resolves it to the existing row's current status; this method
 * simply reports whichever row it got back.
 *
 * **`customerId` is encrypted and hashed before it ever reaches the repository or a log line**
 * (R8) — `EncryptionService.encrypt()`/`hash()` (T-RR-005), never a hand-rolled primitive. The one
 * log statement this service emits references `customer_id_hash` (via `LogRedactorService`), never
 * the raw `customerId` argument (TC-6).
 *
 * **`reward_processed_env` is stamped here, from this service's own deployment environment
 * (`NODE_ENV`), not received from the DTO.** `ARCHITECTURE.md` §6's field-reconciliation table:
 * "This service stamps its own `rewardProcessedEnv` ... at the point it processes the entry — it
 * is never something RAP tells this service." The task file's own implementation note 6 groups
 * this field with `country`/`tenantCode` as "stamped later, at claim time ... in Wave 2, not by
 * this task" — but `01-DATABASE.md` §1 declares `reward_processed_env` `NOT NULL` (unlike the two
 * genuinely deferred, nullable `country_code`/`tenant_code` columns, which this method
 * deliberately leaves `NULL`), and resolving it needs no cached tenant/schema lookup the way
 * `country`/`tenantCode` do (`06-CACHING-AND-TENANT-CONFIG.md` §5) — only this instance's own
 * static config. Deferring it to Wave 2 the same way would mean this task's own `INSERT` violates
 * a `NOT NULL` constraint on every single call, which cannot be the intended reading. Stamping it
 * here, at ingest time, is the only interpretation that satisfies both the schema and "never
 * something RAP tells this service" — flagged here, and in the completion report, as a resolved
 * documentation inconsistency rather than silently picked without a trace.
 *
 * **T-RR-056.** `MetricsRegistry.incrementRewardEntriesIngested(channel)`
 * (`07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3) is called from this one shared call site — never
 * from any of the three transport adapters individually (R10) — once per `ingest()` call that
 * reaches a durable outcome, on both the fresh-insert and the duplicate-short-circuit branch: both
 * are "durably received" per `ARCHITECTURE.md` §6 and this metric's own §3 description, and a
 * caller-retried/redelivered duplicate is exactly the kind of inbound arrival this metric exists
 * to count. `dto.ingestionChannel` (`'GRPC'|'KAFKA'|'REST'`) is lower-cased to match §3's
 * `channel` label values (`'grpc'|'kafka'|'rest'`).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Config } from '@/config/config.schema';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { LogRedactorService } from '@/modules/encryption/log-redactor.service';
import { MetricsRegistry } from '@/observability/metrics.registry';
import type { IngestionChannel } from '@/observability/metrics.registry';
import type { RewardRedemptionEntryStatus } from '@/database/models/reward-redemption-entry.model';
import { RewardRedemptionEntryRepository } from './reward-redemption-entry.repository';
import type { RewardEntryIngestDto } from './reward-entry-ingest.dto';

/**
 * Thrown only for an obviously-invalid DTO (e.g. a missing `id`) — implementation note 4's own
 * carve-out. The *transport-specific* translation of this into a gRPC `INVALID_ARGUMENT` status or
 * an HTTP `400` is each adapter's own job, never this service's (R10) — this is a plain, named
 * `Error` subclass precisely so each adapter can `instanceof`-check it without this module ever
 * importing a transport-specific status type.
 */
export class InvalidRewardEntryDtoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRewardEntryDtoError';
  }
}

export interface IngestResult {
  rewardEntryId: string;
  status: RewardRedemptionEntryStatus;
}

/** Every DTO field that must be a non-empty string for the DTO to be well-formed. Deliberately
 * excludes `transactionType`/`activityCode` (a documented one-of, either legitimately `null`),
 * `merchantCode` (documented optional, `01-DATABASE.md` §1), and — as of T-INT-046 —
 * `rewardValueUnit`: some reward kinds (`PROMO_CODE`/`POINTS`) have no fixed currency/point unit
 * by design, so an empty string is a well-formed value for this field, not a malformed DTO. Each
 * of the three transport adapters (T-RR-011/012/013) already normalizes an absent/`null` unit to
 * `''` before ever calling `ingest()`; this defensive, shared check must not re-reject what the
 * adapters themselves now consider valid, per T-INT-046's own evidence trail (a wire payload that
 * passed every transport's own validator was still failing here, uncaught, producing a real `500`
 * instead of the DoD's own required `200`). */
const REQUIRED_STRING_FIELDS: ReadonlyArray<keyof RewardEntryIngestDto> = [
  'id',
  'correlationId',
  'customerId',
  'customerIdType',
  'activityType',
  'activityCategory',
  'activityValue',
  'activityValueUnit',
  'channel',
  'activityPerformedEnv',
  'activityName',
  'campaignCode',
  'trackerCode',
  'trackerComponentCode',
  'rewardCode',
  'rewardCategory',
  'rewardValue',
  'ingestionChannel',
];

@Injectable()
export class RewardIngestionService {
  private readonly logger = new Logger(RewardIngestionService.name);

  constructor(
    private readonly repository: RewardRedemptionEntryRepository,
    private readonly encryption: EncryptionService,
    private readonly logRedactor: LogRedactorService,
    private readonly config: ConfigService<Config, true>,
    /**
     * Optional (`@Optional()`) purely so the pre-existing, out-of-this-task's-scope direct
     * `new RewardIngestionService(...)` construction sites that predate T-RR-056
     * (`test/processing/concurrency-load-safety.e2e-spec.ts`, `agent-rr-processing`'s file scope,
     * R3 — not edited by this task) keep compiling unchanged. Every real, Nest-DI-resolved
     * construction path (`RewardIngestionModule` importing `ObservabilityModule`) always supplies
     * a real instance; `ingest()` below only skips the increment if this is genuinely absent.
     */
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {}

  async ingest(dto: RewardEntryIngestDto): Promise<IngestResult> {
    this.assertWellFormed(dto);

    const { row, wasInserted } = await this.repository.insertOrGetExisting({
      id: dto.id,
      correlation_id: dto.correlationId,
      tenant_id: dto.tenantId,
      customer_id_encrypted: this.encryption.encrypt(dto.customerId),
      customer_id_hash: this.encryption.hash(dto.customerId),
      customer_id_type: dto.customerIdType,
      activity_performed_date: dto.activityPerformedDate,
      transaction_type: dto.transactionType,
      activity_code: dto.activityCode,
      activity_type: dto.activityType,
      activity_category: dto.activityCategory,
      activity_value: dto.activityValue,
      activity_value_unit: dto.activityValueUnit,
      channel: dto.channel,
      activity_performed_env: dto.activityPerformedEnv,
      activity_name: dto.activityName,
      campaign_code: dto.campaignCode,
      tracker_code: dto.trackerCode,
      tracker_component_code: dto.trackerComponentCode,
      merchant_code: dto.merchantCode,
      reward_code: dto.rewardCode,
      reward_category: dto.rewardCategory,
      reward_value: dto.rewardValue,
      reward_value_unit: dto.rewardValueUnit,
      reward_entry_date: dto.rewardEntryDate,
      completion_cycle: dto.completionCycle,
      reward_processed_env: this.config.get('NODE_ENV', { infer: true }),
      ingestion_channel: dto.ingestionChannel,
    });

    this.logger.log({
      message: wasInserted
        ? 'reward entry ingested'
        : 'duplicate reward entry short-circuited to existing status',
      rewardEntryId: row.id,
      correlationId: row.correlation_id,
      tenantId: row.tenant_id,
      campaignCode: row.campaign_code,
      customerIdHash: this.logRedactor.redactCustomerId(dto.customerId),
      ingestionChannel: dto.ingestionChannel,
      status: row.status,
    });

    // T-RR-056: one durably-received inbound entry, regardless of whether this call inserted a
    // fresh row or short-circuited to an already-existing one (both count per §3's own definition).
    this.metrics?.incrementRewardEntriesIngested(this.toMetricsChannel(dto.ingestionChannel));

    return { rewardEntryId: row.id, status: row.status };
  }

  /** `RewardEntryIngestDto.ingestionChannel` (`'GRPC'|'KAFKA'|'REST'`) lower-cased to
   * `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3's `channel` label values
   * (`'grpc'|'kafka'|'rest'`) — kept as an explicit, exhaustively-typed mapping (not a bare
   * `.toLowerCase()` cast) so a future addition to `IngestionChannel` fails to compile here
   * instead of silently emitting an unlisted label value. */
  private toMetricsChannel(channel: RewardEntryIngestDto['ingestionChannel']): IngestionChannel {
    switch (channel) {
      case 'GRPC':
        return 'grpc';
      case 'KAFKA':
        return 'kafka';
      case 'REST':
        return 'rest';
      default: {
        // Exhaustiveness guard — a compile error here means `IngestionChannel` grew a member
        // this mapping was never updated for.
        const exhaustiveCheck: never = channel;
        throw new Error(`Unmapped ingestion channel: ${String(exhaustiveCheck)}`);
      }
    }
  }

  /**
   * Defensive, not exhaustive (implementation note 4) — real shape/type validation is each
   * transport adapter's own job before `ingest()` is ever called. This only guards against an
   * obviously-broken DTO reaching the repository/encryption layer at all.
   */
  private assertWellFormed(dto: RewardEntryIngestDto): void {
    if (!dto) {
      throw new InvalidRewardEntryDtoError('RewardEntryIngestDto is required');
    }
    for (const field of REQUIRED_STRING_FIELDS) {
      const value = dto[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidRewardEntryDtoError(`RewardEntryIngestDto.${field} is required`);
      }
    }
    if (typeof dto.tenantId !== 'number' || !Number.isFinite(dto.tenantId)) {
      throw new InvalidRewardEntryDtoError(
        'RewardEntryIngestDto.tenantId is required and must be a finite number',
      );
    }
    if (
      !(dto.activityPerformedDate instanceof Date) ||
      Number.isNaN(dto.activityPerformedDate.getTime())
    ) {
      throw new InvalidRewardEntryDtoError(
        'RewardEntryIngestDto.activityPerformedDate is required and must be a valid Date',
      );
    }
    if (!(dto.rewardEntryDate instanceof Date) || Number.isNaN(dto.rewardEntryDate.getTime())) {
      throw new InvalidRewardEntryDtoError(
        'RewardEntryIngestDto.rewardEntryDate is required and must be a valid Date',
      );
    }
    if (!Number.isInteger(dto.completionCycle)) {
      throw new InvalidRewardEntryDtoError(
        'RewardEntryIngestDto.completionCycle is required and must be an integer',
      );
    }
  }
}
