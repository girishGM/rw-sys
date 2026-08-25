import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  Model,
  Table,
} from 'sequelize-typescript';
import { Tracker } from './tracker.model';
import { TrackerComponent } from './tracker-component.model';

/**
 * `reward_config.tracker_tracker_components` — **added by T-037** (see
 * `tracker-component.model.ts`'s header for why these six models are this task's to add).
 *
 * The **single authoritative** tracker↔component link, per 12-CAMPAIGN-STRUCTURE.md §1.3.
 * `tracker_component_groups` is the competing table that decision rejected; it is left in place,
 * untouched and unused by the portal, and is deliberately **not** modelled here — modelling it
 * would invite exactly the "two sources of truth that can silently disagree" §1.1 warns about.
 *
 * ### `timestamps: false`, and why that is not an oversight
 *
 * The live table has `created_at` and **no `updated_at`** (confirmed against
 * `information_schema.columns`, not assumed from the extracted DDL). Sequelize's default
 * `timestamps: true` would add `updated_at` to every INSERT and UPDATE and fail on a column that
 * does not exist, so timestamps are off and `created_at` is declared explicitly with `@CreatedAt`.
 *
 * ### `group_code` is written `NULL` and never read
 *
 * T007_001 added the column for the two-level completion design 12-CAMPAIGN-STRUCTURE.md §1.4
 * sketches. §1.5 is explicit that v1 does **not** build it: *"The column is added now and left
 * unused … Wizard writes `group_code = NULL` throughout"* (T-037 implementation note 7c). It is
 * modelled so the drift check covers it and so a future task has a typed field to reach for —
 * not so this task can populate it.
 */
@Table({
  schema: 'reward_config',
  tableName: 'tracker_tracker_components',
  underscored: true,
  timestamps: false,
})
export class TrackerTrackerComponent extends Model<TrackerTrackerComponent> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tracker)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tracker_id' })
  declare trackerId: number;

  @ForeignKey(() => TrackerComponent)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'component_id' })
  declare componentId: number;

  /** Display and intent order — **not an enforced gate** in v1 (implementation note 6).
   * Completing component 3 before component 1 is permitted; the runtime is not told otherwise. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1, field: 'sequence_order' })
  declare sequenceOrder: number;

  /** Overrides `n_of` (implementation note 5): a mandatory component is always required, even
   * when the tracker's threshold could otherwise be met without it. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_mandatory' })
  declare isMandatory: boolean;

  /** T007_001. Always `NULL` from the portal — see this file's header. */
  @Column({ type: DataType.STRING(10), allowNull: true, field: 'group_code' })
  declare groupCode: string | null;

  @BelongsTo(() => Tracker)
  declare tracker: Tracker;

  @BelongsTo(() => TrackerComponent)
  declare component: TrackerComponent;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;
}
