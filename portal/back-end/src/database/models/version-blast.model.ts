import { Column, DataType, Model, Table } from 'sequelize-typescript';

export type BlastEntityType = 'rule' | 'reward';
export type BlastScope = 'all_countries' | 'selected';

/**
 * `reward_config.version_blasts` (T005_004) — added to T-003's modelled set beyond the task
 * file's own fixed list, per 05-EXECUTION-PLAN.md §1. One table serves both rules and
 * rewards (`entity_type`) rather than a mirrored pair — see T005_004's own migration comment.
 *
 * `entity_id`, `version_id` and `origin_request_id` are deliberately **not** FKs — `version_id`
 * resolves to either `rule_versions.id` or `reward_versions.id` depending on `entity_type`,
 * and Postgres has no polymorphic FK; same reasoning for `origin_request_id` pointing at
 * `definition_requests`. No `created_at`/`updated_at` (`blasted_at`/`blasted_by` only) —
 * `timestamps: false`. `blasted_by` references the un-modelled `admin_users`.
 *
 * No `@HasMany` to `VersionBlastTarget` — this model set declares only the `@BelongsTo` side
 * throughout (see `country.model.ts`'s own doc comment); reverse traversal is a query through
 * the future `ScopedRepository` (T-013), not an association here.
 */
@Table({
  schema: 'reward_config',
  tableName: 'version_blasts',
  underscored: true,
  timestamps: false,
})
export class VersionBlast extends Model<VersionBlast> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(10), allowNull: false, field: 'entity_type' })
  declare entityType: BlastEntityType;

  /** No FK constraint — polymorphic, resolves via `entityType`. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'entity_id' })
  declare entityId: number;

  /** No FK constraint — polymorphic, resolves via `entityType`. See file doc comment. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'version_id' })
  declare versionId: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'version_no' })
  declare versionNo: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare scope: BlastScope;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'target_count' })
  declare targetCount: number;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare note: string | null;

  /** References `definition_requests`, no FK — see file doc comment. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'origin_request_id' })
  declare originRequestId: number | null;

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'blasted_by' })
  declare blastedBy: number;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'blasted_at',
  })
  declare blastedAt: Date;
}
