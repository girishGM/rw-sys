/**
 * T-PC-012. Typed application errors for the `campaign-binding` domain — same discipline as
 * `promo-code-config.errors.ts` (T-PC-010): plain `Error` subclasses with no dependency on the
 * HTTP layer, mapped to concrete status codes only by this module's own
 * `filters/http-exception.filter.ts`.
 */

/**
 * Thrown when a bind request body fails structural validation (zod schema in
 * `dto/create-campaign-promo-config.dto.ts`) — always raised before any query reaches the
 * database.
 */
export class CampaignBindingValidationError extends Error {
  constructor(public readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    super(
      `Invalid campaign promo-config bind request: ${issues
        .map((i) => `${i.path || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'CampaignBindingValidationError';
  }
}

/**
 * `04-API-CONTRACT.md` §2's explicit `409`: `promoCodeConfigId` does not resolve to an `ACTIVE`
 * config for the request's `tenantId` — covers "doesn't exist", "belongs to a different tenant"
 * (`PromoCodeCodeConfigService.findById` is tenant-scoped, so a cross-tenant id already looks
 * identical to "doesn't exist", R3) and "exists but is `INACTIVE`/`ARCHIVED`" uniformly.
 */
export class ConfigNotActiveError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly promoCodeConfigId: string,
  ) {
    super(
      `promoCodeConfigId "${promoCodeConfigId}" does not resolve to an ACTIVE config for tenant "${tenantId}"`,
    );
    this.name = 'ConfigNotActiveError';
  }
}

/**
 * Implementation note 3: two concurrent bind requests for the same `(tenantId, bindLevel,
 * bindRefId)` can both pass the application-level "is there an active one?" check before either
 * commits — the unique partial index (`uc_campaign_promo_config_active`) is the actual
 * concurrency safety net. `CampaignBindingService` retries the deactivate+insert sequence once
 * on that race before surfacing this error, so this only reaches a caller if the race repeats
 * twice in a row.
 */
export class BindingConflictError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly bindLevel: string,
    public readonly bindRefId: string,
  ) {
    super(
      `Concurrent bind conflict for tenant "${tenantId}", bindLevel "${bindLevel}", bindRefId "${bindRefId}"`,
    );
    this.name = 'BindingConflictError';
  }
}
