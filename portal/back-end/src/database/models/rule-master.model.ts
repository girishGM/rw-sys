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
import { RuleSubCategory } from './rule-sub-category.model';
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

/**
 * `reward_config.rule_master` — T-003. `tenant_id` is nullable since T-002's authorised
 * `DROP NOT NULL` (01-DATABASE.md §4, gap G6): `NULL` means a global rule owned by
 * `super_admin`, offered to countries via `rule_country_assignments` /
 * `rule_version_country_assignments` — read paths must use the shared
 * `ruleVisibilityScope(countryId)` helper (T-013+) rather than a hand-written
 * `WHERE tenant_id = :id`. `parameters` is `text` holding JSON (TC-8: malformed content
 * tolerantly returns `{}`, never throws). `created_by` references `reward_config.admin_users`,
 * which is out of this task's modelled set (Files owned §"reward_config models required")
 * — kept as a plain integer column, no association.
 */
@Table({
  schema: 'reward_config',
  tableName: 'rule_master',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RuleMaster extends Model<RuleMaster> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'tenant_id' })
  declare tenantId: number | null;

  @ForeignKey(() => RuleSubCategory)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'sub_category_id' })
  declare subCategoryId: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'rule_code' })
  declare ruleCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare expression: string | null;

  @Column(DataType.TEXT)
  get parameters(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('parameters'), {});
  }
  set parameters(value: Record<string, unknown>) {
    this.setDataValue(
      'parameters',
      stringifyJsonColumn(value) as unknown as Record<string, unknown>,
    );
  }

  /** References `reward_config.admin_users`, not modelled — see file doc comment. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'created_by' })
  declare createdBy: number | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant | null;

  @BelongsTo(() => RuleSubCategory)
  declare subCategory: RuleSubCategory;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
