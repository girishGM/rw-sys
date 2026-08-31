import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Ad hoc demo-data seed, phase 1 of 3 (see `task/reset-reference-data-keep-users`; follows
 * `T900_001`'s reset). Builds the country/tenant/merchant skeleton the user asked for: 3
 * countries (`MY`/`SG`/`KH`), 2 tenants per country, 2 merchants per tenant. `MY`/`DEMO`/
 * `KOPI_HOUSE` already exist (kept by `T900_001`) — this migration adds exactly the remaining
 * 2 countries, 5 tenants and 11 merchants, idempotently (`NOT EXISTS`-guarded on each table's
 * own unique key, same pattern as `T105_001`/`T105_002`).
 *
 * Names/codes/timezones/currencies were chosen freely (not specified by the user beyond the
 * country codes and the 2-tenants/2-merchants-per-tenant shape) — see the completion report for
 * the full picked-name rationale.
 *
 * `countries.id`/`tenants.id`/`merchants.id` are `generated always as identity` columns (T105_002
 * documents this for `tenants`; confirmed live for all three here), so every insert below omits
 * `id` and resolves parent rows by their own unique `code` column instead of a literal id —
 * genuinely reversible, unlike `T900_001`'s reset: `down()` deletes by exact code list, never a
 * blanket wipe, so it cannot touch `MY`/`DEMO`/`KOPI_HOUSE`.
 */

interface CountrySeed {
  code: string;
  name: string;
  timezone: string;
  currencyCode: string;
  dialingCode: string;
}

interface TenantSeed {
  code: string;
  name: string;
  countryCode: string;
  contactEmail: string;
}

interface MerchantSeed {
  tenantCode: string;
  merchantCode: string;
  name: string;
  description: string;
  countryCode: string;
}

const COUNTRIES: readonly CountrySeed[] = [
  {
    code: 'SG',
    name: 'Singapore',
    timezone: 'Asia/Singapore',
    currencyCode: 'SGD',
    dialingCode: '+65',
  },
  {
    code: 'KH',
    name: 'Cambodia',
    timezone: 'Asia/Phnom_Penh',
    currencyCode: 'KHR',
    dialingCode: '+855',
  },
];

const TENANTS: readonly TenantSeed[] = [
  {
    code: 'MY_MAJUBANK',
    name: 'Maju Digital Bank',
    countryCode: 'MY',
    contactEmail: 'ops@majubank.demo',
  },
  {
    code: 'SG_RAFFLES',
    name: 'Raffles Pay',
    countryCode: 'SG',
    contactEmail: 'ops@rafflespay.demo',
  },
  {
    code: 'SG_MARINA',
    name: 'Marina Digital Bank',
    countryCode: 'SG',
    contactEmail: 'ops@marinabank.demo',
  },
  {
    code: 'KH_ANGKOR',
    name: 'Angkor Digital Bank',
    countryCode: 'KH',
    contactEmail: 'ops@angkorbank.demo',
  },
  { code: 'KH_MEKONG', name: 'Mekong Pay', countryCode: 'KH', contactEmail: 'ops@mekongpay.demo' },
];

const MERCHANTS: readonly MerchantSeed[] = [
  {
    tenantCode: 'DEMO',
    merchantCode: 'TEH_TARIK_CORNER',
    name: 'Teh Tarik Corner',
    description: 'Mamak-style stall accepting QR payments',
    countryCode: 'MY',
  },
  {
    tenantCode: 'MY_MAJUBANK',
    merchantCode: 'MART_EXPRESS',
    name: 'Mart Express',
    description: 'Convenience store chain',
    countryCode: 'MY',
  },
  {
    tenantCode: 'MY_MAJUBANK',
    merchantCode: 'FUEL_STOP',
    name: 'Fuel Stop',
    description: 'Petrol station chain',
    countryCode: 'MY',
  },
  {
    tenantCode: 'SG_RAFFLES',
    merchantCode: 'KOPI_TIAM_SG',
    name: 'Kopi Tiam SG',
    description: 'Traditional coffee shop chain',
    countryCode: 'SG',
  },
  {
    tenantCode: 'SG_RAFFLES',
    merchantCode: 'MARINA_FOOD_COURT',
    name: 'Marina Food Court',
    description: 'Hawker-style food court',
    countryCode: 'SG',
  },
  {
    tenantCode: 'SG_MARINA',
    merchantCode: 'ORCHARD_RETAIL_HUB',
    name: 'Orchard Retail Hub',
    description: 'Retail mall outlet',
    countryCode: 'SG',
  },
  {
    tenantCode: 'SG_MARINA',
    merchantCode: 'CONVENIENCE_PLUS',
    name: 'Convenience Plus',
    description: 'Convenience store chain',
    countryCode: 'SG',
  },
  {
    tenantCode: 'KH_ANGKOR',
    merchantCode: 'ANGKOR_MART',
    name: 'Angkor Mart',
    description: 'Supermarket chain',
    countryCode: 'KH',
  },
  {
    tenantCode: 'KH_ANGKOR',
    merchantCode: 'RIVERSIDE_CAFE',
    name: 'Riverside Cafe',
    description: 'Cafe chain along the riverside',
    countryCode: 'KH',
  },
  {
    tenantCode: 'KH_MEKONG',
    merchantCode: 'MEKONG_MARKET',
    name: 'Mekong Market',
    description: 'Local grocery market chain',
    countryCode: 'KH',
  },
  {
    tenantCode: 'KH_MEKONG',
    merchantCode: 'PHNOM_EATS',
    name: 'Phnom Penh Eats',
    description: 'Casual dining chain',
    countryCode: 'KH',
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const c of COUNTRIES) {
      await context.query(
        `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, is_hq, status)
         SELECT :code, :name, :timezone, :currencyCode, :dialingCode, false, 'active'
         WHERE NOT EXISTS (SELECT 1 FROM reward_config.countries WHERE code = :code);`,
        { type: QueryTypes.RAW, transaction: t, replacements: { ...c } },
      );
    }

    for (const tenant of TENANTS) {
      await context.query(
        `INSERT INTO reward_config.tenants (code, name, country_id, contact_email, status)
         SELECT :code, :name, (SELECT id FROM reward_config.countries WHERE code = :countryCode), :contactEmail, 'active'
         WHERE NOT EXISTS (SELECT 1 FROM reward_config.tenants WHERE code = :code);`,
        { type: QueryTypes.RAW, transaction: t, replacements: { ...tenant } },
      );
    }

    for (const m of MERCHANTS) {
      await context.query(
        `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, description, country_code, status)
         SELECT (SELECT id FROM reward_config.tenants WHERE code = :tenantCode), :merchantCode, :name, :description, :countryCode, 'active'
         WHERE NOT EXISTS (
           SELECT 1 FROM reward_config.merchants
           WHERE tenant_id = (SELECT id FROM reward_config.tenants WHERE code = :tenantCode)
             AND merchant_code = :merchantCode
         );`,
        { type: QueryTypes.RAW, transaction: t, replacements: { ...m } },
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
    const merchantCodes = MERCHANTS.map((m) => m.merchantCode);
    await context.query(
      `DELETE FROM reward_config.merchants WHERE merchant_code IN (:merchantCodes);`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { merchantCodes },
      },
    );

    const tenantCodes = TENANTS.map((tn) => tn.code);
    await context.query(`DELETE FROM reward_config.tenants WHERE code IN (:tenantCodes);`, {
      type: QueryTypes.RAW,
      transaction: t,
      replacements: { tenantCodes },
    });

    const countryCodes = COUNTRIES.map((c) => c.code);
    await context.query(`DELETE FROM reward_config.countries WHERE code IN (:countryCodes);`, {
      type: QueryTypes.RAW,
      transaction: t,
      replacements: { countryCodes },
    });

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
