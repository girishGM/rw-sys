import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';

export type RequestType = 'new_rule' | 'update_rule' | 'new_reward' | 'update_reward';
export type RequestStatus =
  'submitted' | 'under_review' | 'approved' | 'rejected' | 'fulfilled' | 'withdrawn';
export type RequestPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * `reward_config.definition_requests` (T005_005) — the "please build me a rule/reward"
 * workflow (G12); added to T-003's modelled set beyond the task file's own fixed list, per
 * 05-EXECUTION-PLAN.md §1.
 *
 * **No FK constraints at all** in the live DDL: `entity_id` is polymorphic (set only for
 * `update_rule`/`update_reward`, resolving to `rule_master.id`/`reward_systems.id`);
 * `requesting_country_id`/`requesting_tenant_id` and `fulfilled_version_id` (resolving to
 * either `rule_versions.id` or `reward_versions.id`) likewise carry no `references` clause in
 * `T005_005`'s own DDL — kept as plain columns, no associations, per implementation note 7.
 * `requested_by`/`reviewed_by` reference the un-modelled `admin_users`.
 */
@Table({
  schema: 'reward_config',
  tableName: 'definition_requests',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class DefinitionRequest extends Model<DefinitionRequest> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(20), allowNull: false, field: 'request_type' })
  declare requestType: RequestType;

  /** No FK constraint — polymorphic, resolves via `requestType`. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'entity_id' })
  declare entityId: number | null;

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'requested_by' })
  declare requestedBy: number;

  /** No FK constraint in the live DDL — see file doc comment. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'requesting_country_id' })
  declare requestingCountryId: number | null;

  /** No FK constraint in the live DDL — see file doc comment. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'requesting_tenant_id' })
  declare requestingTenantId: number | null;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare description: string;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'business_justification' })
  declare businessJustification: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true, field: 'desired_by' })
  declare desiredBy: string | null;

  @Column({ type: DataType.STRING(10), allowNull: false, defaultValue: 'normal' })
  declare priority: RequestPriority;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'submitted' })
  declare status: RequestStatus;

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'reviewed_by' })
  declare reviewedBy: number | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'reviewed_at' })
  declare reviewedAt: Date | null;

  @Column({ type: DataType.STRING(1000), allowNull: true, field: 'review_comment' })
  declare reviewComment: string | null;

  /** No FK constraint — polymorphic, resolves via `requestType`. See file doc comment. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'fulfilled_version_id' })
  declare fulfilledVersionId: number | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'fulfilled_at' })
  declare fulfilledAt: Date | null;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
