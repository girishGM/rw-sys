/**
 * T-RTS-010. `RewardTrackingIngestionService.applyRewardTrackingEvent()` — the one, transport-
 * agnostic domain method every inbound channel (gRPC `T-RTS-011`, Kafka `T-RTS-012`, REST `T-RTS-013`)
 * calls with an identical DTO shape and produces an identical observable outcome from (R8).
 * Idempotent ingestion of one `reward.redemption.completed.v1`-shaped event into `reward_fact`,
 * `customer_reward_ledger`, and `campaign_reward_counter_shard`, in one transaction
 * (`brain-storm/02-DATA-MODEL.md`, this task's own implementation notes 1-2).
 *
 * **One transaction, four writes** (implementation note 1): `inbound_event_log` insert, `reward_fact`
 * insert, `customer_reward_ledger` upsert, `campaign_reward_counter_shard` upsert, all committed
 * together or all rolled back together (TC-5) — this service owns the one `pg.Pool`/transaction
 * boundary; every repository it calls takes the open `PoolClient` explicitly rather than opening its
 * own (see `inbound-event-log.repository.ts`'s own header).
 *
 * **Idempotency check happens first, inside the same transaction** (implementation note 2), via
 * `InboundEventLogRepository.insertIfNew`'s own `ON CONFLICT (reward_entry_id) DO NOTHING RETURNING *`
 * — an empty result means "already processed": this method short-circuits the rest of the
 * transaction and answers with the already-recorded `reward_fact` row (TC-2).
 *
 * **Resolved documentation inconsistency, noted rather than silently picked.** This task file's own
 * "Scope" prose says a duplicate "marks the new `inbound_event_log` row `duplicate`", while its own
 * "Implementation notes" §2 prescribes `ON CONFLICT ... DO NOTHING` and reading the existing
 * `reward_fact` row to answer with. Those two cannot both be literally true: `reward_entry_id` is the
 * table's own unique key, so there is structurally no second, distinct row a redelivery could ever
 * create to mark `'duplicate'` on. This implementation follows implementation note 2 (the precise,
 * procedural instruction, and the one that matches `uq_iel_reward_entry`'s own single-row-per-id
 * design) as authoritative: a redelivery leaves the original row's `processing_status` (`'applied'`)
 * untouched and never creates or mutates a second row. `'duplicate'` stays a defined
 * `InboundEventProcessingStatus` value (for whichever later hardening task, if any, wants a
 * differently-shaped detection path) but is never written by this method.
 *
 * **`reward_kind`-aware, not `reward_kind`-blind, upserts** (implementation note 4) — the ledger and
 * shard upserts both key on `reward_kind` as part of their own conflict target; an event with
 * `reward_kind: null` (today's actual state until `T-RR-062`/`T-RAP-062`/`T-173` land) still ingests
 * correctly (TC-7), accumulating under a `NULL`-keyed row distinct from any typed one.
 *
 * **No enforcement, no validation beyond shape** (implementation note 5, R1) — this service never
 * rejects an event because a budget/limit would be exceeded; the only rejection it ever performs is a
 * malformed event (missing a required field), a data-quality bug in the sender to surface, never a
 * business decision to make.
 *
 * **R6 — `customerId` is encrypted and hashed before it ever reaches a repository, a log line, or the
 * `inbound_event_log.payload` audit column.** `CustomerIdCryptoService.encrypt()`/`hash()` (this
 * task's own file, see that file's header for why it exists in this task's scope rather than a
 * dedicated foundation task) run before the transaction opens; the payload persisted to
 * `inbound_event_log` has `customerId` stripped and `customerIdEncrypted` substituted in its place —
 * the plaintext value is never written anywhere at rest, and the one log line this method emits
 * references `customerIdHash`, never the raw value.
 */
import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import type { Config } from '@/config/config.schema';
import type { RewardFactRow, RewardKind } from '@/database/models/reward-fact.model';
import type { InboundEventChannel } from '@/database/models/inbound-event-log.model';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory, type StructuredLogger } from '@/observability/logging.module';
import { InboundEventLogRepository } from './inbound-event-log.repository';
import { RewardFactRepository } from './reward-fact.repository';
import { CustomerRewardLedgerRepository } from './customer-reward-ledger.repository';
import { CampaignRewardCounterShardRepository } from './campaign-reward-counter-shard.repository';
import { ShardCountResolverService } from './shard-count-resolver.service';
import { CustomerIdCryptoService } from './customer-id-crypto.service';

