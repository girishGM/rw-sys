/**
 * T-017 — enforcement point ④, the API response (07-DATA-PROTECTION.md §8, implementation note 6).
 *
 * > *"Response masking runs **before** serialisation and considers `actor.role` against
 * > `reveal_roles`. Order is fixed: DTO → mask → serialise → (T-018 encrypt)."*
 *
 * ```
 * entity → response DTO → mask by caller role → serialise → encrypt envelope → send
 *                           ▲
 *                           └─ policy.ui_visibility + policy.reveal_roles + actor.role
 * ```
 *
 * ---
 *
 * ## The rule that surprises people, and is correct
 *
 * `reveal_on_demand` masks the value **even for a role listed in `reveal_roles`** (TC-14). The
 * listed roles are not "roles that see it in the list"; they are "roles permitted to *ask* for
 * it, one record at a time, with an audit row". §8 spells this out: *"masked by default; roles in
 * `reveal_roles` may call the reveal endpoint"*.
 *
 * If the list unmasked automatically for those roles, the audit trail in §8 would record nothing
 * — a support agent viewing 400 customer emails would do it with one `GET /merchants?limit=400`
 * and leave no trace, which is exactly the question the design says you must be able to ask. So
 * `reveal_roles` never affects this interceptor's output. It is read here only to be handed to
 * the client as *capability* metadata (see {@link REVEALABLE_FIELDS_KEY}), so the SPA knows which
 * fields deserve the 👁 control — 07-DATA-PROTECTION.md §9.
 *
 * ## `never` removes the key; `masked` replaces the value
 *
 * TC-19 requires a `ui_visibility: never` field to be *"**absent** from the response entirely"*,
 * not present-and-masked. The distinction is real: a masked value confirms the field exists and
 * has a value for this record, which for something like `mfa_secret_enc` is itself information.
 *
 * ## Where this must sit in the interceptor chain
 *
 * Nest runs response-side interceptor logic in **reverse** registration order, so an interceptor
 * registered *after* this one operates on this one's output. T-018's payload-encryption
 * interceptor must therefore be registered **before** this one in `AppModule` to encrypt the
 * masked body rather than the raw one. `DataProtectionModule`'s header records this so the
 * ordering constraint is written down in both places.
 *
 * ## Fail-closed
 *
 * Every lookup goes through the cache's fail-closed form, and a walk that throws for any reason
 * masks the whole payload rather than propagating (TC-21: *"fields masked (fail-closed), request
 * not failed open"*). An interceptor that throws would turn a policy-cache blip into a 500 for
 * the user, which discloses nothing but breaks everything.
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
  type CustomDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { AuthenticatedRequest } from '@/modules/auth/decorators/current-user.decorator';
import { CHAIN_SPAN, traceSpan } from '@/common/tracing/span.service';
import type { MaskStrategyName } from './data-protection.constants';
import { containerOf } from './log-masking.serializer';
import { applyMask } from './mask.strategies';
import { PolicyCacheService } from './policy-cache.service';
import { toSnakeCase, type ResolvedPolicy } from './policy.service';

/**
 * Marks a route whose body must reach the client unmasked.
 *
 * **There is exactly one legitimate user of this decorator: `RevealController`.** Its entire
 * purpose is to return one plaintext value, after a role check, a rate limit and an audit write —
 * masking its output would make the endpoint a no-op. Any second use is a security decision that
 * belongs in a review, which is why the marker is a named export with this comment rather than a
 * boolean option on a shared decorator.
 */
export const NO_RESPONSE_MASKING_KEY = 'dp:noResponseMasking';

/** @see NO_RESPONSE_MASKING_KEY */
export const NoResponseMasking = (): CustomDecorator<string> =>
  SetMetadata(NO_RESPONSE_MASKING_KEY, true);

/**
 * The property the interceptor adds to a response envelope listing the fields the caller's role
 * may unmask through `GET /reveal/...`.
 *
 * Capability metadata, not data: it names fields, never values. The SPA uses it to decide where
 * to render the 👁 control (07-DATA-PROTECTION.md §9) instead of hard-coding a field list that
 * would drift from the policy table the moment a row changed.
 */
export const REVEALABLE_FIELDS_KEY = 'revealable';

/** Depth bound, matching the log serialiser's. A response is not a place for a 12-deep object. */
export const MAX_RESPONSE_DEPTH = 12;

