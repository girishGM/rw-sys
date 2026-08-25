import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  DeletedAt,
  ForeignKey,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Tenant } from './tenant.model';
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

/**
 * `reward_config.reward_systems` — T-003. `tenant_id` nullable since T-002's authorised
 * `DROP NOT NULL` (gap G6, same semantics as `rule_master`). `paranoid: true` (`deleted_at`
 * exists). `connector_config`, `retry_config` and `maintenance_schedule` are `text` holding
 * JSON — same tolerant getter/setter treatment as every other legacy JSON-in-text column.
 * `merchant_id` has no FK constraint in the live schema for this table.
 */
@Table({
  schema: 'reward_config',
  tableName: 'reward_systems',
  underscored: true,
  timestamps: true,
  paranoid: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
})
export class RewardSystem extends Model<RewardSystem> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'tenant_id' })
  declare tenantId: number | null;

  /** No FK constraint in the live schema for this column. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'merchant_id' })
  declare merchantId: number | null;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'system_code' })
  declare systemCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.STRING(30), allowNull: false, field: 'reward_type' })
  declare rewardType: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'realtime',
    field: 'delivery_mode',
  })
  declare deliveryMode: string;

  @Column({ type: DataType.STRING(20), allowNull: false, field: 'connector_type' })
  declare connectorType: string;

  @Column({ type: DataType.TEXT, field: 'connector_config' })
  get connectorConfig(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('connectorConfig'), {});
  }
  set connectorConfig(value: Record<string, unknown>) {
    this.setDataValue(
      'connectorConfig',
      stringifyJsonColumn(value) as unknown as Record<string, unknown>,
    );
  }

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'maintenance_window_enabled',
  })
  declare maintenanceWindowEnabled: boolean;

  @Column({ type: DataType.TEXT, field: 'maintenance_schedule' })
  get maintenanceSchedule(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('maintenanceSchedule'), {});
  }
  set maintenanceSchedule(value: Record<string, unknown>) {
    this.setDataValue(
      'maintenanceSchedule',
      stringifyJsonColumn(value) as unknown as Record<string, unknown>,
    );
  }

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true, field: 'retry_enabled' })
  declare retryEnabled: boolean;

  @Column({ type: DataType.TEXT, field: 'retry_config' })
  get retryConfig(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('retryConfig'), {});
  }
  set retryConfig(value: Record<string, unknown>) {
    this.setDataValue(
      'retryConfig',
      stringifyJsonColumn(value) as unknown as Record<string, unknown>,
    );
  }

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant | null;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;

  @DeletedAt
  @Column({ type: DataType.DATE, field: 'deleted_at' })
  declare deletedAt: Date | null;
}
