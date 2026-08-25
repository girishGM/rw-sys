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
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

/** `reward_config.reward_policies` — T-003. `config` is `text` holding JSON. */
@Table({
  schema: 'reward_config',
  tableName: 'reward_policies',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RewardPolicy extends Model<RewardPolicy> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => RewardSystem)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'reward_system_id' })
  declare rewardSystemId: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'policy_code' })
  declare policyCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @Column(DataType.TEXT)
  get config(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('config'), {});
  }
  set config(value: Record<string, unknown>) {
    this.setDataValue('config', stringifyJsonColumn(value) as unknown as Record<string, unknown>);
  }

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => RewardSystem)
  declare rewardSystem: RewardSystem;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