/**
 * The one shared shape every transport adapter maps its own wire format into before calling
 * `applyRewardTrackingEvent()` (R8). Field set mirrors reward-redemption-service's outbound
 * `RewardTrackingDispatchPayload` once `reward-redemption-service-plan/tasks/T-RR-062` lands
 * (`trackerCode`/`trackerComponentCode`/`merchantCode`/`expiresAt`/`rewardKind`/
 * `promoCodeConfigId`/`promoCodeConfigVersionNo` included from day one here, even though that task
 * hasn't shipped yet — every one of those fields is nullable/optional below for exactly that reason,
 * per `brain-storm/02-DATA-MODEL.md`'s own "nullable means not yet known, never fabricated"
 * discipline), plus `customerId` (plaintext — re-encrypted immediately on receipt, `T-RTS-011`'s own
 * note) in place of `customerIdEncrypted`, and `receivedChannel` (this service's own observability
 * field, never a business-logic branch, R8).
 *
 * `trackerCode`/`trackerComponentCode` are required (non-nullable) here even though
 * `reward_fact.tracker_code`/`tracker_component_code` are themselves nullable columns — because
 * `customer_reward_ledger.tracker_code`/`tracker_component_code` are `NOT NULL` (`brain-storm/
 * 02-DATA-MODEL.md` §3.1's own schema), so an event missing either would violate that table's own
 * constraint partway through this method's single transaction. Flagged as a real, pre-existing
 * schema-vs-schema tension between §2.1 (nullable) and §3.1 (`NOT NULL`) for the same two columns —
 * not something this task's own file scope can resolve (the tables are `T-RTS-002`'s), so this DTO's
 * own validation is the conservative fix: reject the malformed-for-this-pipeline event up front
 * (implementation note 5's own "the only rejection ... is a malformed event") rather than let it
 * reach the ledger insert and fail there.
 */
export interface ApplyRewardTrackingEventInput {
  rewardEntryId: string;
  correlationId: string;
  receivedChannel: InboundEventChannel;
  tenantId: number;
  tenantCode?: string | null;
  countryCode?: string | null;
  /** Plaintext — encrypted/hashed internally, never persisted or logged as-is (R6). */
  customerId: string;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  merchantCode?: string | null;
  rewardCode: string;
  rewardCategory: string;
  rewardKind?: RewardKind | null;
  unitType?: string | null;
  unitCode?: string | null;
  rewardValue: string;
  rewardValueUnit: string;
  externalSystemCode?: string | null;
  externalReferenceId?: string | null;
  promoCodeConfigId?: string | null;
  promoCodeConfigVersionNo?: number | null;
  redeemedAt: Date;
  /** Taken verbatim from the inbound payload, never recomputed here (R5). */
  expiresAt?: Date | null;
}

export interface ApplyRewardTrackingEventResult {
  rewardEntryId: string;
  status: 'applied' | 'duplicate';
  rewardFact: RewardFactRow;
}

/** Thrown only for an obviously-invalid input (a missing required field) — implementation note 5's
 * own carve-out. The transport-specific translation into a gRPC `INVALID_ARGUMENT`/HTTP `400` is each
 * adapter's own job (R8), never this service's — a plain, named `Error` subclass so each adapter can
 * `instanceof`-check it without importing a transport-specific status type. */
export class InvalidRewardTrackingEventInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRewardTrackingEventInputError';
  }
}

// T-INT-050 — `rewardValueUnit` deliberately removed from this list: it is empty (`''`) by design
// for a reward kind with no fixed currency/point unit (`PROMO_CODE`/`POINTS`), and each of the
// three transport adapters (T-RTS-011/012/013, all fixed by T-INT-050 too) now lets an
// empty/absent value flow through rather than rejecting it before it ever reaches this shared
// guard — so this guard must not re-reject it here. Not in this task's own "Files owned" list
// (that names only the three transport-adapter files); extended per `AGENT-PROTOCOL.md`'s
// "make the best reasonable engineering call" instruction and disclosed here plus in the
// completion report (R3), same deviation `reward-redemption-service`'s own T-INT-046 made in its
// sibling `assertWellFormed()`-equivalent guard one hop upstream.
const REQUIRED_STRING_FIELDS: ReadonlyArray<keyof ApplyRewardTrackingEventInput> = [
  'rewardEntryId',
  'correlationId',
  'customerId',
  'campaignCode',
  'trackerCode',
  'trackerComponentCode',
  'rewardCode',
  'rewardCategory',
  'rewardValue',
];

