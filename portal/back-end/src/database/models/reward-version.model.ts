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
import { RewardSystem } from './reward-system.model';
import type { UnitType } from './campaign-cap.model';
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';
import type { VersionStatus } from './rule-version.model';

/**
 * `reward_config.reward_versions` (T005_002) — mirrors `rule_versions` exactly; added to
 * T-003's modelled set beyond the task file's own fixed list, per the same
 * 05-EXECUTION-PLAN.md §1 note as `rule-version.model.ts`.
 *
 * `connector_config` / `retry_config` are `text` holding JSON (same tolerant getter/setter
 * treatment as every other legacy JSON-in-text column). `policies_snapshot` is genuine
 * `jsonb` in the live DDL — modelled directly as `DataType.JSONB`, no getter needed.
 * `unit_type`/`unit_code` reuse `campaign-cap.model.ts`'s `UnitType` — 11-BUDGETS-AND-LIMITS.md
 * §3.1: no conversion rate anywhere in the design, a budget only ever matches a grant sharing
 * both fields exactly.
 */
@Table({
  schema: 'reward_config',
  tableName: 'reward_versions',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RewardVersion extends Model<RewardVersion> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => RewardSystem)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'reward_id' })
  declare rewardId: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'version_no' })
  declare versionNo: number;

  @Column(DataType.TEXT)
  get connectorConfig(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('connectorConfig'), {});
  }
  set connectorConfig(value: Record<string, unknown>) {
    this.setDataValue(
      'connectorConfig',
      stringifyJsonColumn(value) as unknown as Record<string, unknown>,
    );
  }

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'delivery_mode' })
  declare deliveryMode: string | null;

  @Column(DataType.TEXT)
  get retryConfig(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('retryConfig'), {});
  }
  set retryConfig(value: Record<string, unknown>) {
    this.setDataValue(
      'retryConfig',
      stringifyJsonColumn(value) as unknown as Record<string, unknown>,
    );
  }

  @Column({ type: DataType.JSONB, allowNull: true, field: 'policies_snapshot' })
  declare policiesSnapshot: Record<string, unknown>[] | Record<string, unknown> | null;

  @Column({ type: DataType.STRING(14), allowNull: true, field: 'unit_type' })
  declare unitType: UnitType | null;

  @Column({ type: DataType.STRING(10), allowNull: true, field: 'unit_code' })
  declare unitCode: string | null;

  @Column({ type: DataType.STRING(500), allowNull: true, field: 'change_summary' })
  declare changeSummary: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_breaking' })
  declare isBreaking: boolean;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'draft' })
  declare status: VersionStatus;

  @ForeignKey(() => RewardVersion)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'supersedes_version_id' })
  declare supersedesVersionId: number | null;

  /** References `definition_requests`, no FK — mirrors `rule_versions`' own note. */
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

  @BelongsTo(() => RewardSystem)
  declare reward: RewardSystem;

  @BelongsTo(() => RewardVersion, { foreignKey: 'supersedesVersionId' })
  declare supersedesVersion: RewardVersion | null;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
