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
import { RewardCategory } from './reward-category.model';

/**
 * `reward_config.reward_sub_categories` — T-116. Field-for-field mirror of
 * `rule-sub-category.model.ts` (T-003). See `reward-category.model.ts`'s own header for why a
 * brand-new table still mirrors the legacy shape.
 */
@Table({
  schema: 'reward_config',
  tableName: 'reward_sub_categories',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RewardSubCategory extends Model<RewardSubCategory> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => RewardCategory)
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

  @BelongsTo(() => RewardCategory)
  declare category: RewardCategory;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
