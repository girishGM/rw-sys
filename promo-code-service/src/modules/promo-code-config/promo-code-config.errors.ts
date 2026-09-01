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
