import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-165 — activates the already-seeded `PROMO_CODE_CONFIG_SERVICE` row on
 * `reward_config.field_api_lookup_providers` (`T121_002`), so the Maker's existing "pick a promo
 * code config" dropdown (`PromoCodeConfigPicker.tsx` → `GET /field-value-sources/api/
 * PROMO_CODE_CONFIG_SERVICE`, both built and `done` since T-127/T-123) returns real data instead
 * of its current 501 `FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE`.
 *
 * **Update in place, never re-insert.** `provider_code = 'PROMO_CODE_CONFIG_SERVICE'` is immutable
 * and already referenced by every rule/reward field pointing at it — this is a plain `UPDATE`,
 * guarded by `WHERE ... AND status = 'planned'` so a second run against an already-activated row
 * is a no-op, not an error (same idempotent shape `T121_002`'s own inserts use).
 *
 * **`auth_config_enc` is deliberately left untouched by this migration**, in either direction.
 * `T121_002`'s own header explains why a migration structurally cannot produce valid ciphertext
 * here: `FieldCryptoService` needs the key registry and a resolved key, neither of which the
 * Umzug migration-CLI context has. Leaving it `NULL` while `status = 'active'` and
 * `auth_type = 'bearer'` is a real, honest, temporary state — `FieldValueSourceLookupService
 * .apiLookup` (T-123) will 502 (`FieldApiLookupUpstreamError`, via `buildAuthHeaders`'s bearer
 * branch throwing on a missing token) until a `super_admin` runs the follow-up
 * `PATCH /field-value-sources/field-api-lookup-providers/:id` call this task's own file documents
 * (implementation note 3) — a one-off admin action per environment, not something a migration
 * should attempt.
 *
 * **`PROMO_CODE_SERVICE_BASE_URL` is read via `process.env` at migration run time**, not baked
 * into this file, so the same migration produces the right URL whether run locally or against
 * Render. No default is supplied — a missing value fails the migration loudly rather than writing
 * a malformed `undefined/api/v1/promo-code-configs` endpoint (TC-5).
 *
 * No `reward_config` DDL (R1): this is a data correction against a table `T121_001` already
 * created and granted to `reward_app`.
 *
 * ### Deviation from this task's own implementation note 4 (flagged per AGENT-PROTOCOL §3)
 *
 * Note 4 asks `down()` to restore `endpoint_url` to "`T121_002`'s `PLACEHOLDER_ENDPOINT` constant
 * (import it, don't retype the string)". That constant is not exported from `T121_002`, and
 * `T121_002.ts` is a file T-121 (a different, already-`done` task) owns — R9 ("do not edit
 * another task's owned files") forbids adding an `export` to it just to make this import possible.
 * `PLACEHOLDER_ENDPOINT_FROM_T121_002` below is therefore a local, byte-for-byte copy of that same
 * string rather than an import. If `T121_002`'s constant is ever exported for an unrelated reason,
 * this local copy should be replaced with a real import at that point.
 */

/**
 * Byte-for-byte copy of `T121_002`'s own `PLACEHOLDER_ENDPOINT` — see this file's header.
 * Exported (only) so this migration's own spec (`T165_001_activate_promo_code_config_service_
 * provider.e2e-spec.ts`, T-165's own file) can assert against the same literal rather than a
 * second, independently-typed copy — not for use outside this task's own two owned files.
 */
export const PLACEHOLDER_ENDPOINT_FROM_T121_002 =
  'PLACEHOLDER — confirm with data owner before flipping to active';

export const PROVIDER_CODE = 'PROMO_CODE_CONFIG_SERVICE';

/** `T121_002`'s own seeded placeholder guesses, restored by `down()`. */
export const PLACEHOLDER_RESPONSE_VALUE_KEY = 'promoCode';
export const PLACEHOLDER_RESPONSE_LABEL_KEY = 'promoCodeLabel';

/**
 * Builds the real endpoint from `PROMO_CODE_SERVICE_BASE_URL`. Throws — rather than falling back
 * to any guessed value — when the variable is missing or blank (TC-5).
 */
function resolveEndpointUrl(): string {
  const baseUrl = process.env.PROMO_CODE_SERVICE_BASE_URL;
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error(
      '[T165_001] PROMO_CODE_SERVICE_BASE_URL is required to activate the ' +
        'PROMO_CODE_CONFIG_SERVICE field-api-lookup provider, and was not set. Refusing to write ' +
        'a malformed endpoint_url — set PROMO_CODE_SERVICE_BASE_URL (e.g. http://localhost:3010) ' +
        'and re-run this migration.',
    );
  }
  // Strip any trailing slash(es) so the join below never produces a double slash.
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
  return `${trimmedBase}/api/v1/promo-code-configs`;
}

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const endpointUrl = resolveEndpointUrl();

  const t = await context.transaction();
  try {
    await context.query(
      `UPDATE reward_config.field_api_lookup_providers
          SET status              = 'active',
              endpoint_url        = :endpointUrl,
              response_value_key  = 'id',
              response_label_key  = 'name',
              auth_type           = 'bearer',
              updated_at          = now()
        WHERE provider_code = :providerCode
          AND status        = 'planned';`,
      {
        type: QueryTypes.UPDATE,
        transaction: t,
        replacements: { providerCode: PROVIDER_CODE, endpointUrl },
      },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `UPDATE reward_config.field_api_lookup_providers
          SET status              = 'planned',
              endpoint_url        = :endpointUrl,
              response_value_key  = :responseValueKey,
              response_label_key  = :responseLabelKey,
              auth_type           = 'none',
              updated_at          = now()
        WHERE provider_code = :providerCode;`,
      {
        type: QueryTypes.UPDATE,
        transaction: t,
        replacements: {
          providerCode: PROVIDER_CODE,
          endpointUrl: PLACEHOLDER_ENDPOINT_FROM_T121_002,
          responseValueKey: PLACEHOLDER_RESPONSE_VALUE_KEY,
          responseLabelKey: PLACEHOLDER_RESPONSE_LABEL_KEY,
        },
      },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
