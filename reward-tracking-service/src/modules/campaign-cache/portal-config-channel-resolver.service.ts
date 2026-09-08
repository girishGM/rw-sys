/**
 * T-INT-013. `PortalConfigChannelResolverService` — resolves which transport
 * (`CampaignHierarchyClient`'s REST-vs-gRPC choice for reaching the portal's
 * `CampaignConfigService`) a given tenant/campaign should use, over
 * `reward_tracking.portal_config_channel_config` (migration `009`).
 *
 * Ported in *shape* from `reward-redemption-service`'s own `PromoCodeChannelResolverService`
 * (`reward-redemption-service/src/modules/connectors/promo-code-channel-resolver.service.ts`, the
 * reference implementation this task's own file names) — same first-match-wins precedence walk,
 * same "tenant-specific row beats tenant-agnostic row at the same scope level, checked before
 * falling through to the next level" rule, same `IS NOT DISTINCT FROM` nullable-column comparison.
 * Two deliberate departures from that reference, both documented in this task's own migration
 * header and completion report:
 *
 *   1. Only `CAMPAIGN` → `GLOBAL` scope levels exist for this leg (no `REWARD`/`TRACKER` — this
 *      client has no reward/tracker-scoped call site at all).
 *   2. **Deliberately NOT cached**, for the same reasoning `PromoCodeChannelResolverService`'s own
 *      header already gives for its own leg: this resolver is called once per tenant per
 *      cold-start warm cycle and once per `WatchCampaignConfig` invalidation event, never on a
 *      high-frequency request path — a TTL cache (and the `POST /api/v1/cache/invalidate`
 *      machinery `ARCHITECTURE.md` §4 describes as the general pattern) would add real
 *      infrastructure (a `cache-invalidation` module, an admin-token guard, an audit repository —
 *      none of them in this task's own "Files owned" list) for no measurable benefit here. This
 *      also happens to be exactly what makes `set-transport-primary.js`'s own "GRPC now primary,
 *      live, no restart" (TC-4) trivially true for this leg: the very next `resolve()` call reads
 *      the freshly-written row, with no invalidation round trip needed at all — `RETURNING` in
 *      that script's own `UPDATE` still runs and succeeds even though this leg never configures
 *      `CACHE_ADMIN_TOKEN`/a matching `cacheKey` handler; the script's own `runDbLeg` degrades
 *      gracefully (warns, does not fail) when the invalidate POST has nothing to reach.
 *
 * Env vars read directly from `process.env`, not `ConfigService` — matching
 * `campaign-hierarchy.client.ts`'s own established convention for this exact module (that file's
 * header: "outside this task's file scope"), since this resolver is constructed directly by that
 * client (see that file's own header on why its constructor signature could not change to accept
 * this as an injected dependency).
 */
import { Pool } from 'pg';

export type PortalConfigChannel = 'REST' | 'GRPC';
export type PortalConfigChannelScopeLevel = 'CAMPAIGN' | 'GLOBAL';

/** `009_create_portal_config_channel_config.ts`'s own column set, exactly. */
export interface PortalConfigChannelConfigRow {
  id: number;
  scope_level: PortalConfigChannelScopeLevel;
  scope_ref_code: string | null;
  tenant_id: number | null;
  rest_enabled: boolean;
  grpc_enabled: boolean;
  primary_channel: PortalConfigChannel;
  fallback_channel: PortalConfigChannel;
  created_at: Date;
  updated_at: Date;
}

/** Only `campaignCode`/`tenantId` — this leg has no reward/tracker-scoped call site (this file's
 * own header). A field left `undefined` means that scope level can never match. */
export interface PortalConfigChannelResolveContext {
  campaignCode?: string;
  tenantId?: number;
}

export interface ResolvedPortalConfigChannel {
  primaryChannel: PortalConfigChannel;
  fallbackChannel: PortalConfigChannel;
  restEnabled: boolean;
  grpcEnabled: boolean;
}

/** Thrown instead of returning a hardcoded default when no row resolves at any scope, including
 * no `GLOBAL` row — migration `009` seeds exactly one `GLOBAL` row, but this resolver must not
 * assume that seed survives a fresh/misconfigured environment (same precedent as
 * `PromoCodeChannelResolutionError`). The caller (`CampaignHierarchyClient`) decides how to react
 * — see that file's own `resolveChannel` for its "never gates" fallback. */
