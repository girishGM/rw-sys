import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_app` least-privilege grants for the 9 `reward_config` tables created by `T005`
 * (versioning/blast/definition-request schema) and `T006` (campaign caps and tenant budget
 * ceilings) — see `T002_008_grants.ts`'s own header for why `reward_config` gets no
 * `ALTER DEFAULT PRIVILEGES` the way `reward_portal` does (deliberate, least-privilege):
 * every `reward_config` table needs an explicit `GRANT` or `reward_app` can neither read
 * nor write it, ever.
 *
 * **Why this is its own migration rather than an edit to `T005_00x`/`T006_00x`.** Those
 * files are owned by tasks that are already `done` and shipped (`05-EXECUTION-PLAN.md §3`,
 * R9) — this task's own "Files owned" list deliberately does not include them. It would also
 * not have worked even with permission to edit them: on every environment that has already
 * run past those migrations (every environment that exists, including the one this defect
 * was found on), Umzug never re-executes an already-applied migration's `up()` — editing it
 * changes nothing already-migrated ever sees. A brand new, later-numbered migration is the
 * only change that actually reaches an already-migrated database via an ordinary forward
 * `db:migrate`, which is why `T002_008_grants.ts`/`T007_002_tracker_group_defs.ts` (this same
 * task, but genuinely owned/still-effective files, see their own headers) were fixed in
 * place while these 9 tables' grants live here instead.
 *
 * Placed after `T056` (the last migration at the time this was written) so every one of
 * these tables already exists by the time this runs — required, since `T005`/`T006` run
 * long before this in the chain and `GRANT` on a nonexistent table simply fails.
 *
 * Grants `SELECT, INSERT, UPDATE` — the minimum this fix needs, and what every genuinely
 * clean install (this task's own scratch-DB proof; a fresh docker-compose stack, which is
 * where this defect was actually reported from) ends up with. No explicit `REVOKE DELETE`
 * here, deliberately: on *this project's own shared local dev database* specifically,
 * `reward_config` already carries a pre-existing, out-of-project `ALTER DEFAULT PRIVILEGES`
 * (confirmed live via `pg_default_acl`, predates this project) that hands `reward_app`
 * `DELETE` on every new table here automatically — `campaign_caps`/`tenant_budget_ceilings`
 * included, and `T006_001_campaign_caps.ts`'s own test already investigated and pinned that
 * exact fact as accepted, relied-upon behaviour (its `afterAll` cleanup uses `reward_app`'s
 * `DELETE` directly). Explicitly revoking it here would silently contradict that established
 * precedent on this database while changing nothing on a docker-compose/CI install that
 * never had it to begin with. Flagged as a genuine, pre-existing conflict between
 * `01-DATABASE.md §3` ("DELETE is granted nowhere") and this real database's actual ACL in
 * the T-091 completion report, for the architect to resolve. Immutability of published
 * version rows is enforced independently by the `T005_007` triggers regardless, not by
 * withholding `UPDATE`/`DELETE` at the grant level — plenty of legitimate `UPDATE`s happen
 * pre-publish (drafts) and post-publish on the non-frozen columns (`deprecated_at`,
 * `retired_at`, status transitions), so the grant has to allow `UPDATE` either way.
 */
const APP_ROLE = 'reward_app';

const TABLES = [
  'reward_config.rule_versions',
  'reward_config.reward_versions',
  'reward_config.rule_version_country_assignments',
  'reward_config.reward_version_country_assignments',
  'reward_config.version_blasts',
  'reward_config.version_blast_targets',
  'reward_config.definition_requests',
  'reward_config.campaign_caps',
  'reward_config.tenant_budget_ceilings',
] as const;

export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`GRANT SELECT, INSERT, UPDATE ON ${TABLES.join(', ')} TO ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`REVOKE SELECT, INSERT, UPDATE ON ${TABLES.join(', ')} FROM ${APP_ROLE};`, {
    type: QueryTypes.RAW,
  });
}
