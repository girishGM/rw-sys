import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';

/** `reward_config.system_messages` — T-003 (01-DATABASE.md §5.4). */
@Table({
  schema: 'reward_config',
  tableName: 'system_messages',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class SystemMessage extends Model<SystemMessage> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'message_key' })
  declare messageKey: string;

  @Column({ type: DataType.STRING(1000), allowNull: false, field: 'message_text' })
  declare messageText: string;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
