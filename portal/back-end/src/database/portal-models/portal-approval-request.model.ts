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
import { PortalUser } from './portal-user.model';

/**
 * `reward_portal.portal_approval_requests` (T037_001) — the portal-side replacement for
 * `reward_config.approval_requests`, whose `requested_by`/`reviewed_by` foreign keys point at
 * `admin_users` and therefore cannot hold a `maker` or `checker`. See the migration's own header
 * for the full evidence chain and for why this is the fourth application of an already-accepted
 * pattern rather than a new design decision.
 *
 * `payload` is `jsonb` here (the legacy column is `text`), so it is declared as a plain typed
 * column rather than through `json-text.util`'s tolerant getter/setter: the database itself
 * guarantees the value parses, which is exactly the guarantee the `text` version could not give
 * and which T-038's diff view (its own TC-20) would otherwise have to defend against.
 *
 * No `Tenant` association is declared even though `tenant_id` carries a real cross-schema FK:
 * `reward_config.tenants` is a `reward_config` model, and a `@BelongsTo` across the two barrels
 * would make `portal-models/index.ts` depend on `models/index.ts` — a cycle the drift check and
 * `sequelize.provider.ts` both do without. The column is plain; joins go through explicit
 * `where` clauses instead.
 */
@Table({
  schema: 'reward_portal',
  tableName: 'portal_approval_requests',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class PortalApprovalRequest extends Model<PortalApprovalRequest> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'entity_type' })
  declare entityType: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'entity_id' })
  declare entityId: number | null;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare action: string;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'pending' })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare payload: Record<string, unknown> | null;

  /** A **`reward_portal.portal_users.id`** — the whole point of this table. */
  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'requested_by' })
  declare requestedBy: number;

  @Column({ type: DataType.DATE, allowNull: false, field: 'requested_at' })
  declare requestedAt: Date;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'reviewed_by' })
  declare reviewedBy: number | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'reviewed_at' })
  declare reviewedAt: Date | null;

  @Column({ type: DataType.STRING(500), allowNull: true, field: 'review_comment' })
  declare reviewComment: string | null;

  @Column({ type: DataType.DATE, allowNull: false, field: 'expires_at' })
  declare expiresAt: Date;

  @BelongsTo(() => PortalUser, { foreignKey: 'requestedBy', as: 'requester' })
  declare requester: PortalUser;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
