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
import { ActivityType } from './activity-type.model';
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

/**
 * `reward_config.activities` — T-003. `metadata` is `text` holding JSON (01-DATABASE.md §6
 * implementation note 3) — exposed as a tolerant getter/setter, never a raw string.
 */
@Table({
  schema: 'reward_config',
  tableName: 'activities',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class Activity extends Model<Activity> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @ForeignKey(() => ActivityType)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'type_id' })
  declare typeId: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'activity_code' })
  declare activityCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @Column(DataType.TEXT)
  get metadata(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('metadata'), {});
  }
  set metadata(value: Record<string, unknown>) {
    this.setDataValue('metadata', stringifyJsonColumn(value) as unknown as Record<string, unknown>);
  }

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => ActivityType)
  declare type: ActivityType;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
