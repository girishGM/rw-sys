import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { Tenant } from './tenant.model';
import { TenantCampaign } from './tenant-campaign.model';
import { ApprovalRequest } from './approval-request.model';
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

/**
 * `reward_config.campaign_audit_trail` — T-003. **Append-only**: `reward_app` has
 * `SELECT, INSERT` only (01-DATABASE.md §3) — never call `.update()`/`.destroy()` on this
 * model; there is no scope-enforced way to do so through `ScopedRepository` (T-013) either.
 * No `created_at`/`updated_at` on this table (`performed_at` only) — `timestamps: false`.
 * `field_changes` is `text` holding JSON. `performed_by`/`approved_by` reference the
 * un-modelled `admin_users` — plain columns. See "Division of audit responsibility"
 * (01-DATABASE.md §2.5): domain/campaign events live here, auth/access events live in
 * `reward_portal.portal_audit_log` — do not duplicate one into the other.
 */
@Table({
  schema: 'reward_config',
  tableName: 'campaign_audit_trail',
  underscored: true,
  timestamps: false,
})
export class CampaignAuditTrail extends Model<CampaignAuditTrail> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @ForeignKey(() => TenantCampaign)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'campaign_id' })
  declare campaignId: number;

  @Column({ type: DataType.STRING(40), allowNull: false, field: 'entity_type' })
  declare entityType: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'entity_id' })
  declare entityId: number | null;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare action: string;

  @Column(DataType.TEXT)
  get fieldChanges(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('fieldChanges'), {});
  }
  set fieldChanges(value: Record<string, unknown>) {
    this.setDataValue(
      'fieldChanges',
      stringifyJsonColumn(value) as unknown as Record<string, unknown>,
    );
  }

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'performed_by' })
  declare performedBy: number;

  @Column({ type: DataType.DATE, allowNull: false, field: 'performed_at' })
  declare performedAt: Date;

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'approved_by' })
  declare approvedBy: number | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'approved_at' })
  declare approvedAt: Date | null;

  @ForeignKey(() => ApprovalRequest)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'approval_request_id' })
  declare approvalRequestId: number | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare comment: string | null;

  @Column({ type: DataType.DATE, allowNull: false, field: 'retention_expires_at' })
  declare retentionExpiresAt: Date;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => TenantCampaign)
  declare campaign: TenantCampaign;

  @BelongsTo(() => ApprovalRequest)
  declare approvalRequest: ApprovalRequest | null;
}
