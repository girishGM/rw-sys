/**
 * T-012 — DI wiring for the hardening layer: the counter store, and the two guards
 * 00-ARCHITECTURE.md §6 places at positions 3 and 4.
 *
 * ### Why the guards are global here, when T-011's are not
 *
 * `AuthModule` deliberately exports its three guards without registering them globally, because
 * doing so would 401 `GET /health` — a route it does not own and cannot annotate `@Public()`
 * (see `auth.controller.ts`'s header). The two guards here have no such problem: neither denies
 * an anonymous request. `RateLimitGuard` counts it, `CsrfGuard` passes it through when there is
 * no session and no CSRF cookie to check against. So they can be — and must be — global: a
 * rate limit that only applies to the controllers somebody remembered to annotate is not a rate
 * limit, and the same is true of CSRF.
 *
 * Registration order is load-bearing. Nest runs `APP_GUARD` providers in the order they are
 * declared, so `RateLimitGuard` is declared first and `CsrfGuard` second, matching §6 (3 then
 * 4). T-013 appends the rest of the chain — `JwtAuthGuard` (5) onward — from its own module;
 * because Nest runs global guards before controller-bound ones, and because `AppModule` imports
 * this module before any feature module, the composed order stays the one §6 fixes.
 *
 * `useExisting` rather than `useClass` on both, so the `APP_GUARD` entry and the exported
 * provider are the *same instance* — two instances would mean two of everything a guard holds,
 * and in `RateLimitGuard`'s case that would eventually mean two counter stores.
 *
 * This file is an addition to T-012's declared *Files owned* list; recorded as a deviation in
 * the completion report.
 */
import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ConfigModule } from '@/config/config.module';
import { AuthModule } from '@/modules/auth/auth.module';
import type { Env } from '@/config/env.schema';
import { CsrfGuard } from './csrf.guard';
import { RateLimitGuard } from './rate-limit.guard';
import { createThrottleStore, THROTTLE_STORE } from './throttle.store';
import {
  LOGIN_THROTTLE_LIMITS,
  LOGIN_THROTTLE_RELAX_FACTOR_VAR,
  loginThrottleRelaxedWarning,
  resolveLoginThrottleLimits,
  type LoginThrottleLimits,
} from './security.constants';

@Module({
  // `AuthModule` for `TokenService` — the CSRF value is an HMAC it derives, and the per-user
  // rate-limit key comes from claims it verifies. `ConfigModule` is `@Global`, but is imported
  // explicitly for the reason `AuthModule` gives: a module whose graph only resolves because
  // something else loaded a global one cannot be tested in isolation.
  imports: [ConfigModule, AuthModule],
  providers: [
    {
      provide: THROTTLE_STORE,
      useFactory: (config: ConfigService<Env, true>) =>
        createThrottleStore({
          redisUrl: config.get('REDIS_URL', { infer: true }),
          instanceCount: config.get('APP_INSTANCE_COUNT', { infer: true }) ?? 1,
        }),
      inject: [ConfigService],
    },
    {
      // T-066. Resolved once, here, from the config layer rather than from `process.env` in the
      // guard: `ConfigService` reads the *validated* configuration, which is the only view that
      // includes values supplied by a `.env` file (`@nestjs/config` assigns only validated keys
      // back to `process.env`, and zod strips unknown ones — T-057's D-3). Resolving it in a
      // provider factory also guarantees it happens after `ConfigModule` has loaded those files,
      // which a module-load-time read of `process.env` in `security.constants.ts` would not.
      provide: LOGIN_THROTTLE_LIMITS,
      useFactory: (config: ConfigService<Env, true>): LoginThrottleLimits => {
        const limits = resolveLoginThrottleLimits({
          raw: config.get(LOGIN_THROTTLE_RELAX_FACTOR_VAR, { infer: true }),
          nodeEnv: config.get('NODE_ENV', { infer: true }),
        });

        if (limits.relaxed) {
          // Warn, not log: this must be visible in an environment whose level is `info` or
          // above, because "the login limiter is not at its production setting" is exactly the
          // sort of thing nobody goes looking for until it matters.
          new Logger(RateLimitGuard.name).warn(loginThrottleRelaxedWarning(limits));
        }

        return limits;
      },
      inject: [ConfigService],
    },
    RateLimitGuard,
    CsrfGuard,
    { provide: APP_GUARD, useExisting: RateLimitGuard },
    { provide: APP_GUARD, useExisting: CsrfGuard },
  ],
  exports: [THROTTLE_STORE, RateLimitGuard, CsrfGuard],
})
export class SecurityModule {}
