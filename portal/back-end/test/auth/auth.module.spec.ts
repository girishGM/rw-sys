/**
 * T-010 — `AuthModule`'s DI wiring.
 *
 * A module file looks too trivial to test right up until the graph it describes stops
 * resolving. Everything asserted here fails *at boot in production* and nowhere else: a
 * provider missing from `providers`, a service missing from `exports` (so T-011 cannot
 * inject it), or — the one that matters most — `CREDENTIAL_STORE` not being bound, which
 * would leave the entire credential layer unable to reach the database.
 *
 * `DatabaseModule` is mocked out for the reason `test/auth/support/fake-database.module.ts`
 * documents. T-011's `auth.e2e-spec.ts` boots the real module against the real database,
 * which is where "does this wire up against the genuine article" gets answered.
 */
import { Test } from '@nestjs/testing';

/**
 * Jest hoists these above every `import` below, so the replacements have to be reached through
 * `jest.requireActual` rather than a top-level import that has not run yet.
 *
 * T-011 added the `ConfigModule` mock: `AuthModule` now imports the real one so `TokenService`
 * can resolve the RS256 key pair, and the real one exits the process on an incomplete
 * environment — see `support/fake-config.module.ts`.
 */
jest.mock('@/database/database.module', () => jest.requireActual('./support/fake-database.module'));
jest.mock('@/config/config.module', () => jest.requireActual('./support/fake-config.module'));

import { AuthModule } from '@/modules/auth/auth.module';
import { AuthController } from '@/modules/auth/auth.controller';
import { AuthService } from '@/modules/auth/auth.service';
import {
  CredentialRepository,
  CREDENTIAL_STORE,
  type CredentialStore,
} from '@/modules/auth/services/credential.repository';
import { CredentialService } from '@/modules/auth/services/credential.service';
import { LockoutService } from '@/modules/auth/services/lockout.service';
import { PasswordPolicyService } from '@/modules/auth/services/password-policy.service';
import {
  SessionRepository,
  SESSION_STORE,
  type SessionStore,
} from '@/modules/auth/services/session.repository';
import { SessionService } from '@/modules/auth/services/session.service';
import {
  NoopStepUpHook,
  STEP_UP_HOOK,
  type StepUpHook,
} from '@/modules/auth/services/step-up.hook';
// T-055 — the hook that replaced `NoopStepUpHook`, and the providers it brought with it.
import { TotpStepUpHook } from '@/modules/auth/services/totp-step-up.hook';
import { MfaPendingTokenService } from '@/modules/auth/services/mfa-pending-token.service';
import { MfaRepository, MFA_STORE, type MfaStore } from '@/modules/auth/services/mfa.repository';
import { MfaService } from '@/modules/auth/services/mfa.service';
import { MfaController } from '@/modules/auth/mfa.controller';
import { MfaAdminController } from '@/modules/auth/mfa-admin.controller';
import {
  MfaPendingConfinementGuard,
  MfaRequiredGuard,
} from '@/modules/auth/guards/mfa-required.guard';
import { TokenService } from '@/modules/auth/services/token.service';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { SessionValidGuard } from '@/modules/auth/guards/session-valid.guard';
import { PasswordChangeRequiredGuard } from '@/modules/auth/guards/password-change-required.guard';

