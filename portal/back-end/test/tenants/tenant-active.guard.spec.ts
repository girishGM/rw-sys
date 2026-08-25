/**
 * T-034 — `assertTenantActive` (implementation note 3, TC-17). See `tenant-active.guard.ts`'s
 * own header for the disclosed limit of what this suite can prove: the assertion itself, not the
 * end-to-end "creating a campaign against a pending tenant 422s" behaviour, since no
 * campaign-creation endpoint exists yet to call it from.
 */
import { assertTenantActive } from '@/modules/tenants/tenant-active.guard';
import { TenantNotActiveError, TENANT_ERROR_CODE } from '@/modules/tenants/tenants.errors';

describe('assertTenantActive', () => {
  it('passes silently for an active tenant', () => {
    expect(() => assertTenantActive({ status: 'active' })).not.toThrow();
  });

  it.each(['pending_provisioning', 'inactive', 'suspended'])(
    '422 TENANT_NOT_ACTIVE for a %s tenant (TC-17)',
    (status) => {
      let thrown: unknown;
      try {
        assertTenantActive({ status });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TenantNotActiveError);
      expect((thrown as TenantNotActiveError).status).toBe(422);
      expect((thrown as TenantNotActiveError).code).toBe(TENANT_ERROR_CODE.TENANT_NOT_ACTIVE);
    },
  );
});
