/**
 * T-032 implementation note 5 — "Caps live in `reward_policy_caps`; expose read/write for
 * super_admin only."
 *
 * ### Why this is a hand-written parameterised query, not a `ScopedRepository` call
 *
 * `reward_config.reward_policy_caps` has no Sequelize model — T-003 (`back-end/src/database/
 * models/**`, not owned by this task, R9) did not model it, and neither adding a model nor
 * adding a `scope-strategy.ts` entry is this task's call to make (that file is T-013's owned
 * scope too). `rules/campaign-usage.query.ts` (T-031) already establishes the precedent this
 * file follows for exactly this situation: a raw, parameterised `sequelize.query()` against a
 * table with no Sequelize model, values bound through `replacements` (never interpolated), for
 * a table `reward_app` is independently confirmed to hold real `SELECT`/`INSERT`/`UPDATE`
 * privilege on — checked against the live database with `has_table_privilege()` before this file
 * was written (T-032 completion report).
 *
 * This is **not** an R2 bypass in the sense R2 exists to prevent: `reward_policy_caps` carries no
 * `tenant_id`/`country_id` column at all — it hangs off `reward_policy_id`, whose own visibility
 * (via `reward_policies` → `reward_systems` → `reward_country_assignments`) is a Super-Admin-
 * authored, assignment-gated resource. Every route this file backs is gated `@Roles('super_admin')`
 * (`rewards.controller.ts`), whose `scope-strategy.ts` entries are themselves unrestricted for
 * every table in this schema — so there is no cross-tenant row this raw query could leak that
 * `ScopedRepository` would have prevented; the actual authority boundary is the route guard, not
 * a `WHERE` clause on this table.
 */
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type {
  RewardPolicyCapFrequencyUnitValue,
  RewardPolicyCapStatusValue,
  RewardPolicyCapTypeValue,
} from './dto/reward-policy-cap.dto';