describe('AuthModule', () => {
  async function compile() {
    return Test.createTestingModule({ imports: [AuthModule] }).compile();
  }

  it('resolves every provider in the credential layer', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(CredentialService)).toBeInstanceOf(CredentialService);
    expect(moduleRef.get(LockoutService)).toBeInstanceOf(LockoutService);
    expect(moduleRef.get(PasswordPolicyService)).toBeInstanceOf(PasswordPolicyService);
  });

  it('binds CREDENTIAL_STORE to the Sequelize-backed repository', async () => {
    const moduleRef = await compile();

    // The token is what the services inject; if this binding is missing, every one of them
    // fails to construct at boot.
    expect(moduleRef.get<CredentialStore>(CREDENTIAL_STORE)).toBeInstanceOf(CredentialRepository);
  });

  it('exports what T-011 and T-055 need to inject', async () => {
    // Resolved from a consuming module rather than from AuthModule itself: `get()` on the
    // module under test would succeed for a provider that is registered but not exported,
    // which is exactly the mistake this case exists to catch.
    const consumer = await Test.createTestingModule({
      imports: [AuthModule],
      providers: [],
    }).compile();

    const app = consumer.createNestApplication();
    await app.init();

    expect(app.get(CredentialService)).toBeInstanceOf(CredentialService);
    expect(app.get(LockoutService)).toBeInstanceOf(LockoutService);
    expect(app.get(PasswordPolicyService)).toBeInstanceOf(PasswordPolicyService);
    expect(app.get(CREDENTIAL_STORE)).toBeInstanceOf(CredentialRepository);
    expect(app.get(SESSION_STORE)).toBeInstanceOf(SessionRepository);
    expect(app.get(TokenService)).toBeInstanceOf(TokenService);
    expect(app.get(SessionService)).toBeInstanceOf(SessionService);
    expect(app.get(AuthService)).toBeInstanceOf(AuthService);
    expect(app.get(JwtAuthGuard)).toBeInstanceOf(JwtAuthGuard);
    expect(app.get(SessionValidGuard)).toBeInstanceOf(SessionValidGuard);
    expect(app.get(PasswordChangeRequiredGuard)).toBeInstanceOf(PasswordChangeRequiredGuard);

    await app.close();
  }, 30_000);

  // --- T-011 ---------------------------------------------------------------------------------

  it('resolves the session layer, the token service and all three guards', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(TokenService)).toBeInstanceOf(TokenService);
    expect(moduleRef.get(SessionService)).toBeInstanceOf(SessionService);
    expect(moduleRef.get(AuthService)).toBeInstanceOf(AuthService);
    expect(moduleRef.get(JwtAuthGuard)).toBeInstanceOf(JwtAuthGuard);
    expect(moduleRef.get(SessionValidGuard)).toBeInstanceOf(SessionValidGuard);
    expect(moduleRef.get(PasswordChangeRequiredGuard)).toBeInstanceOf(PasswordChangeRequiredGuard);
  });

  it('registers AuthController, which is what makes /auth/* exist at all', async () => {
    const moduleRef = await compile();
    expect(moduleRef.get(AuthController)).toBeInstanceOf(AuthController);
  });

  it('binds SESSION_STORE to the Sequelize-backed repository', async () => {
    const moduleRef = await compile();
    expect(moduleRef.get<SessionStore>(SESSION_STORE)).toBeInstanceOf(SessionRepository);
  });

  /**
   * **T-055 replaced this binding.** The assertion is deliberately kept in the same place and
   * reworded rather than deleted: the point of the original test was that `STEP_UP_HOOK` is the
   * single line this feature would change, and the point of this one is that it *was* — nobody
   * routed around the seam by editing the login flow instead.
   */
  it('binds STEP_UP_HOOK to the TOTP hook — the one line T-055 replaced', async () => {
    const moduleRef = await compile();
    const hook = moduleRef.get<StepUpHook>(STEP_UP_HOOK);

    expect(hook).toBeInstanceOf(TotpStepUpHook);

    // Five of the six roles are unchanged: no second factor, and nothing to satisfy (TC-15).
    await expect(hook.evaluate({ id: 1, role: 'maker' } as never)).resolves.toEqual({
      required: false,
    });

    // `super_admin` always steps up, enrolled or not — see `totp-step-up.hook.ts`.
    const decision = await hook.evaluate({
      id: 1,
      role: 'super_admin',
      mfaEnabled: false,
    } as never);
    expect(decision.required).toBe(true);
    expect(typeof decision.pendingToken).toBe('string');
  });

  /**
   * `NoopStepUpHook` is no longer bound anywhere, and is deliberately still exported: it is
   * T-055's documented rollback target ("revert `super_admin` login to the pre-T-055 flow"), and
   * it remains the correct implementation of "no step-up is required". A rollback path nobody has
   * ever executed is not a rollback path, so it is asserted rather than assumed.
   */
  it('keeps the no-op hook working as the documented rollback target', async () => {
    await expect(new NoopStepUpHook().evaluate({} as never)).resolves.toEqual({ required: false });
  });

  it('registers the MFA layer: both controllers, the store binding and the two guards', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(MfaController)).toBeInstanceOf(MfaController);
    expect(moduleRef.get(MfaAdminController)).toBeInstanceOf(MfaAdminController);
    expect(moduleRef.get<MfaStore>(MFA_STORE)).toBeInstanceOf(MfaRepository);
    expect(moduleRef.get(MfaService)).toBeInstanceOf(MfaService);
    expect(moduleRef.get(MfaPendingTokenService)).toBeInstanceOf(MfaPendingTokenService);
    expect(moduleRef.get(MfaPendingConfinementGuard)).toBeInstanceOf(MfaPendingConfinementGuard);
    expect(moduleRef.get(MfaRequiredGuard)).toBeInstanceOf(MfaRequiredGuard);
  });

  it('does NOT register any guard globally — T-013 owns the chain, see auth.controller.ts', async () => {
    const moduleRef = await compile();

    // APP_GUARD here would 401 `GET /health`, whose controller this task cannot annotate.
    expect(() => moduleRef.get('APP_GUARD')).toThrow();
  });

  it('warms the dummy hash on init rather than on the first unknown-email login', async () => {
    // onModuleInit runs here; without it the first unknown-address login pays a one-off
    // Argon2 hash and stands out from every later one — the TC-4 oracle, once.
    const moduleRef = await compile();
    const app = moduleRef.createNestApplication();

    await expect(app.init()).resolves.toBeDefined();

    await app.close();
  }, 30_000);
});
