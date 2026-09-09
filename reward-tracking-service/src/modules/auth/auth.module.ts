/**
 * T-RTS-032, revised by T-RTS-030 (same owning agent, `agent-rts-api`, across all three of this
 * agent's tasks — not a cross-task edit, R10's own "don't edit another task's owned files" governs
 * *other* agents' scopes).
 *
 * **Split into two single-guard modules, not one combined `AuthModule` — a real defect, reproduced,
 * not hypothetical.** The original shape here provided both `PortalAdminAuthGuard` and
 * `CustomerAuthGuard` from one `AuthModule`, on the reasoning that either T-RTS-030 or T-RTS-031
 * would "import `AuthModule` directly". That reasoning held right up until T-RTS-030 actually became
 * the first task to register a real controller into `AppModule` (`customer-rewards-api.module.ts`):
 * importing the combined module to get `CustomerAuthGuard` also eagerly constructs
 * `PortalAdminAuthGuard` as one of the same module's providers — and that guard's own constructor
 * throws synchronously if `PORTAL_ADMIN_API_AUTH_SECRET` isn't set (R12's own fail-fast design,
 * working exactly as intended, just for the *wrong* guard). Reproduced directly:
 * `test/health.e2e-spec.ts` (T-RTS-001's own, unrelated test — it boots the real `AppModule` purely
 * to prove `ConfigModule`/`HealthModule` wiring) started failing with `PORTAL_ADMIN_API_AUTH_SECRET
 * is required`, despite that test never touching a portal-admin endpoint and
 * `CUSTOMER_API_AUTH_SECRET` already being correctly configured. A customer-facing-only consumer
 * must never be forced to also provision the portal-admin secret (and, symmetrically, T-RTS-031's
 * own future portal-admin-only consumer must never be forced to provision the customer secret) —
 * fixed here by giving each guard its own module, each importing only the one secret its own guard
 * actually needs.
 */
import { Module } from '@nestjs/common';
import { CustomerAuthGuard } from './customer-auth.guard';
import { PortalAdminAuthGuard } from './portal-admin-auth.guard';

/** T-RTS-030's own feature module (`customer-rewards-api.module.ts`) imports this directly. */
@Module({
  providers: [CustomerAuthGuard],
  exports: [CustomerAuthGuard],
})
export class CustomerAuthModule {}

/** T-RTS-031's own feature module imports this directly once it lands — never
 * `CustomerAuthModule`/`CustomerAuthGuard`, a different trust domain entirely (see
 * `customer-auth.guard.ts`'s own header). `Reflector` (used by `PortalAdminAuthGuard`) needs no
 * entry here — it is one of Nest's own core providers, available without explicit registration. */
@Module({
  providers: [PortalAdminAuthGuard],
  exports: [PortalAdminAuthGuard],
})
export class PortalAdminAuthModule {}
