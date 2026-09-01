/**
 * T-PC-022. Scoped repository for `promo_code.promo_code_outbox` (`01-DATABASE.md` §4). Every
 * method here is read/write against that table plus one narrow, PK-keyed lookup back into
 * `promo_code.promo_code` for the envelope fields (`correlationId`/`tenantId`) that don't live on
 * the outbox row itself — same "talks to Postgres with parameterised `sequelize.query(...)`"
 * convention `promo-code.repository.ts` (T-PC-021) already established, no `@Table` models.
 *
 * This repository never creates an outbox row (that's T-PC-021's own transactional insert,
 * explicitly out of this task's scope) and never touches `promo_code`/`promo_code_config` beyond
 * the one read-only lookup below.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { PROMO_CODE_SEQUELIZE } from '../promo-code-config/promo-code-config.constants';

export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

/** The shape the poller needs per row — deliberately narrow, not `SELECT *`. */
export interface OutboxPendingRow {
  id: string;
  promoCodeId: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

/**
 * T-PC-045. Optional constraint a caller can apply to {@link OutboxRepository.findPendingBatch} so
 * a batch never reaches beyond a specific, already-known set of rows. `findPendingBatch` was
 * previously *always* global by design (implementation note 1 above — no `JOIN`, no extra
 * predicate, to protect the `ix_promo_code_outbox_pending` plan) precisely because the poller's own
 * production job genuinely is "drain the whole table." That same global reach became a real bug
 * once more than one `OutboxPublisherWorker` instance started polling the *same* real Postgres
 * table concurrently — which only happens in `test/e2e/**`, where several `*.e2e-spec.ts` files
 * each boot their own `AppModule`/worker in separate Jest worker processes, and at least one
 * (`kafka-round-trip.e2e-spec.ts`/`cross-transport-parity.e2e-spec.ts`'s `withOutboxPump`) must
 * keep manually driving `runOnce()` on an interval to prove a real Kafka publish end to end. With
 * no scoping available, one file's own poll could and did pick up and publish a `PENDING` row a
 * *different* file had just committed, before that file's own assertion ever observed it as
 * `PENDING` (T-PC-045's own filed evidence, T-PC-040).
 *
 * `rowIds` — rather than a `tenantId`/`correlationId` filter — because `promo_code_outbox.id` is
 * this table's own primary key: no `JOIN` needed (`promo_code_id` already lives on this table), and
 * a caller that just committed a row already knows its id (e.g. via the same query the caller used
 * to confirm it exists). Omitting `scope` entirely (the default for every production/non-e2e
 * caller) reproduces the prior global query byte-for-byte — this is additive, not a behavior change
 * for anyone who doesn't opt in.
 */
export interface OutboxBatchScope {
  /** `promo_code_outbox.id` values this caller cares about — nothing else is ever returned. */
  rowIds: string[];
}

interface OutboxPendingRowRaw {
  id: string;
  promo_code_id: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date;
}

/** `correlationId`/`tenantId` for the envelope — live on `promo_code.promo_code`, not the outbox row. */
export interface PromoCodeCorrelationContext {
  correlationId: string;
  tenantId: string;
}

interface PromoCodeCorrelationRowRaw {
  correlation_id: string;
  tenant_id: string;
}

@Injectable()
export class OutboxRepository {
  constructor(@Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * Implementation note 1: `WHERE status = 'PENDING' ORDER BY created_at` matches
   * `ix_promo_code_outbox_pending`'s own column order (`(status, created_at) WHERE status =
   * 'PENDING'`) exactly, so Postgres can satisfy this filter+sort with a single partial-index
   * scan (TC-6) rather than a sequential scan that degrades as this ever-growing, immutable table
   * grows. No `JOIN` here — that would risk losing that plan, which is why the
   * `correlationId`/`tenantId` lookup below is a deliberately separate query instead.
   *
   * T-PC-045: an optional `scope.rowIds` adds exactly one extra predicate, `id IN (:rowIds)`.
   * Deliberately `IN (:rowIds)`, not `= ANY(:rowIds)`/`= ANY(:rowIds::uuid[])` — `sequelize.query`'s
   * named-replacement escaping expands an array replacement into a parenthesised, comma-separated
   * literal list for `IN (...)` (its documented array-replacement behavior), but for `ANY(...)` it
   * just escapes the JS array as a single quoted string, which Postgres then rejects two different
   * ways depending on the exact form tried (`operator does not exist: uuid = text` without a cast,
   * `malformed array literal` with one) — verified against the real `promo_code_app` role while
   * diagnosing this task, not assumed. `IN (:rowIds)` is evaluated by Postgres as a filter over rows
   * the partial index scan already produced (still one index scan, same plan shape TC-6 asserts on)
   * — never a second index or a join. Callers that omit `scope` (every one prior to this task, and
   * every production caller) get the byte-for-byte prior query back.
   */
  async findPendingBatch(batchSize: number, scope?: OutboxBatchScope): Promise<OutboxPendingRow[]> {
    const rows = scope
      ? await this.sequelize.query<OutboxPendingRowRaw>(
          `SELECT id, promo_code_id, topic, payload, attempts, created_at
             FROM promo_code.promo_code_outbox
            WHERE status = 'PENDING'
              AND id IN (:rowIds)
            ORDER BY created_at ASC
            LIMIT :batchSize`,
          {
            type: QueryTypes.SELECT,
            replacements: { batchSize, rowIds: scope.rowIds },
          },
        )
      : await this.sequelize.query<OutboxPendingRowRaw>(
          `SELECT id, promo_code_id, topic, payload, attempts, created_at
             FROM promo_code.promo_code_outbox
            WHERE status = 'PENDING'
            ORDER BY created_at ASC
            LIMIT :batchSize`,
          { type: QueryTypes.SELECT, replacements: { batchSize } },
        );
    return rows.map((row) => ({
      id: row.id,
      promoCodeId: row.promo_code_id,
      topic: row.topic,
      payload: row.payload,
      attempts: row.attempts,
      createdAt: row.created_at,
    }));
  }

  /**
   * A single PK lookup (`promo_code.promo_code`'s primary key), called once per row per publish
   * attempt so `OutboxPublisherWorker` can build a fresh envelope (implementation note 5).
   */
  async findPromoCodeCorrelation(promoCodeId: string): Promise<PromoCodeCorrelationContext | null> {
    const rows = await this.sequelize.query<PromoCodeCorrelationRowRaw>(
      `SELECT correlation_id, tenant_id FROM promo_code.promo_code WHERE id = :promoCodeId`,
      { type: QueryTypes.SELECT, replacements: { promoCodeId } },
    );
    const row = rows[0];
    return row ? { correlationId: row.correlation_id, tenantId: row.tenant_id } : null;
  }

  /**
   * Implementation note 2: only ever called after a confirmed Kafka ack — never the reverse
   * order. `attempts` still increments here (implementation note 3: "increments on every publish
   * attempt, success or failure").
   */
  async markPublished(id: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE promo_code.promo_code_outbox
          SET status = 'PUBLISHED', published_at = now(), attempts = attempts + 1
        WHERE id = :id`,
      { type: QueryTypes.UPDATE, replacements: { id } },
    );
  }

  /** A publish attempt failed but the retry ceiling hasn't been reached — stays `PENDING`. */
  async incrementAttempts(id: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE promo_code.promo_code_outbox SET attempts = attempts + 1 WHERE id = :id`,
      { type: QueryTypes.UPDATE, replacements: { id } },
    );
  }

  /**
   * Retries exhausted — a broker/infrastructure failure signal (implementation note 3), distinct
   * from T-PC-030's DLQ (which is for malformed *incoming* messages, not this).
   */
  async markFailed(id: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE promo_code.promo_code_outbox
          SET status = 'FAILED', attempts = attempts + 1
        WHERE id = :id`,
      { type: QueryTypes.UPDATE, replacements: { id } },
    );
  }
}