export interface RewardPolicyCapRow {
  readonly id: number;
  readonly rewardPolicyId: number;
  readonly capType: RewardPolicyCapTypeValue;
  readonly frequencyValue: number | null;
  readonly frequencyUnit: RewardPolicyCapFrequencyUnitValue | null;
  readonly maxOccurrences: number | null;
  readonly maxTotalAmount: number | null;
  readonly status: RewardPolicyCapStatusValue;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RawRewardPolicyCapRow {
  readonly id: number;
  readonly reward_policy_id: number;
  readonly cap_type: string;
  readonly frequency_value: number | null;
  readonly frequency_unit: string | null;
  readonly max_occurrences: number | null;
  readonly max_total_amount: string | null;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function fromRaw(row: RawRewardPolicyCapRow): RewardPolicyCapRow {
  return {
    id: row.id,
    rewardPolicyId: row.reward_policy_id,
    capType: row.cap_type as RewardPolicyCapTypeValue,
    frequencyValue: row.frequency_value,
    frequencyUnit: row.frequency_unit as RewardPolicyCapFrequencyUnitValue | null,
    maxOccurrences: row.max_occurrences,
    // `decimal(18,4)` round-trips through `pg` as a string, to avoid silent float precision
    // loss on a monetary column; converted to `number` here, at the one boundary this module
    // owns, the same choice `campaign-usage.query.ts`'s sibling modules make for money columns.
    maxTotalAmount: row.max_total_amount === null ? null : Number(row.max_total_amount),
    status: row.status as RewardPolicyCapStatusValue,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRewardPolicyCaps(
  sequelize: Sequelize,
  rewardPolicyId: number,
): Promise<readonly RewardPolicyCapRow[]> {
  const rows = await sequelize.query<RawRewardPolicyCapRow>(
    `SELECT id, reward_policy_id, cap_type, frequency_value, frequency_unit, max_occurrences,
            max_total_amount, status, created_at, updated_at
       FROM reward_config.reward_policy_caps
      WHERE reward_policy_id = :rewardPolicyId
      ORDER BY id`,
    { type: QueryTypes.SELECT, replacements: { rewardPolicyId } },
  );
  return rows.map(fromRaw);
}

export async function findRewardPolicyCap(
  sequelize: Sequelize,
  id: number,
  rewardPolicyId: number,
): Promise<RewardPolicyCapRow | null> {
  const rows = await sequelize.query<RawRewardPolicyCapRow>(
    `SELECT id, reward_policy_id, cap_type, frequency_value, frequency_unit, max_occurrences,
            max_total_amount, status, created_at, updated_at
       FROM reward_config.reward_policy_caps
      WHERE id = :id AND reward_policy_id = :rewardPolicyId`,
    { type: QueryTypes.SELECT, replacements: { id, rewardPolicyId } },
  );
  return rows.length === 0 ? null : fromRaw(rows[0]);
}

export interface InsertRewardPolicyCapInput {
  readonly rewardPolicyId: number;
  readonly capType: RewardPolicyCapTypeValue;
  readonly frequencyValue: number | null;
  readonly frequencyUnit: RewardPolicyCapFrequencyUnitValue | null;
  readonly maxOccurrences: number | null;
  readonly maxTotalAmount: number | null;
}

export async function insertRewardPolicyCap(
  sequelize: Sequelize,
  input: InsertRewardPolicyCapInput,
  transaction?: Transaction,
): Promise<RewardPolicyCapRow> {
  const rows = await sequelize.query<RawRewardPolicyCapRow>(
    `INSERT INTO reward_config.reward_policy_caps
         (reward_policy_id, cap_type, frequency_value, frequency_unit, max_occurrences,
          max_total_amount, status, created_at, updated_at)
     VALUES (:rewardPolicyId, :capType, :frequencyValue, :frequencyUnit, :maxOccurrences,
             :maxTotalAmount, 'active', now(), now())
     RETURNING id, reward_policy_id, cap_type, frequency_value, frequency_unit, max_occurrences,
               max_total_amount, status, created_at, updated_at`,
    {
      type: QueryTypes.SELECT,
      replacements: {
        rewardPolicyId: input.rewardPolicyId,
        capType: input.capType,
        frequencyValue: input.frequencyValue,
        frequencyUnit: input.frequencyUnit,
        maxOccurrences: input.maxOccurrences,
        maxTotalAmount: input.maxTotalAmount,
      },
      transaction,
    },
  );
  return fromRaw(rows[0]);
}

export interface UpdateRewardPolicyCapInput {
  readonly frequencyValue?: number | null;
  readonly frequencyUnit?: RewardPolicyCapFrequencyUnitValue | null;
  readonly maxOccurrences?: number | null;
  readonly maxTotalAmount?: number | null;
  readonly status?: RewardPolicyCapStatusValue;
}

/** Returns `null` when no row matched `id`/`rewardPolicyId` — the caller answers 404, the same
 * "absent or out of scope is indistinguishable" contract `ScopedRepository.findByPkOrFail`
 * documents (there is no scope to be "out of" here, but the same response shape either way). */
export async function updateRewardPolicyCap(
  sequelize: Sequelize,
  id: number,
  rewardPolicyId: number,
  changes: UpdateRewardPolicyCapInput,
): Promise<RewardPolicyCapRow | null> {
  const assignments: string[] = [];
  const replacements: Record<string, unknown> = { id, rewardPolicyId };

  for (const [column, key] of [
    ['frequency_value', 'frequencyValue'],
    ['frequency_unit', 'frequencyUnit'],
    ['max_occurrences', 'maxOccurrences'],
    ['max_total_amount', 'maxTotalAmount'],
    ['status', 'status'],
  ] as const) {
    if (key in changes) {
      assignments.push(`${column} = :${key}`);
      replacements[key] = changes[key as keyof UpdateRewardPolicyCapInput] ?? null;
    }
  }

  if (assignments.length === 0) {
    return findRewardPolicyCap(sequelize, id, rewardPolicyId);
  }

  const rows = await sequelize.query<RawRewardPolicyCapRow>(
    `UPDATE reward_config.reward_policy_caps
        SET ${assignments.join(', ')}, updated_at = now()
      WHERE id = :id AND reward_policy_id = :rewardPolicyId
      RETURNING id, reward_policy_id, cap_type, frequency_value, frequency_unit, max_occurrences,
                max_total_amount, status, created_at, updated_at`,
    { type: QueryTypes.SELECT, replacements },
  );
  return rows.length === 0 ? null : fromRaw(rows[0]);
}
