import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import type { Config } from '@/config/config.schema';
import type {
  RewardRedemptionEntryRow,
  RewardRedemptionEntryStatus,
} from '@/database/models/reward-redemption-entry.model';
import {
  InvalidRedemptionStateTransitionError,
  RedemptionEntryNotFoundError,
} from './redemption-state-machine.errors';
import {
  REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT,
  type RedemptionCompletionSideEffectsPort,
} from './redemption-completion-side-effects.port';

/**
 * Input for `markDispatchedExternal` (`processing -> dispatched_external`, §2/§6 step 1).
 *
 * **T-RR-067 (defect fix).** This input used to also carry `attemptNumber`/`requestSummary`/
 * `responseSummary`/`latencyMs` so this method could insert its own `external_system_call_log`
 * row (§6 step 2's original framing: written "in the same transaction" as the status flip below).
 * That row was never the only one written for a successful attempt: every real connector
 * (`PromoCodeServiceConnector`/`CoreBankingConnector`, `08-EXTERNAL-INTEGRATION-CONTRACTS.md` §2/§3)
 * already writes its own `external_system_call_log` row for *every* attempt it makes, `SUCCESS`
 * included, before ever returning its `RedemptionResult` to `RedemptionProcessingOrchestrator`
 * (T-RR-024). Once T-RR-024 wired a real connector to this method, a single successful call wrote
 * two rows for the identical attempt — reproduced and root-caused by T-RR-041, filed as T-RR-067.
 * The connector is the only call site that has a real, single, natural place to log every outcome
 * uniformly (`SUCCESS`/`RETRYABLE_FAILURE`/`PERMANENT_FAILURE` alike — the latter two never reach
 * this method at all, so this method was never a complete substitute for the connector's own write
 * in the first place). This method therefore no longer writes `external_system_call_log` at all;
 * see `05-PROCESSING-PIPELINE.md` §6's own revision note for the updated, reconciled framing.
 */
export interface MarkDispatchedExternalInput {
  entryId: string;
  externalSystemCode: string;
  externalReferenceId: string;
  /**
   * T-RR-063. The absolute UTC instant this redemption's reward stops being usable, computed by
   * the caller (`RedemptionProcessingOrchestrator`, via `expiry-computation.ts`'s `computeExpiresAt`)
   * from the resolved `BoundReward`'s expiry duration — `null` when the reward never expires.
   *
   * Optional (not just nullable) purely so every call site/test predating this task that never had
   * an opinion on expiry keeps compiling unchanged — `undefined` and `null` are treated identically
   * below (both persist as SQL `NULL`). A real caller (`RedemptionProcessingOrchestrator`) always
   * supplies it explicitly, having just computed it.
   */
  expiresAt?: Date | null;
}

/** Input for `markRetrying` (`processing`/`retrying` -> `retrying`, §2/§5). */
export interface MarkRetryingInput {
  entryId: string;
  errorCode: string | null;
  errorMessage: string;
  /** T-RR-024's own computed backoff delay (§5's `delayMs` formula) — this service only writes
   * `next_attempt_at = now() + delayMs`, it does not compute the backoff itself (Out of scope). */
  delayMs: number;
}

/** Input for `markFailed` (`processing`/`retrying` -> `failed`, §2/§7). */
export interface MarkFailedInput {
  entryId: string;
  totalAttempts: number;
  finalErrorCode: string | null;
  finalErrorMessage: string;
}

const SELECT_FOR_UPDATE_SQL =
  'SELECT * FROM reward_redemption.reward_redemption_entry WHERE id = $1 FOR UPDATE';
const SELECT_SQL = 'SELECT * FROM reward_redemption.reward_redemption_entry WHERE id = $1';

/**
 * T-RR-021. `reward_redemption_entry.status` is the single source of truth for pipeline state
 * (`05-PROCESSING-PIPELINE.md` §2's own opening line) — this is the one place every status
 * transition in that section's table is written, so the full state graph stays auditable in one
 * file rather than scattered across call sites that each mutate `status` independently.
 *
 * Every public method here is one row of §2's transition table:
 *   - `markDispatchedExternal`: `processing -> dispatched_external` (connector call succeeded).
 *     T-RR-067: writes only the redemption facts + status flip — the `external_system_call_log`
 *     row for this attempt is the calling connector's own responsibility, written before this
 *     method is ever invoked (see that method's own doc comment).
 *   - `markCompletedDirect`: `processing -> completed` directly (§4 resolved no connector at all).
 *   - `completeDispatched`: `dispatched_external -> completed` (outbox/notification step, §6
 *     steps 3-5) — also the completion sweep's own resume point (`CompletionSweepService`).
 *   - `markRetrying`: `processing`/`retrying -> retrying` (retryable failure, §5).
 *   - `markFailed`: `processing`/`retrying -> failed` (permanent failure or exhausted retries, §7).
 *
 * Connects as the least-privilege `rr_app` role via its own small `pg.Pool` — same convention
 * `RewardRedemptionEntryClaimRepository`/`RewardRedemptionEntryRepository` already established (no
 * shared runtime DB pool module exists anywhere in this service). The second constructor parameter
 * exists solely so a test can substitute a real (test-owned) or fake `Pool`, same `@Optional()`
 * idiom as those two repositories.
 */
