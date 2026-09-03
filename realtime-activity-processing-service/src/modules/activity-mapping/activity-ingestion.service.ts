/**
 * T-RAP-021. `ActivityIngestionService.ingest` — the one domain method `ARCHITECTURE.md` §6
 * requires both the gRPC `SubmitActivity` handler (T-RAP-022) and the Kafka `activity.ingest.v1`
 * consumer (T-RAP-023) to call. Everything transport-specific (proto/Kafka payload parsing, error
 * shape) stays in those two tasks (`AGENT-PROTOCOL.md` R5) — this class knows nothing about gRPC or
 * Kafka, only `InboundActivity` in, `IngestResult` out.
 *
 * Implements `05-PROCESSING-PIPELINE.md` §1 (receive, log, correlate, map, fan out) and §2
 * (idempotency before any fan-out write) end to end, in this order, every call:
 *
 *   1. Resolve `correlationId`, derive `dedupKey` (both pure, side-effect-free — T-RAP-020).
 *   2. Encrypt + hash `customerId` immediately (`AGENT-PROTOCOL.md` R4) — no plaintext value is
 *      read again by this method after this step.
 *   3. Emit the raw-receipt log line — `customerIdHash` only, never `customerId` or
 *      `customerIdEncrypted` (see `logReceipt`'s own header for why this never goes through the
 *      generic, config-driven `LogRedactorService` the way other fields do).
 *   4. Map the activity to every currently-active tracker component it matches (`ActivityMapper`,
 *      itself backed by T-RAP-010's in-memory cache exclusively).
 *   5. Zero matches → logged as a no-op, not an error (TC-5), `status: 'accepted'`,
 *      `matchedTrackerComponents: []`.
 *   6. One or more matches → single-transaction, multi-row `INSERT ... ON CONFLICT DO NOTHING`
 *      (`ActivityLogsRepository`, task implementation note 3/4) — whatever comes back from
 *      `RETURNING` is what actually landed this call; `status` is `'duplicate'` only when *nothing*
 *      came back (every matched tuple already existed), `'accepted'` otherwise, including the
 *      partial-duplicate case (task implementation note 4: some rows are genuinely new, some
 *      conflict — no special-casing needed, the same statement handles both).
 *
 * No advisory lock here (task implementation note 5) — that's a Wave 3 concern
 * (`05-PROCESSING-PIPELINE.md` §3/§4), taken when *processing* a claimed `pending` row, not when
 * *inserting* it. Concurrent ingestion of the same activity is already race-safe via
 * `ON CONFLICT DO NOTHING` on `uc_activity_logs_fanout` (`AGENT-PROTOCOL.md` R2's "belt and
 * suspenders" backstop layer) — proven under real concurrency in
 * `activity-logs.repository.spec.ts` (TC-7).
 *
 * T-RAP-058: wires the reusable observability primitives T-RAP-043 built in `src/observability/`
 * (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3) into this, their one actual call site —
 * `MetricsService.incrementActivitiesIngested`/`incrementActivityLogsFanout`/`incrementDedupHits`
 * and `StructuredLogger` (replacing the plain `Logger`/string-interpolated lines below) so
 * `correlationId`/`tenantId`/`campaignCode` are separate JSON fields, never baked into `message`.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize';
import { CorrelationIdService } from '@/modules/idempotency/correlation-id.service';
import { IdempotencyService } from '@/modules/idempotency/idempotency.service';
import type {
  InboundActivity,
  SourceTransport,
} from '@/modules/idempotency/inbound-activity.types';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { LogRedactorService } from '@/modules/encryption/log-redactor.service';
import { MetricsService, type IngestTransport } from '@/observability/metrics.service';
import { StructuredLogger, StructuredLoggerFactory } from '@/observability/structured-logger';
import { ActivityMapper } from './activity-mapper';
import {
  ACTIVITY_MAPPING_SEQUELIZE,
  ActivityLogsRepository,
  type FanOutRowInput,
} from './activity-logs.repository';

export type IngestOutcome = 'accepted' | 'duplicate';

/** `03-GRPC-CONTRACT.md` §1's `SubmitActivityResponse` maps onto this 1:1; the Kafka consumer
 * (T-RAP-023) uses the same shape for its own offset-commit/DLQ decision. */
