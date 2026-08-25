import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Widens `reward_portal.portal_audit_log.actor_role` from `varchar(20)` to `varchar(40)`.
 *
 * ### Why T-047 needs this
 *
 * 09-INTEGRATION.md §7a fixes the shape of the budget-breach audit row verbatim:
 *
 * > `portal_audit_log` `event_type: budget_breach_paused`, **`actor_role:
 * > 'system:transaction-runtime'`**, with `capId` and `observedTotal` in `detail`. A human reading
 * > the audit trail must be able to tell a breach-triggered pause from a tenant_admin one.
 *
 * `'system:transaction-runtime'` is 26 characters. `T002_006` sized the column at `varchar(20)`,
 * which comfortably fits every *portal role* (`super_admin`, `tenant_admin`, `country_admin`,
 * `maker`, `checker`) — the only actors that existed when 01-DATABASE.md §2.5 was written — and
 * nothing else. The insert therefore failed with *"value too long for type character varying(20)"*,
 * and because `AuditService.recordPortalEvent` deliberately **never rejects** (T-014: an audit
 * failure must not fail the request it is describing), the pause succeeded and the audit row simply
 * did not appear. That is the worst of both worlds for a segregation-of-duty record, and it is
 * exactly what T-047 TC-37 exists to catch.
 *
 * Two fixes were possible: shorten the string, or widen the column. **The design doc wins**
 * (AGENT-PROTOCOL §3) — §7a names the literal, TC-37 asserts it, and the runtime team's operators
 * will grep for it. Truncating a *system actor's identity* to make it fit a column sized for
 * human roles would also set the precedent that the audit trail is allowed to be approximate.
 *
 * ### Why this is safe, and why it is a widening rather than a rewrite
 *
 * `portal_audit_log` is a `reward_portal` table (R1 governs `reward_config`, not this schema), it
 * carries no CHECK constraint or index on `actor_role`, and `varchar(20) → varchar(40)` is a
 * metadata-only change in Postgres: no table rewrite, no lock beyond `ACCESS EXCLUSIVE` for the
 * catalogue update, no existing value affected. 40 leaves room for the `system:<service>` shape to
 * grow without another migration.
 *
 * ### The `down()` is lossy, and says so
 *
 * Narrowing a column can only succeed if every stored value fits, so `down()` re-types with an
 * explicit `USING left(actor_role, 20)`. Rolling this migration back on a database that has
 * recorded breach-triggered pauses will therefore shorten those rows' `actor_role` to
 * `system:transaction-r`. That is stated rather than hidden: it is inherent to reversing a
 * widening, and R7 asks for a `down()` that works, not one that can undo physics.
 */
const TABLE = 'reward_portal.portal_audit_log';

export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`ALTER TABLE ${TABLE} ALTER COLUMN actor_role TYPE varchar(40);`, {
    type: QueryTypes.RAW,
  });
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE ${TABLE}
       ALTER COLUMN actor_role TYPE varchar(20) USING left(actor_role, 20);`,
    { type: QueryTypes.RAW },
  );
}
