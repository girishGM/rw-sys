import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { VersionBlast } from './version-blast.model';
import { Country } from './country.model';

export type BlastTargetStatus = 'delivered' | 'failed' | 'skipped';

/**
 * `reward_config.version_blast_targets` (T005_004) — added to T-003's modelled set beyond
 * the task file's own fixed list, per 05-EXECUTION-PLAN.md §1. One row per country a
 * `version_blasts` row was sent to. No `created_at`/`updated_at` in the live DDL —
 * `timestamps: false`.
 */
@Table({
  schema: 'reward_config',
  tableName: 'version_blast_targets',
  underscored: true,
  timestamps: false,
})
export class VersionBlastTarget extends Model<VersionBlastTarget> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => VersionBlast)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'blast_id' })
  declare blastId: number;

  @ForeignKey(() => Country)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'country_id' })
  declare countryId: number;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'delivered' })
  declare status: BlastTargetStatus;

  @Column({ type: DataType.STRING(300), allowNull: true, field: 'failure_reason' })
  declare failureReason: string | null;

  @BelongsTo(() => VersionBlast)
  declare blast: VersionBlast;

  @BelongsTo(() => Country)
  declare country: Country;
}
