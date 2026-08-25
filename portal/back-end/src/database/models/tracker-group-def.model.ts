import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';

/**
 * DEPRECATION NOTICE — read before touching `tracker_component_groups` anywhere in this
 * codebase.
 *
 * `reward_config.tracker_component_groups` is **portal-deprecated**, superseded by
 * `tracker_tracker_components.group_code` (T007_001) plus this table,
 * `tracker_group_defs` (T007_002). 12-CAMPAIGN-STRUCTURE.md §1 found the two tables
 * competing, not complementary — same FKs, same `unique (tracker_id, component_id)`, both
 * answering "which components belong to this tracker" — a shape that produces two sources
 * of truth that can silently disagree. The portal standardises on
 * `tracker_tracker_components` because it carries `is_mandatory`, which a confirmed
 * requirement needs today; `tracker_component_groups` does not, and its one real
 * advantage — a `group_code` label — turned out to be a cheap nullable `ADD COLUMN` on the
 * winning table instead.
 *
 * `tracker_component_groups` is left in place, untouched and unused (C1 forbids dropping
 * it) — it holds zero rows as of this migration and the portal writes none. **No later
 * agent should generate a Sequelize model for it, query it, or write to it.** If a
 * two-level-completion feature is ever built, it is built on `group_code` +
 * `tracker_group_defs`, not by reviving this table.
 *
 * ---
 *
 * `reward_config.tracker_group_defs` (T007_002) — 12-CAMPAIGN-STRUCTURE.md §1.4. Mirrors
 * that migration's DDL exactly; every CHECK lives in the database, not here.
 *
 * **Not wired into any evaluator in v1.** The column that would reference this table
 * (`tracker_tracker_components.group_code`) is written as `NULL` throughout by the wizard
 * (T-037) — see 12-CAMPAIGN-STRUCTURE.md §1.5's "Now / Later" table. This model exists so
 * the future feature is additive, not a redesign; building the group UI or the two-level
 * evaluator now is explicitly out of scope for this task.
 *
 * Evaluation order once a later task wires this up (§1.4):
 *   1. Every component with `group_code IS NULL` evaluates directly against the tracker's
 *      own `completion_logic`.
 *   2. Every group evaluates by its own `completionLogic` here, producing one boolean.
 *   3. The tracker's `completion_logic` then applies over
 *      `{ungrouped components} UNION {group results}`.
 *   4. `isMandatory` wins at both levels — a mandatory component or group is always
 *      required, regardless of what its containing logic would otherwise permit.
 *
 * No FK links `tracker_tracker_components.group_code` to this table's `group_code`
 * (12-CAMPAIGN-STRUCTURE.md §1.4's own DDL has none) — the match is by application logic
 * once an evaluator exists, not a DB-enforced relationship.
 */
export type GroupCompletionLogic = 'all' | 'any' | 'n_of';

@Table({
  schema: 'reward_config',
  tableName: 'tracker_group_defs',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class TrackerGroupDef extends Model<TrackerGroupDef> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tracker_id' })
  declare trackerId: number;

  /** Matched (by application logic, not a DB FK) against
   * `tracker_tracker_components.group_code` for rows belonging to this group. */
  @Column({ type: DataType.STRING(10), allowNull: false, field: 'group_code' })
  declare groupCode: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name: string | null;

  /** Same three-value vocabulary as `trackers.completion_logic` (`ck_trk_logic`). */
  @Column({
    type: DataType.STRING(10),
    allowNull: false,
    defaultValue: 'all',
    field: 'completion_logic',
  })
  declare completionLogic: GroupCompletionLogic;

  /** Required when `completionLogic = 'n_of'` (`ck_tgd_threshold`); an `n_of` group with no
   * threshold is a configuration error the database refuses to store. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'completion_threshold' })
  declare completionThreshold: number | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1, field: 'sequence_order' })
  declare sequenceOrder: number;

  /** Wins over the tracker's `completion_logic` at the group level — a mandatory group is
   * always required, per the evaluation order documented on this file's header comment. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_mandatory' })
  declare isMandatory: boolean;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
