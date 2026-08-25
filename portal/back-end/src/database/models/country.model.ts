import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';

/**
 * `reward_config.countries` — T-003. Read/write for `reward_app` per 01-DATABASE.md §3.
 * Root of the country → tenant → merchant hierarchy (00-ARCHITECTURE.md §5.1); `portal_users`
 * (cross-schema) anchors `country_admin` scope to a row here.
 *
 * Associations: only `@BelongsTo`-side decorators are declared throughout this model set
 * (T-003 implementation note 7 — "mirror the FKs"); a country is never itself the FK-owning
 * side of a modelled relationship, so this model declares none. Reverse traversal
 * (country → its tenants, etc.) is a query (`Tenant.findAll({ where: { countryId } })`)
 * through the future `ScopedRepository` (T-013), not a `HasMany` here — keeping the
 * association graph one-directional avoids a combinatorial fan-out of `HasMany` across
 * every one of the ~30 models in this task for no test case that needs it.
 */
@Table({
  schema: 'reward_config',
  tableName: 'countries',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class Country extends Model<Country> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.CHAR(2), allowNull: false })
  declare code: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(50), allowNull: false })
  declare timezone: string;

  @Column({ type: DataType.CHAR(3), allowNull: false, field: 'currency_code' })
  declare currencyCode: string;

  @Column({ type: DataType.STRING(5), allowNull: false, field: 'dialing_code' })
  declare dialingCode: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_hq' })
  declare isHq: boolean;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
