import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Tenant } from './tenant.model';
import { Activity } from './activity.model';

/**
 * `reward_config.tracker_components` — **added by T-037**, not T-003.
 *
 * T-003's own "reward_config models required" list stopped at `trackers`; the three tables that
 * make the tracker/component hierarchy usable (`tracker_components`,
 * `tracker_tracker_components`, `tracker_component_rules`) and the three `reward_*_assignments`
 * tables were left unmodelled, and `rules/campaign-usage.query.ts` (T-031) says so explicitly:
 * *"T-037 … the task that owns the tracker/component hierarchy … adding models or a
 * `scope-strategy.ts` entry for them is T-037's call to make"*. This file, its five siblings, the
 * six appended lines in `index.ts` and the six appended `scope-strategy.ts` entries are that
 * call — all of them either brand-new files or pure appends to an append-only registration point
 * (05-EXECUTION-PLAN.md §3), with nothing pre-existing altered.
 *
 * ### The one thing this table does *not* carry: a campaign
 *
 * A component is **tenant**-scoped (`uq_tcomp_tenant_code`), not campaign-scoped — there is no
 * `campaign_id` column anywhere on it. "Components are campaign-scoped" (T-037 TC-21q) is
 * therefore a rule the *service* enforces by walking
 * `tracker_components → tracker_tracker_components → trackers → tenant_campaign_trackers`, not
 * something the schema states. `journey.service.ts` does that walk on every write; see its header.
 *
 * `activity_id` is nullable in the live DDL and is the component's **only** targeting dimension —
 * no product/SKU relationship exists or may be added (12-CAMPAIGN-STRUCTURE.md §2, BACKLOG B-14).
 * The wizard always populates it, and a component without one fails the pre-submit structural
 * check rather than being rejected at insert time, so a half-built draft stays saveable.
 */
@Table({
  schema: 'reward_config',
  tableName: 'tracker_components',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class TrackerComponent extends Model<TrackerComponent> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'component_code' })
  declare componentCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @ForeignKey(() => Activity)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'activity_id' })
  declare activityId: number | null;

  /** `text`. Free-form in the legacy schema; the portal expresses completion through
   * `tracker_component_rules` instead and leaves this untouched. */
  @Column({ type: DataType.TEXT, allowNull: true, field: 'completion_criteria' })
  declare completionCriteria: string | null;

  /**
   * T-104 — how this component's own bound rules combine: `'all'` | `'any'` | `'n_of'`, mirroring
   * `trackers.completion_logic` one level up. `NULL` reads as `'all'` at the application layer
   * (no DB-level default, per this task's own note on staying inside the nullable-additive
   * pattern already established elsewhere in this schema).
   */
  @Column({ type: DataType.STRING(10), allowNull: true, field: 'rule_logic' })
  declare ruleLogic: string | null;

  /** Only meaningful when `ruleLogic === 'n_of'`. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'rule_threshold' })
  declare ruleThreshold: number | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => Activity)
  declare activity: Activity | null;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
