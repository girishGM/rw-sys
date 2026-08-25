import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  DeletedAt,
  ForeignKey,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Tenant } from './tenant.model';
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

/**
 * `reward_config.tenant_campaigns` — T-003. `paranoid: true` (`deleted_at` exists).
 * `metadata` is `text` holding JSON. `budget_amount`/`budget_currency` are the legacy
 * budget pair `src/common/caps/legacy-budget-sync.ts` (T-006) dual-writes alongside
 * `campaign_caps` — **do not** stop reading/writing them; other services still read these
 * two columns directly (T-006 Implementation notes §4). `definition_pinned_at` is T-005's
 * additive column (G9/G10) marking when a campaign's rule/reward versions were pinned for
 * its lifetime. `created_by`/`approved_by` are `varchar(100)` actor references (gap G5,
 * `ActorRef`), not FKs to `admin_users` — kept as plain string columns.
 */
@Table({
  schema: 'reward_config',
  tableName: 'tenant_campaigns',
  underscored: true,
  timestamps: true,
  paranoid: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
})
export class TenantCampaign extends Model<TenantCampaign> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'campaign_code' })
  declare campaignCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.STRING(50), allowNull: true })
  declare region: string | null;

  @Column({ type: DataType.DATE, allowNull: false, field: 'start_date' })
  declare startDate: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'end_date' })
  declare endDate: Date;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'draft' })
  declare status: string;

  @Column(DataType.TEXT)
  get metadata(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('metadata'), {});
  }
  set metadata(value: Record<string, unknown>) {
    this.setDataValue('metadata', stringifyJsonColumn(value) as unknown as Record<string, unknown>);
  }

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'max_participants' })
  declare maxParticipants: number | null;

  /** `decimal(18,2)` — legacy budget pair; see file doc comment. Never coerce to number. */
  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'budget_amount' })
  declare budgetAmount: string | null;

  @Column({ type: DataType.CHAR(3), allowNull: true, field: 'budget_currency' })
  declare budgetCurrency: string | null;

  @Column({ type: DataType.STRING(100), allowNull: false, field: 'created_by' })
  declare createdBy: string;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'approved_by' })
  declare approvedBy: string | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'approved_at' })
  declare approvedAt: Date | null;

  /** T-005 additive column (G9/G10) — see file doc comment. */
  @Column({ type: DataType.DATE, allowNull: true, field: 'definition_pinned_at' })
  declare definitionPinnedAt: Date | null;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

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
