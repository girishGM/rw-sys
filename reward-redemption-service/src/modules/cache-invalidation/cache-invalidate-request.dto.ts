/**
 * T-RR-007. `POST /api/v1/cache/invalidate` wire shapes (`04-REST-CONTRACT.md` §4,
 * `06-CACHING-AND-TENANT-CONFIG.md` §3). No `class-validator`/`class-transformer` dependency
 * exists in this service (`package.json`) — validated by hand in `cache-invalidation.service.ts`,
 * matching every other manual-validation precedent already in this codebase (e.g.
 * `config.schema.ts`'s own zod validation is the one exception, reserved for bootstrap env vars).
 *
 * `campaignCode`/`tenantId` are accepted here even though `campaignConfig` doesn't exist as a real
 * cache until T-RR-022 — implementation note 4's own "the request shape itself is valid input to
 * this endpoint even before T-RR-022 exists" requirement (TC-6).
 */
export interface CacheInvalidateRequest {
  key?: string;
  all?: boolean;
  /** `campaignConfig`'s own narrow-clear scoping fields (§3's note) — unused by every cache this
   * task's own registry actually knows about; present only so a `campaignConfig` request shape
   * doesn't fail request-body validation before T-RR-022 exists. */
  campaignCode?: string;
  tenantId?: number;
}

export interface CacheInvalidateResponse {
  invalidated: string[];
  invalidatedAt: string;
  /** Present only for a currently-not-yet-active known cache name (TC-6) — never present on a
   * real invalidation response. */
  note?: string;
}
