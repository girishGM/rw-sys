import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.grpc_service_grants` — 09-INTEGRATION.md §4c, the table that decides **which
 * service identity may read which sections for which tenants** over the gRPC configuration port.
 *
 * ### Why `tenant_key` exists and must not be "simplified away"
 *
 * T-047 implementation note 12 / architect review AR-02 (revised 2026-08-14 once Postgres was
 * confirmed as the production target — `CAPABILITY-COMPARISON.md` CC-00):
 *
 * > `tenant_id IS NULL` means "every tenant," and without the generated column, two rows granting
 * > the same service identity a global grant would **not** collide, since Postgres treats every
 * > NULL as distinct by default.
 *
 * So `uq_gsg` keys on `(service_identity, tenant_key)` where `tenant_key` is
 * `coalesce(tenant_id, -1)`. Two global grants for one identity then violate the constraint
 * (TC-36), which matters because two rows can disagree about `allowed_sections` and the resolver
 * would have to pick one — silently widening or narrowing an authorisation boundary depending on
 * row order. `-1` is safe as the sentinel because `tenants.id` is `generated always as identity`
 * and therefore always positive.
 *
 * This is the same portable pattern as `campaign_caps.dedupe_key` (T006_001), and was chosen over
 * Postgres 15's `NULLS NOT DISTINCT` for the same two reasons: it needs no minimum server version
 * and it disturbs no existing NULL semantics.
 *
 * ### `allowed_sections` is `jsonb`, not `varchar` (AR-13)
 *
 * There is no legacy-schema constraint forcing the varchar-holding-JSON convention on a brand-new
 * `reward_portal` table, and `jsonb` gives real structural validation. `ck_gsg_sections` asserts
 * it is an array; the *contents* are validated in application code against the `ConfigSection`
 * enum, because a CHECK constraint listing enum values would have to be re-migrated every time
 * the proto gains a section, and a stale constraint on an authorisation table fails closed in the
 * worst possible way (a legitimate new section becomes ungrantable).
 *
 * ### `created_by` has a real foreign key
 *
 * §4c added `created_by` "so grants are attributable — see §4d for the admin surface this now
 * needs." It points at **`reward_portal.portal_users(id)`**, not `reward_config.admin_users`: the
 * actor is a `super_admin` portal user, and `admin_users` cannot represent every portal role
 * (gap G1, established by T-037/T-040). Nothing is invented here — this is the same table every
 * other `reward_portal` FK already targets.
 *
 * ### Not a `reward_config` table
 *
 * It lives in `reward_portal` because it is portal-owned access control, not reward
 * configuration, and because R1 forbids new tables in `reward_config` outright.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.grpc_service_grants (
          id                int generated always as identity primary key,
          service_identity  varchar(120) not null,
          tenant_id         int          null,
          allowed_sections  jsonb        not null,
          status            varchar(20)  not null default 'active',
          created_by        int          not null
                              references reward_portal.portal_users(id),
          created_at        timestamptz  not null default now(),
          updated_at        timestamptz  not null default now(),

          -- Uniqueness-only normalisation (AR-02). See this file's header: without it, two
          -- "every tenant" grants for one identity would not collide.
          tenant_key        int generated always as (coalesce(tenant_id, -1)) stored,
          constraint uq_gsg unique (service_identity, tenant_key),

          constraint ck_gsg_status   check (status in ('active','revoked')),
          constraint ck_gsg_sections check (jsonb_typeof(allowed_sections) = 'array'),
          constraint ck_gsg_identity check (length(btrim(service_identity)) > 0)
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    // The gRPC hot path looks a grant up by SAN on every call (grants are read per request —
    // §4d: "not on the request-volume hot path the way RBAC is", but per-request all the same),
    // so the lookup shape gets its own index rather than relying on `uq_gsg`'s leading column
    // alone: every read also filters on `status`.
    await context.query(
      `CREATE INDEX ix_gsg_identity ON reward_portal.grpc_service_grants(service_identity, status);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // 01-DATABASE.md §3's least-privilege convention: the application role gets exactly the
    // verbs the code uses. Grants are created and edited by `/admin/grpc-grants` (§4d) and
    // revoked by flipping `status`, never hard-deleted — an access-control row that vanished
    // leaves no trace of who could once read what.
    await context.query(
      `GRANT SELECT, INSERT, UPDATE ON reward_portal.grpc_service_grants TO reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `REVOKE DELETE, TRUNCATE ON reward_portal.grpc_service_grants FROM reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** R7 — a working `down()`. The table is portal-owned and nothing references it, so the drop is
 * unconditional; `CASCADE` removes the index and the generated column with it. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(`DROP TABLE IF EXISTS reward_portal.grpc_service_grants CASCADE;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
