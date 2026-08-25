import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

/** `reward_config.role_dashboard_widgets` — T-003. `widget_config` is `text` holding JSON. */
@Table({
  schema: 'reward_config',
  tableName: 'role_dashboard_widgets',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RoleDashboardWidget extends Model<RoleDashboardWidget> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare role: string;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'widget_key' })
  declare widgetKey: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare label: string;

  @Column({ type: DataType.TEXT, field: 'widget_config' })
  get widgetConfig(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('widgetConfig'), {});
  }
  set widgetConfig(value: Record<string, unknown>) {
    this.setDataValue(
      'widgetConfig',
      stringifyJsonColumn(value) as unknown as Record<string, unknown>,
    );
  }

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
