/**
 * T-RR-010. The one shape every inbound channel (gRPC `T-RR-011`, Kafka `T-RR-012`, REST
 * `T-RR-013`) must produce before ever calling `RewardIngestionService.ingest()` — field-for-field
 * identical to `03-GRPC-CONTRACT.md` §1's `RewardEntry` message (itself copied verbatim from
 * RAP's real, shipped `realtime-activity-processing-service/proto/reward_ingest.proto`,
 * `ARCHITECTURE.md` §6), camelCase, plus this plan's own `ingestionChannel` enrichment field.
 *
 * **Deliberately excludes `country`/`tenantCode`/`rewardProcessedEnv`** — `ARCHITECTURE.md` §6's
 * field-reconciliation table is explicit that none of the three is ever received over the wire on
 * any channel; `country`/`tenantCode` are stamped later, at claim time, once a tenant/schema
 * lookup resolves them (`06-CACHING-AND-TENANT-CONFIG.md` §5 — genuinely deferred, since it needs
 * a cached lookup this task does not have). `rewardProcessedEnv` is *not* deferred the same way
 * despite the task file's own implementation note 6 grouping it with the other two: unlike
 * `country_code`/`tenant_code` (`01-DATABASE.md` §1, both nullable, `NULL` until Wave 2's
 * enrichment step runs), `reward_processed_env` is declared `NOT NULL` in that same DDL, and
 * resolving it needs nothing but this service's own static deployment environment
 * (`NODE_ENV`/`ARCHITECTURE.md` §6) — no cached tenant lookup required. `RewardIngestionService`
 * therefore stamps it itself, at ingest time, from its own config, rather than deferring it to a
 * Wave 2 step that has no other reason to touch this column. See that service's own header for
 * the full note — recorded here too since it's the reason this field is absent from the DTO but
 * still present, non-null, on every inserted row.
 *
 * Every value here is assumed already well-typed and complete by the time `ingest()` receives it
 * (T-RR-010 implementation note 4) — parsing a transport-specific envelope (a proto message, a
 * Kafka JSON payload, a REST JSON body) into this exact shape, including any malformed-input
 * rejection, is each adapter's own job, never this module's.
 */
export type IngestionChannel = 'GRPC' | 'KAFKA' | 'REST';

export interface RewardEntryIngestDto {
  /** `reward_entry_unique_id` — the one idempotency key every channel treats identically (R6). */
  id: string;
  correlationId: string;
  tenantId: number;
  /** Plaintext — transient. Never persisted or logged as-is (R8); `ingest()` encrypts/hashes it
   * before it ever reaches a repository call or a log line. */
  customerId: string;
  customerIdType: string;
  activityPerformedDate: Date;
  /** One-of with `activityCode`, per RAP's own proto comment — either may be `null`. */
  transactionType: string | null;
  activityCode: string | null;
  activityType: string;
  activityCategory: string;
  /** Decimal-as-string (never a JS `number`) — avoids float round-trip precision loss, matching
   * `RewardRedemptionEntryRow.activity_value`'s own convention. */
  activityValue: string;
  activityValueUnit: string;
  channel: string;
  activityPerformedEnv: string;
  activityName: string;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  merchantCode: string | null;
  rewardCode: string;
  rewardCategory: string;
  /** Decimal-as-string — same reasoning as `activityValue`. */
  rewardValue: string;
  rewardValueUnit: string;
  rewardEntryDate: Date;
  completionCycle: number;
  /** Observability only — never branches this service's business logic (`01-DATABASE.md` §1's own
   * column comment, R10). */
  ingestionChannel: IngestionChannel;
}