export class PortalConfigChannelResolutionError extends Error {
  constructor(context: PortalConfigChannelResolveContext) {
    super(
      'No reward_tracking.portal_config_channel_config row resolved at any scope (CAMPAIGN or ' +
        `GLOBAL) for context ${JSON.stringify(context)} — the GLOBAL row itself is missing or ` +
        'unreachable.',
    );
    this.name = 'PortalConfigChannelResolutionError';
  }
}

/** `IS NOT DISTINCT FROM` (rather than `=`) is required on both nullable columns — a `GLOBAL`
 * row's `scope_ref_code` is `NULL` by definition, and a tenant-agnostic row at any scope has
 * `tenant_id IS NULL`; plain `=` against a bound `NULL` parameter is SQL `UNKNOWN`, never `TRUE`.
 * Same reasoning as `PromoCodeChannelResolverService`'s own `FIND_ONE_SQL`. */
const FIND_ONE_SQL = `
  SELECT * FROM reward_tracking.portal_config_channel_config
  WHERE scope_level = $1
    AND scope_ref_code IS NOT DISTINCT FROM $2
    AND tenant_id IS NOT DISTINCT FROM $3
`;

function toResolved(row: PortalConfigChannelConfigRow): ResolvedPortalConfigChannel {
  return {
    primaryChannel: row.primary_channel,
    fallbackChannel: row.fallback_channel,
    restEnabled: row.rest_enabled,
    grpcEnabled: row.grpc_enabled,
  };
}

interface Candidate {
  level: PortalConfigChannelScopeLevel;
  refCode: string | null;
}

/** `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_APP_USERNAME`/`DB_APP_PASSWORD`/`DB_SSL` — the exact same
 * env vars `campaign-cache.module.ts`'s own `useFactory` reads via `ConfigService`, read here
 * directly instead (this file's own header). Connects as the least-privilege
 * `reward_tracking_app` role (AGENT-PROTOCOL.md R2), never the migration role. */
export function loadPortalConfigResolverPoolConfig(): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: { rejectUnauthorized: boolean } | undefined;
} {
  return {
    host: process.env.DB_HOST?.trim() || 'localhost',
    port: process.env.DB_PORT ? Number.parseInt(process.env.DB_PORT, 10) : 5432,
    database: process.env.DB_NAME ?? '',
    user: process.env.DB_APP_USERNAME ?? '',
    password: process.env.DB_APP_PASSWORD ?? '',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  };
}

export class PortalConfigChannelResolverService {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? new Pool(loadPortalConfigResolverPoolConfig());
  }

  async resolve(context: PortalConfigChannelResolveContext): Promise<ResolvedPortalConfigChannel> {
    const tenantId = context.tenantId ?? null;

    const candidates: Candidate[] = [];
    if (context.campaignCode !== undefined) {
      candidates.push({ level: 'CAMPAIGN', refCode: context.campaignCode });
    }
    candidates.push({ level: 'GLOBAL', refCode: null });

    for (const { level, refCode } of candidates) {
      const row = await this.resolveAtLevel(level, refCode, tenantId);
      if (row) {
        return toResolved(row);
      }
    }

    throw new PortalConfigChannelResolutionError(context);
  }

  /** Within one scope level, a tenant-specific row wins over the tenant-agnostic row at that
   * *same* level — checked before falling through to the next scope level entirely, never after
   * (same precedent as `PromoCodeChannelResolverService#resolveAtLevel`). */
  private async resolveAtLevel(
    level: PortalConfigChannelScopeLevel,
    refCode: string | null,
    tenantId: number | null,
  ): Promise<PortalConfigChannelConfigRow | null> {
    if (tenantId !== null) {
      const tenantSpecific = await this.findOne(level, refCode, tenantId);
      if (tenantSpecific) {
        return tenantSpecific;
      }
    }
    return this.findOne(level, refCode, null);
  }

  private async findOne(
    scopeLevel: PortalConfigChannelScopeLevel,
    scopeRefCode: string | null,
    tenantId: number | null,
  ): Promise<PortalConfigChannelConfigRow | null> {
    const result = await this.pool.query<PortalConfigChannelConfigRow>(FIND_ONE_SQL, [
      scopeLevel,
      scopeRefCode,
      tenantId,
    ]);
    return result.rows[0] ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
