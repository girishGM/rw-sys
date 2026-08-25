import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { PortalUser } from './portal-user.model';

/**
 * `reward_portal.portal_audit_log` — T-003 (01-DATABASE.md §2.5). **Append-only**:
 * `reward_app` has `SELECT, INSERT` only, `UPDATE`/`DELETE` explicitly revoked
 * (01-DATABASE.md §3) — never call `.update()`/`.destroy()` on this model. `detail` is
 * genuine `jsonb` (implementation note 3's stated exception) and must never contain
 * passwords or tokens (redacted before insert, by the writer, not by this model). No
 * `created_at`/`updated_at` (`occurred_at` instead) — `timestamps: false`. Authentication
 * and access-control events only; domain/campaign events go to
 * `reward_config.campaign_audit_trail` — see that model's own doc comment.
 */
@Table({
  schema: 'reward_portal',
  tableName: 'portal_audit_log',
  underscored: true,
  timestamps: false,
})
export class PortalAuditLog extends Model<PortalAuditLog> {
  @Column({ type: DataType.BIGINT, autoIncrement: true, primaryKey: true })
  declare id: string;

  @Column({ type: DataType.STRING(60), allowNull: false, field: 'event_type' })
  declare eventType: string;

  @ForeignKey(() => PortalUser)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'actor_id' })
  declare actorId: number | null;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'actor_role' })
  declare actorRole: string | null;

  @Column({ type: DataType.STRING(60), allowNull: true, field: 'target_type' })
  declare targetType: string | null;

  @Column({ type: DataType.STRING(60), allowNull: true, field: 'target_id' })
  declare targetId: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'country_id' })
  declare countryId: number | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'tenant_id' })
  declare tenantId: number | null;

  @Column({ type: DataType.INET, allowNull: true, field: 'ip_address' })
  declare ipAddress: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare detail: Record<string, unknown> | null;

  @Column({ type: DataType.DATE, allowNull: false, field: 'occurred_at' })
  declare occurredAt: Date;

  /**
   * T-019's `T019_001_audit_correlation_id.ts` (08-OBSERVABILITY.md §2/§6). Added here — a T-045
   * addition to this otherwise T-003-owned file, not a T-019 one — because the column existed in
   * the database without a matching model attribute: T-019's own migration comment names
   * `GET /audit/trace/:correlationId` as "the key T-045 joins on", but attribute declaration was
   * out of that migration-only task's scope. `varchar(64)` and nullable, exactly as the column is
   * — see that migration for why (rows written outside a request context carry `NULL`).
   */
  @Column({ type: DataType.STRING(64), allowNull: true, field: 'correlation_id' })
  declare correlationId: string | null;

  @BelongsTo(() => PortalUser)
  declare actor: PortalUser | null;
}
