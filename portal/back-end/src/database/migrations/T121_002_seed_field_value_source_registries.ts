import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-121 — day-1 seed data for the two registries created in `T121_001`, plus the
 * `role_entity_permissions` rows the new write endpoints need.
 *
 * Kept as its own migration, separate from the DDL, for the reason `T102_002`'s header gives:
 * a later "add one more provider" change is a new, later-numbered seed migration rather than an
 * edit to an already-applied one.
 *
 * ### Every API lookup provider is seeded `status: 'planned'` — on purpose
 *
 * `13-REWARD-MASTER-VALUE-SOURCES.md` §3, confirmed with the product owner: nobody has yet
 * confirmed the real endpoint, auth or response keys for Product Catalog, Activity List,
 * Merchant List or the Promo Code Config Service with the teams that own that data. They are
 * seeded with real column *shapes* so a rule field can already be authored against them
 * (T-122/T-125) and so the runtime lookup (T-123) has something to refuse politely, but the
 * `endpoint_url` is an unmistakable placeholder rather than a plausible-looking guess — a query
 * against this table must never look silently "ready" when it isn't. Flipping one to `active`
 * once its real details are confirmed is a data change, not a code change.
 *
 * ### Why `auth_config_enc` is seeded NULL rather than a placeholder string
 *
 * The task file asks for a placeholder in `auth_config` too. Writing a plaintext placeholder into
 * a column whose entire contract is "AES-256-GCM ciphertext, AAD-bound to this row's id" would
 * break three things at once: this task's own verification step 3 (*"inspect the raw DB column —
 * ciphertext, not the placeholder plaintext"*), the crypto helper's read path (which would have
 * to learn to tolerate non-ciphertext, weakening it for every real credential later), and the
 * habit the `_enc` suffix exists to enforce. A migration also cannot encrypt: `FieldCryptoService`
 * needs the key registry and a resolved key, neither of which the Umzug CLI context has.
 *
 * NULL is the honest encoding of "this provider has no credential yet", and it is exactly
 * consistent with the `auth_type = 'none'` seeded alongside it. The placeholder the task file
 * wants is still unmissable — it is in `endpoint_url` and `description`, both of which are
 * plain, non-secret columns where a placeholder belongs. Flagged in the completion report.
 */
const CONTEXT_PROVIDERS: ReadonlyArray<{
  code: string;
  name: string;
  description: string;
  status: string;
}> = [
  {
    code: 'SIBLING_COMPONENTS',
    name: 'Sibling Components In This Journey',
    description:
      'Lists the other tracker components in the same journey. Reads the in-progress campaign ' +
      'draft — no network call, so this needs no external confirmation to be usable.',
    // `active`: unlike the API lookups below, this one reads data the portal already owns.
    status: 'active',
  },
  {
    code: 'JOURNEY_COMPONENTS',
    name: 'Components Of The Selected Journey',
    description:
      'Lists the components of a journey selected elsewhere in the same campaign draft. Reads ' +
      'the in-progress campaign draft — no network call.',
    status: 'active',
  },
];

/**
 * The unmistakable-placeholder marker. Deliberately not a URL: anything that parses as one
 * invites a future reader (or a future HTTP client) to try it.
 */
const PLACEHOLDER_ENDPOINT = 'PLACEHOLDER — confirm with data owner before flipping to active';

const API_LOOKUP_PROVIDERS: ReadonlyArray<{
  code: string;
  name: string;
  description: string;
  valueKey: string;
  labelKey: string;
}> = [
  {
    code: 'PRODUCT_CATALOG',
    name: 'Product Catalog',
    description:
      'Products available for selection on a rule or reward field. Endpoint unconfirmed.',
    valueKey: 'productId',
    labelKey: 'productName',
  },
  {
    code: 'ACTIVITY_LIST',
    name: 'Activity List',
    description: 'Trackable customer activities. Endpoint unconfirmed.',
    valueKey: 'activityCode',
    labelKey: 'activityName',
  },
  {
    code: 'MERCHANT_LIST',
    name: 'Merchant List',
    description: 'Merchants selectable on a rule or reward field. Endpoint unconfirmed.',
    valueKey: 'merchantId',
    labelKey: 'merchantName',
  },
  {
    code: 'PROMO_CODE_CONFIG_SERVICE',
    name: 'Promo Code Config Service',
    description:
      'Promo code configurations from the promo code service (T-127). Endpoint unconfirmed.',
    valueKey: 'promoCode',
    labelKey: 'promoCodeLabel',
  },
];