@Injectable()
export class RedemptionStateMachineService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    config: ConfigService<Config, true>,
    @Inject(REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT)
    private readonly sideEffects: RedemptionCompletionSideEffectsPort,
    @Optional() pool?: Pool,
  ) {
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

  /**
   * `processing -> dispatched_external`: writes the redemption facts and flips `status`, in one
   * committing transaction — the durability checkpoint for the redemption fact itself (§2/§7:
   * nothing after this point can ever revert it).
   *
   * **T-RR-067 (defect fix).** No longer also inserts an `external_system_call_log` row here —
   * see `MarkDispatchedExternalInput`'s own doc comment above for why (the connector that actually
   * made the call already wrote that row before this method was ever invoked).
   */
  async markDispatchedExternal(
    input: MarkDispatchedExternalInput,
  ): Promise<RewardRedemptionEntryRow> {
    return this.runInTransaction(async (client) => {
      await this.lockRow(client, input.entryId, 'flip to dispatched_external', ['processing']);

      const updated = await client.query<RewardRedemptionEntryRow>(
        `UPDATE reward_redemption.reward_redemption_entry
           SET status = 'dispatched_external',
               external_system_code = $2,
               external_reference_id = $3,
               redeemed_at = now(),
               expires_at = $4,
               updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          input.entryId,
          input.externalSystemCode,
          input.externalReferenceId,
          input.expiresAt ?? null,
        ],
      );

      return updated.rows[0];
    });
  }

  /**
   * `processing -> completed` directly, skipping `dispatched_external` entirely: §4 resolved no
   * connector for this entry at all. `redeemed_at` is stamped `now()`; `external_system_code`/
   * `external_reference_id` are left untouched (already `NULL`, per §2's own note); no
   * `external_system_call_log` row is written (there was no call to log).
   *
   * `expiresAt` (T-RR-063): optional, `Date | null` — same "caller already computed it from the
   * resolved `BoundReward`'s expiry duration" contract as `MarkDispatchedExternalInput.expiresAt`
   * above. A second parameter, not folded into an input object, since this method's only other
   * parameter is already a bare `entryId` string (unlike `markDispatchedExternal`'s existing input
   * object).
   */
  async markCompletedDirect(
    entryId: string,
    expiresAt?: Date | null,
  ): Promise<RewardRedemptionEntryRow> {
    return this.runInTransaction(async (client) => {
      await this.lockRow(client, entryId, 'flip directly to completed (no connector resolved)', [
        'processing',
      ]);

      const updated = await client.query<RewardRedemptionEntryRow>(
        `UPDATE reward_redemption.reward_redemption_entry
           SET status = 'completed', redeemed_at = now(), expires_at = $2, updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [entryId, expiresAt ?? null],
      );
      return updated.rows[0];
    });
  }

  /**
   * `dispatched_external -> completed`: the outbox/notification step (§6 steps 3-4, stubbed —
   * `RedemptionCompletionSideEffectsPort`, TODO T-RR-034/T-RR-036) runs in an immediately-following
   * transaction, never the same one as the `dispatched_external` write (`05-PROCESSING-PIPELINE.md`
   * §2's own note on implementing "the immediately-following-transaction shape" — simpler, and what
   * `CompletionSweepService` exists specifically to make safe against a crash in that narrow
   * window). The side-effects call itself runs with no open transaction/lock held (mirrors §3's
   * rule about the connector call never running inside one), since it may be an arbitrary,
   * out-of-process call once Wave 3 lands.
   *
   * This is also the completion sweep's own resume point: called both by the normal worker flow
   * right after `markDispatchedExternal` commits, and by `CompletionSweepService` for a row that got
   * stuck. Both callers can legitimately race to complete the same row (the normal flow finishes
   * first, the sweep picks up the same row just before it notices) — an already-`completed` row is
   * treated as an idempotent no-op, not an invariant violation; any other unexpected status still
   * throws loudly.
   */
  async completeDispatched(entryId: string): Promise<RewardRedemptionEntryRow> {
    const preCheck = await this.fetchRow(entryId);
    if (preCheck.status === 'completed') {
      return preCheck;
    }
    if (preCheck.status !== 'dispatched_external') {
      throw new InvalidRedemptionStateTransitionError(
        entryId,
        preCheck.status,
        'resume at the outbox/notification step (dispatched_external -> completed)',
        ['dispatched_external'],
      );
    }

    await this.sideEffects.recordCompletionSideEffects(preCheck);

    return this.runInTransaction(async (client) => {
      const row = await client.query<RewardRedemptionEntryRow>(SELECT_FOR_UPDATE_SQL, [entryId]);
      if (!row.rowCount) {
        throw new RedemptionEntryNotFoundError(entryId);
      }
      if (row.rows[0].status === 'completed') {
        // Lost the race to another completer (normal flow vs. sweep) between the pre-check above
        // and this lock — already done, not an error.
        return row.rows[0];
      }
      if (row.rows[0].status !== 'dispatched_external') {
        throw new InvalidRedemptionStateTransitionError(
          entryId,
          row.rows[0].status,
          'resume at the outbox/notification step (dispatched_external -> completed)',
          ['dispatched_external'],
        );
      }

      const updated = await client.query<RewardRedemptionEntryRow>(
        `UPDATE reward_redemption.reward_redemption_entry
           SET status = 'completed', updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [entryId],
      );
      return updated.rows[0];
    });
  }

  /**
   * `processing`/`retrying -> retrying`: `retry_count` increments, `last_error_code`/
   * `last_error_message`/`last_attempted_at` are written, and `next_attempt_at` is set to
   * `now() + delayMs` — the one column write this state machine must not forget, since it's the
   * only thing making the row invisible to the claim worker until its delay elapses
   * (`01-DATABASE.md` §1, `ix_rre_status_next_attempt`).
   */
  async markRetrying(input: MarkRetryingInput): Promise<RewardRedemptionEntryRow> {
    return this.runInTransaction(async (client) => {
      await this.lockRow(client, input.entryId, 'flip to retrying', ['processing', 'retrying']);

      const nextAttemptAt = new Date(Date.now() + input.delayMs);
      const updated = await client.query<RewardRedemptionEntryRow>(
        `UPDATE reward_redemption.reward_redemption_entry
           SET status = 'retrying',
               retry_count = retry_count + 1,
               last_error_code = $2,
               last_error_message = $3,
               last_attempted_at = now(),
               next_attempt_at = $4,
               updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [input.entryId, input.errorCode, input.errorMessage, nextAttemptAt],
      );
      return updated.rows[0];
    });
  }

  /**
   * `processing`/`retrying -> failed`: `reward_redemption_failed` is inserted in the **same**
   * transaction as this flip (§7). **Structurally guarded** (implementation note 3): this is the
   * single most safety-critical invariant in this task — `dispatched_external -> failed` and
   * `completed -> failed` do not exist as edges in §2's table, so this method asserts the row's
   * current status is `processing` or `retrying` before proceeding, throwing a loud
   * internal-consistency error otherwise (TC-6/TC-7) rather than trusting every call site to never
   * invoke it wrongly.
   */
  async markFailed(input: MarkFailedInput): Promise<RewardRedemptionEntryRow> {
    return this.runInTransaction(async (client) => {
      const row = await this.lockRow(client, input.entryId, 'flip to failed', [
        'processing',
        'retrying',
      ]);

      await client.query(
        `INSERT INTO reward_redemption.reward_redemption_failed
           (reward_entry_id, tenant_id, campaign_code, reward_code, total_attempts,
            final_error_code, final_error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id,
          row.tenant_id,
          row.campaign_code,
          row.reward_code,
          input.totalAttempts,
          input.finalErrorCode,
          input.finalErrorMessage,
        ],
      );

      const updated = await client.query<RewardRedemptionEntryRow>(
        `UPDATE reward_redemption.reward_redemption_entry
           SET status = 'failed', updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [input.entryId],
      );
      return updated.rows[0];
    });
  }

  /** Reads the current row with no lock and no open transaction — used only for `completeDispatched`'s
   * pre-check (deliberately outside any transaction, per this file's own note on never holding a
   * transaction open across the side-effects call). */
  private async fetchRow(entryId: string): Promise<RewardRedemptionEntryRow> {
    const result = await this.pool.query<RewardRedemptionEntryRow>(SELECT_SQL, [entryId]);
    if (!result.rowCount) {
      throw new RedemptionEntryNotFoundError(entryId);
    }
    return result.rows[0];
  }

  /** Locks (`FOR UPDATE`) and returns the row, asserting its current status is one of
   * `allowedFromStatuses` — the shared guard every transition method (other than
   * `completeDispatched`, which has its own two-phase shape) routes through. */
  private async lockRow(
    client: PoolClient,
    entryId: string,
    action: string,
    allowedFromStatuses: RewardRedemptionEntryStatus[],
  ): Promise<RewardRedemptionEntryRow> {
    const result = await client.query<RewardRedemptionEntryRow>(SELECT_FOR_UPDATE_SQL, [entryId]);
    if (!result.rowCount) {
      throw new RedemptionEntryNotFoundError(entryId);
    }
    const row = result.rows[0];
    if (!allowedFromStatuses.includes(row.status)) {
      throw new InvalidRedemptionStateTransitionError(
        entryId,
        row.status,
        action,
        allowedFromStatuses,
      );
    }
    return row;
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
