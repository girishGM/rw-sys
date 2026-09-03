/**
 * T-RAP-020. The one shared, transport-agnostic shape both ingestion adapters — the gRPC
 * `SubmitActivity` handler (T-RAP-022) and the Kafka `activity.ingest.v1` consumer (T-RAP-023) —
 * construct and pass into the mapping/fan-out domain method (T-RAP-021). Field names and
 * optionality mirror `03-GRPC-CONTRACT.md` §1's `SubmitActivityRequest` and
 * `02-KAFKA-CONTRACTS.md` §1's payload description (the two wire formats a transport adapter
 * translates *from*), and `01-DATABASE.md` §3's `activity_logs` columns (what this eventually
 * becomes rows of) — this type is deliberately the intersection point between the two.
 *
 * AGENT-PROTOCOL.md R5: a transport adapter's only job is (de)serialization and error-shape
 * translation into/out of this type — no business logic. R4: `customerId` here is the plaintext
 * value, held only in memory for the lifetime of this request — never logged, never persisted as
 * given (see `01-DATABASE.md` §3: `activity_logs` stores `customer_id_hash`/`customer_id_encrypted`
 * instead, derived downstream of this module, not by it).
 */

/** Which transport this activity arrived on — persisted verbatim as `activity_logs.source_transport`. */
export type SourceTransport = 'GRPC' | 'KAFKA';

export interface InboundActivity {
  /**
   * Resolved by the transport adapter from its own auth context (mTLS client identity / API key
   * → tenant mapping) before this object is constructed — never a field on the wire payload
   * itself (absent from both `SubmitActivityRequest` and the Kafka payload description). Out of
   * this module's scope to resolve; required here only because every downstream consumer of this
   * type (T-RAP-021's fan-out insert) needs it.
   */
  tenantId: number;

  /** Plaintext customer identifier — see the file-level note on R4. Never logged, never hashed by this module. */
  customerId: string;
  customerIdType: string;

  /**
   * Normalized to UTC by the transport adapter before this object is constructed
   * (`01-DATABASE.md` §3: "caller sends full ISO-8601 w/ offset, normalized on ingest"). Using a
   * `Date` here rather than the raw wire string keeps this module pure and deterministic: two
   * activities that name the same instant, however their offset was originally expressed, hash to
   * the same composite dedup key.
   */
  activityPerformedDate: Date;

  /** One of `activityCode` / `transactionType` is required — enforced by request validation upstream of this module, not here. */
  transactionType?: string;
  activityCode?: string;

  activityType: string;
  activityCategory: string;

  /** Decimal-as-string on the wire (avoids float precision loss) — kept as a string end to end. */
  activityValue: string;
  activityValueUnit: string;

  channel: string;
  activityPerformedEnv: string;
  activityName: string;

  /** OPTIONAL — `04-CACHE-INVALIDATION.md`/`01-DATABASE.md` §3. */
  merchantCode?: string;

  /** OPTIONAL but strongly recommended (`ARCHITECTURE.md` §7) — when present, this *is* the dedupKey, verbatim. */
  activityEventId?: string;

  /** OPTIONAL — the caller's own correlation id, if supplied; `CorrelationIdService.resolve` generates one when absent. */
  correlationId?: string;

  sourceTransport: SourceTransport;
}
