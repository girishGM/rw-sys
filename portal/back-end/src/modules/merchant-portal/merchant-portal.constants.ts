/**
 * T-039 — constants shared by the service, the controller and the tests.
 *
 * `role_entity_permissions.entity` for this surface is `campaign` (01-DATABASE.md §5.1: the
 * `merchant` row already holds `view` on it) — there is no separate `merchant_portal` entity in
 * the seeded matrix, and this module does not add one. `@Roles('merchant')` on the controller
 * (see its own header) is the static half of the guard; `@RequirePermission(CAMPAIGN_ENTITY,
 * 'view')` is the runtime-configurable half, the same two-independent-layers shape
 * `audit-viewer.controller.ts`'s header documents for its own `@RequirePermission`+`@Roles` pair.
 */
export const CAMPAIGN_ENTITY = 'campaign';

/**
 * 03-API-CONTRACT.md §13 / T-039 implementation note 4: "Merchants must never see `draft` or
 * `pending_approval` campaigns — only `active`, `paused` and `completed`." `archived` is not
 * named there either, and is excluded for the same reason: it is a terminal, admin-only state,
 * not one of the three the task file lists as visible to a participant.
 *
 * `CAMPAIGN_STATUSES` (`campaign.schema.ts`, T-037) is the full six-value set this is a subset
 * of; not imported from there because `back-end/src/modules/merchant-portal/**` is this task's
 * only file scope (AGENT-PROTOCOL R9) and the shared schema is a `packages/shared` concern.
 */
export const MERCHANT_VISIBLE_CAMPAIGN_STATUSES = ['active', 'paused', 'completed'] as const;

/** `campaign_merchants.status` / `merchant_activities.status` — the one value that counts as
 * "currently participating" (implementation note 1, TC-15) or "currently offered" respectively. */
export const MERCHANT_PARTICIPATION_ACTIVE_STATUS = 'active';

/** `tenant_campaigns.status` — the one value `kpi_active_campaigns` (01-DATABASE.md §5.3) counts. */
export const CAMPAIGN_ACTIVE_STATUS = 'active';
