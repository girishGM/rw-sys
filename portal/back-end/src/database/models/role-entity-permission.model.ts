import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

/**
 * `reward_config.role_entity_permissions` — T-003. The authoritative permission matrix
 * (01-DATABASE.md §5.1). `actions` is a JSON array packed into a `varchar(500)`
 * (implementation note 4) — exposed as `string[]`, never a raw string; malformed content
 * tolerantly returns `[]` rather than throwing (same rule as the `text`-JSON columns).
 */
@Table({
  schema: 'reward_config',
  tableName: 'role_entity_permissions',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RoleEntityPermission extends Model<RoleEntityPermission> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare role: string;

  @Column({ type: DataType.STRING(50), allowNull: false })
  declare entity: string;

  @Column(DataType.STRING(500))
  get actions(): string[] {
    return parseJsonColumn<string[]>(this.getDataValue('actions'), []);
  }
  set actions(value: string[]) {
    this.setDataValue('actions', stringifyJsonColumn(value) as unknown as string[]);
  }

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
