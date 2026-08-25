/**
 * T-047 — the per-service-identity rate limit (09-INTEGRATION.md §7).
 *
 * > *"Per service identity, generous but bounded — a runaway retry loop in the runtime must not
 * > take the portal's database down."*
 *
 * A fixed window per identity, counted in memory. Three deliberate differences from T-012's
 * `RateLimitGuard`, which this does **not** reuse:
 *
 *  1. **The key is a certificate identity, not an IP or an email.** T-012's guard is built around
 *     `request.ip` and the portal's route metadata; there is no `ExecutionContext` here at all.
 *  2. **The response is `RESOURCE_EXHAUSTED`, not HTTP 429** — TC-28. A gRPC client maps the status
 *     code, not the HTTP one, and a 429 would surface to the runtime as `UNKNOWN`.
 *  3. **No Redis store.** T-012's own env note explains that an in-memory limiter across N pods is
 *     an N-times weaker limiter, and that remains true here — but the ceiling exists to stop a
 *     retry storm from one runtime, and a storm hits every pod at once. The completion report
 *     records the shared-store upgrade as the thing to do when `APP_INSTANCE_COUNT > 1`.
 */
import { Injectable, Optional } from '@nestjs/common';
import { RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS } from './grpc.constants';
import { RateLimitExceededError } from './grpc.errors';

interface Window {
  count: number;
  resetAt: number;
}

@Injectable()
export class ServiceRateLimiter {
  private readonly windows = new Map<string, Window>();

  /** Both parameters are `@Optional()` for the reason spelled out in `access-log.ts`: `Number` is
   * not an injectable token, and without it `AppModule` itself fails to boot. Nest passes
   * `undefined` and the defaults — the two constants above — apply. */
  constructor(
    @Optional() private readonly limit: number = RATE_LIMIT_PER_MINUTE,
    @Optional() private readonly windowMs: number = RATE_LIMIT_WINDOW_MS,
  ) {}

  /** Counts one call, or throws `RESOURCE_EXHAUSTED`. */
  consume(identity: string, now: number = Date.now()): void {
    const window = this.windows.get(identity);
    if (window === undefined || now >= window.resetAt) {
      this.windows.set(identity, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      // The **first** call of a window is checked too, not waved through. It always passes for any
      // sane limit; it does not for a limit of 0, and an operator who configures 0 means "refuse
      // everything" rather than "refuse everything except the first call per minute".
      if (this.limit < 1) throw new RateLimitExceededError(identity, this.limit);
      return;
    }
    window.count += 1;
    if (window.count > this.limit) throw new RateLimitExceededError(identity, this.limit);
  }

  /** Drops expired windows so a long-lived process does not accumulate one entry per identity it
   * has ever seen. Run on window rollover rather than on a timer: no interval to leak, and the
   * work is proportional to the number of distinct identities, which is small by design. */
  private sweep(now: number): void {
    for (const [identity, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(identity);
    }
  }
}
