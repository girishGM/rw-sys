/**
 * T-047 — check 2 of 3: *which tenants may this certificate read?*
 *
 * 09-INTEGRATION.md §7: *"Per-service scope: a service identity is bound to a set of `tenant_id`s.
 * A request for a tenant outside that set → `PERMISSION_DENIED`."*
 *
 * ### `PERMISSION_DENIED`, not `NOT_FOUND`, and this is the opposite of the portal's rule
 *
 * Every browser-facing endpoint in this system answers 404 for a resource in another tenant, so
 * that "exists but is not yours" and "does not exist" are indistinguishable (02-SECURITY.md §5.1).
 * Implementation note 3 reverses that here, deliberately: *"this is a service, not a user — leaking
 * existence to a peer service is not the same threat."* The practical difference is what the
 * runtime's operators see. A `NOT_FOUND` for a campaign the runtime is entitled to looks like a
 * campaign that ended, and the runtime skips it silently; a `PERMISSION_DENIED` is a grant that
 * needs fixing, and somebody gets paged.
 *
 * ### Grant precedence
 *
 * An identity may hold a tenant-specific grant **and** a global one (`tenant_id IS NULL`). The
 * tenant-specific row wins for that tenant, because a `super_admin` writing a narrower row for one
 * tenant means the narrower thing. `T047_001`'s `tenant_key` generated column guarantees at most
 * one of each (TC-36), so "wins" is a rule about two rows, never about an unordered set of five.
 */
import { Injectable } from '@nestjs/common';
import {
  GrpcGrantsService,
  type GrpcServiceGrant,
} from '@/modules/access-control/grpc-grants.service';
import { MutualTlsRequiredError, ServiceScopeDeniedError } from './grpc.errors';

/** A caller whose certificate resolved to a known identity holding at least one active grant. */
export interface ResolvedServiceIdentity {
  readonly identity: string;
  readonly grants: readonly GrpcServiceGrant[];
}

@Injectable()
export class ServiceScopeGuard {
  constructor(private readonly grants: GrpcGrantsService) {}

  /**
   * The first of `candidates` that holds any active grant — the allowlist check implementation
   * note 3 asks for (TC-10).
   *
   * A CA-signed certificate for an identity nobody has granted anything is `UNAUTHENTICATED`
   * rather than `PERMISSION_DENIED`: the difference between "I do not know who you are" and "I
   * know who you are and you may not have this" is worth keeping, and only the second is a
   * grant-configuration problem.
   */
  async resolve(candidates: readonly string[]): Promise<ResolvedServiceIdentity> {
    for (const identity of candidates) {
      const grants = await this.grants.activeGrantsFor(identity);
      if (grants.length > 0) return { identity, grants };
    }
    throw new MutualTlsRequiredError(
      `client certificate identity is not in the service allowlist (${candidates.join(', ')})`,
    );
  }

  /**
   * The grant that governs `tenantId`, or `PERMISSION_DENIED` (TC-11).
   *
   * Every read path calls this **before** issuing a query, so a tenant outside the grant is never
   * so much as looked up.
   */
  grantFor(resolved: ResolvedServiceIdentity, tenantId: number): GrpcServiceGrant {
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
      throw new ServiceScopeDeniedError(resolved.identity, tenantId);
    }
    const specific = resolved.grants.find((grant) => grant.tenantId === tenantId);
    if (specific !== undefined) return specific;

    const global = resolved.grants.find((grant) => grant.tenantId === null);
    if (global !== undefined) return global;

    throw new ServiceScopeDeniedError(resolved.identity, tenantId);
  }
}