const VALID_RECEIVED_CHANNELS: ReadonlyArray<InboundEventChannel> = ['KAFKA', 'GRPC', 'REST'];

@Injectable()
export class RewardTrackingIngestionService implements OnModuleDestroy {
  private readonly pool: Pool;
  /** T-RTS-049 — replaces the plain `new Logger(...)` field this class used to hold; see this
   * file's own header note 1 for the DI/observability wiring this task added. */
  private readonly structuredLogger: StructuredLogger;

  /** Last constructor parameter exists solely so a test can substitute a real (test-owned) or fake
   * `Pool` — same `@Optional()` idiom every repository in this project family already uses. */
  constructor(
    config: ConfigService<Config, true>,
    private readonly inboundEventLogRepository: InboundEventLogRepository,
    private readonly rewardFactRepository: RewardFactRepository,
    private readonly customerRewardLedgerRepository: CustomerRewardLedgerRepository,
    private readonly campaignRewardCounterShardRepository: CampaignRewardCounterShardRepository,
    private readonly shardCountResolver: ShardCountResolverService,
    private readonly crypto: CustomerIdCryptoService,
    private readonly metrics: MetricsService,
    loggers: StructuredLoggerFactory,
    @Optional() pool?: Pool,
  ) {
    this.structuredLogger = loggers.forContext(RewardTrackingIngestionService.name);
    this.pool =
      pool ??
      new Pool({
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        database: config.get('DB_NAME', { infer: true }),
        user: config.get('DB_APP_USERNAME', { infer: true }),
        password: config.get('DB_APP_PASSWORD', { infer: true }),
        ssl: config.get('DB_SSL', { infer: true }) ? { rejectUnauthorized: false } : undefined,
      });
  }

  async applyRewardTrackingEvent(
    input: ApplyRewardTrackingEventInput,
  ): Promise<ApplyRewardTrackingEventResult> {
    this.assertWellFormed(input);

    const shardCount = await this.shardCountResolver.resolve();
    const customerIdEncrypted = this.crypto.encrypt(input.customerId);
    const customerIdHash = this.crypto.hash(input.customerId);

    const result = await this.runInTransaction(async (client) => {
      const inserted = await this.inboundEventLogRepository.insertIfNew(client, {
        reward_entry_id: input.rewardEntryId,
        received_channel: input.receivedChannel,
        payload: this.toLoggedPayload(input, customerIdEncrypted),
      });

      if (inserted === null) {
        const existing = await this.rewardFactRepository.findByRewardEntryId(
          client,
          input.rewardEntryId,
        );
        if (existing === null) {
          // Structurally unreachable under normal operation: `inbound_event_log`'s own conflict
          // check blocks on, and waits for, the original transaction to finish before resolving to
          // "no row returned" — by then that original transaction's own reward_fact insert is
          // guaranteed committed (same reasoning `RewardRedemptionEntryRepository`'s own header
          // gives for its identical insert-or-select shape). Guarded rather than silently returning
          // `undefined` (R2).
          throw new Error(
            `reward_tracking.inbound_event_log conflicted on insert for reward_entry_id=` +
              `${input.rewardEntryId} but no reward_tracking.reward_fact row was found.`,
          );
        }
        return {
          rewardEntryId: existing.reward_entry_id,
          status: 'duplicate' as const,
          rewardFact: existing,
        };
      }

      const rewardFact = await this.rewardFactRepository.insert(client, {
        reward_entry_id: input.rewardEntryId,
        correlation_id: input.correlationId,
        tenant_id: input.tenantId,
        tenant_code: input.tenantCode ?? null,
        country_code: input.countryCode ?? null,
        customer_id_encrypted: customerIdEncrypted,
        customer_id_hash: customerIdHash,
        campaign_code: input.campaignCode,
        tracker_code: input.trackerCode,
        tracker_component_code: input.trackerComponentCode,
        merchant_code: input.merchantCode ?? null,
        reward_code: input.rewardCode,
        reward_category: input.rewardCategory,
        reward_kind: input.rewardKind ?? null,
        unit_type: input.unitType ?? null,
        unit_code: input.unitCode ?? null,
        reward_value: input.rewardValue,
        reward_value_unit: input.rewardValueUnit,
        external_system_code: input.externalSystemCode ?? null,
        external_reference_id: input.externalReferenceId ?? null,
        promo_code_config_id: input.promoCodeConfigId ?? null,
        promo_code_config_version_no: input.promoCodeConfigVersionNo ?? null,
        redeemed_at: input.redeemedAt,
        expires_at: input.expiresAt ?? null,
      });

      await this.customerRewardLedgerRepository.upsert(client, {
        tenant_id: input.tenantId,
        customer_id_hash: customerIdHash,
        campaign_code: input.campaignCode,
        tracker_code: input.trackerCode,
        tracker_component_code: input.trackerComponentCode,
        reward_category: input.rewardCategory,
        reward_kind: input.rewardKind ?? null,
        unit_type: input.unitType ?? null,
        unit_code: input.unitCode ?? null,
        reward_value: input.rewardValue,
        earned_at: input.redeemedAt,
      });

      await this.campaignRewardCounterShardRepository.upsert(
        client,
        {
          tenant_id: input.tenantId,
          campaign_code: input.campaignCode,
          reward_category: input.rewardCategory,
          reward_kind: input.rewardKind ?? null,
          unit_type: input.unitType ?? null,
          unit_code: input.unitCode ?? null,
          reward_value: input.rewardValue,
          shardSeed: input.rewardEntryId,
        },
        shardCount,
      );
      // T-RTS-049 item 1 — applied path only; a duplicate short-circuits before this upsert ever
      // runs, so a redelivery never double-counts a shard write.
      this.metrics.incrementShardWrite(input.campaignCode);

      await this.inboundEventLogRepository.markApplied(client, input.rewardEntryId);

      return { rewardEntryId: rewardFact.reward_entry_id, status: 'applied' as const, rewardFact };
    });

    // T-RTS-049 item 1 — one increment per call, right before returning; `result.status` is always
    // 'applied' or 'duplicate' here (a thrown validation/infra failure never reaches this line).
    this.metrics.incrementEventsIngested(input.receivedChannel, result.status);
    this.structuredLogger.log(
      result.status === 'applied'
        ? 'reward tracking event ingested'
        : 'duplicate reward tracking event short-circuited to existing fact',
      {
        correlationId: input.correlationId,
        rewardEntryId: result.rewardEntryId,
        customerIdHash,
        campaignCode: input.campaignCode,
        receivedChannel: input.receivedChannel,
        status: result.status,
      },
    );

    return result;
  }

