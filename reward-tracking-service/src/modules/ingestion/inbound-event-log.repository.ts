/**
 * T-RTS-010. `reward_tracking.inbound_event_log` (`brain-storm/02-DATA-MODEL.md` §1.1) — the
 * idempotency anchor every inbound channel shares. **`ON CONFLICT (reward_entry_id) DO NOTHING
 * RETURNING *`, never a `SELECT` before the `INSERT`** (implementation note 2, R3): the table's own
 * `uq_iel_reward_entry` unique constraint is the actual enforcement mechanism, so a `SELECT`-then-
 * `INSERT` shape would reopen exactly the TOCTOU race two concurrent duplicate arrivals must never
 * hit. When the insert returns no row, the reward_entry_id already existed — Postgres's own
 * unique-index conflict check blocks on, and waits for, the conflicting transaction to finish before
 * this statement can even determine there *was* a conflict, so by the time `DO NOTHING` resolves to
 * zero rows, whatever row caused the conflict is guaranteed already committed and visible.
 *
 * Every method here takes an externally-supplied `pg.PoolClient` and never opens its own
 * transaction — `RewardTrackingIngestionService` owns the one transaction spanning all four tables
 * (implementation note 1), this repository is never called outside it.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  InboundEventChannel,
  InboundEventLogRow,
} from '@/database/models/inbound-event-log.model';

export interface NewInboundEventLogInput {
  reward_entry_id: string;
  received_channel: InboundEventChannel;
  payload: unknown;
}

const INSERT_SQL = `
  INSERT INTO reward_tracking.inbound_event_log (reward_entry_id, received_channel, payload)
  VALUES ($1, $2, $3)
  ON CONFLICT (reward_entry_id) DO NOTHING
  RETURNING *
`;

const MARK_APPLIED_SQL = `
  UPDATE reward_tracking.inbound_event_log
     SET processing_status = 'applied', processed_at = now()
   WHERE reward_entry_id = $1
`;

@Injectable()
export class InboundEventLogRepository {
  /**
   * Returns the freshly-inserted row, or `null` if `input.reward_entry_id` already had a row (a
   * redelivery — the caller is responsible for treating that as "already processed", TC-2).
   */
  async insertIfNew(
    client: PoolClient,
    input: NewInboundEventLogInput,
  ): Promise<InboundEventLogRow | null> {
    const result = await client.query<InboundEventLogRow>(INSERT_SQL, [
      input.reward_entry_id,
      input.received_channel,
      JSON.stringify(input.payload),
    ]);
    return result.rows[0] ?? null;
  }

  /** Flips a freshly-inserted row's `processing_status` to `'applied'` once the rest of the
   * transaction (reward_fact + ledger + shard) has succeeded — still inside the same open
   * transaction, so this flip commits or rolls back atomically with everything else (TC-5). */
  async markApplied(client: PoolClient, rewardEntryId: string): Promise<void> {
    await client.query(MARK_APPLIED_SQL, [rewardEntryId]);
  }
}