/**
 * `super_admin` gets `view/create/update` (no `delete` — this task deliberately doesn't add one,
 * same as T-106); every other role gets `view`, because every role needs to read these registries
 * to render a value-source dropdown. Same shape as `T106_001`'s own permission matrix.
 */
interface PermissionRow {
  role: string;
  entity: string;
  actions: string[];
}

const OTHER_ROLES = ['country_admin', 'tenant_admin', 'maker', 'checker', 'merchant'] as const;

export const FIELD_VALUE_SOURCE_PERMISSIONS: PermissionRow[] = [
  'field_context_provider',
  'field_api_lookup_provider',
].flatMap((entity) => [
  { role: 'super_admin', entity, actions: ['view', 'create', 'update'] },
  ...OTHER_ROLES.map((role) => ({ role, entity, actions: ['view'] })),
]);

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    // `WHERE NOT EXISTS` on the unique code keeps this idempotent on a re-run — same guard, and
    // same reasoning, as `T102_002`.
    for (const p of CONTEXT_PROVIDERS) {
      await context.query(
        `INSERT INTO reward_config.field_context_providers
           (provider_code, name, description, status)
         SELECT :code, :name, :description, :status
         WHERE NOT EXISTS (
           SELECT 1 FROM reward_config.field_context_providers WHERE provider_code = :code
         );`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: {
            code: p.code,
            name: p.name,
            description: p.description,
            status: p.status,
          },
        },
      );
    }

    for (const p of API_LOOKUP_PROVIDERS) {
      await context.query(
        `INSERT INTO reward_config.field_api_lookup_providers
           (provider_code, name, description, endpoint_url, http_method, auth_type,
            auth_config_enc, response_value_key, response_label_key, status)
         SELECT :code, :name, :description, :endpointUrl, 'GET', 'none',
                NULL, :valueKey, :labelKey, 'planned'
         WHERE NOT EXISTS (
           SELECT 1 FROM reward_config.field_api_lookup_providers WHERE provider_code = :code
         );`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: {
            code: p.code,
            name: p.name,
            description: p.description,
            endpointUrl: PLACEHOLDER_ENDPOINT,
            valueKey: p.valueKey,
            labelKey: p.labelKey,
          },
        },
      );
    }

    for (const row of FIELD_VALUE_SOURCE_PERMISSIONS) {
      await context.query(
        `INSERT INTO reward_config.role_entity_permissions (role, entity, actions)
         VALUES (:role, :entity, :actions)
         ON CONFLICT (role, entity) DO NOTHING;`,
        {
          type: QueryTypes.INSERT,
          transaction: t,
          replacements: {
            role: row.role,
            entity: row.entity,
            actions: JSON.stringify(row.actions),
          },
        },
      );
    }

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of FIELD_VALUE_SOURCE_PERMISSIONS) {
      await context.query(
        `DELETE FROM reward_config.role_entity_permissions WHERE role = :role AND entity = :entity;`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: { role: row.role, entity: row.entity },
        },
      );
    }

    // IN (:codes) rather than ANY(...) — Sequelize's named-replacement array expansion produces a
    // bare comma list, which is valid inside IN (...) but not inside ANY(...). See `T102_002`.
    await context.query(
      `DELETE FROM reward_config.field_api_lookup_providers WHERE provider_code IN (:codes);`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { codes: API_LOOKUP_PROVIDERS.map((p) => p.code) },
      },
    );
    await context.query(
      `DELETE FROM reward_config.field_context_providers WHERE provider_code IN (:codes);`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { codes: CONTEXT_PROVIDERS.map((p) => p.code) },
      },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
