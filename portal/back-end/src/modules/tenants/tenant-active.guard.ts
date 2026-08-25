/**
 * T-034 implementation note 3 / TC-17 — "Only `active` tenants may have campaigns created
 * against them".
 *
 * Campaign creation itself is out of this task's scope (`Out: … merchants (T-036)` — and
 * campaigns further still, T-037's own scope per `05-EXECUTION-PLAN.md` §4). This module owns
 * the tenant lifecycle, so it is the right place to declare the one assertion every later
 * write-against-a-tenant path must apply, rather than have each of them reinvent the status
 * check (and, inevitably, the status literal) independently.
 *
 * `TenantsService` does not call this itself — nothing it currently does is gated on the tenant
 * being `active` (creating the Tenant Admin, reading it, setting its budget ceiling are all
 * legitimate against a `pending_provisioning` tenant). It is exported from `tenants.module.ts`
 * for T-037 (or whichever module first needs it) to call from its own campaign-submission path,
 * e.g. `assertTenantActive(tenant)` right before `POST /campaigns/:id/submit` writes anything —
 * see `tenants.errors.ts`'s `TenantNotActiveError` header for the same note. Flagged for the
 * reviewer as a partial implementation of TC-17: the assertion exists and is unit-tested here;
 * the end-to-end "creating a campaign against a pending tenant 422s" behaviour can only be
 * proven once a campaign-creation endpoint exists to call it from.
 */
import { TENANT_ACTIVE_STATUS } from './tenants.constants';
import { TenantNotActiveError } from './tenants.errors';

/** The minimum a caller must supply — satisfied by a `Tenant` model instance or a `TenantDto`. */
export interface StatusBearingTenant {
  readonly status: string;
}

/** Throws `422 TENANT_NOT_ACTIVE` unless `tenant.status === 'active'`. */
export function assertTenantActive(tenant: StatusBearingTenant): void {
  if (tenant.status !== TENANT_ACTIVE_STATUS) {
    throw new TenantNotActiveError({ logContext: { tenantStatus: tenant.status } });
  }
}