@Injectable()
export class ResponseMaskingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ResponseMaskingInterceptor.name);

  constructor(
    private readonly policies: PolicyCacheService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const exempt = this.reflector.getAllAndOverride<boolean>(NO_RESPONSE_MASKING_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt === true) return next.handle();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // R3: the role comes from the verified token via the guard chain, never from the payload.
    // An anonymous caller (a `@Public()` route) resolves to `null`, which matches no
    // `reveal_roles` entry — the strictest possible reading, and the right one.
    const role = request.authUser?.role ?? null;

    // T-019 wrapped the masking work — `response.mask`, the second half of stage 9 in
    // 08-OBSERVABILITY.md §5's waterfall (`response.mask + encrypt`). The span goes around the
    // `map` callback rather than around `intercept`, because `intercept` only builds the
    // observable and would report ~0 ms. `traceSpan` is a no-op outside a request.
    return next
      .handle()
      .pipe(map((body) => traceSpan(CHAIN_SPAN.RESPONSE_MASK, () => this.maskBody(body, role))));
  }

  /**
   * Masks one response body. Never throws.
   *
   * The `catch` is not defensive padding: `walk` calls into the policy cache, into user-supplied
   * DTO getters and into `applyMask`, and this method's contract to the request pipeline is that
   * it returns a body. Failing here masks everything — see the file header.
   */
  maskBody(body: unknown, role: string | null): unknown {
    try {
      const revealable = new Set<string>();
      const masked = this.walk(body, role, 0, new WeakSet<object>(), revealable);
      return attachRevealable(masked, revealable);
    } catch (error) {
      this.logger.error(
        `Response masking failed (${(error as Error).message}). The body was replaced with a ` +
          `fully-masked form rather than sent unmasked (07-DATA-PROTECTION.md §8, fail-closed).`,
      );
      return maskEverything(body, 0);
    }
  }

  private walk(
    value: unknown,
    role: string | null,
    depth: number,
    ancestors: WeakSet<object>,
    revealable: Set<string>,
  ): unknown {
    if (depth > MAX_RESPONSE_DEPTH) return undefined;
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    if (value instanceof Date) return value;
    if (Buffer.isBuffer(value)) return value;

    // A cycle in a response body is a bug that would otherwise hang the serialiser; dropping the
    // back-reference is the only rendering that terminates.
    if (ancestors.has(value)) return undefined;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => this.walk(item, role, depth + 1, ancestors, revealable));
      }

      // A handler that returns a model instance rather than a DTO still gets the fail-closed
      // classification ladder, because the instance names its own table — the same mechanism the
      // log serialiser uses, and for the same reason (see `resolvePolicyFor` there). A plain DTO
      // has no container and is resolved by field name alone.
      const container = containerOf(value);

      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const policy = this.resolve(key, container);

        if (policy === null) {
          out[key] = this.walk(raw, role, depth + 1, ancestors, revealable);
          continue;
        }

        switch (policy.uiVisibility) {
          case 'never':
            // TC-19 — the key does not appear at all.
            continue;
          case 'plain':
            out[key] = this.walk(raw, role, depth + 1, ancestors, revealable);
            continue;
          case 'reveal_on_demand':
            // TC-14 — masked here regardless of role; the role only decides whether the field is
            // advertised as revealable. See the file header.
            if (role !== null && policy.revealRoles.includes(role) && policy.policyKey !== null) {
              revealable.add(policy.policyKey);
            }
            out[key] = this.maskField(raw, policy, depth);
            continue;
          default:
            out[key] = this.maskField(raw, policy, depth);
        }
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  }

  /**
   * Renders one masked field — and the two cases are genuinely different.
   *
   * **A declared `masked` policy** masks every scalar leaf, numbers included. A masked field
   * holding a structure (`reward_versions.connector_config`) can carry a credential as a number
   * or a boolean just as easily as a string, and somebody classified the whole field.
   *
   * **A fail-closed resolution** — the policy cache could not answer — masks *strings only*,
   * keeping numbers, booleans and structure. The difference matters because in that state
   * **every** key resolves this way, including the `data` key of the response envelope: masking
   * its numbers would blank every id and page count in the payload and turn a policy-cache blip
   * into a broken SPA. Strings are what this task protects; ids and counts are what the client
   * needs to keep functioning while an operator fixes the table.
   */
  private maskField(raw: unknown, policy: ResolvedPolicy, depth: number): unknown {
    return policy.source === 'fail_closed'
      ? maskEverything(raw, depth + 1)
      : maskDeep(raw, policy.maskStrategy ?? 'full', depth + 1);
  }

  /**
   * Resolves a response property, fail-closed.
   *
   * Returns `null` — "no policy governs this name, emit it as-is" — only when the cache answered
   * successfully and matched nothing. An *unavailable* cache yields `FAIL_CLOSED_POLICY`,
   * whose `masked` visibility masks the field. The two must not collapse into one; that
   * distinction is TC-21.
   */
  private resolve(key: string, container: string | null): ResolvedPolicy | null {
    if (container !== null) return this.policies.resolveColumnSafe(container, toSnakeCase(key));
    return this.policies.resolveFieldNameSafe(key);
  }
}

