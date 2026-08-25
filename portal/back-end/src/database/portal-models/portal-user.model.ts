import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  DefaultScope,
  DeletedAt,
  ForeignKey,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Country } from '../models/country.model';
import { Tenant } from '../models/tenant.model';
import { Merchant } from '../models/merchant.model';

export type PortalRole =
  'super_admin' | 'country_admin' | 'tenant_admin' | 'maker' | 'checker' | 'merchant';

/**
 * `reward_portal.portal_users` — T-003 (01-DATABASE.md §2.1). The portal identity table;
 * closes gaps G1/G3. `ck_portal_users_scope` is enforced by the database, not here — see
 * that migration's own doc comment; this model must never try to relax it client-side.
 * `paranoid: true` (`deleted_at` exists; email uniqueness is soft-delete-aware — see
 * `uq_portal_users_email_live` / the T-002 fix documented in 01-DATABASE.md §2.1).
 * `mfa_secret_enc` is excluded from the default scope (implementation note 5) — a plain
 * `PortalUser.findAll()` never returns it; retrieving it requires `.unscoped()`.
 */
@DefaultScope(() => ({
  attributes: { exclude: ['mfaSecretEnc'] },
}))
@Table({
  schema: 'reward_portal',
  tableName: 'portal_users',
  underscored: true,
  timestamps: true,
  paranoid: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
})
export class PortalUser extends Model<PortalUser> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  /**
   * The login identity — **AES-256-GCM ciphertext at rest** since T-056.
   *
   * `STRING(512)`, not `STRING(200)`: the stored value is a `v1.<kid>.<iv>.<tag>.<ct>` envelope,
   * which is roughly 358 characters for a 200-character address. The 200-character *input* limit
   * still applies and lives where it belongs, on the DTO (`auth-request.dto.ts`); this width is
   * headroom for the envelope, not a longer permitted address. `T056_001` widens the column to match.
   *
   * Nothing in application code encrypts or decrypts this field by hand: `model-encryption.hooks.ts`
   * does it from the policy row, transparently, for every read and write through this model. The
   * raw-SQL authentication paths, which get no hooks, go through `PortalUserEmailCrypto` instead.
   */
  @Column({ type: DataType.STRING(512), allowNull: false })
  declare email: string;

  /**
   * `HMAC-SHA256(normalise(email), blindIndexKey)` as 64 hex characters — the only way to look a
   * user up by address once {@link email} is ciphertext, because a random IV means the same address
   * encrypts differently every time and `WHERE email = :x` can never match again.
   *
   * Maintained automatically by the encryption hooks; never assign it by hand. It also carries
   * `uq_portal_users_email_live` (T056_001 moved that index here from `lower(email)`), so this is
   * the column that enforces "one live account per address".
   *
   * Nullable in the schema rather than `NOT NULL` — see the T-056 completion report: several
   * fixtures owned by other tasks still INSERT `portal_users` rows with raw SQL and no index, and
   * tightening it is a follow-up that belongs with those fixtures, not here.
   */
  @Column({ type: DataType.STRING(64), allowNull: true, field: 'email_bidx' })
  declare emailBidx: string | null;

  @Column({ type: DataType.STRING(100), allowNull: false, field: 'display_name' })
  declare displayName: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare role: PortalRole;

  @ForeignKey(() => Country)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'country_id' })
  declare countryId: number | null;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'tenant_id' })
  declare tenantId: number | null;

  @ForeignKey(() => Merchant)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'merchant_id' })
  declare merchantId: number | null;

  /** Optional link to `reward_config.admin_users`, which is not modelled (see
   * `rule-master.model.ts` for the same note) — kept as a plain column. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'admin_user_id' })
  declare adminUserId: number | null;

  @Column({ type: DataType.STRING(60), allowNull: true, field: 'preferred_timezone' })
  declare preferredTimezone: string | null;

  @Column({
    type: DataType.STRING(10),
    allowNull: true,
    defaultValue: 'en',
    field: 'preferred_locale',
  })
  declare preferredLocale: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'pending_activation' })
  declare status: string;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'must_change_password',
  })
  declare mustChangePassword: boolean;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'mfa_enabled' })
  declare mfaEnabled: boolean;

  /** AES-256-GCM ciphertext (07-DATA-PROTECTION.md). Excluded from the default scope —
   * see the class doc comment. Never logged. */
  @Column({ type: DataType.STRING(512), allowNull: true, field: 'mfa_secret_enc' })
  declare mfaSecretEnc: string | null;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'created_by' })
  declare createdBy: number | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'last_login_at' })
  declare lastLoginAt: Date | null;

  @BelongsTo(() => Country)
  declare country: Country | null;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant | null;

  @BelongsTo(() => Merchant)
  declare merchant: Merchant | null;

  @BelongsTo(() => PortalUser, { foreignKey: 'createdBy' })
  declare creator: PortalUser | null;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;

  @DeletedAt
  @Column({ type: DataType.DATE, field: 'deleted_at' })
  declare deletedAt: Date | null;
}
