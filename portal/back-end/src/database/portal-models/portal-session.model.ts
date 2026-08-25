import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { PortalUser } from './portal-user.model';

/**
 * `reward_portal.portal_sessions` — T-003 (01-DATABASE.md §2.3). Instant-revoke: the access
 * JWT carries `sid`; `SessionValidGuard` (T-013) checks `status = 'active'` on every
 * request. No `created_at`/`updated_at` on this table (`issued_at`/`last_seen_at` instead)
 * — `timestamps: false`. `transport_key_enc` (AR-03, 07-DATA-PROTECTION.md §5) is
 * AES-256-GCM ciphertext, never logged — not excluded from the default scope here since,
 * unlike `mfa_secret_enc`/password hashes, T-018's payload-encryption handshake is the only
 * consumer and reads it directly by design; treat it as sensitive at every call site
 * regardless.
 */
@Table({
  schema: 'reward_portal',
  tableName: 'portal_sessions',
  underscored: true,
  timestamps: false,
})
export class PortalSession extends Model<PortalSession> {
  @Column({ type: DataType.UUID, primaryKey: true })
  declare id: string;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare userId: number;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @Column({ type: DataType.INET, allowNull: true, field: 'ip_address' })
  declare ipAddress: string | null;

  @Column({ type: DataType.STRING(400), allowNull: true, field: 'user_agent' })
  declare userAgent: string | null;

  @Column({ type: DataType.STRING(512), allowNull: true, field: 'transport_key_enc' })
  declare transportKeyEnc: string | null;

  @Column({ type: DataType.DATE, allowNull: false, field: 'issued_at' })
  declare issuedAt: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'last_seen_at' })
  declare lastSeenAt: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'expires_at' })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'revoked_at' })
  declare revokedAt: Date | null;

  @Column({ type: DataType.STRING(60), allowNull: true, field: 'revoked_reason' })
  declare revokedReason: string | null;

  @BelongsTo(() => PortalUser)
  declare user: PortalUser;
}
