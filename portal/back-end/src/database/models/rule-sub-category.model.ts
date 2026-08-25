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
import { RuleCategory } from './rule-category.model';

/** `reward_config.rule_sub_categories` — T-003. */
@Table({
  schema: 'reward_config',
  tableName: 'rule_sub_categories',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RuleSubCategory extends Model<RuleSubCategory> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => RuleCategory)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'category_id' })
  declare categoryId: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'sub_category_code' })
  declare subCategoryCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => RuleCategory)
  declare category: RuleCategory;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
