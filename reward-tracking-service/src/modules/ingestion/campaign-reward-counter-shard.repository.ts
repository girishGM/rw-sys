/**
 * T-RTS-010. `reward_tracking.campaign_reward_counter_shard` (`brain-storm/02-DATA-MODEL.md` §4) —
 * the one sharded, hot-write table in this design (R7). Every write is a single atomic
 * `INSERT ... ON CONFLICT DO UPDATE x = x + $delta`, never a read-then-write, so correctness never
 * depends on avoiding a race between concurrent writers to the same shard row (R7) — only throughput
 * depends on the configured shard count.
 *
 * **Deviation from §4's own SQL, flagged rather than copied verbatim.** That section's own example
 * writes `shard_key = hashtext($7) % $N` with no `abs()`. `hashtext()` returns a signed `int4` and can
 * be negative; a negative dividend's `%` in Postgres carries through as a negative result (e.g.
 * `-5 % 32 = -5`), which would violate `shard_key`'s own documented `0..N-1` range and the column's
 * `smallint` type would still happily store a negative value — silently producing a shard id outside
 * every read-side assumption. This repository computes `abs(hashtext($1)) % $2` instead, which always
 * lands in `0..N-1`, preserving §4's own "deterministic bucket by hashing the reward entry, spread
 * across N independent rows" intent without the sign bug. Flagged in the completion report for the
 * architect to fold back into the design doc.
 *
 * **Real, reproduced schema defect, filed rather than silently worked around in the migration this
 * task cannot touch (`src/database/migrations/**` is `agent-rts-foundation`'s own, R10).**
 * `005_create_campaign_reward_counter_shard.ts` declares `reward_kind`/`unit_type`/`unit_code`
 * nullable (`varchar(...) NULL`), matching `brain-storm/02-DATA-MODEL.md` §4's own schema — but all
 * three are also part of this table's `PRIMARY KEY`, and Postgres silently forces every column that
 * participates in a primary key to be `NOT NULL`, regardless of what the `CREATE TABLE` itself
 * declares. Reproduced directly: inserting a real row with `reward_kind = NULL` throws `null value in
 * column "reward_kind" ... violates not-null constraint`. This is exactly the "counter-shard PK
 * forcing NOT NULL vs doc's NULL" gap `T-RTS-002`'s own review note already flagged as a known,
 * accepted judgment call at review time — but that review only ran the migration's own schema tests,
 * never a real application-level insert, so the concrete runtime consequence (every single event
 * ingested today, with `reward_kind` universally `NULL` per `brain-storm/02-DATA-MODEL.md` §2.2's own
 * "arrives as NULL on every reward_fact row until T-RR-062/T-RAP-062/T-173 land", would crash on this
 * exact write) was not yet visible. Filed as its own defect against `agent-rts-foundation`
 * (`src/database/migrations/**`) for the real, permanent fix — a generated `dedupe_key` column
 * collapsing `NULL`s the same way this repo's own root `CLAUDE.md` AR-02 precedent already resolved
 * an identical class of problem for `campaign_caps`/`grpc_service_grants` — while this repository
 * applies the minimum workaround needed to make T-RTS-010 actually function against the schema as it
 * exists today: `NULL_GROUPING_SENTINEL` stands in for SQL `NULL` on write, and is translated back to
 * `null` on the row this method returns, so every caller's own type contract
 * (`CampaignRewardCounterShardRow['reward_kind'/'unit_type'/'unit_code']`) stays exactly what it
 * already promises. **Any later task reading this table with its own, separate query (not through
 * this repository) must apply the identical translation** — flagged here and in the completion report
 * so that isn't missed.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CampaignRewardCounterShardRow } from '@/database/models/campaign-reward-counter-shard.model';
import type { RewardKind } from '@/database/models/reward-fact.model';

/** Stands in for SQL `NULL` in `reward_kind`/`unit_type`/`unit_code` on this table only — see this
 * file's own header. Fits every one of the three columns' own `varchar` length limits
 * (`varchar(20)`/`varchar(14)`/`varchar(10)`). Exported so a later reader of this same table (a task
 * this repository cannot foresee) can apply the identical translation back to `null`. */
export const NULL_GROUPING_SENTINEL = '__NULL__';

function toSentinel(value: string | null): string {
  return value ?? NULL_GROUPING_SENTINEL;
}

function fromSentinel(value: string | null): string | null {
  return value === NULL_GROUPING_SENTINEL ? null : value;
}

export interface ShardUpsertInput {
  tenant_id: number;
  campaign_code: string;
  reward_category: string;
  reward_kind: RewardKind | null;
  unit_type: string | null;
  unit_code: string | null;
  reward_value: string;
  /** The value hashed to pick a shard — `reward_entry_id` (§4's own choice: "simpler and needs no
   * extra parameter, since it's already the row's own idempotency key upstream"). */
  shardSeed: string;
}

const UPSERT_SQL = `
  INSERT INTO reward_tracking.campaign_reward_counter_shard
    (tenant_id, campaign_code, reward_category, reward_kind, unit_type, unit_code, shard_key,
     total_reward_value, total_reward_count)
  VALUES ($1, $2, $3, $4, $5, $6, abs(hashtext($7)) % $8, $9, 1)
  ON CONFLICT (tenant_id, campaign_code, reward_category, reward_kind, unit_type, unit_code, shard_key)
  DO UPDATE SET total_reward_value = campaign_reward_counter_shard.total_reward_value + EXCLUDED.total_reward_value,
                total_reward_count = campaign_reward_counter_shard.total_reward_count + 1,
                updated_at         = now()
  RETURNING *
`;

@Injectable()
export class CampaignRewardCounterShardRepository {
  /** `shardCount` (`N`, `ShardCountResolverService`'s own resolved value) is passed in as a bound
   * parameter, never baked into the query string as a literal (§4's own explicit requirement). */
  async upsert(
    client: PoolClient,
    input: ShardUpsertInput,
    shardCount: number,
  ): Promise<CampaignRewardCounterShardRow> {
    const result = await client.query<CampaignRewardCounterShardRow>(UPSERT_SQL, [
      input.tenant_id,
      input.campaign_code,
      input.reward_category,
      toSentinel(input.reward_kind),
      toSentinel(input.unit_type),
      toSentinel(input.unit_code),
      input.shardSeed,
      shardCount,
      input.reward_value,
    ]);
    const row = result.rows[0];
    return {
      ...row,
      reward_kind: fromSentinel(row.reward_kind) as RewardKind | null,
      unit_type: fromSentinel(row.unit_type),
      unit_code: fromSentinel(row.unit_code),
    };
  }
}
