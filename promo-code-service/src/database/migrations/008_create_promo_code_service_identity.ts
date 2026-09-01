import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-PC-044 (filed against T-PC-031's own reproduced defect — see that task's evidence): the
 * client-certificate SAN allowlist `03-GRPC-CONTRACT.md` §3 requires for the mTLS handshake
 * between reward-redemption-service and this service's gRPC port (`50061`). Conceptually the
 * same shape as the portal's own `reward_portal.grpc_service_grants`
 * (`T047_001_grpc_service_grants.ts`) but **structurally independent** — §3 is explicit this
 * table is "scoped entirely to this service — not shared with, or dependent on, the portal's
 * own grant table of the same conceptual shape" — so it is not a copy-paste of that migration,
 * it is designed fresh against what this service's own handshake actually needs to check.
 *
 * ### Why this is simpler than the portal's version (no `tenant_id`/`allowed_sections`)
 *
 * The portal's table answers "which config *sections*, for which *tenant*, may this identity
 * read" because its gRPC port serves tenant-scoped configuration reads directly. This service's
 * two RPCs (`GenerateCode`, `ListActivePromoCodeConfigs`, §1) already carry `tenant_id` as a
 * request field and every write is re-validated against the resolved resource's own `tenant_id`
 * at the repository layer (R3, AGENT-PROTOCOL.md) — that is where tenant authorization actually
 * happens, on every call, regardless of which identity is asking. The mTLS layer's job is
 * strictly narrower and coarser: is this SAN allowed to open a connection to this service *at
 * all*. Adding a `tenant_id` column here would duplicate a check this service already makes
 * correctly downstream, and (per §3's error-model split) would blur a transport/auth-layer
 * concern into the same table as a business-authorization one — the same distinction §5 draws
 * between a gRPC error status and a `FAILED` business response.
 *
 * ### `service_identity` uniqueness, `id` shape, `created_by`
 *
 * One row per allowed SAN — `uc_gsi_identity` enforces that directly (no `tenant_key`-style
 * generated column is needed here: unlike the portal's table, there is no "grant same identity
 * twice for two different tenants" case to disambiguate, because there is no `tenant_id` column
 * to begin with). `id` is `uuid DEFAULT gen_random_uuid()`, matching every other table already
 * in this schema (001-006) rather than the portal's `int generated always as identity` — this
 * table lives in `promo_code`, so it follows `promo_code`'s own convention, not
 * `reward_portal`'s. `created_by` is `uuid NOT NULL` with no foreign key, same as
 * `promo_code_config.created_by`/`updated_by` (002) — this schema has no local admin/user table
 * to reference; the actor id is asserted by the caller (an internal admin tool, out of this
 * service's scope) and merely recorded here for attribution.
 *
 * ### Revocation is a status flip, not a delete
 *
 * Same reasoning as `promo_code_config.status`/`campaign_promo_config.status` elsewhere in this
 * schema: a grant that vanished leaves no trace of who could once connect. `status` is
 * `'ACTIVE'`/`'REVOKED'` (uppercase, matching every other status enum already in this schema —
 * `promo_code_config`, `campaign_promo_config`, `promo_code` all use uppercase; the portal's own
 * lowercase `'active'`/`'revoked'` convention on the equivalent table is a `reward_portal`
 * convention, not one this migration imports). No app-level DB grant restricts DELETE on this
 * table specifically (unlike the portal's `REVOKE DELETE, TRUNCATE`) — `promo_code_app`'s
 * privileges on every table in this schema, including this one, come from 007's blanket
 * `ALTER DEFAULT PRIVILEGES` grant, and no other table in this schema carves out a narrower,
 * per-table exception either; enforcing "revoke via status, not delete" is an application-layer
 * discipline here, consistent with how soft-delete is enforced elsewhere in this service.
 *
 * ### Grant: inherited from 007, not re-issued here
 *
 * `007_create_promo_code_app_role`'s `ALTER DEFAULT PRIVILEGES IN SCHEMA promo_code GRANT
 * SELECT, INSERT, UPDATE, DELETE ON TABLES TO promo_code_app` applies to every table subsequently
 * created *by the same role* in this schema — the migration CLI always connects as
 * `DB_MIGRATION_USERNAME` (`migration-connection.ts`), the same role for every migration
 * including 007 and this one, so `promo_code_app` already has the standard CRUD grant on this
 * table the moment `up()` below finishes; no explicit `GRANT` statement is needed or added.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE promo_code.grpc_service_identity (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_identity  varchar(255) NOT NULL CHECK (length(btrim(service_identity)) > 0),
      description       varchar(255) NULL,
      status            varchar(20) NOT NULL DEFAULT 'ACTIVE'
                           CHECK (status IN ('ACTIVE','REVOKED')),
      created_by        uuid NOT NULL,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_gsi_identity
       ON promo_code.grpc_service_identity (service_identity);`,
    { type: QueryTypes.RAW },
  );

  // The mTLS handshake's hot-path lookup is "is this exact SAN currently ACTIVE" on every
  // connection attempt — matches the portal's own `ix_gsg_identity` reasoning
  // (`T047_001_grpc_service_grants.ts`): the leading column of `uc_gsi_identity` alone doesn't
  // cover a query that also filters on `status`.
  await context.query(
    `CREATE INDEX ix_gsi_identity_status
       ON promo_code.grpc_service_identity (service_identity, status);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS promo_code.grpc_service_identity;', {
    type: QueryTypes.RAW,
  });
}
