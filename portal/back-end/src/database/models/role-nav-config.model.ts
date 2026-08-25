import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';

/** `reward_config.role_nav_configs` — T-003. Drives the dynamic nav (01-DATABASE.md §5.2). */
@Table({
  schema: 'reward_config',
  tableName: 'role_nav_configs',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RoleNavConfig extends Model<RoleNavConfig> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare role: string;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'nav_key' })
  declare navKey: string;

  @Column({ type: DataType.STRING(80), allowNull: false })
  declare label: string;

  @Column({ type: DataType.STRING(50), allowNull: true })
  declare icon: string | null;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare path: string;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'parent_nav_key' })
  declare parentNavKey: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'sort_order' })
  declare sortOrder: number;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare enabled: boolean;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
