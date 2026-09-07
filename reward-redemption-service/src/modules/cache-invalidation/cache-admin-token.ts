/**
 * T-RR-007. `CACHE_ADMIN_TOKEN` env-var loading — deliberately **not** part of
 * `src/config/config.schema.ts` (T-RR-004's own bootstrap-only schema). That file's own header
 * documents the boundary this follows: bearer tokens are "a later-wave-owned var" whose own
 * env-var validation belongs to the module that guards the route it protects, not to the Wave 0
 * bootstrap schema every other later-wave task would then have to avoid colliding on. Read
 * directly from `process.env`, same as `encryption.service.ts`'s own `FIELD_ENCRYPTION_*` loader.
 *
 * R9/this task's own implementation note 6: this is a distinct secret from every other bearer
 * token this service holds (`REWARD_ENTRY_INGEST_TOKEN`, `GENERATION_SERVICE_TOKEN`) — comparison
 * is always against this specific env var's value, never "any known token".
 */
export class MissingCacheAdminTokenError extends Error {
  constructor() {
    super(
      'Missing required environment variable CACHE_ADMIN_TOKEN — set it in .env.development ' +
        '(see .env.example) before CacheInvalidationModule can construct its auth guard.',
    );
    this.name = 'MissingCacheAdminTokenError';
  }
}

export function loadCacheAdminToken(): string {
  const token = process.env.CACHE_ADMIN_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new MissingCacheAdminTokenError();
  }
  return token;
}
