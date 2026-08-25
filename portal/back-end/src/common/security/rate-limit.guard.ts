/**
 * T-012 — layer 3 of the request chain (00-ARCHITECTURE.md §6): rate limiting, per IP and per
 * user, plus the global login ceiling (02-SECURITY.md §8, AR-11, AR-12).
 *
 * The *policy* — which counters apply to which route, and which routes fail closed — lives in
 * `throttler.config.ts` and is a pure function. This file is only the mechanism: charge the
 * counters, decide the response, never leak which counter it was.
 *
 * ---
 *
 * ### Why this runs before authentication
 *
 * Because verifying a token is work, and an unauthenticated flood would otherwise get that work
 * for free. The identity used for per-user keying comes from `resolveVerifiedIdentity`, which
 * verifies the access cookie without granting anything — see `request-identity.ts` for why that
 * is not a second authentication path.
 *
 * ### What the client is told
 *
 * A `Retry-After` header and a bare code. No `X-RateLimit-*` headers, no remaining quota, no
 * indication of which of the seven limits tripped (TC-15). The full detail — rule name, key,
 * count, limit — goes to the server log, where it is useful and where an attacker cannot read
 * it. Quota headers are a genuinely useful API affordance and are deliberately omitted here:
 * on the login endpoint they would tell a credential-stuffing tool exactly how hard it may push
 * and when to rotate address.
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
  type LoggerService,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { TokenService } from '@/modules/auth/services/token.service';
import { resolveVerifiedIdentity } from './request-identity';
import { RateLimitedHttpException, ServiceUnavailableHttpException } from './security.exceptions';
import {
  LOGIN_THROTTLE_LIMITS,
  PRODUCTION_LOGIN_THROTTLE_LIMITS,
  SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS,
  type LoginThrottleLimits,
} from './security.constants';
import { THROTTLE_STORE, type ThrottleCounter, type ThrottleStore } from './throttle.store';
import {
  buildThrottleContext,
  resolveThrottlePolicy,
  type ThrottlePolicy,
  type ThrottleRule,
} from './throttler.config';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger: LoggerService;

  /**
   * `@Optional()` on the logger is load-bearing, not decoration: without it Nest treats the
   * third parameter as a dependency it must resolve, finds no `LoggerService` provider, and
   * refuses to build the module — a failure that only ever surfaces at boot. It is a
   * constructor parameter at all so the outage-policy tests can assert on what was logged,
   * which is the only externally visible difference between failing open and failing open
   * *silently*.
   */
  /**
   * The resolved `/auth/login` ceilings (T-066), read once here and reused on every request.
   *
   * `@Optional()` with a production default for the same reason the whole override is built this
   * way: a wiring mistake that fails to provide this must produce 02-SECURITY.md §8's real
   * numbers, never an absent or weakened limit.
   */
  private readonly loginLimits: LoginThrottleLimits;

  constructor(
    @Inject(THROTTLE_STORE) private readonly store: ThrottleStore,
    private readonly tokens: TokenService,
    @Optional() logger?: LoggerService,
    @Optional() @Inject(LOGIN_THROTTLE_LIMITS) loginLimits?: LoginThrottleLimits,
  ) {
    this.logger = logger ?? new Logger(RateLimitGuard.name);
    this.loginLimits = loginLimits ?? PRODUCTION_LOGIN_THROTTLE_LIMITS;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const identity = resolveVerifiedIdentity(request, this.tokens);
    const policy = resolveThrottlePolicy(buildThrottleContext(request, identity), this.loginLimits);
    if (policy.rules.length === 0) return true;

    const now = Date.now();
    let tripped: { rule: ThrottleRule; counter: ThrottleCounter } | null = null;

    for (const rule of policy.rules) {
      let counter: ThrottleCounter;
      try {
        counter = await this.store.consume(rule.key, rule.windowMs, now);
      } catch (error) {
        this.onStoreFailure(policy, rule, error, response);
        // Reached only on a fail-open route: the counter for this rule is lost, the request
        // proceeds, and the remaining rules are still attempted — a store can fail per-key.
        continue;
      }

      // Charged even once something has already tripped, so an attacker cannot keep the coarse
      // counters low by deliberately tripping a fine-grained one first.
      if (counter.count > rule.limit && tripped === null) {
        tripped = { rule, counter };
      }
    }

    if (tripped !== null) this.shed(tripped.rule, tripped.counter, now, response);

    return true;
  }

  /**
   * AR-11's asymmetry, in one method.
   *
   * Fail closed on `/auth/login`, `/auth/mfa/verify` and `/auth/refresh`: 503, `Retry-After`,
   * and — because this guard is layer 3 and the controller is layer 10 — the request never
   * reaches Argon2 or the credential store (TC-20). Fail open everywhere else: the request
   * proceeds unthrottled rather than taking the whole API down with the counter store (TC-21).
   */
  private onStoreFailure(
    policy: ThrottlePolicy,
    rule: ThrottleRule,
    error: unknown,
    response: Response,
  ): void {
    const message = (error as Error).message;

    if (policy.failClosed) {
      this.logger.error(
        `Throttle store unavailable on a fail-closed route (rule=${rule.name}): ${message}. ` +
          'Shedding with 503 rather than admitting an unthrottled login attempt (AR-11).',
      );
      response.setHeader('Retry-After', String(SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS));
      throw new ServiceUnavailableHttpException();
    }

    this.logger.warn(
      `Throttle store unavailable (rule=${rule.name}): ${message}. ` +
        'Failing open on a non-auth route; this request is not rate limited (AR-11).',
    );
  }

  /** Answers a tripped rule. `Retry-After` is the only number that leaves the process. */
  private shed(
    rule: ThrottleRule,
    counter: ThrottleCounter,
    now: number,
    response: Response,
  ): never {
    // At least one second: a sub-second `Retry-After: 0` invites an immediate retry, which is
    // the opposite of what shedding load is for.
    const retryAfter = Math.max(1, Math.ceil((counter.resetAt - now) / 1000));

    this.logger.warn(
      `Rate limit tripped: rule=${rule.name} count=${counter.count} limit=${rule.limit} ` +
        `retryAfter=${retryAfter}s`,
    );

    response.setHeader('Retry-After', String(retryAfter));
    throw rule.shedWith === 'service_unavailable'
      ? new ServiceUnavailableHttpException(retryAfter)
      : new RateLimitedHttpException(retryAfter);
  }
}
