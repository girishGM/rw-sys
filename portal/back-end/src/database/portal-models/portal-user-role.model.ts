import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { PortalUser } from './portal-user.model';

/**
 * `reward_portal.portal_user_roles` — T-003 (01-DATABASE.md §2.6). Forward compatibility
 * only — **not used in v1** (every user has exactly one role via `portal_users.role`); this
 * table exists so multi-role support later is a data change, not a schema migration. No
 * `created_at`/`updated_at` (`granted_at` instead) — `timestamps: false`.
 */
@Table({
  schema: 'reward_portal',
  tableName: 'portal_user_roles',
  underscored: true,
  timestamps: false,
})
export class PortalUserRole extends Model<PortalUserRole> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare userId: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare role: string;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'granted_by' })
  declare grantedBy: number | null;

  @Column({ type: DataType.DATE, allowNull: false, field: 'granted_at' })
  declare grantedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'revoked_at' })
  declare revokedAt: Date | null;

  @BelongsTo(() => PortalUser, { foreignKey: 'userId' })
  declare user: PortalUser;

  @BelongsTo(() => PortalUser, { foreignKey: 'grantedBy' })
  declare grantedByUser: PortalUser | null;
}
