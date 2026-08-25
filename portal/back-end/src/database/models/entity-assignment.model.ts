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
 * `reward_config.entity_assignments` — T-003. `assigned_to_user_id` / `assigned_by_user_id`
 * / `revoked_by_user_id` all reference the un-modelled `admin_users` — plain columns.
 */
@Table({
  schema: 'reward_config',
  tableName: 'entity_assignments',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class EntityAssignment extends Model<EntityAssignment> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.STRING(30), allowNull: false, field: 'entity_type' })
  declare entityType: string;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'entity_id' })
  declare entityId: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'assigned_to_user_id' })
  declare assignedToUserId: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'assigned_by_user_id' })
  declare assignedByUserId: number;

  @Column({ type: DataType.DATE, allowNull: false, field: 'assigned_at' })
  declare assignedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'revoked_at' })
  declare revokedAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'revoked_by_user_id' })
  declare revokedByUserId: number | null;

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
