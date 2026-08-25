import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { PortalUser } from './portal-user.model';
import { PortalApprovalRequest } from './portal-approval-request.model';

/**
 * `reward_portal.portal_campaign_audit_trail` (T037_002) — the portal-side replacement for
 * `reward_config.campaign_audit_trail`, whose `performed_by` foreign key points at `admin_users`
 * and therefore cannot hold a `maker` or `checker`. See the migration's own header for the full
 * evidence chain, and `audit.service.ts#recordDomainEvent` for the gap T-014 raised and left open.
 *
 * ### `timestamps: false` and no `updated_at`
 *
 * Mirrors the original: an audit row has `performed_at` and nothing else. There is no
 * `updated_at` **because there is no update** — `reward_app` holds `SELECT, INSERT` only on this
 * table (T037_002 revokes the rest), so an `UPDATE` fails at the privilege level rather than at
 * a convention. `performed_at` is written by the database default and is not a Sequelize
 * `@CreatedAt` field, so nothing in application code can backdate it either.
 */
@Table({
  schema: 'reward_portal',
  tableName: 'portal_campaign_audit_trail',
  underscored: true,
  timestamps: false,
})
export class PortalCampaignAuditTrail extends Model<PortalCampaignAuditTrail> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'campaign_id' })
  declare campaignId: number;

  /** `ck_pcat_entity_type` — the original's vocabulary, restated. */
  @Column({ type: DataType.STRING(40), allowNull: false, field: 'entity_type' })
  declare entityType: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'entity_id' })
  declare entityId: number | null;

  /** `ck_pcat_action`. */
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare action: string;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'field_changes' })
  declare fieldChanges: Record<string, unknown> | null;

  /** A **`reward_portal.portal_users.id`** — the whole point of this table. */
  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'performed_by' })
  declare performedBy: number;

  @Column({ type: DataType.DATE, allowNull: false, field: 'performed_at' })
  declare performedAt: Date;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'approved_by' })
  declare approvedBy: number | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'approved_at' })
  declare approvedAt: Date | null;

  @ForeignKey(() => PortalApprovalRequest)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'approval_request_id' })
  declare approvalRequestId: number | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare comment: string | null;

  /**
   * `allowNull: true` **here only** — the column itself is `NOT NULL DEFAULT now() + interval
   * '7 years'` (T037_002) and stays that way.
   *
   * Sequelize runs its own `notNull Violation` check *before* the INSERT and does not know the
   * database has a default, so declaring this `allowNull: false` makes every audit write fail
   * with `PortalCampaignAuditTrail.retentionExpiresAt cannot be null` unless application code
   * supplies a value. Supplying one would move the seven-year retention policy
   * (08-OBSERVABILITY.md §7) out of the schema and into a caller that could quietly shorten it —
   * exactly the wrong place for it. Relaxing the *model*'s validator lets Sequelize omit the
   * column so the database's own default applies, with the `NOT NULL` constraint still the thing
   * that guarantees it is never actually null.
   *
   * Found by `campaigns.e2e-spec.ts`, which had every audit row silently skipped until this was
   * corrected — the audit service's own "never fail the request" wrapper had been swallowing it.
   */
  @Column({ type: DataType.DATE, allowNull: true, field: 'retention_expires_at' })
  declare retentionExpiresAt: Date;

  @BelongsTo(() => PortalUser, { foreignKey: 'performedBy', as: 'performer' })
  declare performer: PortalUser;
}
