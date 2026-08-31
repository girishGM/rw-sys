import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';

/**
 * `reward_config.field_api_lookup_providers` — T-121. A value source that calls a pre-registered
 * HTTP endpoint to populate a field's dropdown. See `13-REWARD-MASTER-VALUE-SOURCES.md` §3.
 *
 * Nothing in T-121 calls one of these; T-123 owns the runtime lookup. Every row seeded today is
 * `status: 'planned'` — its real endpoint, auth and response keys are unconfirmed.
 *
 * ### `authConfigEnc` is ciphertext, and this model deliberately gives it no typed accessor
 *
 * The column holds an AES-256-GCM envelope produced by `FieldApiLookupConfigCrypto`, AAD-bound to
 * this row's `id`. It is declared here as the raw `string | null` it physically is, with no
 * getter/setter that would make it look like a plain object — the *only* supported way to read or
 * write it is through that helper, which is what binds the AAD. A convenience accessor here would
 * be an invitation to bypass it. Note also that `FieldApiLookupProviderDto` never carries this
 * field at all, so it cannot leave the process through a response body by accident.
 */
@Table({
  schema: 'reward_config',
  tableName: 'field_api_lookup_providers',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class FieldApiLookupProvider extends Model<FieldApiLookupProvider> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'provider_code' })
  declare providerCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.STRING(500), allowNull: false, field: 'endpoint_url' })
  declare endpointUrl: string;

  @Column({
    type: DataType.STRING(10),
    allowNull: false,
    field: 'http_method',
    defaultValue: 'GET',
  })
  declare httpMethod: string;

  @Column({ type: DataType.STRING(30), allowNull: false, field: 'auth_type', defaultValue: 'none' })
  declare authType: string;

  /** Ciphertext only — see the class header. Never serialised into a response DTO. */
  @Column({ type: DataType.TEXT, allowNull: true, field: 'auth_config_enc' })
  declare authConfigEnc: string | null;

  @Column({ type: DataType.STRING(100), allowNull: false, field: 'response_value_key' })
  declare responseValueKey: string;

  @Column({ type: DataType.STRING(100), allowNull: false, field: 'response_label_key' })
  declare responseLabelKey: string;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'planned' })
  declare status: string;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
