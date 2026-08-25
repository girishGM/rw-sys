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
import { Country } from './country.model';

/**
 * `reward_config.tenants` — T-003. `paranoid: true`: `deleted_at` genuinely exists on this
 * table (01-DATABASE.md §6 implementation note 2). Read/write for `reward_app`.
 * See `country.model.ts` for why only the `@BelongsTo` side of each FK is declared.
 */
@Table({
  schema: 'reward_config',
  tableName: 'tenants',
  underscored: true,
  timestamps: true,
  paranoid: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
})
export class Tenant extends Model<Tenant> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare code: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  @ForeignKey(() => Country)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'country_id' })
  declare countryId: number;

  @Column({ type: DataType.STRING(10), allowNull: true, field: 'schema_prefix' })
  declare schemaPrefix: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true, field: 'contact_email' })
  declare contactEmail: string | null;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'contact_phone' })
  declare contactPhone: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'pending_provisioning' })
  declare status: string;

  @BelongsTo(() => Country)
  declare country: Country;

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