/**
 * Masks a value, recursing into objects and arrays instead of collapsing them.
 *
 * The naive form — `applyMask(raw, strategy)` — returns the fixed `••••••••` for any non-string,
 * so a masked field holding a JSON object becomes one glyph run and the client loses the shape
 * entirely. Two places make that unacceptable rather than merely untidy:
 *
 *  - `reward_versions.connector_config` is a masked field whose value is a structure. Masking its
 *    *leaves* hides the credentials while leaving the shape a UI can render.
 *  - When the policy cache is unavailable, **every** key resolves to `masked` (TC-21) — including
 *    the `data` key of the response envelope. Collapsing that would answer `{"data":"••••••••"}`
 *    and break every screen, which is a self-inflicted outage on top of a policy-cache blip.
 *
 * So: objects and arrays are walked and every scalar leaf is masked with the same strategy —
 * numbers and booleans included, because a credential inside a masked blob is no less a
 * credential for being numeric. `null`/`undefined` pass through, so "hidden from you" stays
 * distinguishable from "not set". The *fail-closed* rendering is deliberately gentler and lives
 * in {@link maskEverything}; see `ResponseMaskingInterceptor.maskField` for why the two differ.
 */
export function maskDeep(value: unknown, strategy: MaskStrategyName, depth: number): unknown {
  if (depth > MAX_RESPONSE_DEPTH) return undefined;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, strategy, depth + 1));
  // A `Date` survives; a `Buffer` does not. A timestamp inside a masked structure is not the
  // thing being protected, and masking it into `••••••••` breaks date rendering on the client
  // for no gain. A `Buffer` is raw bytes — key material and ciphertext both arrive in one — and
  // falls through to the mask below.
  if (value instanceof Date) return value;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = maskDeep(readSafely(value, key), strategy, depth + 1);
    }
    return out;
  }
  return applyMask(value, strategy);
}

/**
 * Adds the revealable-field list to a `{ data: … }` envelope, if there is anything to add.
 *
 * Only ever attached to a plain object envelope. An array body (an endpoint returning a bare
 * list) is left alone rather than being wrapped — changing a response's *shape* from an
 * interceptor would break 03-API-CONTRACT.md's envelope for every consumer, and the capability
 * hint is an affordance, not a requirement.
 */
export function attachRevealable(body: unknown, revealable: ReadonlySet<string>): unknown {
  if (revealable.size === 0) return body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), [REVEALABLE_FIELDS_KEY]: [...revealable].sort() };
}

/**
 * The emergency rendering: every string leaf replaced by a fixed-width mask, structure kept.
 *
 * Structure is kept so the SPA still renders a page rather than crashing on a missing field — the
 * user sees dots where values were, which is a recognisable and reportable failure. Numbers and
 * booleans survive because they are overwhelmingly ids, counts and flags; the values this task
 * protects are strings, and a fully-masked body that also broke pagination would add an outage to
 * an incident.
 */
export function maskEverything(value: unknown, depth: number): unknown {
  if (depth > MAX_RESPONSE_DEPTH) return undefined;
  if (typeof value === 'string') return applyMask(value, 'full');
  if (Array.isArray(value)) return value.map((item) => maskEverything(item, depth + 1));
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    // `Object.keys` + a guarded read, never `Object.entries`: `entries` evaluates every getter
    // eagerly, so one throwing accessor would take down the emergency path itself — the one path
    // that exists precisely because something already went wrong.
    for (const key of Object.keys(value))
      out[key] = maskEverything(readSafely(value, key), depth + 1);
    return out;
  }
  return value;
}

/** One property, or `''` when its getter throws. Both callers above mask the result anyway. */
function readSafely(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return '';
  }
}
