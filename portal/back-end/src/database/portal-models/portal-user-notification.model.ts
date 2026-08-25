import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  Model,
  Table,
} from 'sequelize-typescript';
import { PortalUser } from './portal-user.model';

/**
 * `reward_portal.portal_user_notifications` — T-040 retry 1 (`T040_001_portal_user_notifications`
 * migration header carries the full rationale for why this table exists rather than a fix to
 * `reward_config.user_notifications`). Column-for-column mirror of that table's shape, with
 * `user_id` fixed to reference `reward_portal.portal_users(id)` — the value every read path
 * already compares against (`scope-strategy.ts`) — instead of the un-bridgeable
 * `reward_config.admin_users(id)`.
 *
 * No `updated_at` column, matching the mirrored table — `updatedAt: false`.
 */
@Table({
  schema: 'reward_portal',
  tableName: 'portal_user_notifications',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
})
export class PortalUserNotification extends Model<PortalUserNotification> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  /** `reward_config.tenants(id)` — cross-schema, `ON DELETE RESTRICT` (01-DATABASE.md §1). */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare userId: number;

  @Column({ type: DataType.STRING(30), allowNull: false, field: 'notification_type' })
  declare notificationType: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare title: string;

  @Column({ type: DataType.STRING(500), allowNull: false })
  declare message: string;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'entity_type' })
  declare entityType: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'entity_id' })
  declare entityId: number | null;

  @Column({ type: DataType.STRING(200), allowNull: true, field: 'entity_label' })
  declare entityLabel: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_read' })
  declare isRead: boolean;

  @Column({ type: DataType.DATE, allowNull: true, field: 'read_at' })
  declare readAt: Date | null;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @BelongsTo(() => PortalUser)
  declare user: PortalUser;
}
