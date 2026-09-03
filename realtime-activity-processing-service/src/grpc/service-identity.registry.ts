/**
 * T-RAP-022. In-memory `identity -> tenantId` allowlist, loaded once at process start from
 * `GRPC_SERVER_ALLOWED_IDENTITIES` (`grpc-server.config.ts`'s own header explains why this is
 * env-driven rather than the Postgres-backed table `promo-code-service`'s own T-PC-031 precedent
 * uses). Deliberately the *only* thing `MtlsGuard` consults to decide "is this client identity
 * allowed, and if so which tenant does it resolve to" — kept as its own small class (not inlined
 * into the guard) so a unit test can construct one directly from a literal `Map`, without needing
 * to set `process.env.GRPC_SERVER_ALLOWED_IDENTITIES` for every guard test case.
 *
 * Always constructed via `grpc.module.ts`'s own factory provider, never Nest's implicit
 * constructor injection — this constructor's own parameter is a plain `ReadonlyMap`, not a class,
 * which Nest's `design:paramtypes` reflection cannot resolve to a DI token (same reasoning
 * `campaign-config-cache.module.ts`'s own `CampaignConfigClient` factory provider documents for
 * this project).
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class ServiceIdentityRegistry {
  constructor(private readonly entries: ReadonlyMap<string, number>) {}

  /** Returns the first candidate identity's resolved `tenantId`, or `undefined` when none of the
   * given candidates (a certificate's SAN entries, falling back to its CN) are on the allowlist. */
  resolveTenantId(candidates: readonly string[]): number | undefined {
    for (const candidate of candidates) {
      const tenantId = this.entries.get(candidate);
      if (tenantId !== undefined) {
        return tenantId;
      }
    }
    return undefined;
  }
}
