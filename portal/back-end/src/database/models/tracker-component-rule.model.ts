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
import { TrackerComponent } from './tracker-component.model';
import { RuleMaster } from './rule-master.model';
import { RuleVersion } from './rule-version.model';
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

/**
 * `reward_config.tracker_component_rules` — **added by T-037** (see
 * `tracker-component.model.ts`'s header for why).
 *
 * **Rules bind to a tracker component, never to the campaign** (04-FRONTEND.md §5.1,
 * implementation note 7). A rule answers exactly one question — *is this component complete?* —
 * and completion then rolls up through the tracker's `completion_logic` to the campaign.
 *
 * ### `config` holds the maker's dynamic values
 *
 * `text` holding JSON, same tolerant getter/setter treatment as `rule_master.parameters`. The
 * values inside are validated **server-side** against the pinned version's own `parameters`
 * meta-schema before they are ever written (`buildRuleValueSchema`, implementation note 9,
 * TC-17) — the client's identically-built schema is a UX affordance, not a control.
 *
 * ### `rule_version_id` is the binding pin
 *
 * T005_006's additive column, and 06-VERSIONING.md §7's whole point: the concrete version a
 * campaign is running, written once at bind time and never rewritten by a later blast. `NULL`
 * means the rule had no version assigned to the actor's country at bind time and reads as
 * "pre-versioning / version 1 by convention" (§5.1's own wording) — the wizard still binds, so a
 * rule that predates T-005 is usable rather than silently missing from the picker.
 */
@Table({
  schema: 'reward_config',
  tableName: 'tracker_component_rules',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class TrackerComponentRule extends Model<TrackerComponentRule> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @ForeignKey(() => TrackerComponent)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tracker_component_id' })
  declare trackerComponentId: number;

  @ForeignKey(() => RuleMaster)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'rule_id' })
  declare ruleId: number;

  /** The maker's dynamic values — see this file's header. */
  @Column(DataType.TEXT)
  get config(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('config'), {});
  }
  set config(value: Record<string, unknown>) {
    this.setDataValue('config', stringifyJsonColumn(value) as unknown as Record<string, unknown>);
  }

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  /** T005_006 binding pin — see this file's header. */
  @ForeignKey(() => RuleVersion)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'rule_version_id' })
  declare ruleVersionId: number | null;

  /**
   * T-104 — the first-class comparison contract this binding actually evaluates, sitting next
   * to `config` rather than replacing it: `config` keeps holding the Maker's extra field values
   * (e.g. `targetComponentCode`), `operator`/`value` are the dedicated comparison the runtime
   * engine reads. `operator` is validated at the application layer against the pinned version's
   * `default_operators` (a future task) — no DB-level CHECK, matching how `status` on this same
   * table has no CHECK constraint either.
   */
  @Column({ type: DataType.STRING(30), allowNull: true })
  declare operator: string | null;

  /** JSON — scalar/array/range depending on `operator`'s `expected_value_type`. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare value: string | null;

  /** Evaluation order within the component — lower runs first. `NULL` reads as `100`. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare priority: number | null;

  /** Per-binding override of the resolver's path. */
  @Column({ type: DataType.STRING(200), allowNull: true, field: 'resolved_data_key_path' })
  declare resolvedDataKeyPath: string | null;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => TrackerComponent)
  declare component: TrackerComponent;

  @BelongsTo(() => RuleMaster)
  declare rule: RuleMaster;

  @BelongsTo(() => RuleVersion)
  declare ruleVersion: RuleVersion | null;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
