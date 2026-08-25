import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Adds `pause`/`resume` to the `tenant_admin` row of `role_entity_permissions` for the `campaign`
 * entity.
 *
 * ### Why T-047 is the task that writes this
 *
 * 03-API-CONTRACT.md §11 lists `POST /campaigns/:id/pause · /resume | tenant_admin` in the campaign
 * route table, and `campaign-state-machine.ts` (T-037) already declares both transitions. Neither
 * route was ever built: T-037's own test cases stop at `submit`, T-038's at the checker's three
 * decisions, and no task's `Files owned` names them. `T004_001`'s seed matches that — `tenant_admin`
 * holds `['view']` on `campaign` and nothing else.
 *
 * T-047 is where that gap stops being theoretical. Implementation note 13 requires the budget-breach
 * callback to call *"the **existing** campaign-pause service method (the same one `POST
 * /campaigns/:id/pause` uses), never a bespoke status write"*, and a system that can be paused by
 * the transaction runtime but not un-paused by the tenant that owns it is worse than one that has
 * neither. So this task builds the pause/resume pair through `CampaignsService`, and this migration
 * grants the role 03-API-CONTRACT.md §11 names. Disclosed as an out-of-scope gap closure in the
 * T-047 completion report.
 *
 * ### Why an UPDATE and not an INSERT
 *
 * `uq_rep_role_entity` means `('tenant_admin','campaign')` already exists; `ON CONFLICT DO NOTHING`
 * would silently change nothing and the endpoint would 403. The statement below rewrites that one
 * row's `actions` — a JSON array packed into a `varchar(500)` (01-DATABASE.md §5.1) — and is
 * idempotent because it writes the whole target array rather than appending to it.
 *
 * No other role is touched. A `maker` cannot pause a live campaign (it is not theirs to run once
 * approved) and a `checker` approves rather than operates.
 */

const ROLE = 'tenant_admin';
const ENTITY = 'campaign';

/** What `T004_001` seeded, restored by `down()`. */
const BEFORE = ['view'];

/** What §11 requires. */
const AFTER = ['view', 'pause', 'resume'];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `UPDATE reward_config.role_entity_permissions
        SET actions = :actions
      WHERE role = :role AND entity = :entity;`,
    {
      type: QueryTypes.UPDATE,
      replacements: { role: ROLE, entity: ENTITY, actions: JSON.stringify(AFTER) },
    },
  );
}

/** R7. Restores exactly what `T004_001` seeded — any hand-edit made through the Access Control
 * screen in between is overwritten, the same trade-off `T004_001` and `T042_001` already
 * document for their own `down()`. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `UPDATE reward_config.role_entity_permissions
        SET actions = :actions
      WHERE role = :role AND entity = :entity;`,
    {
      type: QueryTypes.UPDATE,
      replacements: { role: ROLE, entity: ENTITY, actions: JSON.stringify(BEFORE) },
    },
  );
}
