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

/**
 * `reward_config.trackers` — T-003. `tracker_tracker_components` (T-007's group-composition
 * standardisation, `TrackerGroupDef` model) is out of this task's required list — not
 * modelled here.
 */
@Table({
  schema: 'reward_config',
  tableName: 'trackers',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class Tracker extends Model<Tracker> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'tracker_code' })
  declare trackerCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @Column({
    type: DataType.STRING(10),
    allowNull: false,
    defaultValue: 'all',
    field: 'completion_logic',
  })
  declare completionLogic: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'completion_threshold' })
  declare completionThreshold: number | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
