/**
 * T-RAP-031. `pg_advisory_xact_lock` acquisition — `05-PROCESSING-PIPELINE.md` §3's own key
 * formula, `hashtext(tenant_id::text || ':' || customer_id_hash || ':' || campaign_code)` — the
 * very first statement of the transaction that also writes customer progress/budget/reward state
 * (`AGENT-PROTOCOL.md` R2). A transaction-scoped advisory lock releases automatically on
 * commit/rollback (never needs manual unlocking, safe against a crashed connection) — see
 * `05-PROCESSING-PIPELINE.md` §3's own reasoning.
 *
 * Two genuinely distinct activities for the *same* customer in the *same* campaign — different
 * transports, different service instances, different regions, at the same instant — serialize on
 * this lock: one proceeds start to finish, then the other, never interleaved. A different
 * customer, or the same customer in a different campaign, takes out a different lock key and
 * proceeds fully in parallel.
 *
 * `lock_timeout` is set immediately before acquiring the lock, from the already-seeded
 * `advisory_lock_wait_timeout_ms` `service_config` key
 * (`ServiceConfigResolverService.getAdvisoryLockWaitTimeoutMs`, T-RAP-013, `01-DATABASE.md` §11) —
 * without it, a pathological hot customer+campaign key could block a worker lane indefinitely
 * rather than surfacing as a bounded, retryable failure (Postgres cancels the wait with a
 * `55P03 lock_timeout` error, which propagates as a genuine transaction failure —
 * `05-PROCESSING-PIPELINE.md` §3's "the whole transaction rolls back ... safe to retry from the
 * next worker pass"). `SET LOCAL` scopes the timeout to this transaction only — a session-wide
 * `SET` would leak into whatever the connection pool hands this same physical connection next.
 */
import type { Sequelize, Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';

export interface CustomerCampaignLockParams {
  tenantId: number;
  customerIdHash: string;
  campaignCode: string;
  /** Milliseconds to wait for the lock before Postgres cancels with `lock_timeout` — always a
   * validated positive integer (`ServiceConfigResolverService.getAdvisoryLockWaitTimeoutMs`'s own
   * `resolvePositiveInt` guard, or this module's own `DEFAULT_ADVISORY_LOCK_WAIT_TIMEOUT_MS`
   * fallback). */
  waitTimeoutMs: number;
}

/** The exact triple that defines "one unit of contention" (`05-PROCESSING-PIPELINE.md` §3): a
 * given customer's progress within a given campaign. Exported so tests can assert on it directly
 * without re-deriving the concatenation convention. Content-equivalent to the design doc's own
 * `tenant_id::text || ':' || customer_id_hash || ':' || campaign_code` SQL-side concatenation —
 * built here instead so `hashtext()` receives one bound parameter rather than a hand-assembled SQL
 * expression. */
export function buildCustomerCampaignLockKey(
  tenantId: number,
  customerIdHash: string,
  campaignCode: string,
): string {
  return `${tenantId}:${customerIdHash}:${campaignCode}`;
}

/**
 * Acquires the transaction-scoped advisory lock for one (tenant, customer, campaign) triple.
 * Must be the very first statement of the transaction that will also write progress/budget/reward
 * state (R2) — every caller in this module's own processing chain (T-RAP-031 onward) calls this
 * before anything else once its transaction opens.
 */
export async function acquireCustomerCampaignAdvisoryLock(
  sequelize: Sequelize,
  transaction: Transaction,
  params: CustomerCampaignLockParams,
): Promise<void> {
  if (!Number.isInteger(params.waitTimeoutMs) || params.waitTimeoutMs <= 0) {
    throw new Error(
      `Invalid advisory lock waitTimeoutMs: ${JSON.stringify(params.waitTimeoutMs)} — expected a ` +
        'positive integer.',
    );
  }
  // `SET`'s value position does not accept a server-side bind parameter over the Postgres wire
  // protocol — `waitTimeoutMs` is validated above (a real, positive integer) immediately before
  // this string is built, so this interpolation can never carry anything other than digits.
  await sequelize.query(`SET LOCAL lock_timeout = '${params.waitTimeoutMs}ms'`, {
    type: QueryTypes.RAW,
    transaction,
  });

  const lockKey = buildCustomerCampaignLockKey(
    params.tenantId,
    params.customerIdHash,
    params.campaignCode,
  );
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:lockKey))', {
    type: QueryTypes.SELECT,
    transaction,
    replacements: { lockKey },
  });
}
