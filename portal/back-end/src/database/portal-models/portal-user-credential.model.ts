import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  DefaultScope,
  ForeignKey,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { PortalUser } from './portal-user.model';

/**
 * `reward_portal.portal_user_credentials` — T-003 (01-DATABASE.md §2.2, gap G2). Split from
 * `portal_users` so a plain `SELECT *` on the user table can never return a hash.
 * `password_hash` and `previous_hashes` are excluded from the default scope
 * (implementation note 5) — retrieving either requires an explicit `.unscoped()` call from
 * the auth service (T-010), never a bare `.findOne()`.
 *
 * `previous_hashes` is genuinely `jsonb` in the live schema, not the `text` 01-DATABASE.md
 * §2.2 originally specified — T002_003's own documented deviation (AR-13 consistency fix);
 * modelled here as `DataType.JSONB` directly (no manual parse/stringify needed, unlike the
 * `reward_config` legacy `text`-holding-JSON columns).
 */
@DefaultScope(() => ({
  attributes: { exclude: ['passwordHash', 'previousHashes'] },
}))
@Table({
  schema: 'reward_portal',
  tableName: 'portal_user_credentials',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class PortalUserCredential extends Model<PortalUserCredential> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: false, unique: true, field: 'user_id' })
  declare userId: number;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'password_hash' })
  declare passwordHash: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'argon2id',
    field: 'password_algo',
  })
  declare passwordAlgo: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'password_updated_at' })
  declare passwordUpdatedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'password_expires_at' })
  declare passwordExpiresAt: Date | null;

  /** Last 5 hashes, reuse prevention. Genuine `jsonb` — see class doc comment. */
  @Column({ type: DataType.JSONB, allowNull: true, field: 'previous_hashes' })
  declare previousHashes: string[] | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'failed_attempts' })
  declare failedAttempts: number;

  @Column({ type: DataType.DATE, allowNull: true, field: 'locked_until' })
  declare lockedUntil: Date | null;

  @BelongsTo(() => PortalUser)
  declare user: PortalUser;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
