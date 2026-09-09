/**
 * T-PC-010. Typed application errors for the `promo-code-config` domain — not part of the
 * "Files owned" list in the task file verbatim, but within this module's own directory
 * (`Edit(promo-code-service/src/modules/promo-code-config/**)`) and required by
 * implementation note 6: a `(tenant_id, name)` uniqueness violation must surface as a typed
 * application error, "not a raw Postgres constraint-violation exception" — letting a raw
 * `SequelizeUniqueConstraintError` bubble up would leak persistence-layer detail into the
 * HTTP layer (T-PC-011) and make the error message untestable across a driver upgrade.
 *
 * Every error here is a plain `Error` subclass (not a NestJS `HttpException`) — this module
 * has no dependency on the HTTP layer at all (Scope "Out": "HTTP controllers/routes
 * (T-PC-011)"); mapping one of these to a concrete status code is that task's job.
 */

export class ConfigNameConflictError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly name: string,
  ) {
    super(`A promo code config named "${name}" already exists for tenant "${tenantId}"`);
    this.name = 'ConfigNameConflictError';
  }
}

/**
 * Thrown when a create/update DTO fails structural validation (zod schema in `dto/*.ts`,
 * including the `rewardUnit`-vs-`rewardValueType` cross-field rule from implementation note
 * 2) — always raised **before** any query reaches the database.
 */
export class PromoCodeConfigValidationError extends Error {
  constructor(public readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    super(
      `Invalid promo code config: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`,
    );
    this.name = 'PromoCodeConfigValidationError';
  }
}

/**
 * T-PC-058. `PATCH /:id` was asked to touch a payout (version-defining) field, but the config has
 * no currently open `draft` `promo_code_config_version` — implementation note 3: "rejected with a
 * clear error if the config has no open draft (the caller must first create one)", never a silent
 * mutation of a `published` row.
 */
export class NoOpenDraftError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly promoCodeConfigId: string,
  ) {
    super(
      `promoCodeConfigId "${promoCodeConfigId}" (tenant "${tenantId}") has no open draft version — create one first`,
    );
    this.name = 'NoOpenDraftError';
  }
}

/**
 * T-PC-058. `POST /:id/versions` was asked to create a new draft while one is already open —
 * `uq_pccv_one_draft` (migration `T-PC-058_001`) is the actual concurrency safety net; this is the
 * typed translation of that `23505`, mirroring `ConfigNameConflictError`'s own precedent for the
 * sibling `(tenant_id, name)` uniqueness violation.
 */
export class DraftAlreadyExistsError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly promoCodeConfigId: string,
  ) {
    super(
      `promoCodeConfigId "${promoCodeConfigId}" (tenant "${tenantId}") already has an open draft version`,
    );
    this.name = 'DraftAlreadyExistsError';
  }
}

/**
 * T-PC-058. `POST /:id/versions/:versionId/publish` targeted a `versionId` that doesn't resolve to
 * any `promo_code_config_version` for this `(tenantId, promoCodeConfigId)` — wrong id, or a version
 * belonging to a different config entirely. Never silently substituted (same "TC-8"-style
 * discipline `PromoCodeGenerationService.resolveVersion`, T-PC-060, already established for the
 * generate-time equivalent of this same lookup).
 */
export class VersionNotFoundError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly promoCodeConfigId: string,
    public readonly versionId: string,
  ) {
    super(
      `versionId "${versionId}" does not resolve to a promo_code_config_version for promoCodeConfigId "${promoCodeConfigId}" (tenant "${tenantId}")`,
    );
    this.name = 'VersionNotFoundError';
  }
}

/**
 * T-PC-058. `POST /:id/versions/:versionId/publish` targeted a version that resolves but is not
 * currently `draft` (already `published`/`deprecated`/`retired`) — publishing is only ever a
 * `draft -> published` transition, never re-triggerable on an already-decided version.
 */
export class VersionNotDraftError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly promoCodeConfigId: string,
    public readonly versionId: string,
  ) {
    super(
      `versionId "${versionId}" for promoCodeConfigId "${promoCodeConfigId}" (tenant "${tenantId}") is not a draft — it cannot be published again`,
    );
    this.name = 'VersionNotDraftError';
  }
}
