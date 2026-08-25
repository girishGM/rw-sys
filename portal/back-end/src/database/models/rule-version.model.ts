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
import { RuleMaster } from './rule-master.model';
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

export type VersionStatus = 'draft' | 'published' | 'deprecated' | 'retired';

/**
 * `reward_config.rule_versions` (T005_001) — added to T-003's modelled set beyond the task
 * file's own fixed list, per 05-EXECUTION-PLAN.md §1: "T-003 ... models every table those
 * migrations create" (T-002/T-005/T-006/T-007). `expression`/`parameters` are `text` holding
 * JSON — same tolerant getter/setter treatment as `rule_master`'s own columns. Immutability
 * of a published row and undeletability are enforced by DB triggers (T005_007), not here —
 * this model has no special guard against `.update()`/`.destroy()` on a published row; the
 * database itself rejects it (see `T005_007_immutability_triggers.ts`).
 *
 * `origin_request_id`, `created_by`, `published_by` reference `definition_requests` /
 * un-modelled `admin_users` respectively but carry **no FK constraint** in the live DDL
 * (`T005_001` predates `definition_requests`, created two migrations later in `T005_005`) —
 * kept as plain columns, no association, per implementation note 7.
 */
@Table({
  schema: 'reward_config',
  tableName: 'rule_versions',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RuleVersion extends Model<RuleVersion> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => RuleMaster)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'rule_id' })
  declare ruleId: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'version_no' })
  declare versionNo: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare expression: string | null;

  @Column(DataType.TEXT)
  get parameters(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('parameters'), {});
  }
  set parameters(value: Record<string, unknown>) {
    this.setDataValue(
      'parameters',
      stringifyJsonColumn(value) as unknown as Record<string, unknown>,
    );
  }

  @Column({ type: DataType.STRING(500), allowNull: true, field: 'change_summary' })
  declare changeSummary: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_breaking' })
  declare isBreaking: boolean;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'draft' })
  declare status: VersionStatus;

  @ForeignKey(() => RuleVersion)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'supersedes_version_id' })
  declare supersedesVersionId: number | null;

  /** References `definition_requests`, no FK — see file doc comment. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'origin_request_id' })
  declare originRequestId: number | null;

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'created_by' })
  declare createdBy: number;

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'published_by' })
  declare publishedBy: number | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'published_at' })
  declare publishedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'deprecated_at' })
  declare deprecatedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'retired_at' })
  declare retiredAt: Date | null;

  @BelongsTo(() => RuleMaster)
  declare rule: RuleMaster;

  @BelongsTo(() => RuleVersion, { foreignKey: 'supersedesVersionId' })
  declare supersedesVersion: RuleVersion | null;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