  /** Strips `customerId` (plaintext) out of the payload persisted to `inbound_event_log.payload`,
   * substituting the already-computed `customerIdEncrypted` in its place — R6: the plaintext value is
   * never written anywhere at rest, including this audit column. */
  private toLoggedPayload(
    input: ApplyRewardTrackingEventInput,
    customerIdEncrypted: string,
  ): Record<string, unknown> {
    const { customerId: _plaintextOmitted, ...rest } = input;
    return { ...rest, customerIdEncrypted };
  }

  private assertWellFormed(input: ApplyRewardTrackingEventInput): void {
    if (!input) {
      throw new InvalidRewardTrackingEventInputError('ApplyRewardTrackingEventInput is required');
    }
    for (const field of REQUIRED_STRING_FIELDS) {
      const value = input[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidRewardTrackingEventInputError(
          `ApplyRewardTrackingEventInput.${field} is required`,
        );
      }
    }
    if (typeof input.tenantId !== 'number' || !Number.isFinite(input.tenantId)) {
      throw new InvalidRewardTrackingEventInputError(
        'ApplyRewardTrackingEventInput.tenantId is required and must be a finite number',
      );
    }
    if (!(input.redeemedAt instanceof Date) || Number.isNaN(input.redeemedAt.getTime())) {
      throw new InvalidRewardTrackingEventInputError(
        'ApplyRewardTrackingEventInput.redeemedAt is required and must be a valid Date',
      );
    }
    if (
      input.expiresAt !== undefined &&
      input.expiresAt !== null &&
      (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime()))
    ) {
      throw new InvalidRewardTrackingEventInputError(
        'ApplyRewardTrackingEventInput.expiresAt must be a valid Date when provided',
      );
    }
    if (!VALID_RECEIVED_CHANNELS.includes(input.receivedChannel)) {
      throw new InvalidRewardTrackingEventInputError(
        `ApplyRewardTrackingEventInput.receivedChannel must be one of ${VALID_RECEIVED_CHANNELS.join(', ')}`,
      );
    }
    if (
      Number.isNaN(Number.parseFloat(input.rewardValue)) ||
      !Number.isFinite(Number(input.rewardValue))
    ) {
      throw new InvalidRewardTrackingEventInputError(
        'ApplyRewardTrackingEventInput.rewardValue must be a numeric string',
      );
    }
  }

  private async runInTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
