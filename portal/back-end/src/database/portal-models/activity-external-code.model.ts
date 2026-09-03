import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';

/**
 * `reward_portal.activity_external_codes` — T-171. The external/transaction-type codes one
 * `reward_config.activities` row is also known by outside this portal; served on
 * `campaign_config.v1.proto`'s `Activity.external_codes` so
 * `realtime-activity-processing-service` can resolve an inbound `transactionType` to an
 * `activity_code`. See `T171_001_activity_external_codes.ts` for the full rationale.
 *
 * ### Why this lives in `portal-models/` and not `models/`
 *
 * T-171's "Files owned" names `src/database/models/activity-external-code.model.ts`, but that
 * barrel is, by its own doc comment, *"every `reward_config`-schema Sequelize model"*, and this
 * table is in `reward_portal` — deliberately so (AGENT-PROTOCOL R1 forbids new `reward_config`
 * DDL, which is the whole reason the table is where it is). `portal-models/` is the barrel for
 * `reward_portal`, and both feed the same connection through `sequelize.provider.ts`. Filing a
 * `reward_portal` table under the `reward_config` barrel would make the two barrels stop meaning
 * anything. Flagged in the T-171 completion report.
 *
 * `tenant_id` and `activity_id` reference `reward_config.tenants(id)` / `activities(id)` **by
 * value** — no cross-schema foreign key, so no `@ForeignKey`/`@BelongsTo` here.
 */
@Table({
  schema: 'reward_portal',
  tableName: 'activity_external_codes',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class ActivityExternalCode extends Model<ActivityExternalCode> {
  @Column({ type: DataType.UUID, primaryKey: true, defaultValue: DataType.UUIDV4 })
  declare id: string;

  /** `reward_config.tenants(id)` by value. The tenancy predicate binds to this column. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  /** `reward_config.activities(id)` by value. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'activity_id' })
  declare activityId: number;

  /** The `transactionType` value an external caller sends. Unique per tenant
   * (`uc_activity_external_codes`), not globally — see the migration header. */
  @Column({ type: DataType.STRING(50), allowNull: false, field: 'external_code' })
  declare externalCode: string;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
