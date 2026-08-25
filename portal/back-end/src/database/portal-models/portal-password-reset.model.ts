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
 * `reward_portal.portal_password_resets` — T-003 (01-DATABASE.md §2.5). `token_hash` is
 * SHA-256 of the raw token; the raw value is never stored. Has `created_at` but no
 * `updated_at` — `updatedAt: false`.
 */
@Table({
  schema: 'reward_portal',
  tableName: 'portal_password_resets',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
})
export class PortalPasswordReset extends Model<PortalPasswordReset> {
  @Column({ type: DataType.UUID, primaryKey: true })
  declare id: string;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare userId: number;

  @Column({ type: DataType.STRING(128), allowNull: false, field: 'token_hash' })
  declare tokenHash: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'expires_at' })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'consumed_at' })
  declare consumedAt: Date | null;

  @BelongsTo(() => PortalUser)
  declare user: PortalUser;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;
}
