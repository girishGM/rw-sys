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

/** `reward_config.merchants` — T-003. `paranoid: true` (`deleted_at` exists). */
@Table({
  schema: 'reward_config',
  tableName: 'merchants',
  underscored: true,
  timestamps: true,
  paranoid: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
})
export class Merchant extends Model<Merchant> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'merchant_code' })
  declare merchantCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true, field: 'contact_email' })
  declare contactEmail: string | null;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'contact_phone' })
  declare contactPhone: string | null;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare website: string | null;

  @Column({ type: DataType.CHAR(2), allowNull: false, field: 'country_code' })
  declare countryCode: string;

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

  @DeletedAt
  @Column({ type: DataType.DATE, field: 'deleted_at' })
  declare deletedAt: Date | null;
}
