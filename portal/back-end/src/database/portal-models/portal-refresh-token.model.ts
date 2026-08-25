import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { PortalSession } from './portal-session.model';
import { PortalUser } from './portal-user.model';

/**
 * `reward_portal.portal_refresh_tokens` — T-003 (01-DATABASE.md §2.4). Rotation with reuse
 * detection: a `consumed` token presented again means theft — T-011 must revoke the whole
 * `session_id` family. `token_hash` is SHA-256 of the raw token; the raw value is never
 * stored anywhere, so (unlike the credential hashes) there is nothing here that needs a
 * `defaultScope` exclusion. No `created_at`/`updated_at` (`issued_at` instead) —
 * `timestamps: false`.
 */
@Table({
  schema: 'reward_portal',
  tableName: 'portal_refresh_tokens',
  underscored: true,
  timestamps: false,
})
export class PortalRefreshToken extends Model<PortalRefreshToken> {
  @Column({ type: DataType.UUID, primaryKey: true })
  declare id: string;

  @ForeignKey(() => PortalSession)
  @Column({ type: DataType.UUID, allowNull: false, field: 'session_id' })
  declare sessionId: string;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare userId: number;

  @Column({ type: DataType.STRING(128), allowNull: false, field: 'token_hash' })
  declare tokenHash: string;

  @ForeignKey(() => PortalRefreshToken)
  @Column({ type: DataType.UUID, allowNull: true, field: 'parent_token_id' })
  declare parentTokenId: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'issued_at' })
  declare issuedAt: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'expires_at' })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'consumed_at' })
  declare consumedAt: Date | null;

  @BelongsTo(() => PortalSession)
  declare session: PortalSession;

  @BelongsTo(() => PortalUser)
  declare user: PortalUser;

  @BelongsTo(() => PortalRefreshToken, { foreignKey: 'parentTokenId' })
  declare parentToken: PortalRefreshToken | null;
}