export interface IngestResult {
  correlationId: string;
  dedupKey: string;
  status: IngestOutcome;
  /** `tracker_component_code` values this specific call actually inserted — empty for a whole-
   * activity duplicate (`status === 'duplicate'`) or a zero-match activity, never a stale list
   * from a previous delivery of the same `dedupKey`. */
  matchedTrackerComponents: string[];
}

@Injectable()
export class ActivityIngestionService {
  private readonly logger: StructuredLogger;

  constructor(
    private readonly correlationIdService: CorrelationIdService,
    private readonly idempotencyService: IdempotencyService,
    private readonly mapper: ActivityMapper,
    private readonly encryption: EncryptionService,
    private readonly logRedactor: LogRedactorService,
    private readonly repository: ActivityLogsRepository,
    @Inject(ACTIVITY_MAPPING_SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly metrics: MetricsService,
    loggerFactory: StructuredLoggerFactory,
  ) {
    this.logger = loggerFactory.forContext(ActivityIngestionService.name);
  }

  async ingest(activity: InboundActivity): Promise<IngestResult> {
    // T-RAP-058 / `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3: once per inbound activity,
    // regardless of what happens downstream (zero match, duplicate, error) — placed first so no
    // early return or thrown error (e.g. `deriveDedupKey`'s own throw) can skip it.
    this.metrics.incrementActivitiesIngested(this.toIngestTransport(activity.sourceTransport));

    const correlationId = this.correlationIdService.resolve(activity.correlationId);
    const dedupKey = this.idempotencyService.deriveDedupKey(activity);

    // AGENT-PROTOCOL.md R4 / task implementation note 7: derive both forms immediately: no
    // downstream line in this method (log or SQL) ever reads `activity.customerId` again.
    const customerIdEncrypted = this.encryption.encrypt(activity.customerId);
    const customerIdHash = this.encryption.hash(activity.customerId);

    this.logReceipt(correlationId, dedupKey, activity, customerIdHash);

    const matches = this.mapper.mapToComponents(activity);

    if (matches.length === 0) {
      // TC-5: zero active tracker components matched — a normal, logged outcome, not an error
      // (`05-PROCESSING-PIPELINE.md` §1, `02-KAFKA-CONTRACTS.md` §2).
      this.logger.log('activity matched no active tracker component — no-op, not an error', {
        correlationId,
        tenantId: activity.tenantId,
        dedupKey,
      });
      return { correlationId, dedupKey, status: 'accepted', matchedTrackerComponents: [] };
    }

    const rows: FanOutRowInput[] = matches.map((match) => ({
      correlationId,
      dedupKey,
      tenantId: activity.tenantId,
      customerIdEncrypted,
      customerIdHash,
      customerIdType: activity.customerIdType,
      activityPerformedDate: activity.activityPerformedDate,
      transactionType: activity.transactionType ?? null,
      // The caller's own `activityCode` when supplied directly; otherwise the code the
      // `transactionType` branch resolved it to (`match.activityCode`) — `01-DATABASE.md` §3's
      // "one of the two is required" is still honoured: `transactionType` is stored as received,
      // `activityCode` always ends up populated either way.
      activityCode: activity.activityCode ?? match.activityCode,
      activityType: activity.activityType,
      activityCategory: activity.activityCategory,
      activityValue: activity.activityValue,
      activityValueUnit: activity.activityValueUnit,
      channel: activity.channel,
      activityPerformedEnv: activity.activityPerformedEnv,
      activityName: activity.activityName,
      campaignCode: match.campaignCode,
      trackerCode: match.trackerCode,
      trackerComponentCode: match.componentCode,
      merchantCode: activity.merchantCode ?? null,
      sourceTransport: activity.sourceTransport,
    }));

    // Implementation note 3: one transaction, all matched rows or none — a genuine failure
    // (not a `ON CONFLICT`-tolerated duplicate) rolls back every row in this call, not just some.
    const inserted = await this.sequelize.transaction((transaction) =>
      this.repository.insertFanOutRows(rows, transaction),
    );

    // T-RAP-058 / `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3: exactly `inserted.length`, right
    // after the `ON CONFLICT DO NOTHING` insert (`05-PROCESSING-PIPELINE.md` §1 step 6).
    this.metrics.incrementActivityLogsFanout(inserted.length);

    const status: IngestOutcome = inserted.length === 0 ? 'duplicate' : 'accepted';

    if (status === 'duplicate') {
      // Exactly when every matched tuple already existed (`inserted.length === 0` after
      // `matches.length > 0`) — never on a fresh or partial insert.
      this.metrics.incrementDedupHits();
    }

    // `matches` can span more than one campaign (TC-3 in this file's own spec) — a single
    // `campaignCode` field is only meaningful when every match shares the same one; otherwise it's
    // omitted rather than guessed, per `StructuredLogFields.campaignCode`'s own "when known".
    const distinctCampaignCodes = new Set(matches.map((match) => match.campaignCode));

    this.logger.log('activity ingested', {
      correlationId,
      tenantId: activity.tenantId,
      ...(distinctCampaignCodes.size === 1 ? { campaignCode: [...distinctCampaignCodes][0] } : {}),
      dedupKey,
      status,
      matchedComponents: matches.length,
      insertedRows: inserted.length,
    });

    return {
      correlationId,
      dedupKey,
      status,
      matchedTrackerComponents: inserted.map((row) => row.trackerComponentCode),
    };
  }

  /**
   * `05-PROCESSING-PIPELINE.md` §1, step 3 — the raw-receipt log line. `correlationId` is always
   * present, unredacted (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §1's own explicit carve-out).
   *
   * **`customerId` never reaches `LogRedactorService` here, deliberately** — `AGENT-PROTOCOL.md`
   * R4 ("no plaintext `customerId` anywhere it doesn't have to be ... in a log line") is this
   * codebase's own unconditional rule for this one field; `LogRedactorService.resolve` is a
   * *config-driven* mechanism (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §1) that can, by design,
   * resolve to "not redacted" if a future `field_encryption_config` row (or a missing one) says so
   * — see `log-redactor.service.spec.ts`'s own "refresh replaces" case, which flips `customerId`
   * to unredacted purely via config. Depending on that config for an R4 guarantee would make the
   * guarantee only as strong as whatever's currently seeded. `customerIdHash` carries no such
   * risk (`01-DATABASE.md` §3's own "the only queryable form") and is logged unconditionally
   * instead — this satisfies TC-8 regardless of `field_encryption_config`'s current contents.
   *
   * `activityValue` **is** run through `LogRedactorService` — a genuine example of the
   * general-purpose, config-driven mechanism this task's scope calls for ("redacted logging (via
   * LogRedactor)"), demonstrating that a future `field_encryption_config` row for any other field
   * on this payload takes effect with no code change, exactly `06-CONFIGURABILITY-AND-OBSERVABILITY.md`
   * §1's own stated goal.
   */
  private logReceipt(
    correlationId: string,
    dedupKey: string,
    activity: InboundActivity,
    customerIdHash: string,
  ): void {
    const activityValueForLog = this.logRedactor.redact('activityValue', activity.activityValue, {
      tenantId: activity.tenantId,
    });

    this.logger.log('activity received', {
      correlationId,
      tenantId: activity.tenantId,
      dedupKey,
      customerIdHash,
      activityCode: activity.activityCode ?? '',
      transactionType: activity.transactionType ?? '',
      channel: activity.channel,
      activityValue: activityValueForLog,
      sourceTransport: activity.sourceTransport,
    });
  }

  /** `03-GRPC-CONTRACT.md`/`02-KAFKA-CONTRACTS.md`'s two inbound transports, mapped onto
   * `MetricsService`'s own `IngestTransport` label values (`06-CONFIGURABILITY-AND-OBSERVABILITY.md`
   * §3's `activities_ingested_total{transport}`). */
  private toIngestTransport(sourceTransport: SourceTransport): IngestTransport {
    return sourceTransport === 'GRPC' ? 'grpc' : 'kafka';
  }
}
