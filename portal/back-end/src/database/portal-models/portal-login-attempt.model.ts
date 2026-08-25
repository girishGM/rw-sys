import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { PortalUser } from './portal-user.model';

/**
 * `reward_portal.portal_login_attempts` — T-003 (01-DATABASE.md §2.5). `email` is stored as
 * submitted and may not match a real user (username enumeration protection lives in the
 * auth service, T-010/T-011, not here). No `created_at`/`updated_at` (`attempted_at`
 * instead) — `timestamps: false`.
 */
@Table({
  schema: 'reward_portal',
  tableName: 'portal_login_attempts',
  underscored: true,
  timestamps: false,
})
export class PortalLoginAttempt extends Model<PortalLoginAttempt> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare email: string;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'user_id' })
  declare userId: number | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare success: boolean;

  /** `bad_password | unknown_user | locked | inactive | mfa_failed`. */
  @Column({ type: DataType.STRING(40), allowNull: true, field: 'failure_code' })
  declare failureCode: string | null;

  @Column({ type: DataType.INET, allowNull: true, field: 'ip_address' })
  declare ipAddress: string | null;

  @Column({ type: DataType.STRING(400), allowNull: true, field: 'user_agent' })
  declare userAgent: string | null;

  @Column({ type: DataType.DATE, allowNull: false, field: 'attempted_at' })
  declare attemptedAt: Date;

  @BelongsTo(() => PortalUser)
  declare user: PortalUser | null;
}
