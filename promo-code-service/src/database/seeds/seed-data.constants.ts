/**
 * T-PC-003 — fixed, committed demo data for `promo_code.promo_code_config`.
 *
 * Every id below is a **constant this service invents itself**, not a lookup against
 * `reward_config`/`reward_portal` — `ARCHITECTURE.md` §5 is explicit that this service never
 * reads those schemas directly, and seed data is not an exception to that isolation boundary
 * (task file, implementation note 1). "Consistent in spirit" with the portal's own demo
 * tenants/merchants means these *look* like plausible ids and the configs *read* like real
 * recipes a Maker might pick — not that they're copied from `database/reward_config/`'s seed
 * data.
 *
 * `DEMO_ACTOR_ID` stands in for `created_by`/`updated_by` on every seeded row. This service has
 * no concept of a portal user identity, so a single fixed, documented, made-up actor is more
 * honest than borrowing a real-looking portal user id that could be mistaken for a live
 * cross-reference (implementation note 4). It also doubles as the idempotent cleanup key — see
 * the task file's own "Rollback" section: `DELETE FROM promo_code.promo_code_config WHERE
 * created_by = '<this constant>'` removes exactly (and only) the rows this seed inserts.
 */
export const DEMO_ACTOR_ID = '00000000-0000-4000-8000-000000000001';

// A single demo tenant, plus one demo merchant nested under it — enough to cover both the
// tenant-wide (`merchant_id IS NULL`) and merchant-scoped shapes `01-DATABASE.md` §1 describes,
// without inventing a sprawling roster no other Wave 0 task needs.
export const DEMO_TENANT_ID = '00000000-0000-4000-8000-0000000000a1';
export const DEMO_MERCHANT_ID = '00000000-0000-4000-8000-0000000000b1';

export interface DemoPromoCodeConfigSeed {
  tenant_id: string;
  merchant_id: string | null;
  name: string;
  code_prefix: string | null;
  code_postfix: string | null;
  code_length: number;
  character_set: 'NUMERIC' | 'ALPHA' | 'ALPHANUMERIC';
  exclude_ambiguous_chars: boolean;
  reward_value_type: 'FIXED_AMOUNT' | 'PERCENTAGE' | 'POINTS';
  reward_value: number;
  reward_unit: string;
  max_redemptions_per_code: number;
  code_expiry_days: number | null;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
}

/**
 * Five rows, deliberately spread across all three `reward_value_type` values and three (not
 * just the minimum two) `character_set` values, so Wave 1/2 tasks (T-PC-010's cross-field
 * validation, T-PC-020's generation algorithm) each get exercised against real variety rather
 * than near-identical fixtures (implementation note 3).
 */
export const DEMO_PROMO_CODE_CONFIGS: readonly DemoPromoCodeConfigSeed[] = [
  {
    tenant_id: DEMO_TENANT_ID,
    merchant_id: null,
    name: '10% Off Welcome Code',
    code_prefix: 'WELCOME',
    code_postfix: null,
    code_length: 8,
    character_set: 'ALPHANUMERIC',
    exclude_ambiguous_chars: true,
    reward_value_type: 'PERCENTAGE',
    reward_value: 10,
    reward_unit: '%',
    max_redemptions_per_code: 1,
    code_expiry_days: 30,
    status: 'ACTIVE',
  },
  {
    tenant_id: DEMO_TENANT_ID,
    merchant_id: null,
    name: 'Fixed $5 Cashback Code',
    code_prefix: null,
    code_postfix: null,
    code_length: 10,
    character_set: 'NUMERIC',
    exclude_ambiguous_chars: true,
    reward_value_type: 'FIXED_AMOUNT',
    reward_value: 5,
    reward_unit: 'USD',
    max_redemptions_per_code: 1,
    code_expiry_days: 60,
    status: 'ACTIVE',
  },
  {
    tenant_id: DEMO_TENANT_ID,
    merchant_id: DEMO_MERCHANT_ID,
    name: '500 Points Referral Bonus',
    code_prefix: 'REF',
    code_postfix: null,
    code_length: 12,
    character_set: 'ALPHA',
    exclude_ambiguous_chars: true,
    reward_value_type: 'POINTS',
    reward_value: 500,
    reward_unit: 'PTS',
    max_redemptions_per_code: 1,
    code_expiry_days: null,
    status: 'ACTIVE',
  },
  {
    tenant_id: DEMO_TENANT_ID,
    merchant_id: DEMO_MERCHANT_ID,
    name: 'Fixed £10 Loyalty Reward',
    code_prefix: null,
    code_postfix: 'GBP',
    code_length: 9,
    character_set: 'ALPHANUMERIC',
    exclude_ambiguous_chars: false,
    reward_value_type: 'FIXED_AMOUNT',
    reward_value: 10,
    reward_unit: 'GBP',
    max_redemptions_per_code: 3,
    code_expiry_days: 90,
    status: 'ACTIVE',
  },
  {
    tenant_id: DEMO_TENANT_ID,
    merchant_id: null,
    name: '20% Off Flash Sale',
    code_prefix: 'FLASH',
    code_postfix: null,
    code_length: 6,
    character_set: 'NUMERIC',
    exclude_ambiguous_chars: true,
    reward_value_type: 'PERCENTAGE',
    reward_value: 20,
    reward_unit: '%',
    max_redemptions_per_code: 1,
    code_expiry_days: 7,
    status: 'INACTIVE',
  },
] as const;
