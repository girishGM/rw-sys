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
import { Tenant } from './tenant.model';

/**
 * `reward_config.reward_categories` — T-116. Field-for-field mirror of `rule-category.model.ts`
 * (T-003) — a brand-new table (T116_001), not part of the legacy `reward_config` import, built
 * to the same shape anyway so the two-level category/sub-category concept works identically for
 * Rules and Rewards (this task's own header). `tenant_id` is carried for the same reason
 * `RuleCategory`'s own carries it and is just as inert here: `scope-strategy.ts` declares this
 * model `unrestricted()` for every role, so it is never used to filter a read.
 */
@Table({
  schema: 'reward_config',
  tableName: 'reward_categories',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RewardCategory extends Model<RewardCategory> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'category_code' })
  declare categoryCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
